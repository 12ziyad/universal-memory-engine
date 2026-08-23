/**
 * E4 atomic capture execution and persistence.
 *
 * The model proposes; code verifies an exact span in an already-scrubbed source
 * message; D1 then requires the corresponding permitted source episode to
 * exist in the same scope before it can persist a candidate. This lane is
 * append-only and deliberately absent from recall until E6/E7 ablations earn
 * read-path participation.
 */

import { runAi, withFlushedAiMeter } from "../lib/ai_meter.js";
import { buildPin, currentPin, pinnedRoute, withAiPin } from "../ai/pin.js";
import { managedMutationGuardStatement } from "../lib/managed_projects.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import {
	projectMemorySpaceRegistrationStatement,
	retentionFenceGuardStatement,
	retentionProjectForMemoryOwner,
} from "../lib/retention.js";
import {
	ATOMIC_CAPTURE_SCHEMA,
	ATOMIC_CARDINALITIES,
	ATOMIC_ENTITY_TYPES,
	ATOMIC_TYPES,
	MAX_ATOMIC_PROPOSALS,
	buildAtomicCaptureMessages,
	normalizeAtomicCapture,
	parseAtomicCaptureText,
} from "./atomic_capture.mjs";
import { planExtractionChunks, verifyChunkCoverage } from "./chunking.js";
import { buildPacket } from "./packet.js";
import { responseText, responseTruncated } from "./llm.js";

export const ATOMIC_CAPTURE_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const ATOMIC_CAPTURE_MAX_TOKENS = 3072;
export const ATOMIC_CAPTURE_RUN_TTL_MS = 15 * 60 * 1000;
export const ATOMIC_CAPTURE_MAX_ATTEMPTS = 6;

export const ATOMIC_CAPTURE_JSON_SCHEMA = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: {
		atoms: {
			type: "array",
			maxItems: MAX_ATOMIC_PROPOSALS,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					type: { type: "string", enum: [...ATOMIC_TYPES] },
					entity: { type: "string" },
					entity_type: { type: "string", enum: [...ATOMIC_ENTITY_TYPES] },
					attribute: { type: "string" },
					value: { type: "string" },
					assertion: { type: "string" },
					source_message_id: { type: "string" },
					evidence_quote: { type: "string" },
					raw_temporal_phrase: { type: "string" },
					project_category: { type: "string" },
					cardinality: { type: "string", enum: [...ATOMIC_CARDINALITIES] },
					confidence: { type: "number", minimum: 0, maximum: 1 },
				},
				required: [
					"type", "entity", "entity_type", "attribute", "value", "assertion",
					"source_message_id", "evidence_quote", "cardinality", "confidence",
				],
			},
		},
	},
	required: ["atoms"],
});

function integer(value) {
	return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function safeErrorCode(value, fallback = "internal_error") {
	const code = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 64);
	return code || fallback;
}

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value ?? ""));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function captureRunId(userId, sourcePacketId, chunkKey) {
	return `atomrun:v1:${await sha256Hex(JSON.stringify({
		schema: ATOMIC_CAPTURE_SCHEMA,
		user_id: userId,
		source_packet_id: sourcePacketId,
		chunk_key: chunkKey,
	}))}`;
}

/**
 * Durable identity for exactly one provider attempt of one atomic-capture run.
 *
 * Atomic capture executes inside the parent extraction meter, whose ordinal is
 * intentionally shared by every model call in that extraction. Scheduler or
 * feature-order changes can therefore move the ordinal without changing this
 * logical operation. The capture ledger already owns the correct durable
 * identity: its content-free run id plus its persisted, fenced attempt number.
 */
export function atomicCaptureProviderOperationId(runId, attempt) {
	const durableRunId = typeof runId === "string" ? runId.trim() : "";
	if (!durableRunId) throw new TypeError("atomic provider operation requires a capture run id");
	return `airesv_atom:v1:${durableRunId}:attempt:${Math.max(1, integer(attempt))}`;
}

function terminalRunResult(row, { replayed = false } = {}) {
	const status = String(row?.status ?? "failed");
	const completed = status === "completed" || status === "empty";
	return {
		captureRunId: row?.id ?? null,
		outcome: completed ? "completed" : status === "cancelled_by_delete" ? status : row?.error_code ?? status,
		complete: completed,
		proposed: integer(row?.proposed_count),
		accepted: integer(row?.accepted_count),
		stored: integer(row?.stored_count),
		rejected: integer(row?.rejected_count),
		duplicates: integer(row?.duplicate_count),
		truncated: Number(row?.truncated ?? 0) === 1,
		temporalPresent: integer(row?.temporal_phrase_count),
		temporalResolved: integer(row?.temporal_resolved_count),
		temporalUnresolved: integer(row?.temporal_unresolved_count),
		temporalAnchorMissing: integer(row?.temporal_anchor_missing_count),
		replayed,
	};
}

function inProgressRunResult(row, { replayed = true } = {}) {
	return {
		captureRunId: row?.id ?? null,
		outcome: "in_progress",
		complete: false,
		proposed: 0,
		accepted: 0,
		stored: 0,
		rejected: 0,
		duplicates: 0,
		truncated: false,
		temporalPresent: 0,
		temporalResolved: 0,
		temporalUnresolved: 0,
		temporalAnchorMissing: 0,
		replayed,
	};
}

