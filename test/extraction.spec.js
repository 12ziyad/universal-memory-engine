/**
 * Step 2 — Extraction Engine tests.
 *
 * The LLM is stubbed per-request via `_test.llmResponse` (the exact JSON the
 * model would have returned) so the suite is deterministic and offline. Crucially,
 * the trigger, gates, canonical matching, write and checkpoint logic are all the
 * REAL code under test — only the model output is canned.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

/** POST /v1/ingest and drain the background extraction (ctx.waitUntil). */
async function ingest(userId, messages, opts = {}) {
	const body = { userId, messages };
	if (opts.flush) body.flush = true;
	if (opts.llmResponse !== undefined || opts.settings !== undefined) {
		body._test = {};
		if (opts.llmResponse !== undefined) body._test.llmResponse = opts.llmResponse;
		if (opts.settings !== undefined) body._test.settings = opts.settings;
	}
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx); // let background extraction finish
	return response.json();
}

const msg = (id, content, ts = Date.now()) => ({ id, role: "user", content, ts });

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
	const { results } = await env.DB.prepare("SELECT * FROM edges WHERE user_id = ?").bind(userId).all();
	return results;
}
async function candidates(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM candidates WHERE user_id = ? AND deleted_at IS NULL").bind(userId).all();
	return results;
}
async function checkpoint(userId) {
	const row = await env.DB.prepare(
		"SELECT last_processed_msg_id FROM checkpoints WHERE user_id = ?",
	)
		.bind(userId)
		.first();
	return row?.last_processed_msg_id ?? null;
}
async function seedNode(userId, id, label, category, state = "active") {
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, userId, label, category, null, state, null, now, now)
		.run();
}

describe("1. New node", () => {
	it("creates a Boxing node + started event + progress slice", async () => {
		const userId = "u-new-node";
		const res = await ingest(userId, [msg("m1", "I started boxing and train three days a week")], {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.95 },
					{ kind: "event", on: "Boxing", action: "started", text: "Started boxing", importance: "ordinary", confidence: 0.95 },
					{ kind: "slice", on: "Boxing", text: "Trains three days a week", kind_detail: "progress", confidence: 0.9 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0]).toMatchObject({ label: "Boxing", category: "skill", state: "active" });

		const ev = await events(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "started", node_id: n[0].id });

		const sl = await slices(userId);
		expect(sl).toHaveLength(1);
		expect(sl[0]).toMatchObject({ text: "Trains three days a week", kind: "progress", is_current: 1, node_id: n[0].id });
	});

	it("does not create an empty node from a node-only proposal", async () => {
		const userId = "u-node-only-no-empty";
		await ingest(userId, [msg("m1", "I use Notion for random notes")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Notion", category: "tool", matches_existing: null, confidence: 0.95 },
				],
				notes: "",
			},
		});
		expect(await nodes(userId)).toHaveLength(0);
		expect(await slices(userId)).toHaveLength(0);
		expect(await events(userId)).toHaveLength(0);
		expect(await candidates(userId)).toHaveLength(1);
	});

	it("falls back to a durable life event when the proposal is empty", async () => {
		const userId = "u-life-empty-fallback";
		await ingest(userId, [msg("m1", "My grandmother died yesterday")], {
			flush: true,
			llmResponse: { objects: [], notes: "" },
		});
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0]).toMatchObject({ label: "Grandmother", category: "family" });
		const ev = await events(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "passed_away", importance: "life_significant", node_id: n[0].id });
	});
});

