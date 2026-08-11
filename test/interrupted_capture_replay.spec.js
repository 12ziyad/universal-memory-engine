/**
 * Interrupted extraction repair regressions (V3-D04).
 *
 * These are deterministic storage/queue tests. No Workers AI call is made.
 * They reproduce the production sequence where one atomic sub-chunk committed,
 * another sub-chunk was left running, the extraction was failed by the orphan
 * margin, and an exact replay incorrectly settled as a zero-write duplicate.
 */

import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ATOMIC_CAPTURE_SCHEMA } from "../src/pipeline/atomic_capture.mjs";
import {
	ATOMIC_CAPTURE_MODEL,
	ATOMIC_CAPTURE_RUN_TTL_MS,
	captureAtomicCandidates,
} from "../src/pipeline/atomic_candidates.mjs";
import { planExtractionChunks } from "../src/pipeline/chunking.js";
import { ingestMessages } from "../src/pipeline/ingest.js";
import { writeSourceEpisodes } from "../src/pipeline/episodes.js";
import { claimExtractionRun, settleMemoryJobs } from "../src/lib/db.js";

const EMPTY_GRAPH = { objects: [], notes: "deterministic no-op graph" };
const EMPTY_EDGES = { edges: [] };
const EMPTY_REFLEXION = { entities: [], facts: [], edges: [] };
const RULES = { customInstructions: "", includes: [], excludes: [] };

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

async function holdLease(stub) {
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put("lease", { until: Date.now() + 60_000, token: "interrupt-repair-test" });
	});
}

async function releaseLease(stub) {
	await runInDurableObject(stub, async (_instance, state) => state.storage.delete("lease"));
}

async function queueRows(stub) {
	return runInDurableObject(stub, async (_instance, state) => (
		[...(await state.storage.list({ prefix: "q:" })).entries()]
	));
}

function testEnv(userId, { atomic = false } = {}) {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: atomic ? "allowlist" : "off",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: atomic ? userId : "",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "",
		USE_VECTORS: "false",
		ENABLE_PASS2: "false",
	};
}

function extractionOverrides(label) {
	return {
		source: "ingest",
		llmResponse: {
			objects: [
				{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.98 },
				{ kind: "slice", on: label, text: `${label} survives interrupted replay`, kind_detail: "detail", confidence: 0.97 },
			],
			notes: "deterministic repair proposal",
		},
		edgeResponse: EMPTY_EDGES,
		reflexionResponse: EMPTY_REFLEXION,
	};
}

async function enqueueThenFail(userId, { atomic = false } = {}) {
	const stub = stubFor(userId);
	const idempotencyKey = `interrupted:${userId}`;
	const label = `Repair-${crypto.randomUUID().slice(0, 8)}`;
	const message = {
		id: "m1",
		role: "user",
		content: `I am building ${label} with replay-safe capture`,
		ts: Date.now(),
		source_time: { epoch_ms: Date.now(), offset_minutes: 0, precision: "second" },
	};
	const runtime = testEnv(userId, { atomic });
	await holdLease(stub);
	const ctx = createExecutionContext();
	const accepted = await ingestMessages(runtime, ctx, userId, [message], {
		flush: true,
		idempotencyKey,
		conversationId: `conversation-${userId}`,
		memoryScope: { projectId: "interrupt-repair", projectName: "Interrupt Repair" },
		overrides: extractionOverrides(label),
	});
	await waitOnExecutionContext(ctx);
	expect(accepted.fired).toBe(true);
	const rows = await queueRows(stub);
	expect(rows).toHaveLength(1);
	const [queueKey, entry] = rows[0];
	const extractionRunId = `run_extract_${(await sha256Hex(`${userId}\u0000${queueKey}\u00000`)).slice(0, 48)}`;
	const meta = entry.overrides?.meta ?? {};
	await claimExtractionRun(env, userId, {
		id: extractionRunId,
		toolName: entry.overrides?.source ?? "ingest",
		sourceMode: meta.source_mode ?? "auto_ingest",
		topicFilter: meta.topic_filter ?? null,
		sourcePacketId: meta.source_packet_id ?? null,
		idempotencyKey: meta.idempotency_key ?? null,
		scopeJson: meta.scope_json ?? null,
	});
	await env.DB.prepare(
		"UPDATE extraction_runs SET status='failed', error='inference_outcome_unknown: deterministic interruption', updated_at=? WHERE id=? AND user_id=?",
	).bind(Date.now(), extractionRunId, userId).run();
	await releaseLease(stub);
	await runInDurableObject(stub, async (instance) => instance.drain({
		userId,
		maxJobs: 1,
		ignoreBackoff: true,
		inlineOverrides: extractionOverrides(label),
	}));
	const job = await env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE user_id=? AND id=? LIMIT 1",
	).bind(userId, accepted.jobId).first();
	expect(job.status).toBe("failed");
	return {
		stub,
		runtime,
		userId,
		label,
		message,
		idempotencyKey,
		entry,
		queueKey,
		job,
		sourcePacketId: meta.source_packet_id,
		projectId: "interrupt-repair",
	};
}

