import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	memoryV3AdaptiveContextConfig,
	memoryV3AdaptiveContextEnabled,
} from "../src/lib/memory_v3.js";
import {
	ADAPTIVE_CONTEXT_HARD_MAX,
	adaptiveContextPlan,
	classifyAdaptiveContext,
	compileAdaptiveContext,
} from "../src/pipeline/adaptive_context.mjs";
import { getConfig } from "../src/config.js";
import { recall } from "../src/pipeline/recall.js";

function treatmentEnv(userId) {
	return {
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
		ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: "allowlist",
		ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS: userId,
	};
}

function node(id, evidence, score = 1) {
	return {
		type: "node",
		id,
		score,
		item: {
			id,
			label: id,
			category: "project",
			state: "active",
			evidence: evidence.map((text, index) => ({
				key: `slice:${id}-${index}`,
				kind: "slice",
				text,
			})),
		},
	};
}

const DEPTH_PLAN = Object.freeze({
	maxContextNodes: 200,
	maxContextPages: 100,
	maxLineItems: 4,
	maxContextChars: 24_000,
});

describe("E10 adaptive-context flag", () => {
	it("fails closed and requires the parent V3 and E7 allowlists", () => {
		const userId = "adaptive-treatment";
		const treatment = treatmentEnv(userId);
		expect(memoryV3AdaptiveContextConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3AdaptiveContextEnabled(treatment, userId)).toBe(true);
		expect(memoryV3AdaptiveContextEnabled(treatment, `${userId}-suffix`)).toBe(false);
		expect(memoryV3AdaptiveContextEnabled({ ...treatment, ITSUKI_MEMORY_V3: "off" }, userId)).toBe(false);
		expect(memoryV3AdaptiveContextEnabled({
			...treatment,
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off",
		}, userId)).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3AdaptiveContextEnabled({
				...treatment,
				ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: value,
			}, userId)).toBe(false);
		}
	});
});

describe("E10 deterministic profiles", () => {
	it("assigns frozen generic query profiles and never exceeds the existing plan", () => {
		expect(classifyAdaptiveContext("Which database does Northwind use?")).toBe("targeted");
		expect(classifyAdaptiveContext("When did Rita move to Lisbon?")).toBe("temporal-point");
		expect(classifyAdaptiveContext("How long did physiotherapy last?")).toBe("temporal-span");
		expect(classifyAdaptiveContext("How are Alice and Bob related, and where do they work?")).toBe("multi-source");
		expect(classifyAdaptiveContext("Summarize everything you know about Northwind.")).toBe("broad");

		expect(adaptiveContextPlan("Which database does Northwind use?", DEPTH_PLAN)).toMatchObject({
			profile: "targeted", maxAssertionsPerNode: 1, maxContextChars: 12_000,
		});
		expect(adaptiveContextPlan("When did Rita move?", { ...DEPTH_PLAN, maxContextChars: 2_800 }))
			.toMatchObject({ profile: "temporal-point", maxAssertionsPerNode: 1, maxContextChars: 2_800 });
		expect(adaptiveContextPlan("Summarize everything.", DEPTH_PLAN).maxContextChars)
			.toBe(ADAPTIVE_CONTEXT_HARD_MAX);
	});
});

