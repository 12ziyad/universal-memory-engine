import { ACTIONS, EDGE_TYPES, IMPORTANCE, SLICE_KINDS } from "../config.js";
import { extractJson, responseText } from "./llm.js";
import { canonicalizeCategory } from "./gates.js";
import { canonicalIdentity } from "./manual_identity.js";
import {
	cleanManualEntityLabel,
	parseManualRelationshipCorrection,
	stripManualDirective,
	unsafeManualEntityLabel,
} from "./manual_language.js";
import { titleCaseWords } from "./title.js";

const MANUAL_SYSTEM_PROMPT = `You are the isolated MANUAL memory extractor. The user explicitly submitted content to a memory tool.

Return exactly one JSON object:
{
  "primary_subject_ref": "E0",
  "primary_memory": {
    "kind": "slice",
    "slice_kind": "other",
    "text": "A self-contained memory supported only by the submitted source",
    "evidence_ids": ["M0"],
    "evidence_spans": [{ "message_ref": "M0", "quote": "exact source words" }],
    "confidence": 0.95,
    "attribution": "user_stated",
    "polarity": "positive",
    "modality": "asserted",
    "temporal_status": "current"
  },
  "entities": [
    {
      "ref": "E0",
      "label": "Boxing",
      "category": "skill",
      "mention_role": "primary_subject",
      "aliases": [],
      "evidence_ids": ["M0"],
      "evidence_spans": [{ "message_ref": "M0", "quote": "boxing" }]
    }
  ],
  "facts": [
    {
      "subject_ref": "E0",
      "memory": { "kind": "event", "action": "started", "text": "The user started boxing", "importance": "ordinary" },
      "evidence_ids": ["M0"],
      "evidence_spans": [{ "message_ref": "M0", "quote": "started boxing" }],
      "confidence": 0.95,
      "attribution": "user_stated",
      "polarity": "positive",
      "modality": "asserted",
      "temporal_status": "current"
    }
  ],
  "relationships": [
    {
      "from_ref": "E0",
      "to_ref": "E1",
      "type": "uses",
      "text": "UML uses D1",
      "evidence_ids": ["M0"],
      "evidence_spans": [{ "message_ref": "M0", "quote": "UML uses D1" }],
      "confidence": 0.95
    }
  ],
  "corrections": [
    {
      "kind": "relationship",
      "subject_ref": "E0",
      "predicate": "uses",
      "old_target_ref": "E1",
      "new_target_ref": "E2",
      "text": "the exact submitted correction",
      "evidence_ids": ["M0"],
      "evidence_spans": [{ "message_ref": "M0", "quote": "exact correction words" }],
      "confidence": 0.95
    }
  ],
  "notes": ""
}

Hard rules:
- Extract identities, predicates, and values ONLY from source_messages.
- reference_context may resolve "it", "that", or a name, but must never be cited in evidence_ids or supply a fact, predicate, preference, event, or value.
- The input contains no existing memories. Never invent an existing node reference or database identifier.
- Never output candidates. Assistant-only, unsafe, or unsupported material is omitted; grounded uncertainty is represented with modality "possible".
- The explicit primary manual memory is durable. Preserve grounded casual, temporary, planned, possible, negative, current, and historical content using metadata instead of dropping it.
- Return one coherent primary_subject_ref. Every entity receives a local E-number and one allowed mention_role.
- Allowed mention roles: primary_subject, relationship_target, independent_fact_subject, comparison, example, option, historical_reference, correction_old_target, correction_new_target, incidental_mention.
- Evidence IDs must be source message refs such as M0. Evidence spans quote exact words from that message.
- Every persisted identity must have a primary memory, fact, event, explicit relationship, or correction role. Never return a bare node.
- Resolve the actual canonical subject before proposing a new identity. Strip wrappers such as "Correction:", "remember that", "my project is", and descriptive type words.
- Identity labels are concise entity noun phrases, preferably 2-6 meaningful words. Never use a command, sentence, predicate, or negated phrase as a label.
- Keep distinct identities distinct. Similar wording or shared project vocabulary is not identity.
- Relationship corrections belong in corrections, not as ordinary positive relationships. The old_target is historical and must never be created from a phrase such as "not X".
- A fact correction or replacement sets supersedes=true.
- Slice kinds: ${SLICE_KINDS.join(", ")}.
- Event actions: ${ACTIONS.join(", ")}.
- Importance: ${IMPORTANCE.join(", ")}.
- Relationship types: ${EDGE_TYPES.join(", ")}.
- Do not turn questions, greetings, thanks, jokes, generic world facts, or tool instructions into asserted facts.`;

export const MANUAL_MENTION_ROLES = Object.freeze([
	"primary_subject",
	"relationship_target",
	"independent_fact_subject",
	"comparison",
	"example",
	"option",
	"historical_reference",
	"correction_old_target",
	"correction_new_target",
	"incidental_mention",
]);