async function storedSeen(stub, contextKey) {
	return runInDurableObject(stub, async (_instance, state) => (
		(await state.storage.get(`seen:${contextKey}`)) ?? []
	));
}

async function seedSeen(stub, contextKey, identity) {
	await runInDurableObject(stub, async (_instance, state) => {
		const key = `seen:${contextKey}`;
		const seen = (await state.storage.get(key)) ?? [];
		await state.storage.put(key, [...new Set([...seen, identity])]);
	});
}

async function seedStaleAtomicRun(fixture, { projectId = fixture.projectId } = {}) {
	const [chunk] = await planExtractionChunks([fixture.message], {
		sourcePacketId: fixture.sourcePacketId,
	});
	const id = `atomrun:v1:${await sha256Hex(JSON.stringify({
		schema: ATOMIC_CAPTURE_SCHEMA,
		user_id: fixture.userId,
		source_packet_id: fixture.sourcePacketId,
		chunk_key: chunk.key,
	}))}`;
	const old = Date.now() - ATOMIC_CAPTURE_RUN_TTL_MS - 5_000;
	await env.DB.prepare(
		`INSERT INTO semantic_atom_capture_runs
		 (id,user_id,project_id,project_name,source_packet_id,extraction_run_id,chunk_key,
		  status,model,schema_version,accepted_at,attempts,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,'running',?,?,?,1,?,?)`,
	).bind(
		id,
		fixture.userId,
		projectId,
		"Interrupt Repair",
		fixture.sourcePacketId,
		"run_interrupted_original",
		chunk.key,
		ATOMIC_CAPTURE_MODEL,
		ATOMIC_CAPTURE_SCHEMA,
		fixture.message.ts,
		old,
		old,
	).run();
	return id;
}

