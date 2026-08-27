/**
 * The OAuth 2.1 HTTP surface for Itsuki's MCP server.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
 *   GET  /.well-known/oauth-authorization-server      RFC 8414
 *   GET  /oauth/authorize                             consent screen
 *   POST /oauth/authorize                             consent decision
 *   POST /oauth/token                                 code exchange + refresh
 *   POST /oauth/revoke                                RFC 7009
 *   POST /oauth/register                              RFC 7591
 *
 * Nothing here touches the dashboard's Google sign-in. It does REUSE the
 * dashboard session as the login step, which is the point: a user authorizes
 * an MCP client while signed in as themselves, and the active identity is
 * re-verified immediately before the grant commits.
 */

import { getSessionUser } from "../auth.js";
import { allowRate } from "./rate.js";
import { ensureDefaultManagedProject } from "./managed_projects.js";

const clientIpOf = (request) => request.headers.get("cf-connecting-ip") ?? "local";
import {
	MAX_STATE_LENGTH,
	OAuthError,
	authorizationServerMetadata,
	buildRedirect,
	createConsentRequest,
	consumeAuthorizationCode,
	decideConsentRequest,
	describeScopes,
	issueAuthorizationCode,
	issueTokenPair,
	issuerFor,
	loadClient,
	loadConsentRequest,
	oauthMode,
	parseScopes,
	protectedResourceMetadata,
	redirectUriAllowed,
	registerClient,
	revokeToken,
	rotateRefreshToken,
	scopesToString,
	upsertGrant,
	verifyPkce,
} from "./oauth.js";
import { sha256Hex } from "../auth.js";

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function oauthJson(data, status = 200, extraHeaders = {}) {
	const headers = new Headers({ ...NO_STORE, ...extraHeaders });
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(data), { status, headers });
}

function metadataJson(data) {
	const headers = new Headers({ "cache-control": "public, max-age=300" });
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(data), { status: 200, headers });
}

function errorJson(error) {
	const code = error?.code ?? "server_error";
	const status = error?.status ?? 400;
	return oauthJson({ error: code, error_description: error?.description ?? "The request could not be processed." }, status);
}

/** HTML escaping for every interpolated value on the consent screen. */
function esc(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function htmlResponse(body, status = 200) {
	return new Response(body, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE },
	});
}