const MANUAL_ATTRIBUTIONS = new Set(["user_stated", "user_adopted"]);
const MANUAL_POLARITIES = new Set(["positive", "negative"]);
const MANUAL_MODALITIES = new Set(["asserted", "planned", "possible"]);
const MANUAL_TEMPORAL_STATUSES = new Set(["current", "historical", "timeless"]);

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

function safeSourceRole(value) {
	const role = String(value ?? "user").toLocaleLowerCase("en-US");
	return ["user", "assistant"].includes(role) ? role : "user";
}

function plainScope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const scope = {};
	for (const [key, item] of Object.entries(value)) {
		if (["string", "number", "boolean"].includes(typeof item) || item === null) scope[key] = item;
	}
	return scope;
}

function sourceMessagesFromInput(input = {}) {
	const supplied = Array.isArray(input.sourceMessages)
		? input.sourceMessages
		: Array.isArray(input.messages)
			? input.messages
			: [];
	const messages = supplied
		.map((message, index) => ({
			ref: `M${index}`,
			role: safeSourceRole(typeof message === "string" ? "user" : message?.role),
			content: String(typeof message === "string" ? message : message?.content ?? "").trim(),
			source_message_id: typeof message === "string" ? null : (message?.id ?? message?.source_message_id ?? null),
			attribution: typeof message === "string" ? null : message?.attribution,
			claim_id: typeof message === "string" ? null : (message?.claim_id ?? message?.claimId ?? null),
		}))
		.filter((message) => message.content);
	if (!messages.length) {
		const content = String(input.submittedContent ?? input.content ?? "").trim();
		if (content) messages.push({ ref: "M0", role: "user", content, source_message_id: input.messageId ?? null });
	}
	return messages.map((message, index) => ({ ...message, ref: `M${index}` }));
}

function referenceContextFromInput(input = {}) {
	const supplied = input.referenceContext ?? input.recentContext;
	const values = Array.isArray(supplied) ? supplied : supplied ? [supplied] : [];
	return values
		.map((item, index) => ({
			ref: `R${index}`,
			content: String(typeof item === "string" ? item : item?.content ?? "").trim(),
		}))
		.filter((item) => item.content)
		.map((item, index) => ({ ...item, ref: `R${index}` }));
}

/** Pure source-only envelope; graph-shaped input fields are ignored. */
export function buildManualSourceEnvelope(input = {}) {
	return {
		source_messages: sourceMessagesFromInput(input).map(({ ref, role, content, attribution, claim_id }) => ({
			ref,
			role,
			content,
			...(attribution === "user_adopted" ? { attribution } : {}),
			...(claim_id ? { claim_id } : {}),
		})),
		reference_context: referenceContextFromInput(input),
		resolved_scope: plainScope(input.resolvedScope ?? input.scope),
	};
}

function sourceIndex(envelope) {
	return new Map((envelope?.source_messages ?? []).map((message) => [message.ref, message]));
}

function sourceAttribution(item, envelope) {
	const sources = sourceIndex(envelope);
	const evidenceIds = item?.evidence_ids ?? item?.evidenceIds ?? [];
	return (Array.isArray(evidenceIds) ? evidenceIds : [evidenceIds])
		.some((id) => sources.get(String(id))?.attribution === "user_adopted")
		? "user_adopted"
		: item?.attribution;
}

function metadataDefaults(text, raw = {}) {
	const source = String(text ?? "");
	const requestedAttribution = raw.attribution;
	const requestedPolarity = raw.polarity;
	const requestedModality = raw.modality;
	const requestedTemporal = raw.temporal_status ?? raw.temporalStatus;
	const possible = /\b(?:maybe|might|may|perhaps|possibly|considering|not sure)\b/i.test(source);
	const planned = /\b(?:plan(?:ning|ned)?|will|going to|intend(?:ing|ed)?|want to|hope to)\b/i.test(source);
	const historical = /\b(?:used to|previously|formerly|in the past|yesterday|last (?:week|month|year|night)|had|was|were)\b/i.test(source);
	return {
		attribution: MANUAL_ATTRIBUTIONS.has(requestedAttribution) ? requestedAttribution : "user_stated",
		polarity: MANUAL_POLARITIES.has(requestedPolarity)
			? requestedPolarity
			: /\b(?:not|never|no longer|don['’]t|doesn['’]t|didn['’]t|cannot|can['’]t|without)\b/i.test(source)
				? "negative"
				: "positive",
		modality: MANUAL_MODALITIES.has(requestedModality)
			? requestedModality
			: possible
				? "possible"
				: planned
					? "planned"
					: "asserted",
		temporal_status: MANUAL_TEMPORAL_STATUSES.has(requestedTemporal)
			? requestedTemporal
			: historical
				? "historical"
				: "current",
	};
}

function normalizeEvidenceIds(rawIds, envelope, fallbackText = "") {
	const sources = sourceIndex(envelope);
	const requested = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
	const valid = [...new Set(requested.map(String).filter((id) => sources.get(id)?.role === "user"))];
	if (valid.length) return valid;
	const needle = canonicalIdentity(fallbackText);
	if (needle) {
		const matching = (envelope?.source_messages ?? []).find((message) => message.role === "user" && (
			canonicalIdentity(message.content).includes(needle) || needle.includes(canonicalIdentity(message.content))
		));
		if (matching) return [matching.ref];
	}
	const firstUser = (envelope?.source_messages ?? []).find((message) => message.role === "user");
	return firstUser?.ref ? [firstUser.ref] : [];
}