function cancelledBeforeClaimResult() {
	return {
		captureRunId: null,
		outcome: "cancelled_by_delete",
		complete: false,
		proposed: 0,
		accepted: 0,
		stored: 0,
		rejected: 0,
		duplicates: 0,
		truncated: false,
		temporalPresent: 0,
		temporalResolved: 0,
		temporalUnresolved: 0,
		temporalAnchorMissing: 0,
		replayed: false,
	};
}

async function failRun(env, userId, runId, errorCode, counts = {}, expectedAttempt = 1) {
	const now = Date.now();
	const code = safeErrorCode(errorCode);
	const failed = await env.DB.prepare(
		`UPDATE semantic_atom_capture_runs
		 SET status = 'failed', error_code = ?, proposed_count = ?, accepted_count = ?,
			stored_count = ?, rejected_count = ?, duplicate_count = ?, truncated = ?,
			temporal_phrase_count = ?, temporal_resolved_count = ?,
			temporal_unresolved_count = ?, temporal_anchor_missing_count = ?,
			rejected_reasons_json = ?, updated_at = ?, completed_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'running' AND attempts = ?`,
	).bind(
		code,
		integer(counts.proposed),
		integer(counts.accepted),
		integer(counts.stored),
		integer(counts.rejected),
		integer(counts.duplicates),
		counts.truncated ? 1 : 0,
		integer(counts.temporalPresent),
		integer(counts.temporalResolved),
		integer(counts.temporalUnresolved),
		integer(counts.temporalAnchorMissing),
		counts.rejectedByReason ? JSON.stringify(counts.rejectedByReason) : null,
		now,
		now,
		runId,
		userId,
		integer(expectedAttempt),
	).run();
	if (Number(failed?.meta?.changes ?? 0) !== 1) {
		const current = await env.DB.prepare(
			"SELECT * FROM semantic_atom_capture_runs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(runId, userId).first();
		if (current?.status === "running") return inProgressRunResult(current);
		return terminalRunResult(current, { replayed: true });
	}
	return {
		captureRunId: runId,
		outcome: code,
		complete: false,
		proposed: integer(counts.proposed),
		accepted: integer(counts.accepted),
		stored: integer(counts.stored),
		rejected: integer(counts.rejected),
		duplicates: integer(counts.duplicates),
		truncated: Boolean(counts.truncated),
		temporalPresent: integer(counts.temporalPresent),
		temporalResolved: integer(counts.temporalResolved),
		temporalUnresolved: integer(counts.temporalUnresolved),
		temporalAnchorMissing: integer(counts.temporalAnchorMissing),
		replayed: false,
	};
}

async function claimRun(env, {
	userId,
	accountUserId,
	memoryOwnerUserId,
	managedProjectId,
	projectId,
	projectName,
	sourcePacketId,
	extractionRunId,
	chunkKey,
	acceptedAt,
}) {
	const id = await captureRunId(userId, sourcePacketId, chunkKey);
	const now = Date.now();
	// The claim records the provider/model HALF-PIN this run will execute with.
	// Historically `model` was recorded but the invocation used the constant —
	// so a deploy changing the constant silently re-interpreted an interrupted
	// chunk. proposeAtomic now takes the ROW's model, closing that gap; the
	// pin (when routing is on) supplies both halves at claim time.
	const pinned = pinnedRoute(currentPin(), "extract_atomic");
	const insertStatement = env.DB.prepare(
		`INSERT INTO semantic_atom_capture_runs
		 (id, user_id, project_id, project_name, source_packet_id, extraction_run_id,
		  chunk_key, status, model, schema_version, provider, accepted_at, attempts, created_at, updated_at)
		 SELECT ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 1, ?, ?
		 WHERE NOT EXISTS (
			SELECT 1 FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ?
		 )
		 ON CONFLICT(user_id, source_packet_id, chunk_key) DO NOTHING`,
	).bind(
		id,
		userId,
		projectId,
		projectName,
		sourcePacketId,
		extractionRunId,
		chunkKey,
		pinned?.model ?? ATOMIC_CAPTURE_MODEL,
		ATOMIC_CAPTURE_SCHEMA,
		pinned?.provider ?? null,
		acceptedAt,
		now,
		now,
		userId,
		acceptedAt,
	);
	let inserted;
	try {
		const statements = [];
		if (managedProjectId && memoryOwnerUserId) {
			statements.push(
				managedMutationGuardStatement(env, {
					accountUserId: accountUserId ?? null,
					projectId: managedProjectId,
				}),
				retentionFenceGuardStatement(env, {
					projectId: managedProjectId,
					retentionClass: "semantic_memory",
					acceptedAt,
				}),
				projectMemorySpaceRegistrationStatement(env, {
					projectId: managedProjectId,
					memoryOwnerUserId,
					memoryUserId: userId,
					seenAt: acceptedAt,
				}),
			);
		}
		statements.push(insertStatement);
		const results = await env.DB.batch(statements);
		inserted = results[results.length - 1];
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			if (managedProjectId) {
				const active = await env.DB.prepare(
					"SELECT 1 AS ok FROM managed_projects WHERE id = ? AND status = 'active' LIMIT 1",
				).bind(managedProjectId).first();
				if (!active) return { claimed: false, row: null, cancelledByDelete: true };
			}
			return { claimed: false, row: null, cancelledByRetention: true };
		}
		throw error;
	}
	let row = await env.DB.prepare(
		`SELECT * FROM semantic_atom_capture_runs
		 WHERE user_id = ? AND source_packet_id = ? AND chunk_key = ? LIMIT 1`,
	).bind(userId, sourcePacketId, chunkKey).first();
	// The barrier and this conditional claim are both D1 writes, so their order
	// is authoritative. If deletion won, do not create even a content-free audit
	// row after erasure and do not spend the atomic model call. The second check
	// also covers a claim that cleanup removed between INSERT and SELECT.
	if (!row) {
		const barrier = await env.DB.prepare(
			"SELECT barrier_at FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ? LIMIT 1",
		).bind(userId, acceptedAt).first();
		if (barrier) return { claimed: false, row: null, cancelledByDelete: true };
		throw new Error("atomic capture run claim disappeared");
	}
	if (Number(inserted.meta?.changes ?? 0) === 1) return { claimed: true, row };
	if (row.status === "running" && now - Number(row.updated_at ?? row.created_at ?? 0) > ATOMIC_CAPTURE_RUN_TTL_MS) {
		await env.DB.prepare(
			`UPDATE semantic_atom_capture_runs
			 SET status = 'failed', error_code = 'interrupted_unknown', updated_at = ?, completed_at = ?
			 WHERE id = ? AND user_id = ? AND status = 'running' AND updated_at = ?`,
		).bind(now, now, row.id, userId, row.updated_at).run();
		row = await env.DB.prepare(
			"SELECT * FROM semantic_atom_capture_runs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(row.id, userId).first();
	}
	// A dead Worker may leave an inference outcome unknowable. Once the same
	// durable TTL used by extraction recovery has elapsed, an exact packet replay
	// may reclaim only that interrupted chunk. A non-default provider gets a new
	// attempt ONLY when its prior durable reservation says `released` (provider
	// evidence that it was not billed). Settled, invoking, ambiguous, and missing
	// reservation states are all fail-closed: none may mint another authorization.
	// The monotonically increasing attempt number is also a write fence: a late
	// superseded invocation cannot publish candidates or overwrite this attempt's
	// terminal marker.
	if (
		row.status === "failed"
		&& ["interrupted_unknown", "transport_error", "timeout"].includes(row.error_code)
		&& integer(row.attempts) < ATOMIC_CAPTURE_MAX_ATTEMPTS
	) {
		const reclaimed = await env.DB.prepare(
			`UPDATE semantic_atom_capture_runs
			 SET status = 'running', extraction_run_id = ?, attempts = attempts + 1,
				replay_count = replay_count + 1, proposed_count = 0, accepted_count = 0,
				stored_count = 0, rejected_count = 0, duplicate_count = 0, truncated = 0,
				temporal_phrase_count = 0, temporal_resolved_count = 0,
				temporal_unresolved_count = 0, temporal_anchor_missing_count = 0,
				rejected_reasons_json = NULL, error_code = NULL, updated_at = ?, completed_at = NULL
			 WHERE id = ? AND user_id = ? AND status = 'failed' AND attempts = ?
			   AND NOT EXISTS (
				SELECT 1 FROM semantic_atom_candidates c
				 WHERE c.user_id = ? AND c.capture_run_id = semantic_atom_capture_runs.id
			   )
			   AND (
				(
					COALESCE(provider, 'workers-ai') = 'workers-ai'
					AND error_code = 'interrupted_unknown'
					AND NOT EXISTS (
						SELECT 1 FROM ai_provider_reservations p
						 WHERE p.id = 'airesv_atom:v1:' || semantic_atom_capture_runs.id
							|| ':attempt:' || semantic_atom_capture_runs.attempts
					)
				)
				OR (
					COALESCE(provider, 'workers-ai') <> 'workers-ai'
					AND error_code IN ('interrupted_unknown', 'transport_error', 'timeout')
					AND EXISTS (
						SELECT 1 FROM ai_provider_reservations p
						 WHERE p.id = 'airesv_atom:v1:' || semantic_atom_capture_runs.id
							|| ':attempt:' || semantic_atom_capture_runs.attempts
						   AND p.provider = semantic_atom_capture_runs.provider
						   AND p.status = 'released'
					)
				)
			   )
			 RETURNING *`,
		).bind(
			extractionRunId,
			now,
			row.id,
			userId,
			integer(row.attempts),
			userId,
		).first();
		if (reclaimed) return { claimed: true, row: reclaimed, reclaimed: true };
		row = await env.DB.prepare(
			"SELECT * FROM semantic_atom_capture_runs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(row.id, userId).first();
	}
	if (row.status !== "running") {
		await env.DB.prepare(
			"UPDATE semantic_atom_capture_runs SET replay_count = replay_count + 1, updated_at = ? WHERE id = ? AND user_id = ?",
		).bind(now, row.id, userId).run();
	}
	return { claimed: false, row };
}

/**
 * Exact-replay repair is permitted for an otherwise terminal job only when the
 * atomic ledger itself proves an interrupted chunk. Semantic/schema failures
 * are intentionally excluded: they remain visible terminal outcomes and cannot
 * turn an ordinary enriched replay into another inference call.
 */
export async function hasRecoverableAtomicCaptureInterruption(
	env,
	userId,
	sourcePacketId,
	{ projectId = null, now = Date.now() } = {},
) {
	if (!userId || !sourcePacketId) return false;
	const row = await env.DB.prepare(
		`SELECT 1 AS recoverable
		 FROM semantic_atom_capture_runs r
		 WHERE r.user_id = ? AND r.source_packet_id = ? AND r.project_id IS ?
		   AND r.attempts < ?
		   AND NOT EXISTS (
			SELECT 1 FROM semantic_atom_candidates c
			 WHERE c.user_id = r.user_id AND c.capture_run_id = r.id
		   )
		   AND (
			(
				COALESCE(r.provider, 'workers-ai') = 'workers-ai'
				AND (
					(r.status = 'running' AND r.updated_at <= ?)
					OR (r.status = 'failed' AND r.error_code = 'interrupted_unknown')
				)
				AND NOT EXISTS (
					SELECT 1 FROM ai_provider_reservations p
					 WHERE p.id = 'airesv_atom:v1:' || r.id || ':attempt:' || r.attempts
				)
			)
			OR (
				COALESCE(r.provider, 'workers-ai') <> 'workers-ai'
				AND (
					(r.status = 'running' AND r.updated_at <= ?)
					OR (r.status = 'failed' AND r.error_code IN ('interrupted_unknown', 'transport_error', 'timeout'))
				)
				AND EXISTS (
					SELECT 1 FROM ai_provider_reservations p
					 WHERE p.id = 'airesv_atom:v1:' || r.id || ':attempt:' || r.attempts
					   AND p.provider = r.provider
					   AND p.status = 'released'
				)
			)
		   )
		 LIMIT 1`,
	).bind(
		userId,
		sourcePacketId,
		projectId,
		ATOMIC_CAPTURE_MAX_ATTEMPTS,
		Number(now) - ATOMIC_CAPTURE_RUN_TTL_MS,
		Number(now) - ATOMIC_CAPTURE_RUN_TTL_MS,
	).first();
	return Number(row?.recoverable ?? 0) === 1;
}

function parsedModelValue(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		if (Array.isArray(value.atoms)) return value;
		if (value.response && typeof value.response === "object" && Array.isArray(value.response.atoms)) {
			return value.response;
		}
		if (value.result && typeof value.result === "object" && Array.isArray(value.result.atoms)) {
			return value.result;
		}
	}
	return parseAtomicCaptureText(typeof value === "string" ? value : responseText(value));
}

async function proposeAtomic(env, packet, rules, override, context, model = ATOMIC_CAPTURE_MODEL, reservationId = null) {
	let response;
	let truncated = false;
	try {
		if (override !== undefined && override !== null) {
			response = typeof override === "function" ? await override(context) : override;
		} else {
			if (!env.AI) return { ok: false, outcome: "no_ai_binding", parsed: null, truncated: false };
			response = await runAi(env, model, {
				messages: buildAtomicCaptureMessages(packet, { rules }),
				temperature: 0,
				max_tokens: ATOMIC_CAPTURE_MAX_TOKENS,
				// Llama 4 Scout's current first-party model contract exposes
				// guided_json. Local validation remains mandatory because provider
				// schema guidance is not a trust boundary.
				guided_json: ATOMIC_CAPTURE_JSON_SCHEMA,
			}, undefined, { task: "extract_atomic", reservationId });
			truncated = responseTruncated(response);
		}
		const parsed = parsedModelValue(response);
		return parsed
			? { ok: true, outcome: parsed._truncated || truncated ? "truncated_salvaged" : "parsed", parsed, truncated: Boolean(parsed._truncated || truncated) }
			: { ok: false, outcome: truncated ? "truncated_unsalvageable" : "parse_invalid", parsed: null, truncated };
	} catch (error) {
		const name = String(error?.name ?? "").toLowerCase();
		const code = String(error?.code ?? "").toLowerCase();
		const outcome = name.includes("abort") || name.includes("timeout") || code.includes("timeout")
			? "timeout"
			: "transport_error";
		console.warn(JSON.stringify({
			event: "atomic_capture_failed",
			outcome,
			model,
			error_name: String(error?.name ?? "Error").slice(0, 80),
			error_code: error?.code == null ? null : String(error.code).slice(0, 80),
		}));
		return { ok: false, outcome, parsed: null, truncated: false };
	}
}

async function persistChunk(env, {
	userId,
	accountUserId,
	memoryOwnerUserId,
	managedProjectId,
	projectId,
	sourcePacketId,
	extractionRunId,
	acceptedAt,
	runId,
	runAttempt,
	chunkKey,
	atoms,
	outcomes,
	truncated,
}) {
	const now = Date.now();
	const statements = [];
	const candidateInsertIndexes = [];
	if (managedProjectId) statements.push(managedMutationGuardStatement(env, {
		accountUserId: accountUserId ?? null,
		projectId: managedProjectId,
	}));
	statements.push(env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE EXISTS (
			SELECT 1 FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ?
		 )`,
	).bind(userId, acceptedAt));
	if (managedProjectId && memoryOwnerUserId) {
		statements.push(
			retentionFenceGuardStatement(env, {
				projectId: managedProjectId,
				retentionClass: "semantic_memory",
				acceptedAt,
			}),
			projectMemorySpaceRegistrationStatement(env, {
				projectId: managedProjectId,
				memoryOwnerUserId,
				memoryUserId: userId,
				seenAt: acceptedAt,
			}),
		);
	}

	for (const atom of atoms) {
		// Provenance is a commit precondition, not a later integrity check. If
		// the scrubbed episode vanished or belongs to another scope, trip the
		// same atomic rollback guard used by graph commits.
		statements.push(env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM source_episodes
				 WHERE user_id = ? AND source_packet_id = ? AND message_id = ? AND project_id IS ?
			 )`,
		).bind(userId, sourcePacketId, atom.sourceMessageId, projectId));
		const evidenceHash = await sha256Hex(atom.evidenceQuote);
		const dedupeKey = await sha256Hex(JSON.stringify({
			user_id: userId,
			project_id: projectId,
			source_packet_id: sourcePacketId,
			source_message_id: atom.sourceMessageId,
			start_code_point: atom.startCodePoint,
			end_code_point: atom.endCodePoint,
			type: atom.type,
			entity: atom.entity,
			attribute: atom.attribute,
			value: atom.value,
			assertion: atom.assertion,
		}));
		candidateInsertIndexes.push(statements.length);
		statements.push(env.DB.prepare(
			`INSERT INTO semantic_atom_candidates
			 (id, user_id, memory_user_id, owner_user_id, external_user_id,
			  project_id, project_name, capture_run_id, extraction_run_id,
			  source_episode_id, source_packet_id, chunk_key, source_message_id,
			  start_code_point, end_code_point, evidence_quote, evidence_hash, dedupe_key,
			  atom_type, entity, entity_type, attribute, value, assertion,
			  raw_temporal_phrase, cardinality, confidence,
			  source_time, source_time_offset_minutes, source_time_precision, observed_at,
			  event_time, event_time_end, event_time_precision, event_time_relation,
				event_time_source, event_time_anchor, temporal_schema,
				extraction_model, schema_version, status, created_at, project_category_id)
			 SELECT ?, e.user_id, e.memory_user_id, e.owner_user_id, e.external_user_id,
				e.project_id, e.project_name, ?, ?, e.id, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, e.source_time, e.source_time_offset_minutes,
				e.source_time_precision, e.observed_at, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?,
				(SELECT id FROM project_categories WHERE id = ? AND project_id = ? AND status = 'active')
			 FROM source_episodes e
			 WHERE e.user_id = ? AND e.source_packet_id = ? AND e.message_id = ? AND e.project_id IS ?
			   AND EXISTS (
				SELECT 1 FROM semantic_atom_capture_runs r
				 WHERE r.id = ? AND r.user_id = ? AND r.status = 'running' AND r.attempts = ?
			   )
			 ON CONFLICT DO NOTHING`,
		).bind(
			atom.id,
			runId,
			extractionRunId,
			sourcePacketId,
			chunkKey,
			atom.sourceMessageId,
			atom.startCodePoint,
			atom.endCodePoint,
			atom.evidenceQuote,
			evidenceHash,
			dedupeKey,
			atom.type,
			atom.entity,
			atom.entityType,
			atom.attribute,
			atom.value,
			atom.assertion,
			atom.rawTemporalPhrase,
			atom.cardinality,
			atom.confidence,
			atom.temporal?.eventTime ?? null,
			atom.temporal?.eventTimeEnd ?? null,
			atom.temporal?.eventTimePrecision ?? null,
			atom.temporal?.eventTimeRelation ?? null,
			atom.temporal?.eventTimeSource ?? null,
			atom.temporal?.eventTimeAnchor ?? null,
			atom.temporal?.schema ?? null,
			ATOMIC_CAPTURE_MODEL,
			ATOMIC_CAPTURE_SCHEMA,
			now,
			atom.projectCategoryId ?? null,
			managedProjectId ?? null,
			userId,
			sourcePacketId,
			atom.sourceMessageId,
			projectId,
			runId,
			userId,
			integer(runAttempt),
		));
	}

	const status = atoms.length ? "completed" : "empty";
	const runUpdateIndex = statements.length;
	statements.push(env.DB.prepare(
		`UPDATE semantic_atom_capture_runs
		 SET status = ?, proposed_count = ?, accepted_count = ?,
			stored_count = (
				SELECT COUNT(*) FROM semantic_atom_candidates
				 WHERE user_id = ? AND capture_run_id = ?
			),
			rejected_count = ?,
			duplicate_count = ? + ? - (
				SELECT COUNT(*) FROM semantic_atom_candidates
				 WHERE user_id = ? AND capture_run_id = ?
			),
			truncated = ?, temporal_phrase_count = ?, temporal_resolved_count = ?,
			temporal_unresolved_count = ?, temporal_anchor_missing_count = ?,
			rejected_reasons_json = ?,
			error_code = NULL, updated_at = ?, completed_at = ?
			 WHERE id = ? AND user_id = ? AND status = 'running' AND attempts = ?`,
	).bind(
		status,
		integer(outcomes.proposed),
		atoms.length,
		userId,
		runId,
		integer(outcomes.rejected),
		integer(outcomes.duplicate),
		atoms.length,
		userId,
		runId,
		truncated ? 1 : 0,
		integer(outcomes.temporalPresent),
		integer(outcomes.temporalResolved),
		integer(outcomes.temporalUnresolved),
		integer(outcomes.temporalAnchorMissing),
		JSON.stringify(outcomes.rejectedByReason ?? {}),
		now,
		now,
		runId,
		userId,
		integer(runAttempt),
	));

	try {
		const results = await env.DB.batch(statements);
		if (Number(results[runUpdateIndex]?.meta?.changes ?? 0) !== 1) {
			throw new Error("atomic capture run did not accept its commit marker");
		}
		const stored = candidateInsertIndexes.reduce(
			(sum, index) => sum + integer(results[index]?.meta?.changes),
			0,
		);
		const duplicates = integer(outcomes.duplicate) + Math.max(0, atoms.length - stored);
		return {
			captureRunId: runId,
			outcome: "completed",
			complete: true,
			proposed: integer(outcomes.proposed),
			accepted: atoms.length,
			stored,
			rejected: integer(outcomes.rejected),
			duplicates,
			truncated: Boolean(truncated),
			temporalPresent: integer(outcomes.temporalPresent),
			temporalResolved: integer(outcomes.temporalResolved),
			temporalUnresolved: integer(outcomes.temporalUnresolved),
			temporalAnchorMissing: integer(outcomes.temporalAnchorMissing),
			replayed: false,
		};
	} catch (error) {
		const message = String(error?.message ?? error);
		if (/fence_guard/i.test(message)) {
			const barrier = await env.DB.prepare(
				"SELECT barrier_at FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ? LIMIT 1",
			).bind(userId, acceptedAt).first();
			const retentionFence = !barrier && managedProjectId
				? await env.DB.prepare(
					`SELECT cutoff_at FROM retention_fences
					  WHERE project_id = ? AND class = 'semantic_memory' AND cutoff_at >= ? LIMIT 1`,
				).bind(managedProjectId, acceptedAt).first()
				: null;
			const code = barrier
				? "cancelled_by_delete"
				: retentionFence ? "cancelled_by_retention" : "source_episode_unavailable";
			const terminalStatus = barrier ? "cancelled_by_delete" : "failed";
			const terminal = await env.DB.prepare(
				`UPDATE semantic_atom_capture_runs
				 SET status = ?, error_code = ?, proposed_count = ?, accepted_count = ?,
					stored_count = 0, rejected_count = ?, duplicate_count = ?, truncated = ?,
					temporal_phrase_count = ?, temporal_resolved_count = ?,
					temporal_unresolved_count = ?, temporal_anchor_missing_count = ?,
					rejected_reasons_json = ?, updated_at = ?, completed_at = ?
				 WHERE id = ? AND user_id = ? AND status = 'running' AND attempts = ?`,
			).bind(
				terminalStatus,
				code,
				integer(outcomes.proposed),
				atoms.length,
				integer(outcomes.rejected),
				integer(outcomes.duplicate),
				truncated ? 1 : 0,
				integer(outcomes.temporalPresent),
				integer(outcomes.temporalResolved),
				integer(outcomes.temporalUnresolved),
				integer(outcomes.temporalAnchorMissing),
				JSON.stringify(outcomes.rejectedByReason ?? {}),
				now,
				now,
				runId,
				userId,
				integer(runAttempt),
			).run();
			if (Number(terminal?.meta?.changes ?? 0) !== 1) {
				const current = await env.DB.prepare(
					"SELECT * FROM semantic_atom_capture_runs WHERE id = ? AND user_id = ? LIMIT 1",
				).bind(runId, userId).first();
				if (current?.status === "running") return inProgressRunResult(current);
				return terminalRunResult(current, { replayed: true });
			}
			return {
				captureRunId: runId,
				outcome: code,
				complete: false,
				proposed: integer(outcomes.proposed),
				accepted: atoms.length,
				stored: 0,
				rejected: integer(outcomes.rejected),
				duplicates: integer(outcomes.duplicate),
				truncated: Boolean(truncated),
				temporalPresent: integer(outcomes.temporalPresent),
				temporalResolved: integer(outcomes.temporalResolved),
				temporalUnresolved: integer(outcomes.temporalUnresolved),
				temporalAnchorMissing: integer(outcomes.temporalAnchorMissing),
				replayed: false,
			};
		}
		console.warn(JSON.stringify({
			event: "atomic_capture_failed",
			outcome: "write_failed",
			model: ATOMIC_CAPTURE_MODEL,
			error_name: String(error?.name ?? "Error").slice(0, 80),
		}));
		return failRun(env, userId, runId, "write_failed", {
			proposed: outcomes.proposed,
			accepted: atoms.length,
			rejected: outcomes.rejected,
			duplicates: outcomes.duplicate,
			truncated,
			temporalPresent: outcomes.temporalPresent,
			temporalResolved: outcomes.temporalResolved,
			temporalUnresolved: outcomes.temporalUnresolved,
			temporalAnchorMissing: outcomes.temporalAnchorMissing,
			rejectedByReason: outcomes.rejectedByReason,
		}, runAttempt);
	}
}

