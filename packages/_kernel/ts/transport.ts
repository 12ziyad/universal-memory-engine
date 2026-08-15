/**
 * The single door to the Itsuki API, shared by every TypeScript adapter.
 *
 * Ported from the audited transport that ships in openclaw-itsuki and
 * pi-itsuki, generalized in exactly two ways: the User-Agent is supplied by
 * the package (so a server-side log names the real caller) and the endpoint
 * set covers inventory and deletion for adapters that expose memory
 * management. Everything else is unchanged, deliberately:
 *
 * - The key travels only as an Authorization header, never in a URL or query.
 * - Redirects are refused, so a redirect can never replay the header elsewhere.
 * - Every request is bounded, and the caller's AbortSignal cancels it.
 * - Reads retry; writes retry only under an idempotency key; nothing else does.
 * - Retry-After is honoured exactly; every error surface is scrubbed of the key.
 *
 * This file has no runtime dependencies and no Node built-ins, so it runs
 * unchanged in Node, edge runtimes and Workers.
 */

import {
	type ErrorClass,
	ItsukiError,
	computeBackoffMs,
	mapApiError,
	redactSecrets,
} from "./errors.js";
import type { CaptureMessage, MemoryListItem, RecallScope } from "./types.js";

export const DEFAULT_BASE_URL = "https://itsuki.app";
export const DEFAULT_USER_AGENT = "itsuki-kernel";

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

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RequestOptions {
	method: HttpMethod;
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
	userAgent?: string;
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
			reject(cancelled());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelled());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function cancelled(): ItsukiError {
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

export interface ScopedCall {
	userId?: string | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
}

export class ItsukiTransport {
	readonly baseUrl: string;
	readonly userAgent: string;
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
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
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
						"user-agent": this.userAgent,
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

	// ------------------------------------------------------------- reads

	/** POST /v1/recall — reads only. Never carries an idempotency key. */
	recall(
		query: string,
		options: ScopedCall & {
			limit?: number;
			recallScope?: RecallScope | undefined;
			projectId?: string | undefined;
			conversationId?: string | undefined;
		},
	): Promise<Record<string, unknown>> {
		const body: Record<string, unknown> = { query };
		if (options.limit !== undefined) body["limit"] = options.limit;
		if (options.userId) body["userId"] = options.userId;
		if (options.recallScope) body["recallScope"] = options.recallScope;
		if (options.conversationId) body["conversationId"] = options.conversationId;
		if (options.projectId) body["memoryScope"] = { projectId: options.projectId };
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

	/** GET /v1/memories — inventory, newest first, cursor-paginated. */
	listMemories(
		options: ScopedCall & { limit?: number; cursor?: string | undefined; kind?: string | undefined; q?: string | undefined },
	): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: "/v1/memories",
			query: {
				userId: options.userId,
				limit: options.limit === undefined ? undefined : String(options.limit),
				cursor: options.cursor,
				kind: options.kind,
				q: options.q,
			},
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** GET /v1/memories/:id — one stored memory with its slices and events. */
	getMemory(id: string, options: ScopedCall = {}): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: `/v1/memories/${encodeURIComponent(id)}`,
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/**
	 * GET /v1/packets/:id/status. The packet lives in the memory space it was
	 * written to, so a save scoped to a sub-tenant must be polled with the same
	 * userId or the lookup 404s.
	 */
	packetStatus(packetId: string, options: ScopedCall = {}): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: `/v1/packets/${encodeURIComponent(packetId)}/status`,
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** GET /v1/status — authenticated but content-free (counts only). */
	status(options: ScopedCall = {}): Promise<Record<string, unknown>> {
		return this.request({
			method: "GET",
			path: "/v1/status",
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	// ------------------------------------------------------------ writes

	/** POST /v1/save in direct mode — one durable fact. Always keyed. */
	saveMemory(
		content: string,
		options: ScopedCall & {
			idempotencyKey: string;
			conversationId?: string | undefined;
			sourceId?: string | undefined;
			projectId?: string | undefined;
			source?: string | undefined;
		},
	): Promise<Record<string, unknown>> {
		const body: Record<string, unknown> = { content, idempotencyKey: options.idempotencyKey };
		if (options.userId) body["userId"] = options.userId;
		if (options.conversationId) body["conversationId"] = options.conversationId;
		if (options.sourceId) body["sourceId"] = options.sourceId;
		if (options.source) body["source"] = options.source;
		if (options.projectId) body["memoryScope"] = { projectId: options.projectId };
		return this.request({
			method: "POST",
			path: "/v1/save",
			body,
			idempotent: true,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** POST /v1/save in conversation mode — always idempotency-keyed. */
	saveConversation(
		messages: CaptureMessage[],
		options: ScopedCall & {
			idempotencyKey: string;
			conversationId?: string | undefined;
			sourceId?: string | undefined;
			threadId?: string | undefined;
			projectId?: string | undefined;
			agentId?: string | undefined;
			source?: string | undefined;
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
		if (options.source) body["source"] = options.source;
		if (options.projectId || options.agentId) {
			body["memoryScope"] = {
				...(options.projectId ? { projectId: options.projectId } : {}),
				...(options.agentId ? { agentId: options.agentId } : {}),
			};
		}
		return this.request({
			method: "POST",
			path: "/v1/save",
			body,
			idempotent: true,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	// ---------------------------------------------------------- deletion
	// Guarded at every call site: an adapter must opt in explicitly, and the
	// model can never reach these through a tool that was not enabled.

	/** DELETE /v1/memories/:id — one object, by exact id. */
	deleteMemory(id: string, options: ScopedCall = {}): Promise<Record<string, unknown>> {
		return this.request({
			method: "DELETE",
			path: `/v1/memories/${encodeURIComponent(id)}`,
			query: { userId: options.userId },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/**
	 * DELETE /v1/memories — bulk, by source lane. Dry run unless confirmed,
	 * matching the server's own default: the preview is the safe call, and the
	 * destructive one has to be asked for by name.
	 */
	deleteBySource(
		options: ScopedCall & { source?: string | undefined; confirm?: boolean },
	): Promise<Record<string, unknown>> {
		return this.request({
			method: "DELETE",
			path: "/v1/memories",
			query: {
				userId: options.userId,
				source: options.source,
				...(options.confirm === true ? { confirm: "true", dry_run: "false" } : {}),
			},
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}
}

export type { ErrorClass, MemoryListItem };
