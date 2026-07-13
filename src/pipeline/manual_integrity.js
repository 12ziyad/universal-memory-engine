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

const NON_PERSISTABLE_ROLES = new Set([
	"comparison",
	"example",
	"option",
	"incidental",
	"incidental_mention",
]);
const ATTRIBUTIONS = new Set(["user_stated", "user_adopted"]);
const POLARITIES = new Set(["positive", "negative"]);
const MODALITIES = new Set(["asserted", "planned", "possible"]);
const TEMPORAL_STATUSES = new Set(["current", "historical", "timeless"]);

function sourceMessages(input = {}) {
	const supplied = Array.isArray(input.sourceMessages) ? input.sourceMessages : [];
	const messages = supplied.length
		? supplied
			.map((message) => ({
				role: String(message?.role ?? "user").toLocaleLowerCase("en-US"),
				content: String(message?.content ?? "").trim(),
			}))
			.filter((message) => message.content)
		: String(input.submittedContent ?? "").trim()
			? [{ role: "user", content: String(input.submittedContent).trim() }]
			: [];
	return messages.map((message, index) => ({ ...message, ref: `M${index}` }));
}

function sentenceSegments(value) {
	return String(value ?? "")
		.split(/\n+|(?<=[.!?])\s+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function operationFallbackText(operation) {
	if (operation?.memory?.text) return operation.memory.text;
	if (operation?.text) return operation.text;
	if (operation?.current_text) return operation.current_text;
	if (operation?.currentText) return operation.currentText;
	return "";
}

function evidenceForOperation(operation, input) {
	const messages = sourceMessages(input);
	const byRef = new Map(messages.filter((message) => message.role === "user").map((message) => [message.ref, message]));
	const rawIds = Array.isArray(operation?.evidence_ids)
		? operation.evidence_ids
		: Array.isArray(operation?.evidenceIds)
			? operation.evidenceIds
			: operation?.evidence_ids ?? operation?.evidenceIds
				? [operation.evidence_ids ?? operation.evidenceIds]
				: [];
	const requestedIds = [...new Set(rawIds.map(String))];
	let evidenceIds = requestedIds;
	if (requestedIds.length) {
		if (requestedIds.some((ref) => !byRef.has(ref))) {
			return { ok: false, reason: "invalid_evidence_reference", evidenceIds: [], spans: [], segments: [] };
		}
	} else {
		const fallback = operationFallbackText(operation);
		const exact = messages.find((message) => message.role === "user" && fallback && message.content.includes(fallback));
		const selected = exact ?? messages.find((message) => message.role === "user");
		evidenceIds = selected ? [selected.ref] : [];
	}
	if (!evidenceIds.length) {
		return { ok: false, reason: "missing_user_evidence", evidenceIds: [], spans: [], segments: [] };
	}

	const rawSpans = Array.isArray(operation?.evidence_spans)
		? operation.evidence_spans
		: Array.isArray(operation?.evidenceSpans)
			? operation.evidenceSpans
			: [];
	const spans = [];
	for (const raw of rawSpans) {
		if (!raw || typeof raw !== "object") {
			return { ok: false, reason: "invalid_evidence_span", evidenceIds, spans: [], segments: [] };
		}
		const messageRef = String(raw.message_ref ?? raw.messageRef ?? raw.message_id ?? raw.evidence_id ?? "");
		const message = byRef.get(messageRef);
		if (!message || !evidenceIds.includes(messageRef)) {
			return { ok: false, reason: "evidence_span_reference_mismatch", evidenceIds, spans: [], segments: [] };
		}
		const requestedQuote = String(raw.quote ?? raw.text ?? "").trim();
		const hasOffsets = raw.start !== undefined || raw.end !== undefined;
		if (hasOffsets) {
			const start = Number(raw.start);
			const end = Number(raw.end);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > message.content.length) {
				return { ok: false, reason: "invalid_evidence_span", evidenceIds, spans: [], segments: [] };
			}
			const quote = message.content.slice(start, end);
			if (requestedQuote && requestedQuote !== quote) {
				return { ok: false, reason: "evidence_quote_mismatch", evidenceIds, spans: [], segments: [] };
			}
			spans.push({ message_ref: messageRef, start, end, quote });
			continue;
		}
		if (!requestedQuote) {
			return { ok: false, reason: "invalid_evidence_span", evidenceIds, spans: [], segments: [] };
		}
		const start = message.content.indexOf(requestedQuote);
		if (start < 0) {
			return { ok: false, reason: "evidence_quote_mismatch", evidenceIds, spans: [], segments: [] };
		}
		spans.push({ message_ref: messageRef, start, end: start + requestedQuote.length, quote: requestedQuote });
	}

	if (!spans.length) {
		const fallback = operationFallbackText(operation);
		for (const ref of evidenceIds) {
			const message = byRef.get(ref);
			if (!message) continue;
			const exactStart = fallback ? message.content.indexOf(fallback) : -1;
			if (exactStart >= 0) {
				spans.push({ message_ref: ref, start: exactStart, end: exactStart + fallback.length, quote: fallback });
				break;
			}
		}
		if (!spans.length) {
			const message = byRef.get(evidenceIds[0]);
			if (message?.content) spans.push({ message_ref: message.ref, start: 0, end: message.content.length, quote: message.content });
		}
	}

	const segments = spans.flatMap((span) => sentenceSegments(span.quote));
	return segments.length
		? { ok: true, evidenceIds, spans, segments }
		: { ok: false, reason: "missing_evidence_span", evidenceIds, spans, segments: [] };
}

function semanticMetadata(operation, support) {
	const claimText = String(operationFallbackText(operation));
	const evidenceText = String(support ?? "");
	const semanticText = `${claimText}\n${evidenceText}`;
	const possible = /\b(?:maybe|might|may|perhaps|possibly|considering|not sure)\b/i.test(semanticText);
	const planned = /\b(?:plan(?:ning|ned)?|will|going to|intend(?:ing|ed)?|want to|hope to)\b/i.test(semanticText);
	const negative = /\b(?:not|never|no longer|cannot|without)\b|\b(?:don['’]?t|doesn['’]?t|didn['’]?t|can['’]?t)\b/i.test(claimText);
	const historical = /\b(?:used to|previously|formerly|in the past|yesterday|last (?:week|month|year|night)|had|was|were)\b/i.test(semanticText);
	return {
		attribution: ATTRIBUTIONS.has(operation?.attribution) ? operation.attribution : "user_stated",
		polarity: negative ? "negative" : POLARITIES.has(operation?.polarity) ? operation.polarity : "positive",
		modality: possible
			? "possible"
			: planned
				? "planned"
				: MODALITIES.has(operation?.modality) ? operation.modality : "asserted",
		temporal_status: historical
			? "historical"
			: TEMPORAL_STATUSES.has(operation?.temporal_status) ? operation.temporal_status : "current",
	};
}

function entityRole(identity, ref, entitiesByRef) {
	return entitiesByRef.get(String(ref ?? ""))?.mention_role ?? identity?.mention_role ?? identity?.mentionRole ?? null;
}

function roleCanMaterialize(identity, ref, entitiesByRef) {
	const role = entityRole(identity, ref, entitiesByRef);
	return !role || !NON_PERSISTABLE_ROLES.has(String(role));
}

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

function validateFact(fact, input, evidence) {
	const label = fact?.identity?.label;
	if (!validIdentityLabel(label)) return { ok: false, reason: "invalid_identity" };
	if (!fact?.memory?.text) return { ok: false, reason: "missing_fact_text" };
	if (Number(fact.confidence ?? 0) < 0.25) return { ok: false, reason: "low_confidence" };
	if (fact.memory.kind === "event" && !ACTIONS.includes(fact.memory.action)) {
		return { ok: false, reason: "invalid_event_action" };
	}
	if (fact.memory.kind === "slice" && !SLICE_KINDS.includes(fact.memory.slice_kind)) {
		return { ok: false, reason: "invalid_slice_kind" };
	}
	if (!evidence.ok) return { ok: false, reason: evidence.reason };
	let identityGrounding = null;
	let polarityMismatch = false;
	for (const segment of evidence.segments) {
		const identity = identityGrounded(fact, segment, input.recentContext);
		if (!identity.grounded) continue;
		identityGrounding = identity;
		if (!predicateGrounded(fact, segment)) continue;
		if (factIsNegated(fact.memory.text, fact) !== factIsNegated(segment, fact)) {
			polarityMismatch = true;
			continue;
		}
		return {
			ok: true,
			grounding: identity.via,
			conflictReason: identity.conflictReason ?? null,
			support: segment,
		};
	}
	return identityGrounding
		? { ok: false, reason: polarityMismatch ? "fact_polarity_mismatch" : "fact_not_in_submitted_content" }
		: { ok: false, reason: "identity_not_in_submitted_content" };
}

function regexPhrase(value) {
	return canonicalIdentity(value)
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
}

function factPredicatePhrases(fact) {
	const memory = fact?.memory ?? {};
	const configured = memory.kind === "event"
		? (ACTION_TERMS[memory.action] ?? [])
		: (SLICE_TERMS[memory.slice_kind] ?? []);
	return [...new Set([...configured, "is", "are", "has", "have"]
		.map((phrase) => canonicalIdentity(phrase))
		.filter(Boolean))]
		.sort((left, right) => right.length - left.length);
}

function factTargetAfterPredicate(fact, predicates) {
	const claim = canonicalIdentity(fact?.memory?.text);
	for (const predicate of predicates) {
		const index = ` ${claim} `.indexOf(` ${predicate} `);
		if (index < 0) continue;
		const start = index + predicate.length + 1;
		const suffix = claim.slice(start).split(/\b(?:but|instead|not|rather)\b/)[0];
		const target = suffix.split(/\s+/).filter((word) => word && !GROUNDING_STOPWORDS.has(word)).slice(0, 4).join(" ");
		if (target) return target;
	}
	return canonicalIdentity(fact?.identity?.label);
}

function factIsNegated(text, fact) {
	const source = canonicalIdentity(text);
	const predicates = factPredicatePhrases(fact);
	const target = regexPhrase(factTargetAfterPredicate(fact, predicates));
	if (!source || !target || !predicates.length) return false;
	const predicatePattern = predicates.map(regexPhrase).filter(Boolean).join("|");
	const predicateTarget = `(?:${predicatePattern})\\s+(?:the\\s+)?${target}(?:\\b|$)`;
	const negation = "(?:not|never|no\\s+longer|without|don\\s+t|doesn\\s+t|didn\\s+t|can\\s+t|cannot)";
	const modifiers = "(?:(?:currently|now|still|actually|really)\\s+){0,2}";
	return new RegExp(`\\b${negation}\\s+${modifiers}${predicateTarget}`, "i").test(source) ||
		new RegExp(`\\b(?:${predicatePattern})\\s+(?:not|never|no|without)\\s+(?:the\\s+)?${target}(?:\\b|$)`, "i").test(source);
}

function relationshipIsNegated(text, relationship) {
	const source = canonicalIdentity(text);
	const target = regexPhrase(relationship?.to?.label);
	const predicates = (EDGE_TERMS[relationship?.type] ?? [])
		.map(regexPhrase)
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);
	if (!source || !target || !predicates.length) return false;
	const predicateTarget = `(?:${predicates.join("|")})\\s+(?:the\\s+)?${target}(?:\\b|$)`;
	const negation = "(?:not|never|no\\s+longer|without|avoid|avoids|avoiding|reject|rejects|rejecting|skip|skips|skipping|don\\s+t|doesn\\s+t|didn\\s+t|can\\s+t|cannot)";
	const modifiers = "(?:(?:currently|now|still|actually|really)\\s+){0,2}";
	const intent = "(?:(?:want|wants|plan|plans|intend|intends)\\s+to\\s+)?";
	return new RegExp(`\\b${negation}\\s+${modifiers}${intent}${predicateTarget}`, "i").test(source) ||
		new RegExp(`\\b(?:${predicates.join("|")})\\s+(?:not|no|without)\\s+(?:the\\s+)?${target}(?:\\b|$)`, "i").test(source);
}

