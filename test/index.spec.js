import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

async function fetch(path, init) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("GET /health", () => {
	it("responds without requiring an api key", async () => {
		const response = await fetch("/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "memory-engine",
			version: "0.1.0",
		});
	});
});

describe("auth", () => {
	it("rejects requests missing x-api-key", async () => {
		const response = await fetch("/v1/status?userId=abc");
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("rejects requests with the wrong x-api-key", async () => {
		const response = await fetch("/v1/status?userId=abc", {
			headers: { "x-api-key": "wrong" },
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});
});

describe("v1 routes (with a valid api key)", () => {
	const headers = { "x-api-key": env.API_KEY };

	it("POST /v1/ingest accepts messages and reports whether it fired", async () => {
		const response = await fetch("/v1/ingest", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId: "abc", messages: [] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: true, fired: false });
	});

	it("POST /v1/ingest requires userId and messages[]", async () => {
		const response = await fetch("/v1/ingest", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId: "abc" }),
		});
		expect(response.status).toBe(400);
	});

	it("GET /v1/graph returns an empty graph", async () => {
		const response = await fetch("/v1/graph?userId=abc", { headers });
		expect(response.status).toBe(200);
		const graphBody = await response.json();
		expect(graphBody).toMatchObject({ nodes: [], pages: [], edges: [], candidates: [] });
		expect(graphBody.stats).toEqual({ pages: 0, nodes: 0, slices: 0, events: 0, edges: 0, candidates: 0 });
		expect(typeof graphBody.model).toBe("string");
		expect(Array.isArray(graphBody.models)).toBe(true);
	});

	it("POST /v1/recall returns empty memory for an unknown user", async () => {
		const response = await fetch("/v1/recall", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId: "abc", query: "hi" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ context: "", nodes: [] });
	});

	it("POST /v1/recall requires userId and query", async () => {
		const response = await fetch("/v1/recall", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId: "abc" }),
		});
		expect(response.status).toBe(400);
	});

	it("GET /v1/status returns real counts (zero for an unknown user)", async () => {
		const response = await fetch("/v1/status?userId=abc", { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			nodes: 0,
			pages: 0,
			slices: 0,
			events: 0,
			candidates: 0,
			lastCheckpoint: null,
		});
	});
});

describe("D1-backed data with user isolation", () => {
	const headers = { "x-api-key": env.API_KEY };
	const userId = "user-boxing";
	const otherUserId = "user-someone-else";
	const nodeId = "node-boxing";
	const now = Date.now();

	beforeAll(async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
				userId,
				"boxer@example.com",
				now,
			),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(nodeId, userId, "Boxing", "habit", "active", now, now),
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("slice-1", userId, nodeId, "trains three days a week", "progress", 1, now),
			env.DB.prepare(
				"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind("event-1", userId, nodeId, "started", "started boxing", "ordinary", now, now),
		]);
	});

	it("GET /v1/graph returns the node with its current slice and event nested", async () => {
		const response = await fetch(`/v1/graph?userId=${userId}`, { headers });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.edges).toEqual([]);
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0]).toMatchObject({
			id: nodeId,
			user_id: userId,
			label: "Boxing",
			category: "habit",
		});
		expect(body.nodes[0].slices).toHaveLength(1);
		expect(body.nodes[0].slices[0]).toMatchObject({ text: "trains three days a week" });
		expect(body.nodes[0].events).toHaveLength(1);
		expect(body.nodes[0].events[0]).toMatchObject({ action: "started", text: "started boxing" });
	});

	it("GET /v1/status returns real counts for the user", async () => {
		const response = await fetch(`/v1/status?userId=${userId}`, { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			nodes: 1,
			pages: 0,
			slices: 1,
			events: 1,
			candidates: 0,
			lastCheckpoint: null,
		});
	});

	it("isolates data so a different userId sees nothing", async () => {
		const graphResponse = await fetch(`/v1/graph?userId=${otherUserId}`, { headers });
		expect(await graphResponse.json()).toMatchObject({ nodes: [], pages: [], edges: [], candidates: [] });

		const statusResponse = await fetch(`/v1/status?userId=${otherUserId}`, { headers });
		expect(await statusResponse.json()).toEqual({
			nodes: 0,
			pages: 0,
			slices: 0,
			events: 0,
			candidates: 0,
			lastCheckpoint: null,
		});
	});
});

describe("unknown routes", () => {
	it("returns a JSON 404", async () => {
		const response = await fetch("/nope");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not found" });
	});
});
