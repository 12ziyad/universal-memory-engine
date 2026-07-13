import { getConfig } from "../config.js";
import { addSuppression } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { normalizeLabel } from "../lib/text.js";
import { clusterForMemory, organizeUserClusters } from "./clusters.js";
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
	const node = await env.DB.prepare("SELECT id, label FROM nodes WHERE id = ? AND user_id = ?")
		.bind(nodeId, userId)
		.first();
	if (!node) return;
	await addSuppression(env, userId, {
		kind: "node",
		label: node.label,
		canonical_key: normalizeLabel(node.label),
		reason,
		source_object_id: node.id,
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
}, now) {
	const key = String(canonicalKey ?? "").trim();
	if (!kind || !key) return null;
	return env.DB.prepare(
		`INSERT INTO memory_suppressions
		 (id, user_id, kind, canonical_key, label, reason, source_object_id, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		newId("suppress"), userId, kind, key, label ?? key,
		reason ?? null, sourceObjectId ?? null, now,
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
			"SELECT id, title, canonical_title, topic_filter FROM memory_pages WHERE id = ? AND user_id = ?",
		).bind(pageId, userId).first();
		if (!page) continue;
		const titleSuppression = suppressionStatement(env, userId, {
			kind: "memory_page",
			label: page.title,
			canonicalKey: page.canonical_title,
			reason: "delete_last_extraction",
			sourceObjectId: page.id,
		}, now);
		if (titleSuppression) canonicalDeletes.push(titleSuppression);
		if (page.topic_filter) {
			const topicSuppression = suppressionStatement(env, userId, {
				kind: "memory_page",
				label: page.topic_filter,
				canonicalKey: page.topic_filter,
				reason: "delete_last_extraction",
				sourceObjectId: page.id,
			}, now);
			if (topicSuppression) canonicalDeletes.push(topicSuppression);
		}
	}
	for (const nodeId of nodeIds) {
		const node = await env.DB.prepare(
			"SELECT id, label FROM nodes WHERE id = ? AND user_id = ?",
		).bind(nodeId, userId).first();
		if (!node) continue;
		const nodeSuppression = suppressionStatement(env, userId, {
			kind: "node",
			label: node.label,
			canonicalKey: normalizeLabel(node.label),
			reason: "delete_last_extraction",
			sourceObjectId: node.id,
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
		const neighbourIds = [...new Set((touchingEdges ?? []).flatMap((edge) => [edge.from_node, edge.to_node])
			.filter((nodeId) => nodeId && nodeId !== id))];
		if (neighbourIds.length) await refreshManualSearchProfiles(env, getConfig(env), userId, { nodeIds: neighbourIds });
		return { deleted: true, kind: "node", id };
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
