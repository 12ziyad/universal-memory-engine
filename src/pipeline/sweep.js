/**
 * The reconciliation sweep (fix round 1, Part 1.8) — the independent check
 * that would have caught the Aug 2 stranding in minutes instead of by
 * accident. Runs from a Workers Cron Trigger, deliberately NOT from the same
 * Durable Object alarm chain it audits.
 *
 * Four duties every few minutes:
 *   1. RESCUE — jobs sitting non-terminal past the threshold get their user's
 *      DO kicked (re-arm + drain). Alarms can be lost; the sweep cannot.
 *   2. ALERT — new failed jobs are reported to the admin.
 *   3. INVARIANT — an accepted/staged receipt with no memory_jobs row for its
 *      packet is a red alert: a promise nothing is responsible for keeping.
 *   4. PRUNE — terminal job rows older than the retention window are deleted
 *      in bounded batches, so the ledger stops growing forever.
 */

import { reportServerError } from "../lib/report.js";
import { recordSecurityEvent } from "../lib/security_events.js";
import { updateMemoryJob } from "../lib/db.js";
import { settleStagedText } from "./staged_text.js";

const STALE_MS = 5 * 60 * 1000;
// Terminal job rows are an operational ledger, not memory: after this window
// they stop being useful to anyone (the UI shows recent jobs, the sweep
// alerts on the last 10 minutes) and before pruning existed the table only
// ever grew — 6,907 rows and every cron scan paying for all of them, forever.
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PRUNE_PER_SWEEP = 400;
const TERMINAL_JOB_PRUNE_STATES = ["enriched", "completed", "skipped", "failed"];
// A job the owning Durable Object has no work for is ORPHANED: no queue entry,
// no held message, nothing a kick can reach. Given a wider margin than plain
// staleness so a slow drain (one entry can take tens of seconds) is never
// mistaken for lost work — the entry exists throughout processing, and the job
// is settled BEFORE the entry is deleted, so there is no window where live
// work looks orphaned.
const ORPHAN_MS = 15 * 60 * 1000;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const RECEIPT_SCAN_MS = 60 * 60 * 1000;
const MAX_USERS_PER_SWEEP = 50;
const MAX_STALE_JOBS_PER_USER = 200;

