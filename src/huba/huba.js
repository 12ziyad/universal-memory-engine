/**
 * Huba — Itsuki's in-product assistant.
 *
 * The pipeline, per message:
 *
 *     route  ->  fetch  ->  ground  ->  answer
 *      |          |           |           |
 *      |          |           |           one metered model call (scope huba_chat)
 *      |          |           documentation sections + this account's live data
 *      |          at most 3 read-only, session-scoped fetchers (fetchers.js)
 *      deterministic term routing plus the tab the person is on
 *
 * Three rules it exists under:
 *
 *   1. It answers from Itsuki, never from model knowledge. Sections come from
 *      the real documentation; account facts come from the real database.
 *   2. It never narrates its own machinery. An earlier version told a user
 *      "the docs don't mention a TypeScript SDK" — the SDK exists, retrieval
 *      had simply missed the page. Retrieval is fixed (see retrieval.js) and
 *      the voice rules below forbid that class of sentence outright: talking
 *      about "the docs" makes the product's seams the user's problem.
 *   3. It cannot see another account. Every fetcher runs on the identity
 *      resolved from the session cookie, server-side.
 */

import { runAi, withFlushedAiMeter } from "../lib/ai_meter.js";
import { responseText } from "../pipeline/llm.js";
import { retrieve, pageIndex } from "./retrieval.js";
import { routeFetchers, runFetchers } from "./fetchers.js";

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 900;

const SYSTEM_PROMPT = `You are Huba, the assistant built into Itsuki (itsuki.app) — a memory service that gives AI tools a shared, persistent memory.

You are talking to a signed-in Itsuki user inside their own dashboard.

HOW TO ANSWER
- Use REFERENCE and ACCOUNT below as your knowledge of Itsuki. They are excerpts of Itsuki's own material and live readings from this person's account.
- Answer the question directly, in the first sentence. Then the detail.
- Be specific and concrete: real endpoint names, real commands, real numbers from ACCOUNT.
- Plain, calm, technical. Short sentences. No marketing, no exclamation marks, never the word "simply".
- Under 160 words unless they asked for depth. Commands and code go in fenced blocks.
- Point people at pages by their NAME as it appears in the dashboard or documentation ("the Usage & plan page", "Quickstart"), like a colleague would.

NEVER DO THIS
- Never mention documentation, sources, context, excerpts, retrieval, readings, or what you were "provided" or "given". Never name the sections above (REFERENCE, ACCOUNT) or call anything "the provided data", "the system", or "the metadata". The person cannot see any of that and does not care. Sentences like "the docs don't mention X", "based on the provided context", "the ACCOUNT data does not include" are forbidden — speak as Itsuki itself, in the first person: "I don't have that", "you have 196 saves left".
- Never say a feature does not exist. If you cannot see how something works, say what you DO know and name the page that covers it — never declare the thing missing.
- Never invent an endpoint, parameter, limit, price, or product name. If a specific detail is not in front of you, give the part you are sure of and point to where the rest lives.
- Never speculate about other users, other accounts, or data you cannot see. ACCOUNT is this person's own.
- Never claim to have taken an action. You can read this account; you cannot change it. Tell them where to click instead.
- Never quote internal field or variable names at the person (jobs.failures, recent_by_status, saves_today.neurons_used). Translate them into plain words: "nothing has failed", "five saves finished", "you have about 196 saves left today".
- Never call anything "a section" or say "as detailed in"/"as described in"/"see the X section". Headings above are internal. Refer to a place the person can actually go: a documentation page by its name ("the JavaScript SDK page"), or a dashboard tab ("the Usage & plan page").`;

/**
 * Context budgets. The deterministic model-input boundary (see
 * src/lib/model_input.js) hard-caps a fixed prompt at 24,576 bytes and BLOCKS
 * the call rather than silently truncating it — a good rail, and one this
 * assembly must live inside. These numbers leave headroom for the system
 * prompt, the conversation so far, and the question itself.
 */
const REFERENCE_BUDGET = 10_500;
const ACCOUNT_BUDGET = 3_800;

const TAB_MAP = "Itsuki's dashboard tabs: Get started, Playground, API Keys, Dashboard, Memories, Graph, Requests, Webhooks, Memory exports, History, Usage & plan (profile menu, top right), Settings, and Admin for operators.";

/**
 * Orientation. The full page index is worth ~2.5 KB, so it is spent only when
 * retrieval came back empty and knowing what exists is the whole answer.
 */
