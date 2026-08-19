import {
	auditErrorOutcome,
	auditInvariantStatement,
	auditedMutationResult,
	beginAuditIntent,
	commitAuditedBatch,
	finalizeAuditIntent,
	runAuditedMutation,
	systemRequestId,
} from "./audit.js";
import { newId } from "./ids.js";
import { fallbackSummary, refreshMemoryProfile } from "../pipeline/pass2.js";
import { manualPageVectorNamespace } from "../pipeline/manual_search_profiles.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const DEFAULT_PREVIEW_LIMIT = 5000;
const MAX_PREVIEW_LIMIT = 10_000;
const DEFAULT_BATCH_SIZE = 40;
const MAX_BATCH_SIZE = 50;
export const MAX_RETENTION_MEMORY_SPACES = 512;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const RUN_LEASE_MS = 5 * 60 * 1000;
const ERASED_SOURCE_CONTENT_HASH = "itsuki-erased-source/v1";

export const RETENTION_CONFIRMATION = "APPLY RETENTION";
export const RETENTION_CLASSES = Object.freeze([
	"playground_transcripts",
	"source_episodes",
	"semantic_memory",
	"export_blobs",
	"webhook_deliveries",
	"operational_records",
	"security_audit",
]);

const RETENTION_CLASS_SET = new Set(RETENTION_CLASSES);

export class RetentionError extends Error {
	constructor(code, message, status = 400, current = null) {
		super(message);
		this.name = "RetentionError";
		this.code = code;
		this.status = status;
		this.current = current;
	}
}

const MEMORY_SCOPE_SQL = "SELECT value FROM json_each(?)";

function scopeBinds(scope) {
	if (!Array.isArray(scope.memorySpaces) || !scope.memorySpaces.length) {
		throw new RetentionError("retention_scope_incomplete", "The project's memory-space inventory is unavailable.", 409);
	}
	return [JSON.stringify(scope.memorySpaces)];
}

function userScope(alias = "t") {
	return `${alias}.user_id IN (${MEMORY_SCOPE_SQL})`;
}

function cleanScope(input = {}) {
	const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
	const memoryOwnerUserId = typeof input.memoryOwnerUserId === "string" ? input.memoryOwnerUserId.trim() : "";
	if (!projectId || !memoryOwnerUserId) {
		throw new RetentionError("invalid_retention_scope", "A managed project scope is required.");
	}
	return { projectId, memoryOwnerUserId };
}

function cleanClass(value) {
	const retentionClass = typeof value === "string" ? value.trim() : "";
	if (!RETENTION_CLASS_SET.has(retentionClass)) {
		throw new RetentionError("invalid_retention_class", "Choose one supported retention class.");
	}
	return retentionClass;
}

function cleanDays(value) {
	if (value === null) return null;
	if (!Number.isInteger(value) || value < MIN_DAYS || value > MAX_DAYS) {
		throw new RetentionError(
			"invalid_retention_days",
			`Retention days must be null or an integer from ${MIN_DAYS} to ${MAX_DAYS}.`,
		);
	}
	return value;
}

function cleanExpectedVersion(value) {
	if (!Number.isInteger(value) || value < 0) {
		throw new RetentionError(
			"retention_precondition_required",
			"Reload retention settings before saving so a newer change is not overwritten.",
			428,
		);
	}
	return value;
}

function cleanNow(value) {
	const now = value === undefined ? Date.now() : Number(value);
	if (!Number.isFinite(now) || now <= 0) throw new RetentionError("invalid_time", "A valid retention time is required.");
	return Math.trunc(now);
}

function cleanLimit(value, fallback, max) {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
		throw new RetentionError("invalid_retention_limit", `The retention limit must be from 1 to ${max}.`);
	}
	return parsed;
}

