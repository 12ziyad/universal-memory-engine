/**
 * Labeled-secret scrubbing (campaign 2026-08-07, defect SEC-01).
 *
 * The scrubber caught machine-SHAPED secrets (known key prefixes, JWTs, URI
 * credentials, Bearer tokens, query-string secrets, high-entropy 32+ blobs) but
 * not the LABEL→VALUE form people actually paste: `.env` lines and prose like
 * "my password is …". Found live: a fixture stating a password in prose was
 * stored in `slices.source_snippet` and appeared in `/v1/export`.
 *
 * The pattern is deliberately conservative: the value must be contiguous,
 * long enough to be a credential, and contain a digit or symbol, so ordinary
 * English ("my password is stored in 1Password", "the token is expired")
 * survives untouched. Prose is the thing memory exists to keep.
 */

import { describe, expect, it } from "vitest";

import { scrubText } from "../src/pipeline/scrub.js";

function scrubbed(input) {
	return scrubText(input).text;
}

describe("labeled secrets in .env and config form", () => {
	it("redacts UPPER_SNAKE assignments for every credential-ish label", () => {
		const block = [
			"DATABASE_PASSWORD=hunter2horse",
			"API_SECRET=z9x8c7v6b5n4m3",
			"ACCESS_TOKEN=abc123def456ghi",
			"CLIENT_SECRET=q1w2e3r4t5y6",
			"PRIVATE_KEY=k0k1k2k3k4k5k6",
		].join("\n");
		const output = scrubbed(block);
		for (const value of ["hunter2horse", "z9x8c7v6b5n4m3", "abc123def456ghi", "q1w2e3r4t5y6", "k0k1k2k3k4k5k6"]) {
			expect(output).not.toContain(value);
		}
		// The KEY names survive: they carry the meaning, not the secret.
		expect(output).toContain("DATABASE_PASSWORD");
		expect(output).toContain("CLIENT_SECRET");
	});

	it("redacts colon and quoted forms", () => {
		expect(scrubbed("password: hunter2-swordfish-9911")).not.toContain("hunter2-swordfish-9911");
		expect(scrubbed('password="hunter2horse"')).not.toContain("hunter2horse");
		expect(scrubbed("apiKey: 'abc123def456'")).not.toContain("abc123def456");
		expect(scrubbed("api_key = zz11yy22xx33")).not.toContain("zz11yy22xx33");
	});
});

describe("labeled secrets stated in prose", () => {
	it("redacts 'my password is …' and its siblings", () => {
		expect(scrubbed("my password is Tr0ub4dor&3 ok")).not.toContain("Tr0ub4dor&3");
		expect(scrubbed("The deploy token is abc123def456ghi789 for now")).not.toContain("abc123def456ghi789");
		expect(scrubbed("my passphrase is correct-horse-battery-staple-9911")).not.toContain("correct-horse-battery-staple-9911");
	});

	it("keeps the sentence readable so the surrounding fact still means something", () => {
		const output = scrubbed("I decided the exporter ships nightly and my password is Tr0ub4dor&3 for it.");
		expect(output).toContain("the exporter ships nightly");
		expect(output).toMatch(/\[REDACTED:[a-z-]+\]/);
	});
});

describe("ordinary prose is not eaten", () => {
	it("leaves label words alone when the value is not credential-shaped", () => {
		for (const sentence of [
			"my password is stored in 1Password",
			"the token is expired and I need a new one",
			"my api key is in the vault, ask Priya",
			"the secret is that I actually like tidepools",
			"my password manager is Bitwarden",
			"SECRET=yes",
		]) {
			expect(scrubbed(sentence)).toBe(sentence);
		}
	});

	it("still leaves the existing non-secret cases untouched", () => {
		for (const sentence of [
			"I fixed the bug in commit a94f2c1b8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
			"The Donaudampfschiffahrtsgesellschaftskapitaen retired",
			"We deploy to https://itsuki.app/docs/getting-started every Friday",
		]) {
			expect(scrubbed(sentence)).toBe(sentence);
		}
	});
});