function orientation(hasReference) {
	return hasReference ? TAB_MAP : `${TAB_MAP}\nPages that exist:\n${pageIndex()}`;
}

function renderReference(chunks) {
	if (!chunks.length) return "(no specific section matched — answer from Itsuki's shape below and name the page that covers it)";
	return chunks
		.map((chunk) => `## ${chunk.title} — ${chunk.heading}\n${chunk.text}`)
		.join("\n\n");
}

function renderAccount(data, extras) {
	const payload = { ...extras, ...data };
	if (!Object.keys(payload).length) return "(no account readings were needed for this question)";
	const text = JSON.stringify(payload, null, 1);
	return text.length > ACCOUNT_BUDGET ? `${text.slice(0, ACCOUNT_BUDGET)}…(truncated)` : text;
}

export async function hubaTurn(env, identity, input = {}, { quota = null } = {}) {
	const question = String(input.message ?? "").trim().slice(0, MAX_QUESTION_CHARS);
	if (!question) return { ok: false, reason: "empty", message: "Ask me something about Itsuki." };
	if (!env.AI) {
		return { ok: false, reason: "unavailable", message: "I can't reach the model right now. Try again in a minute." };
	}

	// 1. ROUTE + FETCH — outside the chat meter, so the account's own recall
	// keeps its `recall` attribution (and stays unquota'd) instead of being
	// folded into this turn's chat spend.
	const view = typeof input.view === "string" ? input.view.slice(0, 24) : null;
	const fetcherIds = routeFetchers(question, { view, isAdmin: identity.isAdmin === true });
	const account = await runFetchers(env, identity, fetcherIds, { question });

	// 2. GROUND
	const { chunks, routes } = retrieve(question, { budget: REFERENCE_BUDGET });
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "system", content: `REFERENCE\n${renderReference(chunks)}` },
		{
			role: "system",
			content: `ACCOUNT (this signed-in person's own live readings)\n${renderAccount(account, {
				...(quota ? { quota } : {}),
				...(view ? { currently_viewing: view } : {}),
			})}\n\nABOUT ITSUKI\n${orientation(chunks.length > 0)}`,
		},
		...(Array.isArray(input.history) ? input.history : [])
			.slice(-MAX_HISTORY_TURNS)
			.filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
			.map((message) => ({ role: message.role, content: message.content.slice(0, MAX_HISTORY_CHARS) })),
		{ role: "user", content: question },
	];

	// 3. ANSWER
	const model = env.HUBA_MODEL || env.LLM_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8";
	return withFlushedAiMeter(env, "huba_chat", {
		userId: identity.userId,
		scopeId: `huba_${crypto.randomUUID()}`,
		lifecycle: { accountUserId: identity.accountUserId ?? identity.userId },
	}, async () => {
		try {
			const response = await runAi(env, model, {
				messages,
				temperature: 0.2,
				max_tokens: Number(env.HUBA_MAX_TOKENS ?? 1024),
			}, undefined, { task: "huba_chat", capability: "chat" });
			const reply = scrubMechanismTalk(String(responseText(response) ?? "").trim());
			if (!reply) {
				return { ok: false, reason: "empty_reply", message: "I couldn't put that together — try asking it a different way." };
			}
			return { ok: true, reply, consulted: routes.slice(0, 4), fetched: fetcherIds };
		} catch (error) {
			console.warn("huba chat model failed:", error?.message ?? error);
			return { ok: false, reason: "model_error", message: "I couldn't reach the model just now. Give it a minute and ask again." };
		}
	});
}

/**
 * Last line of defence for rule 2. A model that slips into "the documentation
 * does not mention…" is describing our retrieval to a user who never asked
 * about it, so those openings are rewritten rather than shipped. Prompt rules
 * hold almost always; this catches the almost.
 */