function normalizeEvidenceSpans(rawSpans, evidenceIds, envelope, fallbackText = "") {
	const sources = sourceIndex(envelope);
	const spans = [];
	for (const raw of Array.isArray(rawSpans) ? rawSpans : []) {
		if (!raw || typeof raw !== "object") continue;
		const messageRef = String(raw.message_ref ?? raw.messageRef ?? raw.message_id ?? raw.evidence_id ?? "");
		const message = sources.get(messageRef);
		if (!message || message.role !== "user") continue;
		const quote = String(raw.quote ?? raw.text ?? "").trim();
		let start = Number(raw.start);
		let end = Number(raw.end);
		if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= message.content.length) {
			const exact = message.content.slice(start, end);
			if (quote && exact !== quote) continue;
			spans.push({ message_ref: messageRef, start, end, quote: exact });
			continue;
		}
		if (!quote) continue;
		start = message.content.indexOf(quote);
		if (start < 0) continue;
		end = start + quote.length;
		spans.push({ message_ref: messageRef, start, end, quote });
	}
	if (spans.length) return spans.slice(0, 12);
	const fallback = String(fallbackText ?? "").trim();
	for (const evidenceId of evidenceIds) {
		const message = sources.get(evidenceId);
		if (!message) continue;
		let quote = fallback;
		let start = quote ? message.content.indexOf(quote) : -1;
		if (start < 0) {
			quote = message.content;
			start = 0;
		}
		if (!quote) continue;
		return [{ message_ref: evidenceId, start, end: start + quote.length, quote }];
	}
	return [];
}

function evidenceMetadata(raw, envelope, fallbackText = "") {
	const evidenceIds = normalizeEvidenceIds(raw?.evidence_ids ?? raw?.evidenceIds, envelope, fallbackText);
	return {
		evidence_ids: evidenceIds,
		evidence_spans: normalizeEvidenceSpans(
			raw?.evidence_spans ?? raw?.evidenceSpans,
			evidenceIds,
			envelope,
			fallbackText,
		),
	};
}

