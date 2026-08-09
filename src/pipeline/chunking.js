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

export const EXTRACTION_CHUNK_SCHEMA = "itsuki.extraction-chunk/v1";

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
 * The exact number is not yet validated against measured truncation rates —
 * that is ablation E2, which needs inference and is blocked by the cost gate.
 * It is an env dial (`EXTRACT_CHUNK_MAX_CHARS`) precisely so it can be tuned by
 * evidence later without touching this logic.
 */
export const EXTRACTION_CHUNK_MAX_CHARS = 6000;

function messageChars(message) {
	return String(message?.content ?? "").length;
}

/**
 * Split an accepted chunk into ordered, contiguous, bounded sub-chunks.
 *
 * Pure and synchronous: no clock, no randomness, no I/O. Given the same input
 * it returns the same output forever, which is what makes replay equivalence a
 * property rather than a hope.
 */
export function planExtractionChunks(messages, options = {}) {
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

	for (const message of input) {
		const chars = messageChars(message);
		const wouldExceedCount = current.length >= maxMessages;
		// An oversized message cannot be made to fit, so it must not be allowed to
		// force an empty flush loop: it starts a sub-chunk of its own and ends it.
		const wouldExceedChars = current.length > 0 && currentChars + chars > maxChars;
		if (wouldExceedCount || wouldExceedChars) flush();
		current.push(message);
		currentChars += chars;
		if (currentChars >= maxChars) flush();
	}
	flush();

	return chunks.map((group, index) => ({
		schema: EXTRACTION_CHUNK_SCHEMA,
		index,
		messages: group,
		messageIds: group.map((message) => message?.id ?? null),
		chars: group.reduce((total, message) => total + messageChars(message), 0),
		key: extractionChunkKey(group),
	}));
}

/**
 * A stable identity for one sub-chunk: its ordered message identities and their
 * content. Deterministic and dependency-free — this labels work for logs,
 * telemetry and replay equivalence, and is never used as a security boundary.
 */
export function extractionChunkKey(messages) {
	let hash = 0x811c9dc5;
	const write = (text) => {
		const value = String(text ?? "");
		for (let i = 0; i < value.length; i += 1) {
			hash ^= value.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		hash ^= 0x1f;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	};
	for (const message of messages ?? []) {
		write(message?.id);
		write(message?.role);
		write(message?.content_hash ?? message?.content);
	}
	return `chunk:v1:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Prove a plan covers its input exactly. Called on every real extraction, not
 * only in tests: a coverage break means accepted content was about to be
 * dropped, and finding that out from a counter beats finding it out from a user.
 */
export function verifyChunkCoverage(messages, chunks) {
	const input = Array.isArray(messages) ? messages : [];
	const flat = chunks.flatMap((chunk) => chunk.messages);
	const problems = [];
	if (flat.length !== input.length) {
		problems.push(`covered ${flat.length} of ${input.length} messages`);
	}
	for (let i = 0; i < Math.min(flat.length, input.length); i += 1) {
		if (flat[i] !== input[i]) {
			problems.push(`message ${i} is out of order or substituted`);
			break;
		}
	}
	return {
		ok: problems.length === 0,
		inputCount: input.length,
		coveredCount: flat.length,
		chunkCount: chunks.length,
		problems,
	};
}
