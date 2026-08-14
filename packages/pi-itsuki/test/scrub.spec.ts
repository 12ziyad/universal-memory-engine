/**
 * The scrubber is a COPY of the server's canonical lane, so it gets pinned to
 * the same corpus the server and both editor plugins are pinned to.
 *
 * That corpus (test/fixtures/security_corpus.mjs) exists because two scrubbers
 * silently drifted apart once already (SEC-01, then CDX-07). Copying the
 * implementation is a deliberate packaging choice — a published extension must
 * stand alone — and this file is the price of that choice.
 */

import { describe, expect, it } from "vitest";

import { SECRET_ENTRIES } from "../../../test/fixtures/security_corpus.mjs";
import { scrubText as serverScrubText } from "../../../src/pipeline/scrub.js";
import { looksSecret, scrubText } from "../src/scrub.js";

interface CorpusEntry {
	id: string;
	class: string;
	text: string;
	mustNotSurvive: string[];
	mustSurvive?: string[];
	expect?: Record<string, unknown>;
}

const entries = SECRET_ENTRIES as CorpusEntry[];

describe("canonical security corpus", () => {
	it("is actually loaded (a silently empty corpus would prove nothing)", () => {
		expect(entries.length).toBeGreaterThanOrEqual(18);
	});

	// The Claude capture hook is this adapter's closest analogue: a local
	// lifecycle capture path scrubbing before anything leaves the machine.
	// Every entry it must handle, this one must handle.
	const required = entries.filter((entry) => entry.expect?.["claude"] === "must");

	it("covers every class the local capture adapters are required to handle", () => {
		expect(required.length).toBe(entries.length);
	});

	for (const entry of required) {
		it(`removes the secret: ${entry.id} (${entry.class})`, () => {
			const { text } = scrubText(entry.text);
			for (const canary of entry.mustNotSurvive) {
				expect(text, `${entry.id} leaked ${canary}`).not.toContain(canary);
			}
			for (const kept of entry.mustSurvive ?? []) {
				expect(text, `${entry.id} lost meaning: ${kept}`).toContain(kept);
			}
		});
	}
});

describe("parity with the canonical server lane", () => {
	// Stronger than asserting what we think SHOULD happen: assert that this
	// copy and src/pipeline/scrub.js agree exactly. Any divergence — in either
	// direction, including a limitation one of them "fixes" alone — fails here.
	// This is the check that would have caught SEC-01 and CDX-07 on day one.
	const samples = [
		"my password is stored in 1Password",
		"the token is expired, please refresh it",
		"the secret is that I like tidepools",
		"the token is expired and needs refreshing",
		"DATABASE_PASSWORD=hunter2horse",
		'{"apiKey": "sk-abcdefghijklmnopqrstuvwxyz"}',
		"postgres://admin:s3cr3t@db.example.com:5432/app",
		"curl -H 'Authorization: Bearer abcdefghijklmnop' https://api.example.com",
		"the commit is 0123456789abcdef0123456789abcdef01234567",
		"plain sentence with no secrets at all",
		"",
	];

	it("produces identical output to the server for every sample", () => {
		for (const sample of samples) {
			expect(scrubText(sample).text, sample).toBe(serverScrubText(sample).text);
		}
	});

	it("produces identical output to the server for every corpus entry", () => {
		for (const entry of entries) {
			expect(scrubText(entry.text).text, entry.id).toBe(serverScrubText(entry.text).text);
		}
	});

	it("keeps ordinary prose that merely talks about secrets", () => {
		for (const sample of ["my password is stored in 1Password", "the secret is that I like tidepools"]) {
			expect(scrubText(sample).text, sample).toBe(sample);
		}
	});

	it("keeps hashes, long words and identifiers", () => {
		expect(looksSecret("a".repeat(40))).toBe(false);
		expect(looksSecret("0123456789abcdef0123456789abcdef")).toBe(false);
		expect(looksSecret("Donaudampfschifffahrtsgesellschaftskapitaen")).toBe(false);
		expect(looksSecret("12345678901234567890123456789012")).toBe(false);
	});

	it("still catches a genuinely high-entropy token", () => {
		expect(looksSecret("aG7xQ2mZ9pL4vB8nR1tY6wE3sD5fJ0kC")).toBe(true);
	});
});

describe("the product never memorizes its own credentials", () => {
	it("redacts an Itsuki key wherever it appears", () => {
		const key = "itsuki_live_abcdefghijklmnop";
		const { text, redactions } = scrubText(`I set ITSUKI_API_KEY=${key} in my shell`);
		expect(text).not.toContain(key);
		expect(Object.keys(redactions).length).toBeGreaterThan(0);
	});

	it("counts what it removed without ever recording the value", () => {
		const { redactions } = scrubText("token: sk-abcdefghijklmnopqrstuvwxyz");
		expect(Object.values(redactions).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
		expect(JSON.stringify(redactions)).not.toContain("abcdefghij");
	});
});
