/**
 * MCP server tests — the identity token (pure functions), the auth gate on the
 * /mcp route, and a smoke test that the Streamable HTTP handler builds the server
 * and lists the four tools. Tool *behavior* is covered by the engine tests
 * (recall.spec / extraction.spec) since the tools just call those paths.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { encodeMcpToken, decodeMcpToken } from "../src/mcp/server.js";

async function mcp(token, body) {
	const request = new Request(`http://example.com/mcp/${token}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function mcpJson(response) {
	const text = await response.text();
	const data = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.filter(Boolean)
		.at(-1);
	return JSON.parse(data || text);
}

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function jsonRequest(path, body, cookie) {
	return request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix = "mcp-user") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix });
	expect(res.status).toBe(201);
	const body = await res.json();
	return { user: body.user, cookie: cookieFrom(res) };
}

describe("MCP identity token", () => {
	it("round-trips userId + key", () => {
		const token = encodeMcpToken("user-42", "s3cret:with:colons");
		expect(decodeMcpToken(token)).toEqual({ userId: "user-42", key: "s3cret:with:colons" });
	});

	it("is URL-path safe (no +, /, =)", () => {
		const token = encodeMcpToken("user/with+odd=chars", "k");
		expect(token).not.toMatch(/[+/=]/);
		expect(decodeMcpToken(token).userId).toBe("user/with+odd=chars");
	});

	it("rejects garbage tokens", () => {
		expect(decodeMcpToken("not-base64-!!")).toBeNull();
		expect(decodeMcpToken(encodeMcpToken("", ""))).toBeNull();
	});
});

describe("/mcp auth gate", () => {
	it("rejects a token whose key is not the API key", async () => {
		const token = encodeMcpToken("someone", "wrong-key");
		const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(res.status).toBe(401);
	});

	it("rejects a malformed token", async () => {
		const res = await mcp("garbage", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		expect(res.status).toBe(401);
	});

	it("enforces scopes for live MCP connection tokens", async () => {
		const account = await signupAccount("mcp-scope");
		const created = await jsonRequest(
			"/auth/tokens",
			{ type: "mcp", label: "Read Only MCP", scopes: ["memory:read"] },
			account.cookie,
		);
		expect(created.status).toBe(201);
		const { token } = await created.json();

		const recall = await mcp(token, {
			jsonrpc: "2.0",
			id: 20,
			method: "tools/call",
			params: { name: "recall_memory", arguments: { query: "anything" } },
		});
		expect(recall.status).toBe(200);
		const recallBody = await mcpJson(recall);
		expect(recallBody.result.structuredContent).toMatchObject({
			ok: true,
			command_mode: "recall",
			source: "recall",
		});

		const save = await mcp(token, {
			jsonrpc: "2.0",
			id: 21,
			method: "tools/call",
			params: { name: "save_memory", arguments: { content: "I started fencing." } },
		});
		expect(save.status).toBe(200);
		const saveBody = await mcpJson(save);
		expect(saveBody.result.structuredContent).toMatchObject({
			ok: false,
			command_mode: "direct_save",
			source: "save_memory",
			error: "forbidden",
			code: "insufficient_scope",
			required_scope: "memory:write",
		});
		expect(saveBody.result.content).toHaveLength(1);
		expect(saveBody.result.content[0].text).toBe("Forbidden: token lacks required scope.");
		expect(saveBody.result.content[0].text).not.toContain("structuredContent");
		expect(saveBody.result.content[0].text).not.toContain("receipt_id");
	});
});

describe("/mcp Streamable HTTP handler", () => {
	const token = encodeMcpToken("mcp-user", env.API_KEY);

	it("initializes and reports the server identity", async () => {
		const res = await mcp(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("uml-memory");
	});

	it("lists the four memory tools", async () => {
		const res = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("save_memory");
		expect(text).toContain("observe_messages");
		expect(text).toContain("save_conversation");
		expect(text).toContain("recall_memory");
	});

	it("save_memory returns structured status, receipt, and source ids", async () => {
		const res = await mcp(token, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "save_memory", arguments: { content: "ok thanks" } },
		});
		expect(res.status).toBe(200);
		const body = await mcpJson(res);
		const result = body.result.structuredContent;
		expect(result).toMatchObject({
			ok: true,
			mode: "direct_save",
			source: "save_memory",
			fired: false,
			processing: false,
			receipt: { outcome: "ignored", source: "save_memory" },
		});
		expect(result.source_packet_id).toMatch(/^src_/);
		expect(result.receipt_id).toMatch(/^receipt_/);
		expect(body.result.content[0].text).toContain("Saved: 0");
	});

	it("observe_messages returns structured ignored/held status without duplicating engine logic", async () => {
		const res = await mcp(token, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "observe_messages",
				arguments: { messages: [{ id: "obs-1", role: "user", content: "hello" }], conversationId: "mcp-observe" },
			},
		});
		expect(res.status).toBe(200);
		const body = await mcpJson(res);
		const result = body.result.structuredContent;
		expect(result).toMatchObject({
			ok: true,
			mode: "observe_messages",
			source: "observe_messages",
			fired: false,
			processing: false,
			held: 0,
			skipped: 0,
			receipt: { outcome: "ignored", source: "observe_messages", source_mode: "auto_observe" },
		});
		expect(result.source_packet_id).toMatch(/^src_/);
		expect(result.receipt_id).toMatch(/^receipt_/);
	});

	it("save_conversation returns structured status, receipt, and source ids", async () => {
		const res = await mcp(token, {
			jsonrpc: "2.0",
			id: 45,
			method: "tools/call",
			params: {
				name: "save_conversation",
				arguments: {
					scope: "summary",
					conversationId: "mcp-save-conversation-contract",
					messages: [
						{ id: "conv-1", role: "user", content: "I decided to use D1 for UML storage." },
						{ id: "conv-2", role: "assistant", content: "Good call." },
					],
				},
			},
		});
		expect(res.status).toBe(200);
		const body = await mcpJson(res);
		const result = body.result.structuredContent;
		expect(result).toMatchObject({
			ok: true,
			mode: "conversation_collect",
			source: "save_conversation",
			fired: true,
			processing: false,
			receipt: {
				source: "save_conversation",
				source_mode: "manual_collect",
				saved: { pages: 1 },
			},
			counts: { pages: 1 },
		});
		expect(result.source_packet_id).toMatch(/^src_/);
		expect(result.receipt_id).toMatch(/^receipt_/);
		expect(body.result.content).toHaveLength(1);
		expect(body.result.content[0].text).toContain("memory page");
		expect(body.result.content[0].text).not.toContain("source_packet_id");
		expect(body.result.content[0].text).not.toContain("receipt_id");
		expect(body.result.content[0].text).not.toContain('"receipt"');
	});

	it("recall_memory returns structured recall result and receipt status", async () => {
		const res = await mcp(token, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "recall_memory", arguments: { query: "hi" } },
		});
		expect(res.status).toBe(200);
		const body = await mcpJson(res);
		const result = body.result.structuredContent;
		expect(result).toMatchObject({
			ok: true,
			command_mode: "recall",
			mode: "recall",
			source: "recall",
			recall_mode: "no_recall",
			status: "no_recall",
			processing: false,
			receipt: { outcome: "no_recall", source: "recall" },
			counts: { received: 1, items: 0, nodes: 0, pages: 0 },
		});
		expect(result.source_packet_id).toMatch(/^src_/);
		expect(result.receipt_id).toMatch(/^receipt_/);
		expect(body.result.content).toHaveLength(1);
		expect(body.result.content[0].text).toContain("No relevant memory found");
		expect(body.result.content[0].text).not.toContain("structured_result");
		expect(body.result.content[0].text).not.toContain("source_packet_id");
		expect(body.result.content[0].text).not.toContain("receipt_id");
		expect(body.result.content[0].text).not.toContain('"nodes"');
	});

	it("recall_memory text stays short when structuredContent has full context", async () => {
		const userId = "mcp-rich-recall";
		const richToken = encodeMcpToken(userId, env.API_KEY);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("mcp-rich-node", userId, "Boxing", "skill", "active", now, now),
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("mcp-rich-slice", userId, "mcp-rich-node", "trains five days a week", "progress", 1, now),
		]);

		const res = await mcp(richToken, {
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "recall_memory", arguments: { query: "boxing" } },
		});
		expect(res.status).toBe(200);
		const body = await mcpJson(res);
		const result = body.result.structuredContent;
		expect(result).toMatchObject({
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
		expect(result.context).toContain("trains five days a week");
		expect(body.result.content).toHaveLength(1);
		expect(body.result.content[0].text).toBe("Found relevant memory.");
		expect(body.result.content[0].text).not.toContain("trains five days a week");
		expect(body.result.content[0].text).not.toContain("source_packet_id");
		expect(body.result.content[0].text).not.toContain("receipt_id");
		expect(body.result.content[0].text).not.toContain('"nodes"');
	});
});
