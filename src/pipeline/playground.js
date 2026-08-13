/**
 * The Playground door.
 *
 * A real conversation, in the app, that shows memory being captured while it
 * happens. It is a DOOR, not an engine: the reply comes from a chat model and
 * everything memory-related goes through the same two commands every other
 * door uses — runRecallCommand to look things up, runObserveMessagesCommand to
 * capture. There is no second extraction path here and there must never be one.
 *
 * Two limits live here, both env-tunable:
 *   - PLAYGROUND_MAX_THREADS (5): how many conversations one account keeps.
 *   - PLAYGROUND_DAILY_MESSAGES (30): per user, per UTC day. Without it, a
 *     public playground is a free LLM for anyone who signs up, billed to us.
 * Hitting either is a normal state with a friendly sentence, never an error.
 */

import { getConfig } from "../config.js";
import { newId } from "../lib/ids.js";
import { responseText } from "./llm.js";
import { runObserveMessagesCommand, runRecallCommand } from "./commands.js";
import { getMemoryRules, rulesRejection } from "./rules.js";
import { threadRulesFrom } from "./playground_settings.js";
import { runAi } from "../lib/ai_meter.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_TURNS = 12;
const MAX_MESSAGE_CHARS = 4000;

export function playgroundLimits(env) {
	const threads = Number(env.PLAYGROUND_MAX_THREADS ?? 5);
	const daily = Number(env.PLAYGROUND_DAILY_MESSAGES ?? 30);
	return {
		maxThreads: Number.isFinite(threads) && threads > 0 ? Math.floor(threads) : 5,
		dailyMessages: Number.isFinite(daily) && daily > 0 ? Math.floor(daily) : 30,
	};
}

/**
 * Chat model. Deliberately NOT config.llm.model: that one is tuned for
 * extraction, and swapping it would change what the product captures.
 *
 * The smallest instruct model in the catalogue is the right default. This
 * model's only job is to reply conversationally so the extractor has something
 * to work with — the capture is the product, the reply is scenery.
 */
export function chatModel(env) {
	return env.CHAT_MODEL || "@cf/meta/llama-3.2-1b-instruct";
}

function startOfUtcDay(now = Date.now()) {
	return Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate(),
	);
}

export async function countMessagesToday(env, userId, now = Date.now()) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM playground_messages WHERE user_id = ? AND role = 'user' AND created_at >= ?",
	).bind(userId, startOfUtcDay(now)).first();
	return Number(row?.n ?? 0);
}

export async function listThreads(env, userId) {
	const { results } = await env.DB.prepare(
		`SELECT t.id, t.title, t.created_at, t.updated_at,
			(SELECT COUNT(*) FROM playground_messages m WHERE m.thread_id = t.id) AS message_count
		 FROM playground_threads t WHERE t.user_id = ? ORDER BY t.updated_at DESC`,
	).bind(userId).all();
	return results ?? [];
}

export async function getThread(env, userId, threadId) {
	if (!threadId) return null;
	return env.DB.prepare("SELECT * FROM playground_threads WHERE id = ? AND user_id = ?")
		.bind(threadId, userId).first();
}

export async function getThreadMessages(env, userId, threadId, limit = 200) {
	if (!threadId) return [];
	const { results } = await env.DB.prepare(
		`SELECT id, role, content, extraction_json, created_at FROM playground_messages
		 WHERE thread_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT ?`,
	).bind(threadId, userId, limit).all();
	return (results ?? []).map((row) => ({
		id: row.id,
		role: row.role,
		content: row.content,
		created_at: row.created_at,
		extraction: parseJson(row.extraction_json, null),
	}));
}

// Outcomes that mean extraction is finished, whatever it decided.
const TERMINAL_OUTCOMES = ["wrote", "meaningful_no_write", "llm_failed", "db_write_failed", "no_write"];