function validateRelationship(relationship, evidence) {
	if (!validIdentityLabel(relationship?.from?.label) || !validIdentityLabel(relationship?.to?.label)) {
		return { ok: false, reason: "invalid_edge_identity" };
	}
	if (!EDGE_TYPES.includes(relationship?.type)) return { ok: false, reason: "invalid_edge_type" };
	if (canonicalIdentity(relationship.from.label) === canonicalIdentity(relationship.to.label)) {
		return { ok: false, reason: "edge_self_loop" };
	}
	if (!evidence.ok) return { ok: false, reason: evidence.reason };
	for (const segment of evidence.segments) {
		const identitiesGrounded = includesPhrase(segment, relationship.from.label) &&
			includesPhrase(segment, relationship.to.label);
		const predicateSupported = hasAnyTerm(segment, EDGE_TERMS[relationship.type] ?? []);
		const sourceSupport = identitiesGrounded && predicateSupported &&
			(includesPhrase(segment, relationship.text) || overlap(relationship.text, segment) >= 0.7);
		if (!sourceSupport) continue;
		// The edge table represents active positive relations. A negated relation
		// must be handled as a typed correction or a grounded slice; materializing
		// it as a positive edge would invert the user's statement.
		if (relationshipIsNegated(segment, relationship) || relationshipIsNegated(relationship.text, relationship)) {
			return { ok: false, reason: "negative_edge_requires_correction" };
		}
		return { ok: true, support: segment };
	}
	return { ok: false, reason: "edge_not_in_submitted_content" };
}