function normalizeIdentity(raw, fallback = {}) {
	const value = raw && typeof raw === "object" ? raw : (raw ? { label: raw } : {});
	const rawLabel = cleanText(
		value._raw_label ?? value.raw_label ?? value.rawLabel ?? value.label ?? value.name ?? fallback.label,
		240,
	);
	return {
		label: cleanManualEntityLabel(rawLabel) || cleanLabel(rawLabel),
		_raw_label: rawLabel,
		category: canonicalizeCategory(value.category ?? value.role ?? fallback.category) ?? "other",
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

function normalizeFact(raw, envelope = {}, entities = new Map()) {
	const value = raw && typeof raw === "object" ? raw : {};
	const referencedIdentity = entities.get(String(value.subject_ref ?? value.subjectRef ?? ""));
	const identity = normalizeIdentity(value.identity ?? value.subject ?? referencedIdentity, {
		label: value.label ?? value.on,
		category: value.category,
		aliases: value.aliases,
	});
	const memory = normalizeMemory(value.memory ?? value.detail ?? value.fact, {
		kind: value.memory_kind ?? (value.action ? "event" : "slice"),
		text: value.text,
		slice_kind: value.slice_kind ?? value.kind_detail,
	});
	const evidence = evidenceMetadata(value, envelope, memory.text);
	return {
		subject_ref: referencedIdentity?.ref ?? value.subject_ref ?? value.subjectRef ?? null,
		identity,
		memory,
		...evidence,
		...metadataDefaults(memory.text, value),
		confidence: clampConfidence(value.confidence),
		supersedes: Boolean(value.supersedes ?? value.replaces ?? value.correction),
	};
}

function normalizeRelationship(raw, nodeMeta = new Map(), envelope = {}, entities = new Map()) {
	const value = raw && typeof raw === "object" ? raw : {};
	const referencedFrom = entities.get(String(value.from_ref ?? value.fromRef ?? ""));
	const referencedTo = entities.get(String(value.to_ref ?? value.toRef ?? ""));
	const fromLabel = value.from?.label ?? value.from_label ?? value.from ?? referencedFrom?.label;
	const toLabel = value.to?.label ?? value.to_label ?? value.to ?? referencedTo?.label;
	const fromMeta = nodeMeta.get(canonicalIdentity(fromLabel)) ?? {};
	const toMeta = nodeMeta.get(canonicalIdentity(toLabel)) ?? {};
	const text = cleanText(value.text ?? `${fromLabel ?? ""} ${value.type ?? "related to"} ${toLabel ?? ""}`);
	return {
		from_ref: referencedFrom?.ref ?? value.from_ref ?? value.fromRef ?? null,
		to_ref: referencedTo?.ref ?? value.to_ref ?? value.toRef ?? null,
		from: normalizeIdentity(value.from && typeof value.from === "object" ? value.from : referencedFrom, {
			...fromMeta,
			label: fromLabel,
		}),
		to: normalizeIdentity(value.to && typeof value.to === "object" ? value.to : referencedTo, {
			...toMeta,
			label: toLabel,
		}),
		type: EDGE_TYPES.includes(value.type) ? value.type : null,
		text,
		...evidenceMetadata(value, envelope, text),
		...metadataDefaults(text, value),
		confidence: clampConfidence(value.confidence),
	};
}

function normalizeCorrection(raw, envelope = {}, entities = new Map()) {
	const value = raw && typeof raw === "object" ? raw : {};
	const subjectRef = String(value.subject_ref ?? value.subjectRef ?? "");
	const oldTargetRef = String(value.old_target_ref ?? value.oldTargetRef ?? "");
	const newTargetRef = String(value.new_target_ref ?? value.newTargetRef ?? "");
	const subject = normalizeIdentity(value.subject ?? value.from ?? entities.get(subjectRef), { category: "project" });
	const oldTargetRaw = value.old_target ?? value.oldTarget ?? value.previous_target ?? value.previousTarget ?? value.remove ?? entities.get(oldTargetRef);
	const newTargetRaw = value.new_target ?? value.newTarget ?? value.replacement_target ?? value.replacementTarget ?? value.to ?? entities.get(newTargetRef);
	const oldTarget = oldTargetRaw ? normalizeIdentity(oldTargetRaw, { category: "tool" }) : null;
	const newTarget = newTargetRaw ? normalizeIdentity(newTargetRaw, { category: "tool" }) : null;
	const requestedPredicate = value.predicate ?? value.type;
	const type = EDGE_TYPES.includes(requestedPredicate) ? requestedPredicate : "uses";
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
		kind: value.kind === "fact" ? "fact" : "relationship",
		subject_ref: entities.get(subjectRef)?.ref ?? (subjectRef || null),
		predicate: cleanText(value.predicate ?? type, 80),
		slice_kind: value.kind === "fact"
			? (SLICE_KINDS.includes(value.slice_kind ?? value.sliceKind)
				? (value.slice_kind ?? value.sliceKind)
				: SLICE_KINDS.includes(requestedPredicate) ? requestedPredicate : "other")
			: null,
		old_value: value.old_value ?? value.oldValue ?? null,
		new_value: value.new_value ?? value.newValue ?? value.replacement ?? null,
		old_target_ref: entities.get(oldTargetRef)?.ref ?? (oldTargetRef || null),
		new_target_ref: entities.get(newTargetRef)?.ref ?? (newTargetRef || null),
		subject,
		old_target: oldTarget,
		new_target: newTarget,
		type,
		text,
		current_text: currentText,
		history_text: historyText,
		...evidenceMetadata(value, envelope, text || currentText || historyText),
		...metadataDefaults(text || currentText || historyText, value),
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

function normalizeLegacyObjects(objects, envelope) {
	const submittedContent = (envelope?.source_messages ?? []).map((message) => message.content).join("\n");
	const nodeMeta = new Map();
	const attached = new Set();
	const facts = [];
	const relationships = [];
	const rejected = [];
	for (const object of objects ?? []) {
		if (object?.kind !== "node") continue;
		const identity = normalizeIdentity(object, { label: object.label });
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
			}, envelope));
			attached.add(canonicalIdentity(object.on));
			continue;
		}
		if (object?.kind === "edge") {
			relationships.push(normalizeRelationship(object, nodeMeta, envelope));
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
		}, envelope));
	}
	return { facts, relationships, rejected };
}

const ROLE_PRIORITY = new Map([
	["primary_subject", 100],
	["correction_new_target", 90],
	["relationship_target", 80],
	["independent_fact_subject", 80],
	["correction_old_target", 70],
	["historical_reference", 60],
	["option", 40],
	["comparison", 30],
	["example", 20],
	["incidental_mention", 10],
]);

function safeMentionRole(value, fallback = "incidental_mention") {
	return MANUAL_MENTION_ROLES.includes(value) ? value : fallback;
}

function entityRoleForUse(current, requested) {
	if (!current) return requested;
	return (ROLE_PRIORITY.get(requested) ?? 0) > (ROLE_PRIORITY.get(current) ?? 0) ? requested : current;
}

function emptyManualStructure() {
	return {
		ok: false,
		primary_subject_ref: null,
		primary_memory: null,
		entities: [],
		facts: [],
		relationships: [],
		corrections: [],
		rejected: [],
		notes: "",
	};
}

