import { getConfig } from "../config.js";
import {
	claimMemoryJob,
	createExtractionRun,
	getActiveSuppressions,
	storeReceipt,
	updateExtractionRun,
	updateMemoryJob,
} from "../lib/db.js";
import { canonicalMemoryScope, normalizeProjectScope } from "../lib/project_scope.js";
import { normalizeLabel } from "../lib/text.js";
import { digestConversation } from "./digest.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { filterDigestByTopic, parseCollectIntent, saveMemoryPage, suppressedBy } from "./pages.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { scrubMessages } from "./scrub.js";

const MANUAL_COLLECT_LEASE_MS = 2 * 60 * 1000;

async function manualCollectReceipt(env, userId, sourcePacketId, receiptId = null) {
	const row = receiptId
		? await env.DB.prepare(
			"SELECT id, detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(receiptId, userId).first()
		: await env.DB.prepare(
			`SELECT id, detail, summary FROM receipts
			 WHERE user_id = ? AND source_packet_id = ?
			 ORDER BY created_at DESC LIMIT 1`,
		).bind(userId, sourcePacketId).first();
	let receipt = null;
	try { receipt = JSON.parse(row?.detail ?? "null"); } catch {}
	if (receipt && row?.id) receipt.id = row.id;
	return { row, receipt };
}

function manualCollectReplay(sourcePacket, stored = {}) {
	return {
		fired: false,
		processing: !stored.receipt,
		duplicate: true,
		summary: stored.row?.summary ?? "This exact conversation is already accepted and processing.",
		receipt: stored.receipt ?? null,
		receipt_id: stored.row?.id ?? null,
		sourcePacket,
	};
}

/**
 * Path A2: manual_collect.
 *
 * A chat/summary/topic collect becomes one readable memory page. It does not run
 * normal graph extraction, so weak related concepts stay inside the page instead
 * of becoming nodes/candidates.
 */
export async function saveConversation(env, ctx, userId, rawMessages, opts = {}) {
	const config = getConfig(env);
	const memoryScope = canonicalMemoryScope(opts.memoryScope);
	if (memoryScope.managedProjectId ?? memoryScope.managed_project_id) {
		const error = new Error(
			"The deprecated digest-page collector is unavailable for managed projects; use the guarded conversation engine.",
		);
		error.name = "ManagedManualCollectDisabledError";
		error.code = "managed_manual_collect_disabled";
		error.status = 409;
		throw error;
	}
	const projectScope = normalizeProjectScope(memoryScope);
	// The digest model reads these messages directly — scrub before it can.
	const messages = scrubMessages(rawMessages).messages;
	const optOut = messagesContainMemoryOptOut(messages);
	if (optOut.optedOut) {
		const received = (messages ?? []).filter((m) => (m?.role ?? "user") === "user").length;
		const { receipt, summary } = await storeOptOutReceipt(env, userId, "save_conversation", {
			source_mode: "manual_collect",
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
			received,
			skipped: received || 1,
			opt_out_phrase: optOut.phrase,
		});
		return { fired: false, processing: false, summary, receipt };
	}
	const normalized = await normalizeSourcePacket(userId, {
		type: "message_batch",
		sourceMode: "manual_collect",
		clientSource: opts.clientSource,
		messages,
		conversationId: opts.conversationId,
		threadId: opts.threadId,
		sourceId: opts.sourceId,
		idempotencyKey: opts.idempotencyKey,
		scope: memoryScope,
	});
	// The public idempotency namespace is account-wide. Reject another job
	// lane before creating even a source-only artifact under its key.
	const existingJobOwner = await env.DB.prepare(
		"SELECT type, source_packet_id FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
	).bind(userId, normalized.packet.idempotency_key).first();
	if (existingJobOwner && existingJobOwner.type !== "manual_collect") {
		return {
			idempotencyConflict: true,
			idempotencyKey: normalized.packet.idempotency_key,
			sourcePacketId: existingJobOwner.source_packet_id ?? null,
			summary: "That idempotency key is already owned by different content or a different operation. Use a new key.",
		};
	}
	const sourcePacket = await storeSourcePacket(env, normalized.packet);
	if (sourcePacket?.idempotency_conflict) {
		return {
			idempotencyConflict: true,
			idempotencyKey: normalized.packet.idempotency_key,
			sourcePacketId: sourcePacket.id ?? null,
			summary: "That idempotency key is already owned by different content or a different operation. Use a new key.",
		};
	}
	const source = sourceMeta(sourcePacket);
	const jobPayload = {
		lane: "manual_collect",
		project_id: projectScope.projectId,
		project_name: projectScope.projectName,
	};
	const jobClaim = await claimMemoryJob(env, userId, {
		type: "manual_collect",
		status: "processing",
		idempotencyKey: source.idempotency_key,
		sourcePacketId: source.source_packet_id,
		payload: jobPayload,
	});
	if (jobClaim.capacityExceeded) {
		return { backpressure: true, queueDepth: jobClaim.activeLimit, retryAfterS: 30 };
	}
	const job = await env.DB.prepare(
		`SELECT id, type, status, receipt_id, source_packet_id, updated_at
		 FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1`,
	).bind(jobClaim.id, userId).first();
	if (!job || job.type !== "manual_collect" || job.source_packet_id !== source.source_packet_id) {
		return {
			idempotencyConflict: true,
			idempotencyKey: source.idempotency_key,
			sourcePacketId: source.source_packet_id,
			summary: "That idempotency key is already owned by different content or a different operation. Use a new key.",
		};
	}
	if (!jobClaim.claimed) {
		const stored = await manualCollectReceipt(env, userId, source.source_packet_id);
		if (stored.receipt) {
			const receiptPageId = stored.receipt.page_id
				?? stored.receipt.actions?.createdPages?.[0]?.id
				?? stored.receipt.actions?.updatedPages?.[0]?.id
				?? stored.receipt.actions?.reinforcedPages?.[0]?.id
				?? null;
			const page = receiptPageId
				? await env.DB.prepare(
					`SELECT id, title, canonical_title, topic_filter, deleted_at
					 FROM memory_pages WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1`,
				).bind(receiptPageId, userId, projectScope.projectId).first()
				: null;
			if (page?.deleted_at && stored.receipt.outcome !== "suppressed") {
				const suppressions = await getActiveSuppressions(env, userId, { projectId: projectScope.projectId });
				const suppression = suppressedBy(suppressions, "memory_page", page.canonical_title)
					?? (page.topic_filter ? suppressedBy(suppressions, "memory_page", page.topic_filter) : null);
				if (suppression) {
					const receipt = emptyReceipt("suppressed", "this deleted conversation page remains suppressed", {
						source: "save_conversation",
						source_mode: "manual_collect",
						...source,
						received: normalized.messages.length,
						skipped: 1,
					});
					receipt.id = `receipt_manual_suppressed_${source.source_packet_id}`;
					receipt.page_id = page.id;
					receipt.page_action = "suppressed";
					receipt.suppressed = true;
					receipt.skippedReasons = { suppressed_blocked: 1 };
					const summary = `Skipped suppressed conversation page:\n${page.title ?? "Conversation page"}`;
					await storeReceipt(env, userId, "save_conversation", receipt, summary, { strict: true });
					return manualCollectReplay(sourcePacket, {
						row: { id: receipt.id, summary },
						receipt,
					});
				}
			}
			// Repair a crash after the receipt write but before the terminal job
			// update. The original durable verdict wins; no digest/model reruns.
			if (!["enriched", "completed", "failed"].includes(job.status)) {
				await updateMemoryJob(env, userId, job.id, {
					status: "enriched",
					receiptId: stored.row.id,
					payload: { ...jobPayload, outcome: stored.receipt.outcome ?? null },
					completedAt: Date.now(),
				});
			}
			return manualCollectReplay(sourcePacket, stored);
		}
		if (["enriched", "completed", "failed"].includes(job.status)) {
			throw new Error("manual collect reached a terminal job state without a durable receipt");
		}
		const now = Date.now();
		const leased = Number(job.updated_at ?? 0) <= now - MANUAL_COLLECT_LEASE_MS
			? await env.DB.prepare(
				`UPDATE memory_jobs
				 SET attempts = attempts + 1, updated_at = ?
				 WHERE id = ? AND user_id = ? AND type = 'manual_collect'
				   AND status IN ('queued', 'staged', 'processing') AND updated_at = ?
				 RETURNING id`,
			).bind(now, job.id, userId, job.updated_at).first()
			: null;
		if (!leased?.id) return manualCollectReplay(sourcePacket);
	}
	const settleResult = async (result) => {
		if (!result?.receipt?.id) {
			throw new Error("manual collect completed without a durable receipt");
		}
		await updateMemoryJob(env, userId, job.id, {
			status: "enriched",
			receiptId: result.receipt.id,
			payload: {
				...jobPayload,
				outcome: result.receipt.outcome ?? null,
				page_id: result.receipt.page_id ?? null,
			},
			completedAt: Date.now(),
		});
		return { ...result, sourcePacket };
	};
	const received = normalized.messages.length;
	const intent = parseCollectIntent(normalized.messages, opts);

	const { digest, keptLines } = await digestConversation(env, config, normalized.messages, opts);
	const filteredDigest = filterDigestByTopic(digest, intent);
	const filteredLines = filteredDigest ? filteredDigest.split("\n").filter((line) => line.trim()).length : 0;

	// SRV-02: digestConversation was a model call — an erasure confirmed while
	// it ran is invisible to any check made before it. Re-check here so a
	// superseded save cancels (job failed, nothing durable, no rescue) instead
	// of finalizing bookkeeping and content past the user's deletion.
	const digestAcceptedAt = Number(sourcePacket?.received_at ?? sourcePacket?.created_at ?? NaN);
	if (Number.isFinite(digestAcceptedAt) && digestAcceptedAt > 0) {
		const barrier = await env.DB.prepare(
			"SELECT barrier_at FROM deletion_barriers WHERE user_id = ?",
		).bind(userId).first();
		if (barrier && Number(barrier.barrier_at) > digestAcceptedAt) {
			const receipt = emptyReceipt(
				"cancelled_by_delete",
				"a confirmed delete erased this scope while the save was processing; the save was cancelled",
				{
					source: "save_conversation",
					source_mode: "manual_collect",
					...source,
					received,
				},
			);
			receipt.durable = false;
			const summary = "A confirmed delete erased this scope while the save was processing; nothing was written.";
			await storeReceipt(env, userId, "save_conversation", receipt, summary, { strict: true });
			await updateMemoryJob(env, userId, job.id, {
				status: "failed",
				receiptId: receipt.id ?? null,
				payload: { ...jobPayload, outcome: "cancelled_by_delete" },
				error: "cancelled_by_delete: a confirmed deletion boundary superseded this accepted save",
				completedAt: Date.now(),
			});
			return { fired: false, processing: false, cancelled: true, summary, receipt, sourcePacket };
		}
	}

	if (!filteredDigest || !filteredDigest.trim()) {
		const runId = await createExtractionRun(env, userId, {
			toolName: "save_conversation",
			sourceMode: "manual_collect",
			topicFilter: intent.topic ? normalizeLabel(intent.topic) : null,
			sourcePacketId: source.source_packet_id,
			idempotencyKey: source.idempotency_key,
			scopeJson: source.scope_json,
			status: "skipped",
			skippedObjects: [{ kind: "memory_page", reason: "no durable facts in this chat" }],
		});
		const receipt = emptyReceipt("meaningful_no_write", "no durable facts in this chat (chatter/questions only)", {
			source: "save_conversation",
			source_mode: "manual_collect",
			...source,
			received,
			digested: filteredLines,
		});
		receipt.extraction_run_id = runId;
		const summary = `Received ${received} message(s). ${formatReceipt(receipt)} Receipt: ${runId}`;
		await storeReceipt(env, userId, "save_conversation", receipt, summary, { strict: true });
		await updateExtractionRun(env, userId, runId, { status: "skipped" });
		return settleResult({ fired: false, processing: false, summary, receipt });
	}

	const pageResult = await saveMemoryPage(env, userId, {
		digest: filteredDigest,
		messages: normalized.messages,
		intent,
		received,
		keptLines: filteredLines || keptLines,
		conversationId: opts.conversationId,
		sourcePacket,
	});
	if (pageResult?.cancelled) {
		// The page commit's own fence refused the write: a confirmed erasure
		// superseded this save. The job must say so — an `enriched` here is the
		// resurrection-shaped lie SRV-02 documented.
		await updateMemoryJob(env, userId, job.id, {
			status: "failed",
			receiptId: pageResult.receipt?.id ?? null,
			payload: { ...jobPayload, outcome: "cancelled_by_delete" },
			error: "cancelled_by_delete: a confirmed deletion boundary superseded this accepted save",
			completedAt: Date.now(),
		});
		return { ...pageResult, sourcePacket };
	}
	return settleResult(pageResult);
}
