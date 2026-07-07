import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
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

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix = "user") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix });
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
		const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: "duplicate" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Could not create account. Please try again." });
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
		expect(body.token).toMatch(/^uml_live_/);
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

		const rejected = await request("/v1/status", { headers: { authorization: `Bearer ${body.token}` } });
		expect(rejected.status).toBe(401);
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
		expect(await res.text()).toContain("uml-memory");
	});
});

describe("product shell routes", () => {
	it("public landing page is present in the static shell", () => {
		expect(html).toContain("Universal Memory Layer");
		expect(html).toContain("One private memory graph for AI tools, agents, and apps.");
		expect(html).toContain("UML turns useful context from chats, events, documents, tools, and workflows into structured memory");
		expect(html).toContain("Chat history is not memory.");
		expect(html).toContain("Memory is structured meaning.");
		expect(html).toContain("Backend is the authority, not the LLM.");
		expect(html).toContain("When UML is connected through an MCP-capable AI client");
		expect(html).toContain("Privacy Policy");
		expect(html).toContain("Terms &amp; Conditions");
		expect(html).toContain("Support");
		expect(html).not.toContain("Skip the copy-paste between Claude and ChatGPT.");
		expect(html).not.toContain("Your AI context is scattered.");
		expect(html).toContain("founder@gpmai.dev");
		expect(html).toContain("ejziyad@gmail.com");
		expect(html).toContain("/assets/uml-logo.svg");
		const withoutContactEmail = html.replace(/mailto:founder@gpmai\.dev|founder@gpmai\.dev/g, "");
		expect(withoutContactEmail).not.toMatch(/gpmai/i);
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
