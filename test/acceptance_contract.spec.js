/**
 * A2 — Acceptance-semantics contract (campaign 2026-08-07).
 *
 * "ACCEPTED" means: the full scrubbed payload is durable in the per-account
 * Durable Object queue AND a visible D1 job row exists, both BEFORE the HTTP
 * response. A client may release its local copy exactly when it has parsed an
 * acceptance carrying durable identifiers; from that moment the server owns
 * progress to a VISIBLE terminal state (a0-architecture-decision.md §5).
 *
 * These tests pin the ORDER so a refactor cannot silently move durability
 * after the response. The deeper behaviors live in their own suites:
 * crash-window replay repair (ingest_contract_http), failed-terminal honesty
 * (failed_replay_repair), DO handoff serialization (do_ingest_handoff),
 * poison quarantine (codex_outbox_recovery).
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const emptyExtraction = { objects: [], notes: "nothing extractable" };

async function call(body) {
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

const stubFor = (userId) => env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

async function doDurableText(userId) {
	// Everything the DO holds durably for this account: queued chunks, held
	// buffer, handoff markers. The payload must be findable in here the moment
	// an acceptance response exists.
	return runInDurableObject(stubFor(userId), async (_instance, state) => {
		const all = await state.storage.list();
		return JSON.stringify([...all.entries()]);
	});
}

async function holdLease(userId) {
	const stub = stubFor(userId);
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put("lease", { until: Date.now() + 120_000, token: "acceptance-contract-hold" });
	});
	return stub;
}

async function jobRow(userId, idempotencyKey) {
	return env.DB.prepare(
		"SELECT id, status, source_packet_id FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
	).bind(userId, idempotencyKey).first();
}

describe("acceptance contract - order and ownership", () => {
	it("an acceptance response implies BOTH durable stores were written first", async () => {
		const userId = `accept-order-${crypto.randomUUID()}`;
		const idempotencyKey = `accept-order-key-${crypto.randomUUID()}`;
		const content = "I decided the tide-pool exporter publishes its ledger at dawn.";
		const stub = await holdLease(userId); // nothing drains: freeze the accepted state

		const res = await call({
			userId, flush: true, idempotencyKey,
			messages: [{ id: "m1", role: "user", content }],
			_test: { llmResponse: emptyExtraction },
		});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		// Identifiers are durable references, not decorations.
		expect(res.body.source_packet_id).toMatch(/^src_/);
		expect(res.body.job_id).toMatch(/^job_/);

		const job = await jobRow(userId, idempotencyKey);
		expect(job).toMatchObject({ id: res.body.job_id, source_packet_id: res.body.source_packet_id });
		expect(["queued", "processing"]).toContain(job.status);

		const packet = await env.DB.prepare(
			"SELECT id FROM source_packets WHERE user_id = ? AND id = ?",
		).bind(userId, res.body.source_packet_id).first();
		expect(packet).not.toBeNull();

		// The full payload sits in DO storage — acceptance was not a promise.
		expect(await doDurableText(userId)).toContain("tide-pool exporter");

		await stub.resetAll();
	});

	it("the D1 job row precedes both the DO write and the response", async () => {
		const userId = `accept-job-first-${crypto.randomUUID()}`;
		const idempotencyKey = `accept-job-first-key-${crypto.randomUUID()}`;

		const interrupted = await call({
			userId, flush: true, idempotencyKey,
			messages: [{ id: "m1", role: "user", content: "I chose the basalt footbridge naming scheme." }],
			_test: { _testIngestFault: "after_job_claim", llmResponse: emptyExtraction },
		});
		// The client saw NO acceptance: ownership never transferred, and the
		// response must not be acceptance-shaped.
		expect(interrupted.status).toBe(500);
		expect(interrupted.body?.ok).not.toBe(true);
		expect(interrupted.body?.source_packet_id).toBeUndefined();

		// Yet the job row is already durable — the visible record every later
		// repair (sweep orphan-fail, replay) hangs off.
		const job = await jobRow(userId, idempotencyKey);
		expect(job).not.toBeNull();
		expect(job.status).toBe("queued");

		// And the DO never saw the payload: this is the designed
		// UNACKNOWLEDGED window the client-side outbox covers by retention.
		expect(await doDurableText(userId)).not.toContain("basalt footbridge");
	});

	it("after DO durability the server finishes the work without the client", async () => {
		const userId = `accept-liveness-${crypto.randomUUID()}`;
		const idempotencyKey = `accept-liveness-key-${crypto.randomUUID()}`;

		// Response LOST after the payload became durable — the harshest
		// post-durability case: the client never even parsed the acceptance.
		const interrupted = await call({
			userId, flush: true, idempotencyKey,
			messages: [{ id: "m1", role: "user", content: "I decided the saffron orchard exporter ships nightly." }],
			_test: { _testIngestFault: "after_do_accept", llmResponse: emptyExtraction },
		});
		expect(interrupted.status).toBe(500);

		const before = await jobRow(userId, idempotencyKey);
		expect(before).not.toBeNull();
		expect(await doDurableText(userId)).toContain("saffron orchard");

		// No further client call: the DO's own alarm must drive the accepted
		// work to a visible terminal state (Invariant B, liveness ownership).
		await runInDurableObject(stubFor(userId), (instance) => instance.alarm());

		let after = null;
		for (let i = 0; i < 20; i++) {
			after = await jobRow(userId, idempotencyKey);
			if (after && ["enriched", "failed", "completed"].includes(after.status)) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
			if (i === 19) break;
			await runInDurableObject(stubFor(userId), (instance) => instance.alarm());
		}
		expect(after).not.toBeNull();
		expect(["enriched", "completed"]).toContain(after.status);
	});
});
