/**
 * Shadow-extraction outbox: durable, content-minimized, observational.
 *
 * A shadow-sampled save enqueues one job row ATOMICALLY with its commit batch
 * (write.js appends shadowEnqueueStatement); deterministic reconciliation in
 * the cron creates any sampled job a non-batch settlement path missed. The
 * drain then, per job: re-derives the input from the immutable, already-
 * scrubbed source_episodes rows (never from anything mutable, never from
 * stored prompt text — there is none), re-checks the deletion barrier before
 * AND after the model call (the digest precedent), runs the SAME proposeMemory
 * path the primary used — under a shadow pin, so dispatch routes it to the
 * shadow provider — and stores ONLY content-free comparison metrics.
 *
 * NOTHING here can affect the primary path: the primary is durable before the
 * job exists, every failure collapses to a job status, and shadow work is
 * excluded from receipts and the user's monthly quota (its meter scope is
 * "shadow_extract", not "save").
 */

import { getConfig } from "../config.js";
import { proposeMemory } from "../pipeline/llm.js";
import { withFlushedAiMeter } from "../lib/ai_meter.js";
import { buildPin, withAiPin } from "./pin.js";

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 2;
const RETENTION_DAYS = 30;
export const SHADOW_TERMINAL = Object.freeze(["done", "failed", "cancelled_erased", "cancelled_removed", "dead_letter"]);

