import { ACTION_TO_STATE } from "../config.js";
import { newId } from "../lib/ids.js";
import { clusterForMemory } from "./clusters.js";
import {
	MANUAL_IDENTITY_MERGE_MIN,
	canonicalIdentity,
	manualCategoryCompatibility,
	manualIdentityNames,
	manualIdentitySimilarity,
	manualNodeAliases,
	resolveManualIdentity,
} from "./manual_identity.js";

const ONE_OFF_EVENTS = new Set(["passed_away", "born", "married", "diagnosed"]);
const SINGLE_VALUE_SLICES = new Set(["preference"]);
const FACT_STOPWORDS = new Set(["a", "an", "and", "for", "from", "in", "is", "of", "on", "the", "to", "user", "with"]);

const NON_MATERIALIZING_MENTION_ROLES = new Set([
	"comparison",
	"example",
	"option",
	"incidental",
	"incidental_mention",
	"historical_reference",
	"reference_only",
	"context_only",
]);

const MATERIALIZING_MENTION_ROLES = new Set([
	"primary_subject",
	"independent_fact_subject",
	"fact_subject",
	"relationship_subject",
	"relationship_target",
	"relationship_endpoint",
	"correction_subject",
	"correction_target",
	"correction_old_target",
	"correction_new_target",
	"deliberate_identity",
	"explicit_usage",
	"supporting_entity",
]);

