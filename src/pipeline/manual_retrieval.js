/**
 * Bounded hybrid retrieval for the MCP manual lane.
 *
 * This module never decides identity from semantic context. It keeps exact/name
 * evidence (`identity_score`) separate from BM25/vector/graph/page/community
 * evidence (`context_score`) and exposes only temporary N0-N9 references in the
 * cards that may be sent to a model.
 */

import { embed } from "../lib/embeddings.js";
import { queryNodeVectors } from "../lib/vectorize.js";
import {
	canonicalIdentity,
	manualCategoryCompatibility,
	manualIdentityEvidence,
	manualIdentityNames,
	manualNodeAliases,
} from "./manual_identity.js";

export const MANUAL_BROAD_POOL_LIMIT = 30;
export const MANUAL_CARD_LIMIT = 10;

const PROVISIONAL_LIMIT = 120;
const BM25_LIMIT = 16;
const VECTOR_LIMIT = 20;
const IGNORED_MENTION_ROLES = new Set(["comparison", "example", "option", "incidental", "context_only"]);

function clamp(value, min = 0, max = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) return min;
	return Math.max(min, Math.min(max, number));
}

function cleanText(value, limit = 600) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function safeJsonArray(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function unique(values) {
	return [...new Set((values ?? []).filter(Boolean))];
}

function placeholders(values) {
	return values.map(() => "?").join(", ");
}

function lexicalTokens(value) {
	return canonicalIdentity(value)
		.match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length <= 48).slice(0, 12) ?? [];
}

/** Build a bound FTS5 MATCH expression without interpolating submitted text. */
export function buildFtsQuery(value) {
	const tokens = unique(lexicalTokens(value));
	if (!tokens.length) return null;
	const quote = (term) => `"${term.replace(/"/g, '""')}"`;
	const phrase = tokens.length > 1 ? quote(tokens.join(" ")) : null;
	const clauses = [];
	if (phrase) clauses.push(`identity_text:${phrase}`);
	for (const token of tokens) clauses.push(`identity_text:${quote(token)}`);
	for (const token of tokens) clauses.push(`semantic_text:${quote(token)}`);
	for (const token of tokens) clauses.push(`context_text:${quote(token)}`);
	return clauses.join(" OR ");
}

function sourceEntities(extraction = {}) {
	const byRef = new Map();
	const safeRefs = new Map();
	const add = (identity, fallbackRef, text = "", role = null) => {
		if (!identity) return;
		const rawIdentity = typeof identity === "string" ? { label: identity } : identity;
		const label = cleanText(rawIdentity.label ?? rawIdentity.name, 160);
		if (!label) return;
		const mentionRole = rawIdentity.mention_role ?? rawIdentity.mentionRole ?? role;
		if (mentionRole && IGNORED_MENTION_ROLES.has(String(mentionRole))) return;
		const rawRef = String(rawIdentity.ref ?? rawIdentity.entity_ref ?? fallbackRef ?? "");
		if (rawRef && !safeRefs.has(rawRef)) safeRefs.set(rawRef, `E${safeRefs.size}`);
		const ref = /^E\d+$/.test(rawRef) ? rawRef : (safeRefs.get(rawRef) ?? `E${byRef.size}`);
		const prior = byRef.get(ref);
		const context = unique([prior?.context, text, label]).join(" ");
		byRef.set(ref, {
			ref,
			label,
			category: rawIdentity.category ?? prior?.category ?? null,
			mention_role: mentionRole ?? prior?.mention_role ?? null,
			context,
		});
	};

	for (const entity of extraction.entities ?? []) add(entity, entity.ref, extraction.primary_memory?.text, entity.mention_role);
	for (const item of extraction.facts ?? []) {
		add(item.identity ?? item.subject, item.entity_ref ?? item.subject_ref, item.memory?.text ?? item.text);
	}
	for (const item of extraction.relationships ?? []) {
		add(item.from, item.from_ref, item.text, item.from?.mention_role ?? "relationship_endpoint");
		add(item.to, item.to_ref, item.text, item.to?.mention_role ?? "relationship_endpoint");
	}
	for (const item of extraction.corrections ?? []) {
		add(item.subject, item.subject_ref, item.current_text ?? item.text);
		add(item.old_target, item.old_target_ref, item.history_text ?? item.text, "relationship_endpoint");
		add(item.new_target, item.new_target_ref, item.current_text ?? item.text, "relationship_endpoint");
	}
	return [...byRef.values()].slice(0, 24);
}

