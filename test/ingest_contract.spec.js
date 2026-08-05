import { describe, expect, it } from "vitest";

import {
	INGEST_CAPTURE_EVIDENCE_SCHEMA,
	INGEST_DELIVERY_SCHEMA,
	INGEST_LIMITS,
	INGEST_MESSAGE_ID_MAX_CHARACTERS,
	LEGACY_CLAUDE_OUTBOX_LIMITS,
	isLegacyClaudeOutboxBody,
	normalizeCaptureEvidence,
	normalizeDeliveryMetadata,
	unicodeLength,
	utf8Length,
	validateIngestBody,
} from "../src/lib/ingest_contract.mjs";

const message = (content, id = "m") => ({ id, role: "user", content });
const groupId = `claude_delivery_v1_${"a".repeat(40)}`;

function captureEvidence(overrides = {}) {
	return {
		schema: INGEST_CAPTURE_EVIDENCE_SCHEMA,
		inputRows: 12,
		capturedEvents: 4,
		returnedEvents: 3,
		omittedEvents: 1,
		malformedRows: 1,
		ineligibleRows: 2,
		ignoredThinkingBlocks: 3,
		ignoredMetaRows: 1,
		ignoredToolEvents: 2,
		ignoredRecallEvents: 1,
		ignoredRecallEchoEvents: 1,
		ignoredUnprotectedAssistantEvents: 1,
		ignoredNoiseEvents: 2,
		ambiguousOutcomeRows: 1,
		companionLimitRejectedOutcomeRows: 1,
		closureEventLimitRejectedOutcomeRows: 1,
		truncatedEvents: 1,
		redactions: { api_key: 1, named_secret: 2 },
		tailReturnedRecords: 12,
		tailScannedBytes: 4096,
		tailOversizedLines: 0,
		tailMalformedLines: 1,
		tailIneligibleLines: 2,
		tailEmptyLines: 0,
		...overrides,
	};
}

function delivery(overrides = {}) {
	return {
		schema: INGEST_DELIVERY_SCHEMA,
		groupId,
		batchIndex: 0,
		batchCount: 1,
		sourceMessageCount: 1,
		segmentCount: 1,
		splitSourceMessages: 0,
		captureTruncated: false,
		truncationReason: null,
		...overrides,
	};
}

