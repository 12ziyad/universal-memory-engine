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
		actions: {
			...pageActions,
			createdNodes: (committedGraph.newNodes ?? []).map((node) => ({ id: node.id, label: node.label, summary: node.summary })),
			mergedNodes: (forceZero ? [] : (graph.identityDecisions ?? []))
				.filter((decision) => decision.decision === "existing")
				.map((decision) => ({ id: decision.node_id, label: decision.label, matched_by: decision.matched_by })),
			createdSlices: (committedGraph.newSlices ?? []).map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
			createdEvents: (committedGraph.newEvents ?? []).map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
			createdEdges: (committedGraph.newEdges ?? []).map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
			reinforcedNodes: uniqueNodeTouches(committedGraph).map((nodeId) => ({ id: nodeId })),
			supersededSlices: committedGraph.sliceSupersede ?? [],
			reinforcedSlices: committedGraph.sliceTouches ?? [],
			reinforcedEvents: committedGraph.eventTouches ?? [],
			reinforcedEdges: committedGraph.edgeTouches ?? [],
			resolvedCandidates: forceZero ? [] : (graph.resolvedCandidates ?? []),
			skippedObjects: skipped,
			identityConflicts: graph.conflicts ?? [],
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
	return {
		ok: receipt.outcome !== "db_write_failed",
		command_mode: mode,
		mode,
		source,
		status: receipt.outcome,
		fired: receipt.savedTotal > 0,
		processing: false,
		summary,
		source_packet_id: receipt.source_packet_id ?? sourcePacket?.id ?? null,
		receipt_id: receiptId ?? receipt.id ?? null,
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
			candidates: 0,
			resolvedCandidates: saved.resolvedCandidates ?? 0,
			reinforcedSlices: saved.reinforcedSlices ?? 0,
			reinforcedEvents: saved.reinforcedEvents ?? 0,
			reinforcedEdges: saved.reinforcedEdges ?? 0,
		},
		identity_conflicts: receipt.identity_conflicts ?? [],
	};
}

