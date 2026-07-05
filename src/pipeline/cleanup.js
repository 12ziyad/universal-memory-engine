import { getConfig } from "../config.js";
import { addSuppression } from "../lib/db.js";
import { deleteNodeVectors } from "../lib/vectorize.js";
import { normalizeLabel } from "../lib/text.js";
import { clusterForMemory, organizeUserClusters } from "./clusters.js";
import { suppressPageKey } from "./pages.js";
import { dedupeEvidence, scoreDomains, topicSimilarity } from "./signals.js";
import { canonicalTitle, generateTitle, isBadTitle } from "./title.js";

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
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
			await env.DB.prepare("UPDATE nodes SET archived_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
				.bind(now, now, item.id, userId)
				.run();
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
	await deleteNodeVectors(env, getConfig(env), nodeIds);
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

	for (const p of pages) await suppressPage(env, userId, p.id, "delete_last_extraction");
	for (const n of nodes) await suppressNode(env, userId, n.id, "delete_last_extraction");

	const counts = {
		pages: await softDeleteByIds(env, userId, "memory_pages", pages.map((p) => p.id), now),
		nodes: await softDeleteByIds(env, userId, "nodes", nodes.map((n) => n.id), now),
		slices: await softDeleteByIds(env, userId, "slices", slices.map((s) => s.id), now),
		events: await softDeleteByIds(env, userId, "events", events.map((e) => e.id), now),
		edges: await softDeleteByIds(env, userId, "edges", edges.map((e) => e.id), now),
	};
	await deleteNodeVectors(env, getConfig(env), nodes.map((n) => n.id));
	await env.DB.prepare("UPDATE extraction_runs SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
		.bind("deleted", now, run.id, userId)
		.run();
	return { deleted: true, extraction_run_id: run.id, counts };
}

export async function deleteObject(env, userId, { kind, id, suppress = true }) {
	const now = Date.now();
	if (kind === "page" || kind === "memory_page") {
		if (suppress) await suppressPage(env, userId, id, "delete_selected");
		await env.DB.prepare("UPDATE memory_pages SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, suppress ? now : null, id, userId)
			.run();
		return { deleted: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		if (suppress) await suppressNode(env, userId, id, "delete_selected");
		await env.DB.batch([
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
		await deleteNodeVectors(env, getConfig(env), [id]);
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
		await env.DB.prepare("UPDATE memory_pages SET archived_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
		return { archived: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		await env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
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
	const { results: nodes } = await env.DB.prepare("SELECT id, label FROM nodes WHERE user_id = ?")
		.bind(userId)
		.all();
	const tables = [
		"memory_pages",
		"nodes",
		"slices",
		"events",
		"edges",
		"candidates",
		"receipts",
		"extraction_runs",
		"memory_suppressions",
		"checkpoints",
	];
	const counts = {};
	for (const table of tables) {
		const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(userId).first();
		counts[table] = row?.count ?? 0;
	}
	await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)));
	await deleteNodeVectors(env, getConfig(env), (nodes ?? []).map((n) => n.id));
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

function markdownWithTitleAndEvidence(markdown, title, evidence) {
	const body = String(markdown || "").replace(/^#\s+.+?(?:\n|$)/, "").trim();
	const withoutEvidence = body.replace(/\n*## Evidence\n[\s\S]*$/i, "").trim();
	const parts = [`# ${title}`];
	if (withoutEvidence) parts.push("", withoutEvidence);
	if (evidence?.length) {
		parts.push("", "## Evidence", ...evidence.slice(0, 8).map((item) => `- ${item.snippet}`));
	}
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
		const fullMarkdown = markdownWithTitleAndEvidence(page.full_markdown, title, repairEvidence ? dedupedEvidence : evidence);
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
