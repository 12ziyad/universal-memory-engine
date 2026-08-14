/**
 * Transport contract: what goes on the wire, and what comes back off it.
 *
 * These are the tests that would catch a credential in a URL, a redirect that
 * replays the Authorization header somewhere else, a write retried without an
 * idempotency key, or an error message that quotes the key back at the user.
 */

import { describe, expect, it, vi } from "vitest";

import { ItsukiError } from "../src/errors.js";
import { ItsukiTransport, validApiKeyShape, validateBaseUrl } from "../src/transport.js";

const KEY = "itsuki_live_secret_key_0123456789";

interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

function harness(replies: Array<Reply | Error>, options: { baseUrl?: string } = {}) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	let index = 0;
	const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = replies[Math.min(index, replies.length - 1)]!;
		index += 1;
		if (next instanceof Error) throw next;
		// 204/205/304 are null-body statuses: the Response constructor rejects
		// any body for them, even an empty string.
		const nullBody = next.status === 204 || next.status === 205 || next.status === 304;
		return new Response(
			nullBody || next.body === undefined ? null : JSON.stringify(next.body),
			{ status: next.status, headers: next.headers },
		);
	}) as unknown as typeof fetch;

	const transport = new ItsukiTransport({
		apiKey: KEY,
		baseUrl: options.baseUrl ?? "https://itsuki.app",
		fetchImpl,
		// No real waiting anywhere in the suite.
		sleepImpl: async () => {},
		random: () => 0.5,
	});
	return { transport, calls };
}

describe("credential handling", () => {
	it("sends the key as a header and never in the URL or query", async () => {
		const { transport, calls } = harness([{ status: 200, body: { ok: true } }]);
		await transport.status();
		const call = calls[0]!;
		expect(call.url).toBe("https://itsuki.app/v1/status");
		expect(call.url).not.toContain(KEY);
		const headers = call.init.headers as Record<string, string>;
		expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
	});

	it("refuses to follow redirects, so the header cannot be replayed elsewhere", async () => {
		const { transport, calls } = harness([{ status: 200, body: { ok: true } }]);
		await transport.status();
		expect(calls[0]!.init.redirect).toBe("error");
	});

	it("refuses a malformed key before any request is made", () => {
		expect(() => new ItsukiTransport({ apiKey: "nope" })).toThrow(/malformed|missing/i);
		expect(validApiKeyShape("itsuki_live_abcdefgh")).toBe(true);
		expect(validApiKeyShape("uml_live_abcdefgh")).toBe(true);
		expect(validApiKeyShape("")).toBe(false);
		// A key with a newline would smuggle a second header.
		expect(validApiKeyShape("itsuki_live_abcdefgh\nx-evil: 1")).toBe(false);
	});

	it("refuses an unsafe base URL before any request is made", () => {
		expect(() => new ItsukiTransport({ apiKey: KEY, baseUrl: "http://evil.example" })).toThrow(/HTTPS/);
		expect(() => new ItsukiTransport({ apiKey: KEY, baseUrl: "https://u:p@itsuki.app" })).toThrow(/credentials/);
	});

	it("scrubs the key out of every error surface", async () => {
		const { transport } = harness([{ status: 400, body: { error: "bad", message: `echoed ${KEY} somehow` } }]);
		await expect(transport.status()).rejects.toThrow();
		try {
			await transport.status();
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(KEY);
			expect((error as Error).message).not.toContain(KEY);
			expect((error as ItsukiError).description).not.toContain(KEY);
		}
	});

	it("scrubs the key out of network-level failures too", async () => {
		const { transport } = harness([new Error(`connect failed for Bearer ${KEY}`)]);
		try {
			await transport.recall("hi", { limit: 5 });
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(KEY);
			expect((error as ItsukiError).description).not.toContain(KEY);
		}
	});
});

