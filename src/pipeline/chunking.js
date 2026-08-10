/**
 * Deterministic pre-splitting for extraction.
 *
 * One model call has a bounded output budget. A chunk whose facts do not fit in
 * that budget comes back valid-looking and cut off mid-JSON, the parse fails,
 * and — depending on how many messages the chunk held — the whole fire can end
 * up writing nothing. The LLM-judge baseline puts 64.6% of its misses in
 * "never stored", so a mechanical capture ceiling is expensive in exactly the
 * place the product can least afford it.
 *
 * The fix is to decide the split in CODE, before the model sees anything, and to
 * make that decision a pure function of the chunk. That buys three properties
 * the previous inline arithmetic could not state:
 *
 *   COVERAGE     every message of the accepted chunk lands in exactly one
 *                sub-chunk. Not most; every one.
 *   CHRONOLOGY   sub-chunks are contiguous and ordered, and so are the messages
 *                inside them. Extraction never sees a shuffled history.
 *   REPLAY       the same chunk always produces the same sub-chunks with the
 *                same identities, so a retry re-derives the same work instead of
 *                inventing a differently-shaped one.
 *
 * A message is never split down the middle. A single oversized message becomes
 * its own sub-chunk instead, because half a message with a provenance pointer to
 * the whole is a lie about where the fact came from.
 */

export const EXTRACTION_CHUNK_SCHEMA = "itsuki.extraction-chunk/v2";

/**
 * Messages per sub-chunk. Deliberately equal to the split-rescue ceiling
 * (`SPLIT_RESCUE_MAX_CALLS`, default 8): if a sub-chunk could hold more messages
 * than the rescue is allowed to re-extract, a parse failure inside it has no
 * recovery path at all. That gap was real — chunks of exactly 9 or 10 messages
 * were under the old pre-split threshold and over the rescue ceiling, so a
 * truncated response wrote nothing and nothing tried again.
 */
export const EXTRACTION_CHUNK_MAX_MESSAGES = 8;

/**
 * Characters per sub-chunk. Message COUNT alone does not bound output: eight
 * messages at the 4,000-character wire limit are 32,000 characters of input,
 * and the facts in them cannot fit in one response. This is the real budget;
 * the message count is a secondary guard.
 *
 * The exact number is validated during ablation E2 against measured truncation
 * rates; it remains configurable so later evidence can change the budget.
 * It is an env dial (`EXTRACT_CHUNK_MAX_CHARS`) precisely so it can be tuned by
 * evidence later without touching this logic.
 */
export const EXTRACTION_CHUNK_MAX_CHARS = 6000;

function messageChars(message) {
	// The wire contract and provenance spans count Unicode scalar values. JS
	// string.length counts UTF-16 code units, so astral characters (emoji, many
	// historic scripts) otherwise consume two units during planning and one in
	// downstream source accounting. Array.from gives one deterministic unit per
	// code point without splitting a surrogate pair.
	return Array.from(String(message?.content ?? "")).length;
}

function canonicalSourceTime(value) {
	if (!value || typeof value !== "object") return null;
	return {
		epoch_ms: Number.isFinite(Number(value.epoch_ms)) ? Number(value.epoch_ms) : null,
		offset_minutes: Number.isFinite(Number(value.offset_minutes)) ? Number(value.offset_minutes) : null,
		precision: value.precision == null ? null : String(value.precision),
	};
}

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value ?? ""));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Split an accepted chunk into ordered, contiguous, bounded sub-chunks.
 *
 * Deterministic: no clock, no randomness, and only Web Crypto for the stable
 * SHA-256 identity. Given the same input it returns the same output forever,
 * which makes replay equivalence a property rather than a hope.
 */
export async function planExtractionChunks(messages, options = {}) {
	const maxMessages = Math.max(1, Number(options.maxMessages) || EXTRACTION_CHUNK_MAX_MESSAGES);
	const maxChars = Math.max(1, Number(options.maxChars) || EXTRACTION_CHUNK_MAX_CHARS);
	const input = Array.isArray(messages) ? messages : [];

	const chunks = [];
	let current = [];
	let currentChars = 0;

	const flush = () => {
		if (!current.length) return;
		chunks.push(current);
		current = [];
		currentChars = 0;
	};

	for (let messageIndex = 0; messageIndex < input.length; messageIndex += 1) {
		const message = input[messageIndex];
		const chars = messageChars(message);
		const wouldExceedCount = current.length >= maxMessages;
		// An oversized message cannot be made to fit, so it must not be allowed to
		// force an empty flush loop: it starts a sub-chunk of its own and ends it.
		const wouldExceedChars = current.length > 0 && currentChars + chars > maxChars;
		if (wouldExceedCount || wouldExceedChars) flush();
		current.push({ message, messageIndex });
		currentChars += chars;
		if (currentChars >= maxChars) flush();
	}
	flush();

	return Promise.all(chunks.map(async (group, index) => {
		const groupMessages = group.map((entry) => entry.message);
		return {
			schema: EXTRACTION_CHUNK_SCHEMA,
			index,
			messages: groupMessages,
			messageIds: groupMessages.map((message) => message?.id ?? null),
			chars: groupMessages.reduce((total, message) => total + messageChars(message), 0),
			spans: group.map(({ message, messageIndex }) => ({
				messageId: message?.id ?? null,
				messageIndex,
				startCodePoint: 0,
				endCodePoint: messageChars(message),
			})),
			key: await extractionChunkKey(groupMessages, {
				sourcePacketId: options.sourcePacketId ?? null,
				sourceTime: options.sourceTime ?? null,
			}),
		};
	}));
}

