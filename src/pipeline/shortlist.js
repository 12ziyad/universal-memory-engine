/**
 * The shortlist: find ~10 existing nodes to show the model BEFORE it proposes,
 * so it can reuse them instead of inventing duplicates. This is the first half
 * of the duplicate-killer (the gates are the second half).
 *
 * Two signals, merged:
 *   - keyword match in D1 (node labels vs the chunk text)
 *   - semantic match via Vectorize (embed the chunk, find nearest node vectors)
 *
 * Vectorize/AI are optional; if unavailable we fall back to keyword-only.
 */

import { getUserNodes } from "../lib/db.js";
import { embed } from "../lib/embeddings.js";
import { queryNodeVectors } from "../lib/vectorize.js";
import { jaccard, tokens, wordContains, normalizeLabel } from "../lib/text.js";

function keywordScore(node, queryTokens, queryNorm) {
	let aliases = [];
	try {
		const parsed = JSON.parse(node.aliases_json || "[]");
		if (Array.isArray(parsed)) aliases = parsed;
	} catch {
		aliases = [];
	}
	const labelTokens = tokens([node.label, ...aliases].join(" "));
	let score = jaccard(labelTokens, queryTokens);
	// Boost exact substring hits ("boxing" appears in the chunk).
	if (wordContains(queryNorm, normalizeLabel(node.label))) score += 0.5;
	if (aliases.some((alias) => wordContains(queryNorm, normalizeLabel(alias)))) score += 0.35;
	return score;
}

export async function shortlistNodes(env, config, userId, text) {
	const nodes = await getUserNodes(env, userId);
	if (nodes.length === 0) return [];

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const scores = new Map(); // nodeId -> score

	// 1. Keyword signal.
	const queryTokens = tokens(text);
	const queryNorm = normalizeLabel(text);
	for (const node of nodes) {
		const s = keywordScore(node, queryTokens, queryNorm);
		if (s > 0) scores.set(node.id, (scores.get(node.id) ?? 0) + s);
	}

	// 2. Semantic signal (best-effort).
	const vector = await embed(env, config, text);
	const matches = await queryNodeVectors(env, config, {
		userId,
		values: vector,
		topK: config.shortlistSize,
	});
	for (const m of matches) {
		if (byId.has(m.id)) scores.set(m.id, (scores.get(m.id) ?? 0) + (m.score ?? 0));
	}

	// Merge, sort, cut to top N.
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, config.shortlistSize)
		.map(([id]) => {
			const n = byId.get(id);
			return { id: n.id, label: n.label, category: n.category, state: n.state };
		});
}
