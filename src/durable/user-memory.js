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
import { formatReceipt } from "../pipeline/receipt.js";
import { storeReceipt } from "../lib/db.js";

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

			const processedIds = new Set(chunk.map((m) => m.id));
			const lastId = chunk[chunk.length - 1].id;

			const result = await runExtractionPipeline(this.env, userId, chunk, recent, overrides);

			// Persist the receipt (Priority 5) + attach the human one-liner so the
			// caller (MCP tool) can show it. Best-effort; never blocks the result.
			if (result.receipt) {
				result.summary = formatReceipt(result.receipt);
				await storeReceipt(this.env, userId, result.receipt.source, result.receipt, result.summary);
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

			// user_opt_out no_write is final; meaningful_no_write/failed outcomes remain retryable.
			return result;
		} finally {
			this.busy = false;
		}
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
			this.busy = false;
		});
		return { reset: true };
	}

	async alarm() {
		const { userId, chunk } = await this.#load();
		if (!userId || chunk.length === 0) return;
		const result = await this.runExtraction(userId);
		if (result?.skipped) {
			await this.ctx.storage.setAlarm(Date.now() + 2000);
		}
	}
}
