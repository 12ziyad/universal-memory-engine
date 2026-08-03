/**
 * Part 4 — add_conversation runs the Engine v2 path.
 *
 * The old third door (manual_collect) digested a conversation into one flat
 * memory page: no nodes, no edges, no bi-temporal graph. Rerouted, the same
 * call produces the graph the other doors produce.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

describe("add_conversation on Engine v2", () => {
	it("a rich 7-message conversation produces nodes AND edges", async () => {
		const userId = `conv-engine-${crypto.randomUUID()}`;
		const res = await call("/v1/save", {
			userId,
			mode: "conversation",
			conversationId: "rich-7",
			messages: [
				{ id: "c1", role: "user", content: "I just joined Halcyon Robotics as a controls engineer" },
				{ id: "c2", role: "assistant", content: "Congratulations!" },
				{ id: "c3", role: "user", content: "My manager there is Priya Nair" },
				{ id: "c4", role: "user", content: "The office is in Eindhoven" },
				{ id: "c5", role: "assistant", content: "Sounds like a good setup." },
				{ id: "c6", role: "user", content: "I also started evening welding classes" },
				{ id: "c7", role: "user", content: "ok that's all" },
			],
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Halcyon Robotics", category: "organization", matches_existing: null, confidence: 0.95 },
						{ kind: "node", label: "Priya Nair", category: "person", matches_existing: null, confidence: 0.95 },
						{ kind: "slice", on: "Halcyon Robotics", text: "Joined as a controls engineer", kind_detail: "progress", confidence: 0.9 },
						{ kind: "slice", on: "Priya Nair", text: "Manager at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
						{ kind: "edge", from: "Priya Nair", to: "Halcyon Robotics", type: "part_of", confidence: 0.9 },
					],
					notes: "",
				},
				edgeResponse: { edges: [] },
				reflexionResponse: { entities: [], facts: [], edges: [] },
			},
		});
		expect(res.status).toBe(200);
		expect(res.body.mode).toBe("conversation_collect");
		expect(res.body.fired).toBe(true);

		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		const { results: edges } = await env.DB.prepare(
			"SELECT type FROM edges WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes.length).toBeGreaterThanOrEqual(2); // nodes AND ...
		expect(edges.length).toBeGreaterThanOrEqual(1); // ... edges — the old lane produced neither

		// The accept-time ledger covers this lane like every other (Part 1.1).
		const job = await env.DB.prepare(
			"SELECT status, payload_json FROM memory_jobs WHERE user_id = ? AND type = 'extract'",
		).bind(userId).first();
		expect(job).toBeTruthy();
		expect(job.status).toBe("enriched");
		expect(JSON.parse(job.payload_json).lane).toBe("conversation_collect");
	}, 30000);

	it("the legacy digest lane survives only as its test-hook alias", async () => {
		const userId = `conv-legacy-${crypto.randomUUID()}`;
		const res = await call("/v1/save", {
			userId,
			mode: "conversation",
			conversationId: "legacy-1",
			messages: [{ id: "l1", role: "user", content: "Itsuki runs on Cloudflare with D1." }],
			_test: { digestResponse: "Itsuki runs on Cloudflare with D1." },
		});
		expect(res.status).toBe(200);
		const { results: pages } = await env.DB.prepare(
			"SELECT id FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(pages.length).toBe(1); // page, not graph — the deprecated shape
	}, 30000);
});
