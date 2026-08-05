/**
 * Fix round 1, Part 1 — the write path can never lose work.
 *
 * The invariant under test: every accepted write (a memory_jobs row created
 * at the door) ends in exactly one of two visible terminal states — enriched
 * or failed — regardless of concurrency, crashes mid-job, or poison input.
 * Zero silent errors, by construction.
 *
 * Alarms are disabled in the test pool (DO_WAKE_ALARMS=false); tests stand in
 * for the alarm/sweep by draining explicitly, which is the same code path.
 */

import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { settleMemoryJobs } from "../src/lib/db.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

const WORDS = ["Albatross","Begonia","Cardamom","Dorado","Elderflower"];
const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

async function ingest(userId, messages, opts = {}) {
	const body = { userId, messages, flush: opts.flush ?? true };
	if (opts.idempotencyKey) body.idempotencyKey = opts.idempotencyKey;
	if (opts.llmResponse !== undefined) body._test = { llmResponse: opts.llmResponse };
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function extractJobs(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE user_id = ? AND type = 'extract' ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

async function holdLease(stub, ms = 60_000) {
	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.put("lease", { until: Date.now() + ms, token: "test-hold" });
	});
}

async function dropLease(stub) {
	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.delete("lease");
	});
}

async function drainAll(userId, overrides = null, rounds = 20) {
	const stub = stubFor(userId);
	for (let i = 0; i < rounds; i++) {
		const res = await stub.drain({ userId, maxJobs: 10, ignoreBackoff: true, inlineOverrides: overrides ?? undefined });
		if (!res.leased && res.remaining === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("queue did not drain");
}

const msg = (id, content) => ({ id, role: "user", content, ts: Date.now() });

describe("concurrency: fires during an active lease", () => {
	it("5 fires while the lease is held -> all 5 accepted, all 5 eventually enriched, zero lost", async () => {
		const userId = `q-lease-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);

		// 5 rapid saves; every inline drain sees the lease and backs off.
		for (let i = 1; i <= 5; i++) {
			const res = await ingest(userId, [msg(`c${i}`, `I am building project ${WORDS[i-1]} this month`)], {
				llmResponse: canned(`${WORDS[i-1]}`),
			});
			expect(res.status).toBe(200);
			expect(res.body.fired).toBe(true);
		}

		// Nothing processed yet — the work is durably queued, not lost.
		const before = await extractJobs(userId);
		expect(before).toHaveLength(5);
		expect(before.every((j) => ["queued", "processing"].includes(j.status))).toBe(true);
		const debugHeld = await stub.getDebugState();
		expect(debugHeld.queuedEntries).toBeGreaterThan(0);

		// Lease-holder dies (isolate eviction stand-in) -> anyone can drain.
		await dropLease(stub);
		await drainAll(userId);

		const after = await extractJobs(userId);
		expect(after).toHaveLength(5);
		expect(after.map((j) => j.status)).toEqual(["enriched", "enriched", "enriched", "enriched", "enriched"]);
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes.length).toBe(5);
		expect((await stub.getDebugState()).chunkSize).toBe(0);
		await stub.resetAll();
	}, 30000);
});

describe("chaos: a throw mid-job", () => {
	it("is retried without duplicate graph rows or a partial commit", async () => {
		const userId = `q-chaos-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);
		await ingest(userId, [msg("x1", "I am building project Chaos this month")], {
			llmResponse: canned("Chaos"),
		});
		await dropLease(stub);

		// First drain: the model call dies mid-job. The entry survives with
		// attempts=1; the job row is visibly `processing`, never silently gone.
		// The bomb runs in-isolate (runInDurableObject) — a throwing function
		// must not cross the JSRPC boundary or its stub leaks into teardown.
		await runInDurableObject(stub, async (instance) => {
			const bomb = () => { throw new Error("simulated isolate death"); };
			await instance.drain({ userId, maxJobs: 10, ignoreBackoff: true, inlineOverrides: { llmResponse: bomb } });
		});
		const mid = await extractJobs(userId);
		expect(mid).toHaveLength(1);
		expect(["queued", "processing"]).toContain(mid[0].status);
		// No partial graph rows landed.
		const { results: midNodes } = await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ?",
		).bind(userId).all();
		expect(midNodes).toHaveLength(0);

		// Retry succeeds (entry.overrides still carry the canned response).
		await drainAll(userId);
		const after = await extractJobs(userId);
		expect(after[0].status).toBe("enriched");
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes).toHaveLength(1); // exactly one — no duplicates from the retry
		await stub.resetAll();
	}, 30000);
});

