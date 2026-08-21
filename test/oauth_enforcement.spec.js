/**
 * OAuth 2.1 for the remote MCP server — ENFORCEMENT.
 *
 * The flow tests prove a client can get a token. These prove the token is only
 * ever worth what the live account still allows, at the only moment that
 * matters: the instant memory is written.
 *
 *   1. the commit-time credential fence (revoking the token, and revoking the
 *      GRANT under a live token, both abort a mutation mid-batch)
 *   2. the scope fence (a read-only grant cannot satisfy a write credential)
 *   3. expiry, at the door and at the fence
 *   4. the scope-literal agreement between preflight and fence ('memory:*')
 *   5. losing project membership revokes the grant
 *   6. account erasure kills grants
 *   7. cross-tenant isolation, and forged tokens
 *   8. the RFC 9728 challenge MCP clients discover authorization through
 *   9. track mode answers 404 for the whole OAuth surface
 *
 * Everything runs against real D1 through the real doors; nothing is mocked.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import { sha256Hex } from "../src/auth.js";
import { newId } from "../src/lib/ids.js";
import { ACCESS_TOKEN_PREFIX } from "../src/lib/oauth.js";
import { handleOAuthRoutes } from "../src/lib/oauth_routes.js";
import { applyMemoryChange } from "../src/lib/memory_versions.js";
import {
	MEMORY_DELETE_SCOPE,
	MEMORY_READ_SCOPE,
	MEMORY_WRITE_SCOPE,
	scopeLiteralsSatisfying,
	tokenAllowsScope,
} from "../src/lib/scopes.js";
import {
	ensureDefaultOrganization,
	listProjectMembers,
	removeProjectMember,
	setProjectRole,
	updateProjectRole,
} from "../src/lib/organizations.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";

const HOUR = 60 * 60 * 1000;
const idem = () => `oauth-idem-${crypto.randomUUID()}`;

/* --------------------------------------------------------------- plumbing */

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
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	});
}

async function form(path, fields) {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
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
	return { user: body.user, userId: body.user.id, cookie: cookieFrom(res) };
}

/** The MCP header door, which is the only one an OAuth access token uses. */
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

/**
 * Why a tool call was refused, whichever way the door said no: a structured
 * `insufficient_scope` payload, or — when the connection's scopes mean the tool
 * is never advertised to it — the transport's unknown-tool error.
 */
function refusalReason(result) {
	return result?.structuredContent?.code
		?? result?.structuredContent?.error
		?? result?.content?.map((part) => part.text).join(" ")
		?? "";
}

async function callTool(token, name, args = {}) {
	const res = await mcpBearer(token, {
		jsonrpc: "2.0",
		id: Math.floor(Math.random() * 1e6),
		method: "tools/call",
		params: { name, arguments: args },
	});
	expect(res.status, `${name} should reach the tool`).toBe(200);
	return (await mcpJson(res)).result;
}

/* -------------------------------------------------------------------- PKCE */

// RFC 7636 unreserved alphabet. Written here rather than imported: a test that
// borrowed the server's own PKCE code could not detect the server agreeing
// with itself and nothing else.
const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function makeVerifier(length = 64) {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return [...bytes].map((byte) => VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length]).join("");
}

async function pkce() {
	const verifier = makeVerifier();
	expect(verifier.length).toBeGreaterThanOrEqual(43);
	expect(verifier.length).toBeLessThanOrEqual(128);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let raw = "";
	for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
	const challenge = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return { verifier, challenge };
}

/* ------------------------------------------------------- authorize + grant */

