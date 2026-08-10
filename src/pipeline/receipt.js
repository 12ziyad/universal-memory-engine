import { normalizeSourceEventTrace } from "../lib/source_event.mjs";

export { normalizeSourceEventTrace };

/**
 * Receipts (Priority 5) — turn a gate plan + write result into BOTH:
 *   - a structured record we persist (so the UI "Saves" page can show exactly
 *     what each tool call saved/skipped), and
 *   - a clear one-line human string the save tools return instead of the old
 *     vague "couldn't extract anything storable".
 *
 *   Saved: 2 nodes (Boxing, UML), 3 slices, 1 event. Skipped: 4 (weak maybe, question).
 *   Saved: 0. Reason: no durable memory found (only a question).
 */

// Gate reject reasons → short human phrases for the receipt's parenthetical.
const REASON_PHRASE = {
	junk_label: "pronoun/filler",
	node_is_status: "status phrase",
	low_confidence_downgraded: "weak maybe",
	low_confidence: "weak maybe",
	event_no_node: "event without a subject",
	slice_no_node: "detail without a subject",
	empty_slice: "empty detail",
	duplicate_event: "already recorded",
	duplicate_edge: "duplicate link",
	edge_endpoint_missing: "incomplete link",
	edge_self_loop: "self-link",
	invalid_edge_type: "unsupported link type",
	bad_title: "bad title",
	suppressed_blocked: "suppressed",
	manual_candidate_disabled: "manual candidate disabled",
	manual_collect_kept_inside_page: "kept inside page",
	node_without_detail: "node without durable detail",
	durable_signal_no_node: "durable signal without a subject",
	excluded_by_rule: "blocked by your rules",
	outside_include_rules: "outside your include rules",
	ungrounded_fact: "not grounded in what was sent",
	batch_text_blob: "stitched from multiple messages",
	edge_type_pair_mismatch: "impossible relation for these kinds of things",
	edge_no_evidence: "no quoted evidence",
	edge_evidence_not_verbatim: "evidence quote not found in the messages",
	edge_evidence_missing_endpoint: "evidence quote does not name both sides",
	edge_unknown_entity_id: "cited an unknown entity",
	fact_unknown_entity_id: "cited an unknown entity",
	unknown_kind: "unrecognized",
};

const CONTEXT_TRACE_SCHEMA = "itsuki.extract-context-trace/v1";
const CONTEXT_TRACE_MODES = new Set(["accepted_snapshot", "legacy_empty", "invalid_empty"]);
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MAX_CONTEXT_TRACE_MESSAGES = 10;
const MAX_CONTEXT_TRACE_ROLE_MESSAGES = 5;
const MAX_CONTEXT_TRACE_SERIALIZED_BYTES = 16 * 1024;
const MAX_CONTEXT_TRACE_OMITTED = 1_000_000;
const MAX_CONTEXT_TRACE_TIMESTAMP = 8_640_000_000_000_000;

function boundedTraceInteger(value, max) {
	if (!Number.isSafeInteger(value) || value < 0 || value > max) return null;
	return value;
}

function traceHash(value) {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) return null;
	return value.toLowerCase();
}

function traceTimestamp(value) {
	let timestamp = value;
	if (typeof timestamp === "string") {
		// Accept only a canonical UTC timestamp, never an arbitrary label that
		// could smuggle source or message text into an otherwise content-free trace.
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) return null;
		timestamp = Date.parse(timestamp);
	}
	return boundedTraceInteger(timestamp, MAX_CONTEXT_TRACE_TIMESTAMP);
}

/**
 * Rebuild extraction-context tracing from a strict, content-free allowlist.
 *
 * The trace is persisted and can outlive the messages that produced it, so it
 * must never retain snippets, message ids, scope labels, or caller-provided
 * metadata. Invalid audit data is omitted as a unit instead of being partly
 * preserved with misleading counts. Empty compatibility modes may lack a
 * context hash because legacy/corrupt queue entries do not always have one;
 * accepted snapshots must identify both their logical context and contents.
 */
