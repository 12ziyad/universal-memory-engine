/**
 * JS SDK unit tests — stubbed fetch, no network. Pins the auth header, body
 * shapes, sub-tenant propagation, retry policy (reads always; writes only
 * with an idempotencyKey), and typed errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryClient, MemoryAPIError } from "../sdk/js/index.js";

let calls;
function stubFetch(responses) {
	calls = [];
	let i = 0;
	globalThis.fetch = vi.fn(async (url, init) => {
		calls.push({ url: String(url), init });
		const spec = responses[Math.min(i++, responses.length - 1)];
		return new Response(JSON.stringify(spec.body ?? { ok: true }), {
			status: spec.status ?? 200,
			headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
		});
	});
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => stubFetch([{ status: 200, body: { ok: true } }]));

const client = () => new MemoryClient({ apiKey: "itsuki_live_test", baseUrl: "https://api.example", maxRetries: 2 });

describe("MemoryClient", () => {
	it("requires an apiKey", () => {
		expect(() => new MemoryClient({})).toThrow(MemoryAPIError);
	});

	it("sends Bearer auth and the right body for add/search", async () => {
		const m = client();
		await m.add("I run daily.", { idempotencyKey: "idem_1" });
		await m.search("running");
		expect(calls[0].url).toBe("https://api.example/v1/save");
		expect(calls[0].init.headers.authorization).toBe("Bearer itsuki_live_test");
		expect(JSON.parse(calls[0].init.body)).toMatchObject({ content: "I run daily.", idempotencyKey: "idem_1" });
		expect(calls[1].url).toBe("https://api.example/v1/recall");
		expect(JSON.parse(calls[1].init.body)).toEqual({ query: "running" });
	});

	it("propagates the sub-tenant userId into query and body", async () => {
		const m = new MemoryClient({ apiKey: "k", baseUrl: "https://api.example", userId: "end-user-7" });
		await m.status();
		await m.add("fact");
		expect(calls[0].url).toContain("userId=end-user-7");
		expect(JSON.parse(calls[1].init.body).userId).toBe("end-user-7");
	});

	it("passes project memory and recall scopes without turning them into userId", async () => {
		const m = client();
		const memoryScope = { projectId: "atlas", projectName: "Atlas" };
		await m.add("Atlas deploys from main.", { memoryScope });
		await m.search("How does Atlas deploy?", { memoryScope, recallScope: "project_then_global" });
		expect(JSON.parse(calls[0].init.body)).toMatchObject({ content: "Atlas deploys from main.", memoryScope });
		expect(JSON.parse(calls[1].init.body)).toEqual({
			query: "How does Atlas deploy?",
			memoryScope,
			recallScope: "project_then_global",
		});
		expect(calls[0].url).not.toContain("userId=");
	});

	it("retries GETs on 500 then succeeds", async () => {
		stubFetch([{ status: 500, body: { error: "boom" } }, { status: 200, body: { ok: true, nodes: 1 } }]);
		const res = await client().status();
		expect(res.nodes).toBe(1);
		expect(calls.length).toBe(2);
	});

	it("does NOT retry a write without an idempotencyKey", async () => {
		stubFetch([{ status: 500, body: { error: "boom" } }]);
		await expect(client().add("x")).rejects.toThrow(MemoryAPIError);
		expect(calls.length).toBe(1);
	});

	it("retries a write WITH an idempotencyKey", async () => {
		stubFetch([{ status: 429, body: { error: "too_many_requests" } }, { status: 200, body: { ok: true } }]);
		const res = await client().add("x", { idempotencyKey: "idem_2" });
		expect(res.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	it("throws typed errors with status and code on 4xx without retrying", async () => {
		stubFetch([{ status: 403, body: { error: "forbidden", code: "insufficient_scope" } }]);
		const error = await client().search("q").catch((e) => e);
		expect(error).toBeInstanceOf(MemoryAPIError);
		expect(error.status).toBe(403);
		expect(calls.length).toBe(1);
	});

	it("newIdempotencyKey returns unique idem_ keys", () => {
		const m = client();
		const a = m.newIdempotencyKey();
		expect(a).toMatch(/^idem_/);
		expect(m.newIdempotencyKey()).not.toBe(a);
	});
});
