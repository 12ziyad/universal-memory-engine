/* Maintenance mode (Phase 2): MAINTENANCE_MODE="on" turns the API away with
 * 503 + Retry-After while the public reading surfaces and the auth doors
 * keep serving, and admin sessions pass everything. An env var, not D1, on
 * purpose — it must keep working when D1 itself is the outage.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function jsonInit(body, cookie) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	};
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

const ON = () => ({ ...env, MAINTENANCE_MODE: "on" });

describe("maintenance mode", () => {
	it("is off by default — the flag absent means normal service", async () => {
		const res = await request("/v1/limits");
		expect(res.status).toBe(200);
	});

	it("turns the API and MCP away with 503 + Retry-After when on", async () => {
		for (const path of ["/v1/limits", "/v1/usage", "/mcp"]) {
			const res = await request(path, {}, ON());
			expect(res.status, path).toBe(503);
			expect(res.headers.get("retry-after"), path).toBe("600");
			expect((await res.json()).error, path).toBe("maintenance");
		}
		const save = await request("/v1/save", jsonInit({ userId: "u", content: "x" }), ON());
		expect(save.status).toBe(503);
	});

	it("keeps the reading surfaces and the auth doors open", async () => {
		const securityTxt = await request("/.well-known/security.txt", {}, ON());
		expect(securityTxt.status).toBe(200);
		expect(await securityTxt.text()).toContain("founder@itsuki.app");

		// Signing IN during maintenance must work — that is how the admin gets in.
		const email = `maint-${crypto.randomUUID()}@example.com`;
		const signup = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: "maint", acceptTerms: true }), ON());
		expect(signup.status).toBe(201);
		const login = await request("/auth/login", jsonInit({ email, password: "correct-horse" }), ON());
		expect(login.status).toBe(200);
	});

	it("quiesces the /auth write doors while the sign-in doors stay open", async () => {
		const email = `maintw-${crypto.randomUUID()}@example.com`;
		const signup = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: "maintw", acceptTerms: true }));
		const cookie = cookieFrom(signup);

		const me = await request("/auth/me", { headers: { cookie } }, ON());
		expect(me.status).toBe(200);

		// Minting credentials and creating orgs are exactly the writes
		// maintenance exists to stop — the /auth prefix buys no exemption.
		const mintToken = await request("/auth/tokens", jsonInit({ label: "x" }, cookie), ON());
		expect(mintToken.status).toBe(503);
		const org = await request("/auth/organizations", jsonInit({ name: "Maint Org" }, cookie), ON());
		expect(org.status).toBe(503);
	});

	it("lets admin sessions through and keeps everyone else out", async () => {
		const email = `maintadm-${crypto.randomUUID()}@example.com`;
		const signup = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: "maintadm", acceptTerms: true }));
		const cookie = cookieFrom(signup);
		const userId = (await signup.json()).user.id;

		const asUser = await request("/v1/limits", { headers: { cookie } }, ON());
		expect(asUser.status).toBe(503);

		await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run();
		const asAdmin = await request("/v1/limits", { headers: { cookie } }, ON());
		expect(asAdmin.status).toBe(200);
		const adminSurface = await request("/v1/admin/stats", { headers: { cookie } }, ON());
		expect(adminSurface.status).toBe(200);
	});
});
