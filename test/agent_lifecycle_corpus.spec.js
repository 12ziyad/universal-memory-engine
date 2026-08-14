/**
 * The agent lifecycle corpus is a contract, so it gets a contract test.
 *
 * Every native agent adapter (Pi today, OpenClaw and Hermes next) is written in
 * a different language against a different host API, and none of them share
 * runtime code — a published extension has to stand alone. This file is what
 * keeps them honest with each other. It checks the corpus is well-formed and,
 * more usefully, pins it to the authorities it claims to mirror: the server's
 * own ingest limits and the error classes the adapters must all disposition.
 *
 * Each adapter's own suite asserts its implementation against the same file.
 */

import { describe, expect, it } from "vitest";
import raw from "./fixtures/agent_lifecycle_corpus.json?raw";
import { INGEST_LIMITS } from "../src/lib/ingest_contract.mjs";

const corpus = JSON.parse(raw);

describe("agent lifecycle corpus shape", () => {
	it("declares its schema and the rules for changing it", () => {
		expect(corpus.schema).toBe("itsuki.agent-lifecycle-corpus/v1");
		expect(Array.isArray(corpus.rules)).toBe(true);
		expect(corpus.rules.length).toBeGreaterThan(0);
	});

	it("carries every section an adapter has to satisfy", () => {
		for (const section of [
			"identity",
			"injection",
			"echoSuppression",
			"errorTaxonomy",
			"backoff",
			"batching",
			"baseUrl",
			"lifecycle",
		]) {
			expect(corpus[section], section).toBeTruthy();
		}
	});
});

