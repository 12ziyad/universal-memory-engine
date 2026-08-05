import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import { encodeMcpToken } from "../src/mcp/server.js";

async function request(path, init = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function post(path, body) {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
		body: JSON.stringify(body),
	});
}

async function mcpCall(userId, name, args, id) {
	const token = encodeMcpToken(userId, env.API_KEY);
	const response = await request(`/mcp/${token}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	const text = await response.text();
	const event = text.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean)
		.at(-1);
	return { status: response.status, body: JSON.parse(event || text) };
}

describe("project memory crosses doors without becoming another tenant", () => {
	it("shares hook-like writes with MCP/graph and MCP writes with SessionStart recall", async () => {
		const userId = `cross-door-project-${crypto.randomUUID()}`;
		const alpha = { projectId: "alpha", projectName: "Shared Name", appId: "claude-code-plugin" };
		const beta = { projectId: "beta", projectName: "Shared Name", appId: "claude-code-plugin" };

		const saved = await post("/v1/ingest", {
			userId,
			source: "plugin",
			flush: true,
			conversationId: "claude-alpha-session",
			memoryScope: alpha,
			messages: [{
				id: "claude-alpha-message",
				role: "user",
				content: "We decided the Alpha crossdoor canary deploys through a blue queue.",
			}],
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Alpha crossdoor canary", category: "project", confidence: 0.99 },
						{ kind: "slice", on: "Alpha crossdoor canary", text: "Deploys through a blue queue", kind_detail: "decision", confidence: 0.99 },
					],
					notes: "",
				},
			},
		});
		expect(saved.status).toBe(200);
		const savedBody = await saved.json();
		expect(savedBody.memory_scope).toMatchObject({ project_id: "alpha", project_name: "Shared Name" });

		const status = await request(
			`/v1/packets/${encodeURIComponent(savedBody.source_packet_id)}/status?userId=${encodeURIComponent(userId)}`,
			{ headers: { "x-api-key": env.API_KEY } },
		);
		expect(await status.json()).toMatchObject({
			status: "enriched",
			project_id: "alpha",
			project_name: "Shared Name",
		});

		const mcpRecall = await mcpCall(userId, "recall_memory", {
			query: "How does the Alpha crossdoor canary deploy?",
			memoryScope: alpha,
			recallScope: "project_only",
		}, 1);
		expect(mcpRecall.status).toBe(200);
		expect(mcpRecall.body.result.structuredContent.context).toContain("blue queue");
		expect(mcpRecall.body.result.structuredContent.nodes).toEqual([
			expect.objectContaining({ project_id: "alpha", project_name: "Shared Name" }),
		]);

		const graph = await request(`/v1/graph?userId=${encodeURIComponent(userId)}`, {
			headers: { "x-api-key": env.API_KEY },
		});
		const graphBody = await graph.json();
		expect(graphBody.nodes).toEqual([
			expect.objectContaining({ label: "Alpha crossdoor canary", project_id: "alpha" }),
		]);
		expect(graphBody.projects).toContainEqual(expect.objectContaining({ project_id: "alpha", nodes: 1, slices: 1 }));

		const mcpSave = await mcpCall(userId, "save_conversation", {
			conversationId: "mcp-beta-session",
			idempotencyKey: "mcp-beta-crossdoor",
			memoryScope: beta,
			messages: [{
				id: "mcp-beta-message",
				role: "user",
				content: "We decided the Zephyrvault beta canary uses the amber release rail.",
			}],
		}, 2);
		expect(mcpSave.status).toBe(200);
		expect(mcpSave.body.result.structuredContent).toMatchObject({
			ok: true,
			processing: true,
			project_id: "beta",
			project_name: "Shared Name",
		});

		const sessionStartRecall = await post("/v1/recall", {
			userId,
			query: "What release rail does Zephyrvault use?",
			memoryScope: beta,
			recallScope: "project_then_global",
		});
		expect(sessionStartRecall.status).toBe(200);
		const sessionStartBody = await sessionStartRecall.json();
		expect(sessionStartBody.context).toContain("amber release rail");
		expect(sessionStartBody.context).not.toContain("blue queue");

		const wrongProject = await post("/v1/recall", {
			userId,
			query: "Zephyrvault amber release rail",
			memoryScope: alpha,
			recallScope: "project_only",
		});
		expect((await wrongProject.json()).context).not.toContain("Zephyrvault");

		const beforeInvalid = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ? AND source_mode = 'recall'",
		).bind(userId).first();
		const invalid = await post("/v1/recall", {
			userId,
			query: "anything",
			recallScope: "project_only",
		});
		expect(invalid.status).toBe(400);
		const invalidBody = await invalid.json();
		expect(invalidBody).toMatchObject({ ok: false, code: "project_id_required", source_packet_id: null });
		expect(JSON.stringify(invalidBody)).not.toMatch(/\bat\s+\S+\.js:\d+/);
		const afterInvalid = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ? AND source_mode = 'recall'",
		).bind(userId).first();
		expect(afterInvalid.n).toBe(beforeInvalid.n);

		const overlongProject = await post("/v1/recall", {
			userId,
			query: "anything",
			memoryScope: { projectId: "x".repeat(161) },
			recallScope: "project_only",
		});
		expect(overlongProject.status).toBe(400);
		expect(await overlongProject.json()).toMatchObject({
			error: "project_id_too_long",
			code: "project_id_too_long",
		});
	});

	it("shares SDK and dashboard saves with plugin recall while isolating accounts", async () => {
		const accountA = `cross-door-account-a-${crypto.randomUUID()}`;
		const accountB = `cross-door-account-b-${crypto.randomUUID()}`;
		const project = {
			projectId: "same-project-id",
			projectName: "Same Project Name",
			appId: "claude-code-plugin",
		};

		// Node/Python SDKs both send this /v1/save shape. Keep the project metadata
		// intact so the plugin's SessionStart recall can read it through another door.
		const sdkSave = await post("/v1/save", {
			userId: accountA,
			content: "The SDK bridge canary uses the violet deployment lane.",
			memoryScope: project,
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "SDK bridge canary", category: "project", confidence: 0.99 },
						{ kind: "slice", on: "SDK bridge canary", text: "Uses the violet deployment lane", kind_detail: "decision", confidence: 0.99 },
					],
					notes: "",
				},
			},
		});
		expect(sdkSave.status).toBe(200);
		expect(await sdkSave.json()).toMatchObject({
			ok: true,
			memory_scope: { project_id: "same-project-id", project_name: "Same Project Name" },
		});

		const pluginRecallOfSdk = await post("/v1/recall", {
			userId: accountA,
			query: "Which deployment lane does the SDK bridge canary use?",
			memoryScope: project,
			recallScope: "project_then_global",
		});
		expect((await pluginRecallOfSdk.json()).context).toContain("violet deployment lane");

		// The dashboard's Quick Test save is account-global. Project-then-global is
		// the documented plugin policy, so a later SessionStart must still see it.
		const dashboardSave = await post("/v1/save", {
			userId: accountA,
			content: "The dashboard bridge canary uses the silver release train.",
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Dashboard bridge canary", category: "project", confidence: 0.99 },
						{ kind: "slice", on: "Dashboard bridge canary", text: "Uses the silver release train", kind_detail: "decision", confidence: 0.99 },
					],
					notes: "",
				},
			},
		});
		expect(dashboardSave.status).toBe(200);
		expect(await dashboardSave.json()).toMatchObject({
			ok: true,
			memory_scope: { project_id: null, project_name: null },
		});

		const pluginRecallOfDashboard = await post("/v1/recall", {
			userId: accountA,
			query: "Which release train does the dashboard bridge canary use?",
			memoryScope: project,
			recallScope: "project_then_global",
		});
		expect((await pluginRecallOfDashboard.json()).context).toContain("silver release train");

		// Identical project metadata in another authenticated account is still a
		// different private graph. Neither project nor account-global rows cross it.
		const otherAccountRecall = await post("/v1/recall", {
			userId: accountB,
			query: "violet deployment lane silver release train",
			memoryScope: project,
			recallScope: "project_then_global",
		});
		const otherAccountBody = await otherAccountRecall.json();
		expect(otherAccountBody.context).not.toContain("violet deployment lane");
		expect(otherAccountBody.context).not.toContain("silver release train");
	});
});