function correctionValue(value) {
	if (typeof value === "string" || typeof value === "number") return String(value).trim();
	if (!value || typeof value !== "object") return "";
	return String(value.text ?? value.value ?? value.label ?? "").trim();
}

function factCorrectionValues(correction) {
	return {
		oldText: correctionValue(
			correction?.old_text ?? correction?.oldText ?? correction?.old_value ?? correction?.oldValue,
		),
		newText: correctionValue(
			correction?.new_text ?? correction?.newText ?? correction?.new_value ?? correction?.newValue ??
			correction?.replacement_memory ?? correction?.replacementMemory ?? correction?.replacement,
		),
	};
}

function correctionCue(source) {
	return /\b(?:correction|correct(?:ed|ion)?|actually|instead of|no longer|replace(?:s|d)?|switch(?:ed)?|chang(?:e|ed|ing)|not)\b/i.test(source);
}

function validateFactCorrection(correction, evidence) {
	const subject = correction?.subject;
	if (!validIdentityLabel(subject?.label)) return { ok: false, reason: "invalid_correction_subject" };
	const predicate = String(
		correction?.predicate ?? correction?.slice_kind ?? correction?.sliceKind ?? "",
	).trim();
	if (!predicate) return { ok: false, reason: "missing_correction_predicate" };
	const { oldText, newText } = factCorrectionValues(correction);
	if (!oldText || !newText) return { ok: false, reason: "missing_correction_value" };
	if (!evidence.ok) return { ok: false, reason: evidence.reason };
	// A correction commonly spans two adjacent sentences (the prior value, then
	// its replacement). Validate the complete, already-verified evidence span as
	// well as individual sentences so that structure is retained without joining
	// unrelated or uncited source messages.
	const supports = [...new Set([
		...(evidence.spans ?? []).map((span) => String(span?.quote ?? "").trim()),
		...(evidence.segments ?? []),
	].filter(Boolean))];
	for (const segment of supports) {
		if (!correctionCue(segment)) continue;
		if (!includesPhrase(segment, subject.label) && !distinctiveIdentityGrounded(subject.label, segment)) continue;
		if (!includesPhrase(segment, oldText) || !includesPhrase(segment, newText)) continue;
		if (!SLICE_KINDS.includes(predicate) && !includesPhrase(segment, predicate)) continue;
		return { ok: true, support: segment, oldText, newText };
	}
	return { ok: false, reason: "fact_correction_not_in_evidence" };
}

