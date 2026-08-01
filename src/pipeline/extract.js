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
import { getMemoryRules } from "./rules.js";
import { flushAiMeter, tagAiMeter, withAiMeter } from "../lib/ai_meter.js";

const UPDATE_MODE_RE = /\b(actually|correction|no longer|from now on|replace|instead|forget that|not anymore|it is now|it's now)\b/i;

// Rescue batches run a few messages at a time so an abort decision happens
// BEFORE the next batch spends anything — the old Promise.all over the whole
// chunk had already spent everything by the time it learned it failed.
const SPLIT_RESCUE_BATCH = 4;

/**
 * Per-message re-extraction with a spending contract:
 *   - never starts if the chunk alone would blow `maxCalls` (over_ceiling)
 *   - abandons as soon as `failFast` messages have failed to parse (fail_fast)
 *   - tolerates fewer failures than that, keeping what parsed — a 46/47 parse
 *     is a save with one dropped message, not 5,000 wasted neurons
 * Always returns { split, stats }: stats reports calls actually made, failures,
 * and why it stopped, so the receipt can say what this rescue really cost.
 */
async function proposeSplit(env, config, userId, chunk, recent, overrides, limits = {}) {
	const maxCalls = Number.isFinite(limits.maxCalls) ? limits.maxCalls : Infinity;
	const failFast = Number.isFinite(limits.failFast) ? limits.failFast : 3;
	const stats = { calls: 0, failures: 0, aborted: null };

	if (chunk.length > maxCalls) {
		console.warn(`split rescue refused user=${userId}: ${chunk.length} messages > ceiling ${maxCalls}`);
		stats.aborted = "over_ceiling";
		return { split: null, stats };
	}

	const objects = [];
	const notes = [];
	for (let i = 0; i < chunk.length; i += SPLIT_RESCUE_BATCH) {
		const batch = chunk.slice(i, i + SPLIT_RESCUE_BATCH);
		const parts = await Promise.all(batch.map(async (msg) => {
			const singlePacket = buildPacket([msg], recent);
			const singleText = chunkText([msg]);
			const singleShortlist = await shortlistNodes(env, config, userId, singleText);
			stats.calls += 1;
			const single = await proposeMemory(env, config, { packet: singlePacket, shortlist: singleShortlist }, overrides);
			if (!single._ok) {
				console.warn(`llm split rescue failed user=${userId} msg=${msg.id} notes=${single.notes}`);
				return null;
			}
			return single;
		}));
		for (const single of parts) {
			if (!single) {
				stats.failures += 1;
				continue;
			}
			objects.push(...(single.objects ?? []));
			if (single.notes) notes.push(single.notes);
		}
		if (stats.failures >= failFast) {
			stats.aborted = "fail_fast";
			return { split: null, stats };
		}
	}

	if (objects.length === 0 && stats.failures > 0) {
		// Everything that failed stayed under the fail-fast line, but nothing
		// parsed either — there is no partial result to keep.
		stats.aborted = "all_failed";
		return { split: null, stats };
	}

	return {
		split: {
			objects,
			notes: `split_rescue${notes.length ? `: ${notes.join("; ")}` : ""}`,
			_ok: true,
		},
		stats,
	};
}

async function proposeWithSplitRescue(env, config, userId, chunk, recent, packet, shortlist, overrides) {
	const limits = config.splitRescue ?? {};
	if (overrides.manual && chunk.length > 1) {
		console.warn(`manual chunk has ${chunk.length} retained message(s); splitting before LLM`);
		// The manual path splits deliberately (it is not rescuing a failed
		// parse), so the ceiling does not apply — but fail-fast still does: a
		// systematically unparseable conversation is abandoned, not walked.
		const { split, stats } = await proposeSplit(env, config, userId, chunk, recent, overrides, {
			failFast: limits.failFast,
		});
		if (split) return { proposal: split, rescued: true, rescueStats: stats };
		return {
			proposal: { objects: [], notes: `split_rescue_failed${stats.aborted ? ` (${stats.aborted})` : ""}`, _ok: false },
			rescued: false,
			rescueStats: stats,
		};
	}

	const proposal = await proposeMemory(env, config, { packet, shortlist }, overrides);
	if (proposal._ok || chunk.length <= 1) {
		return { proposal, rescued: false, rescueStats: null };
	}

	console.warn(`llm primary parse failed user=${userId}; retrying ${chunk.length} message(s) individually`);
	const { split, stats } = await proposeSplit(env, config, userId, chunk, recent, overrides, limits);
	if (split) return { proposal: split, rescued: true, rescueStats: stats };
	return { proposal, rescued: false, rescueStats: stats };
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

/**
 * A save, wrapped in a Workers AI meter. Every model call the extraction makes
 * — extract, digest, pass-2 summaries, embeddings — is attributed to this one
 * run, then written to `ai_calls` and rolled up onto the receipt.
 *
 * Metering is strictly observational: it cannot alter the result, and a failure
 * inside it is swallowed rather than allowed to fail a save.
 */
export async function runExtraction(env, userId, chunk, recent, overrides = {}) {
	return withAiMeter("save", async (meter) => {
		const result = await runExtractionInner(env, userId, chunk, recent, overrides, meter);
		try {
			const totals = await flushAiMeter(env, userId, meter);
			if (result?.receipt) {
				result.receipt.ai_calls = totals.calls;
				result.receipt.ai_input_tokens = totals.input_tokens;
				result.receipt.ai_output_tokens = totals.output_tokens;
				result.receipt.ai_neurons = totals.neurons;
			}
		} catch (error) {
			console.warn("ai meter rollup failed:", error?.message ?? error);
		}
		return result;
	});
}

async function runExtractionInner(env, userId, chunk, recent, overrides = {}, meter = null) {
	const config = getConfig(env);
	// Wall time for the whole extraction, carried onto every receipt this
	// function can return. It is what the Requests page reports as latency.
	const startedAt = Date.now();
	const elapsed = () => Date.now() - startedAt;
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
			latency_ms: elapsed(),
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
	// Attribute every model call in this run to it, now that the id exists.
	tagAiMeter(extractionRunId);

	// D — packet (three separated parts).
	const packet = buildPacket(chunk, recent);
	const text = chunkText(chunk);
	const updateMode = UPDATE_MODE_RE.test(text);

	// E — shortlist (~10 existing nodes, keyword + semantic).
	const shortlist = await shortlistNodes(env, config, userId, text);

	// The user's memory rules, resolved ONCE: the prompt gets them as guidance
	// and the gates get the same object for enforcement. A caller may hand in a
	// pre-merged set (the Playground layers thread settings over the account's).
	const rules = overrides.rules ?? await getMemoryRules(env, userId);
	const withRules = { ...overrides, rules };

	// F — LLM proposes (deterministic in tests via overrides.llmResponse).
	const { proposal, rescued, rescueStats } = await proposeWithSplitRescue(
		env,
		config,
		userId,
		chunk,
		recent,
		packet,
		shortlist,
		withRules,
	);
	if (rescueStats) {
		// The rescue happened (or was refused) — the receipt must say so even
		// when the fire ends llm_failed, or this spend is invisible again.
		meta.split_rescue = true;
		meta.split_rescue_calls = rescueStats.calls;
		meta.split_rescue_dropped = rescueStats.failures;
		meta.split_rescue_aborted = rescueStats.aborted;
		meta.split_rescue_recovered = rescued;
	}
	if (!proposal._ok) {
		console.warn(`extraction llm_failed user=${userId} notes=${proposal.notes}`);
		await updateExtractionRun(env, userId, extractionRunId, {
			status: "failed",
			error: "the extractor returned nothing readable",
		});
		return {
			outcome: "llm_failed",
			receipt: emptyReceipt("llm_failed", "the extractor returned nothing I could read", { ...meta, latency_ms: elapsed() }),
		};
	}

	// G — gates (the backend judge). manual=true → lenient Path A gate.
	// The newest message timestamp anchors undated events: "yesterday I ran the
	// race" said on May 8 lands on/near May 8, not on extraction day.
	const lastTs = chunk.reduce((max, m) => {
		const ts = Number(m?.ts);
		return Number.isFinite(ts) && ts > max ? ts : max;
	}, 0) || null;
	const plan = await applyGates(env, config, userId, proposal, shortlist, overrides.settings, {
		manual: Boolean(overrides.manual),
		updateMode,
		sourceText: text,
		lastTs,
		rules,
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
			receipt: buildReceipt("meaningful_no_write", plan, { ...meta, latency_ms: elapsed() }),
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
			receipt: emptyReceipt("db_write_failed", "a storage error interrupted the save", { ...meta, latency_ms: elapsed() }),
		};
	}

	const receipt = buildReceipt("wrote", plan, { ...meta, latency_ms: elapsed() });
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
