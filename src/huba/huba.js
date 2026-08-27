/**
 * Huba AI — the grounded product assistant pinned to the bottom of the app.
 *
 * The contract, in order of importance:
 *   1. NEVER answers from model knowledge. Every answer is grounded in the
 *      docs corpus (built from public/docs/index.html by
 *      scripts/build-huba-corpus.mjs) plus, for the signed-in account, a
 *      compact server-built snapshot of that account's own state.
 *   2. If retrieval finds nothing relevant, it says so and points at the
 *      closest docs page. A confident wrong answer is worse than no answer.
 *   3. Never leaks another user's data: the snapshot is built server-side
 *      from the authenticated session — no id in the request body is
 *      trusted, ever.
 *   4. Every model call runs through the meter under scope "huba_chat", so
 *      spend is attributable per account and capped by checkHubaBudget.
 *
 * Model: HUBA_MODEL, defaulting to the extraction MoE (Qwen3-30B-A3B). It is
 * already proven on this account, its instruction-following is what holds the
 * grounding/refusal contract, and as an A3B MoE its per-token cost is close
 * to an 8B dense model — a full answer lands around 20–35 neurons.
 */

import { HUBA_CORPUS } from "./corpus.generated.js";
import { runAi, withFlushedAiMeter } from "../lib/ai_meter.js";
import { responseText } from "../pipeline/llm.js";

const MAX_QUESTION_CHARS = 2000;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 800;
const MAX_CONTEXT_CHARS = 7000;
const TOP_PAGES = 4;

const STOPWORDS = new Set(("a an and are as at be but by can do does for from has have how i in is it its me my of on or "
	+ "that the this to was what when where which who why will with you your").split(" "));

