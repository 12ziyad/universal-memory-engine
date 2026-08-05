import {
	CLAUDE_CAPTURE_MESSAGE_ID_VERSION,
	DEFAULT_CLAUDE_CAPTURE_MAX_CHARS,
	ITSUKI_LEGACY_RECALL_PREFIXES,
	ITSUKI_RECALL_CONTEXT_END_MARKER_V1,
	ITSUKI_RECALL_CONTEXT_MARKER_V1,
	captureClaudeTranscriptRows,
	formatItsukiRecallContext,
	stripItsukiRecallContext,
} from "./claude-capture.mjs";

export {
	ITSUKI_LEGACY_RECALL_PREFIXES,
	ITSUKI_RECALL_CONTEXT_END_MARKER_V1,
	ITSUKI_RECALL_CONTEXT_MARKER_V1,
	formatItsukiRecallContext,
	stripItsukiRecallContext,
};

// Moving from the legacy session-index IDs can replay one overlapping tail
// after upgrade; graph idempotency/gates prevent duplicate facts. Retries after
// that use this versioned, stable identity scheme.
export const CLAUDE_MESSAGE_ID_VERSION = CLAUDE_CAPTURE_MESSAGE_ID_VERSION;
export const DEFAULT_MAX_MESSAGES = 80;
// Derived coding events are deliberately small. Raw logical messages,
// commands, diffs, and logs never enter the outbox for later segmentation.
export const DEFAULT_MAX_CHARS_PER_MESSAGE = DEFAULT_CLAUDE_CAPTURE_MAX_CHARS;

const CAPTURE_EXCLUSION_KEYS = Object.freeze([
	"inputRows",
	"ineligibleRows",
	"ignoredThinkingBlocks",
	"ignoredMetaRows",
	"ignoredToolEvents",
	"ignoredRecallEvents",
	"ignoredRecallEchoEvents",
	"ignoredUnprotectedAssistantEvents",
	"ignoredNoiseEvents",
]);

function mergeCaptureExclusions(metadata, value) {
	for (const key of CAPTURE_EXCLUSION_KEYS) {
		const count = value?.[key];
		if (Number.isSafeInteger(count) && count >= 0) metadata[key] = (metadata[key] ?? 0) + count;
	}
}

/**
 * Pure transcript transformation. `lines` may be any sync or async iterable
 * of JSONL strings, which keeps filesystem I/O outside the identity logic.
 */
export async function transformClaudeTranscriptLines(lines, options = {}) {
	const maxMessages = Number(options.maxMessages ?? DEFAULT_MAX_MESSAGES);
	const maxCharsPerMessage = Number(options.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE);
	if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
		throw new TypeError("maxMessages must be a positive safe integer");
	}
	const records = [];
	for await (const line of lines ?? []) records.push(line);
	const captured = captureClaudeTranscriptRows(records, {
		...options,
		maxChars: maxCharsPerMessage,
	});
	const messages = captured.messages.slice(-maxMessages);
	const metadata = { ...captured.metadata };
	mergeCaptureExclusions(metadata, options.captureExclusions);
	return {
		messages,
		metadata: {
			...metadata,
			returnedEvents: messages.length,
			omittedEvents: Math.max(0, captured.messages.length - messages.length),
		},
	};
}

/** Backwards-compatible messages-only API. */
export async function messagesFromClaudeTranscriptLines(lines, options = {}) {
	return (await transformClaudeTranscriptLines(lines, options)).messages;
}
