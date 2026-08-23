/**
 * Shadow-extraction outbox: durable, content-minimized, observational.
 *
 * A shadow-sampled save enqueues one job row ATOMICALLY with its commit batch
 * (write.js appends shadowEnqueueStatement); deterministic reconciliation in
 * the cron creates any sampled job a non-batch settlement path missed. The
 * drain then, per job: re-derives the input from the immutable, already-
 * scrubbed source_episodes rows (never from anything mutable, never from
 * stored prompt text — there is none), transactionally admits the external
 * call against deletion/account/project lifecycle fences, re-checks after the
 * call, runs the SAME proposeMemory path the primary used — under a shadow pin,
 * so dispatch routes it to the shadow provider — and stores ONLY content-free
 * comparison metrics.
 *
 * NOTHING here can affect the primary path: the primary is durable before the
 * job exists, every failure collapses to a job status, and shadow work is
 * excluded from receipts and the user's monthly quota (its meter scope is
 * "shadow_extract", not "save").
 */

import { getConfig } from "../config.js";
import { proposeMemory } from "../pipeline/llm.js";
import { providerOperationId, withFlushedAiMeter } from "../lib/ai_meter.js";
import { buildPin, withAiPin } from "./pin.js";

// googleFetch permits two transient retries and one re-auth retry around a
// 60-second lane timeout. Six minutes is above that enforced logical-call
// ceiling while still allowing a crashed cron to recover promptly.
const LEASE_MS = 6 * 60_000;
const MAX_ATTEMPTS = 2;
const RETENTION_DAYS = 30;
export const SHADOW_TERMINAL = Object.freeze([
	"done",
	"failed",
	"cancelled_erased",
	"cancelled_removed",
	"cancelled_lifecycle",
	"dead_letter",
]);
const SHADOW_TERMINAL_SET = new Set(SHADOW_TERMINAL);

