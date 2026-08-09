/**
 * Authoritative wire limits for conversation ingestion.
 *
 * This module is deliberately runtime-neutral: the Worker and the local
 * Claude outbox import the same constants and pure validators, so batching
 * cannot drift from what the server will accept.
 */

export const INGEST_LIMITS = Object.freeze({
	maxMessages: 30,
	maxMessageCharacters: 4_000,
	maxTotalCharacters: 120_000,
	maxRequestBytes: 512 * 1024,
});

import { parseSourceTime } from "./source_time.mjs";

export const INGEST_DELIVERY_SCHEMA = "itsuki.ingest.delivery/v1";
export const INGEST_CAPTURE_EVIDENCE_SCHEMA = "itsuki.capture-evidence/v1";
export const INGEST_MESSAGE_ID_MAX_CHARACTERS = 200;

const INGEST_MESSAGE_ROLES = new Set(["user", "assistant", "system", "tool"]);

// Migration-only allowance for v1 envelopes already protected on disk before
// ordered batching shipped. New callers cannot select this shape accidentally:
// both the plugin source and the complete v1 outbox key format are required.
export const LEGACY_CLAUDE_OUTBOX_LIMITS = Object.freeze({
	maxMessages: 80,
	maxMessageCharacters: 4_001,
	maxTotalCharacters: 320_080,
	// Stage 3 admitted one protected envelope up to 2 MiB. Keeping the same
	// bounded wire allowance is necessary to drain already-spooled Unicode or
	// JSON-escape-heavy v1 sessions after this deploy.
	maxRequestBytes: 2 * 1024 * 1024,
});

const DELIVERY_KEYS = new Set([
	"schema",
	"groupId",
	"batchIndex",
	"batchCount",
	"sourceMessageCount",
	"segmentCount",
	"splitSourceMessages",
	"captureTruncated",
	"truncationReason",
	"captureEvidence",
]);
const CAPTURE_EVIDENCE_KEYS = new Set([
	"schema",
	"inputRows",
	"capturedEvents",
	"returnedEvents",
	"omittedEvents",
	"malformedRows",
	"ineligibleRows",
	"ignoredThinkingBlocks",
	"ignoredMetaRows",
	"ignoredToolEvents",
	"ignoredRecallEvents",
	"ignoredRecallEchoEvents",
	"ignoredUnprotectedAssistantEvents",
	"ignoredNoiseEvents",
	"ambiguousOutcomeRows",
	"companionLimitRejectedOutcomeRows",
	"closureEventLimitRejectedOutcomeRows",
	"truncatedEvents",
	"redactions",
	"tailReturnedRecords",
	"tailScannedBytes",
	"tailOversizedLines",
	"tailMalformedLines",
	"tailIneligibleLines",
	"tailEmptyLines",
]);
const CAPTURE_REDACTION_KEYS = new Set([
	"private_key",
	"connection_credentials",
	"query_secret",
	"api_key",
	"bearer_token",
	"high_entropy",
	"named_secret",
]);
const MAX_CAPTURE_EVIDENCE_COUNTER = 64 * 1024 * 1024;
const DELIVERY_GROUP_ID = /^(?:claude|codex)_delivery_v1_[a-f0-9]{40}$/;
const TRUNCATION_REASON = /^[a-z_]{1,40}$/;
const MAX_DELIVERY_BATCHES = 128;
const MAX_TRUNCATION_REASON_CHARACTERS = 160;

/** Count Unicode code points, not UTF-16 code units. */
export function unicodeLength(value) {
	let length = 0;
	for (const _point of String(value ?? "")) length += 1;
	return length;
}

