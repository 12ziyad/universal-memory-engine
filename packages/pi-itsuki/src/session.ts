/**
 * Reading Pi's session tree — the only host-shaped module in the capture path.
 *
 * Pi persists an append-only entry tree (docs/session-format.md): every entry
 * has `{ type, id, parentId, timestamp }`, message entries carry an
 * `AgentMessage`, and extensions persist their own state as `custom` entries
 * via `pi.appendEntry()`. Our capture watermark lives in exactly that place,
 * which is why it survives `/resume` and is inherited correctly by `/fork`.
 *
 * What we capture: user and assistant TEXT only. Thinking blocks, tool calls,
 * tool results, bash executions and every other extension's custom messages are
 * deliberately excluded — they are machinery, not things the user said or the
 * assistant concluded, and the fixture contract for capture is user-anchored.
 */

import type { CaptureMessage } from "./identity.js";
import { stripRecallBlocks } from "./inject.js";

export const CAPTURE_STATE_TYPE = "itsuki-capture-state";
export const CAPTURE_STATE_SCHEMA = "itsuki.pi-capture-state/v1";

/** What we append after a span has been durably taken ownership of. */
export interface CaptureStateData {
	schema: string;
	/** Entry id of the last message included in the captured span. */
	watermarkEntryId: string;
	idempotencyKey: string;
	/** Present once the server has acknowledged. */
	receiptId?: string | null;
	sourcePacketId?: string | null;
	/** "spooled" until delivered, then "delivered". */
	state: "spooled" | "delivered";
	at: string;
}

interface SessionEntryLike {
	type?: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		customType?: string;
	};
}

/** Minimal structural view of what we need from pi's SessionManager. */
export interface SessionReader {
	getBranch(): unknown[];
	getEntries?(): unknown[];
	getSessionFile?(): string | null | undefined;
	getSessionId?(): string | undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const kind = (block as { type?: unknown }).type;
		// Only plain text. "thinking" is private reasoning and "toolCall" is
		// machinery; neither is something the user said or was told.
		if (kind !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string" && text) parts.push(text);
	}
	return parts.join("\n");
}

/** The most recent capture watermark on the current branch, if any. */
export function readCaptureState(entries: unknown[]): CaptureStateData | null {
	let latest: CaptureStateData | null = null;
	for (const raw of entries) {
		const entry = raw as SessionEntryLike;
		if (entry?.type !== "custom" || entry.customType !== CAPTURE_STATE_TYPE) continue;
		const data = entry.data as Partial<CaptureStateData> | undefined;
		if (!data || typeof data.watermarkEntryId !== "string" || typeof data.idempotencyKey !== "string") continue;
		latest = {
			schema: typeof data.schema === "string" ? data.schema : CAPTURE_STATE_SCHEMA,
			watermarkEntryId: data.watermarkEntryId,
			idempotencyKey: data.idempotencyKey,
			receiptId: data.receiptId ?? null,
			sourcePacketId: data.sourcePacketId ?? null,
			state: data.state === "delivered" ? "delivered" : "spooled",
			at: typeof data.at === "string" ? data.at : "",
		};
	}
	return latest;
}

export interface CaptureSpan {
	messages: CaptureMessage[];
	/** Entry id to record as the new watermark. */
	watermarkEntryId: string | null;
}

/**
 * Collect the user/assistant text that appeared after the watermark.
 *
 * `transform` is applied to each message's text (scrub + echo suppression);
 * a message whose text is empty afterwards is dropped, but the watermark still
 * advances past it so an all-noise span cannot be re-examined forever.
 */
export function collectCaptureSpan(
	branch: unknown[],
	afterEntryId: string | null,
	transform: (text: string, role: "user" | "assistant") => string,
): CaptureSpan {
	let started = afterEntryId === null;
	const messages: CaptureMessage[] = [];
	let watermarkEntryId: string | null = null;

	for (const raw of branch) {
		const entry = raw as SessionEntryLike;
		const id = typeof entry?.id === "string" ? entry.id : null;
		if (!started) {
			if (id !== null && id === afterEntryId) started = true;
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;

		// Everything past the watermark is now owned by this span, even if its
		// text scrubs down to nothing.
		if (id !== null) watermarkEntryId = id;

		const stripped = stripRecallBlocks(textFromContent(entry.message?.content));
		if (!stripped.trim()) continue;
		const text = transform(stripped, role).trim();
		if (!text) continue;
		messages.push({ role, content: text });
	}

	return { messages, watermarkEntryId };
}
