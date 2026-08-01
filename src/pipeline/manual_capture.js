/**
 * Whole-conversation capture — the "save everything from this chat" lane.
 *
 * The strict collect lane stores only durable personal facts, so a lesson or
 * work chat used to come back "Saved: 0 — no eligible conversation claims."
 * Capture is the second lane: when the user explicitly asks for the WHOLE chat,
 * the conversation (user AND assistant turns) is condensed into grounded note
 * lines and stored as an organized notes page through the deterministic page
 * renderer. Notes are page-only: the graph still learns exclusively from the
 * strict fact lane, and a bare "save everything" with no content still writes
 * nothing because no note line survives grounding.
 */

import { responseText } from "./llm.js";
import { rulesAllowText, rulesPromptLines } from "./rules.js";
import { classifyMessage } from "./trigger.js";
import { runAi } from "../lib/ai_meter.js";

// An explicit whole-chat save: the object of the save verb is the chat itself
// ("everything", "this chat", "the whole conversation"), not a topic's details.
const CAPTURE_DIRECTIVE_RE = new RegExp(
	"\\b(?:save|store|keep|record|collect|remember|memorize|memorise)\\b" +
	"[^.!?\\n]{0,80}?" +
	"\\b(?:everything|everithing|everthing|everythin|all\\s+of\\s+(?:this|it)|" +
	"(?:whole|entire|full)\\s+(?:chat|cht|chst|conversation|convo|thread|transcript|discussion)|" +
	"(?:this|the)\\s+(?:chat|cht|chst|conversation|convo|thread|transcript|discussion))(?![\\p{L}\\p{N}])",
	"iu",
);

// A line that IS a save instruction (used to keep the directive itself out of
// the notes; real content mentioning "save" mid-sentence is unaffected).
const SAVE_DIRECTIVE_LINE_RE = new RegExp(
	"^\\s*(?:(?:bro|dude|man|bruh|buddy|mate|hey|yo|ok|okay|please|hi|hello)\\b[\\s,]*)*" +
	"(?:(?:can|could|would|will)\\s+you\\s+)?(?:please\\s+)?" +
	"(?:save|saves|saved|remember|memorize|memorise|store|collect|keep|record)\\b",
	"i",
);

const NOTE_STOP_WORDS = new Set([
	"a", "about", "also", "am", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
	"can", "could", "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "hers",
	"him", "his", "i", "if", "in", "into", "is", "it", "its", "just", "like", "me", "my", "of", "on",
	"or", "our", "ours", "she", "so", "some", "than", "that", "the", "their", "theirs", "them",
	"then", "there", "these", "they", "this", "those", "to", "was", "we", "were", "what", "when",
	"which", "will", "with", "would", "you", "your", "yours",
]);

const NOTES_SYSTEM = `You turn a chat into clean, self-contained NOTE lines for the user's memory notebook.
Output ONE note per line, plain text only — no bullets, no numbering, no headings, no commentary.
CAPTURE the substance of the conversation: topics explained, definitions, key facts, steps, decisions, progress updates, plans, and conclusions — including material the assistant taught or produced, rewritten as short neutral notes.
Write every line so it stands alone ("Unit 3 covers photosynthesis and respiration", never "he said it covers that").
DROP greetings, chit-chat, save/remember instructions, questions nobody answered, and formatting noise.
If the chat has no substance at all, output nothing.`;

