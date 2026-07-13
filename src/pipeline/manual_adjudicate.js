import { canonicalizeCategory } from "./gates.js";
import { extractJson, responseText } from "./llm.js";

const EXACT_IDENTITY_REASONS = new Set([
	"exact_claim",
	"exact_identity_claim",
	"exact_canonical_claim",
	"exact_label",
	"exact_canonical_label",
	"exact_alias",
	"stored_alias",
]);

// Semantic context can corroborate an identity assertion, but it is never an
// identity assertion itself. Keep this list separate from
// SEMANTIC_IDENTITY_SIGNALS so two strong contextual hits cannot be promoted
// into an alias merely because the model recommends one.
const CONTEXTUAL_CORROBORATION_SIGNALS = new Set([
	"bm25",
	"vector",
	"fact_overlap",
	"graph",
	"graph_neighbor",
	"page",
	"linked_page",
	"topic",
	"community",
	"topic_community",
	"cluster",
	"cluster_context",
]);

const SEMANTIC_IDENTITY_SIGNALS = new Set([
	// Emitted only when a stored node fact explicitly equates the submitted
	// name with the node (for example, "Manchester United is also known as the
	// Red Devils"). Ordinary co-occurrence never emits this reason.
	"stored_alias_assertion",
]);

const NON_PERSISTABLE_ROLES = new Set(["comparison", "example", "option", "incidental_mention", "incidental"]);

const SYSTEM_PROMPT = `You are the semantic identity adviser for a manual memory save.
The submitted source was already structurally extracted. You receive candidate Node Context Cards identified only as N0 through N9.
Recommend whether each eligible entity should merge with one supplied card or be created as new.
Context similarity is not identity. Never invent a card reference. Never infer an identity from a shared topic, technology, relationship, page, cluster, or vector similarity alone.
Return strict JSON only:
{"identity_operations":[{"entity_ref":"E0","decision":"merge_existing|create_new","selected_ref":"N0|null","confidence":0.0,"reason_codes":[]}]}`;

