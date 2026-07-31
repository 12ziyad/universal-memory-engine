import { newId } from "./lib/ids.js";

export const SESSION_COOKIE = "uml_session";
export const CONNECTION_TOKEN_PREFIX = "uml_live_";

const ENCODER = new TextEncoder();
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_ALG = "pbkdf2_sha256";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function now() {
	return Date.now();
}

function randomBytes(length) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64Url(bytes) {
	let raw = "";
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
	const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
	const raw = atob(padded);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function hex(bytes) {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equalBytes(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export function normalizeEmail(email) {
	return String(email ?? "").trim().toLowerCase();
}

export function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? ""));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
	const key = await crypto.subtle.importKey("raw", ENCODER.encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = await derivePassword(password, salt);
	const saltText = base64Url(salt);
	return {
		passwordHash: `${PASSWORD_ALG}$${PASSWORD_ITERATIONS}$${saltText}$${base64Url(hash)}`,
		passwordSalt: saltText,
	};
}

export async function verifyPassword(password, storedHash) {
	const parts = String(storedHash ?? "").split("$");
	if (parts.length !== 4 || parts[0] !== PASSWORD_ALG) return false;
	const iterations = Number(parts[1]);
	if (!Number.isFinite(iterations) || iterations < 10000) return false;
	const salt = fromBase64Url(parts[2]);
	const expected = fromBase64Url(parts[3]);
	const actual = await derivePassword(password, salt, iterations);
	return equalBytes(actual, expected);
}

export async function sha256Hex(value) {
	return hex(await crypto.subtle.digest("SHA-256", ENCODER.encode(String(value ?? ""))));
}

export async function timingSafeEqualString(a, b) {
	const left = await crypto.subtle.digest("SHA-256", ENCODER.encode(String(a ?? "")));
	const right = await crypto.subtle.digest("SHA-256", ENCODER.encode(String(b ?? "")));
	return equalBytes(new Uint8Array(left), new Uint8Array(right));
}

export function parseCookies(request) {
	const header = request.headers.get("cookie") || "";
	const cookies = new Map();
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index === -1) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name) cookies.set(name, decodeURIComponent(value));
	}
	return cookies;
}

function cookieBase(request) {
	const secure = new URL(request.url).protocol === "https:";
	return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(request) {
	return `${SESSION_COOKIE}=; ${cookieBase(request)}; Max-Age=0`;
}

function sessionCookie(request, token, expiresAt) {
	const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieBase(request)}; Max-Age=${maxAge}`;
}

function publicUser(row) {
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		name: row.name || "",
		role: row.role || "user",
		status: row.status || "active",
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		email_verified_at: row.email_verified_at ?? null,
	};
}

async function createSession(env, request, userId) {
	const token = base64Url(randomBytes(32));
	const sessionHash = await sha256Hex(token);
	const createdAt = now();
	const expiresAt = createdAt + SESSION_TTL_MS;
	const id = newId("sess");
	const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;
	const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
	const ipHash = ip ? await sha256Hex(ip) : null;
	await env.DB.prepare(
		`INSERT INTO sessions
			(id, user_id, session_hash, created_at, expires_at, last_seen_at, user_agent, ip_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, userId, sessionHash, createdAt, expiresAt, createdAt, userAgent, ipHash)
		.run();
	return { id, token, expiresAt, cookie: sessionCookie(request, token, expiresAt) };
}

export async function getSessionUser(env, request) {
	const token = parseCookies(request).get(SESSION_COOKIE);
	if (!token) return null;
	const sessionHash = await sha256Hex(token);
	const row = await env.DB.prepare(
		`SELECT
			s.id AS session_id, s.user_id, s.created_at AS session_created_at, s.expires_at,
			s.last_seen_at, s.revoked_at,
			u.id, u.email, u.name, u.role, u.status, u.created_at, u.updated_at, u.email_verified_at
		 FROM sessions s
		 JOIN users u ON u.id = s.user_id
		 WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND COALESCE(u.status, 'active') = 'active'
		 LIMIT 1`,
	)
		.bind(sessionHash, now())
		.first();
	if (!row) return null;
	await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now(), row.session_id).run();
	return {
		type: "session",
		userId: row.user_id,
		user: publicUser(row),
		session: {
			id: row.session_id,
			created_at: row.session_created_at,
			expires_at: row.expires_at,
			last_seen_at: row.last_seen_at,
		},
	};
}

