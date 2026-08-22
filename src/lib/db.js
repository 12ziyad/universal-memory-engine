/**
 * Thin D1 helpers. Every query is scoped by user_id — there is no path in
 * the engine that reads across users.
 */

import { newId } from "./ids.js";
import { managedMutationGuardStatement } from "./managed_projects.js";
import { hasProjectScopeOption, normalizeProjectScope } from "./project_scope.js";
import { normalizeLabel } from "./text.js";

export const MEMORY_JOB_ACTIVE_LIMIT = 200;

function durableLifecycleScope(value = {}, options = {}) {
	let scope = {};
	try {
		const rawScope = value?.scope_json ?? value?.scopeJson;
		scope = typeof rawScope === "string"
			? JSON.parse(rawScope || "{}") ?? {}
			: rawScope && typeof rawScope === "object" ? rawScope : {};
	} catch {}
	return {
		accountUserId: options.accountUserId ?? options.account_user_id
			?? value?.accountUserId ?? value?.account_user_id
			?? scope.account_user_id ?? scope.accountUserId ?? null,
		managedProjectId: options.managedProjectId ?? options.managed_project_id
			?? value?.managedProjectId ?? value?.managed_project_id
			?? scope.managed_project_id ?? scope.managedProjectId ?? null,
		managedAccess: options.managedAccess ?? options.managed_access
			?? value?.managedAccess ?? value?.managed_access
			?? "write",
	};
}

function activeWhere(alias = "") {
	const p = alias ? `${alias}.` : "";
	return `(${p}deleted_at IS NULL) AND (${p}archived_at IS NULL) AND (${p}suppressed_at IS NULL)`;
}

function projectWhere(options = {}, alias = "") {
	if (!hasProjectScopeOption(options)) return { sql: "", bindings: [] };
	const p = alias ? `${alias}.` : "";
	return {
		sql: ` AND ${p}project_id IS ?`,
		bindings: [normalizeProjectScope(options).projectId],
	};
}

export function canonicalKey(value) {
	return normalizeLabel(value);
}

/** All nodes for a user (id, label, category, state, summary). Small per user. */
export async function getUserNodes(env, userId, options = {}) {
	const project = projectWhere(options);
	const { results } = await env.DB.prepare(
		`SELECT id, label, category, role, state, summary, aliases_json, canonical_label,
			mention_count, session_count, last_seen_at, heat_score, confidence,
			health_state, importance_class, cluster, project_id, project_name
			 FROM nodes WHERE user_id = ? AND ${activeWhere()}${project.sql}`,
	)
		.bind(userId, ...project.bindings)
		.all();
	return results ?? [];
}

/** Current (is_current = 1) slices for a node. */
export async function getCurrentSlices(env, userId, nodeId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM slices WHERE user_id = ? AND node_id = ? AND is_current = 1 AND deleted_at IS NULL",
	)
		.bind(userId, nodeId)
		.all();
	return results ?? [];
}

/** Recent events for a node (newest first). */
export async function getNodeEvents(env, userId, nodeId, limit = 20) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM events WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
	)
		.bind(userId, nodeId, limit)
		.all();
	return results ?? [];
}

/** A user's existing candidates, keyed by normalized label for quick lookup. */
export async function getUserCandidates(env, userId, options = {}) {
	const project = projectWhere(options);
	const { results } = await env.DB.prepare(
		`SELECT id, label, strength, mentions, cluster_hint, label_guess, canonical_key,
			 role_guess, cluster_guess, confidence, status, first_seen_at, last_seen_at,
			 session_count, mention_count, evidence_json, possible_parent_id,
			 possible_existing_node_id, expires_at, reason
		 FROM candidates
			 WHERE user_id = ?
			   AND deleted_at IS NULL
			   AND suppressed_at IS NULL
			   AND COALESCE(status, 'pending') = 'pending'${project.sql}`,
	)
		.bind(userId, ...project.bindings)
		.all();
	return results ?? [];
}

export async function getUserEdges(env, userId, options = {}) {
	const project = projectWhere(options);
	const { results } = await env.DB.prepare(
		// `fact` is needed to decide whether a correction obsoletes an existing
		// relation (SUPERSEDE-01): without it the conflict check compares against
		// undefined and silently never matches.
		`SELECT id, from_node, to_node, type, reinforcement_count, weight, invalid_at, fact,
			project_id, project_name
		 FROM edges WHERE user_id = ? AND deleted_at IS NULL${project.sql}`,
	)
		.bind(userId, ...project.bindings)
		.all();
	return results ?? [];
}

