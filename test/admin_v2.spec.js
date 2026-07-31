/**
 * Admin v2 console + visit beacon + password change + recall receipt copy.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { formatReceipt } from "../src/pipeline/receipt.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
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

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

async function makeAdmin(userId) {
	await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run();
}

describe("visit beacon", () => {
	it("increments an aggregate counter and stores nothing personal", async () => {
		const day = new Date().toISOString().slice(0, 10);
		const before = await env.DB.prepare("SELECT count FROM site_visits WHERE day = ? AND kind = 'landing'").bind(day).first();
		const res = await request("/v1/beacon", jsonInit({ kind: "landing" }));
		expect(res.status).toBe(200);
		const after = await env.DB.prepare("SELECT * FROM site_visits WHERE day = ? AND kind = 'landing'").bind(day).first();
		expect(Number(after.count)).toBe(Number(before?.count ?? 0) + 1);
		expect(Object.keys(after).sort()).toEqual(["count", "day", "kind"]);
	});

	it("coerces unknown kinds", async () => {
		await request("/v1/beacon", jsonInit({ kind: "evil<script>" }));
		const day = new Date().toISOString().slice(0, 10);
		const row = await env.DB.prepare("SELECT count FROM site_visits WHERE day = ? AND kind = 'other'").bind(day).first();
		expect(Number(row?.count ?? 0)).toBeGreaterThanOrEqual(1);
	});
});

describe("admin users + actions", () => {
	it("gates the users list and supports search", async () => {
		const admin = await signupAccount("adm");
		const denied = await request("/v1/admin/users", { headers: { cookie: admin.cookie } });
		expect(denied.status).toBe(403);
		await makeAdmin(admin.user.id);
		const res = await request(`/v1/admin/users?query=${admin.email.slice(0, 8)}`, { headers: { cookie: admin.cookie } });
		expect(res.status).toBe(200);
		const users = (await res.json()).users;
		expect(users.some((u) => u.id === admin.user.id)).toBe(true);
	});

	it("disables, re-enables, and deletes a target account", async () => {
		const admin = await signupAccount("boss");
		await makeAdmin(admin.user.id);
		const victim = await signupAccount("victim");

		const disable = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "disable" }, admin.cookie));
		expect(disable.status).toBe(200);
		const loginDisabled = await request("/auth/login", jsonInit({ email: victim.email, password: "correct-horse" }));
		expect(loginDisabled.status).toBe(401);

		const enable = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "enable" }, admin.cookie));
		expect(enable.status).toBe(200);
		const loginEnabled = await request("/auth/login", jsonInit({ email: victim.email, password: "correct-horse" }));
		expect(loginEnabled.status).toBe(200);

		const del = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie));
		expect(del.status).toBe(200);
		const gone = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(gone).toBeNull();
	});

	it("protects the admin from locking themselves out", async () => {
		const admin = await signupAccount("selfsafe");
		await makeAdmin(admin.user.id);
		for (const action of ["delete", "demote", "disable"]) {
			const res = await request("/v1/admin/users/action", jsonInit({ userId: admin.user.id, action }, admin.cookie));
			expect(res.status).toBe(400);
		}
	});
});

describe("change password", () => {
	it("changes with the current password and rejects a wrong one", async () => {
		const account = await signupAccount("pw");
		const wrong = await request("/auth/password", jsonInit({ currentPassword: "not-it", newPassword: "brand-new-pass" }, account.cookie));
		expect(wrong.status).toBe(400);
		const ok = await request("/auth/password", jsonInit({ currentPassword: "correct-horse", newPassword: "brand-new-pass" }, account.cookie));
		expect(ok.status).toBe(200);
		const login = await request("/auth/login", jsonInit({ email: account.email, password: "brand-new-pass" }));
		expect(login.status).toBe(200);
	});
});

describe("recall receipt copy", () => {
	it("never phrases lookups as failed saves", () => {
		expect(formatReceipt({ outcome: "recalled" })).toMatch(/lookup completed/i);
		expect(formatReceipt({ outcome: "no_recall" })).toMatch(/lookup skipped/i);
		expect(formatReceipt({ outcome: "recalled" })).not.toContain("Saved: 0");
	});
});
