/**
 * Google sign-in: the start redirect with CSRF state, callback failure paths,
 * and the account-resolution logic (sub match, email link-as-recovery, fresh
 * Google-only account with consent). The live token exchange with Google is
 * not exercised here — resolveGoogleUser is tested directly instead.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { resolveGoogleUser } from "../src/auth.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function seedPasswordUser(email, extra = {}) {
	const id = `user_${crypto.randomUUID()}`;
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_normalized, password_hash, password_salt, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, 'pbkdf2_sha256$100000$x$y', 'salt', ?, ?, ?, ?, 'user')`,
	).bind(id, email, email.toLowerCase(), extra.name ?? "Seed", now, now, extra.status ?? "active").run();
	return id;
}

describe("GET /auth/google/start", () => {
	it("redirects to Google with the client id and sets a state cookie", async () => {
		const res = await request("/auth/google/start");
		expect(res.status).toBe(302);
		const location = res.headers.get("location");
		expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
		expect(location).toContain(encodeURIComponent(env.GOOGLE_CLIENT_ID));
		expect(location).toContain(encodeURIComponent("http://example.com/auth/google/callback"));
		const state = new URL(location).searchParams.get("state");
		expect(state?.length).toBeGreaterThan(20);
		expect(res.headers.get("set-cookie")).toContain(`uml_oauth_state=${encodeURIComponent(state)}`);
	});
});

describe("GET /auth/google/callback failure paths", () => {
	it("redirects to login on provider denial", async () => {
		const res = await request("/auth/google/callback?error=access_denied");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("/login?error=google_denied");
	});

	it("rejects a callback whose state does not match the cookie", async () => {
		const res = await request("/auth/google/callback?code=abc&state=forged", {
			headers: { cookie: "uml_oauth_state=expected" },
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("/login?error=google_state");
	});

	it("rejects a callback with no state cookie at all", async () => {
		const res = await request("/auth/google/callback?code=abc&state=anything");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("/login?error=google_state");
	});
});

describe("resolveGoogleUser", () => {
	it("creates a Google-only account with consent and verified email recorded", async () => {
		const email = `g-${crypto.randomUUID()}@example.com`;
		const result = await resolveGoogleUser(env, {
			sub: `sub-${crypto.randomUUID()}`,
			email,
			email_verified: true,
			name: "Google Person",
		});
		expect(result.created).toBe(true);
		expect(result.user.email_normalized).toBe(email.toLowerCase());
		expect(result.user.password_hash).toBeNull();
		expect(Number(result.user.terms_accepted_at)).toBeGreaterThan(0);
		expect(Number(result.user.email_verified_at)).toBeGreaterThan(0);
	});

	it("links to an existing password account by email — the recovery path", async () => {
		const email = `link-${crypto.randomUUID()}@example.com`;
		const existingId = await seedPasswordUser(email);
		const sub = `sub-${crypto.randomUUID()}`;
		const result = await resolveGoogleUser(env, { sub, email, email_verified: true, name: "Ziyad" });
		expect(result.created).toBe(false);
		expect(result.user.id).toBe(existingId);
		expect(result.user.google_sub).toBe(sub);
		expect(Number(result.user.email_verified_at)).toBeGreaterThan(0);
		// The password stays — both sign-in methods work after linking.
		expect(result.user.password_hash).toBeTruthy();
	});

	it("prefers the stable google_sub even if the Google email later changes", async () => {
		const email = `stable-${crypto.randomUUID()}@example.com`;
		const sub = `sub-${crypto.randomUUID()}`;
		const first = await resolveGoogleUser(env, { sub, email, email_verified: true });
		const changed = await resolveGoogleUser(env, { sub, email: `new-${email}`, email_verified: true });
		expect(changed.user.id).toBe(first.user.id);
	});

	it("refuses disabled accounts", async () => {
		const email = `disabled-${crypto.randomUUID()}@example.com`;
		await seedPasswordUser(email, { status: "disabled" });
		const result = await resolveGoogleUser(env, { sub: `sub-${crypto.randomUUID()}`, email, email_verified: true });
		expect(result.error).toBe("account_disabled");
	});
});

describe("password login on a Google-only account", () => {
	it("explains instead of failing generically", async () => {
		const email = `gonly-${crypto.randomUUID()}@example.com`;
		await resolveGoogleUser(env, { sub: `sub-${crypto.randomUUID()}`, email, email_verified: true });
		const res = await request("/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "whatever-password" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/Google sign-in/);
	});
});
