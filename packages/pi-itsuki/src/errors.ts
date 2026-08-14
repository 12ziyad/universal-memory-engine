/**
 * The Itsuki error taxonomy, ported from the published n8n node
 * (packages/n8n-nodes-itsuki/nodes/Itsuki/GenericFunctions.ts `mapApiError`).
 *
 * Every branch names what happened and what to do. No branch echoes a
 * credential, and no branch blames the user for an account-wide event.
 * The vectors in test/fixtures/agent_lifecycle_corpus.json pin this mapping so
 * the Pi adapter and the n8n node cannot drift apart silently.
 */

export const INGEST_LIMITS = Object.freeze({
	maxMessages: 30,
	maxMessageCharacters: 4_000,
	maxTotalCharacters: 120_000,
	maxRequestBytes: 524_288,
});

/** GET /v1/packets/:id/status terminal states (src/lib/db.js). */
export const TERMINAL_PACKET_STATUSES = Object.freeze(["enriched", "failed", "completed"] as const);

export type ErrorClass =
	| "auth"
	| "not_found"
	| "invalid"
	| "conflict"
	| "too_large"
	| "confirmation"
	| "quota"
	| "capacity"
	| "backlog"
	| "rate_limit"
	| "unavailable"
	| "transport"
	| "timeout"
	| "cancelled"
	| "unknown";

export interface MappedApiError {
	/** Short, human-facing headline. Never contains a secret. */
	message: string;
	/** What to do about it. Never contains a secret. */
	description: string;
	errorClass: ErrorClass;
	retryAfterSeconds?: number;
	retriable: boolean;
}

/** An error that already carries its taxonomy classification. */
export class ItsukiError extends Error {
	readonly status: number;
	readonly errorClass: ErrorClass;
	readonly retriable: boolean;
	readonly retryAfterSeconds: number | undefined;
	readonly description: string;

	constructor(mapped: MappedApiError, status: number) {
		super(mapped.message);
		this.name = "ItsukiError";
		this.status = status;
		this.errorClass = mapped.errorClass;
		this.retriable = mapped.retriable;
		this.retryAfterSeconds = mapped.retryAfterSeconds;
		this.description = mapped.description;
	}
}

type Body = Record<string, unknown> | undefined;

function headerNumber(headers: Headers | undefined, name: string): number | undefined {
	const raw = headers?.get(name);
	if (raw === null || raw === undefined) return undefined;
	const value = Number(raw);
	if (Number.isFinite(value) && value >= 0) return value;
	// Retry-After also permits an HTTP-date. Convert it to a delay.
	const at = Date.parse(raw);
	if (!Number.isFinite(at)) return undefined;
	return Math.max(0, Math.round((at - Date.now()) / 1_000));
}

/**
 * Map an Itsuki error response to a friendly, structured, secret-free error.
 * `statusCode` 0 means the request never produced a response.
 */
