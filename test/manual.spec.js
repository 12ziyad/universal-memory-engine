/**
 * Path A (manual save) + digest + receipts + faster-save tests.
 *
 * The extraction LLM and the digest LLM are both stubbed deterministically:
 *   - _test.llmResponse  → the extraction proposal JSON
 *   - _test.digestResponse → the digest text ("" forces the heuristic fallback)
 * Everything else (trigger flush, lenient gate, canonical match, write, receipts
 * storage, the /v1/save + /v1/receipts routes) is the REAL code under test.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { getConfig } from "../src/config.js";
import { digestConversation } from "../src/pipeline/digest.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, init) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx); // drain background extraction + receipt store
	return { status: response.status, body: await response.json() };
}

function save(body) {
	return call("/v1/save", { method: "POST", headers, body: JSON.stringify(body) });
}
function receipts(userId) {
	return call(`/v1/receipts?userId=${userId}`, { headers });
}
async function nodes(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM nodes WHERE user_id = ?").bind(userId).all();
	return results;
}
async function slices(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM slices WHERE user_id = ?").bind(userId).all();
	return results;
}
async function events(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM events WHERE user_id = ?").bind(userId).all();
	return results;
}
async function seedNode(userId, id, label, category, state = "active") {
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, userId, label, category, null, state, null, now, now)
		.run();
}

describe("Path A - save_memory (manual, immediate)", () => {
	it("saves a direct memory and returns a clear receipt", async () => {
		const userId = "m-mem";
		const { body } = await save({
			userId,
			mode: "memory",
			content: "I started boxing",
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.95 },
						{ kind: "event", on: "Boxing", action: "started", text: "Started boxing", importance: "ordinary", confidence: 0.95 },
					],
					notes: "",
				},
			},
		});
		expect(body.fired).toBe(true);
		expect(body.summary).toContain("Saved:");
		expect(body.summary).toContain("Boxing");
		expect(await nodes(userId)).toHaveLength(1);
	});

	it("'save this: I stopped boxing' updates the existing node - no duplicate", async () => {
		const userId = "m-dedup";
		await seedNode(userId, "n-box", "Boxing", "skill", "active");
		const { body } = await save({
			userId,
			mode: "memory",
			content: "save this: I stopped boxing yesterday",
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Boxing", category: "skill", matches_existing: "n-box", confidence: 0.9 },
						{ kind: "event", on: "Boxing", action: "stopped", text: "Stopped boxing", importance: "ordinary", confidence: 0.95 },
					],
					notes: "",
				},
			},
		});
		expect(body.fired).toBe(true);
		const n = await nodes(userId);
		expect(n).toHaveLength(1); // NO duplicate
		expect(n[0].state).toBe("inactive"); // flipped by the stopped event
		expect(await events(userId)).toHaveLength(1);
	});
});

describe("Path A - save_conversation (digest then extract)", () => {
	it("digests a messy chat into facts, then extracts nodes/edges", async () => {
		const userId = "m-conv";
		const { body } = await save({
			userId,
			mode: "conversation",
			conversationId: "c1",
			messages: [
				{ role: "user", content: "yo" },
				{ role: "assistant", content: "Hi! How can I help?" },
				{ role: "user", content: "I'm building UML, it runs on Cloudflare" },
				{ role: "user", content: "it uses D1 and Vectorize" },
				{ role: "user", content: "lol thanks" },
				{ role: "user", content: "what's the weather?" },
			],
			_test: {
				// digest condenses the messy chat to clean lines…
				digestResponse: "User is building UML.\nUML runs on Cloudflare.\nUML uses D1 and Vectorize.",
				// …then extraction proposes nodes + an edge from those lines.
				llmResponse: {
					objects: [
						{ kind: "node", label: "UML", category: "project", matches_existing: null, confidence: 0.95 },
						{ kind: "node", label: "Cloudflare", category: "tool", matches_existing: null, confidence: 0.9 },
						{ kind: "edge", from: "UML", to: "Cloudflare", type: "runs_on", confidence: 0.9 },
						{ kind: "slice", on: "UML", text: "Uses D1 and Vectorize", kind_detail: "technical_detail", confidence: 0.9 },
					],
					notes: "",
				},
			},
		});
		expect(body.fired).toBe(true);
		expect(body.summary).toContain("Received 6 message(s).");
		const labels = (await nodes(userId)).map((n) => n.label).sort();
		expect(labels).toEqual(["Cloudflare", "UML"]);
	});

	it("returns a clear 'Saved: 0' when the chat has no durable facts", async () => {
		const userId = "m-conv-empty";
		const { body } = await save({
			userId,
			mode: "conversation",
			messages: [
				{ role: "user", content: "lol" },
				{ role: "user", content: "what time is it?" },
			],
			_test: { digestResponse: "" }, // model found nothing; heuristic also drops chatter/questions
		});
		expect(body.fired).toBe(false);
		expect(body.summary).toContain("Saved: 0");
		// A "0" receipt is still stored so the Saves page shows the attempt.
		const r = await receipts(userId);
		expect(r.body.receipts.length).toBeGreaterThan(0);
	});

	it("summary scope saves user-scoped research instead of generic world facts", async () => {
		const userId = "m-summary-research";
		const { body } = await save({
			userId,
			mode: "conversation",
			scope: "summary",
			messages: [
				{
					role: "user",
					content:
						"I researched GTA 6 PC availability, PS5 purchase options in India, EMI safety, and whether a loan is a bad idea.",
				},
			],
		});

		expect(body.fired).toBe(true);
		expect(body.summary).toContain("Saved conversation summary");
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0]).toMatchObject({ label: "GTA 6 / PS5 Research", category: "interest" });
		const sl = await slices(userId);
		expect(sl).toHaveLength(1);
		expect(sl[0].text).toContain("User discussed/researched GTA 6 / PS5 Research");
		expect(sl[0].text).toContain("EMI safety");
	});
});

describe("Receipts (Priority 5)", () => {
	it("stores a receipt for a save and serves it from /v1/receipts", async () => {
		const userId = "m-receipt";
		await save({
			userId,
			mode: "memory",
			content: "I started boxing",
			_test: {
				llmResponse: {
					objects: [{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.95 }],
					notes: "",
				},
			},
		});
		const { status, body } = await receipts(userId);
		expect(status).toBe(200);
		expect(body.receipts.length).toBeGreaterThan(0);
		const top = body.receipts[0];
		expect(top.source).toBe("save_memory");
		expect(top.summary).toContain("Saved:");
		expect(top.saved_nodes).toBe(1);
	});
});

describe("Digest scopes (unit)", () => {
	const config = getConfig(env);
	const chat = [
		{ role: "user", content: "I love hiking" },
		{ role: "assistant", content: "Nice!" },
		{ role: "user", content: "I switched my database to Postgres" },
		{ role: "user", content: "ok" },
	];

	it("summary scope keeps cleaned user lines and drops chatter", async () => {
		const { digest } = await digestConversation(env, config, chat, { scope: "summary" });
		expect(digest).toContain("hiking");
		expect(digest).toContain("Postgres");
		expect(digest).not.toContain("ok");
	});

	it("lastN scope limits to the most recent messages", async () => {
		const { digest } = await digestConversation(env, config, chat, { scope: "lastN", n: 1, digestResponse: "" });
		// only the last message ("ok") is in scope → dropped as chatter → empty
		expect(digest).toBe("");
	});

	it("topic scope keeps only matching messages", async () => {
		const { digest } = await digestConversation(env, config, chat, { scope: "topic", topic: "database", digestResponse: "" });
		expect(digest).toContain("Postgres");
		expect(digest).not.toContain("hiking");
	});

	it("falls back to cleaned user lines when the model returns nothing", async () => {
		const { digest } = await digestConversation(env, config, chat, { digestResponse: "" });
		expect(digest).toContain("Postgres");
		expect(digest).not.toContain("Nice!"); // assistant text never included
	});
});
