import { getConfig } from "../config.js";
import { createExtractionRun } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { digestConversation } from "./digest.js";
import { adjudicateManualIdentities } from "./manual_adjudicate.js";
import { extractManualFacts } from "./manual_extract.js";
import { applyManualIntegrity } from "./manual_integrity.js";
import { canonicalIdentity } from "./manual_identity.js";
import { buildManualPagePlan } from "./manual_page.js";
import { buildManualConversationClaims } from "./manual_conversation_scope.js";
import { synthesizeManualPage } from "./manual_page_synthesis.js";
import { buildManualGraphPlan, loadManualPlanningState } from "./manual_plan.js";
import { refineManualIdentityTitles } from "./manual_titles.js";
import { retrieveManualContext } from "./manual_retrieval.js";
import { refreshManualSearchProfiles } from "./manual_search_profiles.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { filterDigestByTopic, parseCollectIntent } from "./pages.js";
import {
	normalizeSourcePacket,
	sourceMeta,
	storeSourcePacket,
} from "./source.js";
import { classifyMessage } from "./trigger.js";
import { writeApproved } from "./write.js";

const GRAPH_PLAN_FIELDS = [
	"newNodes",
	"nodeStateUpdates",
	"nodeTouches",
	"nodeAliasUpdates",
	"nodeAliasAdds",
	"nodeSummaryUpdates",
	"identityClaims",
	"primaryIdentityClaims",
	"aliasIdentityClaims",
	"correctionGuards",
	"sliceSupersede",
	"newSlices",
	"sliceTouches",
	"newEvents",
	"eventTouches",
	"newEdges",
	"edgeTouches",
	"edgeSupersede",
	"newCandidates",
	"candidateBumps",
	"candidateResolutions",
	"topicCommunityMemberships",
];

function emptySaved() {
	return {
		pages: 0,
		nodes: 0,
		newNodeLabels: [],
		updatedNodes: 0,
		slices: 0,
		supersededSlices: 0,
		events: 0,
		edges: 0,
		supersededEdges: 0,
		candidates: 0,
		reinforcedSlices: 0,
		reinforcedEvents: 0,
		reinforcedEdges: 0,
		resolvedCandidates: 0,
	};
}

function skippedReasons(items = []) {
	const reasons = {};
	for (const item of items) {
		const reason = item?.reason ?? "skipped";
		reasons[reason] = (reasons[reason] ?? 0) + Number(item?.count ?? 1);
	}
	return reasons;
}

function uniqueNodeTouches(plan) {
	return [...new Set((plan?.nodeTouches ?? []).map((touch) => touch?.id ?? touch).filter(Boolean))];
}

function pageActionLists(pagePlan) {
	if (!pagePlan?.page) return { createdPages: [], updatedPages: [], reinforcedPages: [] };
	const item = { id: pagePlan.page.id, title: pagePlan.page.title };
	return {
		createdPages: pagePlan.action === "created" ? [item] : [],
		updatedPages: pagePlan.action === "updated" ? [item] : [],
		reinforcedPages: pagePlan.action === "reinforced" ? [item] : [],
	};
}

function jsonArrayLength(value) {
	if (Array.isArray(value)) return value.length;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}

function canonicalPageAction(action) {
	return ({
		created: "create",
		updated: "update",
		reinforced: "reinforce",
		duplicate: "duplicate",
		ambiguous: "page_conflict",
		conflict: "page_conflict",
		suppressed: "suppressed",
		skipped: "skipped",
	})[action] ?? action ?? null;
}

function buildManualReceipt({
	id,
	source,
	sourceMode,
	sourcePacket,
	runId = null,
	plan = null,
	pagePlan = null,
	received = 1,
	digested = null,
	outcome,
	reason = null,
	forceZero = false,
}) {
	const graph = plan ?? {};
	const committedGraph = forceZero
		? Object.fromEntries(Object.entries(graph).map(([key, value]) =>
			[GRAPH_PLAN_FIELDS.includes(key) ? key : key, GRAPH_PLAN_FIELDS.includes(key) ? [] : value]))
		: graph;
	const pageWritten = Boolean(pagePlan?.write && !forceZero);
	const saved = forceZero ? emptySaved() : {
		pages: pageWritten ? 1 : 0,
		nodes: (committedGraph.newNodes ?? []).length,
		newNodeLabels: (committedGraph.newNodes ?? []).map((node) => node.label),
		updatedNodes: uniqueNodeTouches(committedGraph).length,
		slices: (committedGraph.newSlices ?? []).length,
		supersededSlices: (committedGraph.sliceSupersede ?? []).length,
		events: (committedGraph.newEvents ?? []).length,
		edges: (committedGraph.newEdges ?? []).length,
		supersededEdges: (committedGraph.edgeSupersede ?? []).length,
		candidates: 0,
		reinforcedSlices: (committedGraph.sliceTouches ?? []).length,
		reinforcedEvents: (committedGraph.eventTouches ?? []).length,
		reinforcedEdges: (committedGraph.edgeTouches ?? []).length,
		resolvedCandidates: (committedGraph.candidateResolutions ?? []).length,
	};
	const savedTotal = Object.entries(saved)
		.filter(([key]) => key !== "newNodeLabels" && key !== "candidates")
		.reduce((total, [, value]) => total + Number(value ?? 0), 0);
	const skipped = [
		...(graph.rejected ?? []),
		...(pagePlan?.skipped ?? []),
	];
	const pageActions = pageActionLists(pagePlan);
	const retrieval = graph.retrieval ?? {
		broad_pool_count: 0,
		card_count: 0,
		signals_used: [],
		warnings: [],
	};
	const persistenceFailures = forceZero ? [] : (graph.persistenceFailures ?? graph.persistence_failures ?? []);
	const pageEvidenceCount = jsonArrayLength(pagePlan?.page?.evidence_json);
	const priorPageEvidenceCount = jsonArrayLength(pagePlan?.match?.evidence_json);
	return {
		id,
		outcome,
		reason,
		source,
		source_mode: sourceMode,
		manual: true,
		final: true,
		processing: false,
		durable: savedTotal > 0,
		extraction_run_id: runId,
		...sourceMeta(sourcePacket),
		received,
		digested,
		page_action: pagePlan?.action ?? null,
		saved,
		savedTotal,
		skipped: skipped.length,
		skippedReasons: skippedReasons(skipped),
		identity_decisions: graph.identityDecisions ?? [],
		identity_conflicts: graph.conflicts ?? [],
		primary_subject: graph.primarySubject ?? null,
		resolved_scope: graph.resolvedScope ?? pagePlan?.resolved_scope ?? null,
		auto_choose: graph.autoChoose ?? null,
		retrieval,
		graph: {
			ignored_mentions: forceZero ? [] : (graph.ignoredMentions ?? graph.ignored_mentions ?? []),
			overridden_recommendations: forceZero ? [] : (graph.overriddenRecommendations ?? graph.overridden_recommendations ?? []),
			created_facts: forceZero ? [] : [
				...(committedGraph.newSlices ?? []).map((item) => ({ kind: "slice", id: item.id, node_id: item.node_id })),
				...(committedGraph.newEvents ?? []).map((item) => ({ kind: "event", id: item.id, node_id: item.node_id })),
				...(committedGraph.newEdges ?? []).map((item) => ({ kind: "edge", id: item.id, from_node: item.from_node, to_node: item.to_node })),
			],
			reinforced_facts: forceZero ? [] : [
				...(committedGraph.sliceTouches ?? []).map((item) => ({ kind: "slice", id: item.id })),
				...(committedGraph.eventTouches ?? []).map((item) => ({ kind: "event", id: item.id })),
				...(committedGraph.edgeTouches ?? []).map((item) => ({ kind: "edge", id: item.id })),
			],
			superseded_facts: forceZero ? [] : [
				...(committedGraph.sliceSupersede ?? []).map((item) => ({ kind: "slice", id: item.id ?? null, node_id: item.node_id })),
				...(committedGraph.edgeSupersede ?? []).map((item) => ({ kind: "edge", id: item.id })),
			],
		},
		persistence_failures: persistenceFailures,
		page: {
			action: canonicalPageAction(pagePlan?.action),
			id: pagePlan?.page?.id ?? null,
			title: pagePlan?.page?.title ?? null,
			primary_topic: pagePlan?.page?.topic_filter ?? null,
			primary_subject_node_id: pagePlan?.page?.node_id ?? null,
			identity_score: pagePlan?.identity_score ?? null,
			identity_reason_codes: pagePlan?.identity_reason_codes ?? [],
			quality_score: pagePlan?.quality_score ?? null,
			retry_count: pagePlan?.retry_count ?? 0,
			synthesis_mode: pagePlan?.synthesis_mode ?? null,
			quality_reason_codes: pagePlan?.quality_reason_codes ?? [],
			evidence_count: forceZero ? 0 : pageEvidenceCount,
			evidence_added_count: forceZero || pagePlan?.action === "duplicate"
				? 0
				: Math.max(0, pageEvidenceCount - priorPageEvidenceCount),
		},
		page_conflicts: pagePlan?.page_conflicts ?? [],
		actions: {
			...pageActions,
			createdNodes: (committedGraph.newNodes ?? []).map((node) => ({ id: node.id, label: node.label, summary: node.summary })),
			mergedNodes: (forceZero ? [] : (graph.identityDecisions ?? []))
				.filter((decision) => decision.decision === "existing")
				.map((decision) => ({ id: decision.node_id, label: decision.label, matched_by: decision.matched_by })),
			createdSlices: (committedGraph.newSlices ?? []).map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
			createdEvents: (committedGraph.newEvents ?? []).map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
			createdEdges: (committedGraph.newEdges ?? []).map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
			supersededEdges: committedGraph.edgeSupersede ?? [],
			corrections: forceZero ? [] : (graph.correctionActions ?? []),
			reinforcedNodes: uniqueNodeTouches(committedGraph).map((nodeId) => ({ id: nodeId })),
			supersededSlices: committedGraph.sliceSupersede ?? [],
			reinforcedSlices: committedGraph.sliceTouches ?? [],
			reinforcedEvents: committedGraph.eventTouches ?? [],
			reinforcedEdges: committedGraph.edgeTouches ?? [],
			resolvedCandidates: forceZero ? [] : (graph.resolvedCandidates ?? []),
			skippedObjects: skipped,
			identityConflicts: graph.conflicts ?? [],
			pageConflicts: pagePlan?.page_conflicts ?? [],
		},
		created_at: Date.now(),
	};
}

