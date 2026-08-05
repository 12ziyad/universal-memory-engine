import { describe, expect, it } from "vitest";
import { buildReceipt, emptyReceipt, normalizeContextTrace } from "../src/pipeline/receipt.js";

const HASH_A = "A".repeat(64);
const HASH_B = "b".repeat(64);

function validTrace(overrides = {}) {
	return {
		schema: "itsuki.extract-context-trace/v1",
		mode: "accepted_snapshot",
		context_hash: HASH_A,
		snapshot_hash: HASH_B,
		messages: 4,
		user_messages: 2,
		assistant_messages: 2,
		serialized_bytes: 1_024,
		omitted_messages: 3,
		truncated_messages: 1,
		captured_at: 1_725_000_000_000,
		...overrides,
	};
}

const TRACE_KEYS = [
	"assistant_messages",
	"captured_at",
	"context_hash",
	"messages",
	"mode",
	"omitted_messages",
	"schema",
	"serialized_bytes",
	"snapshot_hash",
	"truncated_messages",
	"user_messages",
];

describe("content-free extraction context receipt tracing", () => {
	it("normalizes hashes and strips every field outside the trace allowlist", () => {
		const input = validTrace({
			content: "RAW_TRACE_SENTINEL_MUST_NOT_APPEAR",
			conversation_id: "private-conversation",
			message_ids: ["private-message"],
			extra: { prompt: "private prompt" },
		});

		const trace = normalizeContextTrace(input);
		expect(trace).toBeTruthy();
		expect(Object.keys(trace).sort()).toEqual(TRACE_KEYS);
		expect(trace.context_hash).toBe(HASH_A.toLowerCase());
		expect(trace.snapshot_hash).toBe(HASH_B);
		expect(JSON.stringify(trace)).not.toContain("RAW_TRACE_SENTINEL");
		expect(JSON.stringify(trace)).not.toContain("private-");
		// Normalization returns a detached record and never edits queue metadata.
		expect(input.context_hash).toBe(HASH_A);
	});

	it("accepts either metadata spelling and emits one canonical receipt field", () => {
		const built = buildReceipt("wrote", {}, { contextTrace: validTrace() });
		expect(built.context_trace).toEqual(normalizeContextTrace(validTrace()));
		expect(built.contextTrace).toBeUndefined();

		const empty = emptyReceipt("ignored", "nothing durable", {
			context_trace: validTrace({ captured_at: "2024-08-29T08:00:00.000Z" }),
		});
		expect(empty.context_trace.captured_at).toBe(Date.parse("2024-08-29T08:00:00.000Z"));
		expect(empty.contextTrace).toBeUndefined();
	});

	it("keeps empty compatibility traces content-free even when no context hash exists", () => {
		for (const mode of ["legacy_empty", "invalid_empty"]) {
			const trace = normalizeContextTrace(validTrace({
				mode,
				context_hash: undefined,
				snapshot_hash: undefined,
				messages: 0,
				user_messages: 0,
				assistant_messages: 0,
				serialized_bytes: 0,
				omitted_messages: 0,
				truncated_messages: 0,
			}));
			expect(trace).toMatchObject({ mode, messages: 0 });
			expect(trace.context_hash).toBeUndefined();
			expect(trace.snapshot_hash).toBeUndefined();
		}
	});

	it("omits malformed or misleading trace records as a unit", () => {
		const invalid = [
			null,
			[],
			validTrace({ schema: "itsuki.extract-context-trace/v2" }),
			validTrace({ mode: "raw_messages" }),
			validTrace({ context_hash: "not-a-hash" }),
			validTrace({ snapshot_hash: null }),
			validTrace({ messages: 11, user_messages: 5, assistant_messages: 6 }),
			validTrace({ messages: 4, user_messages: 3, assistant_messages: 2 }),
			validTrace({ serialized_bytes: 16_385 }),
			validTrace({ omitted_messages: -1 }),
			validTrace({ truncated_messages: 1.5 }),
			validTrace({ captured_at: "source packet at noon" }),
		];

		for (const value of invalid) {
			expect(normalizeContextTrace(value)).toBeNull();
			expect(buildReceipt("wrote", {}, { context_trace: value })).not.toHaveProperty("context_trace");
			expect(emptyReceipt("failed", "test", { contextTrace: value })).not.toHaveProperty("context_trace");
		}
	});

	it("accepts the exact snapshot limits without widening them", () => {
		const trace = normalizeContextTrace(validTrace({
			messages: 10,
			user_messages: 5,
			assistant_messages: 5,
			serialized_bytes: 16 * 1024,
			omitted_messages: 1_000_000,
			truncated_messages: 10,
			captured_at: 8_640_000_000_000_000,
		}));
		expect(trace).toMatchObject({
			messages: 10,
			serialized_bytes: 16 * 1024,
			omitted_messages: 1_000_000,
			captured_at: 8_640_000_000_000_000,
		});
	});
});
