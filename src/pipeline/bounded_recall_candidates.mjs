/**
 * V3-D13: bounded, D1-first corpus construction for E7 recall.
 *
 * Fusion limits are meaningless if every tenant row is first copied into the
 * Worker. This module generates independently bounded candidate lanes in D1,
 * fuses their object identities fairly, performs a bounded two-hop graph walk,
 * then hydrates only the evidence closure those candidates can render.
 *
 * Every query binds user and project scope before LIMIT. Failures degrade to
 * the other bounded lanes/recent fallback; they never fall back to a full scan.
 */

import { tokens } from "../lib/text.js";

export const V3_RECALL_LANE_MAX = 200;
export const V3_RECALL_INITIAL_NODE_MAX = 400;
export const V3_RECALL_NODE_LOAD_MAX = 600;
export const V3_RECALL_PAGE_LOAD_MAX = 200;
export const V3_RECALL_SLICE_LOAD_MAX = 2400;
export const V3_RECALL_EVENT_LOAD_MAX = 4000;
export const V3_RECALL_EDGE_LOAD_MAX = 600;

const NODE_ID_CHUNK = 40;
const FALLBACK_SLICES_PER_NODE = 4;
const FALLBACK_EVENTS_PER_NODE = 8;
const GRAPH_EDGE_MAX = V3_RECALL_LANE_MAX;
const GRAPH_SEED_MAX = 200;
const QUERY_TERM_MAX = 12;
const QUERY_NOISE = new Set([
	"about", "are", "can", "could", "did", "do", "does", "from", "have", "how",
	"know", "me", "please", "remember", "tell", "that", "this", "was", "were",
	"what", "when", "where", "which", "who", "why", "would", "you",
]);

const NODE_FIELDS = `n.id, n.label, n.category, n.state, n.summary, n.aliases_json,
	n.updated_at, n.last_seen_at, n.heat_score, n.cluster, n.project_id, n.project_name`;
const PAGE_FIELDS = `p.id, p.title, p.topic_filter, p.short_summary, p.key_points_json,
	p.decisions_json, p.next_steps_json, p.related_concepts_json, p.updated_at,
	p.heat_score, p.source_mode, p.cluster, p.project_id, p.project_name`;
const SLICE_FIELDS = `s.id, s.node_id, s.text, s.kind, s.created_at, s.project_id, s.project_name`;
const EVENT_FIELDS = `e.id, e.node_id, e.action, e.text, e.importance, e.happened_at,
	e.happened_at_source, e.event_time_end, e.event_time_precision, e.event_time_relation,
	e.created_at, e.project_id, e.project_name`;
const EDGE_FIELDS = `e.id, e.from_node, e.to_node, e.type, e.weight,
	e.reinforcement_count, e.fact, e.valid_at, e.invalid_at, e.project_id, e.project_name`;

function bounded(value, ceiling = V3_RECALL_LANE_MAX) {
	return Math.max(1, Math.min(ceiling, Number(value) || ceiling));
}

function meaningfulTerms(query) {
	const all = [...new Set(tokens(query))];
	const meaningful = all.filter((term) => !QUERY_NOISE.has(term));
	return (meaningful.length ? meaningful : all).slice(0, QUERY_TERM_MAX);
}

function scopePredicate(alias, recallScope, projectId) {
	if (recallScope === "project_only") {
		return projectId
			? { sql: ` AND ${alias}.project_id = ?`, bindings: [projectId] }
			: { sql: " AND 1 = 0", bindings: [] };
	}
	if (recallScope === "project_then_global") {
		return projectId
			? { sql: ` AND (${alias}.project_id = ? OR ${alias}.project_id IS NULL)`, bindings: [projectId] }
			: { sql: ` AND ${alias}.project_id IS NULL`, bindings: [] };
	}
	if (recallScope === "global") return { sql: "", bindings: [] };
	return { sql: " AND 1 = 0", bindings: [] };
}