function listPart(count, singular, plural = `${singular}s`) {
	return count ? `${count} ${count === 1 ? singular : plural}` : null;
}

function receiptSummary(receipt, pagePlan = null) {
	const pagePrefix = pagePlan?.action === "created"
		? `Created one memory page "${pagePlan.page.title}". `
		: pagePlan?.action === "updated"
			? `Updated one memory page "${pagePlan.page.title}". `
			: pagePlan?.action === "reinforced"
				? `Reinforced one memory page "${pagePlan.page.title}". `
				: pagePlan?.action === "duplicate"
				? `Skipped duplicate memory page "${pagePlan.page.title}". `
				: pagePlan?.action === "suppressed"
					? `Skipped suppressed memory page "${pagePlan.page.title}". `
					: pagePlan?.action === "conflict"
						? `Memory page write conflict for "${pagePlan.page.title}". `
						: pagePlan?.action === "ambiguous"
							? `Memory page identity conflict for "${pagePlan.page.title}". `
							: "";
	if (receipt.identity_conflicts?.length) {
		const conflict = receipt.identity_conflicts[0];
		const choices = (conflict.matches ?? []).map((match) => match.label).filter(Boolean).join(" or ");
		const detail = choices ? ` It could mean ${choices}.` : "";
		return `${pagePrefix}Identity conflict for "${conflict.label}".${detail} Clarify the intended existing memory; that identity was not changed.`;
	}
	if (receipt.savedTotal === 0) {
		return `${pagePrefix}Saved: 0. Reason: ${receipt.reason ?? "nothing could be safely persisted from the submitted content"}.`;
	}
	const saved = receipt.saved ?? {};
	const parts = [
		listPart(saved.nodes, "node"),
		listPart(saved.updatedNodes, "merged node"),
		listPart(saved.slices, "slice"),
		listPart(saved.events, "event"),
		listPart(saved.edges, "edge"),
		listPart(saved.supersededEdges, "superseded edge"),
		listPart(saved.reinforcedSlices, "reinforced slice"),
		listPart(saved.reinforcedEvents, "reinforced event"),
		listPart(saved.reinforcedEdges, "reinforced edge"),
		listPart(saved.resolvedCandidates, "resolved candidate"),
	].filter(Boolean);
	const graphText = parts.length ? `Saved graph: ${parts.join(", ")}.` : "Graph: no additional graph facts.";
	return `${pagePrefix}${graphText}`.trim();
}

function resultFromReceipt(mode, source, sourcePacket, receipt, summary, receiptId = null) {
	const saved = receipt.saved ?? emptySaved();
	const receiptPersisted = Boolean(receiptId);
	receipt.receipt_persisted = receiptPersisted;
	const finalSummary = receiptPersisted
		? summary
		: `${summary} Receipt persistence failed; the structured receipt is returned here but no receipt row was created.`;
	const warnings = [
		...(receipt.retrieval?.warnings ?? []),
		...(receipt.persistence_failures ?? []).map((failure) => failure.code ?? failure.message ?? String(failure)),
		...(receiptPersisted ? [] : ["receipt_persistence_failed"]),
	];
	return {
		ok: receipt.outcome !== "db_write_failed",
		command_mode: mode,
		mode,
		source,
		status: receipt.outcome,
		fired: receipt.savedTotal > 0,
		processing: false,
		summary: finalSummary,
		source_packet_id: receipt.source_packet_id ?? sourcePacket?.id ?? null,
		// `receipt_id` is a persistence pointer, not merely the in-memory receipt's
		// generated correlation id. Never claim a row exists when storage failed.
		receipt_id: receiptId ?? null,
		receipt_persisted: receiptPersisted,
		warnings: [...new Set(warnings)],
		receipt,
		counts: {
			received: receipt.received ?? null,
			digested: receipt.digested ?? null,
			skipped: receipt.skipped ?? 0,
			savedTotal: receipt.savedTotal ?? 0,
			pages: saved.pages ?? 0,
			nodes: saved.nodes ?? 0,
			updatedNodes: saved.updatedNodes ?? 0,
			slices: saved.slices ?? 0,
			events: saved.events ?? 0,
			edges: saved.edges ?? 0,
			supersededEdges: saved.supersededEdges ?? 0,
			candidates: 0,
			resolvedCandidates: saved.resolvedCandidates ?? 0,
			reinforcedSlices: saved.reinforcedSlices ?? 0,
			reinforcedEvents: saved.reinforcedEvents ?? 0,
			reinforcedEdges: saved.reinforcedEdges ?? 0,
		},
		identity_conflicts: receipt.identity_conflicts ?? [],
		page_conflicts: receipt.page_conflicts ?? [],
	};
}

