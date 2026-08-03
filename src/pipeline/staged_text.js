/**
 * Read-your-writes staging (fix round 1, Part 8.2).
 *
 * Every accepted write records its SCRUBBED per-message text here at accept
 * time, so a lookup seconds later answers with the content instead of "still
 * processing". When the write's job settles, the rows are settled too and
 * stop matching — the graph now holds the same content, better structured.
 *
 * This is a staging index, never a source of truth: nothing reads it except
 * recall, and losing every row would cost only a few seconds of
 * read-your-writes. All functions are best-effort and never throw into a
 * save — a staging failure must not fail an accepted write.
 */

import { newId } from "../lib/ids.js";

const TEXT_CAP = 2000;
const MAX_ROWS_PER_WRITE = 40;

/** Stage the durable user text of one accepted write. Best-effort. */
export async function stageMemoryText(env, userId, { jobId, sourcePacketId, lane, messages }) {
	const rows = (messages ?? [])
		.filter((m) => (m?.role ?? "user") === "user")
		.map((m) => ({ id: m?.id ?? null, text: String(m?.content ?? "").trim() }))
		.filter((m) => m.text)
		.slice(0, MAX_ROWS_PER_WRITE);
	if (!rows.length) return { staged: 0 };
	const now = Date.now();
	try {
		await env.DB.batch(rows.map((row) => env.DB.prepare(
			`INSERT INTO staged_memories
				(id, user_id, job_id, source_packet_id, lane, message_id, text, created_at, settled_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		).bind(
			newId("staged"),
			userId,
			jobId ?? null,
			sourcePacketId ?? null,
			lane ?? null,
			row.id,
			row.text.slice(0, TEXT_CAP),
			now,
		)));
		return { staged: rows.length };
	} catch (error) {
		console.warn("stage text failed:", error?.message ?? error);
		return { staged: 0, error: String(error?.message ?? error) };
	}
}

/**
 * The upgrade: this write's content now lives in the graph, so its staged
 * rows stop answering. Soft (settled_at) so a support question can still ask
 * what was staged and when.
 */
export async function settleStagedText(env, userId, jobIds = []) {
	const ids = [...new Set((jobIds ?? []).filter(Boolean))];
	if (!ids.length) return { settled: 0 };
	try {
		const marks = ids.map(() => "?").join(", ");
		const result = await env.DB.prepare(
			`UPDATE staged_memories SET settled_at = ?
			 WHERE user_id = ? AND settled_at IS NULL AND job_id IN (${marks})`,
		).bind(Date.now(), userId, ...ids).run();
		return { settled: result.meta?.changes ?? 0 };
	} catch (error) {
		console.warn("settle staged text failed:", error?.message ?? error);
		return { settled: 0 };
	}
}

/**
 * Live staged text matching a query — recall's read-your-writes signal.
 * FTS5 first (BM25 ordering), with a bounded LIKE fallback for the tokens
 * FTS cannot express. Only unsettled rows, only recent ones: staged text is
 * a bridge across the enrichment gap, not a second memory store.
 */
export async function findStagedText(env, userId, queryTokens = [], { limit = 6, maxAgeMs = 30 * 60 * 1000 } = {}) {
	const terms = [...new Set((queryTokens ?? []).filter((t) => String(t).length > 1))].slice(0, 12);
	if (!terms.length) return [];
	const since = Date.now() - maxAgeMs;
	try {
		const match = terms.map((t) => `"${String(t).replace(/"/g, "")}"`).join(" OR ");
		const { results } = await env.DB.prepare(
			`SELECT s.id, s.text, s.created_at, s.lane, s.job_id, s.source_packet_id
			 FROM staged_memories_fts f
			 JOIN staged_memories s ON s.rowid = f.rowid
			 WHERE staged_memories_fts MATCH ?
			   AND s.user_id = ? AND s.settled_at IS NULL AND s.created_at > ?
			 ORDER BY bm25(staged_memories_fts) LIMIT ?`,
		).bind(match, userId, since, limit).all();
		if (results?.length) return results;
	} catch (error) {
		console.warn("staged text FTS lookup failed:", error?.message ?? error);
	}
	// Fallback: a bounded scan of this user's live staged rows. The set is
	// small by construction (backpressure caps active jobs at 200).
	try {
		const { results } = await env.DB.prepare(
			`SELECT id, text, created_at, lane, job_id, source_packet_id
			 FROM staged_memories
			 WHERE user_id = ? AND settled_at IS NULL AND created_at > ?
			 ORDER BY created_at DESC LIMIT 200`,
		).bind(userId, since).all();
		const lowered = terms.map((t) => String(t).toLowerCase());
		return (results ?? [])
			.map((row) => ({
				...row,
				_score: lowered.filter((t) => String(row.text).toLowerCase().includes(t)).length,
			}))
			.filter((row) => row._score > 0)
			.sort((a, b) => b._score - a._score || b.created_at - a.created_at)
			.slice(0, limit);
	} catch (error) {
		console.warn("staged text scan failed:", error?.message ?? error);
		return [];
	}
}

/** Housekeeping: settled rows have no further purpose after a day. */
export async function pruneStagedText(env, olderThanMs = 24 * 60 * 60 * 1000) {
	try {
		const result = await env.DB.prepare(
			"DELETE FROM staged_memories WHERE settled_at IS NOT NULL AND settled_at < ?",
		).bind(Date.now() - olderThanMs).run();
		return { pruned: result.meta?.changes ?? 0 };
	} catch (error) {
		console.warn("staged text prune failed:", error?.message ?? error);
		return { pruned: 0 };
	}
}
