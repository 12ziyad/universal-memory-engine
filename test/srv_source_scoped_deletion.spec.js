/**
 * SRV-01 / SRV-02 — production canary findings, reproduced locally.
 *
 * SRV-01: the REST doors accept a caller `source` ("ai-sdk", "mastra", …) in
 * the body — the published SDKs send it — and DROP it. Conversation-mode runs
 * are stamped source_mode='mcp_save', so a source-scoped preview/delete for
 * the caller's own lane matches nothing and reports zero while the content
 * stays live and recallable. Proven against production on 2026-08-15 with the
 * released ai-sdk-itsuki package.
 *
 * SRV-02: after an unscoped erase reported zero residue, rows re-materialized
 * (~60s later: a fresh extraction_run plus nodes/slices) with no new client
 * write. These tests drive every post-erase machine the harness can reach —
 * alarms, re-drains, the cron sweep — and assert nothing comes back.
 */

import { env, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { bulkDeleteBySource } from "../src/pipeline/cleanup.js";

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

const LIVE_TABLES = ["nodes", "slices", "edges", "events", "memory_pages", "candidates"];
async function liveCounts(userId) {
	const out = {};
	for (const table of LIVE_TABLES) {
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId).first();
		out[table] = Number(row?.n ?? 0);
	}
	out.total = LIVE_TABLES.reduce((n, t) => n + out[t], 0);
	return out;
}

const previewTotal = (body) => Object.values(body?.would_delete ?? {})
	.reduce((n, v) => n + Number(v || 0), 0);

/** Exactly what the published ai-sdk-itsuki/mastra-itsuki packages send. */
async function conversationSave(userId, { source, tag, conversationId, gadget = "Meridian" }) {
	return call("POST", "/v1/save", {
		userId,
		mode: "conversation",
		source,
		conversationId: conversationId ?? `srv01-${tag}`,
		idempotencyKey: `srv01-${tag}-${crypto.randomUUID()}`,
		messages: [
			{ id: `u-${tag}`, role: "user", content: `My ${tag} project uses the ${gadget} scheduler.` },
			{ id: `a-${tag}`, role: "assistant", content: "Noted." },
		],
		_test: {
			llmResponse: {
				objects: [
					{ kind: "node", label: `${tag} project`, category: "project", matches_existing: null, confidence: 0.95 },
					{ kind: "node", label: `${gadget} scheduler`, category: "other", matches_existing: null, confidence: 0.9 },
					{ kind: "slice", on: `${tag} project`, text: `${tag} project uses the ${gadget} scheduler`, kind_detail: "technical_detail", confidence: 0.9 },
					{ kind: "edge", from: `${tag} project`, to: `${gadget} scheduler`, type: "USES", confidence: 0.9 },
				],
				notes: "",
			},
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		},
	});
}

/** Live rows whose visible text mentions the tag — the row-level ground truth. */
async function rowsMentioning(userId, needle) {
	const like = `%${needle}%`;
	const slices = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM slices WHERE user_id = ? AND deleted_at IS NULL AND text LIKE ?",
	).bind(userId, like).first();
	const nodes = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND label LIKE ?",
	).bind(userId, like).first();
	return Number(slices?.n ?? 0) + Number(nodes?.n ?? 0);
}

/** The published SDK ingest lane (llama-index / camel adapters). */
async function ingestSave(userId, { source, tag }) {
	return call("POST", "/v1/ingest", {
		userId,
		flush: true,
		source,
		conversationId: `srv01-ingest-${tag}`,
		idempotencyKey: `srv01-ingest-${tag}-${crypto.randomUUID()}`,
		messages: [{ id: `m-${tag}`, role: "user", content: `The ${tag} pipeline deploys to the Aurelia cluster.` }],
		_test: {
			llmResponse: {
				objects: [
					{ kind: "node", label: `${tag} pipeline`, category: "project", matches_existing: null, confidence: 0.95 },
					{ kind: "slice", on: `${tag} pipeline`, text: `${tag} pipeline deploys to the Aurelia cluster`, kind_detail: "technical_detail", confidence: 0.9 },
				],
				notes: "",
			},
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		},
	});
}

