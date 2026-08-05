import { getConfig } from "../config.js";
import { storeReceipt, updateMemoryJob } from "../lib/db.js";
import { ingestMessages } from "./ingest.js";
import { saveConversation, saveMemory } from "./manual.js";
import { recall } from "./recall.js";
import { emptyReceipt, formatReceipt, replaySummary } from "./receipt.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { flushAiMeter, tagAiMeter, withAiMeter } from "../lib/ai_meter.js";

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
		latency_ms: meta.latency_ms,
		matched: meta.matched,
		ai: meta.ai,
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
	// 1.10 idempotent replay: surface it, don't launder it into "ignored".
	if (res.duplicate) {
		return safeCommandResult({
			mode,
			source,
			fired: false,
			processing: false,
			summary: replaySummary(res.receipt, res.summary),
			receipt: res.receipt ?? null,
			receipt_id: res.receipt_id ?? null,
			sourcePacket: res.sourcePacket ?? sourcePacket,
			counts: { received: meta.received ?? 1, skipped: 1 },
			extra: { duplicate: true },
		});
	}
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

/**
 * lastN/topic narrowing — cheap, deterministic, honored at the door before
 * the engine sees anything. (Local copy: the MCP server has the same helper,
 * but it imports this module, so sharing would be a cycle.)
 */
function applyConversationScope(messages, { scope, n, topic }) {
	let out = messages ?? [];
	if (scope === "lastN" && Number(n) > 0) out = out.slice(-Number(n));
	const topicText = scope === "topic" || topic ? String(topic ?? "").trim() : "";
	if (topicText) {
		const wanted = topicText.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
		if (wanted.length) {
			out = out.filter((m) =>
				(m?.role ?? "user") !== "user"
				|| wanted.some((t) => String(m?.content ?? "").toLowerCase().includes(t)));
		}
	}
	return out;
}

export async function runConversationCollectCommand(env, ctx, userId, input = {}) {
	// Legacy digest-page lane — deprecated alias. Reachable through its test
	// hook and through scope:"summary" (a page-producing feature by
	// definition; the engine path has no flat-page concept to map it onto).
	if (input.digestResponse !== undefined || input.scope === "summary") {
		console.log("manual_collect (deprecated): legacy digest-page lane used");
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

	// Fix round 1, Part 4: add_conversation IS the engine —
	// ingest(messages, flush=true) semantics, so a rich conversation produces
	// nodes AND edges instead of one flat digest page.
	const messages = applyConversationScope(input.messages ?? [], input);
	const result = await runObserveMessagesCommand(env, ctx, userId, messages, {
		flush: true,
		waitBudgetMs: Number(input.waitBudgetMs ?? getConfig(env).saveWaitBudgetMs),
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		memoryScope: input.memoryScope,
		source: "save_conversation",
		sourceMode: "conversation_collect",
		overrides: { manual: true, ...(input.overrides ?? {}) },
	});
	if (result.backpressure) return result;
	return { ...result, command_mode: "conversation_collect", mode: "conversation_collect" };
}

export async function runObserveMessagesCommand(env, ctx, userId, messages, input = {}) {
	const source = input.source ?? "ingest";
	const sourceMode = input.sourceMode ?? source;
	const res = await ingestMessages(env, ctx, userId, messages, {
		flush: Boolean(input.flush),
		// Callers that show the result to a human (the playground) may wait a
		// bounded time for the real receipt. Default 0 keeps every other caller
		// on the fire-and-forget path exactly as before.
		waitBudgetMs: Number(input.waitBudgetMs ?? 0),
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		memoryScope: input.memoryScope,
		sourceMode,
		overrides: { source, ...(input.overrides ?? {}) },
	});

	// 1.7: too much unprocessed work for this user — surface a clear 429
	// upstream instead of accepting invisibly.
	if (res.backpressure) {
		return {
			ok: false,
			backpressure: true,
			error: "queue_full",
			retry_after_s: res.retryAfterS ?? 30,
			queue_depth: res.queueDepth ?? null,
			summary: "Your memory queue is full — give it a moment to catch up, then retry.",
		};
	}

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
		} else if (res.duplicate) {
			const stored = await storeStatusReceipt(env, userId, res.sourcePacket, "duplicate", "this exact content was already accepted (idempotent replay)", source, {
				received: (messages ?? []).length,
				skipped: res.skipped,
				status: res.jobStatus ?? null,
			});
			receipt = stored.receipt;
			summary = res.summary ?? stored.summary;
			id = stored.receipt_id;
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

	// Link the receipt onto the accept-time job row so the packet id → job →
	// receipt chain is walkable from the status endpoint.
	if (res.jobId && id && !res.duplicate) {
		try { await updateMemoryJob(env, userId, res.jobId, { receiptId: id }); }
		catch (error) { console.warn("job receipt link failed:", error?.message ?? error); }
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
			...(res.jobId ? { job_id: res.jobId } : {}),
			...(res.queueDepth != null ? { queue_depth: res.queueDepth } : {}),
			...(res.duplicate ? { duplicate: true } : {}),
		},
	});
}

