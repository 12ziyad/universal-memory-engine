/**
 * SRV-05 — the MCP lane's failed-terminal replay must repair, not dead-end
 * (campaign 2026-08-07; the ingest lane's SRV-02 contract, applied to the
 * lane that shares its idempotency derivation).
 *
 * MCP save keys default to content-derived (source.js: conversation + content
 * hash), so a caller re-sending the SAME conversation after a terminal model
 * fault replays the SAME key. The old behavior answered that replay with an
 * "Already saved/accepted (failed)" ok-shaped duplicate: misleading success
 * (I23) and PERMANENT unsaveability of that content through the natural
 * retry. Contract under test: replay of a failed MCP job repairs the same
 * job row (bounded), and past the bound refuses honestly with a
 * non-acceptance shape.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";

const T0 = Date.parse("2026-08-01T14:00:00Z");

function conv() {
	return [
		{ id: "e1", role: "user", content: "I started a new job at Halcyon Robotics as a firmware engineer.", ts: T0 },
		{ id: "e3", role: "user", content: "My sister Nadia moved to Porto with her husband Tomas.", ts: T0 + 120_000 },
	];
}

const GOOD_EXTRACTION = {
	objects: [
		{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
		{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
	],
	notes: "",
};

async function stage(userId, overrides = {}) {
	const ctx = createExecutionContext();
	const res = await stageMcpConversation(env, ctx, userId, {
		messages: conv(),
		conversationId: `conv-${userId}`,
		testOverrides: {
			llmResponse: GOOD_EXTRACTION,
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
			titleResponse: { title: "New Job At Halcyon Robotics" },
			...overrides,
		},
	});
	await waitOnExecutionContext(ctx);
	return res;
}

async function drainUntilSettled(userId, maxRounds = 30) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) { await stub.resetAll(); return; }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("mcp jobs did not settle");
}

async function jobFor(userId) {
	return env.DB.prepare(
		"SELECT id, status, attempts, error FROM memory_jobs WHERE user_id = ? ORDER BY created_at LIMIT 1",
	).bind(userId).first();
}

describe("MCP failed-terminal replay repairs instead of dead-ending", () => {
	// Generous budgets: the failure phase burns real retry backoff before the
	// terminal verdict, which can exceed the default 5s under full-suite load.
	it("repairs a failed MCP job when the same conversation is saved again", { timeout: 30_000 }, async () => {
		const userId = `mcp-repair-${crypto.randomUUID()}`;
		await stage(userId, { llmResponse: "%% not json at all %%" });
		await drainUntilSettled(userId);
		const failed = await jobFor(userId);
		expect(failed.status).toBe("failed");

		// The natural retry: the user asks to save the same conversation again.
		const replay = await stage(userId);
		expect(replay.duplicate).not.toBe(true);
		expect(replay.processing).toBe(true);
		expect(String(replay.summary ?? "")).not.toMatch(/already saved|already accepted/i);

		await drainUntilSettled(userId);
		const repaired = await jobFor(userId);
		expect(repaired.id).toBe(failed.id); // same row repaired, not a duplicate
		expect(repaired.status).toBe("enriched");
		const node = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(node.n).toBeGreaterThan(0);
	});

	it("refuses honestly past the repair bound - never acceptance-shaped", { timeout: 30_000 }, async () => {
		const userId = `mcp-repair-bound-${crypto.randomUUID()}`;
		await stage(userId, { llmResponse: "%% not json at all %%" });
		await drainUntilSettled(userId);
		const failed = await jobFor(userId);
		expect(failed.status).toBe("failed");
		// Exhausted repairs: the generation counter (bumped once per repair
		// cycle) is the bound the door enforces.
		await env.DB.prepare(
			"UPDATE memory_jobs SET payload_json = json_set(COALESCE(payload_json,'{}'), '$.repair_generation', 5) WHERE id = ? AND user_id = ?",
		).bind(failed.id, userId).run();

		const replay = await stage(userId);
		expect(replay.ok).toBe(false);
		expect(replay.error).toBe("extraction_failed_terminal");
		expect(String(replay.summary ?? "")).not.toMatch(/already saved|already accepted/i);

		const after = await jobFor(userId);
		expect(after.status).toBe("failed"); // untouched — no phantom re-queue
	});
});
