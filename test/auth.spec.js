import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function jsonRequest(path, body, cookie) {
	return request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function jsonRequestWithHeaders(path, body, headers = {}) {
	return request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix = "user") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix, acceptTerms: true });
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res), body };
}

async function insertNode(userId, id, label) {
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(id, userId, label, "project", "active", `${label} summary`, now, now),
		env.DB.prepare(
			"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(`slice-${id}`, userId, id, `${label} private detail`, "other", 1, now),
	]);
}

describe("email/password auth", () => {
	it("signup creates a user and an HttpOnly session without returning password fields", async () => {
		const { user, cookie, body, email } = await signupAccount("signup");
		expect(cookie).toMatch(/^uml_session=/);
		expect(body.user).toMatchObject({ id: user.id, email });
		expect(JSON.stringify(body)).not.toContain("password_hash");

		const row = await env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE id = ?").bind(user.id).first();
		expect(row.password_hash).toMatch(/^pbkdf2_sha256\$100000\$/);
		expect(row.password_hash).not.toContain("correct-horse");
		expect(row.password_salt).toBeTruthy();
	});

	it("duplicate signup fails with safe account creation copy", async () => {
		const { email } = await signupAccount("duplicate");
		const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: "duplicate", acceptTerms: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Could not create account. Please try again." });
	});

	it("signup without affirmative consent is refused and records nothing", async () => {
		const email = `consent-${crypto.randomUUID()}@example.com`;
		const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: "consent" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/accept the Terms/i);
		const row = await env.DB.prepare("SELECT id FROM users WHERE email_normalized = ?").bind(email.toLowerCase()).first();
		expect(row).toBeNull();
	});

	it("signup records the consent timestamp", async () => {
		const { user } = await signupAccount("consent-recorded");
		const row = await env.DB.prepare("SELECT terms_accepted_at FROM users WHERE id = ?").bind(user.id).first();
		expect(Number(row.terms_accepted_at)).toBeGreaterThan(0);
	});

	it("exports the account's data as a JSON attachment", async () => {
		const { user, cookie } = await signupAccount("export");
		await insertNode(user.id, `node-export-${user.id.slice(-6)}`, "Export Probe");
		const res = await request("/v1/export", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("uml-export-");
		const body = await res.json();
		expect(body.format).toBe("uml-export");
		expect(body.nodes.map((n) => n.label)).toContain("Export Probe");
		expect(body.memory_rules).toBeDefined();
	});

	it("admin stats route is role-gated", async () => {
		const { user, cookie } = await signupAccount("admin-gate");
		const denied = await request("/v1/admin/stats", { headers: { cookie } });
		expect(denied.status).toBe(403);
		const anon = await request("/v1/admin/stats");
		expect(anon.status).toBe(401);

		await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(user.id).run();
		const allowed = await request("/v1/admin/stats", { headers: { cookie } });
		expect(allowed.status).toBe(200);
		const stats = await allowed.json();
		expect(stats.users).toBeGreaterThanOrEqual(1);
		expect(stats.totals).toBeDefined();
		expect(Array.isArray(stats.top_users)).toBe(true);
	});

	it("login succeeds with the correct password and fails generically with the wrong password", async () => {
		const { email } = await signupAccount("login");

		const bad = await jsonRequest("/auth/login", { email, password: "wrong-password" });
		expect(bad.status).toBe(401);
		expect(await bad.json()).toEqual({ error: "Invalid email or password" });

		const good = await jsonRequest("/auth/login", { email, password: "correct-horse" });
		expect(good.status).toBe(200);
		expect(cookieFrom(good)).toMatch(/^uml_session=/);
	});

	it("/auth/me returns the current user and logout revokes the session", async () => {
		const { user, cookie } = await signupAccount("me");
		const me = await request("/auth/me", { headers: { cookie } });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ authenticated: true, user: { id: user.id } });

		const logout = await request("/auth/logout", { method: "POST", headers: { cookie } });
		expect(logout.status).toBe(200);

		const after = await request("/auth/me", { headers: { cookie } });
		expect(await after.json()).toEqual({ authenticated: false, user: null });
	});

	it("fails logout-all closed when its audit intent is unavailable, then revokes every session once", async () => {
		const account = await signupAccount("logout-all-audit");
		const login = await jsonRequest("/auth/login", { email: account.email, password: "correct-horse" });
		const secondCookie = cookieFrom(login);
		const requestId = crypto.randomUUID();
		const failedDb = new Proxy(env.DB, {
			get(target, property) {
				if (property === "prepare") return (sql) => {
					if (/^\s*INSERT\s+INTO\s+audit_events/i.test(String(sql))) throw new Error("audit unavailable");
					return target.prepare(sql);
				};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const init = { method: "POST", headers: { cookie: account.cookie, "x-request-id": requestId } };
		const unavailable = await request("/auth/logout-all", init, { ...env, DB: failedDb });
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({ error: "audit_unavailable" });
		expect((await request("/auth/me", { headers: { cookie: secondCookie } })).status).toBe(200);

		const succeeded = await request("/auth/logout-all", init);
		expect(succeeded.status).toBe(200);
		expect(await (await request("/auth/me", { headers: { cookie: secondCookie } })).json())
			.toEqual({ authenticated: false, user: null });
		const events = await env.DB.prepare(
			`SELECT action, outcome, request_id FROM audit_events
			  WHERE actor_user_id = ? AND action = 'account.sessions.revoked_all'`,
		).bind(account.user.id).all();
		expect(events.results).toEqual([expect.objectContaining({ outcome: "ok", request_id: requestId })]);
	});

	it("authenticates before buffering password changes and bounds the request", async () => {
		const account = await signupAccount("password-boundary");
		const before = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
			.bind(account.user.id).first();
		const oversizedBody = JSON.stringify({
			currentPassword: "correct-horse",
			newPassword: "next-correct-horse",
			padding: "x".repeat(9 * 1024),
		});

		const anonymous = await request("/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: oversizedBody,
		});
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toEqual({ error: "unauthorized" });

		const oversized = await request("/auth/password", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: account.cookie },
			body: oversizedBody,
		});
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ error: "request_too_large" });

		const unknown = await jsonRequest("/auth/password", {
			currentPassword: "correct-horse",
			newPassword: "next-correct-horse",
			unexpected: true,
		}, account.cookie);
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({ error: "invalid_password_request" });

		const after = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
			.bind(account.user.id).first();
		expect(after.password_hash).toBe(before.password_hash);
	});
});

