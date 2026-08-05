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
import { enrichMcpConversation } from "../pipeline/mcp_engine.js";
import { formatReceipt } from "../pipeline/receipt.js";
import { runExport as runExportJob } from "../pipeline/exports.js";
import { storeReceipt, settleMemoryJobs } from "../lib/db.js";
import { reportServerError } from "../lib/report.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "../pipeline/webhooks.js";
import { settleStagedText } from "../pipeline/staged_text.js";
import { DIALS } from "../config.js";

const RECENT_LIMIT = 20;

// 1.6 chunk caps: a queue entry never exceeds either bound, whichever first.
// ~4 chars/token puts 12k chars near the 3k-token input budget that keeps one
// extraction call fast, parseable, and cheap to retry.
const MAX_ENTRY_MSGS = 20;
const MAX_ENTRY_CHARS = 12000;

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

function cleanScopeKey(value) {
	const key = String(value ?? GLOBAL_SCOPE_KEY).trim();
	return key && key.length <= 180 ? key : GLOBAL_SCOPE_KEY;
}

function scopedStorageKey(base, scopeKey) {
	const key = cleanScopeKey(scopeKey);
	return key === GLOBAL_SCOPE_KEY ? base : `${base}:${key}`;
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

export class UserMemory extends DurableObject {
	async #load(scopeKey = GLOBAL_SCOPE_KEY) {
		const key = cleanScopeKey(scopeKey);
		const [chunk, recent, checkpoint, userId, seen, chunkScopeKey] = await Promise.all([
			this.ctx.storage.get("chunk"),
			this.ctx.storage.get(scopedStorageKey("recent", key)),
			this.ctx.storage.get(scopedStorageKey("checkpoint", key)),
			this.ctx.storage.get("userId"),
			this.ctx.storage.get(scopedStorageKey("seen", key)),
			this.ctx.storage.get("chunkScopeKey"),
		]);
		return {
			chunk: chunk ?? [],
			recent: recent ?? [],
			checkpoint: checkpoint ?? null,
			userId: userId ?? null,
			seen: seen ?? [],
			scopeKey: key,
			chunkScopeKey: cleanScopeKey(chunkScopeKey),
		};
	}

	/** Bounded set of message ids already finalized (processed or skipped). */
	#capSeen(ids) {
		const MAX_SEEN = 1000;
		return ids.length > MAX_SEEN ? ids.slice(-MAX_SEEN) : ids;
	}

	async #mirrorCheckpoint(userId, msgId) {
		try {
			await this.env.DB.prepare(
				"INSERT INTO checkpoints (user_id, last_processed_msg_id, updated_at) VALUES (?, ?, ?) " +
					"ON CONFLICT(user_id) DO UPDATE SET last_processed_msg_id = excluded.last_processed_msg_id, updated_at = excluded.updated_at",
			)
				.bind(userId, msgId, Date.now())
				.run();
		} catch (err) {
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
		const entries = await this.ctx.storage.list({ prefix: "q:", limit: 64 });
		const legacy = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 });
		const chunk = (await this.ctx.storage.get("chunk")) ?? [];
		const unsettled = chunk.filter((m) => !m._settled);

		let earliest = null;
		if (legacy.size > 0) earliest = Date.now() + 250;
		for (const [, entry] of entries) {
			const at = Math.max(Date.now() + 250, Number(entry.runAfter ?? 0));
			if (earliest === null || at < earliest) earliest = at;
		}
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
		const seq = ((await this.ctx.storage.get("qseq")) ?? 0) + 1;
		await this.ctx.storage.put("qseq", seq);
		return `${String(seq).padStart(10, "0")}-${crypto.randomUUID().slice(0, 8)}`;
	}

	/**
	 * Move fired messages out of the held chunk into durable queue entries,
	 * split at the 1.6 caps (≤20 messages AND ≤~3k tokens, whichever first) so
	 * each entry is one small, retryable extraction. Splitting happens HERE, at
	 * enqueue time — never inside a model call.
	 */
	async #enqueueFired(userId, { overrides = null, scopeKey = null } = {}) {
		const chunk = (await this.ctx.storage.get("chunk")) ?? [];
		if (chunk.length === 0) return 0;
		const activeScopeKey = cleanScopeKey(scopeKey ?? (await this.ctx.storage.get("chunkScopeKey")));
		const pendingOverrides = persistableOverrides(overrides ?? (await this.ctx.storage.get("pendingOverrides")) ?? {});

		let batch = [];
		let chars = 0;
		const batches = [];
		for (const msg of chunk) {
			const len = String(msg.content ?? "").length;
			if (batch.length > 0 && (batch.length >= MAX_ENTRY_MSGS || chars + len > MAX_ENTRY_CHARS)) {
				batches.push(batch);
				batch = [];
				chars = 0;
			}
			batch.push(msg);
			chars += len;
		}
		if (batch.length) batches.push(batch);

		for (const msgs of batches) {
			const seq = await this.#nextSeq();
			await this.ctx.storage.put(`q:${seq}`, {
				kind: "extract",
				messages: msgs.map(({ _settled, ...m }) => m),
				jobByMessage: Object.fromEntries(msgs.filter((m) => m._job).map((m) => [m.id, m._job])),
				overrides: pendingOverrides,
				scopeKey: activeScopeKey,
				attempts: 0,
				runAfter: 0,
				enqueuedAt: Date.now(),
			});
		}
		await this.ctx.storage.put("chunk", []);
		await this.ctx.storage.put("userId", userId);
		return batches.length;
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
		return this.ctx.blockConcurrencyWhile(async () => {
			const requestedScopeKey = cleanScopeKey(opts.scopeKey);
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
				await this.ctx.storage.put("chunkScopeKey", requestedScopeKey);
				state.chunkScopeKey = requestedScopeKey;
			}
			const chunk = state.chunk;
			let recent = state.recent;
			let checkpoint = state.checkpoint;
			const chunkIds = new Set(chunk.map((m) => m.id));
			const seen = new Set(state.seen);
			let checkpointChanged = false;
			let lastSignal = false;
			let held = 0;
			let skipped = 0;
			const settledNow = []; // message ids finalized right here

			for (const msg of messages ?? []) {
				if (!msg || !msg.id) continue;
				const norm = { id: msg.id, role: msg.role ?? "user", content: msg.content ?? "", ts: msg.ts ?? Date.now() };
				recent.push(norm);

				if (norm.role !== "user") continue; // only user messages become memory
				// De-dup re-sends: already held, the current checkpoint, or already
				// processed in a prior fire. Lets save_conversation safely re-send
				// overlapping batches — only genuinely new messages get processed.
				if (chunkIds.has(norm.id) || norm.id === checkpoint || seen.has(norm.id)) {
					skipped++;
					settledNow.push({ id: norm.id, disposition: "deduplicated" });
					continue;
				}

				const cls = classifyMessage(norm.content);
				if (cls === "noise" || cls === "utility") {
					// IGNORE. Safe to advance the checkpoint past noise only when no
					// meaningful content is held before it (otherwise it's trailing
					// noise — drop it, but don't poison the held chunk).
					if (meaningfulCount(chunk) === 0) {
						checkpoint = norm.id;
						checkpointChanged = true;
						seen.add(norm.id);
					}
					settledNow.push({ id: norm.id, disposition: "skipped_noise" });
					continue;
				}

				chunk.push({ ...norm, _cls: cls, ...(opts.jobId ? { _job: opts.jobId } : {}) });
				chunkIds.add(norm.id);
				held++;
				if (cls === "signal") lastSignal = true;
			}

			if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);

			const { fire } = shouldFire(chunk.filter((m) => !m._settled), {
				flush: Boolean(opts.flush),
				now: Date.now(),
				lastSignal,
			});

			await this.ctx.storage.put("chunk", chunk);
			await this.ctx.storage.put(scopedStorageKey("recent", requestedScopeKey), recent);
			await this.ctx.storage.put("userId", userId);
			if (opts.overrides !== undefined) await this.ctx.storage.put("pendingOverrides", persistableOverrides(opts.overrides ?? {}));
			if (checkpointChanged) {
				await this.ctx.storage.put(scopedStorageKey("checkpoint", requestedScopeKey), checkpoint);
				await this.#mirrorCheckpoint(userId, checkpoint);
			}
			if (seen.size !== state.seen.length) {
				await this.ctx.storage.put(scopedStorageKey("seen", requestedScopeKey), this.#capSeen([...seen]));
			}

			// A message finalized at the door settles its slice of the job NOW —
			// if that empties the job, the row goes terminal before we return.
			if (opts.jobId && settledNow.length) {
				await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, [{
					jobId: opts.jobId,
					messageIds: settledNow.map((s) => s.id),
					disposition: "skipped",
				}]));
			}

			let queued = 0;
			if (fire) {
				queued = await this.#enqueueFired(userId, { overrides: opts.overrides, scopeKey: requestedScopeKey });
			}
			// Every exit guarantees a wake while work exists — fired or held.
			await this.#guaranteeWake();

			return { fired: fire, held, skipped, queued };
		});
	}

	/**
	 * Durable enqueue for an MCP background enrichment. The entry is persisted
	 * BEFORE the sync receipt returns, and the queue in storage — not any
	 * particular alarm — is what guarantees processing. A staged job can only
	 * end enriched or failed, never vanish.
	 */
	async enqueueMcpJob(userId, job) {
		if (!job?.jobId) return { queued: false };
		const seq = await this.#nextSeq();
		await this.ctx.storage.put(`q:${seq}`, {
			kind: "mcp",
			job,
			attempts: Number(job.attempts ?? 0),
			runAfter: 0,
			enqueuedAt: Date.now(),
		});
		await this.ctx.storage.put("userId", userId);
		await this.#armAlarm(Date.now() + 50);
		return { queued: true };
	}

	/**
	 * Oldest runnable queue entry, skipping backed-off ones and anything this
	 * drain invocation already attempted — one failing entry gets exactly one
	 * attempt per drain, then the queue moves past it.
	 */
	async #nextEntry(now, { ignoreBackoff = false, skip } = {}) {
		const entries = await this.ctx.storage.list({ prefix: "q:" });
		for (const [key, entry] of entries) {
			if (skip?.has(key)) continue;
			if (ignoreBackoff || Number(entry.runAfter ?? 0) <= now) return { key, entry };
		}
		// Legacy mcpjob:* entries written by the previous build may still be in
		// storage across the deploy — adopt them into the queue shape lazily.
		const legacy = await this.ctx.storage.list({ prefix: "mcpjob:" });
		for (const [key, job] of legacy) {
			const entry = { kind: "mcp", job, attempts: Number(job.attempts ?? 0), runAfter: 0, enqueuedAt: Date.now() };
			const seq = await this.#nextSeq();
			await this.ctx.storage.put(`q:${seq}`, entry);
			await this.ctx.storage.delete(key);
			return { key: `q:${seq}`, entry };
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
			return { leased: true, remaining: (await this.ctx.storage.list({ prefix: "q:" })).size, results };
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

		const remaining = (await this.ctx.storage.list({ prefix: "q:" })).size;
		return { leased: false, remaining, results };
	}

	/** One MCP enrichment entry. The engine's own bookkeeping marks the D1 job. */
	async #processMcpEntry(userId, key, entry) {
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
			const attempts = entry.attempts + 1;
			if (attempts >= MAX_ATTEMPTS) {
				// Dead-letter here too, in case the engine's internal cap moves.
				await this.ctx.storage.delete(key);
				await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, [{
					jobId: entry.job.jobId,
					all: true,
					disposition: "failed",
					error: `retries exhausted (${res.reason ?? "transient failure"})`,
				}]));
				await reportServerError(this.env, "mcp_enrich_poison", new Error(String(res.reason ?? "unknown")), userId);
				return { kind: "mcp", jobId: entry.job.jobId, outcome: "failed" };
			}
			await this.ctx.storage.put(key, { ...entry, attempts, runAfter: Date.now() + backoffMs(attempts) });
			return { kind: "mcp", jobId: entry.job.jobId, outcome: "retry", attempts };
		}
		await this.ctx.storage.delete(key);
		return { kind: "mcp", jobId: entry.job.jobId, outcome: res?.failed ? "failed" : "enriched" };
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
		// Queue entries keep the project that fired them. State used for
		// extraction must follow that immutable entry, not whichever project most
		// recently appended to this account's shared coordinator.
		const scopeKey = cleanScopeKey(entry.scopeKey);
		const recent = (await this.ctx.storage.get(scopedStorageKey("recent", scopeKey))) ?? [];
		// The entry's own persisted overrides win (they carry the packet's true
		// source attribution); inline values fill gaps — except function-valued
		// test hooks, which can never be persisted and therefore always apply.
		const overrides = { ...(inlineOverrides ?? {}), ...(entry.overrides ?? {}) };
		for (const [k, v] of Object.entries(inlineOverrides ?? {})) {
			if (typeof v === "function") overrides[k] = v;
		}
		if (Date.now() - Number(entry.enqueuedAt ?? 0) > BACKLOG_AGE_MS) {
			overrides.meta = { ...(overrides.meta ?? {}), drained_from_backlog: true };
		}

		const messages = entry.messages ?? [];
		const processedIds = messages.map((m) => m.id);
		const lastId = processedIds[processedIds.length - 1] ?? null;
		const jobUpdates = (disposition, extra = {}) => {
			const byJob = new Map();
			for (const [msgId, jobId] of Object.entries(entry.jobByMessage ?? {})) {
				if (!byJob.has(jobId)) byJob.set(jobId, []);
				byJob.get(jobId).push(msgId);
			}
			return [...byJob.entries()].map(([jobId, messageIds]) => ({ jobId, messageIds, disposition, ...extra }));
		};

		let result;
		try {
			result = await runExtractionPipeline(this.env, userId, messages, recent, overrides);
		} catch (error) {
			// An engine throw (not a reported outcome) counts as an attempt like
			// any other transient failure — recorded, bounded, never head-of-line.
			result = { outcome: "llm_failed", error: String(error?.message ?? error) };
			console.warn(`extraction threw user=${userId}:`, result.error);
		}

		// Persist the receipt + human one-liner for whichever outcome we got.
		if (result.receipt) {
			result.summary = formatReceipt(result.receipt);
			await storeReceipt(this.env, userId, result.receipt.source, result.receipt, result.summary);
		}

		const finalizedNoWrite = result.outcome === "no_write" && result.receipt?.reason === "user_opt_out";

		if (result.outcome === "wrote" || finalizedNoWrite) {
			await this.#announceWrite(userId, result);
			// Settle jobs BEFORE deleting the entry (see method comment).
			await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, jobUpdates("processed", {
				counts: result.receipt?.saved ?? null,
				receiptId: result.receipt?.id ?? null,
			})));
			if (lastId) {
				await this.ctx.storage.put(scopedStorageKey("checkpoint", scopeKey), lastId);
				await this.#mirrorCheckpoint(userId, lastId);
			}
			const seenKey = scopedStorageKey("seen", scopeKey);
			const seen = (await this.ctx.storage.get(seenKey)) ?? [];
			await this.ctx.storage.put(seenKey, this.#capSeen([...new Set([...seen, ...processedIds])]));
			await this.ctx.storage.delete(key);
			return { kind: "extract", outcome: result.outcome, receipt: result.receipt ?? null, summary: result.summary ?? null, jobIds: [...new Set(Object.values(entry.jobByMessage ?? {}))] };
		}

		if (result.outcome === "meaningful_no_write") {
			// The engine looked and found nothing durable. The JOB settles now —
			// visible, terminal, zero saved — while the messages return to the
			// held chunk as a rescue buffer: future context may still redeem
			// them, and if it never comes they are already accounted for.
			await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, jobUpdates("processed", {
				counts: { nodes: 0, slices: 0, events: 0, edges: 0 },
				receiptId: result.receipt?.id ?? null,
			})));
			let chunk = (await this.ctx.storage.get("chunk")) ?? [];
			const chunkScopeKey = cleanScopeKey(await this.ctx.storage.get("chunkScopeKey"));
			let restoredIntoEmptyScope = chunk.length === 0;
			if (chunk.length > 0 && chunkScopeKey !== scopeKey) {
				// A no-write rescue buffer is still project-owned. If another
				// project arrived while this entry was extracting, fire that held
				// chunk first and restore this entry only under its original scope.
				await this.#enqueueFired(userId, { scopeKey: chunkScopeKey });
				chunk = [];
				restoredIntoEmptyScope = true;
			}
			if (chunkScopeKey !== scopeKey) await this.ctx.storage.put("chunkScopeKey", scopeKey);
			// When the rescued entry becomes the new held chunk, its own immutable
			// attribution must become the pending attribution too. Otherwise a later
			// fire can write project A's rescued text with project B's source metadata.
			// If newer same-project messages are already held, keep their pending
			// metadata; Stage 5 snapshots context per job rather than rewriting it here.
			if (restoredIntoEmptyScope) {
				await this.ctx.storage.put("pendingOverrides", persistableOverrides(entry.overrides ?? {}));
			}
			const chunkIds = new Set(chunk.map((m) => m.id));
			const restored = messages.filter((m) => !chunkIds.has(m.id)).map((m) => ({ ...m, _settled: true }));
			await this.ctx.storage.put("chunk", [...restored, ...chunk]);
			await this.ctx.storage.delete(key);
			return { kind: "extract", outcome: result.outcome, receipt: result.receipt ?? null, summary: result.summary ?? null, jobIds: [...new Set(Object.values(entry.jobByMessage ?? {}))] };
		}

		// llm_failed / db_write_failed / engine throw → bounded retry with
		// backoff; the queue moves on past this entry meanwhile (1.5).
		const attempts = entry.attempts + 1;
		await settleMemoryJobs(this.env, userId, jobUpdates("attempted", { attempts }));
		if (attempts >= MAX_ATTEMPTS) {
			await this.#announceJobTransitions(userId, await settleMemoryJobs(this.env, userId, jobUpdates("failed", {
				error: String(result.error ?? result.outcome ?? "extraction failed").slice(0, 400),
				receiptId: result.receipt?.id ?? null,
			})));
			await reportServerError(
				this.env,
				"extract_poison",
				new Error(`entry dead-lettered after ${attempts} attempts: ${result.error ?? result.outcome}`),
				userId,
			);
			// Poison messages are finalized (seen) so re-sends don't loop them.
			const seenKey = scopedStorageKey("seen", scopeKey);
			const seen = (await this.ctx.storage.get(seenKey)) ?? [];
			await this.ctx.storage.put(seenKey, this.#capSeen([...new Set([...seen, ...processedIds])]));
			await this.ctx.storage.delete(key);
			return { kind: "extract", outcome: "failed", receipt: result.receipt ?? null, jobIds: [...new Set(Object.values(entry.jobByMessage ?? {}))] };
		}
		await this.ctx.storage.put(key, { ...entry, attempts, runAfter: Date.now() + backoffMs(attempts) });
		return { kind: "extract", outcome: result.outcome, retry: true, attempts, receipt: result.receipt ?? null, jobIds: [...new Set(Object.values(entry.jobByMessage ?? {}))] };
	}

	/**
	 * Job lifecycle webhooks (Part 2.3): memory.enriched / memory.failed fire
	 * exactly once per accepted write, on its terminal transition. Metadata
	 * only — ids, status, counts — never memory content.
	 */
	async #announceJobTransitions(userId, transitions = []) {
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
			await emitWebhookEvent(this.env, (p) => this.ctx.waitUntil(p), userId, event, data).catch((err) => console.warn("job webhook failed:", err?.message ?? err));
		}
	}

	/** Webhook announcements for a landed write — after the fact, async, unfailable. */
	async #announceWrite(userId, result) {
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
			this.ctx.waitUntil(
				emitWebhookEvent(this.env, (p) => this.ctx.waitUntil(p), target, event, data),
			);
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
		await this.#armAlarm(Date.now() + 50);
		const entries = await this.ctx.storage.list({ prefix: "q:", limit: 256 });
		const legacy = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 64 });
		const chunk = (await this.ctx.storage.get("chunk")) ?? [];
		const jobIds = new Set();
		for (const [, entry] of entries) {
			if (entry?.job?.jobId) jobIds.add(entry.job.jobId);
			for (const jobId of Object.values(entry?.jobByMessage ?? {})) jobIds.add(jobId);
		}
		for (const [, job] of legacy) if (job?.jobId) jobIds.add(job.jobId);
		for (const msg of chunk) if (msg?._job) jobIds.add(msg._job);
		return {
			queued: entries.size + legacy.size,
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
		const entries = await this.ctx.storage.list({ prefix: "q:" });
		let queuedMessages = 0;
		for (const [, entry] of entries) queuedMessages += entry.kind === "extract" ? (entry.messages?.length ?? 0) : 0;
		const lease = await this.ctx.storage.get("lease");
		return {
			chunkSize: chunk.length + queuedMessages,
			heldSize: chunk.length,
			queuedEntries: entries.size,
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
