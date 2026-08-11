import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	memoryV3SourceExpansionConfig,
	memoryV3SourceExpansionEnabled,
} from "../src/lib/memory_v3.js";
import {
	SOURCE_EXPANSION_ASSERTION_MAX,
	SOURCE_EXPANSION_EPISODE_MAX,
	SOURCE_EXPANSION_TEXT_CODEPOINT_MAX,
	expandSelectedSourceEvidence,
} from "../src/pipeline/source_expansion.mjs";
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
		...overrides,
	};
}

async function seedExactProjection({
	userId,
	objectKind = "slice",
	objectId,
	projectId = null,
	text = "On March 4, Rita said she moved to Lisbon.",
	role = "user",
	sourceTime = Date.parse("2024-03-04T09:30:00Z"),
	messageIndex = 0,
} = {}) {
	const suffix = crypto.randomUUID();
	const packetId = `packet-${suffix}`;
	const episodeId = `episode-${suffix}`;
	const messageId = `message-${suffix}`;
	const runId = `run-${suffix}`;
	const candidateId = `candidate-${suffix}`;
	await env.DB.prepare(
		`INSERT INTO source_episodes
		 (id, user_id, project_id, source_packet_id, message_id, message_index, role,
		  text, text_hash, source_time, source_time_precision, observed_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'time', ?, ?)`,
	).bind(
		episodeId, userId, projectId, packetId, messageId, messageIndex, role,
		text, `hash-${suffix}`, sourceTime, NOW, NOW,
	).run();
	await env.DB.prepare(
		`INSERT INTO semantic_atom_capture_runs
		 (id, user_id, project_id, source_packet_id, chunk_key, status, model,
		  schema_version, accepted_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'completed', '@cf/test/model', 'test/v1', ?, ?, ?)`,
	).bind(runId, userId, projectId, packetId, `chunk-${suffix}`, NOW, NOW, NOW).run();
	await env.DB.prepare(
		`INSERT INTO semantic_atom_candidates
		 (id, user_id, project_id, capture_run_id, source_episode_id, source_packet_id,
		  chunk_key, source_message_id, start_code_point, end_code_point, evidence_quote,
		  evidence_hash, dedupe_key, atom_type, entity, entity_type, attribute, value,
		  assertion, cardinality, confidence, extraction_model, schema_version, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 4, 'said', ?, ?, 'fact', 'Rita', 'person',
		  'location', 'Lisbon', 'Rita moved to Lisbon', 'single', 0.99,
		  '@cf/test/model', 'test/v1', 'promoted', ?)`,
	).bind(
		candidateId, userId, projectId, runId, episodeId, packetId,
		`chunk-${suffix}`, messageId, `evidence-${suffix}`, `dedupe-${suffix}`, NOW,
	).run();
	await env.DB.prepare(
		`INSERT INTO semantic_atom_projections
		 (candidate_id, user_id, project_id, source_episode_id, source_packet_id,
		  extraction_run_id, outcome, object_kind, object_id, schema_version, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'promoted', ?, ?, 'test/v1', ?)`,
	).bind(candidateId, userId, projectId, episodeId, packetId, runId, objectKind, objectId, NOW).run();
	return { episodeId, packetId, messageId, candidateId };
}

function entryFor(kind, id, text = "Rita moved to Lisbon") {
	return {
		type: "node",
		id: "node-rita",
		item: {
			id: "node-rita",
			label: "Rita",
			evidence: [{ key: `${kind}:${id}`, kind, text }],
		},
	};
}

async function seedSemanticSlice(userId, nodeId, objectId, text, projectId = null) {
	await env.DB.prepare(
		`INSERT INTO nodes
		 (id, user_id, label, category, state, created_at, updated_at, heat_score, project_id)
		 VALUES (?, ?, 'Rita', 'person', 'active', ?, ?, 1, ?)`,
	).bind(nodeId, userId, NOW, NOW, projectId).run();
	await env.DB.prepare(
		`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at, project_id)
		 VALUES (?, ?, ?, ?, 'fact', 1, ?, ?)`,
	).bind(objectId, userId, nodeId, text, NOW, projectId).run();
}

