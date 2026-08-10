/**
 * E4 atomic capture execution and persistence.
 *
 * The model proposes; code verifies an exact span in an already-scrubbed source
 * message; D1 then requires the corresponding permitted source episode to
 * exist in the same scope before it can persist a candidate. This lane is
 * append-only and deliberately absent from recall until E6/E7 ablations earn
 * read-path participation.
 */

import { runAi } from "../lib/ai_meter.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
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
		replayed,
	};
}

async function failRun(env, userId, runId, errorCode, counts = {}) {
	const now = Date.now();
	const code = safeErrorCode(errorCode);
	await env.DB.prepare(
		`UPDATE semantic_atom_capture_runs
		 SET status = 'failed', error_code = ?, proposed_count = ?, accepted_count = ?,
			stored_count = ?, rejected_count = ?, duplicate_count = ?, truncated = ?,
			rejected_reasons_json = ?, updated_at = ?, completed_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'running'`,
	).bind(
		code,
		integer(counts.proposed),
		integer(counts.accepted),
		integer(counts.stored),
		integer(counts.rejected),
		integer(counts.duplicates),
		counts.truncated ? 1 : 0,
		counts.rejectedByReason ? JSON.stringify(counts.rejectedByReason) : null,
		now,
		now,
		runId,
		userId,
	).run();
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
		replayed: false,
	};
}

async function claimRun(env, {
	userId,
	projectId,
	projectName,
	sourcePacketId,
	extractionRunId,
	chunkKey,
	acceptedAt,
}) {
	const id = await captureRunId(userId, sourcePacketId, chunkKey);
	const now = Date.now();
	const inserted = await env.DB.prepare(
		`INSERT INTO semantic_atom_capture_runs
		 (id, user_id, project_id, project_name, source_packet_id, extraction_run_id,
		  chunk_key, status, model, schema_version, accepted_at, attempts, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, 1, ?, ?)
		 ON CONFLICT(user_id, source_packet_id, chunk_key) DO NOTHING`,
	).bind(
		id,
		userId,
		projectId,
		projectName,
		sourcePacketId,
		extractionRunId,
		chunkKey,
		ATOMIC_CAPTURE_MODEL,
		ATOMIC_CAPTURE_SCHEMA,
		acceptedAt,
		now,
		now,
	).run();
	let row = await env.DB.prepare(
		`SELECT * FROM semantic_atom_capture_runs
		 WHERE user_id = ? AND source_packet_id = ? AND chunk_key = ? LIMIT 1`,
	).bind(userId, sourcePacketId, chunkKey).first();
	if (Number(inserted.meta?.changes ?? 0) === 1) return { claimed: true, row };
	if (!row) throw new Error("atomic capture run claim disappeared");
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
	if (row.status !== "running") {
		await env.DB.prepare(
			"UPDATE semantic_atom_capture_runs SET replay_count = replay_count + 1, updated_at = ? WHERE id = ? AND user_id = ?",
		).bind(now, row.id, userId).run();
	}
	return { claimed: false, row };
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

async function proposeAtomic(env, packet, rules, override, context) {
	let response;
	let truncated = false;
	try {
		if (override !== undefined && override !== null) {
			response = typeof override === "function" ? await override(context) : override;
		} else {
			if (!env.AI) return { ok: false, outcome: "no_ai_binding", parsed: null, truncated: false };
			response = await runAi(env, ATOMIC_CAPTURE_MODEL, {
				messages: buildAtomicCaptureMessages(packet, { rules }),
				temperature: 0,
				max_tokens: ATOMIC_CAPTURE_MAX_TOKENS,
				// Llama 4 Scout's current first-party model contract exposes
				// guided_json. Local validation remains mandatory because provider
				// schema guidance is not a trust boundary.
				guided_json: ATOMIC_CAPTURE_JSON_SCHEMA,
			}, undefined, { task: "extract_atomic" });
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
			model: ATOMIC_CAPTURE_MODEL,
			error_name: String(error?.name ?? "Error").slice(0, 80),
			error_code: error?.code == null ? null : String(error.code).slice(0, 80),
		}));
		return { ok: false, outcome, parsed: null, truncated: false };
	}
}