export async function runRecallCommand(env, userId, query, input = {}) {
	// Per-user recall limit (fails open when the binding is absent). One
	// scripted user must not burn a year of inference credit — and the refusal
	// is a friendly message, never an error.
	try {
		if (env.RECALL_LIMITER?.limit) {
			const { success } = await env.RECALL_LIMITER.limit({ key: String(userId ?? "anon") });
			if (success === false) {
				return safeCommandResult({
					mode: "recall",
					source: "recall",
					summary: "You're looking things up very quickly — give it a few seconds and try again.",
					counts: { received: 1 },
					extra: {
						recall_mode: "rate_limited",
						recall_status: "rate_limited",
						context: "",
						items: [],
						count: 0,
						nodes: [],
						pages: [],
					},
				});
			}
		}
	} catch (error) {
		console.warn("recall limiter unavailable:", error?.message ?? error);
	}
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
	const startedAt = Date.now();
	// Recall is metered separately from a save: it is the other half of "what
	// does this cost", and it runs a different (much smaller) set of calls.
	const { result, aiTotals } = await withAiMeter("recall", async (meter) => {
		tagAiMeter(sourcePacket?.id ?? null);
		const value = await recall(env, getConfig(env), userId, query, {
			memoryScope: input.memoryScope,
		});
		return { result: value, aiTotals: await flushAiMeter(env, userId, meter) };
	});
	const latencyMs = Date.now() - startedAt;

	// Honest reads during async saves: if this user has a staged MCP save that
	// has not enriched yet, say so — the caller must never conclude "not saved"
	// from a lookup that raced the background phase. Best-effort, indexed, and
	// never able to fail the recall.
	let processingNote = null;
	try {
		// Every lane has accept-time job rows now (Part 1.1), so the honest-read
		// note covers all of them, not just MCP staging.
		const staged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND type IN ('mcp_enrich', 'extract') AND status IN ('staged', 'queued', 'processing') AND created_at > ?",
		).bind(userId, Date.now() - 15 * 60 * 1000).first();
		if ((staged?.n ?? 0) > 0) {
			// 8.2: when staged text already answered, say what is actually true —
			// the content is here, its relationships are still being worked out.
			// "Still processing" alongside the answer reads as a non-answer.
			processingNote = result.staged_used
				? "Some of this was saved moments ago; its connections are still being worked out."
				: "A recent save is still processing — some facts may not appear yet.";
			if (typeof result.context === "string" && result.context.trim()) {
				result.context = `${result.context}\n\n(${processingNote})`;
			}
		}
	} catch (error) {
		console.warn("staged-job recall check failed:", error?.message ?? error);
	}

	const outcome = result.recall_mode === "no_recall" ? "no_recall" : "recalled";
	const reason = result.recall_mode === "no_recall"
		? "recall gate skipped memory lookup"
		: "bounded recall completed";
	const stored = await storeStatusReceipt(env, userId, sourcePacket, outcome, reason, "recall", {
		received: 1,
		latency_ms: latencyMs,
		matched: Number(result.count ?? 0),
		ai: aiTotals,
	});
	const baseSummary = result.count ? "Found relevant memory." : "No relevant memory found.";
	const summary = processingNote ? `${baseSummary} ${processingNote}` : baseSummary;
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
			processing_note: processingNote,
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
