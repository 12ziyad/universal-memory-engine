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
import { canonicalKey, getActiveSuppressions, getUserCandidates, getUserEdges, getUserNodes } from "../lib/db.js";
import { normalizeLabel, jaccard, tokens, wordContains, levenshteinRatio } from "../lib/text.js";
import { durablePlanFromText } from "./candidate_rules.js";
import { clusterForMemory } from "./clusters.js";
import { isBadTitle } from "./title.js";

// Slice kinds that hold a single "current" value, so a new one supersedes the old.
const SUPERSEDE_KINDS = new Set(["progress", "preference"]);
const UPDATE_MODE_SUPERSEDE_KINDS = new Set([
	"feature_detail",
	"technical_detail",
	"progress",
	"blocker",
	"fix",
	"decision",
	"preference",
	"other",
]);
// Window for treating a same-action event as a duplicate of an ongoing incident.
const EVENT_DEDUPE_MS = 24 * 60 * 60 * 1000;

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
 * Canonical match: does this label really refer to an existing node?
 * Checks the model's hint first, then exact / containment / fuzzy.
 */
function matchExisting(label, matchesExistingId, existing, existingById) {
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
		if (wordContains(norm, nNorm) || wordContains(nNorm, norm)) return node; // containment
		const j = jaccard(labelTokens, tokens(node.label));
		const lev = levenshteinRatio(norm, nNorm);
		const score = Math.max(j, lev);
		if (score > bestScore) {
			bestScore = score;
			best = node;
		}
	}
	if (best && (bestScore >= 0.6)) return best;
	return null;
}

async function recentEventMatch(env, userId, nodeId, action, now) {
	const row = await env.DB.prepare(
		`SELECT id FROM events
		 WHERE user_id = ? AND node_id = ? AND action = ? AND created_at >= ? AND deleted_at IS NULL
		 ORDER BY created_at DESC LIMIT 1`,
	)
		.bind(userId, nodeId, action, now - EVENT_DEDUPE_MS)
		.first();
	return row?.id ?? null;
}