async function persistChunk(env, {
	userId,
	projectId,
	sourcePacketId,
	extractionRunId,
	acceptedAt,
	runId,
	chunkKey,
	atoms,
	outcomes,
	truncated,
}) {
	const now = Date.now();
	const statements = [];
	const candidateInsertIndexes = [];
	statements.push(env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE EXISTS (
			SELECT 1 FROM deletion_barriers WHERE user_id = ? AND barrier_at > ?
		 )`,
	).bind(userId, acceptedAt));

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
			  extraction_model, schema_version, status, created_at)
			 SELECT ?, e.user_id, e.memory_user_id, e.owner_user_id, e.external_user_id,
				e.project_id, e.project_name, ?, ?, e.id, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, e.source_time, e.source_time_offset_minutes,
				e.source_time_precision, e.observed_at, ?, ?, 'candidate', ?
			 FROM source_episodes e
			 WHERE e.user_id = ? AND e.source_packet_id = ? AND e.message_id = ? AND e.project_id IS ?
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
			ATOMIC_CAPTURE_MODEL,
			ATOMIC_CAPTURE_SCHEMA,
			now,
			userId,
			sourcePacketId,
			atom.sourceMessageId,
			projectId,
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
			truncated = ?, rejected_reasons_json = ?,
			error_code = NULL, updated_at = ?, completed_at = ?
		 WHERE id = ? AND user_id = ? AND status = 'running'`,
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
		JSON.stringify(outcomes.rejectedByReason ?? {}),
		now,
		now,
		runId,
		userId,
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
			replayed: false,
		};
	} catch (error) {
		const message = String(error?.message ?? error);
		if (/fence_guard/i.test(message)) {
			const barrier = await env.DB.prepare(
				"SELECT barrier_at FROM deletion_barriers WHERE user_id = ? AND barrier_at > ? LIMIT 1",
			).bind(userId, acceptedAt).first();
			const code = barrier ? "cancelled_by_delete" : "source_episode_unavailable";
			const terminalStatus = barrier ? "cancelled_by_delete" : "failed";
			await env.DB.prepare(
				`UPDATE semantic_atom_capture_runs
				 SET status = ?, error_code = ?, proposed_count = ?, accepted_count = ?,
					stored_count = 0, rejected_count = ?, duplicate_count = ?, truncated = ?,
					rejected_reasons_json = ?, updated_at = ?, completed_at = ?
				 WHERE id = ? AND user_id = ? AND status = 'running'`,
			).bind(
				terminalStatus,
				code,
				integer(outcomes.proposed),
				atoms.length,
				integer(outcomes.rejected),
				integer(outcomes.duplicate),
				truncated ? 1 : 0,
				JSON.stringify(outcomes.rejectedByReason ?? {}),
				now,
				now,
				runId,
				userId,
			).run();
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
			rejectedByReason: outcomes.rejectedByReason,
		});
	}
}

async function captureChunk(env, options, plannedChunk) {
	const claim = await claimRun(env, {
		...options,
		chunkKey: plannedChunk.key,
	});
	if (!claim.claimed) {
		if (claim.row.status === "running") {
			return {
				captureRunId: claim.row.id,
				outcome: "in_progress",
				complete: false,
				proposed: 0,
				accepted: 0,
				stored: 0,
				rejected: 0,
				duplicates: 0,
				truncated: false,
				replayed: true,
			};
		}
		return terminalRunResult(claim.row, { replayed: true });
	}

	const packet = buildPacket(plannedChunk.messages, options.recent ?? []);
	const proposed = await proposeAtomic(
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
	);
	if (!proposed.ok) {
		return failRun(env, options.userId, claim.row.id, proposed.outcome, { truncated: proposed.truncated });
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
		});
	}
	return persistChunk(env, {
		...options,
		runId: claim.row.id,
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
			replayed: false,
			latencyMs: Date.now() - startedAt,
		};
	}
	const project = normalizeProjectScope({ projectId: options.projectId, projectName: options.projectName });
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
			replayed: false,
			latencyMs: Date.now() - startedAt,
		};
	}

	const results = [];
	for (const chunk of chunks) {
		results.push(await captureChunk(env, {
			...options,
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
		replayed: results.some((result) => result.replayed),
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
		replayed: integer(row?.replay_count) > 0,
		latencyMs: null,
	};
}
