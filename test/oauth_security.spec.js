/**
 * OAuth 2.1 / PKCE security contract for Itsuki's remote MCP server.
 *
 * The flow is exercised end to end through the real HTTP surface — register,
 * consent screen, decision, code exchange, refresh, revoke, then MCP with the
 * issued bearer — because every guarantee here is a property of the whole
 * path, not of any one function:
 *
 *   - a denied or forged consent leaves NOTHING behind (no grant, no code);
 *   - a decision is bound to the account that opened the screen, so switching
 *     accounts in another tab can never approve for the wrong user;
 *   - a refresh may narrow scope and never widen it, and a replayed refresh
 *     token burns the whole grant family;
 *   - revocation is immediate, is not a token oracle, and one client can
 *     never revoke another client's tokens;
 *   - OAuth's stricter scope model — memory:delete is its own consent, never
 *     implied by memory:write — governs which MCP tools are offered and which
 *     are refused, without retroactively changing what legacy connection
 *     tokens were issued with;
 *   - the raw access token never lands in any stored row.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

/* ------------------------------------------------------------------------ */
/* HTTP helpers                                                              */

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

/** A real browser form post — urlencoded, exactly what the consent page sends. */
async function formPost(path, fields, cookie) {
	return request(path, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(cookie ? { cookie } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix = "oauth-user") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix, acceptTerms: true });
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

async function mcpBearer(token, body) {
	return request("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function mcpJson(response) {
	const text = await response.text();
	const data = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter(Boolean)
		.at(-1);
	return JSON.parse(data || text);
}

let rpcId = 1000;
async function toolNames(token) {
	const res = await mcpBearer(token, { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
	expect(res.status).toBe(200);
	return ((await mcpJson(res)).result?.tools ?? []).map((tool) => tool.name);
}

async function callTool(token, name, args = {}) {
	const res = await mcpBearer(token, {
		jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args },
	});
	return { status: res.status, body: await mcpJson(res) };
}

/** Whatever shape the server chose, did the tool call fail? */
function wasRefused(body) {
	return Boolean(body.error)
		|| body.result?.isError === true
		|| body.result?.structuredContent?.ok === false;
}

/** Can this bearer reach the MCP door at all? 200 = yes, 401 = credential dead. */
async function mcpStatus(token) {
	const res = await mcpBearer(token, { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
	return res.status;
}

/* ------------------------------------------------------------------------ */
/* PKCE (RFC 7636 S256) — built here rather than imported, so the test proves */
/* the server against the spec and not against its own implementation.       */

const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function codeVerifier(length = 64) {
	expect(length).toBeGreaterThanOrEqual(43);
	expect(length).toBeLessThanOrEqual(128);
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length];
	return out;
}

async function codeChallenge(verifier) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let raw = "";
	for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ------------------------------------------------------------------------ */
/* Flow helpers                                                              */

async function registerOAuthClient(prefix = "cli") {
	const redirectUri = `https://${prefix}-${crypto.randomUUID().slice(0, 8)}.example.com/callback`;
	const res = await request("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: `${prefix} client`, redirect_uris: [redirectUri] }),
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	expect(body.client_id).toBeTruthy();
	return { clientId: body.client_id, redirectUri };
}

function hiddenField(html, name) {
	const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
	return match ? match[1] : null;
}

/** GET /oauth/authorize as a signed-in browser and read the consent screen. */
async function consentScreen({ cookie, client, scope = "memory:read", state = null, challenge }) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: client.clientId,
		redirect_uri: client.redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope,
	});
	if (state) params.set("state", state);
	const res = await request(`/oauth/authorize?${params.toString()}`, { headers: { cookie } });
	const html = await res.text();
	return {
		status: res.status,
		html,
		consentId: hiddenField(html, "consent_id"),
		csrf: hiddenField(html, "csrf"),
	};
}

async function exchangeCode({ client, code, verifier }) {
	return formPost("/oauth/token", {
		grant_type: "authorization_code",
		code,
		redirect_uri: client.redirectUri,
		code_verifier: verifier,
		client_id: client.clientId,
	});
}

async function refreshTokens({ clientId, refreshToken, scope = null }) {
	return formPost("/oauth/token", {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
		...(scope ? { scope } : {}),
	});
}

/** Authorize + consent + exchange, returning the raw token response. */
async function authorize({ cookie, client, scope = "memory:read memory:write", state = null }) {
	const verifier = codeVerifier();
	const challenge = await codeChallenge(verifier);
	const screen = await consentScreen({ cookie, client, scope, state, challenge });
	expect(screen.status, screen.html.slice(0, 300)).toBe(200);
	expect(screen.consentId).toBeTruthy();
	expect(screen.csrf).toBeTruthy();

	const decided = await formPost("/oauth/authorize", {
		consent_id: screen.consentId,
		csrf: screen.csrf,
		decision: "allow",
		...(state ? { state } : {}),
	}, cookie);
	expect(decided.status).toBe(302);
	const location = new URL(decided.headers.get("location"));
	const code = location.searchParams.get("code");
	expect(code, `no code in ${location.toString()}`).toBeTruthy();

	const tokenRes = await exchangeCode({ client, code, verifier });
	expect(tokenRes.status, JSON.stringify(await tokenRes.clone().json())).toBe(200);
	return { tokens: await tokenRes.json(), location, consentId: screen.consentId };
}

/**
 * One fully authorized world: a real account, a real registered client, a real
 * consented grant, and the tokens it issued. Every test below starts here so
 * nothing is proved against hand-inserted rows.
 */
async function grantWorld({ scope = "memory:read memory:write", prefix = "oauth" } = {}) {
	const account = await signupAccount(prefix);
	const client = await registerOAuthClient(prefix);
	const { tokens } = await authorize({ cookie: account.cookie, client, scope });
	const grant = await env.DB.prepare(
		"SELECT id, project_id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL LIMIT 1",
	).bind(account.user.id, client.clientId).first();
	expect(grant?.id).toBeTruthy();
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		grantedScope: tokens.scope,
		clientId: client.clientId,
		client,
		grantId: grant.id,
		projectId: grant.project_id ?? null,
		userId: account.user.id,
		cookie: account.cookie,
		account,
	};
}