function overlapScore(left, right) {
	const a = new Set(lexicalTokens(left).filter((token) => token.length > 1));
	const b = new Set(lexicalTokens(right).filter((token) => token.length > 1));
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / Math.min(a.size, b.size);
}

const ALIAS_ASSERTION_CUE = /\b(?:a\s+k\s+a|aka|alias(?:ed)?(?:\s+(?:for|of))?|nickname(?:d)?(?:\s+(?:for|of))?|also\s+called|commonly\s+called|known(?:\s+[\p{L}\p{N}]+){0,4}\s+as|short\s+for|stands\s+for|same(?:\s+[\p{L}\p{N}]+){0,3}\s+as|refers\s+to)\b/u;
const ALIAS_ASSERTION_NEGATION = /\b(?:not|never|different|distinct|unrelated|versus|vs)\b/u;

function phrasePosition(text, phrase) {
	const paddedText = ` ${text} `;
	const paddedPhrase = ` ${phrase} `;
	const index = paddedText.indexOf(paddedPhrase);
	// The leading space in both padded strings cancels, so `index` is also the
	// phrase start in the unpadded canonical text.
	return index < 0 ? null : { start: index, end: index + phrase.length };
}

/**
 * Recognize only explicit, stored identity assertions. A shared sentence,
 * topic, page, or relationship is insufficient: the two complete names must
 * occur in the same bounded segment with an alias/equivalence cue between
 * them. This is deliberately conservative because the result can authorize a
 * model-recommended alias merge.
 */
function hasStoredAliasAssertion(entity, node) {
	const wanted = canonicalIdentity(entity?.label);
	if (!wanted) return false;
	const source = String(node?.profile_semantic_text ?? "").slice(0, 8000);
	if (!source) return false;
	const existingNames = unique(manualIdentityNames(node).map(canonicalIdentity))
		.filter((name) => name && name !== wanted);
	if (!existingNames.length) return false;
	for (const rawSegment of source.split(/(?:[\r\n]+|[.!?;]+)\s*/u).slice(0, 80)) {
		const segment = canonicalIdentity(rawSegment);
		const wantedPosition = phrasePosition(segment, wanted);
		if (!wantedPosition) continue;
		for (const existing of existingNames) {
			const existingPosition = phrasePosition(segment, existing);
			if (!existingPosition) continue;
			const first = wantedPosition.start < existingPosition.start ? wantedPosition : existingPosition;
			const second = first === wantedPosition ? existingPosition : wantedPosition;
			const between = ` ${segment.slice(first.end, second.start)} `;
			if (!ALIAS_ASSERTION_NEGATION.test(between) && ALIAS_ASSERTION_CUE.test(between)) return true;
		}
	}
	return false;
}

function blankSignals() {
	return {
		exact_claim: false,
		exact_label: false,
		exact_alias: false,
		bm25: 0,
		vector: 0,
		graph: 0,
		page: 0,
		community: 0,
		cluster: 0,
	};
}

function signalReasonCodes(signals) {
	return [
		signals.exact_claim && "exact_identity_claim",
		signals.exact_label && "exact_label",
		signals.exact_alias && "exact_alias",
		signals.bm25 > 0 && "bm25",
		signals.vector > 0 && "vector",
		signals.graph > 0 && "graph_neighbor",
		signals.page > 0 && "linked_page",
		signals.community > 0 && "topic_community",
		signals.cluster > 0 && "cluster_context",
	].filter(Boolean);
}

