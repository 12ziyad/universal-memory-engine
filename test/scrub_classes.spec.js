/**
 * Part 8.1 — the credential shapes the Aug 2 load test did NOT include.
 * It proved sk-/ghp-/URI-creds; these are the common shapes it missed.
 * Each class asserts both halves: the secret is gone, and the surrounding
 * sentence still means something (a scrubber that eats the sentence is a
 * memory engine that forgets why you mentioned it).
 */

import { describe, it, expect } from "vitest";
import { scrubText } from "../src/pipeline/scrub.js";

const gone = (text, secret) => {
	const out = scrubText(text);
	expect(out.text).not.toContain(secret);
	return out;
};

describe("8.1 scrubber classes", () => {
	it("JWTs (eyJ…)", () => {
		const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlppeWFkIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const out = gone(`The session cookie holds ${jwt} and expires nightly.`, jwt);
		expect(out.text).toContain("session cookie");
		expect(out.redactions).toHaveProperty("api_key");
	});

	it("Slack bot and user tokens (xoxb-/xoxp-)", () => {
		const bot = "xoxb-EXAMPLE-NOT-A-REAL-TOKEN-0123456789";
		const user = "xoxp-EXAMPLE-NOT-A-REAL-TOKEN-9876543210";
		const out = gone(`Slack bot ${bot} and my user token ${user} both rotate on Fridays.`, bot);
		expect(out.text).not.toContain(user);
		expect(out.text).toContain("rotate on Fridays");
	});

	it("PEM private-key blocks", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEowIBAAKCAQEAx7Zv8kQm2P0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab",
			"cdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/==",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const out = gone(`Deploy key for the Porto cluster:\n${pem}\nKeep it safe.`, "MIIEowIBAAKCAQEA");
		expect(out.text).toContain("Porto cluster");
		expect(out.text).toContain("[REDACTED:private-key]");
		expect(out.redactions).toHaveProperty("private_key");
	});

	it("database connection strings with credentials", () => {
		const cases = [
			["postgres://admin:Tr4d3W1nds99@db.internal:5432/freight", "Tr4d3W1nds99"],
			["mongodb+srv://svc_user:p9x!Kq2mLw@cluster0.mongodb.net/logs", "p9x!Kq2mLw"],
			["redis://default:aVeryLongRedisPassword123@cache.internal:6379", "aVeryLongRedisPassword123"],
		];
		for (const [uri, secret] of cases) {
			const out = gone(`Our staging DSN is ${uri} for the analytics job.`, secret);
			expect(out.text).toContain("analytics job");
			expect(out.text).toContain("[REDACTED:password]");
			// The scheme and host survive: "uses postgres" is the durable memory.
			expect(out.text).toMatch(/postgres|mongodb|redis/);
		}
	});

	it("Bearer <token> in prose", () => {
		const token = "aB3dEf7HiJkLmNoP9rStUvWxYz012345";
		const out = gone(`curl -H "Authorization: Bearer ${token}" https://api.internal/v1/ping`, token);
		expect(out.text).toContain("api.internal");
		expect(out.text).toMatch(/\[REDACTED:(token|secret)\]/);
	});

	it("does NOT eat ordinary prose that merely looks technical", () => {
		const innocent = [
			"I read the bearer bonds chapter twice.",
			"The commit hash in the stack trace was 9f2a1c4 and the file was src/pipeline/recall.js.",
			"My postgres notes live in Obsidian under Databases/Postgres.",
			"Donaudampfschiffahrtsgesellschaftskapitaen is my favourite compound noun.",
		].join("\n");
		const out = scrubText(innocent);
		expect(out.text).toBe(innocent);
		expect(Object.keys(out.redactions)).toHaveLength(0);
	});
});
