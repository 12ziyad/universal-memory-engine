import { getConfig } from "../config.js";
import { linkIngestMemoryJobReceipt, storeReceipt } from "../lib/db.js";
import { reportServerError } from "../lib/report.js";
import { ingestMessages } from "./ingest.js";
import { saveConversation, saveMemory } from "./manual.js";
import { stageRestConversationPage } from "./mcp_engine.js";
import { recall, RecallLimitError, RecallScopeError, validateRecallLimit, validateRecallScope } from "./recall.js";
import { memoryV3Enabled } from "../lib/memory_v3.js";
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

function packetScope(sourcePacket, receipt = null) {
	if (!sourcePacket && !receipt) return null;
	let persisted = {};
	try { persisted = JSON.parse(receipt?.scope_json ?? "{}") ?? {}; } catch {}
	return {
		project_id: sourcePacket?.project_id ?? sourcePacket?.projectId ?? receipt?.project_id ?? persisted.project_id ?? null,
		project_name: sourcePacket?.project_name ?? sourcePacket?.projectName ?? receipt?.project_name ?? persisted.project_name ?? null,
		workspace_id: sourcePacket?.workspace_id ?? sourcePacket?.workspaceId ?? persisted.workspace_id ?? null,
		app_id: sourcePacket?.app_id ?? sourcePacket?.appId ?? persisted.app_id ?? null,
		source_scope: sourcePacket?.source_scope ?? sourcePacket?.sourceScope ?? persisted.source_scope ?? null,
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
		...((sourcePacket || receipt) ? { memory_scope: packetScope(sourcePacket, receipt) } : {}),
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
	if (meta.source_episodes_written !== undefined) {
		receipt.source_episodes_written = Number(meta.source_episodes_written ?? 0);
		receipt.source_episodes_expected = Number(meta.source_episodes_expected ?? 0);
		receipt.source_episodes_rule_filtered = Number(meta.source_episodes_rule_filtered ?? 0);
	}
	// One immutable door receipt per source packet. Concurrent exact retries
	// race on this deterministic primary key and all return the first durable
	// verdict instead of manufacturing accepted/accumulating duplicates.
	if (sourcePacket?.id) receipt.id = `receipt_door_${sourcePacket.id}`;
	const summary = formatReceipt(receipt);
	const id = await storeReceipt(env, userId, source, receipt, summary, {
		strict: true,
		managedAccess: meta.managedAccess ?? "write",
	});
	let durableReceipt = receipt;
	let durableSummary = summary;
	if (id) {
		const row = await env.DB.prepare(
			"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(id, userId).first();
		try { durableReceipt = JSON.parse(row?.detail ?? "null") ?? receipt; } catch {}
		durableSummary = row?.summary ?? summary;
		durableReceipt.id = id;
	}
	return { receipt: durableReceipt, summary: durableSummary, receipt_id: id ?? durableReceipt.id ?? null };
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
	if (res.idempotencyConflict) {
		return {
			ok: false,
			idempotencyConflict: true,
			error: "idempotency_conflict",
			http_status: 409,
			summary: res.summary ?? "That idempotency key is already owned by different content or a different operation.",
			idempotency_key: res.idempotencyKey ?? res.idempotency_key ?? null,
			source_packet_id: res.sourcePacketId ?? res.source_packet_id ?? null,
		};
	}
	// SRV-02 parity for the direct-save lane: an erased/cancelled or
	// terminally failed replay must keep its honest protocol shape here too,
	// exactly as the observe/ingest lane reports it.
	if (res.sourceEpisodeErased) {
		return {
			ok: false,
			sourceEpisodeErased: true,
			error: "source_write_erased",
			code: "source_write_erased",
			http_status: 409,
			retryable: false,
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	if (res.episodePersistenceFailed) {
		return {
			ok: false,
			episodePersistenceFailed: true,
			error: "source_episode_unavailable",
			code: "source_episode_unavailable",
			http_status: res.retryable === false ? 409 : 503,
			retryable: res.retryable !== false,
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	if (res.extractionFailedTerminal) {
		return {
			ok: false,
			extractionFailedTerminal: true,
			error: "extraction_failed_terminal",
			http_status: 422,
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	if (res.invalidIngestMessage) {
		return {
			ok: false,
			invalidIngestMessage: true,
			error: res.error ?? "invalid_ingest_message",
			code: res.code ?? "duplicate_normalized_message_id",
			http_status: res.httpStatus ?? 422,
			retryable: false,
			summary: res.summary,
		};
	}
	if (res.backpressure) {
		return {
			ok: false,
			backpressure: true,
			error: "queue_full",
			summary: "Your memory queue is full — give it a moment to catch up, then retry.",
			retry_after_s: res.retryAfterS ?? 30,
			queue_depth: res.queueDepth ?? null,
		};
	}
	// 1.10 idempotent replay: surface it, don't launder it into "ignored".
	if (res.duplicate) {
		return safeCommandResult({
			mode,
			source,
			fired: false,
			processing: Boolean(res.processing),
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
		clientSource: input.clientSource,
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
	// Legacy digest-page lane — retired from the public surface. It survives
	// ONLY behind its explicit test hook (digestResponse); scope:"summary" is
	// an ordinary conversation save on the engine + Conversation Page path.
	const managedProjectId = input.memoryScope?.managedProjectId
		?? input.memoryScope?.managed_project_id
		?? null;
	if (input.digestResponse !== undefined && !managedProjectId) {
		console.log("manual_collect (deprecated): legacy digest-page lane used");
		const res = await saveConversation(env, ctx, userId, input.messages ?? [], {
			scope: input.scope,
			n: input.n,
			topic: input.topic,
			clientSource: input.clientSource,
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
	if (managedProjectId && input.digestResponse !== undefined) {
		console.log("manual_collect (deprecated): managed project routed through guarded conversation engine");
	}

	// Fix round 1, Part 4: add_conversation IS the engine —
	// ingest(messages, flush=true) semantics, so a rich conversation produces
	// nodes AND edges instead of one flat digest page.
	const messages = applyConversationScope(input.messages ?? [], input);
	const result = await runObserveMessagesCommand(env, ctx, userId, messages, {
		flush: true,
		waitBudgetMs: Number(input.waitBudgetMs ?? getConfig(env).saveWaitBudgetMs),
		clientSource: input.clientSource,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		delivery: input.delivery,
		memoryScope: input.memoryScope,
		source: "save_conversation",
		sourceMode: "conversation_collect",
		overrides: { manual: true, ...(input.overrides ?? {}) },
	});
	if (result.backpressure) return result;
	const final = { ...result, command_mode: "conversation_collect", mode: "conversation_collect" };
	// Campaign A: an explicit conversation save also creates or advances this
	// conversation's page (CONVERSATION_PAGES="on"). The accepted save never
	// fails because of the page half — a page problem is recorded truthfully
	// on the response and reported, not swallowed.
	try {
		// The shaped command result carries only source_packet_id (the full
		// packet never leaves the server shape) — reload the row for the page
		// half. The id came from this request's own acceptance, so it is ours.
		const sourcePacket = final.source_packet_id
			? await env.DB.prepare("SELECT * FROM source_packets WHERE id = ? LIMIT 1")
				.bind(final.source_packet_id).first()
			: null;
		const page = await stageRestConversationPage(env, ctx, userId, { ...input, messages }, {
			...final,
			sourcePacket,
			duplicate: Boolean(final.duplicate ?? (final.receipt?.outcome === "duplicate") ?? false),
		});
		if (page) final.conversation_page = page;
	} catch (error) {
		final.conversation_page = { error: "conversation_page_staging_failed" };
		await reportServerError(env, "conversation_page_stage", error, userId, {
			reportId: `err_convpage_${final?.source_packet_id ?? "unknown"}`,
		}).catch(() => {});
	}
	return final;
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
		clientSource: input.clientSource,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		delivery: input.delivery,
		memoryScope: input.memoryScope,
		// BF-1: the batch-level authoritative write time, if the caller gave one.
		sourceTime: input.sourceTime,
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
	if (res.invalidIngestMessage) {
		return {
			ok: false,
			invalidIngestMessage: true,
			error: res.error ?? "invalid_ingest_message",
			code: res.code ?? "duplicate_normalized_message_id",
			http_status: res.httpStatus ?? 422,
			retryable: false,
			field: res.field ?? null,
			message_index: res.messageIndex ?? null,
			first_message_index: res.firstMessageIndex ?? null,
			summary: res.summary ?? "The message batch contains duplicate canonical message ids.",
		};
	}
	if (res.idempotencyConflict) {
		return {
			ok: false,
			idempotencyConflict: true,
			error: "idempotency_conflict",
			summary: res.summary,
			idempotency_key: res.idempotencyKey ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	if (res.episodePersistenceFailed) {
		return {
			ok: false,
			episodePersistenceFailed: true,
			error: "source_episode_unavailable",
			code: "source_episode_unavailable",
			http_status: res.retryable === false ? 409 : 503,
			retry_after_s: res.retryable === false ? null : 5,
			retryable: res.retryable !== false,
			outcome: res.episodeOutcome ?? "unknown",
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	if (res.sourceEpisodeErased) {
		return {
			ok: false,
			sourceEpisodeErased: true,
			error: "source_write_erased",
			code: "source_write_erased",
			http_status: 409,
			retryable: false,
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}
	// SRV-02: a replay of permanently failed extraction must never look like an
	// acceptance — callers rely on acceptance to release their durable local copy.
	if (res.extractionFailedTerminal) {
		return {
			ok: false,
			extractionFailedTerminal: true,
			error: "extraction_failed_terminal",
			summary: res.summary,
			job_id: res.jobId ?? null,
			source_packet_id: res.sourcePacketId ?? null,
		};
	}

	const episodeMeta = res.episodeResult ? {
		source_episodes_written: Number(res.episodeResult.written ?? 0),
		source_episodes_expected: Number(res.episodeResult.expected ?? 0),
		source_episodes_rule_filtered: Number(res.episodeResult.ruleFiltered ?? 0),
	} : {};
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
					...episodeMeta,
				},
			);
			receipt = accepted.receipt;
			summary = accepted.summary;
			id = accepted.receipt_id;
			processing = true;
		} else if (res.held > 0) {
			const stored = await storeStatusReceipt(
				env,
				userId,
				res.sourcePacket,
				"accumulating",
				"learning trigger is accumulating more context",
				source,
				{
					received: (messages ?? []).length,
					held: res.held,
					skipped: res.skipped,
					...episodeMeta,
				},
			);
			receipt = stored.receipt;
			summary = stored.summary;
			id = stored.receipt_id;
		} else if (res.duplicate) {
			const stored = await storeStatusReceipt(env, userId, res.sourcePacket, "duplicate", "this exact content was already accepted (idempotent replay)", source, {
				received: (messages ?? []).length,
				skipped: res.skipped,
				status: res.jobStatus ?? null,
				...episodeMeta,
			});
			receipt = stored.receipt;
			summary = res.summary ?? stored.summary;
			id = stored.receipt_id;
		} else {
			const stored = await storeStatusReceipt(env, userId, res.sourcePacket, "ignored", "no durable learning signal found", source, {
				received: (messages ?? []).length,
				held: res.held,
				skipped: res.skipped,
				...episodeMeta,
			});
			receipt = stored.receipt;
			summary = stored.summary;
			id = stored.receipt_id;
		}
	}

	// Link only a same-packet receipt valid for the job's current lifecycle.
	// The compare-and-set cannot replace a terminal engine receipt, and a
	// duplicate/unknown terminal replay never becomes the canonical verdict.
	if (res.jobId && id) {
		try {
			await linkIngestMemoryJobReceipt(env, userId, res.jobId, {
				receiptId: id,
				sourcePacketId: res.sourcePacket?.id ?? null,
				outcome: receipt?.outcome ?? null,
				terminalReplay: Boolean(res.terminalReplay),
				duplicate: Boolean(res.duplicate),
			});
		}
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
			...episodeMeta,
		},
	});
}

export async function runRecallCommand(env, userId, query, input = {}) {
	// BF-2: the depth budget is validated HERE, in the shared facade, so every
	// door — REST, MCP, SDK — gets the same answer. It reaches `recall()` from
	// this point on; it used to stop at the handler and vanish.
	let limit;
	try {
		limit = validateRecallLimit(input.limit);
	} catch (error) {
		if (error instanceof RecallLimitError || error?.name === "RecallLimitError") {
			return {
				ok: false,
				command_mode: "recall",
				mode: "recall",
				source: "recall",
				error: error.code ?? "invalid_limit",
				code: error.code ?? "invalid_limit",
				http_status: Number(error.status ?? 400),
				summary: String(error.message),
				source_packet_id: null,
				receipt_id: null,
				receipt: null,
				counts: { received: 1, items: 0, nodes: 0, pages: 0, savedTotal: 0 },
			};
		}
		throw error;
	}
	// Narrowing is safe on any architecture; widening changes retrieval depth,
	// which is V3 behaviour and stays behind the flag.
	const limitMode = memoryV3Enabled(env, userId, input.memoryScope) ? "depth" : "narrow";
	try {
		validateRecallScope(userId, {
			memoryScope: input.memoryScope,
			recallScope: input.recallScope,
		});
	} catch (error) {
		if (error instanceof RecallScopeError || error?.name === "RecallScopeError") {
			const scope = packetScope(input.memoryScope ?? null);
			return {
				ok: false,
				command_mode: "recall",
				mode: "recall",
				source: "recall",
				error: error.code ?? "invalid_recall_scope",
				code: error.code ?? "invalid_recall_scope",
				http_status: Number(error.status ?? 400),
				summary: String(error.message ?? "The requested memory scope is invalid."),
				source_packet_id: null,
				receipt_id: null,
				receipt: null,
				memory_scope: scope,
				counts: { received: 1, items: 0, nodes: 0, pages: 0, savedTotal: 0 },
			};
		}
		throw error;
	}
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
	// The query is retrieval input, not memory content. Keep it transient for
	// recall while persisting only its cryptographic identity and content-free
	// routing metadata. This prevents a question containing forbidden/private
	// text from becoming a second durable copy in source provenance.
	const contentFreeQueryPacket = {
		...normalized.packet,
		content_preview: null,
		message_count: 0,
		raw_meta_json: JSON.stringify({
			query_content_free: true,
			session_id_explicit: Boolean(normalized.packet.session_id_explicit),
			account_user_id: normalized.packet.account_user_id ?? null,
			managed_project_id: normalized.packet.managed_project_id ?? null,
		}),
		messages: [],
	};
	const sourcePacket = await storeSourcePacket(env, contentFreeQueryPacket, {
		// A confirmed erasure keeps content-free source-packet fences so accepted
		// writes cannot replay. Read queries are different: repeating the same
		// query is a new post-erasure operation and may safely replace only its own
		// erased query/recall row.
		allowErasedReadReplacement: true,
		managedAccess: "read",
	});
	if (sourcePacket?.idempotency_conflict) {
		return {
			ok: false,
			command_mode: "recall",
			mode: "recall",
			source: "recall",
			error: "idempotency_conflict",
			code: "idempotency_conflict",
			http_status: 409,
			summary: "That idempotency key is already owned by different content or a different operation. Use a new key.",
			source_packet_id: sourcePacket.id ?? null,
			receipt_id: null,
			receipt: null,
			counts: { received: 1, items: 0, nodes: 0, pages: 0, savedTotal: 0 },
		};
	}
	const startedAt = Date.now();
	// Recall is metered separately from a save: it is the other half of "what
	// does this cost", and it runs a different (much smaller) set of calls.
	let metered;
	try {
		metered = await withAiMeter("recall", async (meter) => {
			tagAiMeter(sourcePacket?.id ?? null);
			const value = await recall(env, getConfig(env), userId, query, {
				memoryScope: input.memoryScope,
				recallScope: input.recallScope,
				recallMode: input.recallMode,
				limit,
				limitMode,
				// E8: cross-encoder reranking. V3 accounts only — it costs a model
				// call per recall, so it can never switch on for a legacy account.
				rerank: limitMode === "depth" && input.rerank === true,
				rerankKeep: input.rerankKeep,
			});
			return {
				result: value,
				aiTotals: await flushAiMeter(env, userId, meter, {
					accountUserId: sourceMeta(sourcePacket).account_user_id,
					managedProjectId: sourceMeta(sourcePacket).managed_project_id,
					managedAccess: "read",
				}),
			};
		});
	} catch (error) {
		if (error instanceof RecallScopeError || error?.name === "RecallScopeError") {
			return {
				ok: false,
				command_mode: "recall",
				mode: "recall",
				source: "recall",
				error: error.code ?? "invalid_recall_scope",
				code: error.code ?? "invalid_recall_scope",
				http_status: Number(error.status ?? 400),
				summary: String(error.message ?? "The requested memory scope is invalid."),
				source_packet_id: sourcePacket?.id ?? null,
				receipt_id: null,
				receipt: null,
				memory_scope: packetScope(sourcePacket),
				counts: { received: 1, items: 0, nodes: 0, pages: 0, savedTotal: 0 },
			};
		}
		throw error;
	}
	const { result, aiTotals } = metered;
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
		managedAccess: "read",
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
			// The durable receipt is intentionally immutable per source packet. An
			// exact repeated query therefore returns the first receipt's latency,
			// which is audit history rather than this invocation's timing. Expose the
			// current measurement separately so callers and quality gates never read
			// stale performance telemetry.
			recall_latency_ms: latencyMs,
			recall_scope: input.recallScope ?? "global",
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