function safeJson(value, fallback = {}) {
	try {
		const parsed = JSON.parse(value ?? "");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireProject(env, scope) {
	const project = await env.DB.prepare(
		`SELECT id, organization_id, memory_owner_user_id, status
		   FROM managed_projects
		  WHERE id = ? AND memory_owner_user_id = ? AND status IN ('active', 'archived')
		  LIMIT 1`,
	).bind(scope.projectId, scope.memoryOwnerUserId).first();
	if (!project) {
		throw new RetentionError("project_not_found", "That project does not exist.", 404);
	}
	return project;
}

function cleanMemorySpaceId(value) {
	if (typeof value !== "string") return null;
	const id = value.trim();
	if (!id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) return null;
	return id;
}

function scopeIncomplete(message = "Historical memory spaces could not be attributed to exactly one managed project.") {
	return new RetentionError("retention_scope_incomplete", message, 409);
}

/**
 * Migration 0040 intentionally starts the registry empty. Reconstruct its
 * finite set only from server-authored provenance: the immutable project root,
 * explicit managed-project ids, and historical owner ids. Source-level
 * `project_id` is never considered because it is caller attribution, not a
 * managed-project boundary.
 *
 * This function is read-only. Preview uses the returned ids directly through
 * json_each(); activation/execution persist exactly the same set in one guarded
 * statement so an empty rollout registry can never produce an under-delete.
 */
export async function discoverProjectMemorySpaces(env, input = {}) {
	const scope = cleanScope(input);
	await requireProject(env, scope);
	const statements = [
		env.DB.prepare(
			`SELECT DISTINCT pms.memory_user_id, pms.memory_owner_user_id, pms.project_id,
			        NULL AS explicit_project_id, NULL AS explicit_owner_id, 'registry' AS source
			   FROM project_memory_spaces pms
			  WHERE pms.project_id = ? OR pms.memory_owner_user_id = ?
			  LIMIT ?`,
		).bind(scope.projectId, scope.memoryOwnerUserId, MAX_RETENTION_MEMORY_SPACES + 1),
		env.DB.prepare(
			`SELECT DISTINCT COALESCE(sp.memory_user_id, sp.user_id) AS memory_user_id,
			        NULL AS memory_owner_user_id, NULL AS project_id,
			        COALESCE(
			          sp.managed_project_id,
			          CASE WHEN json_valid(sp.raw_meta_json)
			               THEN json_extract(sp.raw_meta_json, '$.managed_project_id') END
			        ) AS explicit_project_id,
			        sp.owner_user_id AS explicit_owner_id,
			        'source_packet' AS source
			   FROM source_packets sp
			  WHERE sp.owner_user_id = ? OR sp.managed_project_id = ?
			     OR (json_valid(sp.raw_meta_json)
			         AND json_extract(sp.raw_meta_json, '$.managed_project_id') = ?)
			  LIMIT ?`,
		).bind(scope.memoryOwnerUserId, scope.projectId, scope.projectId, MAX_RETENTION_MEMORY_SPACES + 1),
		env.DB.prepare(
			`SELECT DISTINCT COALESCE(e.memory_user_id, e.user_id) AS memory_user_id,
			        NULL AS memory_owner_user_id, NULL AS project_id,
			        NULL AS explicit_project_id, e.owner_user_id AS explicit_owner_id,
			        'source_episode' AS source
			   FROM source_episodes e WHERE e.owner_user_id = ? LIMIT ?`,
		).bind(scope.memoryOwnerUserId, MAX_RETENTION_MEMORY_SPACES + 1),
		env.DB.prepare(
			`SELECT DISTINCT COALESCE(c.memory_user_id, c.user_id) AS memory_user_id,
			        NULL AS memory_owner_user_id, NULL AS project_id,
			        NULL AS explicit_project_id, c.owner_user_id AS explicit_owner_id,
			        'semantic_atom_candidate' AS source
			   FROM semantic_atom_candidates c WHERE c.owner_user_id = ? LIMIT ?`,
		).bind(scope.memoryOwnerUserId, MAX_RETENTION_MEMORY_SPACES + 1),
		env.DB.prepare(
			`SELECT DISTINCT r.user_id AS memory_user_id,
			        NULL AS memory_owner_user_id, NULL AS project_id,
			        COALESCE(
			          CASE WHEN json_valid(r.scope_json)
			               THEN json_extract(r.scope_json, '$.managed_project_id') END,
			          sp.managed_project_id,
			          CASE WHEN json_valid(sp.raw_meta_json)
			               THEN json_extract(sp.raw_meta_json, '$.managed_project_id') END
			        ) AS explicit_project_id,
			        COALESCE(
			          CASE WHEN json_valid(r.scope_json)
			               THEN json_extract(r.scope_json, '$.owner_user_id') END,
			          sp.owner_user_id
			        ) AS explicit_owner_id,
			        'extraction_run' AS source
			   FROM extraction_runs r
			   LEFT JOIN source_packets sp
			     ON sp.id = r.source_packet_id AND sp.user_id = r.user_id
			  WHERE (json_valid(r.scope_json) AND (
			           json_extract(r.scope_json, '$.managed_project_id') = ?
			           OR json_extract(r.scope_json, '$.owner_user_id') = ?
			        ))
			     OR sp.owner_user_id = ? OR sp.managed_project_id = ?
			     OR (json_valid(sp.raw_meta_json)
			         AND json_extract(sp.raw_meta_json, '$.managed_project_id') = ?)
			  LIMIT ?`,
		).bind(
			scope.projectId,
			scope.memoryOwnerUserId,
			scope.memoryOwnerUserId,
			scope.projectId,
			scope.projectId,
			MAX_RETENTION_MEMORY_SPACES + 1,
		),
		env.DB.prepare(
			`SELECT DISTINCT r.user_id AS memory_user_id,
			        NULL AS memory_owner_user_id, NULL AS project_id,
			        COALESCE(
			          CASE WHEN json_valid(r.scope_json)
			               THEN json_extract(r.scope_json, '$.managed_project_id') END,
			          sp.managed_project_id,
			          CASE WHEN json_valid(sp.raw_meta_json)
			               THEN json_extract(sp.raw_meta_json, '$.managed_project_id') END
			        ) AS explicit_project_id,
			        COALESCE(
			          CASE WHEN json_valid(r.scope_json)
			               THEN json_extract(r.scope_json, '$.owner_user_id') END,
			          sp.owner_user_id
			        ) AS explicit_owner_id,
			        'receipt' AS source
			   FROM receipts r
			   LEFT JOIN source_packets sp
			     ON sp.id = r.source_packet_id AND sp.user_id = r.user_id
			  WHERE (json_valid(r.scope_json) AND (
			           json_extract(r.scope_json, '$.managed_project_id') = ?
			           OR json_extract(r.scope_json, '$.owner_user_id') = ?
			        ))
			     OR sp.owner_user_id = ? OR sp.managed_project_id = ?
			     OR (json_valid(sp.raw_meta_json)
			         AND json_extract(sp.raw_meta_json, '$.managed_project_id') = ?)
			  LIMIT ?`,
		).bind(
			scope.projectId,
			scope.memoryOwnerUserId,
			scope.memoryOwnerUserId,
			scope.projectId,
			scope.projectId,
			MAX_RETENTION_MEMORY_SPACES + 1,
		),
	];
	const results = await env.DB.batch(statements);
	const memorySpaces = new Set([scope.memoryOwnerUserId]);
	for (const result of results) {
		for (const row of result.results ?? []) {
			const memoryUserId = cleanMemorySpaceId(row.memory_user_id);
			if (!memoryUserId) throw scopeIncomplete("A historical provenance row has no valid memory-space id.");
			if (row.source === "registry") {
				if (row.project_id !== scope.projectId || row.memory_owner_user_id !== scope.memoryOwnerUserId) {
					throw scopeIncomplete("A memory space is registered to conflicting project ownership.");
				}
			} else {
				const explicitProject = cleanMemorySpaceId(row.explicit_project_id);
				const explicitOwner = cleanMemorySpaceId(row.explicit_owner_id);
				if (explicitProject && explicitProject !== scope.projectId) {
					throw scopeIncomplete("Historical provenance names a different managed project.");
				}
				if (explicitOwner && explicitOwner !== scope.memoryOwnerUserId) {
					throw scopeIncomplete("Historical provenance names a different immutable memory owner.");
				}
				if (!explicitProject && !explicitOwner) {
					throw scopeIncomplete();
				}
			}
			memorySpaces.add(memoryUserId);
			if (memorySpaces.size > MAX_RETENTION_MEMORY_SPACES) {
				throw new RetentionError(
					"retention_scope_too_large",
					`This project has more than ${MAX_RETENTION_MEMORY_SPACES} memory spaces. Contact support before changing retention.`,
					409,
				);
			}
		}
	}

	const ordered = [...memorySpaces].sort();
	const conflicts = await env.DB.prepare(
		`SELECT 1 AS conflict
		   FROM project_memory_spaces pms
		  WHERE pms.memory_user_id IN (SELECT value FROM json_each(?))
		    AND (pms.project_id != ? OR pms.memory_owner_user_id != ?)
		  LIMIT 1`,
	).bind(JSON.stringify(ordered), scope.projectId, scope.memoryOwnerUserId).first();
	if (conflicts) throw scopeIncomplete("A memory-space id is already registered to another project.");
	return { ...scope, memorySpaces: ordered };
}

function memorySpaceRegistrationStatements(env, scope, now) {
	const encoded = JSON.stringify(scope.memorySpaces);
	return [
		env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1
			  WHERE EXISTS (
			    SELECT 1 FROM project_memory_spaces
			     WHERE memory_user_id IN (SELECT value FROM json_each(?))
			       AND (project_id != ? OR memory_owner_user_id != ?)
			  )`,
		).bind(encoded, scope.projectId, scope.memoryOwnerUserId),
		env.DB.prepare(
			`INSERT INTO project_memory_spaces
			 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 SELECT ?, ?, value, 'active', ?, ? FROM json_each(?) WHERE 1 = 1
			 ON CONFLICT(project_id, memory_user_id) DO UPDATE SET
			   last_seen_at = MAX(project_memory_spaces.last_seen_at, excluded.last_seen_at)`,
		).bind(scope.projectId, scope.memoryOwnerUserId, now, now, encoded),
	];
}

function memorySpaceInventoryGuardStatement(env, scope) {
	const expected = JSON.stringify(scope.memorySpaces);
	return env.DB.prepare(
		`WITH expected(memory_user_id) AS (
		   SELECT CAST(value AS TEXT) FROM json_each(?)
		 )
		 INSERT INTO fence_guard (violation)
		 SELECT 1
		  WHERE EXISTS (
		    SELECT 1 FROM project_memory_spaces pms
		     WHERE (pms.project_id = ? OR pms.memory_owner_user_id = ?)
		       AND (
		         pms.project_id != ? OR pms.memory_owner_user_id != ?
		         OR NOT EXISTS (
		           SELECT 1 FROM expected WHERE expected.memory_user_id = pms.memory_user_id
		         )
		       )
		  )`,
	).bind(
		expected,
		scope.projectId,
		scope.memoryOwnerUserId,
		scope.projectId,
		scope.memoryOwnerUserId,
	);
}

function publicPolicy(row, retentionClass) {
	return {
		class: retentionClass,
		days: row?.days === null || row?.days === undefined ? null : Number(row.days),
		version: Number(row?.version ?? 0),
		effective_at: row?.effective_at ?? null,
		updated_at: row?.updated_at ?? null,
		locked: retentionClass === "security_audit",
	};
}

async function policyRow(env, scope, retentionClass) {
	return env.DB.prepare(
		`SELECT project_id, memory_owner_user_id, class, days, version, effective_at,
		        updated_by_user_id, created_at, updated_at
		   FROM retention_policies
		  WHERE project_id = ? AND memory_owner_user_id = ? AND class = ?
		  LIMIT 1`,
	).bind(scope.projectId, scope.memoryOwnerUserId, retentionClass).first();
}

function ensureExpectedVersion(row, retentionClass, expectedVersion) {
	const current = publicPolicy(row, retentionClass);
	if (current.version !== expectedVersion) {
		throw new RetentionError(
			"retention_conflict",
			"Retention changed in another session. Reload the current policy before saving.",
			412,
			current,
		);
	}
	return current;
}

function ordinaryTarget(key, table, {
	idColumn = "id",
	ageColumn = "created_at",
	where = "1 = 1",
	action = "delete",
	vectorKind = null,
} = {}) {
	return {
		key,
		table,
		idColumn,
		action,
		vectorKind,
		selectSql: (limit) => ({
			sql: `SELECT t.${idColumn} AS id, t.user_id AS memory_user_id
			        FROM ${table} t
			       WHERE ${userScope("t")} AND t.${ageColumn} IS NOT NULL
			         AND t.${ageColumn} <= ? AND (${where})
			       ORDER BY t.${ageColumn} ASC, t.${idColumn} ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, limit],
		}),
	};
}

function customTarget(key, table, idColumn, selectSql, options = {}) {
	return { key, table, idColumn, selectSql, action: options.action ?? "delete", vectorKind: options.vectorKind ?? null };
}

