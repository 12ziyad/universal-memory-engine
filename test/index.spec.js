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
		expect(await response.json()).toMatchObject({
			received: true,
			ok: true,
			mode: "observe_messages",
			fired: false,
			processing: false,
			held: 0,
			skipped: 0,
			receipt: { outcome: "ignored", source: "ingest" },
		});
	});

	it("POST /v1/ingest returns an accepted receipt when extraction fires asynchronously", async () => {
		const response = await fetch("/v1/ingest", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({
				userId: "abc-ingest-accepted",
				flush: true,
				messages: [{ id: "m1", role: "user", content: "I started boxing today." }],
				_test: {
					llmResponse: {
						objects: [
							{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
							{ kind: "event", on: "Boxing", action: "started", text: "Started boxing", importance: "ordinary", confidence: 0.95 },
						],
						notes: "",
					},
				},
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			mode: "observe_messages",
			source: "ingest",
			received: true,
			fired: true,
			processing: true,
			held: 1,
			skipped: 0,
			receipt: {
				outcome: "accepted",
				source: "ingest",
				processing: true,
				final: false,
				status: "processing",
			},
		});
		expect(body.source_packet_id).toMatch(/^src_/);
		expect(body.receipt_id).toMatch(/^receipt_/);
		expect(body.summary).toContain("Accepted:");
	});

	it("POST /v1/ingest requires userId and messages[]", async () => {
		const response = await fetch("/v1/ingest", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId: "abc" }),
		});
		expect(response.status).toBe(400);
	});

	it("POST /v1/save returns an accepted receipt when direct save continues asynchronously", async () => {
		const response = await fetch("/v1/save", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({
				userId: "abc-save-accepted",
				content: "I started learning Rust today.",
				_test: {
					waitBudgetMs: 0,
					llmResponse: {
						objects: [
							{ kind: "node", label: "Rust", category: "skill", confidence: 0.95 },
							{ kind: "event", on: "Rust", action: "started", text: "Started learning Rust", importance: "ordinary", confidence: 0.95 },
						],
						notes: "",
					},
				},
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			command_mode: "direct_save",
			mode: "direct_save",
			source: "save_memory",
			fired: true,
			processing: true,
			receipt: {
				outcome: "accepted",
				source: "save_memory",
				processing: true,
				final: false,
				status: "processing",
			},
		});
		expect(body.receipt).not.toBeNull();
		expect(body.source_packet_id).toMatch(/^src_/);
		expect(body.receipt_id).toMatch(/^receipt_/);
		expect(body.summary).toContain("Accepted:");
	});

	it("POST /v1/save returns normalized safe fields for a completed direct save", async () => {
		const response = await fetch("/v1/save", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({
				userId: "abc-save-normalized",
				content: "I started learning TypeScript today.",
				_test: {
					llmResponse: {
						objects: [
							{ kind: "node", label: "TypeScript", category: "skill", confidence: 0.95 },
							{ kind: "event", on: "TypeScript", action: "started", text: "Started learning TypeScript", importance: "ordinary", confidence: 0.95 },
						],
						notes: "",
					},
				},
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			command_mode: "direct_save",
			mode: "direct_save",
			source: "save_memory",
			fired: true,
			processing: false,
			receipt: {
				source: "save_memory",
				saved: { nodes: 1, events: 1 },
			},
			counts: { nodes: 1, events: 1 },
		});
		expect(body.counts.savedTotal).toBeGreaterThanOrEqual(2);
		expect(body.source_packet_id).toMatch(/^src_/);
		expect(body.receipt_id).toMatch(/^receipt_/);
		expect(body.summary).toContain("Saved:");
	});

	it("GET /v1/graph returns an empty graph", async () => {
		const response = await fetch("/v1/graph?userId=abc", { headers });
		expect(response.status).toBe(200);
		const graphBody = await response.json();
		expect(graphBody).toMatchObject({ nodes: [], pages: [], edges: [], candidates: [] });
		expect(graphBody.stats).toEqual({ pages: 0, nodes: 0, clusters: 0, slices: 0, events: 0, edges: 0, candidates: 0 });
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
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			command_mode: "recall",
			mode: "recall",
			source: "recall",
			recall_mode: "no_recall",
			status: "no_recall",
			processing: false,
			context: "",
			nodes: [],
			pages: [],
			items: [],
			count: 0,
			receipt: { outcome: "no_recall", source: "recall" },
			counts: { received: 1, items: 0, nodes: 0, pages: 0 },
			vector_used: false,
			lexical_used: false,
			graph_expansion_used: false,
			compressed: false,
		});
		expect(body.source_packet_id).toMatch(/^src_/);
		expect(body.receipt_id).toMatch(/^receipt_/);
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
			visual_type: "node",
			cluster_id: "fitness_habits",
		});
		expect(typeof body.nodes[0].x).toBe("number");
		expect(typeof body.nodes[0].y).toBe("number");
		expect(body.nodes[0].radius).toBeGreaterThan(0);
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

	it("POST /v1/recall returns a short summary for non-empty recall", async () => {
		const response = await fetch("/v1/recall", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ userId, query: "boxing" }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			command_mode: "recall",
			mode: "recall",
			source: "recall",
			summary: "Found relevant memory.",
			recall_mode: "light_recall",
			status: "recalled",
			count: 1,
			counts: { received: 1, items: 1, nodes: 1, pages: 0 },
		});
		expect(body.context).toContain("Boxing (habit, state: active)");
		expect(body.context).toContain("trains three days a week");
		expect(body.summary).not.toContain("trains three days a week");
		expect(body.summary).not.toBe(body.context);
		expect(body.source_packet_id).toMatch(/^src_/);
		expect(body.receipt_id).toMatch(/^receipt_/);
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

describe("graph layout for memory pages", () => {
	const headers = { "x-api-key": env.API_KEY };
	const userId = "user-layout-page";
	const now = Date.now();

	beforeAll(async () => {
		await env.DB.prepare(
			`INSERT INTO memory_pages
			 (id, user_id, source_mode, title, canonical_title, short_summary, key_points_json,
			  related_concepts_json, created_at, updated_at, heat_score, cluster)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"page-layout",
				userId,
				"manual_collect",
				"UML Run 3.2 Memory Pages and Graph UX",
				"uml run 3 2 memory pages and graph ux",
				"Memory pages and graph UX.",
				JSON.stringify(["Backend layout", "Card nodes"]),
				JSON.stringify(["UML", "Graph UX"]),
				now,
				now,
				4,
				"projects_systems",
			)
			.run();
	});

	it("GET /v1/graph returns page visual layout data", async () => {
		const response = await fetch(`/v1/graph?userId=${userId}`, { headers });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.pages).toHaveLength(1);
		expect(body.pages[0]).toMatchObject({
			id: "page-layout",
			visual_type: "page",
			cluster_id: "projects_systems",
			cluster_name: "Projects & Systems",
		});
		expect(typeof body.pages[0].x).toBe("number");
		expect(typeof body.pages[0].y).toBe("number");
		expect(body.pages[0].radius).toBeGreaterThan(30);
		expect(body.clusters[0].display_label).toContain("Projects & Systems");
	});
});

describe("unknown routes", () => {
	it("returns a JSON 404", async () => {
		const response = await fetch("/nope");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not found" });
	});
});