function extractionRunFinalStatement(env, userId, runId, receiptId, data = {}) {
	const fields = ["receipt_id = (SELECT id FROM receipts WHERE id = ? AND user_id = ?)"];
	const values = [receiptId, userId];
	const map = {
		status: "status",
		created_pages_json: "createdPages",
		created_nodes_json: "createdNodes",
		created_slices_json: "createdSlices",
		created_events_json: "createdEvents",
		created_edges_json: "createdEdges",
		updated_objects_json: "updatedObjects",
		reinforced_objects_json: "reinforcedObjects",
		skipped_objects_json: "skippedObjects",
		error: "error",
	};
	const listColumns = new Set([
		"created_pages_json", "created_nodes_json", "created_slices_json", "created_events_json",
		"created_edges_json", "updated_objects_json", "reinforced_objects_json", "skipped_objects_json",
	]);
	for (const [column, key] of Object.entries(map)) {
		if (data[key] === undefined && data[column] === undefined) continue;
		const value = data[key] !== undefined ? data[key] : data[column];
		fields.push(`${column} = ?`);
		values.push(listColumns.has(column) ? JSON.stringify(value ?? []) : value);
	}
	fields.push("updated_at = ?");
	values.push(Date.now());
	return env.DB.prepare(
		`UPDATE extraction_runs SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
	).bind(...values, runId, userId);
}

async function storeFinalReceipt(env, userId, source, receipt, summary, options = {}) {
	const saved = receipt?.saved ?? {};
	const id = receipt?.id ?? newId("receipt");
	const detail = receipt && typeof receipt === "object" ? { ...receipt, id } : receipt;
	const pagePlan = options.pagePlan;
	const page = ["created", "updated", "reinforced"].includes(pagePlan?.action) && pagePlan?.page?.id
		? pagePlan.page
		: null;
	const statements = [];
	if (page) {
		// Link first, then condition receipt creation on that exact page revision
		// still being current. A slower writer can never claim a persisted receipt
		// while a newer page version has already replaced its evidence.
		statements.push(
			env.DB.prepare(
				`UPDATE memory_pages
				 SET receipt_id = ?,
				  evidence_json = CASE WHEN json_valid(evidence_json) THEN COALESCE((
				   SELECT json_group_array(json(json_set(value, '$.receipt_id', ?)))
				   FROM json_each(evidence_json)
				  ), '[]') ELSE evidence_json END
				 WHERE id = ? AND user_id = ?
				  AND (? IS NULL OR source_packet_id = ?)
				  AND (? IS NULL OR input_hash = ?)
				  AND (? IS NULL OR extraction_run_id = ?)`,
			).bind(
				id, id, page.id, userId,
				page.source_packet_id ?? null, page.source_packet_id ?? null,
				page.input_hash ?? null, page.input_hash ?? null,
				page.extraction_run_id ?? null, page.extraction_run_id ?? null,
			),
		);
	}
	const receiptValues = [
		id, userId, source ?? receipt?.source ?? "ingest", receipt?.outcome ?? null,
		summary ?? null, receipt?.savedTotal ?? 0, saved.nodes ?? 0, saved.slices ?? 0,
		saved.events ?? 0, saved.edges ?? 0, saved.candidates ?? 0, saved.updatedNodes ?? 0,
		receipt?.skipped ?? 0, receipt?.received ?? null, receipt?.digested ?? null,
		JSON.stringify(detail ?? {}), receipt?.created_at ?? Date.now(), receipt?.extraction_run_id ?? null,
		saved.pages ?? 0, receipt?.source_packet_id ?? null, receipt?.idempotency_key ?? null,
		receipt?.scope_json ?? null,
	];
	const receiptStatementIndex = statements.length;
	statements.push(
		env.DB.prepare(
			`INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total,
			 saved_nodes, saved_slices, saved_events, saved_edges, saved_candidates,
			 updated_nodes, skipped, received, digested, detail, created_at, extraction_run_id,
			 saved_pages, source_packet_id, idempotency_key, scope_json)
			 ${page
				? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				   WHERE EXISTS (SELECT 1 FROM memory_pages WHERE id = ? AND user_id = ? AND receipt_id = ?)`
				: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"}`,
		).bind(...receiptValues, ...(page ? [page.id, userId, id] : [])),
	);
	if (receipt?.extraction_run_id) {
		statements.push(extractionRunFinalStatement(
			env, userId, receipt.extraction_run_id, id, options.runData ?? {},
		));
	}
	try {
		const results = await env.DB.batch(statements);
		const inserted = Number(results?.[receiptStatementIndex]?.meta?.changes ?? 0) > 0;
		if (!inserted) return null;
		if (receipt && typeof receipt === "object") receipt.id = id;
		return id;
	} catch (error) {
		console.warn("receipt store failed:", error?.message ?? error);
		return null;
	}
}

function withoutGraphWrites(plan) {
	const copy = { ...plan, affectedNodeIds: new Set() };
	for (const field of GRAPH_PLAN_FIELDS) copy[field] = [];
	copy.resolvedCandidates = [];
	copy.runLists = {
		createdNodes: [],
		createdSlices: [],
		createdEvents: [],
		createdEdges: [],
		updatedObjects: [],
		reinforcedObjects: [],
		skippedObjects: plan.rejected ?? [],
	};
	copy.hasGraphWrites = false;
	copy.hasWrites = false;
	return copy;
}

function duplicateRepairGraphPlan(plan) {
	const repairNodeIds = new Set([
		...(plan.newNodes ?? []).map((item) => item.id),
		...(plan.newSlices ?? []).map((item) => item.node_id),
		...(plan.newEvents ?? []).map((item) => item.node_id),
		...(plan.newEdges ?? []).flatMap((item) => [item.from_node, item.to_node]),
		...(plan.candidateResolutions ?? []).map((item) => item.node_id),
		...(plan.nodeAliasUpdates ?? []).map((item) => item.id),
		...(plan.nodeAliasAdds ?? []).map((item) => item.id),
		...(plan.topicCommunityMemberships ?? []).map((item) => item.node_id),
	].filter(Boolean));
	const copy = {
		...plan,
		nodeTouches: (plan.nodeTouches ?? []).filter((item) => repairNodeIds.has(item?.id ?? item)),
		nodeStateUpdates: (plan.nodeStateUpdates ?? []).filter((item) => repairNodeIds.has(item.id)),
		nodeSummaryUpdates: (plan.nodeSummaryUpdates ?? []).filter((item) => repairNodeIds.has(item.id)),
		sliceSupersede: (plan.sliceSupersede ?? []).filter((item) =>
			!item.replacement_id || (plan.newSlices ?? []).some((slice) => slice.id === item.replacement_id)),
		sliceTouches: [],
		eventTouches: [],
		edgeTouches: [],
		edgeSupersede: plan.edgeSupersede ?? [],
	};
	copy.hasGraphWrites = Boolean(
		copy.newNodes?.length || copy.nodeTouches.length || copy.nodeStateUpdates.length || copy.nodeAliasUpdates?.length || copy.nodeAliasAdds?.length ||
		copy.newSlices?.length || copy.sliceSupersede.length || copy.newEvents?.length || copy.newEdges?.length || copy.edgeSupersede.length ||
		copy.candidateResolutions?.length || copy.nodeSummaryUpdates.length || copy.topicCommunityMemberships?.length,
	);
	copy.hasWrites = copy.hasGraphWrites;
	copy.runLists = runListsForPlan(copy);
	return copy;
}

function combinePagePlan(graphPlan, pagePlan) {
	return {
		...graphPlan,
		newPages: pagePlan?.newPages ?? [],
		pageUpdates: pagePlan?.pageUpdates ?? [],
		pageClaims: pagePlan?.pageClaims ?? [],
		hasWrites: Boolean(graphPlan?.hasGraphWrites || pagePlan?.write),
	};
}

function runListsForPlan(plan) {
	return {
		createdNodes: (plan.newNodes ?? []).map((node) => ({ id: node.id, label: node.label })),
		createdSlices: (plan.newSlices ?? []).map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
		createdEvents: (plan.newEvents ?? []).map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
		createdEdges: (plan.newEdges ?? []).map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
		updatedObjects: [
			...uniqueNodeTouches(plan).map((id) => ({ kind: "node", id })),
			...(plan.edgeSupersede ?? []).map((edge) => ({ kind: "edge", id: edge.id, status: "superseded" })),
		],
		reinforcedObjects: [
			...(plan.sliceTouches ?? []).map((item) => ({ kind: "slice", id: item.id })),
			...(plan.eventTouches ?? []).map((item) => ({ kind: "event", id: item.id })),
			...(plan.edgeTouches ?? []).map((item) => ({ kind: "edge", id: item.id })),
		],
		skippedObjects: plan.rejected ?? [],
	};
}

