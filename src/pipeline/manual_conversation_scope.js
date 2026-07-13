const USER_ONLY = "user_only";

export const DEFAULT_MANUAL_CONVERSATION_SCOPE = Object.freeze({
	subject: null,
	speakerScope: USER_ONLY,
	includeAssistantFacts: false,
	excludeOtherPeople: true,
	includeContextForReferenceResolution: true,
});

const SUBJECT_PRONOUNS = new Set([
	"he", "her", "him", "it", "she", "that", "them", "they", "this",
]);

const CLAIM_STOP_WORDS = new Set([
	"a", "about", "an", "and", "are", "as", "at", "be", "been", "being", "by",
	"could", "do", "for", "from", "had", "has", "have", "i", "in", "is", "it",
	"let", "may", "me", "might", "my", "of", "on", "or", "our", "should", "that",
	"the", "their", "them", "they", "this", "to", "use", "using", "we", "will",
	"with", "would", "you", "your",
]);

const ACK_ONLY_RE = /^(?:yes|yep|yeah|ok|okay|sure|thanks|thank you|sounds good|great|perfect|cool)[\s!.]*$/i;
const GREETING_ONLY_RE = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[\s!.]*$/i;
const PROPOSAL_CUE_RE = /\b(?:i (?:suggest|recommend|propose)|my (?:suggestion|recommendation) is|we could|you could|you should|let['\u2019]s|consider|how about|what if|one option is)\b/i;
const CONFIRMATION_CUE_RE = /\b(?:yes[,!]?\s+(?:let['\u2019]s|use|choose|adopt|go with|do)|i (?:agree|accept|approve)|agreed|approved|let['\u2019]s|go with|choose|adopt|do that|that sounds good|this sounds good|the (?:plan|proposal|option) sounds good|we['\u2019]?ll (?:use|do|adopt)|use (?:that|this|the))\b/i;
const REFERENTIAL_CONFIRMATION_RE = /\b(?:that|this|it|the (?:plan|proposal|suggestion|recommendation|option))\b/i;
const AMBIGUOUS_CONFIRMATION_ONLY_RE = /^(?:yes|yep|yeah|i (?:agree|accept|approve)|agreed|approved)[\s!.]*$/i;
const REJECTING_CONFIRMATION_RE = /(?:^|[.!?]\s*)(?:no|nope|nah)\b|\b(?:avoid|decline|disagree with|drop|oppose|reject|rule out|skip)\b|\b(?:instead of|rather than)\b|\b(?:do\s+not|don['\u2019]?t|not)\s+(?:accept|approve|adopt|choose|do|go with|use)\b|\b(?:let['\u2019]s|we\s+(?:will|would|should|can|could)|i\s+(?:will|would|want to|choose to))\s+not\b|\b(?:will|would|should|can|could)\s+not\s+(?:adopt|choose|do|go with|use)\b|\b(?:won['\u2019]?t|wouldn['\u2019]?t|shouldn['\u2019]?t|can['\u2019]?t|cannot|never)\s+(?:adopt|choose|do|go with|use)\b/i;
const SAVE_CONTROL_ONLY_RE = /^(?:please\s+)?(?:save|remember|memorize|store|collect|keep)\s+(?:(?:this|the|our)\s+)?(?:chat|conversation|thread|transcript|messages?|discussion|everything|all(?:\s+of\s+this)?|what\s+we\s+(?:discussed|said)|it)(?:\s+(?:to|in|as)\s+(?:the\s+)?memory)?[\s.!?]*$/i;
const USER_TASK_REQUEST_RE = /^(?:(?:please\s+)?(?:correct|fix|edit|update|revise|create|generate|convert|review|rewrite|remove|add|change|format|prepare|complete|finish)\b|(?:can|could|would|will)\s+you\b|(?:please\s+)?help\s+me\b|i\s+(?:need|want|would\s+like)\s+you\s+to\b)/i;
const ASSISTANT_COMPLETION_RE = /^(?:(?:done|completed|finished|all\s+set)\b|(?:i|we)(?:['\u2019]?ve|\s+have|\s+had)?\s+(?:now\s+)?(?:corrected|fixed|edited|updated|revised|created|generated|converted|reviewed|rewritten|removed|added|changed|formatted|prepared|completed|finished)\b|(?:the|your)\s+.{1,100}?\s+(?:has|have|is|are|was|were)\s+(?:now\s+)?(?:corrected|fixed|edited|updated|revised|created|generated|converted|reviewed|rewritten|removed|added|changed|formatted|prepared|completed|finished)\b)/i;

function cleanText(value, limit = 4000) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : text.slice(0, limit).trim();
}

function canonicalText(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function firstDefined(object, names) {
	for (const name of names) {
		if (object && Object.prototype.hasOwnProperty.call(object, name)) return object[name];
	}
	return undefined;
}

function cleanSubject(value) {
	let subject = cleanText(value, 160)
		.replace(/^[\s'"`\u201c\u201d\u2018\u2019:;,.-]+|[\s'"`\u201c\u201d\u2018\u2019:;,.-]+$/gu, "")
		.replace(/\s+(?:from|in)\s+(?:this|the)\s+(?:chat|conversation|thread)\b.*$/i, "")
		.replace(/\s+from\s+(?:(?:only\s+)?my|(?:only\s+)?(?:the\s+)?user['\u2019]?s?)\s+(?:messages?|turns?|words?)\b.*$/i, "")
		.replace(/\s+(?:and|but)\s+(?:ignore|exclude|skip|don['\u2019]?t)\b.*$/i, "")
		.replace(/\s+only$/i, "")
		.trim();
	if (/^(?:me|myself|the user|user)$/i.test(subject)) return "user";
	if (!subject || SUBJECT_PRONOUNS.has(canonicalText(subject))) return null;
	const words = canonicalText(subject).split(" ").filter(Boolean);
	if (!words.length || words.length > 12) return null;
	return subject;
}

/**
 * Normalize the public contentScope contract. Safety-affecting fields are
 * deliberately locked for the first manual-conversation version.
 */
export function normalizeManualConversationScope(value = {}) {
	const subject = cleanSubject(firstDefined(value, ["subject", "topic"]));
	return {
		subject,
		speakerScope: USER_ONLY,
		includeAssistantFacts: false,
		excludeOtherPeople: true,
		includeContextForReferenceResolution: true,
	};
}

export function normalizeManualConversationMessages(messages = []) {
	const normalized = [];
	for (const [originalIndex, raw] of (Array.isArray(messages) ? messages : []).entries()) {
		const role = typeof raw === "string"
			? "user"
			: String(raw?.role ?? "user").toLocaleLowerCase("en-US");
		if (!(["user", "assistant"].includes(role))) continue;
		const content = String(typeof raw === "string" ? raw : raw?.content ?? "").trim();
		if (!content) continue;
		const ref = `M${normalized.length}`;
		const suppliedId = typeof raw === "string"
			? null
			: (raw?.id ?? raw?.source_message_id ?? raw?.sourceMessageId ?? null);
		normalized.push({
			ref,
			role,
			content,
			source_message_id: suppliedId === null || suppliedId === undefined || suppliedId === ""
				? ref
				: String(suppliedId),
			timestamp: typeof raw === "string" ? null : (raw?.ts ?? raw?.timestamp ?? null),
			original_index: originalIndex,
		});
	}
	return normalized;
}

function messageSegments(message) {
	const segments = [];
	const pattern = /[^.!?;\n]+(?:[.!?]+|(?=;|\n)|$)/g;
	let match;
	while ((match = pattern.exec(message.content)) !== null) {
		const raw = match[0];
		const leading = raw.match(/^\s*/)?.[0]?.length ?? 0;
		const trailing = raw.match(/\s*$/)?.[0]?.length ?? 0;
		const start = match.index + leading;
		const end = match.index + raw.length - trailing;
		if (end <= start) continue;
		segments.push({
			message,
			message_ref: message.ref,
			source_message_id: message.source_message_id,
			role: message.role,
			start,
			end,
			text: message.content.slice(start, end),
		});
	}
	return segments;
}

function subjectFromDirective(text) {
	const source = String(text ?? "");
	const about = source.match(/\b(?:says?\s+)?(?:about|regarding|concerning)\s+(.+?)(?=\s+(?:from|in)\s+(?:this|the)\s+(?:chat|conversation|thread)\b|\s+(?:and|but)\s+(?:ignore|exclude|skip|don['\u2019]?t)\b|[.;!?]|$)/i);
	if (about?.[1]) return cleanSubject(about[1]);
	const possessive = source.match(/^(?:please\s+)?(?:only\s+)?(?:save|remember|memorize|store|collect|keep)\s+(?:only\s+)?(.+?)(?:['\u2019]s\s+)?(?:facts?|details?|information|memories?)\s*(?:only)?[.!]?$/i);
	if (possessive?.[1]) return cleanSubject(possessive[1]);
	const direct = source.match(/^(?:please\s+)?(?:only\s+)?(?:save|remember|memorize|store|collect|keep)\s+(?:only\s+)?(.+?)\s+only[.!]?$/i);
	return cleanSubject(direct?.[1]);
}

function parseScopeDirective(segment) {
	const text = segment.text;
	const saveControl = SAVE_CONTROL_ONLY_RE.test(text);
	const startsScopeCommand = saveControl || (/^(?:please\s+)?(?:only\s+)?(?:save|remember|memorize|store|collect|keep)\b/i.test(text) &&
		/\b(?:only|chat|conversation|thread|messages?|about|regarding|concerning|exclude|ignore|skip)\b/i.test(text));
	const speakerDirective = /^(?:please\s+)?(?:only\s+)?(?:use|include|consider|save|remember)\s+(?:only\s+)?(?:my|the user['\u2019]?s?|user)\s+(?:messages?|turns?|words?)\b/i.test(text) ||
		/^(?:please\s+)?(?:do not|don['\u2019]?t|ignore|exclude|skip)\s+(?:use|include|save|remember)?\s*(?:the\s+)?assistant(?:['\u2019]s)?\s+(?:messages?|facts?|suggestions?|claims?)?\b/i.test(text);
	const assistantFactsRequested = /\b(?:include|save|remember|use)\s+(?:the\s+)?assistant(?:['\u2019]s)?\s+(?:facts?|claims?|suggestions?|messages?)\b/i.test(text) &&
		!/(?:do not|don['\u2019]?t|ignore|exclude|skip)\b/i.test(text);
	if (!startsScopeCommand && !speakerDirective && !assistantFactsRequested) return null;
	return {
		kind: saveControl ? "save_control" : "content_scope_directive",
		subject: subjectFromDirective(text),
		speaker_scope: USER_ONLY,
		assistant_facts_requested: assistantFactsRequested,
		message_ref: segment.message_ref,
		source_message_id: segment.source_message_id,
		evidence_span: evidenceSpan(segment),
		text,
	};
}

function evidenceSpan(segment) {
	return {
		message_ref: segment.message_ref,
		source_message_id: segment.source_message_id,
		role: segment.role,
		start: segment.start,
		end: segment.end,
		quote: segment.text,
	};
}

function userSegmentsAndDirectives(messages) {
	const usable = [];
	const directives = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		for (const segment of messageSegments(message)) {
			// A colon is a useful hard boundary for the common form
			// "Save only about Atlas: Atlas uses D1." Preserve the factual tail.
			const colon = segment.text.indexOf(":");
			if (colon > 0) {
				const head = {
					...segment,
					end: segment.start + colon,
					text: segment.text.slice(0, colon).trimEnd(),
				};
				const directive = parseScopeDirective(head);
				if (directive) {
					directives.push(directive);
					const rawTail = segment.text.slice(colon + 1);
					const leading = rawTail.match(/^\s*/)?.[0]?.length ?? 0;
					const tailText = rawTail.trim();
					if (tailText) {
						const start = segment.start + colon + 1 + leading;
						usable.push({ ...segment, start, end: start + tailText.length, text: tailText });
					}
					continue;
				}
			}
			const directive = parseScopeDirective(segment);
			if (directive) directives.push(directive);
			else usable.push(segment);
		}
	}
	return { usable, directives };
}

export function inferManualConversationScope(messages = []) {
	const normalizedMessages = normalizeManualConversationMessages(messages);
	const { directives } = userSegmentsAndDirectives(normalizedMessages);
	const uniqueSubjects = [];
	const subjectKeys = new Set();
	for (const directive of directives) {
		const subject = cleanSubject(directive.subject);
		const key = canonicalText(subject);
		if (!subject || subjectKeys.has(key)) continue;
		subjectKeys.add(key);
		uniqueSubjects.push(subject);
	}
	const conflicts = uniqueSubjects.length > 1
		? [{ code: "subject_scope_conflict", subjects: uniqueSubjects }]
		: [];
	const warnings = directives.some((item) => item.assistant_facts_requested)
		? ["assistant_facts_not_supported"]
		: [];
	return {
		scope: normalizeManualConversationScope({ subject: uniqueSubjects[0] ?? null }),
		directives,
		conflicts,
		warnings,
		messages: normalizedMessages,
	};
}

export function resolveManualConversationScope(messages = [], contentScope = {}) {
	const inferred = inferManualConversationScope(messages);
	const supplied = normalizeManualConversationScope(contentScope);
	const suppliedSubjectRaw = firstDefined(contentScope, ["subject", "topic"]);
	const suppliedSubject = cleanSubject(suppliedSubjectRaw);
	const inferredSubject = inferred.scope.subject;
	const conflicts = [...inferred.conflicts];
	if (suppliedSubject && inferredSubject && canonicalText(suppliedSubject) !== canonicalText(inferredSubject)) {
		conflicts.push({
			code: "subject_scope_conflict",
			subjects: [suppliedSubject, inferredSubject],
		});
	}
	const warnings = [...inferred.warnings];
	const requestedSpeaker = firstDefined(contentScope, ["speakerScope", "speaker_scope"]);
	if (requestedSpeaker && requestedSpeaker !== USER_ONLY) warnings.push("speaker_scope_forced_user_only");
	if (firstDefined(contentScope, ["includeAssistantFacts", "include_assistant_facts"]) === true) {
		warnings.push("assistant_facts_not_supported");
	}
	if (firstDefined(contentScope, ["excludeOtherPeople", "exclude_other_people"]) === false) {
		warnings.push("other_people_exclusion_required");
	}
	return {
		valid: conflicts.length === 0,
		scope: {
			...supplied,
			subject: suppliedSubject ?? inferredSubject ?? null,
		},
		directives: inferred.directives,
		conflicts,
		warnings: [...new Set(warnings)],
		messages: inferred.messages,
	};
}

function subjectPattern(subject) {
	return canonicalText(subject).split(" ").filter(Boolean);
}

function startsWithSubjectPronoun(value) {
	return /^(?:he|she|they|this person|that person)\b/i.test(String(value ?? "").trim());
}

function segmentIdentifiesUserAsSubject(segment, subject) {
	if (!subject || canonicalText(subject) === "user") return true;
	const escaped = String(subject).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const identity = new RegExp(`\\b(?:i am|i['\\u2019]m|my name is)\\s+${escaped}\\b|\\b${escaped}\\s+(?:is me|is my name)\\b`, "iu");
	return identity.test(segment?.text ?? "");
}

/** Conservative primary-subject check used before graph extraction or page synthesis. */
export function claimMatchesManualConversationSubject(text, subject, options = {}) {
	const clean = cleanSubject(subject);
	if (!clean) return true;
	const normalized = canonicalText(text);
	if (!normalized) return false;
	if (canonicalText(clean) === "user") {
		return /^(?:i|i['\u2019]m|i am|my|me|we|our|the user)\b/i.test(String(text).trim());
	}
	if (options.userIsSubject && /^(?:i|i['\u2019]m|i am|my|me|we|our)\b/i.test(String(text).trim())) return true;
	if (options.allowPronounContext && startsWithSubjectPronoun(text)) return true;

	const subjectWords = subjectPattern(clean);
	const words = normalized.split(" ");
	let subjectIndex = -1;
	for (let index = 0; index <= words.length - subjectWords.length; index++) {
		if (subjectWords.every((word, offset) => words[index + offset] === word)) {
			subjectIndex = index;
			break;
		}
	}
	if (subjectIndex < 0) return false;
	if (subjectIndex === 0) return true;
	const raw = String(text);
	const escaped = String(clean).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (new RegExp(`\\b${escaped}['\\u2019]s\\b`, "iu").test(raw)) return true;
	if (new RegExp(`\\b(?:about|regarding|concerning|for)\\s+${escaped}\\b`, "iu").test(raw)) return true;
	if (/^(?:i\s+(?:think|believe|know|remember|said|noted)\s+(?:that\s+)?)\b/i.test(raw.trim())) return true;
	const prefix = words.slice(0, subjectIndex).join(" ");
	if (/^(?:today|currently|now|yesterday|recently|at work|this (?:week|month|year)|should|could|would|will|can|may|might|does|did|is|was)$/.test(prefix)) return true;

	const predicateWords = new Set([
		"am", "are", "asked", "became", "built", "called", "chose", "compared", "decided", "does",
		"emailed", "has", "helped", "is", "joined", "knows", "likes", "mentioned", "met", "owns",
		"plans", "prefers", "said", "spoke", "started", "stopped", "thanked", "told", "uses", "wants",
		"was", "works",
	]);
	const firstPredicate = words.findIndex((word) => predicateWords.has(word));
	return firstPredicate >= 0 && subjectIndex < firstPredicate;
}

function semanticMetadata(text, { adopted = false } = {}) {
	const value = String(text ?? "");
	const historical = /\b(?:used to|previously|formerly|in the past|yesterday|last (?:week|month|year|night)|was|were|had)\b/i.test(value);
	const possible = /\b(?:maybe|might|may|perhaps|possibly|considering|not sure|could)\b/i.test(value);
	const planned = /\b(?:plan(?:ning|ned)?|will|going to|intend(?:ing|ed)?|want to|hope to|next step|let['\u2019]s)\b/i.test(value);
	const decision = /\b(?:decided|chose|selected|agreed|approved|go with|adopt)\b/i.test(value);
	const question = /\?\s*$/.test(value);
	const currentCue = /\b(?:currently|now|today|still|no longer|am|is|are|has|have|uses|works)\b/i.test(value);
	let type = "fact";
	if (question) type = "open_question";
	else if (adopted || (decision && !planned && !possible)) type = "decision";
	else if (planned || possible) type = "plan";
	else if (historical) type = "historical_state";
	else if (currentCue) type = "current_state";
	return {
		type,
		attribution: adopted ? "user_adopted" : "user_stated",
		polarity: /\b(?:avoid|decline|not|never|no longer|don['\u2019]?t|doesn['\u2019]?t|didn['\u2019]?t|cannot|can['\u2019]?t|reject|rule out|skip|without)\b/i.test(value)
			? "negative"
			: "positive",
		modality: question || possible ? "possible" : planned ? "planned" : "asserted",
		current: !historical,
		temporal_status: historical ? "historical" : "current",
	};
}

function materialTokens(value) {
	return [...new Set(canonicalText(value)
		.split(" ")
		.filter((word) => word.length > 1 && !CLAIM_STOP_WORDS.has(word)))];
}

function proposalText(value) {
	let text = cleanText(value, 1200)
		.replace(/\b(?:i (?:suggest|recommend|propose)(?:\s+that)?|my (?:suggestion|recommendation) is(?:\s+that)?|we could|you could|you should|let['\u2019]s|consider|how about|what if|one option is)\b\s*/i, "")
		.trim();
	if (!text) return cleanText(value, 1200);
	text = `${text.charAt(0).toLocaleUpperCase("en-US")}${text.slice(1)}`;
	return text;
}

function proposalIsExplicitlyNegated(segmentText, proposal, subject = null) {
	const proposalTokens = new Set(materialTokens(proposal?.text)
		.filter((token) => !new Set(materialTokens(subject)).has(token)));
	if (!proposalTokens.size) return false;
	const words = canonicalText(segmentText).split(" ").filter(Boolean);
	for (let index = 0; index < words.length; index++) {
		if (words[index] !== "not" || words[index + 1] === "only") continue;
		// Bind the negation to a nearby distinctive proposal token. This keeps a
		// contrastive choice such as "use D1, not R2" from adopting R2 while
		// still allowing an independently confirmed proposal elsewhere in the
		// same user sentence.
		if (words.slice(index + 1, index + 6).some((word) => proposalTokens.has(word))) return true;
	}
	return false;
}

function proposalsFromMessages(messages) {
	const proposals = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const segment of messageSegments(message)) {
			if (!PROPOSAL_CUE_RE.test(segment.text)) continue;
			const proposition = proposalText(segment.text);
			proposals.push({
				id: `P${proposals.length}`,
				text: proposition,
				original_text: segment.text,
				message_ref: segment.message_ref,
				source_message_id: segment.source_message_id,
				message_index: messages.indexOf(message),
				evidence_span: evidenceSpan(segment),
				context_only: true,
				adopted: false,
			});
		}
	}
	return proposals;
}

function acceptedProposal(segment, proposals, messageIndex, subject = null) {
	if (!CONFIRMATION_CUE_RE.test(segment.text)) return null;
	// A rejection can contain the same lexical material as the proposal and can
	// even start with an affirmative discourse marker (for example, "Yes,
	// let's not use D1"). It must remain a user-stated negative claim; adopting
	// the assistant's positive proposition here would invert the user's intent.
	if (REJECTING_CONFIRMATION_RE.test(segment.text)) return null;
	const available = proposals.filter((proposal) =>
		!proposal.adopted &&
		proposal.message_index < messageIndex &&
		!proposalIsExplicitlyNegated(segment.text, proposal, subject));
	if (!available.length) return null;
	const subjectTokens = new Set(materialTokens(subject));
	const confirmation = new Set(materialTokens(segment.text).filter((token) => !subjectTokens.has(token)));
	const ranked = available.map((proposal) => ({
		proposal,
		overlap: materialTokens(proposal.text)
			.filter((token) => !subjectTokens.has(token) && confirmation.has(token)).length,
	})).sort((left, right) => right.overlap - left.overlap || right.proposal.message_index - left.proposal.message_index);
	if (ranked[0].overlap > 0 && ranked[0].overlap > (ranked[1]?.overlap ?? 0)) return ranked[0].proposal;
	if (!REFERENTIAL_CONFIRMATION_RE.test(segment.text)) return null;
	const latestMessageIndex = Math.max(...available.map((proposal) => proposal.message_index));
	if (messageIndex - latestMessageIndex > 2) return null;
	const latest = available.filter((proposal) => proposal.message_index === latestMessageIndex);
	return latest.length === 1 ? latest[0] : null;
}

function claimFromSegment(segment, id, scope, options = {}) {
	const span = evidenceSpan(segment);
	const adopted = options.proposal ?? null;
	const evidenceSpans = adopted ? [adopted.evidence_span, span] : [span];
	const sourceIds = evidenceSpans.map((item) => item.source_message_id);
	const subjectRef = scope.subject ? "E0" : null;
	const metadata = semanticMetadata(adopted ? adopted.text : segment.text, { adopted: Boolean(adopted) });
	return {
		id,
		claim_id: id,
		subject_ref: subjectRef,
		subject: scope.subject,
		text: adopted ? adopted.text : segment.text,
		...metadata,
		...(options.pageOnly ? {
			page_only: true,
			claim_kind: options.claimKind ?? "user_task_request",
			type: "plan",
			modality: "planned",
		} : {}),
		source_message_ids: [...new Set(sourceIds)],
		source_message_refs: [...new Set(evidenceSpans.map((item) => item.message_ref))],
		evidence_spans: evidenceSpans,
		...(adopted ? {
			proposal_id: adopted.id,
			proposal_source_message_id: adopted.source_message_id,
			confirmation_source_message_id: segment.source_message_id,
			confirmation_text: segment.text,
			adoption: {
				proposal_id: adopted.id,
				proposal_message_ref: adopted.message_ref,
				proposal_source_message_id: adopted.source_message_id,
				confirmation_message_ref: segment.message_ref,
				confirmation_source_message_id: segment.source_message_id,
			},
		} : {}),
	};
}

function scopedSourceMessages(claims, messages) {
	const userClaims = claims.filter((claim) => claim.attribution === "user_stated" && claim.page_only !== true);
	const stated = messages
		.filter((message) => message.role === "user")
		.map((message) => {
			const parts = userClaims
				.flatMap((claim) => claim.evidence_spans)
				.filter((span) => span.message_ref === message.ref && span.role === "user")
				.sort((left, right) => left.start - right.start)
				.map((span) => span.quote);
			if (!parts.length) return null;
			return {
				id: message.source_message_id,
				source_message_id: message.source_message_id,
				role: "user",
				content: [...new Set(parts)].join(" "),
				timestamp: message.timestamp,
			};
		})
		.filter(Boolean);
	const adopted = claims
		.filter((claim) => claim.attribution === "user_adopted" && claim.page_only !== true)
		.map((claim) => ({
			id: `adopted:${claim.claim_id}:${claim.confirmation_source_message_id ?? claim.claim_id}`,
			source_message_id: claim.confirmation_source_message_id ?? claim.claim_id,
			role: "user",
			content: claim.text,
			attribution: "user_adopted",
			claim_id: claim.claim_id,
			source_message_ids: claim.source_message_ids,
			evidence_spans: claim.evidence_spans,
		}));
	return [...stated, ...adopted];
}

function scopedPageSourceMessages(claims, messages) {
	const byRef = new Map(messages.map((message) => [message.ref, message]));
	const partsByRef = new Map();
	for (const claim of claims ?? []) {
		for (const span of claim.evidence_spans ?? []) {
			if (!["user", "assistant"].includes(span?.role) || !span?.message_ref || !span?.quote) continue;
			if (!partsByRef.has(span.message_ref)) partsByRef.set(span.message_ref, []);
			const parts = partsByRef.get(span.message_ref);
			if (!parts.some((part) => part.start === span.start && part.quote === span.quote)) parts.push(span);
		}
	}
	return [...partsByRef.entries()]
		.map(([messageRef, parts]) => {
			const message = byRef.get(messageRef);
			if (!message) return null;
			const content = [...parts]
				.sort((left, right) => Number(left.start ?? 0) - Number(right.start ?? 0))
				.map((part) => part.quote)
				.filter((part, index, values) => values.indexOf(part) === index)
				.join(" ");
			if (!content) return null;
			return {
				id: message.source_message_id,
				source_message_id: message.source_message_id,
				role: message.role,
				content,
				timestamp: message.timestamp,
			};
		})
		.filter(Boolean)
		.sort((left, right) => {
			const leftIndex = messages.findIndex((message) => message.source_message_id === left.source_message_id);
			const rightIndex = messages.findIndex((message) => message.source_message_id === right.source_message_id);
			return leftIndex - rightIndex;
		});
}

function assistantCompletionClaims(messages, claims, scope) {
	const taskClaims = claims.filter((claim) => claim.page_only === true && claim.claim_kind === "user_task_request");
	if (!taskClaims.length) return [];
	const messageIndexByRef = new Map(messages.map((message, index) => [message.ref, index]));
	const output = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const assistantIndex = messageIndexByRef.get(message.ref);
		for (const segment of messageSegments(message)) {
			if (!ASSISTANT_COMPLETION_RE.test(segment.text)) continue;
			const eligible = taskClaims.filter((claim) => {
				const requestRef = claim.evidence_spans?.find((span) => span.role === "user")?.message_ref;
				const requestIndex = messageIndexByRef.get(requestRef);
				return Number.isFinite(requestIndex) && requestIndex < assistantIndex && assistantIndex - requestIndex <= 2;
			});
			if (!eligible.length) continue;
			const latestIndex = Math.max(...eligible.map((claim) => messageIndexByRef.get(
				claim.evidence_spans.find((span) => span.role === "user")?.message_ref,
			)));
			const latest = eligible.filter((claim) => messageIndexByRef.get(
				claim.evidence_spans.find((span) => span.role === "user")?.message_ref,
			) === latestIndex);
			if (latest.length !== 1) continue;
			const request = latest[0];
			const completionSpan = evidenceSpan(segment);
			const requestSpan = request.evidence_spans.find((span) => span.role === "user");
			output.push({
				id: `C${claims.length + output.length}`,
				claim_id: `C${claims.length + output.length}`,
				subject_ref: request.subject_ref ?? (scope.subject ? "E0" : null),
				subject: request.subject ?? scope.subject,
				text: segment.text,
				type: "historical_state",
				claim_kind: "assistant_completed_action",
				attribution: "assistant_completed",
				polarity: "positive",
				modality: "asserted",
				current: false,
				temporal_status: "historical",
				responds_to_claim_id: request.claim_id,
				responds_to_source_message_id: requestSpan?.source_message_id ?? null,
				source_message_ids: [...new Set([
					requestSpan?.source_message_id,
					completionSpan.source_message_id,
				].filter(Boolean))],
				source_message_refs: [...new Set([
					requestSpan?.message_ref,
					completionSpan.message_ref,
				].filter(Boolean))],
				evidence_spans: [requestSpan, completionSpan].filter(Boolean),
			});
		}
	}
	return output;
}

/**
 * Build the deterministic source policy boundary consumed by the MCP manual
 * graph and page lanes. This function performs no model or persistence work.
 */
export function buildManualConversationClaims(messages = [], contentScope = {}) {
	const resolution = resolveManualConversationScope(messages, contentScope);
	const scope = resolution.scope;
	const { usable, directives } = userSegmentsAndDirectives(resolution.messages);
	const proposals = proposalsFromMessages(resolution.messages);
	const claims = [];
	const ignored = directives.map((directive) => ({
		kind: "message_segment",
		message_ref: directive.message_ref,
		source_message_id: directive.source_message_id,
		reason: directive.kind === "save_control" ? "save_control_message" : "content_scope_directive",
		text: directive.text,
	}));
	if (!resolution.valid) {
		return {
			ok: false,
			resolved_scope: scope,
			primary_subject: scope.subject ? { ref: "E0", label: scope.subject } : null,
			claims,
			directives,
			assistant_proposals: proposals,
			source_messages: [],
			page_source_messages: [],
			page_claims: [],
			reference_context: [],
			ignored,
			conflicts: resolution.conflicts,
			warnings: resolution.warnings,
		};
	}

	let userIsSubject = canonicalText(scope.subject) === "user";
	let priorMatchedSubject = false;
	let priorMatchedMessageIndex = -Infinity;
	for (const segment of usable) {
		const messageIndex = resolution.messages.findIndex((message) => message.ref === segment.message_ref);
		const identifiesUser = segmentIdentifiesUserAsSubject(segment, scope.subject);
		const proposal = acceptedProposal(segment, proposals, messageIndex, scope.subject);
		const hasPriorProposal = proposals.some((item) => !item.adopted && item.message_index < messageIndex);
		const rejectsProposal = REJECTING_CONFIRMATION_RE.test(segment.text);
		if (!proposal && !rejectsProposal && hasPriorProposal && CONFIRMATION_CUE_RE.test(segment.text) && (
			REFERENTIAL_CONFIRMATION_RE.test(segment.text) || AMBIGUOUS_CONFIRMATION_ONLY_RE.test(segment.text)
		)) {
			ignored.push({
				kind: "message_segment",
				message_ref: segment.message_ref,
				source_message_id: segment.source_message_id,
				reason: "ambiguous_proposal_confirmation",
				text: segment.text,
			});
			priorMatchedSubject = false;
			continue;
		}
		const candidateText = proposal?.text ?? segment.text;
		const matchesSubject = claimMatchesManualConversationSubject(candidateText, scope.subject, {
			userIsSubject: userIsSubject || identifiesUser,
			allowPronounContext: priorMatchedSubject && messageIndex - priorMatchedMessageIndex <= 2,
		}) || (proposal && claimMatchesManualConversationSubject(segment.text, scope.subject, {
			userIsSubject: userIsSubject || identifiesUser,
		}));
		if (!matchesSubject) {
			ignored.push({
				kind: "message_segment",
				message_ref: segment.message_ref,
				source_message_id: segment.source_message_id,
				reason: "outside_subject_scope",
				text: segment.text,
			});
			priorMatchedSubject = false;
			continue;
		}
		if (GREETING_ONLY_RE.test(segment.text) || (!proposal && ACK_ONLY_RE.test(segment.text))) {
			ignored.push({
				kind: "message_segment",
				message_ref: segment.message_ref,
				source_message_id: segment.source_message_id,
				reason: proposal ? "ambiguous_proposal_confirmation" : "non_claim_acknowledgement",
				text: segment.text,
			});
			priorMatchedSubject = false;
			continue;
		}
		const pageOnly = !proposal && USER_TASK_REQUEST_RE.test(segment.text);
		const claim = claimFromSegment(segment, `C${claims.length}`, scope, {
			proposal,
			pageOnly,
			claimKind: pageOnly ? "user_task_request" : null,
		});
		claims.push(claim);
		if (proposal) proposal.adopted = true;
		if (identifiesUser) userIsSubject = true;
		priorMatchedSubject = Boolean(scope.subject && (
			claimMatchesManualConversationSubject(candidateText, scope.subject, { userIsSubject }) ||
			startsWithSubjectPronoun(candidateText)
		));
		priorMatchedMessageIndex = messageIndex;
	}

	const adoptedProposalIds = new Set(claims.map((claim) => claim.proposal_id).filter(Boolean));
	const assistantProposals = proposals.map((proposal) => ({
		...proposal,
		adopted: adoptedProposalIds.has(proposal.id),
		// The assistant turn remains context even after adoption. Only the linked
		// user_adopted claim crosses the memory boundary.
		context_only: true,
		adopted_claim_id: claims.find((claim) => claim.proposal_id === proposal.id)?.claim_id ?? null,
	}));
	const referenceContext = scope.includeContextForReferenceResolution
		? resolution.messages.filter((message) => message.role === "assistant").map((message) => ({
			ref: message.ref,
			role: "assistant",
			content: message.content,
			source_message_id: message.source_message_id,
			context_only: true,
		}))
		: [];
	const completions = assistantCompletionClaims(resolution.messages, claims, scope);
	const completedRequestIds = new Set(completions.map((claim) => claim.responds_to_claim_id));
	const pageClaims = [
		...claims.map((claim) => completedRequestIds.has(claim.claim_id)
			? { ...claim, type: "historical_state", current: false, temporal_status: "historical" }
			: claim),
		...completions,
	];
	return {
		ok: true,
		resolved_scope: scope,
		primary_subject: scope.subject ? { ref: "E0", label: scope.subject } : null,
		claims,
		page_claims: pageClaims,
		directives,
		assistant_proposals: assistantProposals,
		source_messages: scopedSourceMessages(claims, resolution.messages),
		page_source_messages: scopedPageSourceMessages(pageClaims, resolution.messages),
		reference_context: referenceContext,
		ignored,
		conflicts: resolution.conflicts,
		warnings: resolution.warnings,
	};
}

/** Model-safe claim projection for the later extraction/synthesis stages. */
export function manualConversationClaimEnvelope(result = {}) {
	const claims = result.page_claims ?? result.claims ?? [];
	return {
		resolved_scope: result.resolved_scope ?? normalizeManualConversationScope(),
		primary_subject: result.primary_subject ?? null,
		claims: claims.map((claim) => ({
			claim_id: claim.claim_id,
			type: claim.type,
			subject_ref: claim.subject_ref,
			text: claim.text,
			attribution: claim.attribution,
			polarity: claim.polarity,
			modality: claim.modality,
			current: claim.current,
			temporal_status: claim.temporal_status,
			...(claim.claim_kind ? { claim_kind: claim.claim_kind } : {}),
			...(claim.page_only === true ? { page_only: true } : {}),
			...(claim.responds_to_claim_id ? { responds_to_claim_id: claim.responds_to_claim_id } : {}),
			...(claim.responds_to_source_message_id ? {
				responds_to_source_message_id: claim.responds_to_source_message_id,
			} : {}),
			source_message_ids: claim.source_message_ids,
			evidence_spans: claim.evidence_spans,
			...(claim.adoption ? { adoption: claim.adoption } : {}),
		})),
	};
}
