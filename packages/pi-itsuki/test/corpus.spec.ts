/**
 * Every vector in the shared corpus, run against this adapter.
 *
 * The corpus lives at the repository root because it is the contract three
 * different adapters in two different languages have to satisfy. If this file
 * goes red, either the adapter drifted or the contract changed deliberately —
 * and the second case is supposed to be loud.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { planBatches } from "../src/batching.js";
import { computeBackoffMs, mapApiError } from "../src/errors.js";
import { captureIdentity, type CaptureMessage } from "../src/identity.js";
import { formatRecallBlock, stripRecallBlocks } from "../src/inject.js";
import { validateBaseUrl } from "../src/transport.js";

const corpusPath = fileURLToPath(new URL("../../../test/fixtures/agent_lifecycle_corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

const HOST = "pi";

describe("corpus: identity", () => {
	it("reproduces every pinned digest exactly", () => {
		for (const vector of corpus.identity.vectors) {
			const expected = vector.expect[HOST];
			if (!expected) continue;
			const actual = captureIdentity(
				{
					userId: vector.scope.userId ?? undefined,
					conversationId: vector.scope.conversationId ?? undefined,
					source: vector.scope.source,
				},
				vector.messages as CaptureMessage[],
			);
			expect(actual, vector.id).toBe(expected);
		}
	});

	it("is stable across repeated computation", () => {
		const vector = corpus.identity.vectors[0];
		const scope = { userId: undefined, conversationId: vector.scope.conversationId, source: vector.scope.source };
		expect(captureIdentity(scope, vector.messages)).toBe(captureIdentity(scope, vector.messages));
	});

	it("changes when anything material changes", () => {
		const base: CaptureMessage[] = [{ role: "user", content: "a" }];
		const scope = { userId: undefined, conversationId: "s", source: "pi" };
		const key = captureIdentity(scope, base);
		expect(captureIdentity(scope, [{ role: "assistant", content: "a" }])).not.toBe(key);
		expect(captureIdentity(scope, [{ role: "user", content: "b" }])).not.toBe(key);
		expect(captureIdentity({ ...scope, userId: "u" }, base)).not.toBe(key);
		expect(captureIdentity({ ...scope, conversationId: "t" }, base)).not.toBe(key);
		expect(captureIdentity({ ...scope, source: "openclaw" }, base)).not.toBe(key);
		// Order matters: two messages swapped is a different conversation.
		const pair: CaptureMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
		const swapped: CaptureMessage[] = [{ role: "assistant", content: "b" }, { role: "user", content: "a" }];
		expect(captureIdentity(scope, pair)).not.toBe(captureIdentity(scope, swapped));
	});

	it("never embeds the raw message text in the key", () => {
		const key = captureIdentity(
			{ userId: undefined, conversationId: "s", source: "pi" },
			[{ role: "user", content: "the launch code is hunter2" }],
		);
		expect(key).not.toContain("hunter2");
		expect(key).toMatch(/^pi:v1:[a-f0-9]{64}$/);
	});
});

describe("corpus: injection", () => {
	it("formats every vector exactly as pinned", () => {
		for (const vector of corpus.injection.vectors) {
			if (!(vector.hosts ?? []).includes(HOST)) continue;
			expect(formatRecallBlock(vector.context, vector.maxChars), vector.id).toBe(vector.expect);
		}
	});

	it("keeps a hostile stored instruction inside the labelled boundary", () => {
		const hostile = corpus.injection.injectedDirectiveMustNotEscape;
		const block = formatRecallBlock(hostile.context, 4_000);
		expect(block).not.toBeNull();
		for (const needle of hostile.mustContain) expect(block).toContain(needle);
		// The directive is present as DATA — we do not silently delete it, we
		// label it. Deleting would be dishonest about what is stored.
		expect(block).toContain("SYSTEM OVERRIDE");
	});
});

describe("corpus: echo suppression", () => {
	it("strips marker blocks exactly as pinned", () => {
		for (const vector of corpus.echoSuppression.vectors) {
			if (!(vector.hosts ?? []).includes(HOST)) continue;
			expect(stripRecallBlocks(vector.input), vector.id).toBe(vector.expectStripped);
		}
	});
});

describe("corpus: error taxonomy", () => {
	it("classifies every vector as pinned", () => {
		for (const vector of corpus.errorTaxonomy.vectors) {
			const headers = vector.headers ? new Headers(vector.headers as Record<string, string>) : undefined;
			const mapped = mapApiError(vector.status, vector.body, headers);
			expect(mapped.errorClass, vector.id).toBe(vector.expect.errorClass);
			expect(mapped.retriable, vector.id).toBe(vector.expect.retriable);
			if (vector.expect.retryAfterSeconds !== undefined) {
				expect(mapped.retryAfterSeconds, vector.id).toBe(vector.expect.retryAfterSeconds);
			}
		}
	});

	it("never blames the user for an account-wide pause", () => {
		const mapped = mapApiError(429, { error: "ai_capacity_paused" });
		expect(mapped.description).not.toMatch(/your account is/i);
		expect(mapped.description).toMatch(/nothing you sent was lost/i);
	});

	it("gives every branch a message and a description, never a bare code", () => {
		for (const status of [401, 403, 404, 409, 413, 422, 428, 429, 503, 500, 0]) {
			const mapped = mapApiError(status, {});
			expect(mapped.message.length, String(status)).toBeGreaterThan(3);
			expect(mapped.description.length, String(status)).toBeGreaterThan(3);
		}
	});
});

describe("corpus: backoff", () => {
	it("honours and caps Retry-After, and bounds exponential growth", () => {
		for (const vector of corpus.backoff.vectors) {
			const actual = computeBackoffMs(vector.attempt, vector.retryAfterSeconds, () => 0.5);
			if (vector.expectMs !== undefined) expect(actual, vector.id).toBe(vector.expectMs);
			if (vector.expectMaxMs !== undefined) expect(actual, vector.id).toBeLessThanOrEqual(vector.expectMaxMs);
			if (vector.expectRangeMs) {
				expect(actual, vector.id).toBeGreaterThanOrEqual(vector.expectRangeMs[0]);
				expect(actual, vector.id).toBeLessThanOrEqual(vector.expectRangeMs[1]);
			}
		}
	});

	it("jitters, so a fleet of agents does not retry in lockstep", () => {
		const low = computeBackoffMs(3, undefined, () => 0);
		const high = computeBackoffMs(3, undefined, () => 0.999);
		expect(high).toBeGreaterThan(low);
	});
});

describe("corpus: batching", () => {
	it("splits and clamps exactly as pinned", () => {
		for (const vector of corpus.batching.vectors) {
			const messages: CaptureMessage[] = Array.from({ length: vector.messageCount }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: "x".repeat(vector.eachChars),
			}));
			const batches = planBatches(messages);
			expect(batches.length, vector.id).toBe(vector.expectBatches);
			for (const batch of batches) {
				expect(batch.length, `${vector.id} messages per batch`).toBeLessThanOrEqual(corpus.batching.limits.maxMessages);
				for (const message of batch) {
					expect(
						Array.from(message.content).length,
						`${vector.id} per-message limit`,
					).toBeLessThanOrEqual(corpus.batching.limits.maxMessageCharacters);
				}
			}
			if (vector.expectClamped) {
				expect(batches[0]![0]!.content).toMatch(/truncated/);
			}
		}
	});

	it("loses no message when it splits", () => {
		const messages: CaptureMessage[] = Array.from({ length: 71 }, (_, i) => ({
			role: "user",
			content: `m${i}`,
		}));
		const flattened = planBatches(messages).flat();
		expect(flattened.length).toBe(71);
		expect(flattened.map((m) => m.content)).toEqual(messages.map((m) => m.content));
	});

	it("produces identical batches for identical input, so splitting stays exactly-once", () => {
		const messages: CaptureMessage[] = Array.from({ length: 45 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const scope = { userId: undefined, conversationId: "s", source: "pi" };
		const first = planBatches(messages).map((b) => captureIdentity(scope, b));
		const second = planBatches(messages).map((b) => captureIdentity(scope, b));
		expect(first).toEqual(second);
	});
});

describe("corpus: base URL safety", () => {
	it("accepts every valid form, normalized", () => {
		for (const entry of corpus.baseUrl.valid) {
			expect(validateBaseUrl(entry.input), entry.input).toBe(entry.expect);
		}
	});

	it("refuses every unsafe form, naming the reason", () => {
		for (const entry of corpus.baseUrl.invalid) {
			expect(() => validateBaseUrl(entry.input), entry.input).toThrow(new RegExp(entry.reason, "i"));
		}
	});
});