function normalizeFlatProposal(parsed, envelope) {
	if (!parsed || typeof parsed !== "object") return emptyManualStructure();
	if (Array.isArray(parsed.objects)) {
		return { ok: true, ...normalizeLegacyObjects(parsed.objects, envelope), corrections: [], notes: cleanText(parsed.notes, 500) };
	}
	const facts = Array.isArray(parsed.facts) ? parsed.facts.map((item) => normalizeFact(item, envelope)) : [];
	const relationships = Array.isArray(parsed.relationships)
		? parsed.relationships.map((item) => normalizeRelationship(item, new Map(), envelope))
		: Array.isArray(parsed.edges)
			? parsed.edges.map((item) => normalizeRelationship(item, new Map(), envelope))
			: [];
	const corrections = Array.isArray(parsed.corrections)
		? parsed.corrections.map((item) => normalizeCorrection(item, envelope))
		: Array.isArray(parsed.relationship_corrections)
			? parsed.relationship_corrections.map((item) => normalizeCorrection(item, envelope))
			: [];
	return {
		ok: Array.isArray(parsed.facts) || Array.isArray(parsed.relationships) || Array.isArray(parsed.edges) || corrections.length > 0,
		facts,
		relationships,
		corrections,
		rejected: [...(parsed.rejected ?? [])],
		notes: cleanText(parsed.notes, 500),
	};
}