async function captureChunk(env, options, plannedChunk) {
	const claim = await claimRun(env, {
		...options,
		chunkKey: plannedChunk.key,
	});
	if (claim.cancelledByRetention) return {
		...cancelledBeforeClaimResult(),
		outcome: "cancelled_by_retention",
	};
	if (claim.cancelledByDelete) return cancelledBeforeClaimResult();
	if (!claim.claimed) {
		if (claim.row.status === "running") {
			return inProgressRunResult(claim.row);
		}
		return terminalRunResult(claim.row, { replayed: true });
	}

	const packet = buildPacket(plannedChunk.messages, options.recent ?? []);
	// Replay the ROW's recorded model — on a reclaim this is the model the
	// interrupted attempt was claimed with, never the constant-of-the-day.
	// Reservation identity is explicit rather than inherited from the parent
	// extraction meter's mutable call ordinal.
	const reservationId = atomicCaptureProviderOperationId(claim.row.id, claim.row.attempts);
	// The parent extraction may be replaying under a newer policy pin. Execute
	// this child operation under its OWN durable half-pin so ambient policy can
	// never switch a claimed run's provider or model. Pre-pin rows used NULL to
	// mean the legacy Workers-AI provider.
	const runProvider = typeof claim.row.provider === "string" && claim.row.provider.trim()
		? claim.row.provider.trim()
		: "workers-ai";
	const runModel = typeof claim.row.model === "string" && claim.row.model.trim()
		? claim.row.model.trim()
		: null;
	const runPin = buildPin({
		routes: { extract_atomic: { provider: runProvider, model: runModel } },
	});
	const proposed = await withFlushedAiMeter(env, "atomic_capture", {
		userId: options.userId,
		scopeId: claim.row.id,
		lifecycle: {
			memoryUserId: options.userId,
			accountUserId: options.accountUserId ?? null,
			managedProjectId: options.managedProjectId ?? null,
			acceptedAt: options.acceptedAt,
		},
	}, () => withAiPin(runPin, () => proposeAtomic(
		env,
		packet,
		options.rules,
		options.override,
		{
			packet,
			chunk: plannedChunk.messages,
			chunkKey: plannedChunk.key,
			chunkIndex: plannedChunk.index,
		},
		runModel ?? ATOMIC_CAPTURE_MODEL,
		reservationId,
	)));
	if (!proposed.ok) {
		return failRun(env, options.userId, claim.row.id, proposed.outcome,
			{ truncated: proposed.truncated }, claim.row.attempts);
	}
	const normalized = await normalizeAtomicCapture(proposed.parsed, {
		messages: plannedChunk.messages,
		userId: options.userId,
		projectId: options.projectId,
		sourcePacketId: options.sourcePacketId,
		chunkKey: plannedChunk.key,
		rules: options.rules,
	});
	if (!normalized.ok) {
		return failRun(env, options.userId, claim.row.id, "schema_invalid", {
			...normalized.outcomes,
			truncated: normalized.truncated || proposed.truncated,
		}, claim.row.attempts);
	}
	return persistChunk(env, {
		...options,
		runId: claim.row.id,
		runAttempt: claim.row.attempts,
		chunkKey: plannedChunk.key,
		atoms: normalized.atoms,
		outcomes: normalized.outcomes,
		truncated: normalized.truncated || proposed.truncated,
	});
}

