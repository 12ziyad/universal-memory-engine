import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * Everything here is either a pure function (unit-testable without n8n) or a
 * thin `.call(this, …)` wrapper over n8n's own HTTP helper. There are no
 * runtime dependencies — the transport is n8n's, the logic is ours.
 */

// ---------------------------------------------------------------- contracts

/** Mirror of GET /v1/ingest/limits — the server remains authoritative. */
export const INGEST_LIMITS = Object.freeze({
	maxMessages: 30,
	maxMessageCharacters: 4_000,
	maxTotalCharacters: 120_000,
	maxRequestBytes: 524_288,
});

export const MESSAGE_ROLES = Object.freeze(['user', 'assistant', 'system', 'tool'] as const);

/** GET /v1/packets/:id/status terminal states (same set the itsuki SDK uses). */
export const TERMINAL_PACKET_STATUSES = Object.freeze(['enriched', 'failed', 'completed'] as const);

export const LIST_MAX_ITEMS_CAP = 5_000;
export const LIST_PAGE_SIZE_MAX = 200;

// ---------------------------------------------------------------- pure: url

/**
 * Validate a credential base URL. HTTPS is required except explicit loopback.
 * URLs carrying userinfo, query strings, or fragments are rejected — a base
 * URL is a place, not a request. Returns the normalized origin+path with no
 * trailing slash.
 */
export function validateBaseUrl(raw: string): string {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) throw new Error('Base URL is empty. Use https://itsuki.app or your development server.');
	if (/\s/.test(trimmed)) throw new Error('Base URL must not contain whitespace.');
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Base URL is not a valid URL: ${trimmed}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error('Base URL must not embed credentials. The API key travels only as an Authorization header.');
	}
	if (parsed.search) throw new Error('Base URL must not carry a query string.');
	if (parsed.hash) throw new Error('Base URL must not carry a fragment.');
	const loopback = parsed.hostname === 'localhost'
		|| parsed.hostname === '127.0.0.1'
		|| parsed.hostname === '::1'
		|| parsed.hostname === '[::1]';
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
		throw new Error('Base URL must use HTTPS (plain HTTP is allowed only for localhost development).');
	}
	const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
	return base;
}

// ---------------------------------------------------------- pure: messages

export interface ConversationMessage {
	role: string;
	content: string;
}

/** Count what the server counts: unicode code points, not UTF-16 units. */
export function codePointLength(text: string): number {
	let count = 0;
	const iterator = text[Symbol.iterator]();
	while (!iterator.next().done) count += 1;
	return count;
}

/**
 * Validate a conversation batch locally against the published ingest limits,
 * preserving order. The server re-validates; this exists so a workflow fails
 * fast with a named reason instead of burning a network round trip.
 */
export function validateConversation(messages: unknown): ConversationMessage[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new Error('Provide at least one message with a role and content.');
	}
	if (messages.length > INGEST_LIMITS.maxMessages) {
		throw new Error(
			`Too many messages: ${messages.length}. The limit is ${INGEST_LIMITS.maxMessages} per call — split the batch.`,
		);
	}
	let total = 0;
	const out: ConversationMessage[] = [];
	messages.forEach((entry, index) => {
		const role = String((entry as IDataObject)?.role ?? '').trim().toLowerCase();
		const content = String((entry as IDataObject)?.content ?? '');
		if (!MESSAGE_ROLES.includes(role as (typeof MESSAGE_ROLES)[number])) {
			throw new Error(`messages[${index}].role must be one of: ${MESSAGE_ROLES.join(', ')}.`);
		}
		if (!content.trim()) {
			throw new Error(`messages[${index}].content is empty. Every message needs content.`);
		}
		const length = codePointLength(content);
		if (length > INGEST_LIMITS.maxMessageCharacters) {
			throw new Error(
				`messages[${index}] is ${length} characters; the per-message limit is ${INGEST_LIMITS.maxMessageCharacters}.`,
			);
		}
		total += length;
		out.push({ role, content });
	});
	if (total > INGEST_LIMITS.maxTotalCharacters) {
		throw new Error(
			`The batch totals ${total} characters; the per-call limit is ${INGEST_LIMITS.maxTotalCharacters}. Split it.`,
		);
	}
	return out;
}

