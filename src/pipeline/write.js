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

export async function writeApproved(env, config, userId, plan = {}) {
	const stmts = [];
	const commitEffects = [];
	const fallbackEffects = [];
	const newNodes = plan.newNodes ?? [];
	const nodeStateUpdates = plan.nodeStateUpdates ?? [];
	const nodeTouches = plan.nodeTouches ?? [];
	const nodeAliasUpdates = plan.nodeAliasUpdates ?? [];
	const identityClaims = plan.identityClaims ?? [];
	const sliceSupersede = plan.sliceSupersede ?? [];
	const newSlices = plan.newSlices ?? [];
	const sliceTouches = plan.sliceTouches ?? [];
	const newEvents = plan.newEvents ?? [];
	const eventTouches = plan.eventTouches ?? [];
	const newEdges = plan.newEdges ?? [];
	const edgeTouches = plan.edgeTouches ?? [];
	const edgeSupersede = plan.edgeSupersede ?? [];
	const newCandidates = plan.newCandidates ?? [];
	const candidateBumps = plan.candidateBumps ?? [];
	const candidateResolutions = plan.candidateResolutions ?? [];
	const newPages = plan.newPages ?? [];
	const pageUpdates = plan.pageUpdates ?? [];
	const pageClaims = plan.pageClaims ?? [];
	const nodeSummaryUpdates = plan.nodeSummaryUpdates ?? [];

	function trackNext(effect) {
		commitEffects.push({ statementIndex: stmts.length, ...effect });
	}

	function queueManualFactClaim(item, objectKind, ownerNodeId, relatedNodeId = null) {
		if (!item?.manual_fact_key) return false;
		const now = item.created_at ?? Date.now();
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_fact_identities
					(user_id, fact_key, object_kind, object_id, owner_node_id, related_node_id, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?)
				   AND (? IS NULL OR EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?))
				 ON CONFLICT(user_id, fact_key) DO UPDATE SET
					object_id = CASE WHEN
						(manual_fact_identities.object_kind = 'slice' AND EXISTS (
							SELECT 1 FROM slices WHERE id = manual_fact_identities.object_id AND user_id = manual_fact_identities.user_id AND deleted_at IS NULL
						)) OR
						(manual_fact_identities.object_kind = 'event' AND EXISTS (
							SELECT 1 FROM events WHERE id = manual_fact_identities.object_id AND user_id = manual_fact_identities.user_id AND deleted_at IS NULL
						)) OR
						(manual_fact_identities.object_kind = 'edge' AND EXISTS (
							SELECT 1 FROM edges WHERE id = manual_fact_identities.object_id AND user_id = manual_fact_identities.user_id AND deleted_at IS NULL
						))
					THEN manual_fact_identities.object_id ELSE excluded.object_id END,
					owner_node_id = CASE WHEN manual_fact_identities.object_id = excluded.object_id
						THEN manual_fact_identities.owner_node_id ELSE excluded.owner_node_id END,
					related_node_id = CASE WHEN manual_fact_identities.object_id = excluded.object_id
						THEN manual_fact_identities.related_node_id ELSE excluded.related_node_id END,
					updated_at = excluded.updated_at`,
			).bind(
				userId,
				item.manual_fact_key,
				objectKind,
				item.id,
				ownerNodeId,
				relatedNodeId,
				now,
				now,
				ownerNodeId,
				userId,
				relatedNodeId,
				relatedNodeId,
				userId,
			),
		);
		return true;
	}

	// Claim canonical manual identities first. Concurrent batches serialize on the
	// primary key; the winner's node id is never overwritten by a losing batch.
	for (const claim of identityClaims) {
		if (!claim?.canonical_key || !claim?.node_id) continue;
		const now = claim.created_at ?? Date.now();
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_node_identities
					(user_id, canonical_key, node_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at`,
			).bind(userId, claim.canonical_key, claim.node_id, now, now),
		);
	}

	// New nodes. Manual nodes are inserted only when this batch owns the canonical
	// identity claim, preventing concurrent duplicate creation.
	for (const n of newNodes) {
		const guarded = Boolean(n.identity_key);
		const values = [
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
		];
		if (guarded) values.push(userId, n.identity_key, n.id);
		if (guarded) trackNext({ kind: "nodes", id: n.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO nodes
					(id, user_id, label, category, role, state, summary, created_at, updated_at,
					 canonical_label, aliases_json, mention_count, session_count, last_seen_at,
					 heat_score, confidence, health_state, importance_class, cluster)
				 ${guarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (
						 SELECT 1 FROM manual_node_identities
						 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
					   )`
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
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
	for (const update of nodeAliasUpdates) {
		if (!update?.id || update.aliases_json == null) continue;
		const aliasesJson = typeof update.aliases_json === "string"
			? update.aliases_json
			: JSON.stringify(update.aliases_json ?? []);
		stmts.push(
			env.DB.prepare(
				"UPDATE nodes SET aliases_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(aliasesJson, Date.now(), update.id, userId),
		);
	}

	// Manual fact claims must run after node creation and before any supersede or
	// fact insert. A losing concurrent save can then reinforce the winner without
	// clearing the winner's current single-valued slice.
	const manualFactGuards = new Map();
	for (const slice of newSlices) {
		manualFactGuards.set(slice.id, queueManualFactClaim(slice, "slice", slice.node_id));
	}
	for (const event of newEvents) {
		manualFactGuards.set(event.id, queueManualFactClaim(event, "event", event.node_id));
	}
	for (const edge of newEdges) {
		manualFactGuards.set(edge.id, queueManualFactClaim(edge, "edge", edge.from_node, edge.to_node));
	}

	// Supersede older single-valued slices BEFORE inserting the new current one.
	for (const s of sliceSupersede) {
		const guarded = Boolean(s.replacement_id);
		stmts.push(
			env.DB.prepare(
				`UPDATE slices SET is_current = 0
				 WHERE user_id = ? AND node_id = ? AND kind = ? AND is_current = 1
				   AND (? IS NULL OR id = ?)
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_fact_identities
					 WHERE user_id = ? AND object_kind = 'slice' AND object_id = ?
				   ))`,
			).bind(
				userId,
				s.node_id,
				s.kind,
				s.id ?? null,
				s.id ?? null,
				guarded ? s.replacement_id : null,
				userId,
				s.replacement_id ?? null,
			),
		);
	}

	// New slices.
	for (const s of newSlices) {
		const factGuarded = manualFactGuards.get(s.id) === true;
		const guarded = factGuarded || identityClaims.length > 0;
		const values = [s.id, s.user_id, s.node_id, s.page_id ?? null, s.text, s.kind, s.is_current, s.created_at, s.created_at];
		if (factGuarded) values.push(userId, s.manual_fact_key, "slice", s.id);
		else if (guarded) values.push(s.node_id, userId);
		if (guarded) trackNext({ kind: "slices", id: s.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO slices
					(id, user_id, node_id, page_id, text, kind, is_current, created_at, last_seen_at)
				 ${factGuarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (
						 SELECT 1 FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = ? AND object_id = ?
					   )`
					: guarded
					? "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?)"
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
		);
		if (factGuarded) {
			fallbackEffects.push({ statementIndex: stmts.length, kind: "slice", plannedId: s.id });
			stmts.push(
				env.DB.prepare(
					`UPDATE slices
					 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
					 WHERE id = (
						 SELECT object_id FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = 'slice'
					 ) AND user_id = ? AND id != ?
					 RETURNING id, node_id, kind`,
				).bind(Date.now(), userId, s.manual_fact_key, userId, s.id),
			);
		}
	}

	for (const s of sliceTouches) {
		stmts.push(
			env.DB.prepare(
				"UPDATE slices SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ? WHERE id = ? AND user_id = ?",
			).bind(Date.now(), s.id, userId),
		);
	}

	// New events.
	for (const e of newEvents) {
		const factGuarded = manualFactGuards.get(e.id) === true;
		const guarded = factGuarded || identityClaims.length > 0;
		const values = [
			e.id, e.user_id, e.node_id, e.action, e.text, e.importance, e.happened_at, e.created_at,
			e.created_at, e.confidence ?? null,
		];
		if (factGuarded) values.push(userId, e.manual_fact_key, "event", e.id);
		else if (guarded) values.push(e.node_id, userId);
		if (guarded) trackNext({ kind: "events", id: e.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO events
					(id, user_id, node_id, action, text, importance, happened_at, created_at, last_seen_at, confidence)
				 ${factGuarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (
						 SELECT 1 FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = ? AND object_id = ?
					   )`
					: guarded
					? "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?)"
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
		);
		if (factGuarded) {
			fallbackEffects.push({ statementIndex: stmts.length, kind: "event", plannedId: e.id });
			stmts.push(
				env.DB.prepare(
					`UPDATE events
					 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
					 WHERE id = (
						 SELECT object_id FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = 'event'
					 ) AND user_id = ? AND id != ?
					 RETURNING id, node_id, action`,
				).bind(Date.now(), userId, e.manual_fact_key, userId, e.id),
			);
		}
	}

	for (const e of eventTouches) {
		stmts.push(
			env.DB.prepare(
				"UPDATE events SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ? WHERE id = ? AND user_id = ?",
			).bind(Date.now(), e.id, userId),
		);
	}

	// Relationship corrections retire the exact old edge while preserving its row
	// as history. Release the manual fact claim so a future correction can safely
	// reactivate the same canonical relationship with a new active edge.
	for (const edge of edgeSupersede) {
		if (!edge?.id) continue;
		trackNext({ kind: "edgeSuperseded", id: edge.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE edges SET deleted_at = ?, last_seen_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
			).bind(Date.now(), Date.now(), edge.id, userId),
		);
		stmts.push(
			env.DB.prepare(
				"DELETE FROM manual_fact_identities WHERE user_id = ? AND object_kind = 'edge' AND object_id = ?",
			).bind(userId, edge.id),
		);
	}

	// New edges.
	for (const ed of newEdges) {
		const factGuarded = manualFactGuards.get(ed.id) === true;
		const guarded = factGuarded || identityClaims.length > 0;
		const values = [
			ed.id, ed.user_id, ed.from_node, ed.to_node, ed.type, ed.created_at, ed.created_at,
			ed.weight ?? 1, ed.confidence ?? null, ed.evidence_count ?? 1,
		];
		if (factGuarded) values.push(userId, ed.manual_fact_key, "edge", ed.id);
		else if (guarded) values.push(ed.from_node, userId, ed.to_node, userId);
		if (guarded) trackNext({ kind: "edges", id: ed.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO edges
					(id, user_id, from_node, to_node, type, created_at, last_seen_at, weight, confidence, evidence_count)
				 ${factGuarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (
						 SELECT 1 FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = ? AND object_id = ?
					   )`
					: guarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?)
						 AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND user_id = ?)`
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
		);
		if (factGuarded) {
			fallbackEffects.push({ statementIndex: stmts.length, kind: "edge", plannedId: ed.id });
			stmts.push(
				env.DB.prepare(
					`UPDATE edges
					 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
						 weight = COALESCE(weight, 1) + 0.25,
						 evidence_count = COALESCE(evidence_count, 0) + 1,
						 last_seen_at = ?
					 WHERE id = (
						 SELECT object_id FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = 'edge'
					 ) AND user_id = ? AND id != ?
					 RETURNING id, from_node, to_node, type`,
				).bind(Date.now(), userId, ed.manual_fact_key, userId, ed.id),
			);
		}
	}

	for (const ed of edgeTouches) {
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
	for (const c of newCandidates) {
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
	for (const b of candidateBumps) {
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
	for (const resolution of candidateResolutions) {
		if (!resolution?.id) continue;
		trackNext({ kind: "candidates", id: resolution.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE candidates
				 SET status = ?, reviewed_at = ?,
					 promoted_object_id = COALESCE(?, promoted_object_id),
					 promoted_object_kind = COALESCE(?, promoted_object_kind)
				 WHERE id = ? AND user_id = ? AND COALESCE(status, 'pending') = 'pending'
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
				   ))`,
			).bind(
				resolution.status ?? "resolved",
				resolution.reviewed_at ?? Date.now(),
				resolution.node_id ?? null,
				resolution.node_kind ?? "node",
				resolution.id,
				userId,
				resolution.node_id ?? null,
				resolution.node_id ?? null,
				userId,
			),
		);
	}

	// Claim new MCP-manual page identities before inserting pages. Concurrent
	// callers keep the first page id for a topic/title and never overwrite it.
	for (const claim of pageClaims) {
		if (!claim?.identity_key || !claim?.page_id) continue;
		const now = claim.created_at ?? Date.now();
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_page_identities
					(user_id, canonical_key, page_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at`,
			).bind(userId, claim.identity_key, claim.page_id, now, now),
		);
	}

	// Optional MCP-manual page writes participate in this graph transaction.
	for (const page of newPages) {
		const now = page.created_at ?? Date.now();
		const guarded = Boolean(page.identity_key);
		const values = [
			page.id,
			userId,
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
			page.receipt_id ?? null,
			page.manual_revision ?? 0,
			now,
			page.updated_at ?? now,
			page.last_seen_at ?? now,
			page.heat_score ?? 1,
			page.confidence ?? null,
			page.health_state ?? "active",
			page.importance_class ?? "ordinary",
			page.cluster ?? null,
			page.role_type ?? "container",
		];
		if (guarded) values.push(userId, page.identity_key, page.id);
		trackNext({ kind: "pages", id: page.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO memory_pages
					(id, user_id, node_id, node_kind, source_mode, title, canonical_title, topic_filter,
					 short_summary, full_markdown, sections_json, key_points_json, decisions_json,
					 next_steps_json, related_concepts_json, evidence_json, source_thread_id,
					 source_conversation_id, source_packet_id, input_hash, idempotency_key, extraction_run_id,
					 receipt_id, manual_revision,
					 created_at, updated_at, last_seen_at, heat_score, confidence, health_state, importance_class,
					 cluster, role_type)
				 ${guarded
					? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					   WHERE EXISTS (
						 SELECT 1 FROM manual_page_identities
						 WHERE user_id = ? AND canonical_key = ? AND page_id = ?
					   )`
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
		);
	}

	for (const update of pageUpdates) {
		const page = update?.page;
		if (!page?.id) continue;
		const now = update.now ?? Date.now();
		const expectedRevision = Number(update.expected_revision ?? 0);
		const expectedUpdatedAt = update.expected_updated_at ?? null;
		trackNext({ kind: "pageUpdates", id: page.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE memory_pages SET
					title = ?, canonical_title = ?, topic_filter = ?, short_summary = ?, full_markdown = ?,
					sections_json = ?, key_points_json = ?, decisions_json = ?, next_steps_json = ?,
					related_concepts_json = ?, evidence_json = ?, source_conversation_id = COALESCE(?, source_conversation_id),
					source_packet_id = ?, input_hash = ?, idempotency_key = ?,
					extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
					manual_revision = COALESCE(manual_revision, 0) + 1,
					updated_at = ?, last_seen_at = ?, heat_score = COALESCE(heat_score, 0) + 1,
					confidence = MAX(COALESCE(confidence, 0), ?), importance_class = ?, cluster = ?
					 WHERE id = ? AND user_id = ?
					   AND COALESCE(manual_revision, 0) = ?
					   AND (? IS NULL OR updated_at = ?)`,
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
				update.conversationId ?? page.source_conversation_id ?? null,
				page.source_packet_id ?? null,
				page.input_hash ?? null,
				page.idempotency_key ?? null,
				update.runId ?? page.extraction_run_id ?? null,
				page.receipt_id ?? null,
				now,
				now,
				page.confidence ?? 0,
				page.importance_class ?? "ordinary",
				page.cluster ?? null,
				page.id,
				userId,
				expectedRevision,
				expectedUpdatedAt,
				expectedUpdatedAt,
			),
		);
	}

	// Deterministic summaries are supplied by the manual planner after it has
	// simulated the post-merge fact set, then committed with those facts here.
	for (const update of nodeSummaryUpdates) {
		if (!update?.id) continue;
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes SET summary = COALESCE(?, summary), cluster = COALESCE(?, cluster), updated_at = ?
				 WHERE id = ? AND user_id = ?`,
			).bind(update.summary ?? null, update.cluster ?? null, Date.now(), update.id, userId),
		);
	}
	// Low-level deterministic rollback hook. It is never exposed by the MCP tool
	// schema; Worker-runtime tests use it to prove the whole D1 batch rolls back.
	if (plan.testFailAtomicWrite === true) {
		stmts.push(env.DB.prepare("INSERT INTO __manual_atomic_failure__ (id) VALUES ('fail')"));
	}

	const batchResults = stmts.length > 0
		? await env.DB.batch(stmts) // atomic; throws on failure
		: [];

	// Reconcile from the atomic batch's own statement metadata. No database read
	// occurs after commit, so a transient post-commit read cannot turn a successful
	// durable write into a reported `db_write_failed` result.
	let committed = null;
	if (commitEffects.length || fallbackEffects.length) {
		committed = {
			nodes: [],
			slices: [],
			events: [],
			edges: [],
			candidates: [],
			pages: [],
			pageUpdates: [],
			edgeSuperseded: [],
			reinforcements: { slices: [], events: [], edges: [] },
		};
		for (const effect of commitEffects) {
			const result = batchResults[effect.statementIndex];
			const changes = Number(result?.meta?.changes ?? 0);
			if (changes > 0 && committed[effect.kind]) committed[effect.kind].push(effect.id);
		}
		for (const effect of fallbackEffects) {
			const result = batchResults[effect.statementIndex];
			const row = (result?.results ?? [])[0];
			if (!row?.id) continue;
			const key = `${effect.kind}s`;
			if (!committed.reinforcements[key]) continue;
			committed.reinforcements[key].push({ ...row, id: row.id });
		}
	}

	// Store embeddings for new nodes (best-effort, after the source of truth is committed).
	for (const n of newNodes) {
		if (committed && !committed.nodes.includes(n.id)) continue;
		const values = await embed(env, config, `${n.label} ${n.summary ?? ""}`.trim());
		await upsertNodeVector(env, config, {
			userId,
			nodeId: n.id,
			values,
			label: n.label,
			category: n.category,
		});
	}

	return { affectedNodeIds: [...(plan.affectedNodeIds ?? [])], newNodes, committed };
}
