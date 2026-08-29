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

/**
 * A prepared export is a DERIVED COPY of memory, stored server-side in
 * `memory_exports.data` and served from a live door. Deleting memory that no
 * longer invalidated that copy meant the deletion promise was only true of
 * the primary tables: an export prepared before the delete kept serving the
 * deleted content afterwards — reachable with a credential minted after the
 * erasure, which is not "a copy the user already downloaded".
 *
 * So every deletion path calls this. The blob is dropped and the job is
 * marked `expired`, which is the honest state: the job existed, and its file
 * is gone because the memory behind it was deleted. Regenerating an export is
 * cheap; serving erased content is not recoverable.
 *
 * Deliberately space-wide rather than per-object: knowing which snapshot
 * contains which node would mean parsing every blob, and a stale-but-partial
 * export is exactly the ambiguity this is meant to remove.
 */
export async function invalidateStoredExports(env, userId, reason = "memory_deleted", { purge = false } = {}) {
	try {
		// The bytes live in R2 now, so clearing the row is no longer enough —
		// a deleted memory whose export object survived in the bucket would be
		// exactly the breach this function was written to close, just moved.
		if (env.EXPORTS) {
			const { results: stored } = await env.DB.prepare(
				"SELECT r2_key FROM memory_exports WHERE user_id = ? AND r2_key IS NOT NULL",
			).bind(userId).all();
			for (const row of stored ?? []) {
				await env.EXPORTS.delete(row.r2_key).catch((error) => {
					console.warn("export object delete failed:", error?.message ?? error);
				});
			}
		}
		// A full erasure removes the job rows outright — the census classifies
		// memory_exports as a memory-space table with purge: "delete", and
		// someone who asked for everything to be gone should not still see a
		// list of their old export jobs. A narrower delete keeps the row and
		// marks it expired, which is the honest state: the job happened, and
		// its file is gone because the memory behind it was deleted.
		const done = purge
			? await env.DB.prepare("DELETE FROM memory_exports WHERE user_id = ?").bind(userId).run()
			: await env.DB.prepare(
				`UPDATE memory_exports
				    SET data = NULL, r2_key = NULL, status = 'expired', size_bytes = 0, error = ?
				  WHERE user_id = ? AND (data IS NOT NULL OR r2_key IS NOT NULL OR status IN ('queued', 'running', 'complete'))`,
			).bind(reason, userId).run();
		return { invalidated: Number(done.meta?.changes ?? 0) };
	} catch (error) {
		console.warn("export invalidation failed:", error?.message ?? error);
		return { invalidated: 0 };
	}
}

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

/** Where an export's bytes live in the bucket. Namespaced by owner. */
export function r2KeyFor(userId, exportId) {
	return `exports/${userId}/${exportId}.json`;
}

/**
 * The bytes of a finished export, wherever they were put — R2 for anything
 * made since the bucket landed, the legacy inline column for older rows.
 * Returns null when there is nothing to serve, so the caller can answer
 * honestly instead of sending an empty file.
 */
export async function readExportBody(env, row) {
	if (!row) return null;
	if (row.r2_key && env.EXPORTS) {
		try {
			const object = await env.EXPORTS.get(row.r2_key);
			if (object) return await object.text();
			// The row says complete and the object is missing: say so rather
			// than serving nothing and calling it a download.
			console.warn("export object missing:", row.r2_key);
			return null;
		} catch (error) {
			console.warn("export fetch failed:", error?.message ?? error);
			return null;
		}
	}
	return row.data ?? null;
}

export async function listExports(env, userId, limit = 50) {
	const { results } = await env.DB.prepare(
		`SELECT id, status, format, entity, kind, object_count, size_bytes, delivered_bytes, error,
			created_at, started_at, completed_at
		 FROM memory_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
	).bind(userId, limit).all();
	return results ?? [];
}

/**
 * Record a direct download. It streams and stores nothing, which meant that
 * for a personal account it left NO trace at all — so "did my export work?"
 * had no answer, and the history page silently showed only the failures.
 * A direct download is a real export; it belongs in the list.
 */
export async function recordDirectExport(env, userId, { objectCount = null, bytes = null, entity = "Direct download", now = Date.now() } = {}) {
	try {
		const id = newId("export");
		await env.DB.prepare(
			`INSERT INTO memory_exports
			   (id, user_id, status, format, entity, kind, object_count, size_bytes, delivered_bytes,
			    created_at, started_at, completed_at)
			 VALUES (?, ?, 'complete', 'json', ?, 'direct', ?, ?, ?, ?, ?, ?)`,
		).bind(id, userId, String(entity).slice(0, 80), objectCount, bytes, bytes, now, now, now).run();
		return { id };
	} catch (error) {
		// Never fail someone's download because we could not file the receipt.
		console.warn("direct export record failed:", error?.message ?? error);
		return null;
	}
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

		// Compact, not pretty-printed — this copy is storage. The direct
		// download pretty-prints its own.
		const data = JSON.stringify(payload);
		const bytes = new TextEncoder().encode(data).length;

		// R2 holds the bytes now. This used to be a D1 TEXT column with a hard
		// ~2MB row ceiling, which is why a 2.7MB memory space could never
		// finish an export while the direct download — which streams and
		// stores nothing — always worked. Refusing to export someone's own
		// memory because of where WE chose to put the file was never their
		// problem to solve.
		if (env.EXPORTS) {
			const key = r2KeyFor(userId, exportId);
			await env.EXPORTS.put(key, data, {
				httpMetadata: { contentType: "application/json; charset=utf-8" },
				// Enough to re-associate an object with its row if the two ever
				// disagree, and nothing that is not already in the row.
				customMetadata: { userId, exportId },
			});
			await env.DB.prepare(
				`UPDATE memory_exports SET status = 'complete', r2_key = ?, data = NULL, object_count = ?, size_bytes = ?,
					completed_at = ?, error = NULL WHERE id = ? AND user_id = ?`,
			).bind(key, objectCount, bytes, Date.now(), exportId, userId).run();
			return { ok: true, objectCount, bytes, storage: "r2" };
		}

		// No bucket bound (local tests, or a deploy before the binding lands):
		// fall back to the old inline column, which still carries its ceiling.
		// Stating the real reason beats inventing a limit the product does not
		// actually have any more.
		const max = exportMaxBytes(env);
		if (bytes > max) {
			await failExport(env, userId, exportId,
				`This export is ${(bytes / 1_000_000).toFixed(1)} MB and file storage is not available on this deployment, so it could not be saved. Use "Download directly" — it streams and has no size limit.`);
			return { ok: false, reason: "too_large", bytes };
		}
		await env.DB.prepare(
			`UPDATE memory_exports SET status = 'complete', data = ?, object_count = ?, size_bytes = ?,
				completed_at = ?, error = NULL WHERE id = ? AND user_id = ?`,
		).bind(data, objectCount, bytes, Date.now(), exportId, userId).run();
		return { ok: true, objectCount, bytes, storage: "d1" };
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
