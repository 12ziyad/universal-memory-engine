/**
 * The bug this file exists for: two enqueue paths guarded by DIFFERENT locks
 * (addMessages under blockConcurrencyWhile, drain under the storage lease)
 * both derived a queue key from a non-atomic counter. Under a concurrent
 * burst they could produce the SAME key, and the second `put` silently
 * overwrote the first — the overwritten batch's job rows then sat at
 * `queued`/attempts=0 forever, unreachable by any drain and immune to the
 * sweep's kick. Measured on production: 10 of a 20-wide add() burst lost.
 *
 * test/queue_invariants.spec.js covers concurrency against a HELD LEASE, which
 * is a different thing entirely: there, every call is politely turned away and
 * the work is enqueued correctly. It could never have caught this, because the
 * loss happens precisely when enqueues DO proceed, simultaneously.
 */

import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

const WORDS = [
	"Albatross", "Begonia", "Cardamom", "Dorado", "Elderflower", "Fennel", "Ginkgo",
	"Hyacinth", "Iris", "Juniper", "Kelp", "Larkspur", "Mulberry", "Nasturtium",
	"Oleander", "Pennyroyal", "Quince", "Rosemary", "Sorrel", "Tarragon",
];

const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

/** One add() — the lane the production loss happened on. */
async function addCall(userId, label) {
	const request = new Request("http://example.com/v1/save", {
		method: "POST",
		headers,
		body: JSON.stringify({
			userId,
			content: `I am building project ${label} this month`,
			_test: { llmResponse: canned(label), waitBudgetMs: 1 },
		}),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	const body = await response.json();
	await waitOnExecutionContext(ctx);
	return { status: response.status, body };
}

async function jobsOf(userId) {
	const { results } = await env.DB.prepare(
		"SELECT id, status, attempts, payload_json FROM memory_jobs WHERE user_id = ? AND type = 'extract'",
	).bind(userId).all();
	return results ?? [];
}

async function drainAll(userId, rounds = 40) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < rounds; i++) {
		const res = await stub.drain({ userId, maxJobs: 10, ignoreBackoff: true });
		if (!res.leased && res.remaining === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("queue did not drain");
}

describe("20 concurrent add() calls", () => {
	it("every one of the 20 job rows reaches a terminal state — none orphaned", async () => {
		const userId = `burst-${crypto.randomUUID()}`;

		// Fired simultaneously, exactly as an integrator's thread pool would.
		const results = await Promise.all(WORDS.map((label) => addCall(userId, label)));
		expect(results.every((r) => r.status === 200)).toBe(true);

		const accepted = await jobsOf(userId);
		expect(accepted).toHaveLength(20); // a job row per accepted write (1.1)

		await drainAll(userId);

		const settled = await jobsOf(userId);
		expect(settled).toHaveLength(20);
		const terminal = settled.filter((j) => ["enriched", "failed"].includes(j.status));
		const stuck = settled.filter((j) => !["enriched", "failed"].includes(j.status));
		// The exact assertion that would have caught the production bug: a job
		// left at queued/attempts=0 is work no drain can ever reach.
		expect(stuck.map((j) => `${j.id}:${j.status}:attempts=${j.attempts}`)).toEqual([]);
		expect(terminal).toHaveLength(20);
		expect(settled.filter((j) => j.status === "failed")).toHaveLength(0);

		// And the memories actually landed — terminal must not mean "gave up".
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes.length).toBe(20);

		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
		expect((await stub.getDebugState()).chunkSize).toBe(0);
		await stub.resetAll();
	}, 60000);
});

describe("queue keys are collision-proof", () => {
	it("concurrent enqueues never overwrite each other — no message is lost", async () => {
		const userId = `qkey-${crypto.randomUUID()}`;
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

		// Drive addMessages and drain simultaneously: the two paths whose
		// different locks let the old counter collide.
		await runInDurableObject(stub, async (instance, state) => {
			const enqueues = [];
			for (let i = 0; i < 24; i++) {
				enqueues.push(instance.addMessages(userId, [{
					id: `m${i}`,
					role: "user",
					content: `I started learning ${WORDS[i % WORDS.length]} techniques this week`,
					ts: Date.now(),
				}], { flush: true }));
				// Interleave drains, which also enqueue (held chunk -> queue).
				if (i % 4 === 3) enqueues.push(instance.drain({ userId, maxJobs: 0 }));
			}
			await Promise.all(enqueues);

			// Conservation: every message that was accepted is still somewhere —
			// in a queue entry or in the held chunk. Nothing silently vanished.
			const entries = await state.storage.list({ prefix: "q:" });
			const seen = new Set();
			for (const [, entry] of entries) {
				for (const m of entry.messages ?? []) seen.add(m.id);
			}
			for (const m of (await state.storage.get("chunk")) ?? []) seen.add(m.id);
			const missing = Array.from({ length: 24 }, (_, i) => `m${i}`).filter((id) => !seen.has(id));
			expect(missing).toEqual([]);

			// Keys carry the uniqueness suffix that makes a counter tie harmless.
			for (const key of entries.keys()) {
				expect(key).toMatch(/^q:\d{10}-[0-9a-f]{8}$/);
			}
		});
		await stub.resetAll();
	}, 60000);
});

describe("two enqueues that compute the same sequence number", () => {
	it("both survive — the second must not overwrite the first", async () => {
		const userId = `qcollide-${crypto.randomUUID()}`;
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

		await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [{
				id: "first", role: "user", ts: Date.now(),
				content: "I started open water swimming with the Tagus club this spring",
			}], { flush: true });

			// Rewind the counter. This reproduces the OBSERVABLE CONSEQUENCE of
			// the production race deterministically: two enqueues computing the
			// same sequence number. The race itself needs an interleaving the
			// test runtime will not reliably produce, but its result is exactly
			// this — and on the old `q:${seq}` key the second put silently
			// overwrote the first, taking a whole batch of accepted work with it.
			await state.storage.put("qseq", 0);

			await instance.addMessages(userId, [{
				id: "second", role: "user", ts: Date.now(),
				content: "I also joined a ceramics class at the studio in Campo de Ourique",
			}], { flush: true });

			const entries = await state.storage.list({ prefix: "q:" });
			const messageIds = new Set();
			for (const [, entry] of entries) {
				for (const m of entry.messages ?? []) messageIds.add(m.id);
			}
			expect(entries.size).toBe(2);
			expect([...messageIds].sort()).toEqual(["first", "second"]);
		});
		await stub.resetAll();
	}, 30000);
});

