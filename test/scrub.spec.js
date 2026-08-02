/**
 * The secret scrubber. The one non-negotiable: the exact shape that got stored
 * in production once — an AuraDB neo4j+s:// URI with username and password —
 * can never reach a model again. And the opposite direction matters just as
 * much: ordinary long text must come through untouched, because a scrubber
 * that mangles prose gets turned off.
 */

import { describe, it, expect } from "vitest";
import { scrubText, scrubMessages, looksSecret } from "../src/pipeline/scrub.js";

/**
 * Every fixture below is invented — no real credential has ever been in this
 * file. They are ASSEMBLED AT RUNTIME rather than written as literals so that
 * secret scanners (GitHub's included) don't flag the test that exists to
 * prove secrets get stripped. The scrubber receives the identical string
 * either way; only the source text differs.
 */
const fake = (...parts) => parts.join("");
const FAKE = {
	neo4jPassword: fake("kX9mP2vLqR", "8wN4jT7hB3cF6d"),
	pgPassword: fake("s3cret", "Pass"),
	mongoPassword: fake("hunt", "er2"),
	openai: fake("sk-", "proj-Ab3dEfGh1jKlMnOpQrStUvWx"),
	github: fake("ghp", "_AbCdEfGh1234567890IjKlMnOpQrStUv"),
	pypi: fake("pypi", "-AgEIcHlwaS5vcmcCJDU4YzU4NzQ0LWEzN2Yt"),
	aws: fake("AKIA", "IOSFODNN7EXAMPLE"),
	itsuki: fake("itsuki_live", "_Zx9Yw8Vu7Ts6Rq5P"),
	uml: fake("uml_live", "_Ab1Cd2Ef3Gh4Ij5K"),
	jwt: fake(
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
		"eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
		"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
	),
	queryKey: fake("Zk8mN2p", "Qr5TvXw9Y"),
};

describe("the shapes that must be caught", () => {
	it("the real AuraDB shape: neo4j+s:// with username and password", () => {
		const { text, redactions } = scrubText(
			`connect with neo4j+s://neo4j:${FAKE.neo4jPassword}@a1b2c3d4.databases.neo4j.io and you're in`,
		);
		expect(text).toContain("neo4j+s://neo4j:[REDACTED:password]@a1b2c3d4.databases.neo4j.io");
		expect(text).not.toContain(FAKE.neo4jPassword);
		// Meaning survives: the scheme and host still say "uses AuraDB".
		expect(text).toContain("databases.neo4j.io");
		expect(redactions.connection_credentials).toBe(1);
	});

	it("postgres:// and mongodb+srv:// credentials", () => {
		const { text } = scrubText(
			`prod is postgres://admin:${FAKE.pgPassword}@db.internal:5432/app` +
			` and analytics is mongodb+srv://root:${FAKE.mongoPassword}@cluster0.mongodb.net`,
		);
		expect(text).not.toContain(FAKE.pgPassword);
		expect(text).not.toContain(FAKE.mongoPassword);
		expect(text).toContain("postgres://admin:[REDACTED:password]@db.internal:5432/app");
	});

	it("known key prefixes, including our own", () => {
		const { text, redactions } = scrubText(
			[
				`openai key ${FAKE.openai}`,
				`github ${FAKE.github}`,
				`pypi ${FAKE.pypi}`,
				`aws ${FAKE.aws}`,
				`our own ${FAKE.itsuki}`,
				`legacy ${FAKE.uml}`,
			].join("\n"),
		);
		for (const secret of [FAKE.openai, FAKE.github, FAKE.pypi, FAKE.aws, FAKE.itsuki, FAKE.uml]) {
			expect(text).not.toContain(secret);
		}
		expect(redactions.api_key).toBe(6);
	});

	it("PEM private key blocks, even huge ones", () => {
		const body = fake("MIIEvQIBADANBgkqhkiG9w0", "BAQEFAASCBKcwggSjAgEAAoIBAQ\n").repeat(20);
		const begin = fake("-----BEGIN RSA ", "PRIVATE KEY-----");
		const end = fake("-----END RSA ", "PRIVATE KEY-----");
		const { text } = scrubText(`here's the deploy key\n${begin}\n${body}${end}\nworks on the server`);
		expect(text).toBe("here's the deploy key\n[REDACTED:private-key]\nworks on the server");
	});

	it("an unterminated PEM block (pasted partially) is still caught", () => {
		const partial = `${fake("-----BEGIN ", "PRIVATE KEY-----")}\n${fake("MIIEvQIBADANBgkqhkiG9w0", "BAQEFAASCBKcwggSjAgEAAoIBAQ")}`;
		expect(scrubText(partial).text).toBe("[REDACTED:private-key]");
	});

	it("JWTs and query-string secrets", () => {
		const { text } = scrubText(
			`header ${FAKE.jwt} and https://api.example.com/v2/items?api_key=${FAKE.queryKey}&page=2`,
		);
		expect(text).not.toContain(FAKE.jwt);
		expect(text).not.toContain(FAKE.queryKey);
		expect(text).toContain("?api_key=[REDACTED:secret]&page=2");
	});

	it("a bare high-entropy blob", () => {
		const blob = "9fK2mX7pQ4vL8wN3jT6hB1cR5dY0zA9fK2mX7pQ4vL8w";
		expect(looksSecret(blob)).toBe(true);
		const { text } = scrubText(`the value was ${blob} according to the log`);
		expect(text).toBe("the value was [REDACTED:secret] according to the log");
	});
});

describe("the shapes that must SURVIVE", () => {
	it("ordinary long prose, long words, and URLs without credentials", () => {
		const inputs = [
			"Rindfleischetikettierungsueberwachungsaufgabenuebertragungsgesetz is a real German word",
			"the docs live at https://developers.cloudflare.com/workers/observability/logs/real-time-logs/",
			"I moved the extraction pipeline from src/pipeline/manual_extract.js to src/pipeline/extract.js yesterday",
			"her flight lands at 14:35 on the 14th of November and the booking reference is BRX7K2",
		];
		for (const input of inputs) {
			const { text, redactions } = scrubText(input);
			expect(text, input).toBe(input);
			expect(Object.keys(redactions), input).toHaveLength(0);
		}
	});

	it("git commit SHAs in stack traces stay — they are meaning, not secrets", () => {
		const line = "fixed in commit 0b2d58ef91b71f14fa2e02222b51dbc961640a93 after the meter change";
		expect(scrubText(line).text).toBe(line);
	});

	it("repetitive low-entropy strings stay", () => {
		const line = "then it printed aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and hung";
		expect(scrubText(line).text).toBe(line);
	});

	it("scrubMessages reports counts and never the values", () => {
		const { messages, redactions, redacted } = scrubMessages([
			{ id: "1", role: "user", content: `my key is ${fake("sk-", "AbCdEfGhIjKlMnOpQrStUvWxYz123456")}` },
			{ id: "2", role: "user", content: "and I live in Lisbon" },
		]);
		expect(redacted).toBe(true);
		expect(redactions.api_key).toBe(1);
		expect(messages[0].content).toBe("my key is [REDACTED:api-key]");
		expect(messages[1].content).toBe("and I live in Lisbon");
	});
});
