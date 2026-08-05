/**
 * The AutoMode ingest path used by HTTP `/v1/ingest` and the existing API lane.
 * It is the one place that routes AutoMode messages through the user's Durable
 * Object (hold/trigger) and fires extraction. MCP manual saves
 * bypass this module so they cannot inspect or mutate held AutoMode state.
 *
 * Fix round 1 contract (Part 1.1): a `memory_jobs` row is created for every
 * accepted write BEFORE the 200 leaves — a receipt without a job row is
 * impossible by construction, because a failed job insert fails the request.
 * The packet id on the receipt is the public handle for status.
 *
 * Extraction runs via the DO's storage-backed queue. The inline `drain()` call
 * here is an optimization (it lets a manual save wait a bounded time for the
 * real receipt); the queue + alarm + reconciliation sweep are the guarantee.
 *
 *   - `waitBudgetMs: 0` (HTTP route): return immediately; extraction lands later.
 *   - `waitBudgetMs > 0` (manual save tools): wait up to the budget for the real
 *     receipt so the tool can show "Saved: …", but NEVER past it.
 */

import {
	hashText,
	normalizeSourcePacket,
	sourceContextIdentity,
	sourceMeta,
	storeSourcePacket,
} from "./source.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { scrubMessages } from "./scrub.js";
import { activeJobDepth, claimIngestMemoryJob } from "../lib/db.js";
import { canonicalMemoryScope, normalizeProjectScope } from "../lib/project_scope.js";
import { stageMemoryText } from "./staged_text.js";

// 1.7 backpressure: never accept unbounded work you can't see.
const MAX_QUEUE_DEPTH = 200;
const TERMINAL_JOB_STATES = new Set(["enriched", "failed", "completed"]);

function maybeInjectIngestFault(env, fault, phase) {
	// Test-only interruption points make the two cross-store crash windows
	// reproducible. Production cannot activate them even if `_test` is supplied.
	if (String(env?.DO_WAKE_ALARMS ?? "true") === "false" && fault === phase) {
		const error = new Error("injected ingest interruption");
		error.code = "INGEST_TEST_FAULT";
		throw error;
	}
}