// ------------------------------------------------------------ pure: errors

export interface MappedApiError {
	message: string;
	description: string;
	retryAfterSeconds?: number;
	retriable: boolean;
}

function headerNumber(headers: IDataObject | undefined, name: string): number | undefined {
	const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map an Itsuki error response to a friendly, structured, secret-free error.
 * Every branch names what happened and what to do — never a bare status code.
 */
export function mapApiError(
	statusCode: number,
	body: IDataObject | undefined,
	headers?: IDataObject,
): MappedApiError {
	const code = String(body?.error ?? '');
	const serverMessage = typeof body?.message === 'string' ? body.message : '';
	const retryAfterSeconds = headerNumber(headers, 'retry-after')
		?? (Number.isFinite(Number(body?.retry_after_s)) ? Number(body?.retry_after_s) : undefined);

	if (statusCode === 401) {
		return {
			message: 'Itsuki rejected the API key',
			description: 'The key is malformed, revoked, or expired. Create a fresh key in the Itsuki dashboard under API Keys and update this credential.',
			retriable: false,
		};
	}
	if (statusCode === 403) {
		return {
			message: 'This key is not allowed to do that',
			description: code === 'insufficient_scope'
				? 'The key lacks the required scope (for example a read-only key attempting a write or delete). Create a key with the right scopes.'
				: serverMessage || 'The key\'s project role forbids this operation.',
			retriable: false,
		};
	}
	if (statusCode === 404) {
		return {
			message: 'Not found',
			description: serverMessage || 'No memory with that ID exists in this project (it may have been deleted, or belongs to another scope).',
			retriable: false,
		};
	}
	if (statusCode === 409 || statusCode === 412) {
		return {
			message: 'Conflict — the resource changed underneath this request',
			description: serverMessage || 'Re-read the current state and retry deliberately.',
			retriable: false,
		};
	}
	if (statusCode === 413) {
		return {
			message: 'Request too large',
			description: `The payload exceeds the published limits (${INGEST_LIMITS.maxMessages} messages / ${INGEST_LIMITS.maxMessageCharacters} chars per message / ${INGEST_LIMITS.maxTotalCharacters} total / ${INGEST_LIMITS.maxRequestBytes} bytes). Split the input.`,
			retriable: false,
		};
	}
	if (statusCode === 422 || statusCode === 400) {
		return {
			message: 'Itsuki rejected the request as invalid',
			description: serverMessage || 'A field failed validation. Check the operation\'s parameters.',
			retriable: false,
		};
	}
	if (statusCode === 428) {
		return {
			message: 'Confirmation required',
			description: serverMessage || 'This destructive operation needs its explicit confirmation flag.',
			retriable: false,
		};
	}
	if (statusCode === 429) {
		if (code === 'ai_quota_exhausted') {
			const usage = (body?.usage ?? {}) as IDataObject;
			return {
				message: 'Monthly AI plan exhausted',
				description: serverMessage
					|| `This account has used its monthly AI write budget (${usage.used ?? '?'} of ${usage.limit ?? '?'}). It resets at ${usage.resets_at ?? 'the start of next month'}.`,
				retryAfterSeconds,
				retriable: false,
			};
		}
		if (code === 'ai_capacity_paused') {
			return {
				message: 'Itsuki is at its daily processing ceiling',
				description: serverMessage || 'Account-wide protection tripped; saves resume at 00:00 UTC. Nothing you sent was lost, and nothing about this is specific to your account.',
				retryAfterSeconds,
				retriable: true,
			};
		}
		if (code === 'queue_full') {
			return {
				message: 'Itsuki is briefly backlogged',
				description: serverMessage || 'The processing queue is full. Wait and retry.',
				retryAfterSeconds: retryAfterSeconds ?? 30,
				retriable: true,
			};
		}
		return {
			message: 'Rate limited',
			description: `${serverMessage || 'Too many requests in this window.'}${body?.bucket ? ` (bucket: ${body.bucket})` : ''} Honour the Retry-After header.`,
			retryAfterSeconds: retryAfterSeconds ?? 60,
			retriable: true,
		};
	}
	if (statusCode === 503) {
		return {
			message: 'Itsuki is temporarily unavailable',
			description: serverMessage || 'Transient server condition. Retry with backoff.',
			retryAfterSeconds,
			retriable: true,
		};
	}
	return {
		message: `Itsuki returned HTTP ${statusCode}`,
		description: serverMessage || 'Unexpected response.',
		retriable: statusCode >= 500,
	};
}

// ------------------------------------------------------------- pure: retry

/** Retry-After is honoured exactly; otherwise exponential backoff with jitter. */
export function computeBackoffMs(attempt: number, retryAfterSeconds?: number): number {
	if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1_000, 120_000);
	const base = Math.min(1_000 * 2 ** attempt, 20_000);
	return Math.round(base / 2 + Math.random() * (base / 2));
}

