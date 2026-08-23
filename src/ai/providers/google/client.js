/**
 * Google transport: fetch with a per-lane AbortController timeout, bounded
 * jittered retries for transient failures, one re-auth on 401, and enum-only
 * error typing. The repo's Workers AI path has platform bounds and no
 * transport retry; a raw fetch has neither, so this module brings both.
 *
 * Retry split: the transport retries only explicit Google responses that are
 * documented as transient (429, 500, 503) — at most 2 retries inside one
 * logical attempt. Network failures, client deadlines, and gateway timeouts
 * are ambiguous for a POST: Google may already have accepted the work, so we
 * never replay them here. Everything else surfaces once, immediately.
 *
 * REDACTION IS STRUCTURAL: errors are built from enums and numbers only. The
 * request body, response body, prompt text and bearer token can never reach a
 * thrown error, a log line, or the meter.
 */

import { getAccessToken, invalidateToken } from "./auth.js";
import { assertGoogleApiUrl, googleProject } from "./models.js";

const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 32_000;
const GOOGLE_ENUM = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

const STATUS_CLASS = Object.freeze({
	400: "provider_bad_request",
	401: "auth_expired",
	403: "provider_misconfigured", // IAM / API enablement / billing-disabled
	404: "provider_bad_request",
	429: "rate_limited",
	500: "provider_unavailable",
	503: "provider_unavailable",
	504: "timeout",
});

function classOf(status, googleStatus, googleReason) {
	if (status === 403 && [googleStatus, googleReason].some((value) => /billing/i.test(String(value ?? "")))) return "billing";
	if (status === 429 && /RESOURCE_EXHAUSTED/i.test(String(googleStatus ?? "")) === false) return "rate_limited";
	return STATUS_CLASS[status] ?? (status >= 500 ? "provider_unavailable" : "provider_bad_request");
}

function enumValue(value) {
	return typeof value === "string" && GOOGLE_ENUM.test(value) ? value : null;
}

function errorEnums(body) {
	const envelope = body?.error;
	const googleStatus = enumValue(envelope?.status);
	const legacyReason = Array.isArray(envelope?.errors)
		? envelope.errors.map((entry) => enumValue(entry?.reason)).find(Boolean) ?? null
		: null;
	const detailReason = Array.isArray(envelope?.details)
		? envelope.details.map((entry) => enumValue(entry?.reason)).find(Boolean) ?? null
		: null;
	return { googleStatus, googleReason: legacyReason ?? detailReason };
}

function typedError(status, googleStatus, googleReason, aiErrorClass, retryable) {
	const error = new Error(`google ${aiErrorClass} status=${status}${googleStatus ? ` code=${googleStatus}` : ""}`);
	error.aiErrorClass = aiErrorClass;
	error.status = status;
	error.googleStatus = googleStatus ?? null;
	error.googleReason = googleReason ?? null;
	error.retryable = Boolean(retryable);
	if (aiErrorClass === "timeout") error.name = "TimeoutError"; // llm.js failureKind reads this
	return error;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value, now) {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function retryDelayMs(attempt, retryAfterHeader, { random = Math.random, now = Date.now } = {}) {
	const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
	const normal = Math.min(BACKOFF_CAP_MS, base + Math.floor(random() * base));
	const hinted = retryAfterMs(retryAfterHeader, now());
	// Never violate a server delay by clipping it and retrying early. A hint
	// above our bounded transport budget is handed back to the job layer.
	if (hinted != null && hinted > BACKOFF_CAP_MS) return null;
	return Math.max(normal, hinted ?? 0);
}

/**
 * POST a JSON body. Returns parsed JSON. Throws typed errors only.
 * `deps.fetch` / `deps.now` are injectable for tests.
 */
export async function googleFetch(env, { url, body, timeoutMs }, deps = {}) {
	const fetchImpl = deps.fetch ?? fetch;
	const sleepImpl = deps.sleep ?? sleep;
	const random = deps.random ?? Math.random;
	const now = deps.now ?? Date.now;
	let reauthed = false;
	let retries = 0;
	let attempt = 0;
	// Validate the full authority before minting an access token. This order is
	// deliberate: a poisoned binding must not receive even an OAuth exchange as
	// a side effect, much less an Authorization header on an attacker host.
	const endpoint = assertGoogleApiUrl(env, url);
	const quotaProject = googleProject(env);
	// The loop exits by return or typed throw; attempts are bounded by
	// MAX_TRANSIENT_RETRIES plus at most one re-auth.
	for (;;) {
		const token = await getAccessToken(env, fetchImpl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let res;
		try {
			res = await fetchImpl(endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"x-goog-user-project": quotaProject,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			clearTimeout(timer);
			const aborted = String(error?.name ?? "").toLowerCase().includes("abort");
			throw typedError(
				0,
				aborted ? "deadline" : "network",
				null,
				aborted ? "timeout" : "provider_unavailable",
				false,
			);
		}
		clearTimeout(timer);

		if (res.ok) {
			const json = await res.json().catch(() => null);
			if (json == null) throw typedError(res.status, "malformed_body", null, "provider_bad_response", false);
			json.__retry_count = retries;
			// Network/timeout outcomes are never replayed, so a successful response
			// can only follow explicit provider HTTP responses. Keep this invariant
			// visible to settlement code; ordinary 429/500/503 retries are not
			// ambiguous and must not be charged as extra completed generations.
			json.__ambiguous_retry_count = 0;
			return json;
		}

		// Google error envelope: read the STATUS ENUM only, drop everything else.
		let googleStatus = null;
		let googleReason = null;
		try {
			const errBody = await res.json();
			({ googleStatus, googleReason } = errorEnums(errBody));
		} catch {
			googleStatus = null;
			googleReason = null;
		}

		if (res.status === 401 && !reauthed) {
			reauthed = true;
			invalidateToken();
			continue; // one re-mint, one retry
		}
		const transient = res.status === 429 || res.status === 500 || res.status === 503;
		let retryable = transient;
		if (transient && retries < MAX_TRANSIENT_RETRIES) {
			const delay = retryDelayMs(attempt++, res.headers?.get?.("retry-after"), { random, now });
			if (delay != null) {
				retries += 1;
				await sleepImpl(delay);
				continue;
			}
			// A caller unaware of Retry-After could otherwise immediately replay
			// and violate the server's explicit minimum wait.
			retryable = false;
		}
		throw typedError(
			res.status,
			googleStatus,
			googleReason,
			classOf(res.status, googleStatus, googleReason),
			retryable,
		);
	}
}