function termPredicate(expression, queryTerms) {
	if (!queryTerms.length) return { sql: " AND 1 = 0", bindings: [] };
	return {
		sql: ` AND (${queryTerms.map(() => `instr(lower(${expression}), ?) > 0`).join(" OR ")})`,
		bindings: queryTerms,
	};
}

async function safeAll(env, sql, bindings, label, failures) {
	try {
		const { results } = await env.DB.prepare(sql).bind(...bindings).all();
		return results ?? [];
	} catch {
		failures.push(label);
		console.warn(`bounded recall ${label} lane failed`);
		return [];
	}
}

function dedupeRows(rows, key = (row) => row.id, limit = Infinity) {
	const output = [];
	const seen = new Set();
	for (const row of rows) {
		const id = key(row);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		output.push(row);
		if (output.length >= limit) break;
	}
	return output;
}

function roundRobinIds(lanes, limit) {
	const output = [];
	const seen = new Set();
	let index = 0;
	while (output.length < limit) {
		let advanced = false;
		for (const lane of lanes) {
			const id = lane[index];
			if (!id) continue;
			advanced = true;
			if (seen.has(id)) continue;
			seen.add(id);
			output.push(id);
			if (output.length >= limit) break;
		}
		if (!advanced) break;
		index += 1;
	}
	return output;
}

function chunks(values, size = NODE_ID_CHUNK) {
	const output = [];
	for (let offset = 0; offset < values.length; offset += size) output.push(values.slice(offset, offset + size));
	return output;
}

function edgeActivePredicate(pastIntent, now) {
	return pastIntent
		? { sql: " AND (e.valid_at IS NULL OR e.valid_at <= ?)", bindings: [now] }
		: {
			sql: " AND (e.valid_at IS NULL OR e.valid_at <= ?) AND (e.invalid_at IS NULL OR e.invalid_at > ?)",
			bindings: [now, now],
		};
}

async function manualFtsCandidates(env, userId, queryTerms, scope, limit, failures) {
	if (!queryTerms.length) return [];
	const match = queryTerms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
	const rows = [];
	for (const kind of ["node", "page"]) {
		const table = kind === "node" ? "nodes" : "memory_pages";
		const alias = kind === "node" ? "n" : "m";
		const active = kind === "node"
			? `${alias}.deleted_at IS NULL AND ${alias}.archived_at IS NULL AND ${alias}.suppressed_at IS NULL`
			: `${alias}.deleted_at IS NULL AND ${alias}.archived_at IS NULL AND ${alias}.suppressed_at IS NULL`;
		const project = scopePredicate(alias, scope.recallScope, scope.projectId);
		const result = await safeAll(env,
			`SELECT p.object_kind, p.object_id, bm25(manual_search_fts, 4.0, 1.5, 0.5) AS fts_score
			 FROM manual_search_fts f
			 JOIN manual_search_profiles p ON p.rowid = f.rowid
			 JOIN ${table} ${alias} ON ${alias}.id = p.object_id AND ${alias}.user_id = p.user_id
			 WHERE manual_search_fts MATCH ? AND p.user_id = ? AND p.object_kind = ?
			   AND ${active}${project.sql}
			 ORDER BY bm25(manual_search_fts, 4.0, 1.5, 0.5), p.object_id
			 LIMIT ?`,
			[match, userId, kind, ...project.bindings, limit], `fts_${kind}`, failures);
		rows.push(...result);
	}
	return rows
		.sort((left, right) => Number(left.fts_score ?? 0) - Number(right.fts_score ?? 0)
			|| String(left.object_id).localeCompare(String(right.object_id)))
		.slice(0, limit);
}

