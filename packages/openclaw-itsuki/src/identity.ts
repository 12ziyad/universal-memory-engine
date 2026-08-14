/**
 * Stable, content-derived identity, and the tenancy rules around it.
 *
 * The idempotency key is derived ONLY from the scope and the ordered messages —
 * no clock, no counter, no session path. That is what makes capture
 * exactly-once across every replay path OpenClaw has: a retried delivery, a
 * gateway restart, a re-entered `agent_end`, and a crash between staging and
 * delivery all produce the SAME key, so the server collapses them into one
 * write.
 *
 * Mirrors the published pi-itsuki and Claude outbox conventions with an
 * OpenClaw-specific prefix.
 */

import { createHash } from "node:crypto";

export const CAPTURE_IDENTITY_VERSION = "openclaw:v1";

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

/** Digest of a message prefix, used to detect history rewrites (compaction). */
export function prefixDigest(messages: CaptureMessage[]): string {
	return sha256Hex(canonicalJson(messages.map((m) => ({ role: m.role, content: m.content }))));
}

// ------------------------------------------------------------- tenancy

/**
 * Derive a sub-tenant from a channel-scoped sender.
 *
 * Two hard requirements, both structural rather than advisory:
 *
 * 1. Senders from DIFFERENT channels can never collide. OpenClaw documents
 *    `ctx.senderId` as channel-scoped (a Discord user id and a Feishu open_id
 *    are different namespaces that can coincide), so the channel id is part of
 *    the hashed input — never the sender alone.
 * 2. The result is one-way. A raw platform user id is somebody's identifier on
 *    another service; it should not become a durable key inside Itsuki, and it
 *    must not be reconstructable from anything we send.
 *
 * Returns null when identity is missing (system-originated runs: heartbeat,
 * cron, exec-event), which the caller must treat as "no per-sender tenant" and
 * fall back to owner scope rather than inventing one.
 */
export function senderTenant(channel: unknown, senderId: unknown): string | null {
	const channelId = typeof channel === "string" ? channel.trim() : "";
	const sender = typeof senderId === "string" ? senderId.trim() : "";
	if (!channelId || !sender) return null;
	// Length-prefixed so ("ab","c") and ("a","bc") cannot hash alike.
	const material = `openclaw-sender:v1|${channelId.length}:${channelId}|${sender.length}:${sender}`;
	return `oc_${sha256Hex(material).slice(0, 32)}`;
}
