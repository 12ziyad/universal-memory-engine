/**
 * MCP door rate limiting — the refusal is a tool RESULT, never a transport 429.
 *
 * A transport-level 429 tears down the MCP connection: the client reports a
 * broken server and the model never reads why. So over-limit tool calls return
 * a normal JSON-RPC result with isError + a readable sentence, the same shape
 * queue_full already uses on this door.
 *
 * The limiter key is the authenticated credential + bound project
 * (managedActorRateKey), never the caller-supplied memoryScope — rotating
 * attribution must not buy a fresh bucket. wrangler.test.jsonc declares no
 * limiter bindings, so every test stubs env.<LIMITER> explicitly.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../src";

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
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix, acceptTerms: true });
	expect(res.status).toBe(201);
	return { user: (await res.json()).user, cookie: cookieFrom(res) };
}

async function mintMcpToken(prefix) {
	const account = await signupAccount(prefix);
	const created = await jsonRequest(
		"/auth/tokens",
		{ type: "mcp", label: "rate-limit test", scopes: ["memory:read", "memory:write"] },
		account.cookie,
	);
	expect(created.status).toBe(201);
	return (await created.json()).token;
}

async function mcpCall(token, id, name, args = {}) {
	const res = await request(`/mcp/${token}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
	});
	return res;
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

/** A limiter stub that records every key and refuses everything. */
function refusingLimiter(seen) {
	return { limit: async ({ key }) => { seen.push(key); return { success: false }; } };
}

