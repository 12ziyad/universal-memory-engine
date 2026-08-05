/**
 * Engine v2 — the two calls that come after extraction, plus the deterministic
 * glue around them.
 *
 *   call 1 (llm.js proposeMemory)   facts + entities, stance: generous
 *   call 2 (proposeEdges, here)     relations ONLY, against a numbered entity list
 *   call 3 (proposeReflexion, here) only what the first two passes missed
 *
 * The numbered list is the contract that makes call 2 safe to trust: CODE
 * numbers the resolved entities 1..n for this one save (temporary row numbers,
 * not database ids), and an edge may only cite numbers on the list. An edge
 * citing an unknown id is REJECTED, never repaired — that hard gate is what
 * lets the extraction stance be generous.
 *
 * Why a separate edge pass at all: a single combined call spends its attention
 * on facts and produces relations as an afterthought — measured on conv-0 as
 * 47 nodes / 3 edges. Relations need their own attention budget.
 */

import { runAi } from "../lib/ai_meter.js";
import {
	STRUCTURED_SOURCE_EVENT_ADDENDUM,
	extractJson,
	hasStructuredSourceEvent,
	responseText,
} from "./llm.js";
import { normalizeLabel } from "../lib/text.js";
import { canonicalizeCategory } from "./gates.js";

const RELATION_TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * 6.2 — type-pair whitelist with direction. Coarse endpoint classes; a KNOWN
 * relation type whose endpoints are the wrong kind of thing is rejected
 * (`Cabo Verde Shipping WORKS_AT Lisbon` — an org cannot work anywhere).
 * Novel types stay unconstrained: the open edge vocabulary is a feature, and
 * an unknown/"other" category never triggers a rejection on its own.
 */
const CLASS_OF_CATEGORY = {
	person: "person", family: "person", relationship: "person",
	organization: "org",
	place: "place",
	project: "thing", system: "thing", tool: "thing", possession: "thing",
	skill: "activity", habit: "activity", interest: "activity", goal: "activity",
	health: "condition", life_event: "event",
};

function endpointClass(category) {
	const canonical = canonicalizeCategory(category) ?? "other";
	return CLASS_OF_CATEGORY[canonical] ?? "other";
}

const TYPE_ENDPOINT_RULES = {
	WORKS_AT: { from: ["person"], to: ["org", "place"] },
	EMPLOYED_AT: { from: ["person"], to: ["org"] },
	EMPLOYED_BY: { from: ["person"], to: ["org", "person"] },
	WORKS_FOR: { from: ["person"], to: ["org", "person"] },
	LIVES_IN: { from: ["person"], to: ["place"] },
	MOVED_TO: { from: ["person", "org"], to: ["place"] },
	BASED_IN: { from: ["person", "org"], to: ["place"] },
	LOCATED_IN: { from: ["org", "place", "thing"], to: ["place"] },
	FOUNDED: { from: ["person"], to: ["org", "thing"] },
	MARRIED_TO: { from: ["person"], to: ["person"] },
	ENGAGED_TO: { from: ["person"], to: ["person"] },
	DATING: { from: ["person"], to: ["person"] },
	SIBLING_OF: { from: ["person"], to: ["person"] },
	SISTER_OF: { from: ["person"], to: ["person"] },
	BROTHER_OF: { from: ["person"], to: ["person"] },
	PARENT_OF: { from: ["person"], to: ["person"] },
	CHILD_OF: { from: ["person"], to: ["person"] },
	REPORTS_TO: { from: ["person"], to: ["person"] },
	MANAGED_BY: { from: ["person", "thing"], to: ["person"] },
	MANAGES: { from: ["person"], to: ["person", "org", "thing"] },
	TREATED_BY: { from: ["person"], to: ["person", "org"] },
	TEACHES: { from: ["person"], to: [] }, // any object; the subject must be a person
	OWNS: { from: ["person", "org"], to: [] },
};

function typePairAllowed(type, fromCat, toCat) {
	const rule = TYPE_ENDPOINT_RULES[type];
	if (!rule) return true; // open vocabulary
	const fromClass = endpointClass(fromCat);
	const toClass = endpointClass(toCat);
	if (rule.from.length && fromClass !== "other" && !rule.from.includes(fromClass)) return false;
	if (rule.to.length && toClass !== "other" && !rule.to.includes(toClass)) return false;
	return true;
}

