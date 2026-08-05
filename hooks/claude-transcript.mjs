import { createHash } from "node:crypto";

// Moving from the legacy session-index IDs can replay one overlapping tail
// after upgrade; graph idempotency/gates prevent duplicate facts. Retries after
// that use this versioned, stable identity scheme.
export const CLAUDE_MESSAGE_ID_VERSION = "claude_msg_v1";
export const DEFAULT_MAX_MESSAGES = 80;
export const DEFAULT_MAX_CHARS_PER_MESSAGE = 4000;

function sha256(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function cleanHostId(value) {
	const id = String(value ?? "").trim();
	return id || null;
}

function textFromRow(row) {
	const content = row?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function parsedTimestamp(value) {
	const timestamp = Date.parse(value ?? "");
	return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Build an opaque, versioned ID for one eligible Claude transcript event.
 *
 * A top-level event UUID is authoritative when Claude supplies one. Older or
 * reduced transcripts sometimes expose only an API message ID; because one
 * API message can span several transcript events, that weaker ID is combined
 * with the event's stable fields and its full-transcript ordinal. With no host
 * ID, the same stable fields plus the full-transcript occurrence/ordinal form
 * the deterministic fallback. Raw transcript content never appears in the ID.
 */
function stableMessageId({ row, namespace, role, text, timestamp, ordinal, occurrence }) {
	const contentHash = sha256(text);
	const eventUuid = cleanHostId(row?.uuid ?? row?.event_id ?? row?.eventId);
	if (eventUuid) {
		return `${CLAUDE_MESSAGE_ID_VERSION}_h_${sha256(`event\0${eventUuid}`).slice(0, 32)}`;
	}

	const messageId = cleanHostId(row?.message?.id ?? row?.message_id ?? row?.messageId);
	const stableFields = [namespace, role, timestamp ?? "", contentHash, ordinal, occurrence].join("\0");
	if (messageId) {
		return `${CLAUDE_MESSAGE_ID_VERSION}_m_${sha256(`message\0${messageId}\0${stableFields}`).slice(0, 32)}`;
	}
	return `${CLAUDE_MESSAGE_ID_VERSION}_f_${sha256(`fallback\0${stableFields}`).slice(0, 32)}`;
}

/**
 * Pure transcript transformation. `lines` may be any sync or async iterable
 * of JSONL strings, which keeps filesystem I/O outside the identity logic.
 */
export async function messagesFromClaudeTranscriptLines(lines, options = {}) {
	const maxMessages = Number(options.maxMessages ?? DEFAULT_MAX_MESSAGES);
	const maxCharsPerMessage = Number(options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE);
	const namespace = String(options.sessionId ?? options.transcriptId ?? "session");
	const now = typeof options.now === "function" ? options.now : Date.now;
	const messages = [];
	const occurrences = new Map();
	let ordinal = 0;

	for await (const line of lines ?? []) {
		let row;
		try {
			row = typeof line === "string" ? JSON.parse(line) : line;
		} catch {
			continue;
		}
		if (row?.type !== "user" && row?.type !== "assistant") continue;

		const role = row.type === "assistant" ? "assistant" : "user";
		const text = String(textFromRow(row) ?? "").replace(/\r\n/g, "\n").trim();
		if (!text) continue;

		const timestamp = parsedTimestamp(row.timestamp);
		const fingerprint = sha256([role, timestamp ?? "", text].join("\0"));
		const occurrence = occurrences.get(fingerprint) ?? 0;
		occurrences.set(fingerprint, occurrence + 1);
		const id = stableMessageId({ row, namespace, role, text, timestamp, ordinal, occurrence });

		messages.push({
			id,
			role,
			content: text.length > maxCharsPerMessage ? `${text.slice(0, maxCharsPerMessage)}\u2026` : text,
			ts: timestamp ?? now(),
		});
		ordinal += 1;
	}

	return messages.slice(-maxMessages);
}
