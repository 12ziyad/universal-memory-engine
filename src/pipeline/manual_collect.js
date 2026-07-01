import { getConfig } from "../config.js";
import { createExtractionRun, storeReceipt, updateExtractionRun } from "../lib/db.js";
import { normalizeLabel } from "../lib/text.js";
import { digestConversation } from "./digest.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { filterDigestByTopic, parseCollectIntent, saveMemoryPage } from "./pages.js";

/**
 * Path A2: manual_collect.
 *
 * A chat/summary/topic collect becomes one readable memory page. It does not run
 * normal graph extraction, so weak related concepts stay inside the page instead
 * of becoming nodes/candidates.
 */
export async function saveConversation(env, ctx, userId, messages, opts = {}) {
	const config = getConfig(env);
	const received = (messages ?? []).length;
	const intent = parseCollectIntent(messages ?? [], opts);

	const { digest, keptLines } = await digestConversation(env, config, messages ?? [], opts);
	const filteredDigest = filterDigestByTopic(digest, intent);
	const filteredLines = filteredDigest ? filteredDigest.split("\n").filter((line) => line.trim()).length : 0;

	if (!filteredDigest || !filteredDigest.trim()) {
		const runId = await createExtractionRun(env, userId, {
			toolName: "save_conversation",
			sourceMode: "manual_collect",
			topicFilter: intent.topic ? normalizeLabel(intent.topic) : null,
			status: "skipped",
			skippedObjects: [{ kind: "memory_page", reason: "no durable facts in this chat" }],
		});
		const receipt = emptyReceipt("meaningful_no_write", "no durable facts in this chat (chatter/questions only)", {
			source: "save_conversation",
			source_mode: "manual_collect",
			received,
			digested: filteredLines,
		});
		receipt.extraction_run_id = runId;
		const summary = `Received ${received} message(s). ${formatReceipt(receipt)} Receipt: ${runId}`;
		await storeReceipt(env, userId, "save_conversation", receipt, summary);
		await updateExtractionRun(env, userId, runId, { status: "skipped" });
		return { fired: false, processing: false, summary, receipt };
	}

	return saveMemoryPage(env, userId, {
		digest: filteredDigest,
		messages: messages ?? [],
		intent,
		received,
		keptLines: filteredLines || keptLines,
		conversationId: opts.conversationId,
	});
}
