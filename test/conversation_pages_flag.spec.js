/**
 * The CONVERSATION_PAGES staged rollout flag.
 *
 * "track" (Stage A / rollback target): schema + source-link plumbing live,
 * behavior IDENTICAL to the pre-campaign lane — one page per accepted MCP
 * batch, no identity convergence, no REST pages. This is what production runs
 * first, and what a rollback returns to, so it must be proven, not assumed.
 *
 * "on" (Stage B): deterministic identity, proven in conversation_pages.spec.js.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import { conversationPagesMode, conversationKeyFrom } from "../src/pipeline/conversation_pages.js";
import worker from "../src/index.js";

const T0 = Date.parse("2026-08-03T11:00:00Z");
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

/** The flag reader is pure, so track-mode behavior is exercised via env clone. */
const trackEnv = { ...env, CONVERSATION_PAGES: "track" };

function batch(extra = "") {
	return [
		{ id: `f1${extra}`, role: "user", content: `I started a new job at Halcyon Robotics as a firmware engineer.${extra}`, ts: T0 },
		{ id: `f2${extra}`, role: "assistant", content: "Congratulations on the new role!", ts: T0 + 60_000 },
	];
}

async function drainUntilSettled(useEnv, userId, maxRounds = 30) {
	const stub = useEnv.USER_MEMORY.get(useEnv.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) {
			await stub.resetAll();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("jobs did not settle");
}

async function livePages(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

describe("CONVERSATION_PAGES flag", () => {
	it("reads on/track deterministically and treats anything unrecognized as track", () => {
		expect(conversationPagesMode({ CONVERSATION_PAGES: "on" })).toBe("on");
		expect(conversationPagesMode({ CONVERSATION_PAGES: "ON" })).toBe("on");
		expect(conversationPagesMode({ CONVERSATION_PAGES: "track" })).toBe("track");
		expect(conversationPagesMode({ CONVERSATION_PAGES: "yes" })).toBe("track");
		expect(conversationPagesMode({})).toBe("track");
	});

	it("derives conversation identity from conversationId, then threadId, else null", () => {
		expect(conversationKeyFrom({ conversationId: "c1", threadId: "t1" })).toBe("c1");
		expect(conversationKeyFrom({ threadId: "t1" })).toBe("t1");
		expect(conversationKeyFrom({})).toBeNull();
		expect(conversationKeyFrom({ conversationId: "   " })).toBeNull();
		expect(conversationKeyFrom({ conversationId: "x".repeat(500) })).toHaveLength(200);
	});

	it("track mode keeps the historical lane: a grown re-send makes its own page, no identity claimed", async () => {
		const userId = `track-${crypto.randomUUID()}`;
		const ctx = createExecutionContext();
		await stageMcpConversation(trackEnv, ctx, userId, {
			messages: batch(),
			conversationId: "track-conv",
			testOverrides: CANNED,
		});
		await waitOnExecutionContext(ctx);
		await drainUntilSettled(trackEnv, userId);

		const ctx2 = createExecutionContext();
		await stageMcpConversation(trackEnv, ctx2, userId, {
			messages: batch(" We also shipped the v2 firmware."),
			conversationId: "track-conv",
			testOverrides: CANNED,
		});
		await waitOnExecutionContext(ctx2);
		await drainUntilSettled(trackEnv, userId);

		const pages = await livePages(userId);
		// The pre-campaign behavior, exactly: two batches → two pages.
		expect(pages).toHaveLength(2);
		for (const page of pages) expect(page.conversation_key).toBeNull();
	});

	it("track mode creates no REST conversation page", async () => {
		const userId = `track-rest-${crypto.randomUUID()}`;
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({
				userId,
				mode: "conversation",
				conversationId: "track-rest-conv",
				messages: batch(),
				_test: CANNED,
			}),
		}), { ...env, CONVERSATION_PAGES: "track" }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		await drainUntilSettled(trackEnv, userId);
		expect(await livePages(userId)).toHaveLength(0);
	});
});
