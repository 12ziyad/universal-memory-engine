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
// Interrogative lookups aimed at a named subject: "what do you remember about
// Rahul?", "do you remember Rahul?". Without this these fall through to
// classifyMessage(), which calls any bare question with no first-person
// statement "utility" and skips the memory lookup entirely — the single most
// natural way to ask for a memory was the one phrasing that never recalled.
const RECALL_INTENT_RE =
	/\b(?:do|did|can|could|would|will)\s+(?:you\s+)?(?:still\s+)?(?:remember|recall)\b|\bwhat\s+(?:do|did)\s+you\s+(?:remember|recall|know)\b|\b(?:remember|recall)\s+(?:what|when|where|why|how|who|whether|anything|something)\b|\btell\s+me\s+(?:what|everything|anything)\s+you\s+(?:remember|recall|know)\b/i;
// "Remember that …" / "note this" are save instructions, not lookups. They must
// never be answered from memory instead of being written to it.
const SAVE_IMPERATIVE_RE =
	/^\s*(?:please\s+|also\s+|and\s+)*(?:remember|note|save|store|keep in mind)\s+(?:that|this|to|the following|my|i|we|he|she|they|it)\b/i;
// Pure task requests: generation, translation, arithmetic, formatting. These are
// answerable with no personal context at all, so they stay out of recall. Note
// this deliberately does NOT include bare interrogatives ("who is …", "when is
// …") — those are exactly how people ask about their own people and plans.
const IMPERSONAL_TASK_RE =
	/^\s*(?:please\s+|can you\s+|could you\s+|hey\s+)*(?:translate|calculate|compute|convert|spell|write|generate|draft|code|implement|refactor|debug|rewrite|paraphrase|summarize|summarise)\b/i;

// Questions about the past re-open closed validity windows: "where did I use
// to live" should surface the superseded LIVES_IN edge; "where do I live" must
// not. Everything bi-temporal filtering hides is behind this one gate.
const PAST_INTENT_RE =
	/\b(used to|before|previous(?:ly)?|back then|formerly|history|in the past|no longer|any ?more|earlier|old (?:job|home|place|city|team|employer)|last (?:year|job|place))\b|\bdid\b.*\b(?:live|work|use|train|study)\b/i;

