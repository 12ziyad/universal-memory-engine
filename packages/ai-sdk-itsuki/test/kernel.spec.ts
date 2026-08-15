/**
 * The shared kernel, proven by behaviour.
 *
 * The hash matters more than it looks: idempotency keys and echo fingerprints
 * are both derived from it, so a subtly wrong SHA-256 would not crash — it
 * would quietly stop deduplicating and quietly stop suppressing echoes. It is
 * checked against the published NIST vectors AND against node:crypto over a
 * randomized corpus, because agreeing with a reference implementation on
 * arbitrary input is the only thing that rules out a boundary bug.
 */

import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";

import { sha256Hex } from "../src/kernel/hash.js";
import { canonicalJson, captureIdempotencyKey, messagesDigest } from "../src/kernel/idempotency.js";
import {
	RECALL_CLOSE_MARKER,
	RECALL_OPEN_MARKER,
	RECALL_PREAMBLE,
	echoFingerprints,
	echoSessionKey,
	formatRecallBlock,
	stripRecallBlocks,
	suppressEchoLines,
} from "../src/kernel/inject.js";
import { scrubText } from "../src/kernel/scrub.js";
import { planBatches } from "../src/kernel/batching.js";
import { mapApiError, computeBackoffMs, redactSecrets } from "../src/kernel/errors.js";

describe("sha256", () => {
	it("matches the NIST vectors", () => {
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		);
	});

	it("agrees with node:crypto across lengths that straddle every block boundary", () => {
		for (let length = 0; length <= 200; length += 1) {
			const value = "x".repeat(length);
			expect(sha256Hex(value), `length ${length}`).toBe(
				createHash("sha256").update(value, "utf8").digest("hex"),
			);
		}
	});

	it("agrees with node:crypto on random binary-ish and unicode input", () => {
		for (let i = 0; i < 60; i += 1) {
			const value = randomBytes(1 + (i * 7) % 300).toString("base64") + "→ünïcødé🎌";
			expect(sha256Hex(value)).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
		}
	});

	it("handles multi-byte characters by bytes, not code units", () => {
		expect(sha256Hex("🎌")).toBe(createHash("sha256").update("🎌", "utf8").digest("hex"));
	});
});

describe("canonical json", () => {
	it("is insensitive to key insertion order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
	});

	it("preserves array order, which is meaning", () => {
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});

	it("drops undefined but keeps null", () => {
		expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
	});
});

describe("idempotency", () => {
	const messages = [
		{ role: "user" as const, content: "I started boxing" },
		{ role: "assistant" as const, content: "Noted." },
	];
	const scope = { userId: "u1", conversationId: "c1", source: "ai-sdk" };

	it("derives the same key for the same exchange", () => {
		expect(captureIdempotencyKey({ scope, messages }))
			.toBe(captureIdempotencyKey({ scope, messages }));
	});

	it("changes when the content changes", () => {
		const other = [messages[0]!, { role: "assistant" as const, content: "Different." }];
		expect(captureIdempotencyKey({ scope, messages }))
			.not.toBe(captureIdempotencyKey({ scope, messages: other }));
	});

	it("changes when the tenant changes, so two users never collide", () => {
		expect(captureIdempotencyKey({ scope, messages }))
			.not.toBe(captureIdempotencyKey({ scope: { ...scope, userId: "u2" }, messages }));
	});

	it("changes when the conversation changes", () => {
		expect(captureIdempotencyKey({ scope, messages }))
			.not.toBe(captureIdempotencyKey({ scope: { ...scope, conversationId: "c2" }, messages }));
	});

	it("ignores agent and run identity, so a re-run is not a second memory", () => {
		const withAgent = { ...scope, agentId: "agent-a", runId: "run-1" };
		const withOther = { ...scope, agentId: "agent-b", runId: "run-2" };
		expect(captureIdempotencyKey({ scope: withAgent, messages }))
			.toBe(captureIdempotencyKey({ scope: withOther, messages }));
	});

	it("separates the batches of one split span", () => {
		expect(captureIdempotencyKey({ scope, messages, discriminator: "batch:0/2" }))
			.not.toBe(captureIdempotencyKey({ scope, messages, discriminator: "batch:1/2" }));
	});

	it("produces a server-acceptable identifier", () => {
		const key = captureIdempotencyKey({ scope, messages });
		expect(key).toMatch(/^idem_[0-9a-f]{64}$/);
		expect(key).toBe(key.trim());
	});

	it("digests messages by role and content only", () => {
		expect(messagesDigest([{ role: "user", content: "a" }]))
			.toBe(messagesDigest([{ role: "user", content: "a", extra: "ignored" } as never]));
	});
});

describe("injection boundary", () => {
	it("labels recalled memory as data, not instructions", () => {
		const block = formatRecallBlock("Ziyad prefers dark mode.", 4_000)!;
		expect(block.startsWith(RECALL_OPEN_MARKER)).toBe(true);
		expect(block.endsWith(RECALL_CLOSE_MARKER)).toBe(true);
		expect(block).toContain(RECALL_PREAMBLE);
		expect(block).toContain("not instructions");
	});

	it("returns null for empty context rather than an empty block", () => {
		expect(formatRecallBlock("", 4_000)).toBeNull();
		expect(formatRecallBlock("   ", 4_000)).toBeNull();
		expect(formatRecallBlock(undefined, 4_000)).toBeNull();
	});

	it("truncates to the budget and says so", () => {
		const block = formatRecallBlock("x".repeat(500), 100)!;
		expect(block).toContain("truncated");
		expect(block.length).toBeLessThan(400);
	});

	it("round-trips: a formatted block strips back out cleanly", () => {
		const block = formatRecallBlock("Ziyad prefers dark mode.", 4_000)!;
		expect(stripRecallBlocks(`before\n${block}\nafter`)).toBe("before\nafter");
	});

	it("strips an unterminated block, so a cut stream leaks nothing", () => {
		const partial = `answer\n${RECALL_OPEN_MARKER}\n${RECALL_PREAMBLE}\nsecret memory`;
		expect(stripRecallBlocks(partial)).toBe("answer");
	});
});