async function adjacentEdges(env, userId, seedIds, scope, {
	limit,
	pastIntent,
	now,
	failures,
	label,
}) {
	const output = [];
	const seen = new Set();
	const project = scopePredicate("e", scope.recallScope, scope.projectId);
	const active = edgeActivePredicate(pastIntent, now);
	for (const group of chunks(seedIds.slice(0, V3_RECALL_NODE_LOAD_MAX))) {
		if (output.length >= limit) break;
		const marks = group.map(() => "?").join(",");
		const rows = await safeAll(env,
			`SELECT ${EDGE_FIELDS} FROM edges e
			 WHERE e.user_id = ? AND e.deleted_at IS NULL${project.sql}${active.sql}
			   AND (e.from_node IN (${marks}) OR e.to_node IN (${marks}))
			 ORDER BY COALESCE(e.weight, 1) DESC, e.created_at DESC, e.id ASC LIMIT ?`,
			[userId, ...project.bindings, ...active.bindings, ...group, ...group, limit - output.length],
			label, failures);
		for (const row of rows) {
			if (!row.id || seen.has(row.id)) continue;
			seen.add(row.id);
			output.push(row);
			if (output.length >= limit) break;
		}
	}
	return output;
}

async function loadNodes(env, userId, ids, scope, failures) {
	const byId = new Map();
	const project = scopePredicate("n", scope.recallScope, scope.projectId);
	for (const group of chunks(ids)) {
		const marks = group.map(() => "?").join(",");
		const rows = await safeAll(env,
			`SELECT ${NODE_FIELDS} FROM nodes n
			 WHERE n.user_id = ? AND n.deleted_at IS NULL AND n.archived_at IS NULL
			   AND n.suppressed_at IS NULL${project.sql} AND n.id IN (${marks})`,
			[userId, ...project.bindings, ...group], "node_hydration", failures);
		for (const row of rows) byId.set(row.id, row);
	}
	return ids.map((id) => byId.get(id)).filter(Boolean).slice(0, V3_RECALL_NODE_LOAD_MAX);
}

async function loadPages(env, userId, ids, scope, failures) {
	const byId = new Map();
	const project = scopePredicate("p", scope.recallScope, scope.projectId);
	for (const group of chunks(ids)) {
		const marks = group.map(() => "?").join(",");
		const rows = await safeAll(env,
			`SELECT ${PAGE_FIELDS} FROM memory_pages p
			 WHERE p.user_id = ? AND p.deleted_at IS NULL AND p.archived_at IS NULL
			   AND p.suppressed_at IS NULL${project.sql} AND p.id IN (${marks})`,
			[userId, ...project.bindings, ...group], "page_hydration", failures);
		for (const row of rows) byId.set(row.id, row);
	}
	return ids.map((id) => byId.get(id)).filter(Boolean).slice(0, V3_RECALL_PAGE_LOAD_MAX);
}

async function loadSliceClosure(env, userId, nodeIds, matched, scope, failures) {
	const output = dedupeRows(matched.filter((row) => nodeIds.includes(row.node_id)), (row) => row.id,
		V3_RECALL_SLICE_LOAD_MAX);
	const seen = new Set(output.map((row) => row.id));
	const project = scopePredicate("s", scope.recallScope, scope.projectId);
	for (const group of chunks(nodeIds)) {
		if (output.length >= V3_RECALL_SLICE_LOAD_MAX) break;
		const marks = group.map(() => "?").join(",");
		const limit = Math.min(group.length * FALLBACK_SLICES_PER_NODE,
			V3_RECALL_SLICE_LOAD_MAX - output.length);
		const rows = await safeAll(env,
			`WITH ranked AS (
				SELECT ${SLICE_FIELDS}, ROW_NUMBER() OVER (
					PARTITION BY s.node_id ORDER BY s.created_at DESC, s.id ASC
				) AS evidence_rank
				FROM slices s WHERE s.user_id = ? AND s.is_current = 1 AND s.deleted_at IS NULL
				  ${project.sql} AND s.node_id IN (${marks})
			 )
			 SELECT id,node_id,text,kind,created_at,project_id,project_name FROM ranked
			 WHERE evidence_rank <= ? ORDER BY node_id,evidence_rank LIMIT ?`,
			[userId, ...project.bindings, ...group, FALLBACK_SLICES_PER_NODE, limit],
			"slice_hydration", failures);
		for (const row of rows) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			output.push(row);
		}
	}
	return output.slice(0, V3_RECALL_SLICE_LOAD_MAX);
}

