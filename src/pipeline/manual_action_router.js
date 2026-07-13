/**
 * Pure host-side router for UML's three-tool MCP manual memory door.
 *
 * This module selects an action; it never authenticates, creates a source
 * packet, invokes a memory command, touches D1/Vectorize, or calls a Durable
 * Object. The selected MCP tool remains responsible for authorization and all
 * persistence. The optional vector and LLM hooks are read-only intent signals.
 */

import { extractJson, responseText } from "./llm.js";
import {
	normalizeManualConversationMessages,
	normalizeManualConversationScope,
	resolveManualConversationScope,
} from "./manual_conversation_scope.js";

export const MANUAL_ACTIONS = Object.freeze([
	"save_memory",
	"save_conversation",
	"recall_memory",
	"no_action",
	"clarify",
]);

const ACTION_SET = new Set(MANUAL_ACTIONS);
const TOOL_ACTIONS = new Set(["save_memory", "save_conversation", "recall_memory"]);

const STOP_WORDS = new Set([
	"a", "about", "all", "an", "and", "are", "as", "at", "be", "can", "could", "do", "for",
	"from", "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "please",
	"that", "the", "this", "to", "we", "what", "with", "would", "you", "your",
]);

// Examples deliberately describe intent rather than memory content. The router
// uses BM25 as a request classifier, not as a durability or identity gate.
const ACTION_EXAMPLES = Object.freeze({
	save_memory: Object.freeze([
		"remember this fact about me",
		"save this preference in memory",
		"keep this detail for later",
		"store this one memory",
		"record that I started a project",
		"make a note that I prefer concise answers",
		"hold on to this personal detail",
		"preserve this decision as memory",
	]),
	save_conversation: Object.freeze([
		"save this conversation",
		"remember what we discussed in this chat",
		"store the facts from these messages",
		"save only what this chat says about a subject",
		"collect durable facts from this thread",
		"memorize the user facts in the transcript",
		"keep the important parts of our conversation",
		"save my messages from this discussion",
	]),
	recall_memory: Object.freeze([
		"what do you remember about me",
		"recall my saved memory about a topic",
		"retrieve what I told you before",
		"look up my projects in memory",
		"search your memory for my preferences",
		"what are my current projects",
		"remind me what you know about my goals",
		"find the personal context you have about me",
	]),
	no_action: Object.freeze([
		"hello how are you",
		"thanks that is helpful",
		"explain how this code works",
		"write a function for this task",
		"what is the weather today",
		"summarize this public article",
		"help me debug this error",
		"translate this sentence",
	]),
	clarify: Object.freeze([
		"save this",
		"remember it",
		"use my memory somehow",
		"do something with memory",
		"save or recall this",
		"which memory action should happen",
	]),
});

