/**
 * E7 assertion-level retrieval.
 *
 * Existing recall ranks whole nodes, but the renderer can include only four
 * facts/events/relations from each selected node. This module ranks the
 * assertions inside those nodes so a detail cannot earn its parent a place and
 * then disappear behind unrelated siblings. It is pure, deterministic, and
 * bounded; scope filtering has already happened in SQL before rows arrive.
 */

import { normalizeLabel, tokens } from "../lib/text.js";

export const HYBRID_ASSERTION_CANDIDATE_MAX = 200;
const RRF_K = 60;
const TRUSTWORTHY_EVENT_DATES = new Set(["extracted", "phrase", "source_time"]);
const TEMPORAL_INTENT_RE = /\b(?:when|date|dated|day|week|month|year|before|after|during|since|until|how long|what time)\b|\b(?:19|20)\d{2}\b/i;

function tokenMatches(a, b) {
	if (a === b) return true;
	if (a.length >= 4 && b.startsWith(a)) return true;
	if (b.length >= 4 && a.startsWith(b)) return true;
	return false;
}

function lexicalScore(text, queryTokens) {
	const corpus = tokens(text);
	let matched = 0;
	for (const query of queryTokens) {
		if (corpus.some((candidate) => tokenMatches(query, candidate))) matched += 1;
	}
	return matched;
}

function rank(rows, queryTokens, score) {
	return rows
		.map((row) => ({ ...row, laneScore: score(row, queryTokens) }))
		.filter((row) => row.laneScore > 0)
		.sort((a, b) => b.laneScore - a.laneScore || a.key.localeCompare(b.key));
}

function bounded(value) {
	return Math.max(1, Math.min(HYBRID_ASSERTION_CANDIDATE_MAX, Number(value) || HYBRID_ASSERTION_CANDIDATE_MAX));
}

function edgeText(edge, byId) {
	if (edge?.fact) return String(edge.fact);
	const from = byId.get(edge?.from_node)?.label;
	const to = byId.get(edge?.to_node)?.label;
	if (!from || !to || !edge?.type) return "";
	return `${from} ${String(edge.type).toLowerCase().replace(/_/g, " ")} ${to}`;
}

function eventSearchText(event) {
	const parts = [event?.text];
	const at = Number(event?.happened_at);
	if (TRUSTWORTHY_EVENT_DATES.has(event?.happened_at_source) && Number.isFinite(at) && at > 0) {
		parts.push(new Date(at).toISOString().slice(0, 10));
	}
	return parts.filter(Boolean).join(" ");
}

/** Return assertion and parent-node ranks. No source text enters counters. */
export function rankHybridAssertions(query, {
	nodes = [],
	slices = [],
	events = [],
	edges = [],
} = {}, { candidateLimit = HYBRID_ASSERTION_CANDIDATE_MAX } = {}) {
	const limit = bounded(candidateLimit);
	const queryTokens = tokens(query);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	if (!queryTokens.length) {
		return { candidates: [], byNode: new Map(), nodeRanks: [], laneCounts: { lexical: 0, relation: 0, temporal: 0 } };
	}

	const sliceRows = slices
		.filter((row) => row?.id && row?.node_id && byId.has(row.node_id) && row?.text)
		.map((row) => ({ key: `slice:${row.id}`, kind: "slice", nodeIds: [row.node_id], text: String(row.text) }));
	const eventRows = events
		.filter((row) => row?.id && row?.node_id && byId.has(row.node_id) && row?.text)
		.map((row) => ({ key: `event:${row.id}`, kind: "event", nodeIds: [row.node_id], text: eventSearchText(row), row }));
	const edgeRows = edges
		.filter((row) => row?.id && (byId.has(row.from_node) || byId.has(row.to_node)))
		.map((row) => ({
			key: `edge:${row.id}`,
			kind: "relation",
			nodeIds: [row.from_node, row.to_node].filter((id) => byId.has(id)),
			text: edgeText(row, byId),
		})).filter((row) => row.text);

	const lexical = rank([...sliceRows, ...eventRows], queryTokens, (row, q) => lexicalScore(row.text, q)).slice(0, limit);
	const relation = rank(edgeRows, queryTokens, (row, q) => lexicalScore(row.text, q)).slice(0, limit);
	const temporal = TEMPORAL_INTENT_RE.test(String(query ?? ""))
		? rank(eventRows.filter((candidate) => {
			const event = candidate.row;
			return TRUSTWORTHY_EVENT_DATES.has(event?.happened_at_source)
				&& Number.isFinite(Number(event?.happened_at)) && Number(event.happened_at) > 0;
		}), queryTokens, (row, q) => lexicalScore(row.text, q) + 1).slice(0, limit)
		: [];

	const fused = new Map();
	const rowsByKey = new Map();
	for (const lane of [lexical, relation, temporal]) {
		lane.forEach((candidate, index) => {
			rowsByKey.set(candidate.key, candidate);
			fused.set(candidate.key, (fused.get(candidate.key) ?? 0) + 1 / (RRF_K + index + 1));
		});
	}
	const candidates = [...fused.entries()]
		.map(([key, score]) => ({ ...rowsByKey.get(key), score }))
		.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
		.slice(0, limit);

	const byNode = new Map();
	for (const candidate of candidates) {
		for (const nodeId of candidate.nodeIds) {
			const list = byNode.get(nodeId) ?? [];
			list.push(candidate);
			byNode.set(nodeId, list);
		}
	}
	for (const list of byNode.values()) {
		list.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
	}
	const nodeRanks = [...byNode.entries()]
		.map(([nodeId, assertions]) => ({
			key: `node:${nodeId}`,
			w: assertions.reduce((sum, assertion, index) => sum + assertion.score / (index + 1), 0),
		}))
		.sort((a, b) => b.w - a.w || a.key.localeCompare(b.key));

	return {
		candidates,
		byNode,
		nodeRanks,
		laneCounts: { lexical: lexical.length, relation: relation.length, temporal: temporal.length },
	};
}

/** Stable evidence ordering for one node; unranked evidence retains old order. */
export function orderNodeEvidence(evidence, ranked = []) {
	const score = new Map(ranked.map((candidate) => [candidate.key, candidate.score]));
	return evidence
		.map((entry, index) => ({ entry, index, score: score.get(entry.key) }))
		.sort((a, b) => {
			const aRanked = Number.isFinite(a.score);
			const bRanked = Number.isFinite(b.score);
			if (aRanked !== bRanked) return aRanked ? -1 : 1;
			if (aRanked && a.score !== b.score) return b.score - a.score;
			return a.index - b.index;
		})
		.map(({ entry }) => entry);
}

export function hybridTemporalIntent(query) {
	return TEMPORAL_INTENT_RE.test(String(query ?? ""));
}