const TARGETS = Object.freeze({
	playground_transcripts: [
		ordinaryTarget("playground_messages", "playground_messages"),
		customTarget("playground_threads", "playground_threads", "id", (limit) => ({
			sql: `SELECT t.id AS id, t.user_id AS memory_user_id
			        FROM playground_threads t
			       WHERE ${userScope("t")} AND t.created_at IS NOT NULL AND t.created_at <= ?
			         AND NOT EXISTS (
			           SELECT 1 FROM playground_messages m
			            WHERE m.thread_id = t.id AND m.user_id = t.user_id AND m.created_at > ?
			         )
			       ORDER BY t.created_at ASC, t.id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, cutoffAt, limit],
		})),
	],
	source_episodes: [
		customTarget("semantic_atom_projections", "semantic_atom_projections", "candidate_id", (limit) => ({
			sql: `SELECT p.candidate_id AS id, p.user_id AS memory_user_id
			        FROM semantic_atom_projections p
			        JOIN source_episodes e
			          ON e.id = p.source_episode_id AND e.user_id = p.user_id
			       WHERE ${userScope("p")} AND e.created_at <= ?
			       ORDER BY e.created_at ASC, p.candidate_id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, limit],
		})),
		customTarget("semantic_atom_candidates", "semantic_atom_candidates", "id", (limit) => ({
			sql: `SELECT c.id AS id, c.user_id AS memory_user_id
			        FROM semantic_atom_candidates c
			        JOIN source_episodes e
			          ON e.id = c.source_episode_id AND e.user_id = c.user_id
			       WHERE ${userScope("c")} AND e.created_at <= ?
			       ORDER BY e.created_at ASC, c.id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, limit],
		})),
		customTarget("semantic_atom_capture_runs", "semantic_atom_capture_runs", "id", (limit) => ({
			sql: `SELECT r.id AS id, r.user_id AS memory_user_id
			        FROM semantic_atom_capture_runs r
			       WHERE ${userScope("r")} AND NOT EXISTS (
			         SELECT 1 FROM semantic_atom_candidates c
			          WHERE c.capture_run_id = r.id AND c.user_id = r.user_id
			       ) AND r.created_at <= ?
			       ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, limit],
		})),
		ordinaryTarget("source_episodes", "source_episodes"),
	],
	semantic_memory: [
		// Provenance links go first, while the objects they name are still here:
		// once a slice/event/node row is gone its link is unreachable from every
		// read path, so sweeping it afterwards would need a separate orphan scan.
		ordinaryTarget("memory_source_links", "memory_source_links", { idColumn: "object_id" }),
		ordinaryTarget("semantic_atom_projections", "semantic_atom_projections", { idColumn: "candidate_id" }),
		ordinaryTarget("semantic_atom_candidates", "semantic_atom_candidates"),
		customTarget("semantic_atom_capture_runs", "semantic_atom_capture_runs", "id", (limit) => ({
			sql: `SELECT r.id AS id, r.user_id AS memory_user_id
			        FROM semantic_atom_capture_runs r
			       WHERE ${userScope("r")} AND r.created_at IS NOT NULL AND r.created_at <= ?
			         AND NOT EXISTS (
			           SELECT 1 FROM semantic_atom_candidates c
			            WHERE c.capture_run_id = r.id AND c.user_id = r.user_id
			         )
			       ORDER BY r.created_at ASC, r.id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [...scopeBinds(scope), cutoffAt, limit],
		})),
		ordinaryTarget("slices", "slices"),
		ordinaryTarget("events", "events"),
		ordinaryTarget("edges", "edges"),
		ordinaryTarget("candidates", "candidates"),
		ordinaryTarget("memory_pages", "memory_pages", { vectorKind: "page" }),
		customTarget("nodes", "nodes", "id", (limit) => ({
			sql: `SELECT t.id AS id, t.user_id AS memory_user_id
			        FROM nodes t
			       WHERE ${userScope("t")} AND t.created_at IS NOT NULL AND t.created_at <= ?
			         AND NOT EXISTS (SELECT 1 FROM slices s WHERE s.user_id = t.user_id AND s.node_id = t.id AND s.created_at > ?)
			         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.user_id = t.user_id AND e.node_id = t.id AND e.created_at > ?)
			         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.user_id = t.user_id AND (e.from_node = t.id OR e.to_node = t.id) AND e.created_at > ?)
			         AND NOT EXISTS (SELECT 1 FROM memory_pages p WHERE p.user_id = t.user_id AND p.node_id = t.id AND p.created_at > ?)
			       ORDER BY t.created_at ASC, t.id ASC LIMIT ?`,
			binds: (scope, cutoffAt) => [
				...scopeBinds(scope), cutoffAt, cutoffAt, cutoffAt, cutoffAt, cutoffAt, limit,
			],
		}), { vectorKind: "node" }),
	],
	export_blobs: [
		ordinaryTarget("memory_exports", "memory_exports", {
			where: "t.status = 'complete' AND t.data IS NOT NULL",
			action: "scrub_export",
		}),
	],
	webhook_deliveries: [ordinaryTarget("webhook_deliveries", "webhook_deliveries")],
	operational_records: [
		ordinaryTarget("memory_jobs", "memory_jobs", {
			where: "t.status IN ('enriched', 'failed', 'completed') AND (COALESCE(t.payload_json, '{}') != '{}' OR t.error IS NOT NULL)",
			action: "scrub_job",
		}),
		ordinaryTarget("extraction_runs", "extraction_runs", {
			where: `(t.status IS NULL OR t.status NOT IN ('running', 'committing')) AND (
			  t.topic_filter IS NOT NULL OR t.error IS NOT NULL OR COALESCE(t.scope_json, '{}') != '{}'
			  OR COALESCE(t.created_pages_json, '[]') != '[]' OR COALESCE(t.created_nodes_json, '[]') != '[]'
			  OR COALESCE(t.created_slices_json, '[]') != '[]' OR COALESCE(t.created_events_json, '[]') != '[]'
			  OR COALESCE(t.created_edges_json, '[]') != '[]' OR COALESCE(t.created_candidates_json, '[]') != '[]'
			  OR COALESCE(t.updated_objects_json, '[]') != '[]' OR COALESCE(t.reinforced_objects_json, '[]') != '[]'
			  OR COALESCE(t.skipped_objects_json, '[]') != '[]'
			)`,
			action: "scrub_extraction_run",
		}),
		ordinaryTarget("staged_memories", "staged_memories", { where: "t.settled_at IS NOT NULL" }),
		ordinaryTarget("receipts", "receipts", {
			where: `(t.summary IS NOT NULL OR COALESCE(t.detail, '{}') != '{}' OR COALESCE(t.scope_json, '{}') != '{}') AND NOT EXISTS (
				SELECT 1 FROM memory_jobs j
				 WHERE j.user_id = t.user_id AND j.receipt_id = t.id
				   AND j.status IN ('awaiting_source', 'queued', 'staged', 'processing')
			)`,
			action: "scrub_receipt",
		}),
		ordinaryTarget("ai_calls", "ai_calls"),
		ordinaryTarget("source_packets", "source_packets", {
			ageColumn: "received_at",
			action: "scrub_source_packet",
			where: `(
				COALESCE(t.content_hash, '') != '${ERASED_SOURCE_CONTENT_HASH}'
				OR t.content_preview IS NOT NULL OR COALESCE(t.message_count, 0) != 0
				OR COALESCE(t.raw_meta_json, '{}') != '{}'
			) AND NOT EXISTS (
				SELECT 1 FROM memory_jobs j
				 WHERE j.user_id = t.user_id AND j.source_packet_id = t.id
				   AND j.status IN ('awaiting_source', 'queued', 'staged', 'processing')
			)`,
		}),
	],
	security_audit: [],
});

function shortening(currentDays, nextDays) {
	if (nextDays === null) return false;
	if (currentDays === null) return true;
	return nextDays < currentDays;
}

async function selectTargetRows(env, target, scope, cutoffAt, limit) {
	const query = target.selectSql(limit);
	const { results } = await env.DB.prepare(query.sql).bind(...query.binds(scope, cutoffAt)).all();
	return results ?? [];
}

async function collectInventory(env, { scope, retentionClass, cutoffAt, maxItems }) {
	const lanes = {};
	const evidence = [];
	const guards = [];
	let total = 0;
	for (const target of TARGETS[retentionClass]) {
		const remaining = maxItems - total;
		if (remaining < 0) {
			throw new RetentionError(
				"retention_preview_too_large",
				`This preview exceeds the exact ${maxItems}-record safety limit. Contact an operator for a bounded purge.`,
				413,
			);
		}
		const limit = remaining + 1;
		const rows = await selectTargetRows(env, target, scope, cutoffAt, limit);
		if (rows.length > remaining) {
			throw new RetentionError(
				"retention_preview_too_large",
				`This preview exceeds the exact ${maxItems}-record safety limit. Contact an operator for a bounded purge.`,
				413,
			);
		}
		lanes[target.key] = rows.length;
		total += rows.length;
		for (const row of rows) evidence.push(`${target.key}\u0000${String(row.id)}`);
		guards.push({ target, limit, ids: rows.map((row) => String(row.id)) });
	}
	return { inventory: { total, lanes }, evidence, guards };
}

function inventoryGuardStatement(env, scope, cutoffAt, guard) {
	const query = guard.target.selectSql(guard.limit);
	const expected = JSON.stringify(guard.ids);
	return env.DB.prepare(
		`WITH current(id) AS (
		   SELECT CAST(candidate.id AS TEXT) FROM (${query.sql}) candidate
		 ), expected(id) AS (
		   SELECT CAST(value AS TEXT) FROM json_each(?)
		 )
		 INSERT INTO fence_guard (violation)
		 SELECT 1
		  WHERE EXISTS (SELECT id FROM current EXCEPT SELECT id FROM expected)
		     OR EXISTS (SELECT id FROM expected EXCEPT SELECT id FROM current)`,
	).bind(...query.binds(scope, cutoffAt), expected);
}

async function inventoryHash({ scope, retentionClass, days, cutoffAt, version, evidence }) {
	const canonical = JSON.stringify({
		v: 1,
		project_id: scope.projectId,
		memory_owner_user_id: scope.memoryOwnerUserId,
		class: retentionClass,
		days,
		cutoff_at: cutoffAt,
		policy_version: version,
		evidence: [
			...scope.memorySpaces.map((memorySpace) => `memory_space\u0000${memorySpace}`),
			...evidence,
		],
	});
	return `sha256:${await sha256Hex(canonical)}`;
}

export async function listRetentionPolicies(env, input = {}) {
	const scope = cleanScope(input);
	await requireProject(env, scope);
	const { results } = await env.DB.prepare(
		`SELECT class, days, version, effective_at, updated_at
		   FROM retention_policies
		  WHERE project_id = ? AND memory_owner_user_id = ?`,
	).bind(scope.projectId, scope.memoryOwnerUserId).all();
	const byClass = new Map((results ?? []).map((row) => [row.class, row]));
	return RETENTION_CLASSES.map((retentionClass) => publicPolicy(byClass.get(retentionClass), retentionClass));
}

export async function previewRetentionChange(env, input = {}) {
	const baseScope = cleanScope(input);
	const retentionClass = cleanClass(input.retentionClass ?? input.class);
	const days = cleanDays(input.days);
	const expectedVersion = cleanExpectedVersion(input.expectedVersion);
	const now = cleanNow(input.now);
	const maxItems = cleanLimit(input.maxItems, DEFAULT_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);
	await requireProject(env, baseScope);
	if (retentionClass === "security_audit" && days !== null) {
		throw new RetentionError(
			"retention_class_locked",
			"Security audit records are kept under a separately reviewed policy and cannot be shortened here.",
			409,
		);
	}
	const scope = await discoverProjectMemorySpaces(env, baseScope);
	const row = await policyRow(env, scope, retentionClass);
	const current = ensureExpectedVersion(row, retentionClass, expectedVersion);
	const cutoffAt = days === null ? null : now - days * DAY_MS;
	const collected = cutoffAt === null
		? { inventory: { total: 0, lanes: Object.fromEntries(TARGETS[retentionClass].map((target) => [target.key, 0])) }, evidence: [] }
		: await collectInventory(env, { scope, retentionClass, cutoffAt, maxItems });
	const hash = await inventoryHash({
		scope,
		retentionClass,
		days,
		cutoffAt,
		version: current.version,
		evidence: collected.evidence,
	});
	return {
		class: retentionClass,
		days,
		policy_version: current.version,
		cutoff_at: cutoffAt,
		expires_at: now + PREVIEW_TTL_MS,
		inventory: collected.inventory,
		memory_spaces: scope.memorySpaces.length,
		inventory_hash: hash,
		confirmation_required: shortening(current.days, days) ? RETENTION_CONFIRMATION : null,
		mutation_free: true,
	};
}

function policyCasGuard(env, scope, retentionClass, expectedVersion) {
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1
		  WHERE COALESCE((
		    SELECT version FROM retention_policies
		     WHERE project_id = ? AND memory_owner_user_id = ? AND class = ?
		  ), 0) != ?`,
	).bind(scope.projectId, scope.memoryOwnerUserId, retentionClass, expectedVersion);
}

