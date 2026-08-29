/**
 * ADVERSARIAL: IDOR on control-plane objects + admin boundary probing.
 *
 * Nothing here is a happy path. Every test tries to make one account act on
 * another account's control-plane object (webhook, API key) or to reach an
 * admin door with a credential that is not an admin browser session, and then
 * proves — from the database, not from the response body — whether the state
 * moved.
 *
 * Written as an attack, so a PASSING test means the attack was refused and the
 * victim's row is byte-identical afterwards. A failing test here is a breach.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { newId } from "../src/lib/ids.js";

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
async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}
async function makeAdmin(userId) { await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run(); }

/** Register a webhook and return the full private row plus the one-time secret. */
async function createWebhookFor(cookie, name, url = "https://hooks.example.com/target") {
	const res = await request("/v1/webhooks", jsonInit({ name, url, events: ["memory.added"] }, cookie));
	expect(res.status).toBe(201);
	const body = await res.json();
	const row = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(body.webhook.id).first();
	return { id: body.webhook.id, secret: body.secret, row };
}

/** Mint a Bearer connection token through the real session door. */
async function mintToken(cookie, label = "probe key") {
	const res = await request("/auth/tokens", jsonInit({ label, type: "api" }, cookie));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { token: body.token, id: body.tokenRecord.id };
}

