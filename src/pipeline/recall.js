/**
 * Bounded recall for graph nodes and manual_collect memory pages.
 *
 * The before-answer path is intentionally explicit:
 * recall gate -> hybrid entry detection -> cluster activation -> local graph
 * expansion -> scoring/dedup -> context compression.
 */

import { embed } from "../lib/embeddings.js";
import { queryNodeVectors } from "../lib/vectorize.js";
import { tokens, normalizeLabel, wordContains } from "../lib/text.js";
import { resolveScope } from "./source.js";
import { classifyMessage } from "./trigger.js";

const TOP_N = 8;
const MAX_EVENTS_PER_NODE = 8;
const EVENT_SCAN_LIMIT = 500;
const MAX_CONTEXT_NODES = 6;
const MAX_CONTEXT_PAGES = 4;
const MAX_LINE_ITEMS = 4;
const MAX_CONTEXT_CHARS = 1800;
const NO_RECALL_RE =
	/^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|nice|great|awesome|good morning|good night|what is \d+\s*[+\-*/]\s*\d+\??)$/i;
const UPDATE_RE =
	/\b(latest|recent|current|updates?|what changed|changed lately|active now|actually|correction|no longer|from now on|replace|instead|forget that)\b/i;
const BROAD_RE =
	/\b(what do you know|remember about me|about me|my profile|everything|all memories|who am i|my projects|my health|my family|my goals|my preferences|my skills|my habits|my work|my tools|projects|health|family|goals|preferences|skills|habits|work|tools)\b/i;

function emptyRecall(plan, extras = {}) {
	return {
		ok: true,
		recall_mode: plan.mode,
		mode: plan.mode,
		reason: plan.reason,
		context: "",
		items: [],
		count: 0,
		nodes: [],
		pages: [],
		activated_clusters: [],
		vector_used: false,
		lexical_used: false,
		graph_expansion_used: false,
		compressed: false,
		...extras,
	};
}

export function recallGate(query, opts = {}) {
	const q = String(query ?? "").trim();
	const base = {
		topN: TOP_N,
		maxContextNodes: MAX_CONTEXT_NODES,
		maxContextPages: MAX_CONTEXT_PAGES,
		maxLineItems: MAX_LINE_ITEMS,
		maxEventsPerNode: MAX_EVENTS_PER_NODE,
		eventScanLimit: EVENT_SCAN_LIMIT,
		maxContextChars: MAX_CONTEXT_CHARS,
	};
	if (!q) {
		return {
			mode: "no_recall",
			reason: "empty_query",
			topN: 0,
			maxContextNodes: 0,
			maxContextPages: 0,
			maxLineItems: 0,
			maxEventsPerNode: 0,
			eventScanLimit: 0,
			maxContextChars: 0,
		};
	}
	const lower = q.toLowerCase();
	if (NO_RECALL_RE.test(lower)) {
		return { ...base, mode: "no_recall", reason: "smalltalk_or_self_contained", topN: 0 };
	}
	const broad = BROAD_RE.test(lower);
	const update = UPDATE_RE.test(lower);
	if (!broad && !update && classifyMessage(q) === "utility") {
		return { ...base, mode: "no_recall", reason: "utility_query", topN: 0 };
	}
	if (update) {
		return {
			mode: "update_mode",
			reason: "recent_or_correction_query",
			topN: 10,
			maxContextNodes: 7,
			maxContextPages: 5,
			maxLineItems: 5,
			maxEventsPerNode: 10,
			eventScanLimit: 700,
			maxContextChars: 2400,
		};
	}
	if (broad) {
		return {
			mode: "deep_recall",
			reason: "broad_profile_query",
			topN: 14,
			maxContextNodes: 8,
			maxContextPages: 6,
			maxLineItems: 5,
			maxEventsPerNode: 10,
			eventScanLimit: 800,
			maxContextChars: 2800,
		};
	}
	return { ...base, mode: "light_recall", reason: opts.reason ?? "targeted_query" };
}

function tokenMatches(a, b) {
	if (a === b) return true;
	if (a.length >= 4 && b.startsWith(a)) return true;
	if (b.length >= 4 && a.startsWith(b)) return true;
	return false;
}

