import { ACTIONS, EDGE_TYPES, IMPORTANCE, SLICE_KINDS } from "../config.js";
import { extractJson, responseText } from "./llm.js";
import { canonicalizeCategory } from "./gates.js";
import { canonicalIdentity, manualNodeAliases } from "./manual_identity.js";
import { classifyMessage } from "./trigger.js";
import { titleCaseWords } from "./title.js";

const MANUAL_SYSTEM_PROMPT = `You are the isolated MANUAL memory extractor. The user explicitly submitted content to a memory tool.

Return exactly one JSON object:
{
  "facts": [
    {
      "identity": { "label": "Boxing", "category": "skill", "existing_node_id": null, "aliases": [] },
      "memory": { "kind": "event", "action": "started", "text": "The user started boxing", "importance": "ordinary" },
      "confidence": 0.95,
      "supersedes": false
    }
  ],
  "relationships": [
    {
      "from": { "label": "UML", "category": "project", "existing_node_id": null },
      "to": { "label": "D1", "category": "tool", "existing_node_id": null },
      "type": "uses",
      "text": "UML uses D1",
      "confidence": 0.95
    }
  ],
  "notes": ""
}

Hard rules:
- Extract predicates and values ONLY from submitted_content.
- recent_context is reference-only. It may resolve "it", "that", or a name, but must never supply a fact, predicate, preference, event, or value.
- existing_nodes are identity references only. Never repeat their old facts as new facts.
- Never output candidates. Uncertain, hypothetical, assistant-only, unsafe, or unsupported material is omitted.
- Every durable identity must have a slice or event. Never return a bare node.
- Use an existing_node_id only when the submitted identity unambiguously denotes that exact listed node.
- Keep distinct identities distinct. Similar wording or shared project vocabulary is not identity.
- A correction or replacement sets supersedes=true.
- Slice kinds: ${SLICE_KINDS.join(", ")}.
- Event actions: ${ACTIONS.join(", ")}.
- Importance: ${IMPORTANCE.join(", ")}.
- Relationship types: ${EDGE_TYPES.join(", ")}.
- Do not extract questions, greetings, thanks, jokes, generic world facts, or tool instructions.`;

function clampConfidence(value, fallback = 0.85) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(0, Math.min(1, number));
}