export async function getUserPages(env, userId, options = {}) {
	const { includeArchived = false } = options;
	const project = projectWhere(options);
	const archived = includeArchived ? "1 = 1" : "archived_at IS NULL";
	const { results } = await env.DB.prepare(
		`SELECT * FROM memory_pages
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL AND ${archived}${project.sql}
			 ORDER BY updated_at DESC`,
	)
		.bind(userId, ...project.bindings)
		.all();
	return results ?? [];
}

export async function getActiveSuppressions(env, userId, options = {}) {
	const now = Date.now();
	const project = projectWhere(options);
	const { results } = await env.DB.prepare(
		`SELECT * FROM memory_suppressions
			 WHERE user_id = ? AND (suppressed_until IS NULL OR suppressed_until > ?)${project.sql}`,
	)
		.bind(userId, now, ...project.bindings)
		.all();
	return results ?? [];
}

export async function addSuppression(env, userId, {
	kind,
	label,
	canonical_key,
	reason,
	source_object_id,
	suppressed_until,
	projectId,
	projectName,
	project_id,
	project_name,
}) {
	const now = Date.now();
	const key = canonical_key ?? canonicalKey(label);
	if (!kind || !key) return null;
	const id = newId("suppress");
	const project = normalizeProjectScope({ projectId: projectId ?? project_id, projectName: projectName ?? project_name });
	await env.DB.prepare(
		`INSERT INTO memory_suppressions
				(id, user_id, kind, canonical_key, label, reason, source_object_id, suppressed_until, created_at,
				 project_id, project_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			userId,
			kind,
			key,
			label ?? key,
			reason ?? null,
			source_object_id ?? null,
			suppressed_until ?? null,
			now,
			project.projectId,
			project.projectName,
		)
		.run();
	return id;
}

export async function createExtractionRun(env, userId, data = {}) {
	const now = Date.now();
	const id = data.id ?? newId("run");
	const statement = env.DB.prepare(
		`INSERT INTO extraction_runs
			(id, user_id, tool_name, source_mode, topic_filter, receipt_id, status,
			 created_pages_json, created_nodes_json, created_slices_json, created_events_json,
			 created_edges_json, created_candidates_json, updated_objects_json, reinforced_objects_json,
			 skipped_objects_json, error, created_at, updated_at, source_packet_id, idempotency_key,
			 scope_json, job_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			userId,
			data.tool_name ?? data.toolName ?? null,
			data.source_mode ?? data.sourceMode ?? null,
			data.topic_filter ?? data.topicFilter ?? null,
			data.receipt_id ?? data.receiptId ?? null,
			data.status ?? "running",
			JSON.stringify(data.created_pages ?? data.createdPages ?? []),
			JSON.stringify(data.created_nodes ?? data.createdNodes ?? []),
			JSON.stringify(data.created_slices ?? data.createdSlices ?? []),
			JSON.stringify(data.created_events ?? data.createdEvents ?? []),
			JSON.stringify(data.created_edges ?? data.createdEdges ?? []),
			JSON.stringify(data.created_candidates ?? data.createdCandidates ?? []),
			JSON.stringify(data.updated_objects ?? data.updatedObjects ?? []),
			JSON.stringify(data.reinforced_objects ?? data.reinforcedObjects ?? []),
			JSON.stringify(data.skipped_objects ?? data.skippedObjects ?? []),
			data.error ?? null,
			now,
			now,
			data.source_packet_id ?? data.sourcePacketId ?? null,
			data.idempotency_key ?? data.idempotencyKey ?? null,
			data.scope_json ?? data.scopeJson ?? null,
			data.job_id ?? data.jobId ?? null,
		);
	const lifecycle = durableLifecycleScope(data, data);
	if (lifecycle.managedProjectId) {
		await env.DB.batch([
			managedMutationGuardStatement(env, {
				accountUserId: lifecycle.accountUserId,
				projectId: lifecycle.managedProjectId,
			}),
			statement,
		]);
	} else await statement.run();
	return id;
}

/**
 * Claim one deterministic extraction attempt. The primary key is the durable
 * inference fence: concurrent drains may observe the same row, but only the
 * caller that inserted it is allowed to invoke the model.
 */
export async function claimExtractionRun(env, userId, data = {}) {
	const now = Date.now();
	const id = data.id;
	if (!id) throw new Error("an extraction-run claim requires a deterministic id");
	const owner = {
		toolName: data.tool_name ?? data.toolName ?? null,
		sourceMode: data.source_mode ?? data.sourceMode ?? null,
		topicFilter: data.topic_filter ?? data.topicFilter ?? null,
		sourcePacketId: data.source_packet_id ?? data.sourcePacketId ?? null,
		idempotencyKey: data.idempotency_key ?? data.idempotencyKey ?? null,
		scopeJson: data.scope_json ?? data.scopeJson ?? null,
	};
	// Provider pin (migration 0053): resolved ONCE by the caller at claim time,
	// stored here, replayed on every re-claim. NULL = legacy behavior.
	const pin = {
		provider: data.provider ?? null,
		model: data.model ?? null,
		pinJson: data.pin_json ?? data.pinJson ?? null,
	};
	const insertStatement = env.DB.prepare(
		`INSERT INTO extraction_runs
			(id, user_id, tool_name, source_mode, topic_filter, receipt_id, status,
			 created_pages_json, created_nodes_json, created_slices_json, created_events_json,
			 created_edges_json, created_candidates_json, updated_objects_json, reinforced_objects_json,
			 skipped_objects_json, error, created_at, updated_at, source_packet_id, idempotency_key,
			 scope_json, job_id, provider, model, pin_json)
		 VALUES (?, ?, ?, ?, ?, NULL, 'running', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]',
			 '[]', NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING
		 RETURNING id`,
	)
		.bind(
			id,
			userId,
			owner.toolName,
			owner.sourceMode,
			owner.topicFilter,
			now,
			now,
			owner.sourcePacketId,
			owner.idempotencyKey,
			owner.scopeJson,
			pin.provider,
			pin.model,
			pin.pinJson,
		);
	const lifecycle = durableLifecycleScope(data, data);
	let inserted;
	if (lifecycle.managedProjectId) {
		const results = await env.DB.batch([
			managedMutationGuardStatement(env, {
				accountUserId: lifecycle.accountUserId,
				projectId: lifecycle.managedProjectId,
			}),
			insertStatement,
		]);
		inserted = results?.[1]?.results?.[0] ?? null;
	} else inserted = await insertStatement.first();
	const row = await env.DB.prepare(
		`SELECT * FROM extraction_runs WHERE id = ? LIMIT 1`,
	).bind(id).first();
	if (
		!row
		|| row.user_id !== userId
		|| (row.tool_name ?? null) !== owner.toolName
		|| (row.source_mode ?? null) !== owner.sourceMode
		|| (row.topic_filter ?? null) !== owner.topicFilter
		|| (row.source_packet_id ?? null) !== owner.sourcePacketId
		|| (row.idempotency_key ?? null) !== owner.idempotencyKey
		|| (row.scope_json ?? null) !== owner.scopeJson
	) {
		throw new Error("extraction-run id is already bound to different work");
	}
	// Row-wins pin replay: the STORED pin is authoritative for execution — a
	// re-claim that raced a policy flip resolves a fresh pin, loses to the row,
	// and must execute the recorded one. The throw is reserved for a caller
	// EXPLICITLY forcing a pin that contradicts a stored, different, non-NULL
	// pin (a code bug, never an operational event): routine callers pass
	// pinResolvedFresh so a routine policy change can never dead-letter a run.
	const rowPin = row.pin_json ?? null;
	const callerPin = pin.pinJson ?? null;
	if (rowPin !== null && callerPin !== null && rowPin !== callerPin && !data.pinResolvedFresh) {
		throw new Error("extraction-run id is already bound to a different provider pin");
	}
	return { claimed: Boolean(inserted?.id), id, row };
}

export async function updateExtractionRun(env, userId, runId, data = {}) {
	if (!runId) return;
	const fields = [];
	const values = [];
	const map = {
		receipt_id: "receiptId",
		status: "status",
		created_pages_json: "createdPages",
		created_nodes_json: "createdNodes",
		created_slices_json: "createdSlices",
		created_events_json: "createdEvents",
		created_edges_json: "createdEdges",
		created_candidates_json: "createdCandidates",
		updated_objects_json: "updatedObjects",
		reinforced_objects_json: "reinforcedObjects",
		skipped_objects_json: "skippedObjects",
		error: "error",
		source_packet_id: "sourcePacketId",
		idempotency_key: "idempotencyKey",
		scope_json: "scopeJson",
		job_id: "jobId",
	};
	for (const [column, key] of Object.entries(map)) {
		if (data[key] === undefined && data[column] === undefined) continue;
		const value = data[key] ?? data[column];
		fields.push(`${column} = ?`);
		const listJsonColumns = new Set([
			"created_pages_json",
			"created_nodes_json",
			"created_slices_json",
			"created_events_json",
			"created_edges_json",
			"created_candidates_json",
			"updated_objects_json",
			"reinforced_objects_json",
			"skipped_objects_json",
		]);
		values.push(listJsonColumns.has(column) ? JSON.stringify(value ?? []) : value);
	}
	fields.push("updated_at = ?");
	values.push(Date.now());
	if (!fields.length) return { changes: 0 };
	// SRV-08: a status transition may be GUARDED — `expectStatus` makes the
	// update conditional on the run still being where the caller left it, so a
	// concurrent delete's `cancelled_by_delete` mark cannot be overwritten by
	// the running→committing transition. Callers check `changes`.
	const guard = data.expectStatus ? " AND status = ?" : "";
	const guardValues = data.expectStatus ? [data.expectStatus] : [];
	const result = await env.DB.prepare(
		`UPDATE extraction_runs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?${guard}`,
	)
		.bind(...values, runId, userId, ...guardValues)
		.run();
	const changes = Number(result.meta?.changes ?? 0);
	if (changes > 0 && fields.some((field) => LINKED_OBJECT_COLUMNS.has(field.slice(0, field.indexOf(" "))))) {
		await syncMemorySourceLinks(env, userId, runId);
	}
	return { changes };
}

// The created_*_json columns whose contents are mirrored into
// memory_source_links. Pages are absent on purpose: memory_pages carries its
// own source_packet_id and the read path joins that column directly.
const LINKED_OBJECT_COLUMNS = new Map([
	["created_nodes_json", "node"],
	["created_slices_json", "slice"],
	["created_events_json", "event"],
]);

/**
 * Mirror one run's created-object ids into memory_source_links.
 *
 * The run row is the only input: nothing is passed in from the caller, so a
 * partial update ("just the slices this time") still produces the same links a
 * full replay would. INSERT OR IGNORE makes it idempotent, which matters
 * because every run is updated several times as it advances.
 *
 * Best-effort by design. These links power a read surface; failing a durable
 * memory write because a provenance index could not be refreshed would trade a
 * real memory for a column in a table.
 */
async function syncMemorySourceLinks(env, userId, runId) {
	try {
		const now = Date.now();
		await env.DB.batch([...LINKED_OBJECT_COLUMNS].map(([column, kind]) => env.DB.prepare(
			`INSERT OR IGNORE INTO memory_source_links
				(user_id, object_kind, object_id, source_packet_id, project_id, created_at)
			 SELECT r.user_id, ?, json_extract(j.value, '$.id'), r.source_packet_id,
				json_extract(r.scope_json, '$.project_id'), ?
			 FROM extraction_runs r, json_each(r.${column}) j
			 WHERE r.id = ? AND r.user_id = ? AND r.source_packet_id IS NOT NULL
				AND json_valid(r.${column})
				AND json_extract(j.value, '$.id') IS NOT NULL`,
		).bind(kind, now, runId, userId)));
	} catch (error) {
		console.warn("memory_source_links sync skipped:", error?.message ?? error);
	}
}

/**
 * Persist a save receipt (Priority 5). Best-effort: a receipt failure must never
 * break a save, so this swallows errors. `summary` is the human one-liner.
 */
export async function storeReceipt(env, userId, source, receipt, summary, options = {}) {
	const { strict = false } = options;
	const s = receipt?.saved ?? {};
	const id = receipt?.id ?? newId("receipt");
	const detail = receipt && typeof receipt === "object" ? { ...receipt, id } : receipt;
	try {
		const insertStatement = env.DB.prepare(
			`INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total,
				saved_nodes, saved_slices, saved_events, saved_edges, saved_candidates,
				updated_nodes, skipped, received, digested, detail, created_at, extraction_run_id,
				saved_pages, source_packet_id, idempotency_key, scope_json, latency_ms, matched, source_mode,
				ai_calls, ai_input_tokens, ai_output_tokens, ai_neurons)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO NOTHING`,
		).bind(
				id,
				userId,
				source ?? receipt?.source ?? "ingest",
				receipt?.outcome ?? null,
				summary ?? null,
				receipt?.savedTotal ?? 0,
				s.nodes ?? 0,
				s.slices ?? 0,
				s.events ?? 0,
				s.edges ?? 0,
				s.candidates ?? 0,
				s.updatedNodes ?? 0,
				receipt?.skipped ?? 0,
				receipt?.received ?? null,
				receipt?.digested ?? null,
				JSON.stringify(detail ?? {}),
				receipt?.created_at ?? Date.now(),
				receipt?.extraction_run_id ?? null,
				s.pages ?? 0,
				receipt?.source_packet_id ?? null,
				receipt?.idempotency_key ?? null,
				receipt?.scope_json ?? null,
				Number.isFinite(receipt?.latency_ms) ? Math.round(receipt.latency_ms) : null,
				Number.isFinite(receipt?.matched) ? Math.round(receipt.matched) : null,
				receipt?.source_mode ?? null,
				// Workers AI rollups for this save. Null when nothing was metered.
				Number.isFinite(receipt?.ai_calls) ? receipt.ai_calls : null,
				Number.isFinite(receipt?.ai_input_tokens) ? receipt.ai_input_tokens : null,
				Number.isFinite(receipt?.ai_output_tokens) ? receipt.ai_output_tokens : null,
				Number.isFinite(receipt?.ai_neurons) ? receipt.ai_neurons : null,
			);
		const lifecycle = durableLifecycleScope(receipt, options);
		const stateStatements = [insertStatement];
		if (receipt?.extraction_run_id) {
			stateStatements.push(env.DB.prepare(
				"UPDATE extraction_runs SET receipt_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(id, Date.now(), receipt.extraction_run_id, userId));
		}
		// Historical bearer/API tenants are not accounts and deliberately have no
		// users row. A managed project id is the unambiguous signal that this
		// receipt belongs to the enterprise account/project lifecycle.
		if (lifecycle.managedProjectId) {
			await env.DB.batch([
				managedMutationGuardStatement(env, {
					accountUserId: lifecycle.accountUserId,
					projectId: lifecycle.managedProjectId,
					access: lifecycle.managedAccess,
				}),
				...stateStatements,
			]);
		} else if (stateStatements.length > 1) {
			await env.DB.batch(stateStatements);
		} else {
			await insertStatement.run();
		}
		// Deterministic receipt ids make concurrent/replayed door responses one
		// immutable verdict. A conflicting primary key owned by another user is
		// never treated as success.
		const stored = await env.DB.prepare(
			"SELECT id, user_id, source_packet_id, idempotency_key FROM receipts WHERE id = ? LIMIT 1",
		).bind(id).first();
		if (
			!stored
			|| stored.user_id !== userId
			|| (
				receipt?.source_packet_id
				&& (stored.source_packet_id ?? null) !== receipt.source_packet_id
			)
			|| (
				receipt?.idempotency_key
				&& (stored.idempotency_key ?? null) !== receipt.idempotency_key
			)
		) {
			throw new Error("receipt id is not durably owned by this user");
		}
		if (receipt && typeof receipt === "object") receipt.id = id;
		return id;
	} catch (err) {
		if (strict) throw err;
		console.warn("receipt store failed:", err?.message ?? err);
		return null;
	}
}

export async function createMemoryJob(env, userId, data = {}) {
	const now = Date.now();
	const id = data.id ?? newId("job");
	const idempotencyKey = data.idempotency_key ?? data.idempotencyKey ?? null;
	const type = data.type ?? "job";
	const sourcePacketId = data.source_packet_id ?? data.sourcePacketId ?? null;
	const extractionRunId = data.extraction_run_id ?? data.extractionRunId ?? null;
	const payloadJson = JSON.stringify(data.payload ?? data.payload_json ?? {});
	try {
		const insertStatement = env.DB.prepare(
			`INSERT INTO memory_jobs
				(id, user_id, type, status, idempotency_key, source_packet_id, extraction_run_id,
				 receipt_id, attempts, payload_json, error, run_after, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, idempotency_key) DO NOTHING
			 RETURNING id`,
		).bind(
				id,
				userId,
				type,
				data.status ?? "queued",
				idempotencyKey,
				sourcePacketId,
				extractionRunId,
				data.receipt_id ?? data.receiptId ?? null,
				data.attempts ?? 0,
				payloadJson,
				data.error ?? null,
				data.run_after ?? data.runAfter ?? now,
				now,
				now,
				data.completed_at ?? data.completedAt ?? null,
			);
		const lifecycle = durableLifecycleScope(data, data);
		let inserted;
		if (lifecycle.managedProjectId) {
			const results = await env.DB.batch([
				managedMutationGuardStatement(env, {
					accountUserId: lifecycle.accountUserId,
					projectId: lifecycle.managedProjectId,
				}),
				insertStatement,
			]);
			inserted = results?.[1]?.results?.[0] ?? null;
		} else {
			inserted = await insertStatement.first();
		}
		if (inserted?.id) return inserted.id;
		if (!idempotencyKey) return null;
		const existing = await env.DB.prepare(
			`SELECT id, type, source_packet_id, extraction_run_id, payload_json
			 FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
		).bind(userId, idempotencyKey).first();
		const sameOwner = Boolean(
			existing
			&& existing.type === type
			&& (existing.source_packet_id ?? null) === sourcePacketId
			&& (existing.extraction_run_id ?? null) === extractionRunId
			&& String(existing.payload_json ?? "{}") === payloadJson
		);
		if (sameOwner) return existing.id;
		console.warn("memory job idempotency ownership conflict; existing row left unchanged");
		return null;
	} catch (err) {
		console.warn("memory job create failed:", err?.message ?? err);
		return null;
	}
}

/**
 * Atomically claim a memory job by its permanent, account-wide idempotency
 * key. Every door shares this uniqueness boundary: a caller may observe an
 * existing job, but it may never reset or replace it with another lane's job.
 * A caller that intentionally retries failed enrichment must use a new key.
 */
export async function claimMemoryJob(env, userId, data = {}) {
	const now = Date.now();
	const proposedId = data.id ?? newId("job");
	const idempotencyKey = data.idempotency_key ?? data.idempotencyKey ?? null;
	if (!idempotencyKey) throw new Error("a memory job claim requires an idempotency key");
	const type = data.type ?? "extract";
	const insertStatement = env.DB.prepare(
		`INSERT INTO memory_jobs
			(id, user_id, type, status, idempotency_key, source_packet_id, extraction_run_id,
			 receipt_id, attempts, payload_json, error, run_after, created_at, updated_at, completed_at)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE (
			SELECT COUNT(*) FROM memory_jobs
			WHERE user_id = ? AND status IN ('awaiting_source', 'queued', 'staged', 'processing')
		 ) < ?
		 ON CONFLICT(user_id, idempotency_key) DO NOTHING
		 RETURNING id`,
	)
		.bind(
			proposedId,
			userId,
			type,
			data.status ?? "queued",
			idempotencyKey,
			data.source_packet_id ?? data.sourcePacketId ?? null,
			data.extraction_run_id ?? data.extractionRunId ?? null,
			data.receipt_id ?? data.receiptId ?? null,
			data.attempts ?? 0,
			JSON.stringify(data.payload ?? data.payload_json ?? {}),
			data.error ?? null,
			data.run_after ?? data.runAfter ?? now,
			now,
			now,
			data.completed_at ?? data.completedAt ?? null,
			userId,
			MEMORY_JOB_ACTIVE_LIMIT,
		);
	let row;
	if (data.managedProjectId) {
		const results = await env.DB.batch([
			managedMutationGuardStatement(env, {
				accountUserId: data.accountUserId ?? null,
				projectId: data.managedProjectId,
			}),
			insertStatement,
		]);
		row = results?.[1]?.results?.[0] ?? null;
	} else {
		row = await insertStatement.first();
	}
	if (row?.id) return { claimed: true, id: row.id };
	const existing = await env.DB.prepare(
		"SELECT id, status, type, receipt_id, source_packet_id FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
	).bind(userId, idempotencyKey).first();
	if (existing?.id) return { claimed: false, id: existing.id, job: existing };
	return {
		claimed: false,
		id: null,
		job: null,
		capacityExceeded: true,
		activeLimit: MEMORY_JOB_ACTIVE_LIMIT,
	};
}

/** Backwards-compatible name for the HTTP ingest lane. */
export async function claimIngestMemoryJob(env, userId, data = {}) {
	return claimMemoryJob(env, userId, data);
}

/**
 * Per-message settlement of accept-time job rows (fix round 1, Part 1.1).
 *
 * A job row is created at the door with `payload.remaining` = the user-message
 * ids it accepted. As the Durable Object finalizes messages (processed by a
 * write, skipped as noise, deduplicated, or dead-lettered) it reports them
 * here; when nothing remains the row goes terminal: `enriched` or `failed`.
 * Runs under the DO's per-user serialization, so read-modify-write is safe.
 *
 * updates: [{ jobId, messageIds?, all?, disposition, counts?, error?, receiptId?, attempts?, repairGeneration? }]
 *   disposition: "processed" | "skipped" | "failed" | "attempted"
 *   - attempted: bookkeeping only (attempts + updated_at), no settlement
 *   - failed: terminal immediately, regardless of remaining
 *
 * Returns the jobs that reached a terminal state in THIS call, so the caller
 * can announce memory.enriched / memory.failed exactly once.
 */

/**
 * CAS-based settlement. D1 calls from a door and a drain may interleave even
 * though the Durable Object is the normal coordinator; compare both status and
 * payload bytes so distinct subsets cannot overwrite each other or emit two
 * terminal transitions.
 */
export async function settleMemoryJobs(env, userId, updates = [], { strict = false } = {}) {
	const transitions = [];
	const terminalStates = new Set(["enriched", "failed", "completed"]);
	for (const update of updates) {
		if (!update?.jobId) continue;
		let finished = false;
		try {
			for (let attempt = 0; attempt < 8 && !finished; attempt++) {
				const row = await env.DB.prepare(
					"SELECT id, status, attempts, payload_json, source_packet_id, receipt_id FROM memory_jobs WHERE id = ? AND user_id = ?",
				).bind(update.jobId, userId).first();
				if (!row) {
					if (strict) throw new Error(`memory job ${update.jobId} is missing`);
					finished = true;
					break;
				}
				if (terminalStates.has(row.status)) {
					finished = true;
					break;
				}

				let payload = {};
				try { payload = JSON.parse(row.payload_json ?? "{}") ?? {}; } catch {}
				if (update.repairGeneration !== undefined) {
					const expectedGeneration = Number(update.repairGeneration);
					const currentGeneration = Number(payload.repair_generation ?? 0);
					if (
						!Number.isSafeInteger(expectedGeneration)
						|| expectedGeneration < 0
						|| !Number.isSafeInteger(currentGeneration)
						|| currentGeneration < 0
					) {
						throw new Error(`memory job ${update.jobId} has invalid repair-generation state`);
					}
					// A queue entry from an older repair generation may survive a crash
					// after D1 reached terminal but before the Durable Object deleted its
					// local entry. Never let that stale owner settle a newer generation.
					if (currentGeneration !== expectedGeneration) {
						finished = true;
						break;
					}
				}
				let safeReceiptId = null;
				if (update.receiptId) {
					const receiptOwner = await env.DB.prepare(
						"SELECT source_packet_id FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
					).bind(update.receiptId, userId).first();
					if (receiptOwner && (receiptOwner.source_packet_id ?? null) === (row.source_packet_id ?? null)) {
						safeReceiptId = update.receiptId;
					} else {
						console.warn("memory job receipt ownership mismatch; link omitted");
					}
				}

				if (update.disposition === "attempted") {
					const nextAttempts = Number(update.attempts ?? Number(row.attempts ?? 0) + 1);
					const changed = await env.DB.prepare(
						`UPDATE memory_jobs
						 SET status = 'processing',
						     attempts = CASE WHEN attempts < ? THEN ? ELSE attempts END,
						     updated_at = ?
						 WHERE id = ? AND user_id = ? AND status = ? AND payload_json IS ?
						 RETURNING id`,
					).bind(
						nextAttempts,
						nextAttempts,
						Date.now(),
						update.jobId,
						userId,
						row.status,
						row.payload_json,
					).first();
					finished = Boolean(changed?.id);
					continue;
				}

				if (update.disposition === "failed") {
					const nextPayload = JSON.stringify({ ...payload, remaining: [] });
					const changed = await env.DB.prepare(
						`UPDATE memory_jobs
						 SET status = 'failed', error = ?, receipt_id = COALESCE(?, receipt_id),
						     payload_json = ?, completed_at = ?, updated_at = ?
						 WHERE id = ? AND user_id = ? AND status = ? AND payload_json IS ?
						 RETURNING receipt_id`,
					).bind(
						String(update.error ?? "processing failed").slice(0, 400),
						safeReceiptId,
						nextPayload,
						Date.now(),
						Date.now(),
						update.jobId,
						userId,
						row.status,
						row.payload_json,
					).first();
					if (!changed) continue;
					transitions.push({
						jobId: update.jobId,
						status: "failed",
						sourcePacketId: row.source_packet_id ?? null,
						receiptId: changed.receipt_id ?? row.receipt_id ?? null,
						project_id: payload.project_id ?? null,
						project_name: payload.project_name ?? null,
						error: update.error ?? null,
					});
					finished = true;
					continue;
				}

				const remaining = Array.isArray(payload.remaining) ? payload.remaining : [];
				const remainingSet = new Set(remaining);
				const newlyDone = (update.all ? remaining : (update.messageIds ?? []))
					.filter((messageId) => remainingSet.has(messageId));
				const done = new Set(newlyDone);
				const left = remaining.filter((messageId) => !done.has(messageId));
				const saved = { ...(payload.saved ?? {}) };
				if (newlyDone.length > 0 && update.counts && update.disposition === "processed") {
					for (const key of ["nodes", "slices", "events", "edges", "pages", "candidates"]) {
						saved[key] = Number(saved[key] ?? 0) + Number(update.counts[key] ?? 0);
					}
				}
				const terminal = left.length === 0;
				const nextPayload = JSON.stringify({ ...payload, remaining: left, saved });
				const changed = await env.DB.prepare(
					`UPDATE memory_jobs
					 SET status = ?, receipt_id = COALESCE(?, receipt_id), payload_json = ?,
					     completed_at = ?, updated_at = ?
					 WHERE id = ? AND user_id = ? AND status = ? AND payload_json IS ?
					 RETURNING receipt_id`,
				).bind(
					terminal ? "enriched" : "processing",
					safeReceiptId,
					nextPayload,
					terminal ? Date.now() : null,
					Date.now(),
					update.jobId,
					userId,
					row.status,
					row.payload_json,
				).first();
				if (!changed) continue;
				if (terminal) {
					transitions.push({
						jobId: update.jobId,
						status: "enriched",
						sourcePacketId: row.source_packet_id ?? null,
						receiptId: changed.receipt_id ?? row.receipt_id ?? null,
						project_id: payload.project_id ?? null,
						project_name: payload.project_name ?? null,
						saved,
					});
				}
				finished = true;
			}
			if (!finished) throw new Error(`memory job ${update.jobId} settlement CAS was exhausted`);
		} catch (error) {
			if (strict) throw error;
			console.warn("memory job settle failed:", error?.message ?? error);
		}
	}
	return transitions;
}

/** Count of a user's active (non-terminal) accept-time jobs — the queue depth. */
export async function activeJobDepth(env, userId) {
	try {
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status IN ('awaiting_source', 'queued', 'staged', 'processing')",
		).bind(userId).first();
		return Number(row?.n ?? 0);
	} catch (err) {
		console.warn("job depth query failed:", err?.message ?? err);
		return 0;
	}
}

export async function updateMemoryJob(env, userId, jobId, data = {}) {
	if (!jobId) return;
	const fields = [];
	const values = [];
	const map = {
		status: "status",
		receipt_id: "receiptId",
		attempts: "attempts",
		payload_json: "payload",
		error: "error",
		run_after: "runAfter",
		completed_at: "completedAt",
	};
	for (const [column, key] of Object.entries(map)) {
		if (data[key] === undefined && data[column] === undefined) continue;
		const value = data[key] ?? data[column];
		fields.push(`${column} = ?`);
		values.push(column === "payload_json" ? JSON.stringify(value ?? {}) : value);
	}
	fields.push("updated_at = ?");
	values.push(Date.now());
	await env.DB.prepare(`UPDATE memory_jobs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
		.bind(...values, jobId, userId)
		.run();
}

/**
 * Link only a receipt that belongs to the same ingest packet, without ever
 * replacing a receipt chosen by terminal processing or another concurrent
 * response. Transient door receipts belong only on active jobs. A known
 * ignored verdict from this invocation may fill a terminal job's empty link.
 */
export async function linkIngestMemoryJobReceipt(env, userId, jobId, {
	receiptId,
	sourcePacketId,
	outcome,
	terminalReplay = false,
	duplicate = false,
} = {}) {
	if (!jobId || !receiptId || !sourcePacketId) return false;
	let statuses;
	if (["accepted", "accumulating"].includes(outcome)) {
		statuses = "('queued', 'staged', 'processing')";
	} else if (outcome === "ignored" && !terminalReplay && !duplicate) {
		statuses = "('enriched', 'completed')";
	} else {
		return false;
	}
	const result = await env.DB.prepare(
		`UPDATE memory_jobs
		 SET receipt_id = ?, updated_at = ?
		 WHERE id = ? AND user_id = ? AND type = 'extract'
		   AND source_packet_id = ? AND receipt_id IS NULL
		   AND status IN ${statuses}
		   AND EXISTS (
			   SELECT 1 FROM receipts
			   WHERE id = ? AND user_id = ? AND source_packet_id = ?
		   )`,
	).bind(
		receiptId,
		Date.now(),
		jobId,
		userId,
		sourcePacketId,
		receiptId,
		userId,
		sourcePacketId,
	).run();
	return Number(result?.meta?.changes ?? 0) > 0;
}

/** Recent save receipts for a user, newest first. */
export async function getUserReceipts(env, userId, limit = 50) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return results ?? [];
}