function reconcileManualCommit(plan, writeResult) {
	if (!writeResult?.committed) return plan;
	const committed = writeResult.committed;
	const nodeIds = new Set(committed.nodes ?? []);
	const sliceIds = new Set(committed.slices ?? []);
	const eventIds = new Set(committed.events ?? []);
	const edgeIds = new Set(committed.edges ?? []);
	const supersededEdgeIds = new Set(committed.edgeSuperseded ?? []);
	const candidateIds = new Set(committed.candidates ?? []);
	const aliasKeys = new Set(committed.aliases ?? []);
	const identityClaimKeys = new Set(committed.identityClaims ?? []);
	const correctionGuardKeys = new Set(committed.correctionGuards ?? []);
	const communityKeys = new Set(committed.communities ?? []);
	const nodeTouchIds = new Set(committed.nodeTouches ?? []);
	const nodeStateIds = new Set(committed.nodeStateUpdates ?? []);
	const aliasBulkIds = new Set(committed.aliasBulk ?? []);
	const nodeSummaryIds = new Set(committed.nodeSummaries ?? []);
	const supersededSliceIds = new Set(committed.sliceSuperseded ?? []);
	const touchedSliceIds = new Set(committed.sliceTouches ?? []);
	const touchedEventIds = new Set(committed.eventTouches ?? []);
	const touchedEdgeIds = new Set(committed.edgeTouches ?? []);
	const ownsCorrectionGuard = (item) => !item?.manual_correction_guard_key || correctionGuardKeys.has(
		`${item.manual_correction_guard_key}:${item.manual_correction_guard_token}`,
	);
	const missingNodes = (plan.newNodes ?? []).filter((node) => !nodeIds.has(node.id));
	const fallback = committed.reinforcements ?? {};
	const mergeTouches = (planned, reinforced) => {
		const items = [...(planned ?? [])];
		for (const item of reinforced ?? []) {
			if (!item?.id || items.some((existing) => existing.id === item.id)) continue;
			items.push(item);
		}
		return items;
	};
	const copy = {
		...plan,
		newNodes: (plan.newNodes ?? []).filter((node) => nodeIds.has(node.id) && ownsCorrectionGuard(node)),
		newSlices: (plan.newSlices ?? []).filter((slice) => sliceIds.has(slice.id) && ownsCorrectionGuard(slice)),
		newEvents: (plan.newEvents ?? []).filter((event) => eventIds.has(event.id) && ownsCorrectionGuard(event)),
		newEdges: (plan.newEdges ?? []).filter((edge) => edgeIds.has(edge.id) && ownsCorrectionGuard(edge)),
		nodeTouches: (plan.nodeTouches ?? []).filter((touch) => nodeTouchIds.has(touch?.id ?? touch) && ownsCorrectionGuard(touch)),
		nodeStateUpdates: (plan.nodeStateUpdates ?? []).filter((update) => nodeStateIds.has(update.id) && ownsCorrectionGuard(update)),
		nodeAliasUpdates: (plan.nodeAliasUpdates ?? []).filter((update) => aliasBulkIds.has(update.id) && ownsCorrectionGuard(update)),
		nodeAliasAdds: (plan.nodeAliasAdds ?? []).filter((addition) =>
			aliasKeys.has(`${addition.id}:${addition.identity_key}`) && ownsCorrectionGuard(addition)),
		topicCommunityMemberships: (plan.topicCommunityMemberships ?? []).filter((membership) =>
			communityKeys.has(`${membership.node_id}:${membership.canonical_key}`) && ownsCorrectionGuard(membership)),
		nodeSummaryUpdates: (plan.nodeSummaryUpdates ?? []).filter((update) =>
			nodeSummaryIds.has(update.id) && ownsCorrectionGuard(update) && !missingNodes.some((node) => node.id === update.id)),
		sliceSupersede: (plan.sliceSupersede ?? []).filter((item) =>
			ownsCorrectionGuard(item) && supersededSliceIds.has(item.id ?? `${item.node_id}:${item.kind}`) &&
			(!item.replacement_id || sliceIds.has(item.replacement_id) || (plan.sliceTouches ?? []).some((touch) => touch.id === item.replacement_id))),
		sliceTouches: mergeTouches((plan.sliceTouches ?? []).filter((item) => touchedSliceIds.has(item.id) && ownsCorrectionGuard(item)), fallback.slices),
		eventTouches: mergeTouches((plan.eventTouches ?? []).filter((item) => touchedEventIds.has(item.id) && ownsCorrectionGuard(item)), fallback.events),
		edgeTouches: mergeTouches((plan.edgeTouches ?? []).filter((item) => touchedEdgeIds.has(item.id) && ownsCorrectionGuard(item)), fallback.edges),
		edgeSupersede: (plan.edgeSupersede ?? []).filter((edge) => supersededEdgeIds.has(edge.id) && ownsCorrectionGuard(edge)),
		candidateResolutions: (plan.candidateResolutions ?? []).filter((resolution) => candidateIds.has(resolution.id)),
		resolvedCandidates: (plan.resolvedCandidates ?? []).filter((resolution) => candidateIds.has(resolution.id)),
		conflicts: [...(plan.conflicts ?? [])],
	};
	const failedCorrections = [];
	copy.correctionActions = (plan.correctionActions ?? []).map((action) => {
		const reinforced = (fallback.edges ?? []).find((edge) =>
			edge.from_node === action.subject_node_id &&
			edge.to_node === action.new_target_node_id &&
			edge.type === action.type);
		const touched = (plan.edgeTouches ?? []).find((edge) =>
			edge.id === action.replacement_edge_id || (
				edge.from_node === action.subject_node_id &&
				edge.to_node === action.new_target_node_id &&
				edge.type === action.type
			));
		const reconciled = {
			...action,
			superseded_edge_id: action.superseded_edge_id && supersededEdgeIds.has(action.superseded_edge_id)
				? action.superseded_edge_id
				: null,
			replacement_edge_id: action.replacement_edge_id && edgeIds.has(action.replacement_edge_id)
				? action.replacement_edge_id
				: reinforced?.id ?? touched?.id ?? null,
			current_slice_id: action.current_slice_id && (
				sliceIds.has(action.current_slice_id) || touchedSliceIds.has(action.current_slice_id) ||
				(fallback.slices ?? []).some((slice) => slice.id === action.current_slice_id)
			) ? action.current_slice_id : null,
		};
		const guardOwned = !action.manual_correction_guard_key || correctionGuardKeys.has(
			`${action.manual_correction_guard_key}:${action.manual_correction_guard_token}`,
		);
		const factApplied = action.kind === "fact" && guardOwned && Boolean(
			action.replacement_slice_id && (
				sliceIds.has(action.replacement_slice_id) || touchedSliceIds.has(action.replacement_slice_id) ||
				(fallback.slices ?? []).some((slice) => slice.id === action.replacement_slice_id)
			) && (action.superseded_slice_ids ?? []).every((id) => supersededSliceIds.has(id)),
		);
		const relationshipApplied = action.kind !== "fact" && guardOwned && Boolean(
			(action.replacement_edge_id ? reconciled.replacement_edge_id : true) &&
			(action.superseded_edge_id ? reconciled.superseded_edge_id : true),
		);
		if ((action.manual_correction_guard_key && !factApplied && !relationshipApplied)) {
			failedCorrections.push(action);
			return null;
		}
		return reconciled;
	}).filter(Boolean);
	for (const failed of failedCorrections) {
		copy.conflicts.push({
			kind: "correction",
			label: failed.subject_label ?? null,
			reason: "concurrent_correction_conflict",
			matches: [],
		});
	}
	for (const missing of missingNodes) {
		if (missing.manual_correction_guard_key && !correctionGuardKeys.has(
			`${missing.manual_correction_guard_key}:${missing.manual_correction_guard_token}`,
		)) continue;
		copy.conflicts.push({
			label: missing.label,
			reason: "concurrent_identity_claim",
			matches: [],
		});
	}
	for (const claim of plan.identityClaims ?? []) {
		const claimId = `${claim.canonical_key}:${claim.node_id}`;
		if (identityClaimKeys.has(claimId)) continue;
		if (claim.manual_correction_guard_key && !correctionGuardKeys.has(
			`${claim.manual_correction_guard_key}:${claim.manual_correction_guard_token}`,
		)) continue;
		const node = (plan.newNodes ?? []).find((item) => item.id === claim.node_id);
		if (node && missingNodes.includes(node)) continue;
		if (copy.conflicts.some((conflict) => conflict.reason === "concurrent_identity_claim" && conflict.label === claim.canonical_key)) continue;
		copy.conflicts.push({
			label: claim.canonical_key,
			reason: "concurrent_identity_claim",
			matches: [],
		});
	}
	copy.hasGraphWrites = Boolean(
		copy.newNodes.length || copy.nodeTouches?.length || copy.nodeStateUpdates?.length || copy.nodeAliasUpdates?.length || copy.nodeAliasAdds?.length ||
		copy.newSlices.length || copy.sliceTouches?.length || copy.sliceSupersede?.length ||
		copy.newEvents.length || copy.eventTouches?.length || copy.newEdges.length || copy.edgeTouches?.length || copy.edgeSupersede.length ||
		copy.candidateResolutions.length || copy.topicCommunityMemberships?.length,
	);
	copy.hasWrites = copy.hasGraphWrites;
	copy.runLists = runListsForPlan(copy);
	return copy;
}

function reconcilePageCommit(pagePlan, writeResult) {
	if (!pagePlan?.write || !writeResult?.committed) return pagePlan;
	const expectedKind = pagePlan.action === "created" ? "pages" : "pageUpdates";
	if ((writeResult.committed[expectedKind] ?? []).includes(pagePlan.page?.id)) return pagePlan;
	const reason = pagePlan.action === "created" ? "concurrent_page_claim" : "concurrent_page_update";
	return {
		...pagePlan,
		action: "conflict",
		write: false,
		reason,
		newPages: [],
		pageUpdates: [],
		pageClaims: [],
		skipped: [...(pagePlan.skipped ?? []), {
			kind: "memory_page",
			id: pagePlan.page?.id ?? null,
			label: pagePlan.page?.title ?? null,
			reason,
		}],
	};
}

function scopedUserMessages(messages) {
	return (messages ?? [])
		.filter((message) => (message?.role ?? "user") === "user")
		.map((message) => String(message?.content ?? "").trim())
		.filter(Boolean);
}

