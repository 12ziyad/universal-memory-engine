import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import {
	RECALL_LIMIT_MAX,
	RECALL_LIMIT_MIN,
	recallGate,
	validateRecallLimit,
} from "../src/pipeline/recall.js";
import { runRecallCommand } from "../src/pipeline/commands.js";

/**
 * BF-2. `/v1/recall` advertised a `limit`, both SDKs exposed it, and the handler
 * never forwarded it — a caller asking for one memory got eight and had no way
 * to tell. This suite holds the repaired contract: it works, or it fails by name.
 */

const USER = "user_bf2";
const V3_ENV = { ...env, ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: USER };

async function seedGraph(userId, count) {
	const now = Date.now();
	const statements = [];
	for (let i = 0; i < count; i += 1) {
		statements.push(env.DB.prepare(
			`INSERT INTO nodes (id, user_id, label, category, state, summary, cluster, heat_score, created_at, updated_at, last_seen_at)
			 VALUES (?, ?, ?, 'project', 'active', ?, 'projects_systems', 1, ?, ?, ?)`,
		).bind(`node_${userId}_${i}`, userId, `Falcon project ${i}`, `Falcon project ${i} is a deployment target`, now, now, now));
	}
	await env.DB.batch(statements);
}

async function recallOnce(userId, query, input, environment = env) {
	return runRecallCommand(environment, userId, query, input);
}

describe("BF-2 validation: a documented parameter works or fails by name", () => {
	it("accepts absent, and the whole documented range", () => {
		expect(validateRecallLimit(undefined)).toBe(null);
		expect(validateRecallLimit(null)).toBe(null);
		expect(validateRecallLimit(RECALL_LIMIT_MIN)).toBe(RECALL_LIMIT_MIN);
		expect(validateRecallLimit(RECALL_LIMIT_MAX)).toBe(RECALL_LIMIT_MAX);
		expect(validateRecallLimit(50)).toBe(50);
	});

	it("refuses zero, negatives, fractions, and absurd depths rather than clamping", () => {
		for (const bad of [0, -1, -100, 1.5, RECALL_LIMIT_MAX + 1, 100_000]) {
			expect(() => validateRecallLimit(bad), String(bad)).toThrow(/limit must be/);
		}
	});

	it("refuses the wrong type instead of coercing it", () => {
		for (const bad of ["8", "many", true, [], {}, Number.NaN, Infinity]) {
			expect(() => validateRecallLimit(bad), String(bad)).toThrow();
		}
	});

	it("surfaces the refusal as a 400 through the shared command facade", async () => {
		const result = await recallOnce(USER, "what do I know", { limit: 0 });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("invalid_limit");
		expect(result.http_status).toBe(400);
	});
});

describe("BF-2 gate plan: the final evidence budget", () => {
	it("does nothing at all when no limit is given", () => {
		const plan = recallGate("where do I live?");
		expect(plan.topN).toBe(8);
		expect(plan.maxContextNodes).toBe(6);
		expect(plan.limit_applied ?? null).toBe(null);
	});

	it("narrows the budget for a legacy account", () => {
		const plan = recallGate("where do I live?", { limit: 3, limitMode: "narrow" });
		expect(plan.limit_mode).toBe("narrow");
		expect(plan.topN).toBe(3);
		expect(plan.maxContextNodes).toBe(3);
		expect(plan.maxContextPages).toBe(3);
	});

	it("never WIDENS for a legacy account, however large the request", () => {
		const legacy = recallGate("where do I live?");
		const asked = recallGate("where do I live?", { limit: 200, limitMode: "narrow" });
		expect(asked.topN).toBe(legacy.topN);
		expect(asked.maxContextNodes).toBe(legacy.maxContextNodes);
		expect(asked.maxContextChars).toBe(legacy.maxContextChars);
		// And it says so, rather than implying 200 items are coming.
		expect(asked.limit_requested).toBe(200);
		expect(asked.limit_applied).toBe(legacy.topN);
	});

	it("becomes a real depth control for a V3 account", () => {
		const plan = recallGate("where do I live?", { limit: 40, limitMode: "depth" });
		expect(plan.limit_mode).toBe("depth");
		expect(plan.topN).toBe(40);
		expect(plan.maxContextNodes).toBe(40);
		expect(plan.maxContextChars).toBeGreaterThan(recallGate("where do I live?").maxContextChars);
	});

	it("keeps hard ceilings even at the maximum depth", () => {
		const plan = recallGate("where do I live?", { limit: RECALL_LIMIT_MAX, limitMode: "depth" });
		expect(plan.topN).toBe(RECALL_LIMIT_MAX);
		// Context is bounded by an absolute ceiling, not by the caller's number.
		expect(plan.maxContextChars).toBeLessThanOrEqual(24_000);
		expect(plan.eventScanLimit).toBeLessThanOrEqual(4000);
	});

	it("still refuses to look things up for smalltalk, whatever the limit", () => {
		const plan = recallGate("thanks", { limit: 100, limitMode: "depth" });
		expect(plan.mode).toBe("no_recall");
		expect(plan.topN).toBe(0);
	});
});

