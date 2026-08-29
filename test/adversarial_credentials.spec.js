/**
 * ADVERSARIAL: stale / revoked credentials and async races.
 *
 * Every test here tries to make a credential outlive the fact that authorized
 * it. Nothing is stubbed except the extraction LLM (`_test`), so each attack
 * runs against the real doors: the real revoke route, the real account
 * erasure, the real admin gate, the real membership resolution.
 *
 * A passing test in this file is a proof of DEFENCE, not of feature work.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function jsonInit(body, cookie) {
	return { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) };
}
function cookieFrom(res) { return res.headers.get("set-cookie")?.split(";")[0] || ""; }
async function signupAccount(prefix, emailOverride = null) {
	const email = emailOverride ?? `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}
async function makeAdmin(userId) { await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run(); }

// ---- shared helpers --------------------------------------------------------

const CANNED = {
	llmResponse: {
		objects: [
			{ kind: "node", label: "Probe fact", category: "other", confidence: 0.9 },
			{ kind: "slice", on: "Probe fact", text: "A durable probe detail.", kind_detail: "other", confidence: 0.9 },
		],
	},
	edgeResponse: { edges: [] },
	reflexionResponse: { entities: [], facts: [], edges: [] },
};

async function mintToken(cookie, label = "probe") {
	const res = await request("/auth/tokens", jsonInit({ type: "api", label }, cookie));
	expect(res.status).toBe(201);
	const body = await res.json();
	expect(body.token).toMatch(/^itsuki_live_/);
	return { token: body.token, id: body.tokenRecord.id };
}

function bearer(token, extra = {}) {
	return { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra };
}

function saveBody(content, extra = {}) {
	return JSON.stringify({ content, _test: CANNED, ...extra });
}

async function countFor(memoryUserId) {
	const [nodes, packets, receipts] = await env.DB.batch([
		env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(memoryUserId),
		env.DB.prepare("SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ? OR owner_user_id = ? OR memory_user_id = ?")
			.bind(memoryUserId, memoryUserId, memoryUserId),
		env.DB.prepare("SELECT COUNT(*) AS n FROM receipts WHERE user_id = ?").bind(memoryUserId),
	]);
	return {
		nodes: Number(nodes.results[0].n),
		packets: Number(packets.results[0].n),
		receipts: Number(receipts.results[0].n),
	};
}

// ============================================================================
// (a) REVOKED BEARER
// ============================================================================

describe("attack (a): a revoked bearer token", () => {
	it("stops reading AND writing the instant the real revoke door returns, and no refused write lands", async () => {
		const account = await signupAccount("revoke-bearer");
		const { token, id } = await mintToken(account.cookie);

		// 1. Prove the credential genuinely works first, on a read and a write.
		const readBefore = await request("/v1/status", { headers: bearer(token) });
		expect(readBefore.status).toBe(200);

		const writeBefore = await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("Before the revoke.") });
		expect(writeBefore.status).toBe(200);
		const scope = JSON.parse((await writeBefore.json()).receipt.scope_json ?? "{}");
		const memoryUserId = scope.memory_user_id;
		expect(memoryUserId).toBeTruthy();
		const before = await countFor(memoryUserId);
		expect(before.nodes).toBeGreaterThan(0);
		// Positive control for the leak probe below: a landed write IS findable
		// this way, so a later count of 0 means "nothing landed", not "bad query".
		const control = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%Before the revoke%'",
		).first();
		expect(Number(control.n)).toBe(1);

		// 2. Revoke through the real door.
		const revoke = await request(`/auth/tokens/${id}/revoke`, { method: "POST", headers: { cookie: account.cookie } });
		expect(revoke.status).toBe(200);
		expect((await revoke.json()).revoked).toBe(true);

		// 3. Reuse on every shape of door the token could reach.
		const readAfter = await request("/v1/status", { headers: bearer(token) });
		expect(readAfter.status).toBe(401);

		const recallAfter = await request("/v1/recall", { method: "POST", headers: bearer(token), body: JSON.stringify({ query: "probe" }) });
		expect(recallAfter.status).toBe(401);

		const writeAfter = await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("AFTER THE REVOKE — must never land.") });
		expect(writeAfter.status).toBe(401);

		const ingestAfter = await request("/v1/ingest", {
			method: "POST",
			headers: bearer(token),
			body: JSON.stringify({ messages: [{ role: "user", content: "after the revoke" }] }),
		});
		expect(ingestAfter.status).toBe(401);

		// The legacy alias header must not be a second front door for the same
		// dead secret.
		const aliasAfter = await request("/v1/status", { headers: { "x-uml-token": token } });
		expect(aliasAfter.status).toBe(401);

		// 4. Nothing the refused calls carried may have landed.
		const after = await countFor(memoryUserId);
		expect(after).toEqual(before);
		const leaked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%AFTER THE REVOKE%'",
		).first();
		expect(Number(leaked.n)).toBe(0);
	});

	it("stops working when the key is DELETED rather than revoked, and the row cannot be resurrected by use", async () => {
		const account = await signupAccount("delete-bearer");
		const { token, id } = await mintToken(account.cookie, "doomed");
		expect((await request("/v1/status", { headers: bearer(token) })).status).toBe(200);

		const gone = await request(`/auth/tokens/${id}`, { method: "DELETE", headers: { cookie: account.cookie } });
		expect(gone.status).toBe(200);
		expect((await gone.json()).deleted).toBe(true);

		expect((await request("/v1/status", { headers: bearer(token) })).status).toBe(401);
		const write = await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("DELETED KEY WRITE.") });
		expect(write.status).toBe(401);

		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM connection_tokens WHERE id = ?").bind(id).first();
		expect(Number(row.n)).toBe(0);
		const leaked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%DELETED KEY WRITE%'",
		).first();
		expect(Number(leaked.n)).toBe(0);
	});

	it("cannot open the MCP door after revocation", async () => {
		const account = await signupAccount("revoke-mcp");
		const res = await request("/auth/tokens", jsonInit({ type: "mcp", label: "mcp probe" }, account.cookie));
		expect(res.status).toBe(201);
		const { token, tokenRecord } = await res.json();

		const mcpCall = (t) => request("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${t}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
			}),
		});

		const ok = await mcpCall(token);
		// The live key gets a real MCP answer (200 JSON or 200 SSE).
		expect(ok.status).toBe(200);

		const revoke = await request(`/auth/tokens/${tokenRecord.id}/revoke`, { method: "POST", headers: { cookie: account.cookie } });
		expect(revoke.status).toBe(200);

		const dead = await mcpCall(token);
		const deadText = await dead.text();
		// Whatever the transport shape, it must not be an authenticated success.
		expect(dead.status).toBe(401);
		expect(deadText).not.toContain("serverInfo");
	});

	// RACE: fire writes concurrently with the revoke. The invariant is not
	// "which one wins" — it is that the answer and the durable state agree.
	it("race: every 200 landed and every 401 landed nothing, with revoke in flight", async () => {
		const account = await signupAccount("revoke-race");
		const { token, id } = await mintToken(account.cookie, "race");

		const seed = await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("Race seed.") });
		expect(seed.status).toBe(200);
		const memoryUserId = JSON.parse((await seed.json()).receipt.scope_json ?? "{}").memory_user_id;
		const before = await countFor(memoryUserId);

		// Start the revoke, then stagger writes across REAL D1 round-trips so
		// some are authorized before the revoke commits and some after. A single
		// Promise.all fan-out is not a race: all three saves authenticate in the
		// same tick and the refusal branch never runs.
		const revokeInFlight = request(`/auth/tokens/${id}/revoke`, { method: "POST", headers: { cookie: account.cookie } });
		const inFlight = [];
		for (let i = 0; i < 10; i++) {
			await env.DB.prepare("SELECT 1 AS tick").first();
			inFlight.push(request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody(`RACEWRITE ${i}.`) }));
		}
		const [revoked, ...saves] = await Promise.all([revokeInFlight, ...inFlight]);
		expect(revoked.status).toBe(200);
		const statuses = saves.map((r) => r.status);
		// Every save must be a clean allow or a clean refusal — never a 500.
		for (const status of statuses) expect([200, 401]).toContain(status);
		const allowed = statuses.filter((s) => s === 200).length;
		// The race genuinely straddled the revoke: at least one write was
		// refused, so the "refused write must not land" branch really ran.
		expect(allowed).toBeLessThan(statuses.length);

		// After the race settles, the credential is unambiguously dead.
		expect((await request("/v1/status", { headers: bearer(token) })).status).toBe(401);
		expect((await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("RACEWRITE late.") })).status).toBe(401);

		// Exactly the allowed writes landed: no refused write left a packet.
		const landed = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%RACEWRITE%'",
		).first();
		expect(Number(landed.n)).toBe(allowed);
		const after = await countFor(memoryUserId);
		expect(after.packets - before.packets).toBe(allowed);
	});
});

// ============================================================================
// (b) DISABLED / DELETED ACCOUNT
// ============================================================================

describe("attack (b): a session that outlives its account", () => {
	it("a disabled account's live cookie and live bearer key both stop at the memory doors", async () => {
		const account = await signupAccount("disabled");
		const { token } = await mintToken(account.cookie, "still-warm");

		const warmCookie = await request("/v1/status", { headers: { cookie: account.cookie } });
		expect(warmCookie.status).toBe(200);
		const warmWrite = await request("/v1/save", jsonInit({ content: "Before disable.", _test: CANNED }, account.cookie));
		expect(warmWrite.status).toBe(200);
		const memoryUserId = JSON.parse((await warmWrite.json()).receipt.scope_json ?? "{}").memory_user_id;
		const before = await countFor(memoryUserId);

		await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(account.user.id).run();

		expect((await request("/v1/status", { headers: { cookie: account.cookie } })).status).toBe(401);
		// /auth/me is a public probe: it answers 200 but must report nobody.
		const me = await request("/auth/me", { headers: { cookie: account.cookie } });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ authenticated: false, user: null });
		const blockedWrite = await request("/v1/save", jsonInit({ content: "DISABLED WRITE.", _test: CANNED }, account.cookie));
		expect(blockedWrite.status).toBe(401);
		// The key minted while active dies with the account too.
		expect((await request("/v1/status", { headers: bearer(token) })).status).toBe(401);
		expect((await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("DISABLED KEY WRITE.") })).status).toBe(401);

		expect(await countFor(memoryUserId)).toEqual(before);
		const leaked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%DISABLED WRITE%' OR content_preview LIKE '%DISABLED KEY WRITE%'",
		).first();
		expect(Number(leaked.n)).toBe(0);
	});

	it("an erased account's cookie authenticates nothing and resurrects nothing", async () => {
		const account = await signupAccount("erased");
		const { token } = await mintToken(account.cookie, "pre-erasure");
		const warm = await request("/v1/save", jsonInit({ content: "Before erasure.", _test: CANNED }, account.cookie));
		expect(warm.status).toBe(200);

		const erased = await deleteAccountCompletely(env, account.user.id);
		expect(erased.deleted).toBe(true);

		const snapshot = async () => {
			const [sessions, projects, tokens, packets, nodes, users] = await env.DB.batch([
				env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL").bind(account.user.id),
				env.DB.prepare("SELECT COUNT(*) AS n FROM managed_projects WHERE owner_user_id = ? AND status = 'active'").bind(account.user.id),
				env.DB.prepare("SELECT COUNT(*) AS n FROM connection_tokens WHERE user_id = ? AND revoked_at IS NULL").bind(account.user.id),
				env.DB.prepare("SELECT COUNT(*) AS n FROM source_packets WHERE owner_user_id = ? OR user_id = ?").bind(account.user.id, account.user.id),
				env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(account.user.id),
				env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ? AND status = 'active'").bind(account.user.id),
			]);
			return [sessions, projects, tokens, packets, nodes, users].map((r) => Number(r.results[0].n));
		};
		const afterErasure = await snapshot();
		// Erasure itself must leave nothing live.
		expect(afterErasure.slice(0, 3)).toEqual([0, 0, 0]);
		expect(afterErasure[5]).toBe(0);

		// Now attack with the stale cookie and the stale key across the doors
		// that are known to lazily CREATE state (bootstrap / project list).
		// /auth/me is the public probe: 200, but it must name nobody.
		const me = await request("/auth/me", { headers: { cookie: account.cookie } });
		expect(me.status).toBe(200);
		const mePayload = await me.json();
		expect(mePayload).toMatchObject({ authenticated: false, user: null });
		expect(JSON.stringify(mePayload)).not.toContain(account.user.id);

		const probes = {
			"/auth/bootstrap": await request("/auth/bootstrap", { headers: { cookie: account.cookie } }),
			"/auth/projects": await request("/auth/projects", { headers: { cookie: account.cookie } }),
			"/v1/status (cookie)": await request("/v1/status", { headers: { cookie: account.cookie } }),
			"/v1/save (cookie)": await request("/v1/save", jsonInit({ content: "ERASEDWRITE cookie.", _test: CANNED }, account.cookie)),
			"/v1/status (bearer)": await request("/v1/status", { headers: bearer(token) }),
			"/v1/save (bearer)": await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("ERASEDWRITE key.") }),
		};
		for (const [label, res] of Object.entries(probes)) {
			expect(`${label}:${res.status}`).toBe(`${label}:401`);
		}

		// And nothing was recreated by the attempt.
		expect(await snapshot()).toEqual(afterErasure);
		const leaked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%ERASEDWRITE%'",
		).first();
		expect(Number(leaked.n)).toBe(0);

		// Signing in again with the same password must not work either.
		const relogin = await request("/auth/login", jsonInit({ email: account.email, password: "correct-horse" }));
		expect(relogin.status).toBe(401);
	});

	/**
	 * CONFIRMED BREACH — erasure is not durable against the legacy operator lane.
	 *
	 * Every managed lane (session / bearer / OAuth) carries an `account_user_id`
	 * in its source meta, and UserMemory#assertManagedLifecycleActive refuses the
	 * write when that id has an account_erasure_tombstones row. The legacy
	 * x-api-key lane resolves to `{ type: "legacy" }` (src/index.js:632) and
	 * resolveScopedMemory stamps `ownerUserId: "legacy"` with NO accountUserId
	 * (src/index.js:758-768), so the DO guard returns early and never reads the
	 * tombstone — even though the memory space being written is literally
	 * `nodes.user_id = <erased account id>`, the same namespace erasure emptied
	 * and the same one GET /v1/admin/users attributes back to that account.
	 *
	 * This test asserts the DEFENDED behaviour. It fails today; the failure is
	 * the finding.
	 */
	it("the legacy operator key cannot refill an erased account's memory space", async () => {
		const account = await signupAccount("erased-legacy");
		const warm = await request("/v1/save", jsonInit({ content: "Pre-erasure legacy.", _test: CANNED }, account.cookie));
		expect(warm.status).toBe(200);

		expect((await deleteAccountCompletely(env, account.user.id)).deleted).toBe(true);
		const emptied = await countFor(account.user.id);
		expect(emptied.nodes).toBe(0);
		// The tombstone that every managed lane consults is in place.
		const tombstone = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM account_erasure_tombstones WHERE user_id = ?",
		).bind(account.user.id).first();
		expect(Number(tombstone.n)).toBe(1);

		const attack = await request("/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({ userId: account.user.id, content: "RESURRECT via operator key.", _test: CANNED }),
		});
		const refilled = await countFor(account.user.id);
		const planted = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%RESURRECT via operator key%'",
		).first();

		// And the resurrection is PERMANENT: re-running erasure sees no users row,
		// short-circuits on `already_deleted`, and never revisits the namespace.
		const reErase = await deleteAccountCompletely(env, account.user.id);
		const afterReErase = await countFor(account.user.id);

		expect({
			save_status: attack.status,
			packets_planted_in_erased_space: Number(planted.n),
			nodes_in_erased_space: refilled.nodes,
			re_erase: reErase,
			nodes_after_re_erase: afterReErase.nodes,
		}).toEqual({
			// 403, not 401: the operator key IS a valid credential, it simply
			// may not write into a space that has been erased.
			save_status: 403,
			packets_planted_in_erased_space: 0,
			nodes_in_erased_space: emptied.nodes,
			re_erase: { deleted: false, already_deleted: true, memory_spaces: 0 },
			nodes_after_re_erase: emptied.nodes,
		});
	});
});

