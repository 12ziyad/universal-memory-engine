/**
 * The gates: the backend is the real judge. For every object the model proposed,
 * the backend independently decides keep / downgrade / reject. The model never
 * writes final truth — this module turns proposals into an approved write plan.
 *
 * Order of processing matters: nodes first (so events/slices/edges can resolve
 * and attach to nodes created in the same batch), then events, slices, edges,
 * candidates.
 *
 * Worth-saving is judged by category-of-MEANING + junk rules, never by membership
 * in a short whitelist:
 *   - an unknown category is canonicalized (CATEGORY_ALIASES) or kept as "other",
 *     never dropped just for being off-list;
 *   - an event/slice whose subject node the model forgot AUTO-CREATES that node
 *     (anti-orphan), so "my grandmother died" still lands as Grandmother +
 *     passed_away even when the model only emits the event;
 *   - junk is still rejected: pronouns/fillers, status-as-node, duplicates,
 *     low-confidence maybes (parked as candidates), self-loops.
 */

import {
	CATEGORIES,
	CATEGORY_ALIASES,
	ACTIONS,
	IMPORTANCE,
	EDGE_TYPES,
	SLICE_KINDS,
	CANDIDATE_STRENGTHS,
	ACTION_TO_STATE,
} from "../config.js";
import { newId } from "../lib/ids.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import { canonicalKey, getActiveSuppressions, getUserCandidates, getUserEdges, getUserNodes } from "../lib/db.js";
import { normalizeLabel, jaccard, tokens, wordContains, levenshteinRatio } from "../lib/text.js";
import { durablePlanFromText } from "./candidate_rules.js";
import { clusterForMemory } from "./clusters.js";
import { resolveAdmissionRules } from "./admission.js";
import { attributeAssertion, attributesRelated, identityRelatedLabels, obsoletedValues, replacesAttributeValue, significantTerms, supersedesValue } from "./corrections.js";
import { rulesRejection } from "./rules.js";
import { isBadTitle } from "./title.js";

// Slice kinds that hold a single "current" value, so a new one supersedes the old.
// Kinds that are single-valued by nature: a newer "progress" or "preference"
// genuinely replaces the older one. (The old UPDATE_MODE_SUPERSEDE_KINDS set,
// which blanket-retired nearly every kind whenever update language appeared,
// was removed — see SUPERSEDE-01: it destroyed co-existing multi-valued facts.)
const SUPERSEDE_KINDS = new Set(["progress", "preference"]);
// Window for treating a same-action event as a duplicate of an ongoing incident.
const EVENT_DEDUPE_MS = 24 * 60 * 60 * 1000;

// Structural caps on string attributes (engine v2). Oversized values are
// clipped; absurd ones are rejected outright — a 10KB "slice" is tool output,
// not a memory.
const LABEL_CAP = 120;
const TEXT_CAP = 600;
const TEXT_REJECT = 5000;

// v2 relation types where one source holds ONE current target (you work at one
// place, live in one city). A new edge of the same type from the same source
// to a DIFFERENT target closes the old one's validity window — never deletes.
const FUNCTIONAL_RELATIONS = new Set([
	"WORKS_AT", "EMPLOYED_BY", "LIVES_IN", "BASED_IN", "MARRIED_TO",
	"DATING", "ENGAGED_TO", "REPORTS_TO", "MANAGED_BY", "HOSTED_ON",
]);

// SCREAMING_SNAKE_CASE — the v2 edge vocabulary is open but shaped.
const V2_RELATION_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The plugin lens: coding sessions must not memorize paths and tool chatter. */
function looksLikeFilePath(label) {
	const s = String(label ?? "").trim();
	return /^(?:[A-Za-z]:)?[\w.@-]*[\\/][\w.@\\/-]+\.\w{1,8}$/.test(s) || /^(?:src|test|lib|dist|node_modules)[\\/]/.test(s);
}