function boundedText(value, max = 320) {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function boundedList(values, max, mapper = (value) => value) {
	return (Array.isArray(values) ? values : []).slice(0, max).map(mapper);
}

function safeCard(card = {}) {
	const ref = /^N[0-9]$/.test(String(card.ref ?? card.card_ref ?? ""))
		? String(card.ref ?? card.card_ref)
		: null;
	if (!ref) return null;
	const retrieval = card.retrieval ?? {};
	return {
		ref,
		entity_refs: boundedList(retrieval.entity_refs ?? card.entity_refs, 24, (value) => boundedText(value, 16))
			.filter((value) => /^E\d+$/.test(value)),
		label: boundedText(card.label, 120),
		category: boundedText(card.category, 40) || null,
		summary: boundedText(card.summary, 320) || null,
		aliases: boundedList(card.aliases, 8, (value) => boundedText(value, 120)).filter(Boolean),
		current_facts: boundedList(card.current_facts ?? card.facts, 5, (value) => boundedText(value?.text ?? value, 220)).filter(Boolean),
		relationships: boundedList(card.relationships, 5, (value) => ({
			type: boundedText(value?.type, 48),
			direction: value?.direction === "incoming" ? "incoming" : "outgoing",
			other_label: boundedText(value?.other_label ?? value?.label, 120),
		})),
		important_events: boundedList(card.important_events ?? card.events, 3, (value) => boundedText(value?.text ?? value, 220)).filter(Boolean),
		communities: boundedList(card.communities, 3, (value) => boundedText(value?.label ?? value, 120)).filter(Boolean),
		linked_pages: boundedList(card.linked_pages ?? card.pages, 3, (value) => boundedText(value?.title ?? value, 160)).filter(Boolean),
		retrieval: {
			identity_score: clampScore(retrieval.identity_score ?? card.identity_score),
			context_score: clampScore(retrieval.context_score ?? card.context_score),
			reason_codes: boundedList(retrieval.reason_codes ?? card.reason_codes, 16, (value) => boundedText(value, 64)).filter(Boolean),
		},
	};
}

function safeEntity(entity = {}) {
	return {
		ref: /^E\d+$/.test(String(entity.ref ?? "")) ? String(entity.ref) : null,
		label: boundedText(entity.label, 120),
		category: boundedText(entity.category, 40) || "other",
		mention_role: boundedText(entity.mention_role, 48) || null,
	};
}

function clampScore(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

/** Build the only payload the identity-adjudication model is allowed to see. */
export function buildManualAdjudicationPayload(structure = {}, cards = []) {
	const sourceClaims = [];
	const addClaim = (entityRefs, kind, value = {}) => {
		const refs = boundedList(entityRefs, 4, (ref) => String(ref)).filter((ref) => /^E\d+$/.test(ref));
		const claim = {
			entity_refs: refs,
			kind,
			text: boundedText(value?.memory?.text ?? value?.text ?? value?.current_text, 320),
			attribution: boundedText(value?.attribution, 32) || null,
			polarity: boundedText(value?.polarity, 16) || null,
			modality: boundedText(value?.modality, 16) || null,
			temporal_status: boundedText(value?.temporal_status, 24) || null,
		};
		if (refs.length && claim.text) sourceClaims.push(claim);
	};
	if (structure.primary_subject_ref && structure.primary_memory) {
		addClaim([structure.primary_subject_ref], "primary_memory", structure.primary_memory);
	}
	for (const fact of structure.facts ?? []) addClaim([fact.subject_ref], "fact", fact);
	for (const relationship of structure.relationships ?? []) {
		addClaim([relationship.from_ref, relationship.to_ref], "relationship", relationship);
	}
	for (const correction of structure.corrections ?? []) {
		addClaim([correction.subject_ref, correction.old_target_ref, correction.new_target_ref], "correction", correction);
	}
	return {
		entities: boundedList(structure.entities, 32, safeEntity).filter((entity) => entity.ref && entity.label),
		primary_subject_ref: /^E\d+$/.test(String(structure.primary_subject_ref ?? ""))
			? String(structure.primary_subject_ref)
			: null,
		source_claims: sourceClaims.slice(0, 40),
		cards: boundedList(cards, 10, safeCard).filter(Boolean),
	};
}

export function normalizeManualAdjudicationResponse(value) {
	const parsed = typeof value === "string" ? extractJson(value) : value;
	const operations = Array.isArray(parsed?.identity_operations) ? parsed.identity_operations : [];
	return {
		identity_operations: operations.slice(0, 32).map((operation) => ({
			entity_ref: /^E\d+$/.test(String(operation?.entity_ref ?? "")) ? String(operation.entity_ref) : null,
			decision: operation?.decision === "merge_existing" ? "merge_existing" : "create_new",
			selected_ref: /^N[0-9]$/.test(String(operation?.selected_ref ?? "")) ? String(operation.selected_ref) : null,
			confidence: clampScore(operation?.confidence),
			reason_codes: boundedList(operation?.reason_codes, 12, (item) => boundedText(item, 64)).filter(Boolean),
		})).filter((operation) => operation.entity_ref),
	};
}

function categoryCompatible(entity, card) {
	const wanted = canonicalizeCategory(entity?.category);
	const existing = canonicalizeCategory(card?.category);
	if (!wanted || !existing || wanted === "other" || existing === "other") return true;
	return wanted === existing;
}

function reasonSet(card) {
	return new Set(card?.retrieval?.reason_codes ?? []);
}

function hasExactIdentity(card) {
	const reasons = reasonSet(card);
	return [...EXACT_IDENTITY_REASONS].some((reason) => reasons.has(reason));
}

function compatibleSignalCount(card) {
	const reasons = reasonSet(card);
	let count = 0;
	for (const reason of SEMANTIC_IDENTITY_SIGNALS) if (reasons.has(reason)) count++;
	for (const reason of CONTEXTUAL_CORROBORATION_SIGNALS) if (reasons.has(reason)) count++;
	return count;
}

function hasSemanticIdentityEvidence(card) {
	const reasons = reasonSet(card);
	return [...SEMANTIC_IDENTITY_SIGNALS].some((reason) => reasons.has(reason));
}

function contextualCorroborationCount(card) {
	const reasons = reasonSet(card);
	let count = 0;
	for (const reason of CONTEXTUAL_CORROBORATION_SIGNALS) if (reasons.has(reason)) count++;
	return count;
}

function candidatesForEntity(entityRef, cards) {
	return cards.filter((card) => {
		const refs = Array.isArray(card.entity_refs)
			? card.entity_refs
			: Array.isArray(card.retrieval?.entity_refs)
				? card.retrieval.entity_refs
			: card.entity_ref
				? [card.entity_ref]
				: [];
		return refs.length === 0 || refs.includes(entityRef);
	});
}

function publicCandidate(card) {
	return {
		ref: card.ref,
		node_id: card._node_id ?? card.node_id ?? null,
		label: card.label,
		category: card.category ?? null,
		identity_score: clampScore(card.retrieval?.identity_score),
		context_score: clampScore(card.retrieval?.context_score),
		reason_codes: [...(card.retrieval?.reason_codes ?? [])],
	};
}

/**
 * Deterministic backend authority. The model may recommend a semantic alias, but
 * it cannot weaken exact-match, category, signal-count, shortlist, or margin rules.
 */
export function decideManualIdentity(entity, rawCards = [], recommendation = null) {
	const cards = candidatesForEntity(entity.ref, rawCards)
		.filter((card) => categoryCompatible(entity, card))
		.sort((left, right) =>
			clampScore(right.retrieval?.identity_score) - clampScore(left.retrieval?.identity_score) ||
			String(left.label).localeCompare(String(right.label)) ||
			String(left.ref).localeCompare(String(right.ref)));
	const incompatible = candidatesForEntity(entity.ref, rawCards).filter((card) => !categoryCompatible(entity, card));
	const exact = cards.filter(hasExactIdentity);
	if (exact.length > 1) {
		return {
			entity_ref: entity.ref,
			decision: "identity_conflict",
			confidence: 1,
			reason_codes: ["multiple_exact_identity_matches"],
			matches: exact.map(publicCandidate),
		};
	}
	if (exact.length === 1) {
		const result = {
			entity_ref: entity.ref,
			decision: "merge_existing",
			selected_ref: exact[0].ref,
			selected_node_id: exact[0]._node_id ?? exact[0].node_id ?? null,
			confidence: 1,
			reason_codes: ["authoritative_exact_identity"],
		};
		if (recommendation && (
			recommendation.decision !== "merge_existing" || recommendation.selected_ref !== exact[0].ref
		)) result.overridden_recommendation = recommendation;
		return result;
	}

	const best = cards[0] ?? null;
	const second = cards[1] ?? null;
	const bestScore = clampScore(best?.retrieval?.identity_score);
	const secondScore = clampScore(second?.retrieval?.identity_score);
	const lead = best ? bestScore - secondScore : 0;
	if (best && bestScore >= 0.94) {
		if (second && lead < 0.08) {
			return {
				entity_ref: entity.ref,
				decision: "identity_conflict",
				confidence: bestScore,
				reason_codes: ["identity_margin_too_small"],
				matches: cards.slice(0, 4).map(publicCandidate),
			};
		}
		const result = {
			entity_ref: entity.ref,
			decision: "merge_existing",
			selected_ref: best.ref,
			selected_node_id: best._node_id ?? best.node_id ?? null,
			confidence: bestScore,
			reason_codes: ["deterministic_name_identity"],
		};
		if (recommendation && (
			recommendation.decision !== "merge_existing" || recommendation.selected_ref !== best.ref
		)) result.overridden_recommendation = recommendation;
		return result;
	}
	if (best && second && bestScore >= 0.8 && secondScore >= 0.8 && lead < 0.08) {
		return {
			entity_ref: entity.ref,
			decision: "identity_conflict",
			confidence: bestScore,
			reason_codes: ["identity_margin_too_small"],
			matches: cards.slice(0, 4).map(publicCandidate),
		};
	}

	const recommended = recommendation?.decision === "merge_existing"
		? cards.find((card) => card.ref === recommendation.selected_ref)
		: null;
	if (recommendation?.decision === "merge_existing" && !recommended) {
		return {
			entity_ref: entity.ref,
			decision: "create_new",
			confidence: 1,
			reason_codes: ["unknown_or_out_of_shortlist_recommendation"],
			overridden_recommendation: recommendation,
		};
	}
	if (recommended) {
		const rivalScore = Math.max(0, ...cards.filter((card) => card.ref !== recommended.ref)
			.map((card) => Math.max(
				clampScore(card.retrieval?.identity_score),
				clampScore(card.retrieval?.context_score),
			)));
		const semanticAllowed = clampScore(recommendation.confidence) >= 0.95 &&
			hasSemanticIdentityEvidence(recommended) &&
			contextualCorroborationCount(recommended) >= 1 &&
			compatibleSignalCount(recommended) >= 2 &&
			!reasonSet(recommended).has("hard_name_contradiction") &&
			clampScore(recommendation.confidence) - rivalScore >= 0.08;
		if (semanticAllowed) {
			return {
				entity_ref: entity.ref,
				decision: "merge_existing",
				selected_ref: recommended.ref,
				selected_node_id: recommended._node_id ?? recommended.node_id ?? null,
				confidence: clampScore(recommendation.confidence),
				reason_codes: ["validated_semantic_alias"],
			};
		}
		return {
			entity_ref: entity.ref,
			decision: "create_new",
			confidence: 1,
			reason_codes: ["semantic_recommendation_failed_policy"],
			overridden_recommendation: recommendation,
		};
	}

	// Contextual evidence can rank a card but is intentionally powerless to merge.
	return {
		entity_ref: entity.ref,
		decision: "create_new",
		confidence: incompatible.length ? 0.98 : 1,
		reason_codes: incompatible.length ? ["category_incompatible_candidates"] : ["no_identity_evidence"],
	};
}

async function callAdjudicationModel(env, config, payload) {
	if (!env.AI || payload.cards.length === 0 || payload.entities.length === 0) return null;
	try {
		const response = await env.AI.run(
			config.llm.model,
			{
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: JSON.stringify(payload) },
				],
				temperature: 0,
				max_tokens: Math.min(Number(config.llm.maxTokens ?? 4096), 2048),
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		return normalizeManualAdjudicationResponse(responseText(response));
	} catch (error) {
		console.warn("manual identity adjudication failed:", error?.message ?? error);
		return null;
	}
}

export async function adjudicateManualIdentities(env, config, {
	structure = {},
	cards = [],
	candidatesByEntityRef = {},
	refMap = new Map(),
	adjudicationResponse,
} = {}) {
	const safePayload = buildManualAdjudicationPayload(structure, cards);
	const parsed = adjudicationResponse !== undefined
		? normalizeManualAdjudicationResponse(adjudicationResponse)
		: await callAdjudicationModel(env, config, safePayload);
	const recommendations = new Map((parsed?.identity_operations ?? [])
		.map((operation) => [operation.entity_ref, operation]));
	const decisions = [];
	const ignored_mentions = [];
	const overridden_recommendations = [];
	for (const entity of safePayload.entities) {
		if (NON_PERSISTABLE_ROLES.has(entity.mention_role)) {
			ignored_mentions.push({
				entity_ref: entity.ref,
				label: entity.label,
				mention_role: entity.mention_role,
				reason: "non_persistable_mention_role",
			});
			continue;
		}
		const cardNodeIds = new Map([...refMap.entries()].map(([ref, nodeId]) => [String(nodeId), ref]));
		const authorityCandidates = (candidatesByEntityRef?.[entity.ref] ?? []).map((candidate, index) => ({
			ref: cardNodeIds.get(String(candidate.node_id)) ?? `B${index}`,
			_node_id: candidate.node_id,
			label: candidate.label,
			category: candidate.category,
			entity_refs: [entity.ref],
			retrieval: {
				identity_score: candidate.identity_score,
				context_score: candidate.context_score,
				reason_codes: candidate.reason_codes ?? [],
			},
		}));
		const byNode = new Set(authorityCandidates.map((candidate) => String(candidate._node_id)));
		for (const card of cards) {
			const sanitized = safeCard(card);
			if (!sanitized) continue;
			const nodeId = refMap.get(card.ref) ?? null;
			if (nodeId && byNode.has(String(nodeId))) continue;
			authorityCandidates.push({ ...card, ...sanitized, _node_id: nodeId });
		}
		const decision = decideManualIdentity(entity, authorityCandidates, recommendations.get(entity.ref));
		decisions.push(decision);
		if (decision.overridden_recommendation) {
			overridden_recommendations.push({
				entity_ref: entity.ref,
				recommendation: decision.overridden_recommendation,
				reason_codes: decision.reason_codes,
			});
		}
	}
	return {
		decisions,
		ignored_mentions,
		overridden_recommendations,
		model_used: Boolean(parsed),
		model_payload: safePayload,
	};
}