async function registerOAuthClient(name = "Enforcement client") {
	const redirectUri = `https://client-${crypto.randomUUID()}.example.com/callback`;
	const res = await jsonRequest("/oauth/register", {
		client_name: name,
		redirect_uris: [redirectUri],
		token_endpoint_auth_method: "none",
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	return { clientId: body.client_id, redirectUri };
}

/** authorize → consent → decision → code → token, exactly as a client does. */
async function authorizeAndExchange({ cookie, clientId, redirectUri, scope }) {
	const { verifier, challenge } = await pkce();
	const state = `state-${crypto.randomUUID()}`;
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope,
		state,
	});
	const consent = await request(`/oauth/authorize?${query.toString()}`, { headers: { cookie } });
	expect(consent.status).toBe(200);
	const html = await consent.text();
	const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
	expect(consentId, "consent screen must carry a consent id").toBeTruthy();
	expect(csrf, "consent screen must carry a CSRF token").toBeTruthy();

	const decided = await request("/oauth/authorize", {
		method: "POST",
		headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ consent_id: consentId, csrf, decision: "allow", state }).toString(),
	});
	expect(decided.status).toBe(302);
	const location = new URL(decided.headers.get("location"));
	expect(location.searchParams.get("state")).toBe(state);
	const code = location.searchParams.get("code");
	expect(code, "an approved consent must return a code").toBeTruthy();

	const exchanged = await form("/oauth/token", {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId,
		code_verifier: verifier,
	});
	expect(exchanged.status).toBe(200);
	return exchanged.json();
}

/**
 * A complete, real OAuth connection: signed-up account, registered client,
 * consented grant, live access token, plus the row identities the fence needs.
 */
async function oauthConnection(prefix, { scope = "memory:read memory:write" } = {}) {
	const account = await signupAccount(prefix);
	const client = await registerOAuthClient(`${prefix} client`);
	const tokens = await authorizeAndExchange({
		cookie: account.cookie,
		clientId: client.clientId,
		redirectUri: client.redirectUri,
		scope,
	});
	const row = await env.DB.prepare(
		`SELECT tok.id AS token_id, tok.grant_id, g.project_id, g.scopes_json
		   FROM oauth_tokens tok JOIN oauth_grants g ON g.id = tok.grant_id
		  WHERE tok.token_hash = ? AND tok.kind = 'access' LIMIT 1`,
	).bind(await sha256Hex(tokens.access_token)).first();
	expect(row, "the exchanged access token must exist in D1").toBeTruthy();
	return {
		userId: account.userId,
		cookie: account.cookie,
		clientId: client.clientId,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		scope: tokens.scope,
		tokenId: row.token_id,
		grantId: row.grant_id,
		projectId: row.project_id,
	};
}

/* ------------------------------------------------------------- memory rows */

