/**
 * Recall v2 — four ranked signals fused with RRF, bi-temporal filtering, MMR,
 * and graph expansion that actually reads the graph Block 4 built. Zero
 * generative calls anywhere in the path (the query embedding is the only
 * model touch, and these tests run with vectors off entirely).
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getConfig } from "../src/config.js";
import { recall, recallGate, buildContext } from "../src/pipeline/recall.js";

const NOW = Date.now();

async function seedNode(userId, id, label, { category = "other", summary = null, heat = 1 } = {}) {
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, heat_score)
		 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
	).bind(id, userId, label, category, summary, NOW, NOW, heat).run();
}

async function seedEdge(userId, id, from, to, type, { fact = null, valid = null, invalid = null, weight = 1 } = {}) {
	await env.DB.prepare(
		`INSERT INTO edges (id, user_id, from_node, to_node, type, created_at, weight, fact, valid_at, invalid_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, from, to, type, NOW, weight, fact, valid, invalid).run();
}

async function seedSlice(userId, id, nodeId, text) {
	await env.DB.prepare(
		"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, 'other', 1, ?)",
	).bind(id, userId, nodeId, text, NOW).run();
}

const config = () => getConfig(env);

describe("multi-hop through the graph", () => {
	it("answers with a node whose own text shares NOTHING with the query", async () => {
		const userId = `r2-hop-${crypto.randomUUID()}`;
		// "Meridian Labs" is mentioned in the query. Priya's node text never
		// mentions the company — only the WORKS_AT edge connects them.
		await seedNode(userId, "hop-org", "Meridian Labs", { category: "organization" });
		await seedNode(userId, "hop-priya", "Priya", { category: "person", summary: "Approved the four-day-week trial." });
		await seedNode(userId, "hop-noise", "Biscuit", { category: "possession", summary: "Rescue greyhound." });
		await seedEdge(userId, "hop-e1", "hop-priya", "hop-org", "WORKS_AT", { fact: "Priya works at Meridian Labs" });

		const res = await recall(env, config(), userId, "Who do I know at Meridian Labs?");
		const labels = res.nodes.map((n) => n.label);
		expect(labels).toContain("Meridian Labs");
		expect(labels).toContain("Priya");
		expect(labels).not.toContain("Biscuit");
		expect(res.graph_expansion_used).toBe(true);
		expect(res.context).toContain("Priya works at Meridian Labs");
	});
});

describe("bi-temporal answers", () => {
	const seedLiving = async (userId) => {
		// Vitest 4 isolates Workers storage per file rather than per test. Bind
		// globally-unique primary keys to this test's tenant so the two temporal
		// cases can share a file without sharing rows.
		const id = (part) => `${userId}:${part}`;
		await seedNode(userId, id("bt-me"), "Ziyad", { category: "identity" });
		await seedNode(userId, id("bt-porto"), "Porto", { category: "place", summary: "Coastal city." });
		await seedNode(userId, id("bt-braga"), "Braga", { category: "place", summary: "Northern city." });
		await seedEdge(userId, id("bt-e1"), id("bt-me"), id("bt-porto"), "LIVES_IN", {
			fact: "Lives in Porto", valid: Date.parse("2023-02-01"), invalid: Date.parse("2026-06-01"),
		});
		await seedEdge(userId, id("bt-e2"), id("bt-me"), id("bt-braga"), "LIVES_IN", {
			fact: "Lives in Braga", valid: Date.parse("2026-06-01"),
		});
	};

	it("a current question returns the current value, not the closed one", async () => {
		const userId = `r2-now-${crypto.randomUUID()}`;
		await seedLiving(userId);
		const res = await recall(env, config(), userId, "Where does Ziyad live?");
		expect(res.context).toContain("Lives in Braga");
		expect(res.context).not.toContain("Lives in Porto");
	});

	it("a question about the past retrieves the closed window, dated", async () => {
		const userId = `r2-past-${crypto.randomUUID()}`;
		await seedLiving(userId);
		const res = await recall(env, config(), userId, "Where did Ziyad live before?");
		expect(res.context).toContain("Lives in Porto (until 2026-06-01)");
	});
});

describe("the two Phase-A bugs stay dead", () => {
	it("a question without I/my still searches memory (recallGate)", async () => {
		// The old bug: classifyMessage called any bare question "utility" and
		// recall never ran — measured at 87.5% of benchmark questions skipped.
		const plan = recallGate("When is Sarah's birthday?");
		expect(plan.mode).not.toBe("no_recall");

		const userId = `r2-gate-${crypto.randomUUID()}`;
		await seedNode(userId, "g-sarah", "Sarah", { category: "person", summary: "Birthday on November 14th." });
		const res = await recall(env, config(), userId, "When is Sarah's birthday?");
		expect(res.count).toBeGreaterThan(0);
		expect(res.context).toContain("Sarah");
	});

	it("an oversized first line is clipped, never dropped (buildContext)", () => {
		const plan = recallGate("what do you know about my projects?");
		const giant = "x".repeat(plan.maxContextChars * 2);
		const context = buildContext([
			{ type: "node", item: { label: "Huge", category: "project", state: "active", summary: null, slices: [{ text: giant }], events: [], relations: [] } },
		], plan);
		expect(context.length).toBeGreaterThan(0);
		expect(context.length).toBeLessThanOrEqual(plan.maxContextChars + 2);
	});
});

describe("MMR and fusion", () => {
	it("five phrasings of one fact return once; a distinct fact still makes the cut", async () => {
		const userId = `r2-mmr-${crypto.randomUUID()}`;
		// Five near-identical marathon nodes and one distinct fact.
		for (let i = 1; i <= 5; i++) {
			await seedNode(userId, `mmr-${i}`, `Porto half marathon plan ${i}`, {
				category: "goal", summary: "Training for the Porto half marathon in October, 40km weekly.",
			});
		}
		await seedNode(userId, "mmr-distinct", "Marathon fundraiser", {
			category: "project", summary: "Raising money for the marathon charity drive.",
		});
		const res = await recall(env, config(), userId, "what do you know about my marathon plans?");
		expect(res.nodes.length).toBeGreaterThan(0);
		const labels = res.nodes.map((n) => n.label);
		// The distinct item survives the near-duplicate wall.
		expect(labels).toContain("Marathon fundraiser");
	});

	it("BM25 catches a rare term living only in a search profile", async () => {
		const userId = `r2-fts-${crypto.randomUUID()}`;
		await seedNode(userId, "fts-node", "Deploy ritual", { category: "habit", summary: "Ship on Fridays." });
		await env.DB.prepare(
			`INSERT INTO manual_search_profiles
				(user_id, object_kind, object_id, identity_text, semantic_text, context_text, profile_hash, source_updated_at, created_at, updated_at)
			 VALUES (?, 'node', 'fts-node', ?, ?, '', 'test-hash', ?, ?, ?)`,
		).bind(userId, "Deploy ritual xylozephyr", "wrangler publish then smoke", NOW, NOW, NOW).run();

		const res = await recall(env, config(), userId, "what was that xylozephyr thing?");
		expect(res.nodes.map((n) => n.label)).toContain("Deploy ritual");
	});
});

describe("scope by door", () => {
	it("a plugin-scoped key's memory space and the owner's differ", async () => {
		// Tenancy IS the scope filter: a scoped save lands in an isolated memory
		// user, so the same query answers differently through each door.
		const owner = `r2-scope-owner-${crypto.randomUUID()}`;
		const project = `${owner}::project-itsuki`;
		await seedNode(owner, "sc-personal", "Amara", { category: "family", summary: "Sister, visiting in August." });
		await seedNode(project, "sc-project", "Retry logic decision", {
			category: "project", summary: "Retries live in the worker so failures stay observable.",
		});

		const personal = await recall(env, config(), owner, "what do you know about my work decisions and family?");
		const pluginScoped = await recall(env, config(), project, "what do you know about my work decisions and family?");

		expect(personal.nodes.map((n) => n.label)).toContain("Amara");
		expect(personal.nodes.map((n) => n.label)).not.toContain("Retry logic decision");
		expect(pluginScoped.nodes.map((n) => n.label)).toContain("Retry logic decision");
		expect(pluginScoped.nodes.map((n) => n.label)).not.toContain("Amara");
	});
});
