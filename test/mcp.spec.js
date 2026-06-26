/**
 * MCP server tests — the identity token (pure functions), the auth gate on the
 * /mcp route, and a smoke test that the Streamable HTTP handler builds the server
 * and lists the three tools. Tool *behavior* is covered by the engine tests
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

	it("lists the three memory tools", async () => {
		const res = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("save_memory");
		expect(text).toContain("save_conversation");
		expect(text).toContain("recall_memory");
	});
});