async function settle(userId, { rounds = 24 } = {}) {
	for (let i = 0; i < rounds; i++) {
		const pending = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched','failed','completed')",
		).bind(userId).first();
		if (Number(pending?.n ?? 0) === 0) return true;
		await runInDurableObject(stubFor(userId), (instance) => instance.alarm());
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

describe("SRV-01: the caller's source survives into deletion scoping", () => {
	it("conversation-mode: source-scoped preview sees the rows and the delete removes them", async () => {
		const userId = `srv01-conv-${crypto.randomUUID()}`;
		const res = await conversationSave(userId, { source: "ai-sdk", tag: "atlas" });
		expect(res.status).toBe(200);
		await settle(userId);
		expect((await liveCounts(userId)).total).toBeGreaterThan(0);

		// The exact production sequence the released package performs.
		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=ai-sdk`);
		expect(preview.status).toBe(200);
		expect(previewTotal(preview.body), "source-scoped preview blind to conversation-capture rows").toBeGreaterThan(0);

		const confirmed = await call(
			"DELETE",
			`/v1/memories?userId=${encodeURIComponent(userId)}&source=ai-sdk&confirm=true&dry_run=false`,
		);
		expect(confirmed.status).toBe(200);
		expect((await liveCounts(userId)).total, "source-scoped delete left live rows").toBe(0);

		const recall = await call("POST", "/v1/recall", { userId, query: "What does the atlas project use?" });
		expect(/meridian/i.test(String(recall.body?.context ?? "")), "deleted content recallable").toBe(false);

		// Idempotent repetition converges and stays zero.
		const again = await call(
			"DELETE",
			`/v1/memories?userId=${encodeURIComponent(userId)}&source=ai-sdk&confirm=true&dry_run=false`,
		);
		expect(again.status).toBe(200);
		expect(previewTotal((await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=ai-sdk`)).body)).toBe(0);
		await stubFor(userId).resetAll();
	}, 30000);

	it("ingest lane: the caller's source scopes deletion the same way", async () => {
		const userId = `srv01-ingest-${crypto.randomUUID()}`;
		const res = await ingestSave(userId, { source: "llama-index", tag: "borealis" });
		expect(res.status).toBe(200);
		await settle(userId);
		expect((await liveCounts(userId)).total).toBeGreaterThan(0);

		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=llama-index`);
		expect(previewTotal(preview.body), "ingest-lane source invisible to preview").toBeGreaterThan(0);

		await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=llama-index&confirm=true&dry_run=false`);
		expect((await liveCounts(userId)).total).toBe(0);
		await stubFor(userId).resetAll();
	}, 30000);

	it("two sources in one space: deleting one leaves the other untouched", async () => {
		const userId = `srv01-mixed-${crypto.randomUUID()}`;
		// Distinct vocabulary per source so a shared node can never make the
		// survivor's content answer for the deleted one.
		await conversationSave(userId, { source: "ai-sdk", tag: "castor", gadget: "Meridian" });
		await conversationSave(userId, { source: "mastra", tag: "pollux", gadget: "Zephyr" });
		await settle(userId);
		expect(await rowsMentioning(userId, "castor")).toBeGreaterThan(0);
		expect(await rowsMentioning(userId, "pollux")).toBeGreaterThan(0);

		await call("DELETE", `${`/v1/memories?userId=${encodeURIComponent(userId)}`}&source=ai-sdk&confirm=true&dry_run=false`);

		// Row-level ground truth: castor (ai-sdk) gone, pollux (mastra) intact.
		expect(await rowsMentioning(userId, "castor"), "deleted source left live rows").toBe(0);
		expect(await rowsMentioning(userId, "Meridian"), "deleted source's gadget survived").toBe(0);
		expect(await rowsMentioning(userId, "pollux"), "sibling source was collateral damage").toBeGreaterThan(0);

		// And through the product surface: the deleted fact is unrecallable,
		// the sibling still answers.
		const castor = await call("POST", "/v1/recall", { userId, query: "What does the castor project use?" });
		expect(/meridian/i.test(String(castor.body?.context ?? "")), "deleted source still recallable").toBe(false);
		const pollux = await call("POST", "/v1/recall", { userId, query: "What does the pollux project use?" });
		expect(/zephyr/i.test(String(pollux.body?.context ?? "")), "sibling source no longer recallable").toBe(true);

		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		await stubFor(userId).resetAll();
	}, 30000);

	it("direct save lane: client.add(fact, {source}) rows scope exactly", async () => {
		// The published js-sdk's exact request shape: POST /v1/save, no mode,
		// content + source spread into the body.
		const userId = `srv01-direct-${crypto.randomUUID()}`;
		const res = await call("POST", "/v1/save", {
			userId,
			content: "The direct-save canary bird is a kestrel.",
			source: "canary",
			idempotencyKey: `srv01-direct-${crypto.randomUUID()}`,
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "direct-save canary", category: "other", matches_existing: null, confidence: 0.95 },
						{ kind: "slice", on: "direct-save canary", text: "the direct-save canary bird is a kestrel", kind_detail: "technical_detail", confidence: 0.9 },
					],
					notes: "",
				},
				edgeResponse: { edges: [] },
				reflexionResponse: { entities: [], facts: [], edges: [] },
			},
		});
		expect(res.status).toBe(200);
		await settle(userId);
		expect((await liveCounts(userId)).total).toBeGreaterThan(0);

		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=canary`);
		expect(previewTotal(preview.body), "direct-save source invisible to preview").toBeGreaterThan(0);
		await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=canary&confirm=true&dry_run=false`);
		expect((await liveCounts(userId)).total, "direct-save source-scoped delete left rows").toBe(0);
		await stubFor(userId).resetAll();
	}, 30000);

	it("an invalid source label is refused at both doors, not silently dropped", async () => {
		const userId = `srv01-invalid-${crypto.randomUUID()}`;
		// Write door: control characters / oversize labels are a 400.
		const bad = await call("POST", "/v1/save", {
			userId,
			content: "should never be stored under a broken label",
			source: "x".repeat(65),
		});
		expect(bad.status).toBe(400);
		const badIngest = await call("POST", "/v1/ingest", {
			userId,
			messages: [{ id: "m1", role: "user", content: "hello" }],
			source: "bad\u0000label",
		});
		expect(badIngest.status).toBe(400);
		// Delete door: an unmatchable filter is a 400, not a zero-count no-op.
		const badDelete = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=${encodeURIComponent("y".repeat(65))}`);
		expect(badDelete.status).toBe(400);
	}, 30000);

	it("a source that never wrote anything previews and deletes as zero, ok:true", async () => {
		const userId = `srv01-empty-${crypto.randomUUID()}`;
		await conversationSave(userId, { source: "ai-sdk", tag: "vega" });
		await settle(userId);

		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&source=never-used`);
		expect(preview.status).toBe(200);
		expect(previewTotal(preview.body)).toBe(0);
		const confirmed = await call(
			"DELETE",
			`/v1/memories?userId=${encodeURIComponent(userId)}&source=never-used&confirm=true&dry_run=false`,
		);
		expect(confirmed.status).toBe(200);
		// And the unrelated rows survived.
		expect((await liveCounts(userId)).total).toBeGreaterThan(0);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		await stubFor(userId).resetAll();
	}, 30000);
});

