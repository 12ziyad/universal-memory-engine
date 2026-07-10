import { ACTIONS, EDGE_TYPES, SLICE_KINDS } from "../config.js";
import { canonicalIdentity } from "./manual_identity.js";
import { isBadTitle } from "./title.js";

const JUNK_IDENTITIES = new Set([
	"i", "me", "my", "mine", "myself", "it", "its", "this", "that", "thing", "things",
	"something", "anything", "everything", "user", "the user", "assistant", "the assistant",
]);

const GROUNDING_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "had", "has", "have",
	"i", "in", "is", "it", "my", "of", "on", "or", "that", "the", "their", "this", "to", "user", "was", "were", "with",
]);
const GENERIC_IDENTITY_TOKENS = new Set([
	"app", "application", "database", "habit", "memory", "preference", "project", "research", "service", "skill", "style", "system", "tool",
]);

const ACTION_TERMS = {
	started: ["start", "started", "begin", "began", "joined", "took up"],
	stopped: ["stop", "stopped", "quit", "left", "no longer"],
	paused: ["pause", "paused", "hold", "on hold"],
	resumed: ["resume", "resumed", "restart", "restarted", "again"],
	launched: ["launch", "launched", "released", "shipped"],
	completed: ["complete", "completed", "finish", "finished", "done"],
	fixed: ["fix", "fixed", "resolved", "repaired"],
	removed: ["remove", "removed", "deleted", "dropped"],
	changed_plan: ["changed", "switched", "instead", "replace", "replaced"],
	decided: ["decided", "chose", "selected", "settled"],
	diagnosed: ["diagnosed", "diagnosis"],
	passed_away: ["died", "passed away", "death"],
	married: ["married", "wedding"],
	born: ["born", "birth"],
	moved: ["moved", "relocated"],
	broke_up: ["broke up", "breakup", "separated"],
	injured: ["injured", "injury", "hurt"],
	recovered: ["recovered", "recovery", "healed"],
	achieved: ["achieved", "reached", "accomplished"],
	joined: ["joined", "started at"],
	left: ["left", "quit", "departed"],
	practiced: ["practiced", "practising", "training", "trained"],
	other: [],
};

const SLICE_TERMS = {
	preference: ["prefer", "preference", "like", "dislike", "favorite", "favourite"],
	decision: ["decided", "chose", "selected", "will use", "settled"],
	progress: ["building", "working", "progress", "started", "completed", "learning", "training"],
	blocker: ["blocked", "blocker", "risk", "problem", "issue"],
	fix: ["fix", "fixed", "resolved", "solution"],
	technical_detail: ["uses", "runs", "database", "api", "built", "tool"],
	feature_detail: ["feature", "supports", "includes"],
	other: [],
};

function words(value) {
	return canonicalIdentity(value)
		.split(" ")
		.filter((word) => word.length > 1 && !GROUNDING_STOPWORDS.has(word));
}

function includesPhrase(haystack, phrase) {
	const left = canonicalIdentity(haystack);
	const right = canonicalIdentity(phrase);
	return Boolean(left && right && (` ${left} `).includes(` ${right} `));
}

function overlap(left, right) {
	const a = new Set(words(left));
	const b = new Set(words(right));
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / Math.min(a.size, b.size);
}

function hasAnyTerm(source, terms = []) {
	return terms.some((term) => includesPhrase(source, term));
}

function distinctiveIdentityGrounded(label, source) {
	const labelWords = words(label).filter((word) => !GENERIC_IDENTITY_TOKENS.has(word));
	if (!labelWords.length) return false;
	const sourceWords = new Set(words(source));
	const shared = labelWords.filter((word) => sourceWords.has(word)).length;
	return shared >= Math.max(1, Math.ceil(labelWords.length * 0.5));
}