describe("identity vectors", () => {
	it("pins a digest per vector, per host, in the versioned form", () => {
		expect(corpus.identity.vectors.length).toBeGreaterThanOrEqual(4);
		for (const vector of corpus.identity.vectors) {
			expect(vector.id, "vector needs an id").toBeTruthy();
			expect(Object.keys(vector.expect).length, `${vector.id} needs at least one host`).toBeGreaterThan(0);
			for (const [host, key] of Object.entries(vector.expect)) {
				expect(key, `${vector.id}/${host}`).toMatch(/^[a-z0-9-]+:v1:[a-f0-9]{64}$/);
			}
		}
	});

	it("gives every vector a distinct digest, so scope really separates writes", () => {
		const keys = corpus.identity.vectors.map((v) => v.expect.pi);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("proves sub-tenant and session isolation are part of the identity", () => {
		const byId = Object.fromEntries(corpus.identity.vectors.map((v) => [v.id, v]));
		// Same sentence, different userId / different session — different write.
		expect(byId["subtenant-differs"].messages).toEqual(byId["single-user-turn"].messages);
		expect(byId["subtenant-differs"].expect.pi).not.toBe(byId["single-user-turn"].expect.pi);
		expect(byId["other-session-same-content"].messages).toEqual(byId["single-user-turn"].messages);
		expect(byId["other-session-same-content"].expect.pi).not.toBe(byId["single-user-turn"].expect.pi);
	});
});

describe("injection boundary", () => {
	it("wraps recalled memory in markers behind a data label", () => {
		const { openMarker, closeMarker, preamble } = corpus.injection;
		expect(openMarker).toBe("<itsuki-recalled-context-v1>");
		expect(closeMarker).toBe("</itsuki-recalled-context-v1>");
		expect(preamble).toMatch(/not instructions/i);
	});

	it("keeps every non-empty expected block inside the boundary", () => {
		for (const vector of corpus.injection.vectors) {
			if (vector.expect === null) continue;
			expect(vector.expect.startsWith(corpus.injection.openMarker), vector.id).toBe(true);
			expect(vector.expect.endsWith(corpus.injection.closeMarker), vector.id).toBe(true);
			expect(vector.expect, vector.id).toContain(corpus.injection.preamble);
		}
	});

	it("treats an empty recall as no injection at all", () => {
		const empties = corpus.injection.vectors.filter((v) => v.expect === null);
		expect(empties.length).toBeGreaterThanOrEqual(2);
	});

	it("requires a hostile stored instruction to stay labelled as data", () => {
		const hostile = corpus.injection.injectedDirectiveMustNotEscape;
		expect(hostile.context).toMatch(/ignore previous instructions/i);
		for (const needle of hostile.mustContain) {
			expect(typeof needle).toBe("string");
		}
	});
});

describe("error taxonomy", () => {
	it("classifies every vector and dispositions every class it produces", () => {
		const { vectors, dispositions } = corpus.errorTaxonomy;
		const dispositioned = new Set([
			...dispositions.remove_terminal,
			...dispositions.hold_and_pause,
			...dispositions.hold_and_retry,
		]);
		for (const vector of vectors) {
			expect(vector.expect.errorClass, vector.id).toBeTruthy();
			expect(typeof vector.expect.retriable, vector.id).toBe("boolean");
			expect(dispositioned.has(vector.expect.errorClass), `${vector.id} class is not dispositioned`).toBe(true);
		}
	});

	it("never lets a class be both terminal and held", () => {
		const { dispositions } = corpus.errorTaxonomy;
		const terminal = new Set(dispositions.remove_terminal);
		for (const held of [...dispositions.hold_and_pause, ...dispositions.hold_and_retry]) {
			expect(terminal.has(held), `${held} cannot be both`).toBe(false);
		}
	});

	it("keeps quota non-retriable but never treats it as data loss", () => {
		const quota = corpus.errorTaxonomy.vectors.find((v) => v.id === "quota-exhausted");
		expect(quota.expect.retriable).toBe(false);
		expect(corpus.errorTaxonomy.dispositions.hold_and_pause).toContain("quota");
		expect(corpus.errorTaxonomy.dispositions.remove_terminal).not.toContain("quota");
	});

	it("keeps an account-wide pause distinct from the caller's own rate limit", () => {
		const capacity = corpus.errorTaxonomy.vectors.find((v) => v.id === "capacity-paused");
		const rate = corpus.errorTaxonomy.vectors.find((v) => v.id === "rate-limited-with-header");
		expect(capacity.expect.errorClass).toBe("capacity");
		expect(rate.expect.errorClass).toBe("rate_limit");
		expect(rate.expect.retryAfterSeconds).toBe(60);
	});
});

describe("batching limits", () => {
	it("mirrors the server's authoritative ingest contract exactly", () => {
		// If the server ever moves a limit, this fails and every adapter is told.
		expect(corpus.batching.limits.maxMessages).toBe(INGEST_LIMITS.maxMessages);
		expect(corpus.batching.limits.maxMessageCharacters).toBe(INGEST_LIMITS.maxMessageCharacters);
		expect(corpus.batching.limits.maxTotalCharacters).toBe(INGEST_LIMITS.maxTotalCharacters);
		expect(corpus.batching.limits.maxRequestBytes).toBe(INGEST_LIMITS.maxRequestBytes);
	});

	it("splits rather than drops, and clamps rather than discards", () => {
		const byId = Object.fromEntries(corpus.batching.vectors.map((v) => [v.id, v]));
		expect(byId["exactly-at-message-limit"].expectBatches).toBe(1);
		expect(byId["over-message-limit-splits"].expectBatches).toBe(2);
		expect(byId["oversized-message-is-clamped-not-dropped"].expectClamped).toBe(true);
		expect(byId["oversized-message-is-clamped-not-dropped"].expectBatches).toBe(1);
	});
});

describe("base URL safety", () => {
	it("refuses plain HTTP off loopback, and anything carrying a credential", () => {
		const reasons = corpus.baseUrl.invalid.map((entry) => entry.reason);
		expect(reasons).toContain("HTTPS");
		expect(reasons).toContain("credentials");
		expect(reasons).toContain("query");
		expect(reasons).toContain("fragment");
		// The link-local metadata address is the one an SSRF probe reaches for.
		expect(corpus.baseUrl.invalid.some((e) => e.input.includes("169.254.169.254"))).toBe(true);
	});

	it("allows loopback development without allowing the open internet in cleartext", () => {
		for (const entry of corpus.baseUrl.valid) {
			const isHttp = entry.input.startsWith("http://");
			if (isHttp) expect(entry.input).toMatch(/localhost|127\.0\.0\.1/);
		}
	});
});

describe("lifecycle contract", () => {
	it("makes recall fail open, with the reason written down", () => {
		expect(corpus.lifecycle.recall.failureMode).toBe("open");
		expect(corpus.lifecycle.recall.failureRationale).toMatch(/agent outage/i);
		expect(corpus.lifecycle.recall.emptyResult).toMatch(/inject nothing/i);
	});

	it("requires durable ownership before delivery, not after", () => {
		expect(corpus.lifecycle.capture.ownershipBeforeDelivery).toBe(true);
		expect(corpus.lifecycle.capture.neverClaimsSavedWithoutReceipt).toBe(true);
	});

	it("forbids capturing an unsettled or aborted turn", () => {
		expect(corpus.lifecycle.capture.neverWhen).toContain("mid-stream");
		expect(corpus.lifecycle.capture.neverWhen).toContain("after an aborted or cancelled turn");
	});

	it("forbids automatic destructive operations outright", () => {
		expect(corpus.lifecycle.destructive.automaticDeletionAllowed).toBe(false);
	});

	it("states that scope can only narrow and credentials never enter adapter files", () => {
		expect(corpus.lifecycle.scope.widening).toMatch(/impossible/i);
		expect(corpus.lifecycle.scope.credentialLocation).toMatch(/never a config file/i);
	});
});
