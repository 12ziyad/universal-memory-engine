/**
 * Pass 2 — background, separate, cheap. Runs AFTER Pass-1 structural writes have
 * committed. It refreshes affected nodes' `summary` (a short rollup) and rolls up
 * slices when a node exceeds the threshold (preserving state changes, milestones
 * and decisions by keeping non-superseded slices current).
 *
 * A Pass-2 failure must NEVER affect Pass-1 writes: the whole thing is wrapped in
 * try/catch and only ever runs once Pass 1 is already durable.
 */

import { getCurrentSlices, getNodeEvents } from "../lib/db.js";
import { clusterForMemory } from "./clusters.js";

async function summarizeNode(env, config, node, slices, events) {
	if (!env.AI) return null;
	const facts = [
		`Label: ${node.label} (category: ${node.category}, state: ${node.state})`,
		...slices.slice(0, 12).map((s) => `- ${s.kind}: ${s.text}`),
		...events.slice(0, 6).map((e) => `- ${e.action}: ${e.text}`),
	].join("\n");
	const res = await env.AI.run(
		config.llm.summaryModel,
		{
			messages: [
				{
					role: "system",
					content:
						"Write a single concise sentence (max 25 words) summarizing this memory node. No preamble, no quotes.",
				},
				{ role: "user", content: facts },
			],
			temperature: 0,
			max_tokens: config.llm.summaryMaxTokens,
		},
		config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
	);
	const text = (res?.response ?? "").trim();
	return text || null;
}

function fallbackSummary(node, slices, events) {
	const facts = [
		...slices.map((s) => s.text),
		...events.map((e) => e.text),
	].filter(Boolean);
	if (facts.length) return `${node.label}: ${facts.slice(0, 2).join("; ")}`.slice(0, 240);
	return `${node.label} is ${node.state ?? "active"} ${node.category ?? "memory"}`.replace(/\s+/g, " ").trim();
}

async function summarizeNodeBestEffort(env, config, node, slices, events) {
	if (config.enablePass2 && config.pass2UseAi && env.AI) {
		try {
			const summary = await summarizeNode(env, config, node, slices, events);
			if (summary) return summary;
		} catch (err) {
			console.warn(`pass2 summary AI failed node=${node.id}:`, err?.message ?? err);
		}
	}
	return fallbackSummary(node, slices, events);
}

function activeWhere(alias = "") {
	const p = alias ? `${alias}.` : "";
	return `${p}deleted_at IS NULL AND ${p}archived_at IS NULL AND ${p}suppressed_at IS NULL`;
}

function topByUpdated(items, limit) {
	return [...items]
		.sort((a, b) => Number(b.updated_at ?? b.last_seen_at ?? 0) - Number(a.updated_at ?? a.last_seen_at ?? 0))
		.slice(0, limit);
}