async function storeFinalReceipt(env, userId, source, receipt, summary) {
	const storedId = await storeReceipt(env, userId, source, receipt, summary);
	return storedId ?? receipt.id ?? null;
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

function combinePagePlan(graphPlan, pagePlan) {
	return {
		...graphPlan,
		newPages: pagePlan?.newPages ?? [],
		pageUpdates: pagePlan?.pageUpdates ?? [],
		hasWrites: Boolean(graphPlan?.hasGraphWrites || pagePlan?.write),
	};
}

function runListsForPlan(plan) {
	return {
		createdNodes: (plan.newNodes ?? []).map((node) => ({ id: node.id, label: node.label })),
		createdSlices: (plan.newSlices ?? []).map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
		createdEvents: (plan.newEvents ?? []).map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
		createdEdges: (plan.newEdges ?? []).map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
		updatedObjects: uniqueNodeTouches(plan).map((id) => ({ kind: "node", id })),
		reinforcedObjects: [
			...(plan.sliceTouches ?? []).map((item) => ({ kind: "slice", id: item.id })),
			...(plan.eventTouches ?? []).map((item) => ({ kind: "event", id: item.id })),
			...(plan.edgeTouches ?? []).map((item) => ({ kind: "edge", id: item.id })),
		],
		skippedObjects: plan.rejected ?? [],
	};
}

async function reconcileManualCommit(env, userId, plan, writeResult) {
	if (!writeResult?.committed) return plan;
	const committed = writeResult.committed;
	const nodeIds = new Set(committed.nodes);
	const sliceIds = new Set(committed.slices);
	const eventIds = new Set(committed.events);
	const edgeIds = new Set(committed.edges);
	const missingNodes = (plan.newNodes ?? []).filter((node) => !nodeIds.has(node.id));
	const copy = {
		...plan,
		newNodes: (plan.newNodes ?? []).filter((node) => nodeIds.has(node.id)),
		newSlices: (plan.newSlices ?? []).filter((slice) => sliceIds.has(slice.id)),
		newEvents: (plan.newEvents ?? []).filter((event) => eventIds.has(event.id)),
		newEdges: (plan.newEdges ?? []).filter((edge) => edgeIds.has(edge.id)),
		nodeSummaryUpdates: (plan.nodeSummaryUpdates ?? []).filter((update) =>
			!missingNodes.some((node) => node.id === update.id)),
		candidateResolutions: (plan.candidateResolutions ?? []).filter((resolution) =>
			!missingNodes.some((node) => node.id === resolution.node_id)),
		resolvedCandidates: (plan.resolvedCandidates ?? []).filter((resolution) =>
			!missingNodes.some((node) => node.id === resolution.node_id)),
		conflicts: [...(plan.conflicts ?? [])],
	};
	for (const missing of missingNodes) {
		const winner = await env.DB.prepare(
			`SELECT n.id, n.label, n.category
			 FROM manual_node_identities i
			 LEFT JOIN nodes n ON n.id = i.node_id AND n.user_id = i.user_id
			 WHERE i.user_id = ? AND i.canonical_key = ?`,
		)
			.bind(userId, missing.identity_key)
			.first();
		copy.conflicts.push({
			label: missing.label,
			reason: "concurrent_identity_claim",
			matches: winner?.id ? [{ id: winner.id, label: winner.label, category: winner.category, score: 1 }] : [],
		});
	}
	copy.hasGraphWrites = Boolean(
		copy.newNodes.length || copy.nodeTouches?.length || copy.nodeStateUpdates?.length || copy.nodeAliasUpdates?.length ||
		copy.newSlices.length || copy.sliceTouches?.length || copy.sliceSupersede?.length ||
		copy.newEvents.length || copy.eventTouches?.length || copy.newEdges.length || copy.edgeTouches?.length ||
		copy.candidateResolutions.length,
	);
	copy.hasWrites = copy.hasGraphWrites;
	copy.runLists = runListsForPlan(copy);
	return copy;
}

function scopedUserText(messages) {
	return (messages ?? [])
		.filter((message) => (message?.role ?? "user") === "user")
		.map((message) => String(message?.content ?? "").trim())
		.filter(Boolean)
		.join("\n");
}

function messagesForCollectScope(messages, input) {
	const all = messages ?? [];
	if (input.scope === "lastN") {
		const count = Math.max(1, Number(input.n ?? 20));
		return all.slice(-count);
	}
	if (input.scope === "topic" && input.topic) {
		const topic = String(input.topic).toLocaleLowerCase("en-US");
		return all.filter((message) => String(message?.content ?? "").toLocaleLowerCase("en-US").includes(topic));
	}
	return all;
}

function contentWords(value) {
	return String(value ?? "").toLocaleLowerCase("en-US").match(/[a-z0-9]+/g) ?? [];
}

const DIGEST_GENERIC_WORDS = new Set([
	"about", "also", "building", "changed", "decided", "important", "main", "matter", "matters",
	"memory", "project", "projects", "purchase", "research", "started", "stopped", "storage", "the", "user", "uses", "using",
]);

function groundDigest(digest, messages) {
	const userText = scopedUserText(messages);
	const sourceWords = new Set(contentWords(userText));
	return String(digest ?? "")
		.split(/\n+/)
		.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
		.filter(Boolean)
		.filter((line) => !["noise", "utility"].includes(classifyMessage(line)))
		.filter((line) => {
			const words = [...new Set(contentWords(line).filter((word) => word.length > 2))];
			if (!words.length) return false;
			const shared = words.filter((word) => sourceWords.has(word)).length;
			const anchors = words.filter((word) => !DIGEST_GENERIC_WORDS.has(word));
			const anchored = !anchors.length || anchors.some((word) => sourceWords.has(word));
			return anchored && shared >= Math.min(2, words.length);
		})
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
		await updateExtractionRun(env, userId, data.runId, {
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
		extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
	});
	const integrity = applyManualIntegrity(proposal, {
		submittedContent: content,
		recentContext: input.recentContext,
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

	try {
		const writeResult = await writeApproved(env, config, userId, plan);
		plan = await reconcileManualCommit(env, userId, plan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan, received: 1,
			outcome: "db_write_failed", reason: "atomic memory write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure);
		await updateExtractionRun(env, userId, runId, { status: "failed", error: failure.error });
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
	await updateExtractionRun(env, userId, runId, { status: "wrote", ...plan.runLists });
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
	if (!digest) {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, received, digested: 0,
			outcome: "ignored", reason: "no durable user facts in the submitted conversation",
		});
	}

	const pagePlan = await buildManualPagePlan(env, userId, {
		digest,
		messages: scopedMessages,
		intent,
		received,
		keptLines,
		conversationId: input.conversationId,
		sourcePacket,
		runId,
		receiptId,
	});
	if (pagePlan.action === "duplicate" || pagePlan.action === "suppressed") {
		return finishNoWrite(env, userId, {
			mode, source, sourceMode, sourcePacket, runId, receiptId, pagePlan, received, digested: keptLines,
			outcome: pagePlan.action === "duplicate" ? "skipped_duplicate" : "suppressed",
			reason: pagePlan.reason,
		});
	}

	const state = await loadManualGraphState(env, userId);
	const proposal = await extractManualFacts(env, config, {
		submittedContent: digest,
		recentContext: "",
		nodes: state.nodes,
		extractionResponse: input.extractionResponse ?? input.overrides?.llmResponse,
	});
	const integrity = applyManualIntegrity(proposal, { submittedContent: digest, recentContext: "" });
	let graphPlan = buildManualGraphPlan(userId, integrity, state, { submittedContent: digest });
	const conflicts = graphPlan.conflicts;
	if (conflicts.length) graphPlan = withoutGraphWrites(graphPlan);
	graphPlan.conflicts = conflicts;
	const combinedPlan = combinePagePlan(graphPlan, pagePlan);
	if (input.testFailAtomicWrite === true) combinedPlan.testFailAtomicWrite = true;

	try {
		const writeResult = await writeApproved(env, config, userId, combinedPlan);
		graphPlan = await reconcileManualCommit(env, userId, graphPlan, writeResult);
	} catch (error) {
		const failure = buildManualReceipt({
			id: receiptId, source, sourceMode, sourcePacket, runId, plan: graphPlan, pagePlan,
			received, digested: keptLines, outcome: "db_write_failed", reason: "atomic page and graph write failed", forceZero: true,
		});
		failure.error = String(error?.message ?? error);
		const summary = receiptSummary(failure, null);
		await updateExtractionRun(env, userId, runId, { status: "failed", error: failure.error });
		const storedId = await storeFinalReceipt(env, userId, source, failure, summary);
		return resultFromReceipt(mode, source, sourcePacket, failure, summary, storedId);
	}

	const outcome = graphPlan.conflicts.length ? "wrote_with_identity_conflict" : "wrote";
	const receipt = buildManualReceipt({
		id: receiptId, source, sourceMode, sourcePacket, runId, plan: graphPlan, pagePlan,
		received, digested: keptLines, outcome,
		reason: graphPlan.conflicts.length ? "page saved; ambiguous graph identity not written" : null,
	});
	const summary = receiptSummary(receipt, pagePlan);
	const pageItem = pagePlan.page ? [{ id: pagePlan.page.id, title: pagePlan.page.title }] : [];
	await updateExtractionRun(env, userId, runId, {
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
	if (pagePlan.page?.id && storedId) {
		await env.DB.prepare("UPDATE memory_pages SET receipt_id = ? WHERE id = ? AND user_id = ?")
			.bind(storedId, pagePlan.page.id, userId)
			.run();
	}
	return resultFromReceipt(mode, source, sourcePacket, receipt, summary, storedId);
}
