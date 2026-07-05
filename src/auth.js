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

	const existing = await env.DB.prepare("SELECT id FROM users WHERE email_normalized = ? LIMIT 1")
		.bind(valid.email)
		.first();
	if (existing) return { error: "Could not create account. Please try again.", status: 409 };

	const id = newId("user");
	const createdAt = now();
	const password = await hashPassword(valid.password);
	await env.DB.prepare(
		`INSERT INTO users
			(id, email, email_normalized, password_hash, password_salt, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'user')`,
	)
		.bind(id, valid.email, valid.email, password.passwordHash, password.passwordSalt, valid.name || null, createdAt, createdAt)
		.run();
	const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
	const session = await createSession(env, request, id);
	return { user: publicUser(user), session, status: 201 };
}

export async function login(env, request, body) {
	const valid = authValidation(body);
	if (valid.error) return { error: "Invalid email or password", status: 401 };
	const row = await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ? LIMIT 1")
		.bind(valid.email)
		.first();
	if (!row || row.status === "disabled" || !(await verifyPassword(valid.password, row.password_hash))) {
		return { error: "Invalid email or password", status: 401 };
	}
	const session = await createSession(env, request, row.id);
	return { user: publicUser(row), session, status: 200 };
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
