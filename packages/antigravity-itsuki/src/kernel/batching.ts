// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/batching.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * Keeping a captured span inside the published wire limits.
 *
 * The server re-validates everything here (GET /v1/ingest/limits is the
 * authority). Enforcing it locally means an over-long turn fails fast with a
 * named reason instead of burning a round trip, and — more importantly — that a
 * long session is SPLIT rather than dropped. Each batch is hashed from its own
 * contents, so splitting preserves exactly-once: re-splitting identical input
 * yields identical batches and therefore identical idempotency keys.
 */

import { INGEST_LIMITS } from "./errors.js";
import type { CaptureMessage } from "./types.js";
import { codePointLength, truncateToCodePoints } from "./inject.js";

const TRUNCATION_NOTE = "\n[truncated: message exceeded the per-message limit]";

/** Clamp one message to the per-message code-point limit, saying so when it bites. */
export function clampMessage(message: CaptureMessage): CaptureMessage {
	const length = codePointLength(message.content);
	if (length <= INGEST_LIMITS.maxMessageCharacters) return message;
	const room = INGEST_LIMITS.maxMessageCharacters - codePointLength(TRUNCATION_NOTE);
	return {
		role: message.role,
		content: `${truncateToCodePoints(message.content, Math.max(1, room))}${TRUNCATION_NOTE}`,
	};
}

/**
 * Split a span into wire-sized batches, preserving order.
 * Returns [] for an empty span — nothing to send is not an error.
 */
export function planBatches(messages: CaptureMessage[]): CaptureMessage[][] {
	const batches: CaptureMessage[][] = [];
	let current: CaptureMessage[] = [];
	let currentChars = 0;

	for (const raw of messages) {
		const message = clampMessage(raw);
		const length = codePointLength(message.content);
		const wouldOverflow = current.length >= INGEST_LIMITS.maxMessages
			|| (current.length > 0 && currentChars + length > INGEST_LIMITS.maxTotalCharacters);
		if (wouldOverflow) {
			batches.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(message);
		currentChars += length;
	}

	if (current.length > 0) batches.push(current);
	return batches;
}
