/**
 * Cross-encoder reranking of fused recall candidates.
 *
 * WHY. E1 raised evidence availability from 30.45% to 65.97% by widening the
 * context budget, and the same reader's conditional accuracy FELL from 68.23%
 * to 58.27% — a measured 9.96 pp dilution tax. The evidence is present and the
 * reader drowns in ~74 unranked items. Fusion ranks by how many lanes agreed,
 * not by whether an item answers THIS question; a cross-encoder scores exactly
 * that.
 *
 * WHAT THIS IS NOT. It is not a filter that makes the context small. Truncating
 * to the 8 best items would raise conditional accuracy and destroy availability,
 * which is the failure this experiment exists to avoid. Ordering is the product;
 * `keep` is a bound, not the goal.
 *
 * SAFETY. Reranking runs entirely inside an already scope-filtered candidate
 * list — it can reorder and drop, never introduce. It cannot reach another
 * tenant or project because it never queries anything. A reranker failure is a
 * degraded read, never a failed one: on any error the fused order is returned
 * unchanged.
 */

import { runAi } from "../lib/ai_meter.js";

/** Cross-encoder. Verified first-party (partner=false) by the billing guard. */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Hard ceiling on pairs scored per query. The caller cannot raise this. */
export const RERANK_MAX_CANDIDATES = 120;
/** Per-candidate text handed to the cross-encoder. */
const RERANK_TEXT_CAP = 900;

/**
 * The text a candidate is judged by. Deliberately the same material the reader
 * will see — scoring a summary and then showing the reader something else would
 * rank one thing and deliver another.
 */
export function candidateText(entry) {
	const item = entry?.item ?? {};
	if (entry?.type === "page") {
		return [item.title, item.short_summary, ...(item.key_points ?? []).slice(0, 3)]
			.filter(Boolean).join(" — ").slice(0, RERANK_TEXT_CAP);
	}
	const parts = [
		item.label,
		item.category ? `(${item.category})` : null,
		item.summary,
		...(item.relations ?? []).slice(0, 3),
		...(item.slices ?? []).slice(0, 4).map((s) => s.text),
		...(item.events ?? []).slice(0, 4).map((e) => e.text),
	];
	return parts.filter(Boolean).join(" — ").slice(0, RERANK_TEXT_CAP);
}

/**
 * Reorder fused entries by cross-encoder relevance to the query.
 *
 * Returns `{ entries, used, scored, keep, latencyMs, error }`. `used:false`
 * always means the caller got its input back untouched.
 */
export async function rerankEntries(env, query, entries, { keep = null, maxCandidates = RERANK_MAX_CANDIDATES } = {}) {
	const started = Date.now();
	const list = Array.isArray(entries) ? entries : [];
	const q = String(query ?? "").trim();
	if (!env?.AI || !q || list.length < 2) {
		return { entries: list, used: false, scored: 0, keep: null, latencyMs: 0 };
	}

	// Bounded: only the head of the fused list is scored. Fusion already ordered
	// it, so the tail is the least likely to matter and is the cheapest to drop.
	const bound = Math.max(2, Math.min(maxCandidates, RERANK_MAX_CANDIDATES));
	const head = list.slice(0, bound);
	const tail = list.slice(bound);
	const contexts = head.map((entry) => ({ text: candidateText(entry) }));
	if (contexts.some((c) => !c.text)) {
		// A candidate we cannot describe cannot be fairly scored against the rest.
		return { entries: list, used: false, scored: 0, keep: null, latencyMs: Date.now() - started, error: "empty_candidate_text" };
	}

	let ranked;
	try {
		const res = await runAi(env, RERANK_MODEL, { query: q, contexts }, undefined, { task: "rerank" });
		ranked = res?.response ?? res?.result?.response ?? res;
	} catch (error) {
		console.warn("rerank failed:", error?.message ?? error);
		return { entries: list, used: false, scored: 0, keep: null, latencyMs: Date.now() - started, error: String(error?.message ?? error) };
	}
	if (!Array.isArray(ranked) || !ranked.length) {
		return { entries: list, used: false, scored: 0, keep: null, latencyMs: Date.now() - started, error: "unreadable_rerank_response" };
	}

	// The model returns {id, score} where id indexes `contexts`. Anything that
	// does not map back to a real candidate is discarded rather than guessed at.
	const seen = new Set();
	const reordered = [];
	for (const row of [...ranked].sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0))) {
		const index = Number(row?.id);
		if (!Number.isInteger(index) || index < 0 || index >= head.length || seen.has(index)) continue;
		seen.add(index);
		reordered.push({ ...head[index], rerankScore: Number(row.score) });
	}
	// Any head candidate the model did not return keeps its fused position after
	// the ones it did — dropping it silently would lose evidence to a model quirk.
	for (let i = 0; i < head.length; i += 1) {
		if (!seen.has(i)) reordered.push(head[i]);
	}

	const merged = [...reordered, ...tail];
	const bounded = Number.isInteger(keep) && keep > 0 ? merged.slice(0, keep) : merged;
	return {
		entries: bounded,
		used: true,
		scored: head.length,
		keep: Number.isInteger(keep) && keep > 0 ? keep : null,
		latencyMs: Date.now() - started,
	};
}