describe("cross-packet queue ownership", () => {
	it("splits held jobs and never links one packet's receipt to another", async () => {
		const userId = `q-attribution-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);
		const first = await ingest(userId, [msg("owner-a", "The Atlas cache policy remains conservative.")], {
			flush: false,
			idempotencyKey: `packet-a-${userId}`,
			llmResponse: canned("Atlas"),
		});
		const second = await ingest(userId, [msg("owner-b", "The Borealis release policy remains conservative.")], {
			flush: true,
			idempotencyKey: `packet-b-${userId}`,
			llmResponse: canned("Borealis"),
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);

		const queued = await runInDurableObject(stub, async (_instance, state) => (
			[...(await state.storage.list({ prefix: "q:" })).values()]
				.filter((entry) => entry.kind === "extract")
		));
		expect(queued).toHaveLength(2);
		expect(queued.map((entry) => new Set(Object.values(entry.jobByMessage ?? {})).size)).toEqual([1, 1]);

		await dropLease(stub);
		await drainAll(userId);
		const { results } = await env.DB.prepare(
			`SELECT j.source_packet_id, j.receipt_id, r.source_packet_id AS receipt_source_packet_id
			 FROM memory_jobs j
			 LEFT JOIN receipts r ON r.id = j.receipt_id AND r.user_id = j.user_id
			 WHERE j.user_id = ? AND j.type = 'extract'
			 ORDER BY j.created_at`,
		).bind(userId).all();
		expect(results).toHaveLength(2);
		for (const row of results) {
			expect(row.receipt_id).toBeTruthy();
			expect(row.receipt_source_packet_id).toBe(row.source_packet_id);
		}
		await stub.resetAll();
	}, 30_000);

	it("keeps the queue entry when terminal job settlement is interrupted", async () => {
		const userId = `q-settle-fault-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);
		await ingest(userId, [msg("settle-fault", "I am building project Settlement this month")], {
			idempotencyKey: `settle-fault-${userId}`,
			llmResponse: canned("Settlement"),
		});
		await dropLease(stub);

		await runInDurableObject(stub, async (instance, state) => {
			const interrupted = await instance.drain({
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					_testBeforeJobSettlement: () => { throw new Error("simulated D1 settlement outage"); },
				},
			});
			expect(interrupted.results[0]).toMatchObject({
				outcome: "settlement_pending",
				retry: true,
				attempts: 1,
			});
			const queued = [...(await state.storage.list({ prefix: "q:" })).values()];
			expect(queued).toHaveLength(1);
			expect(queued[0]).toMatchObject({ phase: "settlement_pending", settlementAttempts: 1 });
			expect(queued[0].runAfter).toBeGreaterThan(Date.now());
		});
		expect((await stub.getDebugState()).queuedEntries).toBe(1);
		expect((await extractJobs(userId))[0].status).not.toBe("enriched");

		await drainAll(userId);
		expect((await extractJobs(userId))[0].status).toBe("enriched");
		const { results: nodes } = await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes).toHaveLength(1);
		await stub.resetAll();
	}, 30_000);

	it("does not add saved counts twice when a partially settled entry replays", async () => {
		const userId = `q-count-replay-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO memory_jobs
			 (id, user_id, type, status, idempotency_key, attempts, payload_json, run_after, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'processing', ?, 0, ?, 0, ?, ?)`,
		).bind(
			jobId,
			userId,
			`count-replay-${userId}`,
			JSON.stringify({ message_ids: ["m1", "m2"], remaining: ["m1", "m2"] }),
			Date.now(),
			Date.now(),
		).run();
		const update = [{
			jobId,
			messageIds: ["m1"],
			disposition: "processed",
			counts: { nodes: 1, slices: 2 },
		}];
		await settleMemoryJobs(env, userId, update, { strict: true });
		await settleMemoryJobs(env, userId, update, { strict: true });
		const row = await env.DB.prepare(
			"SELECT status, payload_json FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(jobId, userId).first();
		const payload = JSON.parse(row.payload_json);
		expect(row.status).toBe("processing");
		expect(payload.remaining).toEqual(["m2"]);
		expect(payload.saved).toMatchObject({ nodes: 1, slices: 2 });
	}, 30_000);
});

