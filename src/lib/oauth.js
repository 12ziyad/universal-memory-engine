/**
 * OAuth 2.1 authorization for Itsuki's remote MCP server.
 *
 * Itsuki is the authorization server AND the protected resource here. This is
 * a different system from the Google OAuth used to sign in to the dashboard,
 * where Itsuki is merely a client — nothing in this file touches that path.
 *
 * Design constraints that shaped it:
 *   - state lives in D1, not KV, so a revoked grant can be re-proved inside
 *     the SAME batch that writes memory (see credentialGuardStatement kind
 *     "oauth" in memory_versions.js). A KV-held grant could not be fenced
 *     transactionally, which would silently downgrade "revocation is
 *     immediate" to "revocation applies to the next request";
 *   - every secret is stored as a SHA-256 hash only, exactly like sessions and
 *     connection tokens. Raw codes/tokens/secrets exist only in the response
 *     that issues them;
 *   - PKCE S256 is mandatory. There is no `plain` code path to disable;
 *   - redirect URIs match exactly. No wildcards, no prefixes, no normalization
 *     that could widen a match.
 *
 * Specs: MCP authorization (2026-07-28), OAuth 2.1, RFC 9728 (protected
 * resource metadata), RFC 8414 (AS metadata), RFC 7591 (dynamic client
 * registration), RFC 7636 (PKCE), RFC 7009 (revocation), RFC 8707 (resource
 * indicators), RFC 9207 (issuer identification).
 */

import { newId } from "./ids.js";
import { randomSecret, sha256Hex } from "../auth.js";
import { MEMORY_DELETE_SCOPE, MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, OAUTH_SCOPES } from "./scopes.js";

/** Lifetimes. Access tokens are short; refresh tokens rotate on every use. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000;
/** RFC 7591 registrations expire; pre-registered clients do not. */
export const CLIENT_REGISTRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const ACCESS_TOKEN_PREFIX = "itsuki_at_";
export const REFRESH_TOKEN_PREFIX = "itsuki_rt_";
const REGISTRATION_TOKEN_PREFIX = "itsuki_rat_";

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 120;
const MAX_URI_LENGTH = 2048;
export const MAX_STATE_LENGTH = 512;

export function oauthMode(env) {
	return String(env?.MCP_OAUTH ?? "").toLowerCase() === "on" ? "on" : "track";
}

export class OAuthError extends Error {
	constructor(code, description, status = 400, extra = {}) {
		super(description);
		this.name = "OAuthError";
		this.code = code;
		this.description = description;
		this.status = status;
		this.extra = extra;
	}
}

/* ------------------------------------------------------------------------ */
/* Scopes                                                                    */

/**
 * Parse a space-delimited scope request into the frozen vocabulary.
 * Unknown scopes are an error, never silently dropped: a client that asked for
 * something we do not implement must not believe it was granted.
 */
