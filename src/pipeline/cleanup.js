import { getConfig } from "../config.js";
import { addSuppression, storeReceipt } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { managedProjectMemoryOwnerId } from "../lib/managed_projects.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "../lib/audit.js";
import { normalizeLabel } from "../lib/text.js";
import { deleteNodeVectors } from "../lib/vectorize.js";
import { clusterForMemory, organizeUserClusters } from "./clusters.js";
import { fallbackSummary } from "./pass2.js";
import { suppressPageKey } from "./pages.js";
import { dedupeEvidence, scoreDomains, topicSimilarity } from "./signals.js";
import { canonicalTitle, generateTitle, isBadTitle } from "./title.js";
import { deleteManualSearchObjects, refreshManualSearchProfiles } from "./manual_search_profiles.js";
import { applyFencedUpdate, purgeVectorArtifactsForObjects, userAuthoredSummaryFence, versionResidueStatements } from "../lib/memory_versions.js";
import {
	countSemanticAtomProjections,
	countSourceEpisodes,
	deleteSourceEpisodes,
} from "./episodes.js";
import { countSemanticAtomCandidates } from "./atomic_candidates.mjs";
import { rebuildConversationPageFromSources } from "./mcp_engine.js";
import { grantRevocationStatements } from "../lib/oauth.js";
import { ERASED_SOURCE_CONTENT_HASH } from "./source.js";
import {
	assertNoActiveProviderInvocation,
	scrubProviderReservationLifecycle,
} from "../ai/provider_budget.js";

function shadowInvocationInFlightError() {
	const error = new Error("A bounded shadow provider invocation is still in flight; retry deletion after its lease drains.");
	error.name = "LifecycleFenceError";
	error.code = "shadow_invocation_in_flight";
	error.status = 503;
	error.retryable = true;
	return error;
}

async function assertNoActiveShadowInvocation(env, {
	userId = null,
	accountUserId = null,
	acceptedThrough = null,
	now = Date.now(),
} = {}) {
	const clauses = [];
	const bindings = [];
	if (userId) {
		clauses.push("user_id = ?");
		bindings.push(userId);
	}
	if (accountUserId) {
		clauses.push("account_user_id = ?");
		bindings.push(accountUserId);
	}
	if (!clauses.length) return;
	let accepted = "";
	if (acceptedThrough !== null && acceptedThrough !== undefined
		&& Number.isFinite(Number(acceptedThrough))) {
		accepted = " AND created_at <= ?";
		bindings.push(Number(acceptedThrough));
	}
	bindings.push(now);
	const active = await env.DB.prepare(
		`SELECT 1 AS active FROM ai_shadow_jobs
		 WHERE (${clauses.join(" OR ")})${accepted}
		   AND status = 'invoking'
		   AND (lease_until IS NULL OR lease_until > ?)
		 LIMIT 1`,
	).bind(...bindings).first();
	if (active) throw shadowInvocationInFlightError();
}

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function advanceManualPageWriteEpoch(env, userId, now) {
	return env.DB.prepare(
		`INSERT INTO manual_page_write_epochs (user_id, epoch, updated_at)
		 VALUES (?, 1, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			epoch = manual_page_write_epochs.epoch + 1,
			updated_at = excluded.updated_at`,
	).bind(userId, now);
}

async function softDeleteByIds(env, userId, table, ids, now) {
	if (!ids.length) return 0;
	let count = 0;
	for (const id of ids) {
		await env.DB.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND user_id = ?`)
			.bind(now, id, userId)
			.run();
		count++;
	}
	return count;
}

async function suppressNode(env, userId, nodeId, reason) {
	const node = await env.DB.prepare("SELECT id, label, project_id, project_name FROM nodes WHERE id = ? AND user_id = ?")
		.bind(nodeId, userId)
		.first();
	if (!node) return;
	await addSuppression(env, userId, {
		kind: "node",
		label: node.label,
		canonical_key: normalizeLabel(node.label),
		reason,
		source_object_id: node.id,
		project_id: node.project_id ?? null,
		project_name: node.project_name ?? null,
	});
}

async function suppressPage(env, userId, pageId, reason) {
	const page = await env.DB.prepare("SELECT * FROM memory_pages WHERE id = ? AND user_id = ?")
		.bind(pageId, userId)
		.first();
	if (!page) return;
	await suppressPageKey(env, userId, page, reason);
}

function suppressionStatement(env, userId, {
	kind,
	label,
	canonicalKey,
	reason,
	sourceObjectId,
	projectId = null,
	projectName = null,
}, now) {
	const key = String(canonicalKey ?? "").trim();
	if (!kind || !key) return null;
	return env.DB.prepare(
		`INSERT INTO memory_suppressions
		 (id, user_id, kind, canonical_key, label, reason, source_object_id, created_at,
		  project_id, project_name)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		newId("suppress"), userId, kind, key, label ?? key,
		reason ?? null, sourceObjectId ?? null, now, projectId, projectName,
	);
}

export function junkReasonForLabel(label, item = {}) {
	const raw = String(label ?? "").trim();
	const norm = normalizeLabel(raw);
	if (!norm || norm.length < 3) return "empty_or_weak_label";
	if (isBadTitle(raw)) return "bad_title";
	if (/^(want|wants|need|needs|see|show|make|create|give|help|please)\b/.test(norm)) return "vague_request_sentence";
	if (/\b(want|wants|need|needs|see|show|prototype|interactive|world facing|demo)\b.*\b(prototype|interactive|world facing|demo)\b/.test(norm)) {
		return "vague_request_sentence";
	}
	if (/\b(impressive|world facing|world-facing|detailed interactive|modern conceptual adapters)\b/.test(norm)) {
		return "assistant_or_marketing_phrase";
	}
	if (/\b(user|assistant|chatgpt|claude|chat|conversation)\b.*\b(asked|said|response|reply|request|wants|wrote)\b/.test(norm)) {
		return "assistant_chat_phrase";
	}
	if (/\b(what we discussed|from this chat|save this chat|in this conversation|old chat)\b/.test(norm)) {
		return "chat_container_phrase";
	}
	if (norm.split(" ").length >= 8 && !/\b(uml|cloudflare|memory|project|system|graph|run|d1|mcp|vectorize)\b/.test(norm)) {
		return "sentence_fragment";
	}
	if (item.kind === "candidate" && Number(item.mentions ?? 1) <= 1 && norm.split(" ").length > 6) {
		return "weak_candidate_sentence";
	}
	return null;
}

export async function previewJunkCleanup(env, userId) {
	const [nodesRes, candidatesRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, summary, created_at, updated_at FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, label, strength, mentions, cluster_hint, created_at FROM candidates
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
	]);
	const items = [];
	for (const node of nodesRes.results ?? []) {
		const reason = junkReasonForLabel(node.label, { ...node, kind: "node" });
		if (reason) items.push({ kind: "node", id: node.id, label: node.label, reason });
	}
	for (const candidate of candidatesRes.results ?? []) {
		const reason = junkReasonForLabel(candidate.label, { ...candidate, kind: "candidate" });
		if (reason) items.push({ kind: "candidate", id: candidate.id, label: candidate.label, reason });
	}
	return {
		dryRun: true,
		junkPreviewed: items.length,
		items,
		confirmationRequired: "CLEAN JUNK",
	};
}

