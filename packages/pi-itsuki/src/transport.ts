/**
 * The single door to the Itsuki API.
 *
 * This is a self-contained transport with ZERO runtime dependencies. It does
 * not use the published `itsuki` npm SDK: as of 0.2.0 that package ships no
 * packet-status/waitFor call, no base-URL safety validation, and no redirect
 * hardening — three things this adapter's contract requires (see PLAN.md
 * "Divergence D-1"). The semantics below are ported from the published and
 * proven n8n node transport (packages/n8n-nodes-itsuki).
 *
 * Guarantees:
 * - The key travels only as an Authorization header, never in a URL or query.
 * - Redirects are refused, so a redirect can never replay the header elsewhere.
 * - Every request is bounded, and the caller's AbortSignal cancels it.
 * - Reads retry; writes retry only under an idempotency key; nothing else does.
 * - Retry-After is honoured exactly; every error surface is scrubbed of the key.
 */

import {
	type ErrorClass,
	ItsukiError,
	computeBackoffMs,
	mapApiError,
	redactSecrets,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://itsuki.app";
export const USER_AGENT = "pi-itsuki";

/**
 * Validate a base URL. HTTPS is required except explicit loopback. URLs
 * carrying userinfo, query strings, or fragments are rejected — a base URL is
 * a place, not a request. Returns the normalized origin+path, no trailing slash.
 */
export function validateBaseUrl(raw: string): string {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed) throw new Error("Base URL is empty. Use https://itsuki.app or your development server.");
	if (/\s/.test(trimmed)) throw new Error("Base URL must not contain whitespace.");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Base URL is not a valid URL: ${trimmed}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("Base URL must not embed credentials. The API key travels only as an Authorization header.");
	}
	if (parsed.search) throw new Error("Base URL must not carry a query string.");
	if (parsed.hash) throw new Error("Base URL must not carry a fragment.");
	const host = parsed.hostname.toLowerCase();
	const loopback = host === "localhost"
		|| host === "::1"
		|| host === "[::1]"
		|| /^127(?:\.\d{1,3}){3}$/.test(host);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
		throw new Error("Base URL must use HTTPS (plain HTTP is allowed only for localhost development).");
	}
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/** An Itsuki key is header-safe printable ASCII with the documented prefix. */
export function validApiKeyShape(key: string): boolean {
	if (typeof key !== "string" || !key) return false;
	if (!/^[!-~]+$/.test(key)) return false;
	return /^(?:itsuki|uml)_live_[A-Za-z0-9_-]{8,}$/.test(key);
}

export interface RequestOptions {
	method: "GET" | "POST";
	path: string;
	body?: Record<string, unknown>;
	query?: Record<string, string | undefined>;
	/** Writes retry only when true (an idempotency key protects them). */
	idempotent?: boolean;
	timeoutMs?: number;
	maxRetries?: number;
	signal?: AbortSignal;
}

export interface TransportOptions {
	apiKey: string;
	baseUrl?: string;
	/** Total budget for one logical call including its retries. */
	timeoutMs?: number;
	maxRetries?: number;
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new ItsukiError(
				{ message: "Cancelled", description: "The turn was cancelled.", errorClass: "cancelled", retriable: false },
				0,
			));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ItsukiError(
				{ message: "Cancelled", description: "The turn was cancelled.", errorClass: "cancelled", retriable: false },
				0,
			));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function cancelled(): ItsukiError {
	return new ItsukiError(
		{ message: "Cancelled", description: "The turn was cancelled.", errorClass: "cancelled", retriable: false },
		0,
	);
}

function timedOut(ms: number): ItsukiError {
	return new ItsukiError(
		{
			message: "Itsuki did not answer in time",
			description: `No response within ${Math.round(ms)}ms.`,
			errorClass: "timeout",
			retriable: true,
		},
		0,
	);
}

export class ItsukiTransport {
	readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly fetchImpl: typeof fetch;
	private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly random: () => number;
	private readonly now: () => number;