describe("authoritative ingest contract", () => {
	it("publishes frozen limits shared by the Worker and hook outbox", () => {
		expect(INGEST_LIMITS).toEqual({
			maxMessages: 30,
			maxMessageCharacters: 4_000,
			maxTotalCharacters: 120_000,
			maxRequestBytes: 512 * 1024,
		});
		expect(Object.isFrozen(INGEST_LIMITS)).toBe(true);
		expect(() => { INGEST_LIMITS.maxMessages = 80; }).toThrow();
	});

	it.each([
		[3_999, null],
		[4_000, null],
		[4_001, "ingest_message_characters_exceeded"],
	])("enforces the per-message boundary at %i Unicode code points", (length, error) => {
		const result = validateIngestBody({ messages: [message("x".repeat(length))] });
		expect(result?.error ?? null).toBe(error);
		if (result) expect(result).toMatchObject({ status: 422, field: "messages[0].content", limit: 4_000, actual: length });
	});

	it.each([
		[29, 3_999, null],
		[29, 4_000, null],
		[29, 4_001, "ingest_total_characters_exceeded"],
	])("enforces combined content around the total limit (%i full messages + tail %i)", (full, tail, error) => {
		const messages = Array.from({ length: full }, (_, index) => message("x".repeat(4_000), `m${index}`));
		messages.push(message("x".repeat(tail), "tail"));
		const result = validateIngestBody({ messages });
		expect(result?.error ?? null).toBe(error);
		if (result) expect(result).toMatchObject({ status: 422, field: "messages", limit: 120_000, actual: 120_001 });
	});

	it("accepts 30 messages and rejects both 31 and 80 on the current contract", () => {
		expect(validateIngestBody({ messages: Array.from({ length: 30 }, (_, i) => message("x".repeat(4_000), `m${i}`)) })).toBeNull();
		for (const count of [31, 80]) {
			expect(validateIngestBody({ messages: Array.from({ length: count }, (_, i) => message("x".repeat(4_000), `m${i}`)) }))
				.toMatchObject({ status: 422, error: "ingest_message_count_exceeded", field: "messages", limit: 30, actual: count });
		}
	});

	it("rejects one enormous logical message with an explicit character limit", () => {
		expect(validateIngestBody({ messages: [message("x".repeat(200_000))] })).toMatchObject({
			status: 422,
			error: "ingest_total_characters_exceeded",
			field: "messages",
			limit: INGEST_LIMITS.maxTotalCharacters,
			actual: 200_000,
		});
	});

	it.each([
		[{ content: ["not", "text"] }, "messages[0].content"],
		[[], "messages[0]"],
		[{ id: "", role: "user", content: "valid content" }, "messages[0].id"],
		[{ id: 0, role: "user", content: "valid content" }, "messages[0].id"],
		[{ id: "x".repeat(INGEST_MESSAGE_ID_MAX_CHARACTERS + 1), role: "user", content: "valid content" }, "messages[0].id"],
		[{ id: "m1", role: "unknown", content: "valid content" }, "messages[0].role"],
	])("rejects malformed message shape %# before it can be normalized away", (value, field) => {
		expect(validateIngestBody({ messages: [value] })).toMatchObject({
			status: 422,
			error: "invalid_ingest_message",
			field,
			messageIndex: 0,
			retryable: false,
		});
	});

	it("rejects duplicate explicit message ids instead of collapsing content", () => {
		expect(validateIngestBody({ messages: [
			message("first", "same"),
			message("second", "same"),
		] })).toMatchObject({
			status: 422,
			error: "invalid_ingest_message",
			field: "messages[1].id",
			actual: "duplicate",
		});
	});

	it("counts astral Unicode as code points while counting serialized HTTP bytes as UTF-8", () => {
		const content = "🪁".repeat(4_000);
		expect(content.length).toBe(8_000);
		expect(unicodeLength(content)).toBe(4_000);
		expect(validateIngestBody({ messages: [message(content)] })).toBeNull();
		expect(utf8Length(content)).toBe(16_000);
		const escaped = JSON.stringify({ messages: [message("\ud800")] });
		expect(utf8Length(escaped)).toBe(new TextEncoder().encode(escaped).byteLength);
	});

	it.each([
		[INGEST_LIMITS.maxRequestBytes - 1, null],
		[INGEST_LIMITS.maxRequestBytes, null],
		[INGEST_LIMITS.maxRequestBytes + 1, "ingest_request_too_large"],
	])("enforces the serialized request byte boundary at %i", (requestBytes, error) => {
		const result = validateIngestBody({ messages: [] }, { requestBytes });
		expect(result?.error ?? null).toBe(error);
		if (result) expect(result).toMatchObject({ status: 413, field: "request", limit: 524_288, actual: 524_289, unit: "bytes" });
	});

	it("measures the actual serialized JSON boundary, including multibyte values", () => {
		const base = { messages: [], idempotencyKey: "", sourceId: "é" };
		const overhead = utf8Length(JSON.stringify(base));
		for (const delta of [-1, 0, 1]) {
			const body = { ...base, idempotencyKey: "x".repeat(INGEST_LIMITS.maxRequestBytes + delta - overhead) };
			const requestBytes = utf8Length(JSON.stringify(body));
			expect(requestBytes).toBe(INGEST_LIMITS.maxRequestBytes + delta);
			expect(validateIngestBody(body, { requestBytes })?.status ?? null).toBe(delta > 0 ? 413 : null);
		}
	});

	it("normalizes complete ordered-delivery metadata and rejects malformed ordering", () => {
		expect(normalizeDeliveryMetadata(delivery({ batchIndex: 2, batchCount: 3 }))).toEqual(delivery({ batchIndex: 2, batchCount: 3 }));
		for (const invalid of [
			delivery({ groupId: "wrong" }),
			delivery({ batchIndex: 3, batchCount: 3 }),
			delivery({ batchCount: 129 }),
			delivery({ sourceMessageCount: -1 }),
			delivery({ captureTruncated: false, truncationReason: "bounded_scan" }),
			{ ...delivery(), unknown: true },
		]) {
			expect(normalizeDeliveryMetadata(invalid)).toBeNull();
			expect(validateIngestBody({ messages: [], delivery: invalid })).toMatchObject({
				status: 422,
				error: "invalid_ingest_delivery_metadata",
				field: "delivery",
			});
		}
	});

	it("accepts only fixed, content-free, bounded capture evidence", () => {
		const evidence = captureEvidence();
		expect(normalizeCaptureEvidence(evidence)).toEqual(evidence);
		expect(normalizeDeliveryMetadata(delivery({ captureTruncated: true, truncationReason: "max_capture_events", captureEvidence: evidence })))
			.toEqual(delivery({ captureTruncated: true, truncationReason: "max_capture_events", captureEvidence: evidence }));
		for (const invalid of [
			{ ...evidence, rawCommand: "must never cross the wire" },
			{ ...evidence, capturedEvents: "4" },
			{ ...evidence, omittedEvents: 0 },
			{ ...evidence, ineligibleRows: evidence.inputRows + 1 },
			{ ...evidence, ignoredMetaRows: evidence.inputRows + 1 },
			{ ...evidence, ignoredNoiseEvents: evidence.inputRows + 1 },
			{ ...evidence, tailReturnedRecords: evidence.inputRows + 1 },
			{ ...evidence, tailIneligibleLines: evidence.inputRows + 1 },
			{ ...evidence, tailScannedBytes: 64 * 1024 * 1024 + 1 },
			{ ...evidence, redactions: { secret_value: 1 } },
		]) expect(normalizeCaptureEvidence(invalid)).toBeNull();
	});

	it("keeps only already-spooled v1 Claude envelopes on their former bounded shape", () => {
		const legacy = {
			source: "plugin",
			idempotencyKey: `claude-outbox:v1:${"b".repeat(64)}`,
			messages: Array.from({ length: 80 }, (_, i) => message("x".repeat(4_001), `m${i}`)),
		};
		expect(isLegacyClaudeOutboxBody(legacy)).toBe(true);
		expect(validateIngestBody(legacy, { requestBytes: LEGACY_CLAUDE_OUTBOX_LIMITS.maxRequestBytes })).toBeNull();
		expect(validateIngestBody(legacy, { requestBytes: LEGACY_CLAUDE_OUTBOX_LIMITS.maxRequestBytes + 1 })).toMatchObject({
			status: 413,
			limit: LEGACY_CLAUDE_OUTBOX_LIMITS.maxRequestBytes,
			actual: LEGACY_CLAUDE_OUTBOX_LIMITS.maxRequestBytes + 1,
		});
		expect(validateIngestBody({ ...legacy, source: "ingest" })).toMatchObject({
			error: "ingest_message_count_exceeded",
			limit: INGEST_LIMITS.maxMessages,
		});
		expect(validateIngestBody({ ...legacy, messages: [...legacy.messages, message("x", "m80")] })).toMatchObject({
			error: "ingest_message_count_exceeded",
			limit: LEGACY_CLAUDE_OUTBOX_LIMITS.maxMessages,
			actual: 81,
		});
	});
});