function validateRelationshipCorrection(correction, evidence) {
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
	if (!evidence.ok) return { ok: false, reason: evidence.reason };
	for (const segment of evidence.segments) {
		if (!correctionCue(segment)) continue;
		if (!includesPhrase(segment, subject.label) && !distinctiveIdentityGrounded(subject.label, segment)) continue;
		let targetsGrounded = true;
		for (const target of [oldTarget, newTarget].filter(Boolean)) {
			if (!includesPhrase(segment, target.label)) targetsGrounded = false;
		}
		if (!targetsGrounded) continue;
		if (!hasAnyTerm(segment, EDGE_TERMS[correction.type] ?? [])) continue;
		return { ok: true, support: segment };
	}
	return { ok: false, reason: "correction_not_in_submitted_content" };
}

function validateCorrection(correction, evidence) {
	return correction?.kind === "fact"
		? validateFactCorrection(correction, evidence)
		: validateRelationshipCorrection(correction, evidence);
}

/** Backend grounding/integrity gate for the MCP manual lane only. */
export function applyManualIntegrity(proposal, input = {}) {
	const submittedContent = String(input.submittedContent ?? "").trim();
	const recentContext = String(input.recentContext ?? "").trim();
	const entities = [...(proposal?.entities ?? [])];
	const entitiesByRef = new Map(entities.filter((entity) => entity?.ref).map((entity) => [String(entity.ref), entity]));
	const facts = [];
	const relationships = [];
	const corrections = [];
	const rejected = [...(proposal?.rejected ?? [])];

	for (const fact of proposal?.facts ?? []) {
		if (!roleCanMaterialize(fact?.identity, fact?.subject_ref ?? fact?.entity_ref, entitiesByRef)) {
			rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact?.identity?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		const evidence = evidenceForOperation(fact, { ...input, submittedContent });
		const decision = validateFact(fact, { submittedContent, recentContext }, evidence);
		if (!decision.ok) {
			rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact?.identity?.label ?? null, reason: decision.reason });
			continue;
		}
		facts.push({
			...fact,
			identity: decision.conflictReason
				? { ...fact.identity, _manual_conflict_reason: decision.conflictReason }
				: fact.identity,
			...semanticMetadata(fact, decision.support),
			evidence_ids: evidence.evidenceIds,
			evidence_spans: evidence.spans,
			grounding: decision.grounding,
		});
	}

	for (const relationship of proposal?.relationships ?? []) {
		const fromEligible = roleCanMaterialize(relationship?.from, relationship?.from_ref, entitiesByRef);
		const toEligible = roleCanMaterialize(relationship?.to, relationship?.to_ref, entitiesByRef);
		if (!fromEligible || !toEligible) {
			rejected.push({ kind: "edge", label: relationship?.from?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		const evidence = evidenceForOperation(relationship, { ...input, submittedContent });
		const decision = validateRelationship(relationship, evidence);
		if (!decision.ok) {
			rejected.push({ kind: "edge", label: relationship?.from?.label ?? null, reason: decision.reason });
			continue;
		}
		relationships.push({
			...relationship,
			...semanticMetadata(relationship, decision.support),
			evidence_ids: evidence.evidenceIds,
			evidence_spans: evidence.spans,
		});
	}

	for (const correction of proposal?.corrections ?? []) {
		const subjectEligible = roleCanMaterialize(correction?.subject, correction?.subject_ref, entitiesByRef);
		const oldEligible = !correction?.old_target || roleCanMaterialize(correction.old_target, correction?.old_target_ref, entitiesByRef);
		const newEligible = !correction?.new_target || roleCanMaterialize(correction.new_target, correction?.new_target_ref, entitiesByRef);
		if (!subjectEligible || !oldEligible || !newEligible) {
			rejected.push({ kind: "correction", label: correction?.subject?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		const evidence = evidenceForOperation(correction, { ...input, submittedContent });
		const decision = validateCorrection(correction, evidence);
		if (!decision.ok) {
			rejected.push({ kind: "correction", label: correction?.subject?.label ?? null, reason: decision.reason });
			continue;
		}
		corrections.push({
			...correction,
			...(correction?.kind === "fact" ? {
				old_text: correction.old_text ?? correction.oldText ?? decision.oldText,
				new_text: correction.new_text ?? correction.newText ?? decision.newText,
			} : {}),
			...semanticMetadata(correction, decision.support),
			evidence_ids: evidence.evidenceIds,
			evidence_spans: evidence.spans,
		});
	}

	let primaryMemory = proposal?.primary_memory ?? null;
	const primarySubjectRef = proposal?.primary_subject_ref ?? null;
	if (primaryMemory?.text && primarySubjectRef) {
		const acceptedPrimaryFact = facts.find((fact) =>
			String(fact.subject_ref ?? fact.entity_ref ?? "") === String(primarySubjectRef) &&
			canonicalIdentity(fact.memory?.text) === canonicalIdentity(primaryMemory.text));
		if (acceptedPrimaryFact) {
			primaryMemory = {
				...primaryMemory,
				...semanticMetadata(acceptedPrimaryFact, acceptedPrimaryFact.evidence_spans?.[0]?.quote),
				evidence_ids: acceptedPrimaryFact.evidence_ids,
				evidence_spans: acceptedPrimaryFact.evidence_spans,
			};
		} else {
			const primaryEntity = entitiesByRef.get(String(primarySubjectRef));
			const pseudoFact = primaryEntity ? {
				identity: primaryEntity,
				subject_ref: primarySubjectRef,
				memory: primaryMemory,
				confidence: primaryMemory.confidence ?? 0.9,
				evidence_ids: primaryMemory.evidence_ids,
				evidence_spans: primaryMemory.evidence_spans,
			} : null;
			const evidence = pseudoFact ? evidenceForOperation(pseudoFact, { ...input, submittedContent }) : { ok: false };
			const decision = pseudoFact && roleCanMaterialize(primaryEntity, primarySubjectRef, entitiesByRef)
				? validateFact(pseudoFact, { submittedContent, recentContext }, evidence)
				: { ok: false };
			primaryMemory = decision.ok
				? {
					...primaryMemory,
					...semanticMetadata(primaryMemory, decision.support),
					evidence_ids: evidence.evidenceIds,
					evidence_spans: evidence.spans,
				}
				: null;
		}
	}

	return {
		...proposal,
		primary_subject_ref: primarySubjectRef,
		primary_memory: primaryMemory,
		entities,
		facts,
		relationships,
		corrections,
		rejected,
		hasDurableFacts: facts.length > 0 || relationships.length > 0 || corrections.length > 0,
	};
}