/** Score one node while preserving the identity/context boundary. */
export function scoreManualCandidate(entity, node, signals = {}) {
	const s = { ...blankSignals(), ...signals };
	let nameEvidence = { score: 0, reason_codes: [] };
	for (const name of manualIdentityNames(node)) {
		const evidence = manualIdentityEvidence(entity?.label, name);
		if (evidence.score > nameEvidence.score) nameEvidence = evidence;
	}
	const storedAliasAssertion = hasStoredAliasAssertion(entity, node);
	const baseIdentityScore = s.exact_claim || s.exact_label
		? 1
		: s.exact_alias
			? 0.99
			: nameEvidence.score;
	// An explicit historical assertion is identity-bearing but remains below
	// the deterministic 0.94 merge threshold. It still needs high-confidence
	// adjudication and independent contextual corroboration.
	const identityScore = Math.max(baseIdentityScore, storedAliasAssertion ? 0.9 : 0);
	const entityTokens = new Set(canonicalIdentity(entity?.label).split(" ").filter(Boolean));
	const nodeTokens = new Set(canonicalIdentity(node?.label).split(" ").filter(Boolean));
	const sharedNameTokens = [...entityTokens].filter((token) => nodeTokens.has(token));
	const hardNameContradiction = nameEvidence.score === 0 && entityTokens.size >= 2 && nodeTokens.size >= 2 &&
		sharedNameTokens.length > 0 && sharedNameTokens.length < entityTokens.size && sharedNameTokens.length < nodeTokens.size;
	const factOverlap = overlapScore(entity?.context, [node?.summary, node?.profile_semantic_text].filter(Boolean).join(" "));
	const contextScore =
		clamp(s.bm25) * 0.30 +
		clamp(s.vector) * 0.25 +
		clamp(factOverlap) * 0.20 +
		clamp(s.graph) * 0.10 +
		clamp(s.page) * 0.10 +
		Math.max(clamp(s.community), clamp(s.cluster)) * 0.05;
	const category = manualCategoryCompatibility(entity, node);
	return {
		identity_score: Number(clamp(identityScore).toFixed(4)),
		context_score: Number(clamp(contextScore).toFixed(4)),
		category_compatible: !category.hard_conflict,
		reason_codes: unique([
			...signalReasonCodes(s),
			...(storedAliasAssertion ? ["stored_alias_assertion"] : []),
			...(factOverlap > 0 ? ["fact_overlap"] : []),
			...(nameEvidence.reason_codes ?? []),
			...(hardNameContradiction ? ["hard_name_contradiction"] : []),
		]),
	};
}

function normalizeBm25(rows) {
	if (!rows.length) return [];
	const relevance = rows.map((row) => -Number(row.lexical_rank ?? 0));
	const min = Math.min(...relevance);
	const max = Math.max(...relevance);
	return rows.map((row, index) => ({
		...row,
		bm25_normalized: max > min ? (relevance[index] - min) / (max - min) : 1,
	}));
}

async function exactMatches(env, userId, entity) {
	const key = canonicalIdentity(entity.label);
	const { results } = await env.DB.prepare(
		`SELECT n.id, n.label, n.canonical_label, n.aliases_json, n.category, n.state, n.summary,
			CASE
				WHEN identity.node_id IS NOT NULL THEN 'claim'
				WHEN n.canonical_label = ? OR lower(trim(n.label)) = lower(trim(?)) THEN 'label'
				ELSE 'alias'
			END AS exact_kind
		 FROM nodes AS n
		 LEFT JOIN manual_node_identities AS identity
			ON identity.user_id = n.user_id AND identity.node_id = n.id AND identity.canonical_key = ?
		 WHERE n.user_id = ?
			AND n.deleted_at IS NULL AND n.archived_at IS NULL AND n.suppressed_at IS NULL
			AND (
				identity.node_id IS NOT NULL OR n.canonical_label = ? OR lower(trim(n.label)) = lower(trim(?)) OR
				EXISTS (
					SELECT 1
					FROM json_each(CASE WHEN json_valid(n.aliases_json) THEN n.aliases_json ELSE '[]' END) AS alias
					WHERE lower(trim(CAST(alias.value AS TEXT))) = lower(trim(?))
				)
			)
		 ORDER BY n.id`,
	)
		.bind(key, entity.label, key, userId, key, entity.label, entity.label)
		.all();
	return results ?? [];
}