export function parseScopes(raw, { allowEmpty = false } = {}) {
	const requested = String(raw ?? "")
		.split(/[\s+]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (!requested.length) {
		if (allowEmpty) return [];
		// No scope parameter: the conservative default is read-only.
		return [MEMORY_READ_SCOPE];
	}
	const unknown = requested.filter((scope) => !OAUTH_SCOPES.includes(scope));
	if (unknown.length) {
		throw new OAuthError("invalid_scope", `Unsupported scope: ${unknown[0]}.`, 400);
	}
	// memory:write implies memory:read for enforcement; keep the grant honest
	// by recording exactly what was asked for, deduplicated and ordered.
	return OAUTH_SCOPES.filter((scope) => requested.includes(scope));
}

export function scopesToString(scopes = []) {
	return (scopes ?? []).join(" ");
}

/** Human-readable permission descriptions for the consent screen. */
export function describeScopes(scopes = []) {
	const set = new Set(scopes ?? []);
	const out = [];
	if (set.has(MEMORY_READ_SCOPE) || set.has(MEMORY_WRITE_SCOPE)) {
		out.push({
			scope: MEMORY_READ_SCOPE,
			title: "Read your memories",
			detail: "Search and read everything Itsuki remembers in the selected project, including saved conversations and their history.",
			destructive: false,
		});
	}
	if (set.has(MEMORY_WRITE_SCOPE)) {
		out.push({
			scope: MEMORY_WRITE_SCOPE,
			title: "Save and edit memories",
			detail: "Add new memories, save conversations, and revise existing ones. Earlier versions are kept.",
			destructive: false,
		});
	}
	if (set.has(MEMORY_DELETE_SCOPE)) {
		out.push({
			scope: MEMORY_DELETE_SCOPE,
			title: "Permanently delete memories",
			detail: "Erase individual memories or every memory in the selected project. Deleted memory cannot be recovered.",
			destructive: true,
		});
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* Metadata documents                                                        */

export function issuerFor(env, request) {
	const configured = String(env?.PUBLIC_ORIGIN ?? "").trim();
	if (configured) return configured.replace(/\/+$/, "");
	return new URL(request.url).origin;
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(issuer) {
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		registration_endpoint: `${issuer}/oauth/register`,
		revocation_endpoint: `${issuer}/oauth/revoke`,
		scopes_supported: [...OAUTH_SCOPES],
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
		// S256 only. `plain` is not implemented, so it is not advertised.
		code_challenge_methods_supported: ["S256"],
		revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
		service_documentation: `${issuer}/docs/api/mcp`,
		// RFC 8707: this server validates the resource indicator.
		resource_indicators_supported: true,
		// RFC 9207: the issuer is returned on the authorization response.
		authorization_response_iss_parameter_supported: true,
	};
}

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata(issuer) {
	return {
		resource: `${issuer}/mcp`,
		authorization_servers: [issuer],
		scopes_supported: [...OAUTH_SCOPES],
		bearer_methods_supported: ["header"],
		resource_documentation: `${issuer}/docs/api/mcp`,
	};
}

/**
 * The WWW-Authenticate challenge every unauthenticated or under-scoped MCP
 * response carries, so a client can discover where to authorize (Claude and
 * other MCP clients require `resource_metadata`).
 */
export function bearerChallenge(issuer, { error = null, description = null, scopes = null } = {}) {
	const parts = [`Bearer realm="itsuki"`];
	if (error) parts.push(`error="${error}"`);
	if (description) parts.push(`error_description="${String(description).replace(/"/g, "'")}"`);
	if (scopes?.length) parts.push(`scope="${scopes.join(" ")}"`);
	parts.push(`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
	return parts.join(", ");
}

/* ------------------------------------------------------------------------ */
/* PKCE                                                                      */

/** S256 only: base64url(SHA-256(verifier)) compared to the stored challenge. */
export async function verifyPkce({ verifier, challenge, method = "S256" }) {
	if (method !== "S256") return false;
	const value = String(verifier ?? "");
	// RFC 7636 §4.1 bounds. A short verifier is not a valid one.
	if (value.length < 43 || value.length > 128) return false;
	if (!/^[A-Za-z0-9\-._~]+$/.test(value)) return false;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let raw = "";
	for (const byte of new Uint8Array(digest)) raw += String.fromCharCode(byte);
	const computed = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	// Constant-time-ish comparison over equal-length base64url strings.
	const expected = String(challenge ?? "");
	if (computed.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

/* ------------------------------------------------------------------------ */
/* Clients                                                                   */

function validateRedirectUri(value) {
	const raw = String(value ?? "").trim();
	if (!raw || raw.length > MAX_URI_LENGTH) return null;
	let url;
	try { url = new URL(raw); } catch { return null; }
	// No fragments (RFC 6749 §3.1.2), no wildcards, no credentials.
	if (url.hash) return null;
	if (url.username || url.password) return null;
	const isHttps = url.protocol === "https:";
	// RFC 8252 loopback redirect for native clients (Claude Code uses one).
	const isLoopback = url.protocol === "http:"
		&& (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
	// A private-use scheme (com.example.app:/callback) is the other native form.
	const isPrivateScheme = /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol)
		&& !["http:", "https:", "javascript:", "data:", "file:", "vbscript:"].includes(url.protocol.toLowerCase())
		&& url.protocol.includes(".");
	if (!isHttps && !isLoopback && !isPrivateScheme) return null;
	return raw;
}

export function normalizeRedirectUris(value) {
	const list = Array.isArray(value) ? value : [];
	if (!list.length) throw new OAuthError("invalid_redirect_uri", "At least one redirect_uri is required.", 400);
	if (list.length > MAX_REDIRECT_URIS) {
		throw new OAuthError("invalid_client_metadata", `At most ${MAX_REDIRECT_URIS} redirect URIs are supported.`, 400);
	}
	const out = [];
	for (const entry of list) {
		const valid = validateRedirectUri(entry);
		if (!valid) {
			throw new OAuthError("invalid_redirect_uri", "Every redirect_uri must be an absolute https URL, a loopback http URL, or a private-use scheme, with no fragment.", 400);
		}
		if (!out.includes(valid)) out.push(valid);
	}
	return out;
}

function cleanText(value, max) {
	// Control characters are flattened here so a registered client_name cannot
	// smuggle newlines or terminal escapes into the consent screen or the logs.
	// HTML escaping still happens at render time; this is defence in depth.
	const text = String(value ?? "")
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text ? text.slice(0, max) : null;
}

/**
 * RFC 7591 dynamic client registration. Public clients (PKCE, no secret) are
 * the norm for MCP; a confidential client may request a secret.
 */
export async function registerClient(env, body = {}, { now = Date.now(), createdByUserId = null } = {}) {
	const redirectUris = normalizeRedirectUris(body.redirect_uris);
	const requestedAuth = String(body.token_endpoint_auth_method ?? "none");
	if (!["none", "client_secret_post", "client_secret_basic"].includes(requestedAuth)) {
		throw new OAuthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.", 400);
	}
	const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
		? body.grant_types.map(String)
		: ["authorization_code", "refresh_token"];
	const unsupportedGrant = grantTypes.find((g) => !["authorization_code", "refresh_token"].includes(g));
	if (unsupportedGrant) {
		throw new OAuthError("invalid_client_metadata", `Unsupported grant_type: ${unsupportedGrant}.`, 400);
	}
	const responseTypes = Array.isArray(body.response_types) && body.response_types.length
		? body.response_types.map(String)
		: ["code"];
	if (responseTypes.some((t) => t !== "code")) {
		throw new OAuthError("invalid_client_metadata", "Only the authorization code response type is supported.", 400);
	}
	// Scope is advisory at registration; the authorization request is what
	// actually determines what may be asked for.
	const scope = body.scope ? scopesToString(parseScopes(body.scope)) : null;

	const clientId = newId("itsuki_client");
	const secret = requestedAuth === "none" ? null : randomSecret(32);
	const registrationToken = `${REGISTRATION_TOKEN_PREFIX}${randomSecret(24)}`;
	const record = {
		client_id: clientId,
		client_secret_hash: secret ? await sha256Hex(secret) : null,
		client_name: cleanText(body.client_name, MAX_CLIENT_NAME),
		redirect_uris_json: JSON.stringify(redirectUris),
		grant_types_json: JSON.stringify(grantTypes),
		response_types_json: JSON.stringify(responseTypes),
		token_endpoint_auth_method: requestedAuth,
		scope,
		registration_access_token_hash: await sha256Hex(registrationToken),
		software_id: cleanText(body.software_id, 120),
		created_at: now,
		updated_at: now,
		expires_at: now + CLIENT_REGISTRATION_TTL_MS,
		status: "active",
		created_by_user_id: createdByUserId,
	};
	await env.DB.prepare(
		`INSERT INTO oauth_clients
			(client_id, client_secret_hash, client_name, redirect_uris_json, grant_types_json,
			 response_types_json, token_endpoint_auth_method, scope, registration_access_token_hash,
			 software_id, created_at, updated_at, expires_at, status, created_by_user_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		record.client_id, record.client_secret_hash, record.client_name, record.redirect_uris_json,
		record.grant_types_json, record.response_types_json, record.token_endpoint_auth_method,
		record.scope, record.registration_access_token_hash, record.software_id,
		record.created_at, record.updated_at, record.expires_at, record.status, record.created_by_user_id,
	).run();

	return {
		client_id: clientId,
		...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
		client_id_issued_at: Math.floor(now / 1000),
		client_name: record.client_name ?? undefined,
		redirect_uris: redirectUris,
		grant_types: grantTypes,
		response_types: responseTypes,
		token_endpoint_auth_method: requestedAuth,
		...(scope ? { scope } : {}),
		registration_access_token: registrationToken,
	};
}

export async function loadClient(env, clientId, { now = Date.now() } = {}) {
	const id = String(clientId ?? "").trim();
	if (!id) return null;
	const row = await env.DB.prepare(
		"SELECT * FROM oauth_clients WHERE client_id = ? LIMIT 1",
	).bind(id).first();
	if (!row) return null;
	if (row.status !== "active") return null;
	if (row.expires_at && Number(row.expires_at) <= now) return null;
	let redirectUris = [];
	let grantTypes = [];
	try { redirectUris = JSON.parse(row.redirect_uris_json ?? "[]"); } catch {}
	try { grantTypes = JSON.parse(row.grant_types_json ?? "[]"); } catch {}
	return {
		...row,
		redirect_uris: Array.isArray(redirectUris) ? redirectUris : [],
		grant_types: Array.isArray(grantTypes) ? grantTypes : [],
	};
}

/** Exact match only — the single most important check in the whole flow. */
export function redirectUriAllowed(client, redirectUri) {
	const candidate = String(redirectUri ?? "");
	if (!candidate) return false;
	return (client?.redirect_uris ?? []).some((uri) => uri === candidate);
}

/* ------------------------------------------------------------------------ */
/* Grants, codes, tokens                                                     */

export async function findLiveGrant(env, { userId, clientId, projectId = null }) {
	return env.DB.prepare(
		`SELECT * FROM oauth_grants
		 WHERE user_id = ? AND client_id = ? AND project_id IS ? AND revoked_at IS NULL
		 LIMIT 1`,
	).bind(userId, clientId, projectId ?? null).first();
}

/**
 * Create or re-authorize the grant for (user, client, project).
 *
 * Re-authorization REPLACES the scope set rather than accumulating it, so
 * consenting to less genuinely narrows the grant. Narrowing also revokes the
 * tokens issued under the wider scope — otherwise the old access token would
 * keep the permissions the user just removed.
 */
export async function upsertGrant(env, { userId, clientId, projectId = null, scopes, now = Date.now() }) {
	const existing = await findLiveGrant(env, { userId, clientId, projectId });
	const scopesJson = JSON.stringify(scopes);
	if (existing) {
		let previous = [];
		try { previous = JSON.parse(existing.scopes_json ?? "[]"); } catch {}
		const narrowed = previous.some((scope) => !scopes.includes(scope));
		const statements = [
			env.DB.prepare(
				"UPDATE oauth_grants SET scopes_json = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
			).bind(scopesJson, now, existing.id),
		];
		if (narrowed) {
			statements.push(env.DB.prepare(
				"UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
			).bind(now, existing.id));
		}
		await env.DB.batch(statements);
		return { id: existing.id, created: false, narrowed };
	}
	const id = newId("ogrant");
	await env.DB.prepare(
		`INSERT INTO oauth_grants (id, user_id, client_id, project_id, scopes_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, clientId, projectId ?? null, scopesJson, now, now).run();
	return { id, created: true, narrowed: false };
}

export async function issueAuthorizationCode(env, {
	grantId, clientId, userId, projectId = null, scopes, redirectUri,
	codeChallenge, codeChallengeMethod = "S256", resource = null, now = Date.now(),
}) {
	const code = randomSecret(32);
	await env.DB.prepare(
		`INSERT INTO oauth_authorization_codes
			(code_hash, grant_id, client_id, user_id, project_id, scopes_json, redirect_uri,
			 code_challenge, code_challenge_method, resource, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		await sha256Hex(code), grantId, clientId, userId, projectId ?? null,
		JSON.stringify(scopes), redirectUri, codeChallenge, codeChallengeMethod,
		resource, now, now + AUTHORIZATION_CODE_TTL_MS,
	).run();
	return code;
}

/**
 * Consume an authorization code exactly once.
 *
 * The UPDATE is the claim: `consumed_at IS NULL` in the WHERE clause means two
 * concurrent exchanges cannot both win, without a transaction or a lock. A
 * code presented twice is treated as replay — RFC 6749 §4.1.2 requires
 * revoking the tokens already issued from it.
 */
export async function consumeAuthorizationCode(env, code, { now = Date.now() } = {}) {
	const codeHash = await sha256Hex(code);
	const row = await env.DB.prepare(
		"SELECT * FROM oauth_authorization_codes WHERE code_hash = ? LIMIT 1",
	).bind(codeHash).first();
	if (!row) return { ok: false, reason: "unknown" };
	if (row.consumed_at) {
		// Replay of a spent code: revoke everything it produced.
		await env.DB.batch([
			env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'authorization_code_replay' WHERE id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
			env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
		]);
		return { ok: false, reason: "replayed", row };
	}
	if (Number(row.expires_at) <= now) return { ok: false, reason: "expired", row };
	const claimed = await env.DB.prepare(
		"UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL RETURNING code_hash",
	).bind(now, codeHash).first();
	if (!claimed) return { ok: false, reason: "replayed", row };
	return { ok: true, row };
}

export async function issueTokenPair(env, {
	grantId, clientId, userId, scopes, now = Date.now(), rotatedFrom = null,
}) {
	const accessToken = `${ACCESS_TOKEN_PREFIX}${randomSecret(32)}`;
	const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomSecret(32)}`;
	const scopesJson = JSON.stringify(scopes);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO oauth_tokens
				(id, grant_id, user_id, client_id, kind, token_hash, scopes_json, created_at, expires_at, rotated_from)
			 VALUES (?, ?, ?, ?, 'access', ?, ?, ?, ?, NULL)`,
		).bind(newId("otok"), grantId, userId, clientId, await sha256Hex(accessToken), scopesJson, now, now + ACCESS_TOKEN_TTL_MS),
		env.DB.prepare(
			`INSERT INTO oauth_tokens
				(id, grant_id, user_id, client_id, kind, token_hash, scopes_json, created_at, expires_at, rotated_from)
			 VALUES (?, ?, ?, ?, 'refresh', ?, ?, ?, ?, ?)`,
		).bind(newId("otok"), grantId, userId, clientId, await sha256Hex(refreshToken), scopesJson, now, now + REFRESH_TOKEN_TTL_MS, rotatedFrom),
		env.DB.prepare("UPDATE oauth_grants SET last_used_at = ?, updated_at = ? WHERE id = ?").bind(now, now, grantId),
	]);
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: "Bearer",
		expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
		scope: scopesToString(scopes),
	};
}