/**
 * Fold late receipts into the messages they came from.
 *
 * A turn waits a bounded time for its receipt and then returns regardless —
 * the model must never hold the response open. On a real extraction model that
 * bound is often hit, so the message is stored as "processing" and the finished
 * receipt lands seconds later. Without this the Memories panel would sit on
 * "Capturing…" forever, which is exactly what happened the first time this ran
 * against the live model instead of a stub.
 */
export async function reconcileExtractions(env, userId, messages) {
	const pending = messages.filter((m) => m.extraction?.processing && m.extraction.source_packet_id);
	if (!pending.length) return messages;

	const updates = [];
	for (const message of pending) {
		const receipt = await env.DB.prepare(
			`SELECT id, detail, outcome, saved_total FROM receipts
			 WHERE user_id = ? AND source_packet_id = ?
			   AND outcome IN (${TERMINAL_OUTCOMES.map(() => "?").join(",")})
			 ORDER BY created_at DESC LIMIT 1`,
		).bind(userId, message.extraction.source_packet_id, ...TERMINAL_OUTCOMES).first().catch(() => null);
		if (!receipt) continue;

		const detail = parseJson(receipt.detail, {});
		message.extraction = {
			...message.extraction,
			items: await extractionItems(env, userId, detail),
			summary: null,
			saved_total: Number(receipt.saved_total ?? 0),
			processing: false,
			receipt_id: receipt.id,
			at: message.extraction.at ?? message.created_at,
		};
		updates.push(env.DB.prepare("UPDATE playground_messages SET extraction_json = ? WHERE id = ? AND user_id = ?")
			.bind(JSON.stringify(message.extraction), message.id, userId));
	}
	if (updates.length) await env.DB.batch(updates).catch(() => {});
	return messages;
}

