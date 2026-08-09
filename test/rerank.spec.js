import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { RERANK_MAX_CANDIDATES, candidateText, rerankEntries } from "../src/pipeline/rerank.js";

/**
 * E8 reranking.
 *
 * The measurement that motivated it: at depth 200 the same reader's conditional
 * accuracy fell from 68.23% to 58.27% — 9.96 pp lost to dilution, with the
 * evidence present. Fusion ranks by how many lanes agreed, not by whether an
 * item answers the question.
 *
 * The properties below matter more than the ranking itself: a reranker that
 * silently drops evidence, or that can reach outside the candidate list, would
 * be a worse bug than the dilution it fixes.
 */

const entry = (id, label, extra = {}) => ({
	type: "node",
	score: 0.5,
	item: { id, label, category: "project", slices: [], events: [], relations: [], ...extra },
});

/** A stubbed cross-encoder that ranks by a caller-supplied order. */
function aiReturning(order) {
	return {
		AI: {
			run: async () => ({ response: order.map((id, rank) => ({ id, score: 1 - rank * 0.1 })) }),
		},
	};
}

describe("candidate text is what the reader will actually see", () => {
	it("includes the label, facts and events, not just the label", () => {
		const text = candidateText(entry("n1", "Banker", {
			summary: "left banking",
			slices: [{ text: "worked there four years" }],
			events: [{ text: "Left job as a banker (2023-01-20)" }],
		}));
		expect(text).toContain("Banker");
		expect(text).toContain("worked there four years");
		expect(text).toContain("2023-01-20");
	});

	it("is bounded", () => {
		const text = candidateText(entry("n1", "X", { summary: "y".repeat(5000) }));
		expect(text.length).toBeLessThanOrEqual(900);
	});
});

describe("reranking reorders without inventing or losing evidence", () => {
	const entries = [entry("a", "Alpha"), entry("b", "Beta"), entry("c", "Gamma")];

	it("applies the model's order", async () => {
		const result = await rerankEntries(aiReturning([2, 0, 1]), "who?", entries);
		expect(result.used).toBe(true);
		expect(result.entries.map((e) => e.item.id)).toEqual(["c", "a", "b"]);
	});

	it("never introduces an item that was not a candidate", async () => {
		const result = await rerankEntries(aiReturning([2, 0, 1]), "who?", entries);
		const ids = new Set(entries.map((e) => e.item.id));
		for (const e of result.entries) expect(ids.has(e.item.id)).toBe(true);
	});

	it("keeps a candidate the model failed to score rather than dropping it", async () => {
		// Silent evidence loss is the exact failure class this campaign keeps
		// finding. An unscored candidate falls to the back; it does not vanish.
		const result = await rerankEntries(aiReturning([1]), "who?", entries);
		expect(result.entries).toHaveLength(3);
		expect(result.entries[0].item.id).toBe("b");
	});

	it("ignores out-of-range or duplicated ids instead of trusting them", async () => {
		const result = await rerankEntries(aiReturning([99, -1, 1, 1]), "who?", entries);
		expect(result.entries).toHaveLength(3);
		expect(result.entries.map((e) => e.item.id).sort()).toEqual(["a", "b", "c"]);
	});
});

describe("keep-K is a bound, not the goal", () => {
	const entries = Array.from({ length: 10 }, (_, i) => entry(`n${i}`, `Node ${i}`));

	it("truncates to K after reordering, never before", async () => {
		const order = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
		const result = await rerankEntries(aiReturning(order), "q", entries, { keep: 3 });
		expect(result.entries.map((e) => e.item.id)).toEqual(["n9", "n8", "n7"]);
		expect(result.keep).toBe(3);
	});

	it("returns everything, reordered, when no K is given", async () => {
		const result = await rerankEntries(aiReturning([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), "q", entries);
		expect(result.entries).toHaveLength(10);
		expect(result.keep).toBe(null);
	});
});

describe("a reranker failure is a degraded read, never a failed one", () => {
	const entries = [entry("a", "Alpha"), entry("b", "Beta")];

	it("returns the fused order untouched when the model throws", async () => {
		const broken = { AI: { run: async () => { throw new Error("model unavailable"); } } };
		const result = await rerankEntries(broken, "q", entries);
		expect(result.used).toBe(false);
		expect(result.entries).toEqual(entries);
		expect(result.error).toMatch(/unavailable/);
	});

	it("returns the fused order when the response is unreadable", async () => {
		for (const bad of [null, {}, { response: [] }, { response: "nope" }]) {
			const result = await rerankEntries({ AI: { run: async () => bad } }, "q", entries);
			expect(result.used).toBe(false);
			expect(result.entries).toEqual(entries);
		}
	});

	it("does nothing without an AI binding, a query, or enough candidates", async () => {
		expect((await rerankEntries({}, "q", entries)).used).toBe(false);
		expect((await rerankEntries(aiReturning([0]), "", entries)).used).toBe(false);
		expect((await rerankEntries(aiReturning([0]), "q", [entries[0]])).used).toBe(false);
	});
});

describe("the candidate pool is bounded by us, not by the caller", () => {
	it("scores at most RERANK_MAX_CANDIDATES and keeps the rest in fused order", async () => {
		const many = Array.from({ length: 200 }, (_, i) => entry(`n${i}`, `Node ${i}`));
		let scoredCount = 0;
		const ai = {
			AI: {
				run: async (_model, input) => {
					scoredCount = input.contexts.length;
					return { response: input.contexts.map((_, i) => ({ id: i, score: 1 - i * 0.001 })) };
				},
			},
		};
		const result = await rerankEntries(ai, "q", many);
		expect(scoredCount).toBeLessThanOrEqual(RERANK_MAX_CANDIDATES);
		expect(result.scored).toBeLessThanOrEqual(RERANK_MAX_CANDIDATES);
		// Unscored tail is preserved, not discarded.
		expect(result.entries).toHaveLength(200);
	});
});

describe("recall integration", () => {
	it("is off by default — a legacy read makes no reranker call", async () => {
		const { recall } = await import("../src/pipeline/recall.js");
		const { getConfig } = await import("../src/config.js");
		let called = false;
		const spyEnv = { ...env, AI: { run: async () => { called = true; return {}; } } };
		const userId = `rr_off_${Date.now().toString(36)}`;
		await env.DB.prepare(
			`INSERT INTO nodes (id, user_id, label, category, state, summary, cluster, heat_score, created_at, updated_at, last_seen_at)
			 VALUES (?, ?, 'Falcon', 'project', 'active', 'a falcon project', 'projects_systems', 1, ?, ?, ?)`,
		).bind(`node_${userId}`, userId, Date.now(), Date.now(), Date.now()).run();
		const result = await recall(spyEnv, getConfig(env), userId, "Falcon", {});
		expect(result.rerank_used).toBe(false);
		expect(called).toBe(false);
	});
});