export async function shadowJobId(primaryRunId) {
	const data = new TextEncoder().encode(`shadow\0${primaryRunId}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return `shadow_${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
}

/** The statement write.js appends to a shadow-sampled commit batch. */
export function shadowEnqueueStatement(env, { id, userId, accountUserId = null, primaryRunId, shadow, now = Date.now() }) {
	return env.DB.prepare(
		`INSERT INTO ai_shadow_jobs
			(id, user_id, account_user_id, primary_run_id, provider, model, prompt_version,
			 status, attempts, lease_until, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', 0, NULL, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).bind(id, userId, accountUserId, primaryRunId, shadow.provider, shadow.model ?? null, now, now);
}

/**
 * Deterministic reconciliation: any terminal run whose pin says shadow-sampled
 * but which has no job row (a settlement path that bypassed the batch, or a
 * batch bug) gets its job created here. Bounded per tick; the id is derived in
 * SQL so the INSERT is idempotent against the batch path racing it.
 */
export async function reconcileShadowJobs(env, { limit = 25, now = Date.now() } = {}) {
	const since = now - RETENTION_DAYS * 86_400_000;
	const rows = await env.DB.prepare(
		`SELECT er.id, er.user_id, er.pin_json FROM extraction_runs er
		 WHERE er.created_at > ?
		   AND er.pin_json IS NOT NULL
		   AND json_extract(er.pin_json, '$.shadow.sampled') = 1
		   AND er.status IN ('wrote', 'skipped', 'failed')
		 ORDER BY er.created_at DESC LIMIT ?`,
	).bind(since, limit * 4).all();
	let created = 0;
	for (const run of rows?.results ?? []) {
		if (created >= limit) break;
		const shadow = safeShadow(run.pin_json);
		if (!shadow) continue;
		const id = await shadowJobId(run.id);
		const result = await env.DB.prepare(
			`INSERT INTO ai_shadow_jobs
				(id, user_id, account_user_id, primary_run_id, provider, model, prompt_version,
				 status, attempts, lease_until, created_at, updated_at)
			 SELECT ?, ?, NULL, ?, ?, ?, NULL, 'pending', 0, NULL, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM ai_shadow_jobs WHERE id = ?)`,
		).bind(id, run.user_id, run.id, shadow.provider, shadow.model ?? null, now, now, id).run();
		if (Number(result?.meta?.changes ?? 0) === 1) created += 1;
	}
	return created;
}

function safeShadow(pinJson) {
	try {
		const shadow = JSON.parse(pinJson)?.shadow;
		return shadow?.sampled && typeof shadow.provider === "string" ? shadow : null;
	} catch {
		return null;
	}
}

/** Cron duty: claim and execute due shadow jobs. Bounded; never throws. */
export async function drainShadowJobs(env, { limit = 5, now = Date.now() } = {}) {
	if (!env?.DB) return { drained: 0 };
	let drained = 0;
	try {
		const due = await env.DB.prepare(
			`SELECT id FROM ai_shadow_jobs
			 WHERE status = 'pending' OR (status = 'running' AND lease_until < ?)
			 ORDER BY created_at LIMIT ?`,
		).bind(now, limit).all();
		for (const candidate of due?.results ?? []) {
			const claimed = await env.DB.prepare(
				`UPDATE ai_shadow_jobs
				 SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
				 WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?))
				 RETURNING *`,
			).bind(now + LEASE_MS, now, candidate.id, now).first();
			if (!claimed) continue;
			await processShadowJob(env, claimed, now).catch(async (error) => {
				await settleShadowJob(env, claimed.id, {
					status: Number(claimed.attempts) >= MAX_ATTEMPTS ? "dead_letter" : "pending",
					errorClass: typeof error?.aiErrorClass === "string" ? error.aiErrorClass : "error",
				});
			});
			drained += 1;
		}
	} catch (error) {
		console.warn("shadow drain failed:", error?.message ?? error);
	}
	return { drained };
}

async function settleShadowJob(env, id, { status, comparison = null, usage = null, durationMs = null, errorClass = null, now = Date.now() }) {
	// pending = lease released for the next tick; anything else is terminal.
	await env.DB.prepare(
		`UPDATE ai_shadow_jobs
		 SET status = ?, lease_until = NULL, comparison_json = ?,
			input_tokens = ?, output_tokens = ?, duration_ms = ?, error_class = ?, updated_at = ?
		 WHERE id = ? AND status = 'running'`,
	).bind(
		status,
		comparison ? JSON.stringify(comparison) : null,
		usage?.input ?? null,
		usage?.output ?? null,
		durationMs,
		errorClass,
		now,
		id,
	).run();
}

async function barrierCovers(env, userId, sinceTs) {
	const barrier = await env.DB.prepare(
		"SELECT barrier_at FROM deletion_barriers WHERE user_id = ?",
	).bind(userId).first();
	return barrier != null && Number(barrier.barrier_at) > Number(sinceTs);
}

async function processShadowJob(env, job, now) {
	if (Number(job.attempts) > MAX_ATTEMPTS) {
		return settleShadowJob(env, job.id, { status: "dead_letter", errorClass: "attempts_exhausted" });
	}
	// Erasure check BEFORE any content is touched.
	if (await barrierCovers(env, job.user_id, job.created_at)) {
		return settleShadowJob(env, job.id, { status: "cancelled_erased" });
	}
	const run = await env.DB.prepare(
		`SELECT id, source_packet_id, scope_json, created_nodes_json, created_slices_json,
			created_events_json, created_edges_json, created_candidates_json, status
		 FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1`,
	).bind(job.primary_run_id, job.user_id).first();
	if (!run) return settleShadowJob(env, job.id, { status: "cancelled_erased", errorClass: "primary_missing" });

	// Input re-derivation: the immutable, scrubbed, rules-filtered episodes.
	const episodes = await env.DB.prepare(
		`SELECT role, text FROM source_episodes
		 WHERE user_id = ? AND source_packet_id = ? ORDER BY message_index LIMIT 64`,
	).bind(job.user_id, run.source_packet_id).all();
	const messages = (episodes?.results ?? []).map((e) => ({ role: e.role || "user", content: e.text }));
	if (!messages.length) return settleShadowJob(env, job.id, { status: "cancelled_erased", errorClass: "source_gone" });

	const config = getConfig(env);
	const { buildPacket } = await import("../pipeline/packet.js");
	const { shortlistNodes } = await import("../pipeline/shortlist.js");
	const packet = buildPacket(messages, []);
	const text = messages.map((m) => m.content).join("\n");
	const shortlist = await shortlistNodes(env, config, job.user_id, text, null).catch(() => []);

	// The shadow pin routes ONLY this scope's extract lane to the shadow
	// provider; everything else the call touches stays default.
	const pin = buildPin({ routes: { extract: { provider: job.provider, model: job.model ?? null } } });
	const startedAt = Date.now();
	let proposal = null;
	let usage = null;
	await withFlushedAiMeter(env, "shadow_extract", { userId: job.user_id, scopeId: job.id, lifecycle: { accountUserId: job.account_user_id ?? null } }, async (meter) => {
		proposal = await withAiPin(pin, () => proposeMemory(env, config, { packet, shortlist }, {}));
		const call = meter.calls[meter.calls.length - 1] ?? null;
		usage = call ? { input: call.input_tokens, output: call.output_tokens } : null;
		if (call && call.ok === 0) {
			throw Object.assign(new Error("shadow model call failed"), { aiErrorClass: call.error_class ?? "error" });
		}
	});

	// Erasure check AFTER the model call: an erasure confirmed during inference
	// must cancel the record, not survive as a metric row.
	if (await barrierCovers(env, job.user_id, job.created_at)) {
		return settleShadowJob(env, job.id, { status: "cancelled_erased" });
	}

	const comparison = await compareProposals(proposal, run);
	if (proposal?._ok === false) {
		const status = Number(job.attempts) >= MAX_ATTEMPTS ? "dead_letter" : "pending";
		return settleShadowJob(env, job.id, { status, errorClass: String(proposal._outcome ?? "shadow_failed"), usage, durationMs: Date.now() - startedAt });
	}
	return settleShadowJob(env, job.id, { status: "done", comparison, usage, durationMs: Date.now() - startedAt });
}

async function hashKey(value) {
	const data = new TextEncoder().encode(String(value ?? "").toLowerCase().trim());
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content-free comparison: counts, hashed-label overlap, schema validity.
 * Basis is proposal-vs-committed (the primary's row holds committed objects,
 * the shadow holds a pre-gate proposal) — a coarse "same universe" signal;
 * the promotion instrument is the paired LoCoMo run, not this. */
async function compareProposals(proposal, run) {
	const objects = Array.isArray(proposal?.objects) ? proposal.objects : [];
	const countBy = (kind) => objects.filter((o) => o?.kind === kind).length;
	const parseCount = (json) => {
		try {
			const arr = JSON.parse(json ?? "[]");
			return Array.isArray(arr) ? arr.length : 0;
		} catch {
			return 0;
		}
	};
	const shadowLabels = new Set(await Promise.all(objects
		.map((o) => o?.label ?? o?.text ?? "")
		.filter(Boolean)
		.slice(0, 64)
		.map(hashKey)));
	let primaryLabels = new Set();
	try {
		const nodes = JSON.parse(run.created_nodes_json ?? "[]");
		primaryLabels = new Set(await Promise.all((Array.isArray(nodes) ? nodes : [])
			.map((n) => n?.label ?? "")
			.filter(Boolean)
			.slice(0, 64)
			.map(hashKey)));
	} catch {
		primaryLabels = new Set();
	}
	let intersection = 0;
	for (const key of shadowLabels) if (primaryLabels.has(key)) intersection += 1;
	const union = new Set([...shadowLabels, ...primaryLabels]).size;
	return {
		basis: "proposal_vs_committed",
		shadow: {
			ok: proposal?._ok !== false,
			outcome: proposal?._outcome ?? "ok",
			truncated: Boolean(proposal?._truncated),
			nodes: countBy("node"),
			slices: countBy("slice"),
			events: countBy("event"),
			edges: countBy("edge"),
			candidates: countBy("candidate"),
		},
		primary: {
			status: run.status,
			nodes: parseCount(run.created_nodes_json),
			slices: parseCount(run.created_slices_json),
			events: parseCount(run.created_events_json),
			edges: parseCount(run.created_edges_json),
			candidates: parseCount(run.created_candidates_json),
		},
		label_jaccard: union ? Number((intersection / union).toFixed(3)) : null,
	};
}

/** Cron retention: shadow rows are evaluation evidence, never an archive. */
export async function purgeExpiredShadowJobs(env, { retentionDays = RETENTION_DAYS, limit = 500, now = Date.now() } = {}) {
	try {
		const cutoff = now - retentionDays * 86_400_000;
		const result = await env.DB.prepare(
			`DELETE FROM ai_shadow_jobs WHERE id IN (
				SELECT id FROM ai_shadow_jobs WHERE created_at < ? LIMIT ?
			)`,
		).bind(cutoff, limit).run();
		return Number(result?.meta?.changes ?? 0);
	} catch (error) {
		console.warn("shadow retention purge failed:", error?.message ?? error);
		return 0;
	}
}