async function countGrants(clientId) {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE client_id = ?").bind(clientId).first();
	return Number(row.n);
}

async function countCodes(clientId) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM oauth_authorization_codes WHERE client_id = ?",
	).bind(clientId).first();
	return Number(row.n);
}

async function seedNode(userId, label = "OAuth scope target") {
	const id = `node_${crypto.randomUUID()}`;
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, project_id, label, category, state, summary, created_at, updated_at)
		 VALUES (?, ?, NULL, ?, 'tool', 'active', 'Summary.', ?, ?)`,
	).bind(id, userId, label, now, now).run();
	return id;
}

async function nodeIsLive(id) {
	const row = await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id = ? LIMIT 1").bind(id).first();
	return Boolean(row) && row.deleted_at == null;
}

/* ------------------------------------------------------------------------ */

describe("OAuth consent decisions", () => {
	it("a denied consent redirects with access_denied and leaves no grant and no code", async () => {
		const account = await signupAccount("oauth-deny");
		const client = await registerOAuthClient("deny");
		const state = `state-${crypto.randomUUID()}`;
		const verifier = codeVerifier();
		const screen = await consentScreen({
			cookie: account.cookie, client, scope: "memory:read memory:write", state,
			challenge: await codeChallenge(verifier),
		});
		expect(screen.status).toBe(200);

		const denied = await formPost("/oauth/authorize", {
			consent_id: screen.consentId,
			csrf: screen.csrf,
			decision: "deny",
			state,
		}, account.cookie);

		expect(denied.status).toBe(302);
		const location = new URL(denied.headers.get("location"));
		expect(`${location.origin}${location.pathname}`).toBe(client.redirectUri);
		expect(location.searchParams.get("error")).toBe("access_denied");
		// The client's own state must come back so it can match the response to
		// the request it started — a denial is still an answer.
		expect(location.searchParams.get("state")).toBe(state);
		expect(location.searchParams.get("code")).toBeNull();

		// Nothing was created. A denial that quietly leaves a grant behind is the
		// worst possible outcome: the user believes they said no.
		expect(await countGrants(client.clientId)).toBe(0);
		expect(await countCodes(client.clientId)).toBe(0);
	});

	it("a forged CSRF value is refused on-site, never redirected, and creates no grant", async () => {
		const account = await signupAccount("oauth-csrf");
		const client = await registerOAuthClient("csrf");
		const verifier = codeVerifier();
		const screen = await consentScreen({
			cookie: account.cookie, client, scope: "memory:read memory:write",
			challenge: await codeChallenge(verifier),
		});
		expect(screen.status).toBe(200);

		const forged = await formPost("/oauth/authorize", {
			consent_id: screen.consentId,
			csrf: `${screen.csrf}-tampered`,
			decision: "allow",
		}, account.cookie);

		// Not a redirect: a cross-site post must not be able to drive the browser
		// to the client's callback, with or without a code.
		expect(forged.status).toBe(400);
		expect(forged.headers.get("location")).toBeNull();
		expect(forged.headers.get("content-type")).toMatch(/text\/html/);
		const html = await forged.text();
		expect(html).toMatch(/could not be verified/i);
		expect(html).not.toContain(screen.csrf);

		expect(await countGrants(client.clientId)).toBe(0);
		expect(await countCodes(client.clientId)).toBe(0);
	});

	it("replaying a valid consent post is refused the second time and leaves exactly one grant", async () => {
		const account = await signupAccount("oauth-replay");
		const client = await registerOAuthClient("replay");
		const verifier = codeVerifier();
		const screen = await consentScreen({
			cookie: account.cookie, client, scope: "memory:read memory:write",
			challenge: await codeChallenge(verifier),
		});
		const decision = {
			consent_id: screen.consentId,
			csrf: screen.csrf,
			decision: "allow",
		};

		const first = await formPost("/oauth/authorize", decision, account.cookie);
		expect(first.status).toBe(302);
		expect(new URL(first.headers.get("location")).searchParams.get("code")).toBeTruthy();

		const second = await formPost("/oauth/authorize", decision, account.cookie);
		expect(second.status).toBe(400);
		expect(second.headers.get("location")).toBeNull();
		expect(await second.text()).toMatch(/already answered|expired/i);

		// One consent, one grant — a replay must not mint a second authorization
		// that revocation of the first would then miss.
		expect(await countGrants(client.clientId)).toBe(1);
		expect(await countCodes(client.clientId)).toBe(1);
	});

	it("never approves for the wrong signed-in account", async () => {
		const alice = await signupAccount("oauth-alice");
		const bob = await signupAccount("oauth-bob");
		const client = await registerOAuthClient("mismatch");
		const verifier = codeVerifier();

		// Alice opens the consent screen…
		const screen = await consentScreen({
			cookie: alice.cookie, client, scope: "memory:read memory:write",
			challenge: await codeChallenge(verifier),
		});
		expect(screen.status).toBe(200);

		// …and the decision arrives carrying BOB's session (account switched in
		// another tab, or a stolen consent id posted from Bob's browser).
		const decided = await formPost("/oauth/authorize", {
			consent_id: screen.consentId,
			csrf: screen.csrf,
			decision: "allow",
		}, bob.cookie);

		expect(decided.status).toBe(409);
		expect(decided.headers.get("location")).toBeNull();
		expect(await decided.text()).toMatch(/account signed in to this browser is not the one/i);

		// Neither account gained anything.
		expect(await countGrants(client.clientId)).toBe(0);
		expect(await countCodes(client.clientId)).toBe(0);
		for (const userId of [alice.user.id, bob.user.id]) {
			const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?").bind(userId).first();
			expect(Number(row.n)).toBe(0);
		}
	});
});

describe("OAuth token endpoint", () => {
	it("a refresh may narrow scope but never widen it", async () => {
		const readOnly = await grantWorld({ scope: "memory:read", prefix: "oauth-widen" });
		expect(readOnly.grantedScope).toBe("memory:read");

		const widened = await refreshTokens({
			clientId: readOnly.clientId,
			refreshToken: readOnly.refreshToken,
			scope: "memory:read memory:write",
		});
		expect(widened.status).toBe(400);
		expect(await widened.json()).toMatchObject({ error: "invalid_scope" });

		// A REFUSED request must not consume the credential it refused. Burning
		// the refresh token here would force a re-authorization for a client-side
		// mistake — and a naive retry would then trip reuse detection and revoke
		// the whole grant.
		const grantRow = await env.DB.prepare(
			"SELECT revoked_at FROM oauth_grants WHERE id = ?",
		).bind(readOnly.grantId).first();
		expect(grantRow.revoked_at).toBeNull();
		const retry = await refreshTokens({ clientId: readOnly.clientId, refreshToken: readOnly.refreshToken });
		expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(200);
		expect((await retry.json()).scope).toBe("memory:read");

		// Narrowing is the direction that must work.
		const full = await grantWorld({ scope: "memory:read memory:write", prefix: "oauth-narrow" });
		const narrowed = await refreshTokens({
			clientId: full.clientId,
			refreshToken: full.refreshToken,
			scope: "memory:read",
		});
		expect(narrowed.status).toBe(200);
		const narrowedTokens = await narrowed.json();
		expect(narrowedTokens.scope).toBe("memory:read");
		// And the narrowing is real at the door, not just in the response body:
		// the token the narrowing issued cannot write, and the revising tools it
		// could have used are no longer offered to it.
		const narrowedSave = await callTool(narrowedTokens.access_token, "save_memory", { content: "Narrowed write." });
		const narrowedRefused = Boolean(narrowedSave.body.error)
			|| narrowedSave.body.result?.isError === true
			|| narrowedSave.body.result?.structuredContent?.ok === false;
		expect(narrowedRefused, JSON.stringify(narrowedSave.body).slice(0, 200)).toBe(true);
		const narrowedNames = await toolNames(narrowedTokens.access_token);
		expect(narrowedNames).not.toContain("update_memory");
		expect(narrowedNames).not.toContain("save_memory");
	});

	it("rotates refresh tokens, and a replayed one revokes the whole grant family", async () => {
		const world = await grantWorld({ prefix: "oauth-rotate" });
		expect(await mcpStatus(world.accessToken)).toBe(200);

		const rotated = await refreshTokens({ clientId: world.clientId, refreshToken: world.refreshToken });
		expect(rotated.status).toBe(200);
		const fresh = await rotated.json();
		expect(fresh.access_token).toBeTruthy();
		expect(fresh.refresh_token).toBeTruthy();
		expect(fresh.refresh_token).not.toBe(world.refreshToken);

		// A rotation means "give me current credentials": the previous access
		// token stops working immediately.
		expect(await mcpStatus(world.accessToken)).toBe(401);
		expect(await mcpStatus(fresh.access_token)).toBe(200);

		// Reuse detection: presenting the spent refresh token is treated as theft.
		const replayed = await refreshTokens({ clientId: world.clientId, refreshToken: world.refreshToken });
		expect(replayed.status).toBe(400);
		expect(await replayed.json()).toMatchObject({ error: "invalid_grant" });

		const grantRow = await env.DB.prepare(
			"SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?",
		).bind(world.grantId).first();
		expect(grantRow.revoked_at).toBeTruthy();
		expect(String(grantRow.revoked_reason)).toMatch(/reuse/i);

		// The family, not just the replayed token: the credentials issued by the
		// successful rotation are dead too, so a thief who won the race is
		// evicted along with everyone else.
		expect(await mcpStatus(fresh.access_token)).toBe(401);
		const stillLive = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM oauth_tokens WHERE grant_id = ? AND revoked_at IS NULL",
		).bind(world.grantId).first();
		expect(Number(stillLive.n)).toBe(0);
	});
});

describe("OAuth revocation", () => {
	it("revoking a refresh token kills the access token immediately", async () => {
		const world = await grantWorld({ prefix: "oauth-revoke" });
		expect(await mcpStatus(world.accessToken)).toBe(200);

		const revoked = await formPost("/oauth/revoke", {
			token: world.refreshToken,
			client_id: world.clientId,
		});
		expect(revoked.status).toBe(200);
		expect(await mcpStatus(world.accessToken)).toBe(401);
	});

	it("answers 200 for a token it has never seen, so the endpoint is not an oracle", async () => {
		const world = await grantWorld({ prefix: "oauth-oracle" });
		const unknown = await formPost("/oauth/revoke", {
			token: `itsuki_rt_${crypto.randomUUID().replace(/-/g, "")}`,
			client_id: world.clientId,
		});
		expect(unknown.status).toBe(200);
		expect(await unknown.json()).toEqual({});
		// The bland answer is not a side effect: the real token still works.
		expect(await mcpStatus(world.accessToken)).toBe(200);
	});

	it("one client cannot revoke another client's token", async () => {
		const victim = await grantWorld({ prefix: "oauth-victim" });
		const attackerClient = await registerOAuthClient("attacker");

		const attempt = await formPost("/oauth/revoke", {
			token: victim.refreshToken,
			client_id: attackerClient.clientId,
		});
		// RFC 7009: still a bland 200 — but nothing happened.
		expect(attempt.status).toBe(200);
		expect(await mcpStatus(victim.accessToken)).toBe(200);
		const revokedRows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM oauth_tokens WHERE grant_id = ? AND revoked_at IS NOT NULL",
		).bind(victim.grantId).first();
		expect(Number(revokedRows.n)).toBe(0);
		const grantRow = await env.DB.prepare(
			"SELECT revoked_at FROM oauth_grants WHERE id = ?",
		).bind(victim.grantId).first();
		expect(grantRow.revoked_at).toBeNull();
	});
});

describe("OAuth scope enforcement at the MCP door", () => {
	it("a read-only grant is refused every write tool, and the mutating ones are not even offered", async () => {
		const world = await grantWorld({ scope: "memory:read", prefix: "oauth-ro" });
		const names = await toolNames(world.accessToken);

		// Every mutating tool is hidden outright: a read-only connection cannot
		// even propose one, so the model never suggests a save that could only
		// be refused.
		for (const tool of [
			"save_memory", "save_conversation",
			"update_memory", "rollback_memory",
			"delete_memory", "delete_all_memories",
		]) {
			expect(names, `read-only grant must not be shown ${tool}`).not.toContain(tool);
		}
		for (const tool of ["recall_memory", "list_memories", "get_memory", "whoami"]) {
			expect(names, `read-only grant must keep ${tool}`).toContain(tool);
		}

		// Enforcement, which is the part that actually matters: hiding a tool is
		// usability, refusing the call is the security boundary.
		const save = await callTool(world.accessToken, "save_memory", { content: "I started boxing in June." });
		expect(save.status).toBe(200);
		expect(wasRefused(save.body), JSON.stringify(save.body).slice(0, 300)).toBe(true);

		const staged = await callTool(world.accessToken, "save_conversation", {
			messages: [{ id: "m1", role: "user", content: "I started boxing in June." }],
			conversationId: `oauth-ro-${crypto.randomUUID()}`,
		});
		expect(wasRefused(staged.body), JSON.stringify(staged.body).slice(0, 300)).toBe(true);

		// And nothing was written by either attempt.
		for (const table of ["receipts", "source_packets", "memory_jobs", "nodes"]) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(world.userId).first();
			expect(Number(row.n), `${table} must be untouched by a refused save`).toBe(0);
		}
	});

	it("a write grant cannot delete until delete is separately consented", async () => {
		const world = await grantWorld({ scope: "memory:read memory:write", prefix: "oauth-wo" });
		const names = await toolNames(world.accessToken);
		expect(names).toContain("save_memory");
		expect(names).toContain("update_memory");
		// memory:write does not imply memory:delete. The account IS the project
		// owner, so the delete CAPABILITY is present — what is missing is the
		// consented scope, which is exactly what this isolates.
		expect(names).not.toContain("delete_memory");
		expect(names).not.toContain("delete_all_memories");

		const target = await seedNode(world.userId, "Delete me only with consent");
		const refused = await callTool(world.accessToken, "delete_memory", { id: target });
		expect(wasRefused(refused.body), JSON.stringify(refused.body).slice(0, 300)).toBe(true);
		expect(await nodeIsLive(target)).toBe(true);

		// Re-authorize the SAME client, this time including memory:delete.
		const upgraded = await authorize({
			cookie: world.cookie,
			client: world.client,
			scope: "memory:read memory:write memory:delete",
		});
		expect(upgraded.tokens.scope).toBe("memory:read memory:write memory:delete");
		// Re-authorization updates the one grant rather than accumulating shadows.
		expect(await countGrants(world.clientId)).toBe(1);

		const upgradedNames = await toolNames(upgraded.tokens.access_token);
		expect(upgradedNames).toContain("delete_memory");
		expect(upgradedNames).toContain("delete_all_memories");

		const deleted = await callTool(upgraded.tokens.access_token, "delete_memory", { id: target });
		expect(deleted.body.result?.structuredContent, JSON.stringify(deleted.body).slice(0, 300))
			.toMatchObject({ ok: true, command_mode: "delete", id: target });
		expect(await nodeIsLive(target)).toBe(false);
	});

	it("keeps the historical contract for a legacy read+write connection token", async () => {
		// OAuth's stricter model must not reach backwards. A connection token
		// issued with memory:read + memory:write was always allowed to delete
		// (write scope plus the live delete capability); demanding a memory:delete
		// scope it was never issued would break every existing integration.
		const account = await signupAccount("oauth-legacy");
		const created = await jsonRequest(
			"/auth/tokens",
			{ type: "mcp", label: "Legacy integration", scopes: ["memory:read", "memory:write"] },
			account.cookie,
		);
		expect(created.status).toBe(201);
		const { token } = await created.json();

		const names = await toolNames(token);
		expect(names).toContain("save_memory");
		expect(names).toContain("delete_memory");
		expect(names).toContain("delete_all_memories");

		const target = await seedNode(account.user.id, "Legacy deletable");
		const deleted = await callTool(token, "delete_memory", { id: target });
		expect(deleted.body.result?.structuredContent, JSON.stringify(deleted.body).slice(0, 300))
			.toMatchObject({ ok: true, command_mode: "delete", id: target });
		expect(await nodeIsLive(target)).toBe(false);
	});
});

describe("OAuth credential hygiene", () => {
	it("never records the raw access token in receipts, audit events, or error reports", async () => {
		const world = await grantWorld({ scope: "memory:read memory:write", prefix: "oauth-leak" });

		const saved = await callTool(world.accessToken, "save_conversation", {
			messages: [
				{ id: "m1", role: "user", content: "I moved to Lisbon last month and started learning Portuguese." },
			],
			conversationId: `oauth-leak-${crypto.randomUUID()}`,
			idempotencyKey: `oauth-leak-${crypto.randomUUID()}`,
		});
		expect(saved.status).toBe(200);
		expect(saved.body.result?.structuredContent, JSON.stringify(saved.body).slice(0, 300))
			.toMatchObject({ ok: true });

		// The save really happened, so "no token anywhere" is not vacuously true.
		const receipts = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ?",
		).bind(world.userId).first();
		expect(Number(receipts.n)).toBeGreaterThan(0);

		for (const table of ["receipts", "audit_events", "error_reports"]) {
			const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
			const dumped = JSON.stringify(results ?? []);
			expect(dumped, `${table} must not contain the raw access token`).not.toContain(world.accessToken);
			expect(dumped, `${table} must not contain the raw refresh token`).not.toContain(world.refreshToken);
		}

		// Belt and braces: the stores that DO hold the credential hold only a
		// hash of it, never the string the client sent.
		const tokenRows = await env.DB.prepare(
			"SELECT token_hash FROM oauth_tokens WHERE grant_id = ?",
		).bind(world.grantId).all();
		for (const row of tokenRows.results ?? []) {
			expect(row.token_hash).not.toContain(world.accessToken);
			expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
