/**
 * UserMemory — one Durable Object per user (keyed by userId). It owns, per user:
 *   - the held chunk (messages waiting to be processed),
 *   - a small rolling buffer of recent raw messages (for bridge/assistant context),
 *   - the checkpoint (last_processed_msg_id),
 *   - a lock so only one extraction runs at a time (no double-processing).
 *
 * All ingest for a user routes through this object. It decides IGNORE/HOLD/FIRE
 * (via the trigger) but delegates the heavy extraction to the pipeline. The
 * checkpoint advances ONLY after a successful write.
 */

import { DurableObject } from "cloudflare:workers";
import { classifyMessage, shouldFire, meaningfulCount } from "../pipeline/trigger.js";
import { runExtraction as runExtractionPipeline } from "../pipeline/extract.js";
import { enrichMcpConversation } from "../pipeline/mcp_engine.js";
import { formatReceipt } from "../pipeline/receipt.js";
import { runExport as runExportJob } from "../pipeline/exports.js";
import { storeReceipt } from "../lib/db.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "../pipeline/webhooks.js";

const RECENT_LIMIT = 20;

export class UserMemory extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.busy = false; // in-memory extraction lock for this instance
	}

	async #load() {
		const [chunk, recent, checkpoint, userId, seen] = await Promise.all([
			this.ctx.storage.get("chunk"),
			this.ctx.storage.get("recent"),
			this.ctx.storage.get("checkpoint"),
			this.ctx.storage.get("userId"),
			this.ctx.storage.get("seen"),
		]);
		return {
			chunk: chunk ?? [],
			recent: recent ?? [],
			checkpoint: checkpoint ?? null,
			userId: userId ?? null,
			seen: seen ?? [],
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
	 * Append new messages, run the trigger, and report whether a fire is due.
	 * Fast (no LLM / no heavy D1) so the caller can respond immediately. Atomic
	 * via blockConcurrencyWhile so concurrent ingests can't interleave.
	 */
	async addMessages(userId, messages, opts = {}) {
		return this.ctx.blockConcurrencyWhile(async () => {
			const state = await this.#load();
			const chunk = state.chunk;
			let recent = state.recent;
			let checkpoint = state.checkpoint;
			const chunkIds = new Set(chunk.map((m) => m.id));
			const seen = new Set(state.seen);
			let checkpointChanged = false;
			let lastSignal = false;
			let held = 0;
			let skipped = 0;

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
					continue;
				}

				chunk.push({ ...norm, _cls: cls });
				chunkIds.add(norm.id);
				held++;
				if (cls === "signal") lastSignal = true;
			}

			if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);

			const { fire } = shouldFire(chunk, {
				flush: Boolean(opts.flush),
				now: Date.now(),
				lastSignal,
			});

			await this.ctx.storage.put("chunk", chunk);
			await this.ctx.storage.put("recent", recent);
			await this.ctx.storage.put("userId", userId);
			if (checkpointChanged) {
				await this.ctx.storage.put("checkpoint", checkpoint);
				await this.#mirrorCheckpoint(userId, checkpoint);
			}
			if (seen.size !== state.seen.length) {
				await this.ctx.storage.put("seen", this.#capSeen([...seen]));
			}
			if (fire) {
				await this.ctx.storage.setAlarm(Date.now() + 1000);
			}

			return { fired: fire, held, skipped };
		});
	}

	/**
	 * Run the extraction pipeline under the per-user lock. Advances the checkpoint
	 * and clears the processed messages ONLY on a successful write; otherwise the
	 * chunk is retained for retry and the checkpoint stays put.
	 */
	async runExtraction(userId, overrides = {}) {
		if (this.busy) return { skipped: true };
		this.busy = true;
		try {
			const { chunk, recent } = await this.#load();
			if (chunk.length === 0) return { outcome: "empty" };

			// Watchdog: alarms survive isolate death, `this.busy` does not. If
			// this fire is killed mid-flight (eviction, crash, deploy), the
			// pending alarm revives extraction in a fresh instance instead of
			// stranding the held chunk. Completion logic below replaces it.
			await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);

			const processedIds = new Set(chunk.map((m) => m.id));
			const lastId = chunk[chunk.length - 1].id;

			const result = await runExtractionPipeline(this.env, userId, chunk, recent, overrides);

			// Persist the receipt (Priority 5) + attach the human one-liner so the
			// caller (MCP tool) can show it. Best-effort; never blocks the result.
			if (result.receipt) {
				result.summary = formatReceipt(result.receipt);
				await storeReceipt(this.env, userId, result.receipt.source, result.receipt, result.summary);
			}

			// Announce the write to any registered webhooks — strictly after the
			// fact, strictly async, never able to fail the save. This one hook
			// point covers every door that runs the engine (ingest, save, SDK,
			// playground, plugin).
			if (result.outcome === "wrote" && result.receipt) {
				const saved = result.receipt.saved ?? {};
				const added = (saved.nodes ?? 0) + (saved.slices ?? 0) + (saved.events ?? 0) + (saved.edges ?? 0) > 0;
				const updated = (saved.updatedNodes ?? 0) + (saved.supersededSlices ?? 0) > 0;
				const event = added ? "memory.added" : updated ? "memory.updated" : null;
				if (event) {
					const data = webhookDataFromReceipt(result.receipt);
					// Scoped saves (SDK sub-tenants, plugin project spaces) announce
					// to the OWNING account's webhooks too — the sub-tenant id is
					// derived and owns no configuration of its own.
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
			}

			const finalizedNoWrite = result.outcome === "no_write" && result.receipt?.reason === "user_opt_out";
			if (result.outcome === "wrote" || finalizedNoWrite) {
				// Remove only the messages we processed (a concurrent addMessages may
				// have appended more), then advance the checkpoint.
				const current = (await this.ctx.storage.get("chunk")) ?? [];
				const remaining = current.filter((m) => !processedIds.has(m.id));
				await this.ctx.storage.put("chunk", remaining);
				await this.ctx.storage.put("checkpoint", lastId);
				await this.#mirrorCheckpoint(userId, lastId);
				// Remember what we processed so a re-sent batch skips it.
				const seen = (await this.ctx.storage.get("seen")) ?? [];
				await this.ctx.storage.put("seen", this.#capSeen([...new Set([...seen, ...processedIds])]));
			}
			// meaningful_no_write / llm_failed / db_write_failed → keep chunk + checkpoint.

			// Re-arm the alarm when messages are still held, or a backlog that
			// accumulated DURING this fire is stranded until the next ingest —
			// with multi-call fires taking tens of seconds, that stranded a whole
			// conversation's tail. After a write: drain promptly. After a
			// failure: retry with exponential backoff, capped attempts, so a
			// permanently poisoned chunk cannot ping the model forever.
			// meaningful_no_write deliberately does NOT re-arm — that chunk waits
			// for more context, and retrying identical input yields identical
			// results.
			// A pending MCP enrichment owns the alarm too — clearing it here would
			// strand a staged job, which is the exact silent-loss bug this lane
			// was rebuilt to prevent. When jobs are queued, hand the alarm back
			// to them instead of deleting it.
			const mcpPending = (await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 })).size > 0;
			const releaseAlarm = async () => {
				if (mcpPending) await this.ctx.storage.setAlarm(Date.now() + 2000);
				else await this.ctx.storage.deleteAlarm();
			};
			const held = ((await this.ctx.storage.get("chunk")) ?? []).length;
			if (held > 0) {
				if (result.outcome === "wrote" || finalizedNoWrite) {
					await this.ctx.storage.put("failCount", 0);
					await this.ctx.storage.setAlarm(Date.now() + 1500);
				} else if (["llm_failed", "db_write_failed"].includes(result.outcome)) {
					const fails = ((await this.ctx.storage.get("failCount")) ?? 0) + 1;
					await this.ctx.storage.put("failCount", fails);
					if (fails <= 6) {
						await this.ctx.storage.setAlarm(Date.now() + Math.min(5000 * 2 ** (fails - 1), 600000));
					} else {
						await releaseAlarm();
					}
				} else {
					// meaningful_no_write: the chunk waits for NEW messages. The
					// start-of-fire watchdog must not retry identical input on a
					// five-minute loop.
					await releaseAlarm();
				}
			} else {
				await this.ctx.storage.put("failCount", 0);
				// Nothing held → the only pending alarm is our watchdog. Clear it
				// (an addMessages fire-alarm implies a non-empty chunk).
				await releaseAlarm();
			}

			// user_opt_out no_write is final; meaningful_no_write/failed outcomes remain retryable.
			return result;
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Durable enqueue for an MCP background enrichment. The entry is persisted
	 * BEFORE the sync receipt returns, and the alarm — which survives isolate
	 * death — drives processing. This is the design answer to the "queued
	 * receipt, silently never saved" failure mode: a staged job can only end
	 * enriched or failed, never vanish.
	 */
	async enqueueMcpJob(userId, job) {
		if (!job?.jobId) return { queued: false };
		await this.ctx.storage.put(`mcpjob:${job.jobId}`, job);
		await this.ctx.storage.put("userId", userId);
		const soon = Date.now() + 50;
		const pending = await this.ctx.storage.getAlarm();
		if (!pending || pending > soon) await this.ctx.storage.setAlarm(soon);
		return { queued: true };
	}

	/**
	 * Process every queued MCP enrichment under the per-user lock. Transient
	 * engine failures (llm_failed / db_write_failed) retry with backoff up to
	 * a bounded attempt count; everything else finishes the job one way or the
	 * other. Returns what the alarm needs to decide about re-arming.
	 */
	async drainMcpJobs(userId) {
		const jobs = await this.ctx.storage.list({ prefix: "mcpjob:" });
		if (jobs.size === 0) return { remaining: 0, busySkip: false };
		if (this.busy) return { remaining: jobs.size, busySkip: true };
		this.busy = true;
		try {
			for (const [key, job] of jobs) {
				// Watchdog: if this isolate dies mid-enrichment, the pending alarm
				// revives the queue in a fresh instance instead of stranding it.
				await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
				const res = await enrichMcpConversation(this.env, userId, job, (p) => this.ctx.waitUntil(p));
				if (res?.retry) {
					const attempts = Number(job.attempts ?? 0) + 1;
					await this.ctx.storage.put(key, { ...job, attempts });
				} else {
					await this.ctx.storage.delete(key);
				}
			}
		} finally {
			this.busy = false;
		}
		const left = await this.ctx.storage.list({ prefix: "mcpjob:" });
		if (left.size === 0) {
			// Queue drained: clear our watchdog so it cannot fire into a clean
			// instance — then re-check, because an addMessages may have armed a
			// fire alarm for a fresh chunk in the meantime. Never strand work.
			const chunk = (await this.ctx.storage.get("chunk")) ?? [];
			if (chunk.length === 0) {
				await this.ctx.storage.deleteAlarm();
				const chunkAfter = (await this.ctx.storage.get("chunk")) ?? [];
				const jobsAfter = await this.ctx.storage.list({ prefix: "mcpjob:", limit: 1 });
				if (chunkAfter.length > 0 || jobsAfter.size > 0) {
					await this.ctx.storage.setAlarm(Date.now() + 1500);
				}
			}
		}
		return { remaining: left.size, busySkip: false };
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

	/** Inspect held state — used by tests to assert chunk retention. */
	async getDebugState() {
		const { chunk, checkpoint } = await this.#load();
		return { chunkSize: chunk.length, checkpoint };
	}

	/** Clear held ingest state after an explicit DELETE ALL reset. */
	async resetAll() {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll();
			// deleteAll clears values, not alarms — an orphaned alarm would wake
			// a wiped instance (and in tests, fire into storage teardown).
			await this.ctx.storage.deleteAlarm();
			this.busy = false;
		});
		return { reset: true };
	}

	async alarm() {
		const { userId, chunk } = await this.#load();
		if (!userId) return;
		// MCP enrichments first — a staged receipt is a promise with a clock on
		// it; held auto-mode chunks tolerate the extra seconds far better.
		const drained = await this.drainMcpJobs(userId);
		if (drained.remaining > 0) {
			// busy-skip → try again shortly; retryable failure → back off.
			await this.ctx.storage.setAlarm(Date.now() + (drained.busySkip ? 2000 : 15000));
		}
		if (chunk.length === 0) return;
		const result = await this.runExtraction(userId);
		if (result?.skipped) {
			await this.ctx.storage.setAlarm(Date.now() + 2000);
		}
	}
}
