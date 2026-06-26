/**
 * The single ingest path, shared by the HTTP `/v1/ingest` route and the MCP
 * tools — so there is exactly ONE place that routes a user's messages through
 * their Durable Object (hold/trigger) and fires extraction. No engine logic is
 * duplicated in the MCP layer.
 *
 * Extraction ALWAYS runs in the background via ctx.waitUntil (Priority 3): the
 * Durable Object has already durably persisted the held chunk before we return,
 * so nothing is lost if the client disconnects, and we never block on the LLM.
 *
 *   - `waitBudgetMs: 0` (HTTP route): return immediately; extraction lands later.
 *   - `waitBudgetMs > 0` (manual save tools): wait up to the budget for the real
 *     receipt so the tool can show "Saved: …", but NEVER past it — that bounded
 *     wait is what replaces the old unbounded await that caused >90s timeouts.
 */

export async function ingestMessages(env, ctx, userId, messages, opts = {}) {
	const { flush = false, overrides = {}, waitBudgetMs = 0 } = opts;

	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	const { fired, held, skipped } = await stub.addMessages(userId, messages, { flush });

	let result = null;
	if (fired) {
		// One guarded promise: keep it alive past the response AND optionally race
		// it against the budget. A rejection can never surface as an unhandled error.
		const p = stub.runExtraction(userId, overrides).catch((err) => {
			console.warn(`background extraction failed user=${userId}:`, err?.message ?? err);
			return null;
		});
		ctx.waitUntil(p);
		if (waitBudgetMs > 0) {
			let timer;
			const budget = new Promise((resolve) => {
				timer = setTimeout(() => resolve(null), waitBudgetMs);
			});
			result = await Promise.race([p, budget]);
			clearTimeout(timer);
		}
	}
	return { fired, held, skipped, result };
}

/**
 * Deterministic message id from a conversation + its content, so the SAME line
 * re-sent in an overlapping batch resolves to the same id and the Durable
 * Object's de-dup (chunk + checkpoint + seen-set) skips it instead of
 * re-extracting it. Used by save_conversation when the caller omits ids.
 */
export async function stableMsgId(conversationId, content) {
	const data = new TextEncoder().encode(`${conversationId ?? "conv"}:${content ?? ""}`);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const hex = [...new Uint8Array(digest)]
		.slice(0, 12)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `msg_${hex}`;
}