/**
 * Rotate a refresh token, with reuse detection.
 *
 * A refresh token is single-use. Presenting one that has already been rotated
 * means either a stolen token or a confused client; OAuth 2.1 requires
 * revoking the whole family, so the entire grant is revoked and the caller
 * must re-authorize. This is deliberately unforgiving: silently issuing new
 * tokens after a replay is how refresh-token theft goes unnoticed.
 *
 * `requestedScopes` is checked BEFORE the token is claimed. A request this
 * server is going to refuse must not consume the single-use credential it
 * refused: burning it would turn a client-side scope mistake into a forced
 * re-authorization, and the client's natural retry would then look like reuse
 * and revoke the whole grant.
 */
export async function rotateRefreshToken(env, refreshToken, { clientId, now = Date.now(), requestedScopes = null }) {
	const tokenHash = await sha256Hex(refreshToken);
	const row = await env.DB.prepare(
		"SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' LIMIT 1",
	).bind(tokenHash).first();
	if (!row) return { ok: false, reason: "unknown" };
	if (row.client_id !== clientId) return { ok: false, reason: "wrong_client" };
	if (row.consumed_at || row.revoked_at) {
		await env.DB.batch([
			env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'refresh_token_reuse' WHERE id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
			env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
		]);
		return { ok: false, reason: "reused", row };
	}
	if (Number(row.expires_at) <= now) return { ok: false, reason: "expired", row };
	const grant = await env.DB.prepare(
		"SELECT * FROM oauth_grants WHERE id = ? AND revoked_at IS NULL LIMIT 1",
	).bind(row.grant_id).first();
	if (!grant) return { ok: false, reason: "grant_revoked" };

	let scopes = [];
	try { scopes = JSON.parse(grant.scopes_json ?? "[]"); } catch {}
	// OAuth 2.1 §4.3.2: a refresh may narrow scope, never widen it. Refuse
	// here — before the claim below — so the rejected request leaves the
	// refresh token spendable.
	if (requestedScopes) {
		const widened = requestedScopes.filter((scope) => !scopes.includes(scope));
		if (widened.length) return { ok: false, reason: "scope_exceeded", row, grant, scopes };
	}

	// Claim this refresh token; a concurrent refresh loses and sees `reused`
	// on its next attempt rather than both succeeding.
	const claimed = await env.DB.prepare(
		"UPDATE oauth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",
	).bind(now, row.id).first();
	if (!claimed) return { ok: false, reason: "reused", row };

	// The previous access tokens for this grant stop working at rotation: a
	// refresh is the client saying "give me current credentials".
	await env.DB.prepare(
		"UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND kind = 'access' AND revoked_at IS NULL",
	).bind(now, row.grant_id).run();

	return { ok: true, grant, scopes, rotatedFrom: row.id };
}