export function mapApiError(statusCode: number, body?: Body, headers?: Headers): MappedApiError {
	const code = String(body?.["error"] ?? "");
	const rawMessage = body?.["message"];
	const serverMessage = typeof rawMessage === "string" ? rawMessage : "";
	const bodyRetry = Number(body?.["retry_after_s"]);
	const retryAfterSeconds = headerNumber(headers, "retry-after")
		?? (Number.isFinite(bodyRetry) && bodyRetry >= 0 ? bodyRetry : undefined);

	if (statusCode === 401) {
		return {
			message: "Itsuki rejected the API key",
			description: "The key is malformed, revoked, or expired. Create a fresh key in the Itsuki dashboard under API Keys and set ITSUKI_API_KEY.",
			errorClass: "auth",
			retriable: false,
		};
	}
	if (statusCode === 403) {
		return {
			message: "This key is not allowed to do that",
			description: code === "insufficient_scope"
				? "The key lacks the required scope (for example a read-only key attempting a write). Create a key with the right scopes."
				: serverMessage || "The key's project role forbids this operation.",
			errorClass: "auth",
			retriable: false,
		};
	}
	if (statusCode === 404) {
		return {
			message: "Not found",
			description: serverMessage || "No such record in this project (it may have been deleted, or belongs to another scope).",
			errorClass: "not_found",
			retriable: false,
		};
	}
	if (statusCode === 409 || statusCode === 412) {
		return {
			message: "Conflict — the resource changed underneath this request",
			description: serverMessage || "Re-read the current state and retry deliberately.",
			errorClass: "conflict",
			retriable: false,
		};
	}
	if (statusCode === 413) {
		return {
			message: "Request too large",
			description: `The payload exceeds the published limits (${INGEST_LIMITS.maxMessages} messages / ${INGEST_LIMITS.maxMessageCharacters} chars per message / ${INGEST_LIMITS.maxTotalCharacters} total / ${INGEST_LIMITS.maxRequestBytes} bytes). Split the input.`,
			errorClass: "too_large",
			retriable: false,
		};
	}
	if (statusCode === 422 || statusCode === 400) {
		return {
			message: "Itsuki rejected the request as invalid",
			description: serverMessage || "A field failed validation.",
			errorClass: "invalid",
			retriable: false,
		};
	}
	if (statusCode === 428) {
		return {
			message: "Confirmation required",
			description: serverMessage || "This destructive operation needs its explicit confirmation flag.",
			errorClass: "confirmation",
			retriable: false,
		};
	}
	if (statusCode === 429) {
		if (code === "ai_quota_exhausted") {
			const usage = (body?.["usage"] ?? {}) as Record<string, unknown>;
			return {
				message: "Monthly AI plan exhausted",
				description: serverMessage
					|| `This account has used its monthly AI write budget (${usage["used"] ?? "?"} of ${usage["limit"] ?? "?"}). It resets at ${usage["resets_at"] ?? "the start of next month"}.`,
				errorClass: "quota",
				retryAfterSeconds,
				retriable: false,
			};
		}
		if (code === "ai_capacity_paused") {
			return {
				message: "Itsuki is at its daily processing ceiling",
				description: serverMessage || "Account-wide protection tripped; saves resume at 00:00 UTC. Nothing you sent was lost, and nothing about this is specific to your account.",
				errorClass: "capacity",
				retryAfterSeconds,
				retriable: true,
			};
		}
		if (code === "queue_full") {
			return {
				message: "Itsuki is briefly backlogged",
				description: serverMessage || "The processing queue is full. Wait and retry.",
				errorClass: "backlog",
				retryAfterSeconds: retryAfterSeconds ?? 30,
				retriable: true,
			};
		}
		const bucket = body?.["bucket"];
		return {
			message: "Rate limited",
			description: `${serverMessage || "Too many requests in this window."}${bucket ? ` (bucket: ${String(bucket)})` : ""} Honour the Retry-After header.`,
			errorClass: "rate_limit",
			retryAfterSeconds: retryAfterSeconds ?? 60,
			retriable: true,
		};
	}
	if (statusCode === 503) {
		return {
			message: "Itsuki is temporarily unavailable",
			description: serverMessage || "Transient server condition. Retry with backoff.",
			errorClass: "unavailable",
			retryAfterSeconds,
			retriable: true,
		};
	}
	if (statusCode === 0) {
		return {
			message: "Could not reach Itsuki",
			description: "Network, DNS, proxy, or TLS failure.",
			errorClass: "transport",
			retriable: true,
		};
	}
	return {
		message: `Itsuki returned HTTP ${statusCode}`,
		description: serverMessage || "Unexpected response.",
		errorClass: statusCode >= 500 ? "unavailable" : "unknown",
		retriable: statusCode >= 500,
	};
}

/** Retry-After is honoured exactly (capped); otherwise exponential backoff with jitter. */
export function computeBackoffMs(attempt: number, retryAfterSeconds?: number, random: () => number = Math.random): number {
	if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1_000, 120_000);
	const base = Math.min(1_000 * 2 ** attempt, 20_000);
	return Math.round(base / 2 + random() * (base / 2));
}

/**
 * Replace every occurrence of each secret with ***.
 * Short strings are ignored rather than shredding ordinary text.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
	let out = text;
	for (const secret of secrets) {
		if (typeof secret === "string" && secret.length >= 8) {
			out = out.split(secret).join("***");
		}
	}
	return out;
}
