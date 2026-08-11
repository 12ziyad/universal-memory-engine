import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { runExtraction } from "../src/pipeline/extract.js";
import { deleteSourceEpisodes, writeSourceEpisodes } from "../src/pipeline/episodes.js";
import {
	ATOMIC_CAPTURE_MODEL,
	atomicCaptureSummaryForExtractionRun,
	captureAtomicCandidates,
	countSemanticAtomCandidates,
} from "../src/pipeline/atomic_candidates.mjs";

const EMPTY_GRAPH = { objects: [], notes: "control graph writes nothing" };
const RULES = { customInstructions: "", includes: [], excludes: [] };

function atom(messageId = "m1", overrides = {}) {
	return {
		type: "decision",
		entity: "Northwind",
		entity_type: "project",
		attribute: "database policy",
		value: "sqlc without an ORM",
		assertion: "Northwind uses sqlc and does not use an ORM.",
		source_message_id: messageId,
		evidence_quote: "uses sqlc; no ORM",
		cardinality: "single",
		confidence: 0.97,
		...overrides,
	};
}

function flagged(userId, projectId = "project-a") {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: userId,
		USE_VECTORS: "false",
		ENABLE_PASS2: "false",
		_projectId: projectId,
	};
}

async function fixture(label, { projectId = "project-a", content = "Northwind uses sqlc; no ORM." } = {}) {
	const userId = `atomic-${label}-${crypto.randomUUID()}`;
	const sourcePacketId = `packet-${crypto.randomUUID()}`;
	const message = {
		id: "m1",
		role: "user",
		content,
		ts: 1_762_250_400_000,
		source_time: { epoch_ms: 1_762_250_400_000, offset_minutes: 0, precision: "second" },
	};
	const testEnv = flagged(userId, projectId);
	const episode = await writeSourceEpisodes(testEnv, userId, {
		sourcePacketId,
		messages: [message],
		projectId,
		projectName: "Project A",
		rules: RULES,
		acceptedAt: message.ts,
		required: true,
	});
	expect(episode).toMatchObject({ ok: true, written: 1 });
	return { userId, sourcePacketId, message, testEnv, projectId };
}

async function extract(f, atomicLlmResponse, extra = {}) {
	return runExtraction(f.testEnv, f.userId, [f.message], [], {
		llmResponse: EMPTY_GRAPH,
		atomicLlmResponse,
		meta: {
			source_packet_id: f.sourcePacketId,
			accepted_at: f.message.ts,
			project_id: f.projectId,
			project_name: "Project A",
		},
		...extra,
	});
}