function keywordScore(corpusTokens, queryTokens) {
	let matched = 0;
	for (const q of queryTokens) {
		if (corpusTokens.some((c) => tokenMatches(q, c))) matched++;
	}
	return matched;
}

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function entryCluster(entry) {
	if (entry.type === "node") return entry.item?.cluster ?? null;
	return entry.item?.cluster ?? entry.item?.topic_filter ?? null;
}

function activateClusters(entries) {
	const scores = new Map();
	for (const entry of entries) {
		const cluster = entryCluster(entry);
		if (!cluster) continue;
		scores.set(cluster, (scores.get(cluster) ?? 0) + entry.score);
	}
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([cluster]) => cluster);
}

function dedupeEntries(entries) {
	const seen = new Set();
	const out = [];
	for (const entry of entries) {
		const item = entry.item;
		const key = entry.type === "node"
			? `node:${normalizeLabel(item.label)}`
			: `page:${normalizeLabel(item.title)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

function buildContext(entries, plan = recallGate("memory")) {
	const lines = [];
	let nodeCount = 0;
	let pageCount = 0;
	for (const entry of entries) {
		if (entry.type === "node" && nodeCount < plan.maxContextNodes) {
			const n = entry.item;
			const sliceTexts = n.slices.map((s) => s.text);
			const eventTexts = [...n.events].reverse().map((e) => e.text);
			const items = [...sliceTexts, ...eventTexts].filter(Boolean).slice(0, plan.maxLineItems);
			const tail = items.length ? ` - ${items.join("; ")}` : "";
			lines.push(`${n.label} (${n.category}, state: ${n.state})${tail}`);
			nodeCount++;
		}
		if (entry.type === "page" && pageCount < plan.maxContextPages) {
			const p = entry.item;
			const points = (p.key_points ?? []).slice(0, 3);
			const tail = [p.short_summary, points.length ? `Key points: ${points.join("; ")}` : ""]
				.filter(Boolean)
				.join(" ");
			lines.push(`Memory page: ${p.title}${tail ? ` - ${tail}` : ""}`);
			pageCount++;
		}
	}
	const out = [];
	let chars = 0;
	for (const line of lines) {
		if (chars + line.length + 1 > plan.maxContextChars) break;
		out.push(line);
		chars += line.length + 1;
	}
	return out.join("\n");
}

function recentScore(item) {
	const heat = Number(item.heat_score ?? 1);
	const ts = Number(item.updated_at ?? item.last_seen_at ?? 0);
	return heat * 0.2 + (ts ? Math.min(1, (Date.now() - ts) / (1000 * 60 * 60 * 24 * 30)) * -0.05 : 0);
}

function profileClusterMatches(profile, queryTokens) {
	const hints = parseJsonArray(profile?.cluster_hints_json);
	const families = parseJsonArray(profile?.family_summaries_json);
	const corpusByCluster = new Map();
	for (const hint of hints) {
		if (!hint?.cluster) continue;
		const text = [hint.cluster, hint.label, hint.summary].filter(Boolean).join(" ");
		corpusByCluster.set(hint.cluster, `${corpusByCluster.get(hint.cluster) ?? ""} ${text}`);
	}
	for (const family of families) {
		if (!family?.cluster) continue;
		const text = [family.cluster, family.summary, ...(family.labels ?? [])].filter(Boolean).join(" ");
		corpusByCluster.set(family.cluster, `${corpusByCluster.get(family.cluster) ?? ""} ${text}`);
	}
	return new Map([...corpusByCluster.entries()]
		.map(([cluster, text]) => [cluster, keywordScore(tokens(text), queryTokens)])
		.filter(([, score]) => score > 0));
}

function nodeItem(node, slicesByNode, eventsByNode) {
	return {
		id: node.id,
		label: node.label,
		category: node.category,
		state: node.state,
		summary: node.summary,
		cluster: node.cluster,
		slices: slicesByNode.get(node.id) ?? [],
		events: eventsByNode.get(node.id) ?? [],
	};
}

function pageItem(page) {
	return {
		id: page.id,
		title: page.title,
		source_mode: page.source_mode,
		topic_filter: page.topic_filter,
		short_summary: page.short_summary,
		cluster: page.cluster,
		key_points: parseJsonArray(page.key_points_json).slice(0, 6),
		related_concepts: parseJsonArray(page.related_concepts_json).slice(0, 8),
	};
}

function itemSummary(entry) {
	if (entry.type === "node") {
		return {
			type: "node",
			id: entry.item.id,
			label: entry.item.label,
			category: entry.item.category,
			cluster: entry.item.cluster,
			score: Number(entry.score.toFixed(4)),
		};
	}
	return {
		type: "page",
		id: entry.item.id,
		title: entry.item.title,
		cluster: entry.item.cluster ?? entry.item.topic_filter ?? null,
		score: Number(entry.score.toFixed(4)),
	};
}

export async function recall(env, config, userId, query, opts = {}) {
	const q = String(query ?? "").trim();
	const plan = recallGate(q, opts);
	resolveScope(userId, opts.memoryScope ?? opts.scope);
	if (plan.mode === "no_recall") return emptyRecall(plan);

	const [nodesRes, pagesRes, slicesRes, eventsRes, edgesRes, profileRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, state, summary, aliases_json, updated_at, last_seen_at,
				 heat_score, cluster
			 FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, title, topic_filter, short_summary, key_points_json, decisions_json,
				 next_steps_json, related_concepts_json, updated_at, heat_score, source_mode, cluster
			 FROM memory_pages
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			"SELECT id, node_id, text, kind, created_at FROM slices WHERE user_id = ? AND is_current = 1 AND deleted_at IS NULL",
		).bind(userId),
		env.DB.prepare(
			"SELECT id, node_id, action, text, importance, happened_at, created_at FROM events WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
		).bind(userId, plan.eventScanLimit),
		env.DB.prepare(
			"SELECT id, from_node, to_node, type, weight, reinforcement_count FROM edges WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId),
		env.DB.prepare("SELECT * FROM memory_profiles WHERE user_id = ?").bind(userId),
	]);

	const nodes = nodesRes.results ?? [];
	const pages = pagesRes.results ?? [];
	const profile = profileRes.results?.[0] ?? null;
	if ((nodes.length === 0 && pages.length === 0) || q.length === 0) {
		return emptyRecall(plan);
	}

	const slicesByNode = new Map();
	for (const s of slicesRes.results ?? []) {
		if (!slicesByNode.has(s.node_id)) slicesByNode.set(s.node_id, []);
		slicesByNode.get(s.node_id).push(s);
	}
	const eventsByNode = new Map();
	for (const e of eventsRes.results ?? []) {
		const list = eventsByNode.get(e.node_id) ?? [];
		if (list.length < plan.maxEventsPerNode) list.push(e);
		eventsByNode.set(e.node_id, list);
	}

	const queryTokens = tokens(q);
	const queryNorm = normalizeLabel(q);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const pageById = new Map(pages.map((p) => [p.id, p]));
	const scores = new Map();
	const pageScores = new Map();
	let lexicalUsed = false;

	for (const node of nodes) {
		const slices = slicesByNode.get(node.id) ?? [];
		const events = eventsByNode.get(node.id) ?? [];
		const aliases = parseJsonArray(node.aliases_json);
		const corpus = [node.label, node.summary, ...aliases, ...slices.map((s) => s.text), ...events.map((e) => e.text)]
			.filter(Boolean)
			.join(" ");
		let score = keywordScore(tokens(corpus), queryTokens);
		if (wordContains(queryNorm, normalizeLabel(node.label))) score += 2;
		if (aliases.some((alias) => wordContains(queryNorm, normalizeLabel(alias)))) score += 1.5;
		if (score > 0) {
			lexicalUsed = true;
			scores.set(node.id, score);
		}
	}

	for (const page of pages) {
		const keyPoints = parseJsonArray(page.key_points_json);
		const decisions = parseJsonArray(page.decisions_json);
		const nextSteps = parseJsonArray(page.next_steps_json);
		const related = parseJsonArray(page.related_concepts_json);
		const corpus = [
			page.title,
			page.topic_filter,
			page.short_summary,
			...keyPoints,
			...decisions,
			...nextSteps,
			...related,
		].filter(Boolean).join(" ");
		let score = keywordScore(tokens(corpus), queryTokens);
		if (wordContains(queryNorm, normalizeLabel(page.title))) score += 3;
		if (related.some((r) => wordContains(queryNorm, normalizeLabel(r)))) score += 1.5;
		if (score > 0) {
			lexicalUsed = true;
			pageScores.set(page.id, score + Number(page.heat_score ?? 1) * 0.1);
		}
	}

	const profileClusters = profileClusterMatches(profile, queryTokens);
	for (const node of nodes) {
		if (node.cluster && profileClusters.has(node.cluster)) {
			scores.set(node.id, (scores.get(node.id) ?? 0) + profileClusters.get(node.cluster) * 0.35);
		}
	}
	for (const page of pages) {
		const cluster = page.cluster ?? page.topic_filter;
		if (cluster && profileClusters.has(cluster)) {
			pageScores.set(page.id, (pageScores.get(page.id) ?? 0) + profileClusters.get(cluster) * 0.25);
		}
	}

	let vectorUsed = false;
	const vector = await embed(env, config, q);
	const matches = await queryNodeVectors(env, config, { userId, values: vector, topK: plan.topN + 4 });
	for (const m of matches) {
		if (byId.has(m.id)) {
			vectorUsed = true;
			scores.set(m.id, (scores.get(m.id) ?? 0) + (m.score ?? 0));
		}
	}

	if (scores.size === 0 && pageScores.size === 0 && (plan.mode === "deep_recall" || plan.mode === "update_mode")) {
		for (const node of [...nodes].sort((a, b) => recentScore(b) - recentScore(a)).slice(0, plan.maxContextNodes)) {
			scores.set(node.id, Math.max(0.1, recentScore(node)));
		}
		for (const page of [...pages].sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)).slice(0, plan.maxContextPages)) {
			pageScores.set(page.id, Math.max(0.1, Number(page.heat_score ?? 1) * 0.1));
		}
	}

	const candidateNodeIds = [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, plan.topN)
		.map(([id]) => id);
	let graphExpansionUsed = false;
	const edgeRows = edgesRes.results ?? [];
	for (const edge of edgeRows) {
		const fromActive = candidateNodeIds.includes(edge.from_node);
		const toActive = candidateNodeIds.includes(edge.to_node);
		if (!fromActive && !toActive) continue;
		const other = fromActive ? edge.to_node : edge.from_node;
		if (!byId.has(other)) continue;
		const boost = Math.max(0.15, Number(edge.weight ?? 1) * 0.25 + Number(edge.reinforcement_count ?? 0) * 0.05);
		if (!scores.has(other)) graphExpansionUsed = true;
		scores.set(other, (scores.get(other) ?? 0) + boost);
	}

	if (scores.size === 0 && pageScores.size === 0) return emptyRecall(plan, { lexical_used: lexicalUsed, vector_used: vectorUsed });

	let entries = [
		...[...scores.entries()].map(([id, score]) => ({ type: "node", id, score, item: nodeItem(byId.get(id), slicesByNode, eventsByNode) })),
		...[...pageScores.entries()].map(([id, score]) => ({ type: "page", id, score, item: pageItem(pageById.get(id)) })),
	].filter((entry) => entry.item);

	const activatedClusters = activateClusters(entries);
	if (activatedClusters.length) {
		entries = entries.filter((entry) => {
			const cluster = entryCluster(entry);
			return !cluster || activatedClusters.includes(cluster);
		});
	}

	entries = dedupeEntries(entries)
		.sort((a, b) => b.score - a.score)
		.slice(0, plan.topN);

	const resultNodes = entries.filter((entry) => entry.type === "node").map((entry) => entry.item);
	const resultPages = entries.filter((entry) => entry.type === "page").map((entry) => entry.item);
	const context = buildContext(entries, plan);
	const items = entries.map(itemSummary);

	return {
		ok: true,
		recall_mode: plan.mode,
		mode: plan.mode,
		reason: plan.reason,
		context,
		items,
		count: items.length,
		nodes: resultNodes,
		pages: resultPages,
		activated_clusters: activatedClusters,
		vector_used: vectorUsed,
		lexical_used: lexicalUsed,
		graph_expansion_used: graphExpansionUsed,
		compressed: Boolean(context),
	};
}