describe("2. Update, no duplicate", () => {
	it("adds a stopped event on the SAME node, flips state inactive, creates no node", async () => {
		const userId = "u-update";
		await seedNode(userId, "n-box", "Boxing", "skill", "active");

		const res = await ingest(userId, [msg("m1", "I stopped boxing")], {
			llmResponse: {
				objects: [
					// model re-proposes the node — the canonical-match gate must dedupe it.
					{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.9 },
					{ kind: "event", on: "Boxing", action: "stopped", text: "Stopped boxing", importance: "ordinary", confidence: 0.95 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const n = await nodes(userId);
		expect(n).toHaveLength(1); // NO duplicate
		expect(n[0].id).toBe("n-box");
		expect(n[0].state).toBe("inactive"); // lifecycle event flipped state

		const ev = await events(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "stopped", node_id: "n-box" });
	});
});

describe("3. Detail not node", () => {
	it("adds a slice under the existing node, creates no Voice Mode node", async () => {
		const userId = "u-detail";
		await seedNode(userId, "n-kaka", "Kaka", "project", "active");

		const res = await ingest(userId, [msg("m1", "Kaka now supports voice mode")], {
			llmResponse: {
				objects: [
					{ kind: "slice", on: "Kaka", text: "Supports voice mode", kind_detail: "feature_detail", confidence: 0.9 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const n = await nodes(userId);
		expect(n).toHaveLength(1); // only Kaka — no "Voice Mode" node
		expect(n[0].id).toBe("n-kaka");

		const sl = await slices(userId);
		expect(sl).toHaveLength(1);
		expect(sl[0]).toMatchObject({ node_id: "n-kaka", text: "Supports voice mode" });
	});
});

describe("4. Ignore noise", () => {
	it('writes nothing and the checkpoint can advance past "ok bro"', async () => {
		const userId = "u-ignore";
		const res = await ingest(userId, [msg("m-ok", "ok bro")]);
		expect(res.fired).toBe(false);

		expect(await nodes(userId)).toHaveLength(0);
		expect(await slices(userId)).toHaveLength(0);
		expect(await events(userId)).toHaveLength(0);
		// Safe to advance past noise.
		expect(await checkpoint(userId)).toBe("m-ok");
	});
});

describe("5. Question ignored", () => {
	it("writes nothing for a pure utility question", async () => {
		const userId = "u-question";
		const res = await ingest(userId, [msg("m-q", "what is boxing?")]);
		expect(res.fired).toBe(false);

		expect(await nodes(userId)).toHaveLength(0);
		expect(await slices(userId)).toHaveLength(0);
		expect(await events(userId)).toHaveLength(0);
		expect(await checkpoint(userId)).toBe("m-q");
	});
});

describe("6. Edge only on explicit relation", () => {
	it("creates a slice + an edge Kaka -uses-> Cloudflare Worker", async () => {
		const userId = "u-edge";
		await seedNode(userId, "n-kaka2", "Kaka", "project", "active");

		const res = await ingest(userId, [msg("m1", "Kaka uses Cloudflare Workers")], {
			llmResponse: {
				objects: [
					{ kind: "slice", on: "Kaka", text: "Uses Cloudflare Workers", kind_detail: "technical_detail", confidence: 0.9 },
					{ kind: "node", label: "Cloudflare Worker", category: "tool", matches_existing: null, confidence: 0.85 },
					{ kind: "edge", from: "Kaka", to: "Cloudflare Worker", type: "uses", confidence: 0.9 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const sl = await slices(userId);
		expect(sl.some((s) => s.node_id === "n-kaka2")).toBe(true);

		const cfNode = (await nodes(userId)).find((n) => n.label === "Cloudflare Worker");
		expect(cfNode).toBeDefined();

		const ed = await edges(userId);
		expect(ed).toHaveLength(1);
		expect(ed[0]).toMatchObject({ from_node: "n-kaka2", to_node: cfNode.id, type: "uses" });
	});
});

describe("7. meaningful_no_write safety", () => {
	it("does not advance the checkpoint and retains the chunk when the LLM proposes nothing", async () => {
		const userId = "u-nowrite";
		const res = await ingest(userId, [msg("m1", "I have a brand new secret project idea")], {
			llmResponse: { objects: [], notes: "nothing extractable" },
		});
		expect(res.fired).toBe(true); // it was meaningful and fired

		// Nothing written.
		expect(await nodes(userId)).toHaveLength(0);
		expect(await slices(userId)).toHaveLength(0);
		expect(await events(userId)).toHaveLength(0);

		// Checkpoint did NOT advance, and the chunk is retained for retry.
		expect(await checkpoint(userId)).toBeNull();
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
		const debug = await stub.getDebugState();
		expect(debug.chunkSize).toBe(1);
		expect(debug.checkpoint).toBeNull();
	});
});

describe("user isolation in extraction", () => {
	it("keeps one user's extracted memory invisible to another", async () => {
		const userId = "u-iso-a";
		await ingest(userId, [msg("m1", "I started boxing")], {
			llmResponse: {
				objects: [{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.95 }],
				notes: "",
			},
		});
		expect(await nodes(userId)).toHaveLength(1);
		expect(await nodes("u-iso-b")).toHaveLength(0);
	});
});

describe("8. Re-sent messages are de-duplicated", () => {
	it("skips a message id already processed, creating no duplicate node/event", async () => {
		const userId = "u-dedup";
		const llmResponse = {
			objects: [
				{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.95 },
				{ kind: "event", on: "Boxing", action: "started", text: "Started boxing", importance: "ordinary", confidence: 0.95 },
			],
			notes: "",
		};

		// First send writes the node + event.
		const first = await ingest(userId, [msg("dup-1", "I started boxing")], { llmResponse });
		expect(first.fired).toBe(true);
		expect(await nodes(userId)).toHaveLength(1);
		expect(await events(userId)).toHaveLength(1);

		// Re-sending the SAME id is a no-op — the seen-set skips it, nothing fires.
		const second = await ingest(userId, [msg("dup-1", "I started boxing")], { llmResponse });
		expect(second.fired).toBe(false);
		expect(await nodes(userId)).toHaveLength(1);
		expect(await events(userId)).toHaveLength(1);
	});
});

describe("9. Junk pronoun labels are rejected", () => {
	it("creates no node for a pronoun like 'I', and prunes the orphan edge endpoint", async () => {
		const userId = "u-junk";
		const res = await ingest(userId, [msg("m1", "I train three days a week")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "I", category: "person", matches_existing: null, confidence: 0.9 },
					{ kind: "node", label: "Boxing", category: "skill", matches_existing: null, confidence: 0.9 },
					{ kind: "edge", from: "I", to: "Boxing", type: "related_to", confidence: 0.9 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const n = await nodes(userId);
		expect(n).toHaveLength(0); // "Boxing" had no durable slice/event/edge after I was rejected

		const e = await edges(userId);
		expect(e).toHaveLength(0); // the I->Boxing edge lost its endpoint and was dropped
	});
});

// ---- Priority 1: the worth-saving gate fix -------------------------------------
// These cases all used to save NOTHING (an off-list category like "family" was
// downgraded to a weak candidate, then the event lost its subject and was dropped).
// They must now save Node + Event, and judge by meaning, not a hardcoded list.
describe("10. Life / family / health events now save (gate fix)", () => {
	async function eventsOf(userId) {
		const { results } = await env.DB.prepare("SELECT * FROM events WHERE user_id = ?").bind(userId).all();
		return results;
	}

	it("'My grandmother died' -> Grandmother (family) + passed_away (life_significant)", async () => {
		const userId = "u-grandma";
		const res = await ingest(userId, [msg("m1", "My grandmother died")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Grandmother", category: "family", matches_existing: null, confidence: 0.95 },
					{ kind: "event", on: "Grandmother", action: "passed_away", text: "Grandmother passed away", importance: "life_significant", confidence: 0.95 },
				],
				notes: "",
			},
		});
		expect(res.fired).toBe(true);

		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0]).toMatchObject({ label: "Grandmother", category: "family" });

		const ev = await eventsOf(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "passed_away", importance: "life_significant", node_id: n[0].id });
	});

	it("maps an off-list category by meaning ('relative' -> family)", async () => {
		const userId = "u-grandma2";
		await ingest(userId, [msg("m1", "My grandmother passed away")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Grandmother", category: "relative", matches_existing: null, confidence: 0.9 },
					{ kind: "event", on: "Grandmother", action: "passed_away", text: "passed away", importance: "life_significant", confidence: 0.9 },
				],
				notes: "",
			},
		});
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0].category).toBe("family"); // 'relative' canonicalized, NOT dropped
	});

	it("anti-orphan: 'I lost my grandmother' with only an event still creates the subject node", async () => {
		const userId = "u-grandma3";
		await ingest(userId, [msg("m1", "I lost my grandmother")], {
			flush: true,
			llmResponse: {
				objects: [
					// the model forgot to emit the node — only the event
					{ kind: "event", on: "Grandmother", action: "passed_away", text: "lost my grandmother", importance: "life_significant", confidence: 0.9 },
				],
				notes: "",
			},
		});
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0].label).toBe("Grandmother");
		expect(n[0].category).toBe("family"); // inferred from passed_away

		const ev = await eventsOf(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "passed_away", importance: "life_significant", node_id: n[0].id });
	});

	it("'I was diagnosed with asthma' -> Asthma (health) + diagnosed", async () => {
		const userId = "u-asthma";
		await ingest(userId, [msg("m1", "I was diagnosed with asthma")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Asthma", category: "health", matches_existing: null, confidence: 0.9 },
					{ kind: "event", on: "Asthma", action: "diagnosed", text: "Diagnosed with asthma", importance: "life_significant", confidence: 0.9 },
				],
				notes: "",
			},
		});
		const n = await nodes(userId);
		expect(n[0]).toMatchObject({ label: "Asthma", category: "health" });
		const ev = await eventsOf(userId);
		expect(ev[0]).toMatchObject({ action: "diagnosed" });
	});

	it("'I got married' -> a life_event node + married (life_significant)", async () => {
		const userId = "u-married";
		await ingest(userId, [msg("m1", "I got married last weekend")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Marriage", category: "life_event", matches_existing: null, confidence: 0.9 },
					{ kind: "event", on: "Marriage", action: "married", text: "Got married", importance: "life_significant", confidence: 0.9 },
				],
				notes: "",
			},
		});
		const n = await nodes(userId);
		expect(n[0]).toMatchObject({ label: "Marriage", category: "life_event" });
		const ev = await eventsOf(userId);
		expect(ev[0]).toMatchObject({ action: "married", importance: "life_significant" });
	});

	it("turns a node-only skill action with an unknown category into node plus event", async () => {
		const userId = "u-other-cat";
		await ingest(userId, [msg("m1", "I started doing pottery")], {
			flush: true,
			llmResponse: {
				objects: [
					{ kind: "node", label: "Pottery", category: "artsy_craft_thing", matches_existing: null, confidence: 0.8 },
				],
				notes: "",
			},
		});
		const n = await nodes(userId);
		expect(n).toHaveLength(1);
		expect(n[0]).toMatchObject({ label: "Pottery", category: "skill" });
		const ev = await eventsOf(userId);
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ action: "started", node_id: n[0].id });
	});
});
