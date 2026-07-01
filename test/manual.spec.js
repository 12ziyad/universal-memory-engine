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
async function edges(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM edges WHERE user_id = ? AND deleted_at IS NULL").bind(userId).all();
	return results;
}
async function pages(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL").bind(userId).all();
	return results;
}
async function candidates(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM candidates WHERE user_id = ? AND deleted_at IS NULL").bind(userId).all();
	return results;
}
async function runs(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM extraction_runs WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
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
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0].cluster).toBe("fitness_habits");
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

	it("rejects bad sentence-fragment titles instead of creating nodes", async () => {
		const userId = "m-bad-title";
		const { body } = await save({
			userId,
			mode: "memory",
			content: "want to see a detailed and interactive prototype",
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "want to see a detailed and interactive prototype", category: "project", confidence: 0.95 },
					],
					notes: "",
				},
			},
		});
		expect(body.summary).toContain("Saved: 0");
		expect(await nodes(userId)).toHaveLength(0);
	});

	it("does not create candidates on manual_direct", async () => {
		const userId = "m-no-manual-candidate";
		await save({
			userId,
			mode: "memory",
			content: "Maybe I should try piano someday",
			_test: {
				llmResponse: {
					objects: [{ kind: "candidate", label: "Piano", strength: "weak", confidence: 0.5 }],
					notes: "",
				},
			},
		});
		expect(await candidates(userId)).toHaveLength(0);
	});

	it("repeated grandmother passed-away memory reinforces one event", async () => {
		const userId = "m-grandmother-reinforce";
		const llmResponse = {
			objects: [
				{ kind: "node", label: "Grandmother", category: "family", matches_existing: null, confidence: 0.95 },
				{ kind: "event", on: "Grandmother", action: "passed_away", text: "Grandmother passed away", importance: "life_significant", confidence: 0.95 },
			],
			notes: "",
		};
		await save({ userId, mode: "memory", content: "my grandmother died", _test: { llmResponse } });
		await save({ userId, mode: "memory", content: "my grandmother passed away", _test: { llmResponse } });
		expect(await nodes(userId)).toHaveLength(1);
		const ev = await events(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0].reinforcement_count).toBeGreaterThan(0);
	});

	it("repeated same edge reinforces instead of duplicating", async () => {
		const userId = "m-edge-reinforce";
		const llmResponse = {
			objects: [
				{ kind: "node", label: "UML", category: "project", matches_existing: null, confidence: 0.95 },
				{ kind: "node", label: "D1", category: "tool", matches_existing: null, confidence: 0.95 },
				{ kind: "edge", from: "UML", to: "D1", type: "uses", confidence: 0.95 },
			],
			notes: "",
		};
		await save({ userId, mode: "memory", content: "UML uses D1", _test: { llmResponse } });
		await save({ userId, mode: "memory", content: "UML also uses D1", _test: { llmResponse } });
		const ed = await edges(userId);
		expect(ed).toHaveLength(1);
		expect(ed[0].reinforcement_count).toBeGreaterThan(0);
	});
});