describe("SRV-02: deletion is durable against everything that runs later", () => {
	it("erase after enrichment, then drive every post-erase machine: nothing comes back", async () => {
		const userId = `srv02-post-${crypto.randomUUID()}`;
		await conversationSave(userId, { source: "ai-sdk", tag: "rigel" });
		await settle(userId);
		expect((await liveCounts(userId)).total).toBeGreaterThan(0);

		const erased = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(erased.ok).toBe(true);
		expect((await liveCounts(userId)).total).toBe(0);

		// Everything production runs afterwards: DO alarms, an explicit re-drain,
		// and the cron sweep — several rounds, matching the ~60s window in which
		// the production rows re-materialized.
		for (let round = 0; round < 6; round++) {
			await runInDurableObject(stubFor(userId), (instance) => instance.alarm());
			await runInDurableObject(stubFor(userId), (instance) =>
				instance.drain({ userId, ignoreBackoff: true }));
			const ctx = createExecutionContext();
			await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
			await waitOnExecutionContext(ctx);
			await new Promise((r) => setTimeout(r, 50));

			const live = await liveCounts(userId);
			expect(live.total, `round ${round}: rows re-materialized after erase: ${JSON.stringify(live)}`).toBe(0);
		}

		const recall = await call("POST", "/v1/recall", { userId, query: "What does the rigel project use?" });
		expect(/meridian/i.test(String(recall.body?.context ?? ""))).toBe(false);
		expect(previewTotal(await bulkDeleteBySource(env, userId, {}))).toBe(0);
		await stubFor(userId).resetAll();
	}, 60000);

	it("erase while the job is still queued, then drain: nothing lands, job terminal", async () => {
		const userId = `srv02-held-${crypto.randomUUID()}`;
		// Hold the queue so the save is accepted but unprocessed.
		await runInDurableObject(stubFor(userId), async (_i, state) => {
			await state.storage.put("lease", { until: Date.now() + 120_000, token: "srv02-hold" });
		});
		await conversationSave(userId, { source: "mastra", tag: "deneb" });

		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });

		await runInDurableObject(stubFor(userId), async (_i, state) => { await state.storage.delete("lease"); });
		await runInDurableObject(stubFor(userId), (instance) => instance.drain({ userId, ignoreBackoff: true }));
		await settle(userId);

		expect((await liveCounts(userId)).total, "held pre-erase conversation landed after the erase").toBe(0);
		const jobs = await env.DB.prepare(
			"SELECT status FROM memory_jobs WHERE user_id = ?",
		).bind(userId).all();
		for (const job of jobs.results ?? []) {
			expect(["enriched", "failed", "completed"]).toContain(job.status);
		}
		await stubFor(userId).resetAll();
	}, 30000);

	it("concurrent duplicate erasures both succeed and converge", async () => {
		const userId = `srv02-dupe-${crypto.randomUUID()}`;
		await conversationSave(userId, { source: "ai-sdk", tag: "spica" });
		await settle(userId);

		const [a, b] = await Promise.all([
			bulkDeleteBySource(env, userId, { dryRun: false, confirm: true }),
			bulkDeleteBySource(env, userId, { dryRun: false, confirm: true }),
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect((await liveCounts(userId)).total).toBe(0);
		await stubFor(userId).resetAll();
	}, 30000);
});