async function bm25Matches(env, userId, entity) {
	const query = buildFtsQuery(`${entity.label} ${entity.context}`);
	if (!query) return [];
	try {
		const { results } = await env.DB.prepare(
			`SELECT profile.object_kind, profile.object_id,
				bm25(manual_search_fts, 6.0, 2.5, 1.0) AS lexical_rank
			 FROM manual_search_fts
			 JOIN manual_search_profiles AS profile ON profile.rowid = manual_search_fts.rowid
			 WHERE manual_search_fts MATCH ? AND profile.user_id = ?
			 ORDER BY lexical_rank ASC, profile.object_kind, profile.object_id
			 LIMIT ?`,
		)
			.bind(query, userId, BM25_LIMIT)
			.all();
		return normalizeBm25(results ?? []);
	} catch (error) {
		return [{ _warning: `bm25_failed:${String(error?.message ?? error)}` }];
	}
}

async function vectorMatches(env, config, userId, entity) {
	const values = await embed(env, config, `${entity.label} ${entity.category ?? ""} ${entity.context}`.trim());
	return queryNodeVectors(env, config, { userId, values, topK: VECTOR_LIMIT });
}

async function rowsByIds(env, userId, ids) {
	const uniqueIds = unique(ids).slice(0, PROVISIONAL_LIMIT);
	if (!uniqueIds.length) return [];
	const output = [];
	for (let offset = 0; offset < uniqueIds.length; offset += 60) {
		const chunk = uniqueIds.slice(offset, offset + 60);
		const { results } = await env.DB.prepare(
			`SELECT n.id, n.label, n.canonical_label, n.aliases_json, n.category, n.role, n.state,
				n.summary, n.cluster, profile.semantic_text AS profile_semantic_text
			 FROM nodes AS n
			 LEFT JOIN manual_search_profiles AS profile
				ON profile.user_id = n.user_id AND profile.object_kind = 'node' AND profile.object_id = n.id
			 WHERE n.user_id = ? AND n.id IN (${placeholders(chunk)})
				AND n.deleted_at IS NULL AND n.archived_at IS NULL AND n.suppressed_at IS NULL`,
		)
			.bind(userId, ...chunk)
			.all();
		output.push(...(results ?? []));
	}
	return output;
}

function vectorObject(match) {
	const id = String(match?.id ?? "");
	if (!id) return null;
	return id.startsWith("page:")
		? { kind: "page", id: id.slice(5), score: clamp(match.score) }
		: { kind: "node", id, score: clamp(match.score) };
}

function candidateMapFor(entities) {
	return new Map(entities.map((entity) => [entity.ref, new Map()]));
}

function addSignal(candidateMaps, entityRef, nodeId, patch = {}) {
	if (!nodeId || !candidateMaps.has(entityRef)) return;
	const map = candidateMaps.get(entityRef);
	if (!map.has(nodeId) && map.size >= PROVISIONAL_LIMIT) return;
	const current = map.get(nodeId) ?? blankSignals();
	for (const key of Object.keys(blankSignals())) {
		if (typeof current[key] === "boolean") current[key] = Boolean(current[key] || patch[key]);
		else current[key] = Math.max(Number(current[key] ?? 0), Number(patch[key] ?? 0));
	}
	map.set(nodeId, current);
}