function terms(text) {
	return [...new Set(String(text).toLowerCase().split(/[^a-z0-9_/-]+/)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

/**
 * Lexical retrieval over the 69 docs pages. At this corpus size a scored
 * term-overlap beats an embedding round-trip: zero neurons, zero latency,
 * fully deterministic, and the pages are editorially self-contained.
 */
export function retrieveDocs(question, limit = TOP_PAGES) {
	const queryTerms = terms(question);
	if (!queryTerms.length) return [];
	const scored = [];
	for (const page of HUBA_CORPUS) {
		const title = page.title.toLowerCase();
		const route = page.route.toLowerCase();
		const body = page.text.toLowerCase();
		let score = 0;
		for (const term of queryTerms) {
			if (title.includes(term)) score += 6;
			if (route.includes(term)) score += 3;
			// Term frequency, capped so one repeated word cannot drown the rest.
			let idx = 0, hits = 0;
			while (hits < 8 && (idx = body.indexOf(term, idx)) !== -1) { hits += 1; idx += term.length; }
			score += hits;
		}
		// Phrase bonus: the literal question fragment appearing beats bag-of-words.
		const phrase = String(question).toLowerCase().trim().slice(0, 60);
		if (phrase.length >= 8 && body.includes(phrase)) score += 10;
		if (score > 0) scored.push({ page, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
}

/** The best window of a page around the query terms, for the model context. */
function excerpt(page, question, budget) {
	const body = page.text;
	if (body.length <= budget) return body;
	const lower = body.toLowerCase();
	let best = 0, bestHits = -1;
	for (const term of terms(question)) {
		const at = lower.indexOf(term);
		if (at === -1) continue;
		const start = Math.max(0, at - Math.floor(budget / 3));
		let hits = 0;
		const windowText = lower.slice(start, start + budget);
		for (const t2 of terms(question)) if (windowText.includes(t2)) hits += 1;
		if (hits > bestHits) { bestHits = hits; best = start; }
	}
	return (best > 0 ? "…" : "") + body.slice(best, best + budget) + (best + budget < body.length ? "…" : "");
}

/**
 * Compact, content-light snapshot of the signed-in account, built entirely
 * server-side from the session identity. Personal-space ledgers only — a
 * deliberate floor, not a leak: Huba describes what this account can already
 * read through /v1/usage, /v1/receipts and /v1/jobs.
 */
export async function buildAccountSnapshot(env, { userId, accountUserId }, quota = null, now = Date.now()) {
	if (!env?.DB || !userId) return null;
	const snapshot = { as_of: new Date(now).toISOString() };
	try {
		const user = await env.DB.prepare(
			"SELECT email, name, created_at FROM users WHERE id = ?",
		).bind(userId).first();
		if (user) {
			snapshot.account = {
				name: user.name ?? null,
				signed_up: user.created_at ? new Date(Number(user.created_at)).toISOString().slice(0, 10) : null,
			};
		}
		const since30d = now - 30 * 24 * 60 * 60 * 1000;
		const receipts = await env.DB.prepare(
			`SELECT source, outcome, saved_total, created_at FROM receipts
			 WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
		).bind(userId).all();
		snapshot.recent_saves = (receipts.results ?? []).map((r) => ({
			source: r.source, outcome: r.outcome, saved: r.saved_total,
			at: new Date(Number(r.created_at)).toISOString(),
		}));
		const jobs = await env.DB.prepare(
			`SELECT
				SUM(CASE WHEN status IN ('queued','staged','processing') THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN status = 'failed' AND completed_at > ? THEN 1 ELSE 0 END) AS failed_7d
			 FROM memory_jobs WHERE user_id = ? AND created_at > ?`,
		).bind(now - 7 * 24 * 60 * 60 * 1000, userId, since30d).first();
		snapshot.jobs = { pending: Number(jobs?.pending ?? 0), failed_last_7_days: Number(jobs?.failed_7d ?? 0) };
	} catch (error) {
		console.warn("huba snapshot (activity) unavailable:", error?.message ?? error);
	}
	if (quota) snapshot.quota = quota;
	return snapshot;
}

const SYSTEM_PROMPT = `You are Huba, Itsuki's product assistant. Itsuki (itsuki.app) is a memory service for AI tools.

Hard rules, in priority order:
1. Answer ONLY from the DOCS EXCERPTS and ACCOUNT SNAPSHOT below. Never from general knowledge. If the excerpts and snapshot do not contain the answer, say exactly that and point to the most relevant docs page route instead of guessing.
2. Never invent an endpoint, parameter, limit, price, or product name. If a detail is not in the excerpts, you do not know it.
3. The ACCOUNT SNAPSHOT describes the signed-in person's own account. Never speculate about other accounts or other people's data.
4. Voice: plain and specific. Short sentences. No marketing language, no exclamation marks, never the word "simply". Refer to docs pages by their route, like /quickstart or /api/limits, and the reader can open them at /docs/.
5. Keep answers under 160 words unless the person asked for detail. Code and commands go in fenced blocks.
6. Never quote raw JSON field names from the snapshot (like quota.saves_today.limit_neurons) — translate them into plain words ("about 100 saves left today").`;

export async function hubaTurn(env, { userId, accountUserId }, input = {}, { quota = null } = {}) {
	const question = String(input.message ?? "").trim().slice(0, MAX_QUESTION_CHARS);
	if (!question) return { ok: false, reason: "empty", message: "Ask something first." };
	if (!env.AI) return { ok: false, reason: "unavailable", message: "Huba is offline right now — the docs at /docs/ cover everything it knows." };

	const hits = retrieveDocs(question);
	const perPage = Math.floor(MAX_CONTEXT_CHARS / Math.max(1, Math.min(TOP_PAGES, hits.length || 1)));
	const context = hits.map(({ page }) =>
		`--- ${page.title} (route ${page.route}) ---\n${excerpt(page, question, perPage)}`).join("\n\n");
	const snapshot = await buildAccountSnapshot(env, { userId, accountUserId }, quota);

	const history = Array.isArray(input.history) ? input.history.slice(-MAX_HISTORY_TURNS) : [];
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "system",
			content: `DOCS EXCERPTS${hits.length ? "" : " (retrieval found no relevant page — say so and point to /docs/)"}:\n${context || "(none)"}\n\nACCOUNT SNAPSHOT (the signed-in person's own account):\n${snapshot ? JSON.stringify(snapshot) : "(not signed in)"}`,
		},
		...history
			.filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
			.map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) })),
		{ role: "user", content: question },
	];

	const model = env.HUBA_MODEL || env.LLM_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8";
	return withFlushedAiMeter(env, "huba_chat", {
		userId,
		scopeId: `huba_${crypto.randomUUID()}`,
		lifecycle: { accountUserId: accountUserId ?? userId },
	}, async () => {
		try {
			const res = await runAi(env, model, {
				messages,
				temperature: 0.2,
				max_tokens: Number(env.HUBA_MAX_TOKENS ?? 1024),
			}, undefined, { task: "huba_chat", capability: "chat" });
			const reply = String(responseText(res) ?? "").trim();
			if (!reply) return { ok: false, reason: "empty_reply", message: "Huba could not produce an answer — try rephrasing, or check /docs/." };
			return {
				ok: true,
				reply,
				sources: hits.slice(0, 3).map(({ page }) => ({ route: page.route, title: page.title })),
			};
		} catch (error) {
			console.warn("huba chat model failed:", error?.message ?? error);
			return { ok: false, reason: "model_error", message: "Huba could not reach the model just now. The docs at /docs/ have everything it knows — try again in a minute." };
		}
	});
}
