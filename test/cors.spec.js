/**
 * CORS contract — opt-in via ENABLE_CORS, /v1/* only, Bearer-only cross-origin.
 * The three guarantees: (1) flag off = byte-identical old behavior, (2)
 * allow-credentials is NEVER sent, (3) cookies and the legacy admin key can
 * never authenticate a cross-origin request.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const OTHER_ORIGIN = "https://someapp.example.net";

describe("CORS disabled (default)", () => {
	it("OPTIONS /v1/* stays a 404 and no CORS headers leak", async () => {
		const res = await request("/v1/save", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } });
		expect(res.status).toBe(404);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("CORS enabled", () => {
	let cookie = "";
	let token = "";

	beforeAll(async () => {
		const email = `cors-${crypto.randomUUID()}@example.com`;
		const signup = await request("/auth/signup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "correct-horse", acceptTerms: true }),
		});
		expect(signup.status).toBe(201);
		cookie = signup.headers.get("set-cookie")?.split(";")[0] || "";
		const created = await request("/auth/tokens", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ type: "api", label: "cors test" }),
		});
		token = (await created.json()).token;
		env.ENABLE_CORS = "true";
	});

	afterAll(() => {
		delete env.ENABLE_CORS;
	});

	it("answers preflight with reflected origin and never allow-credentials", async () => {
		const res = await request("/v1/recall", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(OTHER_ORIGIN);
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
		expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
	});

	it("cross-origin Bearer token works and gets CORS headers", async () => {
		const res = await request("/v1/status", {
			headers: { origin: OTHER_ORIGIN, authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe(OTHER_ORIGIN);
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	});

	it("cross-origin cookie-only is refused — sessions never act cross-site", async () => {
		const res = await request("/v1/status", { headers: { origin: OTHER_ORIGIN, cookie } });
		expect(res.status).toBe(401);
	});

	it("cross-origin legacy x-api-key is refused", async () => {
		const res = await request("/v1/status?userId=someone", {
			headers: { origin: OTHER_ORIGIN, "x-api-key": env.API_KEY },
		});
		// Rejected before auth resolves — the exact code differs by route shape,
		// what matters is it can never be a 200.
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});

	it("same-origin session keeps working exactly as before", async () => {
		const res = await request("/v1/status", { headers: { cookie } });
		expect(res.status).toBe(200);
	});

	it("no CORS on /auth/* even with the flag on", async () => {
		const res = await request("/auth/me", { headers: { origin: OTHER_ORIGIN, cookie } });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});
