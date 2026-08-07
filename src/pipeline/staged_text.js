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
import { normalizeProjectScope } from "../lib/project_scope.js";
import { resolveAdmissionRules } from "./admission.js";
import { rulesAllowText } from "./rules.js";

const TEXT_CAP = 2000;
const MAX_ROWS_PER_WRITE = 40;

/**
 * Stage the durable user text of one accepted write. Best-effort.
 *
 * Recall reads this index, so the user's include/exclude rules must gate it
 * exactly as they gate the extraction pass — otherwise excluded content is
 * recallable through the staging bridge until the job settles.
 */
export async function stageMemoryText(env, userId, {
	jobId,
	sourcePacketId,
	lane,
	messages,
	projectId = null,
	projectName = null,
	rules,
}) {
	// Fail closed: if rules cannot be resolved, stage nothing rather than risk
	// staging content the user asked never to keep. Staging is only a bridge —
	// losing it costs seconds of read-your-writes, never durable memory.
	let effectiveRules;
	try { effectiveRules = await resolveAdmissionRules(env, userId, rules); }
	catch (error) {
		console.warn("stage text rules load failed:", error?.message ?? error);
		return { staged: 0, ruleFiltered: 0, rulesUnavailable: true };
	}
	const eligible = (messages ?? [])
		.filter((m) => (m?.role ?? "user") === "user")
		.map((m) => ({ id: m?.id ?? null, text: String(m?.content ?? "").trim() }))
		.filter((m) => m.text);
	const allowed = eligible.filter((row) => rulesAllowText(effectiveRules, row.text));
	const ruleFiltered = eligible.length - allowed.length;
	const rows = allowed.slice(0, MAX_ROWS_PER_WRITE);
	if (!rows.length) return { staged: 0, ruleFiltered };
	const now = Date.now();
	const project = normalizeProjectScope({ projectId, projectName });
	try {
		await env.DB.batch(rows.map((row) => env.DB.prepare(
			`INSERT INTO staged_memories
				(id, user_id, job_id, source_packet_id, lane, message_id, text, created_at, settled_at,
				 project_id, project_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
		).bind(
			newId("staged"),
			userId,
			jobId ?? null,
			sourcePacketId ?? null,
			lane ?? null,
			row.id,
			row.text.slice(0, TEXT_CAP),
			now,
			project.projectId,
			project.projectName,
		)));
		return { staged: rows.length, ruleFiltered };
	} catch (error) {
		console.warn("stage text failed:", error?.message ?? error);
		return { staged: 0, ruleFiltered, error: String(error?.message ?? error) };
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
export async function findStagedText(env, userId, queryTokens = [], {
	limit = 6,
	maxAgeMs = 30 * 60 * 1000,
	projectId = null,
	recallScope = "global",
} = {}) {
	const terms = [...new Set((queryTokens ?? []).filter((t) => String(t).length > 1))].slice(0, 12);
	if (!terms.length) return [];
	const since = Date.now() - maxAgeMs;
	const project = normalizeProjectScope({ projectId });
	const scope = String(recallScope ?? "global").trim().toLowerCase();
	let projectSql = "";
	let projectBindings = [];
	if (scope === "project_only") {
		projectSql = project.projectId ? " AND s.project_id = ?" : " AND 1 = 0";
		projectBindings = project.projectId ? [project.projectId] : [];
	} else if (scope === "project_then_global") {
		projectSql = project.projectId ? " AND (s.project_id = ? OR s.project_id IS NULL)" : " AND s.project_id IS NULL";
		projectBindings = project.projectId ? [project.projectId] : [];
	}
	try {
		const match = terms.map((t) => `"${String(t).replace(/"/g, "")}"`).join(" OR ");
		const { results } = await env.DB.prepare(
			`SELECT s.id, s.text, s.created_at, s.lane, s.job_id, s.source_packet_id,
				s.project_id, s.project_name
			 FROM staged_memories_fts f
			 JOIN staged_memories s ON s.rowid = f.rowid
			 WHERE staged_memories_fts MATCH ?
			   AND s.user_id = ? AND s.settled_at IS NULL AND s.created_at > ?${projectSql}
			 ORDER BY bm25(staged_memories_fts) LIMIT ?`,
		).bind(match, userId, since, ...projectBindings, limit).all();
		if (results?.length) return results;
	} catch (error) {
		console.warn("staged text FTS lookup failed:", error?.message ?? error);
	}
	// Fallback: a bounded scan of this user's live staged rows. The set is
	// small by construction (backpressure caps active jobs at 200).
	try {
		const { results } = await env.DB.prepare(
			`SELECT s.id, s.text, s.created_at, s.lane, s.job_id, s.source_packet_id,
				s.project_id, s.project_name
			 FROM staged_memories s
			 WHERE s.user_id = ? AND s.settled_at IS NULL AND s.created_at > ?${projectSql}
			 ORDER BY created_at DESC LIMIT 200`,
		).bind(userId, since, ...projectBindings).all();
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
