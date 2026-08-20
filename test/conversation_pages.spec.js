/**
 * Conversation Pages — deterministic conversation identity on the explicit
 * conversation doors (Campaign A gap-pinning suite, written failing-first).
 *
 * Target contract:
 *   - a stable explicit conversationId converges to ONE Conversation Page in
 *     the resolved memory space; a later explicit batch ADVANCES that page as
 *     a forward revision (never a silent duplicate page)
 *   - REST /v1/save mode:"conversation" (the SDK/n8n door) creates or
 *     advances a Conversation Page too — not only the MCP door
 *   - captureDefault "graph_only" ("Never build pages") suppresses the page
 *     entirely while graph extraction still runs
 *   - the same words in DIFFERENT conversations remain distinct pages
 *   - each advance links its source packet in conversation_page_sources
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import { saveMemoryRules } from "../src/pipeline/rules.js";
import worker from "../src/index.js";

const T0 = Date.parse("2026-08-02T09:00:00Z");

const CANNED = {
	llmResponse: {
		objects: [
			{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
			{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
		],
		notes: "",
	},
	edgeResponse: { edges: [] },
	reflexionResponse: { entities: [], facts: [], edges: [] },
	titleResponse: { title: "Job At Halcyon Robotics" },
};

const CANNED_GROWN = {
	...CANNED,
	llmResponse: {
		objects: [
			{ kind: "node", label: "Porto", category: "place", confidence: 0.9 },
			{ kind: "slice", on: "Porto", text: "Sister Nadia moved to Porto", kind_detail: "other", confidence: 0.9 },
		],
		notes: "",
	},
};

function batchOne() {
	return [
		{ id: "c1", role: "user", content: "I started a new job at Halcyon Robotics as a firmware engineer.", ts: T0 },
		{ id: "c2", role: "assistant", content: "Congratulations on the new role!", ts: T0 + 60_000 },
	];
}

function batchGrown() {
	return [
		...batchOne(),
		{ id: "c3", role: "user", content: "My sister Nadia moved to Porto last month.", ts: T0 + 120_000 },
	];
}

async function stage(userId, messages, input = {}, overrides = {}) {
	const ctx = createExecutionContext();
	const res = await stageMcpConversation(env, ctx, userId, {
		...input,
		messages,
		testOverrides: { ...CANNED, ...overrides },
	});
	await waitOnExecutionContext(ctx);
	return res;
}

async function drainUntilSettled(userId, maxRounds = 30, { reset = true } = {}) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) {
			if (reset) await stub.resetAll();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("conversation jobs did not settle");
}

async function livePages(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

async function pageSources(userId, pageId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM conversation_page_sources WHERE user_id = ? AND page_id = ? ORDER BY seq",
	).bind(userId, pageId).all();
	return results ?? [];
}

async function saveHttp(userId, body) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request("http://example.com/v1/save", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
		body: JSON.stringify({ userId, ...body }),
	}), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

describe("deterministic conversation identity (MCP door)", () => {
	it("a later batch for the same conversationId advances ONE page — never a second page", async () => {
		const userId = `conv-adv-${crypto.randomUUID()}`;
		const first = await stage(userId, batchOne(), { conversationId: "conv-stable-1" });
		expect(first.page_id).toMatch(/^page_/);
		await drainUntilSettled(userId, 30, { reset: false });

		const second = await stage(userId, batchGrown(), { conversationId: "conv-stable-1" }, CANNED_GROWN);
		expect(second.ok ?? true).toBe(true);
		await drainUntilSettled(userId);

		const pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		expect(pages[0].id).toBe(first.page_id);
		expect(pages[0].conversation_key).toBeTruthy();
		expect(pages[0].enrich_status).toBe("enriched");
		// The advance is a forward revision of the same page.
		expect(Number(pages[0].revision)).toBeGreaterThanOrEqual(2);
		// Both accepted batches are linked as this page's sources.
		const links = await pageSources(userId, pages[0].id);
		expect(links).toHaveLength(2);
		expect(new Set(links.map((l) => l.source_packet_id)).size).toBe(2);
	});

	it("the same words in different conversations remain distinct pages", async () => {
		const userId = `conv-distinct-${crypto.randomUUID()}`;
		await stage(userId, batchOne(), { conversationId: "conv-A" });
		await drainUntilSettled(userId, 30, { reset: false });
		await stage(userId, batchOne(), { conversationId: "conv-B" });
		await drainUntilSettled(userId);
		const pages = await livePages(userId);
		expect(pages).toHaveLength(2);
		expect(pages[0].conversation_key).not.toBe(pages[1].conversation_key);
	});

	it("captureDefault graph_only builds no Conversation Page while the graph still fires", async () => {
		const userId = `conv-graphonly-${crypto.randomUUID()}`;
		await saveMemoryRules(env, userId, { captureDefault: "graph_only" });
		const res = await stage(userId, batchOne(), { conversationId: "conv-nopage" });
		expect(res.ok ?? true).toBe(true);
		await drainUntilSettled(userId);
		const pages = await livePages(userId);
		expect(pages).toHaveLength(0);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(Number(nodes.n)).toBeGreaterThan(0);
	});
});

describe("REST /v1/save mode:conversation (SDK/n8n door)", () => {
	it("creates one Conversation Page and links extraction, like the MCP door", async () => {
		const userId = `rest-page-${crypto.randomUUID()}`;
		const res = await saveHttp(userId, {
			mode: "conversation",
			conversationId: "rest-conv-1",
			messages: batchOne(),
			_test: CANNED,
		});
		expect(res.status).toBe(200);
		await drainUntilSettled(userId);
		const pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		expect(pages[0].conversation_key).toBeTruthy();
		expect(pages[0].enrich_status).toBe("enriched");
		const links = await pageSources(userId, pages[0].id);
		expect(links).toHaveLength(1);
	});

	it("a later REST batch with the same conversationId advances the same page", async () => {
		const userId = `rest-adv-${crypto.randomUUID()}`;
		await saveHttp(userId, {
			mode: "conversation",
			conversationId: "rest-conv-2",
			messages: batchOne(),
			_test: CANNED,
		});
		await drainUntilSettled(userId, 30, { reset: false });
		await saveHttp(userId, {
			mode: "conversation",
			conversationId: "rest-conv-2",
			messages: batchGrown(),
			_test: CANNED_GROWN,
		});
		await drainUntilSettled(userId);
		const pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		expect((await pageSources(userId, pages[0].id))).toHaveLength(2);
	});
});
