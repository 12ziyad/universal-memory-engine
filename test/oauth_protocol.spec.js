/**
 * OAuth 2.1 protocol conformance for Itsuki's remote MCP server.
 *
 * Covers the parts a client actually depends on and an attacker actually
 * probes: discovery (RFC 9728 / RFC 8414), dynamic client registration
 * (RFC 7591) including every redirect_uri shape that must be refused, the
 * complete authorization-code + PKCE happy path, and the failure modes that
 * make PKCE worth having — a missing verifier, a wrong verifier, "plain"
 * semantics, code replay, code expiry, and redirect_uri substitution.
 *
 * Two properties are asserted structurally rather than through the API,
 * because "we return a hash" is not the same claim as "we store only a hash":
 * the DCR row is read back to prove the registration access token is stored
 * hashed, and the token rows are read back to prove the raw access token
 * appears in no column.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

const ISSUER = "http://example.com";

async function request(path, init = {}) {
	const req = new Request(`${ISSUER}${path}`, init);
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

async function signupAccount(prefix = "oauth-user") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", {
		email,
		password: "correct-horse",
		name: prefix,
		acceptTerms: true,
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

/* ------------------------------------------------------------------------ */
/* PKCE (RFC 7636). Written here on purpose: a test that imported the         */
/* server's own verifier would agree with any bug it contains.               */

const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function makeVerifier(length = 64) {
	if (length < 43 || length > 128) throw new Error("RFC 7636 §4.1: verifier must be 43-128 chars");
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length];
	return out;
}

async function challengeFor(verifier) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let raw = "";
	for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
	const verifier = makeVerifier();
	return { verifier, challenge: await challengeFor(verifier) };
}

/* ------------------------------------------------------------------------ */
/* OAuth request helpers                                                     */

async function registerClient(body) {
	return request("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function registerOk(overrides = {}) {
	const res = await registerClient({
		redirect_uris: ["https://client.example/cb"],
		client_name: "Test Client",
		...overrides,
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function tokenRequest(params) {
	return request("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
}

async function authorizeGet({
	cookie,
	clientId,
	redirectUri,
	challenge,
	method = "S256",
	scope = "memory:read memory:write",
	state = "xyz",
	extra = {},
}) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: method,
		scope,
		...(state === null ? {} : { state }),
		...extra,
	});
	return request(`/oauth/authorize?${params.toString()}`, {
		headers: { ...(cookie ? { cookie } : {}) },
	});
}

function consentFieldsFrom(html) {
	const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
	return { consentId, csrf };
}

async function consentAllow({ cookie, consentId, csrf, decision = "allow", state = null }) {
	return request("/oauth/authorize", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(cookie ? { cookie } : {}),
		},
		body: new URLSearchParams({
			consent_id: consentId,
			csrf,
			decision,
			...(state === null ? {} : { state }),
		}).toString(),
	});
}

/**
 * signup -> register -> authorize -> consent -> a fresh authorization code.
 * Every PKCE failure test needs its own, because a code is single-use.
 */
async function freshAuthorization({ prefix = "oauth-flow", account = null, client = null, scope = "memory:read memory:write", state = "xyz" } = {}) {
	const user = account ?? await signupAccount(prefix);
	const registered = client ?? await registerOk({ client_name: `Client ${prefix}` });
	const redirectUri = registered.redirect_uris[0];
	const { verifier, challenge } = await pkcePair();
	const page = await authorizeGet({
		cookie: user.cookie,
		clientId: registered.client_id,
		redirectUri,
		challenge,
		scope,
		state,
	});
	expect(page.status).toBe(200);
	const html = await page.text();
	const { consentId, csrf } = consentFieldsFrom(html);
	expect(consentId).toBeTruthy();
	expect(csrf).toBeTruthy();
	const decided = await consentAllow({ cookie: user.cookie, consentId, csrf, state });
	expect(decided.status).toBe(302);
	const location = new URL(decided.headers.get("location"));
	const code = location.searchParams.get("code");
	expect(code).toBeTruthy();
	return { account: user, client: registered, redirectUri, verifier, challenge, code, location, html };
}

async function mcpInitialize(accessToken) {
	return request("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
		}),
	});
}

/* ------------------------------------------------------------------------ */