function cleanLine(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function noteTokens(value) {
	const tokens = String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.match(/[\p{L}\p{N}][\p{L}\p{N}+#.\-]*/gu) ?? [];
	return [...new Set(tokens
		.map((token) => token.replace(/[^\p{L}\p{N}]+$/gu, ""))
		.filter((token) => token.length > 1 && !NOTE_STOP_WORDS.has(token)))];
}

/**
 * A note line must be substantially supported by ONE conversation turn —
 * relaxed (notes rephrase content) but single-source, so a fabricated line
 * that splices vocabulary across turns is still dropped.
 */
function noteLineGrounded(line, sourceTokenSets) {
	const tokens = noteTokens(line);
	if (tokens.length < 2) return false;
	for (const source of sourceTokenSets) {
		const shared = tokens.filter((token) => source.has(token)).length;
		if (shared >= 2 && shared / tokens.length >= 0.6) return true;
	}
	return false;
}

function sameNoteLine(left, right) {
	const a = noteTokens(left);
	const b = new Set(noteTokens(right));
	if (!a.length || !b.size) return false;
	const shared = a.filter((token) => b.has(token)).length;
	return shared / Math.max(a.length, b.size) >= 0.85;
}

function isDirectiveLine(line) {
	return SAVE_DIRECTIVE_LINE_RE.test(line) && CAPTURE_DIRECTIVE_RE.test(line);
}

/** True when a user turn explicitly asks to save the whole conversation. */
export function detectConversationCapture(messages = []) {
	return (messages ?? []).some((message) =>
		(message?.role ?? "user") === "user" && CAPTURE_DIRECTIVE_RE.test(String(message?.content ?? "")));
}

// "save more about this chat" parses "this chat" as a topic; for capture that
// is a chat referent, not a content filter, and must never empty the notes.
const CHAT_REFERENT_TOPIC_RE = new RegExp(
	"^(?:(?:this|that|the|our|whole|entire|full)\\s+)*" +
	"(?:chat|cht|chst|conversation|convo|thread|transcript|discussion|everything|everithing|everthing|everythin|all|it|memory|memories|uml|graph|notes?)" +
	"(?:\\s+(?:please|now|again|too))*\\s*$",
	"i",
);

export function isChatReferentTopic(value) {
	return CHAT_REFERENT_TOPIC_RE.test(String(value ?? "").trim());
}

async function llmNotes(env, config, turns, rules = null) {
	if (!env.AI) return "";
	const payload = turns
		.slice(-40)
		.map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${cleanLine(turn.content).slice(0, 600)}`)
		.join("\n");
	const ruleLines = rulesPromptLines(rules);
	const system = ruleLines.length ? `${NOTES_SYSTEM}\n${ruleLines.join("\n")}` : NOTES_SYSTEM;
	try {
		const res = await runAi(
			env,
			config.llm.digestModel,
			{
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: payload },
				],
				temperature: 0,
				max_tokens: config.llm.digestMaxTokens,
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		return responseText(res).trim();
	} catch (err) {
		console.warn("capture notes llm failed:", err?.message ?? err);
		return "";
	}
}

function fallbackLines(turns) {
	const lines = [];
	for (const turn of turns) {
		const content = cleanLine(turn.content);
		if (!content || isDirectiveLine(content)) continue;
		if (["noise", "utility"].includes(classifyMessage(content))) continue;
		lines.push(content);
	}
	return lines;
}

/**
 * Condense the scoped conversation into grounded note lines.
 * Deterministic in tests via `opts.notesResponse` ("" forces the fallback).
 *
 * @returns {Promise<{ digest: string, lines: string[] }>}
 */
export async function buildConversationCapture(env, config, messages, opts = {}) {
	const turns = (messages ?? []).filter((message) =>
		["user", "assistant"].includes(message?.role ?? "user") && cleanLine(message?.content));
	if (!turns.length) return { digest: "", lines: [] };
	const sourceTokenSets = turns.map((turn) => new Set(noteTokens(turn.content)));

	let raw;
	if (opts.notesResponse !== undefined && opts.notesResponse !== null) {
		raw = String(opts.notesResponse);
	} else {
		raw = await llmNotes(env, config, turns, opts.rules ?? null);
	}
	let candidates = String(raw ?? "")
		.split(/\n+/)
		.map((line) => cleanLine(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")))
		.filter(Boolean);
	if (!candidates.length) candidates = fallbackLines(turns);

	const lines = [];
	for (const line of candidates) {
		if (lines.length >= 24) break;
		if (isDirectiveLine(line)) continue;
		if (["noise", "utility"].includes(classifyMessage(line))) continue;
		if (!noteLineGrounded(line, sourceTokenSets)) continue;
		if (!rulesAllowText(opts.rules ?? null, line)) continue;
		if (lines.some((existing) => sameNoteLine(existing, line))) continue;
		lines.push(line.slice(0, 300));
	}
	return { digest: lines.join("\n"), lines };
}
