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
import { findStagedText } from "./staged_text.js";
import { rerankEntries } from "./rerank.js";
import {
	memoryV3AdaptiveContextEnabled,
	memoryV3EpisodeFallbackEnabled,
	memoryV3HybridRetrievalEnabled,
	memoryV3SourceExpansionEnabled,
} from "../lib/memory_v3.js";
import { adaptiveContextPlan, compileAdaptiveContext } from "./adaptive_context.mjs";
import {
	hybridTemporalIntent,
	orderNodeEvidence,
	rankHybridAssertions,
} from "./hybrid_retrieval.mjs";
import { loadBoundedV3RecallCorpus } from "./bounded_recall_candidates.mjs";
import { expandSelectedSourceEvidence } from "./source_expansion.mjs";
import {
	emptyEpisodeFallbackResult,
	findEpisodeFallbackEvidence,
} from "./episode_fallback.mjs";

const TOP_N = 8;
const MAX_EVENTS_PER_NODE = 8;
const EVENT_SCAN_LIMIT = 500;
const MAX_CONTEXT_NODES = 6;
const MAX_CONTEXT_PAGES = 4;
const MAX_LINE_ITEMS = 4;
const MAX_CONTEXT_CHARS = 1800;
const RECALL_SCOPES = new Set(["global", "project_only", "project_then_global"]);

/**
 * BF-2 — the recall depth budget.
 *
 * `/v1/recall` advertised a `limit` parameter, both SDKs expose it, and the
 * handler never forwarded it. A caller asking for one memory got eight and had
 * no way to tell. A parameter that is documented must either work or fail
 * loudly; quietly doing nothing is the worst of the three.
 *
 * Two budgets, deliberately separated:
 *
 *   FINAL EVIDENCE BUDGET     how many items the caller gets back, and how much
 *                             of the rendered context they fill.
 *   INTERNAL CANDIDATE BUDGET how many candidates each retrieval lane may
 *                             generate before fusion. Always bounded by the
 *                             constants below, never by the caller.
 *
 * Two modes, because widening retrieval and narrowing it are different risks:
 *
 *   "narrow"  Legacy accounts. `limit` may only ever REDUCE what the proven
 *             path would have returned. Asking for 3 gets at most 3; asking for
 *             200 gets the legacy maximum. No new retrieval work, no new spend,
 *             no architecture change — and no published SDK caller breaks.
 *   "depth"   Memory V3 accounts. `limit` is a real depth control that raises
 *             both budgets, up to the hard ceilings here.
 */
export const RECALL_LIMIT_MIN = 1;
export const RECALL_LIMIT_MAX = 200;
const RECALL_CONTEXT_CHARS_HARD_MAX = 24_000;
const RECALL_CONTEXT_CHARS_PER_ITEM = 220;
// Vectorize's own per-query ceiling. Asking past it is an error, not more results.
const VECTOR_TOPK_MAX = 100;
const BM25_CANDIDATES_BASE = 24;
const BM25_CANDIDATES_MAX = 200;
const GRAPH_EXPANSION_BASE = 50;
const GRAPH_EXPANSION_MAX = 200;
const EVENT_SCAN_HARD_MAX = 4000;

export class RecallLimitError extends Error {
	constructor(message) {
		super(message);
		this.name = "RecallLimitError";
		this.code = "invalid_limit";
		this.status = 400;
	}
}

/**
 * Validate a caller-supplied `limit`. Absent is fine. Anything present that is
 * not a whole number in range is refused by name — never clamped, because a
 * silent clamp is the same lie in a smaller font.
 */
export function validateRecallLimit(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
		throw new RecallLimitError(`limit must be a whole number between ${RECALL_LIMIT_MIN} and ${RECALL_LIMIT_MAX}.`);
	}
	if (value < RECALL_LIMIT_MIN || value > RECALL_LIMIT_MAX) {
		throw new RecallLimitError(
			`limit must be between ${RECALL_LIMIT_MIN} and ${RECALL_LIMIT_MAX} — ${value} is outside what recall will return.`,
		);
	}
	return value;
}

/** Apply the caller's evidence budget to a gate plan. */
function applyRecallLimit(plan, limit, mode) {
	if (!limit || plan.mode === "no_recall") return plan;
	if (mode !== "depth") {
		// Narrowing only: never more than the legacy path would have produced.
		return {
			...plan,
			limit_applied: Math.min(plan.topN, limit),
			limit_requested: limit,
			limit_mode: "narrow",
			topN: Math.min(plan.topN, limit),
			maxContextNodes: Math.min(plan.maxContextNodes, limit),
			maxContextPages: Math.min(plan.maxContextPages, limit),
		};
	}
	const extra = Math.max(0, limit - plan.topN);
	return {
		...plan,
		limit_applied: limit,
		limit_requested: limit,
		limit_mode: "depth",
		topN: limit,
		maxContextNodes: limit,
		maxContextPages: Math.max(plan.maxContextPages, Math.ceil(limit / 2)),
		maxEventsPerNode: plan.maxEventsPerNode,
		eventScanLimit: Math.min(EVENT_SCAN_HARD_MAX, Math.max(plan.eventScanLimit, limit * 20)),
		maxContextChars: Math.min(
			RECALL_CONTEXT_CHARS_HARD_MAX,
			plan.maxContextChars + extra * RECALL_CONTEXT_CHARS_PER_ITEM,
		),
	};
}

/**
 * The internal candidate budget for each lane. Derived from the final budget,
 * but capped by constants the caller cannot move — "no unbounded retrieval"
 * has to be true of the lanes, not just of the answer.
 */
function candidateBudget(plan) {
	const topN = Math.max(1, Number(plan.topN) || TOP_N);
	return {
		vectorTopK: Math.min(VECTOR_TOPK_MAX, topN + 6),
		bm25: Math.min(BM25_CANDIDATES_MAX, Math.max(BM25_CANDIDATES_BASE, topN * 2)),
		graphExpansionTotal: Math.min(GRAPH_EXPANSION_MAX, Math.max(GRAPH_EXPANSION_BASE, topN)),
	};
}
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

export class RecallScopeError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RecallScopeError";
		this.code = code;
		this.status = 400;
	}
}