export async function runReconciliationSweep(env) {
	const now = Date.now();
	const result = { rescued: [], orphaned: [], failedUsers: [], orphanReceipts: 0, pruned: 0, errors: [] };

	// 1. Rescue stale non-terminal jobs — and tell a real rescue apart from a
	// futile one. A kick can only drain what is in the Durable Object's
	// storage; a job row with no queue entry behind it will never settle, and
	// reporting "rescued" for it every five minutes forever is exactly the
	// silent-failure disease this sweep exists to end. Those get resolved to a
	// visible terminal state instead.
	try {
		const { results: staleUsers } = await env.DB.prepare(
			`SELECT user_id, COUNT(*) AS n, MIN(updated_at) AS oldest
			 FROM memory_jobs
			 WHERE status IN ('queued', 'staged', 'processing') AND updated_at < ?
			 GROUP BY user_id
			 ORDER BY oldest
			 LIMIT ?`,
		).bind(now - STALE_MS, MAX_USERS_PER_SWEEP).all();

		for (const row of staleUsers ?? []) {
			try {
				const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(row.user_id));
				const kicked = await stub.kick(row.user_id);
				const known = new Set(kicked.jobIds ?? []);

				// Which of this user's stale jobs does the object actually hold
				// work for? Anything older than the orphan margin that it does
				// not know about cannot be rescued by waking it.
				const { results: jobs } = await env.DB.prepare(
					`SELECT id, type, attempts, created_at, updated_at, source_packet_id
					 FROM memory_jobs
					 WHERE user_id = ? AND status IN ('queued', 'staged', 'processing')
					 ORDER BY updated_at LIMIT ?`,
				).bind(row.user_id, MAX_STALE_JOBS_PER_USER).all();

				const orphans = (jobs ?? []).filter(
					(job) => !known.has(job.id) && job.updated_at < now - ORPHAN_MS,
				);
				const reachable = (jobs ?? []).length - orphans.length;

				if (reachable > 0) {
					result.rescued.push({
						userId: row.user_id,
						reachableJobs: reachable,
						queued: kicked.queued,
						held: kicked.held,
						oldestMs: now - row.oldest,
					});
				}

				for (const job of orphans) {
					await updateMemoryJob(env, row.user_id, job.id, {
						status: "failed",
						error: "work never reached the queue — no durable entry exists for this job, so it can never be processed",
						completedAt: Date.now(),
					});
					await settleStagedText(env, row.user_id, [job.id]);
				}
				if (orphans.length) {
					result.orphaned.push({
						userId: row.user_id,
						count: orphans.length,
						jobIds: orphans.slice(0, 10).map((job) => job.id),
						oldestMs: now - Math.min(...orphans.map((job) => job.updated_at)),
					});
				}
			} catch (error) {
				result.errors.push(`kick ${row.user_id}: ${error?.message ?? error}`);
			}
		}

		if (result.rescued.length) {
			await reportServerError(
				env,
				"sweep_rescue",
				new Error(`kicked ${result.rescued.length} user(s) with reachable stale jobs: ${result.rescued.map((r) => `${r.userId}(${r.reachableJobs} jobs, oldest ${Math.round(r.oldestMs / 1000)}s)`).join("; ").slice(0, 300)}`),
				null,
			);
		}
		if (result.orphaned.length) {
			const total = result.orphaned.reduce((a, o) => a + o.count, 0);
			await reportServerError(
				env,
				"sweep_orphaned_jobs",
				new Error(`RED ALERT: ${total} job(s) had NO durable work behind them and were failed rather than kicked forever — ${result.orphaned.map((o) => `${o.userId}(${o.count})`).join("; ").slice(0, 250)}`),
				null,
			);
			await recordSecurityEvent(env, {
				kind: "sweep_orphaned_jobs",
				severity: "high",
				groupKey: "sweep_orphaned_jobs",
				details: { total, users: result.orphaned.length },
			});
		}
	} catch (error) {
		result.errors.push(`rescue query: ${error?.message ?? error}`);
	}

	// 2. Alert on fresh failures.
	try {
		const { results } = await env.DB.prepare(
			`SELECT user_id, COUNT(*) AS n FROM memory_jobs
			 WHERE status = 'failed' AND completed_at > ?
			 GROUP BY user_id LIMIT ?`,
		).bind(now - FAILED_WINDOW_MS, MAX_USERS_PER_SWEEP).all();
		result.failedUsers = (results ?? []).map((r) => ({ userId: r.user_id, failed: r.n }));
		if (result.failedUsers.length) {
			await reportServerError(
				env,
				"sweep_failed_jobs",
				new Error(`${result.failedUsers.reduce((a, r) => a + r.failed, 0)} failed job(s) across ${result.failedUsers.length} user(s) in the last ${FAILED_WINDOW_MS / 60000}min`),
				null,
			);
		}
	} catch (error) {
		result.errors.push(`failed query: ${error?.message ?? error}`);
	}

	// 3. Invariant: accepted-in == jobs-tracked. A receipt promising background
	// work with no job row behind it must never exist. (Old-enough only, so a
	// receipt stored milliseconds before its job row doesn't false-positive.)
	try {
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n
			 FROM receipts r
			 WHERE r.outcome IN ('accepted', 'staged')
			   AND r.created_at BETWEEN ? AND ?
			   AND r.source_packet_id IS NOT NULL
			   AND NOT EXISTS (
				   SELECT 1 FROM memory_jobs j
				   WHERE j.user_id = r.user_id AND j.source_packet_id = r.source_packet_id
			   )`,
		).bind(now - RECEIPT_SCAN_MS, now - STALE_MS).first();
		result.orphanReceipts = Number(row?.n ?? 0);
		if (result.orphanReceipts > 0) {
			await reportServerError(
				env,
				"sweep_invariant_violation",
				new Error(`RED ALERT: ${result.orphanReceipts} accepted/staged receipt(s) have NO job row — a write was promised with nothing responsible for it`),
				null,
			);
			await recordSecurityEvent(env, {
				kind: "sweep_receipt_without_job",
				severity: "critical",
				groupKey: "sweep_receipt_without_job",
				details: { count: result.orphanReceipts },
			});
		}
	} catch (error) {
		result.errors.push(`invariant query: ${error?.message ?? error}`);
	}

	// 4. PRUNE — terminal rows past the retention window, in bounded batches
	// so a backlog drains across ticks instead of one giant delete. Both
	// slices ride the 0058 (status, completed_at)/(status, updated_at)
	// indexes; updated_at covers legacy terminal rows that never got a
	// completed_at stamp.
	try {
		const cutoff = now - JOB_RETENTION_MS;
		const statuses = TERMINAL_JOB_PRUNE_STATES.map(() => "?").join(", ");
		const completed = await env.DB.prepare(
			`DELETE FROM memory_jobs WHERE id IN (
			   SELECT id FROM memory_jobs
			    WHERE status IN (${statuses}) AND completed_at IS NOT NULL AND completed_at < ?
			    LIMIT ?)`,
		).bind(...TERMINAL_JOB_PRUNE_STATES, cutoff, MAX_PRUNE_PER_SWEEP).run();
		const unstamped = await env.DB.prepare(
			`DELETE FROM memory_jobs WHERE id IN (
			   SELECT id FROM memory_jobs
			    WHERE status IN (${statuses}) AND completed_at IS NULL AND updated_at < ?
			    LIMIT ?)`,
		).bind(...TERMINAL_JOB_PRUNE_STATES, cutoff, MAX_PRUNE_PER_SWEEP).run();
		result.pruned = Number(completed.meta?.changes ?? 0) + Number(unstamped.meta?.changes ?? 0);
	} catch (error) {
		result.errors.push(`prune query: ${error?.message ?? error}`);
	}

	console.log(
		`sweep: rescued=${result.rescued.length} orphanedJobs=${result.orphaned.reduce((a, o) => a + o.count, 0)} ` +
		`failedUsers=${result.failedUsers.length} orphanReceipts=${result.orphanReceipts} pruned=${result.pruned ?? 0} errors=${result.errors.length}`,
	);
	return result;
}