// --------------------------------------------------------- pure: redaction

/** Replace every occurrence of each secret in a string with ***. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
	let out = text;
	for (const secret of secrets) {
		if (typeof secret === 'string' && secret.length >= 8) {
			out = out.split(secret).join('***');
		}
	}
	return out;
}

// ------------------------------------------------------------- transport

export interface ItsukiRequestOptions {
	method: IHttpRequestMethods;
	path: string;
	body?: IDataObject;
	qs?: IDataObject;
	timeoutMs?: number;
	/** Writes are retried only when this is true (an idempotency key protects them). */
	idempotent?: boolean;
	maxRetries?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('The execution was cancelled.'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('The execution was cancelled.'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function cancelSignal(ctx: IExecuteFunctions): AbortSignal | undefined {
	const anyCtx = ctx as unknown as { getExecutionCancelSignal?: () => AbortSignal | undefined };
	return typeof anyCtx.getExecutionCancelSignal === 'function' ? anyCtx.getExecutionCancelSignal() : undefined;
}

/**
 * One door for every API call the node makes.
 *
 * - Auth via n8n's credential system (header only; the key never enters URLs).
 * - Full-response mode so status codes and Retry-After are read deliberately.
 * - GETs retry on retriable failures; writes retry only under an idempotency
 *   key; DELETEs never retry.
 * - The execution's cancel signal aborts both requests and backoff sleeps.
 * - Any error text is scrubbed of the credential before it can surface.
 */
export async function itsukiApiRequest(
	this: IExecuteFunctions,
	options: ItsukiRequestOptions,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('itsukiApi');
	const apiKey = String(credentials.apiKey ?? '');
	let base: string;
	try {
		base = validateBaseUrl(String(credentials.baseUrl ?? 'https://itsuki.app'));
	} catch (error) {
		throw new NodeOperationError(this.getNode(), (error as Error).message);
	}

	const signal = cancelSignal(this);
	const maxRetries = options.maxRetries ?? (options.method === 'GET' || options.idempotent ? 3 : 0);
	const timeout = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 120_000);

	let attempt = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (signal?.aborted) throw new NodeOperationError(this.getNode(), 'The execution was cancelled.');

		const requestOptions: IHttpRequestOptions = {
			method: options.method,
			url: `${base}${options.path}`,
			qs: options.qs,
			body: options.body,
			json: true,
			timeout,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			abortSignal: signal,
		};

		let response: { statusCode: number; body: IDataObject; headers: IDataObject };
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'itsukiApi',
				requestOptions,
			)) as unknown as { statusCode: number; body: IDataObject; headers: IDataObject };
		} catch (error) {
			// Network-level failure (DNS, TLS, abort, timeout). Retry reads only.
			const raw = redactSecrets(String((error as Error).message ?? error), [apiKey]);
			if (signal?.aborted) throw new NodeOperationError(this.getNode(), 'The execution was cancelled.');
			if (attempt < maxRetries) {
				await sleep(computeBackoffMs(attempt), signal);
				attempt += 1;
				continue;
			}
			throw new NodeApiError(this.getNode(), { message: raw }, {
				message: 'Could not reach Itsuki',
				description: `Network error talking to ${base}: ${raw}`,
			});
		}

		const { statusCode, body, headers } = response;
		if (statusCode >= 200 && statusCode < 300) {
			return (body ?? {}) as IDataObject;
		}

		const mapped = mapApiError(statusCode, body, headers);
		const canRetry = mapped.retriable && attempt < maxRetries
			&& (options.method === 'GET' || options.idempotent === true);
		if (canRetry) {
			await sleep(computeBackoffMs(attempt, mapped.retryAfterSeconds), signal);
			attempt += 1;
			continue;
		}

		throw new NodeApiError(
			this.getNode(),
			{ message: redactSecrets(JSON.stringify(body ?? {}), [apiKey]), httpCode: String(statusCode) },
			{
				message: mapped.message,
				description: redactSecrets(mapped.description, [apiKey]),
				httpCode: String(statusCode),
			},
		);
	}
}