/** A limiter stub that records every key and allows everything. */
function allowingLimiter(seen) {
	return { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
}

const LIMITER_NAMES = ["SAVE_LIMITER", "DELETE_LIMITER", "READ_LIMITER", "RECALL_LIMITER", "IMPORT_LIMITER", "AUTH_LIMITER"];
const saved = {};

beforeEach(() => {
	for (const name of LIMITER_NAMES) saved[name] = env[name];
});

afterEach(() => {
	for (const name of LIMITER_NAMES) {
		if (saved[name] === undefined) delete env[name];
		else env[name] = saved[name];
	}
});

describe("MCP tool rate limiting", () => {
	it("save_memory over limit returns a soft isError result, not a transport 429", async () => {
		const token = await mintMcpToken("mcp-rl-save");
		const seen = [];
		env.SAVE_LIMITER = refusingLimiter(seen);

		const res = await mcpCall(token, 1, "save_memory", { content: "I started fencing." });
		expect(res.status).toBe(200); // transport survives — this is the point
		const body = await mcpJson(res);
		expect(body.result.isError).toBe(true);
		expect(body.result.structuredContent).toMatchObject({
			ok: false,
			command_mode: "direct_save",
			source: "save_memory",
			error: "rate_limited",
			code: "rate_limited",
			http_status: 429,
			retry_after_s: 60,
			receipt_id: null,
		});
		expect(body.result.content[0].text).toContain("very quickly");
		// Nothing was saved and nothing claims it was.
		expect(body.result.content[0].text).not.toContain("Saved");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/^mcp-save:token:/);
		expect(seen[0]).toContain(":project:");
	});

	it("save_conversation shares the save bucket", async () => {
		const token = await mintMcpToken("mcp-rl-conv");
		const seen = [];
		env.SAVE_LIMITER = refusingLimiter(seen);

		const res = await mcpCall(token, 2, "save_conversation", {
			messages: [{ role: "user", content: "Remember that I prefer tea." }],
		});
		const body = await mcpJson(res);
		expect(body.result.isError).toBe(true);
		expect(body.result.structuredContent.error).toBe("rate_limited");
		expect(seen[0]).toMatch(/^mcp-save:token:/);
	});

	it("delete tools use the DELETE bucket and refuse without deleting", async () => {
		const token = await mintMcpToken("mcp-rl-del");
		const seen = [];
		env.DELETE_LIMITER = refusingLimiter(seen);

		const one = await mcpJson(await mcpCall(token, 3, "delete_memory", { id: "node_nonexistent" }));
		expect(one.result.isError).toBe(true);
		expect(one.result.structuredContent).toMatchObject({ error: "rate_limited", source: "delete_memory" });

		const all = await mcpJson(await mcpCall(token, 4, "delete_all_memories", { confirm: true }));
		expect(all.result.isError).toBe(true);
		expect(all.result.structuredContent).toMatchObject({ error: "rate_limited", source: "delete_all_memories" });

		expect(seen).toHaveLength(2);
		for (const key of seen) expect(key).toMatch(/^mcp-del:token:.*:project:/);
	});

	it("inventory reads and whoami use the READ bucket", async () => {
		const token = await mintMcpToken("mcp-rl-read");
		const seen = [];
		env.READ_LIMITER = refusingLimiter(seen);

		for (const [id, name, args] of [
			[5, "list_memories", {}],
			[6, "get_memory", { id: "node_x" }],
			[7, "whoami", {}],
		]) {
			const body = await mcpJson(await mcpCall(token, id, name, args));
			expect(body.result.isError).toBe(true);
			expect(body.result.structuredContent.error).toBe("rate_limited");
		}
		expect(seen).toHaveLength(3);
		for (const key of seen) expect(key).toMatch(/^mcp-read:token:.*:project:/);
	});

	it("recall_memory is limited by RECALL_LIMITER only — no double charge", async () => {
		const token = await mintMcpToken("mcp-rl-recall");
		const saveSeen = [];
		const readSeen = [];
		const recallSeen = [];
		env.SAVE_LIMITER = allowingLimiter(saveSeen);
		env.READ_LIMITER = allowingLimiter(readSeen);
		env.RECALL_LIMITER = allowingLimiter(recallSeen);

		const body = await mcpJson(await mcpCall(token, 8, "recall_memory", { query: "tea" }));
		expect(body.result.structuredContent.ok).toBe(true);
		expect(recallSeen).toHaveLength(1);
		expect(saveSeen).toHaveLength(0);
		expect(readSeen).toHaveLength(0);
	});

	it("rotating caller-supplied memoryScope does not buy a fresh bucket", async () => {
		const token = await mintMcpToken("mcp-rl-rotate");
		const seen = [];
		env.SAVE_LIMITER = refusingLimiter(seen);

		// The caller-supplied ids must be impossible substrings of the server's
		// own bound project id (proj_ + 32 hex chars): "proj_a"/"proj_b" matched
		// a legitimate proj_a…/proj_b… hex id one run in eight, failing the
		// not.toContain below against the SERVER's id rather than the caller's.
		await mcpCall(token, 9, "save_memory", { content: "fact one", memoryScope: { projectId: "proj_caller_alpha" } });
		await mcpCall(token, 10, "save_memory", { content: "fact two", memoryScope: { projectId: "proj_caller_beta" } });

		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]); // same credential, same bucket — attribution cannot rotate it
		expect(seen[0]).not.toContain("proj_caller_alpha");
		expect(seen[0]).not.toContain("proj_caller_beta");
	});

	it("a permission refusal consumes no limiter budget", async () => {
		const account = await signupAccount("mcp-rl-scope");
		const created = await jsonRequest(
			"/auth/tokens",
			{ type: "mcp", label: "read only", scopes: ["memory:read"] },
			account.cookie,
		);
		const readOnly = (await created.json()).token;
		const seen = [];
		env.SAVE_LIMITER = refusingLimiter(seen);

		// A read-only connection is not offered save_memory at all, so the call
		// is refused before any handler runs. Either refusal shape is correct;
		// what this test protects is that a refusal never spends limiter budget
		// (otherwise an unauthorized caller could exhaust a legitimate one's).
		const body = await mcpJson(await mcpCall(readOnly, 11, "save_memory", { content: "nope" }));
		const refused = Boolean(body.error)
			|| body.result?.isError === true
			|| body.result?.structuredContent?.ok === false;
		expect(refused, JSON.stringify(body).slice(0, 200)).toBe(true);
		expect(seen).toHaveLength(0); // forbidden before the limiter runs
	});
});