/** Anything phrased as a question — the clearest possible request for memory. */
function isQuestion(text) {
	const q = String(text ?? "").trim();
	if (!q) return false;
	return /\?\s*$/.test(q)
		|| /^(?:who|what|when|where|why|which|how|did|do|does|is|are|was|were|can|could|will|would|has|have|had|tell me)\b/i.test(q);
}

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
	const recallIntent = RECALL_INTENT_RE.test(lower) && !SAVE_IMPERATIVE_RE.test(q);
	if (IMPERSONAL_TASK_RE.test(q)) {
		return { ...base, mode: "no_recall", reason: "impersonal_task", topN: 0 };
	}
	// A question is the STRONGEST signal that memory should be consulted, so it
	// must never be gated by classifyMessage(): that classifier answers a
	// different question ("is this a durable fact worth SAVING?", for which a
	// question is correctly never a fact) and calls every question lacking
	// "I"/"my" utility. Reusing it here meant "When is Sarah's birthday?" or
	// "What did Melanie research?" never looked in memory even when the answer
	// was stored — measured at 87.5% of LoCoMo questions silently skipped.
	// Attempting a lookup that finds nothing is cheap; refusing to look is not.
	if (!broad && !update && !recallIntent && !isQuestion(q) && classifyMessage(q) === "utility") {
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
	if (recallIntent) {
		return { ...base, mode: "light_recall", reason: "recall_intent_query" };
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

export function buildContext(entries, plan = recallGate("memory")) {
	const lines = [];
	let nodeCount = 0;
	let pageCount = 0;
	for (const entry of entries) {
		if (entry.type === "node" && nodeCount < plan.maxContextNodes) {
			const n = entry.item;
			const sliceTexts = n.slices.map((s) => s.text);
			const eventTexts = [...n.events].reverse().map((e) => e.text);
			// Relations lead: an edge fact ("Amara works at Nova Systems") is
			// usually the direct answer, and it is what the edge pass paid for.
			const relationTexts = n.relations ?? [];
			const items = [...relationTexts, ...sliceTexts, ...eventTexts].filter(Boolean).slice(0, plan.maxLineItems);
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
		if (chars >= plan.maxContextChars) break;
		// Clip an oversized line to the remaining budget instead of dropping it.
		// Digest-heavy nodes can produce single lines longer than the whole
		// budget; breaking on the first one returned an EMPTY context even when
		// recall had strong matches — the caller saw "found memory" with nothing
		// attached.
		const remaining = plan.maxContextChars - chars;
		const clipped = line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line;
		out.push(clipped);
		chars += clipped.length + 1;
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

/**
 * Greedy MMR over fused entries: relevance minus similarity to what is
 * already selected, so five phrasings of one fact return once. Similarity is
 * token Jaccard over label/title + summary — cheap and deterministic.
 */
function mmrSelect(entries, topN, lambda = 0.75) {
	const tokensOf = (entry) => {
		const item = entry.item ?? {};
		return new Set(tokens([item.label ?? item.title ?? "", item.summary ?? item.short_summary ?? ""].join(" ")));
	};
	const pool = entries.map((entry) => ({ entry, toks: tokensOf(entry) }));
	const chosen = [];
	while (chosen.length < topN && pool.length) {
		let bestIdx = 0;
		let bestVal = -Infinity;
		for (let i = 0; i < pool.length; i++) {
			let maxSim = 0;
			for (const c of chosen) {
				const inter = [...pool[i].toks].filter((t) => c.toks.has(t)).length;
				const union = new Set([...pool[i].toks, ...c.toks]).size || 1;
				maxSim = Math.max(maxSim, inter / union);
			}
			const val = lambda * pool[i].entry.score - (1 - lambda) * maxSim * 0.02;
			if (val > bestVal) { bestVal = val; bestIdx = i; }
		}
		chosen.push(pool.splice(bestIdx, 1)[0]);
	}
	return chosen.map((c) => c.entry);
}

function nodeItem(node, slicesByNode, eventsByNode, graph = null) {
	// The node's relations, validity-filtered: open windows always; closed ones
	// only when the question asked about the past — rendered with their end
	// date so "until mid-2026" is part of the answer, not a surprise.
	let relations = [];
	if (graph?.edgeRows) {
		for (const edge of graph.edgeRows) {
			if (edge.from_node !== node.id && edge.to_node !== node.id) continue;
			const closed = edge.invalid_at != null;
			if (closed && !graph.pastIntent) continue;
			const otherId = edge.from_node === node.id ? edge.to_node : edge.from_node;
			const other = graph.byId?.get(otherId);
			const base = edge.fact
				?? (other ? `${node.label} ${String(edge.type).toLowerCase().replace(/_/g, " ")} ${other.label}` : null);
			if (!base) continue;
			relations.push(closed ? `${base} (until ${new Date(edge.invalid_at).toISOString().slice(0, 10)})` : base);
			if (relations.length >= 3) break;
		}
	}
	return {
		id: node.id,
		label: node.label,
		category: node.category,
		state: node.state,
		summary: node.summary,
		cluster: node.cluster,
		slices: slicesByNode.get(node.id) ?? [],
		events: eventsByNode.get(node.id) ?? [],
		relations,
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
			`SELECT id, from_node, to_node, type, weight, reinforcement_count, fact, valid_at, invalid_at
			 FROM edges WHERE user_id = ? AND deleted_at IS NULL`,
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
	const edgeRows = edgesRes.results ?? [];

	// The stack: one query embedding, four independently RANKED signals fused
	// with reciprocal-rank fusion, a validity-time filter, MMR de-duplication,
	// and a per-item context budget. ZERO generative calls anywhere in here —
	// the embedding is the only model touch.
	const pastIntent = PAST_INTENT_RE.test(q);

	// ---- signal 1: exact / alias lookup --------------------------------------
	// "what's my deploy command" must hit a node named "deploy command" exactly,
	// not approximately. Longer matched labels outrank shorter ones.
	const exactRank = [];
	for (const node of nodes) {
		const aliases = parseJsonArray(node.aliases_json);
		let w = 0;
		if (wordContains(queryNorm, normalizeLabel(node.label))) w = tokens(node.label).length + 1;
		else if (aliases.some((alias) => wordContains(queryNorm, normalizeLabel(alias)))) w = 1;
		if (w > 0) exactRank.push({ key: `node:${node.id}`, w: w + Number(node.heat_score ?? 1) * 0.01 });
	}
	for (const page of pages) {
		if (wordContains(queryNorm, normalizeLabel(page.title))) {
			exactRank.push({ key: `page:${page.id}`, w: tokens(page.title).length + 1 });
		}
	}
	exactRank.sort((a, b) => b.w - a.w);

	// ---- signal 2: BM25 (D1 FTS5), keyword overlap as its tail ---------------
	// FTS catches the rare terms vectors blur; the keyword scan keeps objects
	// that predate their search profile reachable.
	let bm25Rank = [];
	try {
		const ftsMatch = queryTokens
			.filter((t) => t.length > 1)
			.slice(0, 12)
			.map((t) => `"${t.replace(/"/g, "")}"`)
			.join(" OR ");
		if (ftsMatch) {
			const { results } = await env.DB.prepare(
				`SELECT p.object_kind, p.object_id
				 FROM manual_search_fts f
				 JOIN manual_search_profiles p ON p.rowid = f.rowid
				 WHERE manual_search_fts MATCH ? AND p.user_id = ?
				 ORDER BY bm25(manual_search_fts, 4.0, 1.5, 0.5)
				 LIMIT 24`,
			).bind(ftsMatch, userId).all();
			bm25Rank = (results ?? [])
				.filter((r) => (r.object_kind === "node" ? byId.has(r.object_id) : pageById.has(r.object_id)))
				.map((r) => ({ key: `${r.object_kind}:${r.object_id}` }));
		}
	} catch (err) {
		console.warn("bm25 recall signal failed:", err?.message ?? err);
	}
	const inBm25 = new Set(bm25Rank.map((e) => e.key));
	const keywordRank = [];
	for (const node of nodes) {
		const slices = slicesByNode.get(node.id) ?? [];
		const events = eventsByNode.get(node.id) ?? [];
		const corpus = [node.label, node.summary, ...parseJsonArray(node.aliases_json), ...slices.map((s) => s.text), ...events.map((e) => e.text)]
			.filter(Boolean).join(" ");
		const w = keywordScore(tokens(corpus), queryTokens);
		if (w > 0 && !inBm25.has(`node:${node.id}`)) keywordRank.push({ key: `node:${node.id}`, w });
	}
	for (const page of pages) {
		const corpus = [
			page.title, page.topic_filter, page.short_summary,
			...parseJsonArray(page.key_points_json), ...parseJsonArray(page.decisions_json),
			...parseJsonArray(page.next_steps_json), ...parseJsonArray(page.related_concepts_json),
		].filter(Boolean).join(" ");
		const w = keywordScore(tokens(corpus), queryTokens);
		if (w > 0 && !inBm25.has(`page:${page.id}`)) keywordRank.push({ key: `page:${page.id}`, w });
	}
	keywordRank.sort((a, b) => b.w - a.w);
	const lexicalRank = [...bm25Rank, ...keywordRank];

	// ---- signal 3: vector (paraphrase) ---------------------------------------
	const vector = await embed(env, config, q);
	const matches = await queryNodeVectors(env, config, { userId, values: vector, topK: plan.topN + 6 });
	const vectorRank = matches.filter((m) => byId.has(m.id)).map((m) => ({ key: `node:${m.id}` }));

	// ---- signal 4: graph expansion -------------------------------------------
	// Walk edges out from the seeds the other signals matched — the only way a
	// multi-hop question ("who works at the company I mentioned?") reaches an
	// answer whose own text shares nothing with the query. Closed validity
	// windows stay invisible here unless the question is about the past.
	const seedIds = new Set();
	for (const list of [exactRank, lexicalRank, vectorRank]) {
		for (const entry of list.slice(0, 6)) {
			if (entry.key.startsWith("node:")) seedIds.add(entry.key.slice(5));
		}
	}
	const graphRank = [];
	const expanded = new Set();
	for (const edge of edgeRows) {
		if (edge.invalid_at != null && !pastIntent) continue;
		const fromSeed = seedIds.has(edge.from_node);
		const toSeed = seedIds.has(edge.to_node);
		if (!fromSeed && !toSeed) continue;
		const other = fromSeed ? edge.to_node : edge.from_node;
		if (!byId.has(other) || seedIds.has(other) || expanded.has(other)) continue;
		expanded.add(other);
		graphRank.push({ key: `node:${other}`, w: Number(edge.weight ?? 1) + Number(edge.reinforcement_count ?? 0) * 0.1 });
	}
	graphRank.sort((a, b) => b.w - a.w);

	const lexicalUsed = exactRank.length > 0 || lexicalRank.length > 0;
	const vectorUsed = vectorRank.length > 0;
	const graphExpansionUsed = graphRank.length > 0;

	// ---- RRF fusion ----------------------------------------------------------
	const RRF_K = 60;
	const fused = new Map();
	for (const list of [exactRank, lexicalRank, vectorRank, graphRank]) {
		list.forEach((entry, i) => {
			fused.set(entry.key, (fused.get(entry.key) ?? 0) + 1 / (RRF_K + i + 1));
		});
	}

	// Profile-cluster affinity nudges ties; it can no longer FILTER results the
	// signals earned (the old top-2-clusters filter could drop a correct
	// multi-hop answer that lived in another cluster).
	const profileClusters = profileClusterMatches(profile, queryTokens);
	for (const [key, score] of fused) {
		if (!key.startsWith("node:")) continue;
		const node = byId.get(key.slice(5));
		if (node?.cluster && profileClusters.has(node.cluster)) {
			fused.set(key, score + Math.min(profileClusters.get(node.cluster) * 0.002, 0.008));
		}
	}

	if (fused.size === 0 && (plan.mode === "deep_recall" || plan.mode === "update_mode")) {
		for (const node of [...nodes].sort((a, b) => recentScore(b) - recentScore(a)).slice(0, plan.maxContextNodes)) {
			fused.set(`node:${node.id}`, 0.001 + Math.max(0, recentScore(node)) * 0.001);
		}
		for (const page of [...pages].sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0)).slice(0, plan.maxContextPages)) {
			fused.set(`page:${page.id}`, 0.001);
		}
	}

	if (fused.size === 0) return emptyRecall(plan, { lexical_used: lexicalUsed, vector_used: vectorUsed });

	let entries = [...fused.entries()].map(([key, score]) => {
		const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		return type === "node"
			? { type, id, score, item: nodeItem(byId.get(id), slicesByNode, eventsByNode, { edgeRows, byId, pastIntent }) }
			: { type, id, score, item: pageItem(pageById.get(id)) };
	}).filter((entry) => entry.item);

	const activatedClusters = activateClusters(entries);

	// ---- MMR: five phrasings of one fact return once -------------------------
	entries = mmrSelect(dedupeEntries(entries).sort((a, b) => b.score - a.score), plan.topN);

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
