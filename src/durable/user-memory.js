/**
 * UserMemory — one Durable Object per user (keyed by userId). It owns, per user:
 *   - the held chunk (messages waiting for the trigger),
 *   - a durable QUEUE of fired work (`q:*` entries), one small sub-chunk each,
 *   - a small rolling buffer of recent raw messages (bridge/assistant context),
 *   - the checkpoint (last_processed_msg_id),
 *   - a storage-backed LEASE so only one drain runs at a time.
 *
 * Design principle (fix round 1): alarms are hints; storage is truth. The
 * drain loop is driven by queue contents in storage, never by whether one
 * particular fire "got through". The failure this replaces: an in-memory
 * `busy` flag plus a completion-time alarm delete raced concurrent ingests
 * and stranded accepted work with no alarm and no record — 200s all the way
 * down, nothing saved (docs/fix-round-1-trace.md, 0.1).
 *
 * Invariant this file upholds: every accepted write (a `memory_jobs` row
 * created at the door) ends in `enriched` or `failed`, visibly. Entries are
 * processed a bounded number per alarm, poison entries dead-letter after
 * MAX_ATTEMPTS without blocking the head of the queue, and every exit path
 * that leaves work in storage guarantees a future alarm before returning.
 */

import { DurableObject } from "cloudflare:workers";
import { classifyMessage, shouldFire, meaningfulCount } from "../pipeline/trigger.js";
import { runExtraction as runExtractionPipeline } from "../pipeline/extract.js";
import { announceMcpTerminal, enrichMcpConversation, markMcpEnrichmentFailed } from "../pipeline/mcp_engine.js";
import { formatReceipt } from "../pipeline/receipt.js";
import { runExport as runExportJob } from "../pipeline/exports.js";
import { storeReceipt, settleMemoryJobs } from "../lib/db.js";
import { reportServerError } from "../lib/report.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "../pipeline/webhooks.js";
import { settleStagedText } from "../pipeline/staged_text.js";
import { sourceMeta } from "../pipeline/source.js";
import { DIALS } from "../config.js";

const RECENT_LIMIT = 20;

// 1.6 chunk caps: a queue entry never exceeds either bound, whichever first.
// ~4 chars/token puts 12k chars near the 3k-token input budget that keeps one
// extraction call fast, parseable, and cheap to retry.
const MAX_ENTRY_MSGS = 20;
const MAX_ENTRY_CHARS = 12000;

// Exactly-once Worker -> Durable Object handoff markers. The raw handoff id
// never becomes a storage key: a bounded SHA-256 key avoids key injection and
// keeps permanent replay records small. The marker itself binds that stable id
// to the source packet's content hash forever.
const HANDOFF_MARKER_PREFIX = "handoff:v1:";
const MCP_HANDOFF_MARKER_PREFIX = "mcp-handoff:v1:";
const HANDOFF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;
const TERMINAL_JOB_STATES = new Set(["enriched", "failed", "completed"]);

// 1.5 poison ceiling and 1.9 drain pacing.
const MAX_ATTEMPTS = 3;
const MAX_JOBS_PER_DRAIN = 3;

// 1.2 lease: storage-backed concurrency guard. Long enough for one capped
// extraction (multi-pass, slow model), short enough that a killed isolate
// frees the queue quickly.
const LEASE_MS = 120_000;

// Entries older than this get `drained_from_backlog` on their receipts so a
// sudden burst of graph changes is explainable in the UI.
const BACKLOG_AGE_MS = 10 * 60 * 1000;
const GLOBAL_SCOPE_KEY = "global";

const backoffMs = (attempts) => Math.min(5000 * 2 ** Math.max(0, attempts - 1), 600_000);

function unicodeLength(value) {
	let length = 0;
	for (const _ of String(value ?? "")) length++;
	return length;
}

function codedError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function validateQueueableMessages(messages) {
	for (const message of messages ?? []) {
		if (!message || (message.role ?? "user") !== "user") continue;
		if (unicodeLength(message.content) > MAX_ENTRY_CHARS) {
			throw codedError("MESSAGE_TOO_LARGE", "message exceeds the Durable Object queue-entry limit");
		}
	}
}

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value ?? ""));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleanScopeKey(value) {
	const key = String(value ?? GLOBAL_SCOPE_KEY).trim();
	return key && key.length <= 180 ? key : GLOBAL_SCOPE_KEY;
}

function scopedStorageKey(base, scopeKey) {
	const key = cleanScopeKey(scopeKey);
	return key === GLOBAL_SCOPE_KEY ? base : `${base}:${key}`;
}

function messageDedupeNamespace(scopeKey, overrides = {}) {
	let scope = {};
	try { scope = JSON.parse(overrides?.meta?.scope_json ?? "{}") ?? {}; } catch {}
	return JSON.stringify([
		cleanScopeKey(scopeKey),
		scope.workspace_id ?? null,
		scope.app_id ?? null,
		scope.agent_id ?? null,
		scope.source_scope ?? null,
		scope.conversation_id ?? scope.thread_id ?? scope.session_id ?? null,
	]);
}

async function messageDedupeIdentity(scopeKey, overrides, message) {
	const contentHash = CONTENT_HASH_RE.test(String(message?.content_hash ?? "").toLowerCase())
		? String(message.content_hash).toLowerCase()
		: await sha256Hex(message?.content ?? "");
	const namespace = messageDedupeNamespace(scopeKey, overrides);
	return {
		contentHash,
		identity: `message:v2:${await sha256Hex(`${namespace}\u0000${message?.id ?? ""}\u0000${contentHash}`)}`,
	};
}

/**
 * Overrides may carry function-valued test hooks (JSRPC passes them as
 * callback stubs). Those can ride an inline drain call but can never be
 * persisted — DO storage structured-clones. Keep the serializable subset for
 * the queue; the caller passes the full object as inlineOverrides when it
 * wants the hooks honored right now.
 */
function persistableOverrides(value) {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (typeof value === "function") return undefined;
	if (Array.isArray(value)) return value.map((v) => persistableOverrides(v)).filter((v) => v !== undefined);
	if (typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			const kept = persistableOverrides(v);
			if (kept !== undefined) out[k] = kept;
		}
		return out;
	}
	return value;
}

/** Content-free, bounded receipt fields safe to retain in a retry record. */
function compactTerminalReceipt(receipt, id) {
	if (!receipt || typeof receipt !== "object") return null;
	const saved = receipt.saved && typeof receipt.saved === "object"
		? Object.fromEntries(
			["pages", "nodes", "slices", "events", "edges", "candidates", "updatedNodes", "supersededSlices"]
				.map((key) => [key, Number(receipt.saved[key] ?? 0)]),
		)
		: {};
	const compact = {
		id,
		outcome: receipt.outcome ?? null,
		reason: receipt.reason ? String(receipt.reason).slice(0, 300) : null,
		source: receipt.source ?? "ingest",
		source_mode: receipt.source_mode ?? null,
		source_packet_id: receipt.source_packet_id ?? null,
		idempotency_key: receipt.idempotency_key ?? null,
		scope_json: receipt.scope_json ?? null,
		extraction_run_id: receipt.extraction_run_id ?? null,
		received: Number.isFinite(receipt.received) ? receipt.received : null,
		digested: Number.isFinite(receipt.digested) ? receipt.digested : null,
		skipped: Number(receipt.skipped ?? 0),
		saved,
		savedTotal: Number.isFinite(receipt.savedTotal)
			? receipt.savedTotal
			: ["pages", "nodes", "slices", "events", "edges", "candidates"]
				.reduce((total, key) => total + Number(saved[key] ?? 0), 0),
		latency_ms: Number.isFinite(receipt.latency_ms) ? Math.round(receipt.latency_ms) : null,
		matched: Number.isFinite(receipt.matched) ? Math.round(receipt.matched) : null,
		ai_calls: Number.isFinite(receipt.ai_calls) ? receipt.ai_calls : null,
		ai_input_tokens: Number.isFinite(receipt.ai_input_tokens) ? receipt.ai_input_tokens : null,
		ai_output_tokens: Number.isFinite(receipt.ai_output_tokens) ? receipt.ai_output_tokens : null,
		ai_neurons: Number.isFinite(receipt.ai_neurons) ? receipt.ai_neurons : null,
	};
	return compact;
}

export class UserMemory extends DurableObject {
	// Same-isolate duplicate RPCs share one promise. Durable markers below are
	// still the source of truth across eviction, deployment, and crashes.
	#handoffsInFlight = new Map();

