import { normalizeMemoryRules, rulesPromptLines, rulesRejection } from "./rules.js";
import { scrubText } from "./scrub.js";
import { normalizeAtomicTemporal } from "./temporal.js";

export const ATOMIC_CAPTURE_SCHEMA = "itsuki.semantic-atom/v1";
export const ATOMIC_TYPES = Object.freeze([
	"fact",
	"event",
	"relationship",
	"preference",
	"decision",
	"goal",
	"plan",
	"procedure",
	"quantity",
	"location",
	"state",
	"other",
]);
export const ATOMIC_ENTITY_TYPES = Object.freeze([
	"person",
	"family",
	"relationship",
	"project",
	"system",
	"tool",
	"skill",
	"habit",
	"health",
	"goal",
	"preference",
	"identity",
	"life_event",
	"place",
	"organization",
	"possession",
	"interest",
	"other",
]);
export const ATOMIC_CARDINALITIES = Object.freeze(["single", "multi", "unknown"]);
export const MAX_ATOMIC_PROPOSALS = 64;

const TYPE_SET = new Set(ATOMIC_TYPES);
const ENTITY_TYPE_SET = new Set(ATOMIC_ENTITY_TYPES);
const CARDINALITY_SET = new Set(ATOMIC_CARDINALITIES);
const FIELD_LIMITS = Object.freeze({
	entity: 160,
	attribute: 96,
	value: 512,
	assertion: 800,
	evidence_quote: 6_000,
	raw_temporal_phrase: 160,
});

const SYSTEM_PROMPT = `You are the source-grounded CAPTURE stage of a long-term memory system. Extract durable facts about the user and the user's world from new_slice.

new_slice is the ONLY source of new memory. bridge_context may resolve a reference such as "it" or "that project", but NEVER extract a fact from bridge_context. NEVER extract from assistant_context.

Return exactly one JSON object: {"atoms":[...]}. Return {"atoms":[]} when there is no durable memory. Do not add prose, markdown, or reasoning.

Each atom must have exactly these fields:
- type: fact|event|relationship|preference|decision|goal|plan|procedure|quantity|location|state|other
- entity: the durable person, project, system, topic, place, or thing the assertion is about
- entity_type: person|family|relationship|project|system|tool|skill|habit|health|goal|preference|identity|life_event|place|organization|possession|interest|other
- attribute: a short relation/property name
- value: the atomic value or object
- assertion: one standalone durable claim
- source_message_id: one id from new_slice
- evidence_quote: an exact, non-empty substring copied from that source message
- raw_temporal_phrase: optional; only an exact temporal phrase copied from that same message
- project_category: optional; one offered project filing slug, only when it clearly fits
- cardinality: single|multi|unknown
- confidence: number from 0 to 1

Capture exhaustively but precisely:
- Emit ZERO TO MANY atoms. Emit one atom for each independent durable claim, not one lossy summary per message.
- Split compound details. "Northwind uses Go, Chi, and sqlc; no ORM" is four facts, each grounded to an exact source quote.
- Capture decisions and their stated reasons; architecture facts; conventions; error causes and fixes; preferences; relationships; skills; habits and habit changes; events; quantities; locations; goals; plans; and ordered procedures.
- Preserve corrections and transitions as explicit state/event atoms. Do not silently replace old facts here; later code governs coexistence and supersession.
- Keep exact dates, relative temporal phrases, quantities, negation, and ordering when present. Never invent date precision.
- A relationship should name both endpoints in entity/value. A procedure may preserve an ordered sequence in one atom when splitting it would destroy the order.
- Capture only user-specific durable information. Ignore greetings, acknowledgements, jokes, generic world knowledge, pure questions, and assistant suggestions.
- Do not invent database ids, entities, causes, dates, or facts. If a claim cannot be grounded to one exact quote in one new_slice message, do not emit it.
- evidence_quote is evidence, not a rewritten paraphrase. Copy it exactly, including punctuation and Unicode.
- Do not include secrets or content forbidden by the supplied rules.`;

function compactPacketMessage(message) {
	return {
		id: message?.id == null ? "" : String(message.id),
		content: String(message?.content ?? ""),
		...(Number.isFinite(Number(message?.ts)) ? { ts: Number(message.ts) } : {}),
		...(message?.source_time ? { source_time: message.source_time } : {}),
		...(message?.sourceTime ? { source_time: message.sourceTime } : {}),
		...(message?.source_event ? { source_event: message.source_event } : {}),
	};
}

/**
 * Build a prompt whose information boundary matches buildPacket(): new_slice
 * is authoritative; bridge/assistant text is context only. Source is last so
 * the central model-input tail guard preserves it under pressure.
 */
export function buildAtomicCaptureMessages(packet = {}, options = {}) {
	const normalizedRules = options.rules ? normalizeMemoryRules(options.rules) : null;
	const ruleLines = rulesPromptLines(normalizedRules);
	const body = {
		instructions: "Extract durable atoms from new_slice only. NEVER extract from bridge_context or assistant_context.",
		...(ruleLines.length ? { rules: ruleLines.join("\n") } : {}),
		bridge_context: (packet.bridge_context ?? []).map(compactPacketMessage),
		assistant_context: (packet.assistant_context ?? []).map(compactPacketMessage),
		new_slice: (packet.new_slice ?? []).map(compactPacketMessage),
	};
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: JSON.stringify(body) },
	];
}