function cleanText(value, limit = 1200) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 3).trim()}...`;
}

function cleanLabel(value) {
	const raw = cleanText(value, 160).replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, "");
	if (!raw) return "";
	if (raw === raw.toLocaleLowerCase("en-US")) return titleCaseWords(raw);
	return raw;
}

function normalizeAliases(value) {
	const list = Array.isArray(value) ? value : [];
	return [...new Set(list.map(cleanLabel).filter(Boolean))].slice(0, 12);
}

function normalizeIdentity(raw, fallback = {}) {
	const value = raw && typeof raw === "object" ? raw : {};
	return {
		label: cleanLabel(value.label ?? value.name ?? fallback.label),
		category: canonicalizeCategory(value.category ?? value.role ?? fallback.category) ?? "other",
		existing_node_id:
			value.existing_node_id ?? value.existingNodeId ?? value.matches_existing ?? fallback.existing_node_id ?? null,
		aliases: normalizeAliases(value.aliases ?? fallback.aliases),
	};
}

function normalizeMemory(raw, fallback = {}) {
	const value = raw && typeof raw === "object" ? raw : {};
	const requestedKind = value.kind ?? value.memory_kind ?? fallback.kind;
	const kind = requestedKind === "event" || value.action ? "event" : "slice";
	if (kind === "event") {
		return {
			kind,
			action: ACTIONS.includes(value.action) ? value.action : "other",
			text: cleanText(value.text ?? value.value ?? fallback.text),
			importance: IMPORTANCE.includes(value.importance) ? value.importance : "ordinary",
			happened_at: Number.isFinite(Number(value.happened_at ?? value.happenedAt))
				? Number(value.happened_at ?? value.happenedAt)
				: null,
		};
	}
	const sliceKind = value.slice_kind ?? value.sliceKind ?? value.kind_detail ?? fallback.slice_kind;
	return {
		kind,
		slice_kind: SLICE_KINDS.includes(sliceKind) ? sliceKind : "other",
		text: cleanText(value.text ?? value.value ?? fallback.text),
	};
}

function normalizeFact(raw) {
	const value = raw && typeof raw === "object" ? raw : {};
	const identity = normalizeIdentity(value.identity ?? value.subject, {
		label: value.label ?? value.on,
		category: value.category,
		existing_node_id: value.existing_node_id ?? value.matches_existing,
		aliases: value.aliases,
	});
	const memory = normalizeMemory(value.memory ?? value.detail ?? value.fact, {
		kind: value.memory_kind ?? (value.action ? "event" : "slice"),
		text: value.text,
		slice_kind: value.slice_kind ?? value.kind_detail,
	});
	return {
		identity,
		memory,
		confidence: clampConfidence(value.confidence),
		supersedes: Boolean(value.supersedes ?? value.replaces ?? value.correction),
	};
}

function normalizeRelationship(raw, nodeMeta = new Map()) {
	const value = raw && typeof raw === "object" ? raw : {};
	const fromLabel = value.from?.label ?? value.from_label ?? value.from;
	const toLabel = value.to?.label ?? value.to_label ?? value.to;
	const fromMeta = nodeMeta.get(canonicalIdentity(fromLabel)) ?? {};
	const toMeta = nodeMeta.get(canonicalIdentity(toLabel)) ?? {};
	return {
		from: normalizeIdentity(value.from && typeof value.from === "object" ? value.from : null, {
			...fromMeta,
			label: fromLabel,
		}),
		to: normalizeIdentity(value.to && typeof value.to === "object" ? value.to : null, {
			...toMeta,
			label: toLabel,
		}),
		type: EDGE_TYPES.includes(value.type) ? value.type : null,
		text: cleanText(value.text ?? `${fromLabel ?? ""} ${value.type ?? "related to"} ${toLabel ?? ""}`),
		confidence: clampConfidence(value.confidence),
	};
}

function evidenceLineForLabel(source, label) {
	const keyTokens = canonicalIdentity(label).split(" ").filter((token) => token.length > 1);
	const lines = String(source ?? "")
		.split(/\n+|(?<=[.!?])\s+/)
		.map((line) => cleanText(line))
		.filter(Boolean);
	return lines.find((line) => {
		const normalized = canonicalIdentity(line);
		return keyTokens.some((token) => normalized.split(" ").includes(token));
	}) ?? (lines.length === 1 ? lines[0] : "");
}

function normalizeLegacyObjects(objects, submittedContent) {
	const nodeMeta = new Map();
	const attached = new Set();
	const facts = [];
	const relationships = [];
	const rejected = [];
	for (const object of objects ?? []) {
		if (object?.kind !== "node") continue;
		const identity = normalizeIdentity(object, {
			label: object.label,
			existing_node_id: object.matches_existing,
		});
		nodeMeta.set(canonicalIdentity(identity.label), identity);
	}
	for (const object of objects ?? []) {
		if (object?.kind === "event" || object?.kind === "slice") {
			const meta = nodeMeta.get(canonicalIdentity(object.on)) ?? {};
			facts.push(normalizeFact({
				identity: { ...meta, label: object.on ?? meta.label },
				memory: object.kind === "event"
					? { kind: "event", action: object.action, text: object.text, importance: object.importance }
					: { kind: "slice", slice_kind: object.kind_detail, text: object.text },
				confidence: object.confidence,
				supersedes: object.supersedes,
			}));
			attached.add(canonicalIdentity(object.on));
			continue;
		}
		if (object?.kind === "edge") {
			relationships.push(normalizeRelationship(object, nodeMeta));
			continue;
		}
		if (object?.kind === "candidate") {
			rejected.push({ kind: "candidate", label: cleanLabel(object.label), reason: "manual_candidate_disallowed" });
		}
	}
	for (const identity of nodeMeta.values()) {
		if (attached.has(canonicalIdentity(identity.label))) continue;
		const evidence = evidenceLineForLabel(submittedContent, identity.label);
		if (!evidence) {
			rejected.push({ kind: "node", label: identity.label, reason: "node_without_grounded_detail" });
			continue;
		}
		facts.push(normalizeFact({
			identity,
			memory: { kind: "slice", slice_kind: "other", text: evidence },
			confidence: 0.85,
		}));
	}
	return { facts, relationships, rejected };
}

function normalizeProposal(parsed, submittedContent) {
	if (!parsed || typeof parsed !== "object") return { ok: false, facts: [], relationships: [], rejected: [] };
	if (Array.isArray(parsed.objects)) {
		return { ok: true, ...normalizeLegacyObjects(parsed.objects, submittedContent), notes: cleanText(parsed.notes, 500) };
	}
	const facts = Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact) : [];
	const relationships = Array.isArray(parsed.relationships)
		? parsed.relationships.map((item) => normalizeRelationship(item))
		: Array.isArray(parsed.edges)
			? parsed.edges.map((item) => normalizeRelationship(item))
			: [];
	return {
		ok: Array.isArray(parsed.facts) || Array.isArray(parsed.relationships) || Array.isArray(parsed.edges),
		facts,
		relationships,
		rejected: [],
		notes: cleanText(parsed.notes, 500),
	};
}

function stripDirective(value) {
	return cleanText(value)
		.replace(/^(?:please\s+)?(?:remember|save|store|keep)(?:\s+this)?\s*[:,-]?\s*/i, "")
		.trim();
}

function fact(identity, memory, confidence = 0.9, supersedes = false) {
	return normalizeFact({ identity, memory, confidence, supersedes });
}

function trimIdentityTail(value) {
	return cleanLabel(String(value ?? "")
		.replace(/\b(?:yesterday|today|recently|last night|this week)\b.*$/i, "")
		.replace(/\b(?:three|four|five|six|seven|two|\d+)\s+(?:times|days|hours)\b.*$/i, "")
		.trim());
}

function heuristicManualFacts(submittedContent) {
	const facts = [];
	const relationships = [];
	const seen = new Set();
	const addFact = (item) => {
		const key = `${canonicalIdentity(item.identity.label)}:${item.memory.kind}:${item.memory.action ?? item.memory.slice_kind}:${canonicalIdentity(item.memory.text)}`;
		if (!item.identity.label || !item.memory.text || seen.has(key)) return;
		seen.add(key);
		facts.push(item);
	};
	const lines = String(submittedContent ?? "")
		.split(/\n+|(?<=[.!?])\s+/)
		.map(stripDirective)
		.filter(Boolean);

	for (const line of lines) {
		if (!line || classifyMessage(line) === "noise") continue;
		if (/\?$/.test(line) || /\b(?:maybe|might|perhaps|someday|not sure)\b/i.test(line)) continue;

		let match = line.match(/\bmy\s+(grandmother|grandfather|mother|father|mom|mum|dad|sister|brother|wife|husband|partner|friend)\s+(?:died|passed away)\b/i);
		if (match) {
			addFact(fact({ label: match[1], category: "family" }, {
				kind: "event", action: "passed_away", text: line, importance: "life_significant",
			}, 0.98));
			continue;
		}

		match = line.match(/\b(?:i was|the user was|user was)\s+diagnosed with\s+(.+)$/i);
		if (match) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "health" }, {
				kind: "event", action: "diagnosed", text: line, importance: "life_significant",
			}, 0.97));
			continue;
		}

		match = line.match(/\b(?:i|the user|user)\s+(?:have\s+)?moved to\s+(.+)$/i);
		if (match) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "place" }, {
				kind: "event", action: "moved", text: line, importance: "important",
			}, 0.95));
			continue;
		}

		match = line.match(/\b(?:i am|i['’]m|the user is|user is)\s+(?:currently\s+)?(?:building|developing|working on)\s+(?:an?\s+(?:app|project)\s+(?:called|named)\s+)?(.+)$/i);
		if (match) {
			const label = trimIdentityTail(match[1].replace(/\s+(?:that|which)\s+.+$/i, ""));
			addFact(fact({ label, category: "project" }, {
				kind: "slice", slice_kind: "progress", text: line,
			}, 0.92));
			continue;
		}

		match = line.match(/\b(?:i|the user|user)\s+(?:have\s+)?(started|stopped|paused|resumed|completed|finished|launched|quit|joined|left|practiced)\s+(?:(learning|practicing|building|using|working on)\s+)?(.+)$/i);
		if (match) {
			const actionMap = { finished: "completed", quit: "stopped" };
			const action = actionMap[match[1].toLowerCase()] ?? match[1].toLowerCase();
			const qualifier = String(match[2] ?? "").toLowerCase();
			const category = qualifier === "building" || qualifier === "working on"
				? "project"
				: qualifier === "using"
					? "tool"
					: ["joined", "left"].includes(action)
						? "organization"
						: "skill";
			addFact(fact({ label: trimIdentityTail(match[3]), category }, {
				kind: "event", action, text: line, importance: "ordinary",
			}, 0.94));
			continue;
		}

		match = line.match(/\b(?:i|the user|user)\s+(?:have\s+)?(?:decided|chose)\s+to\s+use\s+(.+?)(?:\s+for\s+(.+))?$/i);
		if (match) {
			const tool = trimIdentityTail(match[1]);
			addFact(fact({ label: tool, category: "tool" }, {
				kind: "slice", slice_kind: "decision", text: line,
			}, 0.93, /\b(?:instead|replace|switched)\b/i.test(line)));
			continue;
		}

		match = line.match(/\b(?:i|the user|user)\s+(?:strongly\s+)?prefer\s+(.+)$/i);
		if (match) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "preference" }, {
				kind: "slice", slice_kind: "preference", text: line,
			}, 0.92, /\b(?:now|instead|no longer)\b/i.test(line)));
			continue;
		}

		match = line.match(/\bmy\s+goal\s+is\s+(?:to\s+)?(.+)$/i);
		if (match) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "goal" }, {
				kind: "slice", slice_kind: "progress", text: line,
			}, 0.9));
			continue;
		}

		match = line.match(/^(.{2,80}?)\s+(uses|runs on|depends on|is built with|is powered by)\s+(.+)$/i);
		if (match && !/^(?:i|the user|user)$/i.test(match[1].trim())) {
			const typeMap = {
				"uses": "uses",
				"runs on": "uses",
				"depends on": "depends_on",
				"is built with": "uses",
				"is powered by": "depends_on",
			};
			const from = cleanLabel(match[1]);
			const targets = match[3].split(/\s*(?:,|\band\b)\s*/i).map(trimIdentityTail).filter(Boolean).slice(0, 6);
			for (const to of targets) {
				relationships.push({
					from: normalizeIdentity({ label: from, category: "project" }),
					to: normalizeIdentity({ label: to, category: "tool" }),
					type: typeMap[match[2].toLowerCase()],
					text: line,
					confidence: 0.94,
				});
			}
			continue;
		}

		match = line.match(/\b(?:i|the user|user)\s+(?:currently\s+)?use\s+(.+)$/i);
		if (match) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "tool" }, {
				kind: "slice", slice_kind: "technical_detail", text: line,
			}, 0.9));
			continue;
		}

		match = line.match(/\b(?:i am|i['’]m|the user is|user is)\s+(?:an?\s+)?([a-z][a-z /+-]{2,60})$/i);
		if (match && !/\b(?:fine|okay|ok|here|ready|sure)\b/i.test(match[1])) {
			addFact(fact({ label: trimIdentityTail(match[1]), category: "identity" }, {
				kind: "slice", slice_kind: "other", text: line,
			}, 0.82));
		}
	}

	return { ok: true, facts, relationships, rejected: [], notes: "heuristic_fallback" };
}

function modelPayload(submittedContent, recentContext, nodes) {
	return JSON.stringify({
		submitted_content: String(submittedContent ?? ""),
		recent_context: String(recentContext ?? ""),
		existing_nodes: (nodes ?? []).slice(0, 250).map((node) => ({
			id: node.id,
			label: node.label,
			aliases: manualNodeAliases(node),
			category: node.category,
			role: node.role ?? null,
			summary: node.summary ?? null,
		})),
	});
}

async function callManualModel(env, config, input) {
	if (!env.AI) return null;
	try {
		const result = await env.AI.run(
			config.llm.model,
			{
				messages: [
					{ role: "system", content: MANUAL_SYSTEM_PROMPT },
					{ role: "user", content: modelPayload(input.submittedContent, input.recentContext, input.nodes) },
				],
				temperature: 0,
				max_tokens: config.llm.maxTokens,
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		const parsed = extractJson(responseText(result));
		return normalizeProposal(parsed, input.submittedContent);
	} catch (error) {
		console.warn("manual extraction failed:", error?.message ?? error);
		return null;
	}
}

/** Isolated extraction entrypoint shared only by the MCP manual lane. */
export async function extractManualFacts(env, config, input = {}) {
	let proposal = null;
	if (input.extractionResponse !== undefined && input.extractionResponse !== null) {
		const parsed = typeof input.extractionResponse === "string"
			? extractJson(input.extractionResponse)
			: input.extractionResponse;
		proposal = normalizeProposal(parsed, input.submittedContent);
	} else {
		// Common explicit manual facts have a deterministic path. Besides being
		// faster, this keeps local/offline MCP calls deterministic; the model is
		// reserved for language the conservative parser cannot structure.
		const deterministic = heuristicManualFacts(input.submittedContent);
		if (deterministic.facts.length || deterministic.relationships.length) {
			return { ...deterministic, extractor: "heuristic" };
		}
		proposal = await callManualModel(env, config, input);
	}

	if (proposal?.ok && (proposal.facts.length || proposal.relationships.length)) {
		return { ...proposal, extractor: input.extractionResponse !== undefined ? "override" : "ai" };
	}
	const fallback = heuristicManualFacts(input.submittedContent);
	return {
		...fallback,
		rejected: [...(proposal?.rejected ?? []), ...(fallback.rejected ?? [])],
		extractor: "heuristic",
		model_notes: proposal?.notes ?? null,
	};
}
