function ensure(condition, message) {
	if (!condition) throw new Error(message);
}

function count(value) {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function groupByPacket(rows) {
	const grouped = new Map();
	for (const row of rows) {
		const packetId = row?.source_packet_id;
		if (!grouped.has(packetId)) grouped.set(packetId, []);
		grouped.get(packetId).push(row);
	}
	return grouped;
}

/**
 * Reconcile final state without erasing honest retry history.
 *
 * A memory job's receipt_id is the authoritative final receipt. Older receipts
 * and a bounded inference_outcome_unknown predecessor remain durable evidence,
 * but must not be summed as if they were additional final candidates.
 */
export function reconcileRetryAwareState({
	sampleId,
	packetIds,
	expectedProjectId,
	jobs,
	extractionRuns,
	receipts,
	captureRuns,
	candidates,
	projections,
}) {
	const prefix = `${sampleId}: retry-aware state`;
	const packetSet = new Set(packetIds);
	ensure(packetSet.size === packetIds.length, `${prefix}: duplicate accepted packet id`);
	for (const collection of [jobs, extractionRuns, receipts, captureRuns, candidates, projections]) {
		ensure(collection.every((row) => packetSet.has(row.source_packet_id)),
			`${prefix}: row escaped the accepted packet set`);
	}

	const extractJobs = jobs.filter((job) => job.type === "extract");
	const pass2Jobs = jobs.filter((job) => job.type === "pass2_rollup");
	ensure(extractJobs.length + pass2Jobs.length === jobs.length,
		`${prefix}: unsupported memory-job type`);
	const jobsByPacket = groupByPacket(extractJobs);
	const pass2ByExtraction = new Map();
	for (const job of pass2Jobs) {
		ensure(["completed", "skipped"].includes(job.status) && job.error == null,
			`${prefix}: pass-2 job is not successful terminal state`);
		ensure(job.extraction_run_id && !pass2ByExtraction.has(job.extraction_run_id),
			`${prefix}: pass-2 extraction ownership is missing or duplicated`);
		pass2ByExtraction.set(job.extraction_run_id, job);
	}
	const extractionByPacket = groupByPacket(extractionRuns);
	const captureByPacket = groupByPacket(captureRuns);
	const receiptsById = new Map();
	for (const receipt of receipts) {
		ensure(receipt.id && !receiptsById.has(receipt.id), `${prefix}: duplicate receipt id`);
		receiptsById.set(receipt.id, receipt);
	}

	const successfulRuns = extractionRuns.filter((row) => ["wrote", "skipped"].includes(row.status));
	const interruptedRuns = extractionRuns.filter((row) => row.status === "failed"
		&& String(row.error ?? "").startsWith("inference_outcome_unknown:"));
	const unsupportedRuns = extractionRuns.filter((row) => !successfulRuns.includes(row)
		&& !interruptedRuns.includes(row));
	const unsupportedSummary = {
		statuses: Object.fromEntries([...new Set(unsupportedRuns.map((row) => row.status))]
			.map((status) => [status, unsupportedRuns.filter((row) => row.status === status).length])),
		errors: Object.fromEntries([...new Set(unsupportedRuns.map((row) => String(row.error ?? "").split(":")[0]))]
			.map((error) => [error, unsupportedRuns.filter((row) => String(row.error ?? "").startsWith(error)).length])),
		packets: Object.fromEntries([...new Set(unsupportedRuns.map((row) => row.source_packet_id))]
			.map((packetId) => [packetId, unsupportedRuns.filter((row) => row.source_packet_id === packetId).length])),
		nonterminal: unsupportedRuns.filter((row) => ["running", "committing"].includes(row.status)).map((row) => ({
			id: row.id,
			packetId: row.source_packet_id,
			ageMs: Date.now() - count(row.updated_at ?? row.created_at),
			captureRuns: captureRuns.filter((run) => run.extraction_run_id === row.id).map((run) => ({
				id: run.id, status: run.status, attempts: count(run.attempts), stored: count(run.stored_count),
			})),
			candidates: candidates.filter((candidate) => candidate.extraction_run_id === row.id).length,
			projections: projections.filter((projection) => projection.projection_extraction_run_id === row.id).length,
			job: jobs.find((job) => job.source_packet_id === row.source_packet_id && job.type === "extract") ?? null,
		})),
	};
	ensure(extractionRuns.length === successfulRuns.length + interruptedRuns.length,
		`${prefix}: unsupported extraction history ${JSON.stringify(unsupportedSummary)}`);
	ensure(successfulRuns.length > 0, `${prefix}: no successful extraction runs`);

	const canonicalReceipts = successfulRuns.map((run) => {
		const receipt = receiptsById.get(run.receipt_id);
		ensure(receipt && receipt.source_packet_id === run.source_packet_id,
			`${prefix}: successful extraction receipt is missing or cross-bound`);
		ensure(count(receipt.atomic_enabled) === 1 && count(receipt.atomic_complete) === 1,
			`${prefix}: canonical atomic receipt is incomplete`);
		const pass2 = pass2ByExtraction.get(run.id);
		if (run.status === "wrote") {
			ensure(pass2 && run.job_id === pass2.id,
				`${prefix}: wrote extraction lacks its terminal pass-2 job`);
		} else {
			ensure(!run.job_id || (pass2 && run.job_id === pass2.id),
				`${prefix}: skipped extraction has inconsistent pass-2 ownership`);
		}
		return receipt;
	});
	ensure(pass2ByExtraction.size === successfulRuns.filter((run) => run.status === "wrote").length,
		`${prefix}: pass-2 jobs do not reconcile with wrote extractions`);
	ensure(new Set(canonicalReceipts.map((receipt) => receipt.id)).size === successfulRuns.length,
		`${prefix}: canonical receipts are not one-to-one with successful extractions`);

	let interruptedPredecessors = 0;
	let repairedPackets = 0;
	let repairGenerations = 0;
	const canonicalReceiptIds = new Set(canonicalReceipts.map((receipt) => receipt.id));
	for (const packetId of packetIds) {
		const packetJobs = jobsByPacket.get(packetId) ?? [];
		ensure(packetJobs.length === 1, `${prefix}: ${packetId} has ${packetJobs.length} jobs`);
		const job = packetJobs[0];
		const generation = count(job.repair_generation);
		ensure(["enriched", "completed"].includes(job.status) && job.error == null,
			`${prefix}: ${packetId} job is not successful terminal state`);
		ensure(job.project_id === expectedProjectId && count(job.remaining) === 0,
			`${prefix}: ${packetId} job scope/remaining mismatch`);
		ensure(Number.isSafeInteger(generation) && generation >= 0 && generation <= 3,
			`${prefix}: ${packetId} repair generation is invalid`);

		const history = extractionByPacket.get(packetId) ?? [];
		const successful = history.filter((row) => ["wrote", "skipped"].includes(row.status));
		const interrupted = history.filter((row) => row.status === "failed"
			&& String(row.error ?? "").startsWith("inference_outcome_unknown:"));
		ensure(history.length === successful.length + interrupted.length,
			`${prefix}: ${packetId} has unsupported extraction history`);
		ensure(interrupted.length <= generation,
			`${prefix}: ${packetId} interruption history exceeds its repair generation`);
		if (interrupted.length > 0) {
			ensure(generation > 0, `${prefix}: ${packetId} interruption lacks repair proof`);
			ensure(interrupted.every((row) => successful.some((success) => count(success.created_at) >= count(row.created_at))),
				`${prefix}: ${packetId} successful extraction predates its interruption`);
		}

		const packetCaptureRuns = captureByPacket.get(packetId) ?? [];
		if (generation > 0 && interrupted.length === 0) {
			ensure(packetCaptureRuns.some((row) => count(row.attempts) > 1),
				`${prefix}: ${packetId} repair generation has no retry evidence`);
		}
		if (job.receipt_id != null) {
			const linked = receiptsById.get(job.receipt_id);
			ensure(linked && linked.source_packet_id === packetId,
				`${prefix}: ${packetId} terminal job receipt is missing or cross-bound`);
		}
		if (generation > 0) {
			ensure(canonicalReceiptIds.has(job.receipt_id),
				`${prefix}: ${packetId} repaired job does not link its successful receipt`);
		}
		interruptedPredecessors += interrupted.length;
		if (generation > 0) repairedPackets += 1;
		repairGenerations += generation;
	}

	ensure(captureRuns.length > 0
		&& captureRuns.every((row) => ["completed", "empty"].includes(row.status)),
	`${prefix}: capture runs are not completely terminal`);
	const extractionIds = new Set(extractionRuns.map((row) => row.id));
	ensure(captureRuns.every((row) => extractionIds.has(row.extraction_run_id)),
		`${prefix}: capture run escaped extraction history`);
	const receiptChunks = canonicalReceipts.reduce((sum, receipt) => sum + count(receipt.atomic_chunks), 0);
	const receiptStored = canonicalReceipts.reduce((sum, receipt) => sum + count(receipt.atomic_stored), 0);
	const durableStored = captureRuns.reduce((sum, run) => sum + count(run.stored_count), 0);
	ensure(receiptChunks >= captureRuns.length && receiptStored === candidates.length
		&& durableStored === candidates.length,
	`${prefix}: canonical capture receipts do not reconcile`);
	ensure(canonicalReceipts.every((receipt) => count(receipt.projection_candidates) === 0
		|| count(receipt.projection_enabled) === 1),
	`${prefix}: projection work lacks an enabled canonical receipt`);
	const canonicalProjectionCandidates = canonicalReceipts.reduce((sum, receipt) =>
		sum + count(receipt.projection_candidates), 0);
	const canonicalProjectionOutcomes = canonicalReceipts.reduce((sum, receipt) =>
		sum + count(receipt.projection_promoted) + count(receipt.projection_reinforced)
			+ count(receipt.projection_ignored), 0);
	ensure(projections.length === candidates.length
		&& canonicalProjectionCandidates === canonicalProjectionOutcomes
		&& canonicalProjectionCandidates <= candidates.length,
	`${prefix}: projection receipt accounting is impossible`);
	const receiptAccounting = {
		captureStored: receiptStored,
		durableCandidates: candidates.length,
		durableProjections: projections.length,
		projectionCandidates: canonicalProjectionCandidates,
		projectionOutcomes: canonicalProjectionOutcomes,
		projectionCandidateGap: candidates.length - canonicalProjectionCandidates,
		projectionOutcomeGap: candidates.length - canonicalProjectionOutcomes,
	};
	return {
		canonicalReceipts,
		receiptAccounting,
		retryHistory: {
			repairedPackets,
			repairGenerations,
			interruptedPredecessors,
			successfulExtractions: successfulRuns.length,
			pass2Jobs: pass2Jobs.length,
			canonicalReceipts: canonicalReceipts.length,
		},
	};
}
