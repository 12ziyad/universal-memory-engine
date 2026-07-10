import { ACTIONS, EDGE_TYPES, IMPORTANCE, SLICE_KINDS } from "../config.js";
import { extractJson, responseText } from "./llm.js";
import { canonicalizeCategory } from "./gates.js";
import { canonicalIdentity, manualNodeAliases } from "./manual_identity.js";
import {
	cleanManualEntityLabel,
	parseManualRelationshipCorrection,
	stripManualDirective,
	unsafeManualEntityLabel,
} from "./manual_language.js";
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
  "corrections": [
    {
      "subject": { "label": "Project Name", "category": "project", "existing_node_id": null },
      "old_target": { "label": "Old Tool", "category": "tool", "existing_node_id": null },
      "new_target": { "label": "New Tool", "category": "tool", "existing_node_id": null },
      "type": "uses",
      "text": "the exact submitted correction",
      "current_text": "Project Name uses New Tool.",
      "history_text": "Technology corrected from Old Tool to New Tool.",
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
- Resolve the actual canonical subject before proposing a new identity. Strip wrappers such as "Correction:", "remember that", "my project is", and descriptive type words.
- Identity labels are concise entity noun phrases, preferably 2-6 meaningful words. Never use a command, sentence, predicate, or negated phrase as a label.
- Keep distinct identities distinct. Similar wording or shared project vocabulary is not identity.
- Relationship corrections belong in corrections, not as ordinary positive relationships. The old_target is historical and must never be created from a phrase such as "not X".
- A fact correction or replacement sets supersedes=true.
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
	const value = raw && typeof raw === "object" ? raw : (raw ? { label: raw } : {});
	const rawLabel = cleanText(value.label ?? value.name ?? fallback.label, 240);
	return {
		label: cleanManualEntityLabel(rawLabel) || cleanLabel(rawLabel),
		_raw_label: rawLabel,
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

function normalizeCorrection(raw) {
	const value = raw && typeof raw === "object" ? raw : {};
	const subject = normalizeIdentity(value.subject ?? value.from, { category: "project" });
	const oldTargetRaw = value.old_target ?? value.oldTarget ?? value.previous_target ?? value.previousTarget ?? value.remove;
	const newTargetRaw = value.new_target ?? value.newTarget ?? value.replacement_target ?? value.replacementTarget ?? value.to;
	const oldTarget = oldTargetRaw ? normalizeIdentity(oldTargetRaw, { category: "tool" }) : null;
	const newTarget = newTargetRaw ? normalizeIdentity(newTargetRaw, { category: "tool" }) : null;
	const type = EDGE_TYPES.includes(value.type) ? value.type : "uses";
	const text = cleanText(value.text ?? value.source_text);
	const historyText = cleanText(value.history_text ?? value.historyText ?? (
		oldTarget?.label && newTarget?.label
			? `Technology corrected from ${oldTarget.label} to ${newTarget.label}.`
			: oldTarget?.label
				? `Technology removed: ${oldTarget.label}.`
				: newTarget?.label
					? `Technology corrected to ${newTarget.label}.`
					: ""
	));
	const currentText = cleanText(value.current_text ?? value.currentText ?? (
		newTarget?.label
			? `${subject.label} ${type === "depends_on" ? "depends on" : "uses"} ${newTarget.label}.`
			: oldTarget?.label
				? `${subject.label} no longer ${type === "depends_on" ? "depends on" : "uses"} ${oldTarget.label}.`
				: ""
	));
	return {
		subject,
		old_target: oldTarget,
		new_target: newTarget,
		type,
		text,
		current_text: currentText,
		history_text: historyText,
		confidence: clampConfidence(value.confidence, 0.9),
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
	if (!parsed || typeof parsed !== "object") return { ok: false, facts: [], relationships: [], corrections: [], rejected: [] };
	if (Array.isArray(parsed.objects)) {
		return { ok: true, ...normalizeLegacyObjects(parsed.objects, submittedContent), corrections: [], notes: cleanText(parsed.notes, 500) };
	}
	const facts = Array.isArray(parsed.facts) ? parsed.facts.map(normalizeFact) : [];
	const relationships = Array.isArray(parsed.relationships)
		? parsed.relationships.map((item) => normalizeRelationship(item))
		: Array.isArray(parsed.edges)
			? parsed.edges.map((item) => normalizeRelationship(item))
			: [];
	const corrections = Array.isArray(parsed.corrections)
		? parsed.corrections.map(normalizeCorrection)
		: Array.isArray(parsed.relationship_corrections)
			? parsed.relationship_corrections.map(normalizeCorrection)
			: [];
	return {
		ok: Array.isArray(parsed.facts) || Array.isArray(parsed.relationships) || Array.isArray(parsed.edges) || corrections.length > 0,
		facts,
		relationships,
		corrections,
		rejected: [],
		notes: cleanText(parsed.notes, 500),
	};
}

function stripDirective(value) {
	return stripManualDirective(cleanText(value));
}

function fact(identity, memory, confidence = 0.9, supersedes = false) {
	return normalizeFact({ identity, memory, confidence, supersedes });
}

function mergeManualProposals(deterministic, modelProposal) {
	const facts = [];
	const relationships = [];
	const corrections = [];
	const factKeys = new Set();
	const relationshipKeys = new Set();
	const correctionKeys = new Set();
	// Prefer the model's more precise identity when both extractors describe the
	// same grounded fact sentence. Identity is deliberately excluded from this
	// dedupe key so "Violin" and a heuristic "Violin Practice" cannot both be
	// created for one submitted event.
	for (const item of [...(modelProposal?.facts ?? []), ...(deterministic?.facts ?? [])]) {
		const key = [
			item?.memory?.kind,
			item?.memory?.action ?? item?.memory?.slice_kind,
			canonicalIdentity(item?.memory?.text),
		].join(":");
		if (!item?.identity?.label || !item?.memory?.text || factKeys.has(key)) continue;
		factKeys.add(key);
		facts.push(item);
	}
	for (const item of [...(modelProposal?.relationships ?? []), ...(deterministic?.relationships ?? [])]) {
		const key = [
			canonicalIdentity(item?.from?.label),
			canonicalIdentity(item?.to?.label),
			item?.type,
			canonicalIdentity(item?.text),
		].join(":");
		if (!item?.from?.label || !item?.to?.label || relationshipKeys.has(key)) continue;
		relationshipKeys.add(key);
		relationships.push(item);
	}
	for (const item of [...(modelProposal?.corrections ?? []), ...(deterministic?.corrections ?? [])]) {
		const key = [
			canonicalIdentity(item?.subject?.label),
			canonicalIdentity(item?.old_target?.label),
			canonicalIdentity(item?.new_target?.label),
			item?.type,
		].join(":");
		if (!item?.subject?.label || (!item?.old_target?.label && !item?.new_target?.label) || correctionKeys.has(key)) continue;
		correctionKeys.add(key);
		corrections.push(item);
	}
	// A correction is the authoritative interpretation for its subject/type/new
	// target. Drop an ordinary relationship for the same mutation so it cannot be
	// planned twice.
	const filteredRelationships = relationships.filter((relationship) => !corrections.some((correction) =>
		canonicalIdentity(correction.subject?.label) === canonicalIdentity(relationship.from?.label) &&
		correction.type === relationship.type &&
		canonicalIdentity(correction.new_target?.label) === canonicalIdentity(relationship.to?.label)));
	return {
		ok: Boolean(deterministic?.ok || modelProposal?.ok),
		facts,
		relationships: filteredRelationships,
		corrections,
		rejected: [...(deterministic?.rejected ?? []), ...(modelProposal?.rejected ?? [])],
		notes: modelProposal?.notes ?? deterministic?.notes ?? "",
	};
}

function actionableManualLines(submittedContent) {
	return String(submittedContent ?? "")
		.split(/\n+|(?<=[.!?])\s+/)
		.map(stripDirective)
		.filter(Boolean)
		.filter((line) => classifyMessage(line) !== "noise")
		.filter((line) => !/\?$/.test(line))
		.filter((line) => !/\b(?:maybe|might|perhaps|someday|not sure)\b/i.test(line));
}

function unhandledManualContent(submittedContent, deterministic) {
	const handled = new Set([
		...(deterministic?.facts ?? []).map((item) => canonicalIdentity(item?.memory?.text)),
		...(deterministic?.relationships ?? []).map((item) => canonicalIdentity(item?.text)),
		...(deterministic?.corrections ?? []).map((item) => canonicalIdentity(item?.text)),
	].filter(Boolean));
	return actionableManualLines(submittedContent)
		.filter((line) => !handled.has(canonicalIdentity(line)))
		.join("\n");
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
	const corrections = [];
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
		const correction = parseManualRelationshipCorrection(line);
		if (correction) {
			corrections.push(normalizeCorrection(correction));
			continue;
		}

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

		match = line.match(
			/\b(?:i am|i['’]m|the user is|user is)\s+(?:currently\s+)?(?:building|developing|working on)\s+(?:an?\s+(?:app|project)\s+(?:called|named)\s+)?(.+?)\s+(?:with|using)\s+(.+?)(?:\s+for\s+.+)?$/i,
		);
		if (match) {
			const project = trimIdentityTail(match[1]);
			const targets = match[2]
				.split(/\s*(?:,|\band\b)\s*/i)
				.map(trimIdentityTail)
				.filter(Boolean)
				.slice(0, 6);
			addFact(fact({ label: project, category: "project" }, {
				kind: "slice", slice_kind: "progress", text: line,
			}, 0.94));
			for (const to of targets) {
				relationships.push({
					from: normalizeIdentity({ label: project, category: "project" }),
					to: normalizeIdentity({ label: to, category: "tool" }),
					type: "uses",
					text: line,
					confidence: 0.94,
				});
			}
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
			const from = cleanManualEntityLabel(match[1]);
			const targets = match[3]
				.split(/\s*(?:,|\band\b)\s*/i)
				.map(trimIdentityTail)
				.filter((target) => target && !unsafeManualEntityLabel(target))
				.slice(0, 6);
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

	return { ok: true, facts, relationships, corrections, rejected: [], notes: "heuristic_fallback" };
}

function modelPayload(submittedContent, recentContext, nodes, graphState = {}) {
	const byId = new Map((nodes ?? []).map((node) => [node.id, node]));
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
			current_details: (graphState.slices ?? [])
				.filter((slice) => slice.node_id === node.id && Number(slice.is_current ?? 1) === 1)
				.slice(0, 12)
				.map((slice) => slice.text),
			relationships: (graphState.edges ?? [])
				.filter((edge) => edge.from_node === node.id || edge.to_node === node.id)
				.slice(0, 12)
				.map((edge) => ({
					type: edge.type,
					direction: edge.from_node === node.id ? "outgoing" : "incoming",
					other_label: byId.get(edge.from_node === node.id ? edge.to_node : edge.from_node)?.label ?? null,
				})),
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
					{ role: "user", content: modelPayload(input.submittedContent, input.recentContext, input.nodes, input.graphState) },
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
	const deterministic = heuristicManualFacts(input.submittedContent);
	let modelProposal = null;
	if (input.extractionResponse !== undefined && input.extractionResponse !== null) {
		const parsed = typeof input.extractionResponse === "string"
			? extractJson(input.extractionResponse)
			: input.extractionResponse;
		modelProposal = normalizeProposal(parsed, input.submittedContent);
	} else {
		// The heuristic path provides deterministic high-confidence facts, while the
		// model is still allowed to recover durable facts from unrecognized sentences
		// in the same submission. Returning after the first heuristic match silently
		// dropped the remainder of mixed manual saves.
		const unhandledContent = unhandledManualContent(input.submittedContent, deterministic);
		if (unhandledContent) modelProposal = await callManualModel(env, config, input);
	}

	const combined = mergeManualProposals(deterministic, modelProposal);
	if (combined.facts.length || combined.relationships.length || combined.corrections.length) {
		const usedHeuristic = deterministic.facts.length > 0 || deterministic.relationships.length > 0 || deterministic.corrections.length > 0;
		const usedModel = (modelProposal?.facts?.length ?? 0) > 0 ||
			(modelProposal?.relationships?.length ?? 0) > 0 ||
			(modelProposal?.corrections?.length ?? 0) > 0;
		return {
			...combined,
			extractor: usedHeuristic && usedModel
				? (input.extractionResponse !== undefined ? "heuristic+override" : "heuristic+ai")
				: usedHeuristic
					? "heuristic"
					: (input.extractionResponse !== undefined ? "override" : "ai"),
		};
	}
	return {
		...deterministic,
		rejected: [...(deterministic.rejected ?? []), ...(modelProposal?.rejected ?? [])],
		extractor: "heuristic",
		model_notes: modelProposal?.notes ?? null,
	};
}