// ============================================================================
// (c) ROLE REVOCATION MID-USE
// ============================================================================

describe("attack (c): role revoked while the session is still open", () => {
	it("a demoted admin's existing cookie is refused by the admin doors (role is read fresh, not cached)", async () => {
		const admin = await signupAccount("role-admin");
		const victim = await signupAccount("role-victim");
		await makeAdmin(admin.user.id);

		// The cookie predates the promotion; it must still see the fresh role.
		const before = await request("/v1/admin/users", { headers: { cookie: admin.cookie } });
		expect(before.status).toBe(200);

		await env.DB.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(admin.user.id).run();

		const readAfter = await request("/v1/admin/users", { headers: { cookie: admin.cookie } });
		expect(readAfter.status).toBe(403);

		const actAfter = await request(
			"/v1/admin/users/action",
			jsonInit({ userId: victim.user.id, action: "disable" }, admin.cookie),
		);
		expect(actAfter.status).toBe(403);

		const confirmAfter = await request(
			"/v1/admin/users/confirm",
			jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie),
		);
		expect(confirmAfter.status).toBe(403);

		const stats = await request("/v1/admin/stats", { headers: { cookie: admin.cookie } });
		expect(stats.status).toBe(403);

		// The victim is untouched.
		const row = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(row.status).toBe("active");
	});

	it("a step-up confirmation minted while admin is worthless after the demotion", async () => {
		const admin = await signupAccount("stepup-admin");
		const victim = await signupAccount("stepup-victim");
		await makeAdmin(admin.user.id);

		const minted = await request(
			"/v1/admin/users/confirm",
			jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie),
		);
		expect(minted.status).toBe(200);
		const confirmation = await minted.json();
		expect(confirmation.token).toBeTruthy();

		await env.DB.prepare("UPDATE users SET role = 'user' WHERE id = ?").bind(admin.user.id).run();

		const replay = await request("/v1/admin/users/action", jsonInit({
			userId: victim.user.id,
			action: "delete",
			confirmation_token: confirmation.token,
			confirm_text: confirmation.confirm_text,
		}, admin.cookie));
		expect(replay.status).toBe(403);

		const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(Number(still.n)).toBe(1);
	});

	it("a step-up confirmation does not survive its own session being revoked", async () => {
		const admin = await signupAccount("stepup-session");
		const victim = await signupAccount("stepup-session-victim");
		await makeAdmin(admin.user.id);

		const minted = await request(
			"/v1/admin/users/confirm",
			jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie),
		);
		expect(minted.status).toBe(200);
		const confirmation = await minted.json();

		// Log every session out, then sign back in: same human, same role, a
		// DIFFERENT session. The confirmation was bound to the old one.
		const logoutAll = await request("/auth/logout-all", jsonInit({}, admin.cookie));
		expect(logoutAll.status).toBe(200);
		const relogin = await request("/auth/login", jsonInit({ email: admin.email, password: "correct-horse" }));
		expect(relogin.status).toBe(200);
		const freshCookie = cookieFrom(relogin);

		// The old cookie itself is dead.
		expect((await request("/v1/admin/users", { headers: { cookie: admin.cookie } })).status).toBe(401);

		const replay = await request("/v1/admin/users/action", jsonInit({
			userId: victim.user.id,
			action: "delete",
			confirmation_token: confirmation.token,
			confirm_text: confirmation.confirm_text,
		}, freshCookie));
		expect(replay.status).not.toBe(200);
		expect(await replay.json()).toMatchObject({ error: expect.stringContaining("confirmation") });

		const still = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(Number(still.n)).toBe(1);
	});
});

