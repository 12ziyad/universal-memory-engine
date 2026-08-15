/**
 * Itsuki JavaScript SDK — a thin, dependency-free client for the Itsuki
 * memory API. Node 18+ (built-in fetch).
 *
 * Keep API keys on the server. Do not embed a long-lived key in browser code.
 */

import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://itsuki.app";
export const VERSION = "0.2.1";

const MAX_TIMER_MS = 2_147_483_647;
const TERMINAL_JOB_STATUSES = new Set(["enriched", "failed", "completed"]);
const JOB_STATUSES = new Set(["queued", "staged", "processing", ...TERMINAL_JOB_STATUSES]);
const USAGE_RANGES = new Set(["1d", "7d", "30d", "all"]);

export class MemoryAPIError extends Error {
	constructor(message, { status = 0, code = null, body = null, retryAfterMs = null, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "MemoryAPIError";
		this.status = status;
		this.code = code;
		this.body = body;
		this.retryAfterMs = retryAfterMs;
	}
}

function invalidArgument(message) {
	return new MemoryAPIError(message, { code: "invalid_argument" });
}

function requireNonEmptyString(value, name) {
	if (typeof value !== "string" || !value.trim()) {
		throw invalidArgument(`${name} must be a non-empty string`);
	}
	return value;
}

function requireIdentifier(value, name) {
	requireNonEmptyString(value, name);
	if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
		throw invalidArgument(`${name} must not have surrounding whitespace or control characters`);
	}
	return value;
}

function optionalUserId(value, name = "userId") {
	if (value == null) return null;
	return requireIdentifier(value, name);
}

function requireFiniteNumber(value, name, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
	if (
		typeof value !== "number"
		|| !Number.isFinite(value)
		|| value < min
		|| value > max
		|| (integer && !Number.isSafeInteger(value))
	) {
		const qualifier = integer ? "safe integer" : "finite number";
		const upperBound = Number.isFinite(max) ? ` and no greater than ${max}` : "";
		throw invalidArgument(`${name} must be a ${qualifier} greater than or equal to ${min}${upperBound}`);
	}
	return value;
}

function asOptions(value, label, allowed = null) {
	if (value == null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw invalidArgument(`${label} must be an object`);
	}
	if (allowed) {
		const unknown = Object.keys(value).find((key) => !allowed.includes(key));
		if (unknown) throw invalidArgument(`${label}.${unknown} is not supported`);
	}
	return value;
}

function rejectReservedOptions(options, label, reserved) {
	const key = reserved.find((name) => Object.prototype.hasOwnProperty.call(options, name));
	if (key) throw invalidArgument(`${label}.${key} is set by the method argument`);
}

function requireMessages(value, name, { allowEmpty = true } = {}) {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		throw invalidArgument(`${name} must be ${allowEmpty ? "an array" : "a non-empty array"}`);
	}
	return value;
}

