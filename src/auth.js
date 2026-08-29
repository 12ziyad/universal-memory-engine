import { newId } from "./lib/ids.js";
import { recordSecurityEvent } from "./lib/security_events.js";
import { wakeDormantAccount, VAULT_STATUS } from "./lib/account_vault.js";
import { stampEarlyAccess } from "./lib/ai_budget.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { resolveVerifiedIdentity } from "./lib/auth_identity.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./lib/audit.js";

export const SESSION_COOKIE = "uml_session";
// New tokens mint with the Itsuki prefix; tokens minted before the rebrand
// keep working forever — a rename must never break a user's integrations.
export const CONNECTION_TOKEN_PREFIX = "itsuki_live_";
export const ACCEPTED_TOKEN_PREFIXES = [CONNECTION_TOKEN_PREFIX, "uml_live_"];

const ENCODER = new TextEncoder();
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_ALG = "pbkdf2_sha256";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT = 50;
export const MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT = 200;

export class ConnectionTokenError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.name = "ConnectionTokenError";
		this.code = code;
		this.status = status;
	}
}

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

/**
 * One high-entropy URL-safe secret, generated the same way every other
 * credential in this file is. Exported so the OAuth lane mints codes and
 * tokens with the identical primitive rather than a second implementation.
 */
export function randomSecret(byteLength = 32) {
	return base64Url(randomBytes(byteLength));
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

export function publicUser(row) {
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

export async function createSession(env, request, userId) {
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

/**
 * Every sign-in door renders "By continuing, you agree to the Terms of
 * Service and Privacy Policy" beside its buttons, and the Terms state that
 * using the Service constitutes acceptance. So a successful sign-in IS an
 * acceptance event, and an account created before consent stamping existed
 * gets its stamp the next time its owner walks through a door — recorded at
 * the moment it actually happened, never fabricated retroactively.
 */
async function stampTermsAcceptance(env, user) {
	if (!user || user.terms_accepted_at) return;
	try {
		await env.DB.prepare(
			"UPDATE users SET terms_accepted_at = ?, updated_at = ? WHERE id = ? AND terms_accepted_at IS NULL",
		).bind(now(), now(), user.id).run();
		user.terms_accepted_at = now();
	} catch (error) {
		console.warn("terms acceptance stamp failed:", error?.message ?? error);
	}
}

/** Shared final door for every interactive identity provider. */
export async function issueAuthenticatedSession(env, request, userId, outcome, email = null) {
	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").bind(userId).first();
	if (!user) return { error: "account_not_found", status: 401 };
	if (user.status === "disabled") return { error: "account_disabled", status: 403 };
	// A vaulted account wakes the moment its owner proves they are back.
	await wakeDormantAccount(env, user, { via: outcome || "signin" });
	await stampTermsAcceptance(env, user);
	const session = await createSession(env, request, user.id);
	await recordLoginEvent(env, request, user.id, outcome, email);
	return { user: publicUser(user), session, status: 200 };
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
	await stampEarlyAccess(env, id, createdAt);
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
	await wakeDormantAccount(env, row, { via: "password_login" });
	await stampTermsAcceptance(env, row);
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
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
let googleRemoteJwks = null;

function oauthStateCookie(request, value, maxAgeSeconds) {
	return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; ${cookieBase(request)}; Max-Age=${maxAgeSeconds}`;
}

export function googleAuthStart(env, request) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return { redirect: "/login?error=google_not_configured", cookie: null };
	}
	const state = base64Url(randomBytes(24));
	const nonce = base64Url(randomBytes(24));
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/auth/google/callback", request.url).toString());
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", state);
	url.searchParams.set("nonce", nonce);
	url.searchParams.set("prompt", "select_account");
	return { redirect: url.toString(), cookie: oauthStateCookie(request, `${state}.${nonce}`, 600) };
}

/**
 * Verify the Google ID token cryptographically, including issuer, audience,
 * expiry and the browser-bound nonce.  A key resolver can be injected only
 * by focused tests; production always uses Google's published JWKS.
 */
export async function verifyGoogleIdToken(env, idToken, { nonce, keyResolver = null } = {}) {
	if (!env.GOOGLE_CLIENT_ID || !nonce) throw new Error("google_verification_not_configured");
	if (!googleRemoteJwks) googleRemoteJwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
	const { payload } = await jwtVerify(String(idToken ?? ""), keyResolver || googleRemoteJwks, {
		issuer: GOOGLE_ISSUERS,
		audience: env.GOOGLE_CLIENT_ID,
		algorithms: ["RS256"],
	});
	if (!(await timingSafeEqualString(payload.nonce, nonce))) throw new Error("google_nonce_mismatch");
	if (payload.email_verified !== true) throw new Error("google_email_unverified");
	return payload;
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
	if (profile.email_verified !== true) return { error: "google_email_unverified" };
	return resolveVerifiedIdentity(env, {
		provider: "google",
		subject: sub,
		email,
		name: profile.name,
		verifiedAt: now(),
	});
}

export async function googleAuthCallback(env, request) {
	const url = new URL(request.url);
	const clearState = oauthStateCookie(request, "", 0);
	if (url.searchParams.get("error")) return { redirect: "/login?error=google_denied", cookies: [clearState] };
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const stateEnvelope = parseCookies(request).get(OAUTH_STATE_COOKIE) || "";
	const separator = stateEnvelope.indexOf(".");
	const expectedState = separator > 0 ? stateEnvelope.slice(0, separator) : "";
	const nonce = separator > 0 ? stateEnvelope.slice(separator + 1) : "";
	if (!code || !state || !expectedState || !nonce || !(await timingSafeEqualString(state, expectedState))) {
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
		payload = await verifyGoogleIdToken(env, token.id_token, { nonce });
	} catch (error) {
		console.warn("google token exchange failed:", error?.message ?? error);
		return { redirect: "/login?error=google_failed", cookies: [clearState] };
	}
	const resolved = await resolveGoogleUser(env, payload ?? {});
	if (resolved.error) {
		const reason = resolved.error === "account_disabled" ? "account_disabled" : "google_failed";
		return { redirect: `/login?error=${reason}`, cookies: [clearState] };
	}
	const authenticated = await issueAuthenticatedSession(
		env,
		request,
		resolved.user.id,
		resolved.created ? "google_signup" : "google_login",
	);
	if (authenticated.error) {
		return { redirect: `/login?error=${authenticated.error}`, cookies: [clearState] };
	}
	return { redirect: "/?app=1", cookies: [clearState, authenticated.session.cookie] };
}

export async function recordLoginEvent(env, request, userId, outcome, email = null) {
	try {
		const ip = request.headers.get("cf-connecting-ip") ?? "";
		const ipHash = ip ? await sha256Hex(ip) : null;
		const at = now();
		await env.DB.prepare(
			"INSERT INTO login_events (id, user_id, email_normalized, outcome, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
		).bind(newId("login"), userId, email, outcome, at, ipHash).run();
		// Ten failed passwords from one address inside fifteen minutes is a
		// credential-stuffing shape, not a fat finger. The event dedupes per
		// ip-hash prefix and escalates with volume; only the truncated hash
		// ever leaves this function.
		if (outcome === "password_failed" && ipHash) {
			const windowMs = 15 * 60 * 1000;
			const burst = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM login_events WHERE outcome = 'password_failed' AND ip_hash = ? AND created_at > ?",
			).bind(ipHash, at - windowMs).first("n");
			if (Number(burst ?? 0) >= 10) {
				await recordSecurityEvent(env, {
					kind: "login_failed_burst",
					severity: "high",
					groupKey: `login_failed_burst:${ipHash.slice(0, 12)}`,
					details: { ip_hash_prefix: ipHash.slice(0, 12), count: Number(burst), window_ms: windowMs, threshold: 10 },
				});
			}
		}
	} catch (error) {
		console.warn("login event record failed:", error?.message ?? error);
	}
}

/**
 * Change (or, for Google-only accounts, set) the password while logged in.
 * The active session proves identity; existing passwords must be re-entered.
 */
export async function changePassword(env, request, body, options = {}) {
	const auditIntent = options?.auditIntent ?? null;
	const auth = await getSessionUser(env, request);
	if (!auth) {
		const result = { error: "unauthorized", status: 401 };
		return auditIntent ? commitAuditedNoop(env, auditIntent, result) : result;
	}
	const newPassword = String(body?.newPassword ?? "");
	if (newPassword.length < 8) {
		const result = { error: "New password must be at least 8 characters", status: 400 };
		return auditIntent ? commitAuditedNoop(env, auditIntent, result) : result;
	}
	const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(auth.userId).first();
	if (!row) {
		const result = { error: "unauthorized", status: 401 };
		return auditIntent ? commitAuditedNoop(env, auditIntent, result) : result;
	}
	if (row.password_hash && !(await verifyPassword(String(body?.currentPassword ?? ""), row.password_hash))) {
		const result = { error: "Current password is incorrect", status: 400 };
		return auditIntent ? commitAuditedNoop(env, auditIntent, result) : result;
	}
	const password = await hashPassword(newPassword);
	const updatedAt = Math.max(now(), Number(row.updated_at ?? 0) + 1);
	const statement = env.DB.prepare(
		"UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ? AND password_hash IS ? AND updated_at IS ?",
	).bind(password.passwordHash, password.passwordSalt, updatedAt, row.id, row.password_hash ?? null, row.updated_at ?? null);
	if (auditIntent) {
		await commitAuditedBatch(env, auditIntent, [statement], {
			preconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM users WHERE id = ? AND status = 'active' AND password_hash IS ? AND updated_at IS ?",
				[row.id, row.password_hash ?? null, row.updated_at ?? null],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND updated_at = ?",
				[row.id, password.passwordHash, updatedAt],
			)],
		});
	} else {
		const updated = await statement.run();
		if (Number(updated?.meta?.changes ?? 0) !== 1) {
			return { error: "Account changed. Reload and try again.", status: 409 };
		}
	}
	await recordLoginEvent(env, request, row.id, row.password_hash ? "password_changed" : "password_set");
	const result = { ok: true, status: 200 };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
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

export async function logoutAll(env, userId, { auditIntent = null } = {}) {
	const revokedAt = now();
	const statement = env.DB.prepare(
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
	).bind(revokedAt, userId);
	if (auditIntent) {
		await commitAuditedBatch(env, auditIntent, [statement], {
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at IS NULL)",
				[userId],
			)],
		});
	} else {
		await statement.run();
	}
	const result = { ok: true, revoked_at: revokedAt };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

export function publicToken(row) {
	const tail = String(row.token_prefix_tail ?? row.token_tail ?? "").slice(-4);
	return {
		id: row.id,
		project_id: row.project_id ?? null,
		label: row.label,
		type: row.type,
		token_prefix: row.token_prefix,
		masked_token: `${CONNECTION_TOKEN_PREFIX}********${tail || "...."}`,
		created_at: row.created_at,
		last_used_at: row.last_used_at ?? null,
		revoked_at: row.revoked_at ?? null,
		scopes: JSON.parse(row.scopes_json || "[]"),
		status: row.status || "active",
		owner: row.owner_user_id ? {
			user_id: String(row.owner_user_id).slice(0, 100),
			name: String(row.owner_name ?? "").trim().slice(0, 120) || null,
			email: String(row.owner_email ?? "").trim().toLocaleLowerCase("en-US").slice(0, 254) || null,
		} : null,
	};
}

export async function listConnectionTokens(env, userId, options = {}) {
	const scoped = Object.prototype.hasOwnProperty.call(options, "projectId");
	const requestedLimit = Number(options.limit ?? MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT);
	const limit = Math.max(1, Math.min(MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT, Number.isFinite(requestedLimit)
		? Math.floor(requestedLimit)
		: MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT));
	const columns = `t.id, t.project_id, t.label, t.type, t.token_prefix, t.token_tail,
		t.scopes_json, t.created_at, t.last_used_at, t.revoked_at, t.status,
		t.user_id AS owner_user_id, u.name AS owner_name, u.email AS owner_email`;
	const statement = !scoped
		? env.DB.prepare(
			`SELECT ${columns} FROM connection_tokens t
			 LEFT JOIN users u ON u.id = t.user_id
			 WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ?`,
		)
			.bind(userId, limit)
		: options.isDefault
			? env.DB.prepare(
				`SELECT ${columns} FROM connection_tokens t
				 LEFT JOIN users u ON u.id = t.user_id
				 WHERE t.project_id = ? OR (t.project_id IS NULL AND t.user_id = ?)
				 ORDER BY t.created_at DESC LIMIT ?`,
			).bind(options.projectId, userId, limit)
			: env.DB.prepare(
			`SELECT ${columns} FROM connection_tokens t
			 LEFT JOIN users u ON u.id = t.user_id
			 WHERE t.project_id = ?
			 ORDER BY t.created_at DESC LIMIT ?`,
		).bind(options.projectId, limit);
	const { results } = await statement.all();
	return (results ?? []).map(publicToken);
}

export async function createConnectionToken(env, userId, body = {}, options = {}) {
	const projectScoped = Object.prototype.hasOwnProperty.call(options, "projectId");
	if (projectScoped && !options.projectId) throw new ConnectionTokenError("project_required", "Choose a project before creating a key.", 400);
	const auditIntent = options.auditIntent ?? null;
	const includeHistoricalDefault = options.isDefault === true;
	const type = ["mcp", "api"].includes(body.type) ? body.type : "api";
	const label = String(body.label ?? "").trim().slice(0, 80) || (type === "mcp" ? "MCP client" : "API client");
	const token = `${CONNECTION_TOKEN_PREFIX}${base64Url(randomBytes(32))}`;
	const tokenHash = await sha256Hex(token);
	const createdAt = now();
	const row = {
		id: newId("tok"),
		project_id: options.projectId ?? null,
		label,
		type,
		token_prefix: token.slice(0, 18),
		token_tail: token.slice(-4),
		scopes_json: JSON.stringify(Array.isArray(body.scopes) ? body.scopes : ["memory:read", "memory:write"]),
		// SDK keys may carry their own memory rules; they sit between the
		// account's rules and any per-request override.
		rules_json: body.rules && typeof body.rules === "object" ? JSON.stringify(body.rules) : null,
		created_at: createdAt,
		status: "active",
	};
	const statement = projectScoped ? env.DB.prepare(
		`INSERT INTO connection_tokens
			(id, user_id, project_id, label, token_hash, token_prefix, token_tail, type, created_at, scopes_json, status, rules_json)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		  WHERE (SELECT COUNT(*) FROM connection_tokens
		          WHERE (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?))
		            AND status = 'active' AND revoked_at IS NULL) < ?
		    AND (SELECT COUNT(*) FROM connection_tokens
		          WHERE project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)) < ?`,
	)
		.bind(
			row.id,
			userId,
			row.project_id,
			row.label,
			tokenHash,
			row.token_prefix,
			row.token_tail,
			row.type,
			row.created_at,
			row.scopes_json,
			row.status,
			row.rules_json,
			row.project_id,
			includeHistoricalDefault ? 1 : 0,
			userId,
			MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT,
			row.project_id,
			includeHistoricalDefault ? 1 : 0,
			userId,
			MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT,
		)
		: env.DB.prepare(
			`INSERT INTO connection_tokens
			 (id, user_id, project_id, label, token_hash, token_prefix, token_tail, type, created_at, scopes_json, status, rules_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			row.id, userId, null, row.label, tokenHash, row.token_prefix, row.token_tail,
			row.type, row.created_at, row.scopes_json, row.status, row.rules_json,
		);
	let result;
	try {
		if (auditIntent && projectScoped) {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					`SELECT 1 WHERE
					 (SELECT COUNT(*) FROM connection_tokens
					   WHERE (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?))
					     AND status = 'active' AND revoked_at IS NULL) < ?
					 AND (SELECT COUNT(*) FROM connection_tokens
					   WHERE project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)) < ?`,
					[row.project_id, includeHistoricalDefault ? 1 : 0, userId,
						MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT,
						row.project_id, includeHistoricalDefault ? 1 : 0, userId,
						MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM connection_tokens WHERE id = ? AND project_id = ? AND status = 'active' AND revoked_at IS NULL",
					[row.id, row.project_id],
				)],
				commitDetails: { targetId: row.id },
			});
		} else result = await statement.run();
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const count = await env.DB.prepare(
				`SELECT COUNT(*) AS total,
				        SUM(CASE WHEN status = 'active' AND revoked_at IS NULL THEN 1 ELSE 0 END) AS active
				   FROM connection_tokens
				  WHERE project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)`,
			).bind(row.project_id, includeHistoricalDefault ? 1 : 0, userId).first();
			if (Number(count?.total ?? 0) >= MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT) {
				throw new ConnectionTokenError(
					"credential_history_limit_reached",
					`A project can retain at most ${MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT} key records. Delete a revoked key before creating another.`,
					409,
				);
			}
			if (Number(count?.active ?? 0) >= MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT) {
				throw new ConnectionTokenError(
					"credential_limit_reached",
					`A project can have at most ${MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT} active keys. Delete one before creating another.`,
					409,
				);
			}
		}
		throw error;
	}
	if (Number(result?.meta?.changes ?? 0) !== 1) {
		const total = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM connection_tokens
			  WHERE project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)`,
		).bind(row.project_id, includeHistoricalDefault ? 1 : 0, userId).first();
		if (Number(total?.n ?? 0) >= MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT) {
			throw new ConnectionTokenError(
				"credential_history_limit_reached",
				`A project can retain at most ${MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT} key records. Delete a revoked key before creating another.`,
				409,
			);
		}
		throw new ConnectionTokenError(
			"credential_limit_reached",
			`A project can have at most ${MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT} active keys. Delete one before creating another.`,
			409,
		);
	}
	const created = { token, tokenRecord: publicToken(row) };
	return auditIntent ? auditedMutationResult(created, auditIntent) : created;
}

export async function revokeConnectionToken(env, userId, tokenId, options = {}) {
	const auditIntent = options.auditIntent ?? null;
	const scoped = Object.prototype.hasOwnProperty.call(options, "projectId");
	const statement = !scoped
		? env.DB.prepare(
			"UPDATE connection_tokens SET revoked_at = ?, status = 'revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
		).bind(now(), tokenId, userId)
		: options.isDefault
			? env.DB.prepare(
				`UPDATE connection_tokens SET revoked_at = ?, status = 'revoked'
				  WHERE id = ? AND (project_id = ? OR (project_id IS NULL AND user_id = ?)) AND revoked_at IS NULL`,
			).bind(now(), tokenId, options.projectId, userId)
			: env.DB.prepare(
			"UPDATE connection_tokens SET revoked_at = ?, status = 'revoked' WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
		).bind(now(), tokenId, options.projectId);
	const visible = scoped ? await env.DB.prepare(
		`SELECT status, revoked_at FROM connection_tokens
		  WHERE id = ? AND (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)) LIMIT 1`,
	).bind(tokenId, options.projectId, options.isDefault ? 1 : 0, userId).first() : null;
	if (scoped && (!visible || visible.revoked_at !== null || visible.status !== "active")) {
		const unchanged = { revoked: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	let result;
	if (auditIntent) {
		[result] = await commitAuditedBatch(env, auditIntent, [statement], {
			postconditions: [auditInvariantStatement(
				env,
				`SELECT 1 FROM connection_tokens
				  WHERE id = ? AND (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?))
				    AND status = 'revoked' AND revoked_at IS NOT NULL`,
				[tokenId, options.projectId, options.isDefault ? 1 : 0, userId],
			)],
		});
	} else result = await statement.run();
	const revoked = { revoked: Number(result.meta?.changes ?? 0) > 0 };
	return auditIntent ? auditedMutationResult(revoked, auditIntent) : revoked;
}

/**
 * Delete a key outright. Revoking kept the row so the list could show what had
 * existed; the product now offers one action instead, and a deleted key leaves
 * no row. Either way the secret stops working immediately — resolveConnectionToken
 * matches on the hash, and there is nothing left to match.
 */
export async function deleteConnectionToken(env, userId, tokenId, options = {}) {
	const auditIntent = options.auditIntent ?? null;
	const scoped = Object.prototype.hasOwnProperty.call(options, "projectId");
	const statement = !scoped
		? env.DB.prepare("DELETE FROM connection_tokens WHERE id = ? AND user_id = ?")
			.bind(tokenId, userId)
		: options.isDefault
			? env.DB.prepare(
				"DELETE FROM connection_tokens WHERE id = ? AND (project_id = ? OR (project_id IS NULL AND user_id = ?))",
			).bind(tokenId, options.projectId, userId)
			: env.DB.prepare(
			"DELETE FROM connection_tokens WHERE id = ? AND project_id = ?",
		).bind(tokenId, options.projectId);
	const visible = scoped ? await env.DB.prepare(
		`SELECT 1 FROM connection_tokens
		  WHERE id = ? AND (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?)) LIMIT 1`,
	).bind(tokenId, options.projectId, options.isDefault ? 1 : 0, userId).first() : null;
	if (scoped && !visible) {
		const unchanged = { deleted: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	let result;
	if (auditIntent) {
		[result] = await commitAuditedBatch(env, auditIntent, [statement], {
			postconditions: [auditInvariantStatement(
				env,
				`SELECT 1 WHERE NOT EXISTS (
				 SELECT 1 FROM connection_tokens
				  WHERE id = ? AND (project_id = ? OR (? = 1 AND project_id IS NULL AND user_id = ?))
				)`,
				[tokenId, options.projectId, options.isDefault ? 1 : 0, userId],
			)],
		});
	} else result = await statement.run();
	const deleted = { deleted: Number(result.meta?.changes ?? 0) > 0 };
	return auditIntent ? auditedMutationResult(deleted, auditIntent) : deleted;
}

export async function resolveConnectionToken(env, token, { allowedTypes = ["api", "mcp"] } = {}) {
	if (!ACCEPTED_TOKEN_PREFIXES.some((prefix) => String(token || "").startsWith(prefix))) return null;
	const tokenHash = await sha256Hex(token);
	const row = await env.DB.prepare(
		`SELECT
			t.id AS token_id, t.user_id, t.project_id, t.label, t.type, t.scopes_json, t.status, t.revoked_at, t.rules_json,
			u.id, u.email, u.name, u.role, u.status AS user_status, u.created_at, u.updated_at, u.email_verified_at
		 FROM connection_tokens t
		 JOIN users u ON u.id = t.user_id
		 WHERE t.token_hash = ? AND t.revoked_at IS NULL AND COALESCE(t.status, 'active') = 'active'
		   AND COALESCE(u.status, 'active') IN ('active', 'dormant')
		 LIMIT 1`,
	)
		.bind(tokenHash)
		.first();
	if (!row || !allowedTypes.includes(row.type)) return null;
	// Using an API/MCP key is proof the account is in use, so it wakes the
	// vault too. Without this a shelved account's integrations would fail
	// silently with no door that could ever bring them back.
	if (row.user_status === VAULT_STATUS) {
		await wakeDormantAccount(env, { id: row.user_id, status: VAULT_STATUS }, { via: "api_key" });
		row.user_status = "active";
	}
	await env.DB.prepare("UPDATE connection_tokens SET last_used_at = ? WHERE id = ?")
		.bind(now(), row.token_id)
		.run();
	return {
		type: "token",
		userId: row.user_id,
		user: publicUser({ ...row, status: row.user_status }),
		token: {
			id: row.token_id,
			projectId: row.project_id ?? null,
			label: row.label,
			type: row.type,
			scopes: JSON.parse(row.scopes_json || "[]"),
			rules: (() => { try { return row.rules_json ? JSON.parse(row.rules_json) : null; } catch { return null; } })(),
		},
	};
}
