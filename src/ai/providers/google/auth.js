/**
 * Worker → Google Cloud auth: service-account key in a Cloudflare secret,
 * RS256 JWT via WebCrypto, exchanged for a ~1h cloud-platform access token.
 *
 * Cache is ISOLATE-scoped and holds SERVICE identity only — nothing here may
 * ever take or derive from a per-user value. Single-flight so concurrent
 * requests in one isolate never stampede the token endpoint.
 *
 * HARD RULES: no key material, JWT, or access token may ever appear in a
 * thrown error, log line, meter record, or response. Errors carry HTTP status
 * and Google's error-code enum only.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REFRESH_MARGIN_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_PRIVATE_KEY_ID_CHARS = 256;

let cache = { token: null, expiresAtMs: 0 };
let inflight = null;
let cryptoKey = null;
let keyFingerprint = null;

export function invalidateToken() {
	cache = { token: null, expiresAtMs: 0 };
}

export function resetGoogleAuthForTests() {
	invalidateToken();
	inflight = null;
	cryptoKey = null;
	keyFingerprint = null;
}

function parseServiceAccount(env) {
	const raw = env?.GCP_SERVICE_ACCOUNT;
	if (!raw) throw authError("no_credentials", 0);
	try {
		const parsed = JSON.parse(raw);
		const privateKeyId = parsed.private_key_id;
		if (
			!parsed.client_email
			|| !parsed.private_key
			|| typeof privateKeyId !== "string"
			|| privateKeyId.trim().length === 0
			|| privateKeyId.length > MAX_PRIVATE_KEY_ID_CHARS
		) throw new Error("incomplete");
		// A service-account document is credential material, not transport
		// configuration. Never let a poisoned token_uri choose where the signed
		// assertion is sent or what audience it names.
		if (parsed.token_uri != null && parsed.token_uri !== TOKEN_URL) throw new Error("token_uri");
		return parsed;
	} catch {
		throw authError("invalid_credentials", 0);
	}
}

function authError(code, status) {
	// Enum-only message by construction.
	return Object.assign(new Error(`google auth ${code}`), {
		aiErrorClass: code === "no_credentials" || code === "invalid_credentials" ? "provider_misconfigured" : "auth_failed",
		googleStatus: code,
		status,
	});
}

function pemToDer(pem) {
	const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
	const bin = atob(body);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}

function b64url(bytes) {
	let bin = "";
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	for (const b of arr) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(sa) {
	// Re-import when the secret rotates (fingerprint = key id, never material).
	const fp = sa.private_key_id;
	if (cryptoKey && keyFingerprint === fp) return cryptoKey;
	cryptoKey = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(sa.private_key),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	keyFingerprint = fp;
	return cryptoKey;
}

async function mintToken(env, fetchImpl, now) {
	const sa = parseServiceAccount(env);
	const key = await importKey(sa);
	const iat = Math.floor(now / 1000) - 30; // 30s backdate absorbs clock skew
	const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
	const encoder = new TextEncoder();
	const unsigned = `${b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id })))}.${b64url(encoder.encode(JSON.stringify(claims)))}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
	const assertion = `${unsigned}.${b64url(signature)}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
	let res;
	try {
		res = await fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
			signal: controller.signal,
		});
	} catch (error) {
		throw Object.assign(new Error("google auth exchange_unreachable"), {
			aiErrorClass: String(error?.name ?? "").toLowerCase().includes("abort") ? "timeout" : "provider_unavailable",
			googleStatus: "exchange_unreachable",
			status: 0,
			name: String(error?.name ?? "").toLowerCase().includes("abort") ? "TimeoutError" : "Error",
		});
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) throw authError("exchange_rejected", res.status);
	const body = await res.json().catch(() => null);
	if (!body?.access_token) throw authError("exchange_malformed", res.status);
	return {
		token: body.access_token,
		expiresAtMs: now + Math.max(60, Number(body.expires_in ?? 3600)) * 1000,
	};
}

/** The bearer token for Vertex + Discovery Engine. `fetchImpl` is injectable
 * for tests; production passes nothing and gets globalThis.fetch. */
export async function getAccessToken(env, fetchImpl = fetch, now = Date.now()) {
	if (cache.token && cache.expiresAtMs - now > REFRESH_MARGIN_MS) return cache.token;
	inflight ??= mintToken(env, fetchImpl, now)
		.then((minted) => {
			cache = minted;
			return minted.token;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}