function retryAfterMilliseconds(headers) {
	const raw = headers.get("retry-after");
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function errorMessage(data, method, path, status) {
	if (typeof data?.message === "string" && data.message) return data.message;
	if (typeof data?.error === "string" && data.error) return data.error;
	return `${method} ${path} failed with ${status}`;
}

function errorCode(data) {
	if (typeof data?.code === "string" && data.code) return data.code;
	if (typeof data?.error === "string" && data.error) return data.error;
	return null;
}

export class MemoryClient {
	/**
	 * @param {object} options
	 * @param {string} options.apiKey - itsuki_live_… Bearer key (legacy uml_live_ keys also work).
	 * @param {string} [options.baseUrl] - deployment origin.
	 * @param {string|null} [options.userId] - default isolated end-user memory space.
	 * @param {number} [options.timeoutMs] - total budget for one request and its retries.
	 * @param {number} [options.maxRetries] - retries for GETs and idempotent writes.
	 */
	constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, userId = null, timeoutMs = 30000, maxRetries = 2 } = {}) {
		this.apiKey = requireIdentifier(apiKey, "apiKey");

		let parsedBaseUrl;
		try {
			parsedBaseUrl = new URL(requireIdentifier(baseUrl, "baseUrl"));
		} catch (error) {
			if (error instanceof MemoryAPIError) throw error;
			throw invalidArgument("baseUrl must be a valid HTTP or HTTPS URL");
		}
		const hostname = parsedBaseUrl.hostname.toLowerCase();
		const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostname);
		const loopbackHttp = parsedBaseUrl.protocol === "http:"
			&& (ipv4Loopback || ["localhost", "[::1]", "::1"].includes(hostname));
		if (parsedBaseUrl.protocol !== "https:" && !loopbackHttp) {
			throw invalidArgument("baseUrl must use HTTPS except for loopback development");
		}
		if (
			parsedBaseUrl.username
			|| parsedBaseUrl.password
			|| parsedBaseUrl.pathname !== "/"
			|| parsedBaseUrl.search
			|| parsedBaseUrl.hash
		) {
			throw invalidArgument("baseUrl must not contain credentials, a path, a query string, or a fragment");
		}

		this.baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
		this.userId = optionalUserId(userId);
		this.timeoutMs = requireFiniteNumber(timeoutMs, "timeoutMs", { min: 1, max: MAX_TIMER_MS });
		this.maxRetries = requireFiniteNumber(maxRetries, "maxRetries", { min: 0, max: 10, integer: true });
	}

	/** Save one durable fact. Returns the write receipt. */
	add(content, opts = {}) {
		const options = asOptions(opts, "add options");
		rejectReservedOptions(options, "add options", ["content", "messages", "mode"]);
		return this.#post("/v1/save", { ...options, content: requireNonEmptyString(content, "content") });
	}

	save(content, opts = {}) {
		return this.add(content, opts);
	}

	/** Save a conversation (messages oldest first). */
	addConversation(messages, opts = {}) {
		const options = asOptions(opts, "addConversation options");
		rejectReservedOptions(options, "addConversation options", ["content", "messages", "mode"]);
		return this.#post("/v1/save", {
			...options,
			mode: "conversation",
			messages: requireMessages(messages, "messages", { allowEmpty: false }),
		});
	}

	/** Look up relevant memory. `context` on the result is prompt-ready. */
	search(query, opts = {}) {
		const options = asOptions(opts, "search options");
		rejectReservedOptions(options, "search options", ["query"]);
		return this.#post("/v1/recall", { ...options, query: requireNonEmptyString(query, "query") });
	}

	recall(query, opts = {}) {
		return this.search(query, opts);
	}

	/** Recall + auto-capture in one call. */
	turn(messages, opts = {}) {
		const options = asOptions(opts, "turn options");
		rejectReservedOptions(options, "turn options", ["messages"]);
		requireMessages(messages, "messages");
		if (messages.length === 0 && (typeof options.query !== "string" || !options.query.trim())) {
			throw invalidArgument("turn needs at least one message or a non-empty options.query");
		}
		return this.#post("/v1/turn", { ...options, messages });
	}

	/** Bulk ingestion; an empty list with `flush: true` may flush held context. */
	ingest(messages, opts = {}) {
		const options = asOptions(opts, "ingest options");
		rejectReservedOptions(options, "ingest options", ["messages"]);
		return this.#post("/v1/ingest", { ...options, messages: requireMessages(messages, "messages") });
	}

	graph(opts = {}) {
		const { userId } = asOptions(opts, "graph options", ["userId"]);
		return this.#get("/v1/graph", { userId });
	}

	status(opts = {}) {
		const { userId } = asOptions(opts, "status options", ["userId"]);
		return this.#get("/v1/status", { userId });
	}

	receipts(opts = {}) {
		const { limit = 50, userId } = asOptions(opts, "receipts options", ["limit", "userId"]);
		requireFiniteNumber(limit, "limit", { min: 1, integer: true });
		return this.#get("/v1/receipts", { userId, query: { limit } });
	}

	usage(opts = {}) {
		const { range = "30d", userId } = asOptions(opts, "usage options", ["range", "userId"]);
		if (!USAGE_RANGES.has(range)) throw invalidArgument("range must be one of: 1d, 7d, 30d, all");
		return this.#get("/v1/usage", { userId, query: { range } });
	}

	getRules(opts = {}) {
		const { userId } = asOptions(opts, "getRules options", ["userId"]);
		return this.#get("/v1/rules", { userId });
	}

	setRules(rules, opts = {}) {
		if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
			throw invalidArgument("rules must be an object");
		}
		const { userId } = asOptions(opts, "setRules options", ["userId"]);
		return this.#request("PUT", "/v1/rules", this.#withUserId({ rules, userId }));
	}

	exportAll(opts = {}) {
		const { userId } = asOptions(opts, "exportAll options", ["userId"]);
		return this.#get("/v1/export", { userId });
	}

	/** A fresh idempotency key for retry-safe writes. */
	static newIdempotencyKey() {
		return `idem_${randomUUID()}`;
	}

	newIdempotencyKey() {
		return MemoryClient.newIdempotencyKey();
	}

	/** Delete one memory object (node_… / page_… / slice_… / candidate id). */
	delete(memoryId, opts = {}) {
		const { userId } = asOptions(opts, "delete options", ["userId"]);
		return this.#request(
			"DELETE",
			`/v1/memories/${encodeURIComponent(requireIdentifier(memoryId, "memoryId"))}`,
			undefined,
			{ userId },
		);
	}

	/**
	 * Bulk delete by source lane and/or time window. Safe by default: without
	 * `confirm: true`, the server returns only what would be deleted.
	 */
	deleteBySource(opts = {}) {
		const { source, before, after, confirm = false, userId } = asOptions(
			opts,
			"deleteBySource options",
			["source", "before", "after", "confirm", "userId"],
		);
		if (source != null) requireIdentifier(source, "source");
		if (before != null) requireFiniteNumber(before, "before", { min: 1 });
		if (after != null) requireFiniteNumber(after, "after", { min: 1 });
		if (typeof confirm !== "boolean") throw invalidArgument("confirm must be a boolean");
		return this.#request("DELETE", "/v1/memories", undefined, {
			userId,
			query: { source, before, after, ...(confirm ? { confirm: "true", dry_run: "false" } : {}) },
		});
	}

	/** Background-processing status for one accepted write. */
	packetStatus(sourcePacketId, opts = {}) {
		const { userId } = asOptions(opts, "packetStatus options", ["userId"]);
		return this.#get(
			`/v1/packets/${encodeURIComponent(requireIdentifier(sourcePacketId, "sourcePacketId"))}/status`,
			{ userId },
		);
	}

	/** List accepted background jobs. */
	jobs(opts = {}) {
		const { status, since, limit, userId } = asOptions(
			opts,
			"jobs options",
			["status", "since", "limit", "userId"],
		);
		if (status != null && !JOB_STATUSES.has(status)) {
			throw invalidArgument(`status must be one of: ${[...JOB_STATUSES].join(", ")}`);
		}
		if (since != null) requireFiniteNumber(since, "since", { min: 1 });
		if (limit != null) requireFiniteNumber(limit, "limit", { min: 1, integer: true });
		return this.#get("/v1/jobs", { userId, query: { status, since, limit } });
	}

	/**
	 * Poll packet status until `enriched`, `failed`, or legacy `completed`.
	 * A polling timeout returns the last response with `timed_out: true`.
	 */
	async waitFor(sourcePacketId, opts = {}) {
		const { timeoutMs = 60000, intervalMs = 1500, userId } = asOptions(
			opts,
			"waitFor options",
			["timeoutMs", "intervalMs", "userId"],
		);
		requireIdentifier(sourcePacketId, "sourcePacketId");
		requireFiniteNumber(timeoutMs, "timeoutMs", { min: 0, max: MAX_TIMER_MS });
		requireFiniteNumber(intervalMs, "intervalMs", { min: 0, max: MAX_TIMER_MS });
		if (intervalMs === 0) throw invalidArgument("intervalMs must be greater than zero");

		const deadline = Date.now() + timeoutMs;
		const statusPath = `/v1/packets/${encodeURIComponent(sourcePacketId)}/status`;
		let last = null;
		let firstPoll = true;
		while (firstPoll || Date.now() < deadline) {
			const initialPoll = firstPoll;
			firstPoll = false;
			const remainingBeforePoll = deadline - Date.now();
			const requestTimeoutMs = initialPoll && timeoutMs === 0
				? this.timeoutMs
				: Math.max(1, Math.min(this.timeoutMs, remainingBeforePoll));
			// Whether this poll is bounded by the POLLING budget rather than the
			// client's own request timeout. Decided here, at dispatch: a timeout
			// of a budget-bounded poll IS the polling deadline expiring, and
			// re-reading the clock in the catch below raced the abort timer —
			// when the timer fired a hair before the deadline, waitFor threw
			// instead of returning the documented timed_out snapshot.
			const budgetBounded = !(initialPoll && timeoutMs === 0)
				&& remainingBeforePoll <= this.timeoutMs;
			try {
				last = await this.#request("GET", statusPath, undefined, {
					userId,
					timeoutMs: requestTimeoutMs,
					maxRetries: 0,
				});
			} catch (error) {
				if (!(error instanceof MemoryAPIError)
					|| error.code !== "timeout"
					|| !budgetBounded) throw error;
				break;
			}
			if (last && TERMINAL_JOB_STATUSES.has(last.status)) {
				if (timeoutMs === 0 || Date.now() < deadline) return last;
				break;
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) break;
			if (remainingMs <= intervalMs) {
				// The budget is spent by the time this capped sleep ends. Sleeping
				// and then re-reading the same clock lands exactly on the boundary
				// — a timer waking at 19ms of a 20ms budget raced one extra poll
				// on CI. The outcome is decided here, at the cap, not by a re-read.
				await new Promise((resolve) => setTimeout(resolve, remainingMs));
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}

		return { ...(last ?? { status: "unknown" }), timed_out: true };
	}

	#get(path, { userId, query } = {}) {
		return this.#request("GET", path, undefined, { userId, query });
	}

	#post(path, body) {
		return this.#request("POST", path, this.#withUserId(body));
	}

	#withUserId(body) {
		if (body.idempotencyKey != null) requireIdentifier(body.idempotencyKey, "idempotencyKey");
		const hasPerCallUserId = Object.prototype.hasOwnProperty.call(body, "userId") && body.userId !== undefined;
		const resolvedUserId = optionalUserId(hasPerCallUserId ? body.userId : this.userId);
		const scoped = { ...body };
		delete scoped.userId;
		if (resolvedUserId !== null) scoped.userId = resolvedUserId;
		return scoped;
	}

	#url(path, { userId, query, includeUserId = false } = {}) {
		const url = new URL(this.baseUrl + path);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value != null) url.searchParams.set(key, String(value));
		}
		if (includeUserId) {
			const resolvedUserId = optionalUserId(userId === undefined ? this.userId : userId);
			if (resolvedUserId !== null) url.searchParams.set("userId", resolvedUserId);
		}
		return url;
	}

	async #request(method, path, body = undefined, requestOptions = {}) {
		const url = this.#url(path, {
			...requestOptions,
			includeUserId: method === "GET" || method === "DELETE",
		});
		let payload;
		try {
			payload = body === undefined ? undefined : JSON.stringify(body);
		} catch (error) {
			throw new MemoryAPIError("request body must be JSON-serializable", {
				code: "invalid_argument",
				cause: error,
			});
		}

		// Writes retry only when the caller opted into idempotency; reads may retry.
		const requestBudgetMs = requestOptions.timeoutMs ?? this.timeoutMs;
		const maxRetries = requestOptions.maxRetries ?? this.maxRetries;
		const retryable = method === "GET" || (body && typeof body.idempotencyKey === "string");
		const attempts = retryable ? maxRetries + 1 : 1;
		const deadline = Date.now() + requestBudgetMs;
		let lastError = null;

		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (attempt > 0) {
				const remainingBeforeDelay = deadline - Date.now();
				if (remainingBeforeDelay <= 0) break;
				const backoff = 250 * 2 ** (attempt - 1) + Math.random() * 100;
				const proposedDelay = lastError?.retryAfterMs ?? backoff;
				const delay = Math.min(proposedDelay, remainingBeforeDelay);
				await new Promise((resolve) => setTimeout(resolve, delay));
				if (proposedDelay >= remainingBeforeDelay || Date.now() >= deadline) break;
			}

			const attemptTimeoutMs = Math.max(1, deadline - Date.now());
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
			try {
				const headers = {
					authorization: `Bearer ${this.apiKey}`,
					"user-agent": `itsuki-js/${VERSION}`,
					...(payload === undefined ? {} : { "content-type": "application/json" }),
				};
				const response = await fetch(url, {
					method,
					headers,
					body: payload,
					signal: controller.signal,
					redirect: "error",
				});
				const data = await response.json().catch(() => null);
				if (response.ok) return data;

				const error = new MemoryAPIError(errorMessage(data, method, path, response.status), {
					status: response.status,
					code: errorCode(data),
					body: data,
					retryAfterMs: retryAfterMilliseconds(response.headers),
				});
				if (response.status === 429 || response.status >= 500) {
					lastError = error;
					continue;
				}
				throw error;
			} catch (error) {
				if (error instanceof MemoryAPIError && !(error.status === 429 || error.status >= 500)) throw error;
				lastError = error instanceof MemoryAPIError
					? error
					: new MemoryAPIError(
						error?.name === "AbortError"
							? `request timed out after ${attemptTimeoutMs}ms`
							: `request failed: ${String(error?.message ?? error)}`,
						{ status: 0, code: error?.name === "AbortError" ? "timeout" : "transport_error", cause: error },
					);
			} finally {
				clearTimeout(timer);
			}
		}

		throw lastError;
	}
}

export const Memory = MemoryClient;
export default MemoryClient;
