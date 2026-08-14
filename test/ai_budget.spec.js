/**
 * The AI budget: per-user monthly write quota (fail CLOSED) and the
 * account-wide daily neuron circuit breaker (fail OPEN, cached).
 *
 * The quota counts ai_calls.account_user_id — the authenticated account —
 * so rotating body.userId must never reset a budget. Refusal shapes follow
 * each door's own grammar: REST 429 (a soft 200 would read as a successful
 * save), /v1/turn degrades to recall-only at 200, MCP returns isError.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../src";
import {
	aiBudget,
	checkAiBudget,
	countWritesThisMonth,
	derivedNeurons,
	resetBreakerCacheForTests,
	startOfUtcMonth,
	utcDayKey,
} from "../src/lib/ai_budget.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function jsonRequest(path, body, headers = {}) {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

/** Seed N distinct AI-processed writes for an account this month. */
async function seedWrites(accountUserId, n, { userId = accountUserId, scope = "save" } = {}) {
	const now = Date.now();
	const stmts = [];
	for (let i = 0; i < n; i++) {
		stmts.push(env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, input_tokens, output_tokens, neurons, ok, created_at, account_user_id)
			 VALUES (?, ?, ?, ?, 'test-model', 'extract', 10, 5, 1.0, 1, ?, ?)`,
		).bind(`aicall_seed_${crypto.randomUUID()}`, userId, scope, `run_${crypto.randomUUID()}`, now, accountUserId));
	}
	await env.DB.batch(stmts);
}

const ENV_KEYS = ["AI_MONTHLY_WRITES", "AI_DAILY_NEURON_CEILING"];
const savedEnv = {};

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = env[key];
	resetBreakerCacheForTests();
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete env[key];
		else env[key] = savedEnv[key];
	}
	resetBreakerCacheForTests();
	// A breaker test may have inflated today's rollup — drain it so later
	// tests (and later FILES in this isolate) are not spuriously paused.
	await env.DB.prepare("DELETE FROM ai_daily_totals").run();
});

describe("aiBudget config", () => {
	it("honours env vars and rejects garbage", () => {
		env.AI_MONTHLY_WRITES = "250";
		env.AI_DAILY_NEURON_CEILING = "9000";
		expect(aiBudget(env)).toEqual({ monthlyWrites: 250, dailyNeuronCeiling: 9000 });
		env.AI_MONTHLY_WRITES = "-5";
		env.AI_DAILY_NEURON_CEILING = "banana";
		expect(aiBudget(env).monthlyWrites).toBe(1000);
		expect(aiBudget(env).dailyNeuronCeiling).toBe(750_000);
	});

	it("derives neurons from token sums at the published rates", () => {
		expect(derivedNeurons(1_000_000, 0)).toBeCloseTo(4625);
		expect(derivedNeurons(0, 1_000_000)).toBeCloseTo(30475);
		expect(derivedNeurons(0, 0)).toBe(0);
	});
});

describe("countWritesThisMonth", () => {
	it("counts distinct writes for the account, not per-call rows", async () => {
		const account = `acct-${crypto.randomUUID()}`;
		await seedWrites(account, 3);
		// A second call on an existing scope_id must not double-count — reuse one.
		const row = await env.DB.prepare(
			"SELECT scope_id FROM ai_calls WHERE account_user_id = ? LIMIT 1",
		).bind(account).first();
		await env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, ok, created_at, account_user_id)
			 VALUES (?, ?, 'save', ?, 'test-model', 'embed', 1, ?, ?)`,
		).bind(`aicall_seed_${crypto.randomUUID()}`, account, row.scope_id, Date.now(), account).run();
		expect(await countWritesThisMonth(env, { accountUserId: account })).toBe(3);
	});

	it("ignores writes from before this UTC month", async () => {
		const account = `acct-${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, ok, created_at, account_user_id)
			 VALUES (?, ?, 'save', ?, 'test-model', 'extract', 1, ?, ?)`,
		).bind(`aicall_seed_${crypto.randomUUID()}`, account, `run_${crypto.randomUUID()}`, startOfUtcMonth() - 1000, account).run();
		expect(await countWritesThisMonth(env, { accountUserId: account })).toBe(0);
	});
});