/** Return the serialized UTF-8 byte count used by the HTTP body limit. */
export function utf8Length(value) {
	return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function nonnegativeSafeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function boundedCaptureCounter(value) {
	return nonnegativeSafeInteger(value) && value <= MAX_CAPTURE_EVIDENCE_COUNTER;
}

/**
 * Validate the bounded, content-free capture evidence carried to receipts.
 * Every key is fixed by the schema; arbitrary strings, labels, paths, commands,
 * or raw transcript values cannot cross this metadata boundary.
 */
export function normalizeCaptureEvidence(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (Object.keys(value).length !== CAPTURE_EVIDENCE_KEYS.size) return null;
	if (Object.keys(value).some((key) => !CAPTURE_EVIDENCE_KEYS.has(key))) return null;
	if (value.schema !== INGEST_CAPTURE_EVIDENCE_SCHEMA) return null;
	for (const key of CAPTURE_EVIDENCE_KEYS) {
		if (key === "schema" || key === "redactions") continue;
		if (!boundedCaptureCounter(value[key])) return null;
	}
	if (value.returnedEvents > value.capturedEvents) return null;
	if (value.omittedEvents !== value.capturedEvents - value.returnedEvents) return null;
	if (value.malformedRows > value.inputRows) return null;
	// These counters are each incremented at most once per parsed input row, or
	// describe a subset of those rows. Block/line-level counters such as thinking,
	// tools, recall, and redactions may legitimately exceed the row count.
	for (const key of [
		"ineligibleRows",
		"ignoredMetaRows",
		"ignoredNoiseEvents",
		"ambiguousOutcomeRows",
		"companionLimitRejectedOutcomeRows",
		"closureEventLimitRejectedOutcomeRows",
		"tailReturnedRecords",
		"tailIneligibleLines",
	]) {
		if (value[key] > value.inputRows) return null;
	}
	if (!value.redactions || typeof value.redactions !== "object" || Array.isArray(value.redactions)) return null;
	if (Object.keys(value.redactions).some((key) => !CAPTURE_REDACTION_KEYS.has(key))) return null;
	const redactions = {};
	for (const [key, count] of Object.entries(value.redactions)) {
		if (!boundedCaptureCounter(count) || count < 1) return null;
		redactions[key] = count;
	}
	return {
		schema: INGEST_CAPTURE_EVIDENCE_SCHEMA,
		inputRows: value.inputRows,
		capturedEvents: value.capturedEvents,
		returnedEvents: value.returnedEvents,
		omittedEvents: value.omittedEvents,
		malformedRows: value.malformedRows,
		ineligibleRows: value.ineligibleRows,
		ignoredThinkingBlocks: value.ignoredThinkingBlocks,
		ignoredMetaRows: value.ignoredMetaRows,
		ignoredToolEvents: value.ignoredToolEvents,
		ignoredRecallEvents: value.ignoredRecallEvents,
		ignoredRecallEchoEvents: value.ignoredRecallEchoEvents,
		ignoredUnprotectedAssistantEvents: value.ignoredUnprotectedAssistantEvents,
		ignoredNoiseEvents: value.ignoredNoiseEvents,
		ambiguousOutcomeRows: value.ambiguousOutcomeRows,
		companionLimitRejectedOutcomeRows: value.companionLimitRejectedOutcomeRows,
		closureEventLimitRejectedOutcomeRows: value.closureEventLimitRejectedOutcomeRows,
		truncatedEvents: value.truncatedEvents,
		redactions,
		tailReturnedRecords: value.tailReturnedRecords,
		tailScannedBytes: value.tailScannedBytes,
		tailOversizedLines: value.tailOversizedLines,
		tailMalformedLines: value.tailMalformedLines,
		tailIneligibleLines: value.tailIneligibleLines,
		tailEmptyLines: value.tailEmptyLines,
	};
}

/**
 * Validate and copy ordered-delivery metadata. Unknown or malformed fields
 * fail closed; callers receive null and can return a semantic 422.
 */
export function normalizeDeliveryMetadata(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (Object.keys(value).some((key) => !DELIVERY_KEYS.has(key))) return null;
	if (value.schema !== INGEST_DELIVERY_SCHEMA) return null;
	if (typeof value.groupId !== "string" || !DELIVERY_GROUP_ID.test(value.groupId)) return null;
	if (!nonnegativeSafeInteger(value.batchIndex)) return null;
	if (!Number.isSafeInteger(value.batchCount) || value.batchCount < 1 || value.batchCount > MAX_DELIVERY_BATCHES) return null;
	if (value.batchIndex >= value.batchCount) return null;
	if (!Number.isSafeInteger(value.sourceMessageCount) || value.sourceMessageCount < 1) return null;
	if (!Number.isSafeInteger(value.segmentCount) || value.segmentCount < value.sourceMessageCount) return null;
	if (!nonnegativeSafeInteger(value.splitSourceMessages)) return null;
	if (value.splitSourceMessages > value.sourceMessageCount) return null;
	if (typeof value.captureTruncated !== "boolean") return null;

	if (value.truncationReason != null && typeof value.truncationReason !== "string") return null;
	const reason = value.truncationReason == null ? null : value.truncationReason.trim();
	if (value.captureTruncated) {
		if (!reason || unicodeLength(reason) > MAX_TRUNCATION_REASON_CHARACTERS || !TRUNCATION_REASON.test(reason)) return null;
	} else if (reason) {
		return null;
	}
	const captureEvidence = value.captureEvidence == null
		? null
		: normalizeCaptureEvidence(value.captureEvidence);
	if (value.captureEvidence != null && !captureEvidence) return null;

	return {
		schema: INGEST_DELIVERY_SCHEMA,
		groupId: value.groupId,
		batchIndex: value.batchIndex,
		batchCount: value.batchCount,
		sourceMessageCount: value.sourceMessageCount,
		segmentCount: value.segmentCount,
		splitSourceMessages: value.splitSourceMessages,
		captureTruncated: value.captureTruncated,
		truncationReason: reason,
		...(captureEvidence ? { captureEvidence } : {}),
	};
}

function violation(status, error, message, limit, actual, extra = {}) {
	return {
		status,
		error,
		code: error,
		message,
		limit,
		actual,
		retryable: false,
		limits: INGEST_LIMITS,
		...extra,
	};
}

function messageContent(message) {
	return typeof message === "string" ? message : message.content;
}

function invalidMessage(index, field, message, { limit = null, actual = null } = {}) {
	return violation(
		422,
		"invalid_ingest_message",
		message,
		limit,
		actual,
		{ unit: "message", field, messageIndex: index },
	);
}

export function isLegacyClaudeOutboxBody(body) {
	return Boolean(
		body
		&& typeof body === "object"
		&& !Array.isArray(body)
		&& body.source === "plugin"
		&& /^claude-outbox:v1:[a-f0-9]{64}$/.test(body.idempotencyKey ?? "")
		&& !Object.prototype.hasOwnProperty.call(body, "delivery"),
	);
}

/**
 * Validate only the shared ingest contract. General body-shape and parameter
 * validation remains at the HTTP door for backwards-compatible 400 errors.
 */
export function validateIngestBody(body, { requestBytes } = {}) {
	const legacyClaudeOutbox = isLegacyClaudeOutboxBody(body);
	const contentLimits = legacyClaudeOutbox
		? LEGACY_CLAUDE_OUTBOX_LIMITS
		: INGEST_LIMITS;
	if (Number.isFinite(requestBytes) && requestBytes > contentLimits.maxRequestBytes) {
		return violation(
			413,
			"ingest_request_too_large",
			`The serialized ingest request exceeds ${contentLimits.maxRequestBytes} UTF-8 bytes.`,
			contentLimits.maxRequestBytes,
			requestBytes,
			{
				unit: "bytes",
				field: "request",
				...(legacyClaudeOutbox ? { legacyLimits: LEGACY_CLAUDE_OUTBOX_LIMITS } : {}),
			},
		);
	}

	// BF-1: the batch-level default write time, applied to any message that does
	// not carry its own.
	if (body && Object.prototype.hasOwnProperty.call(body, "sourceTime")) {
		const parsed = parseSourceTime(body.sourceTime);
		if (!parsed.ok) {
			return violation(422, parsed.code, parsed.message, null, null, {
				unit: "timestamp",
				field: "sourceTime",
			});
		}
	}

	const messages = body?.messages;
	if (Array.isArray(messages)) {
		if (messages.length > contentLimits.maxMessages) {
			return violation(
				422,
				"ingest_message_count_exceeded",
				`An ingest request may contain at most ${contentLimits.maxMessages} messages.`,
				contentLimits.maxMessages,
				messages.length,
				{ unit: "messages", field: "messages" },
			);
		}

		const messageIds = new Set();
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (typeof message === "string") continue; // legacy shorthand: a user message
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				return invalidMessage(
					index,
					`messages[${index}]`,
					`messages[${index}] must be a string or a message object.`,
				);
			}
			if (typeof message.content !== "string") {
				return invalidMessage(
					index,
					`messages[${index}].content`,
					`messages[${index}].content must be a string.`,
				);
			}
			if (Object.prototype.hasOwnProperty.call(message, "role") && (
				typeof message.role !== "string"
				|| !INGEST_MESSAGE_ROLES.has(message.role.toLowerCase())
			)) {
				return invalidMessage(
					index,
					`messages[${index}].role`,
					`messages[${index}].role must be user, assistant, system, or tool.`,
				);
			}
			// BF-1: a per-message authoritative write time. Structural validation
			// happens here, at the door, so a malformed timestamp is a named 422
			// rather than a value that quietly becomes "now" three layers down.
			if (Object.prototype.hasOwnProperty.call(message, "sourceTime")) {
				const parsed = parseSourceTime(message.sourceTime);
				if (!parsed.ok) {
					return invalidMessage(
						index,
						`messages[${index}].sourceTime`,
						parsed.message.replace("sourceTime", `messages[${index}].sourceTime`),
					);
				}
			}
			if (Object.prototype.hasOwnProperty.call(message, "id")) {
				const idCharacters = typeof message.id === "string" ? unicodeLength(message.id) : null;
				if (typeof message.id !== "string" || !message.id.trim() || idCharacters > INGEST_MESSAGE_ID_MAX_CHARACTERS) {
					return invalidMessage(
						index,
						`messages[${index}].id`,
						`messages[${index}].id must be a non-empty string of at most ${INGEST_MESSAGE_ID_MAX_CHARACTERS} Unicode characters.`,
						{ limit: INGEST_MESSAGE_ID_MAX_CHARACTERS, actual: idCharacters },
					);
				}
				if (messageIds.has(message.id)) {
					return invalidMessage(
						index,
						`messages[${index}].id`,
						`messages[${index}].id duplicates an earlier message id.`,
						{ actual: "duplicate" },
					);
				}
				messageIds.add(message.id);
			}
		}

		const characterCounts = messages.map((message) => unicodeLength(messageContent(message)));
		const totalCharacters = characterCounts.reduce((total, characters) => total + characters, 0);
		if (totalCharacters > contentLimits.maxTotalCharacters) {
			return violation(
				422,
				"ingest_total_characters_exceeded",
				`The combined message content exceeds ${contentLimits.maxTotalCharacters} Unicode characters.`,
				contentLimits.maxTotalCharacters,
				totalCharacters,
				{ unit: "unicode_code_points", field: "messages" },
			);
		}

		for (let index = 0; index < characterCounts.length; index += 1) {
			const characters = characterCounts[index];
			if (characters > contentLimits.maxMessageCharacters) {
				return violation(
					422,
					"ingest_message_characters_exceeded",
					`messages[${index}].content exceeds ${contentLimits.maxMessageCharacters} Unicode characters.`,
					contentLimits.maxMessageCharacters,
					characters,
					{ unit: "unicode_code_points", field: `messages[${index}].content`, messageIndex: index },
				);
			}
		}
	}

	if (body && Object.prototype.hasOwnProperty.call(body, "delivery")) {
		const delivery = normalizeDeliveryMetadata(body.delivery);
		if (!delivery) {
			return violation(
				422,
				"invalid_ingest_delivery_metadata",
				"delivery must contain valid ordered-batch metadata for the current ingest delivery schema.",
				MAX_DELIVERY_BATCHES,
				null,
				{ unit: "batches", field: "delivery" },
			);
		}
	}

	return null;
}
