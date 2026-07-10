/**
 * Thin D1 helpers. Every query is scoped by user_id — there is no path in
 * the engine that reads across users.
 */

import { newId } from "./ids.js";
import { normalizeLabel } from "./text.js";

function activeWhere(alias = "") {
	const p = alias ? `${alias}.` : "";
	return `(${p}deleted_at IS NULL) AND (${p}archived_at IS NULL) AND (${p}suppressed_at IS NULL)`;
}

export function canonicalKey(value) {
	return normalizeLabel(value);
}

/** All nodes for a user (id, label, category, state, summary). Small per user. */
export async function getUserNodes(env, userId) {
	const { results } = await env.DB.prepare(
		`SELECT id, label, category, role, state, summary, aliases_json, canonical_label,
			mention_count, session_count, last_seen_at, heat_score, confidence,
			health_state, importance_class, cluster
		 FROM nodes WHERE user_id = ? AND ${activeWhere()}`,
	)
		.bind(userId)
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
export async function getUserCandidates(env, userId) {
	const { results } = await env.DB.prepare(
		`SELECT id, label, strength, mentions, cluster_hint, label_guess, canonical_key,
			 role_guess, cluster_guess, confidence, status, first_seen_at, last_seen_at,
			 session_count, mention_count, evidence_json, possible_parent_id,
			 possible_existing_node_id, expires_at, reason
		 FROM candidates
		 WHERE user_id = ?
		   AND deleted_at IS NULL
		   AND suppressed_at IS NULL
		   AND COALESCE(status, 'pending') = 'pending'`,
	)
		.bind(userId)
		.all();
	return results ?? [];
}

export async function getUserEdges(env, userId) {
	const { results } = await env.DB.prepare(
		"SELECT id, from_node, to_node, type, reinforcement_count, weight FROM edges WHERE user_id = ? AND deleted_at IS NULL",
	)
		.bind(userId)
		.all();
	return results ?? [];
}

export async function getUserPages(env, userId, { includeArchived = false } = {}) {
	const archived = includeArchived ? "1 = 1" : "archived_at IS NULL";
	const { results } = await env.DB.prepare(
		`SELECT * FROM memory_pages
		 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL AND ${archived}
		 ORDER BY updated_at DESC`,
	)
		.bind(userId)
		.all();
	return results ?? [];
}

export async function getActiveSuppressions(env, userId) {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT * FROM memory_suppressions
		 WHERE user_id = ? AND (suppressed_until IS NULL OR suppressed_until > ?)`,
	)
		.bind(userId, now)
		.all();
	return results ?? [];
}

export async function addSuppression(env, userId, { kind, label, canonical_key, reason, source_object_id, suppressed_until }) {
	const now = Date.now();
	const key = canonical_key ?? canonicalKey(label);
	if (!kind || !key) return null;
	const id = newId("suppress");
	await env.DB.prepare(
		`INSERT INTO memory_suppressions
			(id, user_id, kind, canonical_key, label, reason, source_object_id, suppressed_until, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, userId, kind, key, label ?? key, reason ?? null, source_object_id ?? null, suppressed_until ?? null, now)
		.run();
	return id;
}

export async function createExtractionRun(env, userId, data = {}) {
	const now = Date.now();
	const id = data.id ?? newId("run");
	await env.DB.prepare(
		`INSERT INTO extraction_runs
			(id, user_id, tool_name, source_mode, topic_filter, receipt_id, status,
			 created_pages_json, created_nodes_json, created_slices_json, created_events_json,
			 created_edges_json, updated_objects_json, reinforced_objects_json, skipped_objects_json,
			 error, created_at, updated_at, source_packet_id, idempotency_key, scope_json, job_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		)
		.run();
	return id;
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
			"updated_objects_json",
			"reinforced_objects_json",
			"skipped_objects_json",
		]);
		values.push(listJsonColumns.has(column) ? JSON.stringify(value ?? []) : value);
	}
	fields.push("updated_at = ?");
	values.push(Date.now());
	if (!fields.length) return;
	await env.DB.prepare(`UPDATE extraction_runs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
		.bind(...values, runId, userId)
		.run();
}

/**
 * Persist a save receipt (Priority 5). Best-effort: a receipt failure must never
 * break a save, so this swallows errors. `summary` is the human one-liner.
 */
export async function storeReceipt(env, userId, source, receipt, summary) {
	const s = receipt?.saved ?? {};
	const id = receipt?.id ?? newId("receipt");
	const detail = receipt && typeof receipt === "object" ? { ...receipt, id } : receipt;
	try {
		await env.DB.prepare(
			`INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total,
				saved_nodes, saved_slices, saved_events, saved_edges, saved_candidates,
				updated_nodes, skipped, received, digested, detail, created_at, extraction_run_id,
				saved_pages, source_packet_id, idempotency_key, scope_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
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
			)
			.run();
		if (receipt && typeof receipt === "object") receipt.id = id;
		if (receipt?.extraction_run_id) {
			await updateExtractionRun(env, userId, receipt.extraction_run_id, { receiptId: id });
		}
		return id;
	} catch (err) {
		console.warn("receipt store failed:", err?.message ?? err);
		return null;
	}
}

export async function createMemoryJob(env, userId, data = {}) {
	const now = Date.now();
	const id = data.id ?? newId("job");
	const idempotencyKey = data.idempotency_key ?? data.idempotencyKey ?? null;
	try {
		await env.DB.prepare(
			`INSERT INTO memory_jobs
				(id, user_id, type, status, idempotency_key, source_packet_id, extraction_run_id,
				 receipt_id, attempts, payload_json, error, run_after, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, idempotency_key) DO UPDATE SET
				status = excluded.status,
				source_packet_id = excluded.source_packet_id,
				extraction_run_id = excluded.extraction_run_id,
				receipt_id = excluded.receipt_id,
				payload_json = excluded.payload_json,
				error = excluded.error,
				run_after = excluded.run_after,
				updated_at = excluded.updated_at,
				completed_at = excluded.completed_at`,
		)
			.bind(
				id,
				userId,
				data.type ?? "job",
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
			)
			.run();
		const row = idempotencyKey
			? await env.DB.prepare("SELECT id FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?")
				.bind(userId, idempotencyKey)
				.first()
			: { id };
		return row?.id ?? id;
	} catch (err) {
		console.warn("memory job create failed:", err?.message ?? err);
		return null;
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

/** Recent save receipts for a user, newest first. */
export async function getUserReceipts(env, userId, limit = 50) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
	)
		.bind(userId, limit)
		.all();
	return results ?? [];
}