describe("monthly quota at the REST doors", () => {
	it("refuses /v1/save with 429 once the account is over budget", async () => {
		env.AI_MONTHLY_WRITES = "2";
		const userId = `quota-${crypto.randomUUID()}`;
		await seedWrites(userId, 2);
		const res = await jsonRequest("/v1/save", { userId, content: "One more fact." }, { "x-api-key": env.API_KEY });
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBeTruthy();
		expect(res.headers.get("ratelimit-limit")).toBe("2");
		const body = await res.json();
		expect(body).toMatchObject({
			error: "ai_quota_exhausted",
			capped: "monthly_ai",
			usage: { used: 2, limit: 2, unit: "ai_writes" },
		});
		expect(body.usage.resets_at).toMatch(/^\d{4}-\d{2}-01T00:00:00/);
		// Nothing was written.
		const nodes = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(userId).first();
		expect(nodes.n).toBe(0);
	});

	it("rotating body.userId under one account does not reset the budget", async () => {
		env.AI_MONTHLY_WRITES = "1";
		const signup = await jsonRequest("/auth/signup", {
			email: `rot-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: "rot", acceptTerms: true,
		});
		expect(signup.status).toBe(201);
		const cookie = cookieFrom(signup);
		const account = (await signup.json()).user.id;
		const created = await request("/auth/tokens", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ type: "api", label: "quota rotation", scopes: ["memory:read", "memory:write"] }),
		});
		expect(created.status).toBe(201);
		const { token } = await created.json();

		await seedWrites(account, 1);
		for (const externalUser of ["tenant-a", "tenant-b"]) {
			const res = await jsonRequest("/v1/save", { userId: externalUser, content: "fact" }, { authorization: `Bearer ${token}` });
			expect(res.status, externalUser).toBe(429);
			expect((await res.json()).error).toBe("ai_quota_exhausted");
		}
	});

	it("/v1/turn stays 200 and degrades to recall-only when capped", async () => {
		env.AI_MONTHLY_WRITES = "1";
		const userId = `turncap-${crypto.randomUUID()}`;
		await seedWrites(userId, 1);
		const res = await jsonRequest("/v1/turn", {
			userId,
			query: "anything",
			messages: [{ role: "user", content: "Remember I like tea." }],
		}, { "x-api-key": env.API_KEY });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.recall).toBeTruthy();
		expect(body.collect).toMatchObject({ enabled: true, ok: false, capped: "monthly_ai", error: "ai_quota_exhausted" });
		expect(body.collect.usage).toMatchObject({ used: 1, limit: 1, unit: "ai_writes" });
	});

	it("fails CLOSED with 503 when the quota store is unreadable", async () => {
		env.AI_MONTHLY_WRITES = "5";
		const userId = `closed-${crypto.randomUUID()}`;
		const realPrepare = env.DB.prepare.bind(env.DB);
		env.DB.prepare = (sql, ...rest) => {
			if (String(sql).includes("COUNT(DISTINCT scope_id)")) throw new Error("d1 unavailable");
			return realPrepare(sql, ...rest);
		};
		try {
			const res = await jsonRequest("/v1/save", { userId, content: "fact" }, { "x-api-key": env.API_KEY });
			expect(res.status).toBe(503);
			expect((await res.json()).error).toBe("ai_quota_unavailable");
		} finally {
			env.DB.prepare = realPrepare;
		}
	});
});

describe("global circuit breaker", () => {
	it("pauses saves account-wide and never blames the user", async () => {
		env.AI_DAILY_NEURON_CEILING = "100";
		await env.DB.prepare(
			`INSERT INTO ai_daily_totals (day, calls, input_tokens, output_tokens, measured_neurons, measured_neuron_calls, updated_at)
			 VALUES (?, 10, 0, 0, 500, 10, ?)
			 ON CONFLICT(day) DO UPDATE SET measured_neurons = 500, measured_neuron_calls = 10, updated_at = excluded.updated_at`,
		).bind(utcDayKey(), Date.now()).run();
		resetBreakerCacheForTests();

		const userId = `breaker-${crypto.randomUUID()}`;
		const res = await jsonRequest("/v1/save", { userId, content: "fact" }, { "x-api-key": env.API_KEY });
		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.error).toBe("ai_capacity_paused");
		expect(body.message).not.toMatch(/\byour\b/i);
		expect(body.message).toContain("00:00 UTC");
	});

	it("tops up unreported calls from token sums, labelled as derived", async () => {
		env.AI_DAILY_NEURON_CEILING = "100";
		// 20 calls, none reported neurons; 30M input tokens ≈ 138,750 derived.
		await env.DB.prepare(
			`INSERT INTO ai_daily_totals (day, calls, input_tokens, output_tokens, measured_neurons, measured_neuron_calls, updated_at)
			 VALUES (?, 20, 30000000, 0, 0, 0, ?)
			 ON CONFLICT(day) DO UPDATE SET calls=20, input_tokens=30000000, measured_neurons=0, measured_neuron_calls=0, updated_at=excluded.updated_at`,
		).bind(utcDayKey(), Date.now()).run();
		resetBreakerCacheForTests();

		const refusal = await checkAiBudget(env, { accountUserId: `acct-${crypto.randomUUID()}` });
		expect(refusal?.error).toBe("ai_capacity_paused");
	});

	it("caches the daily read per isolate", async () => {
		env.AI_DAILY_NEURON_CEILING = "999999999";
		resetBreakerCacheForTests();
		const realPrepare = env.DB.prepare.bind(env.DB);
		let rollupReads = 0;
		env.DB.prepare = (sql, ...rest) => {
			if (String(sql).includes("FROM ai_daily_totals WHERE day")) rollupReads += 1;
			return realPrepare(sql, ...rest);
		};
		try {
			const account = `acct-${crypto.randomUUID()}`;
			await checkAiBudget(env, { accountUserId: account });
			await checkAiBudget(env, { accountUserId: account });
			expect(rollupReads).toBe(1);
		} finally {
			env.DB.prepare = realPrepare;
		}
	});

	it("fails OPEN when the rollup is unreadable", async () => {
		env.AI_DAILY_NEURON_CEILING = "1";
		resetBreakerCacheForTests();
		const realPrepare = env.DB.prepare.bind(env.DB);
		env.DB.prepare = (sql, ...rest) => {
			if (String(sql).includes("FROM ai_daily_totals WHERE day")) throw new Error("d1 blip");
			return realPrepare(sql, ...rest);
		};
		try {
			const refusal = await checkAiBudget(env, { accountUserId: `acct-${crypto.randomUUID()}` });
			expect(refusal).toBeNull(); // breaker unreadable → allow, loudly
		} finally {
			env.DB.prepare = realPrepare;
		}
	});
});

describe("MCP door", () => {
	it("save_memory over quota returns isError with the quota sentence", async () => {
		env.AI_MONTHLY_WRITES = "1";
		const signup = await jsonRequest("/auth/signup", {
			email: `mcpq-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: "mcpq", acceptTerms: true,
		});
		const cookie = cookieFrom(signup);
		const account = (await signup.json()).user.id;
		const created = await request("/auth/tokens", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ type: "mcp", label: "quota mcp", scopes: ["memory:read", "memory:write"] }),
		});
		const { token } = await created.json();
		await seedWrites(account, 1);

		const res = await request(`/mcp/${token}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "save_memory", arguments: { content: "over budget fact" } },
			}),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		const data = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
		const body = JSON.parse(data || text);
		expect(body.result.isError).toBe(true);
		expect(body.result.structuredContent).toMatchObject({
			ok: false,
			error: "ai_quota_exhausted",
			usage: { used: 1, limit: 1 },
			receipt_id: null,
		});
		expect(body.result.content[0].text).toContain("AI saves");
	});
});