function resolveRecallScope(userId, opts = {}) {
	const recallScope = opts.recallScope ?? "global";
	if (!RECALL_SCOPES.has(recallScope)) {
		throw new RecallScopeError(
			"invalid_recall_scope",
			"recallScope must be global, project_only, or project_then_global",
		);
	}
	const memoryScope = resolveScope(userId, opts.memoryScope ?? opts.scope);
	if (recallScope !== "global" && !memoryScope.project_id) {
		throw new RecallScopeError(
			"project_id_required",
			`memoryScope.projectId is required when recallScope is ${recallScope}`,
		);
	}
	return { recallScope, memoryScope, projectId: memoryScope.project_id };
}

/** Validate recall coverage before a query source packet is persisted. */
export function validateRecallScope(userId, opts = {}) {
	return resolveRecallScope(userId, opts);
}

function projectPredicate(alias, recallScope) {
	if (recallScope === "project_only") return ` AND ${alias}.project_id = ?`;
	if (recallScope === "project_then_global") {
		return ` AND (${alias}.project_id = ? OR ${alias}.project_id IS NULL)`;
	}
	return "";
}

function projectBindings(recallScope, projectId) {
	return recallScope === "global" ? [] : [projectId];
}

/** Anything phrased as a question — the clearest possible request for memory. */
function isQuestion(text) {
	const q = String(text ?? "").trim();
	if (!q) return false;
	return /\?\s*$/.test(q)
		|| /^(?:who|what|when|where|why|which|how|did|do|does|is|are|was|were|can|could|will|would|has|have|had|tell me)\b/i.test(q);
}

/** What the caller asked for and what they actually got, always both. */
function limitReport(plan) {
	return {
		limit_requested: plan.limit_requested ?? null,
		limit_applied: plan.limit_applied ?? null,
		limit_mode: plan.limit_mode ?? null,
		evidence_budget: plan.topN ?? 0,
	};
}

function emptyRecall(plan, extras = {}) {
	return {
		ok: true,
		recall_mode: plan.mode,
		mode: plan.mode,
		reason: plan.reason,
		...limitReport(plan),
		context: "",
		items: [],
		count: 0,
		nodes: [],
		pages: [],
		activated_clusters: [],
		vector_used: false,
		lexical_used: false,
		graph_expansion_used: false,
		hybrid_retrieval_used: false,
		hybrid_assertion_candidates: 0,
		hybrid_parent_candidates: 0,
		hybrid_lane_counts: { lexical: 0, relation: 0, temporal: 0 },
		compressed: false,
		...extras,
	};
}

export function recallGate(query, opts = {}) {
	return applyRecallLimit(baseRecallGate(query, opts), opts.limit ?? null, opts.limitMode ?? "narrow");
}

