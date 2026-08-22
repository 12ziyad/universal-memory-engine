/**
 * Google transport: fetch with a per-lane AbortController timeout, bounded
 * jittered retries for transient failures, one re-auth on 401, and enum-only
 * error typing. The repo's Workers AI path has platform bounds and no
 * transport retry; a raw fetch has neither, so this module brings both.
 *
 * Retry split: the transport retries only what is plausibly transient AND
 * identical-on-retry (429, 500, 503, 504, network) — at most 2 retries inside
 * one logical attempt. Everything else surfaces once, immediately: the job
 * layer already owns coarse retry, and llm.js owns semantic salvage.
 *
 * REDACTION IS STRUCTURAL: errors are built from enums and numbers only. The
 * request body, response body, prompt text and bearer token can never reach a
 * thrown error, a log line, or the meter.
 */

import { getAccessToken, invalidateToken } from "./auth.js";

const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 4_000;

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

function classOf(status, googleStatus) {
	if (status === 403 && /billing/i.test(String(googleStatus ?? ""))) return "billing";
	if (status === 429 && /RESOURCE_EXHAUSTED/i.test(String(googleStatus ?? "")) === false) return "rate_limited";
	return STATUS_CLASS[status] ?? (status >= 500 ? "provider_unavailable" : "provider_bad_request");
}

function typedError(status, googleStatus, aiErrorClass, retryable) {
	const error = new Error(`google ${aiErrorClass} status=${status}${googleStatus ? ` code=${googleStatus}` : ""}`);
	error.aiErrorClass = aiErrorClass;
	error.status = status;
	error.googleStatus = googleStatus ?? null;
	error.retryable = Boolean(retryable);
	if (aiErrorClass === "timeout") error.name = "TimeoutError"; // llm.js failureKind reads this
	return error;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
	const hinted = Number(retryAfterHeader);
	if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, BACKOFF_CAP_MS);
	const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
	return Math.floor(base / 2 + Math.random() * (base / 2)); // full jitter, bounded
}

/**
 * POST a JSON body. Returns parsed JSON. Throws typed errors only.
 * `deps.fetch` / `deps.now` are injectable for tests.
 */
export async function googleFetch(env, { url, body, timeoutMs }, deps = {}) {
	const fetchImpl = deps.fetch ?? fetch;
	let reauthed = false;
	let retries = 0;
	let attempt = 0;
	// The loop exits by return or typed throw; attempts are bounded by
	// MAX_TRANSIENT_RETRIES plus at most one re-auth.
	for (;;) {
		const token = await getAccessToken(env, fetchImpl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let res;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			clearTimeout(timer);
			const aborted = String(error?.name ?? "").toLowerCase().includes("abort");
			if (!aborted && retries < MAX_TRANSIENT_RETRIES) {
				retries += 1;
				await sleep(retryDelayMs(attempt++, null));
				continue;
			}
			throw typedError(0, aborted ? "deadline" : "network", aborted ? "timeout" : "provider_unavailable", !aborted);
		}
		clearTimeout(timer);

		if (res.ok) {
			const json = await res.json().catch(() => null);
			if (json == null) throw typedError(res.status, "malformed_body", "provider_bad_response", false);
			json.__retry_count = retries;
			return json;
		}

		// Google error envelope: read the STATUS ENUM only, drop everything else.
		let googleStatus = null;
		try {
			const errBody = await res.json();
			googleStatus = errBody?.error?.status ?? errBody?.error?.errors?.[0]?.reason ?? null;
		} catch {
			googleStatus = null;
		}

		if (res.status === 401 && !reauthed) {
			reauthed = true;
			invalidateToken();
			continue; // one re-mint, one retry
		}
		const transient = res.status === 429 || res.status === 500 || res.status === 503 || res.status === 504;
		if (transient && retries < MAX_TRANSIENT_RETRIES) {
			retries += 1;
			await sleep(retryDelayMs(attempt++, res.headers?.get?.("retry-after")));
			continue;
		}
		throw typedError(res.status, googleStatus, classOf(res.status, googleStatus), transient);
	}
}