describe.sequential("interrupted extraction replay", () => {
	it("does not mark a failed extraction identity as successfully seen", async () => {
		const fixture = await enqueueThenFail(`failed-seen-${crypto.randomUUID()}`);
		const identity = fixture.entry.dedupeByMessage.m1;
		expect(await storedSeen(fixture.stub, fixture.entry.contextKey)).not.toContain(identity);
		await fixture.stub.resetAll();
	});

	it("repairs a legacy failed job even when its identity was already polluted into seen", async () => {
		const fixture = await enqueueThenFail(`failed-repair-${crypto.randomUUID()}`);
		const identity = fixture.entry.dedupeByMessage.m1;
		await seedSeen(fixture.stub, fixture.entry.contextKey, identity);

		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			waitBudgetMs: 5_000,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay.duplicate).not.toBe(true);

		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("enriched");
		expect(Number(job.attempts)).toBe(1);
		expect(JSON.parse(job.payload_json).repair_generation).toBe(1);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) n FROM nodes WHERE user_id=? AND deleted_at IS NULL",
		).bind(fixture.userId).first();
		expect(Number(nodes.n)).toBeGreaterThan(0);
		const runs = await env.DB.prepare(
			"SELECT status FROM extraction_runs WHERE user_id=? ORDER BY created_at,id",
		).bind(fixture.userId).all();
		expect(runs.results.map((row) => row.status)).toEqual(["failed", "wrote"]);
		await fixture.stub.resetAll();
	});

	it("supersedes stale older-generation queue ownership before repairing", async () => {
		const fixture = await enqueueThenFail(`stale-queue-repair-${crypto.randomUUID()}`);
		const identity = fixture.entry.dedupeByMessage.m1;
		await seedSeen(fixture.stub, fixture.entry.contextKey, identity);
		await runInDurableObject(fixture.stub, async (_instance, state) => {
			await state.storage.put(fixture.queueKey, fixture.entry);
		});

		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			waitBudgetMs: 5_000,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay.duplicate).not.toBe(true);

		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("enriched");
		expect(Number(job.attempts)).toBe(1);
		expect(JSON.parse(job.payload_json).repair_generation).toBe(1);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) n FROM nodes WHERE user_id=? AND deleted_at IS NULL",
		).bind(fixture.userId).first();
		expect(Number(nodes.n)).toBeGreaterThan(0);
		const runs = await env.DB.prepare(
			"SELECT status FROM extraction_runs WHERE user_id=? ORDER BY created_at,id",
		).bind(fixture.userId).all();
		expect(runs.results.map((row) => row.status)).toEqual(["failed", "wrote"]);
		expect(await queueRows(fixture.stub)).toHaveLength(0);
		await fixture.stub.resetAll();
	});

	it("fences stale settlement from a newer durable repair generation", async () => {
		const fixture = await enqueueThenFail(`stale-settlement-fence-${crypto.randomUUID()}`);
		const payload = JSON.parse(fixture.job.payload_json ?? "{}");
		await env.DB.prepare(
			`UPDATE memory_jobs
			 SET status='queued', attempts=1, payload_json=?, error=NULL,
			     completed_at=NULL, run_after=?, updated_at=?
			 WHERE id=? AND user_id=?`,
		).bind(
			JSON.stringify({ ...payload, remaining: ["m1"], repair_generation: 1 }),
			Date.now(),
			Date.now(),
			fixture.job.id,
			fixture.userId,
		).run();

		const transitions = await settleMemoryJobs(env, fixture.userId, [{
			jobId: fixture.job.id,
			messageIds: ["m1"],
			disposition: "failed",
			error: "stale generation must not settle",
			repairGeneration: 0,
		}], { strict: true });
		expect(transitions).toEqual([]);
		const job = await env.DB.prepare(
			"SELECT status,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("queued");
		expect(JSON.parse(job.payload_json)).toMatchObject({ remaining: ["m1"], repair_generation: 1 });
		await fixture.stub.resetAll();
	});

	it("joins an active repair generation after the D1 CAS and before its handoff", async () => {
		const fixture = await enqueueThenFail(`active-repair-join-${crypto.randomUUID()}`);
		const identity = fixture.entry.dedupeByMessage.m1;
		await seedSeen(fixture.stub, fixture.entry.contextKey, identity);
		const payload = JSON.parse(fixture.job.payload_json ?? "{}");
		await env.DB.prepare(
			`UPDATE memory_jobs
			 SET status='queued', attempts=1, payload_json=?, error=NULL,
			     completed_at=NULL, run_after=?, updated_at=?
			 WHERE id=? AND user_id=?`,
		).bind(
			JSON.stringify({ ...payload, remaining: ["m1"], repair_generation: 1 }),
			Date.now(),
			Date.now(),
			fixture.job.id,
			fixture.userId,
		).run();

		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			waitBudgetMs: 5_000,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay.duplicate).not.toBe(true);
		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("enriched");
		expect(Number(job.attempts)).toBe(1);
		expect(JSON.parse(job.payload_json).repair_generation).toBe(1);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) n FROM nodes WHERE user_id=? AND deleted_at IS NULL",
		).bind(fixture.userId).first();
		expect(Number(nodes.n)).toBeGreaterThan(0);
		const runs = await env.DB.prepare(
			"SELECT status FROM extraction_runs WHERE user_id=? ORDER BY created_at,id",
		).bind(fixture.userId).all();
		expect(runs.results.map((row) => row.status)).toEqual(["failed", "wrote"]);
		await fixture.stub.resetAll();
	});

	it("reopens an enriched job only when a stale interrupted atomic run proves incomplete work", async () => {
		const fixture = await enqueueThenFail(`enriched-repair-${crypto.randomUUID()}`, { atomic: true });
		await seedSeen(fixture.stub, fixture.entry.contextKey, fixture.entry.dedupeByMessage.m1);
		await seedStaleAtomicRun(fixture);
		await env.DB.prepare(
			"UPDATE memory_jobs SET status='enriched',error=NULL,completed_at=?,updated_at=? WHERE id=? AND user_id=?",
		).bind(Date.now(), Date.now(), fixture.job.id, fixture.userId).run();

		await holdLease(fixture.stub);
		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay.duplicate).not.toBe(true);
		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("queued");
		expect(Number(job.attempts)).toBe(1);
		expect(JSON.parse(job.payload_json).remaining).toEqual(["m1"]);
		const rows = await queueRows(fixture.stub);
		expect(rows).toHaveLength(1);
		expect(Number(rows[0][1].attempts)).toBe(0);
		expect(Number(rows[0][1].repairGeneration)).toBe(1);
		await releaseLease(fixture.stub);
		await fixture.stub.resetAll();
	});

	it("keeps an ordinary enriched replay immutable without interrupted atomic proof", async () => {
		const fixture = await enqueueThenFail(`enriched-immutable-${crypto.randomUUID()}`, { atomic: true });
		await seedSeen(fixture.stub, fixture.entry.contextKey, fixture.entry.dedupeByMessage.m1);
		await env.DB.prepare(
			"UPDATE memory_jobs SET status='enriched',error=NULL,completed_at=?,updated_at=? WHERE id=? AND user_id=?",
		).bind(Date.now(), Date.now(), fixture.job.id, fixture.userId).run();

		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay).toMatchObject({ duplicate: true, terminalReplay: true, jobStatus: "enriched" });
		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("enriched");
		expect(Number(job.attempts)).toBe(0);
		expect(JSON.parse(job.payload_json).repair_generation).toBeUndefined();
		expect(await queueRows(fixture.stub)).toHaveLength(0);
		await fixture.stub.resetAll();
	});

	it("does not let an interrupted ledger from another project authorize repair", async () => {
		const fixture = await enqueueThenFail(`enriched-project-fence-${crypto.randomUUID()}`, { atomic: true });
		await seedSeen(fixture.stub, fixture.entry.contextKey, fixture.entry.dedupeByMessage.m1);
		await seedStaleAtomicRun(fixture, { projectId: "another-project" });
		await env.DB.prepare(
			"UPDATE memory_jobs SET status='enriched',error=NULL,completed_at=?,updated_at=? WHERE id=? AND user_id=?",
		).bind(Date.now(), Date.now(), fixture.job.id, fixture.userId).run();

		const ctx = createExecutionContext();
		const replay = await ingestMessages(fixture.runtime, ctx, fixture.userId, [fixture.message], {
			flush: true,
			idempotencyKey: fixture.idempotencyKey,
			conversationId: `conversation-${fixture.userId}`,
			memoryScope: { projectId: fixture.projectId, projectName: "Interrupt Repair" },
			overrides: extractionOverrides(fixture.label),
		});
		await waitOnExecutionContext(ctx);
		expect(replay).toMatchObject({ duplicate: true, terminalReplay: true, jobStatus: "enriched" });
		const job = await env.DB.prepare(
			"SELECT status,attempts,payload_json FROM memory_jobs WHERE id=? AND user_id=?",
		).bind(fixture.job.id, fixture.userId).first();
		expect(job.status).toBe("enriched");
		expect(Number(job.attempts)).toBe(0);
		expect(JSON.parse(job.payload_json).repair_generation).toBeUndefined();
		expect(await queueRows(fixture.stub)).toHaveLength(0);
		await fixture.stub.resetAll();
	});
});