// ============================================================================
// (d) STALE MEMBERSHIP
// ============================================================================

async function buildSharedProject() {
	const owner = await signupAccount("org-owner");
	const created = await request("/auth/organizations", jsonInit({ name: `Probe Org ${crypto.randomUUID().slice(0, 8)}` }, owner.cookie));
	expect(created.status).toBe(201);
	const { organization, project } = await created.json();

	// Owner puts a memory in the project's shared space.
	const seeded = await request("/v1/save", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: owner.cookie, "x-itsuki-project": project.id },
		body: saveBody("Owner-only project secret."),
	});
	expect(seeded.status).toBe(200);
	const memoryUserId = JSON.parse((await seeded.json()).receipt.scope_json ?? "{}").memory_user_id;

	const memberEmail = `org-member-${crypto.randomUUID()}@example.com`;
	const invited = await request("/v1/settings/invitations", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: owner.cookie, "x-itsuki-project": project.id },
		body: JSON.stringify({ email: memberEmail, org_role: "member", project_role: "member" }),
	});
	expect(invited.status).toBe(201);
	const link = (await invited.json()).link;
	const inviteToken = link.split("#invite=")[1];
	expect(inviteToken).toBeTruthy();

	const member = await signupAccount("org-member", memberEmail);
	const accepted = await request("/v1/settings/invitations/accept", jsonInit({ token: inviteToken }, member.cookie));
	expect(accepted.status).toBe(200);
	expect((await accepted.json()).ok).toBe(true);

	return { owner, member, organization, project, memoryUserId };
}