/** The default managed project id the session is bound to. */
async function projectIdFor(cookie) {
	const res = await request("/auth/tokens", { headers: { cookie } });
	expect(res.status).toBe(200);
	return (await res.json()).project.id;
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function webhookRow(id) {
	return env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first();
}
async function deliveryCount(webhookId) {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?").bind(webhookId).first();
	return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// (a) /v1/webhooks/:id — cross-account object access
// ---------------------------------------------------------------------------

describe("ATTACK (a): IDOR on another account's webhook", () => {
	it("refuses every verb A points at B's webhook id, and leaves B's row and secret untouched", async () => {
		const victim = await signupAccount("wh-victim");
		const attacker = await signupAccount("wh-attacker");
		const hook = await createWebhookFor(victim.cookie, "victim hook", "https://hooks.example.com/victim-endpoint");
		expect(hook.row.user_id).toBe(victim.user.id);
		expect(hook.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

		// The attacker holds a real, fully-authenticated session — this is an
		// authorization probe, not an authentication one.
		const attempts = {
			get: await request(`/v1/webhooks/${hook.id}`, { headers: { cookie: attacker.cookie } }),
			patch: await request(`/v1/webhooks/${hook.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json", cookie: attacker.cookie },
				body: JSON.stringify({ url: "https://evil.example.com/exfil" }),
			}),
			deliveries: await request(`/v1/webhooks/${hook.id}/deliveries`, { headers: { cookie: attacker.cookie } }),
			del: await request(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers: { cookie: attacker.cookie } }),
		};

		// No read door for a single webhook exists at all; PATCH is not a verb
		// this resource answers. Both fall through to the 404.
		expect(attempts.get.status).toBe(404);
		expect(attempts.patch.status).toBe(404);

		// Deliveries IS a real door and it answers 200 — but scoped to the
		// caller, so the attacker sees an empty list, not the victim's log.
		expect(attempts.deliveries.status).toBe(200);
		expect((await attempts.deliveries.json()).deliveries).toEqual([]);

		// DELETE is the dangerous one: it answers 200 with deleted:false.
		expect(attempts.del.status).toBe(200);
		expect(await attempts.del.json()).toMatchObject({ deleted: false });

		// The authoritative check: the victim's row is byte-identical.
		const after = await webhookRow(hook.id);
		expect(after).toBeTruthy();
		expect(after.user_id).toBe(victim.user.id);
		expect(after.secret).toBe(hook.row.secret);
		expect(after.url).toBe("https://hooks.example.com/victim-endpoint");
		expect(after.status).toBe("active");
		expect(after.updated_at).toBe(hook.row.updated_at);

		// And the attacker's own inventory never contains it.
		const list = await request("/v1/webhooks", { headers: { cookie: attacker.cookie } });
		expect((await list.json()).webhooks.map((w) => w.id)).not.toContain(hook.id);
	});

	it("cannot use B's webhook /test as an SSRF trigger — no delivery is ever queued", async () => {
		const victim = await signupAccount("ssrf-victim");
		const attacker = await signupAccount("ssrf-attacker");
		const hook = await createWebhookFor(victim.cookie, "ssrf target", "https://hooks.example.com/ssrf-probe");
		expect(await deliveryCount(hook.id)).toBe(0);

		const fired = await request(`/v1/webhooks/${hook.id}/test`, jsonInit({}, attacker.cookie));
		expect(fired.status).toBe(404);
		expect(await fired.json()).toMatchObject({ error: "not_found" });

		// The outbound leg is gated on the INSERT: zero rows means zero fetches.
		expect(await deliveryCount(hook.id)).toBe(0);

		// The refusal is indistinguishable from a webhook that does not exist,
		// so the door is not an existence oracle for other accounts' ids.
		const ghost = await request(`/v1/webhooks/${newId("wh")}/test`, jsonInit({}, attacker.cookie));
		expect(ghost.status).toBe(404);
		expect(await ghost.json()).toEqual(await (await request(`/v1/webhooks/${hook.id}/test`, jsonInit({}, attacker.cookie))).json());
		expect(await deliveryCount(hook.id)).toBe(0);
	});

	it("POSITIVE CONTROL: the same doors work for the owner (so the 404s above are refusals, not dead routes)", async () => {
		const owner = await signupAccount("wh-owner");
		const hook = await createWebhookFor(owner.cookie, "owner hook", "https://hooks.example.com/owner-endpoint");

		// Point the stored target at a blocked host so the delivery worker's
		// re-check refuses to connect on attempt 1 — the queue-and-dispatch
		// path still runs end to end, without a real outbound leg or backoff.
		await env.DB.prepare("UPDATE webhooks SET url = 'http://127.0.0.1:9/blocked' WHERE id = ?").bind(hook.id).run();

		const fired = await request(`/v1/webhooks/${hook.id}/test`, jsonInit({}, owner.cookie));
		expect(fired.status).toBe(200);
		expect(await fired.json()).toMatchObject({ ok: true, sent: true });
		expect(await deliveryCount(hook.id)).toBe(1);

		const deleted = await request(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ deleted: true });
		expect(await webhookRow(hook.id)).toBeNull();
	});

	it("answers a foreign id and a never-existed id identically (no existence oracle)", async () => {
		const victim = await signupAccount("oracle-victim");
		const attacker = await signupAccount("oracle-attacker");
		const hook = await createWebhookFor(victim.cookie, "oracle hook");
		const ghostId = newId("wh");

		const foreignDelete = await request(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers: { cookie: attacker.cookie } });
		const ghostDelete = await request(`/v1/webhooks/${ghostId}`, { method: "DELETE", headers: { cookie: attacker.cookie } });
		expect(foreignDelete.status).toBe(ghostDelete.status);
		expect(await foreignDelete.json()).toEqual(await ghostDelete.json());

		const foreignLog = await request(`/v1/webhooks/${hook.id}/deliveries`, { headers: { cookie: attacker.cookie } });
		const ghostLog = await request(`/v1/webhooks/${ghostId}/deliveries`, { headers: { cookie: attacker.cookie } });
		expect(foreignLog.status).toBe(ghostLog.status);
		expect(await foreignLog.json()).toEqual(await ghostLog.json());

		expect(await webhookRow(hook.id)).toBeTruthy();
	});

	it("cannot borrow B's project id via the x-itsuki-project header to reach B's webhooks", async () => {
		const victim = await signupAccount("proj-victim");
		const attacker = await signupAccount("proj-attacker");
		const hook = await createWebhookFor(victim.cookie, "project hook", "https://hooks.example.com/project-endpoint");
		const victimProject = await projectIdFor(victim.cookie);

		const headers = { cookie: attacker.cookie, "x-itsuki-project": victimProject };
		const listed = await request("/v1/webhooks", { headers });
		expect(listed.status).toBe(404);
		expect(await listed.json()).toMatchObject({ error: "project_not_found" });

		const del = await request(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers });
		expect(del.status).toBe(404);
		expect(await webhookRow(hook.id)).toBeTruthy();

		const fired = await request(`/v1/webhooks/${hook.id}/test`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: "{}",
		});
		expect(fired.status).toBe(404);
		expect(await deliveryCount(hook.id)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// (b) /auth/tokens/:id — denial of service by revoking someone else's key
// ---------------------------------------------------------------------------

describe("ATTACK (b): IDOR on another account's API key", () => {
	it("A cannot revoke or delete B's key, and B's key still authenticates afterwards", async () => {
		const victim = await signupAccount("tok-victim");
		const attacker = await signupAccount("tok-attacker");
		const key = await mintToken(victim.cookie, "victim key");

		// Baseline: the key is live.
		const before = await request("/v1/memories?limit=1", { headers: bearer(key.token) });
		expect(before.status).toBe(200);

		const revoke = await request(`/auth/tokens/${key.id}/revoke`, jsonInit({}, attacker.cookie));
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toMatchObject({ revoked: false });

		const del = await request(`/auth/tokens/${key.id}`, { method: "DELETE", headers: { cookie: attacker.cookie } });
		expect(del.status).toBe(200);
		expect(await del.json()).toMatchObject({ deleted: false });

		// State proof: the row is untouched.
		const row = await env.DB.prepare("SELECT user_id, status, revoked_at FROM connection_tokens WHERE id = ?").bind(key.id).first();
		expect(row).toBeTruthy();
		expect(row.user_id).toBe(victim.user.id);
		expect(row.status).toBe("active");
		expect(row.revoked_at).toBeNull();

		// Behaviour proof: the secret still opens the door it opened before.
		const after = await request("/v1/memories?limit=1", { headers: bearer(key.token) });
		expect(after.status).toBe(200);

		// The attacker's own key list never contained it.
		const list = await request("/auth/tokens", { headers: { cookie: attacker.cookie } });
		expect((await list.json()).tokens.map((t) => t.id)).not.toContain(key.id);
	});

	it("cannot reach B's key by pointing the project header at B's project", async () => {
		const victim = await signupAccount("tokproj-victim");
		const attacker = await signupAccount("tokproj-attacker");
		const key = await mintToken(victim.cookie, "victim project key");
		const victimProject = await projectIdFor(victim.cookie);

		const del = await request(`/auth/tokens/${key.id}`, {
			method: "DELETE",
			headers: { cookie: attacker.cookie, "x-itsuki-project": victimProject },
		});
		expect(del.status).toBe(404);
		expect(await del.json()).toMatchObject({ error: "project_not_found" });

		const row = await env.DB.prepare("SELECT status, revoked_at FROM connection_tokens WHERE id = ?").bind(key.id).first();
		expect(row.status).toBe("active");
		expect(row.revoked_at).toBeNull();
		expect((await request("/v1/memories?limit=1", { headers: bearer(key.token) })).status).toBe(200);
	});

	it("POSITIVE CONTROL: the owner's own delete does kill the key", async () => {
		const owner = await signupAccount("tok-owner");
		const key = await mintToken(owner.cookie, "owner key");
		expect((await request("/v1/memories?limit=1", { headers: bearer(key.token) })).status).toBe(200);

		const del = await request(`/auth/tokens/${key.id}`, { method: "DELETE", headers: { cookie: owner.cookie } });
		expect(del.status).toBe(200);
		expect(await del.json()).toMatchObject({ deleted: true });
		expect(await env.DB.prepare("SELECT 1 FROM connection_tokens WHERE id = ?").bind(key.id).first()).toBeNull();
		expect((await request("/v1/memories?limit=1", { headers: bearer(key.token) })).status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// Cross-cutting: the control plane is session-only. The legacy x-api-key is a
// single global secret with no account identity; if it reached these doors it
// would be a master key over every tenant's webhooks and credentials.
// ---------------------------------------------------------------------------

describe("ATTACK (a+b): non-session credentials on the control plane", () => {
	it("neither the legacy x-api-key nor a Bearer token can read or destroy control-plane objects", async () => {
		const victim = await signupAccount("cp-victim");
		const hook = await createWebhookFor(victim.cookie, "cp hook", "https://hooks.example.com/cp-endpoint");
		const key = await mintToken(victim.cookie, "cp key");
		const outsider = await signupAccount("cp-outsider");
		const outsiderKey = await mintToken(outsider.cookie, "outsider key");

		const credentials = [
			["x-api-key", { "x-api-key": env.API_KEY }],
			["own-bearer", bearer(key.token)],
			["other-bearer", bearer(outsiderKey.token)],
		];
		const seen = [];
		for (const [name, headers] of credentials) {
			seen.push([`${name} list-webhooks`, (await request("/v1/webhooks", { headers })).status]);
			seen.push([`${name} delete-webhook`, (await request(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers })).status]);
			seen.push([`${name} test-webhook`, (await request(`/v1/webhooks/${hook.id}/test`, {
				method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
			})).status]);
			seen.push([`${name} list-keys`, (await request("/auth/tokens", { headers })).status]);
			seen.push([`${name} delete-key`, (await request(`/auth/tokens/${key.id}`, { method: "DELETE", headers })).status]);
			seen.push([`${name} revoke-key`, (await request(`/auth/tokens/${key.id}/revoke`, {
				method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
			})).status]);
		}
		expect(seen.every(([, status]) => status === 401 || status === 403), JSON.stringify(seen)).toBe(true);

		// State proofs.
		expect(await webhookRow(hook.id)).toBeTruthy();
		expect(await deliveryCount(hook.id)).toBe(0);
		const row = await env.DB.prepare("SELECT status, revoked_at FROM connection_tokens WHERE id = ?").bind(key.id).first();
		expect(row.status).toBe("active");
		expect(row.revoked_at).toBeNull();
		expect((await request("/v1/memories?limit=1", { headers: bearer(key.token) })).status).toBe(200);
	});

	it("mass assignment: owner fields in the create bodies are ignored or refused", async () => {
		const victim = await signupAccount("mass-victim");
		const attacker = await signupAccount("mass-attacker");
		const victimProject = await projectIdFor(victim.cookie);

		// Webhook create whitelists its fields, so a planted id/user_id is a 400
		// rather than a silently-honoured owner override.
		const plantedHook = await request("/v1/webhooks", jsonInit({
			name: "planted", url: "https://hooks.example.com/planted", events: ["memory.added"],
			id: "wh_planted", user_id: victim.user.id,
		}, attacker.cookie));
		expect(plantedHook.status).toBe(400);
		expect((await plantedHook.json()).error).toBe("unknown_webhook_field");
		expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?")
			.bind(victim.user.id).first()).n)).toBe(0);

		// Key create takes label/type/scopes/rules from the body and the owner
		// from the session. Planted owner fields must not move the row.
		const plantedKey = await request("/auth/tokens", jsonInit({
			label: "planted", type: "api",
			userId: victim.user.id, user_id: victim.user.id, project_id: victimProject,
		}, attacker.cookie));
		expect(plantedKey.status).toBe(201);
		const record = (await plantedKey.json()).tokenRecord;
		const row = await env.DB.prepare("SELECT user_id, project_id FROM connection_tokens WHERE id = ?").bind(record.id).first();
		expect(row.user_id).toBe(attacker.user.id);
		expect(row.project_id).not.toBe(victimProject);
	});

	it("a self-minted wildcard-scope token is still confined to its own account", async () => {
		const victim = await signupAccount("scope-victim");
		const attacker = await signupAccount("scope-attacker");
		// Plant a memory in the victim's space directly, so the read below has
		// something real to fail to find.
		const nodeId = newId("node");
		const canary = `canary-${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at) VALUES (?, ?, ?, 'fact', 'active', ?, ?, ?)",
		).bind(nodeId, victim.user.id, canary, canary, Date.now(), Date.now()).run();

		// scopes[] is taken verbatim from the request body, so the attacker mints
		// the strongest credential the system can express.
		const minted = await request("/auth/tokens", jsonInit({ label: "wildcard", type: "api", scopes: ["*"] }, attacker.cookie));
		expect(minted.status).toBe(201);
		const wild = await minted.json();
		expect(wild.tokenRecord.scopes).toEqual(["*"]);

		// It works — on the attacker's own account.
		expect((await request("/v1/memories?limit=5", { headers: bearer(wild.token) })).status).toBe(200);

		// Aiming it at the victim's account id yields a derived sub-namespace,
		// never the victim's own memory space.
		const crossed = await request(`/v1/memories?limit=50&userId=${encodeURIComponent(victim.user.id)}`, { headers: bearer(wild.token) });
		expect(crossed.status).toBe(200);
		const crossedBody = await crossed.json();
		expect(crossedBody.memories ?? crossedBody.items ?? []).toEqual([]);
		expect(JSON.stringify(crossedBody)).not.toContain(canary);

		const direct = await request(`/v1/memories/${nodeId}`, { headers: bearer(wild.token) });
		expect(direct.status).toBe(404);
		const crossedDirect = await request(`/v1/memories/${nodeId}?userId=${encodeURIComponent(victim.user.id)}`, { headers: bearer(wild.token) });
		expect(crossedDirect.status).toBe(404);

		// And a wildcard scope buys nothing at the operator doors.
		for (const path of ADMIN_READS) {
			const res = await request(path, { headers: bearer(wild.token) });
			expect([path, res.status]).toEqual([path, 401]);
		}

		// The victim can still see their own row — the 404s above are isolation,
		// not a missing record.
		const owner = await request(`/v1/memories/${nodeId}`, { headers: { cookie: victim.cookie } });
		expect(owner.status).toBe(200);
		expect(JSON.stringify(await owner.json())).toContain(canary);
	});

	it("a userId query parameter cannot redirect a control-plane door at another account", async () => {
		const victim = await signupAccount("qs-victim");
		const attacker = await signupAccount("qs-attacker");
		const hook = await createWebhookFor(victim.cookie, "qs hook");
		const key = await mintToken(victim.cookie, "qs key");

		const listed = await request(`/v1/webhooks?userId=${encodeURIComponent(victim.user.id)}`, { headers: { cookie: attacker.cookie } });
		expect(listed.status).toBe(200);
		expect((await listed.json()).webhooks).toEqual([]);

		const keys = await request(`/auth/tokens?userId=${encodeURIComponent(victim.user.id)}`, { headers: { cookie: attacker.cookie } });
		expect(keys.status).toBe(200);
		expect((await keys.json()).tokens.map((t) => t.id)).not.toContain(key.id);

		expect(await webhookRow(hook.id)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// (c) /v1/admin/* — the operator boundary
// ---------------------------------------------------------------------------

const ADMIN_READS = [
	"/v1/admin/stats",
	"/v1/admin/users",
	"/v1/admin/audit-feed",
	"/v1/admin/trust/overview",
	"/v1/admin/errors",
	"/v1/admin/ai-routing",
	"/v1/admin/ai-spend",
	"/v1/admin/upgrade-requests",
	"/v1/admin/user-journey?userId=whoever",
];

async function seedTrustCase() {
	const id = newId("case");
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO trust_cases (id, user_id, kind, severity, status, message, received_at, updated_at)
		 VALUES (?, NULL, 'security_report', 'high', 'received', 'probe', ?, ?)`,
	).bind(id, now, now).run();
	return id;
}

describe("ATTACK (c): admin boundary with non-admin credentials", () => {
	it("legacy x-api-key cannot read any admin door", async () => {
		const seen = [];
		for (const path of ADMIN_READS) {
			const res = await request(path, { headers: { "x-api-key": env.API_KEY } });
			seen.push([path, res.status]);
		}
		expect(seen.every(([, status]) => status === 401 || status === 403), JSON.stringify(seen)).toBe(true);
	});

	it("a normal account's Bearer API token cannot read any admin door", async () => {
		const normal = await signupAccount("adm-bearer");
		const key = await mintToken(normal.cookie, "bearer probe");
		// The token is genuinely valid on the product surface.
		expect((await request("/v1/memories?limit=1", { headers: bearer(key.token) })).status).toBe(200);

		const seen = [];
		for (const path of ADMIN_READS) {
			const res = await request(path, { headers: bearer(key.token) });
			seen.push([path, res.status]);
		}
		expect(seen.every(([, status]) => status === 401 || status === 403), JSON.stringify(seen)).toBe(true);
	});

	it("a valid NON-admin session cookie cannot read any admin door", async () => {
		const normal = await signupAccount("adm-session");
		expect(normal.user.role ?? "user").not.toBe("admin");

		const seen = [];
		for (const path of ADMIN_READS) {
			const res = await request(path, { headers: { cookie: normal.cookie } });
			seen.push([path, res.status]);
		}
		expect(seen.every(([, status]) => status === 401 || status === 403), JSON.stringify(seen)).toBe(true);
		// Specifically 403 — authenticated but not authorized.
		expect(seen.filter(([, status]) => status === 403)).toHaveLength(ADMIN_READS.length);
	});

	it("no credential short of an admin session can promote an account", async () => {
		const normal = await signupAccount("act-actor");
		const key = await mintToken(normal.cookie, "action probe");
		const target = await signupAccount("act-target");
		const payload = { userId: target.user.id, action: "promote" };

		const results = [
			["x-api-key", await request("/v1/admin/users/action", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify(payload),
			})],
			["bearer", await request("/v1/admin/users/action", {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(key.token) },
				body: JSON.stringify(payload),
			})],
			["session", await request("/v1/admin/users/action", jsonInit(payload, normal.cookie))],
			// Self-promotion is the interesting one: the actor names themselves.
			["self", await request("/v1/admin/users/action", jsonInit({ userId: normal.user.id, action: "promote" }, normal.cookie))],
		];
		const statuses = results.map(([name, res]) => [name, res.status]);
		expect(statuses.every(([, status]) => status === 401 || status === 403), JSON.stringify(statuses)).toBe(true);

		// State proof: nobody's role moved.
		for (const id of [target.user.id, normal.user.id]) {
			const row = await env.DB.prepare("SELECT role, status FROM users WHERE id = ?").bind(id).first();
			expect(row.role).not.toBe("admin");
			expect(row.status).not.toBe("disabled");
		}
	});

	it("no credential short of an admin session can disable an account or revoke its sessions", async () => {
		const normal = await signupAccount("dos-actor");
		const key = await mintToken(normal.cookie, "dos probe");
		const victim = await signupAccount("dos-victim");
		const victimKey = await mintToken(victim.cookie, "victim live key");
		// The victim is demonstrably working before the attack.
		expect((await request("/auth/me", { headers: { cookie: victim.cookie } })).status).toBe(200);

		const seen = [];
		for (const action of ["disable", "revoke_sessions"]) {
			const payload = { userId: victim.user.id, action };
			seen.push([`x-api-key ${action}`, (await request("/v1/admin/users/action", {
				method: "POST", headers: { "content-type": "application/json", "x-api-key": env.API_KEY }, body: JSON.stringify(payload),
			})).status]);
			seen.push([`bearer ${action}`, (await request("/v1/admin/users/action", {
				method: "POST", headers: { "content-type": "application/json", ...bearer(key.token) }, body: JSON.stringify(payload),
			})).status]);
			seen.push([`session ${action}`, (await request("/v1/admin/users/action", jsonInit(payload, normal.cookie))).status]);
		}
		expect(seen.every(([, status]) => status === 401 || status === 403), JSON.stringify(seen)).toBe(true);

		// Effect proof: the victim's account, session and key all still work.
		const row = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(row.status).not.toBe("disabled");
		expect((await request("/auth/me", { headers: { cookie: victim.cookie } })).status).toBe(200);
		expect((await request("/v1/memories?limit=1", { headers: bearer(victimKey.token) })).status).toBe(200);
		const live = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
		).bind(victim.user.id).first();
		expect(Number(live.n)).toBeGreaterThan(0);
	});

	it("no credential short of an admin session can move a trust case", async () => {
		const normal = await signupAccount("case-actor");
		const key = await mintToken(normal.cookie, "case probe");
		const caseId = await seedTrustCase();
		const payload = { caseId, action: "resolve", resolution: "no_action" };

		const statuses = [
			["x-api-key", (await request("/v1/admin/trust/cases/action", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify(payload),
			})).status],
			["bearer", (await request("/v1/admin/trust/cases/action", {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(key.token) },
				body: JSON.stringify(payload),
			})).status],
			["session", (await request("/v1/admin/trust/cases/action", jsonInit(payload, normal.cookie))).status],
		];
		expect(statuses.every(([, status]) => status === 401 || status === 403), JSON.stringify(statuses)).toBe(true);

		const row = await env.DB.prepare("SELECT status, resolution, resolved_at FROM trust_cases WHERE id = ?").bind(caseId).first();
		expect(row.status).toBe("received");
		expect(row.resolution).toBeNull();
		expect(row.resolved_at).toBeNull();
	});

	it("no credential short of an admin session can mint a step-up confirmation", async () => {
		const normal = await signupAccount("mint-actor");
		const key = await mintToken(normal.cookie, "mint probe");
		const target = await signupAccount("mint-target");
		const payload = { userId: target.user.id, action: "promote" };

		const statuses = [
			["x-api-key", (await request("/v1/admin/users/confirm", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify(payload),
			})).status],
			["bearer", (await request("/v1/admin/users/confirm", {
				method: "POST",
				headers: { "content-type": "application/json", ...bearer(key.token) },
				body: JSON.stringify(payload),
			})).status],
			["session", (await request("/v1/admin/users/confirm", jsonInit(payload, normal.cookie))).status],
		];
		expect(statuses.every(([, status]) => status === 401 || status === 403), JSON.stringify(statuses)).toBe(true);
		expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_action_confirmations WHERE target_user_id = ?")
			.bind(target.user.id).first())?.n ?? 0)).toBe(0);
	});

	it("one admin cannot spend a step-up confirmation minted by a different admin", async () => {
		const alice = await signupAccount("stepup-alice");
		const bob = await signupAccount("stepup-bob");
		await makeAdmin(alice.user.id);
		await makeAdmin(bob.user.id);
		const target = await signupAccount("stepup-target");

		const minted = await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action: "promote" }, alice.cookie));
		expect(minted.status).toBe(200);
		const ticket = await minted.json();

		// Bob is an admin too, but this confirmation is bound to Alice's actor
		// id and session id. Stealing it must buy nothing.
		const stolen = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: ticket.token, confirm_text: ticket.confirm_text,
		}, bob.cookie));
		expect(stolen.status).toBe(409);
		expect((await stolen.json()).error).toMatch(/confirmation_/);
		expect((await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first()).role).not.toBe("admin");

		// The ticket is still unspent for its rightful owner, so the refusal was
		// a binding check and not a silent burn.
		const legitimate = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: ticket.token, confirm_text: ticket.confirm_text,
		}, alice.cookie));
		expect(legitimate.status).toBe(200);
		expect((await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first()).role).toBe("admin");
	});

	it("POSITIVE CONTROL: a real admin session does reach these doors (the refusals above are authorization, not breakage)", async () => {
		const operator = await signupAccount("real-admin");
		await makeAdmin(operator.user.id);

		for (const path of ["/v1/admin/stats", "/v1/admin/users", "/v1/admin/audit-feed", "/v1/admin/trust/overview", "/v1/admin/errors"]) {
			const res = await request(path, { headers: { cookie: operator.cookie } });
			expect([path, res.status]).toEqual([path, 200]);
		}

		// promote is a step-up action: it needs a server-minted single-use
		// confirmation plus the target's email typed back.
		const target = await signupAccount("real-target");
		const bare = await request("/v1/admin/users/action", jsonInit({ userId: target.user.id, action: "promote" }, operator.cookie));
		expect(bare.status).toBe(428);

		const minted = await request("/v1/admin/users/confirm", jsonInit({ userId: target.user.id, action: "promote" }, operator.cookie));
		expect(minted.status).toBe(200);
		const ticket = await minted.json();
		expect(ticket.confirm_text).toBe(target.email);

		const promoted = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: ticket.token, confirm_text: ticket.confirm_text,
		}, operator.cookie));
		expect(promoted.status).toBe(200);
		const row = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(target.user.id).first();
		expect(row.role).toBe("admin");

		// The same ticket cannot be replayed.
		const replay = await request("/v1/admin/users/action", jsonInit({
			userId: target.user.id, action: "promote",
			confirmation_token: ticket.token, confirm_text: ticket.confirm_text,
		}, operator.cookie));
		expect(replay.status).toBe(409);
	});
});