describe("retry policy", () => {
	it("retries a read on a retriable failure and then succeeds", async () => {
		const { transport, calls } = harness([
			{ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "0" } },
			{ status: 200, body: { ok: true } },
		]);
		const out = await transport.status();
		expect(out["ok"]).toBe(true);
		expect(calls.length).toBe(2);
	});

	it("never retries a write that carries no idempotency key", async () => {
		const { transport, calls } = harness([
			{ status: 503, body: { error: "unavailable" } },
			{ status: 200, body: { ok: true } },
		]);
		await expect(transport.request({ method: "POST", path: "/v1/save", body: { content: "x" } })).rejects.toThrow();
		expect(calls.length).toBe(1);
	});

	it("retries an idempotency-keyed write, so a duplicate cannot be created", async () => {
		const { transport, calls } = harness([
			{ status: 503, body: { error: "unavailable" }, headers: { "retry-after": "0" } },
			{ status: 200, body: { ok: true, receipt_id: "r1" } },
		]);
		const out = await transport.saveConversation([{ role: "user", content: "x" }], { idempotencyKey: "pi:v1:abc" });
		expect(out["receipt_id"]).toBe("r1");
		expect(calls.length).toBe(2);
		const sent = JSON.parse(String(calls[0]!.init.body));
		expect(sent.idempotencyKey).toBe("pi:v1:abc");
		expect(sent.mode).toBe("conversation");
	});

	it("does not retry a non-retriable refusal", async () => {
		const { transport, calls } = harness([{ status: 429, body: { error: "ai_quota_exhausted" } }]);
		await expect(transport.status()).rejects.toThrow(/plan exhausted/i);
		expect(calls.length).toBe(1);
	});

	it("does not retry an auth failure", async () => {
		const { transport, calls } = harness([{ status: 401, body: { error: "unauthorized" } }]);
		await expect(transport.status()).rejects.toThrow(/rejected the API key/i);
		expect(calls.length).toBe(1);
	});
});

describe("scoping", () => {
	it("puts the sub-tenant in the body for writes and the query for reads", async () => {
		const { transport, calls } = harness([{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }]);
		await transport.saveConversation([{ role: "user", content: "x" }], {
			idempotencyKey: "pi:v1:abc",
			userId: "alice",
			conversationId: "sess-1",
		});
		const sent = JSON.parse(String(calls[0]!.init.body));
		expect(sent.userId).toBe("alice");
		expect(sent.conversationId).toBe("sess-1");

		await transport.packetStatus("src_1", { userId: "alice" });
		expect(calls[1]!.url).toContain("userId=alice");
	});

	it("omits the sub-tenant entirely when none is configured", async () => {
		const { transport, calls } = harness([{ status: 200, body: { ok: true } }]);
		await transport.recall("q", { limit: 3 });
		const sent = JSON.parse(String(calls[0]!.init.body));
		expect(sent.userId).toBeUndefined();
		expect(sent.limit).toBe(3);
	});
});

describe("cancellation and timeouts", () => {
	it("aborts immediately when the caller's signal is already aborted", async () => {
		const { transport, calls } = harness([{ status: 200, body: { ok: true } }]);
		const controller = new AbortController();
		controller.abort();
		await expect(transport.status({ signal: controller.signal })).rejects.toMatchObject({ errorClass: "cancelled" });
		expect(calls.length).toBe(0);
	});

	it("reports a cancellation as cancelled, never as a server failure", async () => {
		const controller = new AbortController();
		const transport = new ItsukiTransport({
			apiKey: KEY,
			fetchImpl: (async () => {
				controller.abort();
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}) as unknown as typeof fetch,
			sleepImpl: async () => {},
		});
		await expect(transport.status({ signal: controller.signal })).rejects.toMatchObject({ errorClass: "cancelled" });
	});

	it("gives up when the total budget is spent rather than retrying forever", async () => {
		let now = 0;
		const transport = new ItsukiTransport({
			apiKey: KEY,
			timeoutMs: 1_000,
			fetchImpl: (async () => {
				now += 600;
				return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
			}) as unknown as typeof fetch,
			sleepImpl: async () => {},
			now: () => now,
		});
		await expect(transport.status()).rejects.toThrow();
		// Budget 1000ms, each attempt burns 600ms: two attempts at most.
		expect(now).toBeLessThanOrEqual(1_800);
	});
});

describe("responses", () => {
	it("returns an empty object for a 2xx with no body", async () => {
		const { transport } = harness([{ status: 204 }]);
		await expect(transport.status()).resolves.toEqual({});
	});

	it("survives a 2xx whose body is not JSON", async () => {
		const transport = new ItsukiTransport({
			apiKey: KEY,
			fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
			sleepImpl: async () => {},
		});
		await expect(transport.status()).resolves.toEqual({});
	});
});

describe("base URL validation", () => {
	it("normalizes trailing slashes and keeps a path prefix", () => {
		expect(validateBaseUrl("https://itsuki.app///")).toBe("https://itsuki.app");
		expect(validateBaseUrl("https://example.test/api/")).toBe("https://example.test/api");
	});
});