export async function shadowJobId(primaryRunId) {
	const data = new TextEncoder().encode(`shadow\0${primaryRunId}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return `shadow_${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
}

/** The statement write.js appends to a shadow-sampled commit batch. */
export function shadowEnqueueStatement(env, { id, userId, accountUserId = null, primaryRunId, shadow, now = Date.now() }) {
	return env.DB.prepare(
		`INSERT OR IGNORE INTO ai_shadow_jobs
			(id, user_id, account_user_id, primary_run_id, provider, model, prompt_version,
			 status, attempts, lease_until, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', 0, NULL, ?, ?)`,
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
		`SELECT er.id, er.user_id, er.pin_json, er.scope_json, er.created_at
		 FROM extraction_runs er
		 WHERE er.created_at > ?
		   AND er.pin_json IS NOT NULL
		   AND CASE WHEN json_valid(er.pin_json) THEN CASE
		     WHEN json_extract(er.pin_json, '$.shadow.sampled') = 1
		      AND json_type(er.pin_json, '$.shadow.provider') = 'text'
		     THEN 1 ELSE 0 END ELSE 0 END = 1
		   AND er.status IN ('wrote', 'skipped', 'failed')
		   AND NOT EXISTS (
		     SELECT 1 FROM ai_shadow_jobs sj WHERE sj.primary_run_id = er.id
		   )
		 ORDER BY er.created_at ASC, er.id ASC LIMIT ?`,
	).bind(since, limit).all();
	let created = 0;
	for (const run of rows?.results ?? []) {
		if (created >= limit) break;
		const shadow = safeShadow(run.pin_json);
		if (!shadow) continue;
		// A malformed/legacy pin may have lost the provider id while retaining a
		// concrete Google model. The removal gate treats either as a Google
		// reference, so reconciliation must consult the same durable Google
		// override rather than materializing executable work behind a clean gate.
		const removalProvider = shadowReferencesGoogle(shadow) ? "google-vertex" : shadow.provider;
		const id = await shadowJobId(run.id);
		const accountUserId = accountUserIdFromScope(run.scope_json);
		const result = await env.DB.prepare(
			`WITH lifecycle(erased, removed) AS (
			   SELECT
			     CASE WHEN ? IS NOT NULL AND EXISTS (
			       SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			     ) THEN 1 ELSE 0 END,
			     CASE WHEN EXISTS (
			       SELECT 1 FROM ai_provider_overrides
			        WHERE provider = ? AND disabled = 1
			     ) THEN 1 ELSE 0 END
			 )
			 INSERT OR IGNORE INTO ai_shadow_jobs
				(id, user_id, account_user_id, primary_run_id, provider, model, prompt_version,
				 status, attempts, lease_until, created_at, updated_at, terminal_at)
			 SELECT ?, ?, CASE WHEN lifecycle.erased = 1 THEN NULL ELSE ? END,
			        ?, ?, ?, NULL,
			        CASE
			          WHEN lifecycle.erased = 1 THEN 'cancelled_erased'
			          WHEN lifecycle.removed = 1 THEN 'cancelled_removed'
			          ELSE 'pending'
			        END,
			        0, NULL, ?, ?,
			        CASE WHEN lifecycle.erased = 1 OR lifecycle.removed = 1 THEN ? ELSE NULL END
			   FROM lifecycle
			  WHERE NOT EXISTS (
			    SELECT 1 FROM ai_shadow_jobs WHERE primary_run_id = ?
			  )`,
		).bind(
			accountUserId,
			accountUserId,
			removalProvider,
			id,
			run.user_id,
			accountUserId,
			run.id,
			shadow.provider,
			shadow.model ?? null,
			Number(run.created_at),
			now,
			now,
			run.id,
		).run();
		if (Number(result?.meta?.changes ?? 0) === 1) created += 1;
	}
	return created;
}

function shadowReferencesGoogle(shadow) {
	if (shadow?.provider === "google-vertex") return true;
	const model = typeof shadow?.model === "string" ? shadow.model.toLowerCase() : "";
	return model.startsWith("gemini-")
		|| model.startsWith("semantic-ranker-")
		|| model.startsWith("text-embedding-");
}

function accountUserIdFromScope(scopeJson) {
	try {
		const scope = JSON.parse(scopeJson ?? "{}");
		const value = scope?.account_user_id ?? scope?.accountUserId ?? null;
		return typeof value === "string" && value.length ? value : null;
	} catch {
		return null;
	}
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
export async function drainShadowJobs(env, { limit = 5, now = null, clock = Date.now } = {}) {
	if (!env?.DB) return { drained: 0 };
	let drained = 0;
	try {
		const fixedNow = now === null || now === undefined ? null : Number(now);
		const hasFixedNow = Number.isFinite(fixedNow);
		const scanNow = hasFixedNow ? fixedNow : Number(clock());
		// `invoking` is provider-call ownership, not retryable queue ownership. A
		// worker that disappears after admission must never cause a second model
		// call. The lease is deliberately longer than the provider's bounded call;
		// once it expires, retire the observation instead of replaying it.
		await env.DB.prepare(
			`UPDATE ai_shadow_jobs
			 SET status = 'dead_letter', claim_token = NULL, lease_until = NULL,
			     error_class = 'invocation_lease_expired', terminal_at = ?, updated_at = ?
			 WHERE status = 'invoking' AND lease_until IS NOT NULL AND lease_until < ?`,
		).bind(scanNow, scanNow, scanNow).run();
		const due = await env.DB.prepare(
			`SELECT id FROM ai_shadow_jobs
			 WHERE status = 'pending' OR (status = 'running' AND lease_until < ?)
			 ORDER BY created_at, id LIMIT ?`,
		).bind(scanNow, limit).all();
		for (const candidate of due?.results ?? []) {
			const claimNow = hasFixedNow ? fixedNow : Number(clock());
			const claimed = await claimShadowJob(env, candidate.id, { now: claimNow });
			if (!claimed) continue;
			await processShadowJob(env, claimed).catch(async (error) => {
				await settleShadowAttemptFailure(env, claimed, {
					reservationId: error?.reservationId ?? await shadowAttemptReservationId(claimed),
					errorClass: typeof error?.jobErrorClass === "string"
						? error.jobErrorClass
						: typeof error?.aiErrorClass === "string" ? error.aiErrorClass : "error",
				});
			});
			drained += 1;
		}
	} catch (error) {
		console.warn("shadow drain failed:", error?.message ?? error);
	}
	return { drained };
}

async function shadowAttemptReservationId(job) {
	const attemptScopeId = `${job.id}:attempt:${Math.max(0, Math.floor(Number(job.attempts) || 0))}`;
	return providerOperationId({
		scope: "shadow_extract",
		scopeId: attemptScopeId,
		task: "extract",
		ordinal: 0,
	});
}

async function reservationStatus(env, reservationId) {
	if (!env?.DB || !reservationId) return null;
	const row = await env.DB.prepare(
		"SELECT status FROM ai_provider_reservations WHERE id = ?",
	).bind(reservationId).first();
	return typeof row?.status === "string" ? row.status : null;
}

/**
 * A shadow retry is permitted only after the provider ledger proves the prior
 * operation was not billed. Ambiguous/in-flight/settled work is terminal: a
 * new attempt id there could invoke and charge the provider twice.
 */
async function settleShadowAttemptFailure(env, job, {
	reservationId,
	errorClass,
	usage = null,
	durationMs = null,
} = {}) {
	const disposition = await reservationStatus(env, reservationId);
	const provenUnbilled = disposition === null || disposition === "released";
	const status = provenUnbilled && Number(job.attempts) < MAX_ATTEMPTS
		? "pending"
		: "dead_letter";
	return settleShadowJob(env, job, {
		status,
		errorClass,
		usage,
		durationMs,
	});
}

function shadowThrownErrorClass(errorClass) {
	if (String(errorClass).startsWith("admission_operation_")) return "operation_refused";
	if (errorClass === "admission_billing") return "billing";
	if (String(errorClass).startsWith("admission_")) return "provider_refused";
	return errorClass ?? "error";
}

/** Token-fenced claim used by the cron and by concurrency regressions. */
export async function claimShadowJob(env, id, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
	const claimToken = crypto.randomUUID();
	return env.DB.prepare(
		`UPDATE ai_shadow_jobs
		 SET status = 'running', attempts = attempts + 1, claim_token = ?,
		     lease_until = ?, updated_at = ?
		 WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?))
		 RETURNING *`,
	).bind(claimToken, now + leaseMs, now, id, now).first();
}

export async function settleShadowJob(env, job, { status, comparison = null, usage = null, durationMs = null, errorClass = null, now = Date.now() }) {
	// pending = lease released for the next tick; anything else is terminal.
	const terminalAt = SHADOW_TERMINAL_SET.has(status) ? now : null;
	const result = await env.DB.prepare(
		`UPDATE ai_shadow_jobs
		 SET status = ?, claim_token = NULL, lease_until = NULL, comparison_json = ?,
			input_tokens = ?, output_tokens = ?, duration_ms = ?, error_class = ?,
			updated_at = ?, terminal_at = ?
		 WHERE id = ? AND status IN ('running', 'invoking') AND claim_token = ?`,
	).bind(
		status,
		comparison ? JSON.stringify(comparison) : null,
		usage?.input ?? null,
		usage?.output ?? null,
		durationMs,
		errorClass,
		now,
		terminalAt,
		job.id,
		job.claim_token,
	).run();
	return Number(result?.meta?.changes ?? 0);
}

async function barrierCovers(env, userId, sinceTs) {
	const barrier = await env.DB.prepare(
		"SELECT barrier_at FROM deletion_barriers WHERE user_id = ?",
	).bind(userId).first();
	return barrier != null && Number(barrier.barrier_at) >= Number(sinceTs);
}

async function accountErasureCovers(env, accountUserId) {
	if (!accountUserId) return false;
	const tombstone = await env.DB.prepare(
		"SELECT 1 AS erased FROM account_erasure_tombstones WHERE user_id = ? LIMIT 1",
	).bind(accountUserId).first();
	return tombstone != null;
}

function managedProjectIdFromScope(scopeJson) {
	try {
		const scope = JSON.parse(scopeJson ?? "{}");
		const value = scope?.managed_project_id ?? scope?.managedProjectId ?? null;
		return typeof value === "string" && value.length ? value : null;
	} catch {
		return null;
	}
}

async function projectAllowsInvocation(env, scopeJson) {
	const projectId = managedProjectIdFromScope(scopeJson);
	if (!projectId) return true;
	const project = await env.DB.prepare(
		`SELECT 1 AS active FROM managed_projects
		 WHERE id = ? AND status = 'active'
		   AND (lifecycle_state IS NULL OR lifecycle_state = 'active')
		 LIMIT 1`,
	).bind(projectId).first();
	return project != null;
}

/**
 * Linearization point for an external shadow invocation.
 *
 * This one D1 write either happens before a lifecycle fence (the deleter then
 * observes `invoking` and cannot confirm yet), or after it (zero rows change,
 * so no provider call starts). Renewing the lease here gives the external call
 * its full bounded window even if input preparation consumed most of the
 * original queue-claim lease.
 */
export async function admitShadowInvocation(env, job, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
	return env.DB.prepare(
		`UPDATE ai_shadow_jobs
		 SET status = 'invoking', lease_until = ?, updated_at = ?
		 WHERE id = ? AND status = 'running' AND claim_token = ?
		   AND NOT EXISTS (
		     SELECT 1 FROM deletion_barriers b
		      WHERE b.user_id = ai_shadow_jobs.user_id
		        AND b.barrier_at >= ai_shadow_jobs.created_at
		   )
		   AND (
		     ai_shadow_jobs.account_user_id IS NULL OR NOT EXISTS (
		       SELECT 1 FROM account_erasure_tombstones t
		        WHERE t.user_id = ai_shadow_jobs.account_user_id
		     )
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM extraction_runs er
		      WHERE er.id = ai_shadow_jobs.primary_run_id
		        AND CASE WHEN json_valid(er.scope_json) THEN COALESCE(
		          json_extract(er.scope_json, '$.managed_project_id'),
		          json_extract(er.scope_json, '$.managedProjectId')
		        ) ELSE NULL END IS NOT NULL
		        AND NOT EXISTS (
		          SELECT 1 FROM managed_projects p
		           WHERE p.id = CASE WHEN json_valid(er.scope_json) THEN COALESCE(
		             json_extract(er.scope_json, '$.managed_project_id'),
		             json_extract(er.scope_json, '$.managedProjectId')
		           ) ELSE NULL END
		             AND p.status = 'active'
		             AND (p.lifecycle_state IS NULL OR p.lifecycle_state = 'active')
		        )
		   )
		 RETURNING *`,
	).bind(now + leaseMs, now, job.id, job.claim_token).first();
}

export async function processShadowJob(env, job) {
	if (Number(job.attempts) > MAX_ATTEMPTS) {
		return settleShadowJob(env, job, { status: "dead_letter", errorClass: "attempts_exhausted" });
	}
	// Erasure check BEFORE any content is touched.
	if (await barrierCovers(env, job.user_id, job.created_at)
		|| await accountErasureCovers(env, job.account_user_id)) {
		return settleShadowJob(env, job, { status: "cancelled_erased" });
	}
	const run = await env.DB.prepare(
		`SELECT id, source_packet_id, scope_json, created_nodes_json, created_slices_json,
			created_events_json, created_edges_json, created_candidates_json, status
		 FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1`,
	).bind(job.primary_run_id, job.user_id).first();
	if (!run) return settleShadowJob(env, job, { status: "cancelled_erased", errorClass: "primary_missing" });

	// Input re-derivation: the immutable, scrubbed, rules-filtered episodes.
	const episodes = await env.DB.prepare(
		`SELECT role, text FROM source_episodes
		 WHERE user_id = ? AND source_packet_id = ? ORDER BY message_index LIMIT 64`,
	).bind(job.user_id, run.source_packet_id).all();
	const messages = (episodes?.results ?? []).map((e) => ({ role: e.role || "user", content: e.text }));
	if (!messages.length) return settleShadowJob(env, job, { status: "cancelled_erased", errorClass: "source_gone" });

	const config = getConfig(env);
	const { buildPacket } = await import("../pipeline/packet.js");
	const { shortlistNodes } = await import("../pipeline/shortlist.js");
	const packet = buildPacket(messages, []);
	const text = messages.map((m) => m.content).join("\n");
	const shortlist = await shortlistNodes(env, config, job.user_id, text, null).catch(() => []);

	// Do not infer permission to call the provider from an earlier plaintext
	// read. Admission is a fresh, transactional lifecycle decision. A concurrent
	// delete/account erase/project transition either wins this write (no call) or
	// must wait for this bounded `invoking` owner before it can confirm.
	const invocation = await admitShadowInvocation(env, job);
	if (!invocation) {
		if (await barrierCovers(env, job.user_id, job.created_at)
			|| await accountErasureCovers(env, job.account_user_id)) {
			return settleShadowJob(env, job, { status: "cancelled_erased" });
		}
		if (!await projectAllowsInvocation(env, run.scope_json)) {
			return settleShadowJob(env, job, { status: "cancelled_lifecycle" });
		}
		// Claim loss/expiry is already represented by the row that won the race.
		// Never manufacture a second owner or invoke from this stale worker.
		return 0;
	}

	// The shadow pin routes ONLY this scope's extract lane to the shadow
	// provider; everything else the call touches stays default.
	const pin = buildPin({ routes: { extract: { provider: job.provider, model: job.model ?? null } } });
	const startedAt = Date.now();
	let proposal = null;
	let usage = null;
	// A retry after a proven-unbilled failure is a new provider operation, but
	// re-executing this same durable claim must resolve to the same operation.
	// `attempts` is incremented atomically by claimShadowJob and persisted with
	// the claim token, so the pair is both retry-distinct and replay-stable.
	const attemptScopeId = `${job.id}:attempt:${Math.max(0, Math.floor(Number(job.attempts) || 0))}`;
	const reservationId = await shadowAttemptReservationId(job);
	await withFlushedAiMeter(env, "shadow_extract", {
		userId: job.user_id,
		scopeId: attemptScopeId,
		lifecycle: {
			accountUserId: job.account_user_id ?? null,
			managedProjectId: managedProjectIdFromScope(run.scope_json),
			acceptedAt: Number(job.created_at),
		},
	}, async (meter) => {
		proposal = await withAiPin(pin, () => proposeMemory(env, config, { packet, shortlist }, { providerReservationId: reservationId }));
		const call = meter.calls[meter.calls.length - 1] ?? null;
		usage = call ? { input: call.input_tokens, output: call.output_tokens } : null;
		if (call && call.ok === 0) {
			throw Object.assign(new Error("shadow model call failed"), {
				aiErrorClass: shadowThrownErrorClass(call.error_class),
				jobErrorClass: call.error_class ?? "error",
				reservationId,
			});
		}
	});

	// Erasure check AFTER the model call: an erasure confirmed during inference
	// must cancel the record, not survive as a metric row.
	if (await barrierCovers(env, job.user_id, job.created_at)
		|| await accountErasureCovers(env, job.account_user_id)) {
		return settleShadowJob(env, job, { status: "cancelled_erased" });
	}
	if (!await projectAllowsInvocation(env, run.scope_json)) {
		return settleShadowJob(env, job, { status: "cancelled_lifecycle" });
	}

	const comparison = await compareProposals(proposal, run);
	if (proposal?._ok === false) {
		return settleShadowAttemptFailure(env, job, {
			reservationId,
			errorClass: String(proposal._outcome ?? "shadow_failed"),
			usage,
			durationMs: Date.now() - startedAt,
		});
	}
	return settleShadowJob(env, job, { status: "done", comparison, usage, durationMs: Date.now() - startedAt });
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
				SELECT id FROM ai_shadow_jobs
				 WHERE terminal_at IS NOT NULL
				   AND terminal_at < ?
				   AND status IN ('done', 'failed', 'cancelled_erased', 'cancelled_removed', 'cancelled_lifecycle', 'dead_letter')
				 ORDER BY terminal_at, id LIMIT ?
			)`,
		).bind(cutoff, limit).run();
		return Number(result?.meta?.changes ?? 0);
	} catch (error) {
		console.warn("shadow retention purge failed:", error?.message ?? error);
		return 0;
	}
}