function pageIdentityHints(integrity) {
	const identities = [
		...(integrity?.corrections ?? []).map((item) => item.subject),
		...(integrity?.relationships ?? []).map((item) => item.from),
		...(integrity?.facts ?? []).map((item) => item.identity),
	].filter((identity) => identity?.label);
	const seen = new Set();
	return identities.filter((identity) => {
		const key = String(identity.label).toLocaleLowerCase("en-US");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function primaryPageSubject(integrity) {
	const primaryRef = integrity?.primary_subject_ref ?? integrity?.primarySubjectRef ?? null;
	return (integrity?.entities ?? []).find((entity) =>
		(entity?.ref ?? entity?.entity_ref ?? entity?.entityRef) === primaryRef) ?? pageIdentityHints(integrity)[0] ?? null;
}

function primaryPageNodeId(integrity, graphPlan) {
	const subject = primaryPageSubject(integrity);
	if (!subject?.label) return null;
	const primaryRef = subject.ref ?? subject.entity_ref ?? subject.entityRef ??
		integrity?.primary_subject_ref ?? integrity?.primarySubjectRef ?? null;
	const existing = (graphPlan?.identityDecisions ?? []).find((decision) =>
		decision?.node_id && (
			(primaryRef && decision.entity_ref === primaryRef) ||
			canonicalIdentity(decision.label) === canonicalIdentity(subject.label)
		));
	if (existing?.node_id) return existing.node_id;
	// A planned new primary node is safe to associate only when the graph plan is
	// itself writable. Otherwise the page must not point at an uncommitted UUID.
	if (graphPlan?.conflicts?.length) return null;
	return (graphPlan?.newNodes ?? []).find((node) =>
		canonicalIdentity(node.identity_key ?? node.canonical_label ?? node.label) === canonicalIdentity(subject.label))?.id ?? null;
}

function pageSynthesisClaims(conversation, integrity) {
	const original = [...(conversation?.page_claims ?? conversation?.claims ?? [])];
	const corrections = integrity?.corrections ?? [];
	if (!corrections.length) return original;
	const correctionSourceIds = new Set(corrections.flatMap((correction) => correction.evidence_ids ?? []));
	const kept = original.filter((claim) => {
		const refs = (claim.evidence_spans ?? []).map((span) => span.message_ref);
		return !refs.some((ref) => correctionSourceIds.has(ref));
	});
	const usedClaimIds = new Set(original.map((claim) => claim?.claim_id).filter(Boolean));
	let index = original.reduce((highest, claim) => {
		const match = String(claim?.claim_id ?? "").match(/^C(\d+)$/);
		return match ? Math.max(highest, Number(match[1]) + 1) : highest;
	}, 0);
	const nextClaimId = () => {
		while (usedClaimIds.has(`C${index}`)) index++;
		const id = `C${index++}`;
		usedClaimIds.add(id);
		return id;
	};
	for (const correction of corrections) {
		const supporting = original.filter((claim) =>
			(claim.evidence_spans ?? []).some((span) => (correction.evidence_ids ?? []).includes(span.message_ref)));
		const sourceMessageIds = [...new Set(supporting.flatMap((claim) => claim.source_message_ids ?? []))];
		const evidenceSpans = supporting.flatMap((claim) => claim.evidence_spans ?? []);
		const currentText = String(
			correction.current_text ?? correction.new_text ?? correction.new_value ?? "",
		).trim();
		if (currentText) {
			kept.push({
				claim_id: nextClaimId(),
				type: "current_state",
				text: currentText,
				subject_ref: correction.subject_ref ?? null,
				subject_label: correction.subject?.label ?? null,
				predicate: correction.predicate ?? correction.type ?? null,
				attribution: correction.attribution ?? "user_stated",
				polarity: "positive",
				modality: "asserted",
				current: true,
				source_message_ids: sourceMessageIds,
				evidence_spans: evidenceSpans,
			});
		}
		const historyText = String(correction.history_text ?? "").trim();
		if (historyText) {
			kept.push({
				claim_id: nextClaimId(),
				type: "decision",
				text: historyText,
				subject_ref: correction.subject_ref ?? null,
				subject_label: correction.subject?.label ?? null,
				predicate: correction.predicate ?? correction.type ?? null,
				attribution: correction.attribution ?? "user_stated",
				polarity: "positive",
				modality: "asserted",
				current: true,
				source_message_ids: sourceMessageIds,
				evidence_spans: evidenceSpans,
			});
		}
	}
	return kept;
}

function structureIdentityObjects(structure) {
	return [
		...(structure?.entities ?? []),
		...(structure?.facts ?? []).flatMap((item) => [item.identity, item.subject]),
		...(structure?.relationships ?? []).flatMap((item) => [item.from, item.to]),
		...(structure?.corrections ?? []).flatMap((item) => [
			item.subject,
			item.old_target,
			item.new_target,
		]),
	].filter(Boolean);
}

function applyManualAdjudication(structure, retrieval, adjudication) {
	const byEntityRef = new Map((adjudication?.decisions ?? []).map((decision) => [decision.entity_ref, decision]));
	const entityByRef = new Map((structure?.entities ?? []).map((entity) => [entity.ref, entity]));
	for (const identity of structureIdentityObjects(structure)) {
		const ref = identity.ref ?? identity.entity_ref ?? identity.subject_ref ?? null;
		const decision = byEntityRef.get(ref);
		if (!decision) continue;
		identity._manual_resolution = decision;
		if (decision.decision === "merge_existing") {
			const nodeId = decision.selected_node_id ?? retrieval?.refMap?.get(decision.selected_ref) ?? null;
			if (nodeId) identity.existing_node_id = nodeId;
			else identity._manual_conflict_reason = "adjudication_reference_unavailable";
		} else if (decision.decision === "identity_conflict") {
			identity.existing_node_id = null;
			identity._manual_conflict_reason = decision.reason_codes?.[0] ?? "identity_conflict";
		} else {
			identity.existing_node_id = null;
		}
	}

	// Legacy facts carry their own identity object. Bind those objects to the
	// authoritative structured entity decision when only a subject_ref is present.
	for (const fact of structure?.facts ?? []) {
		const entity = entityByRef.get(fact.subject_ref ?? fact.entity_ref);
		if (!entity) continue;
		fact.identity = { ...entity, ...(fact.identity ?? {}), existing_node_id: entity.existing_node_id ?? null };
	}
	for (const relationship of structure?.relationships ?? []) {
		const from = entityByRef.get(relationship.from_ref);
		const to = entityByRef.get(relationship.to_ref);
		if (from) relationship.from = { ...from, ...(relationship.from ?? {}), existing_node_id: from.existing_node_id ?? null };
		if (to) relationship.to = { ...to, ...(relationship.to ?? {}), existing_node_id: to.existing_node_id ?? null };
	}
	for (const correction of structure?.corrections ?? []) {
		for (const [field, refField] of [["subject", "subject_ref"], ["old_target", "old_target_ref"], ["new_target", "new_target_ref"]]) {
			const entity = entityByRef.get(correction[refField]);
			if (entity) correction[field] = { ...entity, ...(correction[field] ?? {}), existing_node_id: entity.existing_node_id ?? null };
		}
	}
	structure.adjudication = adjudication;
	structure.retrieval = retrieval?.receipt ?? {};
	structure.ignored_mentions = [
		...(structure.ignored_mentions ?? []),
		...(adjudication?.ignored_mentions ?? []),
	];
	structure.overridden_recommendations = adjudication?.overridden_recommendations ?? [];
	return structure;
}

function derivedRefreshTargets(plan, writeResult, pagePlan = null) {
	const nodeIds = new Set(writeResult?.affectedNodeIds ?? []);
	for (const node of plan?.newNodes ?? []) nodeIds.add(node.id);
	for (const item of plan?.nodeTouches ?? []) nodeIds.add(item?.id ?? item);
	for (const item of plan?.nodeAliasUpdates ?? []) nodeIds.add(item.id);
	for (const item of plan?.nodeAliasAdds ?? []) nodeIds.add(item.id);
	for (const item of plan?.nodeSummaryUpdates ?? []) nodeIds.add(item.id);
	for (const item of plan?.newSlices ?? []) nodeIds.add(item.node_id);
	for (const item of plan?.sliceTouches ?? []) nodeIds.add(item.node_id);
	for (const item of plan?.sliceSupersede ?? []) nodeIds.add(item.node_id);
	for (const item of plan?.newEvents ?? []) nodeIds.add(item.node_id);
	for (const item of plan?.eventTouches ?? []) nodeIds.add(item.node_id);
	for (const item of [...(plan?.newEdges ?? []), ...(plan?.edgeTouches ?? []), ...(plan?.edgeSupersede ?? [])]) {
		nodeIds.add(item.from_node);
		nodeIds.add(item.to_node);
	}
	for (const item of plan?.topicCommunityMemberships ?? []) nodeIds.add(item.node_id);
	const pageIds = new Set();
	if (pagePlan?.write && pagePlan.page?.id) pageIds.add(pagePlan.page.id);
	if (pagePlan?.page?.node_id) nodeIds.add(pagePlan.page.node_id);
	return {
		nodeIds: [...nodeIds].filter(Boolean),
		pageIds: [...pageIds].filter(Boolean),
	};
}

async function refreshManualDerivedIndexes(env, config, userId, plan, writeResult, pagePlan = null) {
	const targets = derivedRefreshTargets(plan, writeResult, pagePlan);
	if (!targets.nodeIds.length && !targets.pageIds.length) return { refreshed: [], vector_refreshed: [], warnings: [] };
	return refreshManualSearchProfiles(env, config, userId, targets);
}

function retrievalIdentityOverflow(retrieval) {
	return (retrieval?.receipt?.warnings ?? []).includes("exact_candidate_overflow");
}

function emptyConversationGraphIntegrity(rejected = []) {
	return {
		ok: false,
		primary_subject_ref: null,
		primary_memory: null,
		entities: [],
		facts: [],
		relationships: [],
		corrections: [],
		rejected,
		notes: "page_only_conversation",
	};
}

function emptyConversationRetrieval(warnings = []) {
	return {
		entities: [],
		broadPool: [],
		candidatesByEntityRef: {},
		cards: [],
		refMap: new Map(),
		receipt: {
			broad_pool_count: 0,
			card_count: 0,
			signals_used: [],
			warnings: [...new Set(warnings.filter(Boolean))],
		},
	};
}

function messagesForCollectScope(messages, input) {
	const all = messages ?? [];
	if (input.scope === "lastN") {
		const requested = Number(input.n ?? 20);
		const count = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 20;
		return all.slice(-count);
	}
	if (input.scope === "topic" && input.topic) {
		const topic = String(input.topic).toLocaleLowerCase("en-US");
		return all.filter((message) => String(message?.content ?? "").toLocaleLowerCase("en-US").includes(topic));
	}
	return all;
}

function contentWords(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.match(/[\p{L}\p{N}]+/gu) ?? [];
}

const DIGEST_STOP_WORDS = new Set([
	"a", "about", "also", "am", "an", "and", "are", "as", "at", "be", "been", "being", "by",
	"for", "from", "had", "has", "have", "he", "her", "hers", "him", "his", "i", "in", "is", "it",
	"its", "me", "my", "of", "on", "or", "our", "ours", "s", "she", "that", "the", "their", "theirs",
	"them", "they", "this", "to", "user", "users", "was", "we", "were", "with", "you", "your", "yours",
]);

const DIGEST_TOKEN_EQUIVALENTS = new Map([
	["began", "start"], ["begin", "start"], ["beginning", "start"], ["started", "start"], ["starting", "start"],
	["built", "build"], ["building", "build"], ["builds", "build"], ["developed", "build"], ["developing", "build"],
	["chose", "decide"], ["chosen", "decide"], ["decided", "decide"], ["selected", "decide"],
	["depends", "depend"], ["depended", "depend"], ["depending", "depend"],
	["liked", "prefer"], ["likes", "prefer"], ["preferred", "prefer"], ["prefers", "prefer"], ["preferring", "prefer"],
	["quit", "stop"], ["stopped", "stop"], ["stopping", "stop"],
	["stored", "store"], ["stores", "store"], ["storing", "store"],
	["used", "use"], ["uses", "use"], ["using", "use"],
	["matters", "matter"], ["mattered", "matter"],
]);

const DIGEST_PREDICATE_WORDS = new Set([
	"achieve", "build", "change", "complete", "decide", "depend", "diagnose", "finish", "join", "launch",
	"leave", "matter", "move", "practice", "prefer", "resume", "start", "stop", "store", "use", "work",
]);

function digestClaimTokens(value) {
	return [...new Set(contentWords(value)
		.filter((word) => word.length > 1 && !DIGEST_STOP_WORDS.has(word))
		.map((word) => DIGEST_TOKEN_EQUIVALENTS.get(word) ?? word))];
}

function digestLineGroundedInUserMessage(line, userMessage) {
	const claim = digestClaimTokens(line);
	const source = new Set(digestClaimTokens(userMessage));
	if (!claim.length || !source.size) return false;
	const shared = claim.filter((word) => source.has(word));
	const predicates = claim.filter((word) => DIGEST_PREDICATE_WORDS.has(word));
	if (predicates.some((word) => !source.has(word))) return false;
	// Every material digest token must be present (after conservative inflection
	// equivalence) in one user message. Partial overlap would allow a model to add
	// an unsupported value such as "Redis" to a grounded "building Atlas" claim.
	return shared.length === claim.length;
}

function groundDigest(digest, messages) {
	const userMessages = scopedUserMessages(messages);
	return String(digest ?? "")
		.split(/\n+/)
		.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
		.filter(Boolean)
		.filter((line) => !["noise", "utility"].includes(classifyMessage(line)))
		// Ground the whole claim in one user turn. Bag-of-words overlap across the
		// conversation can splice an entity from one user turn onto a predicate or
		// value supplied by the assistant, which would leak assistant claims into
		// both the page and graph.
		.filter((line) => userMessages.some((message) => digestLineGroundedInUserMessage(line, message)))
		.join("\n");
}

async function createManualRun(env, userId, source, sourceMode, sourcePacket, topic = null) {
	const meta = sourceMeta(sourcePacket);
	return createExtractionRun(env, userId, {
		toolName: source,
		sourceMode,
		topicFilter: topic,
		sourcePacketId: meta.source_packet_id,
		idempotencyKey: meta.idempotency_key,
		scopeJson: meta.scope_json,
		status: "running",
	});
}

async function finishNoWrite(env, userId, data) {
	const receipt = buildManualReceipt({
		id: data.receiptId ?? newId("receipt"),
		source: data.source,
		sourceMode: data.sourceMode,
		sourcePacket: data.sourcePacket,
		runId: data.runId ?? null,
		plan: data.plan ?? null,
		pagePlan: data.pagePlan ?? null,
		received: data.received,
		digested: data.digested ?? null,
		outcome: data.outcome ?? "ignored",
		reason: data.reason,
		forceZero: true,
	});
	const summary = receiptSummary(receipt, data.pagePlan);
	const storedId = await storeFinalReceipt(env, userId, data.source, receipt, summary, {
		pagePlan: data.pagePlan,
		runData: {
			status: receipt.outcome,
			skippedObjects: receipt.actions.skippedObjects,
		},
	});
	return resultFromReceipt(data.mode, data.source, data.sourcePacket, receipt, summary, storedId);
}

async function sourcePacketForDirect(env, userId, input) {
	const normalized = await normalizeSourcePacket(userId, {
		type: "message",
		sourceMode: "manual_direct",
		content: input.content,
		role: "user",
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		scope: input.memoryScope,
	});
	return { normalized, sourcePacket: await storeSourcePacket(env, normalized.packet) };
}

async function sourcePacketForConversation(env, userId, input) {
	const normalized = await normalizeSourcePacket(userId, {
		type: "message_batch",
		sourceMode: "manual_collect",
		messages: input.messages,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		scope: input.memoryScope,
	});
	return { normalized, sourcePacket: await storeSourcePacket(env, normalized.packet) };
}

function unresolvedManualReference(value) {
	const stripped = String(value ?? "").trim()
		.replace(/^(?:please\s+)?(?:remember|save|store|keep)(?:\s+this|\s+that)?\s*[:,-]?\s*/i, "")
		.trim();
	return /^(?:it|this|that|they|them|he|she|him|her)\b/i.test(stripped);
}

/** MCP-only direct manual save. It never touches USER_MEMORY or AutoMode state. */
export async function runMcpDirectSaveCommand(env, _ctx, userId, input = {}) {
	const mode = "direct_save";
	const source = "save_memory";
	const sourceMode = "manual_direct";
	const content = String(input.content ?? "").trim();
	const { normalized, sourcePacket } = await sourcePacketForDirect(env, userId, { ...input, content });

	const optOut = messagesContainMemoryOptOut(normalized.messages);
	if (optOut.optedOut) {
		const { receipt, receiptId, summary } = await storeOptOutReceipt(env, userId, source, {
			source_mode: sourceMode,
			...sourceMeta(sourcePacket),
			manual: true,
			final: true,
			processing: false,
			received: normalized.messages.length || 1,
			skipped: normalized.messages.length || 1,
			opt_out_phrase: optOut.phrase,
		});
		return resultFromReceipt(mode, source, sourcePacket, receipt, summary, receiptId);
	}

	if (!content || /^(?:please\s+)?(?:save|remember)\s+(?:this|that|it)\s*[.!?]*$/i.test(content) || unresolvedManualReference(content)) {
		const runId = await createManualRun(env, userId, source, sourceMode, sourcePacket);
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, received: normalized.messages.length || 1,
			outcome: content ? "clarification_required" : "ignored",
			reason: content ? "the submitted reference has no resolvable content" : "content is required",
		});
	}

	const runId = await createManualRun(env, userId, source, sourceMode, sourcePacket);
	const receiptId = newId("receipt");
	if ((input.idempotencyKey || input.sourceId) && Number(sourcePacket?.seen_count ?? 1) > 1) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, received: 1,
			outcome: "skipped_duplicate", reason: "idempotent retry already processed",
		});
	}

	const config = getConfig(env);
	const proposal = await extractManualFacts(env, config, {
		submittedContent: content,
		recentContext: input.recentContext,
		sourceMessages: normalized.messages,
		referenceContext: input.recentContext,
		resolvedScope: input.memoryScope ?? {},
		explicitManualSave: true,
		extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
	});
	let integrity = applyManualIntegrity(proposal, {
		submittedContent: content,
		recentContext: input.recentContext,
		sourceMessages: normalized.messages,
		referenceContext: input.recentContext,
		explicitManualSave: true,
	});
	let retrieval;
	try {
		retrieval = await retrieveManualContext(env, config, userId, integrity);
	} catch (error) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, received: 1,
			plan: {
				retrieval: {
					broad_pool_count: 0,
					card_count: 0,
					signals_used: [],
					warnings: [`retrieval_failed:${String(error?.message ?? error)}`],
				},
				rejected: [{ kind: "retrieval", label: null, reason: "manual_identity_retrieval_failed" }],
			},
			outcome: "identity_conflict",
			reason: "manual identity retrieval was unavailable; nothing was written",
		});
	}
	if (retrievalIdentityOverflow(retrieval)) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, received: 1,
			plan: { retrieval: retrieval.receipt, rejected: [] },
			outcome: "identity_conflict",
			reason: "too many exact identities matched; nothing was written",
		});
	}
	const adjudication = await adjudicateManualIdentities(env, config, {
		structure: integrity,
		cards: retrieval.cards,
		candidatesByEntityRef: retrieval.candidatesByEntityRef,
		refMap: retrieval.refMap,
		adjudicationResponse: input.adjudicationResponse ?? input.overrides?.adjudicationResponse,
	});
	integrity = applyManualAdjudication(integrity, retrieval, adjudication);
	const state = await loadManualPlanningState(env, userId, {
		nodeIds: retrieval.broadPool.map((candidate) => candidate.node_id),
		canonicalKeys: (integrity.entities ?? []).map((entity) => entity.label),
	});
	integrity = await refineManualIdentityTitles(env, config, integrity, state, {
		submittedContent: content,
		titleResponse: input.titleResponse ?? input.overrides?.titleResponse,
	});
	let plan = buildManualGraphPlan(userId, integrity, state, {
		submittedContent: content,
		adjudication,
		retrieval,
		sourcePacket,
		topicCommunities: input.topicCommunities ?? input.topic_communities ?? [],
	});
	plan.retrieval = retrieval.receipt;
	plan.ignoredMentions = [...(plan.ignoredMentions ?? []), ...(adjudication.ignored_mentions ?? [])];
	plan.overriddenRecommendations = adjudication.overridden_recommendations ?? [];
	plan.primarySubject = (integrity.entities ?? []).find((entity) => entity.ref === integrity.primary_subject_ref) ?? null;
	plan.manualDerivedRefresh = true;
	if (input.testFailAtomicWrite === true) plan.testFailAtomicWrite = true;

	if (plan.conflicts.length) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, plan, received: 1,
			outcome: "identity_conflict", reason: "ambiguous existing memory identity",
		});
	}
	if (!plan.hasGraphWrites) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, plan, received: 1,
			outcome: "ignored", reason: "the submitted content could not be safely grounded into a manual memory",
		});
	}
	if (typeof input.testBeforeWrite === "function") await input.testBeforeWrite({ plan });

	let writeResult;
	try {
		writeResult = await writeApproved(env, config, userId, plan);
		plan = reconcileManualCommit(plan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan, received: 1,
			outcome: "db_write_failed", reason: "atomic memory write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure);
		const storedId = await storeFinalReceipt(env, userId, source, failure, summary, {
			runData: { status: "failed", error: failure.error },
		});
		return resultFromReceipt(mode, source, sourcePacket, failure, summary, storedId);
	}
	if (plan.conflicts.length && !plan.hasGraphWrites) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, plan, received: 1,
			outcome: "identity_conflict", reason: "another manual save claimed this identity concurrently",
		});
	}
	const derived = await refreshManualDerivedIndexes(env, config, userId, plan, writeResult);
	plan.persistenceFailures = [...(plan.persistenceFailures ?? []), ...(derived.warnings ?? [])];

	const receipt = buildManualReceipt({
		id: receiptId, source, sourceMode, sourcePacket, runId, plan, received: 1,
		outcome: plan.conflicts.length ? "wrote_with_identity_conflict" : "wrote",
	});
	const summary = receiptSummary(receipt);
	const storedId = await storeFinalReceipt(env, userId, source, receipt, summary, {
		runData: { status: "wrote", ...plan.runLists },
	});
	return resultFromReceipt(mode, source, sourcePacket, receipt, summary, storedId);
}