/**
 * Resolve a bearer access token to its live grant.
 *
 * Every failure returns null — an expired, revoked, unknown, or wrong-kind
 * token are indistinguishable to the caller on purpose.
 */
export async function resolveAccessToken(env, token, { now = Date.now() } = {}) {
	const raw = String(token ?? "");
	if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
	const row = await env.DB.prepare(
		`SELECT tok.id AS token_id, tok.grant_id, tok.user_id, tok.client_id, tok.scopes_json AS token_scopes_json,
			tok.expires_at, tok.revoked_at,
			g.project_id, g.scopes_json AS grant_scopes_json, g.revoked_at AS grant_revoked_at,
			c.client_name,
			u.status AS user_status
		 FROM oauth_tokens tok
		 JOIN oauth_grants g ON g.id = tok.grant_id
		 JOIN users u ON u.id = tok.user_id
		 LEFT JOIN oauth_clients c ON c.client_id = tok.client_id
		 WHERE tok.token_hash = ? AND tok.kind = 'access'
		 LIMIT 1`,
	).bind(await sha256Hex(raw)).first();
	if (!row) return null;
	if (row.revoked_at || row.grant_revoked_at) return null;
	if (Number(row.expires_at) <= now) return null;
	if (row.user_status !== "active") return null;
	const erased = await env.DB.prepare(
		"SELECT 1 AS x FROM account_erasure_tombstones WHERE user_id = ? LIMIT 1",
	).bind(row.user_id).first();
	if (erased) return null;
	// The grant is the authority on scope: a token minted before the grant was
	// narrowed must not out-rank it.
	let grantScopes = [];
	try { grantScopes = JSON.parse(row.grant_scopes_json ?? "[]"); } catch {}
	let tokenScopes = [];
	try { tokenScopes = JSON.parse(row.token_scopes_json ?? "[]"); } catch {}
	const scopes = tokenScopes.filter((scope) => grantScopes.includes(scope));
	return {
		kind: "oauth",
		tokenId: row.token_id,
		grantId: row.grant_id,
		userId: row.user_id,
		clientId: row.client_id,
		clientName: row.client_name ?? null,
		projectId: row.project_id ?? null,
		scopes,
	};
}