describe("BF-2 end to end: the number of returned items follows the request", () => {
	it("returns exactly as many items as a legacy caller asked for", async () => {
		const userId = `${USER}_narrow`;
		await seedGraph(userId, 12);
		for (const limit of [1, 2, 5]) {
			const result = await recallOnce(userId, "Falcon project", { limit });
			expect(result.items.length, `limit=${limit}`).toBeLessThanOrEqual(limit);
			expect(result.limit_applied).toBe(limit);
			expect(result.limit_mode).toBe("narrow");
		}
	});

	it("is capped at the legacy maximum for a legacy caller who asks for more", async () => {
		const userId = `${USER}_cap`;
		await seedGraph(userId, 30);
		const result = await recallOnce(userId, "Falcon project", { limit: 100 });
		expect(result.items.length).toBeLessThanOrEqual(8);
		expect(result.limit_requested).toBe(100);
		expect(result.limit_applied).toBe(8);
	});

	it("returns more than the legacy maximum for a V3 caller", async () => {
		await seedGraph(USER, 30);
		const legacy = await recallOnce(USER, "Falcon project", {});
		const deep = await recallOnce(USER, "Falcon project", { limit: 20 }, V3_ENV);
		expect(legacy.items.length).toBeLessThanOrEqual(8);
		expect(deep.limit_mode).toBe("depth");
		expect(deep.items.length).toBeGreaterThan(legacy.items.length);
		expect(deep.items.length).toBeLessThanOrEqual(20);
	});

	it("reports the budget it actually used on every response", async () => {
		const userId = `${USER}_report`;
		await seedGraph(userId, 5);
		const result = await recallOnce(userId, "Falcon project", {});
		expect(result).toHaveProperty("limit_requested", null);
		expect(result).toHaveProperty("limit_applied", null);
		expect(result).toHaveProperty("evidence_budget", 8);
	});
});

describe("BF-2 at the HTTP door", () => {
	async function post(body, environment = env) {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://itsuki.app/v1/recall", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify(body),
			}),
			environment,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return { status: response.status, body: await response.json() };
	}

	it("forwards the limit — the exact line BF-2 was missing", async () => {
		const userId = `${USER}_http`;
		await seedGraph(userId, 12);
		const one = await post({ userId, query: "Falcon project", limit: 1 });
		expect(one.status).toBe(200);
		expect(one.body.items.length).toBeLessThanOrEqual(1);
		expect(one.body.limit_applied).toBe(1);

		const three = await post({ userId, query: "Falcon project", limit: 3 });
		expect(three.body.items.length).toBeGreaterThan(one.body.items.length);
	});

	it("answers a bad limit with a 400 instead of a cheerful 200", async () => {
		const bad = await post({ userId: `${USER}_http`, query: "Falcon project", limit: 0 });
		expect(bad.status).toBe(400);
		expect(bad.body.code).toBe("invalid_limit");
	});

	it("leaves a request without a limit exactly as it was", async () => {
		const userId = `${USER}_http_none`;
		await seedGraph(userId, 12);
		const result = await post({ userId, query: "Falcon project" });
		expect(result.status).toBe(200);
		expect(result.body.limit_applied).toBe(null);
		expect(result.body.items.length).toBeLessThanOrEqual(8);
	});
});
