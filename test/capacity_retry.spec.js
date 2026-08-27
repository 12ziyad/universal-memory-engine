/**
 * Launch hardening (2026-08-28) — the silent-write-loss fix, end to end.
 *
 * A Workers AI out-of-capacity refusal is transient by definition: before
 * this fix it was classified like any real extraction failure, burned the
 * 3-attempt poison ladder in ~35 seconds, and dead-lettered a healthy write
 * without the user ever hearing about it. Now capacity takes its own patient
 * ladder (MAX_CAPACITY_ATTEMPTS spaced retries, poison `attempts` untouched),
 * each retry mints a FRESH deterministic run id (a reused id would "recover"
 * the previous failed run without calling the model again), and only a
 * sustained multi-hour event produces a visible terminal failure.
 *
 * The fault is injected with `_test.llmFault = "capacity"`, which throws the
 * exact error shape the binding produces (code 3040 / "Out of capacity").
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

const msg = (id, content) => ({ id, role: "user", content, ts: Date.now() });

async function ingest(userId, messages, testOverrides) {
	const body = { userId, messages, flush: true, _test: testOverrides };
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST", headers, body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

async function drainRounds(userId, rounds) {
	const stub = stubFor(userId);
	for (let i = 0; i < rounds; i++) {
		const res = await stub.drain({ userId, maxJobs: 10, ignoreBackoff: true });
		if (!res.leased && res.remaining === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

async function extractJobs(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE user_id = ? AND type = 'extract' ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

describe("capacity gets the patient ladder, not the poison ladder", () => {
	it("stays visibly non-terminal through far more than 3 attempts, re-attempts with fresh run ids, and dead-letters loudly only when the ladder is exhausted", async () => {
		const userId = `q-capacity-${crypto.randomUUID()}`;
		const accepted = await ingest(userId, [msg("c1", "I am building project Capacity this month")], {
			llmFault: "capacity",
		});
		expect(accepted.status).toBe(200);
		expect(accepted.body.fired).toBe(true);

		// One drain = one capacity attempt for the entry (a drain skips an
		// entry it already attempted). Four explicit drains on top of the
		// door's inline attempt puts the count well past the 3-attempt poison
		// ceiling — and the job must STILL be non-terminal, which is the whole
		// fix: the old behavior had already dead-lettered by now.
		const stub = stubFor(userId);
		for (let i = 0; i < 4; i++) await stub.drain({ userId, maxJobs: 4, ignoreBackoff: true });
		let [job] = await extractJobs(userId);
		expect(job).toBeTruthy();
		expect(["queued", "staged", "processing"]).toContain(job.status);
		// The D1 column carries attempts+capacityAttempts for visibility.
		expect(Number(job.attempts)).toBeGreaterThan(3);

		// Exhaust the ladder.
		await drainRounds(userId, 12);
		[job] = await extractJobs(userId);
		expect(job.status).toBe("failed");
		expect(String(job.error)).toContain("workers_ai_capacity");

		// Every capacity attempt minted a fresh run id and actually re-called
		// the model: one failed extraction_runs row per attempt, all carrying
		// the capacity prefix. A reused id would have produced exactly one.
		const { results: runs } = await env.DB.prepare(
			"SELECT id, status, error FROM extraction_runs WHERE user_id = ?",
		).bind(userId).all();
		const capacityRuns = (runs ?? []).filter((run) => String(run.error ?? "").startsWith("workers_ai_capacity"));
		expect(capacityRuns.length).toBeGreaterThan(3);

		// No llm_failed receipt spam from the retry loop: capacity retries
		// store no failure receipt while the write is still being retried.
		const { results: receipts } = await env.DB.prepare(
			"SELECT outcome FROM receipts WHERE user_id = ?",
		).bind(userId).all();
		const outcomes = (receipts ?? []).map((row) => row.outcome);
		expect(outcomes.filter((outcome) => outcome === "llm_failed")).toHaveLength(0);
		expect(outcomes.filter((outcome) => outcome === "llm_capacity").length).toBeLessThanOrEqual(1);

		await stub.resetAll();
	}, 45_000);

	it("a genuine failure still dead-letters on the bounded poison ladder (capacity does not loosen it)", async () => {
		const userId = `q-capacity-poison-${crypto.randomUUID()}`;
		await ingest(userId, [msg("p1", "I am building project Poisoned this month")], {
			llmResponse: "%%% never parses %%%",
		});
		await drainRounds(userId, 8);
		const [job] = await extractJobs(userId);
		expect(job.status).toBe("failed");
		expect(Number(job.attempts)).toBeLessThanOrEqual(3);
		await stubFor(userId).resetAll();
	}, 45_000);

	it("recovery keeps the queue moving: a good save behind a capacity-stalled one still lands", async () => {
		const userId = `q-capacity-mixed-${crypto.randomUUID()}`;
		await ingest(userId, [msg("s1", "I am building project Stalled this month")], {
			llmFault: "capacity",
		});
		await ingest(userId, [msg("g1", "I am building project Golden this month")], {
			llmResponse: canned("Golden"),
		});
		await drainRounds(userId, 14);
		const jobs = await extractJobs(userId);
		const byMessage = new Map(jobs.map((job) => [JSON.parse(job.payload_json).message_ids[0], job]));
		expect(byMessage.get("g1")?.status).toBe("enriched");
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect((nodes ?? []).map((node) => node.label)).toContain("Golden");
		await stubFor(userId).resetAll();
	}, 45_000);
});