export function normalizeContextTrace(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.schema !== CONTEXT_TRACE_SCHEMA || !CONTEXT_TRACE_MODES.has(value.mode)) return null;

	const contextHash = value.context_hash == null ? null : traceHash(value.context_hash);
	const snapshotHash = value.snapshot_hash == null ? null : traceHash(value.snapshot_hash);
	if (value.context_hash != null && !contextHash) return null;
	if (value.snapshot_hash != null && !snapshotHash) return null;
	if (value.mode === "accepted_snapshot" && (!contextHash || !snapshotHash)) return null;

	const messages = boundedTraceInteger(value.messages, MAX_CONTEXT_TRACE_MESSAGES);
	const userMessages = boundedTraceInteger(value.user_messages, MAX_CONTEXT_TRACE_ROLE_MESSAGES);
	const assistantMessages = boundedTraceInteger(value.assistant_messages, MAX_CONTEXT_TRACE_ROLE_MESSAGES);
	const serializedBytes = boundedTraceInteger(value.serialized_bytes, MAX_CONTEXT_TRACE_SERIALIZED_BYTES);
	const omittedMessages = boundedTraceInteger(value.omitted_messages, MAX_CONTEXT_TRACE_OMITTED);
	const truncatedMessages = boundedTraceInteger(value.truncated_messages, MAX_CONTEXT_TRACE_MESSAGES);
	const capturedAt = traceTimestamp(value.captured_at);
	if (
		messages == null ||
		userMessages == null ||
		assistantMessages == null ||
		serializedBytes == null ||
		omittedMessages == null ||
		truncatedMessages == null ||
		capturedAt == null ||
		messages !== userMessages + assistantMessages
	) return null;

	return {
		schema: CONTEXT_TRACE_SCHEMA,
		mode: value.mode,
		...(contextHash ? { context_hash: contextHash } : {}),
		...(snapshotHash ? { snapshot_hash: snapshotHash } : {}),
		messages,
		user_messages: userMessages,
		assistant_messages: assistantMessages,
		serialized_bytes: serializedBytes,
		omitted_messages: omittedMessages,
		truncated_messages: truncatedMessages,
		captured_at: capturedAt,
	};
}

function contextTraceFields(meta = {}) {
	const trace = normalizeContextTrace(meta.context_trace) ?? normalizeContextTrace(meta.contextTrace);
	return trace ? { context_trace: trace } : {};
}

function sourceEventTraceFields(meta = {}) {
	const trace = normalizeSourceEventTrace(meta.source_event_trace)
		?? normalizeSourceEventTrace(meta.sourceEventTrace);
	return trace ? { source_event_trace: trace } : {};
}

function phraseFor(reason) {
	return REASON_PHRASE[reason] ?? reason ?? "skipped";
}

/**
 * Split-rescue accounting, present on every receipt whose fire attempted (or
 * refused) a per-message rescue. This is the fix for the invisible failure
 * mode where a fire burned dozens of model calls and the receipt said nothing:
 * calls = model calls the rescue actually made, dropped = messages whose
 * content failed to parse and was left behind, aborted = why it stopped early
 * (over_ceiling | fail_fast | all_failed), recovered = whether the rescue
 * produced a usable proposal at all.
 */
function splitRescueFields(meta = {}) {
	if (!meta.split_rescue) return {};
	return {
		split_rescue: true,
		split_rescue_calls: meta.split_rescue_calls ?? 0,
		split_rescue_dropped: meta.split_rescue_dropped ?? 0,
		split_rescue_aborted: meta.split_rescue_aborted ?? null,
		split_rescue_recovered: meta.split_rescue_recovered ?? false,
	};
}

function extractionConservationFields(meta = {}) {
	if (meta.extraction_outcome == null && meta.chunks_planned == null) return {};
	const integer = (value) => Number.isFinite(Number(value))
		? Math.max(0, Math.trunc(Number(value)))
		: 0;
	return {
		extraction_outcome: String(meta.extraction_outcome ?? "not_attempted").slice(0, 64),
		extraction_failed_spans: integer(meta.extraction_failed_spans),
		extraction_invalid_objects: integer(meta.extraction_invalid_objects),
		extraction_duplicates: integer(meta.extraction_duplicates),
		chunks_planned: integer(meta.chunks_planned),
		chunk_coverage_ok: meta.chunk_coverage_ok === true,
		chunk_messages_covered: integer(meta.chunk_messages_covered),
		chunk_code_points_input: integer(meta.chunk_code_points_input),
		chunk_code_points_covered: integer(meta.chunk_code_points_covered),
	};
}