async function pageRows(env, userId, pageIds) {
	const ids = unique(pageIds).slice(0, 60);
	if (!ids.length) return [];
	const { results } = await env.DB.prepare(
		`SELECT id, node_id, title, topic_filter, short_summary, cluster
		 FROM memory_pages
		 WHERE user_id = ? AND id IN (${placeholders(ids)})
			AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
	)
		.bind(userId, ...ids)
		.all();
	return results ?? [];
}

async function expandContext(env, userId, entities, candidateMaps, seedNodes, pageHitRefs) {
	const seedIds = unique([...seedNodes.keys()]).slice(0, 60);
	if (!seedIds.length && !pageHitRefs.size) return;

	const pageIds = unique([...pageHitRefs.keys()]).slice(0, 60);
	const pages = await pageRows(env, userId, pageIds);
	for (const page of pages) {
		for (const entityRef of pageHitRefs.get(page.id) ?? []) {
			if (page.node_id) addSignal(candidateMaps, entityRef, page.node_id, { page: 1 });
		}
	}

	if (!seedIds.length) return;
	const marks = placeholders(seedIds);
	const [edgeResult, linkedPageResult, communityResult, clusterResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT edge.from_node, edge.to_node
			 FROM edges AS edge
			 JOIN nodes AS left_node ON left_node.id = edge.from_node AND left_node.user_id = edge.user_id
			 JOIN nodes AS right_node ON right_node.id = edge.to_node AND right_node.user_id = edge.user_id
			 WHERE edge.user_id = ? AND edge.deleted_at IS NULL
				AND (edge.from_node IN (${marks}) OR edge.to_node IN (${marks}))
				AND left_node.deleted_at IS NULL AND left_node.archived_at IS NULL AND left_node.suppressed_at IS NULL
				AND right_node.deleted_at IS NULL AND right_node.archived_at IS NULL AND right_node.suppressed_at IS NULL`,
		).bind(userId, ...seedIds, ...seedIds),
		env.DB.prepare(
			`SELECT id, node_id FROM memory_pages
			 WHERE user_id = ? AND node_id IN (${marks})
				AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId, ...seedIds),
		env.DB.prepare(
			`SELECT seed.node_id AS seed_node_id, member.node_id AS member_node_id
			 FROM node_topic_communities AS seed
			 JOIN node_topic_communities AS member
				ON member.user_id = seed.user_id AND member.community_id = seed.community_id
			 WHERE seed.user_id = ? AND seed.node_id IN (${marks})
			 LIMIT 120`,
		).bind(userId, ...seedIds),
		env.DB.prepare(
			`SELECT seed.id AS seed_node_id, peer.id AS member_node_id
			 FROM nodes AS seed
			 JOIN nodes AS peer ON peer.user_id = seed.user_id AND peer.cluster = seed.cluster AND peer.id != seed.id
			 WHERE seed.user_id = ? AND seed.id IN (${marks}) AND seed.cluster IS NOT NULL
				AND peer.deleted_at IS NULL AND peer.archived_at IS NULL AND peer.suppressed_at IS NULL
			 LIMIT 120`,
		).bind(userId, ...seedIds),
	]);

	for (const edge of edgeResult.results ?? []) {
		for (const [seed, other] of [[edge.from_node, edge.to_node], [edge.to_node, edge.from_node]]) {
			for (const entityRef of seedNodes.get(seed) ?? []) addSignal(candidateMaps, entityRef, other, { graph: 1 });
		}
	}
	for (const page of linkedPageResult.results ?? []) {
		for (const entityRef of seedNodes.get(page.node_id) ?? []) addSignal(candidateMaps, entityRef, page.node_id, { page: 1 });
	}
	for (const row of communityResult.results ?? []) {
		for (const entityRef of seedNodes.get(row.seed_node_id) ?? []) {
			addSignal(candidateMaps, entityRef, row.member_node_id, { community: 1 });
		}
	}
	for (const row of clusterResult.results ?? []) {
		for (const entityRef of seedNodes.get(row.seed_node_id) ?? []) {
			addSignal(candidateMaps, entityRef, row.member_node_id, { cluster: 1 });
		}
	}
}

function aggregateRanked(entities, nodes, candidateMaps) {
	const byNode = new Map();
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const perEntity = new Map();
	for (const entity of entities) {
		const ranked = [];
		for (const [nodeId, signals] of candidateMaps.get(entity.ref) ?? []) {
			const node = nodeById.get(nodeId);
			if (!node) continue;
			const score = scoreManualCandidate(entity, node, signals);
			const item = { entity_ref: entity.ref, node, signals, ...score };
			ranked.push(item);
			const current = byNode.get(nodeId) ?? {
				node,
				identity_score: 0,
				context_score: 0,
				exact: false,
				entity_refs: [],
				reason_codes: [],
			};
			current.identity_score = Math.max(current.identity_score, score.identity_score);
			current.context_score = Math.max(current.context_score, score.context_score);
			current.exact = current.exact || signals.exact_claim || signals.exact_label || signals.exact_alias;
			current.entity_refs = unique([...current.entity_refs, entity.ref]);
			current.reason_codes = unique([...current.reason_codes, ...score.reason_codes]);
			byNode.set(nodeId, current);
		}
		ranked.sort((left, right) =>
			Number(right.signals.exact_claim || right.signals.exact_label || right.signals.exact_alias) -
				Number(left.signals.exact_claim || left.signals.exact_label || left.signals.exact_alias) ||
			right.identity_score - left.identity_score || right.context_score - left.context_score ||
			canonicalIdentity(left.node.label).localeCompare(canonicalIdentity(right.node.label)) ||
			String(left.node.id).localeCompare(String(right.node.id)));
		perEntity.set(entity.ref, ranked);
	}
	const global = [...byNode.values()].sort((left, right) =>
		Number(right.exact) - Number(left.exact) || right.identity_score - left.identity_score ||
		right.context_score - left.context_score ||
		canonicalIdentity(left.node.label).localeCompare(canonicalIdentity(right.node.label)) ||
		String(left.node.id).localeCompare(String(right.node.id)));
	return { global, perEntity };
}

function selectBroadPool(entities, global, perEntity, limit = MANUAL_BROAD_POOL_LIMIT) {
	const selected = [];
	const selectedIds = new Set();
	const add = (item) => {
		if (!item || selectedIds.has(item.node.id) || selected.length >= limit) return;
		selectedIds.add(item.node.id);
		selected.push(item);
	};
	for (const item of global) if (item.exact) add(item);
	for (let rank = 0; rank < limit && selected.length < limit; rank++) {
		let found = false;
		for (const entity of entities) {
			const item = perEntity.get(entity.ref)?.[rank];
			if (item) found = true;
			add(item && global.find((candidate) => candidate.node.id === item.node.id));
		}
		if (!found) break;
	}
	for (const item of global) add(item);
	return selected;
}

async function cardDetails(env, userId, ids) {
	if (!ids.length) return { slices: [], events: [], relationships: [], communities: [], pages: [] };
	const marks = placeholders(ids);
	const [sliceResult, eventResult, edgeResult, communityResult, pageResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, node_id, text, kind, created_at FROM (
			 SELECT id, node_id, text, kind, created_at,
			  ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY created_at DESC, id) AS row_rank
			 FROM slices
			 WHERE user_id = ? AND node_id IN (${marks}) AND is_current = 1 AND deleted_at IS NULL
			 ) WHERE row_rank <= 5`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`SELECT id, node_id, action, text, importance, happened_at, created_at FROM (
			 SELECT id, node_id, action, text, importance, happened_at, created_at,
			  ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY
			   CASE importance WHEN 'life_significant' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
			   happened_at DESC, created_at DESC, id) AS row_rank
			 FROM events
			 WHERE user_id = ? AND node_id IN (${marks}) AND deleted_at IS NULL
			 ) WHERE row_rank <= 3`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`WITH endpoint_edges AS (
			 SELECT edge.id, edge.from_node, edge.to_node, edge.type,
			  left_node.label AS from_label, right_node.label AS to_label, edge.from_node AS owner_node_id
			 FROM edges AS edge
			 JOIN nodes AS left_node ON left_node.id = edge.from_node AND left_node.user_id = edge.user_id
			 JOIN nodes AS right_node ON right_node.id = edge.to_node AND right_node.user_id = edge.user_id
			 WHERE edge.user_id = ? AND edge.deleted_at IS NULL AND edge.from_node IN (${marks})
			  AND left_node.deleted_at IS NULL AND left_node.archived_at IS NULL AND left_node.suppressed_at IS NULL
			  AND right_node.deleted_at IS NULL AND right_node.archived_at IS NULL AND right_node.suppressed_at IS NULL
			 UNION ALL
			 SELECT edge.id, edge.from_node, edge.to_node, edge.type,
			  left_node.label, right_node.label, edge.to_node AS owner_node_id
			 FROM edges AS edge
			 JOIN nodes AS left_node ON left_node.id = edge.from_node AND left_node.user_id = edge.user_id
			 JOIN nodes AS right_node ON right_node.id = edge.to_node AND right_node.user_id = edge.user_id
			 WHERE edge.user_id = ? AND edge.deleted_at IS NULL AND edge.to_node IN (${marks})
			  AND left_node.deleted_at IS NULL AND left_node.archived_at IS NULL AND left_node.suppressed_at IS NULL
			  AND right_node.deleted_at IS NULL AND right_node.archived_at IS NULL AND right_node.suppressed_at IS NULL
			), ranked AS (
			 SELECT *, ROW_NUMBER() OVER (PARTITION BY owner_node_id ORDER BY type, from_label, to_label, id) AS row_rank
			 FROM endpoint_edges
			)
			SELECT * FROM ranked WHERE row_rank <= 5`,
		).bind(userId, ...ids, userId, ...ids),
		env.DB.prepare(
			`SELECT node_id, label, summary FROM (
			 SELECT membership.node_id, community.label, community.summary,
			  ROW_NUMBER() OVER (PARTITION BY membership.node_id ORDER BY community.label, community.id) AS row_rank
			 FROM node_topic_communities AS membership
			 JOIN topic_communities AS community
			  ON community.id = membership.community_id AND community.user_id = membership.user_id
			 WHERE membership.user_id = ? AND membership.node_id IN (${marks})
			 ) WHERE row_rank <= 3`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`SELECT node_id, title, topic_filter, short_summary FROM (
			 SELECT node_id, title, topic_filter, short_summary,
			  ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY updated_at DESC, id) AS row_rank
			 FROM memory_pages
			 WHERE user_id = ? AND node_id IN (${marks})
			  AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
			 ) WHERE row_rank <= 3`,
		).bind(userId, ...ids),
	]);
	return {
		slices: sliceResult.results ?? [],
		events: eventResult.results ?? [],
		relationships: edgeResult.results ?? [],
		communities: communityResult.results ?? [],
		pages: pageResult.results ?? [],
	};
}

