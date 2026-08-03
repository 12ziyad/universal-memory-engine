/**
 * The reconciliation sweep (Part 1.8): the independent accepted-in ==
 * settled-out check. These tests seed the exact pathologies the sweep exists
 * to catch and assert it catches them.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runReconciliationSweep } from "../src/pipeline/sweep.js";
import { createMemoryJob, storeReceipt } from "../src/lib/db.js";

async function reports(scope) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM error_reports WHERE scope = ? ORDER BY created_at DESC",
	).bind(scope).all();
	return results ?? [];
}

describe("reconciliation sweep", () => {
	it("finds nothing on a healthy ledger", async () => {
		const result = await runReconciliationSweep(env);
		expect(result.rescued).toHaveLength(0);
		expect(result.orphanReceipts).toBe(0);
	});

	it("rescues a user whose job sat non-terminal past the threshold", async () => {
		const userId = `sweep-stale-${crypto.randomUUID()}`;
		const jobId = await createMemoryJob(env, userId, {
			type: "extract",
			status: "queued",
			idempotencyKey: `sweep-test-${userId}`,
			payload: { message_ids: ["m1"], remaining: ["m1"] },
		});
		expect(jobId).toBeTruthy();
		// Age it past the stale threshold.
		await env.DB.prepare("UPDATE memory_jobs SET updated_at = ?, created_at = ? WHERE id = ?")
			.bind(Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000, jobId).run();

		const result = await runReconciliationSweep(env);
		const mine = result.rescued.find((r) => r.userId === userId);
		expect(mine).toBeTruthy();
		// Stale but inside the orphan margin: still treated as reachable, so
		// the sweep kicks rather than condemning work a slow drain may hold.
		expect(mine.reachableJobs).toBe(1);
		expect(result.orphaned.some((o) => o.userId === userId)).toBe(false);
		// And the admin heard about it.
		expect((await reports("sweep_rescue")).length).toBeGreaterThan(0);
	});

	it("alerts on freshly failed jobs", async () => {
		const userId = `sweep-failed-${crypto.randomUUID()}`;
		const jobId = await createMemoryJob(env, userId, {
			type: "extract",
			status: "failed",
			idempotencyKey: `sweep-failed-${userId}`,
			error: "poison",
			completedAt: Date.now(),
			payload: { message_ids: ["m1"], remaining: [] },
		});
		expect(jobId).toBeTruthy();
		const result = await runReconciliationSweep(env);
		expect(result.failedUsers.some((f) => f.userId === userId)).toBe(true);
		expect((await reports("sweep_failed_jobs")).length).toBeGreaterThan(0);
	});

	it("RED ALERTS on an accepted receipt with no job row behind it", async () => {
		const userId = `sweep-orphan-${crypto.randomUUID()}`;
		const receipt = {
			outcome: "accepted",
			source_packet_id: `src_orphan_${crypto.randomUUID()}`,
			received: 1,
			created_at: Date.now() - 10 * 60 * 1000, // old enough to be suspicious
		};
		await storeReceipt(env, userId, "ingest", receipt, "extraction accepted and processing");

		const result = await runReconciliationSweep(env);
		expect(result.orphanReceipts).toBeGreaterThan(0);
		const alert = await reports("sweep_invariant_violation");
		expect(alert.length).toBeGreaterThan(0);
		expect(alert[0].message).toMatch(/NO job row/);
	});
});