/** RFC 7009 revocation. Revoking a refresh token revokes its whole grant. */
export async function revokeToken(env, token, { clientId = null, now = Date.now() } = {}) {
	const raw = String(token ?? "");
	if (!raw) return { revoked: false };
	const row = await env.DB.prepare(
		"SELECT id, grant_id, kind, client_id FROM oauth_tokens WHERE token_hash = ? LIMIT 1",
	).bind(await sha256Hex(raw)).first();
	if (!row) return { revoked: false };
	// RFC 7009: a client may only revoke its own tokens.
	if (clientId && row.client_id !== clientId) return { revoked: false };
	if (row.kind === "refresh") {
		await env.DB.batch([
			env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'client_revocation' WHERE id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
			env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, row.grant_id),
		]);
		return { revoked: true, scope: "grant" };
	}
	await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(now, row.id).run();
	return { revoked: true, scope: "token" };
}

export async function revokeGrant(env, grantId, { now = Date.now(), reason = "user_revocation" } = {}) {
	await env.DB.batch([
		env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL").bind(now, reason, grantId),
		env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, grantId),
	]);
}

/**
 * Statements revoking every OAuth grant for a user (optionally scoped to one
 * project), for inclusion in the SAME batch that revokes connection tokens —
 * membership removal, project deletion, and account erasure must not leave a
 * live grant behind.
 */
