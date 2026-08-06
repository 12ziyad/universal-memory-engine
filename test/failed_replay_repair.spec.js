/**
 * Replay of a failed-terminal extract job (campaign 2026-08-07, defect SRV-02).
 *
 * Live reproduction that motivated this: a Codex plugin delivery aborted
 * client-side after the server had created the job; the handoff was lost, the
 * reconciliation sweep correctly failed the orphan at its 15-minute margin —
 * and the plugin's later idempotent replay then received an acceptance-shaped
 * `ok:true` for a job that never extracted anything. The plugin deleted its
 * local copy: silent accepted-data loss reported as success.
 *
 * Contract under test:
 *  - An exact-content replay of a failed extract job REPAIRS it (re-queues and
 *    re-hands-off) instead of echoing a phantom acceptance (invariant I1).
 *  - Repairs are bounded: past the attempt bound the door answers with an
 *    honest non-acceptance (422 extraction_failed_terminal) so callers keep
 *    their durable local copy (invariant I23).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

async function call(method, path, body) {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

function ingestBody(userId, idempotencyKey, label, extra = {}) {
	return {
		userId,
		flush: true,
		idempotencyKey,
		messages: [{ id: "m1", role: "user", content: `I am building project ${label} this month`, ts: Date.now() }],
		...extra,
	};
}

async function orphanFailedJob(userId, idempotencyKey, { attempts = 0 } = {}) {
	// Reproduce the exact production sequence: the D1 job row exists but the
	// Durable Object never received the handoff (client abort window)…
	const interrupted = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Repairable", {
		_test: { _testIngestFault: "after_job_claim", llmResponse: canned("Repairable") },
	}));
	expect(interrupted.status).toBe(500);
	// …then the reconciliation sweep passes its orphan margin and fails it.
	await env.DB.prepare(
		`UPDATE memory_jobs SET status = 'failed', attempts = ?, completed_at = ?, updated_at = ?,
		 error = 'work never reached the queue — no durable entry exists for this job, so it can never be processed'
		 WHERE user_id = ? AND idempotency_key = ?`,
	).bind(attempts, Date.now(), Date.now(), userId, idempotencyKey).run();
	const row = await env.DB.prepare(
		"SELECT id, status FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
	).bind(userId, idempotencyKey).first();
	expect(row.status).toBe("failed");
	return row.id;
}

describe("replay of a failed-terminal extract job", () => {
	it("repairs the sweep-failed orphan instead of confirming a phantom acceptance", async () => {
		const userId = `failed-replay-repair-${crypto.randomUUID()}`;
		const idempotencyKey = `failed-replay-key-${crypto.randomUUID()}`;
		const jobId = await orphanFailedJob(userId, idempotencyKey);

		const replay = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Repairable", {
			_test: { llmResponse: canned("Repairable") },
		}));

		expect(replay.status).toBe(200);
		expect(replay.body.ok).toBe(true);
		// The replay must put the work back in flight, not echo the dead verdict.
		expect(replay.body.receipt?.status).not.toBe("failed");

		const job = await env.DB.prepare(
			"SELECT id, status, error FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, idempotencyKey).first();
		expect(job.id).toBe(jobId);
		expect(job.status).toBe("enriched");

		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(nodes.n).toBeGreaterThan(0);
	});

	it("keeps the repaired job's packet/receipt correlation exact", async () => {
		const userId = `failed-replay-packet-${crypto.randomUUID()}`;
		const idempotencyKey = `failed-replay-packet-key-${crypto.randomUUID()}`;
		await orphanFailedJob(userId, idempotencyKey);

		const replay = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Repairable", {
			_test: { llmResponse: canned("Repairable") },
		}));
		expect(replay.status).toBe(200);
		expect(replay.body.source_packet_id).toMatch(/^src_/);

		const counts = await env.DB.prepare(
			`SELECT COUNT(*) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs
			 FROM source_packets WHERE user_id = ?`,
		).bind(userId, idempotencyKey, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 1 });
	});

	it("answers honestly (422, not acceptance-shaped) once the repair bound is exhausted", async () => {
		const userId = `failed-replay-bound-${crypto.randomUUID()}`;
		const idempotencyKey = `failed-replay-bound-key-${crypto.randomUUID()}`;
		await orphanFailedJob(userId, idempotencyKey, { attempts: 5 });

		const replay = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Repairable", {
			_test: { llmResponse: canned("Repairable") },
		}));

		expect(replay.status).toBe(422);
		expect(replay.body.ok).not.toBe(true);
		expect(replay.body.error).toBe("extraction_failed_terminal");
		// The caller must be able to see which packet/job this verdict belongs to.
		expect(replay.body.job_id).toMatch(/^job_/);

		const job = await env.DB.prepare(
			"SELECT status FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, idempotencyKey).first();
		expect(job.status).toBe("failed");
	});

	it("still returns the original receipt for enriched-terminal replays (unchanged contract)", async () => {
		const userId = `enriched-replay-${crypto.randomUUID()}`;
		const idempotencyKey = `enriched-replay-key-${crypto.randomUUID()}`;
		const first = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Stable", {
			_test: { llmResponse: canned("Stable") },
		}));
		expect(first.status).toBe(200);

		const replay = await call("POST", "/v1/ingest", ingestBody(userId, idempotencyKey, "Stable", {
			_test: { llmResponse: canned("Stable") },
		}));
		expect(replay.status).toBe(200);
		expect(replay.body.ok).toBe(true);
		expect(replay.body.duplicate).toBe(true);

		// The account may hold internal maintenance jobs; the replay invariant is
		// scoped to the idempotency key: exactly one job ever exists for it.
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, idempotencyKey).first();
		expect(jobs.n).toBe(1);
	});
});