async function matchingSliceId(env, userId, nodeId, kind, text) {
	const { results } = await env.DB.prepare(
		`SELECT id, text FROM slices
		 WHERE user_id = ? AND node_id = ? AND kind = ? AND deleted_at IS NULL
		 ORDER BY created_at DESC LIMIT 50`,
	)
		.bind(userId, nodeId, kind)
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

const DEFAULT_SETTINGS = { paused: false, disabledCategories: [] };

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
	// Path A (user-commanded save): keep anything durable, drop only obvious junk.
	const manual = Boolean(opts.manual);
	const updateMode = Boolean(opts.updateMode);
	const sourceText = String(opts.sourceText ?? "");
	const supersedeKinds = updateMode ? UPDATE_MODE_SUPERSEDE_KINDS : SUPERSEDE_KINDS;
	const confMin = manual ? config.manualConfidenceMin : config.confidenceMin;

	const plan = {
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
		newCandidates: [],
		candidateBumps: [],
		affectedNodeIds: new Set(),
		autoCreated: [], // labels of nodes synthesized by the anti-orphan rule
		rejected: [],
	};

	let objects = applyUserSettings(proposal.objects ?? [], settings);
	if (!settings?.paused && objects.length === 0) {
		const durable = durablePlanFromText(sourceText);
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

	const existing = await getUserNodes(env, userId);
	const existingById = new Map(existing.map((n) => [n.id, n]));
	const candidates = await getUserCandidates(env, userId);
	const candidateByLabel = new Map(candidates.map((c) => [normalizeLabel(c.label), c]));
	const existingEdges = await getUserEdges(env, userId);
	const suppressions = await getActiveSuppressions(env, userId);
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
		});
		resolved.set(normalizeLabel(label), id);
		existing.push({ id, label, category, state: "active" });
		existingById.set(id, { id, label, category, state: "active" });
		plan.affectedNodeIds.add(id);
		if (auto) plan.autoCreated.push(label);
		return id;
	}

	function resolveRef(ref) {
		if (!ref) return null;
		const norm = normalizeLabel(ref);
		if (resolved.has(norm)) return { id: resolved.get(norm) };
		const match = matchExisting(ref, null, existing, existingById);
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
		const durable = durablePlanFromText(sourceText, obj);
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
			const duplicateEventId = await recentEventMatch(env, userId, node.id, action, now);
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
				happened_at: now,
				created_at: now,
				confidence: durable.confidence,
			});
			const newState = ACTION_TO_STATE[action];
			if (newState) plan.nodeStateUpdates.push({ id: node.id, state: newState });
			plan.affectedNodeIds.add(node.id);
			return true;
		}
		const kind = valid(durable.sliceKind, SLICE_KINDS, "other");
		const duplicateSliceId = await matchingSliceId(env, userId, node.id, kind, durable.text);
		if (duplicateSliceId) {
			plan.sliceTouches.push({ id: duplicateSliceId, node_id: node.id, kind });
			plan.affectedNodeIds.add(node.id);
			return true;
		}
		if (supersedeKinds.has(kind)) plan.sliceSupersede.push({ node_id: node.id, kind });
		plan.newSlices.push({
			id: newId("slice"),
			user_id: userId,
			node_id: node.id,
			text: durable.text,
			kind,
			is_current: 1,
			created_at: now,
			confidence: durable.confidence,
		});
		plan.affectedNodeIds.add(node.id);
		return true;
	}

	function addCandidate(label, strength, clusterHint, meta = {}) {
		if (manual) return;
		const norm = normalizeLabel(label);
		if (isSuppressed("candidate", label) || isSuppressed("node", label)) return;
		// Already a node? Then it isn't a candidate.
		const existingNode = matchExisting(label, meta.possibleExistingNodeId ?? null, existing, existingById);
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
				evidence: meta.evidence ?? sourceText,
				now,
			});
			return;
		}
		if (plan.newCandidates.some((c) => normalizeLabel(c.label) === norm)) return;
		const evidenceText = String(meta.evidence ?? sourceText ?? "").trim();
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

	for (const obj of sorted) {
		const conf = Number(obj.confidence ?? 0);

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
					evidence: sourceText,
				});
				reject(obj, manual ? "low_confidence" : "low_confidence_downgraded");
				continue;
			}
			const match = matchExisting(obj.label, obj.matches_existing, existing, existingById);
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
						evidence: sourceText,
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
			const duplicateEventId = await recentEventMatch(env, userId, node.id, action, now);
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
				happened_at: now,
				created_at: now,
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
			const duplicateSliceId = await matchingSliceId(env, userId, node.id, kind, text);
			if (duplicateSliceId) {
				plan.sliceTouches.push({ id: duplicateSliceId, node_id: node.id, kind });
				plan.affectedNodeIds.add(node.id);
				continue;
			}
			// Supersede an older single-valued slice (mark is_current = 0) before append.
			if (supersedeKinds.has(kind)) plan.sliceSupersede.push({ node_id: node.id, kind });
			plan.newSlices.push({
				id: newId("slice"),
				user_id: userId,
				node_id: node.id,
				text,
				kind,
				is_current: 1,
				created_at: now,
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
			if (!EDGE_TYPES.includes(obj.type)) {
				reject(obj, "invalid_edge_type");
				continue;
			}
			const type = obj.type;
			const existingEdge = existingEdges.find(
				(e) => e.from_node === from.id && e.to_node === to.id && e.type === type,
			);
			if (existingEdge) {
				plan.edgeTouches.push({ id: existingEdge.id, from_node: from.id, to_node: to.id, type });
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
			plan.newEdges.push({
				id: newId("edge"),
				user_id: userId,
				from_node: from.id,
				to_node: to.id,
				type,
				created_at: now,
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
				evidence: sourceText,
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
		plan.newCandidates.length > 0 ||
		plan.nodeStateUpdates.length > 0 ||
		plan.nodeTouches.size > 0 ||
		plan.candidateBumps.length > 0;

	return plan;
}
