/* Step-up confirmations (0062) for the destructive admin actions.
 *
 * delete / promote / demote no longer run on a session cookie alone: the
 * door demands a server-minted single-use token (bound to actor + session +
 * action + target + target-state, 5-minute TTL) AND the target's email typed
 * back. Pins: 428 without a token, 403 on a typed-text mismatch, 409 on
 * replay / expiry / stale target / wrong binding, and single-use consumption
 * under a CAS. Non-destructive actions stay cookie-only.
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

async function mint(admin, target, action) {
	const res = await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action }, admin.cookie));
	expect(res.status).toBe(200);
	return res.json();
}

describe("minting", () => {
	it("is admin-only and refuses unknown actions, unknown targets, and self-lockout", async () => {
		const admin = await signupAccount("mintadm");
		const target = await signupAccount("minttgt");
		expect((await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action: "delete" }))).status).toBe(401);
		expect((await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action: "delete" }, target.cookie))).status).toBe(403);
		await makeAdmin(admin.user.id);
		expect((await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action: "disable" }, admin.cookie))).status).toBe(400);
		expect((await request("/v1/admin/users/confirm", jsonInit({ userId: "usr_nope", action: "delete" }, admin.cookie))).status).toBe(404);
		expect((await request("/v1/admin/users/confirm", jsonInit({ userId: admin.user.id, action: "delete" }, admin.cookie))).status).toBe(400);

		const minted = await mint(admin, target, "promote");
		expect(minted.confirm_text).toBe(target.email);
		expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
		// Only the hash is stored.
		const row = await env.DB.prepare("SELECT token_hash FROM admin_action_confirmations WHERE target_user_id = ?").bind(target.user.id).first();
		expect(row.token_hash).not.toBe(minted.token);
	});
});

describe("the gated action door", () => {
	it("refuses without a token (428), with wrong typed text (403), and honors a valid confirmation", async () => {
		const admin = await signupAccount("gateadm");
		await makeAdmin(admin.user.id);
		const target = await signupAccount("gatetgt");

		const bare = await request("/v1/admin/users/action", jsonInit({ userId: target.user.id, action: "promote" }, admin.cookie));
		expect(bare.status).toBe(428);
		expect((await bare.json()).error).toBe("confirmation_required");

		const minted = await mint(admin, target, "promote");
		const wrongText = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: minted.token, confirm_text: "not-the-email",
		}, admin.cookie));
		expect(wrongText.status).toBe(403);
		expect((await wrongText.json()).error).toBe("confirmation_text_mismatch");

		const ok = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: minted.token, confirm_text: target.email,
		}, admin.cookie));
		expect(ok.status).toBe(200);
		const promoted = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first();
		expect(promoted.role).toBe("admin");

		// Replay of the consumed token: 409, and the role does not flap.
		const demoteWithSpent = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "demote",
			confirmation_token: minted.token, confirm_text: target.email,
		}, admin.cookie));
		expect(demoteWithSpent.status).toBe(409);

		// A fresh demote confirmation completes the round trip.
		const demoteMint = await mint(admin, target, "demote");
		const demoted = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "demote",
			confirmation_token: demoteMint.token, confirm_text: target.email,
		}, admin.cookie));
		expect(demoted.status).toBe(200);
		expect((await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first()).role).toBe("user");
	});

	it("refuses an expired token, a stale target, and a foreign actor — all 409, all fail-closed", async () => {
		const admin = await signupAccount("edgeadm");
		const otherAdmin = await signupAccount("edgeadm2");
		await makeAdmin(admin.user.id);
		await makeAdmin(otherAdmin.user.id);
		const target = await signupAccount("edgetgt");

		// Expired: age the row under the door's feet.
		const expired = await mint(admin, target, "promote");
		await env.DB.prepare(
			"UPDATE admin_action_confirmations SET expires_at = ? WHERE target_user_id = ? AND used_at IS NULL",
		).bind(Date.now() - 1000, target.user.id).run();
		const expiredTry = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: expired.token, confirm_text: target.email,
		}, admin.cookie));
		expect(expiredTry.status).toBe(409);
		expect((await expiredTry.json()).error).toBe("confirmation_expired");

		// Stale target: minted against one (role, status), consumed against another.
		const stale = await mint(admin, target, "promote");
		await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(target.user.id).run();
		const staleTry = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: stale.token, confirm_text: target.email,
		}, admin.cookie));
		expect(staleTry.status).toBe(409);
		expect((await staleTry.json()).error).toBe("confirmation_stale_target");
		await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(target.user.id).run();

		// Foreign actor: admin A's token is useless in admin B's hands.
		const foreign = await mint(admin, target, "promote");
		const foreignTry = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: foreign.token, confirm_text: target.email,
		}, otherAdmin.cookie));
		expect(foreignTry.status).toBe(409);
		expect((await foreignTry.json()).error).toBe("confirmation_invalid");

		// Nothing above changed the target.
		expect((await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first()).role).toBe("user");
	});

	it("still refuses self-lockout with 400 before any confirmation logic", async () => {
		const admin = await signupAccount("selfadm");
		await makeAdmin(admin.user.id);
		const res = await request("/v1/admin/users/action", jsonInit({ userId: admin.user.id, action: "delete" }, admin.cookie));
		expect(res.status).toBe(400);
	});

	it("erasing the target leaves no stable identifier in security_events, group keys included", async () => {
		const admin = await signupAccount("gkadm");
		await makeAdmin(admin.user.id);
		const target = await signupAccount("gktgt");
		const up = await mint(admin, target, "promote");
		await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: up.token, confirm_text: target.email,
		}, admin.cookie));
		const down = await mint(admin, target, "demote");
		await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "demote",
			confirmation_token: down.token, confirm_text: target.email,
		}, admin.cookie));
		// The role-change events now name the target in their group key.
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM security_events WHERE group_key = ?",
		).bind(`admin_role_change:${target.user.id}`).first("n");
		expect(Number(before)).toBe(1);

		const gone = await mint(admin, target, "delete");
		const del = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "delete",
			confirmation_token: gone.token, confirm_text: target.email,
		}, admin.cookie));
		expect(del.status).toBe(200);

		const leftover = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM security_events WHERE group_key LIKE '%' || ? || '%' OR actor_user_id = ? OR target_user_id = ? OR details_json LIKE '%' || ? || '%'",
		).bind(target.user.id, target.user.id, target.user.id, target.user.id).first("n");
		expect(Number(leftover)).toBe(0);
	});

	it("records the role change as a security event", async () => {
		const admin = await signupAccount("sigadm");
		await makeAdmin(admin.user.id);
		const target = await signupAccount("sigtgt");
		const minted = await mint(admin, target, "promote");
		const ok = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: minted.token, confirm_text: target.email,
		}, admin.cookie));
		expect(ok.status).toBe(200);
		const event = await env.DB.prepare(
			"SELECT kind, severity, actor_user_id, target_user_id FROM security_events WHERE group_key = ?",
		).bind(`admin_role_change:${target.user.id}`).first();
		expect(event.kind).toBe("admin_role_change");
		expect(event.severity).toBe("high");
		expect(event.actor_user_id).toBe(admin.user.id);
		expect(event.target_user_id).toBe(target.user.id);
	});
});
