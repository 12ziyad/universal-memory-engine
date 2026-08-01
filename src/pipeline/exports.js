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

export const EXPORT_TABLES = [
	"nodes", "slices", "events", "edges", "memory_pages", "candidates", "receipts", "memory_rules",
];

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

export async function createExport(env, userId, { entity = "All memories" } = {}) {
	const id = newId("export");
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO memory_exports (id, user_id, status, format, entity, created_at)
		 VALUES (?, ?, 'queued', 'json', ?, ?)`,
	).bind(id, userId, String(entity).slice(0, 80), now).run();
	return { id, status: "queued", format: "json", entity, created_at: now };
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
		const results = await env.DB.batch(EXPORT_TABLES.map((table) =>
			env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId)));
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

		const data = JSON.stringify(payload, null, 2);
		const bytes = new TextEncoder().encode(data).length;
		const max = exportMaxBytes(env);
		if (bytes > max) {
			// Never truncate a person's memory and call it an export.
			await failExport(env, userId, exportId,
				`This memory is ${(bytes / 1_000_000).toFixed(1)} MB — larger than an export job can hold here. Use "Export everything" in Settings for the full file.`);
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