function parseJsonArray(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function loadManualGraphState(env, userId) {
	const now = Date.now();
	const [nodes, slices, events, edges, candidates, suppressions] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, canonical_label, aliases_json, category, role, state, summary,
				mention_count, session_count, last_seen_at, heat_score, confidence,
				health_state, importance_class, cluster
			 FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, node_id, text, kind, is_current, created_at, reinforcement_count, last_seen_at
			 FROM slices WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, node_id, action, text, importance, happened_at, created_at,
				reinforcement_count, last_seen_at, confidence
			 FROM events WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, from_node, to_node, type, reinforcement_count, weight, evidence_count,
				last_seen_at, confidence
			 FROM edges WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, label, label_guess, canonical_key, role_guess, cluster_guess,
				possible_existing_node_id, status, evidence_json
			 FROM candidates
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
				AND COALESCE(status, 'pending') = 'pending'`,
		).bind(userId),
		env.DB.prepare(
			`SELECT kind, canonical_key, label, reason, source_object_id
			 FROM memory_suppressions
			 WHERE user_id = ? AND (suppressed_until IS NULL OR suppressed_until > ?)`,
		).bind(userId, now),
	]);
	return {
		nodes: nodes.results ?? [],
		slices: slices.results ?? [],
		events: events.results ?? [],
		edges: edges.results ?? [],
		candidates: candidates.results ?? [],
		suppressions: suppressions.results ?? [],
	};
}

/** Hydrate only the bounded identities selected by MCP manual retrieval. */
export async function loadManualPlanningState(env, userId, { nodeIds = [], canonicalKeys = [] } = {}) {
	const ids = [...new Set(nodeIds.map(String).filter(Boolean))].slice(0, 30);
	const keys = [...new Set(canonicalKeys.map(canonicalIdentity).filter(Boolean))].slice(0, 64);
	const idMarks = ids.map(() => "?").join(", ") || "NULL";
	const keyMarks = keys.map(() => "?").join(", ") || "NULL";
	const now = Date.now();
	const [nodes, slices, events, edges, candidates, suppressions] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, canonical_label, aliases_json, category, role, state, summary,
			 mention_count, session_count, last_seen_at, heat_score, confidence,
			 health_state, importance_class, cluster
			 FROM nodes WHERE user_id = ? AND id IN (${idMarks})
			 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`SELECT id, node_id, text, kind, is_current, created_at, reinforcement_count, last_seen_at
			 FROM slices WHERE user_id = ? AND node_id IN (${idMarks}) AND deleted_at IS NULL`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`SELECT id, node_id, action, text, importance, happened_at, created_at,
			 reinforcement_count, last_seen_at, confidence
			 FROM events WHERE user_id = ? AND node_id IN (${idMarks}) AND deleted_at IS NULL`,
		).bind(userId, ...ids),
		env.DB.prepare(
			`SELECT id, from_node, to_node, type, reinforcement_count, weight, evidence_count,
			 last_seen_at, confidence
			 FROM edges WHERE user_id = ? AND deleted_at IS NULL
			 AND (from_node IN (${idMarks}) OR to_node IN (${idMarks}))`,
		).bind(userId, ...ids, ...ids),
		env.DB.prepare(
			`SELECT id, label, label_guess, canonical_key, role_guess, cluster_guess,
			 possible_existing_node_id, status, evidence_json
			 FROM candidates WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
			 AND COALESCE(status, 'pending') = 'pending' AND canonical_key IN (${keyMarks})`,
		).bind(userId, ...keys),
		env.DB.prepare(
			`SELECT kind, canonical_key, label, reason, source_object_id
			 FROM memory_suppressions WHERE user_id = ?
			 AND (suppressed_until IS NULL OR suppressed_until > ?) AND canonical_key IN (${keyMarks})`,
		).bind(userId, now, ...keys),
	]);
	return {
		nodes: nodes.results ?? [],
		slices: slices.results ?? [],
		events: events.results ?? [],
		edges: edges.results ?? [],
		candidates: candidates.results ?? [],
		suppressions: suppressions.results ?? [],
	};
}

function planBase() {
	return {
		newNodes: [],
		nodeStateUpdates: [],
		nodeTouches: [],
		nodeAliasUpdates: [],
		nodeAliasAdds: [],
		nodeSummaryUpdates: [],
		identityClaims: [],
		primaryIdentityClaims: [],
		aliasIdentityClaims: [],
		correctionGuards: [],
		sliceSupersede: [],
		newSlices: [],
		sliceTouches: [],
		newEvents: [],
		eventTouches: [],
		newEdges: [],
		edgeTouches: [],
		edgeSupersede: [],
		newCandidates: [],
		candidateBumps: [],
		candidateResolutions: [],
		newPages: [],
		pageUpdates: [],
		affectedNodeIds: new Set(),
		autoCreated: [],
		rejected: [],
		identityDecisions: [],
		conflicts: [],
		resolvedCandidates: [],
		correctionActions: [],
		ignoredMentions: [],
		overriddenRecommendations: [],
		verifiedAliasAdditions: [],
		topicCommunityMemberships: [],
		retrieval: {
			broad_pool_count: 0,
			card_count: 0,
			signals_used: [],
			warnings: [],
		},
		derivedRefreshNodeIds: new Set(),
	};
}

function factWords(value) {
	return canonicalIdentity(value)
		.split(" ")
		.filter((word) => word.length > 1 && !FACT_STOPWORDS.has(word))
		.map((word) => {
			if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
			if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
			return word;
		});
}

function textSimilarity(left, right) {
	const aText = canonicalIdentity(left);
	const bText = canonicalIdentity(right);
	if (!aText || !bText) return 0;
	if (aText === bText) return 1;
	const shorter = aText.length <= bText.length ? aText : bText;
	const longer = aText.length > bText.length ? aText : bText;
	if (shorter.length >= 16 && (` ${longer} `).includes(` ${shorter} `)) return 0.92;
	const a = new Set(factWords(aText));
	const b = new Set(factWords(bText));
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}

function manualFactKey(kind, ...parts) {
	return JSON.stringify([kind, ...parts.map((part) => canonicalIdentity(part))]);
}

function sameSlice(left, right) {
	const score = textSimilarity(left, right);
	return score === 1 || (Math.min(factWords(left).length, factWords(right).length) >= 3 && score >= 0.72);
}

function sameEvent(existing, memory) {
	if (existing.action !== memory.action) return false;
	if (ONE_OFF_EVENTS.has(memory.action)) return true;
	return textSimilarity(existing.text, memory.text) >= 0.78;
}

function uniquePush(list, item, key) {
	if (list.some((existing) => key(existing) === key(item))) return;
	list.push(item);
}

function addManualIdentityClaim(plan, claim, { primary = false } = {}) {
	if (!claim?.canonical_key || !claim?.node_id) return;
	const target = primary ? plan.primaryIdentityClaims : plan.aliasIdentityClaims;
	uniquePush(target, claim, (item) => `${item.canonical_key}:${item.node_id}`);
	uniquePush(plan.identityClaims, claim, (item) => `${item.canonical_key}:${item.node_id}`);
}

function suppressedIdentity(state, label) {
	const key = canonicalIdentity(label);
	return state.suppressions.find((row) =>
		row.kind === "node" && canonicalIdentity(row.canonical_key ?? row.label) === key) ?? null;
}

function aliasesAfterObservation(node, observedLabels, verifiedLabels = new Set()) {
	const aliases = [...manualNodeAliases(node)];
	for (const label of observedLabels ?? []) {
		if (
			!label ||
			(manualIdentitySimilarity(label, node.label) < MANUAL_IDENTITY_MERGE_MIN &&
				!verifiedLabels.has(canonicalIdentity(label)))
		) continue;
		if (manualIdentityNames({ ...node, aliases }).some((name) => canonicalIdentity(name) === canonicalIdentity(label))) continue;
		aliases.push(label);
	}
	return aliases.slice(0, 24);
}

function manualClusterFor(item) {
	const cluster = clusterForMemory(item);
	const category = canonicalIdentity(item?.category);
	// clusterForMemory's all-zero tie selects its first configured cluster. Treat
	// that as unresolved for uncategorized manual identities instead of silently
	// placing them in a broad bucket.
	if (cluster === "general_memory" || ((!category || category === "other") && cluster === "identity_career")) {
		return "unclustered";
	}
	return cluster;
}

function mentionRole(identity) {
	return String(identity?.mention_role ?? identity?.mentionRole ?? "").trim().toLocaleLowerCase("en-US");
}

function roleCanMaterialize(identity, { historical = false } = {}) {
	const role = mentionRole(identity);
	if (!role) return true; // Legacy proposal compatibility.
	if (historical && role === "correction_old_target") return true;
	if (NON_MATERIALIZING_MENTION_ROLES.has(role)) return false;
	return MATERIALIZING_MENTION_ROLES.has(role);
}

function plannerIdentityKey(identity) {
	return canonicalIdentity(identity?.label);
}

function normalizedEntityIdentity(raw, ref, entities, fallbackRole = null) {
	const value = raw && typeof raw === "object" ? raw : (raw ? { label: raw } : {});
	const entityRef = ref ?? value.entity_ref ?? value.entityRef ?? value.ref ?? null;
	const entity = entityRef ? entities.get(String(entityRef)) : null;
	const merged = { ...(entity ?? {}), ...value };
	return {
		...merged,
		label: String(merged.label ?? merged.name ?? "").trim(),
		category: merged.category ?? merged.role_type ?? "other",
		aliases: Array.isArray(merged.aliases) ? merged.aliases : [],
		entity_ref: entityRef ? String(entityRef) : (merged.ref ? String(merged.ref) : null),
		mention_role: merged.mention_role ?? merged.mentionRole ?? fallbackRole ?? null,
	};
}

function ignoredMention(plan, identity, reason = "ineligible_mention_role") {
	const key = `${identity?.entity_ref ?? ""}:${plannerIdentityKey(identity)}:${mentionRole(identity)}`;
	if (!plannerIdentityKey(identity)) return;
	if (plan.ignoredMentions.some((item) => item._key === key)) return;
	plan.ignoredMentions.push({
		_key: key,
		entity_ref: identity.entity_ref ?? null,
		label: identity.label,
		mention_role: mentionRole(identity) || null,
		reason,
	});
}

function normalizeManualOperations(integrity, plan) {
	const entities = new Map();
	for (const raw of integrity?.entities ?? []) {
		const ref = raw?.ref ?? raw?.entity_ref ?? raw?.entityRef;
		if (!ref) continue;
		const identity = normalizedEntityIdentity(raw, ref, new Map(), raw.mention_role ?? raw.mentionRole);
		entities.set(String(ref), identity);
		if (!roleCanMaterialize(identity)) ignoredMention(plan, identity);
	}

	const facts = (integrity?.facts ?? []).map((fact) => ({
		...fact,
		identity: normalizedEntityIdentity(
			fact?.identity ?? fact?.subject,
			fact?.subject_ref ?? fact?.subjectRef ?? fact?.entity_ref ?? fact?.entityRef,
			entities,
			"fact_subject",
		),
	}));

	const primaryRef = integrity?.primary_subject_ref ?? integrity?.primarySubjectRef ?? null;
	const primaryMemory = integrity?.primary_memory ?? integrity?.primaryMemory ?? null;
	if (primaryRef && primaryMemory?.text) {
		const identity = normalizedEntityIdentity(null, primaryRef, entities, "primary_subject");
		const duplicate = facts.some((fact) =>
			plannerIdentityKey(fact.identity) === plannerIdentityKey(identity) &&
			canonicalIdentity(fact.memory?.text) === canonicalIdentity(primaryMemory.text));
		if (!duplicate) {
			facts.unshift({
				identity,
				memory: {
					kind: primaryMemory.kind === "event" ? "event" : "slice",
					action: primaryMemory.action ?? "other",
					slice_kind: primaryMemory.slice_kind ?? primaryMemory.sliceKind ?? "other",
					text: String(primaryMemory.text).trim(),
					importance: primaryMemory.importance ?? "ordinary",
					happened_at: primaryMemory.happened_at ?? primaryMemory.happenedAt ?? null,
				},
				confidence: primaryMemory.confidence ?? 0.9,
				primary_memory: true,
			});
		}
	}

	const relationships = (integrity?.relationships ?? []).map((relationship) => ({
		...relationship,
		from: normalizedEntityIdentity(
			relationship?.from,
			relationship?.from_ref ?? relationship?.fromRef,
			entities,
			"relationship_endpoint",
		),
		to: normalizedEntityIdentity(
			relationship?.to,
			relationship?.to_ref ?? relationship?.toRef,
			entities,
			"relationship_endpoint",
		),
	}));

	const corrections = (integrity?.corrections ?? []).map((correction) => ({
		...correction,
		subject: normalizedEntityIdentity(
			correction?.subject,
			correction?.subject_ref ?? correction?.subjectRef,
			entities,
			"correction_subject",
		),
		old_target: correction?.old_target || correction?.oldTarget || correction?.old_target_ref || correction?.oldTargetRef
			? normalizedEntityIdentity(
				correction?.old_target ?? correction?.oldTarget,
				correction?.old_target_ref ?? correction?.oldTargetRef,
				entities,
				"correction_old_target",
			)
			: null,
		new_target: correction?.new_target || correction?.newTarget || correction?.new_target_ref || correction?.newTargetRef
			? normalizedEntityIdentity(
				correction?.new_target ?? correction?.newTarget,
				correction?.new_target_ref ?? correction?.newTargetRef,
				entities,
				"correction_new_target",
			)
			: null,
	}));

	return { entities, facts, relationships, corrections };
}

function isFactCorrection(correction) {
	const kind = String(correction?.kind ?? correction?.correction_kind ?? correction?.correctionKind ?? "")
		.toLocaleLowerCase("en-US");
	if (kind === "relationship") return false;
	if (kind === "fact") return true;
	return correction?.slice_kind != null || correction?.replacement_memory != null;
}

function exactCorrectionOldText(value) {
	return String(
		value?.old_text ?? value?.oldText ?? value?.old_value ?? value?.oldValue ??
		value?.target?.text ?? value?.target?.old_text ?? value?.target?.old_value ?? "",
	).trim();
}

function replacementMemoryForCorrection(correction) {
	const raw = correction?.replacement_memory ?? correction?.replacementMemory ?? correction?.replacement ?? {};
	const text = String(
		raw?.text ?? correction?.new_text ?? correction?.newText ?? correction?.current_text ?? correction?.currentText ?? "",
	).trim();
	return {
		kind: raw?.kind === "event" ? "event" : "slice",
		action: raw?.action ?? "other",
		slice_kind: raw?.slice_kind ?? raw?.sliceKind ?? correction?.slice_kind ?? correction?.sliceKind ?? "other",
		text,
		importance: raw?.importance ?? "ordinary",
		happened_at: raw?.happened_at ?? raw?.happenedAt ?? null,
	};
}

function retrievalReceipt(integrity, input) {
	const raw = input?.retrieval ?? integrity?.retrieval ?? {};
	return {
		broad_pool_count: Number(raw.broad_pool_count ?? raw.broadPoolCount ?? 0),
		card_count: Number(raw.card_count ?? raw.cardCount ?? 0),
		signals_used: [...new Set(raw.signals_used ?? raw.signalsUsed ?? [])],
		warnings: [...new Set(raw.warnings ?? [])],
	};
}

function deterministicSummary(node, slices, events, stateOverride = null) {
	const currentSlices = [...(slices ?? [])]
		.filter((slice) => Number(slice.is_current ?? 1) === 1)
		.sort((left, right) =>
			Number(right.created_at ?? 0) - Number(left.created_at ?? 0) ||
			Number(left.manual_order ?? Number.MAX_SAFE_INTEGER) - Number(right.manual_order ?? Number.MAX_SAFE_INTEGER) ||
			String(left.id).localeCompare(String(right.id)));
	const recentEvents = [...(events ?? [])]
		.sort((left, right) =>
			Number(right.happened_at ?? right.created_at ?? 0) - Number(left.happened_at ?? left.created_at ?? 0) ||
			Number(left.manual_order ?? Number.MAX_SAFE_INTEGER) - Number(right.manual_order ?? Number.MAX_SAFE_INTEGER) ||
			String(left.id).localeCompare(String(right.id)));
	const details = [];
	for (const item of [...currentSlices, ...recentEvents]) {
		const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
		if (!text || details.some((existing) => canonicalIdentity(existing) === canonicalIdentity(text))) continue;
		details.push(text);
		if (details.length >= 3) break;
	}
	if (details.length) return `${node.label}: ${details.join("; ")}`.slice(0, 320);
	const state = stateOverride ?? node.state ?? "active";
	return `${node.label} is an active ${node.category ?? "memory"} (${state}).`.replace(/\s+/g, " ").slice(0, 320);
}

function runLists(plan) {
	return {
		createdNodes: plan.newNodes.map((node) => ({ id: node.id, label: node.label })),
		createdSlices: plan.newSlices.map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
		createdEvents: plan.newEvents.map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
		createdEdges: plan.newEdges.map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
		updatedObjects: [
			...plan.nodeTouches.map((touch) => ({ kind: "node", id: touch.id ?? touch })),
			...plan.edgeSupersede.map((edge) => ({ kind: "edge", id: edge.id, status: "superseded" })),
		],
		reinforcedObjects: [
			...plan.sliceTouches.map((item) => ({ kind: "slice", id: item.id })),
			...plan.eventTouches.map((item) => ({ kind: "event", id: item.id })),
			...plan.edgeTouches.map((item) => ({ kind: "edge", id: item.id })),
		],
		skippedObjects: plan.rejected,
	};
}

/** Convert grounded manual facts into an atomic write plan. */
export function buildManualGraphPlan(userId, integrity, state, input = {}) {
	const now = Date.now();
	const plan = planBase();
	plan.rejected.push(...(integrity?.rejected ?? []));
	plan.retrieval = retrievalReceipt(integrity, input);
	const normalized = normalizeManualOperations(integrity, plan);
	const allNodes = [...(state.nodes ?? [])];
	const virtualByLabel = new Map();
	const virtualById = new Map();
	const observedByNode = new Map();
	const supportTextByNode = new Map();
	const touchedNodeIds = new Set();
	const stateByNode = new Map((state.nodes ?? []).map((node) => [node.id, node.state ?? "active"]));
	const decisions = new Map();
	const requirements = new Map();
	const verifiedLabelsByKey = new Map();

	const facts = [];
	for (const fact of normalized.facts) {
		if (!roleCanMaterialize(fact.identity)) {
			ignoredMention(plan, fact.identity);
			plan.rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact.identity?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		if (!plannerIdentityKey(fact.identity) || !fact?.memory?.text || !["slice", "event"].includes(fact.memory.kind)) {
			plan.rejected.push({ kind: fact?.memory?.kind ?? "fact", label: fact.identity?.label ?? null, reason: "incomplete_fact" });
			continue;
		}
		facts.push(fact);
	}

	const relationships = [];
	for (const relationship of normalized.relationships) {
		const endpoints = [relationship.from, relationship.to];
		const ineligible = endpoints.filter((identity) => !roleCanMaterialize(identity));
		if (ineligible.length) {
			for (const identity of ineligible) ignoredMention(plan, identity);
			plan.rejected.push({ kind: "edge", label: relationship.from?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		if (
			!plannerIdentityKey(relationship.from) ||
			!plannerIdentityKey(relationship.to) ||
			!relationship.type ||
			!String(relationship.text ?? "").trim() ||
			plannerIdentityKey(relationship.from) === plannerIdentityKey(relationship.to)
		) {
			plan.rejected.push({ kind: "edge", label: relationship.from?.label ?? null, reason: "incomplete_relationship" });
			continue;
		}
		relationships.push(relationship);
	}

	const corrections = [];
	for (const correction of normalized.corrections) {
		if (!roleCanMaterialize(correction.subject)) {
			ignoredMention(plan, correction.subject);
			plan.rejected.push({ kind: "correction", label: correction.subject?.label ?? null, reason: "ineligible_mention_role" });
			continue;
		}
		if (!plannerIdentityKey(correction.subject)) {
			plan.rejected.push({ kind: "correction", label: null, reason: "incomplete_correction" });
			continue;
		}
		if (isFactCorrection(correction)) {
			const replacement = replacementMemoryForCorrection(correction);
			if (!replacement.text || replacement.kind !== "slice" || !exactCorrectionOldText(correction)) {
				plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "incomplete_fact_correction" });
				continue;
			}
			corrections.push({ ...correction, _manual_fact_correction: true, _replacement_memory: replacement });
			continue;
		}
		if (
			!correction.type ||
			(!plannerIdentityKey(correction.old_target) && !plannerIdentityKey(correction.new_target)) ||
			(correction.old_target && !roleCanMaterialize(correction.old_target, { historical: true })) ||
			(correction.new_target && !roleCanMaterialize(correction.new_target))
		) {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "incomplete_relationship_correction" });
			continue;
		}
		corrections.push(correction);
	}

	function requireIdentity(identity, purpose, historicalOnly = false) {
		const key = plannerIdentityKey(identity);
		if (!key) return;
		const known = requirements.get(key);
		if (known) {
			known.purposes.add(purpose);
			known.historicalOnly = known.historicalOnly && historicalOnly;
			if (!known.identity.entity_ref && identity.entity_ref) known.identity.entity_ref = identity.entity_ref;
			return;
		}
		requirements.set(key, { key, identity: { ...identity }, purposes: new Set([purpose]), historicalOnly });
	}

	for (const fact of facts) requireIdentity(fact.identity, "fact");
	for (const relationship of relationships) {
		requireIdentity(relationship.from, "relationship");
		requireIdentity(relationship.to, "relationship");
	}
	for (const correction of corrections) {
		requireIdentity(correction.subject, "correction_subject");
		if (!correction._manual_fact_correction && correction.old_target) {
			requireIdentity(correction.old_target, "correction_old_target", true);
		}
		if (!correction._manual_fact_correction && correction.new_target) {
			requireIdentity(correction.new_target, "correction_new_target");
		}
	}

	const cards = [
		...(input.nodeContextCards ?? input.node_context_cards ?? []),
		...(input.retrieval?.cards ?? []),
		...(integrity?.nodeContextCards ?? integrity?.node_context_cards ?? []),
	];
	const cardsByRef = new Map(cards.map((card) => [String(card.ref ?? card.card_ref ?? card.cardRef ?? ""), card]));
	const adjudication = input.adjudicatedDecisions ?? input.adjudicated_decisions ?? input.adjudication ??
		integrity?.adjudicatedDecisions ?? integrity?.adjudicated_decisions ?? integrity?.adjudication ?? {};
	const identityOperations = adjudication.identity_operations ?? adjudication.identityOperations ?? adjudication.decisions ?? [];
	const adjudicationByRef = new Map();
	for (const operation of identityOperations) {
		const ref = operation?.entity_ref ?? operation?.entityRef;
		if (ref) adjudicationByRef.set(`ref:${String(ref)}`, operation);
		if (operation?.label) adjudicationByRef.set(`key:${canonicalIdentity(operation.label)}`, operation);
	}

	function recommendationFor(identity) {
		return adjudicationByRef.get(`ref:${identity?.entity_ref}`) ??
			adjudicationByRef.get(`key:${plannerIdentityKey(identity)}`) ?? null;
	}

	function overrideRecommendation(identity, operation, reason, deterministicDecision = null) {
		plan.overriddenRecommendations.push({
			entity_ref: identity?.entity_ref ?? operation?.entity_ref ?? null,
			label: identity?.label ?? null,
			recommendation: operation?.decision ?? null,
			selected_ref: operation?.selected_ref ?? operation?.selectedRef ?? null,
			reason,
			deterministic_decision: deterministicDecision?.decision ?? null,
		});
	}

	function decideRequirement(requirement) {
		const identity = requirement.identity;
		const suppression = suppressedIdentity(state, identity.label);
		if (suppression) return { decision: "invalid", label: identity.label, reason: "suppressed_blocked" };
		if (identity._manual_conflict_reason) {
			const rawReason = String(identity._manual_conflict_reason);
			const authoritativeMatches = identity._manual_resolution?.matches ?? [];
			return {
				decision: "ambiguous",
				label: identity.label,
				reason: rawReason === "multiple_exact_identity_matches" ? "multiple_existing_nodes_match" : rawReason,
				reason_codes: identity._manual_resolution?.reason_codes ?? [],
				matches: authoritativeMatches.map((match) => ({
					id: match.node_id ?? match.id ?? null,
					label: match.label,
					category: match.category ?? null,
					score: match.identity_score ?? match.score ?? null,
				})),
			};
		}
		const authoritative = identity._manual_resolution;
		if (authoritative?.decision === "identity_conflict") {
			const rawReason = authoritative.reason_codes?.[0] ?? "identity_conflict";
			return {
				decision: "ambiguous",
				label: identity.label,
				reason: rawReason === "multiple_exact_identity_matches" ? "multiple_existing_nodes_match" : rawReason,
				reason_codes: authoritative.reason_codes ?? [],
				matches: (authoritative.matches ?? []).map((match) => ({
					id: match.node_id ?? match.id ?? null,
					label: match.label,
					category: match.category ?? null,
					score: match.identity_score ?? match.score ?? null,
				})),
			};
		}
		if (authoritative?.decision === "create_new") {
			return { decision: "new", label: identity.label, canonical_key: requirement.key, adjudicated: true };
		}
		if (authoritative?.decision === "merge_existing") {
			const selected = (state.nodes ?? []).find((node) => node.id === identity.existing_node_id);
			const category = selected ? manualCategoryCompatibility(identity, selected) : null;
			if (!selected || category?.hard_conflict) {
				return {
					decision: "ambiguous",
					label: identity.label,
					reason: selected ? "adjudicated_category_conflict" : "adjudicated_node_unavailable",
					matches: [],
				};
			}
			if (!verifiedLabelsByKey.has(requirement.key)) verifiedLabelsByKey.set(requirement.key, new Set());
			verifiedLabelsByKey.get(requirement.key).add(canonicalIdentity(identity.label));
			return {
				decision: "existing",
				label: identity.label,
				node: selected,
				score: authoritative.confidence ?? null,
				matched_name: identity.label,
				adjudicated: true,
			};
		}
		const deterministic = resolveManualIdentity(identity, state.nodes ?? []);
		const operation = recommendationFor(identity);
		if (!operation) return deterministic;
		const recommendation = String(operation.decision ?? "");
		if (["create_new", "new"].includes(recommendation)) {
			if (deterministic.decision !== "new") overrideRecommendation(identity, operation, "deterministic_identity_override", deterministic);
			return deterministic;
		}
		if (!["merge_existing", "existing"].includes(recommendation)) {
			overrideRecommendation(identity, operation, "unsupported_recommendation", deterministic);
			return deterministic;
		}

		const selectedRef = String(operation.selected_ref ?? operation.selectedRef ?? "");
		const card = cardsByRef.get(selectedRef);
		const selectedId = operation.selected_node_id ?? operation.selectedNodeId ??
			input.retrieval?.refMap?.get?.(selectedRef) ??
			card?.node_id ?? card?.nodeId ?? card?._node_id ?? null;
		const selected = (state.nodes ?? []).find((node) => node.id === selectedId);
		if (!selected) {
			overrideRecommendation(identity, operation, "unknown_or_out_of_shortlist_reference", deterministic);
			return deterministic;
		}

		const hinted = resolveManualIdentity({ ...identity, existing_node_id: selected.id }, state.nodes ?? []);
		if (hinted.decision === "existing") {
			if (!verifiedLabelsByKey.has(requirement.key)) verifiedLabelsByKey.set(requirement.key, new Set());
			verifiedLabelsByKey.get(requirement.key).add(canonicalIdentity(identity.label));
			return hinted;
		}

		const confidence = Number(operation.confidence ?? 0);
		const signals = operation.compatible_non_llm_signals ?? operation.compatibleNonLlmSignals ??
			operation.non_llm_signals ?? operation.nonLlmSignals ?? [];
		const signalCount = Array.isArray(signals)
			? new Set(signals.filter(Boolean)).size
			: Number(operation.compatible_signal_count ?? operation.compatibleSignalCount ?? 0);
		const category = manualCategoryCompatibility(identity, selected);
		if (
			confidence >= 0.95 &&
			signalCount >= 2 &&
			!category.hard_conflict &&
			operation.hard_name_contradiction !== true &&
			operation.hardNameContradiction !== true
		) {
			if (!verifiedLabelsByKey.has(requirement.key)) verifiedLabelsByKey.set(requirement.key, new Set());
			verifiedLabelsByKey.get(requirement.key).add(canonicalIdentity(identity.label));
			return {
				decision: "existing",
				label: identity.label,
				node: selected,
				score: confidence,
				matched_name: selected.label,
				adjudicated: true,
			};
		}

		overrideRecommendation(identity, operation, "semantic_alias_validation_failed", deterministic);
		return deterministic;
	}

	for (const requirement of requirements.values()) {
		const decision = decideRequirement(requirement);
		decisions.set(requirement.key, decision);
		plan.identityDecisions.push({
			entity_ref: requirement.identity.entity_ref ?? null,
			label: requirement.identity.label,
			decision: requirement.historicalOnly && decision.decision === "new" ? "historical_not_found" : decision.decision,
			node_id: decision.node?.id ?? null,
			matched_by: decision.matched_name ?? null,
			score: decision.score ?? null,
			adjudicated: decision.adjudicated === true,
		});
		if (decision.decision === "ambiguous") {
			plan.conflicts.push({
				label: decision.label,
				reason: decision.reason,
				reason_codes: decision.reason_codes ?? [],
				matches: decision.matches ?? [],
			});
		} else if (decision.decision === "invalid") {
			plan.rejected.push({ kind: "identity", label: decision.label, reason: decision.reason });
		}
	}

	function usableDecision(identity, { existingOnly = false } = {}) {
		const decision = decisions.get(plannerIdentityKey(identity));
		if (!decision || decision.decision === "invalid" || decision.decision === "ambiguous") return false;
		return !existingOnly || decision.decision === "existing";
	}

	let validFacts = facts.filter((fact) => usableDecision(fact.identity));
	const validRelationships = relationships.filter((relationship) => {
		if (!usableDecision(relationship.from) || !usableDecision(relationship.to)) return false;
		const from = decisions.get(plannerIdentityKey(relationship.from));
		const to = decisions.get(plannerIdentityKey(relationship.to));
		const same = plannerIdentityKey(relationship.from) === plannerIdentityKey(relationship.to) ||
			(from.decision === "existing" && to.decision === "existing" && from.node.id === to.node.id);
		if (same) {
			plan.rejected.push({ kind: "edge", label: relationship.from.label, reason: "edge_self_loop" });
			return false;
		}
		return true;
	});

	const validCorrections = [];
	for (const correction of corrections) {
		if (!usableDecision(correction.subject)) continue;
		const subjectDecision = decisions.get(plannerIdentityKey(correction.subject));
		if (correction._manual_fact_correction) {
			if (subjectDecision.decision !== "existing") {
				plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "fact_correction_subject_not_found" });
				continue;
			}
			const memory = correction._replacement_memory;
			const current = (state.slices ?? []).filter((slice) =>
				slice.node_id === subjectDecision.node.id &&
				Number(slice.is_current ?? 1) === 1 &&
				slice.kind === memory.slice_kind);
			const replacement = current.find((slice) => sameSlice(slice.text, memory.text));
			if (replacement) {
				validCorrections.push({ ...correction, _target_slice_ids: [] });
				continue;
			}
			const oldKey = canonicalIdentity(exactCorrectionOldText(correction));
			const targets = current.filter((slice) => canonicalIdentity(slice.text) === oldKey);
			if (targets.length !== 1) {
				plan.rejected.push({
					kind: "correction",
					label: correction.subject.label,
					reason: targets.length ? "ambiguous_fact_correction_target" : "fact_correction_target_not_found",
				});
				continue;
			}
			validCorrections.push({ ...correction, _target_slice_ids: [targets[0].id] });
			continue;
		}

		const oldUsable = !correction.old_target || usableDecision(correction.old_target, { existingOnly: true });
		const newUsable = !correction.new_target || usableDecision(correction.new_target);
		if (!oldUsable || !newUsable) {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "historical_identity_not_found" });
			continue;
		}
		if (subjectDecision.decision !== "existing") {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "correction_subject_not_found" });
			continue;
		}
		const oldDecision = correction.old_target ? decisions.get(plannerIdentityKey(correction.old_target)) : null;
		const newDecision = correction.new_target ? decisions.get(plannerIdentityKey(correction.new_target)) : null;
		const oldEdge = oldDecision?.node ? (state.edges ?? []).find((edge) =>
			edge.from_node === subjectDecision.node.id && edge.to_node === oldDecision.node.id && edge.type === correction.type) : null;
		const replacementEdge = newDecision?.decision === "existing" ? (state.edges ?? []).find((edge) =>
			edge.from_node === subjectDecision.node.id && edge.to_node === newDecision.node.id && edge.type === correction.type) : null;
		if (correction.old_target && !oldEdge && !replacementEdge) {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "correction_relationship_not_found" });
			continue;
		}
		validCorrections.push(correction);
	}

	// A typed correction is authoritative for its replacement value. Heuristic
	// extraction may also emit that same sentence as an ordinary fact; planning it
	// twice would create an unguarded second current slice beside the correction.
	validFacts = validFacts.filter((fact) => !validCorrections.some((correction) =>
		correction._manual_fact_correction &&
		plannerIdentityKey(correction.subject) === plannerIdentityKey(fact.identity) &&
		canonicalIdentity(correction._replacement_memory?.text) === canonicalIdentity(fact.memory?.text)));

	// Legacy `supersedes` facts remain accepted, but they now resolve one exact
	// target before allocation instead of clearing every current slice of a kind.
	validFacts = validFacts.filter((fact) => {
		if (!fact.supersedes || fact.memory.kind !== "slice") return true;
		const decision = decisions.get(plannerIdentityKey(fact.identity));
		if (decision?.decision !== "existing") return true;
		const current = (state.slices ?? []).filter((slice) =>
			slice.node_id === decision.node.id &&
			slice.kind === fact.memory.slice_kind &&
			Number(slice.is_current ?? 1) === 1);
		if (current.some((slice) => sameSlice(slice.text, fact.memory.text))) {
			fact._target_slice_ids = [];
			return true;
		}
		const oldText = exactCorrectionOldText(fact);
		const targets = oldText
			? current.filter((slice) => canonicalIdentity(slice.text) === canonicalIdentity(oldText))
			: current;
		if (targets.length === 1) {
			fact._target_slice_ids = [targets[0].id];
			return true;
		}
		if (!targets.length && !SINGLE_VALUE_SLICES.has(fact.memory.slice_kind)) {
			fact._target_slice_ids = [];
			return true;
		}
		plan.rejected.push({
			kind: "slice",
			label: fact.identity.label,
			reason: targets.length ? "ambiguous_fact_correction_target" : "fact_correction_target_not_found",
		});
		return false;
	});

	const activeIdentityKeys = new Set();
	for (const fact of validFacts) activeIdentityKeys.add(plannerIdentityKey(fact.identity));
	for (const relationship of validRelationships) {
		activeIdentityKeys.add(plannerIdentityKey(relationship.from));
		activeIdentityKeys.add(plannerIdentityKey(relationship.to));
	}
	for (const correction of validCorrections) {
		activeIdentityKeys.add(plannerIdentityKey(correction.subject));
		if (correction.old_target) activeIdentityKeys.add(plannerIdentityKey(correction.old_target));
		if (correction.new_target) activeIdentityKeys.add(plannerIdentityKey(correction.new_target));
	}

	if (plan.conflicts.length) {
		plan.hasGraphWrites = false;
		plan.hasWrites = false;
		plan.runLists = runLists(plan);
		for (const item of plan.ignoredMentions) delete item._key;
		return plan;
	}

	function observe(nodeId, label, supportText = null) {
		if (!observedByNode.has(nodeId)) observedByNode.set(nodeId, new Set());
		if (label) observedByNode.get(nodeId).add(label);
		if (supportText && !supportTextByNode.has(nodeId)) supportTextByNode.set(nodeId, supportText);
		plan.affectedNodeIds.add(nodeId);
		plan.derivedRefreshNodeIds.add(nodeId);
	}

	function touchExisting(nodeId, identityKey = null) {
		if (touchedNodeIds.has(nodeId)) {
			const existing = plan.nodeTouches.find((touch) => (touch?.id ?? touch) === nodeId);
			if (existing && !existing.manual_identity_key && identityKey) existing.manual_identity_key = identityKey;
			return;
		}
		touchedNodeIds.add(nodeId);
		plan.nodeTouches.push({ id: nodeId, increment_session: true, manual_identity_key: identityKey });
	}

	function resolve(identity, supportText = null) {
		const labelKey = canonicalIdentity(identity?.label);
		if (!activeIdentityKeys.has(labelKey)) return null;
		if (virtualByLabel.has(labelKey)) {
			const known = virtualByLabel.get(labelKey);
			observe(known.node.id, identity?.label, supportText);
			return known;
		}
		const decision = decisions.get(labelKey);
		if (!decision || !["existing", "new"].includes(decision.decision)) return null;

		let node;
		let existed;
		if (decision.decision === "existing") {
			node = decision.node;
			existed = !node._manual_new;
			if (existed) touchExisting(node.id, canonicalIdentity(identity?.label));
		} else {
			const id = newId("node");
			const category = identity.category ?? "other";
			node = {
				id,
				user_id: userId,
				label: identity.label,
				canonical_label: canonicalIdentity(identity.label),
				aliases_json: JSON.stringify((identity.aliases ?? []).filter((alias) =>
					manualIdentitySimilarity(alias, identity.label) >= MANUAL_IDENTITY_MERGE_MIN)),
				category,
				role: null,
				state: "active",
				summary: null,
				identity_key: canonicalIdentity(identity.label),
				created_at: now,
				updated_at: now,
				last_seen_at: now,
				mention_count: 1,
				session_count: 1,
				heat_score: 1,
				confidence: Number.isFinite(Number(identity.confidence)) ? Number(identity.confidence) : null,
				health_state: "active",
				importance_class: "ordinary",
				cluster: manualClusterFor({ label: identity.label, category }),
				_manual_new: true,
			};
			plan.newNodes.push(node);
			allNodes.push(node);
			stateByNode.set(id, node.state);
			existed = false;
		}
		const nodeKey = canonicalIdentity(node.label);
		const observedKey = canonicalIdentity(identity.label);
		if (!existed) {
			addManualIdentityClaim(plan, { canonical_key: nodeKey, node_id: node.id, created_at: now }, { primary: true });
		} else {
			addManualIdentityClaim(plan, { canonical_key: nodeKey, node_id: node.id, created_at: now });
		}
		if (observedKey && observedKey !== nodeKey) {
			addManualIdentityClaim(plan, { canonical_key: observedKey, node_id: node.id, created_at: now });
		}
		const virtual = { node, existed, identityKey: observedKey || nodeKey, relatedIdentityKey: null };
		virtualByLabel.set(labelKey, virtual);
		virtualById.set(node.id, virtual);
		observe(node.id, identity?.label, supportText);
		return virtual;
	}

	function resolveExistingOnly(identity) {
		const decision = decisions.get(plannerIdentityKey(identity));
		if (!decision || decision.decision !== "existing") return null;
		return { node: decision.node, existed: true };
	}

	function addSlice(virtual, fact) {
		const memory = fact.memory;
		const existingSlices = [
			...(state.slices ?? []).filter((slice) =>
				slice.node_id === virtual.node.id && slice.kind === memory.slice_kind && Number(slice.is_current ?? 1) === 1),
			...plan.newSlices.filter((slice) => slice.node_id === virtual.node.id && slice.kind === memory.slice_kind),
		];
		const duplicate = existingSlices.find((slice) => sameSlice(slice.text, memory.text));
		if (duplicate) {
			if ((state.slices ?? []).some((slice) => slice.id === duplicate.id)) {
				uniquePush(plan.sliceTouches, {
					id: duplicate.id,
					node_id: virtual.node.id,
					kind: duplicate.kind,
					manual_identity_key: virtual.identityKey,
				}, (item) => item.id);
			}
			for (const targetId of fact._target_slice_ids ?? []) {
				if (targetId === duplicate.id) continue;
				const target = (state.slices ?? []).find((slice) => slice.id === targetId && slice.node_id === virtual.node.id);
				if (!target) continue;
				uniquePush(plan.sliceSupersede, {
					id: target.id,
					node_id: target.node_id,
					kind: target.kind,
					replacement_id: duplicate.id,
				}, (item) => item.id);
			}
			return duplicate;
		}
		const id = newId("slice");
		for (const targetId of fact._target_slice_ids ?? []) {
			const target = (state.slices ?? []).find((slice) => slice.id === targetId && slice.node_id === virtual.node.id);
			if (!target) continue;
			uniquePush(plan.sliceSupersede, {
				id: target.id,
				node_id: target.node_id,
				kind: target.kind,
				replacement_id: id,
			}, (item) => item.id);
		}
		const created = {
			id,
			user_id: userId,
			node_id: virtual.node.id,
			text: memory.text,
			kind: memory.slice_kind,
			is_current: 1,
			created_at: now,
			manual_order: plan.newSlices.length,
			manual_fact_key: manualFactKey("slice", virtual.node.id, memory.slice_kind, memory.text),
			manual_identity_key: virtual.identityKey,
		};
		plan.newSlices.push(created);
		return created;
	}

	function addEvent(virtual, fact) {
		const memory = fact.memory;
		const existingEvents = [
			...(state.events ?? []).filter((event) => event.node_id === virtual.node.id),
			...plan.newEvents.filter((event) => event.node_id === virtual.node.id),
		];
		const duplicate = existingEvents.find((event) => sameEvent(event, memory));
		if (duplicate) {
			if ((state.events ?? []).some((event) => event.id === duplicate.id)) {
				uniquePush(plan.eventTouches, {
					id: duplicate.id,
					node_id: virtual.node.id,
					action: duplicate.action,
					manual_identity_key: virtual.identityKey,
				}, (item) => item.id);
			}
		} else {
			const id = newId("event");
			plan.newEvents.push({
				id,
				user_id: userId,
				node_id: virtual.node.id,
				action: memory.action,
				text: memory.text,
				importance: memory.importance ?? "ordinary",
				happened_at: memory.happened_at ?? now,
				created_at: now,
				confidence: fact.confidence ?? null,
				manual_order: plan.newEvents.length,
					manual_fact_key: manualFactKey(
					"event",
					virtual.node.id,
					memory.action,
					ONE_OFF_EVENTS.has(memory.action) ? "one_off" : memory.text,
					),
					manual_identity_key: virtual.identityKey,
			});
		}
		const nextState = ACTION_TO_STATE[memory.action];
		if (nextState && stateByNode.get(virtual.node.id) !== nextState) {
			stateByNode.set(virtual.node.id, nextState);
			if (!virtual.existed) {
				virtual.node.state = nextState;
				return;
			}
			const prior = plan.nodeStateUpdates.find((update) => update.id === virtual.node.id);
			if (prior) prior.state = nextState;
			else plan.nodeStateUpdates.push({
				id: virtual.node.id,
				state: nextState,
				increment_session: virtual.existed,
				manual_identity_key: virtual.identityKey,
			});
		}
	}

	function addRelationship(from, to, relationship) {
		const duplicate = (state.edges ?? []).find((edge) =>
			edge.from_node === from.node.id && edge.to_node === to.node.id && edge.type === relationship.type);
		if (duplicate) {
			uniquePush(plan.edgeTouches, {
				id: duplicate.id,
				from_node: duplicate.from_node,
				to_node: duplicate.to_node,
				type: duplicate.type,
				manual_identity_key: from.identityKey,
				manual_related_identity_key: to.identityKey,
			}, (item) => item.id);
			return duplicate;
		}
		const planned = plan.newEdges.find((edge) =>
			edge.from_node === from.node.id && edge.to_node === to.node.id && edge.type === relationship.type);
		if (planned) return planned;
		const edge = {
			id: newId("edge"),
			user_id: userId,
			from_node: from.node.id,
			to_node: to.node.id,
			type: relationship.type,
			created_at: now,
			confidence: relationship.confidence ?? null,
			evidence_count: 1,
			manual_fact_key: manualFactKey("edge", from.node.id, to.node.id, relationship.type),
			manual_identity_key: from.identityKey,
			manual_related_identity_key: to.identityKey,
		};
		plan.newEdges.push(edge);
		return edge;
	}

	function correctionCurrentSlice(subject, oldTarget, correction) {
		const text = String(correction.current_text ?? "").trim();
		if (!text) return null;
		const duplicate = [
			...(state.slices ?? []).filter((slice) =>
				slice.node_id === subject.node.id &&
				Number(slice.is_current ?? 1) === 1 &&
				sameSlice(slice.text, text)),
			...plan.newSlices.filter((slice) => slice.node_id === subject.node.id && sameSlice(slice.text, text)),
		][0];
		let current = duplicate ?? null;
		if (duplicate && (state.slices ?? []).some((slice) => slice.id === duplicate.id)) {
			uniquePush(plan.sliceTouches, {
				id: duplicate.id,
				node_id: subject.node.id,
				kind: duplicate.kind,
			}, (item) => item.id);
		}
		if (!current) {
			current = {
				id: newId("slice"),
				user_id: userId,
				node_id: subject.node.id,
				text,
				kind: "technical_detail",
				is_current: 1,
				created_at: now,
				manual_order: plan.newSlices.length,
				manual_fact_key: manualFactKey("slice", subject.node.id, "technical_detail", text),
				manual_identity_key: subject.identityKey,
			};
			plan.newSlices.push(current);
		}

		if (!oldTarget?.node?.id || !correction.old_target?.label) return current;
		const subjectKey = canonicalIdentity(subject.node.label);
		const oldTargetKey = canonicalIdentity(correction.old_target.label);
		const predicate = correction.type === "depends_on" ? /\b(?:depends? on|powered by)\b/i : /\buses?\b/i;
		for (const slice of state.slices ?? []) {
			if (slice.node_id !== subject.node.id) continue;
			if (Number(slice.is_current ?? 1) !== 1 || slice.id === current.id) continue;
			const sliceKey = canonicalIdentity(slice.text);
			if (!sliceKey.includes(subjectKey) || !sliceKey.includes(oldTargetKey) || !predicate.test(slice.text)) continue;
			uniquePush(plan.sliceSupersede, {
				id: slice.id,
				node_id: slice.node_id,
				kind: slice.kind,
				replacement_id: current.id,
			}, (item) => item.id ?? `${item.node_id}:${item.kind}`);
			plan.affectedNodeIds.add(slice.node_id);
			plan.derivedRefreshNodeIds.add(slice.node_id);
		}
		return current;
	}

	for (const fact of validFacts) {
		const virtual = resolve(fact.identity, fact.memory?.text);
		if (!virtual) continue;
		if (fact.memory.kind === "event") addEvent(virtual, fact);
		else addSlice(virtual, fact);
	}

	for (const correction of validCorrections) {
		if (correction._manual_fact_correction) {
			const subject = resolve(correction.subject, correction._replacement_memory.text);
			if (!subject) continue;
			const replacement = addSlice(subject, {
				confidence: correction.confidence,
				memory: correction._replacement_memory,
				_target_slice_ids: correction._target_slice_ids,
			});
			const oldSliceId = (correction._target_slice_ids ?? [])[0] ?? null;
			let guard = null;
			if (oldSliceId && replacement?.id && oldSliceId !== replacement.id) {
				guard = {
					guard_key: manualFactKey("correction_guard", "slice", oldSliceId),
					token: replacement.id,
					object_kind: "slice",
					old_object_id: oldSliceId,
					owner_node_id: subject.node.id,
					replacement_fact_key: replacement.manual_fact_key ?? null,
					replacement_object_id: replacement.id,
					created_at: now,
				};
				plan.correctionGuards.push(guard);
				Object.assign(replacement, {
					manual_correction_guard_key: guard.guard_key,
					manual_correction_guard_token: guard.token,
				});
				for (const supersede of plan.sliceSupersede.filter((item) => item.id === oldSliceId && item.replacement_id === replacement.id)) {
					Object.assign(supersede, {
						manual_correction_guard_key: guard.guard_key,
						manual_correction_guard_token: guard.token,
						replacement_fact_key: replacement.manual_fact_key ?? null,
					});
				}
				for (const touch of plan.sliceTouches.filter((item) => item.id === replacement.id)) {
					Object.assign(touch, {
						manual_correction_guard_key: guard.guard_key,
						manual_correction_guard_token: guard.token,
					});
				}
				for (const mutation of [...plan.nodeTouches, ...plan.nodeStateUpdates]) {
					if (mutation?.id !== subject.node.id) continue;
					mutation.manual_correction_guard_key = guard.guard_key;
					mutation.manual_correction_guard_token = guard.token;
					mutation.manual_correction_guard_fact_key = replacement.manual_fact_key ?? null;
					mutation.manual_correction_guard_object_id = replacement.id;
				}
			}
			plan.correctionActions.push({
				kind: "fact",
				subject_node_id: subject.node.id,
				subject_label: subject.node.label,
				slice_kind: correction._replacement_memory.slice_kind,
				predicate: correction.predicate ?? null,
				old_text: exactCorrectionOldText(correction),
				current_text: correction._replacement_memory.text,
				superseded_slice_ids: [...(correction._target_slice_ids ?? [])],
				replacement_slice_id: replacement?.id ?? null,
				manual_correction_guard_key: guard?.guard_key ?? null,
				manual_correction_guard_token: guard?.token ?? null,
			});
			continue;
		}
		const subject = resolve(correction.subject, correction.current_text ?? correction.text);
		const oldTarget = correction.old_target ? resolveExistingOnly(correction.old_target) : null;
		const newTarget = correction.new_target
			? resolve(correction.new_target, correction.current_text ?? correction.text)
			: null;
		if (!subject || (correction.new_target && !newTarget)) continue;
		if (oldTarget && newTarget && oldTarget.node.id === newTarget.node.id) {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "correction_same_target" });
			continue;
		}

		let replacementEdge = null;
		if (newTarget) {
			replacementEdge = addRelationship(subject, newTarget, {
				type: correction.type,
				confidence: correction.confidence,
			});
		}
		const currentSlice = correctionCurrentSlice(subject, oldTarget, correction);
		let supersededEdge = null;
		if (oldTarget) {
			supersededEdge = (state.edges ?? []).find((edge) =>
				edge.from_node === subject.node.id &&
				edge.to_node === oldTarget.node.id &&
				edge.type === correction.type) ?? null;
			if (supersededEdge && supersededEdge.id !== replacementEdge?.id) {
				const guard = {
					guard_key: manualFactKey("correction_guard", "edge", supersededEdge.id),
					token: replacementEdge?.id ?? newId("correction"),
					object_kind: "edge",
					old_object_id: supersededEdge.id,
					owner_node_id: subject.node.id,
					related_node_id: newTarget?.node.id ?? null,
					replacement_fact_key: replacementEdge?.manual_fact_key ?? null,
					replacement_object_id: replacementEdge?.id ?? null,
					created_at: now,
				};
				plan.correctionGuards.push(guard);
				if (replacementEdge) Object.assign(replacementEdge, {
					manual_correction_old_edge_id: supersededEdge.id,
					manual_correction_guard_key: guard.guard_key,
					manual_correction_guard_token: guard.token,
				});
				if (currentSlice) {
					currentSlice.manual_correction_guard_key = guard.guard_key;
					currentSlice.manual_correction_guard_token = guard.token;
					if (replacementEdge?.manual_fact_key) {
						currentSlice.manual_correction_guard_fact_key = replacementEdge.manual_fact_key;
						currentSlice.manual_correction_guard_object_id = replacementEdge.id;
						currentSlice.manual_correction_requires_fact_claim = true;
					}
					for (const touch of plan.sliceTouches.filter((item) => item.id === currentSlice.id)) {
						Object.assign(touch, {
							manual_correction_guard_key: guard.guard_key,
							manual_correction_guard_token: guard.token,
							manual_correction_guard_fact_key: replacementEdge?.manual_fact_key ?? null,
							manual_correction_guard_object_id: replacementEdge?.id ?? null,
						});
					}
				}
				for (const touch of plan.edgeTouches.filter((item) => item.id === replacementEdge?.id)) {
					Object.assign(touch, {
						manual_correction_guard_key: guard.guard_key,
						manual_correction_guard_token: guard.token,
					});
				}
				uniquePush(plan.edgeSupersede, {
					id: supersededEdge.id,
					from_node: supersededEdge.from_node,
					to_node: supersededEdge.to_node,
					type: supersededEdge.type,
					replacement_edge_id: replacementEdge?.id ?? null,
					replacement_fact_key: replacementEdge?.manual_fact_key ?? null,
					manual_correction_guard_key: guard.guard_key,
					manual_correction_guard_token: guard.token,
					history_text: correction.history_text,
				}, (item) => item.id);
				plan.affectedNodeIds.add(oldTarget.node.id);
				plan.derivedRefreshNodeIds.add(oldTarget.node.id);

				// A new relationship target exists only if this correction owns the
				// transient guard. Primary/alias claims, the node, its supporting fact,
				// and its summary inherit the same capability in later planning passes.
				if (newTarget?.node && plan.newNodes.some((node) => node.id === newTarget.node.id)) {
					newTarget.node.manual_correction_guard_key = guard.guard_key;
					newTarget.node.manual_correction_guard_token = guard.token;
					for (const claim of [...plan.primaryIdentityClaims, ...plan.aliasIdentityClaims]) {
						if (claim.node_id !== newTarget.node.id) continue;
						claim.manual_correction_guard_key = guard.guard_key;
						claim.manual_correction_guard_token = guard.token;
					}
				}
				for (const mutation of [...plan.nodeTouches, ...plan.nodeStateUpdates]) {
					if (![subject.node.id, newTarget?.node.id].includes(mutation?.id)) continue;
					mutation.manual_correction_guard_key = guard.guard_key;
					mutation.manual_correction_guard_token = guard.token;
					mutation.manual_correction_guard_fact_key = replacementEdge?.manual_fact_key ?? null;
					mutation.manual_correction_guard_object_id = replacementEdge?.id ?? null;
				}
			}
		}

		if (correction.history_text) {
			addEvent(subject, {
				confidence: correction.confidence,
				memory: {
					kind: "event",
					action: "changed_plan",
					text: correction.history_text,
					importance: "important",
					happened_at: now,
				},
			});
			const historyEvent = [...plan.newEvents].reverse().find((event) =>
				event.node_id === subject.node.id && event.action === "changed_plan" &&
				canonicalIdentity(event.text) === canonicalIdentity(correction.history_text));
			if (historyEvent && replacementEdge?.manual_correction_guard_key) {
				historyEvent.manual_correction_guard_key = replacementEdge.manual_correction_guard_key;
				historyEvent.manual_correction_guard_token = replacementEdge.manual_correction_guard_token;
				if (replacementEdge.manual_fact_key) {
					historyEvent.manual_correction_guard_fact_key = replacementEdge.manual_fact_key;
					historyEvent.manual_correction_guard_object_id = replacementEdge.id;
					historyEvent.manual_correction_requires_fact_claim = true;
				}
				for (const touch of plan.eventTouches.filter((item) => item.id === historyEvent.id)) {
					Object.assign(touch, {
						manual_correction_guard_key: replacementEdge.manual_correction_guard_key,
						manual_correction_guard_token: replacementEdge.manual_correction_guard_token,
						manual_correction_guard_fact_key: replacementEdge.manual_fact_key ?? null,
						manual_correction_guard_object_id: replacementEdge.id,
					});
				}
			}
		}
		plan.correctionActions.push({
			subject_node_id: subject.node.id,
			subject_label: subject.node.label,
			type: correction.type,
			old_target_node_id: oldTarget?.node.id ?? null,
			old_target_label: correction.old_target?.label ?? null,
			new_target_node_id: newTarget?.node.id ?? null,
			new_target_label: correction.new_target?.label ?? null,
			superseded_edge_id: supersededEdge?.id ?? null,
			replacement_edge_id: replacementEdge?.id ?? null,
			current_slice_id: currentSlice?.id ?? null,
			history_text: correction.history_text,
			current_text: correction.current_text,
			manual_correction_guard_key: replacementEdge?.manual_correction_guard_key ??
				plan.edgeSupersede.find((item) => item.id === supersededEdge?.id)?.manual_correction_guard_key ?? null,
			manual_correction_guard_token: replacementEdge?.manual_correction_guard_token ??
				plan.edgeSupersede.find((item) => item.id === supersededEdge?.id)?.manual_correction_guard_token ?? null,
		});
	}

	for (const relationship of validRelationships) {
		const from = resolve(relationship.from, relationship.text);
		const to = resolve(relationship.to, relationship.text);
		if (!from || !to) continue;
		if (from.node.id === to.node.id) {
			plan.rejected.push({ kind: "edge", label: relationship.from.label, reason: "edge_self_loop" });
			continue;
		}
		addRelationship(from, to, relationship);
	}

	// Edge endpoints are real durable identities too. A new endpoint without its
	// own fact receives the grounded relationship sentence as supporting detail.
	for (const node of plan.newNodes) {
		const hasDetail = plan.newSlices.some((slice) => slice.node_id === node.id) ||
			plan.newEvents.some((event) => event.node_id === node.id);
		if (hasDetail) continue;
		const support = supportTextByNode.get(node.id);
		if (!support) continue;
		const id = newId("slice");
		plan.newSlices.push({
			id,
			user_id: userId,
			node_id: node.id,
			text: support,
			kind: "technical_detail",
			is_current: 1,
			created_at: now,
			manual_order: plan.newSlices.length,
			manual_fact_key: manualFactKey("slice", node.id, "technical_detail", support),
			manual_identity_key: node.identity_key,
			manual_correction_guard_key: node.manual_correction_guard_key ?? null,
			manual_correction_guard_token: node.manual_correction_guard_token ?? null,
			manual_correction_guard_fact_key: plan.newEdges.find((edge) =>
				edge.to_node === node.id && edge.manual_correction_guard_key === node.manual_correction_guard_key)?.manual_fact_key ?? null,
			manual_correction_guard_object_id: plan.newEdges.find((edge) =>
				edge.to_node === node.id && edge.manual_correction_guard_key === node.manual_correction_guard_key)?.id ?? null,
			manual_correction_requires_fact_claim: Boolean(node.manual_correction_guard_key),
		});
	}

	const completeNewNodeIds = new Set([
		...plan.newSlices.map((slice) => slice.node_id),
		...plan.newEvents.map((event) => event.node_id),
	]);
	for (const node of [...plan.newNodes]) {
		if (completeNewNodeIds.has(node.id)) continue;
		plan.rejected.push({ kind: "node", label: node.label, reason: "node_without_grounded_detail" });
		plan.newNodes = plan.newNodes.filter((candidate) => candidate.id !== node.id);
		plan.affectedNodeIds.delete(node.id);
		plan.derivedRefreshNodeIds.delete(node.id);
	}

	// Record safely observed aliases only after every identity decision is known.
	for (const [nodeId, labels] of observedByNode) {
		const virtual = virtualById.get(nodeId) ?? { node: allNodes.find((node) => node.id === nodeId), existed: true };
		if (!virtual.node) continue;
		const verifiedLabels = new Set();
		for (const [identityKey, mapped] of virtualByLabel) {
			if (mapped.node.id !== nodeId) continue;
			for (const key of verifiedLabelsByKey.get(identityKey) ?? []) verifiedLabels.add(key);
		}
		const aliases = aliasesAfterObservation(virtual.node, [...labels], verifiedLabels);
		const beforeKeys = new Set(manualIdentityNames(virtual.node).map(canonicalIdentity));
		const observedKeys = new Set([...labels].map(canonicalIdentity).filter(Boolean));
		for (const alias of aliases) {
			const aliasKey = canonicalIdentity(alias);
			if (!aliasKey || (!observedKeys.has(aliasKey) && !verifiedLabels.has(aliasKey))) continue;
			addManualIdentityClaim(plan, {
				canonical_key: aliasKey,
				node_id: nodeId,
				created_at: now,
				manual_correction_guard_key: virtual.node.manual_correction_guard_key ?? null,
				manual_correction_guard_token: virtual.node.manual_correction_guard_token ?? null,
			});
			if (beforeKeys.has(aliasKey)) continue;
			uniquePush(plan.verifiedAliasAdditions, {
				node_id: nodeId,
				alias,
				canonical_key: aliasKey,
				verification: verifiedLabels.has(aliasKey) ? "adjudicated" : "deterministic",
			}, (item) => `${item.node_id}:${item.canonical_key}`);
			uniquePush(plan.nodeAliasAdds, {
				id: nodeId,
				alias,
				identity_key: aliasKey,
				manual_correction_guard_key: virtual.node.manual_correction_guard_key ?? null,
				manual_correction_guard_token: virtual.node.manual_correction_guard_token ?? null,
			}, (item) => `${item.id}:${item.identity_key}`);
		}
		if (!virtual.existed) virtual.node.aliases_json = "[]";
	}

	// Manual promotion/merge clears only candidates whose identity key is one of
	// the final verified canonical/alias keys. Retrieval similarity and stale node
	// hints are never sufficient.
	const verifiedKeysByNode = new Map();
	for (const [nodeId, labels] of observedByNode) {
		const node = allNodes.find((item) => item.id === nodeId);
		if (!node) continue;
		const keys = new Set(manualIdentityNames(node).map(canonicalIdentity).filter(Boolean));
		for (const label of labels) {
			if (
				manualIdentitySimilarity(label, node.label) >= MANUAL_IDENTITY_MERGE_MIN ||
				[...verifiedLabelsByKey.values()].some((verified) => verified.has(canonicalIdentity(label)))
			) keys.add(canonicalIdentity(label));
		}
		verifiedKeysByNode.set(nodeId, keys);
	}
	for (const candidate of state.candidates ?? []) {
		const candidateKeys = new Set([
			candidate?.canonical_key,
			candidate?.label_guess,
			candidate?.label,
		].map(canonicalIdentity).filter(Boolean));
		for (const [nodeId, verifiedKeys] of verifiedKeysByNode) {
			const node = allNodes.find((item) => item.id === nodeId);
			const verifiedIdentityKey = [...candidateKeys].find((key) => verifiedKeys.has(key));
			if (!node || !verifiedIdentityKey) continue;
			const existed = !node._manual_new;
			const resolution = {
				id: candidate.id,
				status: existed ? "merged" : "promoted",
				node_id: node.id,
				node_kind: "node",
				reviewed_at: now,
				label: candidate.label_guess ?? candidate.label,
				verified_identity_key: verifiedIdentityKey,
			};
			plan.candidateResolutions.push(resolution);
			plan.resolvedCandidates.push(resolution);
			break;
		}
	}

	const communitySpecs = [
		...(integrity?.topic_communities ?? integrity?.topicCommunities ?? []),
		...(input.topicCommunities ?? input.topic_communities ?? []),
	];
	for (const entity of normalized.entities.values()) {
		for (const community of entity.communities ?? entity.topic_communities ?? entity.topicCommunities ?? []) {
			communitySpecs.push({
				label: typeof community === "string" ? community : community.label,
				canonical_key: typeof community === "string" ? canonicalIdentity(community) : community.canonical_key,
				member_refs: [entity.entity_ref],
			});
		}
	}
	for (const community of communitySpecs) {
		const label = String(community?.label ?? community?.topic ?? "").trim();
		const communityKey = canonicalIdentity(community?.canonical_key ?? community?.canonicalKey ?? label);
		if (!communityKey) continue;
		const memberRefs = community?.member_refs ?? community?.memberRefs ?? community?.entity_refs ?? community?.entityRefs ??
			(community?.entity_ref ? [community.entity_ref] : []);
		for (const ref of memberRefs) {
			const entity = normalized.entities.get(String(ref));
			if (!entity || !roleCanMaterialize(entity)) continue;
			const virtual = virtualByLabel.get(plannerIdentityKey(entity));
			if (!virtual?.node?.id) continue;
			uniquePush(plan.topicCommunityMemberships, {
				canonical_key: communityKey,
				label: label || communityKey,
				summary: community?.summary ?? null,
				confidence: community?.confidence ?? null,
				node_id: virtual.node.id,
				entity_ref: entity.entity_ref ?? String(ref),
				verified_identity_key: virtual.identityKey,
				manual_correction_guard_key: virtual.node.manual_correction_guard_key ?? null,
				manual_correction_guard_token: virtual.node.manual_correction_guard_token ?? null,
				source_packet_id: input.sourcePacket?.id ?? input.source_packet_id ?? null,
				created_at: now,
			}, (item) => `${item.canonical_key}:${item.node_id}`);
			plan.derivedRefreshNodeIds.add(virtual.node.id);
		}
	}

	// Simulate the post-write current facts and compute deterministic summaries.
	for (const nodeId of plan.affectedNodeIds) {
		const node = allNodes.find((item) => item.id === nodeId);
		if (!node || (node._manual_new && !plan.newNodes.some((item) => item.id === nodeId))) continue;
		const supersededSliceIds = new Set(plan.sliceSupersede
			.filter((item) => item.node_id === nodeId && item.id)
			.map((item) => item.id));
		const supersededKinds = new Set(plan.sliceSupersede
			.filter((item) => item.node_id === nodeId && !item.id)
			.map((item) => item.kind));
		const slices = [
			...(state.slices ?? []).filter((slice) =>
				slice.node_id === nodeId && Number(slice.is_current ?? 1) === 1 &&
				!supersededSliceIds.has(slice.id) && !supersededKinds.has(slice.kind)),
			...plan.newSlices.filter((slice) => slice.node_id === nodeId && Number(slice.is_current ?? 1) === 1),
		];
		const events = [
			...(state.events ?? []).filter((event) => event.node_id === nodeId),
			...plan.newEvents.filter((event) => event.node_id === nodeId),
		];
		const summary = deterministicSummary(node, slices, events, stateByNode.get(nodeId));
		const cluster = manualClusterFor({ ...node, summary, cluster: null });
		const correctionGuard = plan.correctionGuards.find((guard) =>
			guard.owner_node_id === nodeId || guard.related_node_id === nodeId);
		plan.nodeSummaryUpdates.push({
			id: nodeId,
			summary,
			cluster,
			manual_identity_key: canonicalIdentity(node.label),
			manual_correction_guard_key: correctionGuard?.guard_key ?? node.manual_correction_guard_key ?? null,
			manual_correction_guard_token: correctionGuard?.token ?? node.manual_correction_guard_token ?? null,
			manual_correction_guard_fact_key: correctionGuard?.replacement_fact_key ?? null,
			manual_correction_guard_object_id: correctionGuard?.replacement_object_id ?? null,
		});
		if (node._manual_new) {
			node.summary = summary;
			node.cluster = cluster;
			delete node._manual_new;
		}
	}

	plan.hasGraphWrites = Boolean(
		plan.newNodes.length || plan.nodeTouches.length || plan.nodeStateUpdates.length || plan.nodeAliasUpdates.length || plan.nodeAliasAdds.length ||
		plan.newSlices.length || plan.sliceTouches.length || plan.sliceSupersede.length ||
		plan.newEvents.length || plan.eventTouches.length || plan.newEdges.length || plan.edgeTouches.length || plan.edgeSupersede.length ||
		plan.candidateResolutions.length || plan.nodeSummaryUpdates.length || plan.topicCommunityMemberships.length,
	);
	plan.hasWrites = plan.hasGraphWrites;
	plan.runLists = runLists(plan);
	for (const item of plan.ignoredMentions) delete item._key;
	return plan;
}
