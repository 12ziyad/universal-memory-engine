import { ACTIONS, EDGE_TYPES, SLICE_KINDS } from "../config.js";
import { canonicalIdentity } from "./manual_identity.js";
import { unsafeManualEntityLabel } from "./manual_language.js";
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
const GENERIC_DETAIL_TOKENS = new Set([
	"answer", "app", "application", "database", "detail", "fact", "memory", "plan", "preference",
	"project", "response", "service", "storage", "style", "system", "thing", "tool", "work",
]);
const CONTEXT_REFERENCE_STOPWORDS = new Set([
	"also", "assistant", "earlier", "i", "later", "monday", "now", "recently", "saturday",
	"sunday", "then", "thursday", "today", "tuesday", "user", "we", "wednesday", "yesterday",
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

const EDGE_TERMS = {
	part_of: ["part of", "belongs to", "within"],
	uses: ["uses", "use", "using", "runs on", "built with", "is built with", "with"],
	depends_on: ["depends on", "requires", "relies on", "powered by", "is powered by"],
	drives: ["drives", "driving", "motivates"],
	supports: ["supports", "support", "helps"],
	improves: ["improves", "improved", "enhances"],
	blocked_by: ["blocked by", "blocked", "prevented by"],
	caused: ["caused", "because of", "led to"],
	replaced_by: ["replaced by", "switched from", "instead of"],
	related_to: ["related to", "associated with", "connected to"],
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

function evidenceWord(value) {
	if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
	if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
	return value;
}

function factPredicateTerms(fact) {
	const memory = fact?.memory ?? {};
	const phrases = memory.kind === "event"
		? (ACTION_TERMS[memory.action] ?? [])
		: (SLICE_TERMS[memory.slice_kind] ?? []);
	return new Set(phrases.flatMap((phrase) => words(phrase)).map(evidenceWord));
}

function factDetailEvidence(fact, submittedContent) {
	const labelWords = new Set(words(fact?.identity?.label).map(evidenceWord));
	const predicateWords = factPredicateTerms(fact);
	const details = [...new Set(words(fact?.memory?.text)
		.map(evidenceWord)
		.filter((word) =>
			!labelWords.has(word) && !predicateWords.has(word) && !GENERIC_DETAIL_TOKENS.has(word)))];
	const sourceWords = new Set(words(submittedContent).map(evidenceWord));
	return {
		hasDetails: details.length > 0,
		grounded: details.every((word) => sourceWords.has(word)),
	};
}

function contextHasMultipleNamedReferences(recentContext, label) {
	const labelKey = canonicalIdentity(label);
	const references = String(recentContext ?? "").match(
		/\b[\p{Lu}][\p{L}\p{N}+#.-]*(?:\s+[\p{Lu}][\p{L}\p{N}+#.-]*)*/gu,
	) ?? [];
	return references.some((reference) => {
		const key = canonicalIdentity(reference);
		if (!key || CONTEXT_REFERENCE_STOPWORDS.has(key)) return false;
		if (key === labelKey || (` ${key} `).includes(` ${labelKey} `)) return false;
		return true;
	});
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
	if (/^[A-Z][A-Za-z0-9+#./-]{1,15}$/.test(raw)) return true;
	if (/[^\x00-\x7F]/.test(raw) && /\p{L}/u.test(raw)) return true;
	return !isBadTitle(raw);
}

function sourceLooksUncertain(source, label) {
	if (!/\b(?:maybe|might|perhaps|possibly|someday|not sure|considering)\b/i.test(source)) return false;
	return includesPhrase(source, label) || overlap(source, label) > 0;
}

function predicateGrounded(fact, submittedContent) {
	const memory = fact.memory ?? {};
	if (includesPhrase(submittedContent, memory.text)) return true;
	const detail = factDetailEvidence(fact, submittedContent);
	if (!detail.grounded) return false;
	if (memory.kind === "event") {
		return ACTIONS.includes(memory.action) &&
			hasAnyTerm(submittedContent, ACTION_TERMS[memory.action]) &&
			(detail.hasDetails || memory.action !== "other");
	}
	if (!SLICE_KINDS.includes(memory.slice_kind)) return false;
	const terms = SLICE_TERMS[memory.slice_kind] ?? [];
	if (terms.length) return hasAnyTerm(submittedContent, terms);
	return detail.hasDetails;
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
		return {
			grounded: true,
			via: "reference_context",
			conflictReason: contextHasMultipleNamedReferences(recentContext, label)
				? "ambiguous_reference_context"
				: null,
		};
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
	return { ok: true, grounding: identity.via, conflictReason: identity.conflictReason ?? null };
}

function validateRelationship(relationship, submittedContent) {
	if (!validIdentityLabel(relationship?.from?.label) || !validIdentityLabel(relationship?.to?.label)) {
		return { ok: false, reason: "invalid_edge_identity" };
	}
	if (!EDGE_TYPES.includes(relationship?.type)) return { ok: false, reason: "invalid_edge_type" };
	if (canonicalIdentity(relationship.from.label) === canonicalIdentity(relationship.to.label)) {
		return { ok: false, reason: "edge_self_loop" };
	}
	const identitiesGrounded = includesPhrase(submittedContent, relationship.from.label) &&
		includesPhrase(submittedContent, relationship.to.label);
	const predicateSupported = hasAnyTerm(submittedContent, EDGE_TERMS[relationship.type] ?? []);
	const sourceSupport = identitiesGrounded && predicateSupported &&
		(includesPhrase(submittedContent, relationship.text) || overlap(relationship.text, submittedContent) >= 0.7);
	if (!sourceSupport) return { ok: false, reason: "edge_not_in_submitted_content" };
	return { ok: true };
}

function validateCorrection(correction, submittedContent) {
	const subject = correction?.subject;
	const oldTarget = correction?.old_target;
	const newTarget = correction?.new_target;
	if (!validIdentityLabel(subject?.label)) return { ok: false, reason: "invalid_correction_subject" };
	if (!oldTarget?.label && !newTarget?.label) return { ok: false, reason: "missing_correction_value" };
	if (oldTarget && !validIdentityLabel(oldTarget.label)) return { ok: false, reason: "invalid_correction_target" };
	if (newTarget && (!validIdentityLabel(newTarget.label) || unsafeManualEntityLabel(newTarget._raw_label ?? newTarget.label))) {
		return { ok: false, reason: "invalid_correction_target" };
	}
	if (!EDGE_TYPES.includes(correction.type)) return { ok: false, reason: "invalid_edge_type" };
	if (!/\b(?:correction|actually|instead of|no longer|replace(?:s|d)?|not)\b/i.test(submittedContent)) {
		return { ok: false, reason: "correction_not_in_submitted_content" };
	}
	if (!includesPhrase(submittedContent, subject.label) && !distinctiveIdentityGrounded(subject.label, submittedContent)) {
		return { ok: false, reason: "correction_subject_not_grounded" };
	}
	for (const target of [oldTarget, newTarget].filter(Boolean)) {
		if (!includesPhrase(submittedContent, target.label)) {
			return { ok: false, reason: "correction_target_not_grounded" };
		}
	}
	if (!hasAnyTerm(submittedContent, EDGE_TERMS[correction.type] ?? [])) {
		return { ok: false, reason: "correction_predicate_not_grounded" };
	}
	return { ok: true };
}

/** Backend grounding/integrity gate for the MCP manual lane only. */
export function applyManualIntegrity(proposal, input = {}) {
	const submittedContent = String(input.submittedContent ?? "").trim();
	const recentContext = String(input.recentContext ?? "").trim();
	const facts = [];
	const relationships = [];
	const corrections = [];
	const rejected = [...(proposal?.rejected ?? [])];

	for (const fact of proposal?.facts ?? []) {
		const decision = validateFact(fact, { submittedContent, recentContext });
		if (!decision.ok) {
			rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact?.identity?.label ?? null, reason: decision.reason });
			continue;
		}
		facts.push({
			...fact,
			identity: decision.conflictReason
				? { ...fact.identity, _manual_conflict_reason: decision.conflictReason }
				: fact.identity,
			grounding: decision.grounding,
		});
	}

	for (const relationship of proposal?.relationships ?? []) {
		const decision = validateRelationship(relationship, submittedContent);
		if (!decision.ok) {
			rejected.push({ kind: "edge", label: relationship?.from?.label ?? null, reason: decision.reason });
			continue;
		}
		relationships.push(relationship);
	}

	for (const correction of proposal?.corrections ?? []) {
		const decision = validateCorrection(correction, submittedContent);
		if (!decision.ok) {
			rejected.push({ kind: "correction", label: correction?.subject?.label ?? null, reason: decision.reason });
			continue;
		}
		corrections.push(correction);
	}

	return {
		facts,
		relationships,
		corrections,
		rejected,
		hasDurableFacts: facts.length > 0 || relationships.length > 0 || corrections.length > 0,
	};
}
