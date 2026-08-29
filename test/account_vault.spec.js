/* The account vault (status='dormant').
 *
 * A vaulted account is shelved, not banned and not deleted: it leaves the
 * operator console's default view, its live sessions stop resolving, its
 * data is untouched, and EVERY door that proves the person is back wakes it
 * automatically. These tests pin that last property at all three doors,
 * because a vault you cannot walk out of is just a ban with a nicer name.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function jsonInit(body, cookie) {
	return { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) };
}
const cookieFrom = (res) => res.headers.get("set-cookie")?.split(";")[0] || "";

async function signup(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	return { email, user: (await res.json()).user, cookie: cookieFrom(res) };
}
const makeAdmin = (id) => env.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(id).run();
const statusOf = async (id) => (await env.DB.prepare("SELECT status FROM users WHERE id=?").bind(id).first())?.status;
const vault = (id) => env.DB.prepare("UPDATE users SET status='dormant' WHERE id=?").bind(id).run();

describe("shelving", () => {
	it("removes the account from the console's default list but reports it in stats and on demand", async () => {
		const admin = await signup("vadm");
		await makeAdmin(admin.user.id);
		const target = await signup("vtgt");

		const before = await request(`/v1/admin/users?query=${target.email.slice(0, 12)}`, { headers: { cookie: admin.cookie } });
		expect((await before.json()).users.some((u) => u.id === target.user.id)).toBe(true);

		await vault(target.user.id);

		const after = await request(`/v1/admin/users?query=${target.email.slice(0, 12)}`, { headers: { cookie: admin.cookie } });
		expect((await after.json()).users.some((u) => u.id === target.user.id)).toBe(false);

		// Shelved, not hidden: an explicit vault view still lists it...
		const vaultView = await request(`/v1/admin/users?vault=1&query=${target.email.slice(0, 12)}`, { headers: { cookie: admin.cookie } });
		const vaultBody = await vaultView.json();
		expect(vaultBody.vault).toBe(true);
		expect(vaultBody.users.some((u) => u.id === target.user.id)).toBe(true);

		// ...and the count is always on the dashboard.
		const stats = await request("/v1/admin/stats", { headers: { cookie: admin.cookie } });
		expect(Number((await stats.json()).vaulted_users ?? 0)).toBeGreaterThanOrEqual(1);
	});

	it("stops existing sessions resolving without destroying anything", async () => {
		const who = await signup("vsess");
		expect((await (await request("/auth/me", { headers: { cookie: who.cookie } })).json()).authenticated).toBe(true);
		await vault(who.user.id);
		expect((await (await request("/auth/me", { headers: { cookie: who.cookie } })).json()).authenticated).toBe(false);
		// The account itself is entirely intact.
		const row = await env.DB.prepare("SELECT id, email, role FROM users WHERE id=?").bind(who.user.id).first();
		expect(row.email).toBe(who.email);
	});

	it("refuses to let an admin vault themselves out of the console", async () => {
		const admin = await signup("vself");
		await makeAdmin(admin.user.id);
		const res = await request("/v1/admin/users/action", jsonInit({ userId: admin.user.id, action: "vault" }, admin.cookie));
		expect(res.status).toBe(400);
		expect(await statusOf(admin.user.id)).not.toBe("dormant");
	});
});

describe("waking — every door that proves the person is back", () => {
	it("wakes on password sign-in", async () => {
		const who = await signup("wpass");
		await vault(who.user.id);
		expect(await statusOf(who.user.id)).toBe("dormant");

		const login = await request("/auth/login", jsonInit({ email: who.email, password: "correct-horse" }));
		expect(login.status).toBe(200);
		expect(await statusOf(who.user.id)).toBe("active");
		// The fresh session works immediately.
		expect((await (await request("/auth/me", { headers: { cookie: cookieFrom(login) } })).json()).authenticated).toBe(true);
	});

	it("wakes on API-key use, so a shelved integration is never silently dead", async () => {
		const who = await signup("wkey");
		const minted = await request("/auth/tokens", jsonInit({ label: "vault key" }, who.cookie));
		expect(minted.status).toBe(201);
		const token = (await minted.json()).token;
		expect(token).toBeTruthy();

		await vault(who.user.id);
		expect(await statusOf(who.user.id)).toBe("dormant");

		const used = await request("/v1/usage", { headers: { authorization: `Bearer ${token}` } });
		expect(used.status).toBe(200);
		expect(await statusOf(who.user.id)).toBe("active");
	});

	it("records the wake as a low-severity security event, so a reappearing account is explainable", async () => {
		const who = await signup("wevt");
		await vault(who.user.id);
		await request("/auth/login", jsonInit({ email: who.email, password: "correct-horse" }));
		const event = await env.DB.prepare(
			"SELECT kind, severity, target_user_id, notify_status FROM security_events WHERE group_key = ?",
		).bind(`account_woken:${who.user.id}`).first();
		expect(event.kind).toBe("account_woken_from_vault");
		expect(event.severity).toBe("low");
		expect(event.target_user_id).toBe(who.user.id);
		// Low severity never emails the owner.
		expect(event.notify_status).toBe("skipped");
	});

	it("does not wake a genuinely disabled account — the two states stay distinct", async () => {
		const who = await signup("wdis");
		await env.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(who.user.id).run();
		const login = await request("/auth/login", jsonInit({ email: who.email, password: "correct-horse" }));
		expect(login.status).toBe(401);
		expect(await statusOf(who.user.id)).toBe("disabled");
	});
});

describe("the audited admin actions", () => {
	it("vaults and unvaults through the audited door, with sessions revoked on the way in", async () => {
		const admin = await signup("vaadm");
		await makeAdmin(admin.user.id);
		const target = await signup("vatgt");

		const put = await request("/v1/admin/users/action", jsonInit({ userId: target.user.id, action: "vault" }, admin.cookie));
		expect(put.status).toBe(200);
		expect(await statusOf(target.user.id)).toBe("dormant");
		const live = await env.DB.prepare(
			"SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at IS NULL",
		).bind(target.user.id).first("n");
		expect(Number(live)).toBe(0);

		const out = await request("/v1/admin/users/action", jsonInit({ userId: target.user.id, action: "unvault" }, admin.cookie));
		expect(out.status).toBe(200);
		expect(await statusOf(target.user.id)).toBe("active");

		const feed = await request("/v1/admin/audit-feed?limit=50", { headers: { cookie: admin.cookie } });
		const actions = (await feed.json()).entries.filter((e) => e.target?.id === target.user.id).map((e) => e.action);
		expect(actions).toContain("admin.user.vault");
		expect(actions).toContain("admin.user.unvault");
	});
});

describe("the console UI", () => {
	it("offers the vault view and the restore control, and says how many are shelved", async () => {
		const { default: html } = await import("../public/index.html?raw");
		expect(html).toContain("function adminToggleVaultView()");
		expect(html).toContain("in the vault");
		expect(html).toContain("'vault')\">Move to vault<");
		expect(html).toContain("'unvault')\">Restore from vault<");
		// The copy has to promise the automatic wake, because that is the
		// whole difference between the vault and a ban.
		expect(html).toContain("wakes automatically the next time they sign in");
	});
});
