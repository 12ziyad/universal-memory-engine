/**
 * The secret scrubber. The one non-negotiable: the exact shape that got stored
 * in production once — an AuraDB neo4j+s:// URI with username and password —
 * can never reach a model again. And the opposite direction matters just as
 * much: ordinary long text must come through untouched, because a scrubber
 * that mangles prose gets turned off.
 */

import { describe, it, expect } from "vitest";
import { scrubText, scrubMessages, looksSecret } from "../src/pipeline/scrub.js";

describe("the shapes that must be caught", () => {
	it("the real AuraDB shape: neo4j+s:// with username and password", () => {
		const { text, redactions } = scrubText(
			"connect with neo4j+s://neo4j:kX9mP2vLqR8wN4jT7hB3cF6d@a1b2c3d4.databases.neo4j.io and you're in",
		);
		expect(text).toContain("neo4j+s://neo4j:[REDACTED:password]@a1b2c3d4.databases.neo4j.io");
		expect(text).not.toContain("kX9mP2vLqR8wN4jT7hB3cF6d");
		// Meaning survives: the scheme and host still say "uses AuraDB".
		expect(text).toContain("databases.neo4j.io");
		expect(redactions.connection_credentials).toBe(1);
	});

	it("postgres:// and mongodb+srv:// credentials", () => {
		const { text } = scrubText(
			"prod is postgres://admin:s3cretPass@db.internal:5432/app and analytics is mongodb+srv://root:hunter2@cluster0.mongodb.net",
		);
		expect(text).not.toContain("s3cretPass");
		expect(text).not.toContain("hunter2");
		expect(text).toContain("postgres://admin:[REDACTED:password]@db.internal:5432/app");
	});

	it("known key prefixes, including our own", () => {
		const { text, redactions } = scrubText(
			[
				"openai key sk-proj-Ab3dEfGh1jKlMnOpQrStUvWx",
				"github ghp_AbCdEfGh1234567890IjKlMnOpQrStUv",
				"pypi pypi-AgEIcHlwaS5vcmcCJDU4YzU4NzQ0LWEzN2Yt",
				"aws AKIAIOSFODNN7EXAMPLE",
				"our own itsuki_live_Zx9Yw8Vu7Ts6Rq5P",
				"legacy uml_live_Ab1Cd2Ef3Gh4Ij5K",
			].join("\n"),
		);
		expect(text).not.toMatch(/sk-proj|ghp_A|pypi-Ag|AKIAIOSFODNN7EXAMPLE|itsuki_live_Zx|uml_live_Ab/);
		expect(redactions.api_key).toBe(6);
	});

	it("PEM private key blocks, even huge ones", () => {
		const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n".repeat(20);
		const { text } = scrubText(`here's the deploy key\n-----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY-----\nworks on the server`);
		expect(text).toBe("here's the deploy key\n[REDACTED:private-key]\nworks on the server");
	});

	it("an unterminated PEM block (pasted partially) is still caught", () => {
		const { text } = scrubText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ");
		expect(text).toBe("[REDACTED:private-key]");
	});

	it("JWTs and query-string secrets", () => {
		const { text } = scrubText(
			"header eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c and https://api.example.com/v2/items?api_key=Zk8mN2pQr5TvXw9Y&page=2",
		);
		expect(text).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c");
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
			{ id: "1", role: "user", content: "my key is sk-AbCdEfGhIjKlMnOpQrStUvWxYz123456" },
			{ id: "2", role: "user", content: "and I live in Lisbon" },
		]);
		expect(redacted).toBe(true);
		expect(redactions.api_key).toBe(1);
		expect(messages[0].content).toBe("my key is [REDACTED:api-key]");
		expect(messages[1].content).toBe("and I live in Lisbon");
	});
});