	async #handoffMarkerKey(handoffId) {
		return `${HANDOFF_MARKER_PREFIX}${await sha256Hex(handoffId)}`;
	}

	#handoffResult(result, duplicate) {
		return {
			...(result ?? { fired: false, held: 0, skipped: 0, queued: 0 }),
			handoffAccepted: true,
			handoffDuplicate: Boolean(duplicate),
		};
	}

	#shouldInjectHandoffFault(opts, phase) {
		// A string fault is intentionally honored only in the alarm-disabled test
		// environment. Production callers cannot turn a successful handoff into a
		// synthetic crash even if an option is accidentally forwarded.
		return Boolean(
			String(this.env.DO_WAKE_ALARMS ?? "true") === "false"
			&& opts?._testHandoffFault === phase
		);
	}

	#maybeInjectHandoffFault(opts, phase) {
		if (this.#shouldInjectHandoffFault(opts, phase)) {
			throw codedError("HANDOFF_TEST_FAULT", "injected handoff interruption");
		}
	}

	async #memoryJobState(userId, jobId) {
		if (!jobId) return null;
		return this.env.DB.prepare(
			"SELECT id, status FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(jobId, userId).first();
	}

	/**
	 * Find durable evidence that a job's messages already crossed into this
	 * object. Queue ownership is explicit in jobByMessage; held messages carry
	 * the same _job tag. We deliberately do not infer ownership from message ids
	 * alone because an overlapping packet may legitimately reuse them.
	 */
	async #handoffOwnership(jobId) {
		if (!jobId) return { owned: false, held: 0, queued: 0, heldIds: [], queuedIds: [] };
		const chunk = await this.ctx.storage.get("chunk");
		const heldIds = new Set();
		for (const message of chunk ?? []) {
			if (message?._job === jobId && message.id) heldIds.add(message.id);
		}
		let queued = 0;
		const queuedIds = new Set();
		await this.#scanQueue((_key, entry) => {
			if (entry?.kind !== "extract") return true;
			const mappedIds = Object.entries(entry.jobByMessage ?? {})
				.filter(([, mappedJobId]) => mappedJobId === jobId)
				.map(([messageId]) => messageId);
			const taggedIds = (entry.messages ?? [])
				.filter((message) => message?._job === jobId && message.id)
				.map((message) => message.id);
			const mapped = mappedIds.length > 0;
			const tagged = taggedIds.length > 0;
			if (mapped || tagged) queued++;
			for (const messageId of [...mappedIds, ...taggedIds]) queuedIds.add(messageId);
			return true;
		});
		return {
			owned: heldIds.size > 0 || queued > 0,
			held: heldIds.size,
			queued,
			heldIds: [...heldIds],
			queuedIds: [...queuedIds],
		};
	}

	#recoveredHandoffResult(marker, ownership = null) {
		const owned = ownership?.owned
			? Math.max(Number(ownership.held ?? 0), Number(marker.fallback?.held ?? 0))
			: Number(marker.fallback?.held ?? 0);
		const queued = Number(ownership?.queued ?? 0);
		return {
			fired: queued > 0 || Boolean(marker.fallback?.fired),
			held: owned,
			skipped: Number(marker.fallback?.skipped ?? 0),
			queued,
		};
	}

	/**
	 * A previous build (or a fault between addMessages and the marker update)
	 * may leave a pending marker with already-held work. Finish a fire that was
	 * interrupted after the chunk write, then derive a stable recovery result.
	 * This block performs local storage work only; no D1 call is held inside it.
	 */
	async #recoverOwnedHandoff(userId, marker) {
		return this.ctx.blockConcurrencyWhile(async () => {
			let ownership = await this.#handoffOwnership(marker.jobId);
			if (ownership.held > 0 && ownership.queued > 0) {
				// Legacy enqueue wrote queue entries one by one, then cleared the
				// chunk. A crash between those steps can leave both copies. Remove
				// only ids already represented in the durable queue; any unwritten
				// remainder stays held and is completed below.
				const queuedIds = new Set(ownership.queuedIds);
				const chunk = (await this.ctx.storage.get("chunk")) ?? [];
				const reconciled = chunk.filter((message) => !(
					message?._job === marker.jobId && queuedIds.has(message.id)
				));
				if (reconciled.length !== chunk.length) await this.ctx.storage.put("chunk", reconciled);
				ownership = await this.#handoffOwnership(marker.jobId);
			}
			if (ownership.held > 0) {
				const chunk = (await this.ctx.storage.get("chunk")) ?? [];
				const unsettled = chunk.filter((message) => !message._settled);
				const lastSignal = unsettled[unsettled.length - 1]?._cls === "signal";
				const { fire } = shouldFire(unsettled, {
					flush: Boolean(marker.flush),
					now: Date.now(),
					lastSignal,
				});
				if (fire) {
					await this.#enqueueFired(userId, {
						scopeKey: marker.scopeKey,
					});
				}
				ownership = await this.#handoffOwnership(marker.jobId);
			}
			await this.#guaranteeWake();
			return this.#recoveredHandoffResult(marker, ownership);
		});
	}

	async #finishAppliedHandoff(markerKey, marker, duplicate, opts) {
		// Local state and the applied marker commit atomically. These D1 effects
		// cannot share that transaction, so the marker carries their bounded,
		// idempotent repair inputs until this acceptance gate has replayed them.
		if (marker.jobId && Array.isArray(marker.settledMessageIds) && marker.settledMessageIds.length > 0) {
			await this.#announceJobTransitions(marker.userId, await settleMemoryJobs(
				this.env,
				marker.userId,
				[{ jobId: marker.jobId, messageIds: marker.settledMessageIds, disposition: "skipped" }],
				{ strict: true },
			));
		}
		if (marker.checkpointToMirror) {
			await this.#mirrorCheckpoint(marker.userId, marker.checkpointToMirror, { strict: true });
		}

		let ownership = await this.#handoffOwnership(marker.jobId);
		let job = null;

		// No local ownership is valid only when D1 already has a terminal verdict
		// (noise/dedupe-only, or a queue entry that drained before recovery). A
		// noise-only settlement is safe to repeat: settleMemoryJobs is terminal-
		// guarded and returns no second transition.
		if (!ownership.owned && marker.jobId) {
			job = await this.#memoryJobState(marker.userId, marker.jobId);
			if (!job || !TERMINAL_JOB_STATES.has(job.status)) {
				if (Number(marker.result?.held ?? 0) === 0) {
					await this.#announceJobTransitions(marker.userId, await settleMemoryJobs(
						this.env,
						marker.userId,
						[{ jobId: marker.jobId, all: true, disposition: "skipped" }],
						{ strict: true },
					));
					job = await this.#memoryJobState(marker.userId, marker.jobId);
				}
				if (!job || !TERMINAL_JOB_STATES.has(job.status)) {
					throw codedError("HANDOFF_NOT_DURABLE", "handoff has no durable queue or terminal job evidence");
				}
			}
		}

		// If a caller uses the RPC without a D1 job (tests/tools), local ownership
		// is the durable evidence. A work-free call also has nothing to lose.
		if (
			!marker.jobId
			&& Number(marker.result?.held ?? 0) > 0
			&& !ownership.owned
			&& marker.localCommitVersion !== 1
		) {
			throw codedError("HANDOFF_NOT_DURABLE", "handoff has no durable queue evidence");
		}

		// A crash can happen after the applied marker is durable but before the
		// normal addMessages exit arms the alarm. Re-establish the wake invariant
		// before acknowledging recovery.
		await this.#guaranteeWake();
		this.#maybeInjectHandoffFault(opts, "before_accepted");
		if (marker.jobId && job && TERMINAL_JOB_STATES.has(job.status)) {
			await this.ctx.storage.delete(markerKey);
			return this.#handoffResult(marker.result, duplicate);
		}
		const {
			settledMessageIds: _settledMessageIds,
			checkpointToMirror: _checkpointToMirror,
			...stableMarker
		} = marker;
		const accepted = {
			...stableMarker,
			state: "accepted",
			acceptedAt: Date.now(),
		};
		await this.ctx.storage.put(markerKey, accepted);
		return this.#handoffResult(accepted.result, duplicate);
	}

	async #acceptMessagesOnce(userId, messages, opts, markerKey) {
		const handoffId = String(opts.handoffId);
		const requestHash = String(opts.requestHash).toLowerCase();
		const jobId = opts.jobId
			? String(opts.jobId)
			: handoffId.startsWith("job_") ? handoffId : null;
		const requestedScopeKey = cleanScopeKey(opts.scopeKey);
		const userMessages = (messages ?? []).filter((message) => message && (message.role ?? "user") === "user");
		const meaningful = userMessages.filter((message) => {
			const cls = classifyMessage(message.content);
			return cls === "signal" || cls === "meaningful";
		}).length;
		const fallback = {
			fired: Boolean(opts.flush) && meaningful > 0,
			held: meaningful,
			skipped: Math.max(0, userMessages.length - meaningful),
		};

		let created = false;
		let marker = await this.ctx.storage.transaction(async (txn) => {
			const existing = await txn.get(markerKey);
			if (existing) return existing;
			const pending = {
				version: 1,
				state: "pending",
				handoffId,
				requestHash,
				userId,
				jobId,
				scopeKey: requestedScopeKey,
				flush: Boolean(opts.flush),
				fallback,
				createdAt: Date.now(),
			};
			await txn.put(markerKey, pending);
			created = true;
			return pending;
		});

		if (
			marker.version !== 1
			|| marker.handoffId !== handoffId
			|| marker.requestHash !== requestHash
			|| marker.userId !== userId
		) {
			throw codedError("HANDOFF_CONFLICT", "handoff identity is already bound to different content");
		}

		const duplicate = !created;
		if (marker.state === "accepted") return this.#handoffResult(marker.result, duplicate);
		if (marker.state === "applied") {
			return this.#finishAppliedHandoff(markerKey, marker, duplicate, opts);
		}
		if (marker.state !== "pending") {
			throw codedError("HANDOFF_STATE_INVALID", "handoff marker state is invalid");
		}

		this.#maybeInjectHandoffFault(opts, "after_pending");

		// Recover an interrupted/legacy call before invoking addMessages. Finding
		// ownership means the active job must never be appended or settled again.
		const ownership = await this.#handoffOwnership(jobId);
		if (ownership.owned) {
			const result = await this.#recoverOwnedHandoff(userId, marker);
			marker = { ...marker, state: "applied", result, appliedAt: Date.now() };
			await this.ctx.storage.put(markerKey, marker);
			this.#maybeInjectHandoffFault(opts, "after_applied");
			return this.#finishAppliedHandoff(markerKey, marker, true, opts);
		}

		// A terminal job with no local ownership is the other complete outcome:
		// noise/dedupe settled at the door, or queued work already drained.
		const priorJob = await this.#memoryJobState(userId, jobId);
		if (priorJob && TERMINAL_JOB_STATES.has(priorJob.status)) {
			const result = this.#recoveredHandoffResult(marker);
			marker = { ...marker, state: "applied", result, appliedAt: Date.now() };
			await this.ctx.storage.put(markerKey, marker);
			this.#maybeInjectHandoffFault(opts, "after_applied");
			return this.#finishAppliedHandoff(markerKey, marker, true, opts);
		}

		// A pending marker binds the behavior as well as the content. A retry may
		// carry different transport options, but it must complete the original
		// scope/flush decision rather than silently changing durable behavior.
		const effectiveOpts = {
			...opts,
			flush: Boolean(marker.flush),
			scopeKey: cleanScopeKey(marker.scopeKey),
		};
		const {
			handoffId: _handoffId,
			requestHash: _requestHash,
			...addOpts
		} = effectiveOpts;
		const result = await this.addMessages(userId, messages, {
			...addOpts,
			_handoffMarker: {
				key: markerKey,
				handoffId,
				requestHash,
				userId,
			},
		});
		if (result?._testHandoffFault) {
			this.#maybeInjectHandoffFault(opts, result._testHandoffFault);
		}
		this.#maybeInjectHandoffFault(opts, "after_add");

		const applied = await this.ctx.storage.get(markerKey);
		marker = applied?.state === "applied"
			? applied
			: { ...marker, state: "applied", result, appliedAt: Date.now() };
		if (applied?.state !== "applied") await this.ctx.storage.put(markerKey, marker);
		this.#maybeInjectHandoffFault(opts, "after_applied");
		// A marker-only retry performed the first real local application in this
		// invocation. It is a recovery, not a duplicate acceptance. Concurrent
		// followers still receive handoffDuplicate=true from the in-flight gate.
		return this.#finishAppliedHandoff(markerKey, marker, false, opts);
	}

	/**
	 * Crash-safe, permanent, content-bound handoff from D1's accept ledger into
	 * this user's held chunk/queue. Exact concurrent/retry calls return the
	 * original addMessages result; a reused id with another hash is rejected.
	 */
	async acceptMessagesOnce(userId, messages, opts = {}) {
		const handoffId = String(opts.handoffId ?? "");
		const requestHash = String(opts.requestHash ?? "").toLowerCase();
		if (!HANDOFF_ID_RE.test(handoffId)) {
			throw codedError("HANDOFF_ID_INVALID", "handoff identity is invalid");
		}
		if (!CONTENT_HASH_RE.test(requestHash)) {
			throw codedError("HANDOFF_HASH_INVALID", "handoff request hash is invalid");
		}
		validateQueueableMessages(messages);

		const markerKey = await this.#handoffMarkerKey(handoffId);
		const running = this.#handoffsInFlight.get(markerKey);
		if (running) {
			if (running.requestHash !== requestHash) {
				throw codedError("HANDOFF_CONFLICT", "handoff identity is already bound to different content");
			}
			const result = await running.promise;
			return { ...result, handoffDuplicate: true };
		}

		const normalizedOpts = { ...opts, handoffId, requestHash };
		const promise = this.#acceptMessagesOnce(userId, messages, normalizedOpts, markerKey);
		this.#handoffsInFlight.set(markerKey, { requestHash, promise });
		try {
			return await promise;
		} finally {
			const current = this.#handoffsInFlight.get(markerKey);
			if (current?.promise === promise) this.#handoffsInFlight.delete(markerKey);
		}
	}

	async #load(scopeKey = GLOBAL_SCOPE_KEY) {
		const key = cleanScopeKey(scopeKey);
		const [chunk, recent, checkpoint, checkpointIdentity, userId, seen, chunkScopeKey] = await Promise.all([
			this.ctx.storage.get("chunk"),
			this.ctx.storage.get(scopedStorageKey("recent", key)),
			this.ctx.storage.get(scopedStorageKey("checkpoint", key)),
			this.ctx.storage.get(scopedStorageKey("checkpointIdentity", key)),
			this.ctx.storage.get("userId"),
			this.ctx.storage.get(scopedStorageKey("seen", key)),
			this.ctx.storage.get("chunkScopeKey"),
		]);
		return {
			chunk: chunk ?? [],
			recent: recent ?? [],
			checkpoint: checkpoint ?? null,
			checkpointIdentity: checkpointIdentity ?? null,
			userId: userId ?? null,
			seen: seen ?? [],
			scopeKey: key,
			chunkScopeKey: cleanScopeKey(chunkScopeKey),
		};
	}

	/**
	 * Page through queue KV without loading a legal worst-case backlog into one
	 * isolate. Return `false` from the visitor to stop after the current entry.
	 */
	async #scanStoredPrefix(prefix, visitor, pageSize = 128) {
		let startAfter = null;
		let count = 0;
		while (true) {
			const options = { prefix, limit: pageSize };
			if (startAfter) options.startAfter = startAfter;
			const page = await this.ctx.storage.list(options);
			if (page.size === 0) break;
			for (const [key, entry] of page) {
				count++;
				startAfter = key;
				if (visitor(key, entry) === false) return { count, stopped: true };
			}
			if (page.size < pageSize) break;
		}
		return { count, stopped: false };
	}

	async #scanQueue(visitor, pageSize = 128) {
		return this.#scanStoredPrefix("q:", visitor, pageSize);
	}

	/** Bounded set of message ids already finalized (processed or skipped). */
	#capSeen(ids) {
		const MAX_SEEN = 1000;
		return ids.length > MAX_SEEN ? ids.slice(-MAX_SEEN) : ids;
	}

	async #mirrorCheckpoint(userId, msgId, { strict = false } = {}) {
		try {
			await this.env.DB.prepare(
				"INSERT INTO checkpoints (user_id, last_processed_msg_id, updated_at) VALUES (?, ?, ?) " +
					"ON CONFLICT(user_id) DO UPDATE SET last_processed_msg_id = excluded.last_processed_msg_id, updated_at = excluded.updated_at",
			)
				.bind(userId, msgId, Date.now())
				.run();
		} catch (err) {
			if (strict) throw err;
			console.warn("checkpoint mirror failed:", err?.message ?? err);
		}
	}

	/**
	 * Earliest-next-wake alarm arming. A DO has exactly ONE alarm and setAlarm
	 * overwrites, so every scheduling decision goes through this min-merge —
	 * nothing may push an existing wake-up later.
	 *
	 * DO_WAKE_ALARMS="false" (vitest only) disables self-arming: the test
	 * pool's per-test stacked storage cannot tolerate alarms firing across
	 * test boundaries, and every test drives drains explicitly instead. The
	 * production guarantee (queue in storage + alarms + cron sweep) is
	 * covered by dedicated queue tests.
	 */
	async #armAlarm(at) {
		if (String(this.env.DO_WAKE_ALARMS ?? "true") === "false") return;
		const pending = await this.ctx.storage.getAlarm();
		if (!pending || pending > at) await this.ctx.storage.setAlarm(at);
	}

	/**
	 * The exit gate: called on EVERY path that returns control while storage
	 * may hold work. Re-checks storage AFTER any alarm delete, so the
	 * completion race that stranded backlogs (trace 0.1c-1) is structurally
	 * closed: no code path can observe "work present" without an alarm set.
	 */
	async #guaranteeWake() {
		const legacy = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 });
		const chunk = (await this.ctx.storage.get("chunk")) ?? [];
		const unsettled = chunk.filter((m) => !m._settled);

		let earliest = null;
		const now = Date.now();
		if (legacy.size > 0) earliest = now + 250;
		await this.#scanQueue((_key, entry) => {
			const at = Math.max(now + 250, Number(entry.runAfter ?? 0));
			if (earliest === null || at < earliest) earliest = at;
			// No later entry can require an earlier wake than the runnable floor.
			return earliest !== now + 250;
		});
		// A live lease means a drain is actively working the queue — waking
		// before it could finish is pure churn. Floor the wake at lease expiry
		// (which is also the revival path if the drainer's isolate died).
		if (earliest !== null) {
			const lease = await this.ctx.storage.get("lease");
			if (lease && Number(lease.until) > Date.now()) {
				earliest = Math.max(earliest, Number(lease.until) + 1000);
			}
		}
		if (earliest === null && unsettled.length > 0) {
			// Held-but-not-fired messages must still fire within a bounded time:
			// the idle trigger needs a clock, not a hope that another message
			// arrives. (+1s so the idle_gap condition is true when we wake.)
			const lastTs = unsettled[unsettled.length - 1]?.ts ?? Date.now();
			earliest = Math.max(Date.now() + 1000, lastTs + DIALS.idleMs + 1000);
		}

		if (earliest !== null) {
			await this.#armAlarm(earliest);
			return;
		}
		// Nothing pending → clear, then RE-CHECK: a concurrent addMessages may
		// have appended between our reads and the delete. Never strand work.
		await this.ctx.storage.deleteAlarm();
		const chunkAfter = (await this.ctx.storage.get("chunk")) ?? [];
		const entriesAfter = await this.ctx.storage.list({ prefix: "q:", limit: 1 });
		const legacyAfter = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 });
		if (entriesAfter.size > 0 || legacyAfter.size > 0 || chunkAfter.some((m) => !m._settled)) {
			await this.#armAlarm(Date.now() + 500);
		}
	}

	/**
	 * Queue keys: ordered by a counter, made unique by a random suffix.
	 *
	 * The counter alone was a silent data-loss bug. It is a non-atomic
	 * read-modify-write called from TWO paths guarded by DIFFERENT locks —
	 * addMessages (blockConcurrencyWhile) and drain (the storage lease) — which
	 * do not exclude each other. Under a concurrent burst both could read the
	 * same value, write the same value, and `put` the same key: the second
	 * enqueue silently overwrote the first, and the overwritten batch's job
	 * rows sat at `queued`/attempts=0 forever, unreachable by any drain and
	 * immune to the sweep's kick. Measured on the owner account: 10 of a
	 * 20-wide add() burst lost this way.
	 *
	 * The suffix makes a collision harmless — both entries survive, adjacent in
	 * key order — so FIFO is preserved and no work can be clobbered.
	 */
	async #nextSeq() {
		const suffix = crypto.randomUUID().slice(0, 8);
		return this.ctx.storage.transaction(async (txn) => {
			const seq = Number((await txn.get("qseq")) ?? 0) + 1;
			await txn.put("qseq", seq);
			return `${String(seq).padStart(10, "0")}-${suffix}`;
		});
	}

	/**
	 * Move fired messages out of the held chunk into durable queue entries,
	 * split at the 1.6 caps (≤20 messages AND ≤~3k tokens, whichever first) so
	 * each entry is one small, retryable extraction. Splitting happens HERE, at
	 * enqueue time — never inside a model call.
	 */
	async #enqueueChunkInTransaction(txn, userId, chunk, { overrides = {}, scopeKey = null } = {}) {
		if (chunk.length === 0) return 0;
		const activeScopeKey = cleanScopeKey(scopeKey ?? (await txn.get("chunkScopeKey")));
		const pendingOverrides = persistableOverrides(overrides ?? {});
		const overridesByJob = (await txn.get("chunkOverridesByJob")) ?? {};

		let batch = [];
		let chars = 0;
		let batchJobId = null;
		const batches = [];
		for (const msg of chunk) {
			const len = unicodeLength(msg.content);
			// New calls are rejected before they enter the held chunk. Keep this
			// second guard for chunks persisted by an older deployment: never let a
			// first oversized message bypass the total-entry cap.
			if (len > MAX_ENTRY_CHARS) {
				throw codedError("MESSAGE_TOO_LARGE", "held message exceeds the Durable Object queue-entry limit");
			}
			const messageJobId = msg?._job ?? null;
			if (
				batch.length > 0
				&& (
					messageJobId !== batchJobId
					|| batch.length >= MAX_ENTRY_MSGS
					|| chars + len > MAX_ENTRY_CHARS
				)
			) {
				batches.push(batch);
				batch = [];
				chars = 0;
				batchJobId = null;
			}
			if (batch.length === 0) batchJobId = messageJobId;
			batch.push(msg);
			chars += len;
		}
		if (batch.length) batches.push(batch);

		let seq = Number((await txn.get("qseq")) ?? 0);
		const enqueuedAt = Date.now();
		for (const msgs of batches) {
			seq++;
			const suffix = crypto.randomUUID().slice(0, 8);
			const jobId = msgs[0]?._job ?? null;
			const batchOverrides = persistableOverrides(
				(jobId && overridesByJob[jobId]) ?? pendingOverrides,
			);
			await txn.put(`q:${String(seq).padStart(10, "0")}-${suffix}`, {
				kind: "extract",
				messages: msgs.map(({ _settled, _job, _cls, _dedupe, ...message }) => message),
				jobByMessage: Object.fromEntries(msgs.filter((m) => m._job).map((m) => [m.id, m._job])),
				dedupeByMessage: Object.fromEntries(msgs.filter((m) => m._dedupe).map((m) => [m.id, m._dedupe])),
				overrides: batchOverrides,
				scopeKey: activeScopeKey,
				attempts: 0,
				runAfter: 0,
				enqueuedAt,
			});
		}
		await txn.put("qseq", seq);
		await txn.put("chunk", []);
		await txn.delete("chunkOverridesByJob");
		await txn.put("userId", userId);
		return batches.length;
	}

	async #enqueueFired(userId, { overrides = null, scopeKey = null } = {}) {
		return this.ctx.storage.transaction(async (txn) => {
			const chunk = (await txn.get("chunk")) ?? [];
			const pendingOverrides = overrides ?? (await txn.get("pendingOverrides")) ?? {};
			return this.#enqueueChunkInTransaction(txn, userId, chunk, {
				overrides: pendingOverrides,
				scopeKey,
			});
		});
	}

	/**
	 * Append new messages, run the trigger, and enqueue when a fire is due.
	 * Fast (no LLM / no heavy D1) so the caller can respond immediately. Atomic
	 * via blockConcurrencyWhile so concurrent ingests can't interleave.
	 *
	 * opts.jobId (from the door's accept-time memory_jobs row) tags each held
	 * message so completion/settlement reaches the right row. Messages decided
	 * TERMINALLY here (noise-ignored, deduplicated) settle their share of the
	 * job immediately — a noise-only packet is `enriched` with 0 saved before
	 * the caller even reads the response.
	 */
	async addMessages(userId, messages, opts = {}) {
		validateQueueableMessages(messages);
		return this.ctx.blockConcurrencyWhile(async () => {
			const requestedScopeKey = cleanScopeKey(opts.scopeKey);
			const persistedOverrides = opts.overrides !== undefined
				? persistableOverrides(opts.overrides ?? {})
				: undefined;
			let state = await this.#load(requestedScopeKey);
			// A project switch is a hard batching boundary. Finish the prior held
			// chunk under its own persisted metadata before any new-scope message
			// can enter it. One account DO remains the coordinator; projects do not
			// become unrelated Durable Object tenants.
			if (state.chunk.length > 0 && state.chunkScopeKey !== requestedScopeKey) {
				await this.#enqueueFired(userId, { scopeKey: state.chunkScopeKey });
				state = await this.#load(requestedScopeKey);
			}
			if (state.chunkScopeKey !== requestedScopeKey) {
				state.chunkScopeKey = requestedScopeKey;
			}
			const chunk = state.chunk;
			let recent = state.recent;
			let checkpoint = state.checkpoint;
			let checkpointIdentity = state.checkpointIdentity;
			const chunkIdentities = new Set(chunk.map((m) => m._dedupe).filter(Boolean));
			const chunkIdentityOwners = new Map(
				chunk.filter((message) => message?._dedupe).map((message) => [message._dedupe, message._job ?? null]),
			);
			const seen = new Set(state.seen);
			// Lazy v1 -> v2 compatibility. Old state used raw ids; trust one only
			// when old recent/chunk evidence binds it to the same content hash.
			const legacySeenIds = new Set(
				state.seen.filter((value) => !String(value).startsWith("message:v2:")),
			);
			const legacyContentById = new Map();
			for (const previous of recent) {
				if (!previous?.id) continue;
				const hash = CONTENT_HASH_RE.test(String(previous.content_hash ?? "").toLowerCase())
					? String(previous.content_hash).toLowerCase()
					: await sha256Hex(previous.content ?? "");
				if (!legacyContentById.has(previous.id)) legacyContentById.set(previous.id, new Set());
				legacyContentById.get(previous.id).add(hash);
			}
			const legacyHeld = new Set();
			for (const previous of chunk) {
				if (!previous?.id || previous._dedupe) continue;
				const hash = CONTENT_HASH_RE.test(String(previous.content_hash ?? "").toLowerCase())
					? String(previous.content_hash).toLowerCase()
					: await sha256Hex(previous.content ?? "");
				legacyHeld.add(`${previous.id}\u0000${hash}`);
			}
			let checkpointChanged = false;
			let lastSignal = false;
			let held = 0;
			let skipped = 0;
			const settledNow = []; // message ids finalized right here

			for (const msg of messages ?? []) {
				if (!msg || !msg.id) continue;
				const { contentHash, identity: dedupeIdentity } = await messageDedupeIdentity(
					requestedScopeKey,
					persistedOverrides ?? {},
					msg,
				);
				const norm = {
					id: msg.id,
					role: msg.role ?? "user",
					content: msg.content ?? "",
					ts: msg.ts ?? Date.now(),
					content_hash: contentHash,
					_dedupe: dedupeIdentity,
				};
				recent.push(norm);

				if (norm.role !== "user") continue; // only user messages become memory
				// De-dup re-sends: already held, the current checkpoint, or already
				// processed in a prior fire. Lets save_conversation safely re-send
				// overlapping batches — only genuinely new messages get processed.
				const legacySeenMatch = (
					(legacySeenIds.has(norm.id) || (!checkpointIdentity && checkpoint === norm.id))
					&& legacyContentById.get(norm.id)?.has(contentHash)
				);
				if (
					chunkIdentities.has(dedupeIdentity)
					|| legacyHeld.has(`${norm.id}\u0000${contentHash}`)
					|| legacySeenMatch
					|| dedupeIdentity === checkpointIdentity
					|| seen.has(dedupeIdentity)
				) {
					skipped++;
					// Two no-id copies in one request can normalize to the same raw
					// id. The first copy already represents this job in the held chunk;
					// settling the second by that shared id would remove *both* entries
					// from payload.remaining and make D1 terminal before extraction.
					const heldByThisJob = chunkIdentities.has(dedupeIdentity)
						&& opts.jobId
						&& chunkIdentityOwners.get(dedupeIdentity) === opts.jobId;
					if (!heldByThisJob) {
						settledNow.push({ id: norm.id, disposition: "deduplicated" });
					}
					continue;
				}

				const cls = classifyMessage(norm.content);
				if (cls === "noise" || cls === "utility") {
					skipped++;
					// IGNORE. Safe to advance the checkpoint past noise only when no
					// meaningful content is held before it (otherwise it's trailing
					// noise — drop it, but don't poison the held chunk).
					if (meaningfulCount(chunk) === 0) {
						checkpoint = norm.id;
						checkpointIdentity = dedupeIdentity;
						checkpointChanged = true;
						seen.add(dedupeIdentity);
					}
					settledNow.push({ id: norm.id, disposition: "skipped_noise" });
					continue;
				}

				chunk.push({ ...norm, _cls: cls, ...(opts.jobId ? { _job: opts.jobId } : {}) });
				chunkIdentities.add(dedupeIdentity);
				chunkIdentityOwners.set(dedupeIdentity, opts.jobId ?? null);
				held++;
				if (cls === "signal") lastSignal = true;
			}

			if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);

			const { fire } = shouldFire(chunk.filter((m) => !m._settled), {
				flush: Boolean(opts.flush),
				now: Date.now(),
				lastSignal,
			});

			const settledMessageIds = settledNow.map((item) => item.id);
			let result;
			let transactionFault = null;

			// Chunk/recent/attribution/queue and the applied marker are one local
			// commit. A crash can leave the earlier pending marker, or this complete
			// state, but never an unattributed partial handoff.
			await this.ctx.storage.transaction(async (txn) => {
				let current = null;
				if (opts._handoffMarker?.key) {
					current = await txn.get(opts._handoffMarker.key);
					if (
						!current
						|| current.state !== "pending"
						|| current.handoffId !== opts._handoffMarker.handoffId
						|| current.requestHash !== opts._handoffMarker.requestHash
						|| current.userId !== opts._handoffMarker.userId
					) {
						throw codedError("HANDOFF_STATE_INVALID", "handoff marker changed during queue acceptance");
					}
				}

				await txn.put("chunk", chunk);
				if (this.#shouldInjectHandoffFault(opts, "after_chunk_write")) {
					txn.rollback();
					transactionFault = "after_chunk_write";
					return;
				}
				await txn.put(scopedStorageKey("recent", requestedScopeKey), recent);
				if (this.#shouldInjectHandoffFault(opts, "after_recent_write")) {
					txn.rollback();
					transactionFault = "after_recent_write";
					return;
				}
				await txn.put("userId", userId);
				await txn.put("chunkScopeKey", requestedScopeKey);
				if (persistedOverrides !== undefined) {
					await txn.put("pendingOverrides", persistedOverrides);
					if (opts.jobId && held > 0) {
						const overridesByJob = (await txn.get("chunkOverridesByJob")) ?? {};
						overridesByJob[opts.jobId] = persistedOverrides;
						await txn.put("chunkOverridesByJob", overridesByJob);
					}
				}
				if (this.#shouldInjectHandoffFault(opts, "after_overrides_write")) {
					txn.rollback();
					transactionFault = "after_overrides_write";
					return;
				}
				if (checkpointChanged) {
					await txn.put(scopedStorageKey("checkpoint", requestedScopeKey), checkpoint);
					await txn.put(scopedStorageKey("checkpointIdentity", requestedScopeKey), checkpointIdentity);
				}
				if (seen.size !== state.seen.length) {
					await txn.put(scopedStorageKey("seen", requestedScopeKey), this.#capSeen([...seen]));
				}

				let queued = 0;
				if (fire) {
					const queueOverrides = persistedOverrides ?? (await txn.get("pendingOverrides")) ?? {};
					queued = await this.#enqueueChunkInTransaction(txn, userId, chunk, {
						overrides: queueOverrides,
						scopeKey: requestedScopeKey,
					});
				}
				result = { fired: fire, held, skipped, queued };
				if (current) {
					await txn.put(opts._handoffMarker.key, {
						...current,
						state: "applied",
						// Versioned proof that the marker and all local acceptance state
						// committed in this same Durable Object transaction. Job-less
						// diagnostic callers cannot be attributed through `_job`, so this
						// is their durable evidence if held work later moves or drains.
						localCommitVersion: 1,
						result,
						settledMessageIds,
						checkpointToMirror: checkpointChanged ? checkpoint : null,
						appliedAt: Date.now(),
					});
				}
			});

			if (transactionFault) return { _testHandoffFault: transactionFault };
			if (this.#shouldInjectHandoffFault(opts, "after_local_commit")) {
				return { ...result, _testHandoffFault: "after_local_commit" };
			}
			if (checkpointChanged) await this.#mirrorCheckpoint(userId, checkpoint);

			// A message finalized at the door settles its slice of the job NOW —
			// if that empties the job, the row goes terminal before we return.
			if (opts.jobId && settledMessageIds.length) {
				await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, [{
					jobId: opts.jobId,
					messageIds: settledMessageIds,
					disposition: "skipped",
				}]));
			}
			// Every exit guarantees a wake while work exists — fired or held.
			await this.#guaranteeWake();

			return result;
		});
	}

	async #mcpHandoffMarkerKey(handoffId) {
		return `${MCP_HANDOFF_MARKER_PREFIX}${await sha256Hex(handoffId)}`;
	}

	#shouldInjectMcpHandoffFault(options, phase) {
		return Boolean(
			String(this.env.DO_WAKE_ALARMS ?? "true") === "false"
			&& options?._testMcpFault === phase
		);
	}

	/**
	 * Permanent, content-bound MCP handoff. The sequence increment, queue entry,
	 * owner identity, and marker commit in one local transaction. An exact retry
	 * observes that marker and never creates a second queue entry; if an old or
	 * damaged queued marker has lost its entry, an active D1 retry repairs it.
	 */
	async enqueueMcpJobOnce(userId, job, options = {}) {
		if (!job?.jobId) return { queued: false, handoffAccepted: false };
		const handoffId = String(options.handoffId ?? job.jobId);
		const contentHash = String(options.contentHash ?? job.sourceMeta?.source_content_hash ?? "");
		if (!HANDOFF_ID_RE.test(handoffId)) {
			throw codedError("MCP_HANDOFF_ID_INVALID", "MCP handoff id is invalid");
		}
		if (!CONTENT_HASH_RE.test(contentHash)) {
			throw codedError("MCP_HANDOFF_HASH_INVALID", "MCP handoff content hash is invalid");
		}
		const markerKey = await this.#mcpHandoffMarkerKey(handoffId);
		const persistedJob = persistableOverrides(job);
		if (!persistedJob?.jobId) throw codedError("MCP_HANDOFF_JOB_INVALID", "MCP handoff job is not persistable");
		const now = Date.now();
		const result = await this.ctx.storage.transaction(async (txn) => {
			const existing = await txn.get(markerKey);
			if (existing) {
				if (
					existing.handoffId !== handoffId
					|| existing.jobId !== job.jobId
					|| existing.userId !== userId
					|| existing.contentHash !== contentHash
				) {
					throw codedError("MCP_HANDOFF_CONFLICT", "MCP handoff is already bound to different work");
				}
				if (existing.state === "terminal") {
					return {
						queued: false,
						terminal: true,
						duplicate: true,
						queueKey: existing.queueKey ?? null,
					};
				}
				if (existing.state !== "queued") {
					throw codedError("MCP_HANDOFF_STATE_INVALID", "MCP handoff marker state is invalid");
				}
				const queued = existing.queueKey ? await txn.get(existing.queueKey) : null;
				if (queued) {
					if (
						queued.kind !== "mcp"
						|| queued.job?.jobId !== job.jobId
						|| queued.mcpContentHash !== contentHash
					) {
						throw codedError("MCP_HANDOFF_STATE_INVALID", "MCP handoff queue ownership is inconsistent");
					}
					return { queued: true, terminal: false, duplicate: true, queueKey: existing.queueKey };
				}
			}

			const seq = Number((await txn.get("qseq")) ?? 0) + 1;
			const suffix = crypto.randomUUID().slice(0, 8);
			const queueKey = `q:${String(seq).padStart(10, "0")}-${suffix}`;
			await txn.put("qseq", seq);
			await txn.put(queueKey, {
				kind: "mcp",
				job: persistedJob,
				attempts: Number(job.attempts ?? 0),
				runAfter: 0,
				enqueuedAt: now,
				mcpHandoffMarkerKey: markerKey,
				mcpContentHash: contentHash,
			});
			await txn.put("userId", userId);
			await txn.put(markerKey, {
				handoffId,
				jobId: job.jobId,
				userId,
				contentHash,
				queueKey,
				state: "queued",
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				repairCount: Number(existing?.repairCount ?? 0) + (existing ? 1 : 0),
			});
			return { queued: true, terminal: false, duplicate: Boolean(existing), queueKey };
		});

		// This fault models an isolate dying after the durable local commit but
		// before either the alarm hint or the caller's successful response.
		if (this.#shouldInjectMcpHandoffFault(options, "after_local_enqueue")) {
			return {
				...result,
				handoffAccepted: true,
				handoffDuplicate: Boolean(result.duplicate),
				markerKey,
				_testMcpFault: "after_local_enqueue",
			};
		}
		if (result.queued) await this.#armAlarm(Date.now() + 50);
		return {
			...result,
			handoffAccepted: true,
			handoffDuplicate: Boolean(result.duplicate),
			markerKey,
		};
	}

	/** Backwards-compatible RPC surface for callers from a mixed deployment. */
	async enqueueMcpJob(userId, job) {
		return this.enqueueMcpJobOnce(userId, job, {
			handoffId: job?.jobId,
			contentHash: job?.sourceMeta?.source_content_hash,
		});
	}

	/**
	 * Oldest runnable queue entry, skipping backed-off ones and anything this
	 * drain invocation already attempted — one failing entry gets exactly one
	 * attempt per drain, then the queue moves past it.
	 */
	async #nextEntry(now, { ignoreBackoff = false, skip } = {}) {
		let found = null;
		await this.#scanQueue((key, entry) => {
			if (skip?.has(key)) return true;
			if (ignoreBackoff || Number(entry.runAfter ?? 0) <= now) {
				found = { key, entry };
				return false;
			}
			return true;
		});
		if (found) return found;
		// Legacy mcpjob:* entries written by the previous build may still be in
		// storage across the deploy — adopt them into the queue shape lazily.
		const legacy = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 });
		for (const [legacyKey] of legacy) {
			const adopted = await this.ctx.storage.transaction(async (txn) => {
				const job = await txn.get(legacyKey);
				if (!job) return null;
				const entry = { kind: "mcp", job, attempts: Number(job.attempts ?? 0), runAfter: 0, enqueuedAt: Date.now() };
				const seq = Number((await txn.get("qseq")) ?? 0) + 1;
				const queueKey = `q:${String(seq).padStart(10, "0")}-${crypto.randomUUID().slice(0, 8)}`;
				await txn.put("qseq", seq);
				await txn.put(queueKey, entry);
				await txn.delete(legacyKey);
				return { key: queueKey, entry };
			});
			if (adopted) return adopted;
		}
		return null;
	}

	/** Storage-backed lease acquire; null when someone else holds it. */
	async #acquireLease() {
		const now = Date.now();
		const lease = await this.ctx.storage.get("lease");
		if (lease && Number(lease.until) > now) return null;
		const token = crypto.randomUUID();
		await this.ctx.storage.put("lease", { until: now + LEASE_MS, token });
		return token;
	}

	async #refreshLease(token) {
		await this.ctx.storage.put("lease", { until: Date.now() + LEASE_MS, token });
	}

	async #releaseLease(token) {
		const lease = await this.ctx.storage.get("lease");
		if (!lease || lease.token === token) await this.ctx.storage.delete("lease");
	}

	/**
	 * THE drain loop — the only code that processes queue entries. Runs from
	 * the alarm, from a door's inline call (so `add()` can wait a bounded time
	 * for a real receipt), and from the reconciliation sweep's kick. All three
	 * are the same path; whoever gets the lease does the work.
	 *
	 * Returns { leased, remaining, results } — `leased: true` means another
	 * drain holds the lease and this call guaranteed a wake instead.
	 */
	async drain(opts = {}) {
		const maxJobs = Number(opts.maxJobs ?? MAX_JOBS_PER_DRAIN);
		const userId = opts.userId ?? (await this.ctx.storage.get("userId"));
		const results = [];
		if (!userId) return { leased: false, remaining: 0, results };

		const token = await this.#acquireLease();
		if (!token) {
			await this.#guaranteeWake();
			const lease = await this.ctx.storage.get("lease");
			if (lease) await this.#armAlarm(Number(lease.until) + 1000);
			return { leased: true, remaining: (await this.#scanQueue(() => true)).count, results };
		}

		try {
			// An idle-fire may be due (held chunk, no entries): check the trigger.
			const chunk = (await this.ctx.storage.get("chunk")) ?? [];
			const unsettled = chunk.filter((m) => !m._settled);
			if (unsettled.length > 0) {
				const { fire } = shouldFire(unsettled, { flush: Boolean(opts.forceFire), now: Date.now() });
				if (fire || opts.forceFire) await this.#enqueueFired(userId, { overrides: opts.forceFire ? opts.inlineOverrides : undefined });
			}

			const attempted = new Set();
			for (let i = 0; i < maxJobs; i++) {
				const next = await this.#nextEntry(Date.now(), { ignoreBackoff: Boolean(opts.ignoreBackoff), skip: attempted });
				if (!next) break;
				attempted.add(next.key);
				await this.#refreshLease(token);
				const result = next.entry.kind === "mcp"
					? await this.#processMcpEntry(userId, next.key, next.entry)
					: await this.#processExtractEntry(userId, next.key, next.entry, opts.inlineOverrides);
				if (result) results.push(result);
			}
		} finally {
			await this.#releaseLease(token);
			// The one non-negotiable: never return while storage holds work
			// without a guaranteed future alarm.
			await this.#guaranteeWake();
		}

		const remaining = (await this.#scanQueue(() => true)).count;
		return { leased: false, remaining, results };
	}

	async #finishMcpEntry(key, entry, outcome) {
		await this.ctx.storage.transaction(async (txn) => {
			const markerKey = entry?.mcpHandoffMarkerKey ?? null;
			if (markerKey) {
				const marker = await txn.get(markerKey);
				if (marker) {
					if (
						marker.jobId !== entry.job?.jobId
						|| marker.contentHash !== entry.mcpContentHash
					) {
						throw codedError("MCP_HANDOFF_STATE_INVALID", "MCP terminal handoff ownership is inconsistent");
					}
					if (marker.queueKey === key) {
						// D1 is the permanent replay verdict. Once it is terminal, the
						// local marker and queue entry can be compacted atomically.
						await txn.delete(markerKey);
					}
				}
			}
			await txn.delete(key);
		});
	}

	async #finishConfirmedMcp(userId, key, entry, status, { repairFailure = true } = {}) {
		try {
			if (status === "failed" && repairFailure) {
				await markMcpEnrichmentFailed(
					this.env,
					userId,
					entry.job,
					entry.terminalReason ?? "MCP enrichment failed",
					(promise) => this.ctx.waitUntil(promise),
				);
			}
			await announceMcpTerminal(
				this.env,
				userId,
				entry.job,
				(promise) => this.ctx.waitUntil(promise),
			);
		} catch (error) {
			const settlementAttempts = Number(entry.settlementAttempts ?? 0) + 1;
			await this.ctx.storage.put(key, {
				...entry,
				phase: "announcement_pending",
				settlementAttempts,
				runAfter: Date.now() + backoffMs(settlementAttempts),
			});
			return { kind: "mcp", jobId: entry.job.jobId, outcome: "announcement_pending", retry: true };
		}
		const outcome = status === "failed" ? "failed" : "enriched";
		await this.#finishMcpEntry(key, entry, outcome);
		return { kind: "mcp", jobId: entry.job.jobId, outcome };
	}

	/** One MCP enrichment entry. The engine's own bookkeeping marks the D1 job. */
	async #processMcpEntry(userId, key, entry) {
		const durableState = await this.#memoryJobState(userId, entry.job?.jobId);
		if (durableState && TERMINAL_JOB_STATES.has(durableState.status)) {
			return this.#finishConfirmedMcp(userId, key, entry, durableState.status, {
				repairFailure: entry.phase !== "announcement_pending",
			});
		}

		if (entry.phase === "terminal_pending") {
			try {
				await markMcpEnrichmentFailed(
					this.env,
					userId,
					entry.job,
					entry.terminalReason ?? "MCP terminal bookkeeping was interrupted",
					(promise) => this.ctx.waitUntil(promise),
				);
				const confirmed = await this.#memoryJobState(userId, entry.job?.jobId);
				if (!confirmed || !TERMINAL_JOB_STATES.has(confirmed.status)) {
					throw new Error("MCP terminal bookkeeping remains unconfirmed");
				}
				return this.#finishConfirmedMcp(userId, key, entry, confirmed.status, { repairFailure: false });
			} catch (error) {
				const settlementAttempts = Number(entry.settlementAttempts ?? 0) + 1;
				await this.ctx.storage.put(key, {
					...entry,
					settlementAttempts,
					runAfter: Date.now() + backoffMs(settlementAttempts),
				});
				return { kind: "mcp", jobId: entry.job.jobId, outcome: "settlement_pending", retry: true };
			}
		}

		let res;
		try {
			res = await enrichMcpConversation(
				this.env,
				userId,
				{ ...entry.job, attempts: entry.attempts },
				(p) => this.ctx.waitUntil(p),
			);
		} catch (error) {
			// enrichMcpConversation catches internally; this is belt-and-braces.
			res = { retry: true, reason: String(error?.message ?? error) };
		}
		if (res?.retry) {
			if (res.inProgress) {
				return {
					kind: "mcp",
					jobId: entry.job.jobId,
					outcome: "in_progress",
					retry: true,
					attempts: Number(entry.attempts ?? 0),
				};
			}
			const attempts = entry.attempts + 1;
			if (res.terminalPending) {
				await this.ctx.storage.put(key, {
					...entry,
					phase: "terminal_pending",
					terminalReason: String(res.reason ?? "MCP terminal bookkeeping was interrupted").slice(0, 400),
					settlementAttempts: 1,
					runAfter: Date.now() + backoffMs(1),
				});
				return { kind: "mcp", jobId: entry.job.jobId, outcome: "settlement_pending", retry: true };
			}
			if (attempts >= MAX_ATTEMPTS) {
				// Dead-letter here too, in case the engine's internal cap moves.
				const terminalReason = `retries exhausted (${res.reason ?? "transient failure"})`;
				await this.ctx.storage.put(key, {
					...entry,
					attempts,
					phase: "terminal_pending",
					terminalReason,
					settlementAttempts: 0,
					runAfter: 0,
				});
				return this.#processMcpEntry(userId, key, {
					...entry,
					attempts,
					phase: "terminal_pending",
					terminalReason,
					settlementAttempts: 0,
				});
			}
			await this.ctx.storage.put(key, { ...entry, attempts, runAfter: Date.now() + backoffMs(attempts) });
			return { kind: "mcp", jobId: entry.job.jobId, outcome: "retry", attempts };
		}
		const confirmed = await this.#memoryJobState(userId, entry.job?.jobId);
		if (!confirmed || !TERMINAL_JOB_STATES.has(confirmed.status)) {
			const terminalReason = "MCP engine returned without a durable terminal job verdict";
			await this.ctx.storage.put(key, {
				...entry,
				phase: "terminal_pending",
				terminalReason,
				settlementAttempts: 0,
				runAfter: Date.now() + backoffMs(1),
			});
			return { kind: "mcp", jobId: entry.job.jobId, outcome: "settlement_pending", retry: true };
		}
		return this.#finishConfirmedMcp(userId, key, entry, confirmed.status, { repairFailure: false });
	}

	/**
	 * Older deployments could place messages owned by several accept-time jobs
	 * in one extraction entry while retaining only the newest job's overrides.
	 * Split such an entry before inference. Child keys remain immediately after
	 * the original key in lexical queue order, and the replacement is atomic, so
	 * a crash yields either the original entry or the complete ordered split.
	 */
	async #splitMixedExtractEntry(key, entry) {
		const messages = entry.messages ?? [];
		const ownership = entry.jobByMessage ?? {};
		const segments = [];
		for (const message of messages) {
			const jobId = ownership[message?.id] ?? null;
			const previous = segments[segments.length - 1];
			if (!previous || previous.jobId !== jobId) {
				segments.push({ jobId, messages: [] });
			}
			segments[segments.length - 1].messages.push(message);
		}
		if (segments.length <= 1) return false;

		await this.ctx.storage.transaction(async (txn) => {
			const current = await txn.get(key);
			if (!current) return;
			for (let index = 0; index < segments.length; index++) {
				const segment = segments[index];
				const childKey = `${key}:split:${String(index).padStart(4, "0")}`;
				const childOwnership = segment.jobId
					? Object.fromEntries(segment.messages.map((message) => [message.id, segment.jobId]))
					: {};
				const childDedupe = Object.fromEntries(
					segment.messages
						.filter((message) => entry.dedupeByMessage?.[message.id] ?? message._dedupe)
						.map((message) => [message.id, entry.dedupeByMessage?.[message.id] ?? message._dedupe]),
				);
				await txn.put(childKey, {
					...current,
					messages: segment.messages,
					jobByMessage: childOwnership,
					dedupeByMessage: childDedupe,
					splitFromMixedEntry: true,
				});
			}
			await txn.delete(key);
		});
		return true;
	}

	/**
	 * Source packets are immutable. Rehydrate their attribution from D1 for the
	 * one job owned by this queue entry instead of trusting mutable held-chunk
	 * overrides. Raw content is never logged or copied into tracing metadata.
	 */
	async #authoritativeExtractOverrides(userId, entry, baseOverrides) {
		const jobIds = [...new Set(Object.values(entry.jobByMessage ?? {}).filter(Boolean))];
		if (jobIds.length !== 1) return baseOverrides;
		const job = await this.env.DB.prepare(
			"SELECT id, type, source_packet_id, payload_json FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(jobIds[0], userId).first();
		if (!job?.source_packet_id) return baseOverrides;
		if (job.type !== "extract") {
			throw codedError("EXTRACT_JOB_OWNERSHIP_INVALID", "extract queue entry belongs to another job lane");
		}
		const sourcePacket = await this.env.DB.prepare(
			"SELECT * FROM source_packets WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(job.source_packet_id, userId).first();
		if (!sourcePacket) {
			throw codedError("EXTRACT_SOURCE_MISSING", "extract queue entry has no immutable source packet");
		}
		let payload = {};
		try { payload = JSON.parse(job.payload_json ?? "{}") ?? {}; } catch {}
		return {
			...(baseOverrides ?? {}),
			...(payload.source ? { source: payload.source } : {}),
			meta: {
				...(baseOverrides?.meta ?? {}),
				...sourceMeta(sourcePacket),
			},
		};
	}

	#extractJobIds(entry) {
		return [...new Set(Object.values(entry.jobByMessage ?? {}).filter(Boolean))];
	}

	#extractJobUpdates(entry, disposition, extra = {}) {
		const byJob = new Map();
		for (const [messageId, jobId] of Object.entries(entry.jobByMessage ?? {})) {
			if (!jobId) continue;
			if (!byJob.has(jobId)) byJob.set(jobId, []);
			byJob.get(jobId).push(messageId);
		}
		return [...byJob.entries()].map(([jobId, messageIds]) => ({
			jobId,
			messageIds,
			disposition,
			...extra,
		}));
	}

	async #terminalHandoffMarkerKeys(entry) {
		return Promise.all(this.#extractJobIds(entry).map((jobId) => this.#handoffMarkerKey(jobId)));
	}

	async #persistExtractSettlement(userId, key, entry, result, {
		action,
		processedIds,
		processedIdentities,
		lastId,
		lastIdentity,
		error = null,
	} = {}) {
		const receiptId = result.receipt
			? (result.receipt.id ?? `receipt_extract_${await sha256Hex(`${userId}\u0000${key}`)}`)
			: null;
		const fullReceipt = result.receipt && receiptId
			? { ...result.receipt, id: receiptId }
			: null;
		// D1 owns the complete audit receipt. Durable Object retry state keeps only
		// a bounded, content-free projection; persisting that projection as the
		// canonical receipt would discard delivery, project, actions, gate reasons,
		// and saved labels. The deterministic id makes this safe across replay.
		if (fullReceipt) {
			await storeReceipt(
				this.env,
				userId,
				fullReceipt.source,
				fullReceipt,
				result.summary ?? formatReceipt(fullReceipt),
				{ strict: true },
			);
		}
		const receipt = compactTerminalReceipt(fullReceipt, receiptId);
		const counts = action === "rescue"
			? { nodes: 0, slices: 0, events: 0, edges: 0 }
			: (receipt?.saved ?? null);
		const disposition = action === "failed" ? "failed" : "processed";
		const jobUpdates = this.#extractJobUpdates(entry, disposition, {
			...(counts ? { counts } : {}),
			...(receiptId ? { receiptId } : {}),
			...(error ? { error: String(error).slice(0, 400) } : {}),
		});
		const pending = {
			...entry,
			phase: "settlement_pending",
			settlementAttempts: Number(entry.settlementAttempts ?? 0),
			runAfter: 0,
			terminal: {
				version: 1,
				action,
				outcome: result.outcome,
				receipt,
				summary: String(result.summary ?? (receipt ? formatReceipt(receipt) : "")).slice(0, 1000),
				jobUpdates,
				processedIds,
				processedIdentities,
				lastId,
				lastIdentity,
				error: error ? String(error).slice(0, 400) : null,
			},
		};
		await this.ctx.storage.put(key, pending);
		return pending;
	}

	async #finalizeExtractQueueState(userId, key, entry, terminal) {
		const scopeKey = cleanScopeKey(entry.scopeKey);
		const markerKeys = await this.#terminalHandoffMarkerKeys(entry);
		if (terminal.action === "rescue") {
			await this.ctx.blockConcurrencyWhile(async () => {
				let chunk = (await this.ctx.storage.get("chunk")) ?? [];
				const chunkScopeKey = cleanScopeKey(await this.ctx.storage.get("chunkScopeKey"));
				if (chunk.length > 0 && chunkScopeKey !== scopeKey) {
					await this.#enqueueFired(userId, { scopeKey: chunkScopeKey });
					chunk = [];
				}
				await this.ctx.storage.transaction(async (txn) => {
					chunk = (await txn.get("chunk")) ?? chunk;
					const chunkIdentities = new Set(chunk.map((message) => message._dedupe).filter(Boolean));
					const restored = (entry.messages ?? [])
						.filter((message) => !chunkIdentities.has(entry.dedupeByMessage?.[message.id]))
						.map((message) => ({
							...message,
							_settled: true,
							_cls: "meaningful",
							...(entry.jobByMessage?.[message.id] ? { _job: entry.jobByMessage[message.id] } : {}),
							...(entry.dedupeByMessage?.[message.id] ? { _dedupe: entry.dedupeByMessage[message.id] } : {}),
						}));
					await txn.put("chunk", [...restored, ...chunk]);
					await txn.put("chunkScopeKey", scopeKey);
					if (chunk.length === 0) {
						await txn.put("pendingOverrides", persistableOverrides(entry.overrides ?? {}));
					}
					const jobIds = this.#extractJobIds(entry);
					if (jobIds.length === 1) {
						const overridesByJob = (await txn.get("chunkOverridesByJob")) ?? {};
						overridesByJob[jobIds[0]] = persistableOverrides(entry.overrides ?? {});
						await txn.put("chunkOverridesByJob", overridesByJob);
					}
					await txn.delete(key);
					for (const markerKey of markerKeys) await txn.delete(markerKey);
				});
			});
			return;
		}

		await this.ctx.storage.transaction(async (txn) => {
			if (terminal.action === "complete" && terminal.lastId) {
				await txn.put(scopedStorageKey("checkpoint", scopeKey), terminal.lastId);
				if (terminal.lastIdentity) {
					await txn.put(scopedStorageKey("checkpointIdentity", scopeKey), terminal.lastIdentity);
				}
			}
			const seenKey = scopedStorageKey("seen", scopeKey);
			const seen = (await txn.get(seenKey)) ?? [];
			await txn.put(seenKey, this.#capSeen([
				...new Set([...seen, ...(terminal.processedIdentities ?? [])]),
			]));
			await txn.delete(key);
			for (const markerKey of markerKeys) await txn.delete(markerKey);
		});
		if (terminal.action === "complete" && terminal.lastId) {
			await this.#mirrorCheckpoint(userId, terminal.lastId);
		}
	}

	async #processPendingExtract(userId, key, entry, inlineOverrides = null) {
		const terminal = entry.terminal;
		if (!terminal || terminal.version !== 1) {
			throw codedError("SETTLEMENT_STATE_INVALID", "extract settlement retry state is invalid");
		}
		const result = {
			outcome: terminal.outcome,
			receipt: terminal.receipt ?? null,
			summary: terminal.summary ?? null,
		};
		try {
			if (terminal.receipt) {
				await storeReceipt(
					this.env,
					userId,
					terminal.receipt.source,
					terminal.receipt,
					terminal.summary,
					{ strict: true },
				);
				const stored = await this.env.DB.prepare(
					"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
				).bind(terminal.receipt.id, userId).first();
				let fullReceipt = null;
				try { fullReceipt = JSON.parse(stored?.detail ?? "null"); } catch {}
				if (!fullReceipt || fullReceipt.id !== terminal.receipt.id) {
					throw new Error("terminal receipt detail is missing or inconsistent");
				}
				result.receipt = fullReceipt;
				result.summary = stored.summary ?? terminal.summary ?? formatReceipt(fullReceipt);
			}
			if (typeof inlineOverrides?._testBeforeJobSettlement === "function") {
				await inlineOverrides._testBeforeJobSettlement();
			}
			await settleMemoryJobs(
				this.env,
				userId,
				terminal.jobUpdates ?? [],
				{ strict: true },
			);
			const durableTransitions = [];
			for (const jobId of this.#extractJobIds(entry)) {
				const row = await this.env.DB.prepare(
					"SELECT status, source_packet_id, receipt_id, payload_json, error FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
				).bind(jobId, userId).first();
				if (!row || !TERMINAL_JOB_STATES.has(row.status)) {
					throw new Error(`memory job ${jobId} has no terminal settlement evidence`);
				}
				let payload = {};
				try { payload = JSON.parse(row.payload_json ?? "{}") ?? {}; } catch {}
				durableTransitions.push({
					jobId,
					status: row.status === "failed" ? "failed" : "enriched",
					sourcePacketId: row.source_packet_id ?? null,
					// The settlement CAS is the ownership authority. If it rejected
					// a cross-packet receipt, never reintroduce that id in a webhook.
					receiptId: row.receipt_id ?? null,
					project_id: payload.project_id ?? null,
					project_name: payload.project_name ?? null,
					saved: payload.saved ?? terminal.receipt?.saved ?? null,
					error: row.error ?? terminal.error ?? null,
				});
			}
			// The outbox rows are deterministic. Reaching D1 terminal and then
			// crashing cannot lose or duplicate a lifecycle/graph announcement.
			await this.#announceWrite(userId, result, { strict: true });
			await this.#announceJobTransitions(userId, durableTransitions, { strict: true });
		} catch (error) {
			const settlementAttempts = Number(entry.settlementAttempts ?? 0) + 1;
			await this.ctx.storage.put(key, {
				...entry,
				settlementAttempts,
				runAfter: Date.now() + backoffMs(settlementAttempts),
			});
			return {
				kind: "extract",
				outcome: "settlement_pending",
				retry: true,
				attempts: settlementAttempts,
				jobIds: this.#extractJobIds(entry),
			};
		}

		await this.#finalizeExtractQueueState(userId, key, entry, terminal);
		if (terminal.action === "failed") {
			await reportServerError(
				this.env,
				"extract_poison",
				new Error(terminal.error ?? "entry dead-lettered"),
				userId,
			);
		}
		return {
			kind: "extract",
			outcome: terminal.action === "failed" ? "failed" : terminal.outcome,
			receipt: result.receipt ?? null,
			summary: result.summary ?? null,
			jobIds: this.#extractJobIds(entry),
		};
	}

	/**
	 * One extraction entry: run the engine over its messages, then do the
	 * bookkeeping the outcome demands. At-least-once safe: the graph write
	 * inside the pipeline is one atomic D1 batch, and job settlement is
	 * recorded BEFORE the entry is deleted, so a crash between the two leaves
	 * a settled job with a stale entry — re-running it re-extracts into
	 * canonical-match upserts, never duplicate rows.
	 */
	async #processExtractEntry(userId, key, entry, inlineOverrides = null) {
		if (entry.phase === "settlement_pending") {
			return this.#processPendingExtract(userId, key, entry, inlineOverrides);
		}
		if (await this.#splitMixedExtractEntry(key, entry)) {
			return { kind: "extract", outcome: "split_mixed_ownership", jobIds: [] };
		}
		const ownedJobs = this.#extractJobIds(entry);
		if (ownedJobs.length > 0) {
			const states = await Promise.all(ownedJobs.map((jobId) => this.#memoryJobState(userId, jobId)));
			if (states.every((state) => state && TERMINAL_JOB_STATES.has(state.status))) {
				const markerKeys = await this.#terminalHandoffMarkerKeys(entry);
				await this.ctx.storage.transaction(async (txn) => {
					await txn.delete(key);
					for (const markerKey of markerKeys) await txn.delete(markerKey);
				});
				return { kind: "extract", outcome: "recovered_terminal", jobIds: ownedJobs };
			}
		}
		// Queue entries keep the project that fired them. State used for
		// extraction must follow that immutable entry, not whichever project most
		// recently appended to this account's shared coordinator.
		const scopeKey = cleanScopeKey(entry.scopeKey);
		const recent = (await this.ctx.storage.get(scopedStorageKey("recent", scopeKey))) ?? [];
		// The entry's own persisted overrides win (they carry the packet's true
		// source attribution); inline values fill gaps — except function-valued
		// test hooks, which can never be persisted and therefore always apply.
		let overrides = { ...(inlineOverrides ?? {}), ...(entry.overrides ?? {}) };
		for (const [k, v] of Object.entries(inlineOverrides ?? {})) {
			if (typeof v === "function") overrides[k] = v;
		}
		overrides = await this.#authoritativeExtractOverrides(userId, entry, overrides);
		const dedupeByMessage = { ...(entry.dedupeByMessage ?? {}) };
		for (const message of entry.messages ?? []) {
			if (!dedupeByMessage[message.id]) {
				dedupeByMessage[message.id] = (await messageDedupeIdentity(scopeKey, overrides, message)).identity;
			}
		}
		entry.dedupeByMessage = dedupeByMessage;
		if (Date.now() - Number(entry.enqueuedAt ?? 0) > BACKLOG_AGE_MS) {
			overrides.meta = { ...(overrides.meta ?? {}), drained_from_backlog: true };
		}

		const messages = entry.messages ?? [];
		const processedIds = messages.map((m) => m.id);
		const processedIdentities = messages.map((message) => dedupeByMessage[message.id]).filter(Boolean);
		const lastId = processedIds[processedIds.length - 1] ?? null;
		const lastIdentity = lastId ? dedupeByMessage[lastId] ?? null : null;
		const extractionAttempt = Number(entry.attempts ?? 0);
		const extractionRunId = `run_extract_${(await sha256Hex(`${userId}\u0000${key}\u0000${extractionAttempt}`)).slice(0, 48)}`;

		let result;
		try {
			result = await runExtractionPipeline(
				this.env,
				userId,
				messages,
				recent,
				overrides,
				{ runId: extractionRunId },
			);
		} catch (error) {
			// An engine throw (not a reported outcome) counts as an attempt like
			// any other transient failure — recorded, bounded, never head-of-line.
			result = { outcome: "llm_failed", error: String(error?.message ?? error) };
			console.warn(`extraction threw user=${userId}:`, result.error);
		}
		if (result.outcome === "in_progress") {
			// Another drain owns this deterministic attempt. Leave the queue entry
			// byte-for-byte unchanged; that owner will publish settlement, and D1's
			// extraction-run primary key prevents a second model invocation.
			return {
				kind: "extract",
				outcome: "in_progress",
				retry: true,
				attempts: extractionAttempt,
				jobIds: this.#extractJobIds(entry),
			};
		}
		if (typeof inlineOverrides?._testAfterExtraction === "function") {
			await inlineOverrides._testAfterExtraction(result);
		}

		if (result.receipt) result.summary = formatReceipt(result.receipt);

		const finalizedNoWrite = result.outcome === "no_write" && result.receipt?.reason === "user_opt_out";

		if (result.outcome === "wrote" || finalizedNoWrite) {
			const pending = await this.#persistExtractSettlement(userId, key, entry, result, {
				action: "complete",
				processedIds,
				processedIdentities,
				lastId,
				lastIdentity,
			});
			return this.#processPendingExtract(userId, key, pending, overrides);
		}

		if (result.outcome === "meaningful_no_write") {
			const pending = await this.#persistExtractSettlement(userId, key, entry, result, {
				action: "rescue",
				processedIds,
				processedIdentities,
				lastId,
				lastIdentity,
			});
			return this.#processPendingExtract(userId, key, pending, overrides);
			// The engine looked and found nothing durable. The JOB settles now —
			// visible, terminal, zero saved — while the messages return to the
			// held chunk as a rescue buffer: future context may still redeem
			// them, and if it never comes they are already accounted for.
				// A no-write rescue buffer is still project-owned. If another
				// project arrived while this entry was extracting, fire that held
				// chunk first and restore this entry only under its original scope.
			// When the rescued entry becomes the new held chunk, its own immutable
			// attribution must become the pending attribution too. Otherwise a later
			// fire can write project A's rescued text with project B's source metadata.
			// If newer same-project messages are already held, keep their pending
			// metadata; Stage 5 snapshots context per job rather than rewriting it here.
		}

		if (result.outcome === "interrupted_unknown") {
			const error = String(result.error ?? "inference outcome is unknown after an interrupted attempt").slice(0, 400);
			const pending = await this.#persistExtractSettlement(userId, key, entry, result, {
				action: "failed",
				processedIds,
				processedIdentities,
				lastId,
				lastIdentity,
				error,
			});
			return this.#processPendingExtract(userId, key, pending, overrides);
		}

		// llm_failed / db_write_failed / engine throw → bounded retry with
		// backoff; the queue moves on past this entry meanwhile (1.5).
		const attempts = entry.attempts + 1;
		if (attempts >= MAX_ATTEMPTS) {
			const error = `entry dead-lettered after ${attempts} attempts: ${result.error ?? result.outcome}`;
			const pending = await this.#persistExtractSettlement(userId, key, { ...entry, attempts }, result, {
				action: "failed",
				processedIds,
				processedIdentities,
				lastId,
				lastIdentity,
				error,
			});
			return this.#processPendingExtract(userId, key, pending, overrides);
		}
		if (result.receipt) {
			await storeReceipt(this.env, userId, result.receipt.source, result.receipt, result.summary);
		}
		const retryEntry = { ...entry, attempts, runAfter: Date.now() + backoffMs(attempts) };
		await this.ctx.storage.put(key, retryEntry);
		try {
			await settleMemoryJobs(
				this.env,
				userId,
				this.#extractJobUpdates(entry, "attempted", { attempts }),
				{ strict: true },
			);
		} catch (error) {
			console.warn("extract attempt bookkeeping deferred:", error?.message ?? error);
		}
		return { kind: "extract", outcome: result.outcome, retry: true, attempts, receipt: result.receipt ?? null, jobIds: [...new Set(Object.values(entry.jobByMessage ?? {}))] };
	}

	/**
	 * Job lifecycle webhooks (Part 2.3): memory.enriched / memory.failed fire
	 * exactly once per accepted write, on its terminal transition. Metadata
	 * only — ids, status, counts — never memory content.
	 */
	async #announceJobTransitions(userId, transitions = [], { strict = false } = {}) {
		// 8.2 upgrade: a job that reached a terminal state has its content in
		// the graph (or a visible failure) — its staged text stops answering.
		const terminalJobs = (transitions ?? []).map((t) => t.jobId).filter(Boolean);
		if (terminalJobs.length) await settleStagedText(this.env, userId, terminalJobs);
		for (const t of transitions ?? []) {
			const event = t.status === "failed" ? "memory.failed" : "memory.enriched";
			const data = {
				job_id: t.jobId,
				source_packet_id: t.sourcePacketId ?? null,
				receipt_id: t.receiptId ?? null,
				status: t.status,
				counts: t.saved ?? null,
				project_id: t.project_id ?? null,
				project_name: t.project_name ?? null,
				...(t.error ? { error: String(t.error).slice(0, 200) } : {}),
			};
			// Await the delivery-row insert (bounded D1 work); the HTTP attempt
			// itself stays deferred through the waitUntil handed to the emitter.
			try {
				await emitWebhookEvent(this.env, (promise) => this.ctx.waitUntil(promise), userId, event, data, {
					eventId: `job:${t.jobId}:${t.status}`,
					strict,
				});
			} catch (error) {
				if (strict) throw error;
				console.warn("job webhook failed:", error?.message ?? error);
			}
		}
	}

	/** Webhook announcements for a landed write — after the fact, async, unfailable. */
	async #announceWrite(userId, result, { strict = false } = {}) {
		if (result.outcome !== "wrote" || !result.receipt) return;
		const saved = result.receipt.saved ?? {};
		const added = (saved.nodes ?? 0) + (saved.slices ?? 0) + (saved.events ?? 0) + (saved.edges ?? 0) > 0;
		const updated = (saved.updatedNodes ?? 0) + (saved.supersededSlices ?? 0) > 0;
		const event = added ? "memory.added" : updated ? "memory.updated" : null;
		if (!event) return;
		const data = webhookDataFromReceipt(result.receipt);
		// Scoped saves (SDK sub-tenants, plugin project spaces) announce to the
		// OWNING account's webhooks too — the sub-tenant id is derived and owns
		// no configuration of its own.
		const targets = new Set([userId]);
		try {
			const owner = JSON.parse(result.receipt.scope_json ?? "{}")?.owner_user_id;
			if (owner && owner !== "legacy") targets.add(owner);
		} catch {}
		for (const target of targets) {
			try {
				await emitWebhookEvent(this.env, (promise) => this.ctx.waitUntil(promise), target, event, data, {
					eventId: `receipt:${result.receipt.id}:${event}:${target}`,
					strict,
				});
			} catch (error) {
				if (strict) throw error;
				console.warn("write webhook failed:", error?.message ?? error);
			}
		}
	}

	/**
	 * Back-compat surface (tests, tools): force-fire everything held with the
	 * given overrides and drain inline. `{ skipped: true }` when another drain
	 * holds the lease — the work is queued and alarm-guaranteed either way.
	 */
	async runExtraction(userId, overrides = {}) {
		const drained = await this.drain({
			userId,
			maxJobs: 10,
			forceFire: true,
			inlineOverrides: overrides,
		});
		if (drained.leased) return { skipped: true };
		const extract = drained.results.find((r) => r.kind === "extract");
		if (!extract) return { outcome: "empty" };
		return { outcome: extract.outcome, receipt: extract.receipt ?? null, summary: extract.summary ?? null, retry: extract.retry ?? false };
	}

	/**
	 * Back-compat surface for MCP tests/tools: drain and report queue state.
	 * Explicit manual drains ignore retry backoff — a human (or test) asking
	 * "process it NOW" outranks the scheduler's politeness.
	 */
	async drainMcpJobs(userId) {
		const drained = await this.drain({ userId, maxJobs: 10, ignoreBackoff: true });
		return { remaining: drained.remaining, busySkip: drained.leased };
	}

	async #pruneTerminalHandoffMarkers(userId, limit = 64) {
		const candidates = [];
		for (const prefix of [HANDOFF_MARKER_PREFIX, MCP_HANDOFF_MARKER_PREFIX]) {
			if (candidates.length >= limit) break;
			await this.#scanStoredPrefix(prefix, (key, marker) => {
				if (marker?.jobId) candidates.push({ key, marker });
				return candidates.length < limit;
			}, Math.min(64, limit));
		}
		let pruned = 0;
		for (const candidate of candidates) {
			const job = await this.#memoryJobState(userId, candidate.marker.jobId);
			if (!job || !TERMINAL_JOB_STATES.has(job.status)) continue;
			await this.ctx.storage.transaction(async (txn) => {
				const current = await txn.get(candidate.key);
				if (!current || current.jobId !== candidate.marker.jobId) return;
				if (current.queueKey) await txn.delete(current.queueKey);
				await txn.delete(candidate.key);
			});
			pruned++;
		}
		return pruned;
	}

	/**
	 * Reconciliation sweep's poke: wake up and drain — and report exactly WHICH
	 * jobs this object actually holds work for.
	 *
	 * That last part is what stops the sweep lying. A kick can only drain what
	 * is in storage; if a job row exists with no queue entry and no held
	 * message behind it, no amount of kicking will ever settle it. Returning
	 * the known job ids lets the sweep tell "wake up, you have work" apart from
	 * "this job is orphaned" instead of reporting a rescue it did not achieve.
	 */
	async kick(userId) {
		if (userId) await this.ctx.storage.put("userId", userId);
		if (userId) await this.#pruneTerminalHandoffMarkers(userId);
		await this.#armAlarm(Date.now() + 50);
		const chunk = (await this.ctx.storage.get("chunk")) ?? [];
		const jobIds = new Set();
		const queueScan = await this.#scanQueue((_key, entry) => {
			if (entry?.job?.jobId) jobIds.add(entry.job.jobId);
			for (const jobId of Object.values(entry?.jobByMessage ?? {})) jobIds.add(jobId);
			return true;
		});
		const legacyScan = await this.#scanStoredPrefix("mcpjob:", (_key, job) => {
			if (job?.jobId) jobIds.add(job.jobId);
			return true;
		});
		for (const msg of chunk) if (msg?._job) jobIds.add(msg._job);
		return {
			queued: queueScan.count + legacyScan.count,
			held: chunk.length,
			jobIds: [...jobIds],
		};
	}

	/**
	 * Build a memory export. It lives here because reading every table a person
	 * owns is slow enough to hold a response open, and the DO already owns this
	 * user's serialized work. It touches no held state, so an export in flight
	 * can never disturb ingest.
	 */
	async runExport(userId, exportId) {
		return runExportJob(this.env, userId, exportId);
	}

	/** Inspect held state — used by tests to assert chunk/queue retention. */
	async getDebugState() {
		const scopeKey = cleanScopeKey(await this.ctx.storage.get("chunkScopeKey"));
		const { chunk, checkpoint } = await this.#load(scopeKey);
		let queuedMessages = 0;
		const queueScan = await this.#scanQueue((_key, entry) => {
			queuedMessages += entry.kind === "extract" ? (entry.messages?.length ?? 0) : 0;
			return true;
		});
		const lease = await this.ctx.storage.get("lease");
		return {
			chunkSize: chunk.length + queuedMessages,
			heldSize: chunk.length,
			queuedEntries: queueScan.count,
			queuedMessages,
			checkpoint,
			scopeKey,
			leased: Boolean(lease && Number(lease.until) > Date.now()),
		};
	}

	/** Clear held ingest state after an explicit DELETE ALL reset. */
	async resetAll() {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll();
			// deleteAll clears values, not alarms — an orphaned alarm would wake
			// a wiped instance (and in tests, fire into storage teardown).
			await this.ctx.storage.deleteAlarm();
		});
		return { reset: true };
	}

	async alarm() {
		const userId = await this.ctx.storage.get("userId");
		if (!userId) {
			// No identity means nothing can be processed — but if work exists,
			// that is a bug worth hearing about, not a silent return.
			const entries = await this.ctx.storage.list({ prefix: "q:", limit: 1 });
			if (entries.size > 0) {
				await reportServerError(this.env, "do_alarm_no_user", new Error("queue entries with no userId"), null);
			}
			return;
		}
		await this.drain({ userId, maxJobs: MAX_JOBS_PER_DRAIN });
	}
}
