/**
 * JavaScript SDK contract tests. Fetch is stubbed; these tests never use the
 * network or a real API key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import MemoryClient, { Memory, MemoryAPIError, VERSION } from "../sdk/js/index.js";

let calls;

function stubFetch(responses) {
	calls = [];
	let index = 0;
	globalThis.fetch = vi.fn(async (url, init) => {
		calls.push({ url: String(url), init });
		const entry = responses[Math.min(index++, responses.length - 1)];
		const spec = typeof entry === "function" ? await entry(url, init) : entry;
		if (spec.throw) throw spec.throw;
		return new Response(
			spec.rawBody === undefined ? JSON.stringify(spec.body ?? { ok: true }) : spec.rawBody,
			{
				status: spec.status ?? 200,
				headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
			},
		);
	});
}

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

beforeEach(() => stubFetch([{ status: 200, body: { ok: true } }]));

const client = (options = {}) => new MemoryClient({
	apiKey: "itsuki_live_test",
	baseUrl: "https://api.example",
	maxRetries: 0,
	...options,
});

function body(call) {
	return call.init.body === undefined ? undefined : JSON.parse(call.init.body);
}

describe("MemoryClient construction and exports", () => {
	it("exports the prepared version and both client aliases", () => {
		expect(VERSION).toBe("0.2.1");
		expect(Memory).toBe(MemoryClient);
		expect(MemoryClient).toBe(Memory);
	});

	it("requires a usable API key", () => {
		for (const apiKey of [undefined, "", "   ", " bad-key ", "bad\nheader"]) {
			expect(() => new MemoryClient({ apiKey })).toThrow(MemoryAPIError);
		}
	});

	it("validates base URL, timeout, retry count, and default user id", () => {
		expect(() => client({ baseUrl: "ftp://api.example" })).toThrow(/HTTPS/);
		expect(() => client({ baseUrl: "http://api.example" })).toThrow(/HTTPS/);
		expect(() => client({ baseUrl: "http://127.0.0.1:8787" })).not.toThrow();
		expect(() => client({ baseUrl: "https://user:pass@api.example" })).toThrow(/must not contain credentials/);
		expect(() => client({ baseUrl: "https://api.example/prefix" })).toThrow(/credentials, a path/);
		expect(() => client({ baseUrl: "https://api.example?key=value" })).toThrow(/query string/);
		for (const baseUrl of ["https://api example", "https://%", "https://api.example\\evil"]) {
			expect(() => client({ baseUrl })).toThrow(/baseUrl/);
		}
		expect(() => client({ timeoutMs: 0 })).toThrow(/timeoutMs/);
		expect(() => client({ timeoutMs: 2_147_483_648 })).toThrow(/no greater than 2147483647/);
		expect(() => client({ baseUrl: "http://127.0.0.2:8787" })).not.toThrow();
		expect(() => client({ baseUrl: "http://126.255.255.255:8787" })).toThrow(/HTTPS/);
		expect(() => client({ maxRetries: -1 })).toThrow(/maxRetries/);
		expect(() => client({ maxRetries: 1.5 })).toThrow(/maxRetries/);
		expect(() => client({ maxRetries: 11 })).toThrow(/no greater than 10/);
		expect(() => client({ userId: "" })).toThrow(/userId/);
		expect(() => client({ userId: " ada " })).toThrow(/userId/);
	});

	it("normalizes a trailing slash on a service origin", async () => {
		const memory = client({ baseUrl: "https://api.example/" });
		await memory.status();
		expect(calls[0].url).toBe("https://api.example/v1/status");
	});
});

describe("deployed-service smoke example", () => {
	it("uses one isolated user and verifies recall absence after dry-run/confirmed cleanup", async () => {
		const previousKey = process.env.ITSUKI_API_KEY;
		const previousBase = process.env.ITSUKI_BASE_URL;
		process.env.ITSUKI_API_KEY = "itsuki_live_smoke_test";
		process.env.ITSUKI_BASE_URL = "https://api.example";
		let marker = null;
		let deleted = false;
		calls = [];
		globalThis.fetch = vi.fn(async (url, init) => {
			const parsed = new URL(url);
			const requestBody = init.body === undefined ? null : JSON.parse(init.body);
			calls.push({ url: String(url), init, body: requestBody });
			let response;
			if (parsed.pathname === "/v1/save") {
				marker = requestBody.content.match(/Fern-\d+/)?.[0] ?? null;
				response = { ok: true, source_packet_id: "src_smoke" };
			} else if (parsed.pathname === "/v1/packets/src_smoke/status") {
				response = { ok: true, status: "enriched", source_packet_id: "src_smoke" };
			} else if (parsed.pathname === "/v1/recall") {
				response = { ok: true, count: deleted ? 0 : 1, context: deleted ? "" : `Remember ${marker}` };
			} else if (parsed.pathname === "/v1/usage") {
				response = { ok: true, totals: {} };
			} else if (parsed.pathname === "/v1/memories" && init.method === "DELETE") {
				const counts = { runs: 1, nodes: 1, pages: 0, slices: 1, events: 0, edges: 0, candidates: 0 };
				if (parsed.searchParams.get("confirm") === "true") {
					deleted = true;
					response = { ok: true, dry_run: false, deleted: counts };
				} else {
					response = { ok: true, dry_run: true, would_delete: counts };
				}
			} else {
				throw new Error(`unexpected smoke request: ${init.method} ${parsed.pathname}`);
			}
			return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
		});
		vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await import("../sdk/js/examples/smoke.mjs?unit-test");
		} finally {
			if (previousKey === undefined) delete process.env.ITSUKI_API_KEY;
			else process.env.ITSUKI_API_KEY = previousKey;
			if (previousBase === undefined) delete process.env.ITSUKI_BASE_URL;
			else process.env.ITSUKI_BASE_URL = previousBase;
		}

		expect(marker).toMatch(/^Fern-\d+$/);
		expect(deleted).toBe(true);
		const scoped = calls.map((call) => call.body?.userId ?? new URL(call.url).searchParams.get("userId"));
		expect(new Set(scoped).size).toBe(1);
		expect(scoped[0]).toMatch(/^sdk-smoke-[0-9a-f-]{36}$/);
		expect(calls.filter((call) => new URL(call.url).pathname === "/v1/memories")).toHaveLength(2);
		expect(calls.at(-1).body.query).toContain(marker);
	});
});

describe("authentication and operation shapes", () => {
	it("sends Bearer auth, versioned user-agent, and fact/search bodies", async () => {
		const memory = client();
		await memory.add("I run daily.", { idempotencyKey: "idem_1" });
		await memory.search("running");

		expect(calls[0].url).toBe("https://api.example/v1/save");
		expect(calls[0].init.headers.authorization).toBe("Bearer itsuki_live_test");
		expect(calls[0].init.headers["user-agent"]).toBe("itsuki-js/0.2.1");
		expect(body(calls[0])).toEqual({ content: "I run daily.", idempotencyKey: "idem_1" });
		expect(calls[1].url).toBe("https://api.example/v1/recall");
		expect(body(calls[1])).toEqual({ query: "running" });
	});

	it("implements addConversation, turn, ingest, save, and recall aliases", async () => {
		const memory = client();
		const messages = [{ id: "m1", role: "user", content: "Remember Atlas." }];

		await memory.addConversation(messages, { conversationId: "conv-1" });
		await memory.turn(messages, { query: "Atlas?", idempotencyKey: "idem-turn" });
		await memory.ingest([], { flush: true, idempotencyKey: "idem-flush" });
		await memory.save("Alias fact");
		await memory.recall("Alias query");

		expect(body(calls[0])).toEqual({
			conversationId: "conv-1",
			mode: "conversation",
			messages,
		});
		expect(calls[1].url).toBe("https://api.example/v1/turn");
		expect(body(calls[1])).toEqual({ query: "Atlas?", idempotencyKey: "idem-turn", messages });
		expect(calls[2].url).toBe("https://api.example/v1/ingest");
		expect(body(calls[2])).toEqual({ flush: true, idempotencyKey: "idem-flush", messages: [] });
		expect(body(calls[3])).toEqual({ content: "Alias fact" });
		expect(body(calls[4])).toEqual({ query: "Alias query" });
	});

	it("passes project scope and recall policy without changing tenant identity", async () => {
		const memory = client();
		const memoryScope = { projectId: "atlas", projectName: "Atlas" };
		await memory.add("Atlas deploys from main.", { memoryScope });
		await memory.search("How does Atlas deploy?", { memoryScope, recallScope: "project_then_global" });

		expect(body(calls[0])).toEqual({ memoryScope, content: "Atlas deploys from main." });
		expect(body(calls[1])).toEqual({ memoryScope, recallScope: "project_then_global", query: "How does Atlas deploy?" });
		expect(calls[0].url).not.toContain("userId=");
	});

	it("does not let options replace primary method arguments", async () => {
		const memory = client();
		await expect(Promise.resolve().then(() => memory.add("safe", { content: "other" })))
			.rejects.toMatchObject({ code: "invalid_argument" });
		await expect(Promise.resolve().then(() => memory.search("safe", { query: "other" })))
			.rejects.toMatchObject({ code: "invalid_argument" });
		await expect(Promise.resolve().then(() => memory.ingest([], { messages: ["other"] })))
			.rejects.toMatchObject({ code: "invalid_argument" });
		expect(calls).toHaveLength(0);
	});
});

describe("userId and query scope", () => {
	it("puts POST tenant identity only in the body and GET identity only in the query", async () => {
		const memory = client({ userId: "default-user" });
		await memory.add("fact");
		await memory.status();

		expect(calls[0].url).toBe("https://api.example/v1/save");
		expect(body(calls[0]).userId).toBe("default-user");
		expect(new URL(calls[1].url).searchParams.get("userId")).toBe("default-user");
		expect(calls[1].init.body).toBeUndefined();
		expect(calls[1].init.headers["content-type"]).toBeUndefined();
	});

	it("per-call userId overrides a default across POST, GET, PUT, and DELETE", async () => {
		const memory = client({ userId: "default-user" });
		await memory.add("fact", { userId: "other-user" });
		await memory.graph({ userId: "other-user" });
		await memory.setRules({ autoCollect: false }, { userId: "other-user" });
		await memory.delete("slice/one", { userId: "other-user" });

		expect(body(calls[0]).userId).toBe("other-user");
		expect(new URL(calls[1].url).searchParams.get("userId")).toBe("other-user");
		expect(body(calls[2])).toEqual({ rules: { autoCollect: false }, userId: "other-user" });
		expect(calls[2].url).not.toContain("userId=");
		expect(new URL(calls[3].url).pathname).toBe("/v1/memories/slice%2Fone");
		expect(new URL(calls[3].url).searchParams.get("userId")).toBe("other-user");
	});

	it("an explicit null per-call userId selects the account root", async () => {
		const memory = client({ userId: "default-user" });
		await memory.add("root fact", { userId: null });
		await memory.status({ userId: null });
		await memory.setRules({}, { userId: null });

		expect(body(calls[0])).toEqual({ content: "root fact" });
		expect(new URL(calls[1].url).searchParams.has("userId")).toBe(false);
		expect(body(calls[2])).toEqual({ rules: {} });
	});

	it("preserves endpoint query fields with scoped reads", async () => {
		const memory = client({ userId: "tenant one" });
		await memory.receipts({ limit: 17 });
		await memory.usage({ range: "all" });
		await memory.jobs({ status: "processing", since: 123, limit: 9 });

		const receipts = new URL(calls[0].url);
		expect(Object.fromEntries(receipts.searchParams)).toEqual({ limit: "17", userId: "tenant one" });
		const usage = new URL(calls[1].url);
		expect(Object.fromEntries(usage.searchParams)).toEqual({ range: "all", userId: "tenant one" });
		const jobs = new URL(calls[2].url);
		expect(Object.fromEntries(jobs.searchParams)).toEqual({
			status: "processing",
			since: "123",
			limit: "9",
			userId: "tenant one",
		});
	});

	it("scopes packet status and both deletion modes", async () => {
		const memory = client();
		await memory.packetStatus("src/value", { userId: "ada" });
		await memory.deleteBySource({ source: "ingest lane", after: 100, userId: "ada" });
		await memory.deleteBySource({ source: "ingest lane", after: 100, confirm: true, userId: "ada" });

		expect(new URL(calls[0].url).pathname).toBe("/v1/packets/src%2Fvalue/status");
		const preview = Object.fromEntries(new URL(calls[1].url).searchParams);
		expect(preview).toEqual({ source: "ingest lane", after: "100", userId: "ada" });
		const confirmed = Object.fromEntries(new URL(calls[2].url).searchParams);
		expect(confirmed).toMatchObject({ confirm: "true", dry_run: "false", userId: "ada" });
	});
});

describe("retries and typed failures", () => {
	it("retries GETs on retryable server errors", async () => {
		stubFetch([
			{ status: 500, body: { error: "temporary" }, headers: { "retry-after": "0" } },
			{ status: 200, body: { ok: true, nodes: 1 } },
		]);
		const result = await client({ maxRetries: 1 }).status();
		expect(result.nodes).toBe(1);
		expect(calls).toHaveLength(2);
	});

	it("does not retry a write without an idempotency key", async () => {
		stubFetch([{ status: 500, body: { error: "temporary" } }]);
		await expect(client({ maxRetries: 2 }).add("x")).rejects.toMatchObject({
			status: 500,
			code: "temporary",
		});
		expect(calls).toHaveLength(1);
	});

	it("retries an idempotent write and honors a zero Retry-After", async () => {
		stubFetch([
			{ status: 429, body: { error: "too_many_requests" }, headers: { "retry-after": "0" } },
			{ status: 200, body: { ok: true } },
		]);
		await expect(client({ maxRetries: 1 }).add("x", { idempotencyKey: "idem_2" })).resolves.toEqual({ ok: true });
		expect(calls).toHaveLength(2);
	});

	it("does not let an untrusted Retry-After delay extend the total request budget", async () => {
		stubFetch([
			{ status: 429, body: { error: "too_many_requests" }, headers: { "retry-after": "3600" } },
			{ status: 200, body: { ok: true } },
		]);
		const started = Date.now();
		await expect(client({ maxRetries: 1, timeoutMs: 15 }).status()).rejects.toMatchObject({
			status: 429,
			code: "too_many_requests",
			retryAfterMs: 3_600_000,
		});
		expect(Date.now() - started).toBeLessThan(250);
		expect(calls).toHaveLength(1);
	});

	it("prefers the server code field and preserves body and Retry-After", async () => {
		stubFetch([{
			status: 429,
			body: { error: "rate_limited", code: "tenant_rate_limited", message: "Try later." },
			headers: { "retry-after": "2" },
		}]);
		const error = await client().status().catch((value) => value);
		expect(error).toBeInstanceOf(MemoryAPIError);
		expect(error).toMatchObject({
			status: 429,
			code: "tenant_rate_limited",
			body: { error: "rate_limited", code: "tenant_rate_limited", message: "Try later." },
			retryAfterMs: 2000,
			message: "Try later.",
		});
	});

	it("wraps transport failures in MemoryAPIError", async () => {
		stubFetch([{ throw: new TypeError("socket closed") }]);
		const error = await client().status().catch((value) => value);
		expect(error).toBeInstanceOf(MemoryAPIError);
		expect(error).toMatchObject({ status: 0, code: "transport_error", message: "request failed: socket closed" });
	});

	it("wraps total request-budget timeouts with a machine-readable code", async () => {
		calls = [];
		globalThis.fetch = vi.fn((url, init) => {
			calls.push({ url: String(url), init });
			return new Promise((resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});
		const error = await client({ timeoutMs: 5 }).status().catch((value) => value);
		expect(error).toMatchObject({ status: 0, code: "timeout" });
		expect(error.message).toMatch(/^request timed out after [1-5]ms$/);
	});

	it("wraps non-serializable request bodies before fetch", async () => {
		const error = await client().add("fact", { recentContext: 1n }).catch((value) => value);
		expect(error).toMatchObject({ status: 0, code: "invalid_argument" });
		expect(error.message).toMatch(/JSON-serializable/);
		expect(calls).toHaveLength(0);
	});
});

describe("status polling and local validation", () => {
	it.each(["enriched", "failed", "completed"])("treats %s as terminal", async (status) => {
		stubFetch([{ status: 200, body: { ok: true, status, source_packet_id: "src_1" } }]);
		const result = await client().waitFor("src_1", { timeoutMs: 0, userId: "ada" });
		expect(result.status).toBe(status);
		expect(result.timed_out).toBeUndefined();
		expect(new URL(calls[0].url).searchParams.get("userId")).toBe("ada");
		expect(calls).toHaveLength(1);
	});

	it("polls immediately at timeout zero and marks a nonterminal result timed out", async () => {
		stubFetch([{ status: 200, body: { ok: true, status: "processing" } }]);
		const result = await client().waitFor("src_1", { timeoutMs: 0 });
		expect(result).toMatchObject({ status: "processing", timed_out: true });
		expect(calls).toHaveLength(1);
	});

	it("rejects polling timers that exceed the runtime-safe bound", async () => {
		await expect(client().waitFor("src_1", { timeoutMs: 2_147_483_648 })).rejects.toMatchObject({
			code: "invalid_argument",
		});
		await expect(client().waitFor("src_1", { intervalMs: 2_147_483_648 })).rejects.toMatchObject({
			code: "invalid_argument",
		});
		expect(calls).toHaveLength(0);
	});

	it("does not oversleep or issue a late poll when interval exceeds the budget", async () => {
		stubFetch([{ status: 200, body: { ok: true, status: "processing" } }]);
		const started = Date.now();
		const result = await client().waitFor("src_1", { timeoutMs: 20, intervalMs: 10_000 });
		const elapsed = Date.now() - started;
		expect(result.timed_out).toBe(true);
		expect(calls).toHaveLength(1);
		expect(elapsed).toBeLessThan(250);
	});

	it("includes a slow status request in a positive polling budget", async () => {
		calls = [];
		globalThis.fetch = vi.fn((url, init) => {
			calls.push({ url: String(url), init });
			return new Promise((resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		});
		const started = Date.now();
		const result = await client({ timeoutMs: 500 }).waitFor("src_1", { timeoutMs: 20, intervalMs: 10 });
		expect(result).toMatchObject({ status: "unknown", timed_out: true });
		expect(Date.now() - started).toBeLessThan(250);
		expect(calls).toHaveLength(1);
	});

	it("rejects ambiguous inputs before any request", async () => {
		const memory = client();
		const cases = [
			() => memory.add(""),
			() => memory.addConversation([]),
			() => memory.turn([]),
			() => memory.search(" "),
			() => memory.packetStatus(""),
			() => memory.delete(""),
			() => memory.status({ user_id: "typo" }),
			() => memory.usage({ range: "90d" }),
			() => memory.jobs({ status: "done" }),
			() => memory.waitFor("src_1", { intervalMs: 0 }),
		];
		for (const operation of cases) {
			await expect(Promise.resolve().then(operation)).rejects.toMatchObject({ code: "invalid_argument" });
		}
		expect(calls).toHaveLength(0);
	});

	it("creates unique keys from both static and instance helpers", () => {
		const memory = client();
		const first = MemoryClient.newIdempotencyKey();
		expect(first).toMatch(/^idem_/);
		expect(memory.newIdempotencyKey()).toMatch(/^idem_/);
		expect(memory.newIdempotencyKey()).not.toBe(first);
	});
});
