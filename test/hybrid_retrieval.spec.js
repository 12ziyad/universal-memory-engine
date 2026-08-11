import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";
import { HYBRID_ASSERTION_CANDIDATE_MAX, rankHybridAssertions } from "../src/pipeline/hybrid_retrieval.mjs";
import { recall } from "../src/pipeline/recall.js";

const NOW = Date.now();

function treatmentEnv(userId) {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
	};
}

async function seedNode(userId, id, label, projectId = null) {
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at, heat_score, project_id)
		 VALUES (?, ?, ?, 'project', 'active', ?, ?, 1, ?)`,
	).bind(id, userId, label, NOW, NOW, projectId).run();
}

async function seedSlice(userId, id, nodeId, text, offset = 0, projectId = null) {
	await env.DB.prepare(
		`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at, project_id)
		 VALUES (?, ?, ?, ?, 'fact', 1, ?, ?)`,
	).bind(id, userId, nodeId, text, NOW + offset, projectId).run();
}

const options = { limit: 200, limitMode: "depth", internalTrace: true };

describe("E7 assertion-level hybrid retrieval", () => {
	it("surfaces a relevant fifth assertion that object retrieval selected but the four-item renderer dropped", async () => {
		const userId = `e7-cap-${crypto.randomUUID()}`;
		const nodeId = `${userId}:atlas`;
		await seedNode(userId, nodeId, "Project Atlas");
		for (let i = 1; i <= 4; i++) {
			await seedSlice(userId, `${nodeId}:noise:${i}`, nodeId, `Project Atlas routine note ${i}.`, i);
		}
		await seedSlice(userId, `${nodeId}:target`, nodeId, "Project Atlas launch codeword is heliotrope.", 5);

		const controlEnv = { ...treatmentEnv(userId), ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off" };
		const control = await recall(controlEnv, getConfig(env), userId, "What is the launch codeword for Project Atlas?", options);
		const treatment = await recall(treatmentEnv(userId), getConfig(env), userId, "What is the launch codeword for Project Atlas?", options);

		expect(control.context).not.toContain("heliotrope");
		expect(treatment.context).toContain("heliotrope");
		expect(treatment.hybrid_retrieval_used).toBe(true);
		expect(treatment.hybrid_assertion_candidates).toBeGreaterThan(0);
		expect(treatment.context.length).toBeLessThanOrEqual(24_000);
	});

	it("puts a dated event ahead of unrelated slices for a temporal query", async () => {
		const userId = `e7-time-${crypto.randomUUID()}`;
		const nodeId = `${userId}:rita`;
		await seedNode(userId, nodeId, "Rita");
		for (let i = 1; i <= 4; i++) {
			await seedSlice(userId, `${nodeId}:noise:${i}`, nodeId, `Rita background note ${i}.`, i);
		}
		await env.DB.prepare(
			`INSERT INTO events
			 (id, user_id, node_id, action, text, importance, happened_at, happened_at_source, created_at)
			 VALUES (?, ?, ?, 'MOVE', 'Rita moved to Lisbon', 1, ?, 'source_time', ?)`,
		).bind(`${nodeId}:move`, userId, nodeId, Date.parse("2024-03-04T00:00:00Z"), NOW + 5).run();

		const result = await recall(treatmentEnv(userId), getConfig(env), userId, "When did Rita move to Lisbon?", options);
		expect(result.context).toContain("Rita moved to Lisbon (2024-03-04)");
		expect(result.hybrid_lane_counts.temporal).toBeGreaterThan(0);
	});

	it("is byte-identical when the nested flag is off", async () => {
		const userId = `e7-off-${crypto.randomUUID()}`;
		const nodeId = `${userId}:node`;
		await seedNode(userId, nodeId, "Stable decision");
		await seedSlice(userId, `${nodeId}:slice`, nodeId, "Use bounded deterministic fusion.");
		const parent = { ...env, ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: userId };
		const explicitOff = { ...parent, ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off", ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId };
		const before = await recall(parent, getConfig(env), userId, "What was the stable fusion decision?", options);
		const after = await recall(explicitOff, getConfig(env), userId, "What was the stable fusion decision?", options);
		expect(after.context).toBe(before.context);
		expect(after.items).toEqual(before.items);
		expect(after.internal_trace).toEqual(before.internal_trace);
		expect(after.hybrid_retrieval_used).toBe(false);
	});

	it("surfaces a ranked relation beyond the legacy first-three relation cap", async () => {
		const userId = `e7-edge-${crypto.randomUUID()}`;
		const root = `${userId}:root`;
		await seedNode(userId, root, "Nora");
		for (let i = 1; i <= 4; i++) {
			const other = `${userId}:other:${i}`;
			await seedNode(userId, other, i === 4 ? "Blue Harbor" : `Noise ${i}`);
			await env.DB.prepare(
				`INSERT INTO edges (id, user_id, from_node, to_node, type, fact, created_at, weight)
				 VALUES (?, ?, ?, ?, 'WORKS_AT', ?, ?, 1)`,
			).bind(`${root}:edge:${i}`, userId, root, other,
				i === 4 ? "Nora works at Blue Harbor" : `Nora has unrelated relation ${i}`, NOW + i).run();
		}
		const result = await recall(treatmentEnv(userId), getConfig(env), userId, "Where does Nora work at Blue Harbor?", options);
		expect(result.context).toContain("Nora works at Blue Harbor");
		expect(result.hybrid_lane_counts.relation).toBeGreaterThan(0);
	});

	it("keeps assertion candidates inside the requested project before fusion", async () => {
		const userId = `e7-project-${crypto.randomUUID()}`;
		const a = `${userId}:a`;
		const b = `${userId}:b`;
		await seedNode(userId, a, "Project A", "project-a");
		await seedNode(userId, b, "Project B", "project-b");
		await seedSlice(userId, `${a}:slice`, a, "Shared codeword is amber.", 1, "project-a");
		await seedSlice(userId, `${b}:slice`, b, "Shared codeword is cobalt.", 1, "project-b");
		const result = await recall(treatmentEnv(userId), getConfig(env), userId, "What is the shared codeword?", {
			...options,
			recallScope: "project_only",
			memoryScope: { projectId: "project-a" },
		});
		expect(result.context).toContain("amber");
		expect(result.context).not.toContain("cobalt");
	});

	it("bounds every assertion union and exposes only content-free counters", () => {
		const node = { id: "bounded-node", label: "Bounded" };
		const slices = Array.from({ length: 500 }, (_, index) => ({
			id: `slice-${index}`,
			node_id: node.id,
			text: `needle assertion ${index}`,
		}));
		const ranked = rankHybridAssertions("find needle assertion", { nodes: [node], slices }, { candidateLimit: 10_000 });
		expect(ranked.candidates).toHaveLength(HYBRID_ASSERTION_CANDIDATE_MAX);
		expect(ranked.laneCounts.lexical).toBe(HYBRID_ASSERTION_CANDIDATE_MAX);
		expect(JSON.stringify({ candidates: ranked.candidates.length, lanes: ranked.laneCounts })).not.toContain("needle");
	});
});