function runPolicyGuard(env, run) {
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1
		  WHERE NOT EXISTS (
		    SELECT 1 FROM retention_policies
		     WHERE project_id = ? AND memory_owner_user_id = ? AND class = ?
		       AND version = ? AND days IS NOT NULL
		  )`,
	).bind(run.project_id, run.memory_owner_user_id, run.class, run.policy_version);
}

function fenceUpsertStatement(env, { scope, retentionClass, cutoffAt, policyVersion, now, requiresRunId = null }) {
	const values = requiresRunId
		? `SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM retention_runs WHERE id = ?)`
		: "VALUES (?, ?, ?, ?, ?, ?)";
	const statement = env.DB.prepare(
		`INSERT INTO retention_fences
		 (project_id, class, cutoff_at, policy_version, created_at, updated_at)
		 ${values}
		 ON CONFLICT(project_id, class) DO UPDATE SET
		   cutoff_at = MAX(retention_fences.cutoff_at, excluded.cutoff_at),
		   policy_version = CASE
		     WHEN excluded.cutoff_at >= retention_fences.cutoff_at THEN excluded.policy_version
		     ELSE retention_fences.policy_version
		   END,
		   updated_at = excluded.updated_at`,
	);
	const binds = [scope.projectId, retentionClass, cutoffAt, policyVersion, now, now];
	if (requiresRunId) binds.push(requiresRunId);
	return statement.bind(...binds);
}

function publicRun(row) {
	if (!row) return null;
	const rawCheckpoint = safeJson(row.checkpoint_json, {});
	const checkpoint = {
		...(typeof rawCheckpoint.lane === "string" ? { lane: rawCheckpoint.lane } : {}),
		batches: Number(rawCheckpoint.batches ?? 0),
		last_batch_count: Number(rawCheckpoint.last_batch_count ?? 0),
		pending_derived_groups: Array.isArray(rawCheckpoint.pending_derived)
			? rawCheckpoint.pending_derived.length
			: 0,
	};
	return {
		id: row.id,
		project_id: row.project_id,
		class: row.class,
		policy_version: Number(row.policy_version),
		cutoff_at: row.cutoff_at,
		mode: row.mode,
		status: row.status,
		inventory: safeJson(row.inventory_json, {}),
		checkpoint,
		deleted: safeJson(row.deleted_json, {}),
		error_code: row.error_code ?? null,
		attempts: Number(row.attempts ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
		completed_at: row.completed_at ?? null,
	};
}

export async function listRetentionRuns(env, input = {}) {
	const scope = cleanScope(input);
	await requireProject(env, scope);
	const limit = cleanLimit(input.limit, 25, 100);
	const { results } = await env.DB.prepare(
		`SELECT * FROM retention_runs
		  WHERE project_id = ? AND memory_owner_user_id = ?
		  ORDER BY created_at DESC, id DESC LIMIT ?`,
	).bind(scope.projectId, scope.memoryOwnerUserId, limit).all();
	return (results ?? []).map(publicRun);
}

async function loadRun(env, runId) {
	return env.DB.prepare("SELECT * FROM retention_runs WHERE id = ? LIMIT 1").bind(runId).first();
}

export async function activateRetentionPolicy(env, input = {}) {
	const baseScope = cleanScope(input);
	const retentionClass = cleanClass(input.retentionClass ?? input.class);
	const days = cleanDays(input.days);
	const expectedVersion = cleanExpectedVersion(input.expectedVersion);
	const now = cleanNow(input.now);
	const project = await requireProject(env, baseScope);
	const scope = await discoverProjectMemorySpaces(env, baseScope);
	if (retentionClass === "security_audit" && days !== null) {
		throw new RetentionError(
			"retention_class_locked",
			"Security audit records are kept under a separately reviewed policy and cannot be shortened here.",
			409,
		);
	}
	const existing = await policyRow(env, scope, retentionClass);
	const current = ensureExpectedVersion(existing, retentionClass, expectedVersion);
	const requestId = input.requestId ?? systemRequestId("retention-policy");
	const waitUntil = typeof input.waitUntil === "function" ? input.waitUntil : null;
	const policyIntent = await beginAuditIntent(env, {
		orgId: project.organization_id ?? null,
		projectId: scope.projectId,
		actorUserId: input.actorUserId ?? null,
		actorType: input.actorUserId ? "user" : "system",
		guardActorUserId: input.actorUserId && input.authorizationGuards?.length ? input.actorUserId : null,
		guardOrgId: input.authorizationGuards?.length ? (project.organization_id ?? null) : null,
		guardProjectId: input.authorizationGuards?.length ? scope.projectId : null,
		action: "retention.policy.changed",
		targetType: "retention_policy",
		targetId: retentionClass,
		requestId,
		metadata: {
			retention_class: { from: retentionClass, to: retentionClass },
			retention_days: { from: current.days, to: days },
			policy_version: { from: current.version, to: current.version + (current.days === days ? 0 : 1) },
		},
		authorizationGuards: input.authorizationGuards ?? [],
	});
	if (current.days === days) {
		await finalizeAuditIntent(env, policyIntent, {
			outcome: "noop",
			reason: "no_change",
			waitUntil,
		});
		return { policy: current, run: null, changed: false };
	}

	const isShortening = shortening(current.days, days);
	let preview = null;
	if (isShortening) {
		if (input.confirmation !== RETENTION_CONFIRMATION) {
			throw new RetentionError(
				"retention_confirmation_required",
				`Type ${RETENTION_CONFIRMATION} exactly before activating a shorter policy.`,
			);
		}
		const cutoffAt = Number(input.previewCutoffAt);
		if (!Number.isFinite(cutoffAt) || cutoffAt > now || now > cutoffAt + days * DAY_MS + PREVIEW_TTL_MS) {
			throw new RetentionError(
				"retention_preview_expired",
				"The deletion preview expired. Preview the current inventory again before applying retention.",
				409,
			);
		}
		const suppliedHash = typeof input.previewInventoryHash === "string" ? input.previewInventoryHash : "";
		const collected = await collectInventory(env, {
			scope,
			retentionClass,
			cutoffAt,
			maxItems: DEFAULT_PREVIEW_LIMIT,
		});
		const freshHash = await inventoryHash({
			scope,
			retentionClass,
			days,
			cutoffAt,
			version: expectedVersion,
			evidence: collected.evidence,
		});
		if (!suppliedHash || suppliedHash !== freshHash) {
			throw new RetentionError(
				"retention_preview_changed",
				"The eligible inventory changed after preview. Review the new exact count before applying retention.",
				409,
			);
		}
		preview = { cutoffAt, inventory: collected.inventory, hash: freshHash, guards: collected.guards };
	}

	const nextVersion = expectedVersion + 1;
	const runId = isShortening ? newId("ret") : null;
	let runIntent = null;
	if (runId) {
		try {
			runIntent = await beginAuditIntent(env, {
				orgId: project.organization_id ?? null,
				projectId: scope.projectId,
				actorUserId: input.actorUserId ?? null,
				actorType: input.actorUserId ? "user" : "system",
				guardActorUserId: input.actorUserId && input.authorizationGuards?.length ? input.actorUserId : null,
				guardOrgId: input.authorizationGuards?.length ? (project.organization_id ?? null) : null,
				guardProjectId: input.authorizationGuards?.length ? scope.projectId : null,
				action: "retention.run.queued",
				targetType: "retention_run",
				targetId: runId,
				requestId,
				metadata: {
					retention_class: { from: null, to: retentionClass },
					retention_days: { from: null, to: days },
					policy_version: { from: null, to: nextVersion },
					run_mode: { from: null, to: "execute" },
					status: { from: null, to: "queued" },
				},
				authorizationGuards: input.authorizationGuards ?? [],
			});
		} catch (error) {
			await finalizeAuditIntent(env, policyIntent, {
				outcome: "failed",
				reason: error?.code ?? "audit_unavailable",
				waitUntil,
			});
			throw error;
		}
	}
	const failAudit = async (error) => {
		const final = {
			outcome: auditErrorOutcome(error),
			reason: error?.code ?? "retention_change_failed",
			waitUntil,
		};
		await Promise.all([
			finalizeAuditIntent(env, policyIntent, final),
			...(runIntent ? [finalizeAuditIntent(env, runIntent, final)] : []),
		]);
	};
	const statements = [
		policyCasGuard(env, scope, retentionClass, expectedVersion),
		...(isShortening
			? [
				memorySpaceInventoryGuardStatement(env, scope),
				...preview.guards.map((guard) => inventoryGuardStatement(env, scope, preview.cutoffAt, guard)),
			]
			: []),
		...memorySpaceRegistrationStatements(env, scope, now),
		env.DB.prepare(
			`INSERT INTO retention_policies
			 (project_id, memory_owner_user_id, class, days, version, effective_at,
			  updated_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, class) DO UPDATE SET
			   memory_owner_user_id = excluded.memory_owner_user_id,
			   days = excluded.days,
			   version = excluded.version,
			   effective_at = excluded.effective_at,
			   updated_by_user_id = excluded.updated_by_user_id,
			   updated_at = excluded.updated_at`,
		).bind(
			scope.projectId,
			scope.memoryOwnerUserId,
			retentionClass,
			days,
			nextVersion,
			now,
			input.actorUserId ?? null,
			existing?.created_at ?? now,
			now,
		),
		env.DB.prepare(
			`UPDATE retention_runs
			    SET status = 'cancelled', error_code = 'policy_superseded', updated_at = ?, completed_at = ?
			  WHERE project_id = ? AND class = ? AND status IN ('queued', 'running', 'retry')`,
		).bind(now, now, scope.projectId, retentionClass),
	];
	if (isShortening) {
		statements.push(
			fenceUpsertStatement(env, { scope, retentionClass, cutoffAt: preview.cutoffAt, policyVersion: nextVersion, now }),
			env.DB.prepare(
				`INSERT INTO retention_runs
				 (id, project_id, memory_owner_user_id, class, policy_version, cutoff_at, mode,
				  status, inventory_hash, inventory_json, checkpoint_json, deleted_json,
				  actor_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'execute', 'queued', ?, ?, '{}', '{}', ?, ?, ?)`,
			).bind(
				runId,
				scope.projectId,
				scope.memoryOwnerUserId,
				retentionClass,
				nextVersion,
				preview.cutoffAt,
				preview.hash,
				JSON.stringify(preview.inventory),
				input.actorUserId ?? null,
				now,
				now,
			),
		);
	}

	try {
		await commitAuditedBatch(env, [policyIntent, runIntent].filter(Boolean), statements);
	} catch (error) {
		const fresh = await policyRow(env, scope, retentionClass);
		if (Number(fresh?.version ?? 0) !== expectedVersion) {
			const conflict = new RetentionError(
				"retention_conflict",
				"Retention changed in another session. Reload the current policy before saving.",
				412,
				publicPolicy(fresh, retentionClass),
			);
			await failAudit(conflict);
			throw conflict;
		}
		if (isShortening) {
			const freshScope = await discoverProjectMemorySpaces(env, baseScope);
			const freshInventory = await collectInventory(env, {
				scope: freshScope,
				retentionClass,
				cutoffAt: preview.cutoffAt,
				maxItems: DEFAULT_PREVIEW_LIMIT,
			});
			const freshHash = await inventoryHash({
				scope: freshScope,
				retentionClass,
				days,
				cutoffAt: preview.cutoffAt,
				version: expectedVersion,
				evidence: freshInventory.evidence,
			});
			if (freshHash !== preview.hash) {
				const changed = new RetentionError(
					"retention_preview_changed",
					"The eligible inventory changed after preview. Review the new exact count before applying retention.",
					409,
				);
				await failAudit(changed);
				throw changed;
			}
		}
		await failAudit(error);
		throw error;
	}

	const saved = await policyRow(env, scope, retentionClass);
	const run = runId ? await loadRun(env, runId) : null;
	await finalizeAuditIntent(env, policyIntent, {
		outcome: "ok",
		metadata: {
			retention_class: { from: retentionClass, to: retentionClass },
			retention_days: { from: current.days, to: days },
			policy_version: { from: current.version, to: nextVersion },
		},
		waitUntil,
	});
	if (run && runIntent) {
		await finalizeAuditIntent(env, runIntent, {
			outcome: "ok",
			metadata: {
				retention_class: { from: null, to: retentionClass },
				retention_days: { from: null, to: days },
				policy_version: { from: null, to: nextVersion },
				run_mode: { from: null, to: run.mode },
				status: { from: null, to: run.status },
			},
			waitUntil,
		});
	}
	return auditedMutationResult({ policy: publicPolicy(saved, retentionClass), run: publicRun(run), changed: true }, policyIntent);
}

export function retentionFenceGuardStatement(env, input = {}) {
	const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
	const retentionClass = cleanClass(input.retentionClass ?? input.class);
	const acceptedAt = Number(input.acceptedAt);
	if (!projectId || !Number.isFinite(acceptedAt)) {
		throw new RetentionError("invalid_retention_fence", "A project and accepted-at time are required.");
	}
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1
		  WHERE EXISTS (
		    SELECT 1 FROM retention_fences
		     WHERE project_id = ? AND class = ? AND cutoff_at >= ?
		  )`,
	).bind(projectId, retentionClass, Math.trunc(acceptedAt));
}

