import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function jsonRequest(path, body, headers = {}, runtimeEnv = env) {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	}, runtimeEnv);
}

function cookieFrom(response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function signup(prefix) {
	const response = await jsonRequest("/auth/signup", {
		email: `${prefix}-${crypto.randomUUID()}@example.com`,
		password: "correct-horse",
		name: prefix,
	});
	expect(response.status).toBe(201);
	const body = await response.json();
	return { user: body.user, cookie: cookieFrom(response) };
}

async function manualRowsFor(userId) {
	const row = await env.DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS source_packets,
			(SELECT COUNT(*) FROM extraction_runs WHERE user_id = ?) AS extraction_runs,
			(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts,
			(SELECT COUNT(*) FROM nodes WHERE user_id = ?) AS nodes,
			(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages,
			(SELECT COUNT(*) FROM candidates WHERE user_id = ?) AS candidates`,
	)
		.bind(userId, userId, userId, userId, userId, userId)
		.first();
	return { ...row };
}

describe("POST /v1/mcp/choose", () => {
	it("requires an authenticated host", async () => {
		const response = await jsonRequest("/v1/mcp/choose", {
			request: "Remember that I prefer dark mode.",
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("routes a scoped conversation without touching D1, Durable Objects, or Workers AI", async () => {
		const unavailable = (service) => ({
			get() {
				throw new Error(`${service} must not be touched by deterministic AutoChoose`);
			},
		});
		const readOnlyEnv = {
			API_KEY: env.API_KEY,
			get DB() {
				throw new Error("D1 must not be touched by legacy-key AutoChoose");
			},
			get USER_MEMORY() {
				return unavailable("USER_MEMORY");
			},
			get AI() {
				return unavailable("AI");
			},
		};
		const response = await jsonRequest(
			"/v1/mcp/choose",
			{
				userId: "host-user",
				request: "Save only what this chat says about Ziyad.",
				messages: [
					{ id: "u1", role: "user", content: "Ziyad is building UML.", ts: 10 },
					{ id: "a1", role: "assistant", content: "UML can use D1.", ts: 11 },
				],
				conversationId: "conversation-2",
				memoryScope: {
					appId: "host-app",
					authType: "spoofed",
					memoryUserId: "spoofed-memory-user",
					ownerUserId: "spoofed-owner",
					externalUserId: "spoofed-external-user",
				},
			},
			{ "x-api-key": env.API_KEY },
			readOnlyEnv,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			chosen_action: "save_conversation",
			reason_codes: expect.arrayContaining(["explicit_save_request", "conversation_scope"]),
			scope: {
				subject: "Ziyad",
				speakerScope: "user_only",
				includeAssistantFacts: false,
				excludeOtherPeople: true,
				includeContextForReferenceResolution: true,
			},
			tool_arguments: {
				conversationId: "conversation-2",
				memoryScope: {
					appId: "host-app",
					authType: "legacy",
					memoryUserId: "host-user",
					ownerUserId: "legacy",
					externalUserId: "host-user",
				},
				contentScope: { subject: "Ziyad" },
			},
		});
	});

	it("does not pre-authorize the selected tool or create memory-pipeline rows", async () => {
		const account = await signup("choose-scope");
		const tokenResponse = await jsonRequest(
			"/auth/tokens",
			{ type: "api", label: "Read-only host", scopes: ["memory:read"] },
			{ cookie: account.cookie },
		);
		expect(tokenResponse.status).toBe(201);
		const { token } = await tokenResponse.json();
		const bearer = { authorization: `Bearer ${token}` };
		const before = await manualRowsFor(account.user.id);

		const chosen = await jsonRequest(
			"/v1/mcp/choose",
			{ request: "Remember that I prefer dark mode." },
			bearer,
		);

		expect(chosen.status).toBe(200);
		expect(await chosen.json()).toMatchObject({
			chosen_action: "save_memory",
			tool_arguments: { content: "I prefer dark mode." },
		});
		expect(await manualRowsFor(account.user.id)).toEqual(before);

		const selectedTool = await jsonRequest(
			"/v1/save",
			{ content: "I prefer dark mode." },
			bearer,
		);
		expect(selectedTool.status).toBe(403);
		expect(await selectedTool.json()).toEqual({ error: "forbidden", code: "insufficient_scope" });
	});
});
