import { getConfig } from "../config.js";
import { storeReceipt } from "../lib/db.js";
import { ingestMessages } from "./ingest.js";
import { saveConversation, saveMemory } from "./manual.js";
import { recall } from "./recall.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";

function receiptId(receipt, fallback = null) {
	return receipt?.id ?? fallback ?? null;
}

function packetId(sourcePacket, receipt = null) {
	return receipt?.source_packet_id ?? sourcePacket?.id ?? null;
}

function receiptCounts(receipt, extras = {}) {
	const saved = receipt?.saved ?? {};
	return {
		received: receipt?.received ?? extras.received ?? null,
		held: extras.held ?? null,
		skipped: receipt?.skipped ?? extras.skipped ?? 0,
		savedTotal: receipt?.savedTotal ?? 0,
		pages: saved.pages ?? 0,
		nodes: saved.nodes ?? 0,
		slices: saved.slices ?? 0,
		events: saved.events ?? 0,
		edges: saved.edges ?? 0,
		candidates: saved.candidates ?? 0,
	};
}

function safeCommandResult({
	mode,
	source,
	fired = false,
	processing = false,
	summary,
	receipt = null,
	receipt_id = null,
	sourcePacket = null,
	counts = {},
	extra = {},
}) {
	const finalReceiptId = receiptId(receipt, receipt_id);
	const finalSourcePacketId = packetId(sourcePacket, receipt);
	return {
		ok: true,
		command_mode: mode,
		mode,
		source,
		fired: Boolean(fired),
		processing: Boolean(processing),
		summary: summary ?? (receipt ? formatReceipt(receipt) : ""),
		source_packet_id: finalSourcePacketId,
		receipt_id: finalReceiptId,
		receipt,
		counts: receiptCounts(receipt, counts),
		...extra,
	};
}

async function storeStatusReceipt(env, userId, sourcePacket, outcome, reason, source, meta = {}) {
	const receipt = emptyReceipt(outcome, reason, {
		source,
		source_mode: sourcePacket?.source_mode ?? meta.source_mode ?? null,
		...sourceMeta(sourcePacket),
		received: meta.received,
		skipped: meta.skipped,
	});
	if (meta.processing !== undefined) receipt.processing = Boolean(meta.processing);
	if (meta.final !== undefined) receipt.final = Boolean(meta.final);
	if (meta.status) receipt.status = meta.status;
	const summary = formatReceipt(receipt);
	const id = await storeReceipt(env, userId, source, receipt, summary);
	if (id) receipt.id = id;
	return { receipt, summary, receipt_id: id ?? receipt.id ?? null };
}

function saveResponse(mode, source, res, env, userId, sourcePacketHint = null, meta = {}) {
	return {
		mode,
		source,
		res,
		env,
		userId,
		sourcePacket: res.sourcePacket ?? sourcePacketHint ?? null,
		meta,
	};
}

async function finalizeSaveResponse({ mode, source, res, env, userId, sourcePacket, meta = {} }) {
	let receipt = res.receipt ?? null;
	let summary = res.summary ?? null;
	let id = res.receipt_id ?? receipt?.id ?? null;

	if (!receipt && res.processing) {
		const stored = await storeStatusReceipt(env, userId, sourcePacket, "accepted", "extraction accepted and processing", source, {
			received: meta.received ?? 1,
			processing: true,
			final: false,
			status: "processing",
		});
		receipt = stored.receipt;
		summary = stored.summary;
		id = stored.receipt_id;
	}

	if (!receipt) {
		const stored = await storeStatusReceipt(env, userId, sourcePacket, "ignored", "nothing durable here (chatter, a question, or a duplicate)", source, {
			received: meta.received ?? 1,
			skipped: 1,
		});
		receipt = stored.receipt;
		summary = summary ?? stored.summary;
		id = stored.receipt_id;
	}

	return safeCommandResult({
		mode,
		source,
		fired: res.fired,
		processing: res.processing,
		summary,
		receipt,
		receipt_id: id,
		sourcePacket,
		counts: { received: receipt?.received ?? null },
	});
}

