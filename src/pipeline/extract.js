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

export async function runExtraction(env, userId, chunk, recent, overrides = {}) {
	const config = getConfig(env);
	const meta = { source: overrides.source ?? "ingest", ...(overrides.meta ?? {}) };

	// D — packet (three separated parts).
	const packet = buildPacket(chunk, recent);
	const text = chunkText(chunk);

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
		return {
			outcome: "llm_failed",
			receipt: emptyReceipt("llm_failed", "the extractor returned nothing I could read", meta),
		};
	}

	// G — gates (the backend judge). manual=true → lenient Path A gate.
	const plan = await applyGates(env, config, userId, proposal, shortlist, overrides.settings, {
		manual: Boolean(overrides.manual),
	});

	// Meaningful chunk but nothing approved → keep for retry, do NOT advance.
	if (!plan.hasWrites) {
		console.warn(`extraction meaningful_no_write user=${userId}`);
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
		return {
			outcome: "db_write_failed",
			error: String(err?.message ?? err),
			receipt: emptyReceipt("db_write_failed", "a storage error interrupted the save", meta),
		};
	}

	const receipt = buildReceipt("wrote", plan, meta);

	// I — Pass 2 (background, cheap). Never affects Pass-1 writes.
	try {
		await runPass2(env, config, userId, result.affectedNodeIds);
	} catch (err) {
		console.warn(`pass2 failed user=${userId}:`, err?.message ?? err);
	}

	return { outcome: "wrote", ...result, receipt };
}