/** Build bounded, UUID-free cards from already hydrated backend rows. */
export function buildNodeContextCards(rankedNodes, details = {}, limit = MANUAL_CARD_LIMIT) {
	return (rankedNodes ?? []).slice(0, Math.min(MANUAL_CARD_LIMIT, limit)).map((entry, index) => {
		const node = entry.node;
		const relationships = (details.relationships ?? [])
			.filter((edge) => edge.owner_node_id === node.id)
			.slice(0, 5)
			.map((edge) => ({
				direction: edge.from_node === node.id ? "outgoing" : "incoming",
				type: edge.type,
				other_label: cleanText(edge.from_node === node.id ? edge.to_label : edge.from_label, 120),
			}));
		return {
			ref: `N${index}`,
			label: cleanText(node.label, 160),
			category: node.category ?? null,
			state: node.state ?? null,
			summary: cleanText(node.summary, 320) || null,
			aliases: unique(manualNodeAliases(node).map((alias) => cleanText(alias, 80))).slice(0, 8),
			facts: (details.slices ?? [])
				.filter((slice) => slice.node_id === node.id)
				.slice(0, 5)
				.map((slice) => ({ kind: slice.kind, text: cleanText(slice.text, 240) })),
			relationships,
			important_events: (details.events ?? [])
				.filter((event) => event.node_id === node.id)
				.slice(0, 3)
				.map((event) => ({ action: event.action, text: cleanText(event.text, 240), importance: event.importance })),
			primary_cluster: node.cluster ?? "unclustered",
			communities: (details.communities ?? [])
				.filter((community) => community.node_id === node.id)
				.slice(0, 3)
				.map((community) => ({ label: cleanText(community.label, 120), summary: cleanText(community.summary, 240) || null })),
			linked_pages: (details.pages ?? [])
				.filter((page) => page.node_id === node.id)
				.slice(0, 3)
				.map((page) => ({
					title: cleanText(page.title, 160),
					topic: cleanText(page.topic_filter, 120) || null,
					summary: cleanText(page.short_summary, 240) || null,
				})),
			retrieval: {
				entity_refs: entry.entity_refs ?? [],
				identity_score: Number(entry.identity_score ?? 0),
				context_score: Number(entry.context_score ?? 0),
				reason_codes: entry.reason_codes ?? [],
			},
		};
	});
}