function authValidation(body, { signup = false } = {}) {
	const email = normalizeEmail(body.email);
	const password = String(body.password ?? "");
	if (!isValidEmail(email)) return { error: "A valid email is required" };
	if (password.length < 8) return { error: "Password must be at least 8 characters" };
	if (signup && String(body.name ?? "").length > 120) return { error: "Name is too long" };
	return { email, password, name: String(body.name ?? "").trim().slice(0, 120) };
}

export async function signup(env, request, body) {
	const valid = authValidation(body, { signup: true });
	if (valid.error) return { error: valid.error, status: 400 };
	// Affirmative consent is required (a pre-ticked box is non-compliant); the
	// acceptance moment is recorded on the account.
	if (body.acceptTerms !== true) {
		return { error: "Please accept the Terms of Service and Privacy Policy to create an account.", status: 400 };
	}

	const existing = await env.DB.prepare("SELECT id FROM users WHERE email_normalized = ? LIMIT 1")
		.bind(valid.email)
		.first();
	if (existing) return { error: "Could not create account. Please try again.", status: 409 };

	const id = newId("user");
	const createdAt = now();
	const password = await hashPassword(valid.password);
	await env.DB.prepare(
		`INSERT INTO users
			(id, email, email_normalized, password_hash, password_salt, name, created_at, updated_at, status, role, terms_accepted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?)`,
	)
		.bind(id, valid.email, valid.email, password.passwordHash, password.passwordSalt, valid.name || null, createdAt, createdAt, createdAt)
		.run();
	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
	const session = await createSession(env, request, id);
	await recordLoginEvent(env, request, id, "signup");
	return { user: publicUser(user), session, status: 201 };
}

export async function login(env, request, body) {
	const valid = authValidation(body);
	if (valid.error) return { error: "Invalid email or password", status: 401 };
	const row = await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ? LIMIT 1")
		.bind(valid.email)
		.first();
	if (row && !row.password_hash && row.google_sub) {
		return { error: "This account uses Google sign-in. Use the Continue with Google button.", status: 400 };
	}
	if (!row || row.status === "disabled" || !(await verifyPassword(valid.password, row.password_hash))) {
		await recordLoginEvent(env, request, row?.id ?? null, "password_failed", valid.email);
		return { error: "Invalid email or password", status: 401 };
	}
	const session = await createSession(env, request, row.id);
	await recordLoginEvent(env, request, row.id, "password_login");
	return { user: publicUser(row), session, status: 200 };
}

// ---- Google sign-in --------------------------------------------------------
// Server-side OAuth code flow. The Google click doubles as password recovery:
// a Google account whose email matches an existing UML account logs into THAT
// account (linked by google_sub for stability). New emails create a Google-only
// account (password_hash NULL) with consent + verified email recorded.

const OAUTH_STATE_COOKIE = "uml_oauth_state";