async function seedNode(userId, { label = "Enforcement node", summary = "Original summary.", projectId = null } = {}) {
	const id = `node_${crypto.randomUUID()}`;
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, project_id, label, category, state, summary, created_at, updated_at, revision)
		 VALUES (?, ?, ?, ?, 'tool', 'active', ?, ?, ?, 1)`,
	).bind(id, userId, projectId, label, summary, at, at).run();
	return id;
}

async function nodeState(nodeId) {
	const [head, revisions] = await env.DB.batch([
		env.DB.prepare("SELECT summary, COALESCE(revision, 1) AS revision FROM nodes WHERE id = ?").bind(nodeId),
		env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ?").bind(nodeId),
	]);
	return { ...head.results[0], history: Number(revisions.results[0].n) };
}

/** One update through the real writer, carrying an OAuth credential. */
function oauthUpdate(connection, nodeId, {
	expectedRevision,
	summary = "Written through an OAuth connection.",
	requiredScope = MEMORY_WRITE_SCOPE,
	tokenId = null,
	projectId = undefined,
}) {
	return applyMemoryChange(env, null, {
		userId: connection.userId,
		project: { id: connection.projectId },
		actor: {
			userId: connection.userId,
			type: "oauth",
			capability: "project.memory.write",
			orgId: null,
			credential: {
				kind: "oauth",
				id: tokenId ?? connection.tokenId,
				requiredScope,
				projectId: projectId === undefined ? connection.projectId : projectId,
			},
		},
		actorClass: "token",
		actorRef: connection.tokenId,
		id: nodeId,
		mode: "update",
		patch: { summary },
		idempotencyKey: idem(),
		expectedRevision,
	});
}

/* ====================================================================== 1 */

describe("the commit-time credential fence for OAuth", () => {
	it("commits with a live token, then aborts the identical write once the TOKEN is revoked", async () => {
		const connection = await oauthConnection("oauth-fence-token");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });

		// Control: the credential is live, so the mutation lands.
		const committed = await oauthUpdate(connection, nodeId, {
			expectedRevision: 1,
			summary: "Committed while the token was live.",
		});
		expect(committed).toMatchObject({ ok: true, revision: 2, previous_revision: 1 });
		const afterCommit = await nodeState(nodeId);
		expect(afterCommit.summary).toBe("Committed while the token was live.");

		// The request passes preflight; the token dies before the batch commits.
		await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?")
			.bind(Date.now(), connection.tokenId).run();

		await expect(oauthUpdate(connection, nodeId, {
			expectedRevision: 2,
			summary: "Written after the token was revoked.",
		})).rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });

		// Nothing about the object moved: same head, same revision, no new history.
		expect(await nodeState(nodeId)).toEqual(afterCommit);
	});

	it("aborts when the GRANT is revoked even though the token row is still live", async () => {
		const connection = await oauthConnection("oauth-fence-grant");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);

		await env.DB.prepare(
			"UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'user_revocation' WHERE id = ?",
		).bind(Date.now(), connection.grantId).run();
		// The token itself is untouched — only the grant behind it died.
		const token = await env.DB.prepare("SELECT revoked_at, expires_at FROM oauth_tokens WHERE id = ?")
			.bind(connection.tokenId).first();
		expect(token.revoked_at).toBeNull();
		expect(Number(token.expires_at)).toBeGreaterThan(Date.now());

		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });
		expect(await nodeState(nodeId)).toEqual(before);
		expect(before.history).toBe(0);
	});

	it("aborts when the token row is deleted outright — absence is never permission", async () => {
		const connection = await oauthConnection("oauth-fence-absent");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);

		await env.DB.prepare("DELETE FROM oauth_tokens WHERE id = ?").bind(connection.tokenId).run();
		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });
		expect(await nodeState(nodeId)).toEqual(before);
	});

	it("aborts when the grant is rebound to a project this write does not belong to", async () => {
		const connection = await oauthConnection("oauth-fence-project");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);

		await env.DB.prepare("UPDATE oauth_grants SET project_id = ? WHERE id = ?")
			.bind(`proj_${crypto.randomUUID()}`, connection.grantId).run();
		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });
		expect(await nodeState(nodeId)).toEqual(before);
	});

	/**
	 * The fence aborting is only half the contract: the REASON must be true.
	 * A live OAuth credential losing an unrelated fence (here a deletion
	 * barrier) has to be reported as project state, not as "your credential is
	 * invalid" — that answer sends a client off to re-authorize a connection
	 * that was never the problem.
	 */
	it("does not blame a live OAuth credential for an unrelated fence loss", async () => {
		const connection = await oauthConnection("oauth-fence-truthful");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);

		const barrierAt = Date.now() + 60_000;
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'oauth-enforcement-test')",
		).bind(connection.userId, barrierAt, Date.now()).run();

		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "project_state_changed", status: 409 });
		expect(await nodeState(nodeId)).toEqual(before);
	});
});

/* ====================================================================== 2 */

describe("the OAuth scope fence", () => {
	it("refuses a write credential when the grant only carries memory:read", async () => {
		const connection = await oauthConnection("oauth-scope-read", { scope: "memory:read" });
		expect(connection.scope).toBe("memory:read");
		const grant = await env.DB.prepare("SELECT scopes_json FROM oauth_grants WHERE id = ?")
			.bind(connection.grantId).first();
		expect(JSON.parse(grant.scopes_json)).toEqual([MEMORY_READ_SCOPE]);

		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);
		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });
		expect(await nodeState(nodeId)).toEqual(before);
	});

	it("keeps the door and the fence agreeing: a read-only grant is refused write at /mcp too", async () => {
		const connection = await oauthConnection("oauth-scope-door", { scope: "memory:read" });
		const whoami = await callTool(connection.accessToken, "whoami");
		expect(whoami.structuredContent).toMatchObject({ ok: true, scopes: [MEMORY_READ_SCOPE] });

		// The mutating tools this grant can never reach are not advertised to it.
		const listed = await mcpBearer(connection.accessToken, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
		const names = (await mcpJson(listed)).result.tools.map((tool) => tool.name);
		expect(names).toContain("recall_memory");
		expect(names).toContain("list_memories");
		expect(names).not.toContain("update_memory");
		expect(names).not.toContain("delete_memory");
		expect(names).not.toContain("delete_all_memories");

		// Asking anyway is refused, and — the part that matters — stores nothing.
		const save = await callTool(connection.accessToken, "save_memory", { content: "I took up sailing." });
		expect(save.isError).toBe(true);
		expect(refusalReason(save)).toMatch(/insufficient_scope|not found/i);
		const stored = await callTool(connection.accessToken, "list_memories", { limit: 200 });
		expect(stored.structuredContent).toMatchObject({ ok: true, count: 0 });
	});

	it("holds an OAuth connection to memory:delete for destructive tools", async () => {
		const readWrite = await oauthConnection("oauth-scope-nodelete");
		const listed = await mcpBearer(readWrite.accessToken, { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} });
		const names = (await mcpJson(listed)).result.tools.map((tool) => tool.name);
		expect(names).toContain("update_memory");
		// memory:write is not memory:delete, however wide the role behind it is.
		expect(names).not.toContain("delete_memory");
		expect(names).not.toContain("delete_all_memories");

		const withDelete = await oauthConnection("oauth-scope-delete", {
			scope: "memory:read memory:write memory:delete",
		});
		const listedWithDelete = await mcpBearer(withDelete.accessToken, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
		const deleteNames = (await mcpJson(listedWithDelete)).result.tools.map((tool) => tool.name);
		expect(deleteNames).toContain("delete_memory");
	});
});

/* ====================================================================== 3 */

describe("access token expiry", () => {
	it("closes both the door and the fence the moment the token expires", async () => {
		const connection = await oauthConnection("oauth-expiry");
		const nodeId = await seedNode(connection.userId, { projectId: connection.projectId });
		const before = await nodeState(nodeId);

		const live = await callTool(connection.accessToken, "whoami");
		expect(live.structuredContent.ok).toBe(true);

		await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, connection.tokenId).run();

		const res = await mcpBearer(connection.accessToken, { jsonrpc: "2.0", id: 10, method: "initialize", params: {} });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'resource_metadata="http://example.com/.well-known/oauth-protected-resource"',
		);

		await expect(oauthUpdate(connection, nodeId, { expectedRevision: 1 }))
			.rejects.toMatchObject({ name: "VersionError", code: "credential_invalid", status: 401 });
		expect(await nodeState(nodeId)).toEqual(before);
	});
});

/* ====================================================================== 4 */

describe("scope literals — preflight and fence derive from one function", () => {
	it("returns exactly the literals tokenAllowsScope would accept", () => {
		expect([...scopeLiteralsSatisfying(MEMORY_READ_SCOPE)].sort())
			.toEqual(["*", "memory:*", "memory:read", "memory:write"]);
		expect([...scopeLiteralsSatisfying(MEMORY_WRITE_SCOPE)].sort())
			.toEqual(["*", "memory:*", "memory:write"]);
		expect([...scopeLiteralsSatisfying(MEMORY_DELETE_SCOPE)].sort())
			.toEqual(["*", "memory:*", "memory:delete"]);
		expect(scopeLiteralsSatisfying(null)).toEqual([]);

		// memory:write must never satisfy memory:delete, on either side.
		expect(scopeLiteralsSatisfying(MEMORY_DELETE_SCOPE)).not.toContain(MEMORY_WRITE_SCOPE);
		expect(tokenAllowsScope([MEMORY_WRITE_SCOPE], MEMORY_DELETE_SCOPE)).toBe(false);
		expect(tokenAllowsScope([MEMORY_WRITE_SCOPE], MEMORY_READ_SCOPE)).toBe(true);
		expect(tokenAllowsScope([MEMORY_READ_SCOPE], MEMORY_WRITE_SCOPE)).toBe(false);
		for (const wildcard of ["*", "memory:*"]) {
			for (const required of [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, MEMORY_DELETE_SCOPE]) {
				expect(tokenAllowsScope([wildcard], required), `${wildcard} → ${required}`).toBe(true);
				expect(scopeLiteralsSatisfying(required)).toContain(wildcard);
			}
		}
	});

	/**
	 * The regression this function exists for: a credential carrying
	 * 'memory:*' passed the request-time check and then tripped the commit
	 * fence, which only accepted the exact scope or '*'. Both sides must
	 * accept it, or the write is refused after the caller was told yes.
	 */
	it("lets a 'memory:*' connection token pass preflight AND commit", async () => {
		const now = Date.now();
		const userId = `user_${crypto.randomUUID()}`;
		const projectId = `proj_${crypto.randomUUID()}`;
		const tokenId = newId("tok");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO users (id, email, email_normalized, created_at, updated_at, status, role)
				 VALUES (?, ?, ?, ?, ?, 'active', 'user')`,
			).bind(userId, `${userId}@example.com`, `${userId}@example.com`, now, now),
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'Wildcard project', ?, 0, 'active', ?, ?)`,
			).bind(projectId, userId, userId, `wildcard-${projectId}`, now, now),
			env.DB.prepare(
				`INSERT INTO connection_tokens
				 (id, user_id, project_id, label, token_hash, token_prefix, token_tail, type, created_at, scopes_json, status)
				 VALUES (?, ?, ?, 'wildcard', ?, 'itsuki_live_xxxxx', 'aaaa', 'api', ?, ?, 'active')`,
			).bind(tokenId, userId, projectId, `hash_${crypto.randomUUID()}`, now, JSON.stringify(["memory:*"])),
		]);

		// Preflight side.
		expect(tokenAllowsScope(["memory:*"], MEMORY_WRITE_SCOPE)).toBe(true);

		// Fence side: the same credential must survive the committing batch.
		const nodeId = await seedNode(userId, { projectId, summary: "Before the wildcard write." });
		const result = await applyMemoryChange(env, null, {
			userId,
			project: { id: projectId },
			actor: {
				userId,
				type: "token",
				capability: "project.memory.write",
				orgId: null,
				credential: { kind: "token", id: tokenId, requiredScope: MEMORY_WRITE_SCOPE, projectId },
			},
			actorClass: "token",
			actorRef: tokenId,
			id: nodeId,
			mode: "update",
			patch: { summary: "Written by a memory:* credential." },
			idempotencyKey: idem(),
			expectedRevision: 1,
		});
		expect(result).toMatchObject({ ok: true, revision: 2 });
		expect((await nodeState(nodeId)).summary).toBe("Written by a memory:* credential.");
	});
});

/* ====================================================================== 5 */

describe("role and membership changes narrow a grant without anyone revoking a token", () => {
	async function orgFixtures(prefix) {
		const at = Date.now();
		const owner = { id: newId("usr"), email: `${prefix}-owner-${crypto.randomUUID()}@example.com` };
		const member = { id: newId("usr"), email: `${prefix}-member-${crypto.randomUUID()}@example.com` };
		for (const person of [owner, member]) {
			await env.DB.prepare(
				`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
				 VALUES (?, ?, ?, ?, ?, ?, 'active', 'user')`,
			).bind(person.id, person.email, person.email.toLowerCase(), prefix, at, at).run();
		}
		const org = await ensureDefaultOrganization(env, owner.id);
		const projectId = newId("proj");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description, is_default, status,
				  organization_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, NULL, 0, 'active', ?, ?, ?)`,
			).bind(projectId, owner.id, `mem_${projectId}`, `Shared ${projectId}`, `shared ${projectId}`, org.id, at, at),
			env.DB.prepare(
				`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), org.id, member.id, owner.id, at, at),
		]);
		await setProjectRole(env, projectId, org.id, member.id, "member", owner.id);
		return { owner, member, org, projectId };
	}

	async function seedGrant({ userId, clientId, projectId, scopes }) {
		const now = Date.now();
		const grantId = newId("ogrant");
		const tokenId = newId("otok");
		const accessToken = `${ACCESS_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO oauth_grants (id, user_id, client_id, project_id, scopes_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(grantId, userId, clientId, projectId, JSON.stringify(scopes), now, now),
			env.DB.prepare(
				`INSERT INTO oauth_tokens
				 (id, grant_id, user_id, client_id, kind, token_hash, scopes_json, created_at, expires_at)
				 VALUES (?, ?, ?, ?, 'access', ?, ?, ?, ?)`,
			).bind(tokenId, grantId, userId, clientId, await sha256Hex(accessToken), JSON.stringify(scopes), now, now + HOUR),
		]);
		return { grantId, tokenId, accessToken };
	}

	it("revokes the OAuth grant when the member loses their project seat", async () => {
		const fixture = await orgFixtures("oauth-membership");
		const client = await registerOAuthClient("Membership client");
		const grant = await seedGrant({
			userId: fixture.member.id,
			clientId: client.clientId,
			projectId: fixture.projectId,
			scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
		});

		// The connection works while the seat exists.
		const before = await callTool(grant.accessToken, "whoami");
		expect(before.structuredContent).toMatchObject({
			ok: true,
			project: { id: fixture.projectId },
			scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
		});

		const seat = (await listProjectMembers(env, fixture.projectId)).find((row) => row.user_id === fixture.member.id);
		expect(seat.role).toBe("member");
		expect(await removeProjectMember(env, fixture.projectId, fixture.member.id, seat.revision))
			.toMatchObject({ removed: true, previous_role: "member" });

		const grantRow = await env.DB.prepare(
			"SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?",
		).bind(grant.grantId).first();
		expect(grantRow.revoked_at, "removal must revoke the grant in the same batch").not.toBeNull();
		expect(grantRow.revoked_reason).toBe("project_membership_removed");
		const tokenRow = await env.DB.prepare("SELECT revoked_at FROM oauth_tokens WHERE id = ?")
			.bind(grant.tokenId).first();
		expect(tokenRow.revoked_at).not.toBeNull();

		const after = await mcpBearer(grant.accessToken, { jsonrpc: "2.0", id: 11, method: "initialize", params: {} });
		expect(after.status).toBe(401);
		expect(after.headers.get("www-authenticate")).toContain("resource_metadata=");
	});

	it("narrows an existing grant to read when the role is downgraded to viewer, with no revocation at all", async () => {
		const fixture = await orgFixtures("oauth-downgrade");
		const client = await registerOAuthClient("Downgrade client");
		const grant = await seedGrant({
			userId: fixture.member.id,
			clientId: client.clientId,
			projectId: fixture.projectId,
			scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
		});
		const before = await callTool(grant.accessToken, "whoami");
		expect(before.structuredContent.scopes).toEqual([MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE]);

		const seat = (await listProjectMembers(env, fixture.projectId)).find((row) => row.user_id === fixture.member.id);
		expect(await updateProjectRole(env, fixture.projectId, fixture.org.id, fixture.member.id, "viewer", seat.revision))
			.toMatchObject({ changed: true, previous_role: "member", member: { role: "viewer" } });

		// Nothing was revoked; the grant and token rows are untouched.
		const rows = await env.DB.batch([
			env.DB.prepare("SELECT revoked_at FROM oauth_grants WHERE id = ?").bind(grant.grantId),
			env.DB.prepare("SELECT revoked_at FROM oauth_tokens WHERE id = ?").bind(grant.tokenId),
		]);
		expect(rows[0].results[0].revoked_at).toBeNull();
		expect(rows[1].results[0].revoked_at).toBeNull();

		// The very next request intersects the grant with the role that exists now.
		const after = await callTool(grant.accessToken, "whoami");
		expect(after.structuredContent.scopes).toEqual([MEMORY_READ_SCOPE]);
		expect(after.structuredContent.can_delete).toBe(false);
		const save = await callTool(grant.accessToken, "save_memory", { content: "A viewer should not store this." });
		expect(save.isError).toBe(true);
		expect(refusalReason(save)).toMatch(/insufficient_scope|not found/i);
		const stored = await callTool(grant.accessToken, "list_memories", { limit: 200 });
		expect(stored.structuredContent).toMatchObject({ ok: true, count: 0 });
	});
});

