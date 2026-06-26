/**
 * Conversation digest (Priority 4) — the fix that makes "save this chat" work.
 *
 * A raw messy chat batch used to choke the extractor ("couldn't extract
 * anything"). Instead we first DIGEST the batch into clean, durable fact-lines,
 * then run normal extraction on that. The digest:
 *   - applies a scope (last-N · topic filter · full · summary-only),
 *   - separates user vs assistant turns and keeps only the user's,
 *   - dedupes and drops obvious chatter,
 *   - asks the cheap model to compress the durable facts into one fact per line
 *     (keeping projects, decisions, preferences, life/health/family, tool facts;
 *     dropping chit-chat, questions, and assistant text),
 *   - falls back to the cleaned user lines if the model is unavailable.
 *
 * Deterministic in tests via `opts.digestResponse` (the exact text the model
 * would have returned; "" forces the heuristic fallback).
 */

import { classifyMessage } from "./trigger.js";

const DIGEST_SYSTEM = `You compress a chat into clean MEMORY lines about the USER.
Output ONLY durable facts about the user, ONE per line, plain text — no bullets, no numbering, no preamble, no commentary.
KEEP: their projects, decisions, preferences, skills, habits, goals, life/health/family facts, and the tools/systems they use.
DROP: greetings, thanks, jokes, questions, anything the assistant said, and formatting noise.
If there is nothing durable to keep, output nothing at all.`;

/** Apply the requested scope to the raw message list. */
function applyScope(messages, opts) {
	const scope = opts.scope ?? "full";
	if (scope === "lastN") {
		const n = Number(opts.n ?? 20);
		return messages.slice(-Math.max(1, n));
	}
	if (scope === "topic" && opts.topic) {
		const t = String(opts.topic).toLowerCase();
		return messages.filter((m) => String(m.content ?? "").toLowerCase().includes(t));
	}
	return messages; // "full" or "summary"
}

/** Dedupe identical user lines and drop pure chatter; optionally drop questions. */
function cleanUserTurns(turns, { dropUtility = false } = {}) {
	const seen = new Set();
	const out = [];
	for (const m of turns) {
		const c = String(m.content ?? "").trim().replace(/\s+/g, " ");
		if (!c) continue;
		const key = c.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const cls = classifyMessage(c);
		if (cls === "noise") continue;
		if (dropUtility && cls === "utility") continue;
		out.push(c);
	}
	return out;
}

async function llmDigest(env, config, userLines, assistantLines) {
	if (!env.AI) return "";
	const payload = [
		"USER MESSAGES:",
		...userLines.map((l, i) => `${i + 1}. ${l}`),
	];
	if (assistantLines.length) {
		payload.push("", "ASSISTANT MESSAGES (context only, never memorize these):");
		payload.push(...assistantLines.slice(-6).map((l) => `- ${l}`));
	}
	try {
		const res = await env.AI.run(
			config.llm.digestModel,
			{
				messages: [
					{ role: "system", content: DIGEST_SYSTEM },
					{ role: "user", content: payload.join("\n") },
				],
				temperature: 0,
				max_tokens: config.llm.digestMaxTokens,
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		return String(res?.response ?? "").trim();
	} catch (err) {
		console.warn("digest llm failed:", err?.message ?? err);
		return "";
	}
}

/**
 * @returns {Promise<{ digest: string, userTurns: number, assistantTurns: number,
 *   keptLines: number, scope: string }>}
 */
export async function digestConversation(env, config, messages, opts = {}) {
	const scope = opts.scope ?? "full";
	const scoped = applyScope(messages ?? [], opts);
	const userTurns = scoped.filter((m) => (m.role ?? "user") === "user");
	const assistantTurns = scoped.filter((m) => m.role === "assistant");

	// Summary-only payload: the caller already condensed it — trust it as-is.
	if (scope === "summary") {
		const lines = cleanUserTurns(userTurns, { dropUtility: false });
		const digest = lines.join("\n");
		return { digest, userTurns: userTurns.length, assistantTurns: assistantTurns.length, keptLines: lines.length, scope };
	}

	const kept = cleanUserTurns(userTurns, { dropUtility: false });
	const assistantText = assistantTurns.map((m) => String(m.content ?? "").trim()).filter(Boolean);

	let digest;
	if (opts.digestResponse !== undefined && opts.digestResponse !== null) {
		digest = String(opts.digestResponse).trim(); // deterministic test hook
	} else {
		digest = await llmDigest(env, config, kept, assistantText);
	}

	// Fallback: if the model gave nothing, keep the cleaned user lines (drop
	// questions too, since there's no model to judge them). Never lose real content.
	if (!digest) {
		digest = cleanUserTurns(userTurns, { dropUtility: true }).join("\n");
	}

	const keptLines = digest ? digest.split("\n").filter((l) => l.trim()).length : 0;
	return { digest, userTurns: userTurns.length, assistantTurns: assistantTurns.length, keptLines, scope };
}
