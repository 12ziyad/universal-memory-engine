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
	const nodeStateUpdates = plan.nodeStateUpdates ?? [];
	const nodeTouches = plan.nodeTouches ?? [];

	// New nodes.
	for (const n of plan.newNodes) {
		stmts.push(
			env.DB.prepare(
				`INSERT INTO nodes
					(id, user_id, label, category, role, state, summary, created_at, updated_at,
					 canonical_label, aliases_json, mention_count, session_count, last_seen_at,
					 heat_score, confidence, health_state, importance_class, cluster)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				n.id,
				n.user_id,
				n.label,
				n.category,
				n.role,
				n.state,
				n.summary,
				n.created_at,
				n.updated_at,
				n.canonical_label ?? null,
				n.aliases_json ?? null,
				n.mention_count ?? 1,
				n.session_count ?? 1,
				n.last_seen_at ?? n.updated_at,
				n.heat_score ?? 1,
				n.confidence ?? null,
				n.health_state ?? "active",
				n.importance_class ?? "ordinary",
				n.cluster ?? null,
			),
		);
	}

	// Node state changes (lifecycle events) — also bumps updated_at.
	for (const u of nodeStateUpdates) {
		const incrementSession = u.increment_session ? 1 : 0;
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes
				 SET state = ?, updated_at = ?, last_seen_at = ?,
					 mention_count = COALESCE(mention_count, 0) + 1,
					 session_count = COALESCE(session_count, 0) + ?,
					 heat_score = COALESCE(heat_score, 0) + 1
				 WHERE id = ? AND user_id = ?`,
			).bind(
				u.state,
				Date.now(),
				Date.now(),
				incrementSession,
				u.id,
				userId,
			),
		);
	}

	// Canonical-match touches (no state change, just freshen updated_at).
	for (const touch of nodeTouches) {
		const id = typeof touch === "string" ? touch : touch?.id;
		if (!id || nodeStateUpdates.some((u) => u.id === id)) continue;
		const incrementSession = typeof touch === "object" && touch?.increment_session ? 1 : 0;
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes
				 SET updated_at = ?, last_seen_at = ?, mention_count = COALESCE(mention_count, 0) + 1,
					 session_count = COALESCE(session_count, 0) + ?,
					 heat_score = COALESCE(heat_score, 0) + 1
				 WHERE id = ? AND user_id = ?`,
			).bind(
				Date.now(),
				Date.now(),
				incrementSession,
				id,
				userId,
			),
		);
	}

	// Manual identity merges may add newly observed labels as aliases. Accept a
	// pre-serialized aliases_json string or an array for planner convenience.
	for (const update of plan.nodeAliasUpdates ?? []) {
		if (!update?.id) continue;
		const aliasesJson = typeof update.aliases_json === "string"
			? update.aliases_json
			: JSON.stringify(update.aliases_json ?? []);
		stmts.push(
			env.DB.prepare(
				"UPDATE nodes SET aliases_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(aliasesJson, Date.now(), update.id, userId),
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
				`INSERT INTO slices
					(id, user_id, node_id, page_id, text, kind, is_current, created_at, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(s.id, s.user_id, s.node_id, s.page_id ?? null, s.text, s.kind, s.is_current, s.created_at, s.created_at),
		);
	}

	for (const s of plan.sliceTouches) {
		stmts.push(
			env.DB.prepare(
				"UPDATE slices SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ? WHERE id = ? AND user_id = ?",
			).bind(Date.now(), s.id, userId),
		);
	}

	// New events.
	for (const e of plan.newEvents) {
		stmts.push(
			env.DB.prepare(
				`INSERT INTO events
					(id, user_id, node_id, action, text, importance, happened_at, created_at, last_seen_at, confidence)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				e.id,
				e.user_id,
				e.node_id,
				e.action,
				e.text,
				e.importance,
				e.happened_at,
				e.created_at,
				e.created_at,
				e.confidence ?? null,
			),
		);
	}

	for (const e of plan.eventTouches) {
		stmts.push(
			env.DB.prepare(
				"UPDATE events SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ? WHERE id = ? AND user_id = ?",
			).bind(Date.now(), e.id, userId),
		);
	}

	// New edges.
	for (const ed of plan.newEdges) {
		stmts.push(
			env.DB.prepare(
				`INSERT INTO edges
					(id, user_id, from_node, to_node, type, created_at, last_seen_at, weight, confidence, evidence_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				ed.id,
				ed.user_id,
				ed.from_node,
				ed.to_node,
				ed.type,
				ed.created_at,
				ed.created_at,
				ed.weight ?? 1,
				ed.confidence ?? null,
				ed.evidence_count ?? 1,
			),
		);
	}

	for (const ed of plan.edgeTouches) {
		stmts.push(
			env.DB.prepare(
				`UPDATE edges
				 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
					 weight = COALESCE(weight, 1) + 0.25,
					 evidence_count = COALESCE(evidence_count, 0) + 1,
					 last_seen_at = ?
				 WHERE id = ? AND user_id = ?`,
			).bind(Date.now(), ed.id, userId),
		);
	}

	// New candidates.
	for (const c of plan.newCandidates) {
		stmts.push(
			env.DB.prepare(
				`INSERT INTO candidates
					(id, user_id, label, strength, mentions, cluster_hint, created_at,
					 label_guess, canonical_key, role_guess, cluster_guess, confidence, status,
					 first_seen_at, last_seen_at, session_count, mention_count, evidence_json,
					 possible_parent_id, possible_existing_node_id, expires_at, reason)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				c.id,
				c.user_id,
				c.label,
				c.strength,
				c.mentions,
				c.cluster_hint,
				c.created_at,
				c.label_guess ?? c.label,
				c.canonical_key ?? null,
				c.role_guess ?? null,
				c.cluster_guess ?? c.cluster_hint ?? null,
				c.confidence ?? null,
				c.status ?? "pending",
				c.first_seen_at ?? c.created_at,
				c.last_seen_at ?? c.created_at,
				c.session_count ?? 1,
				c.mention_count ?? c.mentions ?? 1,
				c.evidence_json ?? "[]",
				c.possible_parent_id ?? null,
				c.possible_existing_node_id ?? null,
				c.expires_at ?? null,
				c.reason ?? null,
			),
		);
	}

	// Candidate mention bumps.
	for (const b of plan.candidateBumps) {
		stmts.push(
			env.DB.prepare(
				`UPDATE candidates
				 SET mentions = ?,
					 mention_count = ?,
					 session_count = COALESCE(session_count, 1) + 1,
					 last_seen_at = ?,
					 evidence_json = CASE
						WHEN ? IS NULL OR ? = '' THEN COALESCE(evidence_json, '[]')
						ELSE json_insert(COALESCE(evidence_json, '[]'), '$[#]', json_object('text', ?, 'source', 'message', 'ts', ?))
					 END
				 WHERE id = ? AND user_id = ?`,
			).bind(
				b.mentions,
				b.mentions,
				b.now ?? Date.now(),
				b.evidence ?? null,
				b.evidence ?? null,
				b.evidence ?? null,
				b.now ?? Date.now(),
				b.id,
				userId,
			),
		);
	}

	// A successful manual merge resolves matching pending candidates in the same
	// transaction as the graph write, preventing stale review rows on retries.
	for (const resolution of plan.candidateResolutions ?? []) {
		if (!resolution?.id) continue;
		stmts.push(
			env.DB.prepare(
				`UPDATE candidates
				 SET status = ?, reviewed_at = ?,
					 promoted_object_id = COALESCE(?, promoted_object_id),
					 promoted_object_kind = COALESCE(?, promoted_object_kind)
				 WHERE id = ? AND user_id = ? AND COALESCE(status, 'pending') = 'pending'`,
			).bind(
				resolution.status ?? "resolved",
				resolution.reviewed_at ?? Date.now(),
				resolution.node_id ?? null,
				resolution.node_kind ?? "node",
				resolution.id,
				userId,
			),
		);
	}

	// Optional MCP-manual page writes. These mirror the existing manual_collect
	// INSERT/UPDATE statements, but participate in this graph transaction.
	for (const page of plan.newPages ?? []) {
		const now = page.created_at ?? Date.now();
		stmts.push(
			env.DB.prepare(
				`INSERT INTO memory_pages
					(id, user_id, node_id, node_kind, source_mode, title, canonical_title, topic_filter,
					 short_summary, full_markdown, sections_json, key_points_json, decisions_json,
					 next_steps_json, related_concepts_json, evidence_json, source_thread_id,
					 source_conversation_id, source_packet_id, input_hash, idempotency_key, extraction_run_id,
					 created_at, updated_at, last_seen_at, heat_score, confidence, health_state, importance_class,
					 cluster, role_type)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				page.id,
				page.user_id ?? userId,
				page.node_id ?? null,
				page.node_kind ?? "memory_page",
				page.source_mode ?? "manual_collect",
				page.title,
				page.canonical_title,
				page.topic_filter ?? null,
				page.short_summary ?? null,
				page.full_markdown ?? null,
				page.sections_json ?? null,
				page.key_points_json ?? null,
				page.decisions_json ?? null,
				page.next_steps_json ?? null,
				page.related_concepts_json ?? null,
				page.evidence_json ?? null,
				page.source_thread_id ?? null,
				page.source_conversation_id ?? null,
				page.source_packet_id ?? null,
				page.input_hash ?? null,
				page.idempotency_key ?? null,
				page.extraction_run_id ?? null,
				now,
				page.updated_at ?? now,
				page.last_seen_at ?? now,
				page.heat_score ?? 1,
				page.confidence ?? null,
				page.health_state ?? "active",
				page.importance_class ?? "ordinary",
				page.cluster ?? null,
				page.role_type ?? "container",
			),
		);
	}

	for (const update of plan.pageUpdates ?? []) {
		const page = update?.page;
		if (!page?.id) continue;
		const now = update.now ?? Date.now();
		stmts.push(
			env.DB.prepare(
				`UPDATE memory_pages SET
					title = ?, canonical_title = ?, topic_filter = ?, short_summary = ?, full_markdown = ?,
					sections_json = ?, key_points_json = ?, decisions_json = ?, next_steps_json = ?,
					related_concepts_json = ?, evidence_json = ?, source_conversation_id = COALESCE(?, source_conversation_id),
					source_packet_id = ?, input_hash = ?, idempotency_key = ?,
					extraction_run_id = ?, updated_at = ?, last_seen_at = ?, heat_score = COALESCE(heat_score, 0) + 1,
					confidence = MAX(COALESCE(confidence, 0), ?), importance_class = ?, cluster = ?
				 WHERE id = ? AND user_id = ?`,
			).bind(
				page.title,
				page.canonical_title,
				page.topic_filter ?? null,
				page.short_summary ?? null,
				page.full_markdown ?? null,
				page.sections_json ?? null,
				page.key_points_json ?? null,
				page.decisions_json ?? null,
				page.next_steps_json ?? null,
				page.related_concepts_json ?? null,
				page.evidence_json ?? null,
				update.conversationId ?? null,
				page.source_packet_id ?? null,
				page.input_hash ?? null,
				page.idempotency_key ?? null,
				update.runId ?? page.extraction_run_id ?? null,
				now,
				now,
				page.confidence ?? 0,
				page.importance_class ?? "ordinary",
				page.cluster ?? null,
				page.id,
				userId,
			),
		);
	}

	// Deterministic summaries are supplied by the manual planner after it has
	// simulated the post-merge fact set, then committed with those facts here.
	for (const update of plan.nodeSummaryUpdates ?? []) {
		if (!update?.id) continue;
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes SET summary = ?, cluster = COALESCE(?, cluster), updated_at = ?
				 WHERE id = ? AND user_id = ?`,
			).bind(update.summary ?? null, update.cluster ?? null, Date.now(), update.id, userId),
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