async function formBody(request) {
	const type = request.headers.get("content-type") ?? "";
	if (type.includes("application/json")) {
		try { return await request.json(); } catch { return {}; }
	}
	const text = await request.text();
	return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Client authentication for the token and revocation endpoints. Public
 * clients (PKCE, `token_endpoint_auth_method: none`) present no secret; a
 * confidential client must present the right one.
 */
async function authenticateClient(env, request, body) {
	let clientId = body.client_id ? String(body.client_id) : null;
	let clientSecret = body.client_secret ? String(body.client_secret) : null;
	const authorization = request.headers.get("authorization") ?? "";
	if (/^basic /i.test(authorization)) {
		try {
			const decoded = atob(authorization.slice(6).trim());
			const idx = decoded.indexOf(":");
			if (idx > -1) {
				clientId = decodeURIComponent(decoded.slice(0, idx));
				clientSecret = decodeURIComponent(decoded.slice(idx + 1));
			}
		} catch {
			throw new OAuthError("invalid_client", "Malformed client credentials.", 401);
		}
	}
	if (!clientId) throw new OAuthError("invalid_client", "client_id is required.", 401);
	const client = await loadClient(env, clientId);
	if (!client) throw new OAuthError("invalid_client", "Unknown or expired client.", 401);
	if (client.token_endpoint_auth_method === "none") {
		// A public client must NOT be able to authenticate with a secret it
		// somehow supplies; there is nothing to verify against.
		return client;
	}
	if (!clientSecret) throw new OAuthError("invalid_client", "This client must authenticate.", 401);
	const presented = await sha256Hex(clientSecret);
	if (!client.client_secret_hash || presented !== client.client_secret_hash) {
		throw new OAuthError("invalid_client", "Client authentication failed.", 401);
	}
	return client;
}

/* ------------------------------------------------------------------------ */
/* Consent screen                                                            */

function consentPage({ issuer, clientName, email, projectName, permissions, consentId, csrf, state }) {
	const dangerous = permissions.filter((p) => p.destructive);
	const ordinary = permissions.filter((p) => !p.destructive);
	const row = (p, danger) => `
		<li class="perm${danger ? " perm-danger" : ""}">
			<div class="perm-title">${esc(p.title)}</div>
			<div class="perm-detail">${esc(p.detail)}</div>
		</li>`;
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Authorize ${esc(clientName)} — Itsuki</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
:root { color-scheme: dark light; --bg:#0b0b0f; --card:#141419; --line:#26262e; --fg:#f2f2f5; --muted:#a0a0ab; --accent:#745bc8; --danger:#e05252; --danger-bg:#2a1616; }
@media (prefers-color-scheme: light) { :root { --bg:#f7f7fa; --card:#fff; --line:#e3e3ea; --fg:#16161a; --muted:#5c5c68; --danger-bg:#fdf0f0; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
  background:var(--bg); color:var(--fg); font-family: Fustat, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.card { width:100%; max-width:460px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
h1 { font-size:19px; line-height:1.35; margin:0 0 6px; font-weight:650; }
.sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
.who { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:18px; font-size:13.5px; }
.who div + div { margin-top:5px; }
.who .k { color:var(--muted); }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:18px 0 8px; font-weight:600; }
ul { list-style:none; margin:0; padding:0; }
.perm { border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin-bottom:8px; }
.perm-title { font-size:14px; font-weight:600; }
.perm-detail { font-size:13px; color:var(--muted); margin-top:3px; line-height:1.45; }
.perm-danger { border-color:var(--danger); background:var(--danger-bg); }
.perm-danger .perm-title { color:var(--danger); }
.actions { display:flex; gap:10px; margin-top:22px; }
button { flex:1; font:inherit; font-size:14.5px; font-weight:600; padding:11px 14px; border-radius:10px; cursor:pointer; border:1px solid var(--line); }
.deny { background:transparent; color:var(--fg); }
.allow { background:var(--accent); border-color:var(--accent); color:#fff; }
button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.foot { margin-top:16px; font-size:12px; color:var(--muted); line-height:1.5; }
</style>
</head>
<body>
<main class="card">
  <h1>Authorize ${esc(clientName)}</h1>
  <p class="sub">${esc(clientName)} wants to connect to your Itsuki memory.</p>
  <div class="who">
    <div><span class="k">Account</span> &middot; ${esc(email)}</div>
    <div><span class="k">Project</span> &middot; ${esc(projectName)}</div>
  </div>
  <h2>This will allow it to</h2>
  <ul>${ordinary.map((p) => row(p, false)).join("")}</ul>
  ${dangerous.length ? `<h2>Requires your explicit approval</h2><ul>${dangerous.map((p) => row(p, true)).join("")}</ul>` : ""}
  <form method="POST" action="${esc(issuer)}/oauth/authorize">
    <input type="hidden" name="consent_id" value="${esc(consentId)}">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    ${state ? `<input type="hidden" name="state" value="${esc(state)}">` : ""}
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow access</button>
    </div>
  </form>
  <p class="foot">You can revoke this connection at any time from Itsuki settings. Only approve if you started this from ${esc(clientName)}.</p>
</main>
</body>
</html>`;
}

function noticePage(title, message) {
	return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)} — Itsuki</title>
<style>
:root{color-scheme:dark light;--bg:#0b0b0f;--card:#141419;--line:#26262e;--fg:#f2f2f5;--muted:#a0a0ab}
@media (prefers-color-scheme: light){:root{--bg:#f7f7fa;--card:#fff;--line:#e3e3ea;--fg:#16161a;--muted:#5c5c68}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--fg);
font-family:Fustat,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:18px;margin:0 0 8px}p{color:var(--muted);font-size:14px;line-height:1.55;margin:0}
</style></head>
<body><main class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}

/* ------------------------------------------------------------------------ */
/* Handlers                                                                  */

/**
 * GET /oauth/authorize — validate the request, then show consent.
 *
 * Errors are split deliberately: anything that would let an attacker choose
 * where the browser lands (unknown client, unregistered redirect_uri) renders
 * an on-site error and NEVER redirects. Everything else redirects the error
 * back to the registered URI, as OAuth requires.
 */
async function handleAuthorizeGet(request, env, url) {
	const issuer = issuerFor(env, request);
	const params = url.searchParams;
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const client = clientId ? await loadClient(env, clientId) : null;
	if (!client) {
		return htmlResponse(noticePage("Unknown application", "This application is not registered with Itsuki, or its registration has expired. Nothing was shared."), 400);
	}
	if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
		return htmlResponse(noticePage("Invalid redirect", "This application asked to return to an address that is not registered for it. For your safety, Itsuki stopped here and shared nothing."), 400);
	}
	const state = params.get("state");
	const fail = (code, description) => Response.redirect(buildRedirect(redirectUri, {
		error: code, error_description: description, state, iss: issuer,
	}), 302);

	// State is bounded, but never silently: a truncated state comes back as a
	// value the client never sent, which its own CSRF check must reject. Saying
	// so plainly is the only answer that leaves the client able to diagnose it.
	if (state && state.length > MAX_STATE_LENGTH) {
		return fail("invalid_request", `state must be at most ${MAX_STATE_LENGTH} characters.`);
	}

	if (params.get("response_type") !== "code") {
		return fail("unsupported_response_type", "Only the authorization code flow is supported.");
	}
	const codeChallenge = params.get("code_challenge");
	const method = params.get("code_challenge_method") ?? "";
	if (!codeChallenge) return fail("invalid_request", "PKCE is required: send code_challenge with S256.");
	if (method !== "S256") return fail("invalid_request", "Only the S256 PKCE method is supported.");

	let scopes;
	try {
		scopes = parseScopes(params.get("scope"));
	} catch (error) {
		return fail(error.code ?? "invalid_scope", error.description ?? "Unsupported scope.");
	}
	// RFC 8707: when a resource is named it must be this MCP server.
	const resource = params.get("resource");
	if (resource) {
		const expected = `${issuer}/mcp`;
		const normalized = resource.replace(/\/+$/, "");
		if (normalized !== expected && normalized !== issuer) {
			return fail("invalid_target", "This authorization server does not issue tokens for that resource.");
		}
	}

	const session = await getSessionUser(env, request);
	if (!session) {
		// Send them through the normal Itsuki login, then straight back here.
		const back = new URL(url.toString());
		return Response.redirect(`${issuer}/?view=login&next=${encodeURIComponent(back.pathname + back.search)}`, 302);
	}

	// The project this grant will be bound to, resolved and NAMED on the
	// consent screen. It is stored on the grant, so a later request cannot
	// move the connection to a project the user never saw.
	const project = await ensureDefaultManagedProject(env, session.userId);
	const consent = await createConsentRequest(env, {
		clientId: client.client_id,
		userId: session.userId,
		// getSessionUser returns the session under `session.session`; reading a
		// non-existent `session.sessionId` recorded NULL on every consent row.
		sessionId: session.session?.id ?? null,
		redirectUri,
		state,
		scopes,
		codeChallenge,
		codeChallengeMethod: "S256",
		resource: resource ?? null,
		projectId: project?.id ?? null,
	});
	return htmlResponse(consentPage({
		issuer,
		clientName: client.client_name || client.client_id,
		email: session.user?.email ?? session.userId,
		projectName: project?.name ?? "Personal memory",
		permissions: describeScopes(scopes),
		consentId: consent.id,
		csrf: consent.csrf,
		state,
	}));
}

/** POST /oauth/authorize — the decision. */
async function handleAuthorizePost(request, env) {
	const issuer = issuerFor(env, request);
	const body = await formBody(request);
	const decided = await decideConsentRequest(env, body.consent_id, body.csrf);
	if (!decided.ok) {
		const message = decided.reason === "csrf"
			? "This approval could not be verified. Start the connection again from your client."
			: "This authorization request has expired or was already answered. Start the connection again from your client.";
		return htmlResponse(noticePage("Request expired", message), 400);
	}
	const consent = decided.row;
	const client = await loadClient(env, consent.client_id);
	if (!client || !redirectUriAllowed(client, consent.redirect_uri)) {
		return htmlResponse(noticePage("Invalid redirect", "This application's registration changed while you were deciding. Nothing was shared."), 400);
	}
	const denied = String(body.decision ?? "") !== "allow";
	if (denied) {
		return Response.redirect(buildRedirect(consent.redirect_uri, {
			error: "access_denied",
			error_description: "The user denied this request.",
			state: consent.state,
			iss: issuer,
		}), 302);
	}

	// Re-verify the ACTIVE identity at the moment of commit. A user must never
	// approve access for an account they are no longer (or never were) signed
	// in as — switching accounts in another tab mid-consent is the exact case
	// this closes.
	const session = await getSessionUser(env, request);
	if (!session || session.userId !== consent.user_id) {
		return htmlResponse(noticePage(
			"Signed-in account changed",
			"The account signed in to this browser is not the one this request was started for. Nothing was authorized. Sign in as the right account and start again from your client.",
		), 409);
	}

	const grant = await upsertGrant(env, {
		userId: consent.user_id,
		clientId: consent.client_id,
		projectId: consent.project_id ?? null,
		scopes: consent.scopes,
	});
	const code = await issueAuthorizationCode(env, {
		grantId: grant.id,
		clientId: consent.client_id,
		userId: consent.user_id,
		projectId: consent.project_id ?? null,
		scopes: consent.scopes,
		redirectUri: consent.redirect_uri,
		codeChallenge: consent.code_challenge,
		codeChallengeMethod: consent.code_challenge_method,
		resource: consent.resource ?? null,
	});
	return Response.redirect(buildRedirect(consent.redirect_uri, {
		code,
		state: consent.state,
		// RFC 9207 — lets a client detect a mix-up attack.
		iss: issuer,
	}), 302);
}

/** POST /oauth/token — authorization_code and refresh_token grants. */
async function handleToken(request, env) {
	const body = await formBody(request);
	const client = await authenticateClient(env, request, body);
	const grantType = String(body.grant_type ?? "");

	if (grantType === "authorization_code") {
		const code = String(body.code ?? "");
		if (!code) throw new OAuthError("invalid_request", "code is required.", 400);
		const result = await consumeAuthorizationCode(env, code);
		if (!result.ok) {
			const description = result.reason === "replayed"
				? "This authorization code was already used. For safety the whole authorization has been revoked; start again."
				: "That authorization code is invalid or expired.";
			throw new OAuthError("invalid_grant", description, 400);
		}
		const row = result.row;
		if (row.client_id !== client.client_id) {
			throw new OAuthError("invalid_grant", "That authorization code was issued to a different client.", 400);
		}
		// RFC 6749 §4.1.3: the redirect_uri must match the one used to obtain
		// the code, exactly.
		if (String(body.redirect_uri ?? "") !== row.redirect_uri) {
			throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.", 400);
		}
		const verified = await verifyPkce({
			verifier: body.code_verifier,
			challenge: row.code_challenge,
			method: row.code_challenge_method,
		});
		if (!verified) throw new OAuthError("invalid_grant", "The PKCE code_verifier is missing or does not match.", 400);
		if (body.resource) {
			const expected = `${issuerFor(env, request)}/mcp`;
			const normalized = String(body.resource).replace(/\/+$/, "");
			if (normalized !== expected && normalized !== issuerFor(env, request)) {
				throw new OAuthError("invalid_target", "This token is not issued for that resource.", 400);
			}
		}
		let scopes = [];
		try { scopes = JSON.parse(row.scopes_json ?? "[]"); } catch {}
		const tokens = await issueTokenPair(env, {
			grantId: row.grant_id,
			clientId: row.client_id,
			userId: row.user_id,
			scopes,
		});
		return oauthJson(tokens);
	}

	if (grantType === "refresh_token") {
		const refreshToken = String(body.refresh_token ?? "");
		if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.", 400);
		// A refresh may narrow scope but never widen it (OAuth 2.1 §4.3.2). Both
		// halves of that check run BEFORE the rotation: an unsupported scope
		// throws here, and an over-reaching one is refused inside the rotation
		// before the refresh token is claimed. A request we refuse must not spend
		// the single-use credential it was presented with.
		const requested = body.scope ? parseScopes(body.scope) : null;
		const rotated = await rotateRefreshToken(env, refreshToken, {
			clientId: client.client_id,
			requestedScopes: requested,
		});
		if (!rotated.ok) {
			if (rotated.reason === "scope_exceeded") {
				throw new OAuthError("invalid_scope", "A refresh cannot request more than was granted.", 400);
			}
			const description = rotated.reason === "reused"
				? "This refresh token was already used. The authorization has been revoked; the user must authorize again."
				: "That refresh token is invalid, expired, or revoked.";
			throw new OAuthError("invalid_grant", description, 400);
		}
		const scopes = requested ?? rotated.scopes;
		const tokens = await issueTokenPair(env, {
			grantId: rotated.grant.id,
			clientId: client.client_id,
			userId: rotated.grant.user_id,
			scopes,
			rotatedFrom: rotated.rotatedFrom,
		});
		return oauthJson(tokens);
	}

	throw new OAuthError("unsupported_grant_type", `Unsupported grant_type: ${grantType || "(missing)"}.`, 400);
}

/** POST /oauth/revoke — RFC 7009. Always 200, even for unknown tokens. */
async function handleRevoke(request, env) {
	const body = await formBody(request);
	let clientId = null;
	try {
		const client = await authenticateClient(env, request, body);
		clientId = client.client_id;
	} catch {
		// RFC 7009 §2.1: an invalid client on revocation is still answered
		// blandly — the endpoint must not become a token oracle.
		return oauthJson({});
	}
	await revokeToken(env, body.token, { clientId });
	return oauthJson({});
}

/** POST /oauth/register — RFC 7591 dynamic client registration. */
async function handleRegister(request, env) {
	let body;
	try { body = await request.json(); } catch {
		throw new OAuthError("invalid_client_metadata", "The registration body must be JSON.", 400);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new OAuthError("invalid_client_metadata", "The registration body must be a JSON object.", 400);
	}
	const registered = await registerClient(env, body);
	return oauthJson(registered, 201);
}

/* ------------------------------------------------------------------------ */
/* Router                                                                    */

/**
 * Returns a Response for an OAuth path, or null to fall through.
 *
 * Metadata is served in BOTH modes: advertising the authorization server
 * while the flow is disabled would be a lie, so in "track" the documents are
 * served only when the flow can actually complete. The flag therefore gates
 * everything except the protected-resource pointer, which stays truthful by
 * being absent too.
 */
export async function handleOAuthRoutes(request, env, ctx, url) {
	const path = url.pathname;
	const isOAuthPath = path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");
	if (!isOAuthPath) return null;

	if (oauthMode(env) !== "on") {
		// Track stage: the subsystem is deployed but not offered. Saying "not
		// found" is the honest answer — a client must not discover an
		// authorization server that will not issue tokens.
		return oauthJson({ error: "not_found", error_description: "OAuth authorization is not enabled on this server." }, 404);
	}

	const issuer = issuerFor(env, request);
	try {
		if (request.method === "GET" && (
			path === "/.well-known/oauth-protected-resource"
			|| path === "/.well-known/oauth-protected-resource/mcp"
		)) {
			return metadataJson(protectedResourceMetadata(issuer));
		}
		if (request.method === "GET" && (
			path === "/.well-known/oauth-authorization-server"
			|| path === "/.well-known/oauth-authorization-server/mcp"
		)) {
			return metadataJson(authorizationServerMetadata(issuer));
		}
		if (path === "/oauth/authorize") {
			if (request.method === "GET") return handleAuthorizeGet(request, env, url);
			if (request.method === "POST") return handleAuthorizePost(request, env);
			return oauthJson({ error: "invalid_request", error_description: "Method not allowed." }, 405);
		}
		// Unauthenticated-by-spec doors still get the auth bucket per IP: an
		// unmetered /oauth/register writes a D1 row per call, and /oauth/token
		// is a guessing surface. Same limiter and refusal shape as /auth/login.
		if (path === "/oauth/token" && request.method === "POST") {
			if (!(await allowRate(env.AUTH_LIMITER, `oauth-token:${clientIpOf(request)}`))) {
				return oauthJson({ error: "slow_down", error_description: "Too many requests. Wait a minute and try again." }, 429);
			}
			return await handleToken(request, env);
		}
		if (path === "/oauth/revoke" && request.method === "POST") return await handleRevoke(request, env);
		if (path === "/oauth/register" && request.method === "POST") {
			if (!(await allowRate(env.AUTH_LIMITER, `oauth-register:${clientIpOf(request)}`))) {
				return oauthJson({ error: "slow_down", error_description: "Too many requests. Wait a minute and try again." }, 429);
			}
			return await handleRegister(request, env);
		}
		return oauthJson({ error: "not_found", error_description: "No such OAuth endpoint." }, 404);
	} catch (error) {
		if (error instanceof OAuthError || error?.name === "OAuthError") return errorJson(error);
		throw error;
	}
}