/** Execute the nested E4 lane. All sub-chunks are bounded and sequential. */
export async function captureAtomicCandidates(env, options = {}) {
	const startedAt = Date.now();
	const userId = typeof options.userId === "string" ? options.userId : "";
	const sourcePacketId = typeof options.sourcePacketId === "string" ? options.sourcePacketId : "";
	const acceptedAt = Number(options.acceptedAt);
	if (!userId || !sourcePacketId || !Number.isFinite(acceptedAt) || acceptedAt <= 0) {
		return {
			enabled: true,
			outcome: "invalid_provenance",
			complete: false,
			chunks: 0,
			proposed: 0,
			accepted: 0,
			stored: 0,
			rejected: 0,
			duplicates: 0,
			truncated: 0,
			temporalPresent: 0,
			temporalResolved: 0,
			temporalUnresolved: 0,
			temporalAnchorMissing: 0,
			replayed: false,
			latencyMs: Date.now() - startedAt,
		};
	}
	const project = normalizeProjectScope({ projectId: options.projectId, projectName: options.projectName });
	const managedProjectId = options.managedProjectId
		?? await retentionProjectForMemoryOwner(env, options.memoryOwnerUserId);
	const chunks = await planExtractionChunks(options.messages ?? [], {
		...(options.chunkConfig ?? {}),
		sourcePacketId,
		sourceTime: options.sourceTime ?? null,
	});
	const coverage = verifyChunkCoverage(options.messages ?? [], chunks);
	if (!coverage.ok) {
		return {
			enabled: true,
			outcome: "coverage_invalid",
			complete: false,
			chunks: chunks.length,
			proposed: 0,
			accepted: 0,
			stored: 0,
			rejected: 0,
			duplicates: 0,
			truncated: 0,
			temporalPresent: 0,
			temporalResolved: 0,
			temporalUnresolved: 0,
			temporalAnchorMissing: 0,
			replayed: false,
			latencyMs: Date.now() - startedAt,
		};
	}

	const results = [];
	for (const chunk of chunks) {
		results.push(await captureChunk(env, {
			...options,
			managedProjectId,
			userId,
			sourcePacketId,
			acceptedAt,
			projectId: project.projectId,
			projectName: project.projectName,
		}, chunk));
	}
	const failures = results.filter((result) => !result.complete);
	let outcome = "completed";
	if (failures.some((result) => result.outcome === "cancelled_by_delete")) outcome = "cancelled_by_delete";
	else if (failures.some((result) => result.outcome === "in_progress")) outcome = "in_progress";
	else if (failures.length === 1 && results.length === 1) outcome = failures[0].outcome;
	else if (failures.length) outcome = "partial_failed";
	return {
		enabled: true,
		outcome,
		complete: failures.length === 0,
		chunks: results.length,
		proposed: results.reduce((sum, result) => sum + result.proposed, 0),
		accepted: results.reduce((sum, result) => sum + result.accepted, 0),
		stored: results.reduce((sum, result) => sum + result.stored, 0),
		rejected: results.reduce((sum, result) => sum + result.rejected, 0),
		duplicates: results.reduce((sum, result) => sum + result.duplicates, 0),
		truncated: results.filter((result) => result.truncated).length,
		temporalPresent: results.reduce((sum, result) => sum + integer(result.temporalPresent), 0),
		temporalResolved: results.reduce((sum, result) => sum + integer(result.temporalResolved), 0),
		temporalUnresolved: results.reduce((sum, result) => sum + integer(result.temporalUnresolved), 0),
		temporalAnchorMissing: results.reduce((sum, result) => sum + integer(result.temporalAnchorMissing), 0),
		replayed: results.some((result) => result.replayed),
		// Internal hand-off for E6. These opaque ids never enter a public receipt;
		// they scope the projection load to exactly the capture chunks that just
		// completed (including a deterministic terminal replay).
		captureRunIds: results.map((result) => result.captureRunId).filter(Boolean),
		latencyMs: Date.now() - startedAt,
	};
}