describe("session user isolation", () => {
	it("requires auth for normal memory routes", async () => {
		const res = await request("/v1/status");
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("treats session userId as external scope without trusting it as the owner", async () => {
		const a = await signupAccount("alice");
		const b = await signupAccount("bob");
		await insertNode(a.user.id, "node-alice", "Alice Project");
		await insertNode(b.user.id, "node-bob", "Bob Secret");

		const ownGraph = await request("/v1/graph", { headers: { cookie: a.cookie } });
		expect(ownGraph.status).toBe(200);
		expect((await ownGraph.json()).nodes.map((n) => n.label)).toEqual(["Alice Project"]);

		const graph = await request(`/v1/graph?userId=${encodeURIComponent(b.user.id)}`, { headers: { cookie: a.cookie } });
		expect(graph.status).toBe(200);
		const graphBody = await graph.json();
		expect(graphBody.nodes.map((n) => n.label)).toEqual([]);

		const status = await request(`/v1/status?userId=${encodeURIComponent(b.user.id)}`, { headers: { cookie: a.cookie } });
		expect(await status.json()).toMatchObject({ nodes: 0, slices: 0 });

		const recall = await jsonRequest("/v1/recall", { userId: b.user.id, query: "Bob Secret" }, a.cookie);
		expect(await recall.json()).toMatchObject({ context: "", nodes: [], pages: [], count: 0 });
	});

	it("reset only deletes the selected scope for the logged-in owner", async () => {
		const a = await signupAccount("reset-a");
		const b = await signupAccount("reset-b");
		await insertNode(a.user.id, "node-reset-a", "Reset A");
		await insertNode(b.user.id, "node-reset-b", "Reset B");

		const externalReset = await jsonRequest("/v1/actions/delete-all", { userId: b.user.id, confirm: "DELETE ALL" }, a.cookie);
		expect(externalReset.status).toBe(200);
		expect((await externalReset.json()).deleted).toBe(true);

		let aCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?").bind(a.user.id).first();
		let bCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?").bind(b.user.id).first();
		expect(aCount.count).toBe(1);
		expect(bCount.count).toBe(1);

		const ownerReset = await jsonRequest("/v1/actions/delete-all", { confirm: "DELETE ALL" }, a.cookie);
		expect(ownerReset.status).toBe(200);

		aCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?").bind(a.user.id).first();
		bCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ?").bind(b.user.id).first();
		expect(aCount.count).toBe(0);
		expect(bCount.count).toBe(1);
	});
});

describe("connection tokens", () => {
	it("creates one-time API tokens, stores only a hash, resolves the token user, and rejects revoked tokens", async () => {
		const a = await signupAccount("token");
		await insertNode(a.user.id, "node-token", "Token Project");

		const created = await jsonRequest("/auth/tokens", { type: "api", label: "Custom Agent" }, a.cookie);
		expect(created.status).toBe(201);
		const body = await created.json();
		expect(body.token).toMatch(/^itsuki_live_/);
		expect(body.tokenRecord.masked_token).not.toContain(body.token);

		const row = await env.DB.prepare("SELECT token_hash, token_prefix, token_tail FROM connection_tokens WHERE id = ?")
			.bind(body.tokenRecord.id)
			.first();
		expect(row.token_hash).toHaveLength(64);
		expect(row.token_hash).not.toBe(body.token);
		expect(row.token_prefix).toBe(body.token.slice(0, 18));

		const list = await request("/auth/tokens", { headers: { cookie: a.cookie } });
		const listed = await list.json();
		expect(JSON.stringify(listed)).not.toContain(body.token);

		const status = await request("/v1/status", { headers: { authorization: `Bearer ${body.token}` } });
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ nodes: 1 });

		const revoke = await request(`/auth/tokens/${body.tokenRecord.id}/revoke`, { method: "POST", headers: { cookie: a.cookie } });
		expect(revoke.status).toBe(200);
		expect((await revoke.json()).revoked).toBe(true);

		const afterRevokeList = await request("/auth/tokens", { headers: { cookie: a.cookie } });
		const revokedRow = (await afterRevokeList.json()).tokens.find((t) => t.id === body.tokenRecord.id);
		expect(revokedRow).toMatchObject({ status: "revoked" });
		expect(revokedRow.revoked_at).toBeTruthy();

		const rejected = await request("/v1/status", { headers: { authorization: `Bearer ${body.token}` } });
		expect(rejected.status).toBe(401);
	});

	// The app now offers one action per key. Deleting must actually stop the
	// key working, not just hide the row.
	it("deletes a key outright, and the key stops working", async () => {
		const a = await signupAccount("token-delete");
		await insertNode(a.user.id, "node-del", "Delete Project");
		const { token, tokenRecord } = await (await jsonRequest("/auth/tokens", { type: "api", label: "Doomed" }, a.cookie)).json();

		expect((await request("/v1/status", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

		const gone = await request(`/auth/tokens/${tokenRecord.id}`, { method: "DELETE", headers: { cookie: a.cookie } });
		expect(gone.status).toBe(200);
		expect((await gone.json()).deleted).toBe(true);

		// The row is gone from the list and from the table.
		const listed = await (await request("/auth/tokens", { headers: { cookie: a.cookie } })).json();
		expect(listed.tokens.find((t) => t.id === tokenRecord.id)).toBeUndefined();
		const row = await env.DB.prepare("SELECT id FROM connection_tokens WHERE id = ?").bind(tokenRecord.id).first();
		expect(row).toBeNull();

		expect((await request("/v1/status", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
	});

	it("will not delete another account's key", async () => {
		const mine = await signupAccount("token-mine");
		const theirs = await signupAccount("token-theirs");
		const { token, tokenRecord } = await (await jsonRequest("/auth/tokens", { type: "api", label: "Mine" }, mine.cookie)).json();

		const attempt = await request(`/auth/tokens/${tokenRecord.id}`, { method: "DELETE", headers: { cookie: theirs.cookie } });
		expect(attempt.status).toBe(200);
		expect((await attempt.json()).deleted).toBe(false);
		expect((await request("/v1/status", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

		const anon = await request(`/auth/tokens/${tokenRecord.id}`, { method: "DELETE" });
		expect(anon.status).toBe(401);
	});

	it("allows normal bearer tokens on safe memory routes and blocks control routes", async () => {
		const a = await signupAccount("token-safe");
		await insertNode(a.user.id, "node-token-safe", "Token Safe Project");

		const created = await jsonRequest("/auth/tokens", { type: "api", label: "Scoped Agent" }, a.cookie);
		const { token } = await created.json();
		const bearer = { authorization: `Bearer ${token}` };

		const status = await request("/v1/status", { headers: bearer });
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ nodes: 1, slices: 1 });

		const graph = await request("/v1/graph", { headers: bearer });
		expect(graph.status).toBe(200);
		expect((await graph.json()).nodes.map((n) => n.label)).toEqual(["Token Safe Project"]);

		const receipts = await request("/v1/receipts", { headers: bearer });
		expect(receipts.status).toBe(200);
		expect(await receipts.json()).toMatchObject({ receipts: [] });

		const recall = await jsonRequestWithHeaders("/v1/recall", { query: "Token Safe Project" }, bearer);
		expect(recall.status).toBe(200);
		expect(await recall.json()).toMatchObject({ ok: true, command_mode: "recall", processing: false });

		const ingest = await jsonRequestWithHeaders(
			"/v1/ingest",
			{ messages: [{ id: "safe-1", role: "user", content: "ok thanks" }] },
			bearer,
		);
		expect(ingest.status).toBe(200);
		expect(await ingest.json()).toMatchObject({ ok: true, mode: "observe_messages" });

		const save = await jsonRequestWithHeaders("/v1/save", { content: "ok thanks" }, bearer);
		expect(save.status).toBe(200);
		expect(await save.json()).toMatchObject({ ok: true, mode: "direct_save" });

		const collect = await jsonRequestWithHeaders(
			"/v1/save",
			{
				mode: "conversation",
				scope: "summary",
				conversationId: `token-safe-collect-${crypto.randomUUID()}`,
				messages: [
					{ id: "collect-1", role: "user", content: "I decided to keep Itsuki on Cloudflare D1." },
					{ id: "collect-2", role: "assistant", content: "Noted." },
				],
			},
			bearer,
		);
		expect(collect.status).toBe(200);
		expect(await collect.json()).toMatchObject({ ok: true, mode: "conversation_collect" });

		for (const [path, body] of [
			["/v1/actions/delete-all", { confirm: "DELETE ALL" }],
			["/v1/actions/delete-object", { kind: "node", id: "node-token-safe" }],
			["/v1/actions/repair-graph", {}],
			["/v1/candidates/cand-token-safe/reject", {}],
		]) {
			const blocked = await jsonRequestWithHeaders(path, body, bearer);
			expect(blocked.status).toBe(403);
			expect(await blocked.json()).toEqual({ error: "forbidden", code: "token_not_allowed" });
		}
	});

	it("enforces connection token scopes before routing safe memory writes", async () => {
		const a = await signupAccount("token-scope");
		await insertNode(a.user.id, "node-token-scope", "Token Scope Project");

		const created = await jsonRequest(
			"/auth/tokens",
			{ type: "api", label: "Read Only Agent", scopes: ["memory:read"] },
			a.cookie,
		);
		const { token } = await created.json();
		const bearer = { authorization: `Bearer ${token}` };

		const status = await request("/v1/status", { headers: bearer });
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ nodes: 1 });

		const recall = await jsonRequestWithHeaders("/v1/recall", { query: "Token Scope Project" }, bearer);
		expect(recall.status).toBe(200);

		const save = await jsonRequestWithHeaders("/v1/save", { content: "I started fencing." }, bearer);
		expect(save.status).toBe(403);
		expect(await save.json()).toEqual({ error: "forbidden", code: "insufficient_scope" });

		const ingest = await jsonRequestWithHeaders(
			"/v1/ingest",
			{ messages: [{ id: "scope-1", role: "user", content: "I started fencing." }] },
			bearer,
		);
		expect(ingest.status).toBe(403);
		expect(await ingest.json()).toEqual({ error: "forbidden", code: "insufficient_scope" });
	});

	it("keeps dashboard sessions and legacy x-api-key access as control/admin paths", async () => {
		const a = await signupAccount("control-session");
		await insertNode(a.user.id, "node-control-session", "Control Session Project");

		const sessionDelete = await jsonRequest(
			"/v1/actions/delete-object",
			{ kind: "node", id: "node-control-session" },
			a.cookie,
		);
		expect(sessionDelete.status).toBe(200);
		expect((await sessionDelete.json()).deleted).toBe(true);

		const legacyUserId = `legacy-${crypto.randomUUID()}`;
		await insertNode(legacyUserId, "node-legacy-control", "Legacy Control Project");
		const legacyHeaders = { "x-api-key": env.API_KEY };

		const legacyStatus = await request(`/v1/status?userId=${encodeURIComponent(legacyUserId)}`, {
			headers: legacyHeaders,
		});
		expect(legacyStatus.status).toBe(200);
		expect(await legacyStatus.json()).toMatchObject({ nodes: 1 });

		const legacyDelete = await jsonRequestWithHeaders(
			"/v1/actions/delete-all",
			{ userId: legacyUserId, confirm: "DELETE ALL" },
			legacyHeaders,
		);
		expect(legacyDelete.status).toBe(200);
		expect((await legacyDelete.json()).deleted).toBe(true);
	});

	it("MCP tokens resolve the correct user", async () => {
		const a = await signupAccount("mcp-token");
		const created = await jsonRequest("/auth/tokens", { type: "mcp", label: "Claude" }, a.cookie);
		const { token } = await created.json();
		const res = await request(`/mcp/${token}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
			}),
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("itsuki-memory");
	});
});

describe("product shell routes", () => {
	it("public landing page is present in the static shell", () => {
		const publicLanding = html.slice(html.indexOf('<div id="landing"'), html.indexOf('<div id="authView"'));
		expect(html).toContain('id="landing" class="public-shell lp-shell"');
		expect(html).toContain("For the AI tools you already use");
		expect(html).toContain("that sits under");
		expect(html).toContain("<em>that sits under<br />your AI tools.</em>");
		expect(html).toContain("Connect Itsuki once with one key.");
		expect(html).toContain("イツキ");
		// The decongested hero: copy takes 70%, the right third is one calm
		// vertical mark, and the developer surface follows immediately.
		expect(html).toContain('class="hero-mono"');
		expect(html).toContain('class="hero-mono-jp"');
		expect(html).toContain('<span>02</span> One memory, every tool');
		expect(html).toContain('<span>03</span> The difference');
		expect(html).toContain("Four moves. One living memory.");
		expect(html).toContain('data-landing-step="0"');
		expect(html).toContain('data-landing-sdk="node"');
		expect(html).toContain('data-landing-sdk="mcp"');
		expect(html).toContain("landingSelectStep");
		expect(html).toContain("landingSelectSdk");
		expect(html).toContain("PASTE_THE_PRIVATE_URL_CREATED_IN_ITSUKI");
		// MCP is the default tab — the fastest path for this audience — so the
		// initial action is the MCP one, not copy.
		expect(html).toContain('id="landingCodeAction" data-action="create-mcp"');
		expect(html).toContain('name === "mcp" ? "create-mcp" : "copy"');
		expect(html).toContain('location.href = "/app#install"');
		expect(html).toContain("actually yours.");
		expect(html).toContain("Put one memory under");
		expect(html).toContain("showAuth('login', event)");
		expect(html).toContain("showAuth('signup', event)");
		expect(html).toContain('href="/privacy"');
		expect(html).toContain('href="/terms"');
		expect(html).toContain("/assets/brand/itsuki-bonsai-mark.svg");
		expect(html).toContain("/assets/brand/itsuki-bonsai-favicon.svg");
		expect(html).toContain("/assets/landing-editorial-v1.css?v=8");
		expect(html).not.toContain("Skip the copy-paste between Claude and ChatGPT.");
		expect(html).not.toContain("Your AI context is scattered.");
		expect(html).toContain("hello@itsuki.app");
		expect(publicLanding).not.toContain("ejziyad@gmail.com");
		expect(publicLanding).not.toMatch(/paper trail/i);
		// Receipts language is deliberate since the 2026-08-28 rebuild: auditable
		// memory is the unclaimed trust territory the research found.
		expect(publicLanding).toMatch(/\breceipt(ed)?\b/i);
		// Brand hygiene, tightened for the domain move: the old brand appears
		// NOWHERE in the page — not even as a contact address.
		expect(html).not.toMatch(/gpmai/i);
	});

	it("uses the official Memory Bonsai mark in auth and the signed-in rail", () => {
		const renderAuthStart = html.indexOf("function renderAuth(");
		const submitAuthStart = html.indexOf("async function submitAuth(", renderAuthStart);
		const authTemplates = html.slice(renderAuthStart, submitAuthStart);

		expect(renderAuthStart).toBeGreaterThan(-1);
		expect(submitAuthStart).toBeGreaterThan(renderAuthStart);
		expect(authTemplates.match(/\/assets\/brand\/itsuki-bonsai-mark\.svg\?v=1/g)?.length ?? 0)
			.toBeGreaterThanOrEqual(2);
		expect(authTemplates).not.toContain("/assets/uml-icon.png");
		expect(html).toContain('<img class="logo-mark" src="/assets/brand/itsuki-bonsai-mark.svg?v=1" alt="" aria-hidden="true" /> <span>Itsuki</span>');
		expect(html).not.toContain("/assets/uml-icon.png");
	});

	it("/app redirects unauthenticated visitors to login", async () => {
		const res = await request("/app", { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("http://example.com/?view=login");
	});

	it("/app redirects authenticated visitors into the dashboard shell", async () => {
		const { cookie } = await signupAccount("app-route");
		const res = await request("/app", { headers: { cookie }, redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("http://example.com/?app=1");
	});
});
