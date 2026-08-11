import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	memoryV3EpisodeFallbackConfig,
	memoryV3EpisodeFallbackEnabled,
} from "../src/lib/memory_v3.js";
import {
	EPISODE_FALLBACK_CANDIDATE_MAX,
	EPISODE_FALLBACK_CHAR_MAX,
	EPISODE_FALLBACK_RENDER_MAX,
	EPISODE_FALLBACK_TEXT_CODEPOINT_MAX,
	episodeFallbackDecision,
	episodeFallbackQueryTokens,
	findEpisodeFallbackEvidence,
} from "../src/pipeline/episode_fallback.mjs";
import { getConfig } from "../src/config.js";
import { recall } from "../src/pipeline/recall.js";

const NOW = Date.parse("2026-08-11T12:00:00Z");

function treatmentEnv(userId, overrides = {}) {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
		ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "allowlist",
		ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS: userId,
		ITSUKI_MEMORY_V3_EPISODE_FALLBACK: "allowlist",
		ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS: userId,
		...overrides,
	};
}

async function seedEpisode({
	userId,
	projectId = null,
	text = "Rita chose SQLite as the database for the field application.",
	sourceTime = Date.parse("2025-02-03T09:30:00Z"),
	messageIndex = 0,
} = {}) {
	const suffix = crypto.randomUUID();
	const id = `episode-${suffix}`;
	const packetId = `packet-${suffix}`;
	const messageId = `message-${suffix}`;
	await env.DB.prepare(
		`INSERT INTO source_episodes
		 (id, user_id, memory_user_id, owner_user_id, external_user_id, project_id,
		  source_packet_id, message_id, message_index, role, text, text_hash,
		  source_time, source_time_precision, observed_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, 'time', ?, ?)`,
	).bind(
		id, userId, userId, userId, userId, projectId,
		packetId, messageId, messageIndex, text, `hash-${suffix}`, sourceTime, NOW, NOW,
	).run();
	return { id, packetId, messageId };
}

async function seedNode(userId, projectId = null) {
	const nodeId = `node-${crypto.randomUUID()}`;
	const sliceId = `slice-${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes
		 (id, user_id, label, category, state, created_at, updated_at, heat_score, project_id)
		 VALUES (?, ?, 'Rita', 'person', 'active', ?, ?, 1, ?)`,
	).bind(nodeId, userId, NOW, NOW, projectId).run();
	await env.DB.prepare(
		`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at, project_id)
		 VALUES (?, ?, ?, 'Rita uses SQLite.', 'fact', 1, ?, ?)`,
	).bind(sliceId, userId, nodeId, NOW, projectId).run();
	return { nodeId, sliceId };
}

describe("E9B episode fallback flag", () => {
	it("fails closed and requires parent V3, E7, E9A, and exact E9B membership", () => {
		const userId = "episode-fallback-treatment";
		const treatment = treatmentEnv(userId);
		expect(memoryV3EpisodeFallbackConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3EpisodeFallbackEnabled(treatment, userId)).toBe(true);
		expect(memoryV3EpisodeFallbackEnabled(treatment, `${userId}-suffix`)).toBe(false);
		expect(memoryV3EpisodeFallbackEnabled({ ...treatment, ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "off" }, userId)).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3EpisodeFallbackEnabled({ ...treatment, ITSUKI_MEMORY_V3_EPISODE_FALLBACK: value }, userId)).toBe(false);
		}
	});
});

describe("E9B deterministic trigger and query", () => {
	it("triggers only for sparse or entirely unbacked semantic evidence", () => {
		expect(episodeFallbackDecision({ entries: [], sourceExpansion: {} })).toMatchObject({ triggered: true });
		expect(episodeFallbackDecision({ entries: [{}, {}], sourceExpansion: { assertions: 2, linkedAssertions: 2 } }))
			.toMatchObject({ triggered: true, reason: "sparse_semantic_items" });
		expect(episodeFallbackDecision({ entries: [{}, {}, {}], sourceExpansion: { assertions: 2, linkedAssertions: 0 } }))
			.toMatchObject({ triggered: true, reason: "unbacked_semantic_assertions" });
		expect(episodeFallbackDecision({ entries: [{}, {}, {}], sourceExpansion: { assertions: 2, linkedAssertions: 1 } }))
			.toEqual({ triggered: false, reason: "semantic_evidence_sufficient", semanticItems: 3 });
	});

	it("uses Unicode-aware, fixed, bounded content terms", () => {
		expect(episodeFallbackQueryTokens("When did José move to Malmö, and why did he move?"))
			.toEqual(["jose", "move", "malmo"]);
		expect(episodeFallbackQueryTokens(Array.from({ length: 30 }, (_, i) => `term${i}`).join(" ")))
			.toHaveLength(12);
	});
});