async function loadEventClosure(env, userId, nodeIds, matched, scope, failures) {
	const output = dedupeRows(matched.filter((row) => nodeIds.includes(row.node_id)), (row) => row.id,
		V3_RECALL_EVENT_LOAD_MAX);
	const seen = new Set(output.map((row) => row.id));
	const project = scopePredicate("e", scope.recallScope, scope.projectId);
	for (const group of chunks(nodeIds)) {
		if (output.length >= V3_RECALL_EVENT_LOAD_MAX) break;
		const marks = group.map(() => "?").join(",");
		const limit = Math.min(group.length * FALLBACK_EVENTS_PER_NODE,
			V3_RECALL_EVENT_LOAD_MAX - output.length);
		const rows = await safeAll(env,
			`WITH ranked AS (
				SELECT ${EVENT_FIELDS}, ROW_NUMBER() OVER (
					PARTITION BY e.node_id ORDER BY COALESCE(e.happened_at,e.created_at) DESC,e.id ASC
				) AS evidence_rank
				FROM events e WHERE e.user_id = ? AND e.deleted_at IS NULL
				  ${project.sql} AND e.node_id IN (${marks})
			 )
			 SELECT id,node_id,action,text,importance,happened_at,happened_at_source,event_time_end,
				event_time_precision,event_time_relation,created_at,project_id,project_name FROM ranked
			 WHERE evidence_rank <= ? ORDER BY node_id,evidence_rank LIMIT ?`,
			[userId, ...project.bindings, ...group, FALLBACK_EVENTS_PER_NODE, limit],
			"event_hydration", failures);
		for (const row of rows) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			output.push(row);
		}
	}
	return output.slice(0, V3_RECALL_EVENT_LOAD_MAX);
}