export function projectMemorySpaceRegistrationStatement(env, input = {}) {
	const scope = cleanScope(input);
	const memoryUserId = cleanMemorySpaceId(input.memoryUserId);
	const seenAt = cleanNow(input.seenAt);
	if (!memoryUserId) {
		throw new RetentionError("invalid_memory_space", "A valid memory-space id is required.");
	}
	return env.DB.prepare(
		`INSERT INTO project_memory_spaces
		 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
		 VALUES (?, ?, ?, 'active', ?, ?)
		 ON CONFLICT(project_id, memory_user_id) DO UPDATE SET
		   last_seen_at = MAX(project_memory_spaces.last_seen_at, excluded.last_seen_at)
		 WHERE project_memory_spaces.memory_owner_user_id = excluded.memory_owner_user_id`,
	).bind(scope.projectId, scope.memoryOwnerUserId, memoryUserId, seenAt, seenAt);
}

/** Resolve a historical write's project only through the immutable owner key. */
export async function retentionProjectForMemoryOwner(env, memoryOwnerUserId) {
	const owner = cleanMemorySpaceId(memoryOwnerUserId);
	if (!owner) return null;
	const row = await env.DB.prepare(
		`SELECT id FROM managed_projects
		  WHERE memory_owner_user_id = ? AND status IN ('active', 'archived') LIMIT 1`,
	).bind(owner).first();
	return cleanMemorySpaceId(row?.id);
}

export async function retentionFenceAllows(env, input = {}) {
	const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
	const retentionClass = cleanClass(input.retentionClass ?? input.class);
	const acceptedAt = Number(input.acceptedAt);
	if (!projectId || !Number.isFinite(acceptedAt)) {
		throw new RetentionError("invalid_retention_fence", "A project and accepted-at time are required.");
	}
	const row = await env.DB.prepare(
		"SELECT cutoff_at FROM retention_fences WHERE project_id = ? AND class = ? LIMIT 1",
	).bind(projectId, retentionClass).first();
	return !row || Number(row.cutoff_at) < acceptedAt;
}

function idsClause(ids) {
	return ids.map(() => "?").join(", ");
}

async function deleteVectorsStrict(env, target, rows) {
	if (!target.vectorKind || !rows.length) return;
	if (String(env.USE_VECTORS ?? "true").toLocaleLowerCase("en-US") === "false") return;
	if (!env.VECTORIZE?.deleteByIds || !env.VECTORIZE?.getByIds) {
		throw new Error("retention_vector_scope_unverifiable");
	}
	const expected = new Map();
	const expectedOwner = new Map();
	const byNamespace = new Map();
	for (const row of rows) {
		const id = target.vectorKind === "page" ? `page:${row.id}` : String(row.id);
		const namespace = target.vectorKind === "page"
			? await manualPageVectorNamespace(row.memory_user_id)
			: row.memory_user_id;
		if (expected.has(id) && expected.get(id) !== namespace) {
			throw new Error("retention_vector_id_scope_collision");
		}
		expected.set(id, namespace);
		expectedOwner.set(id, row.memory_user_id);
		if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
		byNamespace.get(namespace).push(id);
	}
	const vectors = await env.VECTORIZE.getByIds([...expected.keys()]);
	for (const vector of vectors ?? []) {
		const expectedNamespace = expected.get(vector.id);
		if (!expectedNamespace
			|| vector.namespace !== expectedNamespace
			|| (vector.metadata?.user_id && vector.metadata.user_id !== expectedOwner.get(vector.id))) {
			throw new Error("retention_vector_scope_mismatch");
		}
	}
	// The Workers binding does not accept a namespace on deleteByIds. Keep each
	// namespace in its own mutation after verifying every present vector's
	// server-returned namespace (and page vectors' hashed namespace) above.
	for (const ids of byNamespace.values()) await env.VECTORIZE.deleteByIds(ids);
}