describe("attack (d): membership removed under a live session", () => {
	it("a removed project member cannot read the project's memory with the same session", async () => {
		const { member, organization, project, memoryUserId } = await buildSharedProject();
		const headers = { cookie: member.cookie, "x-itsuki-project": project.id };

		// The membership genuinely opens the OWNER's memory space.
		const readBefore = await request("/v1/status", { headers });
		expect(readBefore.status).toBe(200);
		const seen = await readBefore.json();
		expect(seen.nodes).toBeGreaterThan(0);
		const ownerNodes = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL").bind(memoryUserId).first();
		expect(seen.nodes).toBe(Number(ownerNodes.n));

		// Yank the project seat in D1 — the state a removal leaves behind.
		const removed = await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
			.bind(project.id, member.user.id).run();
		expect(Number(removed.meta.changes)).toBe(1);

		// Same cookie, same header, same door.
		const readAfter = await request("/v1/status", { headers });
		expect(readAfter.status).not.toBe(200);
		expect([403, 404]).toContain(readAfter.status);

		const recallAfter = await request("/v1/recall", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ query: "project secret" }),
		});
		expect(recallAfter.status).not.toBe(200);

		const writeAfter = await request("/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: saveBody("STALEMEMBER write."),
		});
		expect(writeAfter.status).not.toBe(200);

		const settingsAfter = await request("/v1/settings", { headers });
		expect(settingsAfter.status).not.toBe(200);

		const leaked = await env.DB.prepare("SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%STALEMEMBER%'").first();
		expect(Number(leaked.n)).toBe(0);

		// The project must also disappear from the member's own project list.
		const list = await request("/auth/projects", { headers: { cookie: member.cookie } });
		expect(list.status).toBe(200);
		const projects = (await list.json()).projects ?? [];
		expect(projects.some((p) => p.id === project.id)).toBe(false);
		expect(organization.id).toBeTruthy();
	});

	it("an expired access window on a still-present seat is refused just as hard", async () => {
		const { member, project } = await buildSharedProject();
		const headers = { cookie: member.cookie, "x-itsuki-project": project.id };
		expect((await request("/v1/status", { headers })).status).toBe(200);

		// The seat row survives; only its access window has lapsed.
		const expired = await env.DB.prepare(
			"UPDATE project_members SET access_expires_at = ? WHERE project_id = ? AND user_id = ?",
		).bind(Date.now() - 60_000, project.id, member.user.id).run();
		expect(Number(expired.meta.changes)).toBe(1);

		const after = await request("/v1/status", { headers });
		expect(after.status).not.toBe(200);
		expect([403, 404]).toContain(after.status);
	});

	it("removing only the ORGANIZATION seat closes the project too", async () => {
		const { member, organization, project } = await buildSharedProject();
		const headers = { cookie: member.cookie, "x-itsuki-project": project.id };
		expect((await request("/v1/status", { headers })).status).toBe(200);

		const removed = await env.DB.prepare("DELETE FROM organization_members WHERE org_id = ? AND user_id = ?")
			.bind(organization.id, member.user.id).run();
		expect(Number(removed.meta.changes)).toBe(1);

		const after = await request("/v1/status", { headers });
		expect(after.status).not.toBe(200);
		expect([403, 404]).toContain(after.status);
	});

	it("a bearer key the member minted for the shared project dies with the membership", async () => {
		const { member, project } = await buildSharedProject();
		const minted = await request("/auth/tokens", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: member.cookie, "x-itsuki-project": project.id },
			body: JSON.stringify({ type: "api", label: "member key" }),
		});
		expect(minted.status).toBe(201);
		const { token } = await minted.json();

		const before = await request("/v1/status", { headers: bearer(token) });
		expect(before.status).toBe(200);

		await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
			.bind(project.id, member.user.id).run();

		const after = await request("/v1/status", { headers: bearer(token) });
		expect(after.status).not.toBe(200);

		const write = await request("/v1/save", { method: "POST", headers: bearer(token), body: saveBody("STALEKEY write.") });
		expect(write.status).not.toBe(200);
		const leaked = await env.DB.prepare("SELECT COUNT(*) AS n FROM source_packets WHERE content_preview LIKE '%STALEKEY%'").first();
		expect(Number(leaked.n)).toBe(0);
	});
});