// ---------------------------------------------------------------- waiting

export interface WaitResult extends IDataObject {
	timed_out?: boolean;
}

/**
 * Poll GET /v1/packets/:id/status until a terminal state or the deadline.
 * On timeout this returns the last observed state with `timed_out: true` —
 * an honest "accepted and still processing", never a fabricated failure.
 * (Same contract as the itsuki SDK's waitFor.)
 */
export async function waitForPacket(
	this: IExecuteFunctions,
	packetId: string,
	{ timeoutMs, intervalMs, userId }: { timeoutMs: number; intervalMs: number; userId?: string },
): Promise<WaitResult> {
	const signal = cancelSignal(this);
	const deadline = Date.now() + timeoutMs;
	let last: IDataObject | null = null;
	let first = true;
	while (first || Date.now() < deadline) {
		first = false;
		last = await itsukiApiRequest.call(this, {
			method: 'GET',
			path: `/v1/packets/${encodeURIComponent(packetId)}/status`,
			// The packet lives in the memory space it was written to. A save
			// scoped to a sub-tenant must be polled with the same userId, or
			// the status lookup lands in the wrong space and 404s.
			qs: userId ? { userId } : undefined,
			maxRetries: 0,
			timeoutMs: Math.max(2_000, Math.min(30_000, deadline - Date.now())),
		});
		const status = String(last?.status ?? '');
		if ((TERMINAL_PACKET_STATUSES as readonly string[]).includes(status)) return last as WaitResult;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(intervalMs, remaining), signal);
	}
	return { ...(last ?? { status: 'unknown' }), timed_out: true } as WaitResult;
}

// -------------------------------------------------------------- pagination

/**
 * Cursor pagination with a hard item cap and loop detection. A repeated
 * cursor is a server bug we refuse to amplify into an unbounded loop.
 */
export async function listAllMemories(
	this: IExecuteFunctions,
	qs: IDataObject,
	{ returnAll, maxItems, pageSize }: { returnAll: boolean; maxItems: number; pageSize: number },
): Promise<IDataObject[]> {
	const cap = Math.min(Math.max(maxItems, 1), LIST_MAX_ITEMS_CAP);
	const size = Math.min(Math.max(pageSize, 1), LIST_PAGE_SIZE_MAX);
	const items: IDataObject[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	const signal = cancelSignal(this);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (signal?.aborted) throw new NodeOperationError(this.getNode(), 'The execution was cancelled.');
		const page: IDataObject = await itsukiApiRequest.call(this, {
			method: 'GET',
			path: '/v1/memories',
			qs: { ...qs, limit: size, ...(cursor ? { cursor } : {}) },
		});
		const pageItems = Array.isArray(page.items) ? (page.items as IDataObject[]) : [];
		items.push(...pageItems);
		if (items.length >= cap) return items.slice(0, cap);
		const next: string | null = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null;
		if (!returnAll || !next) return items;
		if (seenCursors.has(next)) {
			throw new NodeOperationError(
				this.getNode(),
				'Pagination loop detected: the server returned the same cursor twice. Stopping rather than looping forever.',
			);
		}
		seenCursors.add(next);
		cursor = next;
	}
}
