/**
 * GET /v1/usage — per-user activity rollups. Seeds receipts + nodes directly
 * in D1 and asserts day grouping, source split, totals, and auth behavior
 * (session and Bearer token both allowed; scope enforced for tokens).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const userId = "usage-user";

describe("GET /v1/usage", () => {
	beforeAll(async () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const rows = [
			["r1", "save_memory", "wrote", 2, now - 1 * dayMs],
			["r2", "save_memory", "wrote", 1, now - 1 * dayMs],
			["r3", "recall", "recalled", 0, now - 1 * dayMs],
			["r4", "ingest", "wrote", 3, now - 2 * dayMs],
			["r5", "recall", "recalled", 0, now - 40 * dayMs], // outside 30d
		];
		const statements = rows.map(([id, source, outcome, saved, at]) =>
			env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total, skipped, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
			).bind(id, userId, source, outcome, "seeded", saved, at));
		statements.push(env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind("usage-node", userId, "Kotlin", "skill", "active", now - 1 * dayMs, now));
		await env.DB.batch(statements);
	});

	it("rolls up by day, by source, and totals for the default 30d range", async () => {
		const res = await request(`/v1/usage?userId=${userId}`, { headers });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.totals.saves).toBe(3);
		expect(body.totals.recalls).toBe(1); // 40d-old recall excluded
		expect(body.totals.requests).toBe(4);
		expect(body.totals.nodes).toBe(1);
		expect(body.totals.memories).toBe(1);
		const daySum = body.by_day.reduce((a, r) => a + Number(r.saves), 0);
		expect(daySum).toBe(3);
		const bySource = Object.fromEntries(body.by_source.map((r) => [r.source, r.count]));
		expect(bySource.save_memory).toBe(2);
		expect(bySource.ingest).toBe(1);
		expect(bySource.recall).toBe(1);
		const withMemories = body.by_day.find((r) => r.memories_added > 0);
		expect(withMemories).toBeTruthy();
		expect(body.last_activity_at).toBeGreaterThan(0);
	});

	it("carries the AI usage and quota blocks (additive to the activity shape)", async () => {
		const res = await request(`/v1/usage?userId=${userId}`, { headers });
		const body = await res.json();
		expect(body.ai).toMatchObject({ neurons_source: "measured+derived" });
		expect(typeof body.ai.calls).toBe("number");
		expect(typeof body.ai.neurons_total).toBe("number");
		expect(body.quota).toMatchObject({ unit: "ai_writes", period: "calendar_month_utc", capped: false });
		expect(body.quota.limit).toBeGreaterThan(0);
		expect(body.quota.remaining).toBe(body.quota.limit - body.quota.used);
		expect(body.quota.resets_at).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
	});

	it("range=all widens the window", async () => {
		const res = await request(`/v1/usage?userId=${userId}&range=all`, { headers });
		const body = await res.json();
		expect(body.totals.recalls).toBe(2); // old recall included
	});

	it("rejects unauthenticated calls", async () => {
		const res = await request(`/v1/usage`);
		expect(res.status).toBe(401);
	});
});