function parseJson(value, fallback) {
	try {
		const parsed = JSON.parse(value ?? "null");
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

/** Create a thread, or report the cap without creating one. */
export async function createThread(env, userId, title = "New chat") {
	const { maxThreads } = playgroundLimits(env);
	const threads = await listThreads(env, userId);
	if (threads.length >= maxThreads) {
		return {
			ok: false,
			capped: "threads",
			message: `You can keep ${maxThreads} chats here. Delete one to start another.`,
			threads,
		};
	}
	const now = Date.now();
	const id = newId("pgthread");
	await env.DB.prepare(
		"INSERT INTO playground_threads (id, user_id, title, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	).bind(id, userId, String(title).slice(0, 80), null, now, now).run();
	return { ok: true, thread: { id, title, created_at: now, updated_at: now, message_count: 0 } };
}

export async function deleteThread(env, userId, threadId) {
	if (!threadId) return { ok: false, message: "Pick a chat to delete." };
	await env.DB.batch([
		env.DB.prepare("DELETE FROM playground_messages WHERE thread_id = ? AND user_id = ?").bind(threadId, userId),
		env.DB.prepare("DELETE FROM playground_threads WHERE id = ? AND user_id = ?").bind(threadId, userId),
	]);
	return { ok: true, deleted: threadId };
}

async function storeMessage(env, userId, threadId, role, content, extraction = null) {
	const id = newId("pgmsg");
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO playground_messages (id, thread_id, user_id, role, content, extraction_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).bind(id, threadId, userId, role, content, extraction ? JSON.stringify(extraction) : null, now).run();
	return { id, role, content, created_at: now, extraction };
}

/**
 * What the pipeline actually wrote from this turn, in the person's own words.
 * The receipt records ids; the text lives on the rows, so read it back rather
 * than widening the persisted receipt shape for one screen.
 */
export async function extractionItems(env, userId, receipt) {
	const actions = receipt?.actions ?? {};
	const sliceIds = (actions.createdSlices ?? []).map((s) => s.id).filter(Boolean);
	const eventIds = (actions.createdEvents ?? []).map((e) => e.id).filter(Boolean);
	const items = [];

	if (sliceIds.length) {
		const { results } = await env.DB.prepare(
			`SELECT text FROM slices WHERE user_id = ? AND id IN (${sliceIds.map(() => "?").join(",")})`,
		).bind(userId, ...sliceIds).all();
		for (const row of results ?? []) if (row.text) items.push({ kind: "detail", text: row.text });
	}
	if (eventIds.length) {
		const { results } = await env.DB.prepare(
			`SELECT text, action FROM events WHERE user_id = ? AND id IN (${eventIds.map(() => "?").join(",")})`,
		).bind(userId, ...eventIds).all();
		for (const row of results ?? []) if (row.text) items.push({ kind: "event", text: row.text });
	}
	for (const node of actions.createdNodes ?? []) {
		if (node.label && !items.some((item) => item.text === node.label)) {
			items.push({ kind: "memory", text: node.label });
		}
	}
	return items;
}

const CHAT_SYSTEM = `You are the assistant inside the Itsuki playground. Itsuki is this person's private memory, shared by every AI they connect.

Answer naturally and briefly — two or three sentences unless they ask for more.
Use what Itsuki already knows when it is relevant, and say so plainly.
Never claim you saved, stored, or remembered something: Itsuki captures memory itself and shows the person the receipt. Do not describe your own memory.`;

function buildChatMessages(history, message, context) {
	const system = context
		? `${CHAT_SYSTEM}\n\nWhat Itsuki already knows about this person:\n${context}`
		: `${CHAT_SYSTEM}\n\nItsuki has nothing stored about this person yet.`;
	return [
		{ role: "system", content: system },
		...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
		{ role: "user", content: message },
	];
}

const REPLY_FALLBACK = "I could not think of a reply just then. Your message was still read for memory — try sending it again.";

/**
 * Preview extraction: what Itsuki WOULD take from a sentence, without taking it.
 *
 * The preview examples are scripted, so a typed sentence used to fall through
 * to a canned apology with no entities and no graph movement — which reads as
 * the product not working rather than as the example running out of script.
 *
 * This runs one real model call and persists NOTHING: no source packet, no
 * episode, no node, no receipt. It is the honest way to answer "what would you
 * remember from this?" inside a world that is explicitly read-only. The rules
 * filter runs first, so a preview cannot show a fact the account's own policy
 * would have refused.
 */
const PREVIEW_SYSTEM = `You read one sentence and say what is worth remembering long term.

Answer in plain lines, nothing else, in this exact format:
REPLY: one or two warm sentences about what they said
FACT: a short third-person statement that will still be true next month
ENTITY: name | kind

Use at most 3 FACT lines and 3 ENTITY lines, and omit them entirely if the
sentence holds nothing durable. kind is one word: person, place, project,
decision, preference, event, organization. Never invent anything not stated.`;

/**
 * Line output, not JSON.
 *
 * The small instruct model this runs on is fast and warm but unreliable at
 * emitting a closed JSON object — it truncates mid-string, and a half-written
 * object parses to nothing at all. Line prefixes degrade instead: a truncated
 * response loses its last line and keeps every complete one before it.
 */
function parsePreviewLines(raw) {
	const reply = [];
	const facts = [];
	const entities = [];
	for (const line of String(raw ?? "").split(/\r?\n/)) {
		const text = line.trim();
		const value = text.replace(/^[A-Z]+:\s*/, "").trim();
		if (!value) continue;
		if (/^REPLY:/i.test(text)) reply.push(value);
		else if (/^FACT:/i.test(text) && facts.length < 3) facts.push(value.slice(0, 200));
		// The model frequently drops the prefix and emits the bare `name | kind`
		// shape instead. Accepting both is the difference between reading what it
		// produced and throwing it away for a formatting slip.
		else if ((/^ENTITY:/i.test(text) || /^[^|]{1,40}\|[^|]{1,24}$/.test(text)) && entities.length < 3) {
			const [name, kind] = value.split("|").map((part) => part.trim());
			if (name) entities.push({ name: name.slice(0, 40), kind: (kind || "entity").slice(0, 24), summary: "" });
		}
	}
	// A small model often ignores the format and simply answers. That prose is
	// still a real reply, so it is used rather than showing an empty turn — but
	// facts and entities stay empty, because nothing was actually structured and
	// inventing them from prose would be making memory up.
	const spoken = reply.join(" ").trim()
		|| String(raw ?? "").split(/\r?\n/).map((l) => l.trim())
			.filter((l) => l && !/^(FACT|ENTITY):/i.test(l) && !/^[^|]{1,40}\|[^|]{1,24}$/.test(l))
			.join(" ").trim();
	const cleaned = spoken.replace(/^REPLY:\s*/i, "").trim();
	// A small model sometimes restates its own instructions instead of answering.
	// Showing that back is worse than showing nothing, so it is treated as no
	// reply at all rather than dressed up as one.
	const echoed = /you read one sentence|worth remembering long term|in this exact format|third-person statement/i
		.test(cleaned);
	return { reply: echoed ? "" : cleaned.slice(0, 400), facts, entities };
}

export async function playgroundPreviewExtract(env, text, { rules = null } = {}) {
	const message = String(text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
	if (!message) return { ok: false, reason: "empty" };
	// The account's own policy still applies to what a preview may echo back.
	const refusal = rules ? rulesRejection(rules, message) : null;
	if (refusal) return { ok: true, blocked: refusal, reply: null, entities: [], facts: [] };
	if (!env.AI) return { ok: true, unavailable: true, reply: null, entities: [], facts: [] };
	try {
		const res = await runAi(env, chatModel(env), {
			messages: [
				{ role: "system", content: PREVIEW_SYSTEM },
				{ role: "user", content: message },
			],
			temperature: 0.2,
			max_tokens: 300,
		}, undefined, { task: "playground_preview" });
		const parsed = parsePreviewLines(responseText(res));
		return {
			ok: true,
			persisted: false,
			reply: parsed.reply || null,
			entities: parsed.entities.map((e) => ({ ...e, summary: `Named in this message as a ${e.kind}.` })),
			facts: parsed.facts,
		};
	} catch (error) {
		// Log the shape, never the content: this runs on whatever a person typed.
		console.warn("playground preview extract failed:", error?.message ?? error);
		return { ok: true, unavailable: true, reply: null, entities: [], facts: [] };
	}
}

async function chatReply(env, messages) {
	if (!env.AI) return REPLY_FALLBACK;
	try {
		const res = await runAi(env, chatModel(env), {
			messages,
			temperature: Number(env.CHAT_TEMPERATURE ?? 0.4),
			max_tokens: Number(env.CHAT_MAX_TOKENS ?? 512),
		}, undefined, { task: "playground_chat" });
		const text = String(responseText(res) ?? "").trim();
		return text || REPLY_FALLBACK;
	} catch (error) {
		// Never surfaces as an error to the person: the turn still captured.
		console.warn("playground chat model failed:", error?.message ?? error);
		return REPLY_FALLBACK;
	}
}

export async function playgroundTurn(env, ctx, userId, input = {}) {
	const limits = playgroundLimits(env);
	const message = String(input.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
	if (!message) return { ok: false, reason: "empty", message: "Type something to send." };

	const usedToday = await countMessagesToday(env, userId);
	if (usedToday >= limits.dailyMessages) {
		return {
			ok: true,
			capped: "daily",
			message: `You've used all ${limits.dailyMessages} playground messages for today. They reset at midnight UTC — your memory and every connected tool keep working in the meantime.`,
			usage: { usedToday, dailyMessages: limits.dailyMessages },
		};
	}

	let thread = await getThread(env, userId, input.threadId);
	if (!thread) {
		const created = await createThread(env, userId, message.slice(0, 60));
		if (!created.ok) return { ok: true, capped: "threads", message: created.message };
		thread = { ...created.thread, settings_json: null };
	}

	const history = await getThreadMessages(env, userId, thread.id);
	const userMessage = await storeMessage(env, userId, thread.id, "user", message);

	// Recall through the shared command, exactly as a connected client does.
	const recall = await runRecallCommand(env, userId, message, {
		conversationId: `playground:${thread.id}`,
		threadId: thread.id,
	});
	const reply = await chatReply(env, buildChatMessages(history, message, String(recall.context ?? "").trim()));

	// Capture through the shared auto-collect lane. Thread policy is layered
	// UNDER the account's saved rules — one rules system, scoped to this chat.
	//
	// FAIL CLOSED. This load used to be the fail-open one: an unreadable rules
	// row came back as defaults, and because a resolved rules object short
	// -circuits resolveAdmissionRules(), the fail-closed reload every lane
	// downstream relies on could never fire. A transient D1 error therefore
	// turned "never keep my salary" into "keep everything" for this turn. The
	// reply still goes out — losing the conversation helps nobody — but nothing
	// is captured, and the receipt says so rather than staying silent.
	let accountRules = null;
	let rulesUnavailable = false;
	try {
		accountRules = await getMemoryRules(env, userId, { failClosed: true });
	} catch (error) {
		console.warn("playground rules unavailable:", error?.message ?? error);
		rulesUnavailable = true;
	}
	const rules = rulesUnavailable
		? null
		: threadRulesFrom(accountRules, parseJson(thread.settings_json, null)) ?? accountRules;
	const capture = rulesUnavailable ? null : await runObserveMessagesCommand(env, ctx, userId, [
		{ id: userMessage.id, role: "user", content: message, ts: userMessage.created_at },
	], {
		flush: true,
		waitBudgetMs: Number(env.PLAYGROUND_WAIT_MS ?? getConfig(env).saveWaitBudgetMs),
		conversationId: `playground:${thread.id}`,
		threadId: thread.id,
		source: "ingest",
		sourceMode: "playground",
		// `_test` injects a canned extraction proposal for deterministic specs,
		// exactly as /v1/save and /v1/ingest do. Production never sends it, and
		// it only replaces the model's proposal — every gate still runs.
		overrides: { ...(input.overrides ?? {}), ...(rules ? { rules } : {}) },
	});

	const items = capture?.receipt ? await extractionItems(env, userId, capture.receipt) : [];
	const extraction = {
		items,
		summary: capture?.summary ?? null,
		saved_total: capture?.counts?.savedTotal ?? 0,
		processing: Boolean(capture?.processing),
		receipt_id: capture?.receipt_id ?? null,
		// The handle reconcileExtractions() uses to find the real receipt once
		// extraction outruns the wait budget, which on a live model it often does.
		source_packet_id: capture?.source_packet_id ?? null,
		// Typed so the UI can say which of the several honest things happened,
		// rather than showing "nothing captured" for four different reasons.
		blocked: rulesUnavailable ? "rules_unavailable" : null,
		at: Date.now(),
	};

	await env.DB.prepare(
		"UPDATE playground_messages SET extraction_json = ? WHERE id = ? AND user_id = ?",
	).bind(JSON.stringify(extraction), userMessage.id, userId).run();
	const assistantMessage = await storeMessage(env, userId, thread.id, "assistant", reply);
	await env.DB.prepare("UPDATE playground_threads SET updated_at = ? WHERE id = ? AND user_id = ?")
		.bind(Date.now(), thread.id, userId).run();

	return {
		ok: true,
		thread_id: thread.id,
		user_message: { ...userMessage, extraction },
		assistant_message: assistantMessage,
		extraction,
		recall: { count: recall.count ?? 0 },
		usage: { usedToday: usedToday + 1, dailyMessages: limits.dailyMessages },
	};
}
