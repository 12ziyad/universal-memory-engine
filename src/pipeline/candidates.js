import { getConfig } from "../config.js";
import { addSuppression, getUserNodes, storeReceipt } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import { normalizeLabel } from "../lib/text.js";
import { clusterForMemory } from "./clusters.js";
import { buildReceipt, formatReceipt } from "./receipt.js";
import { writeApproved } from "./write.js";

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function now() {
	return Date.now();
}

function planBase() {
	return {
		newNodes: [],
		nodeStateUpdates: [],
		nodeTouches: new Set(),
		sliceSupersede: [],
		newSlices: [],
		sliceTouches: [],
		newEvents: [],
		eventTouches: [],
		newEdges: [],
		edgeTouches: [],
		newCandidates: [],
		candidateBumps: [],
		affectedNodeIds: new Set(),
		autoCreated: [],
		rejected: [],
		hasWrites: true,
	};
}

function candidateLabel(row) {
	return row?.label_guess || row?.label || "Candidate";
}

function evidenceText(row) {
	const evidence = parseJsonArray(row?.evidence_json);
	return evidence.map((item) => item?.text || item?.snippet).filter(Boolean).join(" ").trim();
}

function rowToCandidate(row) {
	const evidence = parseJsonArray(row.evidence_json);
	return {
		id: row.id,
		label: row.label,
		labelGuess: row.label_guess ?? row.label,
		canonicalKey: row.canonical_key ?? normalizeLabel(row.label),
		roleGuess: row.role_guess ?? null,
		clusterGuess: row.cluster_guess ?? row.cluster_hint ?? null,
		confidence: row.confidence ?? null,
		strength: row.strength ?? "weak",
		status: row.status ?? "pending",
		projectId: row.project_id ?? null,
		projectName: row.project_name ?? null,
		firstSeenAt: row.first_seen_at ?? row.created_at ?? null,
		lastSeenAt: row.last_seen_at ?? row.created_at ?? null,
		sessionCount: row.session_count ?? 1,
		mentionCount: row.mention_count ?? row.mentions ?? 1,
		evidence,
		possibleParentId: row.possible_parent_id ?? null,
		possibleExistingNodeId: row.possible_existing_node_id ?? null,
		expiresAt: row.expires_at ?? null,
		reason: row.reason ?? null,
	};
}

async function getCandidate(env, userId, id) {
	return env.DB.prepare("SELECT * FROM candidates WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1")
		.bind(id, userId)
		.first();
}

async function markCandidate(env, userId, id, status, data = {}) {
	await env.DB.prepare(
		`UPDATE candidates
		 SET status = ?, reviewed_at = ?, promoted_object_id = COALESCE(?, promoted_object_id),
			 promoted_object_kind = COALESCE(?, promoted_object_kind),
			 suppressed_at = COALESCE(?, suppressed_at)
		 WHERE id = ? AND user_id = ?`,
	)
		.bind(
			status,
			now(),
			data.promotedObjectId ?? null,
			data.promotedObjectKind ?? null,
			data.suppressedAt ?? null,
			id,
			userId,
		)
		.run();
}

function findExistingNode(nodes, row, body = {}) {
	const id = body.nodeId ?? body.node_id ?? row.possible_existing_node_id ?? null;
	if (id) {
		const direct = nodes.find((node) => node.id === id);
		if (direct) return direct;
	}
	const key = normalizeLabel(body.label ?? candidateLabel(row));
	return nodes.find((node) => normalizeLabel(node.label) === key) ?? null;
}

function addNodeToPlan(plan, userId, label, category) {
	const ts = now();
	const id = newId("node");
	const cluster = clusterForMemory({ label, category });
	plan.newNodes.push({
		id,
		user_id: userId,
		label,
		canonical_label: normalizeLabel(label),
		category,
		role: null,
		state: "active",
		summary: null,
		created_at: ts,
		updated_at: ts,
		last_seen_at: ts,
		mention_count: 1,
		session_count: 1,
		heat_score: 1,
		cluster,
	});
	plan.affectedNodeIds.add(id);
	return id;
}

function ensureNode(plan, userId, row, nodes, body = {}) {
	const existing = findExistingNode(nodes, row, body);
	if (existing) {
		plan.nodeTouches.add(existing.id);
		plan.affectedNodeIds.add(existing.id);
		return { id: existing.id, existed: true, label: existing.label };
	}
	const label = String(body.label ?? candidateLabel(row)).trim() || "Promoted Candidate";
	const category = String(body.category ?? row.role_guess ?? "other").trim() || "other";
	return { id: addNodeToPlan(plan, userId, label, category), existed: false, label };
}