	constructor(options: TransportOptions) {
		if (!validApiKeyShape(options.apiKey)) {
			throw new Error("The Itsuki API key is missing or malformed. It looks like itsuki_live_… — set ITSUKI_API_KEY.");
		}
		this.apiKey = options.apiKey;
		this.baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
		this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 500), 120_000);
		this.maxRetries = Math.min(Math.max(options.maxRetries ?? 2, 0), 5);
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.sleepImpl = options.sleepImpl ?? defaultSleep;
		this.random = options.random ?? Math.random;
		this.now = options.now ?? Date.now;
	}

	/** Scrub the key out of any text before it can surface anywhere. */
	redact(text: string): string {
		return redactSecrets(text, [this.apiKey]);
	}

	async request(options: RequestOptions): Promise<Record<string, unknown>> {
		const budget = Math.min(Math.max(options.timeoutMs ?? this.timeoutMs, 500), 120_000);
		const deadline = this.now() + budget;
		const retryable = options.method === "GET" || options.idempotent === true;
		const maxRetries = options.maxRetries ?? (retryable ? this.maxRetries : 0);

		const url = new URL(this.baseUrl + options.path);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
		}

		let attempt = 0;
		let lastError: ItsukiError | null = null;

		for (;;) {
			if (options.signal?.aborted) throw cancelled();
			const remaining = deadline - this.now();
			if (remaining <= 0) throw lastError ?? timedOut(budget);

			const controller = new AbortController();
			const onOuterAbort = () => controller.abort();
			options.signal?.addEventListener("abort", onOuterAbort, { once: true });
			const timer = setTimeout(() => controller.abort(), remaining);

			let response: Response | null = null;
			let parsed: Record<string, unknown> | undefined;
			let transportFailure: ItsukiError | null = null;

			try {
				response = await this.fetchImpl(url, {
					method: options.method,
					headers: {
						authorization: `Bearer ${this.apiKey}`,
						"user-agent": USER_AGENT,
						...(options.body === undefined ? {} : { "content-type": "application/json" }),
					},
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
					signal: controller.signal,
					// A redirect must never replay the Authorization header at
					// another origin.
					redirect: "error",
				});
				const text = await response.text();
				if (text) {
					try {
						parsed = JSON.parse(text) as Record<string, unknown>;
					} catch {
						parsed = undefined;
					}
				}
			} catch (error) {
				if (options.signal?.aborted) transportFailure = cancelled();
				else if ((error as Error)?.name === "AbortError") transportFailure = timedOut(remaining);
				else {
					const raw = this.redact(String((error as Error)?.message ?? error));
					transportFailure = new ItsukiError(
						{
							message: "Could not reach Itsuki",
							description: this.redact(`Network error talking to ${this.baseUrl}: ${raw}`),
							errorClass: "transport",
							retriable: true,
						},
						0,
					);
				}
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onOuterAbort);
			}

			if (transportFailure) {
				if (transportFailure.errorClass === "cancelled") throw transportFailure;
				lastError = transportFailure;
				if (attempt >= maxRetries) throw transportFailure;
				await this.sleepImpl(
					Math.min(computeBackoffMs(attempt, undefined, this.random), Math.max(0, deadline - this.now())),
					options.signal,
				);
				attempt += 1;
				continue;
			}

			const status = response!.status;
			if (status >= 200 && status < 300) return parsed ?? {};

			const mapped = mapApiError(status, parsed, response!.headers);
			mapped.message = this.redact(mapped.message);
			mapped.description = this.redact(mapped.description);
			const failure = new ItsukiError(mapped, status);
			if (!mapped.retriable || attempt >= maxRetries) throw failure;
			lastError = failure;
			await this.sleepImpl(
				Math.min(
					computeBackoffMs(attempt, mapped.retryAfterSeconds, this.random),
					Math.max(0, deadline - this.now()),
				),
				options.signal,
			);
			attempt += 1;
		}
	}

	/** POST /v1/recall — reads only. Never carries an idempotency key. */
	recall(
		query: string,
		options: { limit: number; userId?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<Record<string, unknown>> {
		const body: Record<string, unknown> = { query, limit: options.limit };
		if (options.userId) body["userId"] = options.userId;
		return this.request({
			method: "POST",
			path: "/v1/recall",
			body,
			// Recall is a read expressed as a POST (the query travels in the
			// body). It has no side effects, so retrying it is safe.
			idempotent: true,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** POST /v1/save in conversation mode — always idempotency-keyed. */
	saveConversation(
		messages: Array<{ role: string; content: string }>,
		options: {
			idempotencyKey: string;
			userId?: string;
			conversationId?: string;
			sourceId?: string;
			threadId?: string;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<Record<string, unknown>> {
		const body: Record<string, unknown> = {
			mode: "conversation",
			messages,
			idempotencyKey: options.idempotencyKey,
		};
		if (options.userId) body["userId"] = options.userId;
		if (options.conversationId) body["conversationId"] = options.conversationId;
		if (options.sourceId) body["sourceId"] = options.sourceId;
		if (options.threadId) body["threadId"] = options.threadId;
		return this.request({
			method: "POST",
			path: "/v1/save",
			body,
			idempotent: true,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/**
	 * GET /v1/packets/:id/status. The packet lives in the memory space it was
	 * written to, so a save scoped to a sub-tenant must be polled with the same
	 * userId or the lookup 404s.
	 */
	packetStatus(
		packetId: string,
		options: { userId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: `/v1/packets/${encodeURIComponent(packetId)}/status`,
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** GET /v1/status — authenticated but content-free (counts only). */
	status(options: { userId?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: "/v1/status",
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}
}

export type { ErrorClass };