export async function countSemanticAtomCandidates(env, userId, { projectId = null } = {}) {
	if (!userId) return 0;
	const row = projectId == null
		? await env.DB.prepare("SELECT COUNT(*) AS n FROM semantic_atom_candidates WHERE user_id = ?").bind(userId).first()
		: await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_candidates WHERE user_id = ? AND project_id = ?",
		).bind(userId, projectId).first();
	return integer(row?.n);
}

/** Privacy-safe aggregate used when a durable extraction result is replayed. */
export async function atomicCaptureSummaryForExtractionRun(env, userId, extractionRunId) {
	if (!userId || !extractionRunId) return null;
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS chunks,
			SUM(proposed_count) AS proposed,
			SUM(accepted_count) AS accepted,
			SUM(stored_count) AS stored,
			SUM(rejected_count) AS rejected,
			SUM(duplicate_count) AS duplicates,
			SUM(truncated) AS truncated,
			SUM(temporal_phrase_count) AS temporal_present,
			SUM(temporal_resolved_count) AS temporal_resolved,
			SUM(temporal_unresolved_count) AS temporal_unresolved,
			SUM(temporal_anchor_missing_count) AS temporal_anchor_missing,
			SUM(replay_count) AS replay_count,
			SUM(CASE WHEN status IN ('completed', 'empty') THEN 0 ELSE 1 END) AS incomplete,
			SUM(CASE WHEN status = 'cancelled_by_delete' THEN 1 ELSE 0 END) AS cancelled,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
		 FROM semantic_atom_capture_runs
		 WHERE user_id = ? AND extraction_run_id = ?`,
	).bind(userId, extractionRunId).first();
	if (integer(row?.chunks) === 0) return null;
	const incomplete = integer(row?.incomplete);
	return {
		enabled: true,
		outcome: integer(row?.cancelled) > 0
			? "cancelled_by_delete"
			: integer(row?.failed) > 0 ? "partial_failed" : incomplete > 0 ? "in_progress" : "completed",
		complete: incomplete === 0,
		chunks: integer(row?.chunks),
		proposed: integer(row?.proposed),
		accepted: integer(row?.accepted),
		stored: integer(row?.stored),
		rejected: integer(row?.rejected),
		duplicates: integer(row?.duplicates),
		truncated: integer(row?.truncated),
		temporalPresent: integer(row?.temporal_present),
		temporalResolved: integer(row?.temporal_resolved),
		temporalUnresolved: integer(row?.temporal_unresolved),
		temporalAnchorMissing: integer(row?.temporal_anchor_missing),
		replayed: integer(row?.replay_count) > 0,
		latencyMs: null,
	};
}