describe("Path A2 - save_conversation (manual_collect memory pages)", () => {
	it("digests a messy chat into exactly one memory page, not graph fan-out", async () => {
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
				digestResponse: "User is building UML.\nUML runs on Cloudflare.\nUML uses D1 and Vectorize.",
			},
		});
		expect(body.fired).toBe(true);
		expect(body.summary).toContain("memory page");
		const p = await pages(userId);
		expect(p).toHaveLength(1);
		expect(p[0].title).toBe("UML Architecture Decisions");
		expect(p[0].cluster).toBe("projects_systems");
		expect(p[0].full_markdown).toContain("UML uses D1 and Vectorize");
		expect(await nodes(userId)).toHaveLength(0);
		expect(await candidates(userId)).toHaveLength(0);
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
		expect(body.summary).toContain("memory page");
		const p = await pages(userId);
		expect(p).toHaveLength(1);
		expect(p[0].title).toBe("GTA 6 / PS5 Research");
		expect(p[0].full_markdown).toContain("EMI safety");
		expect(await nodes(userId)).toHaveLength(0);
	});

	it("topic filter saves car details and skips bike details", async () => {
		const userId = "m-topic-car";
		const { body } = await save({
			userId,
			mode: "conversation",
			topic: "car",
			messages: [
				{ role: "user", content: "I compared car mileage and car service costs." },
				{ role: "user", content: "I also checked bike helmet prices and bike insurance." },
			],
			_test: {
				digestResponse:
					"Car mileage matters for the user's purchase research.\nCar service costs are a concern.\nBike helmet prices were discussed.\nBike insurance was discussed.",
			},
		});
		expect(body.fired).toBe(true);
		const p = await pages(userId);
		expect(p).toHaveLength(1);
		expect(p[0].title).toBe("Car Research");
		expect(p[0].full_markdown).toContain("Car mileage");
		expect(p[0].full_markdown).not.toContain("Bike helmet");
		expect(await nodes(userId)).toHaveLength(0);
	});

	it("later bike collect creates a separate bike page", async () => {
		const userId = "m-topic-bike";
		await save({
			userId,
			mode: "conversation",
			topic: "car",
			messages: [{ role: "user", content: "save everything about car from this chat, skip bike" }],
			_test: { digestResponse: "Car mileage matters.\nBike helmet prices were discussed." },
		});
		await save({
			userId,
			mode: "conversation",
			topic: "bike",
			messages: [{ role: "user", content: "save bike later" }],
			_test: { digestResponse: "Bike helmet prices were discussed.\nBike insurance was discussed." },
		});
		const p = (await pages(userId)).map((page) => page.title).sort();
		expect(p).toEqual(["Bike Research", "Car Research"]);
		expect(await nodes(userId)).toHaveLength(0);
	});

	it("delete last extraction removes the page and suppression blocks immediate recreation", async () => {
		const userId = "m-delete-last";
		await save({
			userId,
			mode: "conversation",
			topic: "car",
			messages: [{ role: "user", content: "Car mileage matters." }],
			_test: { digestResponse: "Car mileage matters." },
		});
		expect(await pages(userId)).toHaveLength(1);

		const deleted = await call("/v1/actions/delete-last-extraction", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId }),
		});
		expect(deleted.status).toBe(200);
		expect(deleted.body.deleted).toBe(true);
		expect(await pages(userId)).toHaveLength(0);

		const second = await save({
			userId,
			mode: "conversation",
			topic: "car",
			messages: [{ role: "user", content: "Car mileage matters." }],
			_test: { digestResponse: "Car mileage matters." },
		});
		expect(second.body.fired).toBe(false);
		expect(second.body.summary).toContain("suppressed");
		expect(await pages(userId)).toHaveLength(0);
	});

	it("organize clusters repairs old unclustered nodes and pages", async () => {
		const userId = "m-organize-clusters";
		await seedNode(userId, "old-skill", "Machine Learning", "skill");
		await env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, source_mode, title, canonical_title, short_summary, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"old-page",
				userId,
				"manual_collect",
				"UML Architecture Decisions",
				"uml architecture decisions",
				"UML uses D1 and Vectorize.",
				Date.now(),
				Date.now(),
			)
			.run();

		const res = await call("/v1/actions/organize-clusters", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId }),
		});
		expect(res.status).toBe(200);
		expect(res.body.updated).toBe(2);
		expect((await nodes(userId))[0].cluster).toBe("skills_tech");
		expect((await pages(userId))[0].cluster).toBe("projects_systems");

		const graph = await call(`/v1/graph?userId=${userId}`, { headers });
		expect(graph.body.clusters.map((c) => c.id).sort()).toEqual(["projects_systems", "skills_tech"]);
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
		expect(top.extraction_run_id).toMatch(/^run_/);
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
