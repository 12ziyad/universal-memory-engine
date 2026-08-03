/**
 * Part 8.2 — read-your-writes, per lane.
 *
 * The 0.3 trace measured the gap: save "my name is X", ask five seconds
 * later, get nothing (add/ingest) or only the first line (MCP staged). The
 * acceptance shape is now blunt: for EVERY write lane, a recall issued
 * before enrichment completes must return THE ANSWER, not a promise.
 */

import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function post(path, body) {
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

/** Hold the queue so nothing enriches: the pre-enrichment window, on demand. */
async function holdLease(userId) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.put("lease", { until: Date.now() + 120_000, token: "ryw-hold" });
	});
	return stub;
}

async function recall(userId, query) {
	const res = await post("/v1/recall", { userId, query });
	return res.body;
}

describe("8.2 read-your-writes: every lane answers before enrichment", () => {
	it("SDK add() / POST /v1/save — the answer, not 'still processing'", async () => {
		const userId = `ryw-add-${crypto.randomUUID()}`;
		await holdLease(userId);
		const saved = await post("/v1/save", {
			userId,
			content: "My name is Ziyad Barbosa and I live in Setubal.",
			_test: { waitBudgetMs: 1 }, // never wait for enrichment
		});
		expect(saved.status).toBe(200);

		const found = await recall(userId, "what is my name?");
		expect(found.context).toContain("Ziyad Barbosa");
		expect(found.staged_used).toBe(true);
	});

	it("SDK ingest() / POST /v1/ingest — findable immediately", async () => {
		const userId = `ryw-ingest-${crypto.randomUUID()}`;
		await holdLease(userId);
		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "i1", role: "user", content: "My dentist is Dr. Alma Ferreira in Estrela." }],
		});
		const found = await recall(userId, "who is my dentist?");
		expect(found.context).toContain("Alma Ferreira");
		expect(found.staged_used).toBe(true);
	});

	it("MCP save_conversation — EVERY durable line, not just the first", async () => {
		const userId = `ryw-mcp-${crypto.randomUUID()}`;
		await holdLease(userId);
		const ctx = createExecutionContext();
		await stageMcpConversation(env, ctx, userId, {
			messages: [
				{ id: "c1", role: "user", content: "I started welding classes on Thursdays." },
				{ id: "c2", role: "user", content: "My instructor there is Teodor Vlahov." },
				{ id: "c3", role: "user", content: "The workshop is in Kralingen." },
			],
			conversationId: `ryw-${userId}`,
		});
		await waitOnExecutionContext(ctx);

		// The THIRD line — the one the old lane could never surface.
		const found = await recall(userId, "where is the welding workshop?");
		expect(found.context).toContain("Kralingen");
		const instructor = await recall(userId, "who is my welding instructor?");
		expect(instructor.context).toContain("Teodor Vlahov");
	});

	it("add_conversation / mode=conversation — findable immediately", async () => {
		const userId = `ryw-conv-${crypto.randomUUID()}`;
		await holdLease(userId);
		await post("/v1/save", {
			userId,
			mode: "conversation",
			conversationId: "ryw-conv",
			messages: [
				{ id: "v1", role: "user", content: "We adopted a cat called Sardinha from Almada." },
				{ id: "v2", role: "assistant", content: "Lovely name." },
			],
		});
		const found = await recall(userId, "what is my cat called?");
		expect(found.context).toContain("Sardinha");
	});

	it("/v1/turn autoCollect — findable within the same conversation", async () => {
		const userId = `ryw-turn-${crypto.randomUUID()}`;
		await holdLease(userId);
		await post("/v1/turn", {
			userId,
			messages: [{ id: "t1", role: "user", content: "I switched my morning drink to rooibos tea." }],
		});
		const found = await recall(userId, "what do I drink in the morning?");
		expect(found.context).toContain("rooibos");
	});
});

describe("8.2 the upgrade: staged text stops answering once the graph has it", () => {
	it("settles on enrichment, and the graph answers instead", async () => {
		const userId = `ryw-upgrade-${crypto.randomUUID()}`;
		const stub = await holdLease(userId);
		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "u1", role: "user", content: "I train at Maas Open Water on Sundays." }],
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Maas Open Water", category: "organization", matches_existing: null, confidence: 0.95 },
						{ kind: "slice", on: "Maas Open Water", text: "Trains there on Sundays", kind_detail: "progress", confidence: 0.9 },
					],
					notes: "",
				},
			},
		});
		const staged = await recall(userId, "where do I train on Sundays?");
		expect(staged.staged_used).toBe(true);

		// Let enrichment land.
		await runInDurableObject(stub, async (instance, state) => { await state.storage.delete("lease"); });
		await stub.drain({ userId, maxJobs: 10, ignoreBackoff: true });

		const live = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM staged_memories WHERE user_id = ? AND settled_at IS NULL",
		).bind(userId).first();
		expect(live.n).toBe(0); // upgraded

		const after = await recall(userId, "where do I train on Sundays?");
		expect(after.context).toContain("Maas Open Water"); // the graph answers now
		expect(after.staged_used).toBe(false);
	}, 30000);

	it("staged text is SCRUBBED text — a secret never becomes findable", async () => {
		const userId = `ryw-scrub-${crypto.randomUUID()}`;
		await holdLease(userId);
		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{
				id: "s1",
				role: "user",
				content: "My deploy key is sk-live-4f9d2b8a1c6e3057fa2b9d4c for the Porto cluster.",
			}],
		});
		const { results } = await env.DB.prepare(
			"SELECT text FROM staged_memories WHERE user_id = ?",
		).bind(userId).all();
		expect(results.length).toBeGreaterThan(0);
		for (const row of results) {
			expect(row.text).not.toContain("sk-live-4f9d2b8a1c6e3057fa2b9d4c");
			expect(row.text).toContain("REDACTED");
		}
	});
});

describe("8.2 empty and staged-only accounts stay clean (with 8.2's sibling case)", () => {
	it("a completely empty account returns a clean empty context, no errors", async () => {
		const userId = `ryw-empty-${crypto.randomUUID()}`;
		const found = await recall(userId, "what do you know about me?");
		expect(found.ok).toBe(true);
		expect(String(found.context ?? "")).toBe("");
		expect(found.count).toBe(0);
	});

	it("a staged-only account (nothing enriched yet) answers from staging", async () => {
		const userId = `ryw-stagedonly-${crypto.randomUUID()}`;
		await holdLease(userId);
		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "o1", role: "user", content: "I bought a red bicycle called Ferrugem." }],
		});
		const graph = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?",
		).bind(userId).first();
		expect(graph.n).toBe(0); // truly staged-only

		const found = await recall(userId, "what is my bicycle called?");
		expect(found.context).toContain("Ferrugem");
		expect(found.ok).toBe(true);
	});
});