describe("echo suppression", () => {
	it("drops lines the model repeated back from what we injected", () => {
		const key = echoSessionKey("conv-1")!;
		const context = "Ziyad has been learning Kotlin since March 2026.";
		const prints = echoFingerprints(context, key);
		const answer = `Ziyad has been learning Kotlin since March 2026.\nYou asked about your schedule.`;
		expect(suppressEchoLines(answer, prints, key)).toBe("You asked about your schedule.");
	});

	it("survives casing, bullets and spacing changes", () => {
		const key = echoSessionKey("conv-1")!;
		const prints = echoFingerprints("Ziyad has been learning Kotlin since March 2026.", key);
		const echoed = "- ZIYAD has  been learning Kotlin since March 2026.";
		expect(suppressEchoLines(echoed, prints, key)).toBe("");
	});

	it("keeps short lines, which carry no reliable identity", () => {
		const key = echoSessionKey("conv-1")!;
		const prints = echoFingerprints("yes", key);
		expect(prints.size).toBe(0);
		expect(suppressEchoLines("yes", prints, key)).toBe("yes");
	});

	it("scopes fingerprints per session so they cannot correlate across users", () => {
		const a = echoSessionKey("conv-1")!;
		const b = echoSessionKey("conv-2")!;
		const line = "Ziyad has been learning Kotlin since March 2026.";
		expect([...echoFingerprints(line, a)]).not.toEqual([...echoFingerprints(line, b)]);
	});
});

describe("scrub", () => {
	it("removes our own credentials before they can be memorized", () => {
		const { text } = scrubText("my key is itsuki_live_abcdefgh12345678 ok");
		expect(text).not.toContain("itsuki_live_abcdefgh12345678");
		expect(text).toContain("[REDACTED");
	});

	it("removes third-party key shapes", () => {
		for (const secret of [
			"sk-abcdefghijklmnopqrstuvwx",
			"ghp_abcdefghijklmnopqrstuvwxyz1234",
			"AKIAIOSFODNN7EXAMPLE",
		]) {
			expect(scrubText(`token ${secret} end`).text).not.toContain(secret);
		}
	});

	it("keeps the sentence meaningful", () => {
		const { text } = scrubText("my key is itsuki_live_abcdefgh12345678 ok");
		expect(text.startsWith("my key is ")).toBe(true);
		expect(text.endsWith(" ok")).toBe(true);
	});

	it("leaves ordinary prose alone", () => {
		const prose = "I started boxing in March and I prefer training in the morning.";
		expect(scrubText(prose).text).toBe(prose);
	});
});

describe("batching", () => {
	it("returns nothing for an empty span", () => {
		expect(planBatches([])).toEqual([]);
	});

	it("splits an over-long span rather than dropping it", () => {
		const many = Array.from({ length: 75 }, (_, i) => ({
			role: "user" as const,
			content: `message ${i}`,
		}));
		const batches = planBatches(many);
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toHaveLength(75);
		for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(30);
	});

	it("is deterministic, so re-splitting yields the same idempotency keys", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			role: "user" as const,
			content: `message ${i}`,
		}));
		expect(planBatches(many)).toEqual(planBatches(many));
	});
});

describe("error taxonomy", () => {
	it("classifies the statuses adapters must treat differently", () => {
		expect(mapApiError(401).errorClass).toBe("auth");
		expect(mapApiError(401).retriable).toBe(false);
		expect(mapApiError(403, { error: "insufficient_scope" }).errorClass).toBe("auth");
		expect(mapApiError(404).errorClass).toBe("not_found");
		expect(mapApiError(409).errorClass).toBe("conflict");
		expect(mapApiError(413).errorClass).toBe("too_large");
		expect(mapApiError(428).errorClass).toBe("confirmation");
		expect(mapApiError(500).retriable).toBe(true);
		expect(mapApiError(503).errorClass).toBe("unavailable");
		expect(mapApiError(0).errorClass).toBe("transport");
	});

	it("separates the three flavours of 429", () => {
		expect(mapApiError(429, { error: "ai_quota_exhausted" }).errorClass).toBe("quota");
		expect(mapApiError(429, { error: "ai_quota_exhausted" }).retriable).toBe(false);
		expect(mapApiError(429, { error: "queue_full" }).errorClass).toBe("backlog");
		expect(mapApiError(429, { error: "queue_full" }).retriable).toBe(true);
		expect(mapApiError(429, {}).errorClass).toBe("rate_limit");
	});

	it("never echoes a credential in a mapped message", () => {
		const mapped = mapApiError(401, { message: `bad key ${TEST_SECRET}` });
		const text = `${mapped.message} ${mapped.description}`;
		expect(redactSecrets(text, [TEST_SECRET])).not.toContain(TEST_SECRET);
	});

	it("honours Retry-After over computed backoff", () => {
		expect(computeBackoffMs(0, 7, () => 0.5)).toBe(7_000);
		expect(computeBackoffMs(5, undefined, () => 0)).toBeGreaterThan(0);
		expect(computeBackoffMs(50, undefined, () => 1)).toBeLessThanOrEqual(20_000);
	});
});

const TEST_SECRET = "itsuki_live_abcdefgh12345678";