/** MCP-only conversation collect: one page plus isolated grounded graph facts. */
export async function runMcpConversationCollectCommand(env, _ctx, userId, input = {}) {
	const mode = "conversation_collect";
	const source = "save_conversation";
	const sourceMode = "manual_collect";
	const { normalized, sourcePacket } = await sourcePacketForConversation(env, userId, input);
	const received = normalized.messages.length;

	const optOut = messagesContainMemoryOptOut(normalized.messages);
	if (optOut.optedOut) {
		const userCount = normalized.messages.filter((message) => message.role === "user").length;
		const { receipt, receiptId, summary } = await storeOptOutReceipt(env, userId, source, {
			source_mode: sourceMode,
			...sourceMeta(sourcePacket),
			manual: true,
			final: true,
			processing: false,
			received,
			skipped: userCount || 1,
			opt_out_phrase: optOut.phrase,
		});
		return resultFromReceipt(mode, source, sourcePacket, receipt, summary, receiptId);
	}

	const config = getConfig(env);
	const intent = parseCollectIntent(normalized.messages, input);
	const scopedMessages = messagesForCollectScope(normalized.messages, input);
	const runId = await createManualRun(env, userId, source, sourceMode, sourcePacket, intent.topic ?? null);
	const receiptId = newId("receipt");
	const conversation = buildManualConversationClaims(scopedMessages, input.contentScope ?? {});
	if (!conversation.ok) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, received,
			plan: {
				resolvedScope: conversation.resolved_scope,
				ignoredMentions: conversation.ignored,
				rejected: conversation.conflicts.map((conflict) => ({
					kind: "content_scope",
					label: conversation.resolved_scope?.subject ?? null,
					reason: conflict.code,
				})),
			},
			outcome: "clarification_required",
			reason: "conversation subject scope is ambiguous or conflicting",
		});
	}
	const claimMessages = conversation.source_messages ?? [];
	const pageMessages = conversation.page_source_messages ?? claimMessages;
	const basePageClaims = conversation.page_claims ?? conversation.claims ?? [];
	const digestResult = await digestConversation(env, config, claimMessages, {
		scope: "full",
		digestResponse: input.digestResponse,
	});
	const groundedDigest = groundDigest(digestResult.digest, claimMessages);
	const graphDigest = filterDigestByTopic(groundedDigest, intent);
	const groundedPageDigest = basePageClaims.map((claim) => String(claim?.text ?? "").trim()).filter(Boolean).join("\n");
	const digest = filterDigestByTopic(groundedPageDigest, intent);
	const keptLines = digest ? digest.split(/\n+/).filter((line) => line.trim()).length : 0;
	const submittedContent = scopedUserMessages(claimMessages).join("\n");
	let integrity = emptyConversationGraphIntegrity();
	let retrieval = emptyConversationRetrieval();
	if (submittedContent) {
		const proposal = await extractManualFacts(env, config, {
			submittedContent,
			recentContext: "",
			sourceMessages: claimMessages,
			referenceContext: conversation.reference_context,
			resolvedScope: conversation.resolved_scope,
			explicitManualSave: false,
			extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
		});
		integrity = applyManualIntegrity(proposal, {
			submittedContent,
			recentContext: "",
			sourceMessages: claimMessages,
			referenceContext: conversation.reference_context,
			explicitManualSave: false,
		});
		try {
			retrieval = await retrieveManualContext(env, config, userId, integrity);
		} catch (error) {
			const warning = `retrieval_failed:${String(error?.message ?? error)}`;
			integrity = emptyConversationGraphIntegrity([
				{ kind: "retrieval", label: null, reason: "manual_identity_retrieval_failed" },
			]);
			retrieval = emptyConversationRetrieval([warning]);
		}
		if (retrievalIdentityOverflow(retrieval)) {
			integrity = emptyConversationGraphIntegrity([
				{ kind: "retrieval", label: null, reason: "manual_identity_candidate_overflow" },
			]);
			retrieval = emptyConversationRetrieval([
				...(retrieval.receipt?.warnings ?? []),
				"graph_skipped_exact_candidate_overflow",
			]);
		}
	}
	const adjudication = await adjudicateManualIdentities(env, config, {
		structure: integrity,
		cards: retrieval.cards,
		candidatesByEntityRef: retrieval.candidatesByEntityRef,
		refMap: retrieval.refMap,
		adjudicationResponse: input.adjudicationResponse ?? input.overrides?.adjudicationResponse,
	});
	integrity = applyManualAdjudication(integrity, retrieval, adjudication);
	const state = await loadManualPlanningState(env, userId, {
		nodeIds: retrieval.broadPool.map((candidate) => candidate.node_id),
		canonicalKeys: (integrity.entities ?? []).map((entity) => entity.label),
	});
	integrity = await refineManualIdentityTitles(env, config, integrity, state, {
		submittedContent,
		titleResponse: input.titleResponse ?? input.overrides?.titleResponse,
	});
	let graphPlan = buildManualGraphPlan(userId, integrity, state, {
		submittedContent,
		adjudication,
		retrieval,
		sourcePacket,
		topicCommunities: input.topicCommunities ?? input.topic_communities ?? [],
	});
	graphPlan.retrieval = retrieval.receipt;
	graphPlan.ignoredMentions = [
		...(graphPlan.ignoredMentions ?? []),
		...(adjudication.ignored_mentions ?? []),
		...(conversation.ignored ?? []),
	];
	graphPlan.overriddenRecommendations = adjudication.overridden_recommendations ?? [];
	graphPlan.primarySubject = (integrity.entities ?? []).find((entity) => entity.ref === integrity.primary_subject_ref) ?? null;
	graphPlan.resolvedScope = conversation.resolved_scope;
	const semanticClaims = pageSynthesisClaims(conversation, integrity);
	graphPlan.conversationClaims = semanticClaims;
	graphPlan.manualDerivedRefresh = true;
	const identityHints = pageIdentityHints(integrity);
	const primaryNodeId = primaryPageNodeId(integrity, graphPlan);
	const primaryNodeIsNew = Boolean(primaryNodeId && (graphPlan.newNodes ?? []).some((node) => node.id === primaryNodeId));
	const pageSynthesis = digest && semanticClaims.length
		? await synthesizeManualPage(env, config, {
			claims: semanticClaims,
			subject: conversation.resolved_scope?.subject ?? primaryPageSubject(integrity)?.label ?? null,
			topic: intent.topic ?? input.topic ?? null,
			preferredTitle: primaryPageSubject(integrity)?.label ?? identityHints[0]?.label ?? null,
			resolvedScope: conversation.resolved_scope,
			sourceMessages: pageMessages,
			synthesisResponse: input.synthesisResponse ?? input.overrides?.synthesisResponse,
			retryResponse: input.synthesisRetryResponse ?? input.overrides?.synthesisRetryResponse,
			synthesisResponses: input.synthesisResponses ?? input.overrides?.synthesisResponses,
		})
		: null;
	let pagePlan = digest && semanticClaims.length
		? await buildManualPagePlan(env, userId, {
			digest,
			messages: pageMessages,
			claims: semanticClaims,
			semanticSynthesis: pageSynthesis,
			resolvedScope: conversation.resolved_scope,
			intent,
			received,
			keptLines,
			conversationId: input.conversationId,
			sourcePacket,
			runId,
			receiptId,
			identityHints,
			primaryNodeId,
			primaryNodeIsNew,
			config,
			queryText: [digest, graphDigest].filter(Boolean).join("\n"),
			preferredTitle: primaryPageSubject(integrity)?.label ?? identityHints[0]?.label ?? null,
			corrections: integrity.corrections,
		})
		: {
			action: "skipped",
			page: null,
			write: false,
			reason: "no_eligible_conversation_claims",
			newPages: [],
			pageUpdates: [],
			pageClaims: [],
			skipped: [{ kind: "memory_page", label: null, reason: "no_eligible_conversation_claims" }],
		};
	if (pagePlan.action === "duplicate") graphPlan = duplicateRepairGraphPlan(graphPlan);
	const conflicts = graphPlan.conflicts;
	if (conflicts.length) graphPlan = withoutGraphWrites(graphPlan);
	graphPlan.conflicts = conflicts;
	const combinedPlan = combinePagePlan(graphPlan, pagePlan);
	if (input.testFailAtomicWrite === true) combinedPlan.testFailAtomicWrite = true;
	if (!combinedPlan.hasWrites) {
		const conflict = graphPlan.conflicts.length > 0;
		const outcome = conflict
			? "identity_conflict"
			: pagePlan.action === "ambiguous"
				? "page_identity_conflict"
			: pagePlan.action === "duplicate"
				? "skipped_duplicate"
				: pagePlan.action === "suppressed"
					? "suppressed"
					: "ignored";
		return finishNoWrite(env, userId, {
			mode,
			source,
			sourceMode,
			sourcePacket,
			runId,
			receiptId,
			plan: graphPlan,
			pagePlan,
			received,
			digested: keptLines,
			outcome,
			reason: conflict ? "ambiguous existing memory identity" : pagePlan.reason ?? "no eligible grounded conversation content",
		});
	}
	if (typeof input.testBeforeWrite === "function") {
		await input.testBeforeWrite({ graphPlan, pagePlan, combinedPlan });
	}

	let writeResult;
	try {
		writeResult = await writeApproved(env, config, userId, combinedPlan);
		graphPlan = reconcileManualCommit(graphPlan, writeResult);
		pagePlan = reconcilePageCommit(pagePlan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan: graphPlan, pagePlan,
			received, digested: keptLines, outcome: "db_write_failed", reason: "atomic page and graph write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure, null);
		const storedId = await storeFinalReceipt(env, userId, source, failure, summary, {
			runData: { status: "failed", error: failure.error },
		});
		return resultFromReceipt(mode, source, sourcePacket, failure, summary, storedId);
	}
	const derived = await refreshManualDerivedIndexes(env, config, userId, graphPlan, writeResult, pagePlan);
	graphPlan.persistenceFailures = [...(graphPlan.persistenceFailures ?? []), ...(derived.warnings ?? [])];

	const pageConflict = pagePlan.action === "conflict" || pagePlan.action === "ambiguous";
	const outcome = graphPlan.conflicts.length
		? (graphPlan.hasGraphWrites || pagePlan.write ? "wrote_with_identity_conflict" : "identity_conflict")
		: pageConflict
			? (graphPlan.hasGraphWrites ? "wrote_with_page_conflict" : "page_write_conflict")
			: "wrote";
	const reason = graphPlan.conflicts.length
		? (pagePlan.write ? "page saved; ambiguous graph identity not written" : "ambiguous graph identity not written")
		: pageConflict
			? pagePlan.reason
			: pagePlan.action === "suppressed" || pagePlan.action === "duplicate" || pagePlan.action === "skipped"
				? pagePlan.reason
				: null;
	const receipt = buildManualReceipt({
		id: receiptId, source, sourceMode, sourcePacket, runId, plan: graphPlan, pagePlan,
		received, digested: keptLines, outcome,
		reason,
	});
	const summary = receiptSummary(receipt, pagePlan);
	const pageItem = pagePlan.page ? [{ id: pagePlan.page.id, title: pagePlan.page.title }] : [];
	const runData = {
		status: outcome,
		...(graphPlan.runLists ?? {}),
		createdPages: pagePlan.action === "created" ? pageItem : [],
		updatedObjects: [
			...(graphPlan.runLists?.updatedObjects ?? []),
			...(pagePlan.action === "updated" ? pageItem.map((page) => ({ kind: "memory_page", ...page })) : []),
		],
		reinforcedObjects: [
			...(graphPlan.runLists?.reinforcedObjects ?? []),
			...(pagePlan.action === "reinforced" ? pageItem.map((page) => ({ kind: "memory_page", ...page })) : []),
		],
		skippedObjects: receipt.actions.skippedObjects,
	};
	if (typeof input.testBeforeReceipt === "function") {
		await input.testBeforeReceipt({ graphPlan, pagePlan, receipt, runData });
	}
	const storedId = await storeFinalReceipt(env, userId, source, receipt, summary, { pagePlan, runData });
	return resultFromReceipt(mode, source, sourcePacket, receipt, summary, storedId);
}