describe("the sweep resolves orphaned jobs instead of kicking them forever", () => {
	it("fails a job the Durable Object has no work for, and says so", async () => {
		const { runReconciliationSweep } = await import("../src/pipeline/sweep.js");
		const { createMemoryJob } = await import("../src/lib/db.js");
		const userId = `orphan-${crypto.randomUUID()}`;

		// A job row with NO queue entry behind it — exactly what the production
		// key collision left behind.
		const jobId = await createMemoryJob(env, userId, {
			type: "extract",
			status: "queued",
			idempotencyKey: `orphan-test-${userId}`,
			payload: { lane: "manual_direct", message_ids: ["ghost"], remaining: ["ghost"] },
		});
		expect(jobId).toBeTruthy();
		const old = Date.now() - 30 * 60 * 1000;
		await env.DB.prepare("UPDATE memory_jobs SET created_at = ?, updated_at = ? WHERE id = ?")
			.bind(old, old, jobId).run();

		const result = await runReconciliationSweep(env);

		const row = await env.DB.prepare("SELECT status, error FROM memory_jobs WHERE id = ?")
			.bind(jobId).first();
		expect(row.status).toBe("failed");
		expect(row.error).toMatch(/never reached the queue/);
		expect(result.orphaned.some((o) => o.userId === userId)).toBe(true);
		// It must NOT be counted as a rescue it never achieved.
		expect(result.rescued.some((r) => r.userId === userId)).toBe(false);

		const report = await env.DB.prepare(
			"SELECT message FROM error_reports WHERE scope = 'sweep_orphaned_jobs' ORDER BY created_at DESC LIMIT 1",
		).first();
		expect(report?.message).toMatch(/RED ALERT/);
	}, 60000);
});