// A key is permanently bound to its first content hash and terminal outcome.
// Exact replays return the original result; failed work needs a new key.
async function findIdempotencyState(env, userId, idempotencyKey, contentHash) {
	if (!idempotencyKey) return null;
	const [sourcePacket, job] = await Promise.all([
		env.DB.prepare(
			"SELECT * FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
		).bind(userId, idempotencyKey).first(),
		env.DB.prepare(
			`SELECT id, status, type, receipt_id, source_packet_id, created_at FROM memory_jobs
			 WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
		).bind(userId, idempotencyKey).first(),
	]);
	// The public idempotency namespace is shared by every lane and by internal
	// maintenance jobs. Detect a reverse collision before creating a source row;
	// never turn it into a partial side effect followed by an opaque 500.
	if (job && job.type !== "extract") return { conflict: true, sourcePacket, job };
	if (!sourcePacket) return job ? { conflict: true, sourcePacket: null, job } : null;
	if (sourcePacket.content_hash !== contentHash) return { conflict: true, sourcePacket, job };
	if (job?.source_packet_id && job.source_packet_id !== sourcePacket.id) {
		return { conflict: true, sourcePacket, job };
	}
	if (!job) return { sourcePacket, job: null, receipt: null, summary: null };
	let receipt = null;
	let summary = null;
	if (job.receipt_id) {
		const row = await env.DB.prepare(
			"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ?",
		).bind(job.receipt_id, userId).first();
		if (row) {
			summary = row.summary ?? null;
			try { receipt = JSON.parse(row.detail ?? "null"); } catch {}
		}
	}
	// A job whose receipt_id was never linked (the gate's "ignored" receipt is
	// written at the API layer, not by the job) still has a durable verdict.
	if (!receipt) {
		const row = await env.DB.prepare(
			"SELECT detail, summary FROM receipts WHERE user_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId, idempotencyKey).first();
		if (row) {
			summary = summary ?? row.summary ?? null;
			try { receipt = JSON.parse(row.detail ?? "null"); } catch {}
		}
	}
	return { job, receipt, summary, sourcePacket };
}

async function recordReplay(env, userId, normalized, replay, { bumpSeen = true } = {}) {
	if (bumpSeen) {
		try {
			await env.DB.prepare(
				"UPDATE source_packets SET seen_count = COALESCE(seen_count, 0) + 1, updated_at = ? WHERE user_id = ? AND idempotency_key = ?",
			).bind(Date.now(), userId, normalized.packet.idempotency_key).run();
		} catch (err) {
			console.warn("replay seen_count bump failed:", err?.message ?? err);
		}
	}
	return {
		fired: false,
		held: 0,
		skipped: normalized.messages.length,
		duplicate: true,
		terminalReplay: true,
		jobId: replay.job.id,
		jobStatus: replay.job.status,
		result: replay.receipt ? { outcome: replay.receipt.outcome, receipt: replay.receipt, summary: replay.summary } : null,
		receipt: replay.receipt,
		receiptId: replay.receipt?.id ?? replay.job.receipt_id ?? null,
		summary: replay.summary,
		sourcePacket: replay.sourcePacket ?? {
			...normalized.packet,
			id: replay.job.source_packet_id ?? null,
		},
	};
}

export async function ingestMessages(env, ctx, userId, rawMessages, opts = {}) {
	const { flush = false, overrides = {}, waitBudgetMs = 0 } = opts;
	const {
		_testIngestFault: ingestFault,
		_testHandoffFault: handoffFault,
		...pipelineOverrides
	} = overrides;
	// Validate and freeze attribution before any early return. Opt-out content is
	// not stored, but its audit receipt must still say which project door saw it.
	const memoryScope = canonicalMemoryScope(opts.memoryScope ?? overrides.meta);
	const projectScope = normalizeProjectScope(memoryScope);
	// Secrets are stripped BEFORE anything durable sees the text: the source
	// packet row, the Durable Object's held chunk, the model, the vectors.
	const scrubbed = scrubMessages(rawMessages);
	const messages = scrubbed.messages;
	if (scrubbed.redacted) {
		overrides.meta = { ...(overrides.meta ?? {}), redactions: scrubbed.redactions };
	}
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
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
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
		delivery: opts.delivery,
		scope: memoryScope,
	});

	// Permanent exact replay returns the original receipt; conflicting content
	// never mutates the packet or reaches the queue.
	const replay = await findIdempotencyState(
		env,
		userId,
		normalized.packet.idempotency_key,
		normalized.packet.content_hash,
	);
	if (replay?.conflict) {
		return {
			idempotencyConflict: true,
			idempotencyKey: normalized.packet.idempotency_key,
			sourcePacketId: replay.sourcePacket?.id ?? replay.job?.source_packet_id ?? null,
			summary: "That idempotency key is already bound to different content or a different save lane. Send the original request or use a new key.",
		};
	}
	if (replay?.job && TERMINAL_JOB_STATES.has(replay.job.status)) {
		return recordReplay(env, userId, normalized, replay);
	}
	const recoveringReplay = Boolean(replay?.sourcePacket || replay?.job);

	// 1.7 backpressure: refuse clearly instead of accepting invisibly.
	const queueDepth = await activeJobDepth(env, userId);
	// Existing work must be able to repair its cross-store handoff even when the
	// account is full; the replay does not create another queue-depth slot.
	if (!recoveringReplay && queueDepth >= MAX_QUEUE_DEPTH) {
		return { backpressure: true, queueDepth, retryAfterS: 30 };
	}

	const sourcePacket = await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
	if (sourcePacket?.idempotency_conflict) {
		return {
			idempotencyConflict: true,
			idempotencyKey: normalized.packet.idempotency_key,
			sourcePacketId: sourcePacket.id ?? null,
			summary: "That idempotency key is already bound to different content. Send the original content or use a new key.",
		};
	}
	const projectId = sourcePacket?.project_id ?? normalized.packet.project_id ?? null;
	const projectName = sourcePacket?.project_name ?? normalized.packet.project_name ?? null;
	// One DO still owns the account, but held/recent/dedupe state is partitioned
	// inside it. Project metadata must never become another physical tenant.
	const scopeKey = projectId ? `project:${projectId}` : "global";
	const { contextKey } = await sourceContextIdentity(userId, { sourcePacket });
	const extractionOverrides = {
		...pipelineOverrides,
		meta: {
			...(pipelineOverrides.meta ?? {}),
			...sourceMeta(sourcePacket),
		},
	};

	// 1.1 job row before the 200 — refusing to accept work without a durable
	// record is the whole point, so a failed insert fails the request.
	const userMsgIds = normalized.messages.filter((m) => m.role === "user").map((m) => m.id);
	const jobClaim = await claimIngestMemoryJob(env, userId, {
		type: "extract",
		status: "queued",
		idempotencyKey: sourcePacket?.idempotency_key ?? normalized.packet.idempotency_key,
		sourcePacketId: sourcePacket?.id ?? null,
		payload: {
			lane: opts.sourceMode ?? pipelineOverrides.source ?? "ingest",
			source: pipelineOverrides.source ?? opts.source ?? "ingest",
			message_ids: userMsgIds,
			remaining: userMsgIds,
			project_id: projectId,
			project_name: projectName,
			delivery: sourceMeta(sourcePacket).delivery ?? null,
		},
	});
	if (jobClaim.capacityExceeded) {
		return {
			backpressure: true,
			queueDepth: jobClaim.activeLimit ?? MAX_QUEUE_DEPTH,
			retryAfterS: 30,
		};
	}
	let duplicate = false;
	let jobId = jobClaim.id;
	let jobStatus = jobClaim.job?.status ?? "queued";
	if (!jobClaim.claimed) {
		const concurrentReplay = await findIdempotencyState(
			env,
			userId,
			normalized.packet.idempotency_key,
			normalized.packet.content_hash,
		);
		if (concurrentReplay?.conflict) {
			return {
				idempotencyConflict: true,
				idempotencyKey: normalized.packet.idempotency_key,
				sourcePacketId: concurrentReplay.sourcePacket?.id ?? concurrentReplay.job?.source_packet_id ?? null,
				summary: "That idempotency key is already bound to different content or a different save lane. Send the original request or use a new key.",
			};
		}
		if (concurrentReplay?.job && TERMINAL_JOB_STATES.has(concurrentReplay.job.status)) {
			return recordReplay(env, userId, normalized, concurrentReplay, { bumpSeen: false });
		}
		if (!concurrentReplay?.job) {
			throw new Error("memory job claim was lost without an existing job");
		}
		jobId = concurrentReplay.job.id;
		jobStatus = concurrentReplay.job.status;
	}
	if (!jobId) {
		throw new Error("memory job row could not be created — refusing to accept work without a durable record");
	}

	// 8.2 read-your-writes: the scrubbed text is findable NOW, not after
	// enrichment. Best-effort — a staging failure never fails an accepted write.
	if (jobClaim.claimed) {
		await stageMemoryText(env, userId, {
			jobId,
			sourcePacketId: sourcePacket?.id ?? null,
			lane: opts.sourceMode ?? pipelineOverrides.source ?? "ingest",
			messages: normalized.messages,
			projectId,
			projectName,
		});
	}
	maybeInjectIngestFault(env, ingestFault, "after_job_claim");

	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	const handoff = await stub.acceptMessagesOnce(userId, normalized.messages, {
		flush,
		jobId,
		handoffId: jobId,
		requestHash: normalized.packet.content_hash,
		scopeKey,
		contextKey,
		overrides: extractionOverrides,
		...(handoffFault ? { _testHandoffFault: handoffFault } : {}),
	});
	maybeInjectIngestFault(env, ingestFault, "after_do_accept");
	const { fired, held, skipped, queued } = handoff;
	duplicate = Boolean(handoff.handoffDuplicate);

	let result = null;
	if (fired) {
		// One guarded promise: keep the inline drain alive past the response AND
		// optionally race it against the budget. A rejection never surfaces.
		// inlineOverrides carries any function-valued test hooks (JSRPC callback
		// stubs) that could not be persisted onto the queue entries.
		const p = stub.drain({ userId, maxJobs: 8, inlineOverrides: extractionOverrides })
			.then((drained) => {
				const mine = (drained?.results ?? []).find(
					(r) => r.kind === "extract" && (r.jobIds ?? []).includes(jobId),
				);
				return mine ? { outcome: mine.outcome, receipt: mine.receipt ?? null, summary: mine.summary ?? null } : null;
			})
			.catch((err) => {
				console.warn(`background drain failed user=${userId}:`, err?.message ?? err);
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
		queued,
		jobId,
		jobStatus,
		duplicate,
		handoffDuplicate: Boolean(handoff.handoffDuplicate),
		queueDepth: queueDepth + (jobClaim.claimed ? 1 : 0),
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
