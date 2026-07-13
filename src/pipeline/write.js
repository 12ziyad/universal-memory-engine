/**
 * Write the approved plan to D1 in one atomic batch, then store new node
 * embeddings in Vectorize (best-effort). History is appended, never rewritten.
 *
 * Returns { affectedNodeIds, newNodes } so Pass 2 knows what to refresh.
 * Throws if the D1 batch fails — the caller then keeps the chunk and does NOT
 * advance the checkpoint.
 */

import { embed } from "../lib/embeddings.js";
import { newId } from "../lib/ids.js";
import { upsertNodeVector } from "../lib/vectorize.js";

export async function writeApproved(env, config, userId, plan = {}) {
	const stmts = [];
	const commitEffects = [];
	const fallbackEffects = [];
	const newNodes = plan.newNodes ?? [];
	const nodeStateUpdates = plan.nodeStateUpdates ?? [];
	const nodeTouches = plan.nodeTouches ?? [];
	const nodeAliasUpdates = plan.nodeAliasUpdates ?? [];
	const nodeAliasAdds = plan.nodeAliasAdds ?? [];
	const legacyIdentityClaims = plan.identityClaims ?? [];
	const primaryIdentityClaims = plan.primaryIdentityClaims ?? legacyIdentityClaims.filter((claim) =>
		newNodes.some((node) => node.id === claim?.node_id && node.identity_key === claim?.canonical_key));
	const aliasIdentityClaims = plan.aliasIdentityClaims ?? legacyIdentityClaims.filter((claim) =>
		!primaryIdentityClaims.includes(claim));
	const identityClaims = [...primaryIdentityClaims, ...aliasIdentityClaims];
	const correctionGuards = plan.correctionGuards ?? [];
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
	const topicCommunityMemberships = plan.topicCommunityMemberships ?? [];
	const newPageIds = new Set(newPages.map((page) => page?.id).filter(Boolean));
	const pageUpdateIds = new Set(pageUpdates.map((update) => update?.page?.id).filter(Boolean));
	const newNodeById = new Map(newNodes.map((node) => [node?.id, node]).filter(([id]) => Boolean(id)));

	function trackNext(effect) {
		commitEffects.push({ statementIndex: stmts.length, ...effect });
	}

	function correctionGuard(item, { includeReplacement = false } = {}) {
		const key = item?.manual_correction_guard_key;
		const token = item?.manual_correction_guard_token;
		const clauses = [];
		const bindings = [];
		if (key && token) {
			clauses.push(`EXISTS (
			 SELECT 1 FROM manual_fact_identities correction_guard
			 WHERE correction_guard.user_id = ? AND correction_guard.fact_key = ?
			  AND correction_guard.object_kind = 'correction_guard' AND correction_guard.object_id = ?
			)`);
			bindings.push(userId, key, token);
		}
		if (includeReplacement && item?.manual_correction_guard_fact_key) {
			clauses.push(`EXISTS (
			 SELECT 1 FROM manual_fact_identities replacement_claim
			 WHERE replacement_claim.user_id = ? AND replacement_claim.fact_key = ?
			  AND (? IS NULL OR replacement_claim.object_id = ?)
			)`);
			bindings.push(
				userId,
				item.manual_correction_guard_fact_key,
				item.manual_correction_guard_object_id ?? null,
				item.manual_correction_guard_object_id ?? null,
			);
		}
		return {
			sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "",
			bindings,
		};
	}

	function provisionalPageNodeGuard(page) {
		const node = newNodeById.get(page?.node_id);
		if (!node) return { sql: "", bindings: [] };
		const clauses = [
			`EXISTS (
			 SELECT 1 FROM nodes
			 WHERE id = ? AND user_id = ?
			  AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
			)`,
		];
		const bindings = [node.id, userId];
		if (node.identity_key) {
			clauses.push(
				`EXISTS (
				 SELECT 1 FROM manual_node_identities
				 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				)`,
			);
			bindings.push(userId, node.identity_key, node.id);
		}
		return { sql: ` AND ${clauses.join(" AND ")}`, bindings };
	}

	function primaryNewPageIdentityKey(page) {
		return page?.identity_key ?? pageClaims.find((claim) => claim?.page_id === page?.id)?.identity_key ?? null;
	}

	function queueManualFactClaim(item, objectKind, ownerNodeId, relatedNodeId = null) {
		if (!item?.manual_fact_key) return false;
		const now = item.created_at ?? Date.now();
		const guard = correctionGuard(item, {
			includeReplacement: item.manual_correction_requires_fact_claim === true,
		});
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_fact_identities
					(user_id, fact_key, object_kind, object_id, owner_node_id, related_node_id, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
						 SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
						 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					   )
					   AND (? IS NULL OR EXISTS (
						 SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
						 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					   ))
					   AND (? IS NULL OR EXISTS (
						 SELECT 1 FROM manual_node_identities
						 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
					   ))
					   ${guard.sql}
					   AND (? IS NULL OR EXISTS (
						 SELECT 1 FROM manual_node_identities
						 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
					   ))
				 ON CONFLICT(user_id, fact_key) DO UPDATE SET
					object_id = CASE WHEN
						(manual_fact_identities.object_kind = 'slice' AND EXISTS (
							SELECT 1 FROM slices WHERE id = manual_fact_identities.object_id AND user_id = manual_fact_identities.user_id
							 AND deleted_at IS NULL AND is_current = 1
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
				item.manual_identity_key ?? null,
				userId,
				item.manual_identity_key ?? null,
				ownerNodeId,
				...guard.bindings,
				item.manual_related_identity_key ?? null,
				userId,
				item.manual_related_identity_key ?? null,
				relatedNodeId,
			),
		);
		return true;
	}

	// A correction guard serializes all replacements of one exact active object.
	// It is acquired and released inside this D1 batch; every correction-only
	// write below checks the token. Losing concurrent plans therefore leave the
	// old fact active and cannot strand a target node or support fact.
	for (const guard of correctionGuards) {
		if (!guard?.guard_key || !guard?.token || !guard?.old_object_id || !guard?.owner_node_id) continue;
		const now = guard.created_at ?? Date.now();
		const oldObjectExists = guard.object_kind === "slice"
			? `EXISTS (
				 SELECT 1 FROM slices old_object
				 WHERE old_object.id = ? AND old_object.user_id = ? AND old_object.node_id = ?
				  AND old_object.deleted_at IS NULL AND old_object.is_current = 1
			   )`
			: `EXISTS (
				 SELECT 1 FROM edges old_object
				 WHERE old_object.id = ? AND old_object.user_id = ? AND old_object.from_node = ?
				  AND old_object.deleted_at IS NULL
			   )`;
		trackNext({ kind: "correctionGuards", id: `${guard.guard_key}:${guard.token}`, requiresResult: true });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_fact_identities
					(user_id, fact_key, object_kind, object_id, owner_node_id, related_node_id, created_at, updated_at)
				 SELECT ?, ?, 'correction_guard', ?, ?, ?, ?, ?
				 WHERE ${oldObjectExists}
				 ON CONFLICT(user_id, fact_key) DO NOTHING
				 RETURNING fact_key, object_id`,
			).bind(
				userId,
				guard.guard_key,
				guard.token,
				guard.owner_node_id,
				guard.related_node_id ?? null,
				now,
				now,
				guard.old_object_id,
				userId,
				guard.owner_node_id,
			),
		);
	}

	// Claim canonical manual identities first. Concurrent batches serialize on the
	// primary key; the winner's node id is never overwritten by a losing batch.
	for (const claim of primaryIdentityClaims) {
		if (!claim?.canonical_key || !claim?.node_id) continue;
		const now = claim.created_at ?? Date.now();
		const guard = correctionGuard(claim);
		trackNext({ kind: "identityClaims", id: `${claim.canonical_key}:${claim.node_id}` });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_node_identities
					(user_id, canonical_key, node_id, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ? WHERE 1 = 1 ${guard.sql}
				 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at
				 WHERE manual_node_identities.node_id = excluded.node_id`,
			).bind(userId, claim.canonical_key, claim.node_id, now, now, ...guard.bindings),
		);
	}

	// New nodes. Manual nodes are inserted only when this batch owns the canonical
	// identity claim, preventing concurrent duplicate creation.
	for (const n of newNodes) {
		const guarded = Boolean(n.identity_key);
		const correction = correctionGuard(n);
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
		if (guarded) values.push(userId, n.identity_key, n.id, ...correction.bindings);
		// Track both guarded MCP nodes and ordinary API/AutoMode nodes. Otherwise a
		// later tracked effect makes `committed` non-null and the embedding loop can
		// incorrectly treat a successful unguarded insert as a losing manual claim.
		trackNext({ kind: "nodes", id: n.id });
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
					   ) ${correction.sql}`
					: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
			).bind(...values),
		);
	}

	// Secondary canonical/alias claims are valid only after their target node
	// exists. This prevents a losing concurrent new-node plan from leaving a
	// dangling alias claim that points at a node which was never inserted.
	for (const claim of aliasIdentityClaims) {
		if (!claim?.canonical_key || !claim?.node_id) continue;
		const now = claim.created_at ?? Date.now();
		const guard = correctionGuard(claim);
		trackNext({ kind: "identityClaims", id: `${claim.canonical_key}:${claim.node_id}` });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_node_identities
					(user_id, canonical_key, node_id, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
					AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				 ) ${guard.sql}
				 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at
				 WHERE manual_node_identities.node_id = excluded.node_id`,
			).bind(userId, claim.canonical_key, claim.node_id, now, now, claim.node_id, userId, ...guard.bindings),
		);
	}

	// Node state changes (lifecycle events) — also bumps updated_at.
	for (const u of nodeStateUpdates) {
		const incrementSession = u.increment_session ? 1 : 0;
		const guard = correctionGuard(u, { includeReplacement: true });
		trackNext({ kind: "nodeStateUpdates", id: u.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes
				 SET state = ?, updated_at = ?, last_seen_at = ?,
					 mention_count = COALESCE(mention_count, 0) + 1,
					 session_count = COALESCE(session_count, 0) + ?,
					 heat_score = COALESCE(heat_score, 0) + 1
				 WHERE id = ? AND user_id = ?
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				   )) ${guard.sql}`,
			).bind(
				u.state,
				Date.now(),
				Date.now(),
				incrementSession,
				u.id,
				userId,
				u.manual_identity_key ?? null,
				userId,
				u.manual_identity_key ?? null,
				u.id,
				...guard.bindings,
			),
		);
	}

	// Canonical-match touches (no state change, just freshen updated_at).
	for (const touch of nodeTouches) {
		const id = typeof touch === "string" ? touch : touch?.id;
		if (!id || nodeStateUpdates.some((u) => u.id === id)) continue;
		const incrementSession = typeof touch === "object" && touch?.increment_session ? 1 : 0;
		const guard = correctionGuard(touch, { includeReplacement: true });
		trackNext({ kind: "nodeTouches", id });
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes
				 SET updated_at = ?, last_seen_at = ?, mention_count = COALESCE(mention_count, 0) + 1,
					 session_count = COALESCE(session_count, 0) + ?,
					 heat_score = COALESCE(heat_score, 0) + 1
				 WHERE id = ? AND user_id = ?
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				   )) ${guard.sql}`,
			).bind(
				Date.now(),
				Date.now(),
				incrementSession,
				id,
				userId,
				touch?.manual_identity_key ?? null,
				userId,
				touch?.manual_identity_key ?? null,
				id,
				...guard.bindings,
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
		const guard = correctionGuard(update, { includeReplacement: true });
		trackNext({ kind: "aliasBulk", id: update.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes SET aliases_json = ?, updated_at = ?
				 WHERE id = ? AND user_id = ?
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				   )) ${guard.sql}`,
			).bind(
				aliasesJson, Date.now(), update.id, userId,
				update.identity_key ?? null, userId, update.identity_key ?? null, update.id,
				...guard.bindings,
			),
		);
	}

	// Verified aliases append independently so concurrent disjoint aliases cannot
	// overwrite one another's JSON arrays. The alias identity claim is authority.
	for (const addition of nodeAliasAdds) {
		if (!addition?.id || !addition?.alias || !addition?.identity_key) continue;
		const guard = correctionGuard(addition, { includeReplacement: true });
		trackNext({ kind: "aliases", id: `${addition.id}:${addition.identity_key}` });
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes
				 SET aliases_json = json_insert(
					CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END,
					'$[#]', ?
				 ), updated_at = ?
				 WHERE id = ? AND user_id = ?
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				   AND EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				   )
				   AND NOT EXISTS (
					 SELECT 1 FROM json_each(CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END)
					 WHERE lower(trim(CAST(value AS TEXT))) = lower(trim(?))
				   ) ${guard.sql}`,
			).bind(
				addition.alias, Date.now(), addition.id, userId,
				userId, addition.identity_key, addition.id, addition.alias,
				...guard.bindings,
			),
		);
	}

	// Manual fact claims must run after node creation and before any supersede or
	// fact insert. A losing concurrent save can then reinforce the winner without
	// clearing the winner's current single-valued slice.
	const manualFactGuards = new Map();
	for (const edge of newEdges) {
		manualFactGuards.set(edge.id, queueManualFactClaim(edge, "edge", edge.from_node, edge.to_node));
	}
	for (const slice of newSlices) {
		manualFactGuards.set(slice.id, queueManualFactClaim(slice, "slice", slice.node_id));
	}
	for (const event of newEvents) {
		manualFactGuards.set(event.id, queueManualFactClaim(event, "event", event.node_id));
	}

	// Supersede older single-valued slices BEFORE inserting the new current one.
	for (const s of sliceSupersede) {
		const guarded = Boolean(s.replacement_id);
		const guard = correctionGuard(s);
		trackNext({ kind: "sliceSuperseded", id: s.id ?? `${s.node_id}:${s.kind}` });
		stmts.push(
			env.DB.prepare(
				`UPDATE slices SET is_current = 0
				 WHERE user_id = ? AND node_id = ? AND kind = ? AND is_current = 1
				   AND (? IS NULL OR id = ?)
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_fact_identities
					 WHERE user_id = ? AND object_kind = 'slice' AND object_id = ?
				   ) OR EXISTS (
					 SELECT 1 FROM slices replacement
					 WHERE replacement.id = ? AND replacement.user_id = ?
					  AND replacement.deleted_at IS NULL AND replacement.is_current = 1
				   )) ${guard.sql}`,
			).bind(
				userId,
				s.node_id,
				s.kind,
				s.id ?? null,
				s.id ?? null,
				guarded ? s.replacement_id : null,
				userId,
				s.replacement_id ?? null,
				s.replacement_id ?? null,
				userId,
				...guard.bindings,
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
			const guard = correctionGuard(s, { includeReplacement: true });
			fallbackEffects.push({ statementIndex: stmts.length, kind: "slice", plannedId: s.id });
			stmts.push(
				env.DB.prepare(
					`UPDATE slices
					 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
					 WHERE id = (
						 SELECT object_id FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = 'slice'
					 ) AND user_id = ? AND id != ? ${guard.sql}
					 RETURNING id, node_id, kind`,
				).bind(Date.now(), userId, s.manual_fact_key, userId, s.id, ...guard.bindings),
			);
		}
	}

	for (const s of sliceTouches) {
		const guard = correctionGuard(s, { includeReplacement: true });
		trackNext({ kind: "sliceTouches", id: s.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE slices SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = slices.node_id
				   )) ${guard.sql}`,
			).bind(
				Date.now(), s.id, userId, s.manual_identity_key ?? null, userId, s.manual_identity_key ?? null,
				...guard.bindings,
			),
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
			const guard = correctionGuard(e, { includeReplacement: true });
			fallbackEffects.push({ statementIndex: stmts.length, kind: "event", plannedId: e.id });
			stmts.push(
				env.DB.prepare(
					`UPDATE events
					 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
					 WHERE id = (
						 SELECT object_id FROM manual_fact_identities
						 WHERE user_id = ? AND fact_key = ? AND object_kind = 'event'
					 ) AND user_id = ? AND id != ? ${guard.sql}
					 RETURNING id, node_id, action`,
				).bind(Date.now(), userId, e.manual_fact_key, userId, e.id, ...guard.bindings),
			);
		}
	}

	for (const e of eventTouches) {
		const guard = correctionGuard(e, { includeReplacement: true });
		trackNext({ kind: "eventTouches", id: e.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE events SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1, last_seen_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = events.node_id
				   )) ${guard.sql}`,
			).bind(
				Date.now(), e.id, userId, e.manual_identity_key ?? null, userId, e.manual_identity_key ?? null,
				...guard.bindings,
			),
		);
	}

	// Relationship corrections retire the exact old edge while preserving its row
	// as history. Release the manual fact claim so a future correction can safely
	// reactivate the same canonical relationship with a new active edge.
	for (const edge of edgeSupersede) {
		if (!edge?.id) continue;
		const guard = correctionGuard(edge);
		const replacementGuardSql = edge.replacement_edge_id
			? ` AND (
				 EXISTS (
				  SELECT 1 FROM manual_fact_identities replacement_claim
				  WHERE replacement_claim.user_id = ? AND replacement_claim.fact_key = ?
				   AND replacement_claim.object_kind = 'edge' AND replacement_claim.object_id = ?
				 ) OR EXISTS (
				  SELECT 1 FROM edges replacement
				  WHERE replacement.id = ? AND replacement.user_id = ? AND replacement.deleted_at IS NULL
				 )
			   )`
			: "";
		const replacementBindings = edge.replacement_edge_id
			? [userId, edge.replacement_fact_key ?? null, edge.replacement_edge_id, edge.replacement_edge_id, userId]
			: [];
		trackNext({ kind: "edgeSuperseded", id: edge.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE edges SET deleted_at = ?, last_seen_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
				 ${guard.sql} ${replacementGuardSql}`,
			).bind(Date.now(), Date.now(), edge.id, userId, ...guard.bindings, ...replacementBindings),
		);
		stmts.push(
			env.DB.prepare(
				`DELETE FROM manual_fact_identities
				 WHERE user_id = ? AND object_kind = 'edge' AND object_id = ?
				  AND NOT EXISTS (
				   SELECT 1 FROM edges old_edge
				   WHERE old_edge.id = ? AND old_edge.user_id = ? AND old_edge.deleted_at IS NULL
				  ) ${guard.sql}`,
			).bind(userId, edge.id, edge.id, userId, ...guard.bindings),
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
			const guard = correctionGuard(ed, { includeReplacement: true });
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
					 ) AND user_id = ? AND id != ? ${guard.sql}
					 RETURNING id, from_node, to_node, type`,
				).bind(Date.now(), userId, ed.manual_fact_key, userId, ed.id, ...guard.bindings),
			);
		}
	}

	for (const ed of edgeTouches) {
		const guard = correctionGuard(ed, { includeReplacement: true });
		trackNext({ kind: "edgeTouches", id: ed.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE edges
				 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
					 weight = COALESCE(weight, 1) + 0.25,
					 evidence_count = COALESCE(evidence_count, 0) + 1,
					 last_seen_at = ?
				 WHERE id = ? AND user_id = ? AND deleted_at IS NULL
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = edges.from_node
				   ))
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = edges.to_node
				   )) ${guard.sql}`,
			).bind(
				Date.now(), ed.id, userId,
				ed.manual_identity_key ?? null, userId, ed.manual_identity_key ?? null,
				ed.manual_related_identity_key ?? null, userId, ed.manual_related_identity_key ?? null,
				...guard.bindings,
			),
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
				   ))
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
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
				resolution.verified_identity_key ?? null,
				userId,
				resolution.verified_identity_key ?? null,
				resolution.node_id ?? null,
			),
		);
	}

	// Topic communities are contextual organization, never graph edges. Upsert
	// the canonical community, then select its winning persisted id for membership.
	for (const membership of topicCommunityMemberships) {
		if (!membership?.canonical_key || !membership?.node_id) continue;
		const now = membership.updated_at ?? membership.created_at ?? Date.now();
		const communityId = membership.community_id ?? newId("community");
		const guard = correctionGuard(membership, { includeReplacement: true });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO topic_communities
				 (id, user_id, canonical_key, label, summary, confidence, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
					  SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
					   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					 )
					 AND (? IS NULL OR EXISTS (
					  SELECT 1 FROM manual_node_identities
					  WHERE user_id = ? AND canonical_key = ? AND node_id = ?
					 )) ${guard.sql}
					 ON CONFLICT(user_id, canonical_key) DO UPDATE SET
				  label = excluded.label,
				  summary = COALESCE(excluded.summary, topic_communities.summary),
				  confidence = MAX(COALESCE(topic_communities.confidence, 0), COALESCE(excluded.confidence, 0)),
				  updated_at = excluded.updated_at`,
			).bind(
				communityId, userId, membership.canonical_key,
				membership.label ?? membership.canonical_key, membership.summary ?? null,
				membership.confidence ?? null, now, now,
				membership.node_id, userId,
				membership.verified_identity_key ?? null, userId,
				membership.verified_identity_key ?? null, membership.node_id,
				...guard.bindings,
			),
		);
		trackNext({ kind: "communities", id: `${membership.node_id}:${membership.canonical_key}` });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO node_topic_communities
				 (user_id, community_id, node_id, confidence, source_packet_id, created_at, updated_at)
				 SELECT ?, community.id, ?, ?, ?, ?, ?
				 FROM topic_communities AS community
				 WHERE community.user_id = ? AND community.canonical_key = ?
				   AND EXISTS (
					 SELECT 1 FROM nodes WHERE id = ? AND user_id = ?
					 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				   )
				   AND (? IS NULL OR EXISTS (
					 SELECT 1 FROM manual_node_identities
					 WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				   )) ${guard.sql}
				 ON CONFLICT(user_id, community_id, node_id) DO UPDATE SET
				  confidence = MAX(COALESCE(node_topic_communities.confidence, 0), COALESCE(excluded.confidence, 0)),
				  source_packet_id = COALESCE(excluded.source_packet_id, node_topic_communities.source_packet_id),
				  updated_at = excluded.updated_at`,
			).bind(
				userId, membership.node_id, membership.confidence ?? null,
				membership.source_packet_id ?? null, now, now,
				userId, membership.canonical_key, membership.node_id, userId,
				membership.verified_identity_key ?? null, userId,
				membership.verified_identity_key ?? null, membership.node_id,
				...guard.bindings,
			),
		);
	}

	// Claim only each new page's primary identity before inserting it. Secondary
	// aliases are learned after the page exists, so a caller that loses the
	// primary claim cannot leave dangling identities pointing at a missing page.
	for (const claim of pageClaims.filter((item) => {
		if (!newPageIds.has(item?.page_id)) return false;
		const page = newPages.find((candidate) => candidate?.id === item.page_id);
		const primaryKey = primaryNewPageIdentityKey(page);
		return item.identity_key === primaryKey;
	})) {
		if (!claim?.identity_key || !claim?.page_id) continue;
		const now = claim.created_at ?? Date.now();
		const expectedWriteEpoch = Number(claim.expected_write_epoch ?? 0);
		const page = newPages.find((item) => item?.id === claim.page_id);
		const provisionalNode = provisionalPageNodeGuard(page);
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_page_write_epochs (user_id, epoch, updated_at)
				 VALUES (?, 0, ?)
				 ON CONFLICT(user_id) DO NOTHING`,
			).bind(userId, now),
		);
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_page_identities
					(user_id, canonical_key, page_id, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?
					 WHERE EXISTS (
					 SELECT 1 FROM manual_page_write_epochs
					 WHERE user_id = ? AND epoch = ?
					 ) ${provisionalNode.sql}
					 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at
					 WHERE manual_page_identities.page_id = excluded.page_id`,
			).bind(
				userId,
				claim.identity_key,
				claim.page_id,
				now,
				now,
				userId,
				expectedWriteEpoch,
				...provisionalNode.bindings,
			),
		);
	}

	// Optional MCP-manual page writes participate in this graph transaction.
	for (const page of newPages) {
		const now = page.created_at ?? Date.now();
		const provisionalNode = provisionalPageNodeGuard(page);
		const primaryIdentityKey = primaryNewPageIdentityKey(page);
		const insertGuards = [];
		const insertGuardBindings = [];
		if (primaryIdentityKey) {
			insertGuards.push(`EXISTS (
			 SELECT 1 FROM manual_page_identities
			 WHERE user_id = ? AND canonical_key = ? AND page_id = ?
			)`);
			insertGuardBindings.push(userId, primaryIdentityKey, page.id);
		}
		if (provisionalNode.sql) {
			insertGuards.push(provisionalNode.sql.replace(/^\s*AND\s+/, ""));
			insertGuardBindings.push(...provisionalNode.bindings);
		}
		const guarded = insertGuards.length > 0;
		const pageValues = [
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
		const placeholders = pageValues.map(() => "?").join(", ");
		const values = guarded ? [...pageValues, ...insertGuardBindings] : pageValues;
		trackNext({ kind: "pages", id: page.id });
		stmts.push(
			env.DB.prepare(
				`INSERT INTO memory_pages
					(id, user_id, node_id, node_kind, source_mode, title, canonical_title, topic_filter,
					 short_summary, full_markdown, sections_json, key_points_json, decisions_json,
					 next_steps_json, related_concepts_json, evidence_json, source_thread_id,
					 source_conversation_id, source_packet_id, input_hash, idempotency_key, extraction_run_id,
					 receipt_id,
					 created_at, updated_at, last_seen_at, heat_score, confidence, health_state, importance_class,
					 cluster, role_type)
					 ${guarded
					? `SELECT ${placeholders}
					   WHERE ${insertGuards.join(" AND ")}`
					: `VALUES (${placeholders})`}
				 ON CONFLICT(id) DO NOTHING`,
			).bind(...values),
		);
		if (guarded) {
			stmts.push(
				env.DB.prepare(
					`INSERT INTO manual_page_versions
						(user_id, page_id, revision, write_token, updated_at)
					 SELECT ?, ?, 0, NULL, ?
					 WHERE EXISTS (
						 SELECT 1 FROM memory_pages
						 WHERE id = ? AND user_id = ?
						   AND source_mode = 'manual_collect'
						   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					 )
					 ON CONFLICT(user_id, page_id) DO NOTHING`,
				).bind(userId, page.id, now, page.id, userId),
			);
		}
		for (const claim of pageClaims.filter((item) =>
			item?.page_id === page.id && item.identity_key && item.identity_key !== primaryIdentityKey)) {
			const claimNow = claim.created_at ?? now;
			const expectedWriteEpoch = Number(claim.expected_write_epoch ?? 0);
			stmts.push(
				env.DB.prepare(
					`INSERT INTO manual_page_identities
					 (user_id, canonical_key, page_id, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?
					 WHERE EXISTS (
					  SELECT 1 FROM memory_pages
					  WHERE id = ? AND user_id = ? AND source_mode = 'manual_collect'
					   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					 ) AND EXISTS (
					  SELECT 1 FROM manual_page_write_epochs WHERE user_id = ? AND epoch = ?
					 )
					 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at
					 WHERE manual_page_identities.page_id = excluded.page_id`,
				).bind(
					userId, claim.identity_key, page.id, claimNow, claimNow,
					page.id, userId, userId, expectedWriteEpoch,
				),
			);
		}
	}

	for (const update of pageUpdates) {
		const page = update?.page;
		if (!page?.id) continue;
		const now = update.now ?? Date.now();
		const expectedRevision = Number(update.expected_revision ?? 0);
		const nextRevision = expectedRevision + 1;
		const expectedUpdatedAt = update.expected_updated_at ?? null;
		const expectedInputHash = update.expected_input_hash ?? null;
		const expectedWriteEpoch = Number(update.expected_write_epoch ?? 0);
		const writeToken = update.write_token ?? newId("page_write");
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_page_write_epochs (user_id, epoch, updated_at)
				 VALUES (?, 0, ?)
				 ON CONFLICT(user_id) DO NOTHING`,
			).bind(userId, now),
		);
		// Legacy pages may predate the version ledger. Establish revision zero only
		// while the active page still exists, then let exactly one expected-revision
		// writer claim the next revision and its own unguessable token.
		stmts.push(
			env.DB.prepare(
				`INSERT INTO manual_page_versions
					(user_id, page_id, revision, write_token, updated_at)
				 SELECT ?, ?, 0, NULL, COALESCE(updated_at, created_at, ?)
				 FROM memory_pages
				 WHERE id = ? AND user_id = ?
				   AND source_mode = 'manual_collect'
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				 ON CONFLICT(user_id, page_id) DO NOTHING`,
			).bind(userId, page.id, now, page.id, userId),
		);
		stmts.push(
			env.DB.prepare(
				`UPDATE manual_page_versions
				 SET revision = ?, write_token = ?, updated_at = ?
				 WHERE user_id = ? AND page_id = ? AND revision = ?
				   AND EXISTS (
					 SELECT 1 FROM manual_page_write_epochs
					 WHERE user_id = ? AND epoch = ?
				   )
				   AND EXISTS (
					 SELECT 1 FROM memory_pages
					 WHERE id = ? AND user_id = ?
					   AND source_mode = 'manual_collect'
					   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					   AND ((? IS NULL AND updated_at IS NULL) OR updated_at = ?)
					   AND ((? IS NULL AND input_hash IS NULL) OR input_hash = ?)
				   )`,
			).bind(
				nextRevision,
				writeToken,
				now,
				userId,
				page.id,
				expectedRevision,
				userId,
				expectedWriteEpoch,
				page.id,
				userId,
				expectedUpdatedAt,
				expectedUpdatedAt,
				expectedInputHash,
				expectedInputHash,
			),
		);
		trackNext({ kind: "pageUpdates", id: page.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE memory_pages SET
					node_id = COALESCE(node_id, ?),
					title = ?, canonical_title = ?, topic_filter = ?, short_summary = ?, full_markdown = ?,
					sections_json = ?, key_points_json = ?, decisions_json = ?, next_steps_json = ?,
					related_concepts_json = ?, evidence_json = ?, source_thread_id = COALESCE(source_thread_id, ?),
					source_conversation_id = COALESCE(?, source_conversation_id),
					source_packet_id = ?, input_hash = ?, idempotency_key = ?,
					extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
					updated_at = ?, last_seen_at = ?, heat_score = COALESCE(heat_score, 0) + 1,
					confidence = MAX(COALESCE(confidence, 0), ?), importance_class = ?, cluster = ?
					 WHERE id = ? AND user_id = ?
					   AND source_mode = 'manual_collect'
					   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
					   AND ((? IS NULL AND updated_at IS NULL) OR updated_at = ?)
					   AND ((? IS NULL AND input_hash IS NULL) OR input_hash = ?)
					   AND EXISTS (
						 SELECT 1 FROM manual_page_versions
						 WHERE user_id = ? AND page_id = ? AND revision = ? AND write_token = ?
					   )`,
			).bind(
				page.node_id ?? null,
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
				expectedUpdatedAt,
				expectedUpdatedAt,
				expectedInputHash,
				expectedInputHash,
				userId,
				page.id,
				nextRevision,
				writeToken,
			),
		);
		// A page update may learn additional stable identity keys. Those claims are
		// part of the update itself: only the writer that acquired this revision's
		// single-use token may persist them. A stale concurrent plan therefore cannot
		// leave claims behind after losing the page CAS.
		for (const claim of pageClaims.filter((item) => item?.page_id === page.id && pageUpdateIds.has(item?.page_id))) {
			if (!claim?.identity_key) continue;
			const claimNow = claim.created_at ?? now;
			stmts.push(
				env.DB.prepare(
					`INSERT INTO manual_page_identities
						(user_id, canonical_key, page_id, created_at, updated_at)
					 SELECT ?, ?, ?, ?, ?
					 WHERE EXISTS (
						 SELECT 1 FROM manual_page_versions
						 WHERE user_id = ? AND page_id = ? AND revision = ? AND write_token = ?
					 )
					 ON CONFLICT(user_id, canonical_key) DO UPDATE SET updated_at = excluded.updated_at
					 WHERE manual_page_identities.page_id = excluded.page_id`,
				).bind(
					userId,
					claim.identity_key,
					page.id,
					claimNow,
					claimNow,
					userId,
					page.id,
					nextRevision,
					writeToken,
				),
			);
		}
		// The claim token is a single-batch capability, not durable permission to
		// replay the page UPDATE. Clear it after the guarded write so executing an
		// identical stale plan again cannot reuse a previously successful token.
		stmts.push(
			env.DB.prepare(
				`UPDATE manual_page_versions
				 SET write_token = NULL, updated_at = ?
				 WHERE user_id = ? AND page_id = ? AND revision = ? AND write_token = ?`,
			).bind(now, userId, page.id, nextRevision, writeToken),
		);
	}

	// Deterministic summaries are supplied by the manual planner after it has
	// simulated the post-merge fact set, then committed with those facts here.
	for (const update of nodeSummaryUpdates) {
		if (!update?.id) continue;
		const guard = correctionGuard(update, { includeReplacement: true });
		trackNext({ kind: "nodeSummaries", id: update.id });
		stmts.push(
			env.DB.prepare(
				`UPDATE nodes SET summary = COALESCE((
				  SELECT substr(nodes.label || ': ' || group_concat(fact_text, '; '), 1, 320)
				  FROM (
				   SELECT fact_text
				   FROM (
				    SELECT trim(text) AS fact_text, 0 AS source_rank, created_at AS fact_time, id
				    FROM slices
				    WHERE user_id = ? AND node_id = ? AND is_current = 1 AND deleted_at IS NULL
				    UNION ALL
				    SELECT trim(text) AS fact_text, 1 AS source_rank,
				     COALESCE(happened_at, created_at) AS fact_time, id
				    FROM events
				    WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL
				   ) AS committed_facts
				   WHERE fact_text <> ''
				   GROUP BY lower(fact_text)
				   ORDER BY MIN(source_rank), MAX(fact_time) DESC, MIN(id)
				   LIMIT 3
				  ) AS summary_facts
				 ), COALESCE(?, summary)), cluster = COALESCE(?, cluster), updated_at = ?
				 WHERE id = ? AND user_id = ?
				  AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				  AND (? IS NULL OR EXISTS (
				   SELECT 1 FROM manual_node_identities
				   WHERE user_id = ? AND canonical_key = ? AND node_id = ?
				  )) ${guard.sql}`,
			).bind(
				userId, update.id, userId, update.id,
				update.summary ?? null, update.cluster ?? null, Date.now(), update.id, userId,
				update.manual_identity_key ?? null, userId, update.manual_identity_key ?? null, update.id,
				...guard.bindings,
			),
		);
	}

	// Transient correction guards never survive a successful batch. If any later
	// statement fails, D1 rolls the whole batch back, including acquisition.
	for (const guard of correctionGuards) {
		if (!guard?.guard_key || !guard?.token) continue;
		stmts.push(
			env.DB.prepare(
				`DELETE FROM manual_fact_identities
				 WHERE user_id = ? AND fact_key = ? AND object_kind = 'correction_guard' AND object_id = ?`,
			).bind(userId, guard.guard_key, guard.token),
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
			aliases: [],
			identityClaims: [],
			correctionGuards: [],
			communities: [],
			nodeStateUpdates: [],
			nodeTouches: [],
			aliasBulk: [],
			nodeSummaries: [],
			sliceSuperseded: [],
			sliceTouches: [],
			eventTouches: [],
			edgeTouches: [],
			pages: [],
			pageUpdates: [],
			edgeSuperseded: [],
			reinforcements: { slices: [], events: [], edges: [] },
		};
		for (const effect of commitEffects) {
			const result = batchResults[effect.statementIndex];
			const changes = Number(result?.meta?.changes ?? 0);
			const committedEffect = effect.requiresResult
				? Boolean((result?.results ?? [])[0])
				: changes > 0;
			if (committedEffect && committed[effect.kind]) committed[effect.kind].push(effect.id);
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
	for (const n of plan.manualDerivedRefresh === true ? [] : newNodes) {
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
