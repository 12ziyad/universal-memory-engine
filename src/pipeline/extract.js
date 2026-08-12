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
import { planExtractionChunks, verifyChunkCoverage } from "./chunking.js";
import { chunkAnchor } from "./temporal.js";
import {
	memoryV3AtomicCaptureEnabled,
	memoryV3AtomicProjectionEnabled,
	memoryV3AtomicCoalescingEnabled,
	memoryV3Enabled,
	memoryV3ExtractionB1Enabled,
} from "../lib/memory_v3.js";
import { shortlistNodes } from "./shortlist.js";
import { proposeMemory } from "./llm.js";
import { attachProvenance, numberEntities, proposeEdges, proposeReflexion } from "./engine_v2.js";
import { applyGates } from "./gates.js";
import { writeApproved } from "./write.js";
import { runPass2 } from "./pass2.js";
import { buildReceipt, emptyReceipt } from "./receipt.js";
import {
	claimExtractionRun,
	createExtractionRun,
	createMemoryJob,
	updateExtractionRun,
	updateMemoryJob,
} from "../lib/db.js";
import { messagesContainMemoryOptOut } from "./opt_out.js";
import { resolveAdmissionRules } from "./admission.js";
import { detectUpdateMode } from "./corrections.js";
import { rulesAllowText } from "./rules.js";
import { normalizeLabel } from "../lib/text.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import { flushAiMeter, tagAiMeter, withAiMeter } from "../lib/ai_meter.js";
import {
	atomicCaptureSummaryForExtractionRun,
	captureAtomicCandidates,
} from "./atomic_candidates.mjs";
import {
	atomicProjectionSummaryForExtractionRun,
	buildAtomicProjection,
	deriveAtomicProjectionDecisions,
	loadAtomicProjectionCandidates,
} from "./atomic_projection.mjs";

