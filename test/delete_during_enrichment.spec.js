/**
 * A4 PASS B — deletion racing an accepted-but-unenriched job.
 *
 * The user's mental model: "I deleted my memories" means what lands AFTER the
 * delete does not silently resurrect them. The accepted-work contract says an
 * accepted job completes to a visible terminal state — so the QUESTION this
 * spec pins is what a bulk delete issued in the acceptance window does to the
 * job's eventual output. Hidden residue (content reappearing durably after a
 * confirmed delete, with the user told "deleted") is the DANGEROUS class.
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(method, path, body) {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let parsed = null;
	try { parsed = await response.json(); } catch {}
	return { status: response.status, body: parsed };
}

const stubFor = (userId) => env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

async function holdLease(userId) {
	const stub = stubFor(userId);
	await runInDurableObject(stub, async (_i, state) => {
		await state.storage.put("lease", { until: Date.now() + 120_000, token: "delete-race-hold" });
	});
	return stub;
}

const extraction = {
	objects: [
		{ kind: "node", label: "Meridian payroll cadence", category: "other", confidence: 0.9 },
		{ kind: "slice", on: "Meridian payroll cadence", text: "Payroll at Meridian runs on the 25th.", kind_detail: "other", confidence: 0.9 },
	],
	notes: "",
};

describe("bulk delete racing an accepted, unenriched job", () => {
	it("content accepted BEFORE a confirmed delete-everything does not silently resurrect after it", async () => {
		const userId = `delete-race-${crypto.randomUUID()}`;
		const stub = await holdLease(userId);

		const save = await call("POST", "/v1/ingest", {
			userId, flush: true, idempotencyKey: `delete-race-${crypto.randomUUID()}`,
			messages: [{ id: "m1", role: "user", content: "Payroll at Meridian runs on the 25th of every month." }],
			_test: { llmResponse: extraction },
		});
		expect(save.status).toBe(200);

		// The user deletes everything while the job is still queued. The
		// preview must SAY accepted work is still processing (SRV-06 honesty
		// half) — an unqualified zero here is how memory "reappears".
		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}`);
		expect(preview.body?.pending_jobs).toBeGreaterThan(0);
		expect(String(preview.body?.note ?? "")).toMatch(/still processing/i);
		const confirmed = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&confirm=true`);
		expect(confirmed.status).toBe(200);
		expect(confirmed.body?.staged_settled).toBeGreaterThan(0);

		// Staging must not answer with the deleted content either.
		const stagedRecall = await call("POST", "/v1/recall", { userId, query: "When does payroll run at Meridian?" });
		const stagedCtx = String(stagedRecall.body?.context ?? "");

		// Release the queue: the accepted job now runs to its terminal state.
		await runInDurableObject(stub, async (_i, state) => { await state.storage.delete("lease"); });
		await runInDurableObject(stub, (instance) => instance.alarm());
		let job = null;
		for (let i = 0; i < 20; i++) {
			job = await env.DB.prepare(
				"SELECT status FROM memory_jobs WHERE user_id = ? LIMIT 1",
			).bind(userId).first();
			if (job && ["enriched", "failed", "completed"].includes(job.status)) break;
			await new Promise((r) => setTimeout(r, 250));
			await runInDurableObject(stubFor(userId), (instance) => instance.alarm());
		}

		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		const recall = await call("POST", "/v1/recall", { userId, query: "When does payroll run at Meridian?" });
		const recallCtx = String(recall.body?.context ?? "");
		const postDry = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}`);

		// Contract: no hidden residue. Either the write is suppressed, or it is
		// VISIBLE to a follow-up delete preview (the user can see and remove
		// it) — what it must never be is recallable while a fresh delete
		// preview claims there is nothing to delete.
		const wouldDelete = Object.values(postDry.body?.would_delete ?? {}).some((v) => Number(v) > 0);
		const recallable = /25th|Meridian/i.test(recallCtx);
		expect(recallable && !wouldDelete, "hidden residue: recallable content invisible to delete").toBe(false);
		// And the pre-enrichment staging window must not leak deleted content.
		expect(/25th/i.test(stagedCtx), "staged window leaked deleted content").toBe(false);

		await stub.resetAll();
	});
});
