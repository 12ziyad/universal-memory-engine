import { newId } from "../lib/ids.js";
import { embed } from "../lib/embeddings.js";
import { normalizeLabel, tokens } from "../lib/text.js";
import { canonicalIdentity, manualIdentitySimilarity } from "./manual_identity.js";
import { buildFtsQuery } from "./manual_retrieval.js";
import { manualPageVectorNamespace } from "./manual_search_profiles.js";
import { sourceMeta } from "./source.js";
import { overlapRatio, topicSimilarity } from "./signals.js";
import {
	buildDeterministicManualPageFallback,
	isValidManualPageTitle,
	normalizePageSynthesis,
	renderManualPageMarkdown,
} from "./manual_page_synthesis.js";
import { canonicalTitle } from "./title.js";
import {
	buildPageDraft,
	isDuplicateCollect,
	mergePageDraft,
	suppressedBy,
} from "./pages.js";

export const MANUAL_PAGE_MATCH_MIN = 0.72;
export const MANUAL_PAGE_MATCH_MARGIN = 0.08;

const PAGE_RETRIEVAL_LIMIT = 20;

function safeJson(value, fallback) {
	try {
		const parsed = JSON.parse(value ?? "");
		return parsed && typeof parsed === "object" ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function uniqueTextItems(items, limit) {
	const seen = new Set();
	const output = [];
	for (const raw of items ?? []) {
		const item = typeof raw === "string" ? { text: raw, claim_ids: [] } : raw;
		const text = String(item?.text ?? "").replace(/\s+/g, " ").trim();
		const key = canonicalIdentity(text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		output.push({ ...item, text, claim_ids: unique(item?.claim_ids ?? item?.claimIds ?? []) });
		if (output.length >= limit) break;
	}
	return output;
}

function pageEvidence(existing, draft) {
	const values = [
		...(Array.isArray(existing?.evidence) ? existing.evidence : safeJson(existing?.evidence_json, [])),
		...(Array.isArray(draft?.evidence) ? draft.evidence : safeJson(draft?.evidence_json, [])),
	];
	const seen = new Set();
	return values.filter((item) => {
		const key = [item?.source_packet_id, item?.source_message_id, item?.content_hash, item?.snippet].join(":");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, 24);
}

function claimEvidenceMessages(claims = []) {
	const seen = new Set();
	const output = [];
	for (const claim of claims ?? []) {
		for (const span of claim?.evidence_spans ?? claim?.evidenceSpans ?? []) {
			const role = ["user", "assistant"].includes(span?.role) ? span.role : "user";
			const content = String(span?.quote ?? "").trim();
			const id = span?.source_message_id ?? span?.sourceMessageId ?? span?.message_ref ?? null;
			const key = `${role}:${id ?? ""}:${canonicalIdentity(content)}`;
			if (!content || seen.has(key)) continue;
			seen.add(key);
			output.push({ id, role, content, ts: span?.timestamp ?? null });
		}
	}
	return output;
}

function semanticDraft(base, result) {
	if (!result?.synthesis || result.valid !== true || result.writable === false) return base;
	return {
		...base,
		title: result.title,
		canonical_title: canonicalTitle(result.title),
		short_summary: result.short_summary,
		full_markdown: result.full_markdown,
		sections_json: result.sections_json,
		key_points_json: result.key_points_json,
		decisions_json: result.decisions_json,
		next_steps_json: result.next_steps_json,
		related_concepts_json: result.related_concepts_json,
		keyPoints: safeJson(result.key_points_json, []),
		decisions: safeJson(result.decisions_json, []),
		nextSteps: safeJson(result.next_steps_json, []),
		related: safeJson(result.related_concepts_json, []),
		quality_score: result.quality_score,
		retry_count: result.retry_count,
		synthesis_mode: result.synthesis_mode,
		quality_reason_codes: result.quality_reason_codes,
	};
}

function mergeSemanticDraft(existing, draft, result, corrections = []) {
	const oldSections = safeJson(existing?.sections_json, {});
	const newSections = safeJson(draft?.sections_json, {});
	const oldValues = (corrections ?? []).flatMap((correction) => [
		correction?.old_target?.label,
		correction?.old_value,
		correction?.old_text,
	]).map(canonicalIdentity).filter(Boolean);
	const keepCurrent = (item) => {
		const text = canonicalIdentity(typeof item === "string" ? item : item?.text);
		return !oldValues.some((oldValue) => text.includes(oldValue));
	};
	const existingTitleSupportedBy = [existing?.title, existing?.short_summary, existing?.key_points_json].join(" ");
	const title = isValidManualPageTitle(existing?.title, existingTitleSupportedBy)
		? existing.title
		: draft.title;
	const synthesis = normalizePageSynthesis({
		selected_title: title,
		title_candidates: unique([title, ...(result?.synthesis?.title_candidates ?? [])]),
		overview: (corrections.length
			? draft?.short_summary
			: [existing?.short_summary, draft?.short_summary].filter(Boolean).join(" "))
			.split(/\s+/).slice(0, 80).join(" "),
		key_facts: uniqueTextItems([
			...(oldSections.keyFacts ?? oldSections.keyPoints ?? safeJson(existing?.key_points_json, [])).filter(keepCurrent),
			...(newSections.keyFacts ?? newSections.keyPoints ?? []),
		], 10),
		decisions: uniqueTextItems([
			...(oldSections.decisions ?? safeJson(existing?.decisions_json, [])).filter(keepCurrent),
			...(newSections.decisions ?? []),
		], 8),
		current_state: uniqueTextItems([...(oldSections.currentState ?? []).filter(keepCurrent), ...(newSections.currentState ?? [])], 8),
		next_steps: uniqueTextItems([
			...(oldSections.nextSteps ?? safeJson(existing?.next_steps_json, [])).filter(keepCurrent),
			...(newSections.nextSteps ?? []),
		], 8),
		open_questions: uniqueTextItems([...(oldSections.openQuestions ?? []), ...(newSections.openQuestions ?? [])], 8),
		historical_context: uniqueTextItems([...(oldSections.historicalContext ?? []), ...(newSections.historicalContext ?? [])], 8),
		related_entities: unique([
			...(oldSections.relatedEntities ?? oldSections.relatedConcepts ?? safeJson(existing?.related_concepts_json, [])),
			...(newSections.relatedEntities ?? newSections.relatedConcepts ?? []),
		]).slice(0, 12),
	});
	const evidence = pageEvidence(existing, draft);
	const quality = result?.sections?.quality ?? newSections.quality ?? {};
	const sections = {
		overview: synthesis.overview,
		keyFacts: synthesis.key_facts,
		decisions: synthesis.decisions,
		currentState: synthesis.current_state,
		nextSteps: synthesis.next_steps,
		openQuestions: synthesis.open_questions,
		historicalContext: synthesis.historical_context,
		relatedEntities: synthesis.related_entities,
		claimFingerprints: unique([
			...(oldSections.claimFingerprints ?? []),
			...(newSections.claimFingerprints ?? []),
		]),
		quality,
	};
	return {
		...draft,
		id: existing.id,
		title,
		canonical_title: canonicalTitle(title),
		short_summary: synthesis.overview.slice(0, 700),
		full_markdown: renderManualPageMarkdown(synthesis),
		sections_json: JSON.stringify(sections),
		key_points_json: JSON.stringify(unique([
			...synthesis.key_facts.map((item) => item.text),
			...synthesis.current_state.map((item) => item.text),
		]).slice(0, 10)),
		decisions_json: JSON.stringify(synthesis.decisions.map((item) => item.text)),
		next_steps_json: JSON.stringify(synthesis.next_steps.map((item) => item.text)),
		related_concepts_json: JSON.stringify(synthesis.related_entities),
		evidence_json: JSON.stringify(evidence),
		evidence,
		keyPoints: synthesis.key_facts.map((item) => item.text),
		decisions: synthesis.decisions.map((item) => item.text),
		nextSteps: synthesis.next_steps.map((item) => item.text),
		related: synthesis.related_entities,
	};
}

function clamp(value, min = 0, max = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) return min;
	return Math.max(min, Math.min(max, number));
}

function unique(values) {
	return [...new Set((values ?? []).filter(Boolean))];
}

function placeholders(values) {
	return values.map(() => "?").join(", ");
}

function stableTopic(value) {
	return canonicalIdentity(value);
}

function validatedSemanticKey(draft) {
	const value = canonicalIdentity(draft?.canonical_title || draft?.title);
	if (!value || value === "memory research" || value === "memory research session") return null;
	if (!tokens(value).some((token) => token.length >= 3)) return null;
	return `semantic:${value}`;
}

/**
 * Stable MCP-manual page identity keys, in authority order. An explicit
 * separate-page request receives only a source-scoped key, so it cannot steal a
 * canonical node/topic claim from the existing default page.
 */
export function manualPageClaimKeys(draft, input = {}) {
	const nodeId = String(input.primaryNodeId ?? draft?.node_id ?? "").trim();
	// A newly allocated graph UUID is provisional until its canonical node claim
	// wins the atomic write. It must not partition concurrent page claims. Use the
	// stable topic/semantic key for that first write; a later reinforcement can add
	// canonical node keys after the node is durable.
	const canonicalNodeId = input.primaryNodeIsNew ? "" : nodeId;
	const topic = stableTopic(draft?.topic_filter ?? input.intent?.topic);
	const semantic = validatedSemanticKey(draft);
	const canonical = unique([
		canonicalNodeId && topic ? `node:${canonicalNodeId}:topic:${topic}` : null,
		canonicalNodeId ? `node:${canonicalNodeId}` : null,
		topic ? `topic:${topic}` : null,
		semantic,
	]);
	if (!input.intent?.explicitNew) return canonical;
	const sourceKey = String(
		input.sourcePacket?.id ?? input.sourcePacket?.source_packet_id ??
		input.sourcePacket?.content_hash ?? draft?.input_hash ?? draft?.id,
	).trim();
	const base = canonical[0] ?? semantic ?? `semantic:${canonicalIdentity(draft?.id)}`;
	return [`${base}:separate:${sourceKey}`];
}

async function getManualPageState(env, userId, claimKeys = []) {
	const now = Date.now();
	const identitySql = claimKeys.length
		? `SELECT canonical_key, page_id FROM manual_page_identities
		   WHERE user_id = ? AND canonical_key IN (${placeholders(claimKeys)})
		   ORDER BY canonical_key, page_id`
		: `SELECT canonical_key, page_id FROM manual_page_identities WHERE user_id = ? AND 0`;
	const identityBindings = claimKeys.length ? [userId, ...claimKeys] : [userId];
	const [pagesResult, epochResult, suppressionsResult, identitiesResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT page.*, COALESCE(version.revision, 0) AS manual_page_version,
				COALESCE((
				 SELECT json_group_array(identity.canonical_key)
				 FROM manual_page_identities AS identity
				 WHERE identity.user_id = page.user_id AND identity.page_id = page.id
				), '[]') AS manual_identity_keys_json
			 FROM memory_pages AS page
			 LEFT JOIN manual_page_versions AS version
				ON version.user_id = page.user_id AND version.page_id = page.id
			 WHERE page.user_id = ?
			   AND page.deleted_at IS NULL
			   AND page.archived_at IS NULL
			   AND page.suppressed_at IS NULL
			 ORDER BY page.id`,
		).bind(userId),
		env.DB.prepare("SELECT epoch FROM manual_page_write_epochs WHERE user_id = ?").bind(userId),
		env.DB.prepare(
			`SELECT * FROM memory_suppressions
			 WHERE user_id = ? AND (suppressed_until IS NULL OR suppressed_until > ?)`,
		).bind(userId, now),
		env.DB.prepare(identitySql).bind(...identityBindings),
	]);
	return {
		pages: pagesResult.results ?? [],
		writeEpoch: Number((epochResult.results ?? [])[0]?.epoch ?? 0),
		suppressions: suppressionsResult.results ?? [],
		identities: identitiesResult?.results ?? [],
	};
}

function pageMatchPayload(page) {
	return {
		title: page?.title,
		topic: page?.topic_filter,
		summary: page?.short_summary,
		text: [page?.full_markdown, page?.key_points_json, page?.decisions_json, page?.related_concepts_json]
			.filter(Boolean)
			.join("\n"),
	};
}

function titleSimilarity(left, right) {
	const a = normalizeLabel(left);
	const b = normalizeLabel(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return 0.82;
	return overlapRatio(tokens(a), tokens(b));
}

function identityHintScore(page, hints = []) {
	let score = 0;
	for (const hint of hints ?? []) {
		for (const name of [hint?.label, ...(hint?.aliases ?? [])].filter(Boolean)) {
			score = Math.max(
				score,
				manualIdentitySimilarity(name, page?.title),
				manualIdentitySimilarity(name, page?.canonical_title),
				manualIdentitySimilarity(name, page?.topic_filter),
			);
		}
	}
	return score;
}

function blankSignals() {
	return { bm25: 0, vector: 0, graph: 0, community: 0 };
}

function normalizeBm25(rows = []) {
	if (!rows.length) return rows;
	const relevance = rows.map((row) => -Number(row.lexical_rank ?? 0));
	const min = Math.min(...relevance);
	const max = Math.max(...relevance);
	return rows.map((row, index) => ({
		...row,
		score: max > min ? (relevance[index] - min) / (max - min) : 1,
	}));
}

async function bm25PageSignals(env, userId, queryText) {
	const query = buildFtsQuery(queryText);
	if (!query) return { scores: new Map(), warnings: [] };
	try {
		const { results } = await env.DB.prepare(
			`SELECT profile.object_id AS page_id,
				bm25(manual_search_fts, 6.0, 2.5, 1.0) AS lexical_rank
			 FROM manual_search_fts
			 JOIN manual_search_profiles AS profile ON profile.rowid = manual_search_fts.rowid
			 WHERE manual_search_fts MATCH ?
			   AND profile.user_id = ? AND profile.object_kind = 'page'
			 ORDER BY lexical_rank ASC, profile.object_id
			 LIMIT ?`,
		).bind(query, userId, PAGE_RETRIEVAL_LIMIT).all();
		return {
			scores: new Map(normalizeBm25(results ?? []).map((row) => [row.page_id, clamp(row.score)])),
			warnings: [],
		};
	} catch (error) {
		return { scores: new Map(), warnings: [`page_bm25_failed:${String(error?.message ?? error)}`] };
	}
}

async function vectorPageSignals(env, config, userId, queryText) {
	if (!config?.useVectors || !env.VECTORIZE) return { scores: new Map(), warnings: [] };
	const values = await embed(env, config, queryText);
	if (!values) return { scores: new Map(), warnings: [] };
	try {
		const namespace = await manualPageVectorNamespace(userId);
		const result = await env.VECTORIZE.query(values, {
			topK: PAGE_RETRIEVAL_LIMIT,
			namespace,
			returnMetadata: "none",
		});
		const scores = new Map();
		for (const match of result?.matches ?? []) {
			const id = String(match?.id ?? "");
			if (!id.startsWith("page:")) continue;
			scores.set(id.slice(5), Math.max(scores.get(id.slice(5)) ?? 0, clamp(match.score)));
		}
		return { scores, warnings: [] };
	} catch (error) {
		return { scores: new Map(), warnings: [`page_vector_failed:${String(error?.message ?? error)}`] };
	}
}

async function graphPageSignals(env, userId, primaryNodeId) {
	if (!primaryNodeId) return { graph: new Set(), community: new Set(), warnings: [] };
	try {
		const [graphResult, communityResult] = await env.DB.batch([
			env.DB.prepare(
				`SELECT DISTINCT page.id AS page_id
				 FROM edges AS edge
				 JOIN memory_pages AS page
				  ON page.user_id = edge.user_id
				 AND page.node_id = CASE WHEN edge.from_node = ? THEN edge.to_node ELSE edge.from_node END
				 WHERE edge.user_id = ? AND edge.deleted_at IS NULL
				   AND (edge.from_node = ? OR edge.to_node = ?)
				   AND page.deleted_at IS NULL AND page.archived_at IS NULL AND page.suppressed_at IS NULL`,
			).bind(primaryNodeId, userId, primaryNodeId, primaryNodeId),
			env.DB.prepare(
				`SELECT DISTINCT page.id AS page_id
				 FROM node_topic_communities AS seed
				 JOIN node_topic_communities AS peer
				  ON peer.user_id = seed.user_id AND peer.community_id = seed.community_id
				 JOIN memory_pages AS page
				  ON page.user_id = peer.user_id AND page.node_id = peer.node_id
				 WHERE seed.user_id = ? AND seed.node_id = ?
				   AND page.deleted_at IS NULL AND page.archived_at IS NULL AND page.suppressed_at IS NULL`,
			).bind(userId, primaryNodeId),
		]);
		return {
			graph: new Set((graphResult.results ?? []).map((row) => row.page_id)),
			community: new Set((communityResult.results ?? []).map((row) => row.page_id)),
			warnings: [],
		};
	} catch (error) {
		return {
			graph: new Set(),
			community: new Set(),
			warnings: [`page_graph_context_failed:${String(error?.message ?? error)}`],
		};
	}
}

async function retrieveManualPageSignals(env, config, userId, input, draft) {
	const queryText = String(input.queryText ?? [draft.title, draft.topic_filter, input.digest].filter(Boolean).join("\n")).slice(0, 12000);
	const [bm25, vector, graph] = await Promise.all([
		bm25PageSignals(env, userId, queryText),
		vectorPageSignals(env, config, userId, queryText),
		graphPageSignals(env, userId, input.primaryNodeId),
	]);
	const byPage = new Map();
	const ensure = (id) => {
		if (!byPage.has(id)) byPage.set(id, blankSignals());
		return byPage.get(id);
	};
	for (const [id, score] of bm25.scores) ensure(id).bm25 = score;
	for (const [id, score] of vector.scores) ensure(id).vector = score;
	for (const id of graph.graph) ensure(id).graph = 1;
	for (const id of graph.community) ensure(id).community = 1;
	return {
		byPage,
		warnings: unique([...bm25.warnings, ...vector.warnings, ...graph.warnings]),
		signalsUsed: unique([
			bm25.scores.size && "bm25",
			vector.scores.size && "vector",
			graph.graph.size && "graph",
			graph.community.size && "community",
		]),
	};
}

/** Score page context without treating lexical/semantic similarity as identity. */
export function scoreManualPageCandidate(page, draft, input = {}, retrievalSignals = {}) {
	const primaryNodeId = String(input.primaryNodeId ?? "");
	const topic = stableTopic(draft?.topic_filter);
	const pageTopic = stableTopic(page?.topic_filter);
	const sameNode = Boolean(primaryNodeId && page?.node_id === primaryNodeId);
	const nodeConflict = Boolean(primaryNodeId && page?.node_id && page.node_id !== primaryNodeId);
	const sameTopic = Boolean(topic && pageTopic && topic === pageTopic);
	const topicConflict = Boolean(topic && pageTopic && topic !== pageTopic);
	const sameThread = Boolean(draft?.source_thread_id && page?.source_thread_id === draft.source_thread_id);
	const sameConversation = Boolean(
		input.conversationId && page?.source_conversation_id === input.conversationId,
	);
	const semantic = topicSimilarity(pageMatchPayload(page), pageMatchPayload(draft));
	const titleScore = Math.max(
		titleSimilarity(page?.title, draft?.title),
		titleSimilarity(page?.canonical_title, draft?.canonical_title),
	);
	const hintScore = identityHintScore(page, input.identityHints);
	const clusterCompatible = !page?.cluster || !draft?.cluster || page.cluster === draft.cluster ||
		page.cluster === "general_memory" || draft.cluster === "general_memory" ||
		page.cluster === "unclustered" || draft.cluster === "unclustered";
	let score =
		(sameNode ? 0.44 : 0) +
		(sameTopic ? 0.42 : 0) +
		(sameThread ? 0.18 : 0) +
		// A canonical topic inside the exact same conversation is a strong legacy
		// page-continuity signal. This keeps MCP page-only task updates attached to
		// an existing /v1/save page even when no graph identity is appropriate.
		(sameConversation ? 0.26 : 0) +
		clamp(semantic.score) * 0.26 +
		clamp(titleScore) * 0.12 +
		clamp(hintScore) * 0.10 +
		clamp(retrievalSignals.bm25) * 0.20 +
		clamp(retrievalSignals.vector) * 0.18 +
		clamp(retrievalSignals.graph) * 0.08 +
		clamp(retrievalSignals.community) * 0.08 +
		(clusterCompatible ? 0.04 : -0.08);
	if (topicConflict) score -= 0.28;
	if (nodeConflict) score -= 0.32;
	score = Number(clamp(score).toFixed(4));
	return {
		page,
		score,
		compatible: !topicConflict && !nodeConflict,
		authoritative_node: sameNode,
		reason_codes: unique([
			sameNode && "primary_node_exact",
			sameTopic && "topic_exact",
			sameThread && "source_thread_exact",
			sameConversation && "conversation_exact",
			retrievalSignals.bm25 > 0 && "bm25",
			retrievalSignals.vector > 0 && "vector",
			retrievalSignals.graph > 0 && "graph_neighbor",
			retrievalSignals.community > 0 && "topic_community",
			semantic.score > 0 && "semantic_context",
			titleScore > 0 && "title_similarity",
			hintScore > 0 && "subject_similarity",
		]),
	};
}

/** Rerank without recency: equal inputs always resolve by stable page id. */
export function rankManualPageCandidates(pages, draft, input = {}, retrieval = { byPage: new Map() }) {
	return (pages ?? [])
		.filter((page) => page.source_mode === "manual_collect")
		.map((page) => scoreManualPageCandidate(page, draft, input, retrieval.byPage?.get(page.id) ?? blankSignals()))
		.filter((candidate) => candidate.compatible)
		.sort((left, right) => right.score - left.score || String(left.page.id).localeCompare(String(right.page.id)));
}

/** A compatible fuzzy winner must clear both the absolute threshold and lead. */
export function manualPageRankingIsAmbiguous(candidates = [], { authoritative = false } = {}) {
	const first = candidates[0] ?? null;
	const second = candidates[1] ?? null;
	if (!first || !second) return false;
	if (!authoritative && first.score < MANUAL_PAGE_MATCH_MIN) return false;
	const lead = Number((first.score - second.score).toFixed(4));
	return lead < MANUAL_PAGE_MATCH_MARGIN;
}

function conflictResult(draft, candidates, reason = "multiple_existing_pages_match") {
	return {
		action: "ambiguous",
		page: draft,
		write: false,
		reason,
		page_conflicts: candidates.slice(0, 4).map((item) => ({
			id: item.page?.id ?? item.page_id ?? null,
			title: item.page?.title ?? item.title ?? null,
			score: item.score ?? 1,
			reason_codes: item.reason_codes ?? ["manual_page_identity_claim"],
		})),
		newPages: [],
		pageUpdates: [],
		pageClaims: [],
		skipped: [{ kind: "memory_page", label: draft.title, reason }],
	};
}

function exactClaimResolution(state, claimKeys) {
	const pageById = new Map(state.pages
		.filter((page) => page.source_mode === "manual_collect")
		.map((page) => [page.id, page]));
	const matches = [];
	for (const key of claimKeys) {
		const claim = state.identities.find((item) => item.canonical_key === key);
		if (!claim) continue;
		matches.push({ key, claim, page: pageById.get(claim.page_id) ?? null });
	}
	if (!matches.length) return { decision: "none" };
	const owners = unique(matches.map((item) => item.claim.page_id));
	if (owners.length > 1 || !matches[0].page) return { decision: "ambiguous", matches };
	return { decision: "existing", page: matches[0].page, key: matches[0].key, matches };
}

function claimsForMatch(state, claimKeys, pageId, writeEpoch, now) {
	return claimKeys
		.filter((key) => {
			const owner = state.identities.find((item) => item.canonical_key === key)?.page_id;
			return !owner || owner === pageId;
		})
		.map((identityKey) => ({
			identity_key: identityKey,
			page_id: pageId,
			created_at: now,
			expected_write_epoch: writeEpoch,
		}));
}

/** Plan one manual conversation page without writing or creating a receipt. */
export async function buildManualPagePlan(env, userId, input = {}) {
	const source = sourceMeta(input.sourcePacket);
	const userMessages = (input.messages ?? []).filter((message) => (message?.role ?? "user") === "user");
	const evidenceMessages = claimEvidenceMessages(input.claims);
	const groundedMessages = evidenceMessages.length ? evidenceMessages : userMessages;
	let semanticSynthesis = input.semanticSynthesis ?? null;
	if (semanticSynthesis && (semanticSynthesis.valid !== true || semanticSynthesis.writable === false)) {
		semanticSynthesis = buildDeterministicManualPageFallback(input.claims ?? [], {
			subject: input.resolvedScope?.subject ?? null,
			topic: input.intent?.topic ?? null,
			preferredTitle: input.preferredTitle ?? null,
			resolvedScope: input.resolvedScope ?? {},
			sourceMessages: groundedMessages,
			retryCount: semanticSynthesis.retry_count ?? 1,
			priorFailures: semanticSynthesis.quality_reason_codes ?? ["page_synthesis_invalid"],
		});
	}
	const groundedSourcePacket = input.sourcePacket
		? { ...input.sourcePacket, messages: groundedMessages }
		: null;
	const draft = semanticDraft({
		...buildPageDraft({
			digest: input.digest,
			messages: groundedMessages,
			intent: input.intent,
			conversationId: input.conversationId,
			extractionRunId: input.runId,
			// The receipt is persisted after the atomic page+graph write. Do not put a
			// preallocated, potentially unstored receipt id into the page or evidence.
			receiptId: null,
			fallbackReceiptToRun: false,
			preferredTitle: input.preferredTitle,
			corrections: input.corrections,
			sourcePacket: groundedSourcePacket,
		}),
		node_id: input.primaryNodeId ?? null,
		source_thread_id: input.sourcePacket?.thread_id ?? null,
		scope_json: source.scope_json ?? null,
	}, semanticSynthesis);
	const claimKeys = manualPageClaimKeys(draft, input);
	draft.identity_key = claimKeys[0] ?? validatedSemanticKey(draft) ?? canonicalIdentity(draft.id);

	// Pages, write epoch, suppression policy, and relevant canonical claims share
	// one D1 snapshot. The later write epoch and identity claim guards decide races.
	const state = await getManualPageState(env, userId, claimKeys);
	const { pages, writeEpoch, suppressions } = state;
	const suppression = suppressedBy(suppressions, "memory_page", draft.canonical_title)
		?? (draft.topic_filter ? suppressedBy(suppressions, "memory_page", draft.topic_filter) : null);
	if (suppression) {
		return {
			action: "suppressed",
			page: draft,
			write: false,
			reason: "suppressed_blocked",
			skipped: [{ kind: "memory_page", label: draft.title, reason: "suppressed_blocked" }],
		};
	}

	// Exact retry is always first, including when the repeated call says
	// "separate page". Retries are idempotency, not page-identity decisions.
	const exactRetries = pages
		.filter((page) => page.source_mode === "manual_collect" && isDuplicateCollect(page, draft, input.sourcePacket))
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));
	const exactRetry = exactRetries[0] ?? null;
	if (exactRetry) {
		return {
			action: "duplicate",
			page: {
				...draft,
				id: exactRetry.id,
				node_id: exactRetry.node_id ?? draft.node_id,
				title: exactRetry.title || draft.title,
				canonical_title: exactRetry.canonical_title || draft.canonical_title,
			},
			match: exactRetry,
			write: false,
			reason: "duplicate_memory_page",
			skipped: [{ kind: "memory_page", id: exactRetry.id, label: exactRetry.title, reason: "duplicate_memory_page" }],
		};
	}

	// A failed semantic quality gate never falls through to the legacy raw digest
	// renderer. The claim-only recovery above is mandatory; suppression here now
	// means the authoritative claim set itself was empty, malformed, contradictory,
	// or otherwise genuinely unsafe to persist.
	if (semanticSynthesis && (
		semanticSynthesis.valid !== true || semanticSynthesis.writable === false
	)) {
		return {
			action: "suppressed",
			page: draft,
			write: false,
			reason: "page_synthesis_invalid",
			quality_score: semanticSynthesis.quality_score ?? 0,
			retry_count: semanticSynthesis.retry_count ?? 0,
			synthesis_mode: semanticSynthesis.synthesis_mode ?? null,
			quality_reason_codes: semanticSynthesis.quality_reason_codes ?? ["page_synthesis_invalid"],
			newPages: [],
			pageUpdates: [],
			pageClaims: [],
			skipped: [{ kind: "memory_page", label: draft.title, reason: "page_synthesis_invalid" }],
		};
	}

	// A deliberate separate-page request bypasses every canonical/fuzzy match.
	let match = null;
	let identityScore = null;
	let identityReasonCodes = [];
	let retrieval = { byPage: new Map(), warnings: [], signalsUsed: [] };
	if (!input.intent?.explicitNew) {
		const claimResolution = exactClaimResolution(state, claimKeys);
		if (claimResolution.decision === "ambiguous") {
			return conflictResult(draft, claimResolution.matches.map((item) => ({
				page: item.page ?? { id: item.claim.page_id, title: null },
				score: 1,
				reason_codes: [item.page ? "conflicting_page_identity_claim" : "stale_page_identity_claim"],
			})), "page_identity_claim_conflict");
		}
		if (claimResolution.decision === "existing") {
			if (
				input.primaryNodeId && claimResolution.page.node_id &&
				claimResolution.page.node_id !== input.primaryNodeId
			) {
				return conflictResult(draft, [{
					page: claimResolution.page,
					score: 1,
					reason_codes: ["page_identity_claim_node_conflict"],
				}], "page_identity_claim_node_conflict");
			}
			match = claimResolution.page;
			identityScore = 1;
			identityReasonCodes = ["manual_page_identity_claim", claimResolution.key];
		}

		if (!match) {
			retrieval = await retrieveManualPageSignals(env, input.config, userId, input, draft);
			const ranked = rankManualPageCandidates(pages, draft, input, retrieval);
			const nodeRanked = input.primaryNodeId
				? ranked.filter((candidate) => candidate.authoritative_node)
				: [];
			const authoritative = nodeRanked.length ? nodeRanked : null;
			const candidates = authoritative ?? ranked;
			const first = candidates[0] ?? null;
			const close = manualPageRankingIsAmbiguous(candidates, { authoritative: Boolean(authoritative) });
			if (close) return {
				...conflictResult(draft, candidates),
				retrieval: {
					signals_used: retrieval.signalsUsed,
					warnings: retrieval.warnings,
				},
			};
			if (first && (authoritative || first.score >= MANUAL_PAGE_MATCH_MIN)) {
				match = first.page;
				identityScore = first.score;
				identityReasonCodes = first.reason_codes;
			}
		}
	}

	const now = Date.now();
	if (match) {
		const action = input.corrections?.length || input.intent?.updateRequested ? "updated" : "reinforced";
		const page = semanticSynthesis
			? mergeSemanticDraft(match, draft, semanticSynthesis, input.corrections)
			: mergePageDraft(match, draft, {
			// Existing valid titles are byte-for-byte stable across all identity paths.
			preferDraftTitle: false,
			corrections: input.corrections,
			});
		page.node_id = match.node_id ?? input.primaryNodeId ?? null;
		page.source_thread_id = match.source_thread_id ?? draft.source_thread_id ?? null;
		const expectedRevision = Number(match.manual_page_version ?? 0);
		return {
			action,
			page,
			match,
			write: true,
			identity_score: identityScore,
			identity_reason_codes: identityReasonCodes,
			retrieval: {
				signals_used: retrieval.signalsUsed,
				warnings: retrieval.warnings,
			},
			quality_score: semanticSynthesis?.quality_score ?? null,
			retry_count: semanticSynthesis?.retry_count ?? 0,
			synthesis_mode: semanticSynthesis?.synthesis_mode ?? "deterministic_legacy",
			quality_reason_codes: semanticSynthesis?.quality_reason_codes ?? [],
			pageUpdates: [{
				page,
				conversationId: input.conversationId,
				runId: input.runId,
				now,
				expected_revision: expectedRevision,
				expected_updated_at: match.updated_at ?? null,
				expected_input_hash: match.input_hash ?? null,
				expected_write_epoch: writeEpoch,
				write_token: newId("page_write"),
			}],
			pageClaims: claimsForMatch(state, claimKeys, page.id, writeEpoch, now),
			newPages: [],
			skipped: [],
		};
	}

	const page = {
		...draft,
		created_at: now,
		updated_at: now,
		last_seen_at: now,
		heat_score: 1,
	};
	return {
		action: "created",
		page,
		write: true,
		identity_score: null,
		identity_reason_codes: [input.intent?.explicitNew ? "explicit_separate_page" : "new_page_identity"],
		retrieval: {
			signals_used: retrieval.signalsUsed,
			warnings: retrieval.warnings,
		},
		quality_score: semanticSynthesis?.quality_score ?? null,
		retry_count: semanticSynthesis?.retry_count ?? 0,
		synthesis_mode: semanticSynthesis?.synthesis_mode ?? "deterministic_legacy",
		quality_reason_codes: semanticSynthesis?.quality_reason_codes ?? [],
		newPages: [page],
		pageUpdates: [],
		// The first key guards creation; the atomic writer learns each additional
		// compatible key only after that page exists. Provisional-node keys were
		// already excluded by manualPageClaimKeys and can be learned later.
		pageClaims: claimKeys.map((identityKey) => ({
			identity_key: identityKey,
			page_id: page.id,
			created_at: now,
			expected_write_epoch: writeEpoch,
		})),
		skipped: [],
	};
}
