/**
 * The AutoMode ingest path used by HTTP `/v1/ingest` and the existing API lane.
 * It is the one place that routes AutoMode messages through the user's Durable
 * Object (hold/trigger) and fires extraction. MCP manual saves
 * bypass this module so they cannot inspect or mutate held AutoMode state.
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

import { hashText, normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";

export async function ingestMessages(env, ctx, userId, messages, opts = {}) {
	const { flush = false, overrides = {}, waitBudgetMs = 0 } = opts;
	const optOut = messagesContainMemoryOptOut(messages);
	if (optOut.optedOut) {
		const source = overrides.source ?? opts.source ?? "ingest";
		const sourceMode = opts.sourceMode
			?? (overrides.manual
				? (source === "save_conversation" ? "manual_collect" : "manual_direct")
				: source);
		const received = (messages ?? []).filter((m) => (m?.role ?? "user") === "user").length;
		const { receipt, receiptId, summary } = await storeOptOutReceipt(env, userId, source, {
			source_mode: sourceMode,
			received,
			skipped: received || 1,
			opt_out_phrase: optOut.phrase,
		});
		return {
			fired: false,
			held: 0,
			skipped: received,
			result: { outcome: "no_write", receipt, summary },
			receipt,
			receiptId,
			summary,
			optedOut: true,
			sourcePacket: null,
		};
	}
	const normalized = await normalizeSourcePacket(userId, {
		type: opts.sourceType ?? "message_batch",
		sourceMode: opts.sourceMode ?? overrides.source ?? "ingest",
		messages,
		conversationId: opts.conversationId,
		threadId: opts.threadId,
		sourceId: opts.sourceId,
		idempotencyKey: opts.idempotencyKey,
		scope: opts.memoryScope,
	});
	const sourcePacket = await storeSourcePacket(env, normalized.packet);
	const extractionOverrides = {
		...overrides,
		meta: {
			...(overrides.meta ?? {}),
			...sourceMeta(sourcePacket),
		},
	};

	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	const { fired, held, skipped } = await stub.addMessages(userId, normalized.messages, { flush });

	let result = null;
	if (fired) {
		// One guarded promise: keep it alive past the response AND optionally race
		// it against the budget. A rejection can never surface as an unhandled error.
		const p = stub.runExtraction(userId, extractionOverrides).catch((err) => {
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
	return {
		fired,
		held,
		skipped,
		result,
		receipt: result?.receipt ?? null,
		receiptId: result?.receipt?.id ?? null,
		summary: result?.summary ?? null,
		sourcePacket,
	};
}

/**
 * Deterministic message id from a conversation + its content, so the SAME line
 * re-sent in an overlapping batch resolves to the same id and the Durable
 * Object's de-dup (chunk + checkpoint + seen-set) skips it instead of
 * re-extracting it. Used by save_conversation when the caller omits ids.
 */
export async function stableMsgId(conversationId, content) {
	const hex = await hashText(`${conversationId ?? "conv"}:${content ?? ""}`);
	return `msg_${hex.slice(0, 24)}`;
}
