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
	unknown_kind: "unrecognized",
};

function phraseFor(reason) {
	return REASON_PHRASE[reason] ?? reason ?? "skipped";
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
		nodes: newNodeLabels.length,
		newNodeLabels,
		autoCreated,
		updatedNodes: updatedNodes.size,
		slices: (p.newSlices ?? []).length,
		events: (p.newEvents ?? []).length,
		edges: (p.newEdges ?? []).length,
		candidates: (p.newCandidates ?? []).length + (p.candidateBumps ?? []).length,
	};

	const savedTotal =
		saved.nodes + saved.updatedNodes + saved.slices + saved.events + saved.edges + saved.candidates;

	return {
		outcome,
		source: meta.source ?? "ingest",
		received: meta.received ?? null,
		digested: meta.digested ?? null,
		saved,
		savedTotal,
		skipped: rejected.length,
		skippedReasons,
		created_at: Date.now(),
	};
}

/** A receipt for a path that never reached the gates (no fire, parse failure…). */
export function emptyReceipt(outcome, reason, meta = {}) {
	return {
		outcome,
		source: meta.source ?? "ingest",
		received: meta.received ?? null,
		digested: meta.digested ?? null,
		saved: {
			nodes: 0,
			newNodeLabels: [],
			autoCreated: [],
			updatedNodes: 0,
			slices: 0,
			events: 0,
			edges: 0,
			candidates: 0,
		},
		savedTotal: 0,
		skipped: meta.skipped ?? 0,
		skippedReasons: {},
		reason,
		created_at: Date.now(),
	};
}

/** The one-line human string a save tool returns. */
export function formatReceipt(receipt) {
	if (!receipt) return "Captured.";
	const s = receipt.saved ?? {};
	const parts = [];
	if (s.nodes) {
		const labels = (s.newNodeLabels ?? []).filter(Boolean);
		parts.push(plural(s.nodes, "node") + (labels.length ? ` (${labels.join(", ")})` : ""));
	}
	if (s.updatedNodes) parts.push(`${s.updatedNodes} updated`);
	if (s.slices) parts.push(plural(s.slices, "slice"));
	if (s.events) parts.push(plural(s.events, "event"));
	if (s.edges) parts.push(plural(s.edges, "edge"));
	if (s.candidates) parts.push(plural(s.candidates, "candidate"));

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
	return line;
}
