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
import { getMemoryRules } from "./rules.js";
import { threadRulesFrom } from "./playground_settings.js";

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

/** Chat model. Deliberately NOT config.llm.model: that one is tuned for
 *  extraction, and swapping it would change what the product captures. */
export function chatModel(env) {
	return env.CHAT_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
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

async function chatReply(env, messages) {
	if (!env.AI) return REPLY_FALLBACK;
	try {
		const res = await env.AI.run(chatModel(env), {
			messages,
			temperature: Number(env.CHAT_TEMPERATURE ?? 0.4),
			max_tokens: Number(env.CHAT_MAX_TOKENS ?? 512),
		});
		const text = String(responseText(res) ?? "").trim();
		return text || REPLY_FALLBACK;
	} catch (error) {
		// Never surfaces as an error to the person: the turn still captured.
		console.warn("playground chat model failed:", error?.message ?? error);
		return REPLY_FALLBACK;
	}
}

/**
 * One playground turn: recall → reply → capture. Both memory steps are the
 * shared commands, so anything captured here is identical to what a connected
 * Claude or ChatGPT would have captured from the same sentence.
 */
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

	// Capture through the shared auto-collect lane. Thread settings are merged
	// over the account's saved rules — one rules system, scoped to this chat.
	const accountRules = await getMemoryRules(env, userId);
	const rules = threadRulesFrom(accountRules, parseJson(thread.settings_json, null));
	const capture = await runObserveMessagesCommand(env, ctx, userId, [
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

	const items = capture.receipt ? await extractionItems(env, userId, capture.receipt) : [];
	const extraction = {
		items,
		summary: capture.summary ?? null,
		saved_total: capture.counts?.savedTotal ?? 0,
		processing: Boolean(capture.processing),
		receipt_id: capture.receipt_id ?? null,
		// The handle reconcileExtractions() uses to find the real receipt once
		// extraction outruns the wait budget, which on a live model it often does.
		source_packet_id: capture.source_packet_id ?? null,
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