/* ====================================================================== 6 */

describe("account erasure", () => {
	it("takes every OAuth grant and token with it", async () => {
		const connection = await oauthConnection("oauth-erasure");
		const live = await callTool(connection.accessToken, "whoami");
		expect(live.structuredContent).toMatchObject({ ok: true, user_id: connection.userId });

		expect((await deleteAccountCompletely(env, connection.userId)).deleted).toBe(true);

		const remaining = await env.DB.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL) AS live_grants,
			   (SELECT COUNT(*) FROM oauth_tokens WHERE user_id = ? AND revoked_at IS NULL) AS live_tokens,
			   (SELECT COUNT(*) FROM oauth_grants WHERE user_id = ?) AS grants,
			   (SELECT COUNT(*) FROM oauth_tokens WHERE user_id = ?) AS tokens`,
		).bind(connection.userId, connection.userId, connection.userId, connection.userId).first();
		expect(Number(remaining.live_grants)).toBe(0);
		expect(Number(remaining.live_tokens)).toBe(0);
		expect(Number(remaining.grants)).toBe(0);
		expect(Number(remaining.tokens)).toBe(0);

		const after = await mcpBearer(connection.accessToken, { jsonrpc: "2.0", id: 12, method: "initialize", params: {} });
		expect(after.status).toBe(401);
		expect(after.headers.get("www-authenticate")).toContain("resource_metadata=");
	});
});

/* ====================================================================== 7 */

describe("cross-tenant isolation", () => {
	it("never lets one account's access token see another account's memories", async () => {
		const alice = await oauthConnection("oauth-tenant-a");
		const bob = await oauthConnection("oauth-tenant-b");
		expect(alice.userId).not.toBe(bob.userId);

		const aliceNode = await seedNode(alice.userId, {
			label: `Alice fact ${crypto.randomUUID()}`,
			projectId: alice.projectId,
		});
		const bobNode = await seedNode(bob.userId, {
			label: `Bob fact ${crypto.randomUUID()}`,
			projectId: bob.projectId,
		});

		const whoami = await callTool(alice.accessToken, "whoami");
		expect(whoami.structuredContent).toMatchObject({ ok: true, user_id: alice.userId });
		expect(whoami.structuredContent.project.id).toBe(alice.projectId);

		const listed = await callTool(alice.accessToken, "list_memories", { limit: 200 });
		const ids = listed.structuredContent.items.map((item) => item.id);
		expect(ids).toContain(aliceNode);
		expect(ids).not.toContain(bobNode);

		// And the reverse direction, so neither result is an accident of ordering.
		const bobListed = await callTool(bob.accessToken, "list_memories", { limit: 200 });
		const bobIds = bobListed.structuredContent.items.map((item) => item.id);
		expect(bobIds).toContain(bobNode);
		expect(bobIds).not.toContain(aliceNode);

		// Alice's own node is not reachable through Bob's connection by id either.
		const stolen = await callTool(bob.accessToken, "get_memory", { id: aliceNode });
		expect(stolen.structuredContent).toMatchObject({ ok: false, error: "not_found" });
	});

	it("refuses a forged access token and still points at the metadata document", async () => {
		const forged = `${ACCESS_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
		const res = await mcpBearer(forged, { jsonrpc: "2.0", id: 13, method: "initialize", params: {} });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'resource_metadata="http://example.com/.well-known/oauth-protected-resource"',
		);
		expect((await res.json()).message).toMatch(/expired, revoked, or not valid/i);
	});
});

