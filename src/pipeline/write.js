/**
 * Write the approved plan to D1 in one atomic batch, then store new node
 * embeddings in Vectorize (best-effort). History is appended, never rewritten.
 *
 * Returns { affectedNodeIds, newNodes } so Pass 2 knows what to refresh.
 * Throws if the D1 batch fails — the caller then keeps the chunk and does NOT
 * advance the checkpoint.
 */

import { embed } from "../lib/embeddings.js";
import { upsertNodeVector } from "../lib/vectorize.js";

export async function writeApproved(env, config, userId, plan) {
	const stmts = [];

	// New nodes.
	for (const n of plan.newNodes) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(n.id, n.user_id, n.label, n.category, n.role, n.state, n.summary, n.created_at, n.updated_at),
		);
	}

	// Node state changes (lifecycle events) — also bumps updated_at.
	for (const u of plan.nodeStateUpdates) {
		stmts.push(
			env.DB.prepare("UPDATE nodes SET state = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(
				u.state,
				Date.now(),
				u.id,
				userId,
			),
		);
	}

	// Canonical-match touches (no state change, just freshen updated_at).
	for (const id of plan.nodeTouches) {
		if (plan.nodeStateUpdates.some((u) => u.id === id)) continue;
		stmts.push(
			env.DB.prepare("UPDATE nodes SET updated_at = ? WHERE id = ? AND user_id = ?").bind(
				Date.now(),
				id,
				userId,
			),
		);
	}

	// Supersede older single-valued slices BEFORE inserting the new current one.
	for (const s of plan.sliceSupersede) {
		stmts.push(
			env.DB.prepare(
				"UPDATE slices SET is_current = 0 WHERE user_id = ? AND node_id = ? AND kind = ? AND is_current = 1",
			).bind(userId, s.node_id, s.kind),
		);
	}

	// New slices.
	for (const s of plan.newSlices) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(s.id, s.user_id, s.node_id, s.text, s.kind, s.is_current, s.created_at),
		);
	}

	// New events.
	for (const e of plan.newEvents) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(e.id, e.user_id, e.node_id, e.action, e.text, e.importance, e.happened_at, e.created_at),
		);
	}

	// New edges.
	for (const ed of plan.newEdges) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO edges (id, user_id, from_node, to_node, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind(ed.id, ed.user_id, ed.from_node, ed.to_node, ed.type, ed.created_at),
		);
	}

	// New candidates.
	for (const c of plan.newCandidates) {
		stmts.push(
			env.DB.prepare(
				"INSERT INTO candidates (id, user_id, label, strength, mentions, cluster_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(c.id, c.user_id, c.label, c.strength, c.mentions, c.cluster_hint, c.created_at),
		);
	}

	// Candidate mention bumps.
	for (const b of plan.candidateBumps) {
		stmts.push(
			env.DB.prepare("UPDATE candidates SET mentions = ? WHERE id = ? AND user_id = ?").bind(
				b.mentions,
				b.id,
				userId,
			),
		);
	}

	if (stmts.length > 0) {
		await env.DB.batch(stmts); // atomic; throws on failure
	}

	// Store embeddings for new nodes (best-effort, after the source of truth is committed).
	for (const n of plan.newNodes) {
		const values = await embed(env, config, `${n.label} ${n.summary ?? ""}`.trim());
		await upsertNodeVector(env, config, {
			userId,
			nodeId: n.id,
			values,
			label: n.label,
			category: n.category,
		});
	}

	return { affectedNodeIds: [...plan.affectedNodeIds], newNodes: plan.newNodes };
}
