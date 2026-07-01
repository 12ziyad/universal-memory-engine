/**
 * Simple recall — given a user's free-text query, find the handful of their
 * memory nodes most relevant to it and return a compact, chat-ready context.
 *
 * Two signals, merged (same shape as the extraction shortlist):
 *   - keyword match in D1 (query words vs each node's label / summary / slice
 *     and event text),
 *   - semantic match via Vectorize (embed the query, find nearest node vectors).
 *
 * Vectorize/AI are optional; with vectors disabled (tests, local dev without
 * --remote) it degrades cleanly to keyword-only. This is deliberately light —
 * no heavy ranking or compression yet — and never returns the whole graph.
 */

import { embed } from "../lib/embeddings.js";
import { queryNodeVectors } from "../lib/vectorize.js";
import { tokens, normalizeLabel, wordContains } from "../lib/text.js";

const TOP_N = 8; // nodes returned at most
const MAX_EVENTS_PER_NODE = 8; // recent events kept per node
const EVENT_SCAN_LIMIT = 500; // cap rows scanned for recent events
const MAX_CONTEXT_NODES = 6; // lines in the context string
const MAX_LINE_ITEMS = 4; // slice/event snippets per context line

/**
 * Loose token match so "train" finds "trains"/"training" without a full stemmer:
 * equal, or one is a prefix of the other (only for tokens long enough that a
 * prefix is meaningful, to avoid matching short noise like "do").
 */
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

/** One readable line per node a chat model can drop straight into its prompt. */
function buildContext(nodes) {
	const lines = [];
	for (const n of nodes.slice(0, MAX_CONTEXT_NODES)) {
		const sliceTexts = n.slices.map((s) => s.text);
		// events arrive newest-first; read them chronologically in the summary.
		const eventTexts = [...n.events].reverse().map((e) => e.text);
		const items = [...sliceTexts, ...eventTexts].filter(Boolean).slice(0, MAX_LINE_ITEMS);
		const tail = items.length ? ` — ${items.join("; ")}` : "";
		lines.push(`${n.label} (${n.category}, state: ${n.state})${tail}`);
	}
	return lines.join("\n");
}

/**
 * @returns {Promise<{ context: string, nodes: Array<{id,label,category,state,slices,events}> }>}
 */
export async function recall(env, config, userId, query) {
	const q = String(query ?? "").trim();

	// Pull this user's graph slice in one round trip. Every read is scoped by
	// user_id — there is no cross-user path.
	const [nodesRes, slicesRes, eventsRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, state, summary FROM nodes
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
	if (nodes.length === 0 || q.length === 0) return { context: "", nodes: [] };

	// Bucket slices/events by node.
	const slicesByNode = new Map();
	for (const s of slicesRes.results ?? []) {
		if (!slicesByNode.has(s.node_id)) slicesByNode.set(s.node_id, []);
		slicesByNode.get(s.node_id).push(s);
	}
	const eventsByNode = new Map();
	for (const e of eventsRes.results ?? []) {
		const list = eventsByNode.get(e.node_id) ?? [];
		if (list.length < MAX_EVENTS_PER_NODE) list.push(e); // already newest-first
		eventsByNode.set(e.node_id, list);
	}

	const queryTokens = tokens(q);
	const queryNorm = normalizeLabel(q);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const scores = new Map();

	// 1. Keyword signal — query tokens vs label + summary + slice/event text.
	for (const node of nodes) {
		const slices = slicesByNode.get(node.id) ?? [];
		const events = eventsByNode.get(node.id) ?? [];
		const corpus = [node.label, node.summary, ...slices.map((s) => s.text), ...events.map((e) => e.text)]
			.filter(Boolean)
			.join(" ");
		let score = keywordScore(tokens(corpus), queryTokens);
		// Strong boost when the node's label appears as a whole word in the query.
		if (wordContains(queryNorm, normalizeLabel(node.label))) score += 2;
		if (score > 0) scores.set(node.id, score);
	}

	// 2. Semantic signal (best-effort; a no-op when vectors are disabled).
	const vector = await embed(env, config, q);
	const matches = await queryNodeVectors(env, config, { userId, values: vector, topK: TOP_N + 4 });
	for (const m of matches) {
		if (byId.has(m.id)) scores.set(m.id, (scores.get(m.id) ?? 0) + (m.score ?? 0));
	}

	if (scores.size === 0) return { context: "", nodes: [] };

	// Merge, sort, cut to the top N.
	const topIds = [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, TOP_N)
		.map(([id]) => id);

	const resultNodes = topIds.map((id) => {
		const n = byId.get(id);
		return {
			id: n.id,
			label: n.label,
			category: n.category,
			state: n.state,
			slices: slicesByNode.get(id) ?? [],
			events: eventsByNode.get(id) ?? [],
		};
	});

	return { context: buildContext(resultNodes), nodes: resultNodes };
}