/** Normalize source-only extraction while retaining legacy embedded identities. */
export function normalizeManualStructure(parsed, envelopeInput = {}) {
	const envelope = Array.isArray(envelopeInput?.source_messages)
		? envelopeInput
		: buildManualSourceEnvelope(envelopeInput);
	if (!parsed || typeof parsed !== "object") return emptyManualStructure();
	const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
	const rawByRef = new Map(rawEntities.filter((entity) => entity?.ref).map((entity) => [String(entity.ref), entity]));
	const entityFor = (ref) => ref ? rawByRef.get(String(ref)) ?? null : null;
	const adapted = Array.isArray(parsed.objects) ? parsed : {
		...parsed,
		facts: (parsed.facts ?? []).map((item) => ({
			...item,
			identity: item?.identity ?? item?.subject ?? entityFor(item?.subject_ref ?? item?.subjectRef),
		})),
		relationships: (parsed.relationships ?? parsed.edges ?? []).map((item) => ({
			...item,
			from: item?.from ?? entityFor(item?.from_ref ?? item?.fromRef),
			to: item?.to ?? entityFor(item?.to_ref ?? item?.toRef),
		})),
		corrections: (parsed.corrections ?? parsed.relationship_corrections ?? []).map((item) => ({
			...item,
			subject: item?.subject ?? entityFor(item?.subject_ref ?? item?.subjectRef),
			old_target: item?.old_target ?? item?.oldTarget ?? entityFor(item?.old_target_ref ?? item?.oldTargetRef),
			new_target: item?.new_target ?? item?.newTarget ?? entityFor(item?.new_target_ref ?? item?.newTargetRef),
		})),
	};
	const flat = normalizeFlatProposal(adapted, envelope);
	const entities = [];
	const byKey = new Map();
	const rawToLocal = new Map();
	const rejected = [...(flat.rejected ?? [])];

	function addEntity(raw, requestedRole = "incidental_mention") {
		const identity = normalizeIdentity(raw);
		if (!identity.label) return null;
		const key = `${canonicalIdentity(identity.label)}:${identity.category ?? "other"}`;
		const declaredRole = raw?.mention_role ?? raw?.mentionRole;
		const role = safeMentionRole(declaredRole, requestedRole);
		let entity = byKey.get(key);
		if (!entity) {
			entity = {
				...identity,
				ref: `E${entities.length}`,
				mention_role: role,
				_mention_role_locked: MANUAL_MENTION_ROLES.includes(declaredRole),
				...evidenceMetadata(raw, envelope, identity.label),
			};
			entities.push(entity);
			byKey.set(key, entity);
		} else {
			if (!entity._mention_role_locked) entity.mention_role = entityRoleForUse(entity.mention_role, role);
			if (MANUAL_MENTION_ROLES.includes(declaredRole)) {
				entity.mention_role = declaredRole;
				entity._mention_role_locked = true;
			}
			entity.aliases = [...new Set([...(entity.aliases ?? []), ...(identity.aliases ?? [])])].slice(0, 12);
			const evidence = evidenceMetadata(raw, envelope, identity.label);
			entity.evidence_ids = [...new Set([...(entity.evidence_ids ?? []), ...evidence.evidence_ids])];
			entity.evidence_spans = [...(entity.evidence_spans ?? []), ...evidence.evidence_spans].slice(0, 12);
		}
		const rawRef = raw?.ref ?? raw?.entity_ref ?? raw?.entityRef;
		if (rawRef) rawToLocal.set(String(rawRef), entity);
		return entity;
	}

	for (const rawEntity of rawEntities) addEntity(rawEntity);
	const facts = [];
	for (let index = 0; index < (flat.facts ?? []).length; index++) {
		const item = flat.facts[index];
		const requested = adapted.facts?.[index]?.subject_ref ?? adapted.facts?.[index]?.subjectRef;
		const entity = rawToLocal.get(String(requested ?? "")) ?? addEntity(item.identity, "independent_fact_subject");
		if (entity) facts.push({ ...item, subject_ref: entity.ref, identity: entity });
		else rejected.push({ kind: "fact", label: null, reason: requested ? "unknown_entity_ref" : "missing_fact_subject" });
	}
	const relationships = [];
	for (const item of flat.relationships ?? []) {
		const from = addEntity(item.from, "independent_fact_subject");
		const to = addEntity(item.to, "relationship_target");
		if (!from || !to) {
			rejected.push({ kind: "edge", label: from?.label ?? null, reason: "unknown_entity_ref" });
			continue;
		}
		if (!to._mention_role_locked) to.mention_role = entityRoleForUse(to.mention_role, "relationship_target");
		relationships.push({ ...item, from_ref: from.ref, to_ref: to.ref, from, to });
	}
	const corrections = [];
	for (const item of flat.corrections ?? []) {
		const subject = addEntity(item.subject, "independent_fact_subject");
		const oldTarget = item.old_target ? addEntity(item.old_target, "correction_old_target") : null;
		const newTarget = item.new_target ? addEntity(item.new_target, "correction_new_target") : null;
		if (!subject) {
			rejected.push({ kind: "correction", label: null, reason: "unknown_entity_ref" });
			continue;
		}
		if (oldTarget && !oldTarget._mention_role_locked) oldTarget.mention_role = entityRoleForUse(oldTarget.mention_role, "correction_old_target");
		if (newTarget && !newTarget._mention_role_locked) newTarget.mention_role = entityRoleForUse(newTarget.mention_role, "correction_new_target");
		corrections.push({
			...item,
			subject_ref: subject.ref,
			old_target_ref: oldTarget?.ref ?? null,
			new_target_ref: newTarget?.ref ?? null,
			subject,
			old_target: oldTarget,
			new_target: newTarget,
		});
	}
	const requestedPrimaryRef = String(parsed.primary_subject_ref ?? parsed.primarySubjectRef ?? "");
	const requestedPrimary = rawToLocal.get(requestedPrimaryRef);
	if (requestedPrimaryRef && !requestedPrimary) {
		rejected.push({ kind: "identity", label: null, reason: "unknown_primary_subject_ref" });
	}
	const primary = requestedPrimaryRef
		? requestedPrimary ?? null
		: entities.find((entity) => entity.mention_role === "primary_subject") ??
			facts[0]?.identity ?? corrections[0]?.subject ?? relationships[0]?.from ??
			entities.find((entity) => !["comparison", "example", "option", "incidental_mention"].includes(entity.mention_role)) ?? null;
	if (primary) {
		for (const entity of entities) {
			if (entity === primary && !entity._mention_role_locked) entity.mention_role = "primary_subject";
			else if (entity !== primary && entity.mention_role === "primary_subject" && !entity._mention_role_locked) {
				entity.mention_role = "independent_fact_subject";
			}
		}
	}
	const rawPrimary = parsed.primary_memory ?? parsed.primaryMemory;
	let primaryMemory = null;
	if (rawPrimary && typeof rawPrimary === "object") {
		const memory = normalizeMemory(rawPrimary.memory ?? rawPrimary, rawPrimary);
		primaryMemory = {
			...memory,
			...evidenceMetadata(rawPrimary, envelope, memory.text),
			...metadataDefaults(memory.text, rawPrimary),
			confidence: clampConfidence(rawPrimary.confidence, 0.9),
		};
	} else {
		const seed = facts.find((item) => item.identity === primary) ?? null;
		const text = seed?.memory?.text ?? corrections.find((item) => item.subject === primary)?.current_text ??
			relationships.find((item) => item.from === primary)?.text ?? "";
		if (text) {
			const memory = seed?.memory ?? { kind: "slice", slice_kind: "other", text };
			primaryMemory = {
				...memory,
				...evidenceMetadata(seed ?? {}, envelope, text),
				...metadataDefaults(text, seed ?? {}),
				confidence: clampConfidence(seed?.confidence, 0.9),
			};
		}
	}
	if (primaryMemory) primaryMemory.attribution = sourceAttribution(primaryMemory, envelope) ?? primaryMemory.attribution;
	for (const item of [...facts, ...relationships, ...corrections]) {
		item.attribution = sourceAttribution(item, envelope) ?? item.attribution;
		if (item.memory) item.memory.attribution = item.attribution;
	}
	return {
		ok: Boolean(flat.ok || rawEntities.length || rawPrimary),
		primary_subject_ref: primary?.ref ?? null,
		primary_memory: primaryMemory,
		entities,
		facts,
		relationships,
		corrections,
		rejected,
		notes: flat.notes ?? cleanText(parsed.notes, 500),
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
		const factCorrection = item?.kind === "fact";
		const key = [
			item?.kind,
			canonicalIdentity(item?.subject?.label),
			factCorrection ? canonicalIdentity(item?.old_value ?? item?.old_text) : canonicalIdentity(item?.old_target?.label),
			factCorrection ? canonicalIdentity(item?.new_value ?? item?.new_text) : canonicalIdentity(item?.new_target?.label),
			factCorrection ? canonicalIdentity(item?.predicate) : item?.type,
		].join(":");
		const complete = factCorrection
			? Boolean(item?.old_value ?? item?.old_text) && Boolean(item?.new_value ?? item?.new_text)
			: Boolean(item?.old_target?.label || item?.new_target?.label);
		if (!item?.subject?.label || !complete || correctionKeys.has(key)) continue;
		correctionKeys.add(key);
		corrections.push(item);
	}
	// A correction is the authoritative interpretation for its subject/type/new
	// target. Drop an ordinary relationship for the same mutation so it cannot be
	// planned twice.
	const filteredRelationships = relationships.filter((relationship) => !corrections.some((correction) =>
		correction.kind !== "fact" &&
		canonicalIdentity(correction.subject?.label) === canonicalIdentity(relationship.from?.label) &&
		correction.type === relationship.type &&
		canonicalIdentity(correction.new_target?.label) === canonicalIdentity(relationship.to?.label)));
	const filteredFacts = facts.filter((fact) => !corrections.some((correction) => {
		if (correction.kind !== "fact" || canonicalIdentity(correction.subject?.label) !== canonicalIdentity(fact.identity?.label)) {
			return false;
		}
		const factText = canonicalIdentity(fact.memory?.text);
		const replacement = canonicalIdentity(correction.new_value ?? correction.new_text ?? correction.current_text);
		const correctionText = canonicalIdentity(correction.text ?? correction.current_text);
		return Boolean(factText) && (
			factText === replacement || correctionText.includes(factText) ||
			(Boolean(replacement) && factText.includes(replacement))
		);
	}));
	return {
		ok: Boolean(deterministic?.ok || modelProposal?.ok),
		facts: filteredFacts,
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
		.filter((line) => !/^\s*(?:what|who|when|where|why|how|can|could|would|should|do|does|did|is|are)\b.*\?$/i.test(line));
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

const FALLBACK_TOPIC_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "for", "from",
	"had", "has", "have", "i", "in", "is", "it", "may", "maybe", "me", "might", "my", "of", "on", "or", "our", "perhaps", "remember",
	"save", "should", "someday", "store", "that", "the", "this", "to", "was", "were", "will", "with", "would", "you",
]);