/* ====================================================================== 8 */

describe("the 401 challenge contract MCP clients discover authorization through", () => {
	const metadataPointer = 'resource_metadata="http://example.com/.well-known/oauth-protected-resource"';

	it("challenges a request with no credential at all", async () => {
		const res = await mcpBearer("", { jsonrpc: "2.0", id: 14, method: "initialize", params: {} });
		expect(res.status).toBe(401);
		const challenge = res.headers.get("www-authenticate");
		expect(challenge).toMatch(/^Bearer realm="itsuki"/);
		expect(challenge).toContain('error="invalid_request"');
		expect(challenge).toContain(metadataPointer);
	});

	it("challenges a request with a bad credential", async () => {
		for (const bad of [`${ACCESS_TOKEN_PREFIX}not-a-real-token`, "itsuki_live_nope"]) {
			const res = await mcpBearer(bad, { jsonrpc: "2.0", id: 15, method: "initialize", params: {} });
			expect(res.status, bad).toBe(401);
			const challenge = res.headers.get("www-authenticate");
			expect(challenge, bad).toContain('error="invalid_token"');
			expect(challenge, bad).toContain(metadataPointer);
		}
	});

	it("serves the document the challenge points at", async () => {
		const res = await request("/.well-known/oauth-protected-resource");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			resource: "http://example.com/mcp",
			authorization_servers: ["http://example.com"],
			bearer_methods_supported: ["header"],
		});
	});
});