export async function cleanJunkMemories(env, userId, { confirm } = {}) {
	const preview = await previewJunkCleanup(env, userId);
	if (confirm !== "CLEAN JUNK") return preview;
	const now = Date.now();
	let archived = 0;
	let suppressed = 0;
	const nodeIds = [];
	for (const item of preview.items) {
		if (item.kind === "node") {
			await suppressNode(env, userId, item.id, `junk_cleanup:${item.reason}`);
			await env.DB.batch([
				env.DB.prepare("DELETE FROM manual_node_identities WHERE user_id = ? AND node_id = ?").bind(userId, item.id),
				env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND (owner_node_id = ? OR related_node_id = ?)")
					.bind(userId, item.id, item.id),
				env.DB.prepare("UPDATE nodes SET archived_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
					.bind(now, now, item.id, userId),
			]);
			nodeIds.push(item.id);
			archived++;
			suppressed++;
		}
		if (item.kind === "candidate") {
			await env.DB.prepare("UPDATE candidates SET suppressed_at = ? WHERE id = ? AND user_id = ?")
				.bind(now, item.id, userId)
				.run();
			suppressed++;
		}
	}
	await deleteManualSearchObjects(env, getConfig(env), userId, { nodeIds });
	return {
		dryRun: false,
		junkPreviewed: preview.junkPreviewed,
		junkArchived: archived,
		junkSuppressed: suppressed,
		items: preview.items,
	};
}

export async function deleteLastExtraction(env, userId) {
	const run = await env.DB.prepare(
		"SELECT * FROM extraction_runs WHERE user_id = ? AND (status IS NULL OR status != 'deleted') ORDER BY created_at DESC LIMIT 1",
	)
		.bind(userId)
		.first();
	if (!run) return { deleted: false, reason: "no extraction run found" };

	const now = Date.now();
	const pages = parseJsonArray(run.created_pages_json);
	const nodes = parseJsonArray(run.created_nodes_json);
	const slices = parseJsonArray(run.created_slices_json);
	const events = parseJsonArray(run.created_events_json);
	const edges = parseJsonArray(run.created_edges_json);

	const pageIds = pages.map((page) => page.id);
	const nodeIds = nodes.map((node) => node.id);
	const sliceIds = slices.map((slice) => slice.id);
	const eventIds = events.map((event) => event.id);
	const edgeIds = edges.map((edge) => edge.id);
	const counts = {
		pages: pageIds.length,
		nodes: nodeIds.length,
		slices: sliceIds.length,
		events: eventIds.length,
		edges: edgeIds.length,
	};
	const canonicalDeletes = [];
	// Suppressions belong to the same delete operation. Build them as prepared
	// statements so a failed D1 batch cannot leave an active object paired with
	// a stray suppression from a half-completed delete-last request.
	for (const pageId of pageIds) {
		const page = await env.DB.prepare(
			"SELECT id, title, canonical_title, topic_filter, project_id, project_name FROM memory_pages WHERE id = ? AND user_id = ?",
		).bind(pageId, userId).first();
		if (!page) continue;
		const titleSuppression = suppressionStatement(env, userId, {
			kind: "memory_page",
			label: page.title,
			canonicalKey: page.canonical_title,
			reason: "delete_last_extraction",
			sourceObjectId: page.id,
			projectId: page.project_id ?? null,
			projectName: page.project_name ?? null,
		}, now);
		if (titleSuppression) canonicalDeletes.push(titleSuppression);
		if (page.topic_filter) {
			const topicSuppression = suppressionStatement(env, userId, {
				kind: "memory_page",
				label: page.topic_filter,
				canonicalKey: page.topic_filter,
				reason: "delete_last_extraction",
				sourceObjectId: page.id,
				projectId: page.project_id ?? null,
				projectName: page.project_name ?? null,
			}, now);
			if (topicSuppression) canonicalDeletes.push(topicSuppression);
		}
	}
	for (const nodeId of nodeIds) {
		const node = await env.DB.prepare(
			"SELECT id, label, project_id, project_name FROM nodes WHERE id = ? AND user_id = ?",
		).bind(nodeId, userId).first();
		if (!node) continue;
		const nodeSuppression = suppressionStatement(env, userId, {
			kind: "node",
			label: node.label,
			canonicalKey: normalizeLabel(node.label),
			reason: "delete_last_extraction",
			sourceObjectId: node.id,
			projectId: node.project_id ?? null,
			projectName: node.project_name ?? null,
		}, now);
		if (nodeSuppression) canonicalDeletes.push(nodeSuppression);
	}
	const queueSoftDeletes = (table, ids) => {
		for (const id of ids) {
			canonicalDeletes.push(env.DB.prepare(
				`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND user_id = ?`,
			).bind(now, id, userId));
		}
	};
	queueSoftDeletes("memory_pages", pageIds);
	queueSoftDeletes("nodes", nodeIds);
	queueSoftDeletes("slices", sliceIds);
	queueSoftDeletes("events", eventIds);
	queueSoftDeletes("edges", edgeIds);
	if (pages.length) canonicalDeletes.push(advanceManualPageWriteEpoch(env, userId, now));
	for (const page of pages) {
		canonicalDeletes.push(env.DB.prepare("DELETE FROM manual_page_identities WHERE user_id = ? AND page_id = ?").bind(userId, page.id));
		canonicalDeletes.push(env.DB.prepare("DELETE FROM manual_page_versions WHERE user_id = ? AND page_id = ?").bind(userId, page.id));
		canonicalDeletes.push(env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'page' AND object_id = ?",
		).bind(userId, page.id));
	}
	for (const node of nodes) {
		canonicalDeletes.push(env.DB.prepare("DELETE FROM manual_node_identities WHERE user_id = ? AND node_id = ?").bind(userId, node.id));
		canonicalDeletes.push(env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND (owner_node_id = ? OR related_node_id = ?)")
			.bind(userId, node.id, node.id));
		canonicalDeletes.push(env.DB.prepare("DELETE FROM node_topic_communities WHERE user_id = ? AND node_id = ?")
			.bind(userId, node.id));
		canonicalDeletes.push(env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(userId, node.id));
	}
	for (const item of [...slices, ...events, ...edges]) {
		canonicalDeletes.push(env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND object_id = ?").bind(userId, item.id));
	}
	canonicalDeletes.push(env.DB.prepare(
		`DELETE FROM topic_communities WHERE user_id = ? AND NOT EXISTS (
		 SELECT 1 FROM node_topic_communities WHERE user_id = ? AND community_id = topic_communities.id
		)`,
	).bind(userId, userId));
	// Revision history, idempotency claims, and projection rows are customer
	// content keyed to these objects; they die in the SAME batch as the objects
	// so no deletion path can leave an invisible archive behind.
	for (const statement of versionResidueStatements(env, userId, [...pageIds, ...nodeIds, ...sliceIds, ...eventIds])) {
		canonicalDeletes.push(statement);
	}
	canonicalDeletes.push(env.DB.prepare(
		"UPDATE extraction_runs SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?",
	).bind("deleted", now, run.id, userId));
	await env.DB.batch(canonicalDeletes);
	if (env.VECTORIZE) {
		const vectorIds = [...nodeIds, ...pageIds.map((id) => `page:${id}`)];
		if (vectorIds.length) {
			try {
				await env.VECTORIZE.deleteByIds(vectorIds);
			} catch (error) {
				console.warn("delete-last vector cleanup failed:", error?.message ?? error);
			}
		}
	}
	const deletedNodeIds = new Set(nodes.map((node) => node.id));
	const refreshNodeIds = [...new Set([
		...slices.map((slice) => slice.node_id),
		...events.map((event) => event.node_id),
		...edges.flatMap((edge) => [edge.from_node, edge.to_node]),
	].filter((id) => id && !deletedNodeIds.has(id)))];
	if (refreshNodeIds.length) {
		await refreshManualSearchProfiles(env, getConfig(env), userId, { nodeIds: refreshNodeIds });
	}
	return { deleted: true, extraction_run_id: run.id, counts };
}

/**
 * Summary residue removal (fix round 1, Part 3.4). Every node summary carries
 * provenance (`summary_sources_json` — the fact ids it was built from). After
 * a delete, any summary whose sources intersect the deleted ids is DIRTY and
 * gets rebuilt from surviving facts only, in one pass — the 3-passes-to-clean
 * bug dies here. Nodes named in `touchedNodeIds` (they lost rows directly)
 * are rebuilt regardless of recorded provenance, which also covers legacy
 * rows from before the provenance column existed.
 */

/** The revision an automatic pass observed for a node row it read. */
function nodeRevision(row) {
	const value = Number(row?.revision);
	return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/**
 * Apply a regenerated node summary ONLY if the node is still at the revision
 * the caller computed from. A stale automatic pass returns { stale: true } and
 * writes nothing, so an explicit user correction can never be overwritten by
 * work that predates it. The successful write participates in versioning.
 */
export async function regenerateNodeSummaryFenced(env, userId, nodeId, { summary, sourcesJson, observedRevision }) {
	const expected = Number(observedRevision);
	if (!Number.isSafeInteger(expected) || expected < 1) {
		return { applied: false, stale: false, reason: "no_observed_revision" };
	}
	const result = await env.DB.prepare(
		`UPDATE nodes
		 SET summary = ?, summary_sources_json = ?, updated_at = ?, revision = COALESCE(revision, 1) + 1
		 WHERE id = ? AND user_id = ?
		   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
		   AND COALESCE(revision, 1) = ?
		   ${userAuthoredSummaryFence("nodes").sql}`,
	).bind(summary, sourcesJson, Date.now(), nodeId, userId, expected).run();
	const changes = result.meta?.changes ?? 0;
	return changes > 0 ? { applied: true, stale: false } : { applied: false, stale: true };
}

export async function regenerateDirtySummaries(env, userId, deletedIds = [], touchedNodeIds = []) {
	const deleted = new Set(deletedIds.filter(Boolean));
	const touched = new Set(touchedNodeIds.filter(Boolean));
	if (deleted.size === 0 && touched.size === 0) return { regenerated: 0 };

	const { results: nodes } = await env.DB.prepare(
		`SELECT id, label, category, state, summary, cluster, summary_sources_json, COALESCE(revision, 1) AS revision
		 FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
	).bind(userId).all();

	let regenerated = 0;
	for (const node of nodes ?? []) {
		const sources = parseJsonArray(node.summary_sources_json);
		const dirty = touched.has(node.id) || sources.some((sid) => deleted.has(sid));
		if (!dirty) continue;
		const [slicesRes, eventsRes] = await env.DB.batch([
			env.DB.prepare(
				"SELECT id, text, kind, created_at FROM slices WHERE user_id = ? AND node_id = ? AND is_current = 1 AND deleted_at IS NULL ORDER BY created_at DESC",
			).bind(userId, node.id),
			env.DB.prepare(
				"SELECT id, action, text, happened_at, created_at FROM events WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL AND COALESCE(action, '') <> 'updated' ORDER BY COALESCE(happened_at, created_at) DESC LIMIT 12",
			).bind(userId, node.id),
		]);
		const slices = slicesRes.results ?? [];
		const events = eventsRes.results ?? [];
		const summary = fallbackSummary(node, slices, events);
		const provenance = JSON.stringify([...slices.map((s) => s.id), ...events.map((e) => e.id)].slice(0, 40));
		// The summary was computed from the rows this pass READ. If an explicit
		// user edit landed in between, that read is stale and this write must
		// lose rather than overwrite the correction.
		const applied = await regenerateNodeSummaryFenced(env, userId, node.id, {
			summary,
			sourcesJson: provenance,
			observedRevision: nodeRevision(node),
		});
		if (applied.applied) regenerated++;
	}
	if (regenerated) await refreshManualSearchProfiles(env, getConfig(env), userId, {});
	return { regenerated };
}

/** Audit tombstone: what was deleted, when, by which credential. Best-effort. */
export async function storeDeletionTombstone(env, userId, {
	kind,
	ids = [],
	by = null,
	source = "delete",
	projectScopes = [],
}) {
	const scopes = [...new Map((projectScopes ?? []).map((scope) => {
		const projectId = scope?.project_id ?? scope?.projectId ?? null;
		const projectName = scope?.project_name ?? scope?.projectName ?? null;
		return [projectId ?? "__global__", { project_id: projectId, project_name: projectName }];
	})).values()];
	const singleScope = scopes.length === 1 ? scopes[0] : null;
	const receipt = {
		outcome: "deleted",
		reason: "user-requested deletion",
		source,
		deleted_kind: kind,
		deleted_ids: ids.slice(0, 200),
		deleted_count: ids.length,
		deleted_by: by ?? null,
		project_scope: scopes.length > 1 ? "mixed" : (singleScope?.project_id ? "project" : "global"),
		project_id: singleScope?.project_id ?? null,
		project_name: singleScope?.project_name ?? null,
		project_scopes: scopes,
		scope_json: singleScope ? JSON.stringify(singleScope) : null,
		created_at: Date.now(),
	};
	await storeReceipt(env, userId, source, receipt, `Deleted ${ids.length} ${kind}(s).`);
	return receipt;
}

/**
 * `guards` are fence statements (capability, credential, lifecycle) that must
 * hold at COMMIT time. They ride in the same D1 batch as the deletion, so a
 * role downgrade or a revoked credential between preflight and commit aborts
 * the whole delete instead of letting it land. Callers that have no
 * authenticated actor pass none, exactly as before.
 */
export async function deleteObject(env, userId, { kind, id, suppress = true, guards = [] }) {
	const now = Date.now();
	const fences = (guards ?? []).filter(Boolean);
	if (kind === "page" || kind === "memory_page") {
		if (suppress) await suppressPage(env, userId, id, "delete_selected");
		await env.DB.batch([
			...fences,
			advanceManualPageWriteEpoch(env, userId, now),
			env.DB.prepare("DELETE FROM manual_page_identities WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("DELETE FROM manual_page_versions WHERE user_id = ? AND page_id = ?").bind(userId, id),
			// Conversation Page source links die with the page — a link that
			// outlives the object it names is a record.
			env.DB.prepare("DELETE FROM conversation_page_sources WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("UPDATE memory_pages SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
				.bind(now, suppress ? now : null, id, userId),
			// Single-object permanent deletion erases revision history too —
			// history must never become an undeletable shadow copy.
			...versionResidueStatements(env, userId, [id]),
		]);
		await deleteManualSearchObjects(env, getConfig(env), userId, { pageIds: [id] });
		return { deleted: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		const { results: touchingEdges } = await env.DB.prepare(
			"SELECT from_node, to_node FROM edges WHERE user_id = ? AND deleted_at IS NULL AND (from_node = ? OR to_node = ?)",
		).bind(userId, id, id).all();
		// Capture the fact ids about to die — the summary-residue pass needs them.
		const { results: dyingRows } = await env.DB.prepare(
			`SELECT id FROM slices WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL
			 UNION ALL SELECT id FROM events WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL`,
		).bind(userId, id, userId, id).all();
		if (suppress) await suppressNode(env, userId, id, "delete_selected");
		await env.DB.batch([
			...fences,
			env.DB.prepare("DELETE FROM manual_node_identities WHERE user_id = ? AND node_id = ?").bind(userId, id),
			env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND (owner_node_id = ? OR related_node_id = ?)")
				.bind(userId, id, id),
			env.DB.prepare("UPDATE nodes SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?").bind(
				now,
				suppress ? now : null,
				id,
				userId,
			),
			env.DB.prepare("UPDATE slices SET deleted_at = ? WHERE node_id = ? AND user_id = ?").bind(now, id, userId),
			env.DB.prepare("UPDATE events SET deleted_at = ? WHERE node_id = ? AND user_id = ?").bind(now, id, userId),
			env.DB.prepare("UPDATE edges SET deleted_at = ? WHERE user_id = ? AND (from_node = ? OR to_node = ?)").bind(
				now,
				userId,
				id,
				id,
			),
			// Revision history of the node AND every cascading slice/event dies
			// with the object graph it describes.
			...versionResidueStatements(env, userId, [id, ...(dyingRows ?? []).map((r) => r.id)]),
		]);
		await deleteManualSearchObjects(env, getConfig(env), userId, { nodeIds: [id] });
		// The full cascade (Part 3.3): the vector goes too (async on Vectorize's
		// side — recall's live-row filter hides it meanwhile), and neighbours
		// whose summaries were built from this node's facts are regenerated.
		// Ledger-driven: removes the legacy bare id AND every revision-qualified
		// artifact ever submitted for this node, including non-contiguous ones.
		await purgeVectorArtifactsForObjects(env, getConfig(env), userId, [id]);
		const neighbourIds = [...new Set((touchingEdges ?? []).flatMap((edge) => [edge.from_node, edge.to_node])
			.filter((nodeId) => nodeId && nodeId !== id))];
		if (neighbourIds.length) await refreshManualSearchProfiles(env, getConfig(env), userId, { nodeIds: neighbourIds });
		await regenerateDirtySummaries(
			env,
			userId,
			[id, ...(dyingRows ?? []).map((r) => r.id)],
			neighbourIds,
		);
		return { deleted: true, kind: "node", id };
	}
	// One wrong fact inside an otherwise-good node. Before this, the smallest
	// deletable unit was the whole node, so removing a single bad slice meant
	// destroying every true fact beside it. The node survives here; only the
	// slice dies — and the summary is rebuilt, because the deleted text fed it.
	if (kind === "slice") {
		const row = await env.DB.prepare(
			"SELECT id, node_id FROM slices WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
		).bind(id, userId).first();
		if (!row) return { deleted: false, kind: "slice", id, reason: "not_found" };
		const nodeId = row.node_id ?? null;
		await env.DB.batch([
			...fences,
			// The same fact-identity cleanup the bulk path does for slices, so the
			// canonical key is freed and re-saving that fact later counts as new.
			env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND object_id = ?").bind(userId, id),
			env.DB.prepare("UPDATE slices SET deleted_at = ?, is_current = 0 WHERE id = ? AND user_id = ?").bind(now, id, userId),
			...versionResidueStatements(env, userId, [id]),
		]);
		if (nodeId) {
			// The parent keeps its vector (label and category are unchanged), but
			// its search profile and summary are built from slice text.
			await refreshManualSearchProfiles(env, getConfig(env), userId, { nodeIds: [nodeId] });
			await regenerateDirtySummaries(env, userId, [id], [nodeId]);
		}
		return { deleted: true, kind: "slice", id, node_id: nodeId };
	}
	if (kind === "candidate") {
		const statement = env.DB.prepare("UPDATE candidates SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, suppress ? now : null, id, userId);
		if (fences.length) await env.DB.batch([...fences, statement]);
		else await statement.run();
		return { deleted: true, kind: "candidate", id };
	}
	return { deleted: false, reason: "unsupported kind" };
}

export async function archiveObject(env, userId, { kind, id }) {
	const now = Date.now();
	if (kind === "page" || kind === "memory_page") {
		await env.DB.batch([
			advanceManualPageWriteEpoch(env, userId, now),
			env.DB.prepare("DELETE FROM manual_page_identities WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("DELETE FROM manual_page_versions WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("UPDATE memory_pages SET archived_at = ? WHERE id = ? AND user_id = ?").bind(now, id, userId),
		]);
		await deleteManualSearchObjects(env, getConfig(env), userId, { pageIds: [id] });
		return { archived: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		const { results: touchingEdges } = await env.DB.prepare(
			"SELECT from_node, to_node FROM edges WHERE user_id = ? AND deleted_at IS NULL AND (from_node = ? OR to_node = ?)",
		).bind(userId, id, id).all();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM manual_node_identities WHERE user_id = ? AND node_id = ?").bind(userId, id),
			env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND (owner_node_id = ? OR related_node_id = ?)")
				.bind(userId, id, id),
			env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE id = ? AND user_id = ?").bind(now, id, userId),
		]);
		await deleteManualSearchObjects(env, getConfig(env), userId, { nodeIds: [id] });
		const neighbourIds = [...new Set((touchingEdges ?? []).flatMap((edge) => [edge.from_node, edge.to_node])
			.filter((nodeId) => nodeId && nodeId !== id))];
		if (neighbourIds.length) await refreshManualSearchProfiles(env, getConfig(env), userId, { nodeIds: neighbourIds });
		return { archived: true, kind: "node", id };
	}
	if (kind === "candidate") {
		await env.DB.prepare("UPDATE candidates SET deleted_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
		return { archived: true, kind: "candidate", id };
	}
	return { archived: false, reason: "unsupported kind" };
}

const DELETED_PROVIDER_ACTOR = "deleted_user";

/**
 * Provider routing is global operational state, so account erasure must not
 * delete or reset it. It does, however, contain bounded account provenance:
 * rollout allowlists, NOT NULL updater ids, audit actors/snapshots/notes, and
 * emergency-override attribution. These statements run in the SAME D1 batch
 * that installs the account tombstone. Consequently, a provider-control write
 * either commits before the tombstone and is scrubbed here, or observes the
 * tombstone at its own commit fence and changes no rows.
 */
function providerControlQuiesceStatements(env, { userId, emailNormalized, now }) {
	const emailNeedle = String(emailNormalized ?? "").trim().toLowerCase() || "\u0000no-email\u0000";
	return [
		env.DB.prepare(
			`UPDATE ai_routing_policies
			    SET allowlist_json = CASE
			          WHEN allowlist_json IS NULL THEN NULL
			          WHEN instr(allowlist_json, ?) = 0
			           AND instr(lower(allowlist_json), ?) = 0
			          THEN allowlist_json
			          WHEN json_valid(allowlist_json)
			           AND json_type(allowlist_json) = 'array'
			          THEN (
			            SELECT json_group_array(member.value)
			              FROM json_each(ai_routing_policies.allowlist_json) member
			             WHERE instr(CAST(member.value AS TEXT), ?) = 0
			               AND instr(lower(CAST(member.value AS TEXT)), ?) = 0
			          )
			          ELSE '[]'
			        END,
			        updated_by = CASE
			          WHEN updated_by = ? OR lower(updated_by) = ?
			          THEN ? ELSE updated_by END,
			        version = version + 1,
			        updated_at = ?,
			        mutation_id = NULL
			  WHERE updated_by = ? OR lower(updated_by) = ?
			     OR (allowlist_json IS NOT NULL AND (
			       instr(allowlist_json, ?) > 0
			       OR instr(lower(allowlist_json), ?) > 0
			     ))`,
		).bind(
			userId, emailNeedle, userId, emailNeedle,
			userId, emailNeedle, DELETED_PROVIDER_ACTOR,
			now, userId, emailNeedle, userId, emailNeedle,
		),
		env.DB.prepare(
			`UPDATE ai_provider_overrides
			    SET actor_user_id = CASE
			          WHEN actor_user_id = ? OR lower(actor_user_id) = ?
			          THEN NULL ELSE actor_user_id END,
			        reason = CASE
			          WHEN actor_user_id = ? OR lower(actor_user_id) = ?
			            OR instr(COALESCE(reason, ''), ?) > 0
			            OR instr(lower(COALESCE(reason, '')), ?) > 0
			          THEN NULL ELSE reason END,
			        updated_at = ?
			  WHERE actor_user_id = ? OR lower(actor_user_id) = ?
			     OR instr(COALESCE(reason, ''), ?) > 0
			     OR instr(lower(COALESCE(reason, '')), ?) > 0`,
		).bind(
			userId, emailNeedle,
			userId, emailNeedle, userId, emailNeedle,
			now,
			userId, emailNeedle, userId, emailNeedle,
		),
	];
}

function containsErasedIdentifier(value, identifiers) {
	const text = String(value ?? "");
	return identifiers.some(({ value: identifier, insensitive }) => insensitive
		? text.toLowerCase().includes(identifier.toLowerCase())
		: text.includes(identifier));
}

function redactIdentifierString(value, identifiers) {
	let redacted = String(value);
	for (const { value: identifier, insensitive } of identifiers) {
		if (!identifier) continue;
		if (!insensitive) {
			redacted = redacted.split(identifier).join(DELETED_PROVIDER_ACTOR);
			continue;
		}
		const needle = identifier.toLowerCase();
		let offset = 0;
		while (true) {
			const index = redacted.toLowerCase().indexOf(needle, offset);
			if (index < 0) break;
			redacted = `${redacted.slice(0, index)}${DELETED_PROVIDER_ACTOR}${redacted.slice(index + identifier.length)}`;
			offset = index + DELETED_PROVIDER_ACTOR.length;
		}
	}
	return redacted;
}

function redactAuditValue(value, identifiers) {
	if (typeof value === "string") {
		// Older snapshots nested allowlist_json as a serialized JSON string.
		// Parse that layer when possible so redaction remains structural rather
		// than relying on a blind replacement over the outer document.
		if (/^\s*[\[{]/.test(value)) {
			try {
				return JSON.stringify(redactAuditValue(JSON.parse(value), identifiers));
			} catch {
				// It is ordinary text beginning with a bracket; redact below.
			}
		}
		return redactIdentifierString(value, identifiers);
	}
	if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, identifiers));
	if (value && typeof value === "object") {
		const redacted = {};
		for (const [key, child] of Object.entries(value)) {
			redacted[redactIdentifierString(key, identifiers)] = redactAuditValue(child, identifiers);
		}
		return redacted;
	}
	return value;
}

function redactAuditSnapshot(raw, identifiers) {
	if (raw == null) return null;
	try {
		return JSON.stringify(redactAuditValue(JSON.parse(raw), identifiers));
	} catch {
		// A malformed historical snapshot is not useful policy evidence. If it
		// carries erased provenance, null it rather than preserving opaque bytes.
		return containsErasedIdentifier(raw, identifiers) ? null : raw;
	}
}

async function scrubProviderControlAudit(env, { userId, emailNormalized }) {
	const identifiers = [{ value: userId, insensitive: false }];
	if (emailNormalized) identifiers.push({ value: String(emailNormalized), insensitive: true });
	const { results: rows } = await env.DB.prepare(
		"SELECT id, actor_user_id, old_json, new_json, note FROM ai_routing_policy_audit",
	).all();
	const updates = [];
	for (const row of rows ?? []) {
		const actorErased = containsErasedIdentifier(row.actor_user_id, identifiers);
		const oldJson = redactAuditSnapshot(row.old_json, identifiers);
		const newJson = redactAuditSnapshot(row.new_json, identifiers);
		const note = actorErased || containsErasedIdentifier(row.note, identifiers) ? null : row.note;
		const actorUserId = actorErased ? DELETED_PROVIDER_ACTOR : row.actor_user_id;
		if (actorUserId === row.actor_user_id && oldJson === row.old_json
			&& newJson === row.new_json && note === row.note) continue;
		updates.push(env.DB.prepare(
			`UPDATE ai_routing_policy_audit
			    SET actor_user_id = ?, old_json = ?, new_json = ?, note = ?
			  WHERE id = ?`,
		).bind(actorUserId, oldJson, newJson, note, row.id));
	}
	// Bound each D1 transaction to a modest statement count. The tombstone is
	// already durable, so retries are safe if a later chunk fails.
	for (let offset = 0; offset < updates.length; offset += 50) {
		await env.DB.batch(updates.slice(offset, offset + 50));
	}
}

async function assertNoProviderControlIdentityResidue(env, { userId, emailNormalized }) {
	const emailNeedle = String(emailNormalized ?? "").trim().toLowerCase() || "\u0000no-email\u0000";
	const row = await env.DB.prepare(
		`SELECT (
		   SELECT COUNT(*) FROM ai_routing_policies
		    WHERE updated_by = ? OR lower(updated_by) = ?
		       OR instr(COALESCE(allowlist_json, ''), ?) > 0
		       OR instr(lower(COALESCE(allowlist_json, '')), ?) > 0
		 ) + (
		   SELECT COUNT(*) FROM ai_routing_policy_audit
		    WHERE actor_user_id = ? OR lower(actor_user_id) = ?
		       OR instr(COALESCE(old_json, ''), ?) > 0
		       OR instr(lower(COALESCE(old_json, '')), ?) > 0
		       OR instr(COALESCE(new_json, ''), ?) > 0
		       OR instr(lower(COALESCE(new_json, '')), ?) > 0
		       OR instr(COALESCE(note, ''), ?) > 0
		       OR instr(lower(COALESCE(note, '')), ?) > 0
		 ) + (
		   SELECT COUNT(*) FROM ai_provider_overrides
		    WHERE actor_user_id = ? OR lower(actor_user_id) = ?
		       OR instr(COALESCE(reason, ''), ?) > 0
		       OR instr(lower(COALESCE(reason, '')), ?) > 0
		 ) AS n`,
	).bind(
		userId, emailNeedle, userId, emailNeedle,
		userId, emailNeedle,
		userId, emailNeedle, userId, emailNeedle, userId, emailNeedle,
		userId, emailNeedle, userId, emailNeedle,
	).first();
	if (Number(row?.n ?? 0) !== 0) {
		throw new Error("account teardown left provider-control identity residue");
	}
}

/**
 * Full account teardown for the admin console and account-deletion requests:
 * all memory rows (via deleteAllMemories), then auth rows, then the user row.
 */
export async function deleteAccountCompletely(env, userId, options = {}) {
	const auditIntent = options?.auditIntent ?? null;
	const user = await env.DB.prepare("SELECT id, email_normalized FROM users WHERE id = ? LIMIT 1")
		.bind(userId).first();
	if (!user) {
		const unchanged = { deleted: false, already_deleted: true, memory_spaces: 0 };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}

	// Ownership is governance, not an implementation detail we may silently
	// discard. A shared organization must be transferred explicitly before its
	// owner can erase the account. This check runs before any memory mutation.
	const { results: ownedOrganizations } = await env.DB.prepare(
		"SELECT id FROM organizations WHERE owner_user_id = ? AND status = 'active'",
	).bind(userId).all();
	for (const org of ownedOrganizations ?? []) {
		const collaborators = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM organization_members WHERE org_id = ? AND user_id != ?",
		).bind(org.id, userId).first();
		if (Number(collaborators?.n ?? 0) > 0) {
			const error = new Error("Transfer or remove the other organization members before deleting this account.");
			error.name = "AccountDeletionError";
			error.code = "organization_transfer_required";
			error.status = 409;
			throw error;
		}
	}

	// Quiesce before discovering a single memory space. A request that already
	// crossed managed authorization has registered its exact (possibly hashed)
	// space; later requests now fail because the account/projects are inactive.
	// If any later erasure step fails, the account remains disabled, credentials
	// revoked, and retryable rather than returning to a writable partial state.
	const quiescedAt = Date.now();
	const quiesceStatements = [
		env.DB.prepare(
			`INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET erased_at = MIN(account_erasure_tombstones.erased_at, excluded.erased_at)`,
		).bind(userId, quiescedAt),
		...providerControlQuiesceStatements(env, {
			userId,
			emailNormalized: user.email_normalized,
			now: quiescedAt,
		}),
		// Reconciliation is intentionally able to recreate a missed outbox row
		// from a terminal primary run. Before shared-project provenance is
		// anonymized below, reserve those sampled runs with terminal markers in
		// this same quiesce transaction. The primary-run unique index makes this
		// idempotent and permanently prevents post-erasure resurrection.
		env.DB.prepare(
			`INSERT OR IGNORE INTO ai_shadow_jobs
			 (id, user_id, account_user_id, primary_run_id, provider, model, prompt_version,
			  status, attempts, lease_until, created_at, updated_at, terminal_at)
			 SELECT 'shadow_cancelled_' || er.id, er.user_id, NULL, er.id,
			        json_extract(er.pin_json, '$.shadow.provider'),
			        CASE WHEN json_type(er.pin_json, '$.shadow.model') = 'text'
			             THEN json_extract(er.pin_json, '$.shadow.model') ELSE NULL END,
			        NULL, 'cancelled_erased', 0, NULL, er.created_at, ?, ?
			   FROM extraction_runs er
			  WHERE er.status IN ('wrote', 'skipped', 'failed')
			    AND CASE WHEN json_valid(er.pin_json) THEN CASE
			      WHEN json_extract(er.pin_json, '$.shadow.sampled') = 1
			       AND json_type(er.pin_json, '$.shadow.provider') = 'text'
			      THEN 1 ELSE 0 END ELSE 0 END = 1
			    AND CASE WHEN json_valid(er.scope_json)
			      THEN COALESCE(
			        json_extract(er.scope_json, '$.account_user_id'),
			        json_extract(er.scope_json, '$.accountUserId')
			      ) ELSE NULL END = ?`,
		).bind(quiescedAt, quiescedAt, userId),
		// Existing rows may belong to a surviving shared project. Preserve their
		// content-free metrics, but erase this account's stable actor id and revoke
		// every live claim so a stale worker cannot write it back.
		env.DB.prepare(
			`UPDATE ai_shadow_jobs
			 SET account_user_id = CASE
			       WHEN status = 'invoking' AND (lease_until IS NULL OR lease_until > ?)
			       THEN account_user_id ELSE NULL END,
			     status = CASE
			       WHEN status IN ('pending', 'running')
			         OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
			       THEN 'cancelled_erased' ELSE status END,
			     claim_token = CASE
			       WHEN status IN ('pending', 'running')
			         OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
			       THEN NULL ELSE claim_token END,
			     lease_until = CASE
			       WHEN status IN ('pending', 'running')
			         OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
			       THEN NULL ELSE lease_until END,
			     error_class = CASE
			       WHEN status IN ('pending', 'running')
			         OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
			       THEN 'account_erased' ELSE error_class END,
			     terminal_at = CASE WHEN status IN ('pending', 'running')
			                        OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
			                        THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
			     updated_at = ?
			 WHERE account_user_id = ? OR user_id = ?`,
		).bind(
			quiescedAt, quiescedAt, quiescedAt, quiescedAt, quiescedAt, quiescedAt,
			quiescedAt, quiescedAt, userId, userId,
		),
		env.DB.prepare(
			"UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?",
		).bind(quiescedAt, userId),
		env.DB.prepare(
			"UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?",
		).bind(quiescedAt, userId),
		env.DB.prepare(
			`UPDATE connection_tokens
			 SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
			 WHERE user_id = ? AND (status != 'revoked' OR revoked_at IS NULL)`,
		).bind(quiescedAt, userId),
		// Every OAuth authorization dies with the account, in the same quiesce
		// batch as sessions and connection tokens. Erasure that left a live MCP
		// grant behind would be erasure in name only.
		...grantRevocationStatements(env, { userId, now: quiescedAt, reason: "account_erased" }),
		env.DB.prepare(
			`UPDATE managed_projects
			 SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ?
			 WHERE owner_user_id = ? AND status = 'active'
			   AND (organization_id IS NULL OR organization_id IN (
			     SELECT id FROM organizations WHERE owner_user_id = ? AND status = 'active'
			   ))`,
		).bind(quiescedAt, quiescedAt, userId, userId),
	];
	if (auditIntent) {
		await commitAuditedBatch(env, auditIntent, quiesceStatements, {
			postconditions: [
				auditInvariantStatement(
					env,
					"SELECT 1 FROM account_erasure_tombstones WHERE user_id = ? AND erased_at <= ?",
					[userId, quiescedAt],
				),
				auditInvariantStatement(
					env,
					"SELECT 1 FROM users WHERE id = ? AND status = 'disabled'",
					[userId],
				),
			],
		});
	} else await env.DB.batch(quiesceStatements);
	// Historical audit JSON can contain identifiers at arbitrary nesting depth,
	// including a serialized allowlist inside the snapshot. The tombstone above
	// now blocks fresh actor writes, so this structural scrub is race-closed and
	// retry-safe even though it may span several bounded D1 batches.
	await scrubProviderControlAudit(env, {
		userId,
		emailNormalized: user.email_normalized,
	});
	await assertNoProviderControlIdentityResidue(env, {
		userId,
		emailNormalized: user.email_normalized,
	});
	// The tombstone and producer fences are durable now. An invocation that
	// linearized before them may finish, but confirmed erasure cannot overtake
	// that external disclosure. The caller retries; the bounded invocation then
	// settles (or its lease expires) and the same idempotent teardown continues.
	await assertNoActiveShadowInvocation(env, {
		userId,
		accountUserId: userId,
		now: quiescedAt,
	});
	await assertNoActiveProviderInvocation(env, {
		memoryUserId: userId,
		accountUserId: userId,
	});
	await scrubProviderReservationLifecycle(env, {
		memoryUserId: userId,
		accountUserId: userId,
	});
	const ownedOrgIds = (ownedOrganizations ?? []).map((row) => row.id);
	const { results: ownedProjects } = await env.DB.prepare(
		`SELECT p.id FROM managed_projects p
		  WHERE p.owner_user_id = ?
		    AND (
		      p.organization_id IS NULL
		      OR p.organization_id IN (
		        SELECT o.id FROM organizations o WHERE o.owner_user_id = ? AND o.status = 'active'
		      )
		    )`,
	).bind(userId, userId).all();
	const ownedProjectIds = (ownedProjects ?? []).map((row) => row.id);
	// A managed project is implemented as a separate proven memory identity,
	// with optional end-user sub-tenants below it. Account erasure must discover
	// and erase every one of those identities before removing the control plane.
	const roots = new Set([userId]);
	try {
		const { results: projects } = await env.DB.prepare(
			`SELECT id, is_default, memory_owner_user_id FROM managed_projects
			  WHERE owner_user_id = ?
			    AND (organization_id IS NULL OR organization_id IN (
			      SELECT id FROM organizations WHERE owner_user_id = ? AND status = 'active'
			    ))`,
		).bind(userId, userId).all();
		for (const project of projects ?? []) {
			roots.add(project.memory_owner_user_id ?? await managedProjectMemoryOwnerId(userId, project));
		}
	} catch (error) {
		console.warn("account teardown: managed project inventory failed:", error?.message ?? error);
		throw error;
	}

	const memoryIds = new Set(roots);
	// The registry is the authoritative finite inventory for managed writes.
	// A tenant may have no source packet/episode yet (for example a commit that
	// registered the scope immediately before an erasure), so provenance tables
	// alone are insufficient and would let that tenant survive when the registry
	// is later removed. This read is deliberately fail-closed.
	if (ownedProjectIds.length) {
		const { results: registeredSpaces } = await env.DB.prepare(
			`SELECT DISTINCT memory_user_id AS id FROM project_memory_spaces
			  WHERE project_id IN (${ownedProjectIds.map(() => "?").join(",")})`,
		).bind(...ownedProjectIds).all();
		for (const row of registeredSpaces ?? []) if (row.id) memoryIds.add(row.id);
	}
	for (const root of roots) {
		const [packets, episodes, atoms] = await env.DB.batch([
			env.DB.prepare(
				`SELECT DISTINCT COALESCE(memory_user_id, user_id) AS id
				 FROM source_packets
				 WHERE owner_user_id = ? OR scope_user_id = ?`,
			).bind(root, root),
			env.DB.prepare(
				"SELECT DISTINCT COALESCE(memory_user_id, user_id) AS id FROM source_episodes WHERE owner_user_id = ?",
			).bind(root),
			env.DB.prepare(
				"SELECT DISTINCT COALESCE(memory_user_id, user_id) AS id FROM semantic_atom_candidates WHERE owner_user_id = ?",
			).bind(root),
		]);
		for (const row of [...(packets.results ?? []), ...(episodes.results ?? []), ...(atoms.results ?? [])]) {
			if (row.id) memoryIds.add(row.id);
		}
	}

	// USER_MEMORY owns private held messages, queued MCP/extraction jobs, replay
	// markers, and an alarm outside D1. Quiescence is already durable, so reset
	// every discovered root/sub-tenant now and fail closed if even one reset is
	// unavailable or fails. The permanent account tombstone makes retries safe;
	// the user/control-plane rows remain until all DO state is proven empty.
	if (!env.USER_MEMORY) {
		throw new Error("account teardown requires the USER_MEMORY binding");
	}
	for (const memoryId of memoryIds) {
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(memoryId));
		if (!stub || typeof stub.resetAll !== "function") {
			throw new Error("account teardown could not reset a memory coordinator");
		}
		await stub.resetAll();
	}

	const memoryResults = [];
	for (const memoryId of memoryIds) {
		memoryResults.push({
			user_id: memoryId,
			...(await bulkDeleteBySource(env, memoryId, {
				dryRun: false,
				confirm: true,
				by: "account_delete",
				barrierFloor: quiescedAt + 1,
			})),
		});
	}

	// Project-owned configuration and secondary copies are not part of a normal
	// "delete memories" reset, but they are part of complete account erasure.
	const projectTables = [
		"memory_pages",
		"nodes",
		"slices",
		"events",
		"edges",
		"candidates",
		"memory_profiles",
		"memory_suppressions",
		"manual_node_identities",
		"checkpoints",
		"node_topic_communities",
		"topic_communities",
		"manual_search_profiles",
		"manual_fact_identities",
		"manual_page_identities",
		"manual_page_versions",
		"memory_revisions",
		"memory_update_idempotency",
		"memory_projection_state",
		"semantic_atom_projections",
		"source_episodes",
		"semantic_atom_candidates",
		"semantic_atom_capture_runs",
		"staged_memories",
		"memory_source_links",
		"conversation_page_sources",
		"webhook_deliveries",
		"webhooks",
		"playground_messages",
		"playground_threads",
		"memory_exports",
		"memory_rules",
		"ai_calls",
		"ai_shadow_jobs",
		"receipts",
		"extraction_runs",
		"memory_jobs",
		"manual_page_write_epochs",
	];
	for (const memoryId of memoryIds) {
		for (const table of projectTables) {
			await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(memoryId).run();
		}
	}

	// Identity/security erasure is mandatory. These statements deliberately
	// share one D1 batch so a storage failure cannot leave a half-erased set and
	// then let the account row disappear. Failed-login rows may not yet have a
	// user id, so the normalized address is an equally authoritative erasure key.
	await env.DB.batch([
		// Shared-project content survives a departing member, but the surviving
		// provenance must no longer contain that account's stable identifier.
		env.DB.prepare(
			`UPDATE source_packets
			    SET external_user_id = CASE WHEN external_user_id = ? THEN NULL ELSE external_user_id END,
			        raw_meta_json = CASE
			          WHEN json_valid(raw_meta_json) AND json_extract(raw_meta_json, '$.account_user_id') = ?
			          THEN json_remove(raw_meta_json, '$.account_user_id') ELSE raw_meta_json END
			  WHERE external_user_id = ? OR (
			    json_valid(raw_meta_json) AND json_extract(raw_meta_json, '$.account_user_id') = ?
			  )`,
		).bind(userId, userId, userId, userId),
		env.DB.prepare(
			"UPDATE source_episodes SET external_user_id = NULL WHERE external_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE semantic_atom_candidates SET external_user_id = NULL WHERE external_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			`UPDATE receipts SET scope_json = json_remove(scope_json, '$.account_user_id')
			  WHERE json_valid(scope_json) AND json_extract(scope_json, '$.account_user_id') = ?`,
		).bind(userId),
		env.DB.prepare(
			`UPDATE extraction_runs SET scope_json = json_remove(scope_json, '$.account_user_id')
			  WHERE json_valid(scope_json) AND json_extract(scope_json, '$.account_user_id') = ?`,
		).bind(userId),
		// A departing member's usage rows belong to the surviving foreign memory
		// root/project. Preserve those content-free metrics, but sever the stable
		// account attribution just as the source/run provenance above is severed.
		env.DB.prepare("UPDATE ai_calls SET account_user_id = NULL WHERE account_user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM playground_messages WHERE account_user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM playground_threads WHERE account_user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM connection_tokens WHERE user_id = ?").bind(userId),
		// OAuth credentials are torn down with the rest of the account's
		// credentials. Children first: a token or code outliving its grant
		// would be an unreachable but real credential record.
		env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM oauth_authorization_codes WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM oauth_consent_requests WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM oauth_clients WHERE created_by_user_id = ?").bind(userId),
		env.DB.prepare(
			"DELETE FROM login_events WHERE user_id = ? OR email_normalized = ?",
		).bind(userId, user.email_normalized),
		...[...memoryIds].map((memoryId) => env.DB.prepare(
			"DELETE FROM error_reports WHERE user_id = ?",
		).bind(memoryId)),
	]);
	// Do not prove convergence from account_user_id alone. Older/in-flight
	// meters can already have anonymized that column while still carrying an
	// owned memory-space or managed-project locator. json_each keeps this check
	// bounded to three parameters even for accounts with many SDK subtenants.
	const usageIdentityResidue = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM ai_calls
		  WHERE account_user_id = ?
		     OR user_id IN (SELECT value FROM json_each(?))
		     OR managed_project_id IN (SELECT value FROM json_each(?))`,
	).bind(
		userId,
		JSON.stringify([...memoryIds]),
		JSON.stringify(ownedProjectIds),
	).first("n");
	if (Number(usageIdentityResidue ?? 0) !== 0) {
		throw new Error("account teardown left owned usage identity residue");
	}

	// Remove this account from organizations it does not own, including every
	// email-bearing invitation addressed to it. Delete its outbox copy first:
	// that row can still contain the recipient email and an encrypted live token
	// while an invitation is pending/retrying. Old project keys were already
	// removed above; the explicit revocation is belt-and-braces for partial rows.
	await env.DB.batch([
		// Foreign-tenant resources survive account erasure, but their provenance
		// must not keep a stable identifier for the deleted person. Nullable actor
		// columns are anonymized; the invitation creator is NOT NULL by schema, so
		// it receives one fixed non-user tombstone rather than a reversible value.
		env.DB.prepare(
			"UPDATE project_categories SET created_by_user_id = NULL WHERE created_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE project_categories SET updated_by_user_id = NULL WHERE updated_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE organization_members SET invited_by_user_id = NULL WHERE invited_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE project_members SET invited_by_user_id = NULL WHERE invited_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE retention_policies SET updated_by_user_id = NULL WHERE updated_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE retention_runs SET actor_user_id = NULL WHERE actor_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE organization_invitations SET invited_by_user_id = 'deleted_user' WHERE invited_by_user_id = ?",
		).bind(userId),
		env.DB.prepare(
			"UPDATE organization_invitations SET accepted_by_user_id = NULL WHERE accepted_by_user_id = ?",
		).bind(userId),
		env.DB.prepare("DELETE FROM project_members WHERE user_id = ?").bind(userId),
		env.DB.prepare("DELETE FROM organization_members WHERE user_id = ?").bind(userId),
		env.DB.prepare(
			`DELETE FROM invitation_email_outbox
			  WHERE invitation_id IN (
				SELECT id FROM organization_invitations
				 WHERE email_normalized = ?
			  )`,
		).bind(user.email_normalized),
		env.DB.prepare("DELETE FROM organization_invitations WHERE email_normalized = ?")
			.bind(user.email_normalized),
		env.DB.prepare(
			`UPDATE audit_event_completions
			    SET target_id = NULL
			  WHERE target_type IN ('member', 'user') AND target_id = ?`,
		).bind(userId),
		// Correlation dedupe belongs to the actor generation. Clear both values
		// while anonymising so two erased users who legitimately supplied the same
		// request id cannot collide under the COALESCE(..., 'system') unique index.
		env.DB.prepare(
			"UPDATE audit_events SET actor_user_id = NULL, request_id = NULL, dedupe_key = NULL WHERE actor_user_id = ?",
		).bind(userId),
		env.DB.prepare("UPDATE audit_events SET target_id = NULL WHERE target_type IN ('member', 'user') AND target_id = ?")
			.bind(userId),
	]);

	// Solo-owned organizations can be removed without orphaning anyone. Delete
	// child control-plane rows before the organization/project rows. No loop
	// constructs dynamic SQL from untrusted values; every id remains bound.
	for (const orgId of ownedOrgIds) {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM invitation_email_outbox WHERE org_id = ?").bind(orgId),
			env.DB.prepare("DELETE FROM organization_invitations WHERE org_id = ?").bind(orgId),
			env.DB.prepare("DELETE FROM project_members WHERE org_id = ?").bind(orgId),
			env.DB.prepare("DELETE FROM organization_members WHERE org_id = ?").bind(orgId),
			env.DB.prepare(
				"DELETE FROM audit_event_completions WHERE event_id IN (SELECT id FROM audit_events WHERE org_id = ?)",
			).bind(orgId),
			env.DB.prepare("DELETE FROM audit_events WHERE org_id = ?").bind(orgId),
		]);
	}
	for (const projectId of ownedProjectIds) {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM project_categories WHERE project_id = ?").bind(projectId),
			env.DB.prepare("DELETE FROM project_memory_spaces WHERE project_id = ?").bind(projectId),
			env.DB.prepare("DELETE FROM retention_fences WHERE project_id = ?").bind(projectId),
			env.DB.prepare("DELETE FROM retention_runs WHERE project_id = ?").bind(projectId),
			env.DB.prepare("DELETE FROM retention_policies WHERE project_id = ?").bind(projectId),
		]);
	}
	await env.DB.prepare(
		`DELETE FROM managed_projects WHERE owner_user_id = ?
		  AND (organization_id IS NULL OR organization_id IN (${ownedOrgIds.length ? ownedOrgIds.map(() => "?").join(",") : "NULL"}))`,
	).bind(userId, ...ownedOrgIds).run();
	for (const orgId of ownedOrgIds) {
		await env.DB.prepare("DELETE FROM organizations WHERE id = ? AND owner_user_id = ?")
			.bind(orgId, userId).run();
	}
	const deleteUser = env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'disabled'").bind(userId);
	const deleted = await deleteUser.run();
	if (Number(deleted?.meta?.changes ?? 0) !== 1) throw new Error("account deletion lost its final state transition");
	const result = { deleted: true, memory: memoryResults[0], memory_spaces: memoryResults.length };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