function oauthStateCookie(request, value, maxAgeSeconds) {
	return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; ${cookieBase(request)}; Max-Age=${maxAgeSeconds}`;
}

export function googleAuthStart(env, request) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return { redirect: "/login?error=google_not_configured", cookie: null };
	}
	const state = base64Url(randomBytes(24));
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/auth/google/callback", request.url).toString());
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", state);
	url.searchParams.set("prompt", "select_account");
	return { redirect: url.toString(), cookie: oauthStateCookie(request, state, 600) };
}

function decodeIdTokenPayload(idToken) {
	try {
		const payload = String(idToken).split(".")[1] ?? "";
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
	} catch {
		return null;
	}
}

/**
 * Find-or-create the UML account for a Google profile. Priority: stable
 * google_sub match, then email link (records the sub + verified email), then a
 * fresh Google-only account with consent recorded (the sign-in button carries
 * the agreement notice).
 */
export async function resolveGoogleUser(env, profile) {
	const sub = String(profile?.sub ?? "").trim();
	const email = normalizeEmail(profile?.email);
	if (!sub || !isValidEmail(email)) return { error: "google_profile_invalid" };
	const verifiedAt = profile.email_verified ? now() : null;

	const bySub = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ? LIMIT 1").bind(sub).first();
	if (bySub) {
		if (bySub.status === "disabled") return { error: "account_disabled" };
		return { user: bySub, created: false };
	}

	const byEmail = await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ? LIMIT 1").bind(email).first();
	if (byEmail) {
		if (byEmail.status === "disabled") return { error: "account_disabled" };
		await env.DB.prepare(
			`UPDATE users SET google_sub = ?, updated_at = ?,
				email_verified_at = COALESCE(email_verified_at, ?),
				name = CASE WHEN COALESCE(name, '') = '' THEN ? ELSE name END
			 WHERE id = ?`,
		).bind(sub, now(), verifiedAt, String(profile.name ?? "").slice(0, 120) || null, byEmail.id).run();
		const linked = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(byEmail.id).first();
		return { user: linked, created: false };
	}

	const id = newId("user");
	const createdAt = now();
	await env.DB.prepare(
		`INSERT INTO users
			(id, email, email_normalized, password_hash, password_salt, name, created_at, updated_at,
			 status, role, terms_accepted_at, email_verified_at, google_sub)
		 VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'active', 'user', ?, ?, ?)`,
	).bind(id, email, email, String(profile.name ?? "").slice(0, 120) || null, createdAt, createdAt, createdAt, verifiedAt, sub).run();
	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
	return { user, created: true };
}

export async function googleAuthCallback(env, request) {
	const url = new URL(request.url);
	const clearState = oauthStateCookie(request, "", 0);
	if (url.searchParams.get("error")) return { redirect: "/login?error=google_denied", cookies: [clearState] };
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const expectedState = parseCookies(request).get(OAUTH_STATE_COOKIE);
	if (!code || !state || !expectedState || !(await timingSafeEqualString(state, expectedState))) {
		return { redirect: "/login?error=google_state", cookies: [clearState] };
	}
	let payload = null;
	try {
		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: env.GOOGLE_CLIENT_ID,
				client_secret: env.GOOGLE_CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: new URL("/auth/google/callback", request.url).toString(),
			}),
		});
		const token = await tokenRes.json().catch(() => ({}));
		if (!tokenRes.ok || !token.id_token) throw new Error(token.error ?? `token exchange failed (${tokenRes.status})`);
		// The id_token arrives directly from Google's token endpoint over TLS, so
		// its claims are trusted without a second signature verification step.
		payload = decodeIdTokenPayload(token.id_token);
	} catch (error) {
		console.warn("google token exchange failed:", error?.message ?? error);
		return { redirect: "/login?error=google_failed", cookies: [clearState] };
	}
	const resolved = await resolveGoogleUser(env, payload ?? {});
	if (resolved.error) {
		const reason = resolved.error === "account_disabled" ? "account_disabled" : "google_failed";
		return { redirect: `/login?error=${reason}`, cookies: [clearState] };
	}
	const session = await createSession(env, request, resolved.user.id);
	await recordLoginEvent(env, request, resolved.user.id, resolved.created ? "google_signup" : "google_login");
	return { redirect: "/?app=1", cookies: [clearState, session.cookie] };
}

async function recordLoginEvent(env, request, userId, outcome, email = null) {
	try {
		const ip = request.headers.get("cf-connecting-ip") ?? "";
		await env.DB.prepare(
			"INSERT INTO login_events (id, user_id, email_normalized, outcome, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
		).bind(newId("login"), userId, email, outcome, now(), ip ? await sha256Hex(ip) : null).run();
	} catch (error) {
		console.warn("login event record failed:", error?.message ?? error);
	}
}

export async function logout(env, request) {
	const token = parseCookies(request).get(SESSION_COOKIE);
	if (token) {
		const sessionHash = await sha256Hex(token);
		await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL")
			.bind(now(), sessionHash)
			.run();
	}
	return { ok: true, cookie: clearSessionCookie(request) };
}

export async function logoutAll(env, userId) {
	await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
		.bind(now(), userId)
		.run();
	return { ok: true };
}

export function publicToken(row) {
	const tail = String(row.token_prefix_tail ?? row.token_tail ?? "").slice(-4);
	return {
		id: row.id,
		label: row.label,
		type: row.type,
		token_prefix: row.token_prefix,
		masked_token: `${CONNECTION_TOKEN_PREFIX}********${tail || "...."}`,
		created_at: row.created_at,
		last_used_at: row.last_used_at ?? null,
		revoked_at: row.revoked_at ?? null,
		scopes: JSON.parse(row.scopes_json || "[]"),
		status: row.status || "active",
	};
}

export async function listConnectionTokens(env, userId) {
	const { results } = await env.DB.prepare(
		`SELECT id, label, type, token_prefix, token_tail, scopes_json, created_at, last_used_at, revoked_at, status
		 FROM connection_tokens
		 WHERE user_id = ?
		 ORDER BY created_at DESC`,
	)
		.bind(userId)
		.all();
	return (results ?? []).map(publicToken);
}

export async function createConnectionToken(env, userId, body = {}) {
	const type = ["mcp", "api"].includes(body.type) ? body.type : "api";
	const label = String(body.label ?? "").trim().slice(0, 80) || (type === "mcp" ? "MCP client" : "API client");
	const token = `${CONNECTION_TOKEN_PREFIX}${base64Url(randomBytes(32))}`;
	const tokenHash = await sha256Hex(token);
	const createdAt = now();
	const row = {
		id: newId("tok"),
		label,
		type,
		token_prefix: token.slice(0, 18),
		token_tail: token.slice(-4),
		scopes_json: JSON.stringify(Array.isArray(body.scopes) ? body.scopes : ["memory:read", "memory:write"]),
		created_at: createdAt,
		status: "active",
	};
	await env.DB.prepare(
		`INSERT INTO connection_tokens
			(id, user_id, label, token_hash, token_prefix, token_tail, type, created_at, scopes_json, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			row.id,
			userId,
			row.label,
			tokenHash,
			row.token_prefix,
			row.token_tail,
			row.type,
			row.created_at,
			row.scopes_json,
			row.status,
		)
		.run();
	return { token, tokenRecord: publicToken(row) };
}