/* ====================================================================== 9 */

describe("track mode", () => {
	const OAUTH_PATHS = [
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/mcp",
		"/.well-known/oauth-authorization-server",
		"/oauth/authorize",
		"/oauth/token",
		"/oauth/register",
		"/oauth/revoke",
	];

	async function route(path, envOverride) {
		const req = new Request(`http://example.com${path}`);
		const ctx = createExecutionContext();
		const res = await handleOAuthRoutes(req, envOverride, ctx, new URL(req.url));
		await waitOnExecutionContext(ctx);
		return res;
	}

	it("answers 404 for the entire OAuth surface when MCP_OAUTH is not 'on'", async () => {
		const tracking = { ...env, MCP_OAUTH: "track" };
		for (const path of OAUTH_PATHS) {
			const res = await route(path, tracking);
			expect(res.status, path).toBe(404);
			expect(await res.json(), path).toMatchObject({ error: "not_found" });
		}
	});

	it("answers those same paths in 'on' mode, so the 404 is the flag and not the route", async () => {
		for (const path of OAUTH_PATHS.filter((p) => p.startsWith("/.well-known/"))) {
			const res = await route(path, env);
			expect(res.status, path).toBe(200);
		}
	});

	it("leaves every non-OAuth path alone in both modes", async () => {
		for (const envUnderTest of [env, { ...env, MCP_OAUTH: "track" }]) {
			for (const path of ["/mcp", "/v1/memories", "/auth/session", "/"]) {
				expect(await route(path, envUnderTest), path).toBeNull();
			}
		}
	});
});
