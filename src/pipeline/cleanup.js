import { getConfig } from "../config.js";
import { addSuppression, storeReceipt } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { normalizeLabel } from "../lib/text.js";
import { deleteNodeVectors } from "../lib/vectorize.js";
import { clusterForMemory, organizeUserClusters } from "./clusters.js";
import { fallbackSummary } from "./pass2.js";
import { suppressPageKey } from "./pages.js";
import { dedupeEvidence, scoreDomains, topicSimilarity } from "./signals.js";
import { canonicalTitle, generateTitle, isBadTitle } from "./title.js";
import { deleteManualSearchObjects, refreshManualSearchProfiles } from "./manual_search_profiles.js";

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
export async function regenerateDirtySummaries(env, userId, deletedIds = [], touchedNodeIds = []) {
	const deleted = new Set(deletedIds.filter(Boolean));
	const touched = new Set(touchedNodeIds.filter(Boolean));
	if (deleted.size === 0 && touched.size === 0) return { regenerated: 0 };

	const { results: nodes } = await env.DB.prepare(
		`SELECT id, label, category, state, summary, cluster, summary_sources_json
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
		await env.DB.prepare(
			"UPDATE nodes SET summary = ?, summary_sources_json = ?, updated_at = ? WHERE id = ? AND user_id = ?",
		).bind(summary, provenance, Date.now(), node.id, userId).run();
		regenerated++;
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

export async function deleteObject(env, userId, { kind, id, suppress = true }) {
	const now = Date.now();
	if (kind === "page" || kind === "memory_page") {
		if (suppress) await suppressPage(env, userId, id, "delete_selected");
		await env.DB.batch([
			advanceManualPageWriteEpoch(env, userId, now),
			env.DB.prepare("DELETE FROM manual_page_identities WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("DELETE FROM manual_page_versions WHERE user_id = ? AND page_id = ?").bind(userId, id),
			env.DB.prepare("UPDATE memory_pages SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
				.bind(now, suppress ? now : null, id, userId),
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
		]);
		await deleteManualSearchObjects(env, getConfig(env), userId, { nodeIds: [id] });
		// The full cascade (Part 3.3): the vector goes too (async on Vectorize's
		// side — recall's live-row filter hides it meanwhile), and neighbours
		// whose summaries were built from this node's facts are regenerated.
		await deleteNodeVectors(env, getConfig(env), [id]);
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
			// The same fact-identity cleanup the bulk path does for slices, so the
			// canonical key is freed and re-saving that fact later counts as new.
			env.DB.prepare("DELETE FROM manual_fact_identities WHERE user_id = ? AND object_id = ?").bind(userId, id),
			env.DB.prepare("UPDATE slices SET deleted_at = ?, is_current = 0 WHERE id = ? AND user_id = ?").bind(now, id, userId),
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
		await env.DB.prepare("UPDATE candidates SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, suppress ? now : null, id, userId)
			.run();
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

/**
 * Full account teardown for the admin console and account-deletion requests:
 * all memory rows (via deleteAllMemories), then auth rows, then the user row.
 */
export async function deleteAccountCompletely(env, userId) {
	const memory = await deleteAllMemories(env, userId, "DELETE ALL");
	for (const table of ["sessions", "connection_tokens", "login_events"]) {
		try {
			await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
		} catch (error) {
			console.warn(`account teardown: ${table} delete failed:`, error?.message ?? error);
		}
	}
	await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
	return { deleted: true, memory };
}

export async function deleteAllMemories(env, userId, confirm) {
	if (confirm !== "DELETE ALL") {
		return {
			deleted: false,
			reason: "confirmation text required",
			confirmationRequired: "DELETE ALL",
		};
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
	];
	const counts = {};
	for (const table of tables) {
		const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(userId).first();
		counts[table] = row?.count ?? 0;
	}
	await env.DB.batch([
		advanceManualPageWriteEpoch(env, userId, Date.now()),
		...[...tables, ...internalManualTables]
			.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
	]);
	const vectorIds = [
		...(nodes ?? []).map((n) => n.id),
		...(pages ?? []).map((p) => `page:${p.id}`),
	];
	if (env.VECTORIZE && vectorIds.length) {
		try {
			await env.VECTORIZE.deleteByIds(vectorIds);
		} catch (error) {
			console.warn("memory reset vector cleanup failed:", error?.message ?? error);
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
	}
	return {
		deleted: true,
		reset: true,
		nodes: counts.nodes,
		pages: counts.memory_pages,
		counts,
		durableObjectReset,
	};
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
		`SELECT id, title, canonical_title, topic_filter, short_summary, full_markdown, key_points_json,
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
		await env.DB.prepare(
			`UPDATE memory_pages
			 SET title = ?, canonical_title = ?, cluster = ?, evidence_json = ?, full_markdown = ?, updated_at = ?
			 WHERE id = ? AND user_id = ?`,
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
			)
			.run();
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
 * Bulk delete by source (fix round 1, Part 3.2). Deletion is scoped by the
 * extraction ledger: every engine write records what it created on its
 * extraction_runs row, so "delete what source X wrote between A and B" is a
 * walk over those lists — including edges that joined two PRE-EXISTING nodes,
 * which no node cascade would ever reach.
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
} = {}) {
	const clauses = ["user_id = ?", "(status IS NULL OR status != 'deleted')"];
	const binds = [userId];
	if (source) {
		clauses.push("(source_mode = ? OR tool_name = ?)");
		binds.push(source, source);
	}
	const beforeMs = Number(before);
	if (Number.isFinite(beforeMs) && beforeMs > 0) {
		clauses.push("created_at < ?");
		binds.push(beforeMs);
	}
	const afterMs = Number(after);
	if (Number.isFinite(afterMs) && afterMs > 0) {
		clauses.push("created_at > ?");
		binds.push(afterMs);
	}
	const { results: runs } = await env.DB.prepare(
		`SELECT id, source_mode, tool_name, scope_json, created_nodes_json, created_pages_json,
			created_slices_json, created_events_json, created_edges_json, created_candidates_json
		 FROM extraction_runs WHERE ${clauses.join(" AND ")}`,
	).bind(...binds).all();

	const ids = {
		nodes: new Set(), pages: new Set(), slices: new Set(), events: new Set(),
		edges: new Set(), candidates: new Set(),
	};
	const labels = [];
	const projectScopes = new Map();
	for (const run of runs ?? []) {
		let runScope = {};
		try { runScope = JSON.parse(run.scope_json ?? "{}") ?? {}; } catch {}
		const projectId = runScope.project_id ?? runScope.projectId ?? null;
		const projectName = runScope.project_name ?? runScope.projectName ?? null;
		projectScopes.set(projectId ?? "__global__", { project_id: projectId, project_name: projectName });
		for (const item of parseJsonArray(run.created_nodes_json)) {
			const id = item?.id ?? item;
			if (id) ids.nodes.add(id);
			if (item?.label && labels.length < 30) labels.push(item.label);
		}
		for (const item of parseJsonArray(run.created_pages_json)) {
			const id = item?.id ?? item;
			if (id) ids.pages.add(id);
		}
		for (const item of parseJsonArray(run.created_slices_json)) {
			const id = item?.id ?? item;
			if (id) ids.slices.add(id);
		}
		for (const item of parseJsonArray(run.created_events_json)) {
			const id = item?.id ?? item;
			if (id) ids.events.add(id);
		}
		for (const item of parseJsonArray(run.created_edges_json)) {
			const id = item?.id ?? item;
			if (id) ids.edges.add(id);
		}
		// Candidates carry their own evidence text — a delete that skips them
		// leaves the deleted content findable (Part 9 acceptance finding).
		for (const item of parseJsonArray(run.created_candidates_json)) {
			const id = item?.id ?? item;
			if (id) ids.candidates.add(id);
		}
	}

	const counts = {
		runs: (runs ?? []).length,
		nodes: ids.nodes.size,
		pages: ids.pages.size,
		slices: ids.slices.size,
		events: ids.events.size,
		edges: ids.edges.size,
		candidates: ids.candidates.size,
	};

	// Accepted work still processing will land AFTER this delete (the server
	// owns its liveness). Saying so is the difference between an honest zero
	// and a user who deleted "everything" and then watches memory reappear.
	const pending = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched', 'failed', 'completed')",
	).bind(userId).first();
	const pendingJobs = Number(pending?.n ?? 0);
	const pendingNote = pendingJobs > 0
		? `${pendingJobs} accepted save(s) are still processing and will finish AFTER this delete; preview again afterwards to remove their output.`
		: undefined;

	if (dryRun || !confirm) {
		return {
			ok: true, dry_run: true, would_delete: counts, sample_labels: labels,
			pending_jobs: pendingJobs, ...(pendingNote ? { note: pendingNote } : {}),
		};
	}

	const now = Date.now();
	const config = getConfig(env);

	// The read-your-writes staging bridge answers recall until its rows settle,
	// so a confirmed delete must retire them too — deleted content staying
	// recallable for the enrichment window is the SRV-03 leak wearing a
	// deletion coat (SRV-06). Over-settling is the safe direction: staging is
	// a seconds-long bridge, never durable memory.
	const stagedSettled = await env.DB.prepare(
		"UPDATE staged_memories SET settled_at = ? WHERE user_id = ? AND settled_at IS NULL",
	).bind(now, userId).run();

	// Nodes first: their cascade also removes their remaining slices/events/
	// edges, FTS rows, vectors, and regenerates neighbour summaries.
	for (const nodeId of ids.nodes) {
		await deleteObject(env, userId, { kind: "node", id: nodeId, suppress: false });
	}
	// Rows that landed on PRE-EXISTING nodes (or between them, for edges):
	// the node cascade never saw these — delete them directly.
	const slicesLeft = [...ids.slices];
	const eventsLeft = [...ids.events];
	const edgesLeft = [...ids.edges];
	await softDeleteByIds(env, userId, "slices", slicesLeft, now);
	await softDeleteByIds(env, userId, "events", eventsLeft, now);
	await softDeleteByIds(env, userId, "edges", edgesLeft, now);
	await softDeleteByIds(env, userId, "candidates", [...ids.candidates], now);
	for (const pageId of ids.pages) {
		await deleteObject(env, userId, { kind: "page", id: pageId, suppress: false });
	}

	// Which surviving nodes just lost facts? Their summaries are dirty.
	const touched = new Set();
	if (slicesLeft.length || eventsLeft.length) {
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
	}
	for (const edgeId of edgesLeft) {
		const row = await env.DB.prepare("SELECT from_node, to_node FROM edges WHERE id = ? AND user_id = ?")
			.bind(edgeId, userId).first();
		if (row?.from_node) touched.add(row.from_node);
		if (row?.to_node) touched.add(row.to_node);
	}
	for (const nodeId of ids.nodes) touched.delete(nodeId);

	const { regenerated } = await regenerateDirtySummaries(
		env,
		userId,
		[...ids.nodes, ...slicesLeft, ...eventsLeft, ...edgesLeft],
		[...touched],
	);
	await deleteNodeVectors(env, config, [...ids.nodes]);
	if (touched.size) await refreshManualSearchProfiles(env, config, userId, { nodeIds: [...touched] });

	await storeDeletionTombstone(env, userId, {
		kind: "bulk_by_source",
		ids: [...ids.nodes, ...ids.pages, ...slicesLeft, ...eventsLeft, ...edgesLeft, ...ids.candidates],
		by,
		source: "bulk_delete",
		projectScopes: [...projectScopes.values()],
	});
	// Keep the extraction ledger (and its source packet/job links) for audit,
	// but retire exactly the runs consumed by this successful cleanup so a
	// repeated preview is an honest zero.
	for (let offset = 0; offset < (runs ?? []).length; offset += 50) {
		await env.DB.batch((runs ?? []).slice(offset, offset + 50).map((run) =>
			env.DB.prepare(
				"UPDATE extraction_runs SET status = 'deleted', updated_at = ? WHERE id = ? AND user_id = ?",
			).bind(now, run.id, userId)));
	}

	return {
		ok: true, dry_run: false, deleted: counts, summaries_regenerated: regenerated,
		staged_settled: stagedSettled.meta?.changes ?? 0,
		pending_jobs: pendingJobs, ...(pendingNote ? { note: pendingNote } : {}),
	};
}