export function grantRevocationStatements(env, { userId, projectId = null, now = Date.now(), reason = "access_revoked" }) {
	const where = projectId ? "user_id = ? AND project_id = ?" : "user_id = ?";
	const binds = projectId ? [userId, projectId] : [userId];
	return [
		env.DB.prepare(
			`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?)
			 WHERE ${where} AND revoked_at IS NULL`,
		).bind(now, reason, ...binds),
		env.DB.prepare(
			`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?)
			 WHERE grant_id IN (SELECT id FROM oauth_grants WHERE ${where}) AND revoked_at IS NULL`,
		).bind(now, ...binds),
	];
}

/**
 * Bounded housekeeping for expired codes, consent requests, and dead tokens.
 *
 * Bounded via a keyed subselect rather than `DELETE ... LIMIT`, which SQLite
 * only supports when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT.
 */
export async function purgeExpiredOAuthState(env, { now = Date.now(), limit = 500 } = {}) {
	const results = await env.DB.batch([
		env.DB.prepare(
			`DELETE FROM oauth_authorization_codes WHERE code_hash IN (
			   SELECT code_hash FROM oauth_authorization_codes WHERE expires_at < ? ORDER BY expires_at LIMIT ?
			 )`,
		).bind(now - AUTHORIZATION_CODE_TTL_MS, limit),
		env.DB.prepare(
			`DELETE FROM oauth_consent_requests WHERE id IN (
			   SELECT id FROM oauth_consent_requests WHERE expires_at < ? ORDER BY expires_at LIMIT ?
			 )`,
		).bind(now, limit),
		env.DB.prepare(
			`DELETE FROM oauth_tokens WHERE id IN (
			   SELECT id FROM oauth_tokens WHERE expires_at < ? ORDER BY expires_at LIMIT ?
			 )`,
		).bind(now - REFRESH_TOKEN_TTL_MS, limit),
	]);
	return results.map((r) => Number(r?.meta?.changes ?? 0));
}