describe("OAuth discovery metadata", () => {
	it("serves RFC 9728 protected resource metadata at both well-known paths", async () => {
		for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
			const res = await request(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			const body = await res.json();
			expect(body.resource).toBe(`${ISSUER}/mcp`);
			expect(body.authorization_servers).toContain(ISSUER);
			expect(body.scopes_supported).toEqual(["memory:read", "memory:write", "memory:delete"]);
			expect(body.bearer_methods_supported).toEqual(["header"]);
		}
	});

	it("serves RFC 8414 authorization server metadata that advertises S256 only", async () => {
		const res = await request("/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = await res.json();
		expect(body.issuer).toBe(ISSUER);
		expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
		expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
		expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
		expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
		// Downgrade defence: `plain` must never be advertised, or a client is
		// entitled to use it.
		expect(body.code_challenge_methods_supported).toEqual(["S256"]);
		expect(body.code_challenge_methods_supported).not.toContain("plain");
		expect(body.grant_types_supported).toContain("authorization_code");
		expect(body.grant_types_supported).toContain("refresh_token");
		expect(body.response_types_supported).toEqual(["code"]);
		expect(body.scopes_supported).toEqual(["memory:read", "memory:write", "memory:delete"]);
	});
});

describe("dynamic client registration (RFC 7591)", () => {
	it("registers a public client and stores every credential hashed", async () => {
		const res = await registerClient({
			redirect_uris: ["https://client.example/cb"],
			client_name: "Test Client",
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.client_id).toBeTruthy();
		// Public client by default: PKCE instead of a secret.
		expect(body.client_secret).toBeUndefined();
		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.registration_access_token).toBeTruthy();
		expect(body.redirect_uris).toEqual(["https://client.example/cb"]);

		const row = await env.DB.prepare(
			"SELECT client_secret_hash, registration_access_token_hash, client_name, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?",
		).bind(body.client_id).first();
		expect(row).toBeTruthy();
		expect(row.client_name).toBe("Test Client");
		expect(row.token_endpoint_auth_method).toBe("none");
		// Hash-only storage: the stored value is a SHA-256 hex digest, not the
		// token, and the raw token appears in no column.
		expect(row.registration_access_token_hash).toBeTruthy();
		expect(row.registration_access_token_hash).not.toBe(body.registration_access_token);
		expect(row.registration_access_token_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row.client_secret_hash).toBeNull();
		const fullRow = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").bind(body.client_id).first();
		expect(JSON.stringify(fullRow)).not.toContain(body.registration_access_token);
	});

	it("refuses a registration with no redirect_uris", async () => {
		const res = await registerClient({ client_name: "No Redirects" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_redirect_uri");
	});

	it("refuses a redirect_uri carrying a fragment", async () => {
		const res = await registerClient({ redirect_uris: ["https://x/cb#frag"], client_name: "Fragment" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_redirect_uri");
	});

	it("refuses plain http on a non-loopback host", async () => {
		const res = await registerClient({ redirect_uris: ["http://evil.example/cb"], client_name: "Cleartext" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_redirect_uri");
	});

	it("refuses a javascript: redirect_uri", async () => {
		const res = await registerClient({ redirect_uris: ["javascript:alert(1)"], client_name: "XSS" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_redirect_uri");
	});

	it("refuses more than ten redirect_uris", async () => {
		const uris = Array.from({ length: 11 }, (_, i) => `https://client.example/cb${i}`);
		const res = await registerClient({ redirect_uris: uris, client_name: "Too Many" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_client_metadata");
	});

	it("refuses the implicit grant", async () => {
		const res = await registerClient({
			redirect_uris: ["https://client.example/cb"],
			grant_types: ["implicit"],
			client_name: "Implicit",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_client_metadata");
	});

	it("refuses the token response type", async () => {
		const res = await registerClient({
			redirect_uris: ["https://client.example/cb"],
			response_types: ["token"],
			client_name: "Token Response",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_client_metadata");
	});

	it("accepts RFC 8252 loopback redirect URIs, which native clients require", async () => {
		for (const uri of ["http://127.0.0.1:1234/callback", "http://localhost:9999/cb"]) {
			const res = await registerClient({ redirect_uris: [uri], client_name: "Native Client" });
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.redirect_uris).toEqual([uri]);
		}
	});
});

describe("authorization code + PKCE happy path", () => {
	it("runs signup -> register -> consent -> code -> tokens end to end", async () => {
		const account = await signupAccount("oauth-happy");
		const registered = await registerOk({ client_name: 'Happy <Client> & "Co"' });
		const redirectUri = registered.redirect_uris[0];
		const { verifier, challenge } = await pkcePair();

		const page = await authorizeGet({
			cookie: account.cookie,
			clientId: registered.client_id,
			redirectUri,
			challenge,
			scope: "memory:read memory:write",
			state: "xyz",
		});
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		const html = await page.text();

		// The client name is attacker-controlled text: it must reach the page
		// escaped, never as markup.
		expect(html).toContain("Happy &lt;Client&gt; &amp; &quot;Co&quot;");
		expect(html).not.toContain("Happy <Client>");
		expect(html).toContain(account.email);
		expect(html).toContain("Read your memories");
		expect(html).toContain("Save and edit memories");
		// Nothing bearer-shaped is ever rendered into the consent screen.
		expect(html).not.toContain("itsuki_at_");
		expect(html).not.toContain("itsuki_rt_");
		expect(html).not.toContain("itsuki_rat_");
		expect(html).not.toContain(registered.registration_access_token);

		const { consentId, csrf } = consentFieldsFrom(html);
		expect(consentId).toBeTruthy();
		expect(csrf).toBeTruthy();

		const decided = await consentAllow({ cookie: account.cookie, consentId, csrf, state: "xyz" });
		expect(decided.status).toBe(302);
		const location = new URL(decided.headers.get("location"));
		expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
		const code = location.searchParams.get("code");
		expect(code).toBeTruthy();
		expect(location.searchParams.get("state")).toBe("xyz");
		// RFC 9207: the issuer travels with the authorization response so a
		// client can detect a mix-up attack.
		expect(location.searchParams.get("iss")).toBe(ISSUER);
		expect(location.searchParams.get("error")).toBeNull();

		const exchanged = await tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: registered.client_id,
			code_verifier: verifier,
		});
		expect(exchanged.status).toBe(200);
		expect(exchanged.headers.get("cache-control")).toContain("no-store");
		const tokens = await exchanged.json();
		expect(tokens.access_token).toMatch(/^itsuki_at_/);
		expect(tokens.refresh_token).toMatch(/^itsuki_rt_/);
		expect(tokens.token_type).toBe("Bearer");
		expect(tokens.expires_in).toBe(3600);
		expect(tokens.scope).toBe("memory:read memory:write");

		// Hash-only storage, proved by reading every column back.
		const rows = await env.DB.prepare(
			"SELECT * FROM oauth_tokens WHERE client_id = ?",
		).bind(registered.client_id).all();
		expect(rows.results.length).toBe(2);
		const serialized = JSON.stringify(rows.results);
		expect(serialized).not.toContain(tokens.access_token);
		expect(serialized).not.toContain(tokens.refresh_token);
		for (const row of rows.results) {
			expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

describe("the authorization response echoes state exactly", () => {
	it("round-trips a state at the length limit unchanged", async () => {
		const state = "s".repeat(512);
		const flow = await freshAuthorization({ prefix: "state-max", state });
		expect(flow.location.searchParams.get("state")).toBe(state);
		expect(flow.location.searchParams.get("code")).toBeTruthy();
	});

	it("refuses an over-long state instead of silently truncating it", async () => {
		const account = await signupAccount("state-long");
		const registered = await registerOk({ client_name: "Long State" });
		const { challenge } = await pkcePair();
		const state = "s".repeat(513);
		const res = await authorizeGet({
			cookie: account.cookie,
			clientId: registered.client_id,
			redirectUri: registered.redirect_uris[0],
			challenge,
			state,
		});
		// The alternative — truncating — hands the client back a state it never
		// sent, which its own CSRF check reads as an attack.
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location"));
		expect(location.searchParams.get("error")).toBe("invalid_request");
		expect(location.searchParams.get("code")).toBeNull();
		const row = await env.DB.prepare(
			"SELECT state FROM oauth_consent_requests WHERE client_id = ?",
		).bind(registered.client_id).first();
		expect(row).toBeNull();
	});

	it("records the session that opened the consent screen", async () => {
		const flow = await freshAuthorization({ prefix: "consent-session" });
		const row = await env.DB.prepare(
			"SELECT session_id, user_id FROM oauth_consent_requests WHERE client_id = ? LIMIT 1",
		).bind(flow.client.client_id).first();
		expect(row.user_id).toBe(flow.account.user.id);
		expect(row.session_id).toBeTruthy();
		const session = await env.DB.prepare(
			"SELECT user_id FROM sessions WHERE id = ?",
		).bind(row.session_id).first();
		expect(session?.user_id).toBe(flow.account.user.id);
	});
});

describe("PKCE is mandatory and S256 only", () => {
	it("refuses an exchange with no code_verifier", async () => {
		const flow = await freshAuthorization({ prefix: "pkce-missing" });
		const res = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_grant");
	});

	it("refuses an exchange with a wrong code_verifier", async () => {
		const flow = await freshAuthorization({ prefix: "pkce-wrong" });
		const res = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
			code_verifier: makeVerifier(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_grant");
	});

	it("refuses a verifier that is the challenge itself (plain semantics)", async () => {
		const flow = await freshAuthorization({ prefix: "pkce-plain" });
		const res = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
			code_verifier: flow.challenge,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_grant");
	});

	it("refuses code_challenge_method=plain at the authorization endpoint", async () => {
		const account = await signupAccount("pkce-plain-authz");
		const registered = await registerOk({ client_name: "Plain Method" });
		const verifier = makeVerifier();
		const res = await authorizeGet({
			cookie: account.cookie,
			clientId: registered.client_id,
			redirectUri: registered.redirect_uris[0],
			// `plain` would make the challenge the verifier: no protection at all.
			challenge: verifier,
			method: "plain",
		});
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location"));
		expect(location.searchParams.get("error")).toBe("invalid_request");
		expect(location.searchParams.get("code")).toBeNull();
		expect(location.searchParams.get("state")).toBe("xyz");
	});

	it("refuses an authorization request with no code_challenge at all", async () => {
		const account = await signupAccount("pkce-absent");
		const registered = await registerOk({ client_name: "No PKCE" });
		const params = new URLSearchParams({
			response_type: "code",
			client_id: registered.client_id,
			redirect_uri: registered.redirect_uris[0],
			scope: "memory:read",
			state: "xyz",
		});
		const res = await request(`/oauth/authorize?${params.toString()}`, {
			headers: { cookie: account.cookie },
		});
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location"));
		expect(location.searchParams.get("error")).toBe("invalid_request");
		expect(location.searchParams.get("code")).toBeNull();
	});
});

describe("authorization codes are single-use and short-lived", () => {
	it("treats a replayed code as compromise: revokes the grant and kills issued tokens", async () => {
		const flow = await freshAuthorization({ prefix: "code-replay" });
		const first = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
			code_verifier: flow.verifier,
		});
		expect(first.status).toBe(200);
		const tokens = await first.json();

		// The token works before the replay, so the 401 below is caused by the
		// replay and not by the token never having been valid.
		const before = await mcpInitialize(tokens.access_token);
		expect(before.status).toBe(200);

		const second = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
			code_verifier: flow.verifier,
		});
		expect(second.status).toBe(400);
		expect((await second.json()).error).toBe("invalid_grant");

		// RFC 6749 §4.1.2: the replay must revoke everything the code produced.
		const grant = await env.DB.prepare(
			"SELECT revoked_at, revoked_reason FROM oauth_grants WHERE client_id = ? LIMIT 1",
		).bind(flow.client.client_id).first();
		expect(grant.revoked_at).not.toBeNull();
		expect(grant.revoked_at).toBeTruthy();
		expect(String(grant.revoked_reason)).toMatch(/replay/i);

		const after = await mcpInitialize(tokens.access_token);
		expect(after.status).toBe(401);
	});

	it("refuses an expired authorization code", async () => {
		const flow = await freshAuthorization({ prefix: "code-expired" });
		await env.DB.prepare(
			"UPDATE oauth_authorization_codes SET expires_at = ? WHERE client_id = ? AND consumed_at IS NULL",
		).bind(Date.now() - 60_000, flow.client.client_id).run();

		const res = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			redirect_uri: flow.redirectUri,
			client_id: flow.client.client_id,
			code_verifier: flow.verifier,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_grant");
	});
});

describe("redirect_uri binding and the open-redirect defence", () => {
	it("refuses an exchange whose redirect_uri is registered but not the one authorized", async () => {
		const account = await signupAccount("redirect-swap");
		const registered = await registerOk({
			client_name: "Two Callbacks",
			redirect_uris: ["https://client.example/cb", "https://client.example/other"],
		});
		const flow = await freshAuthorization({ account, client: registered });
		expect(flow.redirectUri).toBe("https://client.example/cb");

		const res = await tokenRequest({
			grant_type: "authorization_code",
			code: flow.code,
			// Registered for this client, but not the URI the code was bound to.
			redirect_uri: "https://client.example/other",
			client_id: registered.client_id,
			code_verifier: flow.verifier,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_grant");
	});

	it("renders an on-site error for an unknown client_id instead of redirecting", async () => {
		const account = await signupAccount("unknown-client");
		const { challenge } = await pkcePair();
		const res = await authorizeGet({
			cookie: account.cookie,
			clientId: "itsuki_client_does_not_exist",
			redirectUri: "https://attacker.example/steal",
			challenge,
		});
		expect(res.status).toBe(400);
		expect(res.status).not.toBe(302);
		expect(res.headers.get("location")).toBeNull();
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Unknown application");
		expect(html).not.toContain("attacker.example");
	});

	it("renders an on-site error for an unregistered redirect_uri instead of redirecting", async () => {
		const account = await signupAccount("unregistered-redirect");
		const registered = await registerOk({ client_name: "Honest Client" });
		const { challenge } = await pkcePair();
		const res = await authorizeGet({
			cookie: account.cookie,
			clientId: registered.client_id,
			redirectUri: "https://attacker.example/steal",
			challenge,
		});
		// The whole point: an unregistered redirect_uri must never be used as a
		// redirect target, not even to deliver an error.
		expect(res.status).toBe(400);
		expect(res.status).not.toBe(302);
		expect(res.headers.get("location")).toBeNull();
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Invalid redirect");
		expect(html).not.toContain("attacker.example");
	});
});
