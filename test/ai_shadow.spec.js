/**
 * Shadow outbox durability and lifecycle citizenship (migration 0054).
 *
 * waitUntil is never the recovery mechanism: D1 + the cron claim/lease loop
 * is. Reconciliation detects and creates any sampled job a settlement path
 * missed. Erasure cancels a job before content is touched. Retention purges.
 * A shadow failure only ever skips the shadow.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	drainShadowJobs,
	purgeExpiredShadowJobs,
	reconcileShadowJobs,
	shadowJobId,
} from "../src/ai/shadow.js";

async function seedRun(userId, { pinShadow = true, status = "wrote", createdAt = Date.now() } = {}) {
	const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
	const pin = pinShadow
		? JSON.stringify({ v: 1, routes: {}, shadow: { provider: "google-vertex", model: "gemini-2.5-flash", sampled: true } })
		: null;
	await env.DB.prepare(
		`INSERT INTO extraction_runs (id, user_id, tool_name, status, created_pages_json, created_nodes_json,
			created_slices_json, created_events_json, created_edges_json, created_candidates_json,
			updated_objects_json, reinforced_objects_json, skipped_objects_json, created_at, updated_at, pin_json, provider)
		 VALUES (?, ?, 'ingest', ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, ?, ?)`,
	).bind(runId, userId, status, createdAt, createdAt, pin, pinShadow ? "workers-ai" : null).run();
	return runId;
}

describe("reconciliation", () => {
	it("creates the missing job for a sampled terminal run, exactly once", async () => {
		const userId = `shadowrec-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		const created = await reconcileShadowJobs(env, { limit: 10 });
		expect(created).toBeGreaterThanOrEqual(1);
		const job = await env.DB.prepare("SELECT * FROM ai_shadow_jobs WHERE id = ?").bind(await shadowJobId(runId)).first();
		expect(job).toMatchObject({ user_id: userId, primary_run_id: runId, status: "pending" });
		// Second pass: idempotent, nothing new for this run.
		await reconcileShadowJobs(env, { limit: 10 });
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(Number(count.n)).toBe(1);
	});

	it("ignores unsampled and unpinned runs", async () => {
		const userId = `shadownone-${crypto.randomUUID()}`;
		const runId = await seedRun(userId, { pinShadow: false });
		await reconcileShadowJobs(env, { limit: 10 });
		const job = await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(job).toBe(null);
	});
});

describe("drain", () => {
	it("cancels on an erasure barrier before touching any content", async () => {
		const userId = `shadowerase-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at",
		).bind(userId, Date.now() + 60_000, Date.now()).run();
		await drainShadowJobs(env, { limit: 5 });
		const job = await env.DB.prepare("SELECT status, comparison_json FROM ai_shadow_jobs WHERE id = ?").bind(await shadowJobId(runId)).first();
		expect(job.status).toBe("cancelled_erased");
		expect(job.comparison_json).toBe(null);
	});

	it("a failing shadow retries once then dead-letters — and never throws out of the drain", async () => {
		const userId = `shadowfail-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		// No source episodes exist → source_gone is terminal cancelled_erased;
		// exercise the retry ladder instead via a run with episodes but no
		// google credentials: seed one episode so the drain reaches the model,
		// where the pinned google admission refuses (no credentials) and throws.
		await env.DB.prepare(
			`INSERT INTO source_episodes (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
			 VALUES (?, ?, ?, 0, 'user', 'I planted tomatoes.', ?, ?)`,
		).bind(`ep-${crypto.randomUUID()}`, userId, `packet-${runId}`, crypto.randomUUID(), Date.now()).run();
		await env.DB.prepare("UPDATE extraction_runs SET source_packet_id = ? WHERE id = ?").bind(`packet-${runId}`, runId).run();

		await drainShadowJobs(env, { limit: 5 });
		let job = await env.DB.prepare("SELECT status, attempts, error_class FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		expect(["pending", "dead_letter"]).toContain(job.status); // attempt 1 failed → back to pending
		await drainShadowJobs(env, { limit: 5 });
		job = await env.DB.prepare("SELECT status, attempts FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		expect(job.status).toBe("dead_letter");
		expect(Number(job.attempts)).toBe(2);
		// The primary run row is untouched throughout.
		const run = await env.DB.prepare("SELECT status FROM extraction_runs WHERE id = ?").bind(runId).first();
		expect(run.status).toBe("wrote");
	});

	it("an expired lease is re-claimable (crash recovery)", async () => {
		const userId = `shadowlease-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		await env.DB.prepare(
			"UPDATE ai_shadow_jobs SET status = 'running', attempts = 1, lease_until = 1 WHERE id = ?",
		).bind(id).run();
		await drainShadowJobs(env, { limit: 5 });
		const job = await env.DB.prepare("SELECT status, attempts FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		// Reclaimed (attempts 2) and processed to a terminal or pending state —
		// never stuck on the dead lease.
		expect(Number(job.attempts)).toBe(2);
		expect(job.status).not.toBe("running");
	});
});

describe("retention", () => {
	it("purges rows past the retention window, bounded", async () => {
		const userId = `shadowpurge-${crypto.randomUUID()}`;
		const runId = await seedRun(userId, { createdAt: Date.now() - 40 * 86_400_000 });
		await env.DB.prepare(
			`INSERT INTO ai_shadow_jobs (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at)
			 VALUES (?, ?, ?, 'google-vertex', 'done', 1, ?, ?)`,
		).bind(await shadowJobId(runId), userId, runId, Date.now() - 40 * 86_400_000, Date.now()).run();
		const purged = await purgeExpiredShadowJobs(env, { retentionDays: 30, limit: 100 });
		expect(purged).toBeGreaterThanOrEqual(1);
		const job = await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(job).toBe(null);
	});
});