/** Content-free accounting for E4's source-grounded candidate lane. */
function atomicCaptureFields(meta = {}) {
	if (meta.atomic_capture_enabled == null) return {};
	const integer = (value) => Number.isFinite(Number(value))
		? Math.max(0, Math.trunc(Number(value)))
		: 0;
	return {
		atomic_capture_enabled: meta.atomic_capture_enabled === true,
		atomic_capture_outcome: String(meta.atomic_capture_outcome ?? "not_attempted").slice(0, 64),
		atomic_capture_complete: meta.atomic_capture_complete === true,
		atomic_capture_chunks: integer(meta.atomic_capture_chunks),
		atomic_capture_proposed: integer(meta.atomic_capture_proposed),
		atomic_capture_accepted: integer(meta.atomic_capture_accepted),
		atomic_capture_stored: integer(meta.atomic_capture_stored),
		atomic_capture_rejected: integer(meta.atomic_capture_rejected),
		atomic_capture_duplicates: integer(meta.atomic_capture_duplicates),
		atomic_capture_truncated: integer(meta.atomic_capture_truncated),
		atomic_capture_replayed: meta.atomic_capture_replayed === true,
		atomic_capture_latency_ms: Number.isFinite(Number(meta.atomic_capture_latency_ms))
			? Math.max(0, Math.round(Number(meta.atomic_capture_latency_ms)))
			: null,
	};
}