const UPDATE_MODE_RE = /\b(actually|correction|no longer|from now on|replace|instead|forget that|not anymore|it is now|it's now)\b/i;
const EXTRACTION_CLAIM_TTL_MS = 15 * 60 * 1000;

function attachAtomicCaptureMeta(meta, result, enabled = false) {
	meta.atomic_capture_enabled = enabled === true;
	if (!result) return;
	meta.atomic_capture_outcome = result.outcome ?? "internal_error";
	meta.atomic_capture_complete = result.complete === true;
	meta.atomic_capture_chunks = Number(result.chunks ?? 0);
	meta.atomic_capture_proposed = Number(result.proposed ?? 0);
	meta.atomic_capture_accepted = Number(result.accepted ?? 0);
	meta.atomic_capture_stored = Number(result.stored ?? 0);
	meta.atomic_capture_rejected = Number(result.rejected ?? 0);
	meta.atomic_capture_duplicates = Number(result.duplicates ?? 0);
	meta.atomic_capture_truncated = Number(result.truncated ?? 0);
	meta.atomic_capture_temporal_present = Number(result.temporalPresent ?? 0);
	meta.atomic_capture_temporal_resolved = Number(result.temporalResolved ?? 0);
	meta.atomic_capture_temporal_unresolved = Number(result.temporalUnresolved ?? 0);
	meta.atomic_capture_temporal_anchor_missing = Number(result.temporalAnchorMissing ?? 0);
	meta.atomic_capture_replayed = result.replayed === true;
	meta.atomic_capture_latency_ms = Number.isFinite(Number(result.latencyMs))
		? Number(result.latencyMs)
		: null;
}

function attachAtomicProjectionMeta(meta, result, enabled = false) {
	meta.atomic_projection_enabled = enabled === true;
	if (!result) return;
	meta.atomic_projection_outcome = result.outcome ?? "internal_error";
	meta.atomic_projection_candidates = Number(result.candidates ?? 0);
	meta.atomic_projection_promoted = Number(result.promoted ?? 0);
	meta.atomic_projection_reinforced = Number(result.reinforced ?? 0);
	meta.atomic_projection_ignored = Number(result.ignored ?? 0);
	meta.atomic_projection_coalesced = Number(result.coalesced ?? 0);
	meta.atomic_projection_latency_ms = Number.isFinite(Number(result.latencyMs))
		? Number(result.latencyMs)
		: null;
}

function atomicProjectionFieldsForRecovery(result) {
	const fields = {};
	attachAtomicProjectionMeta(fields, result, true);
	return fields;
}

function jsonList(value) {
	try {
		const parsed = JSON.parse(value ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function planFromExtractionRun(row) {
	const updated = jsonList(row.updated_objects_json);
	const reinforced = jsonList(row.reinforced_objects_json);
	return {
		newPages: jsonList(row.created_pages_json),
		newNodes: jsonList(row.created_nodes_json),
		newSlices: jsonList(row.created_slices_json),
		newEvents: jsonList(row.created_events_json),
		newEdges: jsonList(row.created_edges_json),
		newCandidates: jsonList(row.created_candidates_json),
		nodeTouches: new Set(updated.filter((item) => item?.kind === "node" && item.id).map((item) => item.id)),
		sliceTouches: reinforced.filter((item) => item?.kind === "slice" && item.id),
		eventTouches: reinforced.filter((item) => item?.kind === "event" && item.id),
		edgeTouches: reinforced.filter((item) => item?.kind === "edge" && item.id),
		rejected: jsonList(row.skipped_objects_json),
	};
}

async function receiptFromExtractionRun(env, userId, row) {
	if (!row?.receipt_id) return null;
	const stored = await env.DB.prepare(
		"SELECT detail FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(row.receipt_id, userId).first();
	if (!stored?.detail) return null;
	try {
		const receipt = JSON.parse(stored.detail);
		return receipt && typeof receipt === "object"
			? { ...receipt, id: row.receipt_id }
			: null;
	} catch {
		return null;
	}
}

/**
 * When was this work ACCEPTED? The source packet's creation time for every
 * packet-carrying lane (ingest/save/MCP); the DO queue entry's acceptance time
 * as fallback. Null means the lane has no acceptance record (interactive
 * playground/manual paths) — those are live user actions, not deferred work,
 * and are not barrier-fenced (SRV-08 design §7).
 */
async function workAcceptedAt(env, userId, sourcePacketId, meta) {
	if (sourcePacketId) {
		const row = await env.DB.prepare(
			"SELECT created_at FROM source_packets WHERE id = ? AND (user_id = ? OR memory_user_id = ?)",
		).bind(sourcePacketId, userId, userId).first();
		const created = Number(row?.created_at);
		if (Number.isFinite(created) && created > 0) return created;
	}
	const fallback = Number(meta?.accepted_at);
	return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

async function extractionRunResult(env, userId, row, chunk, meta, {
	markInterrupted = false,
	error = null,
} = {}) {
	let current = row;
	if (["running", "committing"].includes(current?.status)) {
		const stale = Date.now() - Number(current.updated_at ?? current.created_at ?? 0) > EXTRACTION_CLAIM_TTL_MS;
		if (!markInterrupted && !stale) {
			return {
				outcome: "in_progress",
				extraction_run_id: current.id,
				retry_after_ms: Math.max(1000, EXTRACTION_CLAIM_TTL_MS - (Date.now() - Number(current.updated_at ?? 0))),
			};
		}
		const reason = `inference_outcome_unknown: ${String(error?.message ?? error ?? "the extraction worker stopped before publishing a durable result").slice(0, 300)}`;
		await env.DB.prepare(
			`UPDATE extraction_runs
			 SET status = 'failed', error = ?, updated_at = ?
			 WHERE id = ? AND user_id = ? AND status = ? AND updated_at IS ?`,
		).bind(reason, Date.now(), current.id, userId, current.status, current.updated_at).run();
		current = await env.DB.prepare(
			"SELECT * FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(current.id, userId).first();
	}

	const atomicEnabled = memoryV3AtomicCaptureEnabled(env, userId);
	let atomicSummary = null;
	let atomicProjectionSummary = null;
	if (atomicEnabled && current?.id) {
		try {
			atomicSummary = await atomicCaptureSummaryForExtractionRun(env, userId, current.id);
		} catch (error) {
			console.warn("atomic capture recovery summary failed:", error?.message ?? error);
		}
	}
	if (current?.id) {
		try {
			atomicProjectionSummary = await atomicProjectionSummaryForExtractionRun(
				env,
				userId,
				current.id,
			);
		} catch (error) {
			console.warn("atomic projection recovery summary failed:", error?.message ?? error);
		}
	}
	const recoveredMeta = {
		...meta,
		source: current.tool_name ?? meta.source ?? "ingest",
		source_mode: current.source_mode ?? meta.source_mode ?? null,
		extraction_run_id: current.id,
		source_packet_id: current.source_packet_id ?? meta.source_packet_id ?? null,
		idempotency_key: current.idempotency_key ?? meta.idempotency_key ?? null,
		scope_json: current.scope_json ?? meta.scope_json ?? null,
		received: (chunk ?? []).filter((message) => (message?.role ?? "user") === "user").length,
	};
	attachAtomicCaptureMeta(recoveredMeta, atomicSummary, atomicEnabled);
	if (atomicProjectionSummary) {
		attachAtomicProjectionMeta(recoveredMeta, atomicProjectionSummary, true);
	}
	const plan = planFromExtractionRun(current);
	if (current.status === "wrote") {
		let receipt = await receiptFromExtractionRun(env, userId, current)
			?? buildReceipt("wrote", plan, recoveredMeta);
		if (atomicProjectionSummary
			&& Number(receipt.atomic_projection_candidates ?? 0) !== atomicProjectionSummary.candidates) {
			receipt = {
				...receipt,
				...atomicProjectionFieldsForRecovery(atomicProjectionSummary),
			};
		}
		if (current.receipt_id) receipt.id = current.receipt_id;
		receipt.created_at = Number(current.created_at ?? Date.now());
		receipt.recovered_from_extraction_run = true;
		return { outcome: "wrote", plan, receipt, recovered: true };
	}
	if (current.status === "skipped") {
		let receipt = await receiptFromExtractionRun(env, userId, current)
			?? buildReceipt("meaningful_no_write", plan, recoveredMeta);
		if (atomicProjectionSummary
			&& Number(receipt.atomic_projection_candidates ?? 0) !== atomicProjectionSummary.candidates) {
			receipt = {
				...receipt,
				...atomicProjectionFieldsForRecovery(atomicProjectionSummary),
			};
		}
		if (current.receipt_id) receipt.id = current.receipt_id;
		receipt.created_at = Number(current.created_at ?? Date.now());
		receipt.recovered_from_extraction_run = true;
		return { outcome: "meaningful_no_write", plan, receipt, recovered: true };
	}
	if (current.status === "failed") {
		const storedError = String(current.error ?? "extraction failed");
		const interrupted = storedError.startsWith("inference_outcome_unknown:");
		const outcome = interrupted
			? "interrupted_unknown"
			: storedError.startsWith("db_write_failed:") ? "db_write_failed" : "llm_failed";
		const receipt = emptyReceipt(
			outcome,
			interrupted
				? "processing was interrupted after inference began; the model was not called again"
				: outcome === "db_write_failed" ? "a storage error interrupted the save" : "the extractor returned nothing readable",
			recoveredMeta,
		);
		receipt.created_at = Number(current.created_at ?? Date.now());
		receipt.recovered_from_extraction_run = true;
		return { outcome, error: storedError, receipt, recovered: true };
	}
	// SRV-08: a confirmed erasure cancelled this run (or, for legacy rows, an
	// old delete marked it 'deleted' while in flight). Terminal, honest, and
	// never retried — the barrier would cancel the retry anyway.
	if (current.status === "cancelled_by_delete" || current.status === "deleted") {
		const receipt = emptyReceipt(
			"cancelled_by_delete",
			"a confirmed delete erased this scope while the save was processing; the save was cancelled",
			recoveredMeta,
		);
		receipt.durable = false;
		receipt.created_at = Number(current.created_at ?? Date.now());
		receipt.recovered_from_extraction_run = true;
		return {
			outcome: "cancelled_by_delete",
			error: String(current.error ?? "cancelled_by_delete"),
			receipt,
			recovered: true,
		};
	}
	throw new Error(`extraction run ${current?.id ?? "unknown"} has an unsupported status`);
}

// Rescue batches run a few messages at a time so an abort decision happens
// BEFORE the next batch spends anything — the old Promise.all over the whole
// chunk had already spent everything by the time it learned it failed.
const SPLIT_RESCUE_BATCH = 4;

/**
 * Per-message re-extraction with a spending contract:
 *   - never starts if the chunk alone would blow `maxCalls` (over_ceiling)
 *   - abandons as soon as `failFast` messages have failed to parse (fail_fast)
 *   - legacy accounts retain the prior partial-rescue behavior
 *   - V3 accounts reject a partial rescue so every failed source span remains
 *     explicit and repairable instead of being reported as semantic success
 * Always returns { split, stats }: stats reports calls actually made, failures,
 * and why it stopped, so the receipt can say what this rescue really cost.
 */
async function proposeSplit(env, config, userId, chunk, recent, overrides, limits = {}) {
	const projectScope = normalizeProjectScope(overrides?.meta);
	const maxCalls = Number.isFinite(limits.maxCalls) ? limits.maxCalls : Infinity;
	const failFast = Number.isFinite(limits.failFast) ? limits.failFast : 3;
	const stats = { calls: 0, failures: 0, aborted: null, outcomes: {}, duplicates: 0, invalidObjects: 0 };

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
			const singleShortlist = await shortlistNodes(env, config, userId, singleText, projectScope);
			stats.calls += 1;
			const single = await proposeMemory(env, config, { packet: singlePacket, shortlist: singleShortlist }, overrides);
			const outcome = single._outcome ?? (single._ok ? "valid_unknown" : "invalid_unknown");
			stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
			stats.duplicates += Number(single._duplicates ?? 0);
			stats.invalidObjects += Number(single._invalid_objects ?? 0);
			if (!single._ok) {
				console.warn(`llm split rescue failed user=${userId} outcome=${outcome}`);
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

	if (stats.failures > 0 && overrides?.extractionV3 === true) {
		// V3 never reports semantic success for only part of an accepted source.
		// The permitted episode remains recoverable and this typed failure can be
		// retried/repaired; committing the successful fragments would hide the gap.
		stats.aborted = objects.length === 0 ? "all_failed" : "incomplete";
		return { split: null, stats };
	}
	if (objects.length === 0 && stats.failures > 0) {
		stats.aborted = "all_failed";
		return { split: null, stats };
	}

	return {
		split: {
			objects,
			notes: `split_rescue${notes.length ? `: ${notes.join("; ")}` : ""}`,
			_ok: true,
			_outcome: objects.length ? "valid_nonempty" : "valid_empty",
		},
		stats,
	};
}

/**
 * Pre-split in code, then extract each sub-chunk.
 *
 * The split decision is a pure function (`planExtractionChunks`) rather than
 * inline arithmetic, so coverage, chronology and replay equivalence are
 * properties that can be stated and tested. It also closed a real hole: the old
 * threshold only split chunks LONGER than 10 messages while the split rescue
 * refused to run on more than 8, so a truncated response inside a 9- or
 * 10-message chunk had no recovery path and the fire wrote nothing.
 */
async function proposePrimary(env, config, userId, chunk, recent, packet, shortlist, overrides) {
	const projectScope = normalizeProjectScope(overrides?.meta);
	const plan = await planExtractionChunks(chunk, {
		...config.extractionChunk,
		// Bind replay identities to the accepted source packet/time when present.
		// Per-message source_time is included by the chunk planner as well.
		sourcePacketId: overrides?.meta?.source_packet_id ?? null,
		sourceTime: overrides?.meta?.source_time ?? null,
	});
	const coverage = verifyChunkCoverage(chunk, plan);
	if (!coverage.ok) {
		// Never silently extract from a partial view of accepted content. This is
		// a code fault, not a model fault, and it fails loudly rather than
		// quietly capturing less than the user was told we accepted.
		console.error(`extraction chunk coverage broken user=${userId}: ${coverage.problems.join("; ")}`);
		return {
			proposal: {
				objects: [],
				notes: `chunk_coverage_broken: ${coverage.problems.join("; ")}`,
				_ok: false,
				_outcome: "coverage_invalid",
			},
			rescued: false,
			rescueStats: null,
			coverage,
		};
	}
	if (plan.length <= 1) {
		const result = await proposeWithSplitRescue(env, config, userId, chunk, recent, packet, shortlist, overrides);
		return { ...result, coverage };
	}

	console.warn(`chunk of ${chunk.length} messages pre-split into ${plan.length} for extraction user=${userId}`);
	const objects = [];
	const notes = [];
	let rescuedAny = false;
	let truncatedAny = false;
	let duplicates = 0;
	let invalidObjects = 0;
	let stats = null;
	for (const sub of plan) {
		const subPacket = buildPacket(sub.messages, recent);
		const subShortlist = sub.index === 0
			? shortlist
			: await shortlistNodes(env, config, userId, chunkText(sub.messages), projectScope);
		const part = await proposeWithSplitRescue(env, config, userId, sub.messages, recent, subPacket, subShortlist, overrides);
		if (part.rescueStats) {
			rescuedAny = rescuedAny || part.rescued;
			stats = stats
				? {
					calls: stats.calls + part.rescueStats.calls,
					failures: stats.failures + part.rescueStats.failures,
					aborted: part.rescueStats.aborted ?? stats.aborted,
					duplicates: Number(stats.duplicates ?? 0) + Number(part.rescueStats.duplicates ?? 0),
					invalidObjects: Number(stats.invalidObjects ?? 0) + Number(part.rescueStats.invalidObjects ?? 0),
					outcomes: Object.entries(part.rescueStats.outcomes ?? {}).reduce((all, [key, count]) => ({
						...all,
						[key]: Number(all[key] ?? 0) + Number(count ?? 0),
					}), { ...(stats.outcomes ?? {}) }),
				}
				: { ...part.rescueStats };
		}
		truncatedAny = truncatedAny || Boolean(part.proposal._truncated);
		duplicates += Number(part.proposal._duplicates ?? 0);
		invalidObjects += Number(part.proposal._invalid_objects ?? 0);
		if (!part.proposal._ok) {
			// One unreadable sub-chunk fails the fire (chunk is retained) — but
			// only after bounded spend, and the receipt says which guard fired.
			return { proposal: part.proposal, rescued: rescuedAny, rescueStats: stats, coverage };
		}
		objects.push(...(part.proposal.objects ?? []));
		if (part.proposal.notes) notes.push(part.proposal.notes);
	}
	return {
		proposal: {
			objects,
			notes: notes.join("; "),
			_ok: true,
			_outcome: truncatedAny ? "truncated_salvaged" : objects.length ? "valid_nonempty" : "valid_empty",
			_duplicates: duplicates,
			_invalid_objects: invalidObjects,
			...(truncatedAny ? { _truncated: true } : {}),
		},
		rescued: rescuedAny,
		rescueStats: stats,
		coverage,
	};
}

async function proposeWithSplitRescue(env, config, userId, chunk, recent, packet, shortlist, overrides) {
	const limits = config.splitRescue ?? {};
	// The MCP lane sends clean per-message conversations — the same shape the
	// auto lane extracts in ONE call. The deliberate manual pre-split exists
	// for digest blobs and messy Path A input; applying it here would charge
	// this door several times the SDK price for identical input.
	if (overrides.manual && overrides.profile !== "mcp" && chunk.length > 1) {
		console.warn(`manual chunk has ${chunk.length} retained message(s); splitting before LLM`);
		// The manual path splits deliberately (it is not rescuing a failed
		// parse), so the ceiling does not apply — but fail-fast still does: a
		// systematically unparseable conversation is abandoned, not walked.
		const { split, stats } = await proposeSplit(env, config, userId, chunk, recent, overrides, {
			failFast: limits.failFast,
		});
		if (split) return { proposal: split, rescued: true, rescueStats: stats };
		return {
			proposal: {
				objects: [],
				notes: `split_rescue_failed${stats.aborted ? ` (${stats.aborted})` : ""}`,
				_ok: false,
				_outcome: stats.failures > 0 && overrides?.extractionV3 === true ? "span_incomplete" : "split_rescue_failed",
				_failed_spans: stats.failures,
			},
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
	return {
		proposal: stats.failures > 0 && overrides?.extractionV3 === true
			? { ...proposal, _outcome: "span_incomplete", _failed_spans: stats.failures }
			: proposal,
		rescued: false,
		rescueStats: stats,
	};
}

function runListsFromPlan(plan) {
	return {
		createdNodes: (plan.newNodes ?? []).map((n) => ({ id: n.id, label: n.label })),
		// Recovery callers such as MCP render the final memory page from this
		// durable plan. Keep the approved human-readable fields as well as ids;
		// otherwise a post-commit replay can overwrite the page with an empty body.
		createdSlices: (plan.newSlices ?? []).map((s) => ({
			id: s.id,
			node_id: s.node_id,
			kind: s.kind,
			text: s.text,
		})),
		createdEvents: (plan.newEvents ?? []).map((e) => ({
			id: e.id,
			node_id: e.node_id,
			action: e.action,
			text: e.text,
		})),
		createdEdges: (plan.newEdges ?? []).map((e) => ({
			id: e.id,
			from_node: e.from_node,
			to_node: e.to_node,
			type: e.type,
			fact: e.fact,
		})),
		// Candidates are created objects too. Leaving them off the ledger meant
		// delete-by-source could not see them: the Part 9 acceptance run found
		// eight fictional candidates (and their evidence text) surviving a
		// "complete" bulk delete.
		createdCandidates: (plan.newCandidates ?? []).map((c) => ({ id: c.id, label: c.label })),
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
export async function runExtraction(env, userId, chunk, recent, overrides = {}, execution = {}) {
	return withAiMeter("save", async (meter) => {
		let result;
		try {
			result = await runExtractionInner(env, userId, chunk, recent, overrides, meter, execution);
		} catch (error) {
			if (!execution.runId) throw error;
			let row = await env.DB.prepare(
				"SELECT * FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1",
			).bind(execution.runId, userId).first();
			if (!row) throw error;
			// A synchronous failure while the run is still in its pre-commit phase
			// is an explicit failed attempt and remains eligible for the bounded
			// retry policy. Once `committing` begins, the outcome is ambiguous unless
			// the atomic graph marker says `wrote`, so that path fails closed instead.
			if (row.status === "running") {
				await env.DB.prepare(
					`UPDATE extraction_runs
					 SET status = 'failed', error = ?, updated_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'running' AND updated_at IS ?`,
				).bind(
					`llm_failed: ${String(error?.message ?? error).slice(0, 300)}`,
					Date.now(),
					row.id,
					userId,
					row.updated_at,
				).run();
				row = await env.DB.prepare(
					"SELECT * FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1",
				).bind(execution.runId, userId).first();
			}
			const sourceMode = overrides.meta?.source_mode
				?? (overrides.manual
					? (overrides.source === "save_conversation" ? "manual_collect" : "manual_direct")
					: "auto_ingest");
			result = await extractionRunResult(env, userId, row, chunk, {
				source: overrides.source ?? "ingest",
				source_mode: sourceMode,
				...(overrides.meta ?? {}),
			}, { markInterrupted: row.status === "committing", error });
		}
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

async function runExtractionInner(env, userId, chunk, recent, overrides = {}, meter = null, execution = {}) {
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
	const projectScope = normalizeProjectScope(meta);
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
	const runOwner = {
		toolName: overrides.source ?? "ingest",
		sourceMode,
		topicFilter: meta.topic_filter ?? null,
		sourcePacketId: meta.source_packet_id ?? null,
		idempotencyKey: meta.idempotency_key ?? null,
		scopeJson: meta.scope_json ?? null,
		status: "running",
	};
	let extractionRunId;
	if (execution.runId) {
		const claim = await claimExtractionRun(env, userId, { id: execution.runId, ...runOwner });
		extractionRunId = claim.id;
		if (!claim.claimed) {
			return extractionRunResult(env, userId, claim.row, chunk, {
				...meta,
				extraction_run_id: extractionRunId,
			});
		}
	} else {
		extractionRunId = await createExtractionRun(env, userId, runOwner);
	}
	meta.extraction_run_id = extractionRunId;
	// Attribute every model call in this run to it, now that the id exists.
	tagAiMeter(extractionRunId);

	// SRV-08 pre-flight: if a confirmed erasure's barrier already covers this
	// work's ACCEPTANCE, cancel now — before spending a model call. Acceptance
	// is the source packet's creation (retries and replays mint fresh runs and
	// fresh queue entries, but never a fresh packet), with the queue entry's
	// acceptance time as fallback for packet-less lanes.
	const acceptedAt = await workAcceptedAt(env, userId, runOwner.sourcePacketId, meta);
	if (acceptedAt != null) {
		const barrier = await env.DB.prepare(
			"SELECT barrier_at FROM deletion_barriers WHERE user_id = ?",
		).bind(userId).first();
		if (barrier && Number(barrier.barrier_at) > acceptedAt) {
			await updateExtractionRun(env, userId, extractionRunId, {
				status: "cancelled_by_delete",
				error: "cancelled_by_delete: a confirmed delete erased this scope after this save was accepted",
				expectStatus: "running",
			});
			const receipt = emptyReceipt(
				"cancelled_by_delete",
				"a confirmed delete erased this scope after this save was accepted; the save was cancelled",
				{ ...meta, latency_ms: elapsed() },
			);
			receipt.durable = false;
			return { outcome: "cancelled_by_delete", error: "cancelled_by_delete", receipt };
		}
	}

	// D — packet (three separated parts).
	const packet = buildPacket(chunk, recent);
	const text = chunkText(chunk);
	// SUPERSEDE-01: the local regex missed "changed X from A to B" and a bare
	// "X is now B", so those corrections never widened the supersede set and
	// could not retire anything. One shared detector now decides this for the
	// whole pipeline (src/pipeline/corrections.js), tested against the
	// correction shapes measured stale.
	const updateMode = detectUpdateMode(text) || UPDATE_MODE_RE.test(text);

	// E — shortlist (~10 existing nodes, keyword + semantic).
	const shortlist = await shortlistNodes(env, config, userId, text, projectScope);

	// The user's memory rules, resolved ONCE: the prompt gets them as guidance
	// and the gates get the same object for enforcement. A caller may hand in a
	// pre-merged set (the Playground layers thread settings over the account's,
	// and an SDK caller's per-request rules arrive the same way).
	const rules = await resolveAdmissionRules(env, userId, overrides.rules);
	// Which rules were actually in force for this save. Without this, a rule
	// that never loaded and a rule that matched nothing look identical on the
	// receipt — which is exactly how unenforced excludes stayed invisible.
	meta.rules_active = {
		source: overrides.rules ? "caller" : "account",
		excludes: rules.excludes?.length ?? 0,
		includes: rules.includes?.length ?? 0,
		instructions: Boolean(rules.customInstructions),
	};
	// One extractor, three lenses: which door this save came through decides
	// the extraction stance and which deterministic gate filters apply.
	const profile = overrides.profile
		?? ({ plugin: "plugin", sdk: "sdk" }[overrides.source] ?? null);
	if (profile) meta.profile = profile;
	const extractionV3 = memoryV3ExtractionB1Enabled(env, userId);
	meta.extraction_v3_b1 = extractionV3;
	const withRules = { ...overrides, rules, profile, extractionV3 };
	const atomicCaptureEnabled = memoryV3AtomicCaptureEnabled(env, userId);
	const atomicProjectionEnabled = memoryV3AtomicProjectionEnabled(env, userId);
	const atomicCoalescingEnabled = memoryV3AtomicCoalescingEnabled(env, userId);
	attachAtomicCaptureMeta(meta, null, atomicCaptureEnabled);
	attachAtomicProjectionMeta(meta, null, atomicProjectionEnabled);
	meta.atomic_projection_coalescing_enabled = atomicCoalescingEnabled;

	// F — call 1: extraction (deterministic in tests via overrides.llmResponse).
	// Oversized chunks are pre-split by code before the model sees them.
	// E4's append-only candidate lane runs independently beside the established
	// proposal. Its deterministic terminal run prevents replayed inference, and
	// a lane failure is visible without turning a proven graph write into a false
	// failure. It has no recall participation in this phase.
	const atomicPromise = atomicCaptureEnabled
		? captureAtomicCandidates(env, {
			userId,
			messages: chunk,
			recent,
			rules,
			projectId: projectScope.projectId,
			projectName: projectScope.projectName,
			sourcePacketId: meta.source_packet_id ?? null,
			extractionRunId,
			acceptedAt,
			sourceTime: meta.source_time ?? null,
			chunkConfig: config.extractionChunk,
			override: overrides.atomicLlmResponse,
		}).catch((error) => {
			console.warn(JSON.stringify({
				event: "atomic_capture_failed",
				outcome: "internal_error",
				error_name: String(error?.name ?? "Error").slice(0, 80),
			}));
			return {
				enabled: true,
				outcome: "internal_error",
				complete: false,
				chunks: 0,
				proposed: 0,
				accepted: 0,
				stored: 0,
				rejected: 0,
				duplicates: 0,
				truncated: 0,
				replayed: false,
				latencyMs: null,
			};
		})
		: Promise.resolve(null);
	const [primaryResult, atomicResult] = await Promise.all([
		proposePrimary(
			env,
			config,
			userId,
			chunk,
			recent,
			packet,
			shortlist,
			withRules,
		),
		atomicPromise,
	]);
	const { proposal, rescued, rescueStats, coverage } = primaryResult;
	attachAtomicCaptureMeta(meta, atomicResult, atomicCaptureEnabled);
	if (coverage) {
		// Privacy-safe capture counters: how the accepted content was divided and
		// whether every message of it reached the model.
		meta.chunks_planned = coverage.chunkCount;
		meta.chunk_coverage_ok = coverage.ok;
		meta.chunk_messages_covered = coverage.coveredCount;
		meta.chunk_code_points_input = coverage.inputCodePoints;
		meta.chunk_code_points_covered = coverage.coveredCodePoints;
	}
	if (proposal._truncated) {
		// The model ran out of output budget. Whatever completed was salvaged;
		// saying so is what turns "this save looked small" into a tunable fact.
		meta.extraction_truncated = true;
	}
	meta.extraction_outcome = proposal._outcome ?? (proposal._ok ? "valid_unknown" : "invalid_unknown");
	meta.extraction_failed_spans = Number(proposal._failed_spans ?? rescueStats?.failures ?? 0);
	meta.extraction_duplicates = Number(proposal._duplicates ?? rescueStats?.duplicates ?? 0);
	meta.extraction_invalid_objects = Number(proposal._invalid_objects ?? rescueStats?.invalidObjects ?? 0);
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
			error: "llm_failed: the extractor returned nothing readable",
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
	// Light path (single atomic facts, e.g. MCP save_memory): a fact with fewer
	// than N distinct resolved entities and no co-mention has nothing to draw
	// edges from — passes 2 and 3 would be spend without yield. Threshold is
	// config.mcp.lightPathMinEntities; the skip is named on the receipt.
	if (overrides.lightPath === true && config.engineV2) {
		const proposedLabels = [...new Set((objects ?? [])
			.filter((o) => o?.kind === "node" && o.label)
			.map((o) => o.label))];
		const needed = Math.max(2, Number(config.mcp?.lightPathMinEntities ?? 2));
		const hasRelationshipCandidate = proposedLabels.length >= 2 && chunk.some((m) => {
			const content = String(m?.content ?? "").toLowerCase();
			return proposedLabels.filter((label) => content.includes(String(label).toLowerCase())).length >= 2;
		});
		if (proposedLabels.length < needed || !hasRelationshipCandidate) {
			meta.engine = "v2_light";
			meta.light_path_skipped_passes = true;
			meta.light_path_entities = proposedLabels.length;
		}
	}
	if (config.engineV2 && meta.light_path_skipped_passes !== true) {
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

		// 6.6 OPTIONAL delta edge pass — a 4th call scoped to entities the
		// reflexion pass surfaced, so their relationships get an attention
		// budget too. Behind ENGINE_DELTA_PASS, DEFAULT OFF: it changes cost
		// and latency, which is Ziyad's dial, not the build's.
		if (config.engineDeltaPass && reflexion.entities.length > 0) {
			const extended = numberEntities(objects, shortlist);
			const delta = await proposeEdges(env, config, packet, extended, withRules);
			preRejected.push(...delta.rejected);
			const known = new Set(objects.filter((o) => o.kind === "edge").map((e) => `${e.from}|${e.type}|${e.to}`));
			const newLabels = new Set(reflexion.entities.map((e) => normalizeLabel(e.label)));
			const fresh = delta.edges.filter((e) =>
				!known.has(`${e.from}|${e.type}|${e.to}`)
				&& (newLabels.has(normalizeLabel(e.from)) || newLabels.has(normalizeLabel(e.to))));
			objects = [...objects, ...fresh];
			meta.delta_pass_edges = fresh.length;
		}
	}

	// G — gates (the backend judge). manual=true → lenient Path A gate.
	// The newest message timestamp anchors undated events: "yesterday I ran the
	// race" said on May 8 lands on/near May 8, not on extraction day.
	// E6 runs only after all legacy model passes. It can change the write
	// proposal, but cannot change extraction prompts, model-call count, or the
	// relation/reflexion result. The loader joins every candidate to its exact
	// permitted source episode in the same tenant/project scope.
	let atomicProjection = null;
	if (atomicProjectionEnabled) {
		const projectionStarted = Date.now();
		if (!atomicResult?.complete) {
			attachAtomicProjectionMeta(meta, {
				outcome: "capture_incomplete",
				latencyMs: Date.now() - projectionStarted,
			}, true);
		} else {
			try {
				const candidates = await loadAtomicProjectionCandidates(env, {
					userId,
					projectId: projectScope.projectId,
					captureRunIds: atomicResult.captureRunIds ?? [],
				});
				const built = buildAtomicProjection(candidates);
				objects = [...objects, ...built.objects];
				atomicProjection = { ...built, candidates, startedAt: projectionStarted };
				attachAtomicProjectionMeta(meta, {
					outcome: candidates.length ? "prepared" : "empty",
					candidates: candidates.length,
					latencyMs: Date.now() - projectionStarted,
				}, true);
			} catch (error) {
				console.warn(JSON.stringify({
					event: "atomic_projection_failed",
					outcome: "load_or_build_failed",
					error_name: String(error?.name ?? "Error").slice(0, 80),
				}));
				attachAtomicProjectionMeta(meta, {
					outcome: "load_or_build_failed",
					latencyMs: Date.now() - projectionStarted,
				}, true);
			}
		}
	}

	const lastTs = chunk.reduce((max, m) => {
		const ts = Number(m?.ts);
		return Number.isFinite(ts) && ts > max ? ts : max;
	}, 0) || null;
	// BF-1 / P1: the authoritative anchor for relative phrases. Only accounts on
	// the V3 timestamp contract can supply one, and without it the gates fall
	// back to `lastTs` exactly as before.
	const temporalAnchor = memoryV3Enabled(env, userId) ? chunkAnchor(chunk) : null;
	if (temporalAnchor) meta.temporal_anchor = temporalAnchor.kind;
	const plan = await applyGates(env, config, userId, { ...proposal, objects }, shortlist, overrides.settings, {
		manual: Boolean(overrides.manual),
		updateMode,
		sourceText: text,
		// 7.4: the chunk's individual messages — the only permissible source
		// for fallback slice/event text and candidate evidence.
		sourceMessages: chunk.map((m) => ({ id: m.id, content: m.content })),
		lastTs,
		temporalAnchor,
		rules,
		profile,
		projectScope,
		atomicProjectionMetadata: atomicProjection?.metadata ?? null,
		atomicSourceCoalescing: atomicCoalescingEnabled,
	});
	// Rejections from the v2 passes (unknown entity ids, malformed relation
	// types) surface on the receipt with everything the gates refused.
	plan.rejected.push(...preRejected);
	if (atomicProjection) {
		plan.atomicProjectionDecisions = deriveAtomicProjectionDecisions(plan, atomicProjection.candidates);
		const promoted = plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "promoted").length;
		const reinforced = plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "reinforced").length;
		const ignored = plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "ignored").length;
		attachAtomicProjectionMeta(meta, {
			outcome: "prepared",
			candidates: plan.atomicProjectionDecisions.length,
			promoted,
			reinforced,
			ignored,
			coalesced: plan.atomicCoalesced.length,
			latencyMs: Date.now() - atomicProjection.startedAt,
		}, true);
		// An ignored decision is still durable semantic-admission state. Commit it
		// atomically instead of leaving an accepted candidate in limbo.
		if (plan.atomicProjectionDecisions.length) plan.hasWrites = true;
	}

	// Provenance: a capped, scrubbed excerpt of the message that produced each
	// object — enough to answer "why do you think that?".
	attachProvenance(plan, chunk, (text) => rulesAllowText(rules, text));

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
			plan,
			receipt: buildReceipt("meaningful_no_write", plan, { ...meta, latency_ms: elapsed() }),
		};
	}

	// H — write (atomic). Publish the recovery lists before committing, then
	// move the run to `wrote` in the same D1 batch as the graph. A retry can
	// therefore settle from this run without invoking the model again.
	//
	// SRV-08: the transition is GUARDED — only a run still 'running' may enter
	// 'committing'. A concurrent erasure that cancelled this run mid-model-call
	// wins here, and the whole save resolves as cancelled instead of publishing
	// rows the user just deleted.
	let result;
	const entered = await updateExtractionRun(env, userId, extractionRunId, {
		status: "committing",
		...runListsFromPlan(plan),
		expectStatus: "running",
	});
	if (Number(entered?.changes ?? 0) !== 1) {
		const row = await env.DB.prepare(
			"SELECT * FROM extraction_runs WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(extractionRunId, userId).first();
		return extractionRunResult(env, userId, row, chunk, meta);
	}
	try {
		result = await writeApproved(env, config, userId, plan, { extractionRunId, acceptedAt });
	} catch (err) {
		const message = String(err?.message ?? err);
		// The commit fence rolled the batch back: a confirmed erasure superseded
		// this save between acceptance and commit. Terminal and honest — never a
		// retryable storage error (the barrier would cancel the retry anyway).
		// The constraint is NAMED fence_guard_violation (migration 0031) so the
		// error text carries "fence_guard"; the expression form is kept for the
		// rollout window where the unnamed 0030 table may still be live.
		if (/fence_guard|violation IS NULL/i.test(message)) {
			console.warn(`extraction cancelled_by_delete at commit user=${userId}`);
			await updateExtractionRun(env, userId, extractionRunId, {
				status: "cancelled_by_delete",
				error: "cancelled_by_delete: a confirmed delete erased this scope while the save was committing",
				expectStatus: "committing",
			});
			const receipt = emptyReceipt(
				"cancelled_by_delete",
				"a confirmed delete erased this scope while the save was processing; the save was cancelled",
				{ ...meta, latency_ms: elapsed() },
			);
			receipt.durable = false;
			return { outcome: "cancelled_by_delete", error: "cancelled_by_delete", receipt };
		}
		console.error(`extraction db_write_failed user=${userId}:`, message);
		await updateExtractionRun(env, userId, extractionRunId, {
			status: "failed",
			error: `db_write_failed: ${message}`,
		});
		return {
			outcome: "db_write_failed",
			error: message,
			receipt: emptyReceipt("db_write_failed", "a storage error interrupted the save", { ...meta, latency_ms: elapsed() }),
		};
	}
	if (atomicProjection) {
		attachAtomicProjectionMeta(meta, {
			outcome: "completed",
			candidates: plan.atomicProjectionDecisions.length,
			promoted: plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "promoted").length,
			reinforced: plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "reinforced").length,
			ignored: plan.atomicProjectionDecisions.filter((decision) => decision.outcome === "ignored").length,
			coalesced: plan.atomicCoalesced.length,
			latencyMs: Date.now() - atomicProjection.startedAt,
		}, true);
	}

	const receipt = buildReceipt("wrote", plan, { ...meta, latency_ms: elapsed() });

	// I — Pass 2 (background, cheap). Never affects Pass-1 writes.
	let jobId = null;
	try {
		jobId = await createMemoryJob(env, userId, {
			type: "pass2_rollup",
			status: "running",
			idempotencyKey: `pass2:${extractionRunId}`,
			sourcePacketId: meta.source_packet_id ?? null,
			extractionRunId,
			payload: {
				affectedNodeIds: result.affectedNodeIds,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
			},
		});
		if (jobId) await updateExtractionRun(env, userId, extractionRunId, { jobId });
		const pass2 = await runPass2(env, config, userId, result.affectedNodeIds, { jobId });
		await updateMemoryJob(env, userId, jobId, {
			status: pass2?.ran ? "completed" : "skipped",
			payload: {
				affectedNodeIds: result.affectedNodeIds,
				project_id: projectScope.projectId,
				project_name: projectScope.projectName,
				pass2,
			},
			completedAt: Date.now(),
		});
	} catch (err) {
		console.warn(`pass2 failed user=${userId}:`, err?.message ?? err);
		if (jobId) {
			await updateMemoryJob(env, userId, jobId, {
				status: "failed",
				error: String(err?.message ?? err),
				completedAt: Date.now(),
			});
		}
	}

	// `plan` rides along for callers that render what was approved (the MCP
	// enrichment writes the final memory-page body from it). Additive only.
	return { outcome: "wrote", ...result, plan, receipt };
}