/**
 * Retrieve a bounded manual context. `refMap` and candidatesByEntityRef are
 * backend-only; only `cards` is suitable for serialization into an LLM prompt.
 */
export async function retrieveManualContext(env, config, userId, extraction = {}) {
	const entities = sourceEntities(extraction);
	const candidateMaps = candidateMapFor(entities);
	const warnings = [];
	const pageHitRefs = new Map();
	const addPageHit = (pageId, entityRef) => {
		if (!pageId) return;
		if (!pageHitRefs.has(pageId)) pageHitRefs.set(pageId, new Set());
		pageHitRefs.get(pageId).add(entityRef);
	};

	for (const entity of entities) {
		const [exact, lexical, vectors] = await Promise.all([
			exactMatches(env, userId, entity),
			bm25Matches(env, userId, entity),
			vectorMatches(env, config, userId, entity),
		]);
		for (const row of exact) {
			addSignal(candidateMaps, entity.ref, row.id, {
				exact_claim: row.exact_kind === "claim",
				exact_label: row.exact_kind === "label",
				exact_alias: row.exact_kind === "alias",
			});
		}
		for (const row of lexical) {
			if (row._warning) {
				warnings.push(row._warning);
				continue;
			}
			if (row.object_kind === "node") addSignal(candidateMaps, entity.ref, row.object_id, { bm25: row.bm25_normalized });
			else if (row.object_kind === "page") addPageHit(row.object_id, entity.ref);
		}
		for (const raw of vectors) {
			const match = vectorObject(raw);
			if (!match) continue;
			if (match.kind === "node") addSignal(candidateMaps, entity.ref, match.id, { vector: match.score });
			else addPageHit(match.id, entity.ref);
		}
	}

	let nodes = await rowsByIds(env, userId, [...candidateMaps.values()].flatMap((map) => [...map.keys()]));
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const seedNodes = new Map();
	for (const entity of entities) {
		for (const [nodeId, signals] of candidateMaps.get(entity.ref) ?? []) {
			const node = nodeById.get(nodeId);
			if (!node) continue;
			const identityScore = scoreManualCandidate(entity, node, signals).identity_score;
			if (!(signals.exact_claim || signals.exact_label || signals.exact_alias || identityScore >= 0.8)) continue;
			if (!seedNodes.has(nodeId)) seedNodes.set(nodeId, new Set());
			seedNodes.get(nodeId).add(entity.ref);
		}
	}
	await expandContext(env, userId, entities, candidateMaps, seedNodes, pageHitRefs);

	nodes = await rowsByIds(env, userId, [...candidateMaps.values()].flatMap((map) => [...map.keys()]));
	const { global, perEntity } = aggregateRanked(entities, nodes, candidateMaps);
	const exactCount = global.filter((item) => item.exact).length;
	if (exactCount > MANUAL_BROAD_POOL_LIMIT) warnings.push("exact_candidate_overflow");
	const broadPool = selectBroadPool(entities, global, perEntity);
	const cardRanked = selectBroadPool(entities, broadPool, new Map(
		[...perEntity].map(([ref, values]) => [ref, values.filter((item) => broadPool.some((entry) => entry.node.id === item.node.id))]),
	), MANUAL_CARD_LIMIT);
	const details = await cardDetails(env, userId, cardRanked.map((item) => item.node.id));
	const cards = buildNodeContextCards(cardRanked, details);
	const refMap = new Map(cards.map((card, index) => [card.ref, cardRanked[index].node.id]));
	const selectedIds = new Set(broadPool.map((item) => item.node.id));
	const candidatesByEntityRef = Object.fromEntries([...perEntity].map(([ref, values]) => [
		ref,
		values
			.filter((item) => selectedIds.has(item.node.id))
			.map((item) => ({
				node_id: item.node.id,
				label: item.node.label,
				category: item.node.category ?? null,
				identity_score: item.identity_score,
				context_score: item.context_score,
				category_compatible: item.category_compatible,
				reason_codes: item.reason_codes,
			})),
	]));

	return {
		entities,
		broadPool: broadPool.map((item) => ({
			node_id: item.node.id,
			identity_score: item.identity_score,
			context_score: item.context_score,
			exact: item.exact,
			reason_codes: item.reason_codes,
		})),
		candidatesByEntityRef,
		cards,
		refMap,
		receipt: {
			broad_pool_count: broadPool.length,
			card_count: cards.length,
			signals_used: unique(broadPool.flatMap((item) => item.reason_codes)),
			warnings: unique(warnings),
		},
	};
}
