import test from "node:test";
import assert from "node:assert/strict";

import { reconcileRetryAwareState } from "./state-accounting.mjs";

function repairedFixture() {
	return {
		sampleId: "sample",
		packetIds: ["packet"],
		expectedProjectId: "project",
		jobs: [
			{ id: "extract-job", type: "extract", source_packet_id: "packet", status: "enriched", error: null,
				project_id: "project", remaining: 0, repair_generation: 1, receipt_id: "new" },
			{ id: "pass2-job", type: "pass2_rollup", source_packet_id: "packet", status: "completed",
				error: null, project_id: "project", extraction_run_id: "success" },
		],
		extractionRuns: [
			{ id: "failed", source_packet_id: "packet", status: "failed",
				error: "inference_outcome_unknown: interrupted", created_at: 10 },
			{ id: "success", source_packet_id: "packet", status: "wrote", error: null,
				created_at: 20, job_id: "pass2-job", receipt_id: "new" },
		],
		receipts: [
			{ id: "old", source_packet_id: "packet", atomic_enabled: 1, atomic_complete: 0,
				atomic_chunks: 1, atomic_stored: 1, projection_enabled: 1,
				projection_candidates: 1, projection_promoted: 1, projection_reinforced: 0,
				projection_ignored: 0 },
			{ id: "new", source_packet_id: "packet", atomic_enabled: 1, atomic_complete: 1,
				atomic_chunks: 2, atomic_stored: 3, projection_enabled: 1,
				projection_candidates: 3, projection_promoted: 2, projection_reinforced: 1,
				projection_ignored: 0 },
		],
		captureRuns: [
			{ id: "capture-1", extraction_run_id: "failed", source_packet_id: "packet",
				status: "completed", attempts: 1, stored_count: 1 },
			{ id: "capture-2", extraction_run_id: "success", source_packet_id: "packet",
				status: "completed", attempts: 2, stored_count: 2 },
		],
		candidates: Array.from({ length: 3 }, () => ({ source_packet_id: "packet" })),
		projections: Array.from({ length: 3 }, () => ({ source_packet_id: "packet" })),
	};
}

test("uses the final job-linked receipt while preserving bounded interrupted history", () => {
	const result = reconcileRetryAwareState(repairedFixture());
	assert.deepEqual(result.canonicalReceipts.map((row) => row.id), ["new"]);
	assert.deepEqual(result.retryHistory, {
		repairedPackets: 1,
		repairGenerations: 1,
		interruptedPredecessors: 1,
		successfulExtractions: 1,
		pass2Jobs: 1,
		canonicalReceipts: 1,
	});
});

test("rejects an interrupted predecessor without durable repair-generation proof", () => {
	const fixture = repairedFixture();
	fixture.jobs[0].repair_generation = 0;
	assert.throws(() => reconcileRetryAwareState(fixture), /exceeds its repair generation/);
});

test("rejects a canonical receipt that double-counts final candidates", () => {
	const fixture = repairedFixture();
	fixture.receipts[1].atomic_stored = 4;
	assert.throws(() => reconcileRetryAwareState(fixture), /canonical capture receipts do not reconcile/);
});

test("rejects nonterminal atomic state even when a final receipt exists", () => {
	const fixture = repairedFixture();
	fixture.captureRuns[1].status = "running";
	assert.throws(() => reconcileRetryAwareState(fixture), /capture runs are not completely terminal/);
});
