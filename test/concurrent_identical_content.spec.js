/**
 * A4 PASS C — the duplicate-under-concurrency class, imported from a mature
 * system's production defect rather than invented here.
 *
 * Mem0 issue #6531 ("hash-dedup TOCTOU race in add() creates duplicate
 * memories under concurrency"): two calls extracting an identical fact for the
 * same scope, awaited concurrently, both snapshot before either inserts, both
 * pass dedup, both insert — a permanent duplicate.
 *
 * Itsuki SHOULD be structurally immune: the per-account Durable Object
 * serializes all work for one account, so two submissions cannot interleave a
 * read-modify-write. The campaign rules forbid asserting that without proof —
 * and our existing convergence tests all use the SAME idempotency key, which
 * short-circuits at the door long before the graph. This one deliberately uses
 * DIFFERENT keys with IDENTICAL content, so the door cannot dedupe it and the
 * question reaches the extraction/entity-resolution path where Mem0's race
 * lives.
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function ingest(body) {
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

// One fact, deterministic extraction: whatever the pipeline does with it,
// "Halcyon Robotics" is the entity both submissions describe.
const extraction = {
	objects: [
		{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
		{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
	],
	notes: "",
};

async function drain(userId, rounds = 40) {
	const stub = stubFor(userId);
	for (let i = 0; i < rounds; i++) {
		const remaining = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched','failed','completed')",
		).bind(userId).first();
		if (Number(remaining?.n ?? 0) === 0) break;
		await runInDurableObject(stub, (instance) => instance.alarm());
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
}

describe("identical content submitted concurrently under different keys", () => {
	it("resolves onto one durable entity instead of duplicating it (Mem0 #6531 class)", async () => {
		const userId = `toctou-${crypto.randomUUID()}`;
		const content = "I started a new job at Halcyon Robotics as a firmware engineer.";
		const message = (id) => [{ id, role: "user", content }];

		// Different idempotency keys: the door CANNOT dedupe these, so the
		// question genuinely reaches entity resolution.
		const [left, right] = await Promise.all([
			ingest({ userId, flush: true, idempotencyKey: `toctou-a-${crypto.randomUUID()}`, messages: message("m-a"), _test: { llmResponse: extraction } }),
			ingest({ userId, flush: true, idempotencyKey: `toctou-b-${crypto.randomUUID()}`, messages: message("m-b"), _test: { llmResponse: extraction } }),
		]);
		expect([left.status, right.status]).toEqual([200, 200]);
		// Two distinct accepted packets — this is NOT the same-key replay path.
		expect(left.body.source_packet_id).not.toBe(right.body.source_packet_id);

		await drain(userId);

		const jobs = await env.DB.prepare(
			"SELECT status, COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND type = 'extract' GROUP BY status",
		).bind(userId).all();
		// Both accepted extract jobs must reach a terminal state — neither may
		// be abandoned because the other won the race.
		const terminal = (jobs.results ?? []).filter((r) => ["enriched", "completed"].includes(r.status))
			.reduce((total, r) => total + Number(r.n), 0);
		expect(terminal).toBe(2);

		// The invariant Mem0 lost: one fact, one durable entity.
		const nodes = await env.DB.prepare(
			"SELECT id, label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		const halcyon = (nodes.results ?? []).filter((n) => /halcyon/i.test(String(n.label)));
		console.error("TOCTOU-NODES", JSON.stringify((nodes.results ?? []).map((n) => n.label)));
		expect(halcyon.length).toBe(1);

		await stubFor(userId).resetAll();
	});
});
