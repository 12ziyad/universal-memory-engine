/**
 * The extraction orchestrator. Given a fired chunk, runs the back half of the
 * pipeline and reports what happened so the Durable Object can manage the
 * checkpoint and held chunk correctly:
 *
 *   build packet → shortlist → LLM propose → gates → write → (pass 2)
 *
 * Returns one of:
 *   { outcome: "wrote", affectedNodeIds, newNodes, receipt }   advance, clear chunk
 *   { outcome: "meaningful_no_write", receipt }                 keep chunk, do NOT advance
 *   { outcome: "llm_failed", receipt }                          keep chunk, do NOT advance
 *   { outcome: "db_write_failed", error, receipt }              keep chunk, do NOT advance
 *
 * Every outcome carries a `receipt` (Priority 5) so the caller can store it and
 * report a clear result instead of a vague message.
 *
 * `overrides` may carry: { llmResponse, settings, manual, source, meta }.
 * `manual: true` is Path A (user-commanded save) → lenient gate.
 *
 * This module never touches DO storage or the checkpoint itself — that is the
 * DO's job, so the "decide vs. persist" split stays clean.
 */

import { getConfig } from "../config.js";
import { buildPacket, chunkText } from "./packet.js";
import { shortlistNodes } from "./shortlist.js";
import { proposeMemory } from "./llm.js";
import { applyGates } from "./gates.js";
import { writeApproved } from "./write.js";
import { runPass2 } from "./pass2.js";
import { buildReceipt, emptyReceipt } from "./receipt.js";
import { createExtractionRun, createMemoryJob, updateExtractionRun, updateMemoryJob } from "../lib/db.js";
import { messagesContainMemoryOptOut } from "./opt_out.js";