describe.sequential("atomic interrupted-attempt fencing", () => {
	it("reclaims only the stale chunk and fences the superseded attempt", async () => {
		const userId = `atomic-reclaim-${crypto.randomUUID()}`;
		const sourcePacketId = `packet-${crypto.randomUUID()}`;
		const projectId = "atomic-reclaim";
		const runtime = testEnv(userId, { atomic: true });
		const message = {
			id: "m1",
			role: "user",
			content: "Northwind uses sqlc; no ORM.",
			ts: Date.now(),
			source_time: { epoch_ms: Date.now(), offset_minutes: 0, precision: "second" },
		};
		await writeSourceEpisodes(runtime, userId, {
			sourcePacketId,
			messages: [message],
			projectId,
			projectName: "Atomic Reclaim",
			rules: RULES,
			acceptedAt: message.ts,
			required: true,
		});

		let startFirst;
		let releaseFirst;
		const firstStarted = new Promise((resolve) => { startFirst = resolve; });
		const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
		const first = captureAtomicCandidates(runtime, {
			userId,
			messages: [message],
			recent: [],
			rules: RULES,
			projectId,
			projectName: "Atomic Reclaim",
			sourcePacketId,
			extractionRunId: "run_original",
			acceptedAt: message.ts,
			override: async () => {
				startFirst();
				await firstReleased;
				return { atoms: [{
					type: "decision",
					entity: "Northwind",
					entity_type: "project",
					attribute: "database policy",
					value: "old attempt",
					assertion: "Northwind accepted the old attempt.",
					source_message_id: "m1",
					evidence_quote: "uses sqlc; no ORM",
					cardinality: "single",
					confidence: 0.99,
				}] };
			},
		});
		await firstStarted;
		await env.DB.prepare(
			"UPDATE semantic_atom_capture_runs SET updated_at=? WHERE user_id=? AND source_packet_id=?",
		).bind(Date.now() - ATOMIC_CAPTURE_RUN_TTL_MS - 5_000, userId, sourcePacketId).run();

		const repaired = await captureAtomicCandidates(runtime, {
			userId,
			messages: [message],
			recent: [],
			rules: RULES,
			projectId,
			projectName: "Atomic Reclaim",
			sourcePacketId,
			extractionRunId: "run_repair_1",
			acceptedAt: message.ts,
			override: { atoms: [{
				type: "decision",
				entity: "Northwind",
				entity_type: "project",
				attribute: "database policy",
				value: "sqlc without an ORM",
				assertion: "Northwind uses sqlc and does not use an ORM.",
				source_message_id: "m1",
				evidence_quote: "uses sqlc; no ORM",
				cardinality: "single",
				confidence: 0.99,
			}] },
		});
		releaseFirst();
		await first;

		expect(repaired).toMatchObject({ outcome: "completed", complete: true, stored: 1 });
		const run = await env.DB.prepare(
			"SELECT status,attempts,replay_count,extraction_run_id FROM semantic_atom_capture_runs WHERE user_id=? AND source_packet_id=?",
		).bind(userId, sourcePacketId).first();
		expect(run).toMatchObject({ status: "completed", attempts: 2, replay_count: 1, extraction_run_id: "run_repair_1" });
		const candidates = await env.DB.prepare(
			"SELECT assertion,extraction_run_id FROM semantic_atom_candidates WHERE user_id=?",
		).bind(userId).all();
		expect(candidates.results).toEqual([{
			assertion: "Northwind uses sqlc and does not use an ORM.",
			extraction_run_id: "run_repair_1",
		}]);
	});
});
