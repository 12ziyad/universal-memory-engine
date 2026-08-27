/**
 * GET /v1/limits — the machine-readable limits document — plus the contracts
 * that keep it honest:
 *
 *   1. The published bucket numbers must equal the wrangler.jsonc binding
 *      declarations (the drift guard: retuning a binding without updating
 *      RATE_BUCKETS breaks this suite, not production trust).
 *   2. tooMany() must carry retry-after and, when given a bucket, the
 *      ratelimit-limit header — our own SDK paces retries off retry-after.
 *   3. allowRate fails OPEN (absent binding, throwing binding): rate limiting
 *      is protection, not a gate.
 */

import wranglerRaw from "../wrangler.jsonc?raw";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { allowRate, managedActorRateKey, RATE_BUCKETS } from "../src/lib/rate.js";
import { RATE_LIMITS_DOC, LIMITS_SCHEMA } from "../src/lib/limits_contract.mjs";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe("GET /v1/limits", () => {
	it("answers unauthenticated with the full document", async () => {
		const res = await request("/v1/limits");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.schema).toBe(LIMITS_SCHEMA);
		expect(Object.keys(body.rate.buckets).sort()).toEqual(
			["auth", "delete", "import", "read", "recall", "save"],
		);
		// Ingest bounds ride along so one fetch answers both questions.
		expect(body.ingest.limits.maxMessages).toBe(30);
		// The AI plan is published; the account-wide ceiling must NOT be.
		expect(body.ai.monthly_writes).toBeGreaterThan(0);
		expect(body.ai.unit).toBe("ai_writes");
		// The per-user DAILY allowance is a product fact and IS published
		// (lower-case "neurons"); the operational account-wide ceiling — the
		// word "ceiling", or the shouting constant name — still must not leak.
		expect(body.ai.daily.limit).toBeGreaterThan(0);
		expect(body.ai.daily.unit).toBe("neurons");
		expect(body.ai.daily.recall_metered).toBe(false);
		expect(body.ai.huba.daily_messages).toBeGreaterThan(0);
		expect(body.ai.huba.first_day_messages).toBeGreaterThan(body.ai.huba.daily_messages);
		expect(JSON.stringify(body)).not.toContain("ceiling");
		expect(JSON.stringify(body)).not.toContain("NEURON");
	});

	it("every bucket documents where it applies", () => {
		for (const [name, bucket] of Object.entries(RATE_LIMITS_DOC.buckets)) {
			expect(bucket.applies_to.length, name).toBeGreaterThan(0);
			expect(bucket.limit, name).toBeGreaterThan(0);
			expect(bucket.period_s, name).toBe(60);
		}
	});

	it("published numbers equal the wrangler.jsonc binding declarations (drift guard)", () => {
		const raw = wranglerRaw;
		for (const [name, bucket] of Object.entries(RATE_BUCKETS)) {
			const decl = new RegExp(
				`"name":\\s*"${bucket.binding}"[^}]*"simple":\\s*\\{\\s*"limit":\\s*(\\d+),\\s*"period":\\s*(\\d+)`,
			).exec(raw);
			expect(decl, `${bucket.binding} must be declared in wrangler.jsonc`).toBeTruthy();
			expect(Number(decl[1]), `${name} limit`).toBe(bucket.limit);
			expect(Number(decl[2]), `${name} period`).toBe(bucket.period_s);
		}
	});
});

describe("429 shape", () => {
	it("carries retry-after and ratelimit-limit when a bucket refuses", async () => {
		const original = env.AUTH_LIMITER;
		env.AUTH_LIMITER = { limit: async () => ({ success: false }) };
		try {
			const res = await request("/auth/signup", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "x@example.com", password: "pw-pw-pw-pw", acceptTerms: true }),
			});
			expect(res.status).toBe(429);
			expect(res.headers.get("retry-after")).toBe("60");
			expect(res.headers.get("ratelimit-limit")).toBe(String(RATE_BUCKETS.auth.limit));
			const body = await res.json();
			expect(body.error).toBe("too_many_requests");
			expect(body.retry_after_s).toBe(60);
			expect(body.bucket).toBe("auth");
		} finally {
			if (original === undefined) delete env.AUTH_LIMITER;
			else env.AUTH_LIMITER = original;
		}
	});
});

describe("allowRate failure policy", () => {
	// Launch hardening 2026-08-28: the brakes must not release exactly when
	// braking hardest. An ABSENT binding still allows (tests and local dev
	// deliberately omit bindings), but a binding that THROWS now refuses on
	// write-shaped paths ({ fail: "closed" } — save/import/delete call sites)
	// while auth/recall/read stay fail-open for availability.
	it("allows when the binding is absent, whatever the policy", async () => {
		expect(await allowRate(undefined, "k")).toBe(true);
		expect(await allowRate(null, "k")).toBe(true);
		expect(await allowRate(null, "k", { fail: "closed" })).toBe(true);
	});

	it("read-shaped default: allows when the binding throws", async () => {
		expect(await allowRate({ limit: async () => { throw new Error("unavailable"); } }, "k")).toBe(true);
	});

	it("write-shaped fail-closed: refuses when the binding throws", async () => {
		expect(await allowRate(
			{ limit: async () => { throw new Error("unavailable"); } },
			"k",
			{ fail: "closed" },
		)).toBe(false);
	});

	it("refuses on an explicit success:false in either mode", async () => {
		expect(await allowRate({ limit: async () => ({ success: false }) }, "k")).toBe(false);
		expect(await allowRate({ limit: async () => ({ success: false }) }, "k", { fail: "closed" })).toBe(false);
		expect(await allowRate({ limit: async () => ({ success: true }) }, "k")).toBe(true);
		expect(await allowRate({ limit: async () => ({}) }, "k")).toBe(true);
	});

	it("every save/import/delete call site in the router passes fail closed", async () => {
		const source = (await import("../src/index.js?raw")).default;
		const sites = [...source.matchAll(/allowRate\(env\.(SAVE|IMPORT|DELETE)_LIMITER/g)];
		expect(sites.length).toBeGreaterThan(10);
		for (const match of sites) {
			const call = source.slice(match.index, match.index + 240);
			expect(call, call.slice(0, 90)).toContain('fail: "closed"');
		}
	});
});

describe("managedActorRateKey", () => {
	it("keys on credential + project, never the memory subject", () => {
		const key = managedActorRateKey("save", {
			auth: { type: "token", token: { id: "tok_1" } },
			managedProject: { id: "proj_9" },
		});
		expect(key).toBe("save:token:tok_1:project:proj_9");
	});

	it("degrades to a single legacy bucket without context", () => {
		expect(managedActorRateKey("save", {})).toBe("save:legacy:configured:project:unmanaged");
	});
});
