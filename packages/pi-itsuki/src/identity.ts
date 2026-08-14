/**
 * Stable, content-derived identity for a captured span.
 *
 * The idempotency key is derived from the scope plus the exact ordered
 * messages, never from a clock, a counter, or a session path. That is what
 * makes capture exactly-once across every replay path Pi has: a retried
 * delivery, a resumed session, a forked branch that re-settles the same
 * prefix, and a crash between spooling and delivering all produce the SAME
 * key, so the server collapses them into one write.
 *
 * Mirrors the Claude outbox's `claude-outbox:v2:<sha256>` convention
 * (hooks/outbox.mjs) with a Pi-specific prefix.
 */

import { createHash } from "node:crypto";

export const CAPTURE_IDENTITY_VERSION = "pi:v1";

export interface CaptureMessage {
	role: "user" | "assistant";
	content: string;
}

export interface CaptureScope {
	/** Sub-tenant, when configured. Narrowing only — never widening. */
	userId?: string | undefined;
	/** Host session identity, used for attribution (not tenancy). */
	conversationId?: string | undefined;
	source: string;
}

/**
 * Deterministic JSON: object keys sorted, so two structurally equal payloads
 * always hash the same regardless of construction order.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The idempotency key for one captured span. */
export function captureIdentity(scope: CaptureScope, messages: CaptureMessage[]): string {
	const digest = sha256Hex(canonicalJson({
		scope: {
			userId: scope.userId ?? null,
			conversationId: scope.conversationId ?? null,
			source: scope.source,
		},
		messages: messages.map((m) => ({ role: m.role, content: m.content })),
	}));
	return `${CAPTURE_IDENTITY_VERSION}:${digest}`;
}
