/**
 * Compact recall for graph nodes and manual_collect memory pages.
 *
 * D1 keyword recall is always available. Vectorize remains a best-effort boost
 * for node ids only, so local tests stay deterministic when vectors are off.
 */

import { embed } from "../lib/embeddings.js";
import { queryNodeVectors } from "../lib/vectorize.js";
import { tokens, normalizeLabel, wordContains } from "../lib/text.js";

const TOP_N = 8;
const MAX_EVENTS_PER_NODE = 8;
const EVENT_SCAN_LIMIT = 500;
const MAX_CONTEXT_NODES = 6;
const MAX_CONTEXT_PAGES = 4;
const MAX_LINE_ITEMS = 4;

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

function buildContext(entries) {
	const lines = [];
	let nodeCount = 0;
	let pageCount = 0;
	for (const entry of entries) {
		if (entry.type === "node" && nodeCount < MAX_CONTEXT_NODES) {
			const n = entry.item;
			const sliceTexts = n.slices.map((s) => s.text);
			const eventTexts = [...n.events].reverse().map((e) => e.text);
			const items = [...sliceTexts, ...eventTexts].filter(Boolean).slice(0, MAX_LINE_ITEMS);
			const tail = items.length ? ` - ${items.join("; ")}` : "";
			lines.push(`${n.label} (${n.category}, state: ${n.state})${tail}`);
			nodeCount++;
		}
		if (entry.type === "page" && pageCount < MAX_CONTEXT_PAGES) {
			const p = entry.item;
			const points = (p.key_points ?? []).slice(0, 3);
			const tail = [p.short_summary, points.length ? `Key points: ${points.join("; ")}` : ""]
				.filter(Boolean)
				.join(" ");
			lines.push(`Memory page: ${p.title}${tail ? ` - ${tail}` : ""}`);
			pageCount++;
		}
	}
	return lines.join("\n");
}

export async function recall(env, config, userId, query) {
	const q = String(query ?? "").trim();

	const [nodesRes, pagesRes, slicesRes, eventsRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, state, summary FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, title, topic_filter, short_summary, key_points_json, decisions_json,
				 next_steps_json, related_concepts_json, updated_at, heat_score, source_mode
			 FROM memory_pages
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			"SELECT id, node_id, text, kind, created_at FROM slices WHERE user_id = ? AND is_current = 1 AND deleted_at IS NULL",
		).bind(userId),
		env.DB.prepare(
			"SELECT id, node_id, action, text, importance, happened_at, created_at FROM events WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
		).bind(userId, EVENT_SCAN_LIMIT),
	]);

	const nodes = nodesRes.results ?? [];
	const pages = pagesRes.results ?? [];
	if ((nodes.length === 0 && pages.length === 0) || q.length === 0) {
		return { context: "", nodes: [], pages: [] };
	}

	const slicesByNode = new Map();
	for (const s of slicesRes.results ?? []) {
		if (!slicesByNode.has(s.node_id)) slicesByNode.set(s.node_id, []);
		slicesByNode.get(s.node_id).push(s);
	}
	const eventsByNode = new Map();
	for (const e of eventsRes.results ?? []) {
		const list = eventsByNode.get(e.node_id) ?? [];
		if (list.length < MAX_EVENTS_PER_NODE) list.push(e);
		eventsByNode.set(e.node_id, list);
	}

	const queryTokens = tokens(q);
	const queryNorm = normalizeLabel(q);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const pageById = new Map(pages.map((p) => [p.id, p]));
	const scores = new Map();
	const pageScores = new Map();

	for (const node of nodes) {
		const slices = slicesByNode.get(node.id) ?? [];
		const events = eventsByNode.get(node.id) ?? [];
		const corpus = [node.label, node.summary, ...slices.map((s) => s.text), ...events.map((e) => e.text)]
			.filter(Boolean)
			.join(" ");
		let score = keywordScore(tokens(corpus), queryTokens);
		if (wordContains(queryNorm, normalizeLabel(node.label))) score += 2;
		if (score > 0) scores.set(node.id, score);
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
		if (score > 0) pageScores.set(page.id, score + Number(page.heat_score ?? 1) * 0.1);
	}

	const vector = await embed(env, config, q);
	const matches = await queryNodeVectors(env, config, { userId, values: vector, topK: TOP_N + 4 });
	for (const m of matches) {
		if (byId.has(m.id)) scores.set(m.id, (scores.get(m.id) ?? 0) + (m.score ?? 0));
	}

	if (scores.size === 0 && pageScores.size === 0) return { context: "", nodes: [], pages: [] };

	const entries = [
		...[...scores.entries()].map(([id, score]) => ({ type: "node", id, score })),
		...[...pageScores.entries()].map(([id, score]) => ({ type: "page", id, score })),
	]
		.sort((a, b) => b.score - a.score)
		.slice(0, TOP_N)
		.map((entry) => ({
			...entry,
			item: entry.type === "node" ? byId.get(entry.id) : pageById.get(entry.id),
		}))
		.filter((entry) => entry.item);

	const resultNodes = entries.filter((entry) => entry.type === "node").map((entry) => {
		const n = byId.get(entry.id);
		return {
			id: n.id,
			label: n.label,
			category: n.category,
			state: n.state,
			slices: slicesByNode.get(entry.id) ?? [],
			events: eventsByNode.get(entry.id) ?? [],
		};
	});

	const resultPages = entries.filter((entry) => entry.type === "page").map((entry) => {
		const page = pageById.get(entry.id);
		return {
			id: page.id,
			title: page.title,
			source_mode: page.source_mode,
			topic_filter: page.topic_filter,
			short_summary: page.short_summary,
			key_points: parseJsonArray(page.key_points_json).slice(0, 6),
			related_concepts: parseJsonArray(page.related_concepts_json).slice(0, 8),
		};
	});

	const contextEntries = entries.map((entry) => {
		if (entry.type === "node") {
			const node = resultNodes.find((n) => n.id === entry.id);
			return node ? { type: "node", item: node } : null;
		}
		const page = resultPages.find((p) => p.id === entry.id);
		return page ? { type: "page", item: page } : null;
	}).filter(Boolean);

	return { context: buildContext(contextEntries), nodes: resultNodes, pages: resultPages };
}
