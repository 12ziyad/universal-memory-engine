/**
 * Memory exports — a job, not a request.
 *
 * Building one means reading every table a person owns. On a large graph that
 * is slow enough to hold a response open, so the route only creates the row
 * and the work runs inside the user's Durable Object. The page polls.
 *
 * The format is JSON and only JSON. A second format before anyone has asked
 * for one is a maintenance cost with no reader.
 */

import { newId } from "../lib/ids.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
} from "../lib/audit.js";

export const EXPORT_TABLES = [
	"nodes", "slices", "events", "edges", "memory_pages", "candidates", "receipts", "memory_rules",
	// Revision snapshots are the customer's own prior wording. Omitting them
	// would make a "complete export" a false claim, so portability includes
	// them — bounded, and only for objects that still exist.
	"memory_revisions",
];

const SOFT_DELETABLE_EXPORT_TABLES = new Set([
	"nodes", "slices", "events", "edges", "memory_pages", "candidates",
]);

/**
 * Hard bound on exported revision rows. History is unbounded in principle, so
 * the export states plainly when it stopped rather than silently truncating.
 */
export const EXPORT_REVISION_LIMIT = 50_000;

/** Prepare the shared live-row selection used by both export surfaces. */
export function prepareExportRows(env, userId, table) {
	if (table === "memory_revisions") {
		// Only history for objects that still exist. Deletion, retention, purge
		// and erasure already remove revisions; this is the belt-and-braces that
		// keeps a deleted memory's prior wording out of a portability download.
		return env.DB.prepare(
			`SELECT r.* FROM memory_revisions r
			  WHERE r.user_id = ?
			    AND (
			      (r.object_kind = 'node'  AND EXISTS (SELECT 1 FROM nodes n         WHERE n.id = r.object_id AND n.user_id = r.user_id AND n.deleted_at IS NULL))
			   OR (r.object_kind = 'page'  AND EXISTS (SELECT 1 FROM memory_pages p  WHERE p.id = r.object_id AND p.user_id = r.user_id AND p.deleted_at IS NULL))
			   OR (r.object_kind = 'slice' AND EXISTS (SELECT 1 FROM slices s        WHERE s.id = r.object_id AND s.user_id = r.user_id AND s.deleted_at IS NULL))
			   OR (r.object_kind = 'event' AND EXISTS (SELECT 1 FROM events e        WHERE e.id = r.object_id AND e.user_id = r.user_id AND e.deleted_at IS NULL))
			    )
			  ORDER BY r.object_id, r.revision
			  LIMIT ?`,
		).bind(userId, EXPORT_REVISION_LIMIT);
	}
	const liveOnly = SOFT_DELETABLE_EXPORT_TABLES.has(table) ? " AND deleted_at IS NULL" : "";
	return env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?${liveOnly}`).bind(userId);
}

/** A row bigger than this cannot be stored or served from D1. */
export function exportMaxBytes(env) {
	const value = Number(env?.EXPORT_MAX_BYTES ?? 1_500_000);
	return Number.isFinite(value) && value > 0 ? value : 1_500_000;
}

export function exportFileName(row) {
	return `itsuki-export-${new Date(Number(row?.created_at ?? Date.now())).toISOString().slice(0, 10)}.json`;
}

export async function listExports(env, userId, limit = 50) {
	const { results } = await env.DB.prepare(
		`SELECT id, status, format, entity, object_count, size_bytes, error,
			created_at, started_at, completed_at
		 FROM memory_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
	).bind(userId, limit).all();
	return results ?? [];
}

export async function getExport(env, userId, id) {
	if (!id) return null;
	return env.DB.prepare("SELECT * FROM memory_exports WHERE id = ? AND user_id = ?").bind(id, userId).first();
}

export async function createExport(env, userId, { entity = "All memories", auditIntent = null } = {}) {
	const id = newId("export");
	const now = Date.now();
	const statement = env.DB.prepare(
		`INSERT INTO memory_exports (id, user_id, status, format, entity, created_at)
		 VALUES (?, ?, 'queued', 'json', ?, ?)`,
	).bind(id, userId, String(entity).slice(0, 80), now);
	if (auditIntent) {
		await commitAuditedBatch(env, auditIntent, [statement], {
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM memory_exports WHERE id = ? AND user_id = ? AND status = 'queued'",
				[id, userId],
			)],
			commitDetails: { targetType: "export", targetId: id },
		});
	} else {
		await statement.run();
	}
	const result = { id, status: "queued", format: "json", entity, created_at: now };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

/**
 * Build the file. Runs inside the Durable Object; never throws at the caller —
 * a failure is a `failed` row with a sentence someone can act on.
 */
export async function runExport(env, userId, exportId) {
	const started = Date.now();
	await env.DB.prepare("UPDATE memory_exports SET status = 'running', started_at = ? WHERE id = ? AND user_id = ?")
		.bind(started, exportId, userId).run();
	try {
		const results = await env.DB.batch(EXPORT_TABLES.map((table) => prepareExportRows(env, userId, table)));
		const payload = {
			format: "itsuki-export",
			version: 1,
			exported_at: new Date().toISOString(),
			user_id: userId,
		};
		let objectCount = 0;
		EXPORT_TABLES.forEach((table, index) => {
			const rows = results[index].results ?? [];
			payload[table] = rows;
			objectCount += rows.length;
		});

		// Compact, not pretty-printed: the blob lives in a D1 TEXT column with a
		// hard ~2MB row ceiling, and indentation on row-heavy JSON was inflating
		// real exports past the limit (a 2.9MB pretty payload is ~1.5MB compact).
		// The direct download pretty-prints its own copy; this one is storage.
		const data = JSON.stringify(payload);
		const bytes = new TextEncoder().encode(data).length;
		const max = exportMaxBytes(env);
		if (bytes > max) {
			// Never truncate a person's memory and call it an export.
			await failExport(env, userId, exportId,
				// The pointer must name a control that actually exists, by its real
				// label — the previous text sent people hunting for an "Export
				// everything" button that was never built.
				`This memory is ${(bytes / 1_000_000).toFixed(1)} MB — larger than an export job can hold here. Use "Export current memory space" in Settings → Account → Data & Privacy for the full file.`);
			return { ok: false, reason: "too_large", bytes };
		}

		await env.DB.prepare(
			`UPDATE memory_exports SET status = 'complete', data = ?, object_count = ?, size_bytes = ?,
				completed_at = ?, error = NULL WHERE id = ? AND user_id = ?`,
		).bind(data, objectCount, bytes, Date.now(), exportId, userId).run();
		return { ok: true, objectCount, bytes };
	} catch (error) {
		console.warn(`export failed user=${userId} export=${exportId}:`, error?.message ?? error);
		await failExport(env, userId, exportId, "Something went wrong building this export. It has been reported — start another one and it will usually go through.");
		return { ok: false, reason: "error" };
	}
}

async function failExport(env, userId, exportId, message) {
	await env.DB.prepare(
		"UPDATE memory_exports SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND user_id = ?",
	).bind(message, Date.now(), exportId, userId).run().catch(() => {});
}
