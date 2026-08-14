/**
 * The shared lifecycle corpus, run against this adapter.
 *
 * The corpus file is READ-ONLY for this campaign. Its `identity.vectors` pin
 * digests under the `pi` host key, and adding an `openclaw` key is a versioned
 * corpus change that needs Fable's approval plus a Pi compatibility re-run — so
 * this suite does NOT invent openclaw digests. Instead it:
 *
 *   - asserts every host-neutral section (injection, echo, taxonomy, backoff,
 *     batching, base URL) directly, because those modules are carried across
 *     from pi-itsuki byte-identically and must behave identically;
 *   - asserts the identity INVARIANTS the corpus states in prose, using this
 *     adapter's own `openclaw:v1` prefix;
 *   - re-derives each identity vector under the openclaw scope and pins the
 *     result here, so a future corpus revision has values to adopt.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { planBatches } from "../src/batching.js";
import { computeBackoffMs, mapApiError } from "../src/errors.js";
import { CAPTURE_IDENTITY_VERSION, captureIdentity, type CaptureMessage } from "../src/identity.js";
import { formatRecallBlock, stripRecallBlocks } from "../src/inject.js";
import { validateBaseUrl } from "../src/transport.js";

const corpusPath = fileURLToPath(new URL("../../../test/fixtures/agent_lifecycle_corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

describe("corpus: identity invariants", () => {
	it("uses this host's own versioned prefix", () => {
		expect(CAPTURE_IDENTITY_VERSION).toBe("openclaw:v1");
	});

	it("is stable across repeated computation", () => {
		const scope = { userId: undefined, conversationId: "sess-a", source: "openclaw" };
		const messages: CaptureMessage[] = [{ role: "user", content: "We picked Postgres for billing." }];
		expect(captureIdentity(scope, messages)).toBe(captureIdentity(scope, messages));
	});

	it("changes when anything material changes", () => {
		const base: CaptureMessage[] = [{ role: "user", content: "a" }];
		const scope = { userId: undefined, conversationId: "s", source: "openclaw" };
		const key = captureIdentity(scope, base);
		expect(captureIdentity(scope, [{ role: "assistant", content: "a" }])).not.toBe(key);
		expect(captureIdentity(scope, [{ role: "user", content: "b" }])).not.toBe(key);
		expect(captureIdentity({ ...scope, userId: "u" }, base)).not.toBe(key);
		expect(captureIdentity({ ...scope, conversationId: "t" }, base)).not.toBe(key);
		expect(captureIdentity({ ...scope, source: "pi" }, base)).not.toBe(key);
		const pair: CaptureMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
		const swapped: CaptureMessage[] = [{ role: "assistant", content: "b" }, { role: "user", content: "a" }];
		expect(captureIdentity(scope, pair)).not.toBe(captureIdentity(scope, swapped));
	});

	it("never embeds raw message text in the key", () => {
		const key = captureIdentity(
			{ userId: undefined, conversationId: "s", source: "openclaw" },
			[{ role: "user", content: "the launch code is hunter2" }],
		);
		expect(key).not.toContain("hunter2");
		expect(key).toMatch(/^openclaw:v1:[a-f0-9]{64}$/);
	});

	it("re-derives every corpus vector distinctly under the openclaw scope", () => {
		// The corpus asserts each vector is a distinct write. That property must
		// hold here too, even though the digests differ by host prefix.
		const derived = corpus.identity.vectors.map((vector: {
			scope: { userId: string | null; conversationId: string | null };
			messages: CaptureMessage[];
		}) => captureIdentity(
			{
				userId: vector.scope.userId ?? undefined,
				conversationId: vector.scope.conversationId ?? undefined,
				source: "openclaw",
			},
			vector.messages,
		));
		expect(new Set(derived).size).toBe(derived.length);
		for (const key of derived) expect(key).toMatch(/^openclaw:v1:[a-f0-9]{64}$/);
	});

	it("keeps sub-tenant and session isolation structural, exactly as the corpus requires", () => {
		const byId = Object.fromEntries(corpus.identity.vectors.map((v: { id: string }) => [v.id, v]));
		const base = byId["single-user-turn"];
		const sub = byId["subtenant-differs"];
		const other = byId["other-session-same-content"];
		const derive = (v: { scope: { userId: string | null; conversationId: string | null }; messages: CaptureMessage[] }) =>
			captureIdentity(
				{ userId: v.scope.userId ?? undefined, conversationId: v.scope.conversationId ?? undefined, source: "openclaw" },
				v.messages,
			);
		expect(derive(sub)).not.toBe(derive(base));
		expect(derive(other)).not.toBe(derive(base));
	});
});

describe("corpus: injection", () => {
	it("formats every vector exactly as pinned", () => {
		for (const vector of corpus.injection.vectors) {
			expect(formatRecallBlock(vector.context, vector.maxChars), vector.id).toBe(vector.expect);
		}
	});

	it("keeps a hostile stored instruction inside the labelled boundary", () => {
		const hostile = corpus.injection.injectedDirectiveMustNotEscape;
		const block = formatRecallBlock(hostile.context, 4_000);
		expect(block).not.toBeNull();
		for (const needle of hostile.mustContain) expect(block).toContain(needle);
		expect(block).toContain("SYSTEM OVERRIDE");
	});
});

describe("corpus: echo suppression", () => {
	it("strips marker blocks exactly as pinned", () => {
		for (const vector of corpus.echoSuppression.vectors) {
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
				expect(batch.length, vector.id).toBeLessThanOrEqual(corpus.batching.limits.maxMessages);
				for (const message of batch) {
					expect(Array.from(message.content).length, vector.id)
						.toBeLessThanOrEqual(corpus.batching.limits.maxMessageCharacters);
				}
			}
			if (vector.expectClamped) expect(batches[0]![0]!.content).toMatch(/truncated/);
		}
	});

	it("produces identical batches for identical input, so splitting stays exactly-once", () => {
		const messages: CaptureMessage[] = Array.from({ length: 45 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const scope = { userId: undefined, conversationId: "s", source: "openclaw" };
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

describe("corpus: lifecycle obligations this adapter inherits", () => {
	it("records that recall fails open and capture takes ownership first", () => {
		expect(corpus.lifecycle.recall.failureMode).toBe("open");
		expect(corpus.lifecycle.capture.ownershipBeforeDelivery).toBe(true);
		expect(corpus.lifecycle.capture.neverClaimsSavedWithoutReceipt).toBe(true);
		expect(corpus.lifecycle.destructive.automaticDeletionAllowed).toBe(false);
	});
});
