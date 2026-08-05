import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
	claudeCaptureExclusionEvidence,
	isClaudeCaptureCorrelationRow,
	isClaudeCaptureEligibleRow,
	selectClaudeCaptureTailRows,
} from "./claude-capture.mjs";

const CAPTURE_EXCLUSION_KEYS = Object.freeze([
	"inputRows",
	"ineligibleRows",
	"ignoredThinkingBlocks",
	"ignoredMetaRows",
	"ignoredToolEvents",
	"ignoredRecallEvents",
	"ignoredRecallEchoEvents",
	"ignoredUnprotectedAssistantEvents",
	"ignoredNoiseEvents",
]);

function emptyCaptureExclusions() {
	return Object.fromEntries(CAPTURE_EXCLUSION_KEYS.map((key) => [key, 0]));
}

function mergeCaptureExclusions(target, source) {
	for (const key of CAPTURE_EXCLUSION_KEYS) target[key] += Number(source?.[key] ?? 0);
}

export const DEFAULT_CLAUDE_TAIL_MAX_EVENTS = 80;
export const DEFAULT_CLAUDE_TAIL_MAX_SCANNED_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CLAUDE_TAIL_MAX_SCAN_MS = 500;
export const DEFAULT_CLAUDE_TAIL_MAX_LINE_BYTES = 256 * 1024;
export const DEFAULT_CLAUDE_TAIL_READ_CHUNK_BYTES = 64 * 1024;

function positiveInteger(value, fallback, name) {
	const resolved = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
	return resolved;
}

function positiveNumber(value, fallback, name) {
	const resolved = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(resolved) || resolved <= 0) {
		throw new TypeError(`${name} must be a positive finite number`);
	}
	return resolved;
}

/**
 * Read a bounded snapshot of the newest Claude capture-candidate events.
 *
 * `lines` is directly consumable by `messagesFromClaudeTranscriptLines`.
 * `records` contains the same strings together with absolute byte ranges from
 * the file snapshot, so callers can retain stable source provenance.
 */
