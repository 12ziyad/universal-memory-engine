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
import { attachProvenance, numberEntities, proposeEdges, proposeReflexion } from "./engine_v2.js";
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

// A chunk this big cannot be extracted in one call: the model's output runs
// past the token budget and truncates mid-JSON — the exact failure the conv-0
// smoke measured on end-of-session flushes. Pre-splitting into sub-chunks
// BEFORE the primary call is the fix; the rescue stays as the parse-failure
// fallback within each sub-chunk.
const PRIMARY_SUBCHUNK = 8;
const PRIMARY_SUBCHUNK_THRESHOLD = 10;

async function proposePrimary(env, config, userId, chunk, recent, packet, shortlist, overrides) {
	if (chunk.length <= PRIMARY_SUBCHUNK_THRESHOLD) {
		return proposeWithSplitRescue(env, config, userId, chunk, recent, packet, shortlist, overrides);
	}
	console.warn(`chunk of ${chunk.length} messages pre-split for extraction user=${userId}`);
	const objects = [];
	const notes = [];
	let rescuedAny = false;
	let stats = null;
	for (let i = 0; i < chunk.length; i += PRIMARY_SUBCHUNK) {
		const sub = chunk.slice(i, i + PRIMARY_SUBCHUNK);
		const subPacket = buildPacket(sub, recent);
		const subShortlist = i === 0 ? shortlist : await shortlistNodes(env, config, userId, chunkText(sub));
		const part = await proposeWithSplitRescue(env, config, userId, sub, recent, subPacket, subShortlist, overrides);
		if (part.rescueStats) {
			rescuedAny = rescuedAny || part.rescued;
			stats = stats
				? { calls: stats.calls + part.rescueStats.calls, failures: stats.failures + part.rescueStats.failures, aborted: part.rescueStats.aborted ?? stats.aborted }
				: { ...part.rescueStats };
		}
		if (!part.proposal._ok) {
			// One unreadable sub-chunk fails the fire (chunk is retained) — but
			// only after bounded spend, and the receipt says which guard fired.
			return { proposal: part.proposal, rescued: rescuedAny, rescueStats: stats };
		}
		objects.push(...(part.proposal.objects ?? []));
		if (part.proposal.notes) notes.push(part.proposal.notes);
	}
	return {
		proposal: { objects, notes: notes.join("; "), _ok: true },
		rescued: rescuedAny,
		rescueStats: stats,
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
	// pre-merged set (the Playground layers thread settings over the account's,
	// and an SDK caller's per-request rules arrive the same way).
	const rules = overrides.rules ?? await getMemoryRules(env, userId);
	// One extractor, three lenses: which door this save came through decides
	// the extraction stance and which deterministic gate filters apply.
	const profile = overrides.profile
		?? ({ plugin: "plugin", sdk: "sdk" }[overrides.source] ?? null);
	if (profile) meta.profile = profile;
	const withRules = { ...overrides, rules, profile };

	// F — call 1: extraction (deterministic in tests via overrides.llmResponse).
	// Oversized chunks are pre-split by code before the model sees them.
	const { proposal, rescued, rescueStats } = await proposePrimary(
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

	// F2 — calls 2 and 3 (engine v2): a dedicated relation pass against a
	// CODE-numbered entity list, then a reflexion pass that may only add what
	// was missed. Both are gated hard — an edge citing an id not on the list
	// is rejected, never repaired.
	let objects = proposal.objects ?? [];
	const preRejected = [];
	if (config.engineV2) {
		const entities = numberEntities(objects, shortlist);
		meta.engine = "v2";

		// Calls 2 and 3 run CONCURRENTLY — they both depend only on call 1, and
		// serializing them doubled fire latency measured against the live model.
		// The reflexion pass therefore doesn't see call 2's relations; if both
		// find the same edge the gates dedupe it (duplicate_edge / reinforce).
		const foundSummary = [
			...entities.map((e) => `entity ${e.n}: ${e.label}`),
			...objects.filter((o) => o.kind === "slice" || o.kind === "event").map((o) => `fact: ${o.text}`),
		].join("\n");
		const [edgePass, reflexion] = await Promise.all([
			proposeEdges(env, config, packet, entities, withRules),
			proposeReflexion(env, config, packet, entities, foundSummary, withRules),
		]);
		preRejected.push(...edgePass.rejected);
		if (edgePass.raw_ok === false) {
			// The edge model returned something unreadable. The save still lands
			// with call 1's facts; the refusal is named on the receipt.
			preRejected.push({ kind: "edge", label: "edge pass", reason: "edge_pass_unparseable" });
		}
		preRejected.push(...reflexion.rejected);
		if (reflexion.raw_ok === false) {
			preRejected.push({ kind: "node", label: "reflexion pass", reason: "reflexion_pass_unparseable" });
		}

		objects = [
			...objects,
			...reflexion.entities.map((e) => ({ kind: "node", label: e.label, category: e.category, matches_existing: e.existingId, confidence: 0.85 })),
			...reflexion.facts.map((f) => ({ kind: "slice", on: f.on, text: f.text, kind_detail: f.kind, confidence: 0.85 })),
			...edgePass.edges,
			...reflexion.edges,
		];
		meta.edge_pass_edges = edgePass.edges.length;
		meta.reflexion_added = reflexion.entities.length + reflexion.facts.length + reflexion.edges.length;
	}

	// G — gates (the backend judge). manual=true → lenient Path A gate.
	// The newest message timestamp anchors undated events: "yesterday I ran the
	// race" said on May 8 lands on/near May 8, not on extraction day.
	const lastTs = chunk.reduce((max, m) => {
		const ts = Number(m?.ts);
		return Number.isFinite(ts) && ts > max ? ts : max;
	}, 0) || null;
	const plan = await applyGates(env, config, userId, { ...proposal, objects }, shortlist, overrides.settings, {
		manual: Boolean(overrides.manual),
		updateMode,
		sourceText: text,
		lastTs,
		rules,
		profile,
	});
	// Rejections from the v2 passes (unknown entity ids, malformed relation
	// types) surface on the receipt with everything the gates refused.
	plan.rejected.push(...preRejected);

	// Provenance: a capped, scrubbed excerpt of the message that produced each
	// object — enough to answer "why do you think that?".
	attachProvenance(plan, chunk);

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