export async function runDirectSaveCommand(env, ctx, userId, input = {}) {
	const res = await saveMemory(env, ctx, userId, input.content, {
		recentContext: input.recentContext,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		memoryScope: input.memoryScope,
		overrides: input.overrides,
		waitBudgetMs: input.waitBudgetMs,
	});
	return finalizeSaveResponse(saveResponse("direct_save", "save_memory", res, env, userId, null, { received: 1 }));
}

export async function runConversationCollectCommand(env, ctx, userId, input = {}) {
	const res = await saveConversation(env, ctx, userId, input.messages ?? [], {
		scope: input.scope,
		n: input.n,
		topic: input.topic,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		memoryScope: input.memoryScope,
		overrides: input.overrides,
		digestResponse: input.digestResponse,
	});
	return finalizeSaveResponse(saveResponse("conversation_collect", "save_conversation", res, env, userId, null, {
		received: (input.messages ?? []).length,
	}));
}

export async function runObserveMessagesCommand(env, ctx, userId, messages, input = {}) {
	const source = input.source ?? "ingest";
	const sourceMode = input.sourceMode ?? source;
	const res = await ingestMessages(env, ctx, userId, messages, {
		flush: Boolean(input.flush),
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		memoryScope: input.memoryScope,
		sourceMode,
		overrides: { source, ...(input.overrides ?? {}) },
	});

	let receipt = res.receipt ?? null;
	let summary = res.summary ?? null;
	let id = res.receiptId ?? receipt?.id ?? null;
	let processing = false;

	if (!receipt) {
		if (res.fired) {
			const accepted = await storeStatusReceipt(
				env,
				userId,
				res.sourcePacket,
				"accepted",
				"extraction accepted and processing",
				source,
				{
					received: (messages ?? []).length,
					held: res.held,
					skipped: res.skipped,
					processing: true,
					final: false,
					status: "processing",
				},
			);
			receipt = accepted.receipt;
			summary = accepted.summary;
			id = accepted.receipt_id;
			processing = true;
		} else {
			const outcome = res.held > 0 ? "accumulating" : "ignored";
			const reason = res.held > 0
				? "learning trigger is accumulating more context"
				: "no durable learning signal found";
			const stored = await storeStatusReceipt(env, userId, res.sourcePacket, outcome, reason, source, {
				received: (messages ?? []).length,
				held: res.held,
				skipped: res.skipped,
			});
			receipt = stored.receipt;
			summary = stored.summary;
			id = stored.receipt_id;
		}
	}

	return safeCommandResult({
		mode: "observe_messages",
		source,
		fired: res.fired,
		processing,
		summary,
		receipt,
		receipt_id: id,
		sourcePacket: res.sourcePacket,
		counts: {
			received: (messages ?? []).length,
			held: res.held,
			skipped: res.skipped,
		},
		extra: {
			received: true,
			held: res.held,
			skipped: res.skipped,
		},
	});
}

export async function runRecallCommand(env, userId, query, input = {}) {
	const normalized = await normalizeSourcePacket(userId, {
		type: "query",
		sourceMode: "recall",
		content: query,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		threadId: input.threadId,
		conversationId: input.conversationId,
		topic: input.topic,
		scope: input.memoryScope,
	});
	const sourcePacket = await storeSourcePacket(env, normalized.packet);
	const result = await recall(env, getConfig(env), userId, query, {
		memoryScope: input.memoryScope,
	});
	const outcome = result.recall_mode === "no_recall" ? "no_recall" : "recalled";
	const reason = result.recall_mode === "no_recall"
		? "recall gate skipped memory lookup"
		: "bounded recall completed";
	const stored = await storeStatusReceipt(env, userId, sourcePacket, outcome, reason, "recall", {
		received: 1,
	});
	const summary = result.count ? "Found relevant memory." : "No relevant memory found.";
	const { mode: recallStatus, ok: _ok, ...recallDetails } = result;
	return safeCommandResult({
		mode: "recall",
		source: "recall",
		fired: false,
		processing: false,
		summary,
		receipt: stored.receipt,
		receipt_id: stored.receipt_id,
		sourcePacket,
		counts: { received: 1 },
		extra: {
			...recallDetails,
			recall_mode: result.recall_mode,
			recall_status: recallStatus,
			status: stored.receipt?.outcome ?? outcome,
			counts: {
				received: 1,
				items: result.count,
				nodes: result.nodes?.length ?? 0,
				pages: result.pages?.length ?? 0,
			},
		},
	});
}