async function derivedWorkForRows(env, target, scope, rows) {
	if (!["slices", "events", "edges", "nodes", "memory_pages"].includes(target.table)) return [];
	const ids = rows.map((row) => String(row.id));
	const marks = idsClause(ids);
	const groups = new Map();
	const group = (memoryUserId) => {
		if (!groups.has(memoryUserId)) {
			groups.set(memoryUserId, { memory_user_id: memoryUserId, deleted_ids: [], touched_node_ids: [] });
		}
		return groups.get(memoryUserId);
	};
	if (target.table === "slices" || target.table === "events") {
		const { results } = await env.DB.prepare(
			`SELECT id, user_id, node_id FROM ${target.table}
			  WHERE id IN (${marks}) AND ${userScope(target.table)}`,
		).bind(...ids, ...scopeBinds(scope)).all();
		for (const row of results ?? []) {
			const entry = group(row.user_id);
			entry.deleted_ids.push(row.id);
			if (row.node_id) entry.touched_node_ids.push(row.node_id);
		}
	} else if (target.table === "edges") {
		const { results } = await env.DB.prepare(
			`SELECT id, user_id, from_node, to_node FROM edges
			  WHERE id IN (${marks}) AND ${userScope("edges")}`,
		).bind(...ids, ...scopeBinds(scope)).all();
		for (const row of results ?? []) {
			const entry = group(row.user_id);
			entry.deleted_ids.push(row.id);
			if (row.from_node) entry.touched_node_ids.push(row.from_node);
			if (row.to_node) entry.touched_node_ids.push(row.to_node);
		}
	} else {
		for (const row of rows) {
			const entry = group(row.memory_user_id);
			entry.deleted_ids.push(String(row.id));
		}
	}
	return [...groups.values()].map((entry) => ({
		...entry,
		deleted_ids: [...new Set(entry.deleted_ids)].slice(0, MAX_BATCH_SIZE),
		touched_node_ids: [...new Set(entry.touched_node_ids)].slice(0, MAX_BATCH_SIZE * 2),
	}));
}