function looksLikeStackTrace(text) {
	const lines = String(text ?? "").split("\n");
	if (lines.length < 2) return /\bat\s+[\w.$<>]+\s+\(.+:\d+:\d+\)/.test(text) && String(text).length > 120;
	const tracey = lines.filter((l) => /^\s*(at\s+[\w.$<>[\]]+\s*\(?|File "[^"]+", line \d+|Traceback \(most recent)/.test(l)).length;
	return tracey / lines.length >= 0.4;
}

function looksLikeDiff(text) {
	const lines = String(text ?? "").split("\n");
	if (lines.length < 4) return false;
	const diffy = lines.filter((l) => /^[+-][^+-]/.test(l) || /^@@ /.test(l) || /^(diff --git|index [0-9a-f]+\.\.)/.test(l)).length;
	return diffy / lines.length >= 0.3;
}

// When the model emits a life event but forgets its subject node, infer the
// auto-created subject's category from the action (best default, model node wins
// if it also proposed one). "my grandmother passed away" → subject is family.
const ACTION_SUBJECT_CATEGORY = {
	passed_away: "family",
	born: "family",
	married: "relationship",
	broke_up: "relationship",
	diagnosed: "health",
	injured: "health",
	recovered: "health",
	moved: "place",
};

function valid(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

/** Normalize a model-supplied category to a comparable key ("Life-Event" → "life_event"). */
function catKey(s) {
	return String(s ?? "")
		.toLowerCase()
		.trim()
		.replace(/[\s-]+/g, "_");
}

/**
 * Map a model's category onto the canonical set by MEANING. Returns a canonical
 * category, or null if genuinely unrecognizable (caller then keeps "other" — the
 * node is NOT dropped just for an off-list category).
 */
export function canonicalizeCategory(raw) {
	const key = catKey(raw);
	if (!key) return null;
	if (CATEGORIES.includes(key)) return key;
	if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
	// tolerate a trailing plural ("tools" → tool, "relatives" → family)
	if (key.endsWith("s")) {
		const sing = key.slice(0, -1);
		if (CATEGORIES.includes(sing)) return sing;
		if (CATEGORY_ALIASES[sing]) return CATEGORY_ALIASES[sing];
	}
	return null;
}

/** Looks like a status/change phrase, not a durable thing (→ should be an event). */
function looksLikeStatus(label) {
	const first = normalizeLabel(label).split(" ")[0];
	return ACTIONS.includes(first) || ["stopped", "started", "quit", "finished"].includes(first);
}

// Pronouns / fillers a weak model sometimes proposes as nodes ("I train..." → node "I").
const JUNK_LABELS = new Set([
	"i", "me", "my", "mine", "myself", "you", "your", "yours", "it", "its", "this", "that",
	"these", "those", "they", "them", "we", "us", "he", "she", "him", "her", "thing", "things",
	"stuff", "something", "someone", "anything", "everything", "everyone", "people",
]);

/** Reject labels that are pronouns/fillers or too short to be a real entity. */
function isJunkLabel(label) {
	const norm = normalizeLabel(label);
	if (!norm) return true;
	if (norm.replace(/\s+/g, "").length < 2) return true; // "i", single chars, punctuation only
	const words = norm.split(" ").filter(Boolean);
	return words.length > 0 && words.every((w) => JUNK_LABELS.has(w));
}

/**
 * 7.1/7.2 — canonical match, biased to SPLIT. Merge into an existing node only
 * on:
 *   (a) the model's explicit hint (an id from the shortlist it was shown),
 *   (b) exact normalized-name match,
 *   (c) an explicitly stated alias (aliases_json),
 *   (d) high similarity (>=0.85) AND matching category class AND no
 *       conflicting DISTINCTIVE token — for multi-word names, any non-shared
 *       token that isn't a stopword-ish filler kills the merge. Meridian
 *       Freight and Meridian Labs share "Meridian"; "Freight" vs "Labs" are
 *       distinctive, so they NEVER merge, whatever the similarity score says.
 *
 * Uncertain ⇒ new node: wrong-splits are mergeable later; wrong-merges poison
 * summaries and history. Every non-exact merge is recorded (`trace`) so
 * contamination stays auditable on the receipt.
 */
const NON_DISTINCTIVE_TOKENS = new Set([
	"the", "a", "an", "of", "and", "for", "my", "our", "de", "da", "van", "von",
	"class", "classes", "club", "team", "group",
]);

function distinctiveTokens(aTokens, bTokens) {
	const a = new Set(aTokens);
	const b = new Set(bTokens);
	const nonShared = [...a, ...b].filter((t) => !(a.has(t) && b.has(t)));
	return nonShared.filter((t) => t.length >= 3 && !NON_DISTINCTIVE_TOKENS.has(t));
}

function categoryClassOf(category) {
	const canonical = canonicalizeCategory(category) ?? "other";
	if (["person", "family", "relationship"].includes(canonical)) return "person";
	if (canonical === "organization") return "org";
	if (canonical === "place") return "place";
	return canonical;
}

function matchExisting(label, matchesExistingId, existing, existingById, opts = {}) {
	if (matchesExistingId && existingById.has(matchesExistingId)) {
		return existingById.get(matchesExistingId);
	}
	const norm = normalizeLabel(label);
	if (!norm) return null;
	const labelTokens = tokens(label);
	let best = null;
	let bestScore = 0;
	for (const node of existing) {
		const nNorm = normalizeLabel(node.label);
		if (nNorm === norm) return node; // exact
		// explicitly stated alias
		try {
			const aliases = JSON.parse(node.aliases_json || "[]");
			if (Array.isArray(aliases) && aliases.some((a) => normalizeLabel(a) === norm)) {
				opts.trace?.push({ label, into: node.id, into_label: node.label, basis: "alias" });
				return node;
			}
		} catch {}
		const j = jaccard(labelTokens, tokens(node.label));
		const lev = levenshteinRatio(norm, nNorm);
		const score = Math.max(j, lev);
		if (score > bestScore) {
			bestScore = score;
			best = node;
		}
	}
	if (!best || bestScore < 0.85) return null; // bias to split
	if (opts.category !== undefined && opts.category !== null) {
		if (categoryClassOf(opts.category) !== categoryClassOf(best.category)) return null;
	}
	if (distinctiveTokens(labelTokens, tokens(best.label)).length > 0) return null;
	opts.trace?.push({
		label,
		into: best.id,
		into_label: best.label,
		basis: `similarity_${bestScore.toFixed(2)}`,
	});
	return best;
}

async function recentEventMatch(env, userId, nodeId, action, now, projectId) {
	const row = await env.DB.prepare(
		`SELECT id FROM events
		 WHERE user_id = ? AND node_id = ? AND project_id IS ?
		   AND action = ? AND created_at >= ? AND deleted_at IS NULL
		 ORDER BY created_at DESC LIMIT 1`,
	)
		.bind(userId, nodeId, projectId, action, now - EVENT_DEDUPE_MS)
		.first();
	return row?.id ?? null;
}

/**
 * 7.3 — same-fact dedup (NOOP). The check is by normalized content on the
 * SAME entity across ALL slice kinds: daily "working on X" must refresh the
 * existing fact, never insert row thirty-one — whatever kind_detail the model
 * felt like using that day. (Supersede handles contradiction; this handles
 * repetition.)
 */
/**
 * Current slices on this node that the incoming correction makes obsolete.
 *
 * Retirement used to be keyed on slice KIND, so a correction the extractor
 * filed under a different kind than the original never retired it and memory
 * kept both values current (SUPERSEDE-01, measured 3/3 stale). Conflict is a
 * property of the VALUE, not the classification: this returns only rows that
 * assert something the correction explicitly marks obsolete, which is what
 * keeps legitimately co-existing facts ("uses D1", "uses Vectorize") alive.
 */
async function conflictingSliceIds(env, userId, nodeId, text, projectId, opts = {}) {
	const namesObsolete = obsoletedValues(text).size > 0
		|| (opts.updateMode === true && obsoletedValues(opts.sourceText).size > 0);
	// The copula, like obsoleting language, may live ONLY in the user's words:
	// extraction mutilated "the cache backend is now Memcached" into the
	// fragment "now Memcached" (measured live), so the attribute change must be
	// readable from the source message too.
	const attrSources = [text, opts.updateMode === true ? opts.sourceText : null].filter(Boolean);
	const attributeChange = opts.updateMode === true && attrSources.some((t) => attributeAssertion(t));
	if (!namesObsolete && !attributeChange) return [];
	// S1: the extractor can split one subject across nodes ("Alnwick" and
	// "Alnwick deploy runner"), so a same-node scan misses the obsolete fact.
	// Widen to identity-related nodes when the correction names an obsolete
	// value — and, since the split was measured intersecting S3 live (the
	// correction's subject landed on a fresh node while "cache backend is
	// Redis" stayed current on the original), when it re-asserts an attribute
	// in update mode: identity-related label + matching multi-token attribute
	// + copula on both sides is the same evidence standard. An unrelated label
	// is never reached (identityRelatedLabels), and the one-token attribute
	// guard keeps "retention" away from "archive retention".
	const nodeIds = [nodeId];
	if ((namesObsolete || attributeChange) && Array.isArray(opts.nodes)) {
		const self = opts.nodes.find((n) => n.id === nodeId);
		if (self?.label) {
			for (const other of opts.nodes) {
				if (other.id === nodeId || !other.label) continue;
				if (identityRelatedLabels(self.label, other.label)) nodeIds.push(other.id);
			}
		}
	}
	const marks = nodeIds.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT id, text, kind, node_id FROM slices
		 WHERE user_id = ? AND node_id IN (${marks}) AND project_id IS ? AND deleted_at IS NULL AND is_current = 1
		 ORDER BY created_at DESC LIMIT 120`,
	).bind(userId, ...nodeIds, projectId).all();
	// Conflict may be stated in the extracted text OR only in what the user
	// wrote: extraction normalizes "now uses CircleCI, not Jenkins" into the
	// clean "X uses CircleCI", which names nothing obsolete.
	const conflictSources = [text, opts.updateMode ? opts.sourceText : null].filter(Boolean);
	return (results ?? [])
		.filter((s) => conflictSources.some((t) => supersedesValue({ text: t }, { text: s.text }))
			|| (attributeChange && attrSources.some((t) => replacesAttributeValue({ text: t }, { text: s.text }))))
		// node_id must travel with the conflict: a cross-node retirement targets
		// the node the OBSOLETE fact lives on, not the correction's node.
		.map((s) => ({ id: s.id, kind: s.kind, node_id: s.node_id }));
}

async function matchingSliceId(env, userId, nodeId, kind, text, projectId) {
	const { results } = await env.DB.prepare(
		`SELECT id, text, kind FROM slices
		 WHERE user_id = ? AND node_id = ? AND project_id IS ? AND deleted_at IS NULL
		 ORDER BY created_at DESC LIMIT 80`,
	)
		.bind(userId, nodeId, projectId)
		.all();
	const norm = normalizeLabel(text);
	return (results ?? []).find((s) => normalizeLabel(s.text) === norm)?.id ?? null;
}

/**
 * User-settings gate (stub, but the hook is real). Drops objects whose category
 * is disabled, or everything when capture is paused. `private` marking is a
 * future hook (no column yet).
 */
export function applyUserSettings(objects, settings) {
	if (settings.paused) return [];
	const disabled = new Set(settings.disabledCategories ?? []);
	if (disabled.size === 0) return objects;
	return objects.filter((o) => {
		if (o.kind === "node" || o.kind === "candidate") return !disabled.has(o.category);
		return true;
	});
}

const DEFAULT_SETTINGS = { paused: false, disabledCategories: [], captureDensity: null };

/**
 * Parse a model-proposed "date" (YYYY-MM-DD, copied from the source text or
 * message timestamps, never invented) into epoch ms. Anything unparseable,
 * pre-1970, or more than 48h in the future is rejected.
 */
function parseProposedDate(value, now) {
	const match = /^s*(d{4})-(d{2})-(d{2})s*$/.exec(String(value ?? ""));
	if (!match) return null;
	const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
	if (!Number.isFinite(ms) || ms < 0 || ms > now + 48 * 60 * 60 * 1000) return null;
	return ms;
}

export async function applyGates(
	env,
	config,
	userId,
	proposal,
	shortlist = [],
	settings = DEFAULT_SETTINGS,
	opts = {},
) {
	const now = Date.now();
	const projectScope = normalizeProjectScope(opts.projectScope ?? opts);
	// Path A (user-commanded save): keep anything durable, drop only obvious junk.
	const manual = Boolean(opts.manual);
	const updateMode = Boolean(opts.updateMode);
	const sourceText = String(opts.sourceText ?? "");

	// 7.4 — no raw batch text on nodes. The chunk's individual messages, each
	// with its index, are the ONLY permissible source for fallback text and
	// candidate evidence. `sourceText` (the concatenation) stays for whole-chunk
	// checks (MCP grounding) and as the last resort when the chunk has one
	// message — it must never again be stored as slice/event/evidence text of a
	// multi-message batch, which is how "ugh the traffic on Avenida" ended up
	// smeared across five nodes and poisoned recall's seed selection.
	const sourceMessages = (opts.sourceMessages ?? [])
		.map((m, idx) => ({
			idx,
			id: m?.id ?? null,
			content: String(m?.content ?? ""),
			tokens: new Set(normalizeLabel(String(m?.content ?? "")).split(" ").filter((t) => t.length > 2)),
		}))
		.filter((m) => m.tokens.size > 0);

	/** Best single message for a piece of text, by token overlap. */
	function bestMessageFor(text) {
		const wanted = normalizeLabel(String(text ?? "")).split(" ").filter((t) => t.length > 2);
		if (!wanted.length || !sourceMessages.length) return null;
		let best = null;
		let bestScore = 0;
		for (const m of sourceMessages) {
			let score = 0;
			for (const t of wanted) if (m.tokens.has(t)) score++;
			if (score > bestScore) { bestScore = score; best = m; }
		}
		return best ? { ...best, coverage: bestScore / wanted.length } : null;
	}

	/** Per-message evidence for an object — never the concatenated chunk. */
	function messageEvidenceFor(obj) {
		const basis = [obj?.text, obj?.label, obj?.on].filter(Boolean).join(" ");
		const match = bestMessageFor(basis);
		if (match) return match.content;
		if (sourceMessages.length === 1) return sourceMessages[0].content;
		return sourceMessages.length ? "" : sourceText;
	}
	// SUPERSEDE-01: update mode used to blanket-retire EVERY slice of these
	// kinds on the node, which measurably destroyed legitimate multi-valued
	// memory — "uses D1 for storage" went non-current the moment "actually uses
	// Vectorize now" arrived. Retirement in update mode is now decided per-fact
	// by conflict detection (named obsolete value, or a same-attribute copula
	// change); the narrow always-single-valued kinds keep their original rule.
	const supersedeKinds = SUPERSEDE_KINDS;
	// Dense capture keeps every durable detail: the auto-lane floor drops to the
	// manual (lenient) floor. Standard stays exactly as before.
	const dense = (settings?.captureDensity ?? null) === "dense";
	let confMin = manual || dense ? config.manualConfidenceMin : config.confidenceMin;
	// MCP saves are user-commanded but host-mediated — the host model may have
	// rewritten what "the user said". They keep manual flush semantics but not
	// manual leniency: one notch stricter, on the auto-lane floor.
	if (opts.profile === "mcp") confMin = config.mcpConfidenceMin;

	const plan = {
		projectScope,
		newNodes: [],
		nodeStateUpdates: [],
		nodeTouches: new Set(),
		sliceSupersede: [],
		newSlices: [],
		sliceTouches: [],
		newEvents: [],
		eventTouches: [],
		newEdges: [],
		edgeTouches: [],
		// Bi-temporal supersede: existing edge ids whose validity window closes
		// in this write. Rows are never deleted — old truth stays queryable.
		edgeClosures: [],
		newCandidates: [],
		candidateBumps: [],
		affectedNodeIds: new Set(),
		autoCreated: [], // labels of nodes synthesized by the anti-orphan rule
		merges: [], // 7.2 audit: every non-exact merge, with its basis
		rejected: [],
	};

	let objects = applyUserSettings(proposal.objects ?? [], settings);
	if (!settings?.paused && objects.length === 0) {
		// 7.4: probe each message individually; the concatenation is not a
		// sentence and must never become one.
		const durable = sourceMessages.length
			? sourceMessages.map((m) => durablePlanFromText(m.content)).find(Boolean)
			: durablePlanFromText(sourceText);
		if (durable) {
			objects = applyUserSettings([{
				kind: "candidate",
				label: durable.label,
				category: durable.category,
				strength: "strong",
				confidence: durable.confidence,
				reason: durable.reason,
			}], settings);
		}
	}

	// Per-user memory rules (includes/excludes) — deterministic enforcement for
	// every auto-lane save, whatever the model proposed.
	const rules = await resolveAdmissionRules(env, userId, opts.rules);
	// Per-user density preference (Settings → exhaustive) lowers the floor too;
	// a per-request setting always wins when present.
	if (!manual && (settings?.captureDensity ?? null) === null && rules.captureDensity === "dense") {
		confMin = config.manualConfidenceMin;
	}
	// Instructions can carry deny terms too ("never save anything about X"), so
	// this gate runs whenever the user has written any rule at all.
	if (rules.includes?.length || rules.excludes?.length || rules.customInstructions) {
		objects = objects.filter((obj) => {
			const reason = rulesRejection(rules, obj?.text, obj?.label, obj?.on, obj?.from, obj?.to);
			if (!reason) return true;
			plan.rejected.push({ kind: obj?.kind ?? "object", label: obj?.label ?? obj?.on ?? null, reason });
			return false;
		});
	}
	const companionRefs = new Set();
	const edgeRefs = new Set();
	for (const obj of objects) {
		if ((obj.kind === "event" || obj.kind === "slice") && obj.on) companionRefs.add(normalizeLabel(obj.on));
		if (obj.kind === "edge") {
			if (obj.from) edgeRefs.add(normalizeLabel(obj.from));
			if (obj.to) edgeRefs.add(normalizeLabel(obj.to));
		}
	}
	const hasCompanionObject = (label) => {
		const norm = normalizeLabel(label);
		return companionRefs.has(norm) || edgeRefs.has(norm);
	};

	const writeScope = { projectId: projectScope.projectId };
	const existing = await getUserNodes(env, userId, writeScope);
	const existingById = new Map(existing.map((n) => [n.id, n]));
	// S1: labels for identity-related conflict scanning. Includes nodes created
	// earlier in THIS batch, since the extractor can split one subject within a
	// single extraction.
	const nodeIdentityList = () => [
		...existing.map((n) => ({ id: n.id, label: n.label })),
		...plan.newNodes.map((n) => ({ id: n.id, label: n.label })),
	];
	const nodeLabel = (id) => existingById.get(id)?.label ?? plan.newNodes.find((n) => n.id === id)?.label ?? null;
	// The assertion carried by an edge with no fact text: its triple, resolved
	// from authoritative graph data only (endpoint labels + relation type).
	// Null when an endpoint cannot be resolved — such an edge asserts nothing
	// checkable and must never be closed on a guess.
	const edgeTripleText = (e) => {
		const fromLabel = nodeLabel(e.from_node);
		const toLabel = nodeLabel(e.to_node);
		return fromLabel && toLabel ? `${fromLabel} ${e.type} ${toLabel}` : null;
	};
	// S3 via edges: a copula re-assertion ("the cache backend is now
	// Memcached") declares its attribute single-valued, and the OLD value can
	// live as a value-bearing RELATION rather than a slice (measured live:
	// "cache backend --uses--> redis" and "The cache backend is Redis" both
	// stayed current beside Memcached). Close such relations under the same
	// evidence standard as the slice widening: update mode + copula in the
	// extract or the user's words + attribute-related from-label (multi-token,
	// so a generic "Engine" is never enough) + a target that does not restate
	// the new value. Only the measured value-bearing types are eligible —
	// structural relations (part_of, depends_on, …) are never touched.
	const VALUE_BEARING_EDGE_TYPES = new Set(["IS", "USES", "uses"]);
	const attributeEdgeClosures = (text) => {
		if (updateMode !== true) return;
		const attrSources = [text, sourceText].filter(Boolean);
		const assertion = attrSources.map(attributeAssertion).find(Boolean);
		if (!assertion) return;
		const newValueTerms = new Set(assertion.value.split(" ").filter(Boolean));
		for (const e of existingEdges) {
			if (e.invalid_at || e.deleted_at) continue;
			// A fact-bearing relation is scoreable AS TEXT, whatever its
			// model-chosen type (the open SCREAMING vocabulary means no type
			// list can cover it — measured live: "The cache backend is Redis"
			// survived as CONFIGURED_AS-class while its fact-null twin closed).
			// Same double-copula standard as slices: both sides must parse as
			// attribute assertions on a related attribute, values differing.
			if (typeof e.fact === "string" && e.fact.trim() !== "") {
				if (attrSources.some((t) => replacesAttributeValue({ text: t }, { text: e.fact }))) {
					plan.edgeClosures.push({ id: e.id, invalid_at: now });
				}
				continue;
			}
			// Fact-null: the triple is the assertion — measured value-bearing
			// types only, structural relations are never touched.
			if (!VALUE_BEARING_EDGE_TYPES.has(e.type)) continue;
			const fromLabel = nodeLabel(e.from_node);
			const toLabel = nodeLabel(e.to_node);
			if (!fromLabel || !toLabel) continue;
			if (!attributesRelated(assertion.attribute, significantTerms(fromLabel).join(" "))) continue;
			const targetTerms = significantTerms(toLabel);
			// Any overlap with the asserted new value means this relation may be
			// restating the new truth — conservative: leave it current.
			if (!targetTerms.length || targetTerms.some((t) => newValueTerms.has(t))) continue;
			plan.edgeClosures.push({ id: e.id, invalid_at: now });
		}
	};
	const candidates = await getUserCandidates(env, userId, writeScope);
	const candidateByLabel = new Map(candidates.map((c) => [normalizeLabel(c.label), c]));
	const existingEdges = await getUserEdges(env, userId, writeScope);
	const suppressions = await getActiveSuppressions(env, userId, writeScope);
	const suppressionByKindKey = new Set(suppressions.map((s) => `${s.kind}:${s.canonical_key}`));

	// label(normalized) -> resolved node id, including nodes created in this batch.
	const resolved = new Map();
	const reject = (o, reason) => plan.rejected.push({ kind: o.kind, label: o.label ?? o.on ?? o.from, reason });
	const isSuppressed = (kind, label) => suppressionByKindKey.has(`${kind}:${canonicalKey(label)}`);

	/** Create a brand-new node and make it resolvable for the rest of this batch. */
	function createNode(label, category, role = null, state = null, auto = false) {
		const id = newId("node");
		const canonicalCategory = canonicalizeCategory(category) ?? "other";
		plan.newNodes.push({
			id,
			user_id: userId,
			label,
			canonical_label: normalizeLabel(label),
			category: canonicalCategory,
			role: role ?? null,
			state: valid(state, ["active", "paused", "inactive", "completed"], "active"),
			summary: null,
			created_at: now,
			updated_at: now,
			last_seen_at: now,
			mention_count: 1,
			session_count: 1,
			heat_score: 1,
			cluster: clusterForMemory({ label, category: canonicalCategory }),
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
		});
		resolved.set(normalizeLabel(label), id);
		const created = {
			id,
			label,
			category: canonicalCategory,
			state: "active",
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
		};
		existing.push(created);
		existingById.set(id, created);
		plan.affectedNodeIds.add(id);
		if (auto) plan.autoCreated.push(label);
		return id;
	}

	function resolveRef(ref) {
		if (!ref) return null;
		const norm = normalizeLabel(ref);
		if (resolved.has(norm)) return { id: resolved.get(norm) };
		const match = matchExisting(ref, null, existing, existingById, { trace: plan.merges });
		if (match) {
			resolved.set(norm, match.id);
			return { id: match.id };
		}
		return null;
	}

	/**
	 * Resolve a subject reference, or AUTO-CREATE a minimal node for it when the
	 * model emitted an event/slice but forgot the node (anti-orphan). Refuses to
	 * synthesize a node from a pronoun/filler or a status phrase.
	 */
	function resolveOrCreateRef(ref, hintCategory) {
		const r = resolveRef(ref);
		if (r) return r;
		if (!ref || isJunkLabel(ref) || looksLikeStatus(ref)) return null;
		if (isSuppressed("node", ref)) return null;
		const id = createNode(ref, hintCategory ?? "other", null, null, true);
		return { id };
	}

	async function materializeDurableSignal(obj) {
		// 7.4: the durable-signal fallback works from the ONE message that
		// carries this object, never the concatenated batch — its output
		// becomes stored slice/event text.
		const basis = sourceMessages.length
			? (bestMessageFor([obj?.text, obj?.label, obj?.on].filter(Boolean).join(" "))?.content ?? "")
			: sourceText;
		if (!basis) return false;
		const durable = durablePlanFromText(basis, obj);
		if (!durable) return false;
		if (isSuppressed("node", durable.label)) {
			reject(obj, "suppressed_blocked");
			return true;
		}
		const node = resolveOrCreateRef(durable.label, durable.category);
		if (!node) {
			reject(obj, "durable_signal_no_node");
			return true;
		}
		if (durable.type === "event") {
			const action = valid(durable.action, ACTIONS, "other");
			const duplicateEventId = await recentEventMatch(env, userId, node.id, action, now, projectScope.projectId);
			if (duplicateEventId) {
				plan.eventTouches.push({ id: duplicateEventId, node_id: node.id, action });
				plan.affectedNodeIds.add(node.id);
				return true;
			}
			plan.newEvents.push({
				id: newId("event"),
				user_id: userId,
				node_id: node.id,
				action,
				text: durable.text,
				importance: valid(durable.importance, IMPORTANCE, "important"),
				happened_at: parseProposedDate(durable.date, now) ?? opts.lastTs ?? now,
				created_at: now,
				confidence: durable.confidence,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
			});
			const newState = ACTION_TO_STATE[action];
			if (newState) plan.nodeStateUpdates.push({ id: node.id, state: newState });
			plan.affectedNodeIds.add(node.id);
			return true;
		}
		const kind = valid(durable.sliceKind, SLICE_KINDS, "other");
		const duplicateSliceId = await matchingSliceId(env, userId, node.id, kind, durable.text, projectScope.projectId);
		if (duplicateSliceId) {
			plan.sliceTouches.push({ id: duplicateSliceId, node_id: node.id, kind });
			plan.affectedNodeIds.add(node.id);
			return true;
		}
		if (supersedeKinds.has(kind)) plan.sliceSupersede.push({ node_id: node.id, kind });
		// SUPERSEDE-01: retire whatever this correction makes obsolete, whatever
		// kind it was filed under. Kind-keyed retirement alone left contradictory
		// facts current in 3 of 3 measured correction shapes.
		for (const conflict of await conflictingSliceIds(env, userId, node.id, durable.text, projectScope.projectId, { updateMode, nodes: nodeIdentityList(), sourceText })) {
			plan.sliceSupersede.push({ node_id: conflict.node_id ?? node.id, kind: conflict.kind, id: conflict.id });
		}
		attributeEdgeClosures(durable.text);
		plan.newSlices.push({
			id: newId("slice"),
			user_id: userId,
			node_id: node.id,
			text: durable.text,
			kind,
			is_current: 1,
			created_at: now,
			confidence: durable.confidence,
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
		});
		plan.affectedNodeIds.add(node.id);
		return true;
	}

	function addCandidate(label, strength, clusterHint, meta = {}) {
		if (manual) return;
		const norm = normalizeLabel(label);
		if (isSuppressed("candidate", label) || isSuppressed("node", label)) return;
		// Already a node? Then it isn't a candidate.
		const existingNode = matchExisting(label, meta.possibleExistingNodeId ?? null, existing, existingById, { trace: plan.merges });
		if (existingNode) {
			plan.nodeTouches.add(existingNode.id);
			plan.affectedNodeIds.add(existingNode.id);
			return;
		}
		const existingCand = candidateByLabel.get(norm);
		if (existingCand) {
			plan.candidateBumps.push({
				id: existingCand.id,
				mentions: (existingCand.mentions ?? existingCand.mention_count ?? 1) + 1,
				evidence: meta.evidence ?? messageEvidenceFor({ label }),
				now,
			});
			return;
		}
		if (plan.newCandidates.some((c) => normalizeLabel(c.label) === norm)) return;
		const evidenceText = String(meta.evidence ?? messageEvidenceFor({ label }) ?? "").trim();
		const clusterGuess = clusterHint ?? meta.clusterGuess ?? clusterForMemory({
			label,
			category: meta.roleGuess ?? "interest",
			text: evidenceText,
		});
		plan.newCandidates.push({
			id: newId("candidate"),
			user_id: userId,
			label,
			label_guess: label,
			canonical_key: canonicalKey(label),
			role_guess: meta.roleGuess ?? null,
			cluster_guess: clusterGuess ?? null,
			strength: valid(strength, CANDIDATE_STRENGTHS, "weak"),
			confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : null,
			status: "pending",
			mentions: 1,
			mention_count: 1,
			session_count: 1,
			cluster_hint: clusterGuess ?? null,
			evidence_json: JSON.stringify(evidenceText ? [{ text: evidenceText, source: "message", ts: now }] : []),
			possible_parent_id: meta.possibleParentId ?? null,
			possible_existing_node_id: meta.possibleExistingNodeId ?? null,
			reason: meta.reason ?? "weak_or_unclear_signal",
			first_seen_at: now,
			last_seen_at: now,
			expires_at: meta.expiresAt ?? null,
			created_at: now,
			project_id: projectScope.projectId,
			project_name: projectScope.projectName,
		});
	}

	function pruneEmptyNewNodes() {
		const attached = new Set();
		for (const s of plan.newSlices) attached.add(s.node_id);
		for (const e of plan.newEvents) attached.add(e.node_id);
		for (const e of plan.newEdges) {
			attached.add(e.from_node);
			attached.add(e.to_node);
		}
		for (const u of plan.nodeStateUpdates) attached.add(u.id);

		const kept = [];
		for (const node of plan.newNodes) {
			if (attached.has(node.id)) {
				kept.push(node);
				continue;
			}
			reject({ kind: "node", label: node.label }, "node_without_detail");
			plan.affectedNodeIds.delete(node.id);
		}
		plan.newNodes = kept;
	}

	const order = { node: 0, event: 1, slice: 2, edge: 3, candidate: 4 };
	const sorted = [...objects].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

	const profile = opts.profile ?? null;

	for (const obj of sorted) {
		const conf = Number(obj.confidence ?? 0);

		// ---- STRUCTURAL CAPS (engine v2) ------------------------------------
		// Absurd attribute sizes are tool output, not memory; merely long ones
		// are clipped so a chatty model cannot bloat a row.
		if (typeof obj.text === "string" && obj.text.length > TEXT_REJECT) {
			reject(obj, "attr_too_long");
			continue;
		}

		// ---- 7.4: BATCH-TEXT BLOB GATE --------------------------------------
		// A slice/event whose text is stitched together from SEVERAL messages
		// is the batch talking, not a fact: no single message covers it, but
		// the whole chunk does. Conservative thresholds — a fact paraphrased
		// from one message always passes.
		if ((obj.kind === "slice" || obj.kind === "event") && typeof obj.text === "string" && sourceMessages.length > 1) {
			const wanted = normalizeLabel(obj.text).split(" ").filter((t) => t.length > 2);
			if (wanted.length >= 25) {
				const best = bestMessageFor(obj.text);
				const chunkTokens = new Set(normalizeLabel(sourceText).split(" ").filter((t) => t.length > 2));
				const chunkCoverage = wanted.filter((t) => chunkTokens.has(t)).length / wanted.length;
				if ((best?.coverage ?? 0) < 0.5 && chunkCoverage >= 0.9) {
					reject(obj, "batch_text_blob");
					continue;
				}
			}
		}
		if (typeof obj.label === "string" && obj.label.length > LABEL_CAP) obj.label = obj.label.slice(0, LABEL_CAP);
		if (typeof obj.text === "string" && obj.text.length > TEXT_CAP) obj.text = `${obj.text.slice(0, TEXT_CAP - 1)}…`;

		// ---- MCP LENS --------------------------------------------------------
		// Host-mediated input earns a grounding check the raw lanes don't need:
		// a fact whose material words are mostly absent from what was actually
		// sent is the host model talking, not the user. This is the retired
		// manual lane's fabrication guard, carried across in reduced form.
		// Edges are exempt — the numbered-entity contract already grounds them.
		if (profile === "mcp" && (obj.kind === "slice" || obj.kind === "event") && sourceText) {
			const material = tokens(String(obj.text ?? "")).filter((t) => t.length > 3);
			if (material.length) {
				const sourceTokens = new Set(tokens(sourceText));
				const hits = material.filter((t) => sourceTokens.has(t)).length;
				if (hits === 0 || hits / material.length < 0.5) {
					reject(obj, "ungrounded_fact");
					continue;
				}
			}
		}

		// ---- PLUGIN LENS -----------------------------------------------------
		// Coding sessions memorize decisions, conventions and error→fix pairs —
		// never paths as standalone memories, stack traces, or diffs.
		if (profile === "plugin") {
			if (obj.kind === "node" && looksLikeFilePath(obj.label)) {
				reject(obj, "file_path_node");
				continue;
			}
			if ((obj.kind === "slice" || obj.kind === "event") && looksLikeDiff(obj.text)) {
				reject(obj, "tool_chatter");
				continue;
			}
			if (
				(obj.kind === "slice" || obj.kind === "event") &&
				looksLikeStackTrace(obj.text) &&
				!["fix", "blocker"].includes(obj.kind_detail ?? obj.kind)
			) {
				// A trace is only memory when it resolved into an error→fix pair.
				reject(obj, "stack_trace_discarded");
				continue;
			}
		}

		// ---- NODE GATE -------------------------------------------------------
		if (obj.kind === "node") {
			if (isJunkLabel(obj.label)) {
				// A pronoun/filler is never a durable entity — drop it entirely
				// (any edge that referenced it then fails endpoint resolution).
				reject(obj, "junk_label");
				continue;
			}
			if (isBadTitle(obj.label)) {
				reject(obj, "bad_title");
				continue;
			}
			if (isSuppressed("node", obj.label)) {
				reject(obj, "suppressed_blocked");
				continue;
			}
			// Judge by MEANING: unknown category becomes "other", it is NOT dropped.
			const category = canonicalizeCategory(obj.category) ?? "other";
			if (conf < confMin) {
				if (await materializeDurableSignal({ ...obj, category, confidence: conf })) continue;
				// Genuinely weak → park as a candidate (still visible in the UI),
				// not silently lost.
				addCandidate(obj.label, "weak", null, {
					confidence: conf,
					roleGuess: category,
					reason: manual ? "manual_low_confidence_rejected" : "low_confidence_downgraded",
					evidence: messageEvidenceFor(obj),
				});
				reject(obj, manual ? "low_confidence" : "low_confidence_downgraded");
				continue;
			}
			const match = matchExisting(obj.label, obj.matches_existing, existing, existingById, { category: obj.category, trace: plan.merges });
			if (match) {
				// Canonical match → update, do NOT create a duplicate.
				resolved.set(normalizeLabel(obj.label), match.id);
				plan.nodeTouches.add(match.id);
				plan.affectedNodeIds.add(match.id);
				continue;
			}
			if (looksLikeStatus(obj.label)) {
				reject(obj, "node_is_status");
				continue;
			}
			if (!hasCompanionObject(obj.label)) {
				if (await materializeDurableSignal({ ...obj, category, confidence: conf })) continue;
				if (!manual) {
					addCandidate(obj.label, "strong", null, {
						confidence: conf,
						roleGuess: category,
						reason: "node_without_detail",
						evidence: messageEvidenceFor(obj),
					});
				}
				reject(obj, "node_without_detail");
				continue;
			}
			createNode(obj.label, category, obj.role, obj.state);
			continue;
		}

		// ---- EVENT GATE ------------------------------------------------------
		if (obj.kind === "event") {
			if (conf < confMin) {
				reject(obj, "low_confidence");
				continue;
			}
			const action = valid(obj.action, ACTIONS, "other");
			// Anti-orphan: synthesize the subject node if the model forgot it, with a
			// category inferred from the action (family for passed_away, etc.).
			const node = resolveOrCreateRef(obj.on, ACTION_SUBJECT_CATEGORY[action]);
			if (!node) {
				reject(obj, "event_no_node");
				continue;
			}
			const duplicateEventId = await recentEventMatch(env, userId, node.id, action, now, projectScope.projectId);
			if (duplicateEventId) {
				plan.eventTouches.push({ id: duplicateEventId, node_id: node.id, action });
				plan.affectedNodeIds.add(node.id);
				continue;
			}
			plan.newEvents.push({
				id: newId("event"),
				user_id: userId,
				node_id: node.id,
				action,
				text: obj.text ?? "",
				importance: valid(obj.importance, IMPORTANCE, "ordinary"),
				happened_at: parseProposedDate(obj.date, now) ?? opts.lastTs ?? now,
				created_at: now,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
			});
			plan.affectedNodeIds.add(node.id);
			// A lifecycle event also updates the node's state.
			const newState = ACTION_TO_STATE[action];
			if (newState) plan.nodeStateUpdates.push({ id: node.id, state: newState });
			continue;
		}

		// ---- SLICE GATE ------------------------------------------------------
		if (obj.kind === "slice") {
			if (conf < confMin) {
				reject(obj, "low_confidence");
				continue;
			}
			const text = String(obj.text ?? "").trim();
			if (!text) {
				reject(obj, "empty_slice");
				continue;
			}
			// Anti-orphan: attach to the subject node, creating it if missing.
			const node = resolveOrCreateRef(obj.on);
			if (!node) {
				reject(obj, "slice_no_node");
				continue;
			}
			const kind = valid(obj.kind_detail, SLICE_KINDS, "other");
			const duplicateSliceId = await matchingSliceId(env, userId, node.id, kind, text, projectScope.projectId);
			if (duplicateSliceId) {
				plan.sliceTouches.push({ id: duplicateSliceId, node_id: node.id, kind });
				plan.affectedNodeIds.add(node.id);
				continue;
			}
			// Supersede an older single-valued slice (mark is_current = 0) before append.
			if (supersedeKinds.has(kind)) plan.sliceSupersede.push({ node_id: node.id, kind });
			// SUPERSEDE-01: plus anything this correction explicitly obsoletes,
			// regardless of the kind it was originally filed under.
			for (const conflict of await conflictingSliceIds(env, userId, node.id, text, projectScope.projectId, { updateMode, nodes: nodeIdentityList(), sourceText })) {
				plan.sliceSupersede.push({ node_id: conflict.node_id ?? node.id, kind: conflict.kind, id: conflict.id });
			}
			attributeEdgeClosures(text);
			plan.newSlices.push({
				id: newId("slice"),
				user_id: userId,
				node_id: node.id,
				text,
				kind,
				is_current: 1,
				created_at: now,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
			});
			plan.affectedNodeIds.add(node.id);
			continue;
		}

		// ---- EDGE GATE -------------------------------------------------------
		if (obj.kind === "edge") {
			if (conf < confMin) {
				reject(obj, "low_confidence");
				continue;
			}
			const from = resolveRef(obj.from);
			const to = resolveRef(obj.to);
			// Only between two existing/durable nodes, only on an explicit relation.
			if (!from || !to) {
				reject(obj, "edge_endpoint_missing");
				continue;
			}
			if (from.id === to.id) {
				reject(obj, "edge_self_loop");
				continue;
			}
			// v2 edges carry an open SCREAMING_SNAKE vocabulary; legacy edges keep
			// the closed list. Both are validated — neither is trusted.
			const isV2 = obj._v2 === true;
			if (isV2 ? !V2_RELATION_RE.test(String(obj.type ?? "")) : !EDGE_TYPES.includes(obj.type)) {
				reject(obj, "invalid_edge_type");
				continue;
			}
			const type = obj.type;
			const exactEdges = existingEdges.filter(
				(e) => e.from_node === from.id && e.to_node === to.id && e.type === type,
			);
			// A closed row is history, not the current relationship. If the same
			// relationship recurs later, preserve the old validity window and write
			// a fresh active row. Explicit end-dated proposals may still match an
			// existing row so repeated evidence does not duplicate history.
			const existingEdge = obj.invalid_at
				? (exactEdges.find((e) => !e.invalid_at) ?? exactEdges[0])
				: exactEdges.find((e) => !e.invalid_at || Number(e.invalid_at) > now);
			if (existingEdge) {
				plan.edgeTouches.push({ id: existingEdge.id, from_node: from.id, to_node: to.id, type });
				// The model may have learned the relation ENDED — close, never delete.
				if (isV2 && obj.invalid_at && !existingEdge.invalid_at) {
					plan.edgeClosures.push({ id: existingEdge.id, invalid_at: obj.invalid_at });
				}
				plan.affectedNodeIds.add(from.id);
				plan.affectedNodeIds.add(to.id);
				continue;
			}
			if (
				plan.newEdges.some(
					(e) => e.from_node === from.id && e.to_node === to.id && e.type === type,
				)
			) {
				reject(obj, "duplicate_edge");
				continue;
			}
			// Functional relation: one open target per source. A new WORKS_AT
			// closes the old employer's validity window (bi-temporal supersede);
			// the old row stays queryable as history.
			if (isV2 && FUNCTIONAL_RELATIONS.has(type)) {
				for (const e of existingEdges) {
					if (e.from_node === from.id && e.type === type && e.to_node !== to.id && !e.invalid_at && !e.deleted_at) {
						plan.edgeClosures.push({ id: e.id, invalid_at: obj.valid_at ?? now });
					}
				}
				for (const e of plan.newEdges) {
					if (e.from_node === from.id && e.type === type && e.to_node !== to.id && !e.invalid_at) {
						e.invalid_at = obj.valid_at ?? now;
					}
				}
			}
			// SUPERSEDE-01 (edge half): a correction also obsoletes RELATION
			// facts, and relations LEAD the recall context — so retiring only
			// slices left "uses blue-green cutover" headlining the answer even
			// after its slice went non-current (measured: slices correct, 2/3
			// still stale via edges). Close the validity window rather than
			// deleting: recall already honors invalid_at and renders it as
			// "(until …)", so history stays queryable.
			if (isV2) {
				// The obsoleting language lives in what the USER wrote, not in the
				// extracted fact: a correction "now uses CircleCI, not Jenkins"
				// becomes the clean fact "X uses CircleCI", which names nothing as
				// obsolete. Measured: the Jenkins relation stayed current because
				// conflict was read from the fact alone. So consult the source
				// text too — still requiring explicit obsoleting language, so an
				// ordinary additive statement never closes anything.
				const conflictSources = [obj.fact, updateMode ? sourceText : null].filter(Boolean);
				for (const e of existingEdges) {
					if (e.from_node !== from.id || e.invalid_at || e.deleted_at) continue;
					// A relation with no fact text still asserts durable content —
					// its triple: from-label + type + to-label. Legacy edges never
					// carry fact, so every correction left them current and recall
					// kept rendering the obsolete relation (measured live: the
					// fact-null "uses Jenkins" edge survived while its textual twin
					// was closed). Mem0's graph memory serializes triples into this
					// text shape for its contradiction decision; Graphiti requires
					// fact text on every edge. Same invariant, deterministic.
					const assertion = e.fact ?? edgeTripleText(e);
					if (!assertion) continue;
					if (!conflictSources.some((t) => supersedesValue({ text: t }, { text: assertion }))) continue;
					plan.edgeClosures.push({ id: e.id, invalid_at: obj.valid_at ?? now });
				}
				// The same correction must also retire conflicting SLICES: the
				// extractor often emits a correction as relations only (measured
				// live: "changed the index from Postgres to SQLite" produced no
				// slice object), and what a correction retires must not depend on
				// which object kinds its extraction happened to emit.
				for (const conflict of await conflictingSliceIds(env, userId, from.id, obj.fact ?? "", projectScope.projectId, { updateMode, nodes: nodeIdentityList(), sourceText })) {
					plan.sliceSupersede.push({ node_id: conflict.node_id ?? from.id, kind: conflict.kind, id: conflict.id });
				}
				attributeEdgeClosures(obj.fact);
			}
			plan.newEdges.push({
				id: newId("edge"),
				user_id: userId,
				from_node: from.id,
				to_node: to.id,
				type,
				created_at: now,
				fact: isV2 ? (obj.fact ?? null) : null,
				valid_at: isV2 ? (obj.valid_at ?? null) : null,
				invalid_at: isV2 ? (obj.invalid_at ?? null) : null,
				confidence: Number.isFinite(conf) ? conf : null,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
			});
			plan.affectedNodeIds.add(from.id);
			plan.affectedNodeIds.add(to.id);
			continue;
		}

		// ---- CANDIDATE GATE --------------------------------------------------
		if (obj.kind === "candidate") {
			if (await materializeDurableSignal(obj)) continue;
			if (manual) {
				reject(obj, "manual_candidate_disabled");
				continue;
			}
			addCandidate(obj.label, obj.strength, obj.cluster_hint, {
				confidence: conf,
				roleGuess: obj.category ?? obj.role_guess ?? null,
				reason: obj.reason ?? "model_candidate",
				evidence: messageEvidenceFor(obj),
				possibleExistingNodeId: obj.matches_existing ?? obj.possible_existing_node_id ?? null,
			});
			continue;
		}

		reject(obj, "unknown_kind");
	}

	pruneEmptyNewNodes();

	plan.hasWrites =
		plan.newNodes.length > 0 ||
		plan.newSlices.length > 0 ||
		plan.sliceTouches.length > 0 ||
		plan.newEvents.length > 0 ||
		plan.eventTouches.length > 0 ||
		plan.newEdges.length > 0 ||
		plan.edgeTouches.length > 0 ||
		plan.edgeClosures.length > 0 ||
		plan.newCandidates.length > 0 ||
		plan.nodeStateUpdates.length > 0 ||
		plan.nodeTouches.size > 0 ||
		plan.candidateBumps.length > 0;

	return plan;
}