describe("E9A source expansion flag", () => {
	it("fails closed and requires the parent V3 and E7 allowlists", () => {
		const userId = "source-treatment";
		const treatment = treatmentEnv(userId);
		expect(memoryV3SourceExpansionConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3SourceExpansionEnabled(treatment, userId)).toBe(true);
		expect(memoryV3SourceExpansionEnabled(treatment, `${userId}-suffix`)).toBe(false);
		expect(memoryV3SourceExpansionEnabled({ ...treatment, ITSUKI_MEMORY_V3: "off" }, userId)).toBe(false);
		expect(memoryV3SourceExpansionEnabled({ ...treatment, ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off" }, userId)).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3SourceExpansionEnabled({ ...treatment, ITSUKI_MEMORY_V3_SOURCE_EXPANSION: value }, userId)).toBe(false);
		}
	});
});

describe("E9A exact source expansion", () => {
	it("leaves E7 byte-identical while OFF and adds only the exact source while ON", async () => {
		const userId = `e9-recall-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		const objectId = `slice-${crypto.randomUUID()}`;
		await seedSemanticSlice(userId, nodeId, objectId, "Rita moved to Lisbon.");
		await seedExactProjection({
			userId,
			objectId,
			text: "On March 4, Rita told me she had moved to Lisbon for a new role.",
		});
		const e7 = {
			...env,
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: userId,
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
		};
		const explicitOff = {
			...e7,
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "off",
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS: userId,
		};
		const options = { limit: 200, limitMode: "depth", internalTrace: true };
		const before = await recall(e7, getConfig(env), userId, "When did Rita move to Lisbon?", options);
		const off = await recall(explicitOff, getConfig(env), userId, "When did Rita move to Lisbon?", options);
		const on = await recall(treatmentEnv(userId), getConfig(env), userId, "When did Rita move to Lisbon?", options);

		expect(off.context).toBe(before.context);
		expect(off.items).toEqual(before.items);
		expect(off.internal_trace).toEqual(before.internal_trace);
		expect(off).toEqual(before);
		expect(on.context).toContain("Source evidence [source message time 2024-03-04T09:30:00.000Z; user]");
		expect(on.context).toContain("Rita told me she had moved to Lisbon");
		expect(on.context).toContain("Rita moved to Lisbon.");
		expect(on.context.length).toBeLessThanOrEqual(24_000);
		expect(on).toMatchObject({
			source_expansion_used: true,
			source_expansion_assertions: 1,
			source_expansion_linked_assertions: 1,
			source_expansion_episodes: 1,
			source_expansion_failed: false,
		});
	});

	it("renders only the exact projected, scope-bound episode with an honest source-time label", async () => {
		const userId = `e9-exact-${crypto.randomUUID()}`;
		const objectId = `slice-${crypto.randomUUID()}`;
		const seeded = await seedExactProjection({ userId, objectId });
		await seedExactProjection({
			userId: `other-${userId}`,
			objectId,
			text: "Cross-tenant canary must never render.",
		});

		const result = await expandSelectedSourceEvidence(env, userId, [entryFor("slice", objectId)], {
			maxLineItems: 4,
			recallScope: "global",
		});

		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toContain("Source evidence [source message time 2024-03-04T09:30:00.000Z; user]");
		expect(result.lines[0]).toContain("Rita said she moved to Lisbon");
		expect(result.lines.join(" ")).not.toContain("Cross-tenant canary");
		expect(result.episodeIds).toEqual([seeded.episodeId]);
		expect(result.records).toEqual([expect.objectContaining({
			episodeId: seeded.episodeId,
			assertionKeys: [`slice:${objectId}`],
			sourceTime: Date.parse("2024-03-04T09:30:00Z"),
		})]);
		expect(result).toMatchObject({ assertions: 1, linkedAssertions: 1, episodes: 1, failed: false });
	});

	it("applies project scope before limiting and never accepts mismatched provenance", async () => {
		const userId = `e9-scope-${crypto.randomUUID()}`;
		const projectAId = `slice-a-${crypto.randomUUID()}`;
		const projectBId = `slice-b-${crypto.randomUUID()}`;
		const globalId = `slice-g-${crypto.randomUUID()}`;
		await seedExactProjection({ userId, objectId: projectAId, projectId: "project-a", text: "Project A source." });
		await seedExactProjection({ userId, objectId: projectBId, projectId: "project-b", text: "Project B source." });
		await seedExactProjection({ userId, objectId: globalId, text: "Global source." });
		const entries = [
			entryFor("slice", projectAId),
			entryFor("slice", projectBId),
			entryFor("slice", globalId),
		];

		const projectOnly = await expandSelectedSourceEvidence(env, userId, entries, {
			maxLineItems: 4,
			recallScope: "project_only",
			projectId: "project-a",
		});
		expect(projectOnly.lines.join(" ")).toContain("Project A source");
		expect(projectOnly.lines.join(" ")).not.toContain("Project B source");
		expect(projectOnly.lines.join(" ")).not.toContain("Global source");

		const layered = await expandSelectedSourceEvidence(env, userId, entries, {
			maxLineItems: 4,
			recallScope: "project_then_global",
			projectId: "project-a",
		});
		expect(layered.lines.join(" ")).toContain("Project A source");
		expect(layered.lines.join(" ")).toContain("Global source");
		expect(layered.lines.join(" ")).not.toContain("Project B source");

		const mismatchedId = `slice-mismatch-${crypto.randomUUID()}`;
		const mismatched = await seedExactProjection({ userId, objectId: mismatchedId, text: "Mismatched source." });
		await env.DB.prepare(
			"UPDATE source_episodes SET owner_user_id = 'different-owner' WHERE id = ? AND user_id = ?",
		).bind(mismatched.episodeId, userId).run();
		const rejectedMismatch = await expandSelectedSourceEvidence(env, userId, [entryFor("slice", mismatchedId)]);
		expect(rejectedMismatch.lines).toEqual([]);
		expect(rejectedMismatch.linkedAssertions).toBe(0);

		const deletedId = `slice-deleted-${crypto.randomUUID()}`;
		const deleted = await seedExactProjection({ userId, objectId: deletedId, text: "Deleted source." });
		await env.DB.prepare("DELETE FROM source_episodes WHERE id = ? AND user_id = ?")
			.bind(deleted.episodeId, userId).run();
		const rejectedDeleted = await expandSelectedSourceEvidence(env, userId, [entryFor("slice", deletedId)]);
		expect(rejectedDeleted.lines).toEqual([]);
		expect(rejectedDeleted.linkedAssertions).toBe(0);

		const invalidScope = await expandSelectedSourceEvidence(env, userId, [entryFor("slice", projectAId)], {
			recallScope: "typo-means-global",
			projectId: "project-a",
		});
		expect(invalidScope.lines).toEqual([]);
	});

	it("re-scrubs corrupt rows, bounds assertions/episodes/code points, and degrades without content", async () => {
		const userId = `e9-bounds-${crypto.randomUUID()}`;
		const entries = [];
		for (let index = 0; index < SOURCE_EXPANSION_ASSERTION_MAX + 3; index++) {
			const objectId = `slice-${index}-${crypto.randomUUID()}`;
			await seedExactProjection({
				userId,
				objectId,
				messageIndex: index,
				text: `${"\u{1F9E0}".repeat(SOURCE_EXPANSION_TEXT_CODEPOINT_MAX + 20)} AKIA1234567890ABCDEF private_key=\"not-safe-123\"`,
			});
			entries.push(entryFor("slice", objectId));
		}
		const result = await expandSelectedSourceEvidence(env, userId, entries, { maxLineItems: 4 });
		expect(result.assertions).toBe(SOURCE_EXPANSION_ASSERTION_MAX);
		expect(result.episodes).toBe(SOURCE_EXPANSION_EPISODE_MAX);
		expect(result.lines).toHaveLength(SOURCE_EXPANSION_EPISODE_MAX);
		expect(result.lines.every((line) => [...line.slice(line.indexOf(": ") + 2)].length <= SOURCE_EXPANSION_TEXT_CODEPOINT_MAX + 1)).toBe(true);
		expect(result.lines.join(" ")).not.toContain("AKIA1234567890ABCDEF");
		expect(result.lines.join(" ")).not.toContain("not-safe-123");

		const failed = await expandSelectedSourceEvidence({ DB: { prepare() { throw new Error("synthetic db failure"); } } }, userId, entries);
		expect(failed).toMatchObject({ lines: [], episodes: 0, failed: true });
		expect(JSON.stringify(failed)).not.toContain("synthetic db failure");
	});
});
