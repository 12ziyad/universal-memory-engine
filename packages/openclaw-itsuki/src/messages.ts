/**
 * Reading OpenClaw's message array.
 *
 * The hook contract types `messages` as `unknown[]` (`PluginHookAgentEndEvent`,
 * `PluginAgentTurnPrepareEvent`), so nothing here may assume a shape. Every
 * extractor below is total: an unrecognised entry becomes "not capturable"
 * rather than throwing inside a host hook.
 *
 * What we capture: user and assistant TEXT only. Tool calls, tool results and
 * system messages are machinery, not something the user said or was told, and
 * the capture fixture contract is user-anchored.
 */

import type { CaptureMessage } from "./identity.js";
import { prefixDigest } from "./identity.js";
import { stripRecallBlocks } from "./inject.js";

const CAPTURABLE_ROLES = new Set(["user", "assistant"]);

/** Pull plain text out of string content or an array of content parts. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const kind = (block as { type?: unknown }).type;
		// Only plain text. "thinking" is private reasoning; tool_use/tool_result
		// are machinery. Neither belongs in durable memory.
		if (kind !== undefined && kind !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string" && text) parts.push(text);
	}
	return parts.join("\n");
}

/** Normalize one host message, or null when it is not capturable. */
export function normalizeMessage(raw: unknown): CaptureMessage | null {
	if (!raw || typeof raw !== "object") return null;
	const role = (raw as { role?: unknown }).role;
	if (typeof role !== "string" || !CAPTURABLE_ROLES.has(role)) return null;
	const text = textFromContent((raw as { content?: unknown }).content);
	if (!text.trim()) return null;
	return { role: role as "user" | "assistant", content: text };
}

/** Every capturable message in a host array, in order. */
export function normalizeMessages(messages: unknown[]): CaptureMessage[] {
	const out: CaptureMessage[] = [];
	for (const raw of messages ?? []) {
		const message = normalizeMessage(raw);
		if (message) out.push(message);
	}
	return out;
}

export interface CaptureSpan {
	messages: CaptureMessage[];
	/** New watermark to persist once the span is durably owned. */
	watermarkCount: number;
	watermarkDigest: string;
	/** True when history no longer matches the watermark (compaction/reset). */
	historyRewritten: boolean;
}

/**
 * Work out what is new since the last capture.
 *
 * The watermark is a count plus a digest of the owned prefix. The digest is
 * what makes this safe across compaction: when OpenClaw rewrites history, the
 * prefix stops matching, and re-sending the whole visible transcript would
 * duplicate everything already stored. In that case we deliberately fall back
 * to the final exchange only — the part that is genuinely new — and let
 * content-derived identity collapse anything that overlaps.
 */
export function planCaptureSpan(
	messages: unknown[],
	watermark: { count: number; digest: string },
	transform: (text: string, role: "user" | "assistant") => string,
): CaptureSpan {
	const all = normalizeMessages(messages);
	const owned = Math.min(Math.max(watermark.count, 0), all.length);
	const observedDigest = prefixDigest(all.slice(0, owned));
	const historyRewritten = owned > 0 && watermark.digest !== "" && observedDigest !== watermark.digest;

	let candidates: CaptureMessage[];
	if (historyRewritten) {
		// Keep only the trailing exchange: the last user message and everything
		// after it. Older content was captured under earlier keys.
		let start = all.length;
		for (let i = all.length - 1; i >= 0; i -= 1) {
			if (all[i]!.role === "user") {
				start = i;
				break;
			}
		}
		candidates = all.slice(start);
	} else {
		candidates = all.slice(owned);
	}

	const cleaned: CaptureMessage[] = [];
	for (const message of candidates) {
		const stripped = stripRecallBlocks(message.content);
		if (!stripped.trim()) continue;
		const text = transform(stripped, message.role).trim();
		if (!text) continue;
		cleaned.push({ role: message.role, content: text });
	}

	return {
		messages: cleaned,
		// Ownership always advances to everything examined, so an all-noise turn
		// is not rescanned forever.
		watermarkCount: all.length,
		watermarkDigest: prefixDigest(all),
		historyRewritten,
	};
}

/**
 * Is this a genuinely settled, completed exchange worth capturing?
 *
 * `agent_end` fires for every run outcome. A failed or aborted run is a partial
 * thought, and a run with no user turn in it (a heartbeat or cron tick) is not
 * a conversation.
 */
export function isSettledExchange(event: { success?: unknown; error?: unknown }, span: CaptureSpan): boolean {
	if (event?.success !== true) return false;
	if (typeof event?.error === "string" && event.error) return false;
	return span.messages.length > 0;
}
