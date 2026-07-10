import { getConfig } from "../config.js";
import {
	createExtractionRun,
	storeReceipt,
	updateExtractionRun,
} from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { digestConversation } from "./digest.js";
import { extractManualFacts } from "./manual_extract.js";
import { applyManualIntegrity } from "./manual_integrity.js";
import { buildManualPagePlan } from "./manual_page.js";
import { buildManualGraphPlan, loadManualGraphState } from "./manual_plan.js";
import { refineManualIdentityTitles } from "./manual_titles.js";
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
	"nodeSummaryUpdates",
	"identityClaims",
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
		return `${pagePrefix}Saved: 0. Reason: ${receipt.reason ?? "no durable facts were found in the submitted content"}.`;
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
	const graphText = parts.length ? `Saved graph: ${parts.join(", ")}.` : "Graph: no additional durable facts.";
	return `${pagePrefix}${graphText}`.trim();
}

function resultFromReceipt(mode, source, sourcePacket, receipt, summary, receiptId = null) {
	const saved = receipt.saved ?? emptySaved();
	const receiptPersisted = Boolean(receiptId);
	receipt.receipt_persisted = receiptPersisted;
	const finalSummary = receiptPersisted
		? summary
		: `${summary} Receipt persistence failed; the structured receipt is returned here but no receipt row was created.`;
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
		warnings: receiptPersisted ? [] : ["receipt_persistence_failed"],
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

async function storeFinalReceipt(env, userId, source, receipt, summary) {
	const storedId = await storeReceipt(env, userId, source, receipt, summary);
	return storedId ?? null;
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
		copy.newNodes?.length || copy.nodeTouches.length || copy.nodeStateUpdates.length || copy.nodeAliasUpdates?.length ||
		copy.newSlices?.length || copy.sliceSupersede.length || copy.newEvents?.length || copy.newEdges?.length || copy.edgeSupersede.length ||
		copy.candidateResolutions?.length || copy.nodeSummaryUpdates.length,
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
		newNodes: (plan.newNodes ?? []).filter((node) => nodeIds.has(node.id)),
		newSlices: (plan.newSlices ?? []).filter((slice) => sliceIds.has(slice.id)),
		newEvents: (plan.newEvents ?? []).filter((event) => eventIds.has(event.id)),
		newEdges: (plan.newEdges ?? []).filter((edge) => edgeIds.has(edge.id)),
		nodeSummaryUpdates: (plan.nodeSummaryUpdates ?? []).filter((update) =>
			!missingNodes.some((node) => node.id === update.id)),
		sliceSupersede: (plan.sliceSupersede ?? []).filter((item) =>
			!item.replacement_id || sliceIds.has(item.replacement_id)),
		sliceTouches: mergeTouches(plan.sliceTouches, fallback.slices),
		eventTouches: mergeTouches(plan.eventTouches, fallback.events),
		edgeTouches: mergeTouches(plan.edgeTouches, fallback.edges),
		edgeSupersede: (plan.edgeSupersede ?? []).filter((edge) => supersededEdgeIds.has(edge.id)),
		candidateResolutions: (plan.candidateResolutions ?? []).filter((resolution) => candidateIds.has(resolution.id)),
		resolvedCandidates: (plan.resolvedCandidates ?? []).filter((resolution) => candidateIds.has(resolution.id)),
		conflicts: [...(plan.conflicts ?? [])],
	};
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
		return {
			...action,
			superseded_edge_id: action.superseded_edge_id && supersededEdgeIds.has(action.superseded_edge_id)
				? action.superseded_edge_id
				: null,
			replacement_edge_id: action.replacement_edge_id && edgeIds.has(action.replacement_edge_id)
				? action.replacement_edge_id
				: reinforced?.id ?? touched?.id ?? null,
		};
	});
	for (const missing of missingNodes) {
		copy.conflicts.push({
			label: missing.label,
			reason: "concurrent_identity_claim",
			matches: [],
		});
	}
	copy.hasGraphWrites = Boolean(
		copy.newNodes.length || copy.nodeTouches?.length || copy.nodeStateUpdates?.length || copy.nodeAliasUpdates?.length ||
		copy.newSlices.length || copy.sliceTouches?.length || copy.sliceSupersede?.length ||
		copy.newEvents.length || copy.eventTouches?.length || copy.newEdges.length || copy.edgeTouches?.length || copy.edgeSupersede.length ||
		copy.candidateResolutions.length,
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

async function bestEffortUpdateRun(env, userId, runId, data) {
	if (!runId) return;
	try {
		await updateExtractionRun(env, userId, runId, data);
	} catch (error) {
		console.warn("manual extraction-run finalization failed:", error?.message ?? error);
	}
}

async function bestEffortLinkReceipt(env, userId, pageId, receiptId) {
	if (!pageId || !receiptId) return;
	try {
		await env.DB.prepare("UPDATE memory_pages SET receipt_id = ? WHERE id = ? AND user_id = ?")
			.bind(receiptId, pageId, userId)
			.run();
	} catch (error) {
		console.warn("manual page receipt link failed:", error?.message ?? error);
	}
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
	if (data.runId) {
		await bestEffortUpdateRun(env, userId, data.runId, {
			status: receipt.outcome,
			skippedObjects: receipt.actions.skippedObjects,
		});
	}
	const storedId = await storeFinalReceipt(env, userId, data.source, receipt, summary);
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

	if (!content || ["noise", "utility"].includes(classifyMessage(content))) {
		const runId = await createManualRun(env, userId, source, sourceMode, sourcePacket);
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, received: normalized.messages.length || 1,
			outcome: "ignored", reason: content ? "no durable facts in the submitted content" : "content is required",
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
	const state = await loadManualGraphState(env, userId);
	const proposal = await extractManualFacts(env, config, {
		submittedContent: content,
		recentContext: input.recentContext,
		nodes: state.nodes,
		graphState: state,
		extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
	});
	const integrity = await refineManualIdentityTitles(env, config, applyManualIntegrity(proposal, {
		submittedContent: content,
		recentContext: input.recentContext,
	}), state, {
		submittedContent: content,
		titleResponse: input.titleResponse ?? input.overrides?.titleResponse,
	});
	let plan = buildManualGraphPlan(userId, integrity, state, { submittedContent: content });
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
			outcome: "ignored", reason: "no durable facts in the submitted content",
		});
	}
	if (typeof input.testBeforeWrite === "function") await input.testBeforeWrite({ plan });

	try {
		const writeResult = await writeApproved(env, config, userId, plan);
		plan = reconcileManualCommit(plan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan, received: 1,
			outcome: "db_write_failed", reason: "atomic memory write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure);
		await bestEffortUpdateRun(env, userId, runId, { status: "failed", error: failure.error });
		const storedId = await storeFinalReceipt(env, userId, source, failure, summary);
		return resultFromReceipt(mode, source, sourcePacket, failure, summary, storedId);
	}
	if (plan.conflicts.length && !plan.hasGraphWrites) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, plan, received: 1,
			outcome: "identity_conflict", reason: "another manual save claimed this identity concurrently",
		});
	}

	const receipt = buildManualReceipt({
		id: receiptId, source, sourceMode, sourcePacket, runId, plan, received: 1,
		outcome: plan.conflicts.length ? "wrote_with_identity_conflict" : "wrote",
	});
	const summary = receiptSummary(receipt);
	await bestEffortUpdateRun(env, userId, runId, { status: "wrote", ...plan.runLists });
	const storedId = await storeFinalReceipt(env, userId, source, receipt, summary);
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
	const digestResult = await digestConversation(env, config, scopedMessages, {
		scope: input.scope,
		n: input.n,
		topic: input.topic,
		digestResponse: input.digestResponse,
	});
	const groundedDigest = groundDigest(digestResult.digest, scopedMessages);
	const digest = filterDigestByTopic(groundedDigest, intent);
	const keptLines = digest ? digest.split(/\n+/).filter((line) => line.trim()).length : 0;
	const state = await loadManualGraphState(env, userId);
	const submittedContent = scopedUserMessages(scopedMessages).join("\n");
	const proposal = await extractManualFacts(env, config, {
		submittedContent,
		recentContext: "",
		nodes: state.nodes,
		graphState: state,
		extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
	});
	const integrity = await refineManualIdentityTitles(
		env,
		config,
		applyManualIntegrity(proposal, { submittedContent, recentContext: "" }),
		state,
		{
			submittedContent,
			titleResponse: input.titleResponse ?? input.overrides?.titleResponse,
		},
	);
	let graphPlan = buildManualGraphPlan(userId, integrity, state, { submittedContent });
	const identityHints = pageIdentityHints(integrity);
	let pagePlan = digest
		? await buildManualPagePlan(env, userId, {
			digest,
			messages: scopedMessages,
			intent,
			received,
			keptLines,
			conversationId: input.conversationId,
			sourcePacket,
			runId,
			receiptId,
			identityHints,
			preferredTitle: identityHints[0]?.label ?? null,
			corrections: integrity.corrections,
		})
		: {
			action: "skipped",
			page: null,
			write: false,
			reason: "no_grounded_conversation_digest",
			newPages: [],
			pageUpdates: [],
			pageClaims: [],
			skipped: [{ kind: "memory_page", label: null, reason: "no_grounded_conversation_digest" }],
		};
	if (graphPlan.conflicts.length && integrity.corrections.length && pagePlan.write) {
		pagePlan = {
			...pagePlan,
			action: "ambiguous",
			write: false,
			reason: "graph_identity_conflict",
			newPages: [],
			pageUpdates: [],
			pageClaims: [],
			page_conflicts: [
				...(pagePlan.page_conflicts ?? []),
				{ kind: "memory_page", label: pagePlan.page?.title ?? null, reason: "graph_identity_conflict" },
			],
		};
	}
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
			reason: conflict ? "ambiguous existing memory identity" : pagePlan.reason ?? "no durable user facts in the submitted conversation",
		});
	}
	if (typeof input.testBeforeWrite === "function") {
		await input.testBeforeWrite({ graphPlan, pagePlan, combinedPlan });
	}

	try {
		const writeResult = await writeApproved(env, config, userId, combinedPlan);
		graphPlan = reconcileManualCommit(graphPlan, writeResult);
		pagePlan = reconcilePageCommit(pagePlan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan: graphPlan, pagePlan,
			received, digested: keptLines, outcome: "db_write_failed", reason: "atomic page and graph write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure, null);
		await bestEffortUpdateRun(env, userId, runId, { status: "failed", error: failure.error });
		const storedId = await storeFinalReceipt(env, userId, source, failure, summary);
		return resultFromReceipt(mode, source, sourcePacket, failure, summary, storedId);
	}

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
	await bestEffortUpdateRun(env, userId, runId, {
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
	});
	const storedId = await storeFinalReceipt(env, userId, source, receipt, summary);
	if (["created", "updated", "reinforced", "duplicate"].includes(pagePlan.action)) {
		await bestEffortLinkReceipt(env, userId, pagePlan.page?.id, storedId);
	}
	return resultFromReceipt(mode, source, sourcePacket, receipt, summary, storedId);
}