function fallbackTopicIdentity(value) {
	const all = canonicalIdentity(value).split(" ").filter(Boolean);
	const meaningful = all.filter((word) => word.length > 1 && !FALLBACK_TOPIC_STOPWORDS.has(word));
	const selected = meaningful.slice(0, 6);
	if (selected.length < 2) {
		for (const word of all) {
			if (word.length <= 1 || selected.includes(word) || ["i", "my", "this", "that", "it"].includes(word)) continue;
			selected.push(word);
			if (selected.length >= 2) break;
		}
	}
	// An explicit manual save is itself the durability decision. A one-word but
	// otherwise grounded submission still needs a stable identity; "Note" labels
	// the container and does not assert any new fact about the submitted content.
	if (selected.length === 1) selected.push("note");
	return titleCaseWords(selected.slice(0, 6).join(" "));
}

function fallbackCategory(value) {
	const text = canonicalIdentity(value);
	if (/\b(?:day|workday|happened|experience|felt|feeling|work)\b/.test(text)) return "experience";
	if (/\b(?:prefer|favorite|favourite|like|dislike)\b/.test(text)) return "preference";
	if (/\b(?:goal|aim|hope|want)\b/.test(text)) return "goal";
	return "other";
}

/** Deterministic last-resort structure for an explicit, grounded manual save. */
export function buildGroundedManualFallback(envelopeInput = {}) {
	const envelope = Array.isArray(envelopeInput?.source_messages)
		? envelopeInput
		: buildManualSourceEnvelope(envelopeInput);
	const message = (envelope.source_messages ?? []).find((item) => item.role === "user" && item.content.trim());
	if (!message) return emptyManualStructure();
	const memoryText = stripDirective(message.content);
	if (!memoryText || /^(?:this|that|it)$/i.test(memoryText)) return emptyManualStructure();
	if (/^(?:it|this|that|they|them|he|she|him|her)\b/i.test(memoryText)) return emptyManualStructure();
	const label = fallbackTopicIdentity(memoryText);
	if (!label || canonicalIdentity(label).split(" ").length < 2) return emptyManualStructure();
	const evidenceSpan = { message_ref: message.ref, quote: memoryText };
	return normalizeManualStructure({
		primary_subject_ref: "E0",
		primary_memory: {
			kind: "slice",
			slice_kind: "other",
			text: memoryText,
			evidence_ids: [message.ref],
			evidence_spans: [evidenceSpan],
			confidence: 0.9,
			...metadataDefaults(memoryText),
		},
		entities: [{
			ref: "E0",
			label,
			category: fallbackCategory(memoryText),
			mention_role: "primary_subject",
			evidence_ids: [message.ref],
			evidence_spans: [evidenceSpan],
		}],
		facts: [],
		relationships: [],
		corrections: [],
		notes: "grounded_explicit_fallback",
	}, envelope);
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
		if (!line) continue;
		if (/^\s*(?:what|who|when|where|why|how|can|could|would|should|do|does|did|is|are)\b.*\?$/i.test(line)) continue;
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

async function callManualModel(env, config, envelope) {
	if (!env.AI) return null;
	try {
		const result = await env.AI.run(
			config.llm.model,
			{
				messages: [
					{ role: "system", content: MANUAL_SYSTEM_PROMPT },
					{ role: "user", content: JSON.stringify(envelope) },
				],
				temperature: 0,
				max_tokens: config.llm.maxTokens,
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		const parsed = extractJson(responseText(result));
		return normalizeManualStructure(parsed, envelope);
	} catch (error) {
		console.warn("manual extraction failed:", error?.message ?? error);
		return null;
	}
}

function withPrimaryCompatibilityFact(structure, envelope) {
	const primary = (structure?.entities ?? []).find((entity) => entity.ref === structure.primary_subject_ref);
	if (!primary || !structure?.primary_memory?.text) return structure;
	if ((structure.facts ?? []).some((item) => item.subject_ref === primary.ref)) return structure;
	if ((structure.corrections ?? []).some((item) =>
		item.subject_ref === primary.ref ||
		canonicalIdentity(item.subject?.label) === canonicalIdentity(primary.label))) return structure;
	const memory = structure.primary_memory;
	const fact = normalizeFact({
		identity: primary,
		subject_ref: primary.ref,
		memory,
		evidence_ids: memory.evidence_ids,
		evidence_spans: memory.evidence_spans,
		confidence: memory.confidence,
		attribution: memory.attribution,
		polarity: memory.polarity,
		modality: memory.modality,
		temporal_status: memory.temporal_status,
	}, envelope);
	fact.identity = primary;
	fact.subject_ref = primary.ref;
	return { ...structure, facts: [...(structure.facts ?? []), fact] };
}

function mergedEntityContext(primaryStructure, secondaryStructure) {
	const primary = (primaryStructure?.entities ?? []).find((entity) => entity.ref === primaryStructure?.primary_subject_ref) ?? null;
	const ordered = [
		...(primary ? [primary] : []),
		...(primaryStructure?.entities ?? []).filter((entity) => entity !== primary),
		...(secondaryStructure?.entities ?? []),
	];
	const entities = [];
	const seen = new Set();
	for (const entity of ordered) {
		const key = `${canonicalIdentity(entity?.label)}:${entity?.category ?? "other"}`;
		if (!entity?.label || seen.has(key)) continue;
		seen.add(key);
		entities.push({ ...entity, ref: entities.length === 0 && primary ? "PRIMARY" : `SOURCE_${entities.length}` });
	}
	return {
		entities,
		primary_subject_ref: primary && entities.length ? "PRIMARY" : null,
	};
}

/** Source-only structural extraction entrypoint for the MCP manual lane. */
export async function extractManualStructure(env, config, input = {}) {
	const envelope = buildManualSourceEnvelope(input);
	const submittedContent = envelope.source_messages
		.filter((message) => message.role === "user")
		.map((message) => message.content)
		.join("\n");
	const deterministicRaw = heuristicManualFacts(submittedContent);
	const deterministic = normalizeManualStructure(deterministicRaw, envelope);
	let modelProposal = null;
	if (input.extractionResponse !== undefined && input.extractionResponse !== null) {
		const parsed = typeof input.extractionResponse === "string"
			? extractJson(input.extractionResponse)
			: input.extractionResponse;
		modelProposal = normalizeManualStructure(parsed, envelope);
	} else {
		// The heuristic path provides deterministic high-confidence facts, while the
		// model is still allowed to recover durable facts from unrecognized sentences
		// in the same submission. Returning after the first heuristic match silently
		// dropped the remainder of mixed manual saves.
		const unhandledContent = unhandledManualContent(submittedContent, deterministic);
		if (unhandledContent) modelProposal = await callManualModel(env, config, envelope);
	}

	const merged = mergeManualProposals(deterministic, modelProposal);
	const preferredStructure = modelProposal?.primary_subject_ref ? modelProposal : deterministic;
	const secondaryStructure = preferredStructure === modelProposal ? deterministic : modelProposal;
	const entityContext = mergedEntityContext(preferredStructure, secondaryStructure);
	const combinedSeed = {
		...merged,
		...entityContext,
		primary_memory: modelProposal?.primary_memory ?? deterministic.primary_memory,
	};
	let combined = withPrimaryCompatibilityFact(normalizeManualStructure(combinedSeed, envelope), envelope);
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

	const fallback = input.explicitManualSave === true
		? withPrimaryCompatibilityFact(buildGroundedManualFallback(envelope), envelope)
		: emptyManualStructure();
	if (fallback.facts.length || fallback.relationships.length || fallback.corrections.length) {
		return {
			...fallback,
			rejected: [...(combined.rejected ?? []), ...(fallback.rejected ?? [])],
			extractor: "grounded_fallback",
			model_notes: modelProposal?.notes ?? null,
		};
	}
	combined = { ...combined, extractor: "heuristic", model_notes: modelProposal?.notes ?? null };
	return combined;
}

/** Backward-compatible name used by the current MCP orchestration. */
export async function extractManualFacts(env, config, input = {}) {
	return extractManualStructure(env, config, input);
}