/**
 * A stable identity for one sub-chunk: its ordered message identities and their
 * content. Deterministic and dependency-free — this labels work for logs,
 * telemetry and replay equivalence, and is never used as a security boundary.
 */
export async function extractionChunkKey(messages, identity = {}) {
	const descriptor = {
		schema: EXTRACTION_CHUNK_SCHEMA,
		source_packet_id: identity.sourcePacketId == null ? null : String(identity.sourcePacketId),
		source_time: canonicalSourceTime(identity.sourceTime),
		messages: (messages ?? []).map((message, index) => ({
			index,
			id: message?.id == null ? null : String(message.id),
			role: message?.role == null ? null : String(message.role),
			content_hash: String(message?.content_hash ?? message?.content ?? ""),
			source_time: canonicalSourceTime(message?.source_time ?? message?.sourceTime),
		})),
	};
	return `chunk:v2:${await sha256Hex(JSON.stringify(descriptor))}`;
}

/**
 * Prove a plan covers its input exactly. Called on every real extraction, not
 * only in tests: a coverage break means accepted content was about to be
 * dropped, and finding that out from a counter beats finding it out from a user.
 */
export function verifyChunkCoverage(messages, chunks) {
	const input = Array.isArray(messages) ? messages : [];
	const safeChunks = Array.isArray(chunks) ? chunks : [];
	const flat = safeChunks.flatMap((chunk) => Array.isArray(chunk?.messages) ? chunk.messages : []);
	const problems = [];
	const inputCodePoints = input.reduce((total, message) => total + messageChars(message), 0);
	let coveredCodePoints = 0;
	if (flat.length !== input.length) {
		problems.push(`covered ${flat.length} of ${input.length} messages`);
	}
	for (let i = 0; i < Math.min(flat.length, input.length); i += 1) {
		if (flat[i] !== input[i]) {
			problems.push(`message ${i} is out of order or substituted`);
			break;
		}
	}
	let spanCursor = 0;
	for (const chunk of safeChunks) {
		const chunkMessages = Array.isArray(chunk?.messages) ? chunk.messages : [];
		const spans = Array.isArray(chunk?.spans) ? chunk.spans : [];
		if (spans.length !== chunkMessages.length) {
			problems.push(`chunk ${chunk?.index ?? "?"} has ${spans.length} spans for ${chunkMessages.length} messages`);
		}
		const expectedChars = chunkMessages.reduce((total, message) => total + messageChars(message), 0);
		if (chunk?.chars !== expectedChars) {
			problems.push(`chunk ${chunk?.index ?? "?"} code point count does not match its messages`);
		}
		for (let i = 0; i < Math.min(spans.length, chunkMessages.length); i += 1) {
			const span = spans[i];
			const expectedMessageIndex = spanCursor + i;
			const expectedEnd = messageChars(chunkMessages[i]);
			const start = Number(span?.startCodePoint);
			const end = Number(span?.endCodePoint);
			if (
				span?.messageId !== (chunkMessages[i]?.id ?? null) ||
				Number(span?.messageIndex) !== expectedMessageIndex ||
				start !== 0 ||
				end !== expectedEnd
			) {
				problems.push(`chunk ${chunk?.index ?? "?"} span ${i} does not exactly cover its source message`);
			}
			if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
				coveredCodePoints += end - start;
			}
		}
		spanCursor += chunkMessages.length;
	}
	if (coveredCodePoints !== inputCodePoints) {
		problems.push(`covered ${coveredCodePoints} of ${inputCodePoints} source code points`);
	}
	return {
		ok: problems.length === 0,
		inputCount: input.length,
		coveredCount: flat.length,
		inputCodePoints,
		coveredCodePoints,
		chunkCount: safeChunks.length,
		problems,
	};
}