function validIdentityLabel(label) {
	const raw = String(label ?? "").trim();
	const key = canonicalIdentity(raw);
	if (!key || JUNK_IDENTITIES.has(key)) return false;
	if (raw.length > 160 || key.split(" ").length > 12) return false;
	if (/^(?:c|c\+\+|c#)$/i.test(raw)) return true;
	if (/[^\x00-\x7F]/.test(raw) && /\p{L}/u.test(raw)) return true;
	return !isBadTitle(raw);
}

function sourceLooksUncertain(source, label) {
	if (!/\b(?:maybe|might|perhaps|possibly|someday|not sure|considering)\b/i.test(source)) return false;
	return includesPhrase(source, label) || overlap(source, label) > 0;
}

function predicateGrounded(fact, submittedContent) {
	const memory = fact.memory ?? {};
	const textScore = overlap(memory.text, submittedContent);
	if (textScore >= 0.34 || includesPhrase(submittedContent, memory.text)) return true;
	if (memory.kind === "event") {
		return ACTIONS.includes(memory.action) && hasAnyTerm(submittedContent, ACTION_TERMS[memory.action]);
	}
	return SLICE_KINDS.includes(memory.slice_kind) && hasAnyTerm(submittedContent, SLICE_TERMS[memory.slice_kind]);
}

function identityGrounded(fact, submittedContent, recentContext) {
	const label = fact.identity?.label;
	if (includesPhrase(submittedContent, label) || distinctiveIdentityGrounded(label, submittedContent)) {
		return { grounded: true, via: "source" };
	}
	// A generated umbrella label (for example "Response Preference") is valid only
	// when its actual value/predicate is strongly grounded in submitted content.
	if (
		overlap(fact.memory?.text, submittedContent) >= 0.55 &&
		distinctiveIdentityGrounded(label, submittedContent)
	) return { grounded: true, via: "grounded_detail" };
	const contextHasIdentity = includesPhrase(recentContext, label) || distinctiveIdentityGrounded(label, recentContext);
	const submittedHasReference = /\b(?:it|that|this|them|those|there|he|she|him|her)\b/i.test(submittedContent);
	if (contextHasIdentity && submittedHasReference && predicateGrounded(fact, submittedContent)) {
		return { grounded: true, via: "reference_context" };
	}
	return { grounded: false, via: null };
}

function validateFact(fact, input) {
	const label = fact?.identity?.label;
	if (!validIdentityLabel(label)) return { ok: false, reason: "invalid_identity" };
	if (!fact?.memory?.text) return { ok: false, reason: "missing_fact_text" };
	if (Number(fact.confidence ?? 0) < 0.25) return { ok: false, reason: "low_confidence" };
	if (sourceLooksUncertain(input.submittedContent, label)) return { ok: false, reason: "uncertain_not_durable" };
	if (fact.memory.kind === "event" && !ACTIONS.includes(fact.memory.action)) {
		return { ok: false, reason: "invalid_event_action" };
	}
	if (fact.memory.kind === "slice" && !SLICE_KINDS.includes(fact.memory.slice_kind)) {
		return { ok: false, reason: "invalid_slice_kind" };
	}
	const identity = identityGrounded(fact, input.submittedContent, input.recentContext);
	if (!identity.grounded) return { ok: false, reason: "identity_not_in_submitted_content" };
	if (!predicateGrounded(fact, input.submittedContent)) {
		return { ok: false, reason: "fact_not_in_submitted_content" };
	}
	return { ok: true, grounding: identity.via };
}

function validateRelationship(relationship, submittedContent) {
	if (!validIdentityLabel(relationship?.from?.label) || !validIdentityLabel(relationship?.to?.label)) {
		return { ok: false, reason: "invalid_edge_identity" };
	}
	if (!EDGE_TYPES.includes(relationship?.type)) return { ok: false, reason: "invalid_edge_type" };
	if (canonicalIdentity(relationship.from.label) === canonicalIdentity(relationship.to.label)) {
		return { ok: false, reason: "edge_self_loop" };
	}
	const sourceSupport = overlap(relationship.text, submittedContent) >= 0.4 ||
		(includesPhrase(submittedContent, relationship.from.label) && includesPhrase(submittedContent, relationship.to.label));
	if (!sourceSupport) return { ok: false, reason: "edge_not_in_submitted_content" };
	return { ok: true };
}

/** Backend grounding/integrity gate for the MCP manual lane only. */
export function applyManualIntegrity(proposal, input = {}) {
	const submittedContent = String(input.submittedContent ?? "").trim();
	const recentContext = String(input.recentContext ?? "").trim();
	const facts = [];
	const relationships = [];
	const rejected = [...(proposal?.rejected ?? [])];

	for (const fact of proposal?.facts ?? []) {
		const decision = validateFact(fact, { submittedContent, recentContext });
		if (!decision.ok) {
			rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact?.identity?.label ?? null, reason: decision.reason });
			continue;
		}
		facts.push({ ...fact, grounding: decision.grounding });
	}

	for (const relationship of proposal?.relationships ?? []) {
		const decision = validateRelationship(relationship, submittedContent);
		if (!decision.ok) {
			rejected.push({ kind: "edge", label: relationship?.from?.label ?? null, reason: decision.reason });
			continue;
		}
		relationships.push(relationship);
	}

	return { facts, relationships, rejected, hasDurableFacts: facts.length > 0 || relationships.length > 0 };
}