describe("E9B bounded source recovery", () => {
	it("recovers a sparse query, excludes E9A's episode, and stays byte-identical while OFF", async () => {
		const userId = `e9b-recall-${crypto.randomUUID()}`;
		await seedNode(userId);
		const episode = await seedEpisode({ userId });
		const base = treatmentEnv(userId, {
			ITSUKI_MEMORY_V3_EPISODE_FALLBACK: "off",
			ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS: userId,
		});
		const absent = { ...base };
		delete absent.ITSUKI_MEMORY_V3_EPISODE_FALLBACK;
		delete absent.ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS;
		const options = { limit: 200, limitMode: "depth", internalTrace: true };
		const before = await recall(absent, getConfig(env), userId, "Which database did Rita choose?", options);
		const explicitOff = await recall(base, getConfig(env), userId, "Which database did Rita choose?", options);
		expect(explicitOff.context).toBe(before.context);
		expect(explicitOff.items).toEqual(before.items);
		expect(explicitOff.internal_trace).toEqual(before.internal_trace);
		expect(explicitOff).not.toHaveProperty("episode_fallback_used");
		expect({ ...explicitOff, source_expansion_ms: 0 }).toEqual({ ...before, source_expansion_ms: 0 });

		const direct = await findEpisodeFallbackEvidence(env, userId, "Which database did Rita choose?", {
			entries: [{}, {}],
			sourceExpansion: { assertions: 1, linkedAssertions: 1, episodeIds: [episode.id] },
		});
		expect(direct.triggered).toBe(true);
		expect(direct.lines).toEqual([]);
		expect(direct.duplicateEpisodes).toBe(1);

		const on = await recall(treatmentEnv(userId), getConfig(env), userId, "Which database did Rita choose?", options);
		expect(on.context).toContain("Episode fallback evidence [source message time 2025-02-03T09:30:00.000Z; user]");
		expect(on.context).toContain("Rita chose SQLite");
		expect(on).toMatchObject({
			episode_fallback_used: true,
			episode_fallback_triggered: true,
			episode_fallback_episodes: 1,
			episode_fallback_failed: false,
		});
	});

	it("recovers from the source layer even when no semantic object exists", async () => {
		const userId = `e9b-zero-semantic-${crypto.randomUUID()}`;
		await seedEpisode({ userId, text: "Rita chose SQLite as the database for the offline field application." });
		const recalled = await recall(
			treatmentEnv(userId), getConfig(env), userId, "Which database did Rita choose?",
			{ limit: 200, limitMode: "depth", internalTrace: true },
		);
		expect(recalled.context).toContain("Episode fallback evidence");
		expect(recalled.context).toContain("SQLite");
		// `count` remains the semantic/staged item contract; fallback has explicit
		// counters and does not masquerade as a graph item.
		expect(recalled.count).toBe(0);
		expect(recalled.episode_fallback_episodes).toBe(1);
	});

	it("applies tenant/project scope before limit and never leaks another scope", async () => {
		const userId = `e9b-scope-${crypto.randomUUID()}`;
		await seedEpisode({ userId, projectId: "project-a", text: "Rita chose SQLite as the project A database." });
		await seedEpisode({ userId, projectId: "project-b", text: "Rita chose Oracle as the project B database." });
		await seedEpisode({ userId, text: "Rita chose Postgres as the global database." });
		await seedEpisode({ userId: `other-${userId}`, projectId: "project-a", text: "Rita chose DB2 as the other tenant database." });

		const projectOnly = await findEpisodeFallbackEvidence(env, userId, "Which database did Rita choose?", {
			entries: [], recallScope: "project_only", projectId: "project-a",
		});
		expect(projectOnly.lines.join(" ")).toContain("project A database");
		expect(projectOnly.lines.join(" ")).not.toMatch(/Oracle|Postgres|DB2/);

		const layered = await findEpisodeFallbackEvidence(env, userId, "Which database did Rita choose?", {
			entries: [], recallScope: "project_then_global", projectId: "project-a",
		});
		expect(layered.lines.join(" ")).toContain("project A database");
		expect(layered.lines.join(" ")).toContain("global database");
		expect(layered.lines.join(" ")).not.toMatch(/Oracle|DB2/);
	});

	it("bounds candidates/rendering/code points, re-scrubs corrupt rows, and fails without content", async () => {
		const userId = `e9b-bounds-${crypto.randomUUID()}`;
		for (let index = 0; index < EPISODE_FALLBACK_CANDIDATE_MAX + 4; index++) {
			await seedEpisode({
				userId,
				messageIndex: index,
				text: `Rita database ${"\u{1F9E0}".repeat(EPISODE_FALLBACK_TEXT_CODEPOINT_MAX + 20)} AKIA1234567890ABCDEF private_key=\"unsafe-canary\"`,
			});
		}
		const result = await findEpisodeFallbackEvidence(env, userId, "Which Rita database?", { entries: [] });
		expect(result.candidates).toBe(EPISODE_FALLBACK_CANDIDATE_MAX);
		expect(result.episodes).toBeGreaterThan(0);
		expect(result.episodes).toBeLessThanOrEqual(EPISODE_FALLBACK_RENDER_MAX);
		expect(result.chars).toBeLessThanOrEqual(EPISODE_FALLBACK_CHAR_MAX);
		expect(result.lines.join(" ")).not.toMatch(/AKIA1234567890ABCDEF|unsafe-canary/);
		expect(result.lines.every((line) => [...line.slice(line.indexOf(": ") + 2)].length <= EPISODE_FALLBACK_TEXT_CODEPOINT_MAX + 1)).toBe(true);

		const notTriggered = await findEpisodeFallbackEvidence(
			{ DB: { prepare() { throw new Error("must not search"); } } }, userId, "Rita database", {
				entries: [{}, {}, {}], sourceExpansion: { assertions: 1, linkedAssertions: 1 },
			},
		);
		expect(notTriggered).toMatchObject({ triggered: false, failed: false, episodes: 0 });

		const failed = await findEpisodeFallbackEvidence(
			{ DB: { prepare() { throw new Error("private query detail"); } } }, userId, "Rita database", { entries: [] },
		);
		expect(failed).toMatchObject({ triggered: true, failed: true, lines: [], episodes: 0 });
		expect(JSON.stringify(failed)).not.toContain("private query detail");
	});
});