function baseRecallGate(query, opts = {}) {
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

/**
 * Relational-word → entity resolution (Part 5). "my partner", "my sister",
 * "my manager" name people the graph knows only by their proper label. Each
 * relation word maps to the edge types and node categories that can hold it,
 * plus a text probe over stored facts ("Amara is my sister"). Deterministic,
 * bounded (≤3 seeds per relation word), zero model calls.
 */
const RELATION_WORDS = {
	partner: { edges: ["MARRIED_TO", "ENGAGED_TO", "DATING", "PARTNER_OF"], categories: ["relationship"] },
	spouse: { edges: ["MARRIED_TO"], categories: ["relationship"] },
	wife: { edges: ["MARRIED_TO"], categories: ["relationship"] },
	husband: { edges: ["MARRIED_TO"], categories: ["relationship"] },
	girlfriend: { edges: ["DATING", "ENGAGED_TO"], categories: ["relationship"] },
	boyfriend: { edges: ["DATING", "ENGAGED_TO"], categories: ["relationship"] },
	sister: { edges: ["SIBLING_OF"], categories: ["family"] },
	brother: { edges: ["SIBLING_OF"], categories: ["family"] },
	mother: { edges: ["PARENT_OF", "CHILD_OF"], categories: ["family"] },
	father: { edges: ["PARENT_OF", "CHILD_OF"], categories: ["family"] },
	cousin: { edges: [], categories: ["family"] },
	aunt: { edges: [], categories: ["family"] },
	uncle: { edges: [], categories: ["family"] },
	grandmother: { edges: [], categories: ["family"] },
	grandfather: { edges: [], categories: ["family"] },
	manager: { edges: ["REPORTS_TO", "MANAGED_BY"], categories: [] },
	boss: { edges: ["REPORTS_TO", "MANAGED_BY"], categories: [] },
	teacher: { edges: ["TEACHES", "TAUGHT_BY"], categories: [] },
};

export function relationalSeeds(query, { nodes, edgeRows, slicesByNode, pastIntent = false } = {}) {
	const queryWords = new Set(tokens(query));
	const seeds = new Set();
	const now = Date.now();
	for (const [word, spec] of Object.entries(RELATION_WORDS)) {
		if (!queryWords.has(word)) continue;
		const found = [];
		// (a) an edge of a matching type names the person directly
		if (spec.edges.length) {
			for (const edge of edgeRows ?? []) {
				if (!spec.edges.includes(String(edge.type))) continue;
				if (!pastIntent && edge.invalid_at != null && Number(edge.invalid_at) <= now) continue;
				found.push(edge.from_node, edge.to_node);
			}
		}
		// (b) a stored fact says so: "<label> is my sister", "my manager is <label>"
		const probe = new RegExp(`\\bmy\\s+${word}\\b|\\bis\\s+my\\s+${word}\\b|\\b${word}\\s+is\\b`, "i");
		for (const node of nodes ?? []) {
			const slices = slicesByNode?.get(node.id) ?? [];
			const corpus = [node.summary, ...slices.map((s) => s.text)].filter(Boolean).join(" ");
			if (probe.test(corpus)) found.push(node.id);
		}
		// (c) category fallback, only when nothing more specific matched
		if (found.length === 0 && spec.categories.length) {
			for (const node of nodes ?? []) {
				if (spec.categories.includes(String(node.category))) found.push(node.id);
			}
		}
		for (const id of found.slice(0, 3)) seeds.add(id);
	}
	return seeds;
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
		const label = entry.type === "node" ? item.label : item.title;
		// A label/title identifies an object only inside its project. Account-wide
		// recall is deliberately allowed to surface the same fact from two
		// projects, so cross-project objects must never dedupe each other.
		const key = JSON.stringify([entry.type, item.project_id ?? null, normalizeLabel(label)]);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

/**
 * Provenance values whose date describes when something HAPPENED. Anything else
 * — including a legacy row's NULL — describes when we were told, which is not
 * an answer to "when did this happen?" and must not be printed as one.
 */
const TRUSTWORTHY_EVENT_DATES = new Set(["extracted", "phrase", "source_time"]);

/**
 * Render one event for the context block, with its date when we actually know it.
 *
 * V3-D04: this used to be `(e) => e.text`. The date was loaded from D1, carried
 * all the way here, and dropped on the last line before the reader saw it — so
 * "When did Jon lose his job as a banker?" was answered from the string "Left
 * job as a banker", which contains no date. Fixing the parser (V3-D03) put the
 * right date in the graph and changed nothing downstream, because nothing
 * downstream ever showed it.
 */
function temporalLabel(event, at) {
	const iso = new Date(at).toISOString().slice(0, 10);
	switch (event?.event_time_precision) {
		case "year": return iso.slice(0, 4);
		case "month": return iso.slice(0, 7);
		case "week": return `week of ${iso}`;
		default: return iso;
	}
}

function eventLine(event) {
	const text = event?.text;
	if (!text) return text;
	if (!TRUSTWORTHY_EVENT_DATES.has(event.happened_at_source)) return text;
	const at = Number(event.happened_at);
	if (!Number.isFinite(at) || at <= 0) return text;
	const date = temporalLabel(event, at);
	const endAt = Number(event?.event_time_end);
	const end = Number.isFinite(endAt) && endAt > at ? temporalLabel(event, endAt) : null;
	const timing = end && event?.event_time_relation === "range" ? `${date} to ${end}` : date;
	// Don't repeat a date the fact already states in words. The extraction prompt
	// asks for the timing to be kept inside the text too, so a lot of facts
	// already carry it and " (2023-01-20)" twice reads as two different claims.
	if (text.includes(date) && (!end || text.includes(end))) return text;
	return `${text} (${timing})`;
}

export function buildContext(entries, plan = recallGate("memory"), staged = [], sourceLines = [], fallbackLines = []) {
	const lines = [];
	let nodeCount = 0;
	let pageCount = 0;
	// 8.2 — just-saved text leads. It is the freshest thing the user told us
	// and the whole point of read-your-writes: the answer, not a promise.
	for (const row of staged.slice(0, 3)) {
		const text = String(row?.text ?? "").replace(/\s+/g, " ").trim();
		if (text) lines.push(`Just saved (still being organized): ${text}`);
	}
	// E9A exact sources follow read-your-writes but precede their lossy semantic
	// summaries. The shared context cap below remains the only final byte budget.
	for (const line of sourceLines) {
		const text = String(line ?? "").replace(/\s+/g, " ").trim();
		if (text) lines.push(text);
	}
	// E9B is lower-confidence than an exact provenance link, but it is still
	// verbatim scrubbed source and should precede lossy semantic summaries when
	// the registered sparse-evidence trigger fires.
	for (const line of fallbackLines) {
		const text = String(line ?? "").replace(/\s+/g, " ").trim();
		if (text) lines.push(text);
	}
	for (const entry of entries) {
		if (entry.type === "node" && nodeCount < plan.maxContextNodes) {
			const n = entry.item;
			let items;
			if (Array.isArray(n.evidence)) {
				// E7: the assertion lane already ordered this node's evidence for
				// the query. The same per-node ceiling remains in force.
				items = n.evidence.map((item) => item.text).filter(Boolean).slice(0, plan.maxLineItems);
			} else {
				const sliceTexts = n.slices.map((s) => s.text);
				const eventTexts = [...n.events].reverse().map(eventLine);
				// Relations lead: an edge fact ("Amara works at Nova Systems") is
				// usually the direct answer, and it is what the edge pass paid for.
				const relationTexts = n.relations ?? [];
				items = [...relationTexts, ...sliceTexts, ...eventTexts].filter(Boolean).slice(0, plan.maxLineItems);
			}
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
	const relationEvidence = [];
	const hybridRelationKeys = new Set((graph?.hybridByNode?.get(node.id) ?? [])
		.filter((candidate) => candidate.kind === "relation")
		.map((candidate) => candidate.key));
	let unrankedRelations = 0;
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
			const key = `edge:${edge.id}`;
			const ranked = hybridRelationKeys.has(key);
			// Legacy behavior retains its first-three cap exactly. E7 scans every
			// relation but carries only ranked hits plus the same three defaults.
			if (graph?.hybridEnabled === true && !ranked && unrankedRelations >= 3) continue;
			const text = closed ? `${base} (until ${new Date(edge.invalid_at).toISOString().slice(0, 10)})` : base;
			relationEvidence.push({ key, kind: "relation", text });
			if (!ranked) unrankedRelations += 1;
			if (graph?.hybridEnabled !== true && relationEvidence.length >= 3) break;
		}
	}
	const slices = slicesByNode.get(node.id) ?? [];
	const events = eventsByNode.get(node.id) ?? [];
	const evidence = graph?.hybridEnabled === true
		? orderNodeEvidence([
			...relationEvidence,
			...slices.filter((slice) => slice?.text).map((slice) => ({ key: `slice:${slice.id}`, kind: "slice", text: slice.text })),
			...events.filter((event) => event?.text).map((event) => ({ key: `event:${event.id}`, kind: "event", text: eventLine(event) })),
		], graph.hybridByNode?.get(node.id) ?? [])
		: null;
	return {
		id: node.id,
		label: node.label,
		category: node.category,
		state: node.state,
		summary: node.summary,
		cluster: node.cluster,
		project_id: node.project_id ?? null,
		project_name: node.project_name ?? null,
		slices,
		events,
		relations: relationEvidence.map((entry) => entry.text),
		...(evidence ? { evidence } : {}),
	};
}

function episodeFallbackTelemetry(enabled, fallback, context = "") {
	if (!enabled) return {};
	const rendered = String(context ?? "")
		.split("\n")
		.filter((line) => line.startsWith("Episode fallback evidence [")).length;
	return {
		episode_fallback_used: true,
		episode_fallback_triggered: fallback.triggered === true,
		episode_fallback_reason: fallback.reason,
		episode_fallback_query_terms: Number(fallback.queryTerms ?? 0),
		episode_fallback_candidates: Number(fallback.candidates ?? 0),
		episode_fallback_eligible: Number(fallback.eligible ?? 0),
		episode_fallback_episodes: Number(fallback.episodes ?? 0),
		episode_fallback_rendered: rendered,
		episode_fallback_assembly_dropped: Math.max(0, Number(fallback.episodes ?? 0) - rendered),
		episode_fallback_duplicate_episodes: Number(fallback.duplicateEpisodes ?? 0),
		episode_fallback_chars: Number(fallback.chars ?? 0),
		episode_fallback_ms: Number(fallback.latencyMs ?? 0),
		episode_fallback_failed: fallback.failed === true,
	};
}

function adaptiveContextTelemetry(enabled, compiled) {
	if (!enabled || !compiled?.telemetry) return {};
	const row = compiled.telemetry;
	return {
		adaptive_context_used: true,
		adaptive_context_profile: row.profile,
		adaptive_context_max_assertions_per_node: Number(row.maxAssertionsPerNode ?? 0),
		adaptive_context_max_chars: Number(row.maxContextChars ?? 0),
		adaptive_context_selected_entries: Number(row.selectedEntries ?? 0),
		adaptive_context_available_assertions: Number(row.availableAssertions ?? 0),
		adaptive_context_profile_selected_assertions: Number(row.profileSelectedAssertions ?? 0),
		adaptive_context_intentional_assertion_omissions: Number(row.intentionalAssertionOmissions ?? 0),
		adaptive_context_exact_duplicates_removed: Number(row.exactDuplicatesRemoved ?? 0),
		adaptive_context_selected_sources: Number(row.selectedSources ?? 0),
		adaptive_context_rendered_entries: Number(row.renderedEntries ?? 0),
		adaptive_context_rendered_assertions: Number(row.renderedAssertions ?? 0),
		adaptive_context_rendered_sources: Number(row.renderedSources ?? 0),
		adaptive_context_hard_cap_dropped_entries: Number(row.hardCapDroppedEntries ?? 0),
		adaptive_context_hard_cap_dropped_assertions: Number(row.hardCapDroppedAssertions ?? 0),
		adaptive_context_hard_cap_dropped_sources: Number(row.hardCapDroppedSources ?? 0),
		adaptive_context_clipped_assertions: Number(row.clippedAssertions ?? 0),
		adaptive_context_lines: Number(row.contextLines ?? 0),
		adaptive_context_chars: Number(row.contextChars ?? 0),
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
		project_id: page.project_id ?? null,
		project_name: page.project_name ?? null,
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
			project_id: entry.item.project_id ?? null,
			project_name: entry.item.project_name ?? null,
			score: Number(entry.score.toFixed(4)),
		};
	}
	return {
		type: "page",
		id: entry.item.id,
		title: entry.item.title,
		cluster: entry.item.cluster ?? entry.item.topic_filter ?? null,
		project_id: entry.item.project_id ?? null,
		project_name: entry.item.project_name ?? null,
		score: Number(entry.score.toFixed(4)),
	};
}

async function internalReadTrace(candidateIds, selectedIds, context, extras = {}) {
	const bytes = new TextEncoder().encode(String(context ?? ""));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const contextHash = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return {
		schema: "itsuki.internal-read-trace/v1",
		candidate_ids: candidateIds,
		selected_ids: selectedIds,
		context_bytes: bytes.byteLength,
		context_sha256: contextHash,
		...extras,
	};
}

/**
 * Startup context for a project: what this project holds, ranked by salience
 * and recency. Deterministic and model-free — no embedding call, no query
 * matching, no gate. Scope is enforced exactly as everywhere else, so a
 * bootstrap can never borrow another project's memory (I5).
 *
 * Project rows lead. Under project_then_global the account's global memory
 * shares this bounded context, and it is often much hotter — live reproduction
 * showed ten global nodes displacing a project's only node, so a session opened
 * in that project would have shown everything EXCEPT the project. Global memory
 * is supporting material here, never the headline.
 */
async function projectBootstrapRecall(env, userId, opts = {}) {
	const { recallScope, projectId } = resolveRecallScope(userId, opts);
	const bindings = projectBindings(recallScope, projectId);
	const plan = {
		...recallGate("project memory", { limit: opts.limit ?? null, limitMode: opts.limitMode ?? "narrow" }),
		mode: "project_bootstrap",
		reason: "session_start_lookup",
	};
	try {
		const [nodesRes, pagesRes, slicesRes, eventsRes] = await env.DB.batch([
			env.DB.prepare(
				`SELECT n.id, n.label, n.category, n.state, n.summary, n.aliases_json, n.updated_at,
					n.last_seen_at, n.heat_score, n.cluster, n.project_id, n.project_name
				 FROM nodes n
				 WHERE n.user_id = ? AND n.deleted_at IS NULL AND n.archived_at IS NULL AND n.suppressed_at IS NULL${projectPredicate("n", recallScope)}
				 ORDER BY CASE WHEN n.project_id IS NULL THEN 1 ELSE 0 END ASC,
					COALESCE(n.heat_score, 1) DESC, COALESCE(n.updated_at, n.last_seen_at, 0) DESC
				 LIMIT ?`,
			).bind(userId, ...bindings, plan.maxContextNodes),
			env.DB.prepare(
				`SELECT p.id, p.title, p.topic_filter, p.short_summary, p.key_points_json, p.decisions_json,
					p.next_steps_json, p.related_concepts_json, p.updated_at, p.heat_score, p.source_mode,
					p.cluster, p.project_id, p.project_name
				 FROM memory_pages p
				 WHERE p.user_id = ? AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.suppressed_at IS NULL${projectPredicate("p", recallScope)}
				 ORDER BY CASE WHEN p.project_id IS NULL THEN 1 ELSE 0 END ASC,
					COALESCE(p.heat_score, 1) DESC, COALESCE(p.updated_at, 0) DESC
				 LIMIT ?`,
			).bind(userId, ...bindings, plan.maxContextPages),
			env.DB.prepare(
				`SELECT s.id, s.node_id, s.text, s.kind, s.created_at, s.project_id, s.project_name
				 FROM slices s
				 WHERE s.user_id = ? AND s.is_current = 1 AND s.deleted_at IS NULL${projectPredicate("s", recallScope)}`,
			).bind(userId, ...bindings),
			env.DB.prepare(
				`SELECT e.id, e.node_id, e.action, e.text, e.importance, e.happened_at, e.happened_at_source,
					e.event_time_end, e.event_time_precision, e.event_time_relation, e.created_at,
					e.project_id, e.project_name
				 FROM events e
				 WHERE e.user_id = ? AND e.deleted_at IS NULL${projectPredicate("e", recallScope)}
				 ORDER BY e.created_at DESC LIMIT ?`,
			).bind(userId, ...bindings, plan.eventScanLimit),
		]);

		const nodes = nodesRes.results ?? [];
		const pages = pagesRes.results ?? [];
		if (!nodes.length && !pages.length) return emptyRecall(plan);

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

		const entries = [
			...nodes.map((node) => ({
				type: "node",
				item: {
					...node,
					slices: slicesByNode.get(node.id) ?? [],
					events: eventsByNode.get(node.id) ?? [],
					relations: [],
				},
			})),
			...pages.map((page) => ({
				type: "page",
				item: { ...page, key_points: parseJsonArray(page.key_points_json) },
			})),
		];
		const context = buildContext(entries, plan);
		return {
			...emptyRecall(plan),
			context,
			count: entries.length,
			nodes: nodes.map((n) => ({ id: n.id, label: n.label, category: n.category })),
			pages: pages.map((p) => ({ id: p.id, title: p.title })),
			compressed: Boolean(context),
		};
	} catch (error) {
		// Startup context is a convenience: never fail a session over it.
		console.warn("project bootstrap recall failed:", error?.message ?? error);
		return emptyRecall(plan);
	}
}

export async function recall(env, config, userId, query, opts = {}) {
	const q = String(query ?? "").trim();
	// REC-01: opening a session is a LOOKUP, not a question. Both plugins used
	// to send a fixed sentence ("project decisions, conventions, architecture,
	// and fixes for X") and hope similarity found something — but scoped recall
	// deliberately skips BM25 (search profiles carry no project column), so
	// ordinary project memory, which shares no words with that sentence,
	// matched nothing and the user was told their project had no memory.
	// Mem0 separates get_all(filters) from search(query); Zep/Graphiti expose
	// get_episodes alongside graph search, for exactly this reason.
	const bootstrap = String(opts.recallMode ?? "").trim() === "project_bootstrap";
	if (bootstrap) return projectBootstrapRecall(env, userId, opts);
	const plan = recallGate(q, opts);
	const budget = candidateBudget(plan);
	const { recallScope, projectId } = resolveRecallScope(userId, opts);
	const hybridEnabled = memoryV3HybridRetrievalEnabled(env, userId);
	const sourceExpansionEnabled = memoryV3SourceExpansionEnabled(env, userId);
	const episodeFallbackEnabled = memoryV3EpisodeFallbackEnabled(env, userId);
	const adaptiveContextEnabled = memoryV3AdaptiveContextEnabled(env, userId);
	const adaptivePlan = adaptiveContextEnabled ? adaptiveContextPlan(q, plan) : null;
	if (plan.mode === "no_recall") return emptyRecall(plan);
	const filteredByProject = recallScope !== "global";
	const bindings = projectBindings(recallScope, projectId);

	// V3-D13: an output LIMIT is not a candidate bound if the full tenant graph
	// has already crossed the D1 -> Worker boundary. E7 therefore shortlists in
	// D1 and hydrates a capped evidence closure. The legacy path remains byte-
	// stable for accounts outside the nested E7 flag.
	let boundedCorpus = null;
	let precomputedVectorMatches = null;
	if (hybridEnabled) {
		if (!filteredByProject) {
			const vector = await embed(env, config, q);
			precomputedVectorMatches = await queryNodeVectors(env, config, {
				userId,
				values: vector,
				topK: budget.vectorTopK,
			});
		}
		boundedCorpus = await loadBoundedV3RecallCorpus(env, userId, q, {
			recallScope,
			projectId,
			candidateLimit: budget.bm25,
			vectorNodeIds: (precomputedVectorMatches ?? []).map((match) => match.id),
			temporalIntent: hybridTemporalIntent(q),
			pastIntent: PAST_INTENT_RE.test(q),
		});
	}

	let nodesRes;
	let pagesRes;
	let slicesRes;
	let eventsRes;
	let edgesRes;
	let profileRes;
	if (boundedCorpus) {
		nodesRes = { results: boundedCorpus.nodes };
		pagesRes = { results: boundedCorpus.pages };
		slicesRes = { results: boundedCorpus.slices };
		eventsRes = { results: boundedCorpus.events };
		edgesRes = { results: boundedCorpus.edges };
		profileRes = { results: boundedCorpus.profile };
	} else {
		[nodesRes, pagesRes, slicesRes, eventsRes, edgesRes, profileRes] = await env.DB.batch([
			env.DB.prepare(
				`SELECT n.id, n.label, n.category, n.state, n.summary, n.aliases_json, n.updated_at, n.last_seen_at,
					 n.heat_score, n.cluster, n.project_id, n.project_name
				 FROM nodes n
				 WHERE n.user_id = ? AND n.deleted_at IS NULL AND n.archived_at IS NULL AND n.suppressed_at IS NULL${projectPredicate("n", recallScope)}`,
			).bind(userId, ...bindings),
			env.DB.prepare(
				`SELECT p.id, p.title, p.topic_filter, p.short_summary, p.key_points_json, p.decisions_json,
					 p.next_steps_json, p.related_concepts_json, p.updated_at, p.heat_score, p.source_mode, p.cluster,
					 p.project_id, p.project_name
				 FROM memory_pages p
				 WHERE p.user_id = ? AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.suppressed_at IS NULL${projectPredicate("p", recallScope)}`,
			).bind(userId, ...bindings),
			env.DB.prepare(
				`SELECT s.id, s.node_id, s.text, s.kind, s.created_at, s.project_id, s.project_name
				 FROM slices s
				 WHERE s.user_id = ? AND s.is_current = 1 AND s.deleted_at IS NULL${projectPredicate("s", recallScope)}`,
			).bind(userId, ...bindings),
			env.DB.prepare(
				`SELECT e.id, e.node_id, e.action, e.text, e.importance, e.happened_at, e.happened_at_source,
					e.event_time_end, e.event_time_precision, e.event_time_relation, e.created_at,
					e.project_id, e.project_name
				 FROM events e
				 WHERE e.user_id = ? AND e.deleted_at IS NULL${projectPredicate("e", recallScope)}
				 ORDER BY e.created_at DESC LIMIT ?`,
			).bind(userId, ...bindings, plan.eventScanLimit),
			env.DB.prepare(
				`SELECT e.id, e.from_node, e.to_node, e.type, e.weight, e.reinforcement_count, e.fact,
					e.valid_at, e.invalid_at, e.project_id, e.project_name
				 FROM edges e WHERE e.user_id = ? AND e.deleted_at IS NULL${projectPredicate("e", recallScope)}`,
			).bind(userId, ...bindings),
			// memory_profiles is account-wide and has no project attribution. It may
			// nudge account-wide results, but cannot safely influence a filtered rank.
			env.DB.prepare("SELECT * FROM memory_profiles WHERE user_id = ? AND ? = 'global'").bind(userId, recallScope),
		]);
	}

	const nodes = nodesRes.results ?? [];
	const pages = pagesRes.results ?? [];
	const profile = profileRes.results?.[0] ?? null;

	// 8.2 read-your-writes: text accepted moments ago, before its enrichment
	// landed. Consulted BEFORE the empty-graph exit — the very first save on a
	// new account is exactly the case that must not answer "I know nothing".
	const stagedRows = await findStagedText(env, userId, tokens(q), { recallScope, projectId });

	if ((nodes.length === 0 && pages.length === 0) || q.length === 0) {
		const fallback = episodeFallbackEnabled && q.length > 0
			? await findEpisodeFallbackEvidence(env, userId, q, {
				entries: [],
				sourceExpansion: {},
				recallScope,
				projectId,
			})
			: emptyEpisodeFallbackResult();
		if ((stagedRows.length || fallback.lines.length) && q.length > 0) {
			const compiled = adaptiveContextEnabled
				? compileAdaptiveContext(q, { entries: [], plan, staged: stagedRows, fallbackLines: fallback.lines })
				: null;
			const context = compiled?.context ?? buildContext([], plan, stagedRows, [], fallback.lines);
			const internalTrace = opts.internalTrace === true && episodeFallbackEnabled
				? await internalReadTrace(
					[],
					[
						...stagedRows.map((row) => `staged:${row.id}`),
						...fallback.episodeIds.map((id) => `episode-fallback:${id}`),
					],
					context,
					{
						episode_fallback_episode_ids: fallback.episodeIds,
						episode_fallback_failed: fallback.failed,
					},
				)
				: null;
			return {
				...emptyRecall(plan),
				context,
				count: stagedRows.length,
				staged_used: stagedRows.length > 0,
				staged_count: stagedRows.length,
				compressed: Boolean(context),
				...episodeFallbackTelemetry(episodeFallbackEnabled, fallback, context),
				...adaptiveContextTelemetry(adaptiveContextEnabled, compiled),
				...(internalTrace ? { internal_trace: internalTrace } : {}),
			};
		}
		const compiled = adaptiveContextEnabled ? compileAdaptiveContext(q, { entries: [], plan }) : null;
		const empty = emptyRecall(plan, adaptiveContextTelemetry(adaptiveContextEnabled, compiled));
		return episodeFallbackEnabled
			? { ...empty, ...episodeFallbackTelemetry(true, fallback, "") }
			: empty;
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
	let bm25Rank = boundedCorpus?.bm25Rank ?? [];
	// Search profiles have no project column. Post-filtering a globally limited
	// list would let another project starve the requested one, so scoped recall
	// uses the already-filtered exact/keyword scan instead.
	if (!boundedCorpus && !filteredByProject) {
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
					 LIMIT ?`,
				).bind(ftsMatch, userId, budget.bm25).all();
				bm25Rank = (results ?? [])
					.filter((r) => (r.object_kind === "node" ? byId.has(r.object_id) : pageById.has(r.object_id)))
					.map((r) => ({ key: `${r.object_kind}:${r.object_id}` }));
			}
		} catch (err) {
			console.warn("bm25 recall signal failed:", err?.message ?? err);
		}
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
	let vectorRank = [];
	// Existing vectors are namespaced per account but carry no project metadata.
	// Disable this signal for filtered modes instead of post-filtering a top-K
	// result that another project can fill before the requested project is seen.
	if (!filteredByProject) {
		const matches = precomputedVectorMatches ?? await (async () => {
			const vector = await embed(env, config, q);
			return queryNodeVectors(env, config, { userId, values: vector, topK: budget.vectorTopK });
		})();
		vectorRank = matches.filter((m) => byId.has(m.id)).map((m) => ({ key: `node:${m.id}` }));
	}

	// ---- signal 4: graph expansion (fix round 1, Part 5) ---------------------
	// Walk edges out from the seeds the other signals matched — the only way a
	// multi-hop question ("who works at the company I mentioned?") reaches an
	// answer whose own text shares nothing with the query. Two hops over
	// ACTIVE validity windows only (valid_at <= now < invalid_at), ≤10
	// neighbours per seed, ≤50 added total, hop-2 at half weight so nearer
	// context outranks farther. Closed windows stay invisible unless the
	// question is about the past. Recall stays zero LLM calls.
	const seedIds = new Set();
	for (const list of [exactRank, lexicalRank, vectorRank]) {
		for (const entry of list.slice(0, 6)) {
			if (entry.key.startsWith("node:")) seedIds.add(entry.key.slice(5));
		}
	}
	// Relational words resolve to entities: "my partner/sister/manager" names
	// a PERSON the graph knows by label, alias, edge type, or a stored fact
	// ("Amara is my sister") — without this, the one natural way to ask about
	// your own people contributed zero seeds (trace 0.2, finding 4).
	for (const id of relationalSeeds(q, { nodes, edgeRows, slicesByNode, pastIntent })) {
		seedIds.add(id);
	}
	const now = Date.now();
	const edgeActive = (edge) =>
		(pastIntent || edge.invalid_at == null || Number(edge.invalid_at) > now)
		&& (edge.valid_at == null || Number(edge.valid_at) <= now);
	const MAX_NEIGHBOURS_PER_SEED = 10;
	const MAX_EXPANSION_TOTAL = budget.graphExpansionTotal;
	const graphRank = [];
	const expanded = new Map(); // node id -> hop
	let frontier = new Set(seedIds);
	for (let hop = 1; hop <= 2 && graphRank.length < MAX_EXPANSION_TOTAL; hop++) {
		const perSeed = new Map();
		const nextFrontier = new Set();
		for (const edge of edgeRows) {
			if (graphRank.length >= MAX_EXPANSION_TOTAL) break;
			if (!edgeActive(edge)) continue;
			const fromSeed = frontier.has(edge.from_node);
			const toSeed = frontier.has(edge.to_node);
			if (!fromSeed && !toSeed) continue;
			const seed = fromSeed ? edge.from_node : edge.to_node;
			const other = fromSeed ? edge.to_node : edge.from_node;
			if (!byId.has(other) || seedIds.has(other) || expanded.has(other)) continue;
			const used = perSeed.get(seed) ?? 0;
			if (used >= MAX_NEIGHBOURS_PER_SEED) continue;
			perSeed.set(seed, used + 1);
			expanded.set(other, hop);
			nextFrontier.add(other);
			const base = Number(edge.weight ?? 1) + Number(edge.reinforcement_count ?? 0) * 0.1;
			graphRank.push({ key: `node:${other}`, w: base * (hop === 1 ? 1 : 0.5), hop });
		}
		frontier = nextFrontier;
	}
	// Hop decay lands through rank order: nearer, heavier neighbours first.
	graphRank.sort((a, b) => b.w - a.w);

	// ---- E7: assertion-level lexical / relation / temporal fusion ----------
	// Every row was already tenant/project/deletion filtered in SQL above. The
	// lane is independently bounded and contributes only parent-node ranks; the
	// corresponding assertion ordering is carried to nodeItem so a fifth fact
	// cannot disappear after its node has been selected.
	const hybrid = hybridEnabled
		? rankHybridAssertions(q, {
			nodes,
			slices: slicesRes.results ?? [],
			events: eventsRes.results ?? [],
			edges: edgeRows.filter(edgeActive),
		}, { candidateLimit: budget.bm25 })
		: { candidates: [], byNode: new Map(), nodeRanks: [], laneCounts: { lexical: 0, relation: 0, temporal: 0 } };

	const lexicalUsed = exactRank.length > 0 || lexicalRank.length > 0;
	const vectorUsed = vectorRank.length > 0;
	const graphExpansionUsed = graphRank.length > 0;

	// ---- RRF fusion ----------------------------------------------------------
	const RRF_K = 60;
	const fused = new Map();
	for (const list of [exactRank, lexicalRank, vectorRank, graphRank, hybrid.nodeRanks]) {
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

	if (fused.size === 0) {
		// Nothing in the graph matched — but freshly staged text might.
		const fallback = episodeFallbackEnabled
			? await findEpisodeFallbackEvidence(env, userId, q, {
				entries: [],
				sourceExpansion: {},
				recallScope,
				projectId,
			})
			: emptyEpisodeFallbackResult();
		if (stagedRows.length || fallback.lines.length) {
			const compiled = adaptiveContextEnabled
				? compileAdaptiveContext(q, { entries: [], plan, staged: stagedRows, fallbackLines: fallback.lines })
				: null;
			const context = compiled?.context ?? buildContext([], plan, stagedRows, [], fallback.lines);
			const internalTrace = opts.internalTrace === true && episodeFallbackEnabled
				? await internalReadTrace(
					[],
					[
						...stagedRows.map((row) => `staged:${row.id}`),
						...fallback.episodeIds.map((id) => `episode-fallback:${id}`),
					],
					context,
					{
						episode_fallback_episode_ids: fallback.episodeIds,
						episode_fallback_failed: fallback.failed,
					},
				)
				: null;
			return {
				...emptyRecall(plan, { lexical_used: lexicalUsed, vector_used: vectorUsed }),
				context,
				count: stagedRows.length,
				staged_used: stagedRows.length > 0,
				staged_count: stagedRows.length,
				compressed: Boolean(context),
				...episodeFallbackTelemetry(episodeFallbackEnabled, fallback, context),
				...adaptiveContextTelemetry(adaptiveContextEnabled, compiled),
				...(internalTrace ? { internal_trace: internalTrace } : {}),
			};
		}
		const compiled = adaptiveContextEnabled ? compileAdaptiveContext(q, { entries: [], plan }) : null;
		const empty = emptyRecall(plan, {
			lexical_used: lexicalUsed,
			vector_used: vectorUsed,
			...adaptiveContextTelemetry(adaptiveContextEnabled, compiled),
		});
		return episodeFallbackEnabled
			? { ...empty, ...episodeFallbackTelemetry(true, fallback, "") }
			: empty;
	}

	let entries = [...fused.entries()].map(([key, score]) => {
		const [type, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
		return type === "node"
			? { type, id, score, item: nodeItem(byId.get(id), slicesByNode, eventsByNode, {
				edgeRows,
				byId,
				pastIntent,
				hybridEnabled,
				hybridByNode: hybrid.byNode,
			}) }
			: { type, id, score, item: pageItem(pageById.get(id)) };
	}).filter((entry) => entry.item);
	const traceCandidateIds = opts.internalTrace === true
		? entries.map((entry) => `${entry.type}:${entry.id}`)
		: null;

	const activatedClusters = activateClusters(entries);

	// ---- MMR: five phrasings of one fact return once -------------------------
	entries = mmrSelect(dedupeEntries(entries).sort((a, b) => b.score - a.score), plan.topN);

	// ---- cross-encoder rerank (E8) -------------------------------------------
	// Fusion ranks by how many lanes agreed; it does not know whether an item
	// answers THIS question. At depth that cost a measured 9.96 pp of conditional
	// accuracy. Reranking reorders what MMR already selected — it can never
	// introduce an item, so scope filtering upstream still holds absolutely.
	// Off unless the deployment asks for it; a failure returns the fused order.
	let rerank = { used: false, scored: 0, keep: null, latencyMs: 0 };
	if (opts.rerank === true && entries.length > 1) {
		rerank = await rerankEntries(env, q, entries, {
			keep: Number.isInteger(opts.rerankKeep) && opts.rerankKeep > 0 ? opts.rerankKeep : null,
		});
		entries = rerank.entries;
	}

	const sourceExpansion = sourceExpansionEnabled
		? await expandSelectedSourceEvidence(env, userId, entries, {
			maxLineItems: adaptivePlan?.maxAssertionsPerNode ?? plan.maxLineItems,
			recallScope,
			projectId,
		})
		: {
			lines: [], assertions: 0, linkedAssertions: 0, episodes: 0, chars: 0,
			latencyMs: 0, episodeIds: [], assertionIds: [], failed: false,
		};
	const episodeFallback = episodeFallbackEnabled
		? await findEpisodeFallbackEvidence(env, userId, q, {
			entries,
			sourceExpansion,
			recallScope,
			projectId,
		})
		: emptyEpisodeFallbackResult();
	const resultNodes = entries.filter((entry) => entry.type === "node").map((entry) => entry.item);
	const resultPages = entries.filter((entry) => entry.type === "page").map((entry) => entry.item);
	const compiled = adaptiveContextEnabled
		? compileAdaptiveContext(q, {
			entries,
			plan,
			staged: stagedRows,
			sourceExpansion,
			fallbackLines: episodeFallback.lines,
		})
		: null;
	const context = compiled?.context
		?? buildContext(entries, plan, stagedRows, sourceExpansion.lines, episodeFallback.lines);
	const items = entries.map(itemSummary);
	const hybridCandidateKeys = new Set(hybrid.candidates.map((candidate) => candidate.key));
	const renderedLineItems = adaptivePlan?.maxAssertionsPerNode ?? plan.maxLineItems;
	const hybridOrderedIds = entries
		.filter((entry) => entry.type === "node")
		.flatMap((entry) => (entry.item.evidence ?? []).slice(0, renderedLineItems).map((evidence) => evidence.key))
		.filter((key) => hybridCandidateKeys.has(key));
	const internalTrace = opts.internalTrace === true
		? await internalReadTrace(
			traceCandidateIds,
			[
				...entries.map((entry) => `${entry.type}:${entry.id}`),
				...stagedRows.map((row) => `staged:${row.id}`),
				...episodeFallback.episodeIds.map((id) => `episode-fallback:${id}`),
			],
			context,
			hybridEnabled ? {
				hybrid_assertion_candidate_ids: hybrid.candidates.map((candidate) => candidate.key),
				hybrid_assertion_ordered_ids: hybridOrderedIds,
				...(adaptiveContextEnabled ? {
					adaptive_context_profile_selected_assertion_ids: compiled?.trace?.profileSelectedAssertionIds ?? [],
					adaptive_context_rendered_assertion_ids: compiled?.trace?.renderedAssertionIds ?? [],
					adaptive_context_rendered_entry_ids: compiled?.trace?.renderedEntryIds ?? [],
					adaptive_context_rendered_episode_ids: compiled?.trace?.renderedEpisodeIds ?? [],
				} : {}),
				...(sourceExpansionEnabled ? {
					source_expansion_assertion_ids: sourceExpansion.assertionIds,
					source_expansion_episode_ids: sourceExpansion.episodeIds,
					source_expansion_failed: sourceExpansion.failed,
				} : {}),
				...(episodeFallbackEnabled ? {
					episode_fallback_episode_ids: episodeFallback.episodeIds,
					episode_fallback_failed: episodeFallback.failed,
				} : {}),
			} : {},
		)
		: null;

	return {
		ok: true,
		recall_mode: plan.mode,
		mode: plan.mode,
		reason: plan.reason,
		...limitReport(plan),
		context,
		items,
		count: items.length + stagedRows.length,
		staged_used: stagedRows.length > 0,
		staged_count: stagedRows.length,
		nodes: resultNodes,
		pages: resultPages,
		activated_clusters: activatedClusters,
		vector_used: vectorUsed,
		lexical_used: lexicalUsed,
		graph_expansion_used: graphExpansionUsed,
		hybrid_retrieval_used: hybridEnabled,
		hybrid_assertion_candidates: hybrid.candidates.length,
		hybrid_parent_candidates: hybrid.nodeRanks.length,
		hybrid_lane_counts: hybrid.laneCounts,
		...(boundedCorpus ? {
			bounded_recall_corpus_used: true,
			bounded_recall_query_terms: boundedCorpus.telemetry.queryTerms,
			bounded_recall_lane_counts: boundedCorpus.telemetry.laneCounts,
			bounded_recall_corpus_counts: boundedCorpus.telemetry.corpusCounts,
			bounded_recall_failures: boundedCorpus.telemetry.failures.length,
		} : {}),
		...(sourceExpansionEnabled ? {
			source_expansion_used: true,
			source_expansion_assertions: sourceExpansion.assertions,
			source_expansion_linked_assertions: sourceExpansion.linkedAssertions,
			source_expansion_episodes: sourceExpansion.episodes,
			source_expansion_chars: sourceExpansion.chars,
			source_expansion_ms: sourceExpansion.latencyMs,
			source_expansion_failed: sourceExpansion.failed,
		} : {}),
		...episodeFallbackTelemetry(episodeFallbackEnabled, episodeFallback, context),
		...adaptiveContextTelemetry(adaptiveContextEnabled, compiled),
		rerank_used: rerank.used,
		rerank_scored: rerank.scored,
		rerank_keep: rerank.keep,
		rerank_ms: rerank.latencyMs,
		compressed: Boolean(context),
		...(internalTrace ? { internal_trace: internalTrace } : {}),
	};
}