function plural(n, one, many = `${one}s`) {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build the structured receipt from a plan (+ optional write result + meta).
 * `outcome` is the extraction outcome; `meta` may carry { source, received,
 * digested } for the conversation path.
 */
export function buildReceipt(outcome, plan, meta = {}) {
	const p = plan ?? {};
	const newNodeLabels = (p.newNodes ?? []).map((n) => n.label);
	const updatedNodes = new Set([
		...(p.nodeTouches ? [...p.nodeTouches] : []),
		...(p.nodeStateUpdates ?? []).map((u) => u.id),
	]);
	// Auto-created nodes are inside newNodes already; surface them separately too.
	const autoCreated = p.autoCreated ?? [];

	const rejected = p.rejected ?? [];
	const skippedReasons = {};
	for (const r of rejected) {
		// low_confidence_downgraded still SAVES a candidate — don't double-scare.
		skippedReasons[r.reason] = (skippedReasons[r.reason] ?? 0) + 1;
	}

	const saved = {
		pages: (p.newPages ?? []).length,
		nodes: newNodeLabels.length,
		newNodeLabels,
		autoCreated,
		updatedNodes: updatedNodes.size,
		slices: (p.newSlices ?? []).length,
		supersededSlices: (p.sliceSupersede ?? []).length,
		events: (p.newEvents ?? []).length,
		edges: (p.newEdges ?? []).length,
		candidates: (p.newCandidates ?? []).length + (p.candidateBumps ?? []).length,
		reinforcedSlices: (p.sliceTouches ?? []).length,
		reinforcedEvents: (p.eventTouches ?? []).length,
		reinforcedEdges: (p.edgeTouches ?? []).length,
	};

	const savedTotal =
		saved.pages +
		saved.nodes +
		saved.updatedNodes +
		saved.slices +
		saved.supersededSlices +
		saved.events +
		saved.edges +
		saved.candidates +
		saved.reinforcedSlices +
		saved.reinforcedEvents +
		saved.reinforcedEdges;

	return {
		outcome,
		source: meta.source ?? "ingest",
		source_mode: meta.source_mode ?? meta.sourceMode ?? null,
		extraction_run_id: meta.extraction_run_id ?? null,
		source_packet_id: meta.source_packet_id ?? meta.sourcePacketId ?? null,
		idempotency_key: meta.idempotency_key ?? meta.idempotencyKey ?? null,
		scope_json: meta.scope_json ?? meta.scopeJson ?? null,
		project_id: meta.project_id ?? meta.projectId ?? null,
		project_name: meta.project_name ?? meta.projectName ?? null,
		delivery: meta.delivery ?? null,
		received: meta.received ?? null,
		digested: meta.digested ?? null,
		...contextTraceFields(meta),
		...sourceEventTraceFields(meta),
		// How long the memory work took. Metadata for the Requests page; null
		// when the caller did not measure it.
		latency_ms: Number.isFinite(meta.latency_ms) ? Math.round(meta.latency_ms) : null,
		...splitRescueFields(meta),
		...extractionConservationFields(meta),
		...atomicCaptureFields(meta),
		...(meta.rules_active ? { rules_active: meta.rules_active } : {}),
		saved,
		savedTotal,
		// 7.3 — repetition is an explicit NOOP, visible: these rows already
		// existed and were refreshed, not re-inserted. Changes the arithmetic
		// of saves-in vs memories-out on purpose.
		duplicates_noop: saved.reinforcedSlices + saved.reinforcedEvents + saved.reinforcedEdges,
		// 7.2 — every non-exact merge, with its basis, for contamination audits.
		...(Array.isArray(p.merges) && p.merges.length ? { merges: p.merges } : {}),
		skipped: rejected.length,
		skippedReasons,
		actions: {
			createdNodes: (p.newNodes ?? []).map((n) => ({ id: n.id, label: n.label })),
			createdSlices: (p.newSlices ?? []).map((s) => ({ id: s.id, node_id: s.node_id, kind: s.kind })),
			createdEvents: (p.newEvents ?? []).map((e) => ({ id: e.id, node_id: e.node_id, action: e.action })),
			createdEdges: (p.newEdges ?? []).map((e) => ({ id: e.id, from_node: e.from_node, to_node: e.to_node, type: e.type })),
			reinforcedNodes: [...updatedNodes].map((id) => ({ id })),
			supersededSlices: p.sliceSupersede ?? [],
			reinforcedSlices: p.sliceTouches ?? [],
			reinforcedEvents: p.eventTouches ?? [],
			reinforcedEdges: p.edgeTouches ?? [],
			skippedObjects: rejected,
		},
		created_at: Date.now(),
	};
}

/** A receipt for a path that never reached the gates (no fire, parse failure…). */
export function emptyReceipt(outcome, reason, meta = {}) {
	return {
		outcome,
		source: meta.source ?? "ingest",
		source_mode: meta.source_mode ?? meta.sourceMode ?? null,
		extraction_run_id: meta.extraction_run_id ?? null,
		source_packet_id: meta.source_packet_id ?? meta.sourcePacketId ?? null,
		idempotency_key: meta.idempotency_key ?? meta.idempotencyKey ?? null,
		scope_json: meta.scope_json ?? meta.scopeJson ?? null,
		project_id: meta.project_id ?? meta.projectId ?? null,
		project_name: meta.project_name ?? meta.projectName ?? null,
		delivery: meta.delivery ?? null,
		received: meta.received ?? null,
		digested: meta.digested ?? null,
		...contextTraceFields(meta),
		...sourceEventTraceFields(meta),
		latency_ms: Number.isFinite(meta.latency_ms) ? Math.round(meta.latency_ms) : null,
		matched: Number.isFinite(meta.matched) ? Math.round(meta.matched) : null,
		...splitRescueFields(meta),
		...extractionConservationFields(meta),
		...atomicCaptureFields(meta),
		// Workers AI rollups, when the caller metered this scope (recall does).
		ai_calls: meta.ai?.calls ?? null,
		ai_input_tokens: meta.ai?.input_tokens ?? null,
		ai_output_tokens: meta.ai?.output_tokens ?? null,
		ai_neurons: meta.ai?.neurons ?? null,
		saved: {
			pages: 0,
			nodes: 0,
			newNodeLabels: [],
			autoCreated: [],
			updatedNodes: 0,
			slices: 0,
			supersededSlices: 0,
			events: 0,
			edges: 0,
			candidates: 0,
			reinforcedSlices: 0,
			reinforcedEvents: 0,
			reinforcedEdges: 0,
		},
		savedTotal: 0,
		skipped: meta.skipped ?? 0,
		skippedReasons: {},
		reason,
		created_at: Date.now(),
	};
}

/**
 * Outcomes that mean the content really was taken in. Everything else — the
 * gate's "ignored", an opt-out, a failure — was NOT saved, and a replay of it
 * must never be described as if it were.
 */
const ACCEPTED_OUTCOMES = new Set(["accepted", "saved", "accumulating"]);
const SKIPPED_OUTCOMES = new Set(["ignored", "skipped", "opted_out"]);

/**
 * Honest wording for an idempotent replay (1.10). Re-sending the same content
 * inside the window answers with the ORIGINAL verdict, and that verdict decides
 * the sentence:
 *
 *   accepted earlier  → "Already saved…"
 *   gated out earlier → "Not saved… skipped, and why"
 *   verdict unknown   → say only that it was seen before
 *
 * The old fallback claimed acceptance whenever the original receipt could not
 * be read, so content the gate had rejected came back as "Already saved — this
 * exact content was accepted earlier." That is the one lie this product cannot
 * tell: never claim an acceptance that did not happen.
 */
export function replaySummary(receipt, storedSummary = null) {
	const outcome = receipt?.outcome ?? null;
	const reason = String(receipt?.reason ?? "").trim().replace(/\.$/, "");

	if (ACCEPTED_OUTCOMES.has(outcome)) {
		// The original receipt's own words are the most accurate thing we have.
		return storedSummary || "Already saved — this exact content was accepted earlier.";
	}
	if (SKIPPED_OUTCOMES.has(outcome)) {
		return `Not saved — this exact content was sent before and skipped${reason ? `: ${reason}` : ""}.`;
	}
	if (outcome) {
		return `Not saved — this exact content was sent before and recorded as "${outcome}"${reason ? `: ${reason}` : ""}.`;
	}
	// No readable verdict. State the fact we are sure of and nothing more.
	return "Seen before — this exact content was already received. Nothing new was saved; check the packet status for what became of the original.";
}

/** The one-line human string a save tool returns. */
export function formatReceipt(receipt) {
	if (!receipt) return "Captured.";
	// Recall receipts are lookups, not saves — never phrase them as "Saved: 0".
	if (receipt.outcome === "recalled") {
		return "Memory lookup completed — recalled context was returned to the caller.";
	}
	if (receipt.outcome === "no_recall") {
		return "Memory lookup skipped — the question didn't need personal context.";
	}
	if (receipt.outcome === "accepted") {
		return `Accepted: ${receipt.reason || "memory extraction is processing"}.`;
	}
	if (receipt.outcome === "accumulating") {
		return `Accepted: ${receipt.reason || "learning trigger is accumulating more context"}.`;
	}
	const s = receipt.saved ?? {};
	const parts = [];
	if (s.pages) parts.push(plural(s.pages, "page"));
	if (s.nodes) {
		const labels = (s.newNodeLabels ?? []).filter(Boolean);
		parts.push(plural(s.nodes, "node") + (labels.length ? ` (${labels.join(", ")})` : ""));
	}
	if (s.updatedNodes) parts.push(`${s.updatedNodes} updated`);
	if (s.slices) parts.push(plural(s.slices, "slice"));
	if (s.supersededSlices) parts.push(`${s.supersededSlices} superseded`);
	if (s.events) parts.push(plural(s.events, "event"));
	if (s.edges) parts.push(plural(s.edges, "edge"));
	if (s.candidates) parts.push(plural(s.candidates, "candidate"));
	if (s.reinforcedSlices) parts.push(`${s.reinforcedSlices} reinforced slice${s.reinforcedSlices === 1 ? "" : "s"}`);
	if (s.reinforcedEvents) parts.push(`${s.reinforcedEvents} reinforced event${s.reinforcedEvents === 1 ? "" : "s"}`);
	if (s.reinforcedEdges) parts.push(`${s.reinforcedEdges} reinforced edge${s.reinforcedEdges === 1 ? "" : "s"}`);

	if (receipt.savedTotal === 0) {
		const reason =
			receipt.reason ||
			(Object.keys(receipt.skippedReasons ?? {}).length
				? `only ${[...new Set(Object.keys(receipt.skippedReasons).map(phraseFor))].join(", ")}`
				: "no durable memory found");
		return `Saved: 0. Reason: ${reason}.`;
	}

	let line = `Saved: ${parts.join(", ")}.`;
	if (receipt.skipped > 0) {
		const reasons = [...new Set(Object.keys(receipt.skippedReasons).map(phraseFor))].slice(0, 3);
		line += ` Skipped: ${receipt.skipped} (${reasons.join(", ")}).`;
	}
	if (receipt.extraction_run_id) line += ` Receipt: ${receipt.extraction_run_id}.`;
	return line;
}