/* ------------------------------------------------------------------------ */
/* Consent requests                                                          */

export async function createConsentRequest(env, {
	clientId, userId, sessionId, redirectUri, state, scopes, codeChallenge,
	codeChallengeMethod = "S256", resource = null, projectId = null, now = Date.now(),
}) {
	const id = newId("oconsent");
	const csrf = randomSecret(24);
	// RFC 6749 §4.1.2 requires the authorization response to echo the EXACT
	// state the client sent. Truncating a long one instead would hand the client
	// back a value it never sent, which its own CSRF check reads as an attack —
	// a silent corruption dressed up as a security alert. Refuse loudly instead.
	const stateValue = state ? String(state) : null;
	if (stateValue !== null && stateValue.length > MAX_STATE_LENGTH) {
		throw new OAuthError("invalid_request", `state must be at most ${MAX_STATE_LENGTH} characters.`, 400);
	}
	await env.DB.prepare(
		`INSERT INTO oauth_consent_requests
			(id, client_id, user_id, session_id, redirect_uri, state, scopes_json,
			 code_challenge, code_challenge_method, resource, project_id, csrf_hash, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		id, clientId, userId, sessionId, redirectUri, stateValue,
		JSON.stringify(scopes), codeChallenge, codeChallengeMethod, resource, projectId,
		await sha256Hex(csrf), now, now + CONSENT_REQUEST_TTL_MS,
	).run();
	return { id, csrf };
}

export async function loadConsentRequest(env, id, { now = Date.now() } = {}) {
	const row = await env.DB.prepare(
		"SELECT * FROM oauth_consent_requests WHERE id = ? LIMIT 1",
	).bind(String(id ?? "")).first();
	if (!row) return null;
	if (row.decided_at) return null;
	if (Number(row.expires_at) <= now) return null;
	let scopes = [];
	try { scopes = JSON.parse(row.scopes_json ?? "[]"); } catch {}
	return { ...row, scopes };
}

/** Single-use: the decision claim and the CSRF proof happen together. */
export async function decideConsentRequest(env, id, csrf, { now = Date.now() } = {}) {
	const row = await loadConsentRequest(env, id, { now });
	if (!row) return { ok: false, reason: "unknown" };
	const presented = await sha256Hex(String(csrf ?? ""));
	if (presented !== row.csrf_hash) return { ok: false, reason: "csrf" };
	const claimed = await env.DB.prepare(
		"UPDATE oauth_consent_requests SET decided_at = ? WHERE id = ? AND decided_at IS NULL RETURNING id",
	).bind(now, id).first();
	if (!claimed) return { ok: false, reason: "already_decided" };
	return { ok: true, row };
}

/* ------------------------------------------------------------------------ */
/* Redirect helpers                                                          */

export function buildRedirect(redirectUri, params) {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}