export function scrubMechanismTalk(reply) {
	// Formatting marks first: the model likes to write `ACCOUNT` or **the
	// docs**, and a word-boundary match against the raw string sails straight
	// past the backticks. Strip the emphasis around the machinery vocabulary
	// (and only there) so the rules below actually see it.
	let text = String(reply).replace(/[`*_]{1,2}(ACCOUNT|REFERENCE|docs|documentation|context)[`*_]{1,2}/gi, "$1");

	// Internal field names, rewritten to what a person would say. The prompt
	// forbids quoting them; this is what catches the times it does anyway.
	// Narrow and explicit — a blanket snake_case rule would also eat the real
	// API field names people legitimately ask about (saved_total, scope_json).
	const INTERNAL_KEYS = {
		recent_by_status: "recent jobs", edges_by_type: "edge types", saves_today: "today's saves",
		huba_messages_today: "today's questions", most_recent_memories: "your most recent memories",
		recalled_text: "what I found", nothing_matched: "no match", approx_saves_left: "saves left",
		neurons_used: "neurons used", neurons_limit: "the daily limit", this_month: "this month",
		custom_limits_granted: "a custom limit", recall_is_metered: "recall metering",
		"jobs.failures": "failed saves", memory_search: "a search of your memories",
	};
	for (const [key, plain] of Object.entries(INTERNAL_KEYS)) {
		text = text.replace(new RegExp(`[\`*]{0,2}${key.replace(".", "\\.")}[\`*]{0,2}`, "g"), plain);
	}

	// The vocabulary of the machinery: every word that, said out loud, tells
	// the reader about our retrieval instead of answering their question.
	const M = "docs|documentation|reference|context|excerpts?|sources?|account data|ACCOUNT|REFERENCE|readings?|metadata|provided data|the system";
	const rewrites = [
		[new RegExp(`\\b(the |these |provided |available )?(${M})\\s+(do(es)? not|don'?t|doesn'?t)\\s+(mention|include|contain|cover|specify|describe|provide|have|show|store|list)\\b[^.!?\\n]*[.!?]?`, "gi"), ""],
		[new RegExp(`\\bno\\s+\\w*\\s*(details?|information|mention|reference|content)\\s+(is|are)\\s+(in|available in|provided in|found in|shown in)\\s+(the\\s+)?(provided\\s+)?(${M})\\b[^.!?\\n]*[.!?]?`, "gi"), ""],
		[new RegExp(`\\b(based on|according to|from|per)\\s+(the\\s+)?(provided\\s+)?(${M}|information (provided|given))\\b[,:]?\\s*`, "gi"), ""],
		[new RegExp(`\\b(is|are) not (mentioned|documented|covered|specified|included|available|visible|stored) (in|anywhere in|here in) (the\\s+)?(${M})\\b[^.!?\\n]*[.!?]?`, "gi"), ""],
		[new RegExp(`\\bthe (${M})\\s+(says?|states?|shows?|notes?|indicates?)\\b`, "gi"), "Itsuki"],
		[new RegExp(`\\bin the (provided |available |given )?(${M})\\b`, "gi"), ""],
		// Affirmative references too — "the current ACCOUNT data shows…" names
		// the machinery just as plainly as a denial does.
		[/\b(the\s+)?(current\s+|provided\s+|available\s+)?(ACCOUNT|REFERENCE)(\s+data)?\b/g, "what I can see"],
		[new RegExp(`\\bit (is|'s) not (visible|available|shown|included) here\\b[^.!?\\n]*[.!?]?`, "gi"), ""],
		// "see the **X** section" / "as detailed in the X section": the reader
		// cannot open a section, only a page. Keep the name, drop the framing.
		// Both rules REQUIRE the word "section" to follow — an earlier version
		// rewrote every "shown in" and turned "no relationships shown in edge
		// types" into "no relationships see edge types".
		[/\b(as\s+)?(detailed|described|explained|shown|outlined|covered)\s+(in|under)\s+(the\s+)?([^.!?\n]{0,60}?)\s+sections?\b/gi, "on the $5 page"],
		[/\bsee\s+(the\s+)?([^.!?\n]{0,60}?)\s+sections?\b/gi, "see the $2 page"],
		[/\s+sections?\b/gi, " page"],
		// A markdown link the renderer does not render, and whose target the
		// model invented anyway — keep the words, drop the dead link.
		[/\[([^\]\n]+)\]\((?:#|https?:\/\/[^)\s]*)?\)/g, "$1"],
	];
	for (const [pattern, replacement] of rewrites) text = text.replace(pattern, replacement);
	return text
		// A removal mid-sentence leaves orphaned punctuation and double spaces
		// ("see the X page ." was the observed shape), so tidy after rewriting.
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/([.,;:])\1+/g, "$1")
		.replace(/\(\s*\)/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*$/, "").trimEnd())
		.join("\n")
		.trim()
		// A rewrite at the head of a sentence can leave it lowercase.
		.replace(/^([a-z])/, (letter) => letter.toUpperCase());
}

export { retrieve } from "./retrieval.js";