describe("deep queue visibility", () => {
	it("kick reports ownership beyond the former 256-entry scan ceiling", async () => {
		const userId = `q-deep-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await runInDurableObject(stub, async (_instance, state) => {
			for (let index = 0; index < 300; index++) {
				const messageId = `deep-message-${index}`;
				await state.storage.put(`q:${String(index).padStart(10, "0")}-deep`, {
					kind: "extract",
					messages: [],
					jobByMessage: { [messageId]: `job_deep_${index}` },
					runAfter: Date.now() + 60_000,
				});
			}
		});
		const state = await stub.kick(userId);
		expect(state.queued).toBe(300);
		expect(state.jobIds).toHaveLength(300);
		expect(state.jobIds).toContain("job_deep_299");
		await stub.resetAll();
	}, 30_000);
});

describe("poison: an entry that always fails", () => {
	it("dead-letters as `failed` after bounded attempts, reports to admin, and never blocks the queue", async () => {
		const userId = `q-poison-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);
		// Canned garbage: unparseable on every attempt, including split rescue.
		const poison = await ingest(userId, [msg("p1", "I am building project Poison this month")], {
			llmResponse: "%%% not json at all %%%",
		});
		expect(poison.body.fired).toBe(true);
		const good = await ingest(userId, [msg("g1", "I am building project Good this month")], {
			llmResponse: canned("Good"),
		});
		expect(good.body.fired).toBe(true);
		await dropLease(stub);

		await drainAll(userId);

		const jobsAfter = await extractJobs(userId);
		expect(jobsAfter).toHaveLength(2);
		const byId = new Map(jobsAfter.map((j) => [JSON.parse(j.payload_json).message_ids[0], j]));
		expect(byId.get("p1").status).toBe("failed");
		expect(byId.get("p1").error).toBeTruthy();
		// The queue moved past the poison: the good save landed.
		expect(byId.get("g1").status).toBe("enriched");
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes.map((n) => n.label)).toContain("Good");
		// Admin heard about it.
		const report = await env.DB.prepare(
			"SELECT * FROM error_reports WHERE user_id = ? AND scope = 'extract_poison'",
		).bind(userId).first();
		expect(report).toBeTruthy();
		await stub.resetAll();
	}, 30000);
});

describe("invariant: accepted == terminal", () => {
	it("N accepted packets under interleaving -> terminal states sum to N", async () => {
		const userId = `q-inv-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await holdLease(stub);

		// A mixed bag: durable saves, one noise-only packet (settles at the
		// door), one poison packet, submitted while nothing can process.
		const sent = [];
		for (let i = 1; i <= 4; i++) {
			sent.push(await ingest(userId, [msg(`n${i}`, `I am building project Inv${i} this month`)], {
				llmResponse: canned(`Inv${i}`),
			}));
		}
		sent.push(await ingest(userId, [msg("noise1", "ok")], { llmResponse: canned("unused") }));
		sent.push(await ingest(userId, [msg("bad1", "I am building project Bad this month")], {
			llmResponse: "%%% never parses %%%",
		}));
		expect(sent.every((r) => r.status === 200)).toBe(true);

		await dropLease(stub);
		await drainAll(userId);

		const all = await extractJobs(userId);
		expect(all).toHaveLength(6);
		const terminal = all.filter((j) => ["enriched", "failed"].includes(j.status));
		expect(terminal).toHaveLength(6); // accepted == enriched + failed, nothing in between
		expect(all.filter((j) => j.status === "failed")).toHaveLength(1);
		await stub.resetAll();
	}, 30000);
});

describe("regression: the load-test arrival pattern, small", () => {
	it("sequential batches + a concurrent burst -> accepted == enriched, failed == 0", async () => {
		const userId = `q-replay-${crypto.randomUUID()}`;
		const stub = stubFor(userId);

		// Phase A stand-in: sequential ingest batches (each drains inline).
		for (let b = 1; b <= 3; b++) {
			const res = await ingest(
				userId,
				[msg(`a${b}1`, `I am building project SeqA${b} this month`), msg(`a${b}2`, `SeqA${b} ships in June`)],
				{ llmResponse: canned(`SeqA${b}`) },
			);
			expect(res.status).toBe(200);
		}

		// Phase B/D stand-in: a burst that arrives while the lease is held —
		// the exact shape that stranded the Aug 2 run.
		await holdLease(stub);
		for (let i = 1; i <= 4; i++) {
			await ingest(userId, [msg(`b${i}`, `I am building project Burst${i} this month`)], {
				llmResponse: canned(`Burst${i}`),
			});
		}
		await dropLease(stub);
		await drainAll(userId);

		const all = await extractJobs(userId);
		expect(all).toHaveLength(7);
		const enriched = all.filter((j) => j.status === "enriched");
		const failed = all.filter((j) => j.status === "failed");
		expect(enriched.length + failed.length).toBe(7); // accepted == enriched + failed
		expect(failed).toHaveLength(0); // and failed == 0
		expect((await stub.getDebugState()).chunkSize).toBe(0); // zero pending after quiesce
		await stub.resetAll();
	}, 30000);
});
