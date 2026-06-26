/**
 * Simple recall tests — seed a real Boxing node (with slices + events) directly
 * in D1, then exercise /v1/recall end to end through the worker.
 *
 * The suite runs with USE_VECTORS=false (see vitest.config.js), so this proves
 * the KEYWORD half of recall on its own: query words matched against each node's
 * label / summary / slice + event text. The semantic (Vectorize) half is a clean
 * no-op here and is exercised live against the deployed worker.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function recall(userId, query) {
	const request = new Request("http://example.com/v1/recall", {
		method: "POST",
		headers,
		body: JSON.stringify({ userId, query }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

const userId = "u-recall";
const otherUserId = "u-recall-other";
const nodeId = "n-box";

describe("/v1/recall - simple recall", () => {
	beforeAll(async () => {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(nodeId, userId, "Boxing", "skill", null, "stopped", null, now, now),
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("s1", userId, nodeId, "trains three days a week", "progress", 1, now),
			// Superseded (is_current = 0) — must NOT come back in recall.
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("s0", userId, nodeId, "trains twice a week", "progress", 0, now - 5000),
			env.DB.prepare(
				"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind("e1", userId, nodeId, "started", "started boxing", "ordinary", now - 2000, now - 2000),
			env.DB.prepare(
				"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind("e2", userId, nodeId, "stopped", "stopped boxing", "ordinary", now, now),
		]);
	});

	it("finds Boxing by a direct keyword and returns its state, current slices and events", async () => {
		const { status, body } = await recall(userId, "boxing");
		expect(status).toBe(200);

		expect(body.nodes).toHaveLength(1);
		const node = body.nodes[0];
		expect(node).toMatchObject({ id: nodeId, label: "Boxing", category: "skill", state: "stopped" });

		// Only the current slice is returned (the superseded one is dropped).
		expect(node.slices).toHaveLength(1);
		expect(node.slices[0]).toMatchObject({ text: "trains three days a week", kind: "progress" });

		// Events come back newest-first.
		expect(node.events).toHaveLength(2);
		expect(node.events[0]).toMatchObject({ action: "stopped" });
		expect(node.events[1]).toMatchObject({ action: "started" });

		// Compact, readable context a chat model can use directly.
		expect(body.context).toContain("Boxing (skill, state: stopped)");
		expect(body.context).toContain("trains three days a week");
	});

	it("finds Boxing from an indirect query via its slice text ('what do I train')", async () => {
		const { status, body } = await recall(userId, "what do I train");
		expect(status).toBe(200);
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0]).toMatchObject({ id: nodeId, label: "Boxing" });
		expect(body.nodes[0].slices[0]).toMatchObject({ text: "trains three days a week" });
	});

	it("isolates users - a different userId recalls nothing", async () => {
		const { status, body } = await recall(otherUserId, "boxing");
		expect(status).toBe(200);
		expect(body).toEqual({ context: "", nodes: [] });
	});

	it("returns empty for an unrelated query", async () => {
		const { status, body } = await recall(userId, "remind me about cooking pasta tonight");
		expect(status).toBe(200);
		expect(body).toEqual({ context: "", nodes: [] });
	});
});
