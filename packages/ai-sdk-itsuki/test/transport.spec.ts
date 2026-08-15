/**
 * Transport behaviour, proven against a scripted fetch.
 *
 * These are the guarantees an enterprise deployment actually leans on: the
 * key never leaves the header, a redirect can never replay it somewhere else,
 * a write never silently duplicates itself through a retry, and no error
 * surface anywhere echoes the credential.
 */

import { describe, it, expect } from "vitest";

import { ItsukiTransport, validateBaseUrl, validApiKeyShape } from "../src/kernel/transport.js";
import { ItsukiError } from "../src/kernel/errors.js";
import { fakeFetch, json, TEST_KEY, BASE_URL } from "./helpers.js";

function transport(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
	return new ItsukiTransport({
		apiKey: TEST_KEY,
		baseUrl: BASE_URL,
		userAgent: "ai-sdk-itsuki",
		fetchImpl,
		sleepImpl: async () => undefined,
		random: () => 0.5,
		...options,
	});
}

describe("base url validation", () => {
	it("accepts https and loopback http", () => {
		expect(validateBaseUrl("https://itsuki.app")).toBe("https://itsuki.app");
		expect(validateBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
		expect(validateBaseUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
	});

	it("refuses anything that could carry or redirect a credential", () => {
		expect(() => validateBaseUrl("http://itsuki.app")).toThrow(/HTTPS/);
		expect(() => validateBaseUrl("https://user:pw@itsuki.app")).toThrow(/credentials/);
		expect(() => validateBaseUrl("https://itsuki.app?key=x")).toThrow(/query/);
		expect(() => validateBaseUrl("https://itsuki.app#x")).toThrow(/fragment/);
		expect(() => validateBaseUrl("")).toThrow();
		expect(() => validateBaseUrl("not a url")).toThrow();
	});
});

describe("api key shape", () => {
	it("accepts current and legacy prefixes", () => {
		expect(validApiKeyShape("itsuki_live_abcdefgh")).toBe(true);
		expect(validApiKeyShape("uml_live_abcdefgh")).toBe(true);
	});

	it("rejects anything that would break a header", () => {
		expect(validApiKeyShape("")).toBe(false);
		expect(validApiKeyShape("itsuki_live_short")).toBe(false);
		expect(validApiKeyShape("itsuki_live_abcdefgh\n")).toBe(false);
		expect(validApiKeyShape("Bearer itsuki_live_abcdefgh")).toBe(false);
	});
});

describe("credential handling", () => {
	it("sends the key only as an Authorization header", async () => {
		const api = fakeFetch(() => json(200, { ok: true }));
		await transport(api.fetch).status({ userId: "u" });

		const call = api.calls[0]!;
		expect(call.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
		expect(call.url).not.toContain(TEST_KEY);
		expect(JSON.stringify(call.body ?? {})).not.toContain(TEST_KEY);
	});

	it("refuses to follow redirects", async () => {
		const api = fakeFetch(() => json(200, { ok: true }));
		await transport(api.fetch).status({});
		expect(api.calls[0]!.redirect).toBe("error");
	});

	it("identifies itself with the package's user agent", async () => {
		const api = fakeFetch(() => json(200, { ok: true }));
		await transport(api.fetch).status({});
		expect(api.calls[0]!.headers["user-agent"]).toBe("ai-sdk-itsuki");
	});

	it("scrubs the key out of a network error message", async () => {
		const api = fakeFetch(() => {
			throw new Error(`connect failed using ${TEST_KEY}`);
		});
		try {
			await transport(api.fetch, { maxRetries: 0 }).status({});
			expect.unreachable();
		} catch (error) {
			// The headline is a fixed sentence; the underlying cause lands in
			// description, which is where a leak would actually happen.
			const failure = error as ItsukiError;
			expect(failure.message).toBe("Could not reach Itsuki");
			expect(failure.description).toContain("***");
			expect(`${failure.message} ${failure.description}`).not.toContain(TEST_KEY);
		}
	});

	it("scrubs the key out of a server error message", async () => {
		const api = fakeFetch(() => json(400, { message: `bad key ${TEST_KEY}` }));
		try {
			await transport(api.fetch).status({});
			expect.unreachable();
		} catch (error) {
			const text = `${(error as Error).message} ${(error as ItsukiError).description}`;
			expect(text).not.toContain(TEST_KEY);
		}
	});
});

describe("retry policy", () => {
	it("retries reads", async () => {
		let calls = 0;
		const api = fakeFetch(() => {
			calls += 1;
			return calls < 3 ? json(500, { error: "boom" }) : json(200, { ok: true });
		});
		await expect(transport(api.fetch).status({})).resolves.toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	it("retries idempotency-keyed writes with the same key", async () => {
		let calls = 0;
		const api = fakeFetch(() => {
			calls += 1;
			return calls < 2 ? json(503, { error: "unavailable" }) : json(200, { ok: true });
		});
		await transport(api.fetch).saveConversation(
			[{ role: "user", content: "hi" }],
			{ idempotencyKey: "idem_fixed", userId: "u" },
		);
		expect(calls).toBe(2);
		expect(api.calls.every((call) => call.body!["idempotencyKey"] === "idem_fixed")).toBe(true);
	});

	it("does not retry a client error", async () => {
		let calls = 0;
		const api = fakeFetch(() => {
			calls += 1;
			return json(403, { error: "insufficient_scope" });
		});
		await expect(transport(api.fetch).status({})).rejects.toMatchObject({ errorClass: "auth" });
		expect(calls).toBe(1);
	});

	it("honours Retry-After", async () => {
		const slept: number[] = [];
		let calls = 0;
		const api = fakeFetch(() => {
			calls += 1;
			return calls < 2
				? json(429, { error: "rate_limited" }, { "retry-after": "3" })
				: json(200, { ok: true });
		});
		await transport(api.fetch, {
			sleepImpl: async (ms: number) => { slept.push(ms); },
		}).status({});
		expect(slept).toEqual([3_000]);
	});

	it("gives up inside the caller's time budget", async () => {
		let now = 0;
		const api = fakeFetch(() => json(500, { error: "boom" }));
		await expect(transport(api.fetch, {
			timeoutMs: 1_000,
			maxRetries: 5,
			now: () => now,
			sleepImpl: async (ms: number) => { now += ms; },
		}).status({})).rejects.toBeInstanceOf(ItsukiError);
	});
});

describe("cancellation", () => {
	it("throws a cancelled error when the signal is already aborted", async () => {
		const api = fakeFetch(() => json(200, { ok: true }));
		const controller = new AbortController();
		controller.abort();
		await expect(transport(api.fetch).status({ signal: controller.signal }))
			.rejects.toMatchObject({ errorClass: "cancelled" });
		expect(api.calls).toHaveLength(0);
	});

	it("never retries after cancellation", async () => {
		const controller = new AbortController();
		let calls = 0;
		const api = fakeFetch(() => {
			calls += 1;
			controller.abort();
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		});
		await expect(transport(api.fetch).status({ signal: controller.signal }))
			.rejects.toMatchObject({ errorClass: "cancelled" });
		expect(calls).toBe(1);
	});
});

describe("endpoint shapes", () => {
	it("scopes a packet-status poll to the same memory space as the write", async () => {
		const api = fakeFetch(() => json(200, { ok: true, status: "enriched" }));
		await transport(api.fetch).packetStatus("pkt_1", { userId: "u_sub" });
		expect(api.calls[0]!.url).toBe(`${BASE_URL}/v1/packets/pkt_1/status?userId=u_sub`);
	});

	it("encodes ids rather than trusting them in a path", async () => {
		const api = fakeFetch(() => json(200, { ok: true }));
		await transport(api.fetch).getMemory("node_../../etc/passwd", {});
		expect(api.calls[0]!.url).toContain("node_..%2F..%2Fetc%2Fpasswd");
	});

	it("previews a bulk delete unless confirmation is explicit", async () => {
		const api = fakeFetch(() => json(200, { ok: true, dry_run: true }));
		await transport(api.fetch).deleteBySource({ userId: "u", source: "ai-sdk" });
		expect(api.calls[0]!.url).not.toContain("confirm");
		expect(api.calls[0]!.method).toBe("DELETE");

		await transport(api.fetch).deleteBySource({ userId: "u", source: "ai-sdk", confirm: true });
		expect(api.calls[1]!.url).toContain("confirm=true");
		expect(api.calls[1]!.url).toContain("dry_run=false");
	});
});