export async function revokeConnectionToken(env, userId, tokenId) {
	const result = await env.DB.prepare(
		"UPDATE connection_tokens SET revoked_at = ?, status = 'revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
	)
		.bind(now(), tokenId, userId)
		.run();
	return { revoked: (result.meta?.changes ?? 0) > 0 };
}

export async function resolveConnectionToken(env, token, { allowedTypes = ["api", "mcp"] } = {}) {
	if (!String(token || "").startsWith(CONNECTION_TOKEN_PREFIX)) return null;
	const tokenHash = await sha256Hex(token);
	const row = await env.DB.prepare(
		`SELECT
			t.id AS token_id, t.user_id, t.label, t.type, t.scopes_json, t.status, t.revoked_at,
			u.id, u.email, u.name, u.role, u.status AS user_status, u.created_at, u.updated_at, u.email_verified_at
		 FROM connection_tokens t
		 JOIN users u ON u.id = t.user_id
		 WHERE t.token_hash = ? AND t.revoked_at IS NULL AND COALESCE(t.status, 'active') = 'active'
		   AND COALESCE(u.status, 'active') = 'active'
		 LIMIT 1`,
	)
		.bind(tokenHash)
		.first();
	if (!row || !allowedTypes.includes(row.type)) return null;
	await env.DB.prepare("UPDATE connection_tokens SET last_used_at = ? WHERE id = ?")
		.bind(now(), row.token_id)
		.run();
	return {
		type: "token",
		userId: row.user_id,
		user: publicUser({ ...row, status: row.user_status }),
		token: {
			id: row.token_id,
			label: row.label,
			type: row.type,
			scopes: JSON.parse(row.scopes_json || "[]"),
		},
	};
}
