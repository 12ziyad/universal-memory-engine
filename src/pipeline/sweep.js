/**
 * The reconciliation sweep (fix round 1, Part 1.8) — the independent check
 * that would have caught the Aug 2 stranding in minutes instead of by
 * accident. Runs from a Workers Cron Trigger, deliberately NOT from the same
 * Durable Object alarm chain it audits.
 *
 * Three duties every few minutes:
 *   1. RESCUE — jobs sitting non-terminal past the threshold get their user's
 *      DO kicked (re-arm + drain). Alarms can be lost; the sweep cannot.
 *   2. ALERT — new failed jobs are reported to the admin.
 *   3. INVARIANT — an accepted/staged receipt with no memory_jobs row for its
 *      packet is a red alert: a promise nothing is responsible for keeping.
 */

import { reportServerError } from "../lib/report.js";

const STALE_MS = 5 * 60 * 1000;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const RECEIPT_SCAN_MS = 60 * 60 * 1000;
const MAX_USERS_PER_SWEEP = 50;

export async function runReconciliationSweep(env) {
	const now = Date.now();
	const result = { rescued: [], failedUsers: [], orphanReceipts: 0, errors: [] };

	// 1. Rescue: stale non-terminal jobs → kick the owning DO.
	try {
		const { results } = await env.DB.prepare(
			`SELECT user_id, COUNT(*) AS n, MIN(updated_at) AS oldest
			 FROM memory_jobs
			 WHERE status IN ('queued', 'staged', 'processing') AND updated_at < ?
			 GROUP BY user_id
			 ORDER BY oldest
			 LIMIT ?`,
		).bind(now - STALE_MS, MAX_USERS_PER_SWEEP).all();
		for (const row of results ?? []) {
			try {
				const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(row.user_id));
				const kicked = await stub.kick(row.user_id);
				result.rescued.push({ userId: row.user_id, staleJobs: row.n, oldestMs: now - row.oldest, ...kicked });
			} catch (error) {
				result.errors.push(`kick ${row.user_id}: ${error?.message ?? error}`);
			}
		}
		if (result.rescued.length) {
			await reportServerError(
				env,
				"sweep_rescue",
				new Error(`rescued ${result.rescued.length} user(s) with stale jobs: ${result.rescued.map((r) => `${r.userId}(${r.staleJobs} jobs, oldest ${Math.round(r.oldestMs / 1000)}s)`).join("; ").slice(0, 300)}`),
				null,
			);
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
		}
	} catch (error) {
		result.errors.push(`invariant query: ${error?.message ?? error}`);
	}

	console.log(
		`sweep: rescued=${result.rescued.length} failedUsers=${result.failedUsers.length} orphanReceipts=${result.orphanReceipts} errors=${result.errors.length}`,
	);
	return result;
}
