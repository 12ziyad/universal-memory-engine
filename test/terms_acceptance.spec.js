/* Terms acceptance capture (consent-by-continuing).
 *
 * Every sign-in door renders "By continuing, you agree to the Terms of
 * Service and Privacy Policy", and the Terms state that use constitutes
 * acceptance. These tests pin that the stamp is recorded at every door —
 * at signup, and backfilled at next sign-in for accounts that predate
 * stamping. The stamp is never fabricated: it is written only when a
 * sign-in actually happens.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { issueAuthenticatedSession } from "../src/auth.js";
import html from "../public/index.html?raw";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const jsonInit = (body, cookie) => ({ method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const stampOf = async (id) => (await env.DB.prepare("SELECT terms_accepted_at FROM users WHERE id=?").bind(id).first())?.terms_accepted_at;

async function signup(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	return { email, user: (await res.json()).user };
}

describe("consent is captured at every door", () => {
	it("password signup refuses without acceptTerms and stamps with it", async () => {
		const email = `noconsent-${crypto.randomUUID()}@example.com`;
		const refused = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: "x" }));
		expect(refused.status).toBe(400);
		const who = await signup("consent");
		expect(await stampOf(who.user.id)).toBeTruthy();
	});

	it("an account missing the stamp gets it on password sign-in — not before", async () => {
		const who = await signup("backfill");
		await env.DB.prepare("UPDATE users SET terms_accepted_at = NULL WHERE id=?").bind(who.user.id).run();
		expect(await stampOf(who.user.id)).toBeNull();

		const login = await request("/auth/login", jsonInit({ email: who.email, password: "correct-horse" }));
		expect(login.status).toBe(200);
		expect(await stampOf(who.user.id)).toBeTruthy();
	});

	it("the shared OAuth/passwordless door stamps too", async () => {
		const who = await signup("oauthdoor");
		await env.DB.prepare("UPDATE users SET terms_accepted_at = NULL WHERE id=?").bind(who.user.id).run();
		const result = await issueAuthenticatedSession(env, new Request("http://example.com/"), who.user.id, "google_login");
		expect(result.status).toBe(200);
		expect(await stampOf(who.user.id)).toBeTruthy();
	});

	it("an existing stamp is never overwritten", async () => {
		const who = await signup("keepstamp");
		const original = await stampOf(who.user.id);
		await request("/auth/login", jsonInit({ email: who.email, password: "correct-horse" }));
		expect(await stampOf(who.user.id)).toBe(original);
	});

	it("the auth card shows the notice beside all three doors", () => {
		expect(html).toContain("By continuing, you agree to the");
		const card = html.slice(html.indexOf("Continue with Google"), html.indexOf("auth-card-seal"));
		expect(card).toContain("auth-agree");
	});
});