const UPDATE_MODE_RE = /\b(actually|correction|no longer|from now on|replace|instead|forget that|not anymore|it is now|it's now)\b/i;

async function proposeSplit(env, config, userId, chunk, recent, overrides) {
	const objects = [];
	const notes = [];
	const parts = await Promise.all(chunk.map(async (msg) => {
		const singlePacket = buildPacket([msg], recent);
		const singleText = chunkText([msg]);
		const singleShortlist = await shortlistNodes(env, config, userId, singleText);
		const single = await proposeMemory(env, config, { packet: singlePacket, shortlist: singleShortlist }, overrides);
		if (!single._ok) {
			console.warn(`llm split rescue failed user=${userId} msg=${msg.id} notes=${single.notes}`);
			return null;
		}
		return single;
	}));
	if (parts.some((part) => !part)) return null;
	for (const single of parts) {
		objects.push(...(single.objects ?? []));
		if (single.notes) notes.push(single.notes);
	}
	return {
		objects,
		notes: `split_rescue${notes.length ? `: ${notes.join("; ")}` : ""}`,
		_ok: true,
	};
}

async function proposeWithSplitRescue(env, config, userId, chunk, recent, packet, shortlist, overrides) {
	if (overrides.manual && chunk.length > 1) {
		console.warn(`manual chunk has ${chunk.length} retained message(s); splitting before LLM`);
		const split = await proposeSplit(env, config, userId, chunk, recent, overrides);
		if (split) return { proposal: split, rescued: true };
		return { proposal: { objects: [], notes: "split_rescue_failed", _ok: false }, rescued: false };
	}

	const proposal = await proposeMemory(env, config, { packet, shortlist }, overrides);
	if (proposal._ok || chunk.length <= 1) {
		return { proposal, rescued: false };
	}

	console.warn(`llm primary parse failed user=${userId}; retrying ${chunk.length} message(s) individually`);
	const split = await proposeSplit(env, config, userId, chunk, recent, overrides);
	if (split) return { proposal: split, rescued: true };
	return { proposal, rescued: false };
}

function runListsFromPlan(plan) {
	return {
		createdNodes: (plan.newNodes ?? []).map((n) => ({ id: n.id, label: n.label })),
		createdSlices: (plan.newSlices ?? []).map((s) => ({ id: s.id, node_id: s.node_id, kind: s.kind })),
		createdEvents: (plan.newEvents ?? []).map((e) => ({ id: e.id, node_id: e.node_id, action: e.action })),
		createdEdges: (plan.newEdges ?? []).map((e) => ({ id: e.id, from_node: e.from_node, to_node: e.to_node, type: e.type })),
		updatedObjects: [
			...[...(plan.nodeTouches ?? [])].map((id) => ({ kind: "node", id })),
			...(plan.nodeStateUpdates ?? []).map((u) => ({ kind: "node", id: u.id, state: u.state })),
		],
		reinforcedObjects: [
			...(plan.sliceTouches ?? []).map((s) => ({ kind: "slice", id: s.id })),
			...(plan.eventTouches ?? []).map((e) => ({ kind: "event", id: e.id })),
			...(plan.edgeTouches ?? []).map((e) => ({ kind: "edge", id: e.id })),
		],
		skippedObjects: plan.rejected ?? [],
	};
}

export async function runExtraction(env, userId, chunk, recent, overrides = {}) {
	const config = getConfig(env);
	const sourceMode = overrides.meta?.source_mode
		?? (overrides.manual
			? (overrides.source === "save_conversation" ? "manual_collect" : "manual_direct")
			: "auto_ingest");
	const meta = {
		source: overrides.source ?? "ingest",
		source_mode: sourceMode,
		...(overrides.meta ?? {}),
	};
	const optOut = messagesContainMemoryOptOut(chunk);
	if (optOut.optedOut) {
		const receipt = emptyReceipt("no_write", "user_opt_out", {
			...meta,
			received: chunk.filter((m) => (m?.role ?? "user") === "user").length,
		});
		receipt.durable = false;
		receipt.opt_out = true;
		receipt.opt_out_phrase = optOut.phrase;
		receipt.skippedReasons = { user_opt_out: receipt.received || 1 };
		return { outcome: "no_write", receipt };
	}
	const extractionRunId = await createExtractionRun(env, userId, {
		toolName: overrides.source ?? "ingest",
		sourceMode,
		topicFilter: meta.topic_filter ?? null,
		sourcePacketId: meta.source_packet_id ?? null,
		idempotencyKey: meta.idempotency_key ?? null,
		scopeJson: meta.scope_json ?? null,
		status: "running",
	});
	meta.extraction_run_id = extractionRunId;

	// D — packet (three separated parts).
	const packet = buildPacket(chunk, recent);
	const text = chunkText(chunk);
	const updateMode = UPDATE_MODE_RE.test(text);

	// E — shortlist (~10 existing nodes, keyword + semantic).
	const shortlist = await shortlistNodes(env, config, userId, text);

	// F — LLM proposes (deterministic in tests via overrides.llmResponse).
	const { proposal, rescued } = await proposeWithSplitRescue(
		env,
		config,
		userId,
		chunk,
		recent,
		packet,
		shortlist,
		overrides,
	);
	if (rescued) meta.splitRescue = true;
	if (!proposal._ok) {
		console.warn(`extraction llm_failed user=${userId} notes=${proposal.notes}`);
		await updateExtractionRun(env, userId, extractionRunId, {
			status: "failed",
			error: "the extractor returned nothing readable",
		});
		return {
			outcome: "llm_failed",
			receipt: emptyReceipt("llm_failed", "the extractor returned nothing I could read", meta),
		};
	}

	// G — gates (the backend judge). manual=true → lenient Path A gate.
	const plan = await applyGates(env, config, userId, proposal, shortlist, overrides.settings, {
		manual: Boolean(overrides.manual),
		updateMode,
		sourceText: text,
	});

	// Meaningful chunk but nothing approved → keep for retry, do NOT advance.
	if (!plan.hasWrites) {
		console.warn(`extraction meaningful_no_write user=${userId}`);
		await updateExtractionRun(env, userId, extractionRunId, {
			status: "skipped",
			skippedObjects: plan.rejected ?? [],
		});
		return {
			outcome: "meaningful_no_write",
			rejected: plan.rejected,
			receipt: buildReceipt("meaningful_no_write", plan, meta),
		};
	}

	// H — write (atomic). On failure, keep chunk + checkpoint.
	let result;
	try {
		result = await writeApproved(env, config, userId, plan);
	} catch (err) {
		console.error(`extraction db_write_failed user=${userId}:`, err?.message ?? err);
		await updateExtractionRun(env, userId, extractionRunId, {
			status: "failed",
			error: String(err?.message ?? err),
		});
		return {
			outcome: "db_write_failed",
			error: String(err?.message ?? err),
			receipt: emptyReceipt("db_write_failed", "a storage error interrupted the save", meta),
		};
	}

	const receipt = buildReceipt("wrote", plan, meta);
	await updateExtractionRun(env, userId, extractionRunId, {
		status: "wrote",
		...runListsFromPlan(plan),
	});

	// I — Pass 2 (background, cheap). Never affects Pass-1 writes.
	const jobId = await createMemoryJob(env, userId, {
		type: "pass2_rollup",
		status: "running",
		idempotencyKey: `pass2:${extractionRunId}`,
		sourcePacketId: meta.source_packet_id ?? null,
		extractionRunId,
		payload: { affectedNodeIds: result.affectedNodeIds },
	});
	if (jobId) await updateExtractionRun(env, userId, extractionRunId, { jobId });
	try {
		const pass2 = await runPass2(env, config, userId, result.affectedNodeIds, { jobId });
		await updateMemoryJob(env, userId, jobId, {
			status: pass2?.ran ? "completed" : "skipped",
			payload: { affectedNodeIds: result.affectedNodeIds, pass2 },
			completedAt: Date.now(),
		});
	} catch (err) {
		console.warn(`pass2 failed user=${userId}:`, err?.message ?? err);
		await updateMemoryJob(env, userId, jobId, {
			status: "failed",
			error: String(err?.message ?? err),
			completedAt: Date.now(),
		});
	}

	return { outcome: "wrote", ...result, receipt };
}