const SAVE_CUE_RE = /\b(?:add(?:\s+this)?\s+to\s+(?:my|your|the)?\s*memor(?:y|ies)|hold\s+on\s+to|keep|memorize|memorise|note|preserve|record|remember|retain|save|store)\b/i;
const NON_REMEMBER_SAVE_CUE_RE = /\b(?:add(?:\s+this)?\s+to\s+(?:my|your|the)?\s*memor(?:y|ies)|hold\s+on\s+to|keep|memorize|memorise|note|preserve|record|retain|save|store)\b/i;
const RECALL_SHAPED_REMEMBER_RE = /\b(?:can|could|do|what\s+do|would)\s+you\s+remember\b/i;
const DIRECT_REMEMBER_RE = /\b(?:(?:can|could|would)\s+you\s+)?remember\s+(?:that\b|this\s+(?:decision|detail|fact|memory|preference)\b)/i;
const RECALL_CUE_RE = /\b(?:(?:can|could|do|would)\s+you\s+remember|do\s+you\s+know\s+(?:anything\s+)?about\s+me|find\s+(?:in|from)\s+(?:my|your|the)?\s*memor(?:y|ies)|look\s*up\s+(?:in\s+)?(?:my|your|the)?\s*memor(?:y|ies)|recall|remind\s+me\s+what\s+you\s+know|retrieve|search\s+(?:my|your|the)?\s*memor(?:y|ies)|tell\s+me\s+what\s+you\s+know\s+about\s+me|what\s+(?:did\s+i\s+tell|do\s+you\s+(?:know|remember)))\b/i;
const CONVERSATION_CUE_RE = /\b(?:(?:this|the|our)\s+(?:chat|conversation|discussion|thread|transcript)|chat\s+history|conversation\s+history|these\s+messages|the\s+messages|my\s+messages|what\s+(?:i\s+(?:just\s+)?(?:said|told\s+you)|we\s+(?:discussed|said))|everything\s+(?:i|we)\s+(?:said|discussed)|facts?\s+from\s+(?:this|the|our)\s+(?:chat|conversation|thread))\b/i;
const WRITE_DECLINED_RE = /\b(?:do\s+not|don['\u2019]?t|never|no\s+need\s+to|please\s+avoid)\s+(?:remember|memorize|memorise|save|store|record|retain|keep)\b|\b(?:opt\s*out|memory\s+off)\b/i;
const RECALL_DECLINED_RE = /\b(?:do\s+not|don['\u2019]?t|never|no\s+need\s+to|please\s+avoid)\s+(?:(?:try|attempt)\s+to\s+)?(?:recall(?:ing)?|retriev(?:e|ing)|search(?:ing)?(?:\s+(?:in|through))?|look(?:ing)?\s*up|find(?:ing)?\s+(?:in|from))\b/i;
const UNSUPPORTED_MUTATION_RE = /\b(?:delete|erase|forget|remove|wipe)\b.{0,48}\b(?:memor(?:y|ies)|remembered|saved|everything|fact|facts)\b|\b(?:delete|erase|forget|remove|wipe)\s+(?:that|this|it|everything)\b/i;
const UNRELATED_SAVE_RE = /^(?:please\s+)?(?:save|store|record)\s+(?:(?:this|that|the|my)\s+)?(?:audio|code|data|document|file|image|photo|recording|spreadsheet|video)\b|^(?:please\s+)?keep\s+(?:going|trying|working|(?:(?:this|that|the)\s+)?(?:file|tab|window)\s+open)\b/i;
const REFERENTIAL_ONLY_RE = /^(?:it|this|that|these|those|them|the\s+(?:above|last)\s+(?:message|thing)|what\s+i\s+just\s+said)[\s.!?]*$/i;
const LEADING_REFERENCE_RE = /^(?:he|her|him|it|she|that|they|them|these|this|those)\b/i;
const DIRECTIVE_RESIDUE_RE = /^(?:as\s+(?:a\s+)?memor(?:y|ies)|for\s+(?:future\s+reference|later)|in\s+(?:my\s+|your\s+|the\s+)?memor(?:y|ies))[\s.!?]*$/i;
const GENERIC_MEMORY_ONLY_RE = /^(?:please\s+)?(?:my\s+|your\s+)?memor(?:y|ies)[\s.!?]*$/i;
const GREETING_OR_ACK_RE = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|ok|okay|cool|great|perfect)[\s!.?]*$/i;
const PERSONAL_RECALL_RE = /(?:\bwhat\b|\bwhich\b|\bwhere\b|\bwhen\b|\bwho\b|\bremind\s+me\b).{0,80}\b(?:my|i)\b.{0,100}\b(?:famil(?:y|ies)|friends?|goals?|habits?|health|interests?|preferences?|projects?|skills?|started|stopped|told|use|using|work)\b/i;
const SEMANTIC_MEMORY_OPERATION_RE = /\b(?:add|apply|archive|bring|capture|choose|decide|make|put|stash|surface|use)\b.{0,100}\bmemor(?:y|ies)\b|\bmemor(?:y|ies)\b.{0,100}\b(?:add|apply|archive|bring|capture|choose|decide|make|put|stash|surface|use)\b/i;

const ROUTER_SYSTEM_PROMPT = `You route an explicit host request to UML's manual memory door.
Return exactly one JSON object:
{"chosen_action":"save_memory|save_conversation|recall_memory|no_action|clarify","confidence":0.0,"reason_codes":[]}

Rules:
- save_memory: one explicit submitted memory with self-contained content.
- save_conversation: an explicit request to save facts from supplied chat messages.
- recall_memory: a request for previously known personal context.
- no_action: no memory operation was requested or useful.
- clarify: the memory intent is conflicting, referential, or missing required content.
Never invent content. Never return tool arguments, identifiers, scopes, or any action outside this list.`;

function cleanText(value, max = 4000) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= max ? text : text.slice(0, max).trim();
}

function canonicalText(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function tokenize(value) {
	return canonicalText(value)
		.split(/\s+/)
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function clampScore(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function rounded(value) {
	return Math.round(clampScore(value) * 10_000) / 10_000;
}

function unique(values) {
	return [...new Set((values ?? []).filter(Boolean))];
}

function normalizedMessages(messages) {
	return normalizeManualConversationMessages(messages).map((message) => ({
		...(message.source_message_id !== message.ref ? { id: message.source_message_id } : {}),
		role: message.role,
		content: message.content,
		...(message.timestamp !== null && message.timestamp !== undefined ? { ts: message.timestamp } : {}),
	}));
}

function plainScope(value) {
	return normalizeManualConversationScope(value ?? {});
}

function copyMetadata(target, input, names) {
	for (const name of names) {
		if (input?.[name] !== undefined && input?.[name] !== null) target[name] = input[name];
	}
	return target;
}

function directContentFromRequest(request) {
	let value = cleanText(request);
	value = value
		.replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+/i, "")
		.replace(/^(?:please\s+)?(?:add(?:\s+this)?\s+to\s+(?:my|your|the)?\s*memor(?:y|ies)|archive|hold\s+on\s+to|keep|make\s+(?:a\s+)?note|memorize|memorise|note|preserve|record|remember|retain|save|stash|store)\b/i, "")
		.replace(/^\s+(?:this\s+(?:fact|memory|detail|decision|preference)|this|that)\b/i, "")
		.replace(/^\s+(?:as|in)\s+(?:a\s+)?memor(?:y|ies)\b/i, "")
		.replace(/^\s*(?:in\s+memor(?:y|ies)\s*)?(?::|,|-)?\s*(?:that\s+)?/i, "")
		.trim();
	return value;
}

function hasUsableDirectContent(value, recentContext = "") {
	const content = cleanText(value);
	if (!content || REFERENTIAL_ONLY_RE.test(content) || DIRECTIVE_RESIDUE_RE.test(content) || GENERIC_MEMORY_ONLY_RE.test(content)) return false;
	if (LEADING_REFERENCE_RE.test(content) && !cleanText(recentContext)) return false;
	const material = tokenize(content).filter((token) => !["fact", "memory", "memories", "detail", "thing"].includes(token));
	return material.length > 0;
}

function hasUsableRecallQuery(input, request) {
	const explicit = cleanText(input?.query ?? input?.topic);
	if (explicit) return true;
	if (/\b(?:about\s+me|what\s+you\s+know\s+about\s+me|my\s+(?:saved\s+)?memor(?:y|ies))\b/i.test(request)) return true;
	let residue = canonicalText(request)
		.replace(/\b(?:about|before|did|do|find|from|i|in|know|look|memory|memories|me|my|recall|remember|remind|retrieve|saved|search|tell|the|what|you|your)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return residue.length >= 2;
}

function hasExplicitSaveIntent(request) {
	return SAVE_CUE_RE.test(request) &&
		!WRITE_DECLINED_RE.test(request) &&
		(!RECALL_SHAPED_REMEMBER_RE.test(request) || DIRECT_REMEMBER_RE.test(request) || NON_REMEMBER_SAVE_CUE_RE.test(request));
}

function hasExplicitRecallIntent(request) {
	return (RECALL_CUE_RE.test(request) && !DIRECT_REMEMBER_RE.test(request)) || PERSONAL_RECALL_RE.test(request);
}

function requestHasMemorySignal(request) {
	return hasExplicitSaveIntent(request) || hasExplicitRecallIntent(request) || /\bmemor(?:y|ies)\b/i.test(request);
}

function hasExplicitMemoryOperation(request) {
	return hasExplicitSaveIntent(request) || hasExplicitRecallIntent(request) || SEMANTIC_MEMORY_OPERATION_RE.test(request);
}

function deterministicDecision(input) {
	const request = input.request;
	const save = hasExplicitSaveIntent(request);
	const recall = hasExplicitRecallIntent(request);
	const conversation = CONVERSATION_CUE_RE.test(request);

	if (!request) return { action: "no_action", confidence: 1, reasons: ["empty_request"] };
	if (GREETING_OR_ACK_RE.test(request)) {
		return { action: "no_action", confidence: 1, reasons: ["non_memory_request"] };
	}
	if (WRITE_DECLINED_RE.test(request)) {
		return { action: "no_action", confidence: 1, reasons: ["user_declined_memory_write"] };
	}
	if (RECALL_DECLINED_RE.test(request) && !save) {
		return { action: "no_action", confidence: 1, reasons: ["user_declined_memory_recall"] };
	}
	if (UNSUPPORTED_MUTATION_RE.test(request)) {
		return { action: "clarify", confidence: 1, reasons: ["unsupported_memory_action"] };
	}
	if (UNRELATED_SAVE_RE.test(request)) {
		return { action: "no_action", confidence: 1, reasons: ["unrelated_save_request"] };
	}
	if (save && recall) {
		return { action: "clarify", confidence: 1, reasons: ["conflicting_memory_actions"] };
	}
	if (save && conversation) {
		return {
			action: "save_conversation",
			confidence: 0.99,
			reasons: ["explicit_save_request", "conversation_scope"],
		};
	}
	if (save) {
		const content = cleanText(input.content) || directContentFromRequest(request);
		if (!hasUsableDirectContent(content, input.recentContext)) {
			return { action: "clarify", confidence: 1, reasons: ["explicit_save_request", "missing_direct_content"] };
		}
		return { action: "save_memory", confidence: 0.99, reasons: ["explicit_save_request", "direct_content_present"] };
	}
	if (recall) {
		if (!hasUsableRecallQuery(input, request)) {
			return { action: "clarify", confidence: 1, reasons: ["explicit_recall_request", "missing_recall_query"] };
		}
		return { action: "recall_memory", confidence: 0.98, reasons: ["explicit_recall_request"] };
	}
	if (GENERIC_MEMORY_ONLY_RE.test(request)) {
		return { action: "clarify", confidence: 1, reasons: ["ambiguous_memory_intent"] };
	}
	if (!requestHasMemorySignal(request)) {
		return { action: "no_action", confidence: 0.99, reasons: ["no_memory_intent"] };
	}
	return null;
}

function termFrequencies(tokens) {
	const counts = new Map();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

const BM25_DOCUMENTS = Object.entries(ACTION_EXAMPLES).flatMap(([action, examples]) =>
	examples.map((text) => ({ action, text, tokens: tokenize(text) })));
const BM25_AVG_LENGTH = BM25_DOCUMENTS.reduce((sum, doc) => sum + doc.tokens.length, 0) / BM25_DOCUMENTS.length;
const BM25_DOC_FREQUENCY = (() => {
	const frequency = new Map();
	for (const doc of BM25_DOCUMENTS) {
		for (const token of new Set(doc.tokens)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
	}
	return frequency;
})();

function scoreDocument(queryTokens, document, k1 = 1.2, b = 0.75) {
	const frequencies = termFrequencies(document.tokens);
	let score = 0;
	for (const token of new Set(queryTokens)) {
		const tf = frequencies.get(token) ?? 0;
		if (!tf) continue;
		const df = BM25_DOC_FREQUENCY.get(token) ?? 0;
		const idf = Math.log(1 + (BM25_DOCUMENTS.length - df + 0.5) / (df + 0.5));
		const denominator = tf + k1 * (1 - b + b * (document.tokens.length / BM25_AVG_LENGTH));
		score += idf * ((tf * (k1 + 1)) / denominator);
	}
	return score;
}

/** Return normalized in-memory BM25 intent scores without any external I/O. */
export function scoreManualActionIntents(request) {
	const queryTokens = tokenize(cleanText(request, 4000));
	const scores = Object.fromEntries(MANUAL_ACTIONS.map((action) => [action, 0]));
	if (!queryTokens.length) return scores;
	for (const action of MANUAL_ACTIONS) {
		const raw = BM25_DOCUMENTS
			.filter((document) => document.action === action)
			.map((document) => scoreDocument(queryTokens, document))
			.sort((left, right) => right - left);
		// The best example carries authority; a second matching paraphrase adds a
		// small stability bonus without rewarding a class merely for having docs.
		const aggregate = (raw[0] ?? 0) + (raw[1] ?? 0) * 0.15;
		scores[action] = rounded(1 - Math.exp(-aggregate / 3.25));
	}
	return scores;
}

function normalizeVectorScores(value) {
	const output = Object.fromEntries(MANUAL_ACTIONS.map((action) => [action, 0]));
	if (Array.isArray(value)) {
		for (const item of value) {
			const action = String(item?.action ?? item?.chosen_action ?? "");
			if (ACTION_SET.has(action)) output[action] = Math.max(output[action], clampScore(item?.score ?? item?.confidence));
		}
		return output;
	}
	if (value && typeof value === "object") {
		for (const action of MANUAL_ACTIONS) output[action] = clampScore(value[action]);
	}
	return output;
}

async function getVectorScores(input, options, safePayload) {
	const supplied = options.vectorIntentScores ?? options.vectorScores;
	if (supplied !== undefined) return { scores: normalizeVectorScores(supplied), used: true, warning: null };
	const hook = options.getVectorIntentScores ?? options.vectorIntent;
	if (typeof hook !== "function") return { scores: normalizeVectorScores(null), used: false, warning: null };
	try {
		const response = await hook({
			request: input.request,
			message_count: input.messages.length,
			actions: [...MANUAL_ACTIONS],
			bm25_scores: safePayload.bm25_scores,
		});
		return { scores: normalizeVectorScores(response), used: true, warning: null };
	} catch {
		return { scores: normalizeVectorScores(null), used: false, warning: "vector_intent_unavailable" };
	}
}

function rankedScores(bm25Scores, vector) {
	const entries = MANUAL_ACTIONS.map((action) => {
		const bm25 = clampScore(bm25Scores[action]);
		const vectorScore = clampScore(vector.scores[action]);
		const combined = vector.used ? (bm25 * 0.65 + vectorScore * 0.35) : bm25;
		return { action, bm25, vector: vectorScore, combined: rounded(combined) };
	});
	return entries.sort((left, right) =>
		right.combined - left.combined ||
		MANUAL_ACTIONS.indexOf(left.action) - MANUAL_ACTIONS.indexOf(right.action));
}

function lexicalDecision(ranked, vectorUsed) {
	const best = ranked[0];
	const second = ranked[1];
	const margin = best.combined - (second?.combined ?? 0);
	const vectorStrong = vectorUsed && best.vector >= 0.88 && best.vector - (second?.vector ?? 0) >= 0.12;
	const lexicalStrong = best.combined >= 0.52 && margin >= 0.1;
	if (!lexicalStrong && !vectorStrong) return null;
	return {
		action: best.action,
		confidence: vectorStrong ? Math.max(best.combined, best.vector * 0.96) : best.combined,
		reasons: unique([
			best.bm25 > 0 ? "bm25_intent_match" : null,
			vectorStrong ? "vector_intent_match" : null,
		]),
	};
}

function safeMessageExcerpt(message) {
	return {
		role: message.role,
		content: cleanText(message.content, 360),
	};
}

/** Build the bounded, identifier-free payload that an optional router LLM sees. */
export function buildManualActionModelPayload(input = {}, bm25Scores = {}, vectorScores = {}) {
	const messages = normalizedMessages(input.messages);
	const scope = plainScope(input.contentScope);
	return {
		request: cleanText(input.request, 1200),
		message_shape: {
			count: messages.length,
			user_count: messages.filter((message) => message.role === "user").length,
			assistant_count: messages.filter((message) => message.role === "assistant").length,
		},
		message_excerpts: messages.slice(-8).map(safeMessageExcerpt),
		recent_context_present: Boolean(cleanText(input.recentContext)),
		requested_subject: scope.subject,
		bm25_scores: Object.fromEntries(MANUAL_ACTIONS.map((action) => [action, rounded(bm25Scores[action])])),
		vector_scores: Object.fromEntries(MANUAL_ACTIONS.map((action) => [action, rounded(vectorScores[action])])),
		available_actions: [...MANUAL_ACTIONS],
	};
}

function normalizeLlmDecision(value) {
	const parsed = typeof value === "string" ? extractJson(value) : value;
	const action = String(parsed?.chosen_action ?? parsed?.action ?? "");
	if (!ACTION_SET.has(action)) return null;
	return {
		action,
		confidence: clampScore(parsed?.confidence),
		reasons: unique((Array.isArray(parsed?.reason_codes) ? parsed.reason_codes : [])
			.slice(0, 12)
			.map((reason) => cleanText(reason, 64))
			.filter(Boolean)),
	};
}

async function callRouterModel(options, payload) {
	if (options.llmResponse !== undefined) return normalizeLlmDecision(options.llmResponse);
	if (typeof options.callLlm === "function") {
		try {
			return normalizeLlmDecision(await options.callLlm(payload));
		} catch {
			return null;
		}
	}
	const env = options.env ?? {};
	const config = options.config ?? {};
	const model = config?.llm?.summaryModel ?? config?.llm?.model;
	if (!env.AI || !model) return null;
	const configuredMaxTokens = Number(config?.llm?.summaryMaxTokens ?? 256);
	const maxTokens = Number.isFinite(configuredMaxTokens)
		? Math.max(64, Math.min(configuredMaxTokens, 384))
		: 256;
	try {
		const response = await env.AI.run(
			model,
			{
				messages: [
					{ role: "system", content: ROUTER_SYSTEM_PROMPT },
					{ role: "user", content: JSON.stringify(payload) },
				],
				temperature: 0,
				max_tokens: maxTokens,
			},
			config?.llm?.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		return normalizeLlmDecision(responseText(response));
	} catch {
		return null;
	}
}

function normalizedInput(raw = {}) {
	return {
		...raw,
		request: cleanText(raw.request ?? raw.command ?? raw.text, 4000),
		content: cleanText(raw.content, 8000),
		recentContext: cleanText(raw.recentContext, 8000),
		messages: normalizedMessages(raw.messages),
	};
}

function scopeResolution(input) {
	const scopeMessages = [...input.messages];
	const requestDefinesScope = CONVERSATION_CUE_RE.test(input.request) ||
		/\b(?:save|remember|store|keep)\b.{0,80}\bonly\b.{0,80}\b(?:about|regarding|concerning)\b/i.test(input.request);
	if (input.request && requestDefinesScope) scopeMessages.push({ role: "user", content: input.request });
	return resolveManualConversationScope(scopeMessages, input.contentScope ?? {});
}

function commonToolMetadata(input) {
	const output = {};
	copyMetadata(output, input, ["conversationId", "threadId", "sourceId", "idempotencyKey"]);
	if (input.memoryScope && typeof input.memoryScope === "object" && !Array.isArray(input.memoryScope)) {
		output.memoryScope = { ...input.memoryScope };
	}
	return output;
}

function buildToolArguments(action, input, scope) {
	const common = commonToolMetadata(input);
	if (action === "save_memory") {
		const content = cleanText(input.content) || directContentFromRequest(input.request);
		return {
			content,
			...(input.recentContext ? { recentContext: input.recentContext } : {}),
			...common,
		};
	}
	if (action === "save_conversation") {
		const output = {
			messages: input.messages,
			contentScope: scope,
			...common,
		};
		copyMetadata(output, input, ["scope", "n", "topic"]);
		return output;
	}
	if (action === "recall_memory") {
		const query = cleanText(input.query) || input.request;
		return {
			query,
			...common,
			...(input.topic !== undefined && input.topic !== null ? { topic: input.topic } : {}),
		};
	}
	return {};
}

function validationFailure(reasons, scope) {
	return {
		chosen_action: "clarify",
		confidence: 1,
		reason_codes: unique(reasons),
		scope,
		tool_arguments: {},
	};
}

function validateDecision(decision, input, resolution, warnings = []) {
	const action = ACTION_SET.has(decision?.action) ? decision.action : "clarify";
	const reasons = unique([...(decision?.reasons ?? []), ...warnings]);
	const scope = resolution.scope;

	if (action === "save_memory") {
		if (!hasExplicitSaveIntent(input.request) && !hasExplicitMemoryOperation(input.request)) {
			return validationFailure([...reasons, "missing_explicit_save_intent"], scope);
		}
		const content = cleanText(input.content) || directContentFromRequest(input.request);
		if (!hasUsableDirectContent(content, input.recentContext)) {
			return validationFailure([...reasons, "missing_direct_content"], scope);
		}
	}
	if (action === "save_conversation") {
		if (!hasExplicitSaveIntent(input.request) && !hasExplicitMemoryOperation(input.request)) {
			return validationFailure([...reasons, "missing_explicit_save_intent"], scope);
		}
		if (!resolution.valid) {
			return validationFailure([
				...reasons,
				...resolution.conflicts.map((conflict) => conflict.code),
			], scope);
		}
		if (!input.messages.some((message) => message.role === "user" && message.content)) {
			return validationFailure([...reasons, "missing_conversation_messages"], scope);
		}
	}
	if (action === "recall_memory") {
		if (!hasExplicitRecallIntent(input.request) && !hasExplicitMemoryOperation(input.request) && !cleanText(input.query)) {
			return validationFailure([...reasons, "missing_explicit_recall_intent"], scope);
		}
		if (!hasUsableRecallQuery(input, input.request)) {
			return validationFailure([...reasons, "missing_recall_query"], scope);
		}
	}

	return {
		chosen_action: action,
		confidence: rounded(decision?.confidence),
		reason_codes: reasons,
		scope,
		tool_arguments: TOOL_ACTIONS.has(action) ? buildToolArguments(action, input, scope) : {},
	};
}

/**
 * Select a manual MCP action using deterministic policy, BM25, an optional
 * caller-supplied vector signal, and (only if still unresolved) an optional LLM.
 */
export async function routeManualAction(rawInput = {}, options = {}) {
	const input = normalizedInput(rawInput);
	const resolution = scopeResolution(input);
	const deterministic = deterministicDecision(input);
	if (deterministic) return validateDecision(deterministic, input, resolution, resolution.warnings);

	const bm25Scores = scoreManualActionIntents(input.request);
	const preVectorPayload = { bm25_scores: bm25Scores };
	const vector = await getVectorScores(input, options, preVectorPayload);
	const ranked = rankedScores(bm25Scores, vector);
	const lexical = lexicalDecision(ranked, vector.used);
	if (lexical) {
		return validateDecision(lexical, input, resolution, unique([
			...resolution.warnings,
			vector.warning,
		]));
	}

	const modelPayload = buildManualActionModelPayload(input, bm25Scores, vector.scores);
	const model = await callRouterModel(options, modelPayload);
	if (model) {
		if (TOOL_ACTIONS.has(model.action) && model.confidence < 0.8) {
			return validateDecision({
				action: "clarify",
				confidence: Math.max(0.8, model.confidence),
				reasons: unique(["llm_fallback", "llm_low_confidence", ...model.reasons]),
			}, input, resolution, unique([...resolution.warnings, vector.warning]));
		}
		return validateDecision({
			...model,
			reasons: unique(["llm_fallback", ...model.reasons]),
		}, input, resolution, unique([...resolution.warnings, vector.warning]));
	}

	const fallback = requestHasMemorySignal(input.request)
		? { action: "clarify", confidence: 0.8, reasons: ["ambiguous_memory_intent"] }
		: { action: "no_action", confidence: 0.9, reasons: ["no_memory_intent"] };
	return validateDecision(fallback, input, resolution, unique([...resolution.warnings, vector.warning]));
}

// Stable aliases for the endpoint adapter and hosts that prefer command-style
// naming. Both preserve the same pure input/options boundary.
export const chooseManualAction = routeManualAction;

export async function runManualActionRouter(env, config, input = {}, overrides = {}) {
	return routeManualAction(input, { ...overrides, env, config });
}