async function persistPromotion(env, userId, row, plan, status, object, acceptedAt) {
	const config = getConfig(env);
	// SRV-09: promotion writes STORED pre-request content back into the graph,
	// so it must respect the erasure barrier for the window between reading the
	// candidate and committing. acceptedAt is the promotion's start; a barrier
	// newer than it means the user erased this scope mid-request, and the
	// candidate this promotion read no longer exists.
	try {
		await writeApproved(env, config, userId, plan, { acceptedAt });
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			return {
				ok: false,
				status: 409,
				error: "This memory space was erased while the promotion was in flight; the candidate no longer exists.",
			};
		}
		throw error;
	}
	await markCandidate(env, userId, row.id, status, {
		promotedObjectId: object?.id ?? null,
		promotedObjectKind: object?.kind ?? null,
	});
	const receipt = buildReceipt("promoted_from_candidate", plan, {
		source: "candidate_review",
		project_id: row.project_id ?? null,
		project_name: row.project_name ?? null,
	});
	receipt.candidate_id = row.id;
	const summary = `Promoted candidate: ${candidateLabel(row)}. ${formatReceipt(receipt)}`;
	await storeReceipt(env, userId, "candidate_review", receipt, summary);
	return { ok: true, candidate: rowToCandidate({ ...row, status }), receipt, summary };
}

export async function listCandidates(env, userId, { status = "pending", limit = 100 } = {}) {
	const statusWhere = status === "all" ? "" : "AND COALESCE(status, 'pending') = ?";
	const stmt = env.DB.prepare(
		`SELECT * FROM candidates
		 WHERE user_id = ?
		   AND deleted_at IS NULL
		   AND suppressed_at IS NULL
		   ${statusWhere}
		 ORDER BY COALESCE(last_seen_at, created_at) DESC
		 LIMIT ?`,
	);
	const bound = status === "all"
		? stmt.bind(userId, limit)
		: stmt.bind(userId, status, limit);
	const { results } = await bound.all();
	return (results ?? []).map(rowToCandidate);
}

export async function promoteCandidate(env, userId, id, body = {}, { acceptedAt = Date.now() } = {}) {
	const row = await getCandidate(env, userId, id);
	if (!row) return { ok: false, error: "candidate not found", status: 404 };
	if ((row.status ?? "pending") !== "pending") return { ok: false, error: "candidate is not pending", status: 409 };

	const projectScope = normalizeProjectScope(row);
	const nodes = await getUserNodes(env, userId, { projectId: projectScope.projectId });
	const plan = planBase();
	plan.projectScope = projectScope;
	const action = body.action ?? "promote_to_node";
	const node = ensureNode(plan, userId, row, nodes, body);
	const text = String((body.text ?? evidenceText(row)) || candidateLabel(row)).trim();
	const ts = now();

	if (action === "promote_to_event") {
		plan.newEvents.push({
			id: newId("event"),
			user_id: userId,
			node_id: node.id,
			action: body.eventAction ?? body.action_type ?? "other",
			text,
			importance: body.importance ?? "ordinary",
			happened_at: ts,
			created_at: ts,
			confidence: row.confidence ?? null,
		});
		plan.affectedNodeIds.add(node.id);
		return persistPromotion(env, userId, row, plan, "promoted", { id: node.id, kind: "event" }, acceptedAt);
	}

	if (action === "promote_to_slice") {
		plan.newSlices.push({
			id: newId("slice"),
			user_id: userId,
			node_id: node.id,
			text,
			kind: body.sliceKind ?? "other",
			is_current: 1,
			created_at: ts,
		});
		plan.affectedNodeIds.add(node.id);
		return persistPromotion(env, userId, row, plan, "promoted", { id: node.id, kind: "slice" }, acceptedAt);
	}

	if (action === "merge_with_existing") {
		if (!node.existed) return { ok: false, error: "nodeId is required for merge", status: 400 };
		plan.newSlices.push({
			id: newId("slice"),
			user_id: userId,
			node_id: node.id,
			text,
			kind: body.sliceKind ?? "other",
			is_current: 1,
			created_at: ts,
		});
		plan.affectedNodeIds.add(node.id);
		return persistPromotion(env, userId, row, plan, "merged", { id: node.id, kind: "node" }, acceptedAt);
	}

	return persistPromotion(env, userId, row, plan, "promoted", { id: node.id, kind: "node" }, acceptedAt);
}

export async function rejectCandidate(env, userId, id, body = {}) {
	const row = await getCandidate(env, userId, id);
	if (!row) return { ok: false, error: "candidate not found", status: 404 };
	const suppress = body.action === "suppress_similar" || body.suppressSimilar === true || body.suppress_similar === true;
	if (suppress) {
		await addSuppression(env, userId, {
			kind: "candidate",
			label: candidateLabel(row),
			canonical_key: row.canonical_key ?? normalizeLabel(candidateLabel(row)),
			reason: body.reason ?? "candidate_review_suppress_similar",
			source_object_id: row.id,
			project_id: row.project_id ?? null,
			project_name: row.project_name ?? null,
		});
	}
	await markCandidate(env, userId, id, suppress ? "suppressed" : "rejected", {
		suppressedAt: suppress ? now() : null,
	});
	return { ok: true, candidate: rowToCandidate({ ...row, status: suppress ? "suppressed" : "rejected" }) };
}

export async function mergeCandidate(env, userId, id, body = {}) {
	return promoteCandidate(env, userId, id, { ...body, action: "merge_with_existing" });
}