async function refreshProfile(env, userId, sourceJobId = null) {
	const [nodesRes, pagesRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, state, summary, cluster, updated_at, last_seen_at, heat_score
			 FROM nodes WHERE user_id = ? AND ${activeWhere()}`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, title, topic_filter, short_summary, cluster, updated_at, heat_score
			 FROM memory_pages WHERE user_id = ? AND ${activeWhere()}`,
		).bind(userId),
	]);
	const nodes = nodesRes.results ?? [];
	const pages = pagesRes.results ?? [];
	const clusterCounts = new Map();
	const hints = [];

	for (const node of nodes) {
		const cluster = node.cluster ?? clusterForMemory(node);
		clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
		hints.push({
			type: "node",
			id: node.id,
			cluster,
			label: node.label,
			category: node.category,
			summary: node.summary,
			updated_at: node.updated_at ?? node.last_seen_at ?? null,
			heat_score: node.heat_score ?? 1,
		});
	}
	for (const page of pages) {
		const cluster = page.cluster ?? clusterForMemory({
			title: page.title,
			category: page.topic_filter,
			summary: page.short_summary,
		});
		clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
		hints.push({
			type: "page",
			id: page.id,
			cluster,
			label: page.title,
			category: page.topic_filter,
			summary: page.short_summary,
			updated_at: page.updated_at ?? null,
			heat_score: page.heat_score ?? 1,
		});
	}

	const byCluster = new Map();
	for (const hint of hints) {
		if (!byCluster.has(hint.cluster)) byCluster.set(hint.cluster, []);
		byCluster.get(hint.cluster).push(hint);
	}
	const familySummaries = [...byCluster.entries()]
		.map(([cluster, items]) => {
			const top = topByUpdated(items, 5);
			return {
				cluster,
				count: items.length,
				labels: top.map((item) => item.label),
				summary: top.map((item) => item.summary).filter(Boolean).slice(0, 3).join(" "),
			};
		})
		.sort((a, b) => b.count - a.count);

	const now = Date.now();
	const profile = {
		node_count: nodes.length,
		page_count: pages.length,
		cluster_counts: Object.fromEntries([...clusterCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
		top_labels: topByUpdated(hints, 12).map((item) => item.label),
		updated_at: now,
	};
	const clusterHints = topByUpdated(hints, 24).map((item) => ({
		type: item.type,
		id: item.id,
		cluster: item.cluster,
		label: item.label,
		category: item.category,
		summary: item.summary,
	}));

	await env.DB.prepare(
		`INSERT INTO memory_profiles
			(user_id, profile_json, cluster_hints_json, family_summaries_json, source_job_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			profile_json = excluded.profile_json,
			cluster_hints_json = excluded.cluster_hints_json,
			family_summaries_json = excluded.family_summaries_json,
			source_job_id = excluded.source_job_id,
			updated_at = excluded.updated_at`,
	)
		.bind(
			userId,
			JSON.stringify(profile),
			JSON.stringify(clusterHints),
			JSON.stringify(familySummaries),
			sourceJobId,
			now,
			now,
		)
		.run();
	return { profile, clusterHints: clusterHints.length, familySummaries: familySummaries.length };
}

export async function runPass2(env, config, userId, affectedNodeIds, opts = {}) {
	if (!config.enablePass2 && !opts.force) return { ran: false, reason: "disabled" };
	let refreshed = 0;
	let rolledUp = 0;
	let clustered = 0;
	const uniqueNodeIds = [...new Set(affectedNodeIds ?? [])].filter(Boolean);
	for (const nodeId of uniqueNodeIds) {
		try {
			const node = await env.DB.prepare(
				"SELECT id, label, category, state, summary, cluster FROM nodes WHERE id = ? AND user_id = ?",
			)
				.bind(nodeId, userId)
				.first();
			if (!node) continue;

			const slices = await getCurrentSlices(env, userId, nodeId);
			const events = await getNodeEvents(env, userId, nodeId);

			// Refresh summary.
			const summary = await summarizeNodeBestEffort(env, config, node, slices, events);
			const cluster = clusterForMemory({ ...node, summary });
			if (summary) {
				await env.DB.prepare("UPDATE nodes SET summary = ?, cluster = ?, updated_at = ? WHERE id = ? AND user_id = ?")
					.bind(summary, cluster, Date.now(), nodeId, userId)
					.run();
				refreshed++;
				if (node.cluster !== cluster) clustered++;
			}

			// Roll up slices if the node has too many current ones. Conservative for
			// now: keep the most recent N current, demote the oldest extras. State
			// changes live in events, so they are never lost by this.
			if (slices.length > config.sliceRollupThreshold) {
				const sorted = [...slices].sort((a, b) => a.created_at - b.created_at);
				const demote = sorted.slice(0, slices.length - config.sliceRollupThreshold);
				for (const s of demote) {
					await env.DB.prepare("UPDATE slices SET is_current = 0 WHERE id = ? AND user_id = ?")
						.bind(s.id, userId)
						.run();
					rolledUp++;
				}
			}
		} catch (err) {
			// Never let a Pass-2 problem bubble up into Pass 1.
			console.warn(`pass2 node ${nodeId} failed:`, err?.message ?? err);
		}
	}
	const profile = await refreshProfile(env, userId, opts.jobId ?? null);
	return {
		ran: true,
		refreshed,
		rolledUp,
		clustered,
		profileUpdated: true,
		profile,
	};
}
