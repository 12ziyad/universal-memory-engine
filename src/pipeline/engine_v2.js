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
import { responseText, extractJson } from "./llm.js";
import { normalizeLabel } from "../lib/text.js";

const RELATION_TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

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

function messagesBlock(packet) {
	return JSON.stringify(packet.new_slice ?? [], null, 1);
}

const EDGE_SYSTEM_PROMPT = `You extract RELATIONSHIPS between known entities from a user's chat messages. Entities are given as a numbered list; you may ONLY reference entities by their list number. Never invent a number that is not on the list.

Reply with EXACTLY ONE JSON object, nothing else:
{
  "edges": [
    { "source_entity_id": 1, "target_entity_id": 4, "relation_type": "WORKS_AT", "fact": "Priya works at Meridian Labs", "valid_at": "2026-09-01", "invalid_at": null }
  ]
}

Rules:
- relation_type is SCREAMING_SNAKE_CASE, specific and directional: WORKS_AT, LIVES_IN, MARRIED_TO, SISTER_OF, USES, BUILT_WITH, TRAINS_FOR, OWNS, TREATED_BY, DEPENDS_ON, MANAGES...
- fact is one short sentence stating the relationship in plain words.
- valid_at: when the relationship BECAME true, as YYYY-MM-DD, ONLY if the messages state or clearly imply it. Never guess; omit or null otherwise.
- invalid_at: when it STOPPED being true (breakups, job changes, migrations off a tool), same rules.
- Extract every relationship the messages STATE or clearly imply between listed entities. Do not invent relationships from co-mention alone.
- If a relationship's other end is not on the list, skip it — do not add entities.
- Empty is valid: { "edges": [] }.`;

/**
 * Call 2 — edges. Returns { edges: [validated], rejected: [named rejections],
 * raw_ok } where every validated edge already resolved its numbers to labels.
 */
export async function proposeEdges(env, config, packet, entities, overrides = {}) {
	if (entities.length < 2) return { edges: [], rejected: [], raw_ok: true, skipped: "too_few_entities" };

	let parsed;
	if (overrides.edgeResponse !== undefined && overrides.edgeResponse !== null) {
		parsed = typeof overrides.edgeResponse === "function"
			? await overrides.edgeResponse({ packet, entities })
			: overrides.edgeResponse;
		if (typeof parsed === "string") parsed = extractJson(parsed);
	} else {
		if (!env.AI) return { edges: [], rejected: [], raw_ok: true, skipped: "no_ai_binding" };
		try {
			const res = await runAi(
				env,
				config.llm.model,
				{
					messages: [
						{ role: "system", content: EDGE_SYSTEM_PROMPT },
						{
							role: "user",
							content: `ENTITIES:\n${entityListLines(entities)}\n\nMESSAGES:\n${messagesBlock(packet)}`,
						},
					],
					temperature: config.llm.temperature,
					max_tokens: config.llm.maxTokens,
				},
				config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
				{ task: "edges" },
			);
			parsed = extractJson(responseText(res));
		} catch (err) {
			console.warn("edge pass failed:", err?.message ?? err);
			return { edges: [], rejected: [], raw_ok: false, skipped: "llm_error" };
		}
	}

	if (!parsed || typeof parsed !== "object") return { edges: [], rejected: [], raw_ok: false, skipped: "unparseable" };
	const rows = Array.isArray(parsed.edges) ? parsed.edges : Array.isArray(parsed) ? parsed : null;
	if (!rows) return { edges: [], rejected: [], raw_ok: false, skipped: "unparseable" };

	return { ...validateEdgeRows(rows, entities), raw_ok: true };
}

/**
 * The hard gate: numbers must be on the list, the relation type must
 * normalize, no self-loops. Rejections are named, never repaired.
 */
export function validateEdgeRows(rows, entities) {
	const byN = new Map(entities.map((e) => [e.n, e]));
	const edges = [];
	const rejected = [];
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
		edges.push({
			kind: "edge",
			_v2: true,
			from: src.label,
			to: dst.label,
			type,
			fact: typeof row.fact === "string" ? row.fact.slice(0, 400) : null,
			valid_at: parseValidityDate(row.valid_at),
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
- Look hardest for: time anchors (dates things happened or will happen), relationships between people, and durable facts mentioned in passing.
- facts.entity_id and edge ids may reference existing numbers OR your new ones.
- fact/text: one short plain sentence. category: person, family, relationship, project, tool, skill, health, goal, preference, place, organization, life_event, habit, interest, other.
- Nothing missed is a valid answer: { "entities": [], "facts": [], "edges": [] }.`;

/**
 * Call 3 — reflexion. Returns { entities, facts, edges, rejected, raw_ok }.
 * New entities are re-numbered deterministically by code (order of appearance,
 * continuing after the existing list) whatever numbers the model claimed.
 */
export async function proposeReflexion(env, config, packet, entities, foundSummary, overrides = {}) {
	let parsed;
	if (overrides.reflexionResponse !== undefined && overrides.reflexionResponse !== null) {
		parsed = typeof overrides.reflexionResponse === "function"
			? await overrides.reflexionResponse({ packet, entities, foundSummary })
			: overrides.reflexionResponse;
		if (typeof parsed === "string") parsed = extractJson(parsed);
	} else {
		if (!env.AI) return { entities: [], facts: [], edges: [], rejected: [], raw_ok: true, skipped: "no_ai_binding" };
		try {
			const res = await runAi(
				env,
				config.llm.model,
				{
					messages: [
						{ role: "system", content: REFLEXION_SYSTEM_PROMPT },
						{
							role: "user",
							content:
								`ENTITIES ALREADY FOUND:\n${entityListLines(entities)}\n\n` +
								`ALREADY RECORDED:\n${foundSummary || "(nothing)"}\n\nMESSAGES:\n${messagesBlock(packet)}`,
						},
					],
					temperature: config.llm.temperature,
					max_tokens: config.llm.maxTokens,
				},
				config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
				{ task: "reflexion" },
			);
			parsed = extractJson(responseText(res));
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
	const validated = validateEdgeRows(edgeRows, extended);

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

export function attachProvenance(plan, chunk) {
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
		return best.content.length > SNIPPET_CAP ? `${best.content.slice(0, SNIPPET_CAP - 1)}…` : best.content;
	};

	for (const s of plan.newSlices ?? []) s.source_snippet = snippetFor(s.text);
	for (const e of plan.newEvents ?? []) e.source_snippet = snippetFor(e.text);
	for (const ed of plan.newEdges ?? []) ed.source_snippet = snippetFor(ed.fact ?? `${ed.type}`);
}
