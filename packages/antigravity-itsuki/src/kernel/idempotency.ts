// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/idempotency.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * Exactly-once capture, derived rather than remembered.
 *
 * A host retries. A stream reconnects. A workflow step re-executes. Each of
 * those replays the SAME logical exchange, and each would become a duplicate
 * memory if the write carried a fresh random key. So the key is a function of
 * the content and the tenancy — never of the clock, never of a counter, never
 * of client-side state that a restart would lose. Replay the same exchange and
 * you compute the same key; the server dedupes it.
 *
 * Canonical JSON (sorted keys, no incidental whitespace) is what makes the
 * derivation stable across engines and property insertion orders.
 */

import { sha256Hex } from "./hash.js";
import type { CaptureMessage, CaptureScope } from "./types.js";

/** Deterministic JSON: object keys sorted, arrays ordered, no stray spacing. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** The stable digest of one ordered span of messages. */
export function messagesDigest(messages: CaptureMessage[]): string {
	return sha256Hex(canonicalJson(messages.map((m) => ({ role: m.role, content: m.content }))));
}

export interface CaptureKeyInput {
	scope: CaptureScope;
	messages: CaptureMessage[];
	/**
	 * Distinguishes batches of one split span, and any host-specific step
	 * identity that legitimately separates two otherwise identical writes.
	 */
	discriminator?: string | undefined;
}

/**
 * The idempotency key for one capture.
 *
 * Note what is NOT in here: agentId and runId. Two agents in one session that
 * settle the identical exchange are the same memory, and a re-run of a failed
 * step is the same memory as the run that failed after staging. Including
 * either would turn a legitimate replay into a duplicate.
 */
export function captureIdempotencyKey(input: CaptureKeyInput): string {
	const digest = sha256Hex(canonicalJson({
		v: 1,
		userId: input.scope.userId ?? null,
		conversationId: input.scope.conversationId ?? null,
		projectId: input.scope.projectId ?? null,
		source: input.scope.source,
		discriminator: input.discriminator ?? null,
		messages: messagesDigest(input.messages),
	}));
	return `idem_${digest}`;
}