function stripWrappers(text) {
	let value = String(text ?? "");
	value = value.replace(/<think>[\s\S]*?<\/think>/gi, " ");
	const finalThink = value.lastIndexOf("</think>");
	if (finalThink !== -1) value = value.slice(finalThink + "</think>".length);
	value = value.replace(/<\|[^>]*\|>/g, " ");
	value = value.replace(/```(?:json)?/gi, " ").replace(/```/g, " ");
	return value.trim();
}

function tolerantParse(value) {
	try {
		return JSON.parse(value);
	} catch {
		try {
			return JSON.parse(value.replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return null;
		}
	}
}

function firstBalancedObject(text) {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return tolerantParse(text.slice(start, index + 1));
		}
	}
	return null;
}

function salvageAtoms(text) {
	const marker = text.search(/"atoms"\s*:\s*\[/);
	if (marker < 0) return null;
	const start = text.indexOf("[", marker);
	if (start < 0) return null;
	const atoms = [];
	let depth = 0;
	let elementStart = -1;
	let inString = false;
	let escaped = false;
	for (let index = start + 1; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) elementStart = index;
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0 && elementStart >= 0) {
				const parsed = tolerantParse(text.slice(elementStart, index + 1));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) atoms.push(parsed);
				elementStart = -1;
			}
			continue;
		}
		if (char === "]" && depth === 0) break;
	}
	return atoms.length ? atoms : null;
}

/** Parse a model response without accepting a partially emitted atom. */
export function parseAtomicCaptureText(text) {
	if (typeof text !== "string") return null;
	const cleaned = stripWrappers(text);
	const direct = tolerantParse(cleaned);
	if (direct && !Array.isArray(direct) && Array.isArray(direct.atoms)) return direct;
	const balanced = firstBalancedObject(cleaned);
	if (balanced && !Array.isArray(balanced) && Array.isArray(balanced.atoms)) return balanced;
	const atoms = salvageAtoms(cleaned);
	return atoms ? { atoms, _truncated: true } : null;
}

function cleanText(value) {
	return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
}

function codePointOffset(text, codeUnitOffset) {
	return Array.from(text.slice(0, codeUnitOffset)).length;
}

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function increment(map, key, count = 1) {
	map[key] = (map[key] ?? 0) + count;
}

function reject(outcomes, reason, count = 1) {
	outcomes.rejected += count;
	increment(outcomes.rejectedByReason, reason, count);
}

function messageIndex(messages) {
	const index = new Map();
	const ambiguous = new Set();
	for (const message of messages ?? []) {
		const id = message?.id == null ? "" : String(message.id);
		if (!id) continue;
		if (index.has(id)) ambiguous.add(id);
		else index.set(id, message);
	}
	for (const id of ambiguous) index.delete(id);
	return { index, ambiguous };
}

function invalidFieldReason(proposal) {
	if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return "invalid_atom";
	if (!TYPE_SET.has(proposal.type) || !ENTITY_TYPE_SET.has(proposal.entity_type) || !CARDINALITY_SET.has(proposal.cardinality)) {
		return "invalid_enum";
	}
	for (const field of ["entity", "attribute", "value", "assertion", "source_message_id", "evidence_quote"]) {
		if (typeof proposal[field] !== "string" || !proposal[field].trim()) return "missing_field";
	}
	if (proposal.raw_temporal_phrase != null && typeof proposal.raw_temporal_phrase !== "string") return "invalid_temporal_phrase";
	if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) return "invalid_confidence";
	for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
		if (proposal[field] != null && Array.from(String(proposal[field])).length > limit) return "field_too_long";
	}
	return null;
}

function projectCategoryIdFor(rules, proposal) {
	const raw = typeof proposal?.project_category === "string"
		? proposal.project_category.trim().toLocaleLowerCase("en-US")
		: "";
	if (!raw) return null;
	for (const category of rules?.projectCategories ?? []) {
		if (raw === String(category.id).toLocaleLowerCase("en-US")
			|| raw === String(category.slug).toLocaleLowerCase("en-US")) {
			return category.id;
		}
	}
	return null;
}

/**
 * Validate and canonicalize model proposals. This is the trust boundary: the
 * model proposes strings; code binds every accepted atom to an exact, scrubbed
 * source span and deterministic tenant-scoped identity.
 */