/** Build the bounded corpus consumed by the existing fusion/MMR/render path. */
export async function loadBoundedV3RecallCorpus(env, userId, query, {
	recallScope = "global",
	projectId = null,
	candidateLimit = V3_RECALL_LANE_MAX,
	vectorNodeIds = [],
	temporalIntent = false,
	pastIntent = false,
} = {}) {
	const startedAt = Date.now();
	const failures = [];
	const scope = { recallScope, projectId };
	const limit = bounded(candidateLimit);
	const queryTerms = meaningfulTerms(query);
	const now = Date.now();

	const nodeScope = scopePredicate("n", recallScope, projectId);
	const pageScope = scopePredicate("p", recallScope, projectId);
	const sliceScope = scopePredicate("s", recallScope, projectId);
	const eventScope = scopePredicate("e", recallScope, projectId);
	const edgeScope = scopePredicate("e", recallScope, projectId);
	const nodeTerms = termPredicate("coalesce(n.label,'')||' '||coalesce(n.aliases_json,'')||' '||coalesce(n.summary,'')", queryTerms);
	const pageTerms = termPredicate("coalesce(p.title,'')||' '||coalesce(p.topic_filter,'')||' '||coalesce(p.short_summary,'')", queryTerms);
	const sliceTerms = termPredicate("coalesce(s.text,'')", queryTerms);
	const eventTerms = termPredicate("coalesce(e.text,'')||' '||coalesce(e.action,'')", queryTerms);
	const edgeTerms = termPredicate("coalesce(e.fact,'')||' '||coalesce(e.type,'')", queryTerms);
	const activeEdges = edgeActivePredicate(pastIntent, now);

	const [ftsRows, directNodes, directPages, matchedSlices, lexicalEvents, matchedEdges, recentNodes, recentPages] = await Promise.all([
		manualFtsCandidates(env, userId, queryTerms, scope, limit, failures),
		safeAll(env,
			`SELECT n.id FROM nodes n WHERE n.user_id=? AND n.deleted_at IS NULL
			 AND n.archived_at IS NULL AND n.suppressed_at IS NULL${nodeScope.sql}${nodeTerms.sql}
			 ORDER BY n.updated_at DESC,n.id ASC LIMIT ?`,
			[userId, ...nodeScope.bindings, ...nodeTerms.bindings, limit], "exact_node", failures),
		safeAll(env,
			`SELECT p.id FROM memory_pages p WHERE p.user_id=? AND p.deleted_at IS NULL
			 AND p.archived_at IS NULL AND p.suppressed_at IS NULL${pageScope.sql}${pageTerms.sql}
			 ORDER BY p.updated_at DESC,p.id ASC LIMIT ?`,
			[userId, ...pageScope.bindings, ...pageTerms.bindings, limit], "exact_page", failures),
		safeAll(env,
			`SELECT ${SLICE_FIELDS} FROM slices s WHERE s.user_id=? AND s.is_current=1
			 AND s.deleted_at IS NULL${sliceScope.sql}${sliceTerms.sql}
			 ORDER BY s.created_at DESC,s.id ASC LIMIT ?`,
			[userId, ...sliceScope.bindings, ...sliceTerms.bindings, limit], "lexical_slice", failures),
		safeAll(env,
			`SELECT ${EVENT_FIELDS} FROM events e WHERE e.user_id=? AND e.deleted_at IS NULL
			 ${eventScope.sql}${eventTerms.sql}
			 ORDER BY COALESCE(e.happened_at,e.created_at) DESC,e.id ASC LIMIT ?`,
			[userId, ...eventScope.bindings, ...eventTerms.bindings, limit], "lexical_event", failures),
		safeAll(env,
			`SELECT ${EDGE_FIELDS} FROM edges e WHERE e.user_id=? AND e.deleted_at IS NULL
			 ${edgeScope.sql}${activeEdges.sql}${edgeTerms.sql}
			 ORDER BY COALESCE(e.weight,1) DESC,e.created_at DESC,e.id ASC LIMIT ?`,
			[userId, ...edgeScope.bindings, ...activeEdges.bindings, ...edgeTerms.bindings, limit],
			"lexical_edge", failures),
		safeAll(env,
			`SELECT n.id FROM nodes n WHERE n.user_id=? AND n.deleted_at IS NULL
			 AND n.archived_at IS NULL AND n.suppressed_at IS NULL${nodeScope.sql}
			 ORDER BY COALESCE(n.heat_score,1) DESC,COALESCE(n.updated_at,n.last_seen_at,0) DESC,n.id ASC LIMIT ?`,
			[userId, ...nodeScope.bindings, limit], "recent_node", failures),
		safeAll(env,
			`SELECT p.id FROM memory_pages p WHERE p.user_id=? AND p.deleted_at IS NULL
			 AND p.archived_at IS NULL AND p.suppressed_at IS NULL${pageScope.sql}
			 ORDER BY COALESCE(p.heat_score,1) DESC,COALESCE(p.updated_at,0) DESC,p.id ASC LIMIT ?`,
			[userId, ...pageScope.bindings, limit], "recent_page", failures),
	]);

	let matchedEvents = lexicalEvents;
	if (temporalIntent) {
		const temporal = await safeAll(env,
			`SELECT ${EVENT_FIELDS} FROM events e WHERE e.user_id=? AND e.deleted_at IS NULL
			 ${eventScope.sql} AND e.happened_at IS NOT NULL
			 AND e.happened_at_source IN ('extracted','phrase','source_time')
			 ORDER BY e.happened_at DESC,e.id ASC LIMIT ?`,
			[userId, ...eventScope.bindings, limit], "temporal_event", failures);
		matchedEvents = dedupeRows([...lexicalEvents, ...temporal], (row) => row.id, limit);
	}

	const ftsNodeIds = ftsRows.filter((row) => row.object_kind === "node").map((row) => row.object_id);
	const ftsPageIds = ftsRows.filter((row) => row.object_kind === "page").map((row) => row.object_id);
	const edgeNodeIds = matchedEdges.flatMap((row) => [row.from_node, row.to_node]);
	let nodeIds = roundRobinIds([
		directNodes.map((row) => row.id),
		matchedSlices.map((row) => row.node_id),
		matchedEvents.map((row) => row.node_id),
		edgeNodeIds,
		ftsNodeIds,
		vectorNodeIds,
		recentNodes.map((row) => row.id),
	], V3_RECALL_INITIAL_NODE_MAX);
	const pageIds = roundRobinIds([
		directPages.map((row) => row.id),
		ftsPageIds,
		recentPages.map((row) => row.id),
	], V3_RECALL_PAGE_LOAD_MAX);

	const firstHopEdges = await adjacentEdges(env, userId, nodeIds.slice(0, GRAPH_SEED_MAX), scope, {
		limit: Math.min(limit, GRAPH_EDGE_MAX), pastIntent, now, failures, label: "graph_hop1",
	});
	const initialSet = new Set(nodeIds);
	const firstHopNodes = dedupeRows(firstHopEdges.flatMap((edge) => [
		{ id: edge.from_node }, { id: edge.to_node },
	]), (row) => row.id).map((row) => row.id).filter((id) => !initialSet.has(id));
	const secondHopEdges = await adjacentEdges(env, userId, firstHopNodes.slice(0, GRAPH_SEED_MAX), scope, {
		limit: Math.max(0, GRAPH_EDGE_MAX - firstHopEdges.length),
		pastIntent, now, failures, label: "graph_hop2",
	});
	const graphEdges = dedupeRows([...firstHopEdges, ...secondHopEdges], (row) => row.id, GRAPH_EDGE_MAX);
	const graphNodeIds = graphEdges.flatMap((edge) => [edge.from_node, edge.to_node]);
	nodeIds = roundRobinIds([nodeIds, graphNodeIds], V3_RECALL_NODE_LOAD_MAX);

	const [nodes, pages, slices, events] = await Promise.all([
		loadNodes(env, userId, nodeIds, scope, failures),
		loadPages(env, userId, pageIds, scope, failures),
		loadSliceClosure(env, userId, nodeIds, matchedSlices, scope, failures),
		loadEventClosure(env, userId, nodeIds, matchedEvents, scope, failures),
	]);
	const relationFallback = await adjacentEdges(env, userId, nodeIds, scope, {
		limit: V3_RECALL_EDGE_LOAD_MAX, pastIntent, now, failures, label: "edge_hydration",
	});
	const edges = dedupeRows([...matchedEdges, ...graphEdges, ...relationFallback], (row) => row.id,
		V3_RECALL_EDGE_LOAD_MAX);
	const profile = await safeAll(env,
		"SELECT * FROM memory_profiles WHERE user_id=? AND ?='global' LIMIT 1",
		[userId, recallScope], "profile", failures);

	return {
		nodes,
		pages,
		slices,
		events,
		edges,
		profile,
		bm25Rank: ftsRows.map((row) => ({ key: `${row.object_kind}:${row.object_id}` })),
		telemetry: {
			used: true,
			queryTerms: queryTerms.length,
			laneCounts: {
				fts: ftsRows.length,
				exactNode: directNodes.length,
				exactPage: directPages.length,
				lexicalSlice: matchedSlices.length,
				lexicalEvent: lexicalEvents.length,
				temporalEvent: Math.max(0, matchedEvents.length - lexicalEvents.length),
				lexicalEdge: matchedEdges.length,
				vector: Math.min(vectorNodeIds.length, V3_RECALL_LANE_MAX),
				graph: graphEdges.length,
			},
			corpusCounts: {
				nodes: nodes.length,
				pages: pages.length,
				slices: slices.length,
				events: events.length,
				edges: edges.length,
			},
			failures: [...new Set(failures)].sort(),
			latencyMs: Date.now() - startedAt,
		},
	};
}
