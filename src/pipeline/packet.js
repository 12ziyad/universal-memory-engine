/**
 * Build the extraction packet handed to the model. Three clearly separated parts:
 *
 *   new_slice        — the held messages; the ONLY source of new memory.
 *   bridge_context   — a few recent earlier USER messages, reference only
 *                      (to resolve "this app" -> a known node).
 *   assistant_context— recent ASSISTANT text; never learned as user memory.
 */

const BRIDGE_LIMIT = 5;
const ASSISTANT_LIMIT = 5;

export function buildPacket(chunk, recent = []) {
	const chunkIds = new Set(chunk.map((m) => m.id));

	const newSlice = chunk.map((m) => ({ id: m.id, content: m.content, ts: m.ts }));

	const bridgeContext = recent
		.filter((m) => m.role === "user" && !chunkIds.has(m.id))
		.slice(-BRIDGE_LIMIT)
		.map((m) => ({ id: m.id, content: m.content, ts: m.ts }));

	const assistantContext = recent
		.filter((m) => m.role === "assistant")
		.slice(-ASSISTANT_LIMIT)
		.map((m) => ({ id: m.id, content: m.content, ts: m.ts }));

	return {
		new_slice: newSlice,
		bridge_context: bridgeContext,
		assistant_context: assistantContext,
	};
}

/** Plain text of just the new_slice — used for keyword + semantic shortlisting. */
export function chunkText(chunk) {
	return chunk.map((m) => m.content).join("\n");
}