export async function normalizeAtomicCapture(parsed, options = {}) {
	const proposed = Array.isArray(parsed?.atoms) ? parsed.atoms : [];
	const outcomes = {
		proposed: proposed.length,
		accepted: 0,
		rejected: 0,
		duplicate: 0,
		temporalPresent: 0,
		temporalResolved: 0,
		temporalUnresolved: 0,
		temporalAnchorMissing: 0,
		temporalAbsent: 0,
		rejectedByReason: {},
	};
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.atoms)) {
		reject(outcomes, "invalid_root");
		return { ok: false, atoms: [], outcomes, truncated: false };
	}

	const source = messageIndex(options.messages);
	const normalizedRules = options.rules ? normalizeMemoryRules(options.rules) : null;
	const acceptedById = new Map();
	const bounded = proposed.slice(0, MAX_ATOMIC_PROPOSALS);
	if (proposed.length > bounded.length) reject(outcomes, "over_limit", proposed.length - bounded.length);

	for (const proposal of bounded) {
		const structuralReason = invalidFieldReason(proposal);
		if (structuralReason) {
			reject(outcomes, structuralReason);
			continue;
		}

		const sourceMessageId = String(proposal.source_message_id);
		if (source.ambiguous.has(sourceMessageId)) {
			reject(outcomes, "ambiguous_source_message");
			continue;
		}
		const message = source.index.get(sourceMessageId);
		if (!message) {
			reject(outcomes, "unknown_source_message");
			continue;
		}

		const content = String(message.content ?? "");
		const evidenceQuote = String(proposal.evidence_quote);
		const quoteOffset = content.indexOf(evidenceQuote);
		if (quoteOffset < 0) {
			reject(outcomes, "inexact_evidence_quote");
			continue;
		}
		const proposedTemporalPhrase = proposal.raw_temporal_phrase == null
			? null
			: String(proposal.raw_temporal_phrase);
		const rawTemporalPhrase = proposedTemporalPhrase?.trim() ? proposedTemporalPhrase : null;
		if (rawTemporalPhrase && content.indexOf(rawTemporalPhrase) < 0) {
			reject(outcomes, "inexact_temporal_phrase");
			continue;
		}

		const entity = cleanText(proposal.entity);
		const attribute = cleanText(proposal.attribute);
		const value = cleanText(proposal.value);
		const assertion = cleanText(proposal.assertion);
		if (!entity || !attribute || !value || !assertion) {
			reject(outcomes, "missing_field");
			continue;
		}

		const semanticText = [entity, attribute, value, assertion, evidenceQuote, rawTemporalPhrase].filter(Boolean).join(" ");
		if (Object.keys(scrubText(semanticText).redactions).length > 0) {
			reject(outcomes, "secret_material");
			continue;
		}
		const ruleReason = rulesRejection(normalizedRules, semanticText);
		if (ruleReason) {
			reject(outcomes, ruleReason);
			continue;
		}
		if (typeof options.allow === "function" && !await options.allow(semanticText, proposal, message)) {
			reject(outcomes, "rejected_by_admission");
			continue;
		}

		const startCodePoint = codePointOffset(content, quoteOffset);
		const endCodePoint = startCodePoint + Array.from(evidenceQuote).length;
		const descriptor = {
			schema: ATOMIC_CAPTURE_SCHEMA,
			user_id: String(options.userId ?? ""),
			project_id: options.projectId == null ? null : String(options.projectId),
			source_packet_id: String(options.sourcePacketId ?? ""),
			chunk_key: String(options.chunkKey ?? ""),
			source_message_id: sourceMessageId,
			start_code_point: startCodePoint,
			end_code_point: endCodePoint,
			type: proposal.type,
			entity,
			entity_type: proposal.entity_type,
			attribute,
			value,
			assertion,
			raw_temporal_phrase: rawTemporalPhrase,
			cardinality: proposal.cardinality,
		};
		const id = `atom:v1:${await sha256Hex(JSON.stringify(descriptor))}`;
		const atom = {
			id,
			schema: ATOMIC_CAPTURE_SCHEMA,
			userId: descriptor.user_id,
			projectId: descriptor.project_id,
			sourcePacketId: descriptor.source_packet_id,
			chunkKey: descriptor.chunk_key,
			sourceMessageId,
			startCodePoint,
			endCodePoint,
			evidenceQuote,
			type: proposal.type,
			entity,
			entityType: proposal.entity_type,
			attribute,
			value,
			assertion,
			rawTemporalPhrase,
			temporal: normalizeAtomicTemporal(rawTemporalPhrase, message),
			cardinality: proposal.cardinality,
			confidence: proposal.confidence,
			projectCategoryId: projectCategoryIdFor(normalizedRules, proposal),
		};
		const existing = acceptedById.get(id);
		if (existing) {
			outcomes.duplicate += 1;
			if (atom.confidence > existing.confidence) acceptedById.set(id, atom);
			continue;
		}
		acceptedById.set(id, atom);
	}

	const atoms = [...acceptedById.values()];
	for (const atom of atoms) {
		const outcome = atom.temporal?.outcome ?? "absent";
		if (atom.rawTemporalPhrase) outcomes.temporalPresent += 1;
		if (outcome === "resolved") outcomes.temporalResolved += 1;
		else if (outcome === "unresolvable") outcomes.temporalUnresolved += 1;
		else if (outcome === "anchor_missing") outcomes.temporalAnchorMissing += 1;
		else outcomes.temporalAbsent += 1;
	}
	outcomes.accepted = atoms.length;
	return {
		ok: true,
		atoms,
		outcomes,
		truncated: Boolean(parsed._truncated),
	};
}