export async function readClaudeTranscriptTail(filePath, options = {}) {
	const maxEvents = positiveInteger(
		options.maxEvents,
		DEFAULT_CLAUDE_TAIL_MAX_EVENTS,
		"maxEvents",
	);
	const maxScannedBytes = positiveInteger(
		options.maxScannedBytes,
		DEFAULT_CLAUDE_TAIL_MAX_SCANNED_BYTES,
		"maxScannedBytes",
	);
	const maxScanMs = positiveNumber(
		options.maxScanMs,
		DEFAULT_CLAUDE_TAIL_MAX_SCAN_MS,
		"maxScanMs",
	);
	const maxLineBytes = positiveInteger(
		options.maxLineBytes,
		DEFAULT_CLAUDE_TAIL_MAX_LINE_BYTES,
		"maxLineBytes",
	);
	const readChunkBytes = Math.min(
		positiveInteger(
			options.readChunkBytes,
			DEFAULT_CLAUDE_TAIL_READ_CHUNK_BYTES,
			"readChunkBytes",
		),
		maxScannedBytes,
	);

	const handle = await open(filePath, "r");
	let snapshotBytes = 0;
	let observedFileBytes = 0;
	let scannedBytes = 0;
	let oversizedLines = 0;
	let malformedLines = 0;
	let ineligibleLines = 0;
	let emptyLines = 0;
	let partialLineSkipped = false;
	let fileChangedDuringScan = false;
	let stopReason = "start_of_file";
	const newestFirst = [];
	const preselectionCaptureExclusions = emptyCaptureExclusions();
	const startedAt = performance.now();

	try {
		const initialStat = await handle.stat();
		snapshotBytes = Number(initialStat.size);
		observedFileBytes = snapshotBytes;

		// This hook is useful to coordinate telemetry and deterministic concurrency
		// tests. The reader's byte range is already fixed before it is invoked.
		if (typeof options.onSnapshot === "function") {
			await options.onSnapshot({ snapshotBytes });
		}

		const scanStartedAt = performance.now();
		const lowerBound = Math.max(0, snapshotBytes - maxScannedBytes);
		let cursor = snapshotBytes;
		let currentLineEndExclusive = snapshotBytes;
		let currentLineBytes = 0;
		let currentLineOversized = false;
		let fragments = [];
		let stopped = false;

		function timedOut() {
			return performance.now() - scanStartedAt >= maxScanMs;
		}

		function appendFragment(buffer, start, end) {
			const length = end - start;
			if (length <= 0) return;
			currentLineBytes += length;
			if (!currentLineOversized && currentLineBytes > maxLineBytes) {
				currentLineOversized = true;
				oversizedLines += 1;
				fragments = [];
				return;
			}
			if (!currentLineOversized) fragments.push(buffer.subarray(start, end));
		}

		function resetLine(nextEndExclusive) {
			currentLineEndExclusive = nextEndExclusive;
			currentLineBytes = 0;
			currentLineOversized = false;
			fragments = [];
		}

		function finishLine(byteOffset) {
			if (currentLineOversized) return;
			if (currentLineBytes === 0) {
				// EOF immediately after a newline is not another physical record.
				if (currentLineEndExclusive < snapshotBytes) emptyLines += 1;
				return;
			}

			fragments.reverse();
			const physical = fragments.length === 1
				? fragments[0]
				: Buffer.concat(fragments, currentLineBytes);
			const hasNewline = currentLineEndExclusive < snapshotBytes;
			const hasCarriageReturn = hasNewline && physical.at(-1) === 0x0d;
			const rawBytes = hasCarriageReturn
				? physical.subarray(0, physical.length - 1)
				: physical;
			if (rawBytes.length === 0) {
				emptyLines += 1;
				return;
			}
			const raw = rawBytes.toString("utf8");
			let row;
			try {
				row = JSON.parse(raw);
			} catch {
				malformedLines += 1;
				return;
			}
			const captureExclusions = claudeCaptureExclusionEvidence(row, options);
			if (!isClaudeCaptureCorrelationRow(row, options)) {
				mergeCaptureExclusions(preselectionCaptureExclusions, captureExclusions);
				ineligibleLines += 1;
				return;
			}
			if (!isClaudeCaptureEligibleRow(row, options)) ineligibleLines += 1;

			newestFirst.push({
				raw,
				byteOffset,
				byteLength: rawBytes.length,
				endOffset: byteOffset + rawBytes.length,
				recordEndOffset: hasNewline
					? currentLineEndExclusive + 1
					: currentLineEndExclusive,
				newlineBytes: hasNewline ? (hasCarriageReturn ? 2 : 1) : 0,
			});
		}

		while (cursor > lowerBound) {
			if (timedOut()) {
				stopReason = "max_time";
				stopped = true;
				break;
			}

			const requestedStart = Math.max(lowerBound, cursor - readChunkBytes);
			const requestedLength = cursor - requestedStart;
			const buffer = Buffer.allocUnsafe(requestedLength);
			const { bytesRead } = await handle.read(buffer, 0, requestedLength, requestedStart);
			if (bytesRead !== requestedLength) {
				fileChangedDuringScan = true;
				stopReason = "file_changed";
				stopped = true;
				break;
			}
			scannedBytes += bytesRead;

			let segmentEnd = bytesRead;
			while (segmentEnd > 0) {
				const newlineIndex = buffer.lastIndexOf(0x0a, segmentEnd - 1);
				const segmentStart = newlineIndex + 1;
				appendFragment(buffer, segmentStart, segmentEnd);

				if (newlineIndex < 0) break;
				const newlineOffset = requestedStart + newlineIndex;
				finishLine(newlineOffset + 1);
				resetLine(newlineOffset);
				segmentEnd = newlineIndex;
				if (timedOut()) {
					stopReason = "max_time";
					stopped = true;
					break;
				}
			}

			cursor = requestedStart;
			if (stopped) break;
		}

		if (!stopped && cursor === 0) {
			finishLine(0);
		} else if (!stopped && cursor === lowerBound && lowerBound > 0) {
			stopReason = "max_bytes";
			partialLineSkipped = currentLineBytes > 0;
		} else if (stopped && (currentLineBytes > 0 || fragments.length > 0)) {
			partialLineSkipped = true;
		}

		try {
			observedFileBytes = Number((await handle.stat()).size);
		} catch {
			fileChangedDuringScan = true;
		}
	} finally {
		await handle.close();
	}

	newestFirst.reverse();
	// max_events is a logical post-selection cap, not a missing transcript
	// prefix. Physical byte/time/change stops require exact host correlation.
	const correlationPrefixIncomplete = stopReason !== "start_of_file"
		|| partialLineSkipped
		|| fileChangedDuringScan
		|| malformedLines > 0
		|| oversizedLines > 0;
	const selection = selectClaudeCaptureTailRows(newestFirst, {
		...options,
		maxEvents,
		prefixTruncated: correlationPrefixIncomplete,
	});
	const records = selection.rows;
	const captureExclusions = { ...preselectionCaptureExclusions };
	mergeCaptureExclusions(captureExclusions, selection.metadata.excludedCaptureEvidence);
	if (stopReason === "start_of_file" && selection.metadata.capturableOutcomeRows > maxEvents) {
		stopReason = "max_events";
	}
	const grewByBytes = Math.max(0, observedFileBytes - snapshotBytes);
	const shrankByBytes = Math.max(0, snapshotBytes - observedFileBytes);
	const scanTruncated = stopReason !== "start_of_file";

	return {
		lines: records.map((record) => record.raw),
		records,
		metadata: {
			snapshotBytes,
			observedFileBytes,
			scannedBytes,
			maxEvents,
			maxScannedBytes,
			maxScanMs,
			maxLineBytes,
			readChunkBytes,
			returnedEvents: selection.metadata.selectedOutcomeRows,
			returnedRows: records.length,
			companionRows: selection.metadata.companionRows,
			maxCompanionRows: selection.metadata.maxCompanionRows,
			companionClosureRows: selection.metadata.companionClosureRows,
			companionClosureLimitReached: selection.metadata.companionClosureLimitReached,
			companionLimitRejectedOutcomeRows: selection.metadata.companionLimitRejectedOutcomeRows,
			closureEventLimitRejectedOutcomeRows: selection.metadata.closureEventLimitRejectedOutcomeRows,
			capturableOutcomeRows: selection.metadata.capturableOutcomeRows,
			ambiguousOutcomeRows: selection.metadata.ambiguousOutcomeRows,
			exactSourceMatches: selection.metadata.exactSourceMatches,
			exactParentMatches: selection.metadata.exactParentMatches,
			fifoMatches: selection.metadata.fifoMatches,
			ambiguousToolResults: selection.metadata.ambiguousToolResults,
			invalidExactLinkResults: selection.metadata.invalidExactLinkResults,
			reusedIdResultsRejected: selection.metadata.reusedIdResultsRejected,
			incompletePrefixResultsRejected: selection.metadata.incompletePrefixResultsRejected,
			unmatchedToolResults: selection.metadata.unmatchedToolResults,
			correlationRowsScanned: newestFirst.length,
			captureExclusions,
			oversizedLines,
			malformedLines,
			ineligibleLines,
			emptyLines,
			partialLineSkipped,
			correlationPrefixIncomplete,
			fileChangedDuringScan,
			fileGrew: grewByBytes > 0,
			grewByBytes,
			fileShrank: shrankByBytes > 0,
			shrankByBytes,
			scanTruncated,
			truncationReason: scanTruncated ? stopReason : null,
			elapsedMs: performance.now() - startedAt,
		},
	};
}