export async function deleteAllMemories(env, userId, confirm, { auditIntent = null } = {}) {
	if (confirm !== "DELETE ALL") {
		const unchanged = {
			deleted: false,
			reason: "confirmation text required",
			confirmationRequired: "DELETE ALL",
		};
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	const [nodeResult, pageResult] = await env.DB.batch([
		env.DB.prepare("SELECT id, label FROM nodes WHERE user_id = ?").bind(userId),
		env.DB.prepare("SELECT id, title FROM memory_pages WHERE user_id = ?").bind(userId),
	]);
	const nodes = nodeResult.results ?? [];
	const pages = pageResult.results ?? [];
	const tables = [
		"memory_pages",
		"nodes",
		"slices",
		"events",
		"edges",
		"candidates",
		"receipts",
		"extraction_runs",
		"source_packets",
		"memory_jobs",
		"memory_profiles",
		"memory_suppressions",
		"manual_node_identities",
		"checkpoints",
	];
	const internalManualTables = [
		"node_topic_communities",
		"topic_communities",
		"manual_search_profiles",
		"manual_fact_identities",
		"manual_page_identities",
		"manual_page_versions",
		"memory_revisions",
		"memory_update_idempotency",
		"memory_projection_state",
		// V3 / P0-D. Hard delete, and the FTS triggers drop the tokens with the
		// row — an episode surviving a "delete everything" would be the user's own
		// words, still searchable, after they asked us to erase them.
		// Projection rows reference candidates/source episodes by durable id and
		// must be removed first. The ledger has no user prose, but retaining it
		// after account erasure would violate provenance convergence.
		"semantic_atom_projections",
		"source_episodes",
		"semantic_atom_candidates",
		"semantic_atom_capture_runs",
		"staged_memories",
		// Provenance links carry no text, but a link that outlives the objects it
		// names is a record that the account once held a memory from that source.
		"memory_source_links",
		"conversation_page_sources",
	];
	const counts = {};
	for (const table of tables) {
		const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(userId).first();
		counts[table] = row?.count ?? 0;
	}
	const deletionStatements = [
		advanceManualPageWriteEpoch(env, userId, Date.now()),
		...[...tables, ...internalManualTables]
			.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
	];
	if (auditIntent) {
		await commitAuditedBatch(env, auditIntent, deletionStatements, {
			postconditions: [auditInvariantStatement(
				env,
				`SELECT 1 WHERE NOT EXISTS (
				   SELECT 1 FROM nodes WHERE user_id = ?
				   UNION ALL SELECT 1 FROM memory_pages WHERE user_id = ?
				   UNION ALL SELECT 1 FROM source_packets WHERE user_id = ?
				   UNION ALL SELECT 1 FROM source_episodes WHERE user_id = ?
				   UNION ALL SELECT 1 FROM semantic_atom_candidates WHERE user_id = ?
				 )`,
				[userId, userId, userId, userId, userId],
			)],
		});
	} else await env.DB.batch(deletionStatements);
	const vectorIds = [
		...(nodes ?? []).map((n) => n.id),
		...(pages ?? []).map((p) => `page:${p.id}`),
	];
	if (env.VECTORIZE && vectorIds.length) {
		try {
			await env.VECTORIZE.deleteByIds(vectorIds);
		} catch (error) {
			console.warn("memory reset vector cleanup failed:", error?.message ?? error);
			if (auditIntent) throw Object.assign(new Error("Memory reset needs retry after vector cleanup failed."), {
				code: "memory_reset_vector_failed",
			});
		}
	}
	let durableObjectReset = false;
	try {
		if (env.USER_MEMORY) {
			const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
			if (stub?.resetAll) {
				await stub.resetAll();
				durableObjectReset = true;
			}
		}
	} catch (err) {
		console.warn("durable object reset failed:", err?.message ?? err);
		if (auditIntent) throw Object.assign(new Error("Memory reset needs retry after coordinator cleanup failed."), {
			code: "memory_reset_coordinator_failed",
		});
	}
	if (auditIntent && !durableObjectReset) {
		throw Object.assign(new Error("Memory reset needs retry because its coordinator was unavailable."), {
			code: "memory_reset_coordinator_unavailable",
		});
	}
	const result = {
		deleted: true,
		reset: true,
		nodes: counts.nodes,
		pages: counts.memory_pages,
		counts,
		durableObjectReset,
	};
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

export async function clearFailedReceipts(env, userId) {
	const res = await env.DB.prepare(
		`DELETE FROM receipts
		 WHERE user_id = ? AND (saved_total = 0 OR outcome IN ('llm_failed', 'db_write_failed', 'meaningful_no_write'))`,
	)
		.bind(userId)
		.run();
	return { cleared: true, changes: res.meta?.changes ?? 0 };
}

function pageRepairText(page) {
	const markdownBody = String(page.full_markdown ?? "").replace(/^#\s+.+?(?:\n|$)/, "");
	return [
		page.topic_filter,
		page.short_summary,
		page.key_points_json,
		page.related_concepts_json,
		markdownBody,
	].filter(Boolean).join("\n");
}

function markdownWithTitleWithoutEvidence(markdown, title) {
	const body = String(markdown || "").replace(/^#\s+.+?(?:\n|$)/, "").trim();
	const withoutEvidence = body.replace(/\n*## Evidence\n[\s\S]*$/i, "").trim();
	const parts = [`# ${title}`];
	if (withoutEvidence) parts.push("", withoutEvidence);
	return parts.join("\n");
}

function titleRepairAllowed(page, text, nextTitle) {
	const current = normalizeLabel(page.title);
	const next = normalizeLabel(nextTitle);
	if (!next || current === next || isBadTitle(nextTitle)) return false;
	if (isBadTitle(page.title) || /memory research session|conversation summary/.test(current)) return true;
	const normText = normalizeLabel(text);
	if (/\buml\b/.test(current) && /\b(microsoft|resume|recruiting|job application|swe|software engineer)\b/.test(normText)) {
		return true;
	}
	if (/^(car|bike) research$/.test(current) && /\b(uml|universal memory|memory engine|memory pages|graph ux|cloudflare|d1|vectorize|mcp)\b/.test(normText)) {
		return true;
	}
	const similarity = topicSimilarity({ title: page.title }, { title: nextTitle, text });
	return similarity.score < 0.16 && similarity.right.domainScore >= 6;
}

function mixedDomainWarning(page, text) {
	const scored = scoreDomains(text).filter((item) => item.score >= 5);
	if (scored.length < 2) return null;
	const [first, second] = scored;
	if (first.score >= second.score + 4) return null;
	return `Page ${page.id} appears to mix ${first.label} and ${second.label}; repair kept changes conservative.`;
}

async function repairMemoryPages(env, userId) {
	const { results } = await env.DB.prepare(
		`SELECT id, COALESCE(revision, 1) AS revision, title, canonical_title, topic_filter, short_summary, full_markdown, key_points_json,
		        related_concepts_json, evidence_json, cluster
		 FROM memory_pages
		 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
	)
		.bind(userId)
		.all();
	let titlesRepaired = 0;
	let clustersRepaired = 0;
	let evidenceDeduped = 0;
	let pagesSkipped = 0;
	const titleRepairs = [];
	const clusterRepairs = [];
	const warnings = [];
	for (const page of results ?? []) {
		const text = pageRepairText(page);
		const nextTitle = generateTitle(text, { topic: page.topic_filter });
		const nextCluster = clusterForMemory({
			title: nextTitle,
			category: page.topic_filter,
			summary: page.short_summary,
			text,
			cluster: null,
		});
		const evidence = parseJsonArray(page.evidence_json);
		const dedupedEvidence = dedupeEvidence(evidence, 12);
		const mixed = mixedDomainWarning(page, text);
		if (mixed) warnings.push(mixed);

		const repairTitle = titleRepairAllowed(page, text, nextTitle);
		const repairCluster = nextCluster && page.cluster !== nextCluster && (!mixed || repairTitle);
		const repairEvidence = evidence.length !== dedupedEvidence.length;
		if (!repairTitle && !repairCluster && !repairEvidence) {
			pagesSkipped++;
			continue;
		}

		const title = repairTitle ? nextTitle : page.title;
		const cluster = repairCluster ? nextCluster : page.cluster;
		const fullMarkdown = markdownWithTitleWithoutEvidence(page.full_markdown, title);
		const repairWrite = await applyFencedUpdate(env.DB.prepare(
			// Fenced on the revision this repair pass read: an explicit user edit
			// committed since must survive, so a stale repair writes nothing.
			`UPDATE memory_pages
			 SET title = ?, canonical_title = ?, cluster = ?, evidence_json = ?, full_markdown = ?, updated_at = ?,
				revision = COALESCE(revision, 1) + 1
			 WHERE id = ? AND user_id = ? AND COALESCE(revision, 1) = ?`,
		)
			.bind(
				title,
				canonicalTitle(title),
				cluster,
				JSON.stringify(repairEvidence ? dedupedEvidence : evidence),
				fullMarkdown,
				Date.now(),
				page.id,
				userId,
				Number(page?.revision) >= 1 ? Number(page.revision) : 1,
			), { label: "page repair" });
		// A lost CAS means an explicit edit landed while the repair was computed.
		// Counting it as repaired would report work that never happened.
		if (!repairWrite.applied) { pagesSkipped++; continue; }
		if (repairTitle) {
			titlesRepaired++;
			titleRepairs.push({ id: page.id, from: page.title, to: title });
		}
		if (repairCluster) {
			clustersRepaired++;
			clusterRepairs.push({ id: page.id, from: page.cluster, to: cluster });
		}
		if (repairEvidence) evidenceDeduped++;
	}
	return {
		pagesChecked: results?.length ?? 0,
		titlesRepaired,
		clustersRepaired,
		evidenceDeduped,
		pagesSkipped,
		titleRepairs,
		clusterRepairs,
		warnings,
	};
}

export async function repairGraph(env, userId, opts = {}) {
	const warnings = [];
	const pageRepair = await repairMemoryPages(env, userId);
	warnings.push(...pageRepair.warnings);
	const clusters = await organizeUserClusters(env, userId);
	const junk = await cleanJunkMemories(env, userId, { confirm: opts.confirmJunk });
	if (junk.dryRun && junk.junkPreviewed) {
		warnings.push("Junk cleanup is preview-only until confirmJunk is CLEAN JUNK.");
	}
	return {
		repaired: true,
		pagesChecked: pageRepair.pagesChecked,
		clustersUpdated: clusters.updated ?? 0,
		clustersRepaired: pageRepair.clustersRepaired,
		evidenceDeduped: pageRepair.evidenceDeduped,
		junkPreviewed: junk.junkPreviewed ?? 0,
		junkArchived: junk.junkArchived ?? 0,
		titlesRepaired: pageRepair.titlesRepaired,
		pagesSkipped: pageRepair.pagesSkipped,
		titleRepairs: pageRepair.titleRepairs,
		clusterRepairs: pageRepair.clusterRepairs,
		skipped: {
			junkCleanup: junk.dryRun ? "preview_only" : null,
			relationBackfill: "preview_only_no_fake_edges",
		},
		warnings,
		relationBackfillPreview: {
			candidateEdges: 0,
			note: "No fake edges were created. Semantic edge backfill remains preview-only until strong evidence exists.",
		},
	};
}

/**
 * The tables whose live rows an unscoped delete must converge to zero, keyed
 * by the id-set name the sweep uses. `memory_pages` maps to the `pages` set.
 */
const ERASURE_TABLES = [
	["nodes", "nodes"], ["pages", "memory_pages"], ["slices", "slices"],
	["events", "events"], ["edges", "edges"], ["candidates", "candidates"],
];

/**
 * SRV-08: enumerate what an UNSCOPED delete owns from the AUTHORITATIVE tables,
 * never from run manifests. A row written by an extraction that raced an
 * earlier delete — or that never got a manifest at all — is still live here,
 * so it is still discoverable and removable (Mem0's delete_all enumerates its
 * vector store the same way; Graphiti's clear_data queries the graph by
 * group_id; see external-research.md §Q9).
 */
async function enumerateLiveScope(env, userId) {
	const ids = {
		nodes: new Set(), pages: new Set(), slices: new Set(), events: new Set(),
		edges: new Set(), candidates: new Set(),
	};
	for (const [setName, table] of ERASURE_TABLES) {
		const { results } = await env.DB.prepare(
			`SELECT id FROM ${table} WHERE user_id = ? AND deleted_at IS NULL LIMIT 10000`,
		).bind(userId).all();
		for (const row of results ?? []) ids[setName].add(row.id);
	}
	return ids;
}

/** Which of `candidateIds` are still LIVE rows of `table` for this user. */
async function filterLiveIds(env, userId, table, candidateIds) {
	const live = new Set();
	const list = [...candidateIds];
	for (let offset = 0; offset < list.length; offset += 50) {
		const chunk = list.slice(offset, offset + 50);
		const marks = chunk.map(() => "?").join(", ");
		const { results } = await env.DB.prepare(
			`SELECT id FROM ${table} WHERE user_id = ? AND deleted_at IS NULL AND id IN (${marks})`,
		).bind(userId, ...chunk).all();
		for (const row of results ?? []) live.add(row.id);
	}
	return live;
}

const idCounts = (ids) => ({
	nodes: ids.nodes.size,
	pages: ids.pages.size,
	slices: ids.slices.size,
	events: ids.events.size,
	edges: ids.edges.size,
	candidates: ids.candidates.size,
});

/**
 * Bulk delete (fix round 1, Part 3.2; rebuilt for SRV-08).
 *
 * Two distinct contracts (D19):
 *
 * UNSCOPED + confirmed = ERASURE. Enumerates from the authoritative tables
 * (manifests are bookkeeping, never the source of truth), records a per-tenant
 * deletion barrier, cancels in-flight extraction runs, and converges: work
 * ACCEPTED before the barrier can never produce durable rows after it — the
 * commit fence in write.js refuses it atomically, and queued entries settle
 * terminal `cancelled_by_delete` without a model call.
 *
 * SCOPED (source/before/after) = curation, not erasure: no barrier, and
 * accepted in-flight work keeps D15's honest-visibility contract. Its
 * enumeration walks ALL matching run manifests — including runs already
 * `status='deleted'`, which is how SRV-08 hid live rows — and intersects them
 * with live table state, so previews count what actually exists and repeats
 * converge.
 *
 * dry_run (the DEFAULT) counts everything that would go and touches nothing.
 * The destructive pass requires confirm=true and ends with: FTS rows gone,
 * Vectorize ids deleted, dependent summaries regenerated from surviving
 * facts, and one tombstone receipt for audit. Job rows are kept.
 */
export async function bulkDeleteBySource(env, userId, {
	source = null,
	before = null,
	after = null,
	dryRun = true,
	confirm = false,
	by = null,
	barrierFloor = null,
} = {}) {
	const beforeMs = Number(before);
	const afterMs = Number(after);
	const erasure = !source && !(Number.isFinite(beforeMs) && beforeMs > 0) && !(Number.isFinite(afterMs) && afterMs > 0);

	// Matching runs: for scoped deletes these ATTRIBUTE rows to the scope; for
	// erasure they are bookkeeping only. Never filtered by status — a run whose
	// output outlived its 'deleted' mark is exactly the SRV-08 specimen.
	const clauses = ["user_id = ?"];
	const binds = [userId];
	if (source) {
		// SRV-01: a run is in scope when the caller's filter names its engine
		// lane, its tool, OR the caller's own source label — the client_source
		// stamped through save/ingest into the run's scope. Without the third
		// arm, conversation-capture rows written with source:"X" were invisible
		// to `?source=X` and scoped deletion silently no-oped on them.
		clauses.push(
			"(source_mode = ? OR tool_name = ? OR (json_valid(scope_json) AND json_extract(scope_json, '$.client_source') = ?))",
		);
		binds.push(source, source, source);
	}
	if (Number.isFinite(beforeMs) && beforeMs > 0) {
		clauses.push("created_at < ?");
		binds.push(beforeMs);
	}
	if (Number.isFinite(afterMs) && afterMs > 0) {
		clauses.push("created_at > ?");
		binds.push(afterMs);
	}
	const { results: runs } = await env.DB.prepare(
		`SELECT id, status, source_mode, tool_name, scope_json, source_packet_id,
			created_nodes_json, created_pages_json,
			created_slices_json, created_events_json, created_edges_json, created_candidates_json
		 FROM extraction_runs WHERE ${clauses.join(" AND ")}`,
	).bind(...binds).all();

	const labels = [];
	const projectScopes = new Map();
	for (const run of runs ?? []) {
		let runScope = {};
		try { runScope = JSON.parse(run.scope_json ?? "{}") ?? {}; } catch {}
		const projectId = runScope.project_id ?? runScope.projectId ?? null;
		const projectName = runScope.project_name ?? runScope.projectName ?? null;
		projectScopes.set(projectId ?? "__global__", { project_id: projectId, project_name: projectName });
	}

	let ids;
	// Conversation Pages that keep out-of-scope sources are rebuilt, not
	// deleted (a derived artifact with independent support survives).
	const partialPages = new Map();
	if (erasure) {
		ids = await enumerateLiveScope(env, userId);
		const { results: sampleRows } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL LIMIT 30",
		).bind(userId).all();
		for (const row of sampleRows ?? []) if (row.label) labels.push(row.label);
	} else {
		const manifestIds = {
			nodes: new Set(), pages: new Set(), slices: new Set(), events: new Set(),
			edges: new Set(), candidates: new Set(),
		};
		const manifestLabels = new Map();
		for (const run of runs ?? []) {
			for (const item of parseJsonArray(run.created_nodes_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.nodes.add(id);
				if (id && item?.label) manifestLabels.set(id, item.label);
			}
			for (const item of parseJsonArray(run.created_pages_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.pages.add(id);
			}
			for (const item of parseJsonArray(run.created_slices_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.slices.add(id);
			}
			for (const item of parseJsonArray(run.created_events_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.events.add(id);
			}
			for (const item of parseJsonArray(run.created_edges_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.edges.add(id);
			}
			// Candidates carry their own evidence text — a delete that skips them
			// leaves the deleted content findable (Part 9 acceptance finding).
			for (const item of parseJsonArray(run.created_candidates_json)) {
				const id = item?.id ?? item;
				if (id) manifestIds.candidates.add(id);
			}
		}
		// Conversation Pages are created at the DOOR, not by the run, so no
		// manifest names them. Attribute them through their source links: a
		// page ALL of whose linked packets are in scope dies with the scope;
		// one that keeps out-of-scope sources is rebuilt from the survivors.
		const scopedPacketIds = new Set((runs ?? []).map((run) => run.source_packet_id).filter(Boolean));
		if (scopedPacketIds.size) {
			const packetList = [...scopedPacketIds];
			const linkedPageIds = new Set();
			for (let offset = 0; offset < packetList.length; offset += 90) {
				const chunk = packetList.slice(offset, offset + 90);
				const { results: linkRows } = await env.DB.prepare(
					`SELECT DISTINCT page_id FROM conversation_page_sources
					 WHERE user_id = ? AND source_packet_id IN (${chunk.map(() => "?").join(", ")})`,
				).bind(userId, ...chunk).all();
				for (const row of linkRows ?? []) if (row.page_id) linkedPageIds.add(row.page_id);
			}
			for (const pageId of linkedPageIds) {
				const { results: allLinks } = await env.DB.prepare(
					"SELECT source_packet_id FROM conversation_page_sources WHERE user_id = ? AND page_id = ?",
				).bind(userId, pageId).all();
				const surviving = (allLinks ?? []).filter((row) => !scopedPacketIds.has(row.source_packet_id));
				if (surviving.length === 0) manifestIds.pages.add(pageId);
				else partialPages.set(pageId, packetList);
			}
		}
		// Only what is still LIVE counts — the preview must describe reality,
		// and the destructive pass must converge on repeats.
		ids = {};
		for (const [setName, table] of ERASURE_TABLES) {
			ids[setName] = await filterLiveIds(env, userId, table, manifestIds[setName]);
		}
		for (const id of ids.nodes) {
			if (manifestLabels.has(id) && labels.length < 30) labels.push(manifestLabels.get(id));
		}
	}

	const counts = {
		// Runs already retired by an earlier cleanup — 'deleted' (consumed) or
		// 'cancelled_by_delete' (fenced) — are settled bookkeeping, not work
		// this delete would consume.
		runs: (runs ?? []).filter((run) => run.status !== "deleted" && run.status !== "cancelled_by_delete").length,
		...idCounts(ids),
		...(partialPages.size ? { pages_rewritten: partialPages.size } : {}),
	};

	// Accepted work still processing is named honestly either way. For a
	// scoped curation it will land AFTER this delete (D15). For an erasure the
	// confirmed pass CANCELS it (D19) — the preview says which is coming.
	const pending = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched', 'failed', 'completed')",
	).bind(userId).first();
	const pendingJobs = Number(pending?.n ?? 0);
	const pendingNote = pendingJobs > 0
		? (erasure
			? `${pendingJobs} accepted save(s) are still processing; a confirmed delete will cancel them.`
			: `${pendingJobs} accepted save(s) are still processing and will finish AFTER this delete; preview again afterwards to remove their output.`)
		: undefined;

	if (dryRun || !confirm) {
		return {
			ok: true, dry_run: true, would_delete: counts, sample_labels: labels,
			pending_jobs: pendingJobs, ...(pendingNote ? { note: pendingNote } : {}),
		};
	}

	const requestedBarrierFloor = Number(barrierFloor);
	const now = Number.isFinite(requestedBarrierFloor) && requestedBarrierFloor > 0
		? Math.max(Date.now(), requestedBarrierFloor)
		: Date.now();
	const config = getConfig(env);

	let cancelledRuns = 0;
	let cancelledSourceJobs = 0;
	let cancelledAtomicRuns = 0;
	let cancelledShadowJobs = 0;
	let sourcePacketsMinimized = 0;
	if (erasure) {
		// Barrier installation and revocation of work that has NOT entered an
		// external call are one D1 transaction. This is the other side of the
		// shadow worker's running→invoking admission CAS: exactly one wins first.
		// An expired invoking lease is bounded crash residue and can be retired;
		// a live invoking owner is deliberately left intact and checked below.
		const [, cancelledShadow] = await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET
					barrier_at = MAX(deletion_barriers.barrier_at, excluded.barrier_at),
					by = excluded.by`,
			).bind(userId, now, now, by ?? null),
			env.DB.prepare(
				`UPDATE ai_shadow_jobs
				 SET status = 'cancelled_erased', claim_token = NULL, lease_until = NULL,
				     error_class = 'memory_erased', terminal_at = COALESCE(terminal_at, ?), updated_at = ?
				 WHERE user_id = ? AND created_at <= ?
				   AND (
				     status IN ('pending', 'running')
				     OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
				   )`,
			).bind(now, now, userId, now, now),
		]);
		cancelledShadowJobs = Number(cancelledShadow?.meta?.changes ?? 0);
		// If call admission won the serialization race, the barrier remains armed
		// but no source/content row is touched and this erase does not claim
		// success. Retry after the provider call settles or its bounded lease ends.
		await assertNoActiveShadowInvocation(env, {
			userId,
			acceptedThrough: now,
			now,
		});
		await assertNoActiveProviderInvocation(env, {
			memoryUserId: userId,
			acceptedThrough: now,
		});
		await scrubProviderReservationLifecycle(env, {
			memoryUserId: userId,
			acceptedThrough: now,
		});
		// Source packets remain as the minimal idempotency/replay fence that keeps
		// an erased terminal write from receiving an acceptance-shaped 200. They
		// must not remain a shadow archive: remove every plaintext preview and
		// provenance snippet accepted at or before this barrier, replace the
		// request digest with a non-content sentinel, and clear user-supplied scope
		// metadata. A genuinely new post-barrier packet does not match this sweep.
		const minimized = await env.DB.prepare(
			`UPDATE source_packets SET
				content_hash = ?, content_preview = NULL, message_count = 0, raw_meta_json = '{}',
				source_id = NULL, source_role = NULL, topic = NULL,
				project_name = NULL, external_user_id = NULL,
				source_time = NULL, source_time_offset_minutes = NULL, source_time_precision = NULL,
				updated_at = ?
			 WHERE user_id = ? AND COALESCE(received_at, created_at, 0) <= ?`,
		).bind(ERASED_SOURCE_CONTENT_HASH, now, userId, now).run();
		sourcePacketsMinimized = Number(minimized.meta?.changes ?? 0);
		// E3's `awaiting_source` job deliberately has no Durable Object entry yet:
		// source preservation must finish before handoff. The DO therefore cannot
		// settle it during erasure, so the D1 owner closes it here after the barrier
		// is durable. Exact replay sees `cancelled_by_delete` and cannot resurrect
		// the source episode.
		const sourceJobs = await env.DB.prepare(
			`UPDATE memory_jobs
			 SET status = 'failed',
				error = 'cancelled_by_delete: source preservation was fenced before acceptance',
				completed_at = ?, updated_at = ?
			 WHERE user_id = ? AND status = 'awaiting_source'`,
		).bind(now, now, userId).run();
		cancelledSourceJobs = Number(sourceJobs.meta?.changes ?? 0);
		// In-flight runs are cancelled by name. The guarded running→committing
		// transition and the commit fence both observe this status, so a run
		// mid-model-call can never publish its rows afterwards.
		const cancelled = await env.DB.prepare(
			`UPDATE extraction_runs
			 SET status = 'cancelled_by_delete',
				error = 'cancelled_by_delete: a confirmed delete erased this scope while the save was processing',
				updated_at = ?
			 WHERE user_id = ? AND status IN ('running', 'committing')`,
		).bind(now, userId).run();
		cancelledRuns = Number(cancelled.meta?.changes ?? 0);
		const cancelledAtomic = await env.DB.prepare(
			`UPDATE semantic_atom_capture_runs
			 SET status = 'cancelled_by_delete', error_code = 'cancelled_by_delete',
				updated_at = ?, completed_at = ?
			 WHERE user_id = ? AND status = 'running'`,
		).bind(now, now, userId).run();
		cancelledAtomicRuns = Number(cancelledAtomic.meta?.changes ?? 0);
		// SRV-02: the Durable Object holds work D1 never sees — held ingest
		// chunks, queued entries, and no-write RESCUE buffers that keep raw
		// messages for a later flush to redeem. Content accepted before this
		// barrier must not sit there awaiting re-extraction under a fresh
		// acceptance time. The barrier is durable at this point, so failing
		// closed is safe: the erase reports failure, the client retries, and
		// the retry meets an already-armed barrier.
		if (!env.USER_MEMORY) {
			throw new Error("a confirmed erasure requires the USER_MEMORY binding to clear held work");
		}
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
		if (!stub || typeof stub.resetAll !== "function") {
			throw new Error("a confirmed erasure could not reach the memory coordinator to clear held work");
		}
		await stub.resetAll();
		// The reset just wiped those jobs' queue entries; nothing will ever
		// drain them. Close their D1 rows terminally (the reset serialized
		// behind any in-flight drain, so a job still 'queued'/'staged' here is
		// permanently ownerless). Post-barrier saves mint new jobs, untouched.
		const orphaned = await env.DB.prepare(
			`UPDATE memory_jobs
			 SET status = 'failed',
				error = 'cancelled_by_delete: a confirmed delete erased this scope before the save was processed',
				completed_at = ?, updated_at = ?
			 WHERE user_id = ? AND status IN ('queued', 'staged')`,
		).bind(now, now, userId).run();
		cancelledSourceJobs += Number(orphaned.meta?.changes ?? 0);
	}

	// The read-your-writes staging bridge answers recall until its rows settle,
	// so a confirmed delete must retire them too — deleted content staying
	// recallable for the enrichment window is the SRV-03 leak wearing a
	// deletion coat (SRV-06). Over-settling is the safe direction: staging is
	// a seconds-long bridge, never durable memory.
	const stagedSettled = await env.DB.prepare(
		"UPDATE staged_memories SET settled_at = ? WHERE user_id = ? AND settled_at IS NULL",
	).bind(now, userId).run();

	// V3 / P0-D: source episodes are the user's own permitted text, indexed for
	// search. A confirmed erasure must remove them, not tombstone them — a
	// soft-deleted episode is retained text with a flag on it. Scoped deletes
	// remove only the scope's episodes; an unscoped one removes them all.
	// Hard delete fires the FTS triggers, so the tokens go with the row.
	const episodeErasure = erasure
		? await deleteSourceEpisodes(env, userId)
		: await deleteSourceEpisodes(env, userId, {
			// A scoped curation removes only the episodes of the accepted writes it
			// matched, identified by the same run manifests that attribute every
			// other row to this scope.
			sourcePacketIds: [...new Set((runs ?? []).map((run) => run.source_packet_id).filter(Boolean))],
		});
	const episodesDeleted = Number(episodeErasure.deleted ?? 0);
	const atomicCandidatesDeleted = Number(episodeErasure.atomicCandidatesDeleted ?? 0);
	const atomicCaptureRunsDeleted = Number(episodeErasure.atomicCaptureRunsDeleted ?? 0);
	const atomicProjectionsDeleted = Number(episodeErasure.atomicProjectionsDeleted ?? 0);

	// The sweep, as a function of an id set — the erasure convergence loop
	// re-derives the set from live state and runs it again (Mem0's delete_all
	// shape: list from the authoritative store until it comes back empty).
	const deletedTotals = { nodes: 0, pages: 0, slices: 0, events: 0, edges: 0, candidates: 0 };
	let regenerated = 0;
	const sweep = async (sweepIds) => {
		// Nodes first: their cascade also removes their remaining slices/events/
		// edges, FTS rows, vectors, and regenerates neighbour summaries.
		for (const nodeId of sweepIds.nodes) {
			await deleteObject(env, userId, { kind: "node", id: nodeId, suppress: false });
		}
		// Rows that landed on PRE-EXISTING nodes (or between them, for edges):
		// the node cascade never saw these — delete them directly.
		const slicesLeft = [...sweepIds.slices];
		const eventsLeft = [...sweepIds.events];
		const edgesLeft = [...sweepIds.edges];

		// Which surviving nodes just lost facts? Their summaries are dirty.
		// (Resolved BEFORE the soft-delete so node_id lookups still match.)
		const touched = new Set();
		const list = async (table, rowIds) => {
			const out = [];
			for (const id of rowIds) {
				const row = await env.DB.prepare(`SELECT node_id FROM ${table} WHERE id = ? AND user_id = ?`)
					.bind(id, userId).first();
				if (row?.node_id) out.push(row.node_id);
			}
			return out;
		};
		for (const nodeId of await list("slices", slicesLeft)) touched.add(nodeId);
		for (const nodeId of await list("events", eventsLeft)) touched.add(nodeId);
		for (const edgeId of edgesLeft) {
			const row = await env.DB.prepare("SELECT from_node, to_node FROM edges WHERE id = ? AND user_id = ?")
				.bind(edgeId, userId).first();
			if (row?.from_node) touched.add(row.from_node);
			if (row?.to_node) touched.add(row.to_node);
		}
		for (const nodeId of sweepIds.nodes) touched.delete(nodeId);

		await softDeleteByIds(env, userId, "slices", slicesLeft, now);
		await softDeleteByIds(env, userId, "events", eventsLeft, now);
		await softDeleteByIds(env, userId, "edges", edgesLeft, now);
		await softDeleteByIds(env, userId, "candidates", [...sweepIds.candidates], now);
		for (const pageId of sweepIds.pages) {
			await deleteObject(env, userId, { kind: "page", id: pageId, suppress: false });
		}

		const regen = await regenerateDirtySummaries(
			env,
			userId,
			[...sweepIds.nodes, ...slicesLeft, ...eventsLeft, ...edgesLeft],
			[...touched],
		);
		regenerated += Number(regen.regenerated ?? 0);
		await purgeVectorArtifactsForObjects(env, config, userId, [...sweepIds.nodes]);
		if (touched.size) await refreshManualSearchProfiles(env, config, userId, { nodeIds: [...touched] });

		for (const [setName] of ERASURE_TABLES) deletedTotals[setName] += sweepIds[setName].size;
		return [...sweepIds.nodes, ...sweepIds.pages, ...slicesLeft, ...eventsLeft, ...edgesLeft, ...sweepIds.candidates];
	};

	const sweptIds = await sweep(ids);
	// Scoped curation: pages that keep out-of-scope sources lose the scoped
	// links and are rebuilt from what survives. Their revision history is
	// erased with the deleted content — old snapshots may quote it, and
	// history must never become an undeletable shadow copy.
	for (const [pageId, packetIds] of partialPages) {
		if (ids.pages?.has?.(pageId)) continue;
		for (let offset = 0; offset < packetIds.length; offset += 90) {
			const chunk = packetIds.slice(offset, offset + 90);
			await env.DB.prepare(
				`DELETE FROM conversation_page_sources
				 WHERE user_id = ? AND page_id = ? AND source_packet_id IN (${chunk.map(() => "?").join(", ")})`,
			).bind(userId, pageId, ...chunk).run();
		}
		const rebuilt = await rebuildConversationPageFromSources(env, userId, pageId);
		if (rebuilt.rebuilt) {
			await env.DB.batch(versionResidueStatements(env, userId, [pageId]));
			await deleteManualSearchObjects(env, config, userId, { pageIds: [pageId] });
			await refreshManualSearchProfiles(env, config, userId, { pageIds: [pageId] });
		} else if (rebuilt.reason === "no_surviving_content" || rebuilt.reason === "no_sources") {
			await deleteObject(env, userId, { kind: "page", id: pageId, suppress: false });
			deletedTotals.pages += 1;
			sweptIds.push(pageId);
		}
	}
	let convergencePasses = 1;
	if (erasure) {
		// Converge: anything that slipped in between enumeration and sweep is
		// still live in the authoritative tables — re-derive and sweep again,
		// bounded. (Post-barrier NEW work may legitimately appear concurrently;
		// the loop removes only what existed at each pass, and INV-3 makes any
		// remainder discoverable by the next delete.)
		for (let pass = 0; pass < 2; pass += 1) {
			const remaining = await enumerateLiveScope(env, userId);
			// Episodes are written at ACCEPT time, so one can land between the
			// enumeration and the sweep exactly as a graph row can. Convergence has
			// to include them or "erased" would be true of the graph and false of
			// the words the graph came from.
			const remainingEpisodes = await countSourceEpisodes(env, userId);
			const remainingAtoms = await countSemanticAtomCandidates(env, userId);
			const remainingProjections = await countSemanticAtomProjections(env, userId);
			const remainingAtomicRuns = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
			).bind(userId).first();
			if (
				remainingEpisodes === 0
				&& remainingAtoms === 0
				&& remainingProjections === 0
				&& Number(remainingAtomicRuns?.n ?? 0) === 0
				&& ERASURE_TABLES.every(([setName]) => remaining[setName].size === 0)
			) break;
			convergencePasses += 1;
			if (
				remainingEpisodes > 0
				|| remainingAtoms > 0
				|| remainingProjections > 0
				|| Number(remainingAtomicRuns?.n ?? 0) > 0
			) {
				await deleteSourceEpisodes(env, userId);
			}
			sweptIds.push(...await sweep(remaining));
		}
	}

	await storeDeletionTombstone(env, userId, {
		kind: "bulk_by_source",
		ids: sweptIds,
		by,
		source: "bulk_delete",
		projectScopes: [...projectScopes.values()],
	});
	// Keep the extraction ledger (and its source packet/job links) for audit,
	// and mark the runs this cleanup consumed. BOOKKEEPING ONLY: enumeration
	// never trusts these marks again (SRV-08), and runs a concurrent delete
	// already cancelled keep their `cancelled_by_delete` status.
	const consumedRuns = (runs ?? []).filter((run) => run.status !== "cancelled_by_delete");
	for (let offset = 0; offset < consumedRuns.length; offset += 50) {
		await env.DB.batch(consumedRuns.slice(offset, offset + 50).map((run) =>
			env.DB.prepare(
				"UPDATE extraction_runs SET status = 'deleted', updated_at = ? WHERE id = ? AND user_id = ? AND status NOT IN ('running', 'committing', 'cancelled_by_delete')",
			).bind(now, run.id, userId)));
	}

	return {
		ok: true, dry_run: false,
		// `runs` = runs consumed (marked retired) by this cleanup — the same
		// number the preview promised. Row totals report what was actually swept.
		deleted: { runs: counts.runs, ...deletedTotals },
		summaries_regenerated: regenerated,
		staged_settled: stagedSettled.meta?.changes ?? 0,
		source_episodes_deleted: episodesDeleted,
		semantic_atom_candidates_deleted: atomicCandidatesDeleted,
		semantic_atom_capture_runs_deleted: atomicCaptureRunsDeleted,
		semantic_atom_projections_deleted: atomicProjectionsDeleted,
		convergence_passes: convergencePasses,
		...(erasure ? {
			cancelled_runs: cancelledRuns,
			cancelled_source_jobs: cancelledSourceJobs,
			cancelled_atomic_runs: cancelledAtomicRuns,
			cancelled_shadow_jobs: cancelledShadowJobs,
			source_packets_minimized: sourcePacketsMinimized,
		} : {}),
		pending_jobs: pendingJobs,
		...(pendingJobs > 0
			? { note: erasure
				? `${pendingJobs} accepted save(s) were cancelled by this delete.`
				: pendingNote }
			: {}),
	};
}