async function settleDerivedWork(env, work = [], lifecycle = {}) {
	for (const entry of work) {
		const userId = cleanMemorySpaceId(entry.memory_user_id);
		if (!userId) throw new Error("retention_derived_scope_invalid");
		const touched = [...new Set((entry.touched_node_ids ?? []).map(cleanMemorySpaceId).filter(Boolean))];
		for (const nodeId of touched) {
			const node = await env.DB.prepare(
				`SELECT id, label, category, state, summary, cluster
				   FROM nodes
				  WHERE id = ? AND user_id = ? AND deleted_at IS NULL
				    AND archived_at IS NULL AND suppressed_at IS NULL`,
			).bind(nodeId, userId).first();
			if (!node) continue;
			const [slicesResult, eventsResult] = await env.DB.batch([
				env.DB.prepare(
					`SELECT id, text, kind, created_at FROM slices
					  WHERE user_id = ? AND node_id = ? AND is_current = 1 AND deleted_at IS NULL
					  ORDER BY created_at DESC`,
				).bind(userId, nodeId),
				env.DB.prepare(
					`SELECT id, action, text, happened_at, created_at FROM events
					  WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL
					    AND COALESCE(action, '') <> 'updated'
					  ORDER BY COALESCE(happened_at, created_at) DESC LIMIT 12`,
				).bind(userId, nodeId),
			]);
			const slices = slicesResult.results ?? [];
			const events = eventsResult.results ?? [];
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE nodes SET summary = ?, summary_sources_json = ?, updated_at = ?,
						revision = COALESCE(revision, 1) + 1
					  WHERE id = ? AND user_id = ?`,
				).bind(
					fallbackSummary(node, slices, events),
					JSON.stringify([...slices.map((row) => row.id), ...events.map((row) => row.id)].slice(0, 40)),
					Date.now(),
					nodeId,
					userId,
				),
				env.DB.prepare(
					`DELETE FROM manual_search_profiles
					  WHERE user_id = ? AND object_kind = 'node' AND object_id = ?`,
				).bind(userId, nodeId),
			]);
		}
		// This project-memory rollup may contain labels/summaries from a deleted
		// node or page. Rebuild it from live rows before the run can advance.
		await refreshMemoryProfile(env, userId, `retention:${Date.now()}`, {
			managedProjectId: lifecycle.managedProjectId ?? null,
		});
	}
}

function auxiliaryDeleteStatements(env, target, scope, ids, now) {
	const marks = idsClause(ids);
	const scoped = (sql, ...leading) => env.DB.prepare(sql).bind(...leading, ...ids, ...scopeBinds(scope));
	// Retention-expired objects lose their revision history, idempotency
	// results, and projection rows with them — history follows content.
	const versionResidue = ["nodes", "memory_pages", "slices", "events"].includes(target.table)
		? [
			scoped(`DELETE FROM memory_revisions WHERE object_id IN (${marks}) AND ${userScope("memory_revisions")}`),
			scoped(`DELETE FROM memory_update_idempotency WHERE object_id IN (${marks}) AND ${userScope("memory_update_idempotency")}`),
			scoped(`DELETE FROM memory_projection_state WHERE object_id IN (${marks}) AND ${userScope("memory_projection_state")}`),
		]
		: [];
	if (target.table === "nodes") {
		return [
			...versionResidue,
			scoped(`DELETE FROM manual_node_identities WHERE node_id IN (${marks}) AND ${userScope("manual_node_identities")}`),
			scoped(`DELETE FROM manual_fact_identities WHERE (owner_node_id IN (${marks}) OR related_node_id IN (${marks})) AND ${userScope("manual_fact_identities")}`, ...ids),
			scoped(`DELETE FROM node_topic_communities WHERE node_id IN (${marks}) AND ${userScope("node_topic_communities")}`),
			scoped(`DELETE FROM manual_search_profiles WHERE object_kind = 'node' AND object_id IN (${marks}) AND ${userScope("manual_search_profiles")}`),
			env.DB.prepare(
				`DELETE FROM topic_communities
				  WHERE ${userScope("topic_communities")}
				    AND NOT EXISTS (
				      SELECT 1 FROM node_topic_communities links
				       WHERE links.user_id = topic_communities.user_id
				         AND links.community_id = topic_communities.id
				    )`,
			).bind(...scopeBinds(scope)),
		];
	}
	if (target.table === "memory_pages") {
		return [
			...versionResidue,
			env.DB.prepare(
				`INSERT INTO manual_page_write_epochs (user_id, epoch, updated_at)
				 SELECT DISTINCT p.user_id, 1, ? FROM memory_pages p
				  WHERE p.id IN (${marks}) AND ${userScope("p")}
				 ON CONFLICT(user_id) DO UPDATE SET
				   epoch = manual_page_write_epochs.epoch + 1,
				   updated_at = excluded.updated_at`,
			).bind(now, ...ids, ...scopeBinds(scope)),
			scoped(`DELETE FROM manual_page_identities WHERE page_id IN (${marks}) AND ${userScope("manual_page_identities")}`),
			scoped(`DELETE FROM manual_page_versions WHERE page_id IN (${marks}) AND ${userScope("manual_page_versions")}`),
			scoped(`DELETE FROM manual_search_profiles WHERE object_kind = 'page' AND object_id IN (${marks}) AND ${userScope("manual_search_profiles")}`),
		];
	}
	if (["slices", "events", "edges"].includes(target.table)) {
		return [
			...versionResidue,
			scoped(`DELETE FROM semantic_atom_projections WHERE object_id IN (${marks}) AND ${userScope("semantic_atom_projections")}`),
			scoped(`DELETE FROM manual_fact_identities WHERE object_id IN (${marks}) AND ${userScope("manual_fact_identities")}`),
		];
	}
	return versionResidue;
}

function targetMutationStatements(env, target, scope, rows, now) {
	const ids = rows.map((row) => String(row.id));
	const marks = idsClause(ids);
	if (target.action === "scrub_export") {
		return [env.DB.prepare(
			`UPDATE memory_exports SET data = NULL, size_bytes = 0
			  WHERE id IN (${marks}) AND ${userScope("memory_exports")}`,
		).bind(...ids, ...scopeBinds(scope))];
	}
	if (target.action === "scrub_source_packet") {
		return [env.DB.prepare(
			`UPDATE source_packets SET
			   content_hash = ?, content_preview = NULL, message_count = 0, raw_meta_json = '{}',
			   source_id = NULL, source_role = NULL, topic = NULL, project_name = NULL,
			   external_user_id = NULL, source_time = NULL, source_time_offset_minutes = NULL,
			   source_time_precision = NULL, updated_at = ?
			 WHERE id IN (${marks}) AND ${userScope("source_packets")}`,
		).bind(ERASED_SOURCE_CONTENT_HASH, now, ...ids, ...scopeBinds(scope))];
	}
	if (target.action === "scrub_job") {
		return [env.DB.prepare(
			`UPDATE memory_jobs SET payload_json = '{}', error = NULL, updated_at = ?
			  WHERE id IN (${marks}) AND ${userScope("memory_jobs")}
			    AND status IN ('enriched', 'failed', 'completed')`,
		).bind(now, ...ids, ...scopeBinds(scope))];
	}
	if (target.action === "scrub_extraction_run") {
		return [env.DB.prepare(
			`UPDATE extraction_runs SET
			   topic_filter = NULL, error = NULL, scope_json = '{}',
			   created_pages_json = '[]', created_nodes_json = '[]', created_slices_json = '[]',
			   created_events_json = '[]', created_edges_json = '[]', created_candidates_json = '[]',
			   updated_objects_json = '[]', reinforced_objects_json = '[]', skipped_objects_json = '[]',
			   updated_at = ?
			 WHERE id IN (${marks}) AND ${userScope("extraction_runs")}
			   AND (status IS NULL OR status NOT IN ('running', 'committing'))`,
		).bind(now, ...ids, ...scopeBinds(scope))];
	}
	if (target.action === "scrub_receipt") {
		return [env.DB.prepare(
			`UPDATE receipts SET summary = NULL, detail = '{}', scope_json = '{}'
			  WHERE id IN (${marks}) AND ${userScope("receipts")}
			    AND NOT EXISTS (
			      SELECT 1 FROM memory_jobs j
			       WHERE j.user_id = receipts.user_id AND j.receipt_id = receipts.id
			         AND j.status IN ('awaiting_source', 'queued', 'staged', 'processing')
			    )`,
		).bind(...ids, ...scopeBinds(scope))];
	}
	return [
		...auxiliaryDeleteStatements(env, target, scope, ids, now),
		env.DB.prepare(
			`DELETE FROM ${target.table}
			  WHERE ${target.idColumn} IN (${marks}) AND ${userScope(target.table)}`,
		).bind(...ids, ...scopeBinds(scope)),
	];
}

function mergeDeleted(run, lane, count) {
	const deleted = safeJson(run.deleted_json, {});
	const lanes = deleted.lanes && typeof deleted.lanes === "object" && !Array.isArray(deleted.lanes)
		? { ...deleted.lanes }
		: {};
	lanes[lane] = Number(lanes[lane] ?? 0) + count;
	return { total: Number(deleted.total ?? 0) + count, lanes };
}

async function policyStillCurrent(env, run) {
	const row = await env.DB.prepare(
		`SELECT version, days FROM retention_policies
		  WHERE project_id = ? AND memory_owner_user_id = ? AND class = ? LIMIT 1`,
	).bind(run.project_id, run.memory_owner_user_id, run.class).first();
	return Boolean(row && row.days !== null && Number(row.version) === Number(run.policy_version));
}

async function nextEligible(env, run, limit, discoveredScope) {
	const scope = discoveredScope ?? await discoverProjectMemorySpaces(env, {
		projectId: run.project_id,
		memoryOwnerUserId: run.memory_owner_user_id,
	});
	for (const target of TARGETS[run.class] ?? []) {
		const rows = await selectTargetRows(env, target, scope, Number(run.cutoff_at), limit);
		if (rows.length) return { target, rows, scope };
	}
	return null;
}

async function transitionRunWithAudit(env, run, status, {
	now = Date.now(),
	errorCode = null,
	expectedStatus = "running",
	policyGuard = false,
} = {}) {
	const project = await env.DB.prepare("SELECT organization_id FROM managed_projects WHERE id = ? LIMIT 1")
		.bind(run.project_id).first();
	const action = status === "completed"
		? "retention.run.completed"
		: status === "cancelled"
			? "retention.run.cancelled"
			: "retention.run.retry";
	return runAuditedMutation(env, {
		orgId: project?.organization_id ?? null,
		projectId: run.project_id,
		actorUserId: run.actor_user_id ?? null,
		actorType: run.actor_user_id ? "user" : "system",
		action,
		targetType: "retention_run",
		targetId: run.id,
		// A run can enter retry more than once. Each real transition receives a
		// fresh opaque scheduler correlation id; the run id remains the target.
		requestId: systemRequestId(action),
		// Archived projects still have enforceable retention. Use an explicit
		// fresh lifecycle fence instead of audit's active-only project default.
		guardOrgId: null,
		guardProjectId: null,
		guardActorUserId: null,
		authorizationGuards: [auditInvariantStatement(
			env,
			"SELECT 1 FROM managed_projects WHERE id = ? AND status IN ('active', 'archived')",
			[run.project_id],
		)],
	}, async (intent) => {
		const state = env.DB.prepare(
			`UPDATE retention_runs
			    SET status = ?, error_code = ?, updated_at = ?, completed_at = ?
			  WHERE id = ? AND status = ? AND policy_version = ?`,
		).bind(
			status,
			errorCode,
			now,
			status === "completed" || status === "cancelled" ? now : null,
			run.id,
			expectedStatus,
			run.policy_version,
		);
		await commitAuditedBatch(env, intent, [state], {
			preconditions: policyGuard ? [runPolicyGuard(env, run)] : [],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM retention_runs WHERE id = ? AND status = ? AND policy_version = ?",
				[run.id, status, run.policy_version],
			)],
		});
		return auditedMutationResult(await loadRun(env, run.id), intent);
	}, (settled) => ({
		outcome: status === "completed" ? "ok" : status === "retry" ? "failed" : "noop",
		reason: errorCode,
		metadata: {
			status: { from: expectedStatus, to: status },
			retention_class: run.class,
			policy_version: Number(run.policy_version),
			retention_days: run.days == null ? null : Number(run.days),
			deleted_count: Number(safeJson(settled?.deleted_json, {}).total ?? 0),
		},
	}));
}

export async function processRetentionRun(env, input = {}) {
	const runId = typeof input.runId === "string" ? input.runId.trim() : "";
	if (!runId) throw new RetentionError("invalid_retention_run", "A retention run id is required.");
	const now = cleanNow(input.now);
	const batchSize = cleanLimit(input.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
	let run = await loadRun(env, runId);
	if (!run) throw new RetentionError("retention_run_not_found", "That retention run does not exist.", 404);
	if ((input.projectId && run.project_id !== input.projectId)
		|| (input.memoryOwnerUserId && run.memory_owner_user_id !== input.memoryOwnerUserId)) {
		throw new RetentionError("retention_run_not_found", "That retention run does not exist.", 404);
	}
	if (["completed", "failed", "cancelled"].includes(run.status)) {
		return { ...publicRun(run), deleted_this_batch: 0 };
	}
	if (run.status === "running" && Number(run.updated_at) > now - RUN_LEASE_MS) {
		return { ...publicRun(run), deleted_this_batch: 0 };
	}
	if (run.status === "running") {
		run = await transitionRunWithAudit(env, run, "retry", {
			now,
			errorCode: "retention_lease_expired",
		});
	}
	const claim = await env.DB.prepare(
		`UPDATE retention_runs
		    SET status = 'running', attempts = attempts + 1, error_code = NULL, updated_at = ?
		  WHERE id = ? AND status IN ('queued', 'retry')`,
	).bind(now, runId).run();
	if (Number(claim.meta?.changes ?? 0) !== 1) {
		run = await loadRun(env, runId);
		return { ...publicRun(run), deleted_this_batch: 0 };
	}
	run = await loadRun(env, runId);
	if (!await policyStillCurrent(env, run)) {
		const cancelled = await transitionRunWithAudit(env, run, "cancelled", {
			now,
			errorCode: "policy_superseded",
		});
		return { ...publicRun(cancelled), deleted_this_batch: 0 };
	}
	let discoveredScope;
	try {
		discoveredScope = await discoverProjectMemorySpaces(env, {
			projectId: run.project_id,
			memoryOwnerUserId: run.memory_owner_user_id,
		});
		await env.DB.batch(memorySpaceRegistrationStatements(env, discoveredScope, now));
	} catch (error) {
		const errorCode = error instanceof RetentionError ? error.code : "retention_scope_incomplete";
		const retry = await transitionRunWithAudit(env, run, "retry", { now, errorCode });
		return { ...publicRun(retry), deleted_this_batch: 0 };
	}
	const storedCheckpoint = safeJson(run.checkpoint_json, {});
	if (Array.isArray(storedCheckpoint.pending_derived) && storedCheckpoint.pending_derived.length) {
		try {
			await settleDerivedWork(env, storedCheckpoint.pending_derived, { managedProjectId: run.project_id });
			const cleared = { ...storedCheckpoint };
			delete cleared.pending_derived;
			await env.DB.prepare(
				`UPDATE retention_runs SET checkpoint_json = ?, updated_at = ?
				  WHERE id = ? AND status = 'running'`,
			).bind(JSON.stringify(cleared), now, runId).run();
			run = await loadRun(env, runId);
		} catch (error) {
			const retry = await transitionRunWithAudit(env, run, "retry", {
				now,
				errorCode: "retention_derived_cleanup_failed",
			});
			console.warn("retention derived cleanup failed:", error?.message ?? error);
			return { ...publicRun(retry), deleted_this_batch: 0 };
		}
	}

	const eligible = await nextEligible(env, run, batchSize, discoveredScope);
	if (!eligible) {
		const completed = await transitionRunWithAudit(env, run, "completed", { now, policyGuard: true });
		return { ...publicRun(completed), deleted_this_batch: 0 };
	}

	try {
		const project = await env.DB.prepare(
			"SELECT organization_id FROM managed_projects WHERE id = ? LIMIT 1",
		).bind(run.project_id).first();
		const batch = await runAuditedMutation(env, {
			orgId: project?.organization_id ?? null,
			projectId: run.project_id,
			actorUserId: run.actor_user_id ?? null,
			actorType: run.actor_user_id ? "user" : "system",
			action: "retention.run.batch_applied",
			targetType: "retention_run",
			targetId: run.id,
			requestId: systemRequestId("retention-run-batch"),
			guardActorUserId: null,
			guardOrgId: null,
			guardProjectId: null,
			authorizationGuards: [auditInvariantStatement(
				env,
				"SELECT 1 FROM managed_projects WHERE id = ? AND status IN ('active', 'archived')",
				[run.project_id],
			)],
		}, async (intent) => {
			// Reserve the durable event before touching Vectorize. Vector deletion
			// is idempotent; if the later D1 batch fails, the audit records failure
			// and a retry safely repeats it without losing canonical state.
			await deleteVectorsStrict(env, eligible.target, eligible.rows);
			const derivedWork = await derivedWorkForRows(env, eligible.target, eligible.scope, eligible.rows);
			const deleted = mergeDeleted(run, eligible.target.key, eligible.rows.length);
			const checkpoint = safeJson(run.checkpoint_json, {});
			const nextCheckpoint = {
				lane: eligible.target.key,
				batches: Number(checkpoint.batches ?? 0) + 1,
				last_batch_count: eligible.rows.length,
				...(derivedWork.length ? { pending_derived: derivedWork } : {}),
			};
			await commitAuditedBatch(env, intent, [
				...targetMutationStatements(env, eligible.target, eligible.scope, eligible.rows, now),
				env.DB.prepare(
					`UPDATE retention_runs
					    SET deleted_json = ?, checkpoint_json = ?, updated_at = ?
					  WHERE id = ? AND status = 'running' AND policy_version = ?`,
				).bind(JSON.stringify(deleted), JSON.stringify(nextCheckpoint), now, runId, run.policy_version),
			], {
				preconditions: [runPolicyGuard(env, run)],
				postconditions: [auditInvariantStatement(
					env,
					`SELECT 1 FROM retention_runs
					  WHERE id = ? AND status = 'running' AND policy_version = ?
					    AND deleted_json = ? AND checkpoint_json = ?`,
					[runId, run.policy_version, JSON.stringify(deleted), JSON.stringify(nextCheckpoint)],
				)],
			});
			return auditedMutationResult({ derivedWork, deleted, nextCheckpoint }, intent);
		}, () => ({
			metadata: {
				retention_class: run.class,
				policy_version: Number(run.policy_version),
				run_mode: run.mode,
				deleted_count: eligible.rows.length,
			},
		}));
		const { derivedWork, nextCheckpoint } = batch;
		if (derivedWork.length) {
			await settleDerivedWork(env, derivedWork, { managedProjectId: run.project_id });
			delete nextCheckpoint.pending_derived;
			await env.DB.prepare(
				`UPDATE retention_runs SET checkpoint_json = ?, updated_at = ?
				  WHERE id = ? AND status = 'running'`,
			).bind(JSON.stringify(nextCheckpoint), now, runId).run();
		}
		const refreshed = await loadRun(env, runId);
		const remaining = await nextEligible(env, refreshed, 1, discoveredScope);
		const nextStatus = remaining ? "retry" : "completed";
		const settled = await transitionRunWithAudit(env, refreshed, nextStatus, { now, policyGuard: true });
		return { ...publicRun(settled), deleted_this_batch: eligible.rows.length };
	} catch (error) {
		if (!await policyStillCurrent(env, run)) {
			const cancelled = await transitionRunWithAudit(env, run, "cancelled", {
				now,
				errorCode: "policy_superseded",
			});
			return { ...publicRun(cancelled), deleted_this_batch: 0 };
		}
		const retry = await transitionRunWithAudit(env, run, "retry", {
			now,
			errorCode: "retention_batch_failed",
		});
		console.warn("retention batch failed:", error?.message ?? error);
		return { ...publicRun(retry), deleted_this_batch: 0 };
	}
}

export async function scheduleRetentionRuns(env, input = {}) {
	const now = cleanNow(input.now);
	const dayBoundary = Math.floor(now / DAY_MS) * DAY_MS;
	const limit = cleanLimit(input.limit, 20, 50);
	const stale = await env.DB.prepare(
		`SELECT * FROM retention_runs
		  WHERE status = 'running' AND updated_at <= ?
		  ORDER BY updated_at ASC, id ASC LIMIT ?`,
	).bind(now - RUN_LEASE_MS, limit).all();
	for (const row of stale.results ?? []) {
		await transitionRunWithAudit(env, row, "retry", {
			now,
			errorCode: "retention_lease_expired",
		});
	}
	const { results } = await env.DB.prepare(
		`SELECT p.project_id, p.memory_owner_user_id, p.class, p.days, p.version,
		        p.updated_by_user_id, mp.organization_id
		   FROM retention_policies p
		   JOIN managed_projects mp ON mp.id = p.project_id
		  WHERE p.days IS NOT NULL AND p.class != 'security_audit'
		    AND mp.status IN ('active', 'archived')
		    AND NOT EXISTS (
		      SELECT 1 FROM retention_runs active
		       WHERE active.project_id = p.project_id AND active.class = p.class
		         AND active.status IN ('queued', 'running', 'retry')
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM retention_runs covered
		       WHERE covered.project_id = p.project_id AND covered.class = p.class
		         AND covered.policy_version = p.version
		         AND covered.cutoff_at >= (? - p.days * ?)
		    )
		  ORDER BY p.project_id ASC, p.class ASC LIMIT ?`,
	).bind(dayBoundary, DAY_MS, limit).all();
	let created = 0;
	const runIds = [];
	for (const policy of results ?? []) {
		const cutoffAt = dayBoundary - Number(policy.days) * DAY_MS;
		const runId = newId("ret");
		const scope = { projectId: policy.project_id, memoryOwnerUserId: policy.memory_owner_user_id };
		const insert = env.DB.prepare(
			`INSERT INTO retention_runs
			 (id, project_id, memory_owner_user_id, class, policy_version, cutoff_at, mode,
			  status, inventory_json, checkpoint_json, deleted_json, actor_user_id, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, 'scheduled', 'queued', '{}', '{}', '{}', NULL, ?, ?
			 WHERE NOT EXISTS (
			   SELECT 1 FROM retention_runs
			    WHERE project_id = ? AND class = ? AND status IN ('queued', 'running', 'retry')
			 ) AND NOT EXISTS (
			   SELECT 1 FROM retention_runs
			    WHERE project_id = ? AND class = ? AND mode = 'scheduled' AND created_at >= ?
			 )`,
		).bind(
			runId,
			policy.project_id,
			policy.memory_owner_user_id,
			policy.class,
			policy.version,
			cutoffAt,
			now,
			now,
			policy.project_id,
			policy.class,
			policy.project_id,
			policy.class,
			dayBoundary,
		);
		try {
			await runAuditedMutation(env, {
				orgId: policy.organization_id ?? null,
				projectId: policy.project_id,
				actorType: "system",
				action: "retention.run.queued",
				targetType: "retention_run",
				targetId: runId,
				requestId: systemRequestId("retention-run-queued", runId),
				guardOrgId: null,
				guardProjectId: null,
				guardActorUserId: null,
				authorizationGuards: [auditInvariantStatement(
					env,
					`SELECT 1 FROM managed_projects
					  WHERE id = ? AND status IN ('active', 'archived')`,
					[policy.project_id],
				)],
			}, async (intent) => {
				await commitAuditedBatch(env, intent, [
					insert,
					fenceUpsertStatement(env, {
						scope,
						retentionClass: policy.class,
						cutoffAt,
						policyVersion: Number(policy.version),
						now,
						requiresRunId: runId,
					}),
				], {
					postconditions: [auditInvariantStatement(
						env,
						`SELECT 1 FROM retention_runs
						  WHERE id = ? AND project_id = ? AND class = ?
						    AND policy_version = ? AND status = 'queued'`,
						[runId, policy.project_id, policy.class, Number(policy.version)],
					)],
				});
				return auditedMutationResult({ id: runId }, intent);
			}, () => ({
				metadata: {
					status: { from: null, to: "queued" },
					retention_class: policy.class,
					retention_days: Number(policy.days),
					policy_version: Number(policy.version),
				},
			}));
			created += 1;
			runIds.push(runId);
		} catch (error) {
			// Another scheduler may have won the exact run claim. Its transaction
			// owns both the run and event; this attempt owns neither and can safely
			// continue to the next policy. Audit availability errors still escape so
			// the scheduler retries instead of silently dropping coverage.
			if (error?.name === "AuditUnavailableError") throw error;
			console.warn("retention schedule claim skipped:", error?.message ?? error);
		}
	}
	return { created, run_ids: runIds };
}

export async function processQueuedRetentionRuns(env, input = {}) {
	const now = cleanNow(input.now);
	const maxRuns = cleanLimit(input.maxRuns, 5, 20);
	const batchSize = cleanLimit(input.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
	const { results } = await env.DB.prepare(
		`SELECT id FROM retention_runs
		  WHERE status IN ('queued', 'retry')
		  ORDER BY created_at ASC, id ASC LIMIT ?`,
	).bind(maxRuns).all();
	const runs = [];
	for (const row of results ?? []) {
		runs.push(await processRetentionRun(env, { runId: row.id, now, batchSize }));
	}
	return { processed: runs.length, runs };
}