/**
 * 6.1 — the evidence gate. The span must exist verbatim (whitespace- and
 * case-normalized) in what was actually sent, and must contain a surface form
 * of BOTH endpoints. Kills co-mention inventions and swapped endpoints.
 */
function normalizeForMatch(text) {
	return String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function surfaceFormsOf(label) {
	const forms = [normalizeForMatch(label)];
	for (const word of String(label ?? "").split(/\s+/)) {
		const w = normalizeForMatch(word).replace(/[^\p{L}\p{N}'-]/gu, "");
		if (w.length >= 3) forms.push(w);
	}
	return forms.filter(Boolean);
}

export function verifyEdgeEvidence(evidence, sourceCorpus, fromLabel, toLabel) {
	const span = normalizeForMatch(evidence);
	if (!span || span.length < 4) return "edge_no_evidence";
	if (!normalizeForMatch(sourceCorpus).includes(span)) return "edge_evidence_not_verbatim";
	if (!surfaceFormsOf(fromLabel).some((f) => span.includes(f))) return "edge_evidence_missing_endpoint";
	if (!surfaceFormsOf(toLabel).some((f) => span.includes(f))) return "edge_evidence_missing_endpoint";
	return null;
}

/** Coerce a model relation_type into SCREAMING_SNAKE_CASE, or null if hopeless. */
export function normalizeRelationType(raw) {
	const cleaned = String(raw ?? "")
		.trim()
		.replace(/[\s-]+/g, "_")
		.replace(/[^A-Za-z0-9_]/g, "")
		.toUpperCase();
	return RELATION_TYPE_RE.test(cleaned) ? cleaned : null;
}

/** Parse a model-supplied YYYY-MM-DD (or epoch ms) into epoch ms, else null. */
export function parseValidityDate(value) {
	if (value === null || value === undefined || value === "") return null;
	if (Number.isFinite(Number(value)) && Number(value) > 10_000_000_000) return Math.round(Number(value));
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
	if (!m) return null;
	const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
	return Number.isFinite(ts) ? ts : null;
}

/**
 * Number the entities this save can see: nodes the model proposed in call 1
 * plus the shortlist of existing nodes. Labels are exact — the edge pass hands
 * back numbers, and the numbers resolve back to these labels.
 */
export function numberEntities(call1Objects, shortlist = []) {
	const seen = new Set();
	const entities = [];
	const push = (label, category, existingId = null) => {
		const norm = normalizeLabel(label);
		if (!norm || seen.has(norm)) return;
		seen.add(norm);
		entities.push({ n: entities.length + 1, label, category: category ?? "other", existingId });
	};
	for (const node of shortlist) push(node.label, node.category, node.id);
	for (const obj of call1Objects ?? []) {
		if (obj?.kind === "node" && obj.label) push(obj.label, obj.category);
	}
	return entities;
}

function entityListLines(entities) {
	return entities.map((e) => `${e.n}. ${e.label} (${e.category})`).join("\n");
}

/**
 * Qwen3's reasoning mode will happily spend an entire output budget inside
 * <think> and return EMPTY content — measured on conv-0: five edge calls,
 * five empty responses. The documented soft switch turns thinking off for
 * these output-light JSON passes. Appended only for qwen3 models; other
 * models never see it.
 */
function noThink(config) {
	return String(config?.llm?.model ?? "").includes("qwen3") ? "\n/no_think" : "";
}

function messagesBlock(packet) {
	return JSON.stringify(packet.new_slice ?? [], null, 1);
}

function secondarySystemPrompt(base, packet, overrides) {
	return overrides?.profile === "plugin" || hasStructuredSourceEvent(packet)
		? base + STRUCTURED_SOURCE_EVENT_ADDENDUM
		: base;
}

const EDGE_SYSTEM_PROMPT = `You extract RELATIONSHIPS between known entities from a user's chat messages. Entities are given as a numbered list; you may ONLY reference entities by their list number. Never invent a number that is not on the list.

Reply with EXACTLY ONE JSON object, nothing else:
{
  "edges": [
    { "source_entity_id": 1, "target_entity_id": 4, "relation_type": "WORKS_AT", "fact": "Priya works at Meridian Labs", "evidence": "priya started at meridian labs on monday", "valid_at": "2026-09-01", "invalid_at": null }
  ]
}

Rules:
- relation_type is SCREAMING_SNAKE_CASE, specific and directional: WORKS_AT, LIVES_IN, MARRIED_TO, SISTER_OF, USES, BUILT_WITH, TRAINS_FOR, OWNS, TREATED_BY, DEPENDS_ON, MANAGES...
- fact is one short sentence stating the relationship in plain words.
- evidence is REQUIRED: a short quote copied EXACTLY, word for word, from the messages — the words that state this relationship. It must mention both entities. An edge you cannot quote is an edge you must not output.
- valid_at: when the relationship BECAME true, as YYYY-MM-DD, ONLY if the messages state or clearly imply it. Never guess; omit or null otherwise.
- invalid_at: when it STOPPED being true (breakups, job changes, migrations off a tool), same rules.
- Extract every relationship the messages STATE or clearly imply between listed entities. Do not invent relationships from co-mention alone — appearing in the same sentence is not a relationship.
- Direction matters: the SOURCE does the verb. A person WORKS_AT an organization, never the reverse.
- If a relationship's other end is not on the list, skip it — do not add entities.
- Empty is valid: { "edges": [] }.`;

// 6.3 — the same contract as a schema, for constrained decoding. One shape
// per pass; the plain-text prompt stays as the retry fallback.
const EDGE_SCHEMA = {
	type: "object",
	properties: {
		edges: {
			type: "array",
			items: {
				type: "object",
				properties: {
					source_entity_id: { type: "integer" },
					target_entity_id: { type: "integer" },
					relation_type: { type: "string" },
					fact: { type: "string" },
					evidence: { type: "string" },
					valid_at: { type: ["string", "null"] },
					invalid_at: { type: ["string", "null"] },
				},
				required: ["source_entity_id", "target_entity_id", "relation_type", "fact", "evidence"],
			},
		},
	},
	required: ["edges"],
};

const REFLEXION_SCHEMA = {
	type: "object",
	properties: {
		entities: {
			type: "array",
			items: {
				type: "object",
				properties: { n: { type: "integer" }, label: { type: "string" }, category: { type: "string" } },
				required: ["n", "label", "category"],
			},
		},
		facts: {
			type: "array",
			items: {
				type: "object",
				properties: { entity_id: { type: "integer" }, text: { type: "string" }, kind: { type: "string" } },
				required: ["entity_id", "text"],
			},
		},
		edges: EDGE_SCHEMA.properties.edges,
	},
	required: ["entities", "facts", "edges"],
};

/** Schema-constrained decoding when enabled; the caller falls back to plain. */
function jsonModeParams(env, schema) {
	if (String(env.LLM_JSON_MODE ?? "true") === "false") return {};
	return { response_format: { type: "json_schema", json_schema: schema } };
}

/**
 * Call 2 — edges. Returns { edges: [validated], rejected: [named rejections],
 * raw_ok } where every validated edge already resolved its numbers to labels.
 */
export async function proposeEdges(env, config, packet, entities, overrides = {}) {
	if (entities.length < 2) return { edges: [], rejected: [], raw_ok: true, skipped: "too_few_entities" };

	let parsed;
	let fromModel = false;
	if (overrides.edgeResponse !== undefined && overrides.edgeResponse !== null) {
		parsed = typeof overrides.edgeResponse === "function"
			? await overrides.edgeResponse({ packet, entities })
			: overrides.edgeResponse;
		if (typeof parsed === "string") parsed = extractJson(parsed);
	} else {
		if (!env.AI) return { edges: [], rejected: [], raw_ok: true, skipped: "no_ai_binding" };
		fromModel = true;
		const attempt = async (constrained) => runAi(
			env,
			config.llm.model,
			{
				messages: [
					{ role: "system", content: secondarySystemPrompt(EDGE_SYSTEM_PROMPT, packet, overrides) },
					{
						role: "user",
						content: `ENTITIES:\n${entityListLines(entities)}\n\nMESSAGES:\n${messagesBlock(packet)}${noThink(config)}`,
					},
				],
				temperature: config.llm.temperature,
				// Edge lists are output-light; a tight budget also bounds how
				// long a thinking model can ruminate before answering.
				max_tokens: config.llm.passMaxTokens,
				// 6.3 — schema-constrained decoding (verified live on Qwen3-30B:
				// schema-valid JSON in choices[].message.content, reasoning kept
				// separate). One plain-text retry remains the fallback.
				...(constrained ? jsonModeParams(env, EDGE_SCHEMA) : {}),
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
			{ task: "edges" },
		);
		try {
			parsed = extractJson(responseText(await attempt(true)));
			if (!parsed || typeof parsed !== "object") {
				console.warn("edge pass: constrained output unparseable, retrying plain");
				parsed = extractJson(responseText(await attempt(false)));
			}
		} catch (err) {
			console.warn("edge pass failed:", err?.message ?? err);
			return { edges: [], rejected: [], raw_ok: false, skipped: "llm_error" };
		}
	}

	if (!parsed || typeof parsed !== "object") return { edges: [], rejected: [], raw_ok: false, skipped: "unparseable" };
	const rows = Array.isArray(parsed.edges) ? parsed.edges : Array.isArray(parsed) ? parsed : null;
	if (!rows) return { edges: [], rejected: [], raw_ok: false, skipped: "unparseable" };

	return {
		...validateEdgeRows(rows, entities, {
			requireEvidence: fromModel,
			sourceCorpus: (packet.new_slice ?? []).map((m) => m?.content ?? "").join("\n"),
		}),
		raw_ok: true,
	};
}

/**
 * The hard gate: numbers must be on the list, the relation type must
 * normalize, no self-loops. Fix round 1 additions: the evidence-quote gate
 * (6.1, only when `opts.requireEvidence` — real model output must prove every
 * edge; canned test responses are exempt), the type-pair whitelist (6.2), and
 * the valid_at sanity gate (6.5). Rejections are named, never repaired.
 */
const FUTURE_TENSE_RE = /\b(will|going to|starts?\s+(?:in|on|next)|starting|from\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)|next\s+(?:week|month|year))\b/i;

export function validateEdgeRows(rows, entities, opts = {}) {
	const byN = new Map(entities.map((e) => [e.n, e]));
	const edges = [];
	const rejected = [];
	const now = Number(opts.now ?? Date.now());
	for (const row of rows) {
		const src = byN.get(Number(row?.source_entity_id));
		const dst = byN.get(Number(row?.target_entity_id));
		if (!src || !dst) {
			rejected.push({ kind: "edge", label: String(row?.fact ?? row?.relation_type ?? "edge").slice(0, 80), reason: "edge_unknown_entity_id" });
			continue;
		}
		if (src.n === dst.n) {
			rejected.push({ kind: "edge", label: src.label, reason: "edge_self_loop" });
			continue;
		}
		const type = normalizeRelationType(row?.relation_type);
		if (!type) {
			rejected.push({ kind: "edge", label: `${src.label}→${dst.label}`, reason: "invalid_edge_type" });
			continue;
		}
		// 6.2 — a known type with the wrong kinds of endpoint dies here.
		if (!typePairAllowed(type, src.category, dst.category)) {
			rejected.push({ kind: "edge", label: `${src.label} ${type} ${dst.label}`, reason: "edge_type_pair_mismatch" });
			continue;
		}
		// 6.1 — real model output must quote its source, verbatim, naming both
		// endpoints. This is what kills co-mention inventions.
		if (opts.requireEvidence) {
			const failure = verifyEdgeEvidence(row?.evidence, opts.sourceCorpus ?? "", src.label, dst.label);
			if (failure) {
				rejected.push({ kind: "edge", label: `${src.label} ${type} ${dst.label}`, reason: failure });
				continue;
			}
		}
		// 6.5 — validity dates must be sane: parseable, and not in the future
		// unless the words actually said so. Hallucinated dates become null,
		// never bi-temporal history.
		let validAt = parseValidityDate(row.valid_at);
		if (validAt !== null && validAt > now + 24 * 60 * 60 * 1000) {
			const wording = `${row?.fact ?? ""} ${row?.evidence ?? ""}`;
			if (validAt > now + 5 * 365 * 24 * 60 * 60 * 1000 || !FUTURE_TENSE_RE.test(wording)) {
				validAt = null;
			}
		}
		edges.push({
			kind: "edge",
			_v2: true,
			from: src.label,
			to: dst.label,
			type,
			fact: typeof row.fact === "string" ? row.fact.slice(0, 400) : null,
			evidence: typeof row.evidence === "string" ? row.evidence.slice(0, 300) : null,
			valid_at: validAt,
			invalid_at: parseValidityDate(row.invalid_at),
			confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.9,
		});
	}
	return { edges, rejected };
}

const REFLEXION_SYSTEM_PROMPT = `You are the second-look pass of a memory extractor. You get the user's messages, the entities already found (numbered), the facts already recorded, and the relationships already recorded. Output ONLY what was MISSED — do not repeat anything already found.

Reply with EXACTLY ONE JSON object, nothing else:
{
  "entities": [ { "n": 7, "label": "Porto half marathon", "category": "goal" } ],
  "facts": [ { "entity_id": 7, "text": "Training plan is 40km a week", "kind": "progress" } ],
  "edges": [ { "source_entity_id": 2, "target_entity_id": 7, "relation_type": "TRAINS_FOR", "fact": "Amara trains for the Porto half marathon", "valid_at": null, "invalid_at": null } ]
}

Rules:
- New entities continue the numbering AFTER the last existing number, in order of appearance. Never renumber existing entities.
- Look hardest for: time anchors (dates things happened or will happen), relationships between people, durable facts mentioned in passing, and PLACES — cities, neighbourhoods, venues the user's life happens in are entities.
- Before answering, list to yourself every proper name mentioned TWO OR MORE times across the messages. Any of them absent from the entity list is a miss you must report as a new entity.
- facts.entity_id and edge ids may reference existing numbers OR your new ones.
- Every edge needs "evidence": a short quote copied word-for-word from the messages, mentioning both entities.
- fact/text: one short plain sentence. category: person, family, relationship, project, tool, skill, health, goal, preference, place, organization, life_event, habit, interest, other. Use ONLY these categories.
- Nothing missed is a valid answer: { "entities": [], "facts": [], "edges": [] }.`;

/**
 * Call 3 — reflexion. Returns { entities, facts, edges, rejected, raw_ok }.
 * New entities are re-numbered deterministically by code (order of appearance,
 * continuing after the existing list) whatever numbers the model claimed.
 */
export async function proposeReflexion(env, config, packet, entities, foundSummary, overrides = {}) {
	let parsed;
	let fromModel = false;
	if (overrides.reflexionResponse !== undefined && overrides.reflexionResponse !== null) {
		parsed = typeof overrides.reflexionResponse === "function"
			? await overrides.reflexionResponse({ packet, entities, foundSummary })
			: overrides.reflexionResponse;
		if (typeof parsed === "string") parsed = extractJson(parsed);
	} else {
		if (!env.AI) return { entities: [], facts: [], edges: [], rejected: [], raw_ok: true, skipped: "no_ai_binding" };
		fromModel = true;
		const attempt = async (constrained) => runAi(
			env,
			config.llm.model,
			{
				messages: [
					{ role: "system", content: secondarySystemPrompt(REFLEXION_SYSTEM_PROMPT, packet, overrides) },
					{
						role: "user",
						content:
							`ENTITIES ALREADY FOUND:\n${entityListLines(entities)}\n\n` +
							`ALREADY RECORDED:\n${foundSummary || "(nothing)"}\n\nMESSAGES:\n${messagesBlock(packet)}${noThink(config)}`,
					},
				],
				temperature: config.llm.temperature,
				max_tokens: config.llm.passMaxTokens,
				...(constrained ? jsonModeParams(env, REFLEXION_SCHEMA) : {}),
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
			{ task: "reflexion" },
		);
		try {
			parsed = extractJson(responseText(await attempt(true)));
			if (!parsed || typeof parsed !== "object") {
				console.warn("reflexion pass: constrained output unparseable, retrying plain");
				parsed = extractJson(responseText(await attempt(false)));
			}
		} catch (err) {
			console.warn("reflexion pass failed:", err?.message ?? err);
			return { entities: [], facts: [], edges: [], rejected: [], raw_ok: false, skipped: "llm_error" };
		}
	}

	if (!parsed || typeof parsed !== "object") {
		return { entities: [], facts: [], edges: [], rejected: [], raw_ok: false, skipped: "unparseable" };
	}

	// Deterministic renumbering: whatever the model claimed, new entities get
	// max+1.. in order of appearance, and a remap table translates its numbers.
	const extended = [...entities];
	const remap = new Map(entities.map((e) => [e.n, e.n]));
	const known = new Set(entities.map((e) => normalizeLabel(e.label)));
	for (const row of Array.isArray(parsed.entities) ? parsed.entities : []) {
		if (!row?.label || known.has(normalizeLabel(row.label))) {
			if (row?.n !== undefined && row?.label) {
				const existing = entities.find((e) => normalizeLabel(e.label) === normalizeLabel(row.label));
				if (existing) remap.set(Number(row.n), existing.n);
			}
			continue;
		}
		known.add(normalizeLabel(row.label));
		const assigned = { n: extended.length + 1, label: String(row.label).slice(0, 120), category: row.category ?? "other", existingId: null };
		extended.push(assigned);
		if (row.n !== undefined) remap.set(Number(row.n), assigned.n);
	}
	const newEntities = extended.slice(entities.length);

	const facts = [];
	const rejected = [];
	for (const row of Array.isArray(parsed.facts) ? parsed.facts : []) {
		const n = remap.get(Number(row?.entity_id)) ?? Number(row?.entity_id);
		const entity = extended.find((e) => e.n === n);
		if (!entity) {
			rejected.push({ kind: "slice", label: String(row?.text ?? "fact").slice(0, 80), reason: "fact_unknown_entity_id" });
			continue;
		}
		if (typeof row.text !== "string" || !row.text.trim()) continue;
		facts.push({ on: entity.label, text: row.text.slice(0, 600), kind: row.kind ?? "other" });
	}

	const edgeRows = (Array.isArray(parsed.edges) ? parsed.edges : []).map((row) => ({
		...row,
		source_entity_id: remap.get(Number(row?.source_entity_id)) ?? row?.source_entity_id,
		target_entity_id: remap.get(Number(row?.target_entity_id)) ?? row?.target_entity_id,
	}));
	const validated = validateEdgeRows(edgeRows, extended, {
		requireEvidence: fromModel,
		sourceCorpus: (packet.new_slice ?? []).map((m) => m?.content ?? "").join("\n"),
	});

	return {
		entities: newEntities,
		facts,
		edges: validated.edges,
		rejected: [...rejected, ...validated.rejected],
		raw_ok: true,
	};
}

/**
 * Provenance: for each new object, the message that most plausibly produced it
 * — highest token overlap with the object's text — capped hard. Input messages
 * were scrubbed at the door, so snippets inherit that.
 */
const SNIPPET_CAP = 240;

/**
 * @param {object} plan
 * @param {Array} chunk
 * @param {(text: string) => boolean} [allow] - the caller's rules. A snippet
 *   is EVIDENCE, and evidence is still content: a sentence the rules refused
 *   to store as a memory must not survive as provenance on a neighbouring
 *   one. Without this, `excludes: ["salary"]` blocked the salary node and
 *   then kept the whole sentence — salary included — on the node next to it.
 */
export function attachProvenance(plan, chunk, allow = null) {
	const messages = (chunk ?? []).map((m) => ({
		content: String(m?.content ?? ""),
		tokens: new Set(normalizeLabel(String(m?.content ?? "")).split(" ").filter((t) => t.length > 2)),
	})).filter((m) => m.tokens.size > 0);
	if (!messages.length) return;

	const snippetFor = (text) => {
		const wanted = normalizeLabel(String(text ?? "")).split(" ").filter((t) => t.length > 2);
		if (!wanted.length) return null;
		let best = null;
		let bestScore = 0;
		for (const m of messages) {
			let score = 0;
			for (const t of wanted) if (m.tokens.has(t)) score++;
			if (score > bestScore) { bestScore = score; best = m; }
		}
		if (!best || bestScore === 0) return null;
		// The rules apply to evidence exactly as they apply to memory.
		if (allow && !allow(best.content)) return null;
		return best.content.length > SNIPPET_CAP ? `${best.content.slice(0, SNIPPET_CAP - 1)}…` : best.content;
	};

	for (const s of plan.newSlices ?? []) s.source_snippet = snippetFor(s.text);
	for (const e of plan.newEvents ?? []) e.source_snippet = snippetFor(e.text);
	for (const ed of plan.newEdges ?? []) ed.source_snippet = snippetFor(ed.fact ?? `${ed.type}`);
}