describe("E10 compiler", () => {
	it("preserves object breadth while selecting one assertion per targeted object and exact-deduplicating", () => {
		const entries = [
			node("Northwind", ["Northwind uses Postgres", "unrelated sibling one", "unrelated sibling two"]),
			node("Postgres", ["Northwind uses Postgres", "Postgres detail"]),
			node("Queue", ["The queue uses LISTEN/NOTIFY", "Queue detail"]),
		];
		const result = compileAdaptiveContext("Which database does Northwind use?", {
			entries,
			plan: DEPTH_PLAN,
		});

		expect(result.context).toContain("Northwind uses Postgres");
		expect(result.context).toContain("The queue uses LISTEN/NOTIFY");
		expect(result.context).not.toContain("unrelated sibling one");
		expect(result.context.match(/Northwind uses Postgres/g)).toHaveLength(1);
		expect(result.telemetry).toMatchObject({
			profile: "targeted",
			selectedEntries: 3,
			profileSelectedAssertions: 3,
			renderedEntries: 3,
			renderedAssertions: 2,
			exactDuplicatesRemoved: 1,
			hardCapDroppedAssertions: 0,
		});
	});

	it("groups an exact source beside its assertion and counts source assembly", () => {
		const entries = [node("Rita", ["Rita moved to Lisbon", "Rita likes pottery"])];
		const sourceExpansion = {
			lines: ["Source evidence [source message time 2024-03-04; user]: Rita moved to Lisbon."],
			records: [{
				episodeId: "episode-1",
				assertionKeys: ["slice:Rita-0"],
				line: "Source evidence [source message time 2024-03-04; user]: Rita moved to Lisbon.",
			}],
		};
		const result = compileAdaptiveContext("When did Rita move to Lisbon?", {
			entries,
			plan: DEPTH_PLAN,
			sourceExpansion,
		});
		const lines = result.context.split("\n");
		expect(lines[0]).toContain("Source evidence");
		expect(lines[1]).toContain("Rita moved to Lisbon");
		expect(result.telemetry).toMatchObject({ selectedSources: 1, renderedSources: 1, hardCapDroppedSources: 0 });
	});

	it("keeps span evidence, reports intentional omissions separately, and clips astral Unicode safely", () => {
		const evidence = [
			"Physio started 2025-01-06",
			"Physio paused 2025-03-10",
			"Physio resumed 2025-04-14",
			"Physio ended 2025-07-22",
			"fifth sibling is intentionally omitted",
		];
		const result = compileAdaptiveContext("How long did physiotherapy last?", {
			entries: [node("Physio", evidence), node("Astral", [`${"🧠".repeat(20_000)} tail`])],
			plan: DEPTH_PLAN,
		});
		expect(result.context).toContain("Physio ended 2025-07-22");
		expect(result.context).not.toContain("fifth sibling");
		expect(result.context.length).toBeLessThanOrEqual(20_000);
		expect(result.context.endsWith("\ud83e")).toBe(false);
		expect(result.telemetry.intentionalAssertionOmissions).toBe(1);
		expect(result.telemetry.hardCapDroppedAssertions).toBeGreaterThanOrEqual(0);
	});
});

describe("E10 recall integration", () => {
	it("leaves E7 byte-identical while OFF and compiles the same selected breadth while ON", async () => {
		const userId = `e10-recall-${crypto.randomUUID()}`;
		const otherUser = `other-${userId}`;
		const now = Date.now();
		const seed = async (owner, nodeId, label, facts) => {
			await env.DB.prepare(
				`INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at, heat_score)
				 VALUES (?, ?, ?, 'project', 'active', ?, ?, 1)`,
			).bind(nodeId, owner, label, now, now).run();
			for (const [index, fact] of facts.entries()) {
				await env.DB.prepare(
					`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at)
					 VALUES (?, ?, ?, ?, 'fact', 1, ?)`,
				).bind(`${nodeId}:slice:${index}`, owner, nodeId, fact, now + index).run();
			}
		};
		await seed(userId, `${userId}:northwind`, "Northwind", [
			"Northwind uses Postgres for its queue.",
			"Northwind has an unrelated dashboard color.",
			"Northwind has an unrelated office detail.",
			"Northwind has an unrelated mascot.",
		]);
		await seed(userId, `${userId}:postgres`, "Postgres", [
			"Postgres powers Northwind's queue.",
			"Postgres unrelated sibling detail.",
		]);
		await seed(otherUser, `${otherUser}:canary`, "Cross tenant", ["SECRET CROSS TENANT CANARY"]);

		const base = {
			...env,
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: userId,
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
		};
		const explicitOff = {
			...base,
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: "off",
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS: userId,
		};
		const treatment = {
			...base,
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: "allowlist",
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS: userId,
		};
		const options = { limit: 200, limitMode: "depth", internalTrace: true };
		const absent = await recall(base, getConfig(env), userId, "Which database powers Northwind's queue?", options);
		const off = await recall(explicitOff, getConfig(env), userId, "Which database powers Northwind's queue?", options);
		const on = await recall(treatment, getConfig(env), userId, "Which database powers Northwind's queue?", options);

		expect(off).toEqual(absent);
		expect(on.items).toEqual(off.items);
		expect(on.context.length).toBeLessThan(off.context.length);
		expect(on.context).toContain("Postgres");
		expect(on.context).not.toContain("unrelated dashboard color");
		expect(on.context).not.toContain("SECRET CROSS TENANT CANARY");
		expect(on).toMatchObject({
			adaptive_context_used: true,
			adaptive_context_profile: "targeted",
			adaptive_context_max_assertions_per_node: 1,
			adaptive_context_hard_cap_dropped_assertions: 0,
		});
		expect(on.internal_trace.adaptive_context_rendered_assertion_ids.length).toBeGreaterThan(0);
	});
});