describe("E4 atomic candidate persistence", () => {
	it("stores only exact, source-episode-backed atoms without changing the graph outcome", async () => {
		const f = await fixture("grounded");
		const result = await extract(f, { atoms: [atom()] });

		expect(result.outcome).toBe("meaningful_no_write");
		expect(result.receipt).toMatchObject({
			atomic_capture_enabled: true,
			atomic_capture_outcome: "completed",
			atomic_capture_accepted: 1,
			atomic_capture_stored: 1,
			atomic_capture_complete: true,
		});
		const row = await env.DB.prepare(
			`SELECT c.*, e.text AS episode_text
			 FROM semantic_atom_candidates c
			 JOIN source_episodes e ON e.id = c.source_episode_id
			 WHERE c.user_id = ?`,
		).bind(f.userId).first();
		expect(row).toMatchObject({
			project_id: f.projectId,
			source_packet_id: f.sourcePacketId,
			source_message_id: "m1",
			evidence_quote: "uses sqlc; no ORM",
			atom_type: "decision",
			entity: "Northwind",
			attribute: "database policy",
			value: "sqlc without an ORM",
			extraction_model: ATOMIC_CAPTURE_MODEL,
			status: "candidate",
			episode_text: f.message.content,
		});
		expect(row.start_code_point).toBe(10);
		expect(row.end_code_point).toBe(27);

		const graph = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(graph.n)).toBe(0);
	});

	it("persists deterministic temporal fields with exact episode provenance", async () => {
		const f = await fixture("temporal", { content: "Northwind switched to sqlc yesterday." });
		const result = await extract(f, { atoms: [atom("m1", {
			type: "event",
			attribute: "database transition",
			value: "sqlc",
			assertion: "Northwind switched to sqlc.",
			evidence_quote: "switched to sqlc yesterday",
			raw_temporal_phrase: "yesterday",
		})] });
		expect(result.receipt).toMatchObject({
			atomic_capture_temporal_present: 1,
			atomic_capture_temporal_resolved: 1,
			atomic_capture_temporal_unresolved: 0,
		});
		const row = await env.DB.prepare(
			`SELECT event_time, event_time_end, event_time_precision, event_time_relation,
				event_time_source, event_time_anchor, temporal_schema, raw_temporal_phrase,
				source_episode_id
			 FROM semantic_atom_candidates WHERE user_id = ?`,
		).bind(f.userId).first();
		expect(row).toMatchObject({
			event_time: Date.UTC(2025, 10, 3, 12),
			event_time_end: null,
			event_time_precision: "day",
			event_time_relation: "at",
			event_time_source: "phrase",
			event_time_anchor: "source_time",
			temporal_schema: "itsuki.atomic-temporal/v1",
			raw_temporal_phrase: "yesterday",
		});
		expect(row.source_episode_id).toBeTruthy();
	});

	it("preserves an unsupported exact phrase but stores no fabricated event time", async () => {
		const f = await fixture("temporal-vague", { content: "Northwind may switch databases eventually." });
		const result = await extract(f, { atoms: [atom("m1", {
			type: "plan",
			attribute: "database plan",
			value: "switch databases",
			assertion: "Northwind may switch databases.",
			evidence_quote: "may switch databases eventually",
			raw_temporal_phrase: "eventually",
		})] });
		expect(result.receipt).toMatchObject({
			atomic_capture_temporal_present: 1,
			atomic_capture_temporal_resolved: 0,
			atomic_capture_temporal_unresolved: 1,
		});
		const row = await env.DB.prepare(
			`SELECT raw_temporal_phrase, event_time, event_time_end, event_time_precision,
				event_time_relation, event_time_source, event_time_anchor, temporal_schema
			 FROM semantic_atom_candidates WHERE user_id = ?`,
		).bind(f.userId).first();
		expect(row).toEqual({
			raw_temporal_phrase: "eventually",
			event_time: null,
			event_time_end: null,
			event_time_precision: null,
			event_time_relation: null,
			event_time_source: null,
			event_time_anchor: null,
			temporal_schema: "itsuki.atomic-temporal/v1",
		});
	});

	it("replay reuses the terminal capture run and never invokes the model twice", async () => {
		const f = await fixture("replay");
		let calls = 0;
		const response = () => {
			calls += 1;
			return { atoms: [atom()] };
		};
		const first = await extract(f, response);
		const second = await extract(f, response);
		expect(first.receipt.atomic_capture_stored).toBe(1);
		expect(second.receipt.atomic_capture_replayed).toBe(true);
		expect(calls).toBe(1);
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(1);
	});

	it("deduplicates the same source atom when a later rescue reshapes the chunk", async () => {
		const f = await fixture("rechunk");
		await extract(f, { atoms: [atom()] });
		const secondMessage = {
			id: "m2",
			role: "user",
			content: "Northwind also uses Go.",
			ts: f.message.ts + 1,
		};
		await writeSourceEpisodes(f.testEnv, f.userId, {
			sourcePacketId: f.sourcePacketId,
			messages: [f.message, secondMessage],
			projectId: f.projectId,
			projectName: "Project A",
			rules: RULES,
			acceptedAt: f.message.ts,
			required: true,
		});
		const second = await runExtraction(f.testEnv, f.userId, [f.message, secondMessage], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: {
				source_packet_id: f.sourcePacketId,
				accepted_at: f.message.ts,
				project_id: f.projectId,
				project_name: "Project A",
			},
		});
		expect(second.receipt).toMatchObject({
			atomic_capture_accepted: 1,
			atomic_capture_stored: 0,
			atomic_capture_duplicates: 1,
		});
		const durable = await atomicCaptureSummaryForExtractionRun(
			env,
			f.userId,
			second.receipt.extraction_run_id,
		);
		expect(durable).toMatchObject({ accepted: 1, stored: 0, duplicates: 1 });
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(1);
	});

	it("rejects inexact evidence without manufacturing a durable candidate", async () => {
		const f = await fixture("inexact");
		const result = await extract(f, { atoms: [atom("m1", { evidence_quote: "uses Prisma" })] });
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "completed",
			atomic_capture_accepted: 0,
			atomic_capture_stored: 0,
			atomic_capture_rejected: 1,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("binds candidate writes to tenant and project with no flag bleed", async () => {
		const f = await fixture("scope", { projectId: "project-private" });
		const controlId = `atomic-control-${crypto.randomUUID()}`;
		const controlEnv = {
			...f.testEnv,
			ITSUKI_MEMORY_V3_USERS: `${f.userId},${controlId}`,
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: f.userId,
		};
		await extract({ ...f, testEnv: controlEnv }, { atoms: [atom()] });

		const otherPacket = `packet-${crypto.randomUUID()}`;
		await writeSourceEpisodes(controlEnv, controlId, {
			sourcePacketId: otherPacket,
			messages: [f.message],
			projectId: "project-other",
			rules: RULES,
			acceptedAt: f.message.ts,
			required: true,
		});
		const control = await runExtraction(controlEnv, controlId, [f.message], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: { source_packet_id: otherPacket, accepted_at: f.message.ts, project_id: "project-other" },
		});
		expect(control.receipt.atomic_capture_enabled).toBe(false);
		expect(await countSemanticAtomCandidates(env, controlId)).toBe(0);
		const stored = await env.DB.prepare(
			"SELECT user_id, project_id FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(stored).toEqual({ user_id: f.userId, project_id: "project-private" });
	});

	it("fails closed when extraction scope does not match the source episode", async () => {
		const f = await fixture("scope-mismatch", { projectId: "project-a" });
		const result = await runExtraction(f.testEnv, f.userId, [f.message], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: {
				source_packet_id: f.sourcePacketId,
				accepted_at: f.message.ts,
				project_id: "project-b",
			},
		});
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "source_episode_unavailable",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("hard-deletes candidates and terminal run state with their source episodes", async () => {
		const f = await fixture("erase");
		const result = await extract(f, { atoms: [atom()] });
		const summaryBefore = await atomicCaptureSummaryForExtractionRun(env, f.userId, result.receipt.extraction_run_id);
		expect(summaryBefore.stored).toBe(1);

		const deletion = await deleteSourceEpisodes(env, f.userId);
		expect(deletion).toMatchObject({ deleted: 1, atomicCandidatesDeleted: 1 });
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(runs.n)).toBe(0);
	});

	it("a post-inference erasure fence cancels the candidate commit", async () => {
		const f = await fixture("race");
		const response = async () => {
			await env.DB.prepare(
				`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
				 VALUES (?, ?, ?, 'test')
				 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
			).bind(f.userId, f.message.ts + 1, f.message.ts + 1).run();
			return { atoms: [atom()] };
		};
		const result = await extract(f, response);
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "cancelled_by_delete",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("does not create a late capture-run residue when erasure wins before the atomic claim", async () => {
		const f = await fixture("barrier-before-claim");
		await env.DB.prepare(
			`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
			 VALUES (?, ?, ?, 'test')
			 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
		).bind(f.userId, f.message.ts + 1, f.message.ts + 1).run();
		let modelCalls = 0;
		const result = await captureAtomicCandidates(f.testEnv, {
			userId: f.userId,
			messages: [f.message],
			recent: [],
			rules: RULES,
			projectId: f.projectId,
			projectName: "Project A",
			sourcePacketId: f.sourcePacketId,
			extractionRunId: `run-${crypto.randomUUID()}`,
			acceptedAt: f.message.ts,
			override: () => {
				modelCalls += 1;
				return { atoms: [atom()] };
			},
		});

		expect(result).toMatchObject({ outcome: "cancelled_by_delete", complete: false, stored: 0 });
		expect(modelCalls).toBe(0);
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(runs.n)).toBe(0);
	});

	it("records malformed output as a terminal typed failure without raw output", async () => {
		const f = await fixture("failure");
		const result = await extract(f, "private source-shaped garbage that must never be stored");
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "parse_invalid",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		const run = await env.DB.prepare(
			"SELECT status, error_code FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(run).toEqual({ status: "failed", error_code: "parse_invalid" });
		const rawLeak = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM semantic_atom_capture_runs
			 WHERE user_id = ? AND CAST(COALESCE(error_code, '') AS TEXT) LIKE '%private source-shaped%'`,
		).bind(f.userId).first();
		expect(Number(rawLeak.n)).toBe(0);
	});
});
