/**
 * Thin D1 helpers. Every query is scoped by user_id — there is no path in
 * the engine that reads across users.
 */

import { newId } from "./ids.js";

/** All nodes for a user (id, label, category, state, summary). Small per user. */
export async function getUserNodes(env, userId) {
	const { results } = await env.DB.prepare(
		"SELECT id, label, category, role, state, summary FROM nodes WHERE user_id = ?",
	)
		.bind(userId)
		.all();
	return results ?? [];
}

/** Current (is_current = 1) slices for a node. */
export async function getCurrentSlices(env, userId, nodeId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM slices WHERE user_id = ? AND node_id = ? AND is_current = 1",
	)
		.bind(userId, nodeId)
		.all();
	return results ?? [];
}

/** Recent events for a node (newest first). */
export async function getNodeEvents(env, userId, nodeId, limit = 20) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM events WHERE user_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT ?",
	)
		.bind(userId, nodeId, limit)
		.all();
	return results ?? [];
}

/** A user's existing candidates, keyed by normalized label for quick lookup. */
export async function getUserCandidates(env, userId) {
	const { results } = await env.DB.prepare(
		"SELECT id, label, strength, mentions FROM candidates WHERE user_id = ?",
	)
		.bind(userId)
		.all();
	return results ?? [];
}

/**
 * Persist a save receipt (Priority 5). Best-effort: a receipt failure must never
 * break a save, so this swallows errors. `summary` is the human one-liner.
 */
export async function storeReceipt(env, userId, source, receipt, summary) {
	const s = receipt?.saved ?? {};
	try {
		await env.DB.prepare(
			`INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total,
				saved_nodes, saved_slices, saved_events, saved_edges, saved_candidates,
				updated_nodes, skipped, received, digested, detail, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				newId("receipt"),
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
				JSON.stringify(receipt ?? {}),
				receipt?.created_at ?? Date.now(),
			)
			.run();
	} catch (err) {
		console.warn("receipt store failed:", err?.message ?? err);
	}
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
