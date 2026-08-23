/**
 * Stage 4 adversarial invariants that sit between the HTTP/MCP doors, D1, and
 * the per-account Durable Object. These tests deliberately avoid model calls.
 */

import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { buildPin, withAiPin } from "../src/ai/pin.js";
import { resolveProvider } from "../src/ai/registry.js";
import { createMemoryJob, settleMemoryJobs } from "../src/lib/db.js";
import { saveConversation } from "../src/pipeline/manual_collect.js";
import { parseCollectIntent, saveMemoryPage } from "../src/pipeline/pages.js";
import { markMcpEnrichmentFailed, stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import {
	hashText,
	normalizeSourcePacket,
	stableSourceMessageId,
	storeSourcePacket,
} from "../src/pipeline/source.js";

const API_HEADERS = {
	"content-type": "application/json",
	"x-api-key": env.API_KEY,
};
const T0 = Date.parse("2026-08-05T12:00:00Z");

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

async function ingestHttp(userId, body) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers: API_HEADERS,
		body: JSON.stringify({ userId, ...body }),
	}), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function stageMcp(userId, input) {
	const ctx = createExecutionContext();
	const result = await stageMcpConversation(env, ctx, userId, input);
	await waitOnExecutionContext(ctx);
	return result;
}

async function memoryJob(userId, idempotencyKey) {
	return env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
	).bind(userId, idempotencyKey).first();
}

function dedupeOverrides(conversationId) {
	return {
		meta: {
			scope_json: JSON.stringify({
				workspace_id: "default",
				app_id: "uml",
				conversation_id: conversationId,
			}),
		},
	};
}

function meaningfulMessage(id, content) {
	return { id, role: "user", content, ts: Date.now() };
}

async function manualCollectArtifacts(userId, idempotencyKey) {
	const source = await env.DB.prepare(
		"SELECT id FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
	).bind(userId, idempotencyKey).first();
	const [pages, runs, receipts, jobs] = await Promise.all([
		env.DB.prepare(
			"SELECT * FROM memory_pages WHERE user_id = ? ORDER BY id",
		).bind(userId).all(),
		env.DB.prepare(
			"SELECT * FROM extraction_runs WHERE user_id = ? AND source_packet_id = ? ORDER BY id",
		).bind(userId, source?.id ?? null).all(),
		env.DB.prepare(
			"SELECT * FROM receipts WHERE user_id = ? AND source_packet_id = ? ORDER BY id",
		).bind(userId, source?.id ?? null).all(),
		env.DB.prepare(
			`SELECT * FROM memory_jobs
			 WHERE user_id = ? AND source_packet_id = ? AND type = 'pass2_rollup'
			 ORDER BY id`,
		).bind(userId, source?.id ?? null).all(),
	]);
	return {
		sourceId: source?.id ?? null,
		pages: pages.results ?? [],
		runs: runs.results ?? [],
		receipts: receipts.results ?? [],
		jobs: jobs.results ?? [],
	};
}

describe("immutable memory-job ownership", () => {
	it("leaves an internal owner byte-for-byte unchanged when an external owner collides", async () => {
		const userId = `job-owner-internal-${crypto.randomUUID()}`;
		const key = `pass2:${crypto.randomUUID()}`;
		const internalId = `job_${crypto.randomUUID()}`;
		const created = await createMemoryJob(env, userId, {
			id: internalId,
			type: "pass2",
			status: "queued",
			idempotencyKey: key,
			extractionRunId: `run_${crypto.randomUUID()}`,
			payload: { lane: "internal", pass: 2 },
		});
		expect(created).toBe(internalId);
		const before = await memoryJob(userId, key);

		const collision = await createMemoryJob(env, userId, {
			id: `job_${crypto.randomUUID()}`,
			type: "extract",
			status: "staged",
			idempotencyKey: key,
			sourcePacketId: `src_${crypto.randomUUID()}`,
			payload: { lane: "ingest", message_ids: ["external"] },
		});

		expect(collision).toBeNull();
		expect(await memoryJob(userId, key)).toEqual(before);
	});

	it("leaves an external owner byte-for-byte unchanged when an internal owner collides", async () => {
		const userId = `job-owner-external-${crypto.randomUUID()}`;
		const key = `external-${crypto.randomUUID()}`;
		const externalId = `job_${crypto.randomUUID()}`;
		const created = await createMemoryJob(env, userId, {
			id: externalId,
			type: "extract",
			status: "processing",
			idempotencyKey: key,
			sourcePacketId: `src_${crypto.randomUUID()}`,
			payload: { lane: "ingest", remaining: ["m1"] },
		});
		expect(created).toBe(externalId);
		const before = await memoryJob(userId, key);

		const collision = await createMemoryJob(env, userId, {
			id: `job_${crypto.randomUUID()}`,
			type: "pass2",
			status: "queued",
			idempotencyKey: key,
			extractionRunId: `run_${crypto.randomUUID()}`,
			payload: { lane: "internal", pass: 2 },
		});

		expect(collision).toBeNull();
		expect(await memoryJob(userId, key)).toEqual(before);
	});

	it("returns the original id for an exact owner replay without touching the row", async () => {
		const userId = `job-owner-replay-${crypto.randomUUID()}`;
		const key = `job-replay-${crypto.randomUUID()}`;
		const id = `job_${crypto.randomUUID()}`;
		const owner = {
			id,
			type: "pass2",
			status: "queued",
			idempotencyKey: key,
			extractionRunId: `run_${crypto.randomUUID()}`,
			payload: { pass: 2, lane: "internal" },
		};
		expect(await createMemoryJob(env, userId, owner)).toBe(id);
		const before = await memoryJob(userId, key);

		expect(await createMemoryJob(env, userId, {
			...owner,
			id: `job_${crypto.randomUUID()}`,
			status: "processing",
		})).toBe(id);
		expect(await memoryJob(userId, key)).toEqual(before);
	});

	it("rejects both public doors against an internal key before creating source artifacts", async () => {
		const userId = `job-owner-public-${crypto.randomUUID()}`;
		const key = `pass2:${crypto.randomUUID()}`;
		const internalId = `job_${crypto.randomUUID()}`;
		await createMemoryJob(env, userId, {
			id: internalId,
			type: "pass2",
			status: "queued",
			idempotencyKey: key,
			extractionRunId: `run_${crypto.randomUUID()}`,
			payload: { lane: "internal", pass: 2 },
		});
		const before = await memoryJob(userId, key);
		const message = meaningfulMessage(
			"public-collision",
			"The public collision probe preserves the internal job owner.",
		);

		const http = await ingestHttp(userId, {
			idempotencyKey: key,
			conversationId: "public-http",
			messages: [message],
		});
		expect(http.status).toBe(409);
		expect(http.body).toMatchObject({ error: "idempotency_conflict" });
		const mcp = await stageMcp(userId, {
			idempotencyKey: key,
			conversationId: "public-mcp",
			messages: [message],
		});
		expect(mcp).toMatchObject({
			ok: false,
			error: "idempotency_conflict",
			http_status: 409,
		});
		expect(await memoryJob(userId, key)).toEqual(before);
		const artifacts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts,
				(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages`,
		).bind(userId, userId, userId).first();
		expect(artifacts).toMatchObject({ packets: 0, receipts: 0, pages: 0 });
	});

	it("rejects manual collect against another lane before creating any partial artifact", async () => {
		const userId = `job-owner-manual-${crypto.randomUUID()}`;
		const key = `pass2:${crypto.randomUUID()}`;
		const internalId = `job_${crypto.randomUUID()}`;
		await createMemoryJob(env, userId, {
			id: internalId,
			type: "pass2",
			status: "queued",
			idempotencyKey: key,
			extractionRunId: `run_${crypto.randomUUID()}`,
			payload: { lane: "internal", pass: 2 },
		});
		const before = await memoryJob(userId, key);

		const result = await saveConversation(env, null, userId, [{
			id: "manual-cross-lane",
			role: "user",
			content: "The cross-lane probe must not create a partial manual memory.",
			ts: T0,
		}], {
			conversationId: `manual-cross-lane-${crypto.randomUUID()}`,
			idempotencyKey: key,
			digestResponse: "This digest must never be persisted.",
		});

		expect(result).toMatchObject({
			idempotencyConflict: true,
			idempotencyKey: key,
		});
		expect(await memoryJob(userId, key)).toEqual(before);
		const artifacts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM extraction_runs WHERE user_id = ?) AS runs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts,
				(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
		).bind(userId, userId, userId, userId, userId).first();
		expect(artifacts).toMatchObject({ packets: 0, runs: 0, receipts: 0, pages: 0, jobs: 1 });
	});
});

describe("concurrent HTTP idempotency", () => {
	it("converges eight exact requests on one packet, job, receipt, and receipt id", async () => {
		const userId = `http-eight-${crypto.randomUUID()}`;
		const idempotencyKey = `http-eight-key-${crypto.randomUUID()}`;
		const request = {
			idempotencyKey,
			conversationId: `conversation-${crypto.randomUUID()}`,
			flush: false,
			messages: [meaningfulMessage(
				"shared-message",
				"The cobalt bicycle frame needs a matte protective coating.",
			)],
		};

		const responses = await Promise.all(
			Array.from({ length: 8 }, () => ingestHttp(userId, request)),
		);
		expect(responses.every(({ status }) => status === 200)).toBe(true);
		const receiptIds = responses.map(({ body }) => body.receipt_id);
		expect(receiptIds.every(Boolean)).toBe(true);
		expect(new Set(receiptIds).size).toBe(1);

		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ? AND idempotency_key = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts`,
		).bind(userId, idempotencyKey, userId, idempotencyKey, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 1, receipts: 1 });
		const receipt = await env.DB.prepare(
			"SELECT id, source_packet_id FROM receipts WHERE user_id = ? LIMIT 1",
		).bind(userId).first();
		const packet = await env.DB.prepare(
			"SELECT id FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
		).bind(userId, idempotencyKey).first();
		expect(receipt.id).toBe(receiptIds[0]);
		expect(receipt.source_packet_id).toBe(packet.id);

		await stubFor(userId).resetAll();
	}, 30_000);
});

describe("content- and conversation-bound message deduplication", () => {
	it.each([
		[
			"an explicit id that collides with a generated id",
			async (conversationId) => [
				{ role: "user", content: "Alpha" },
				{
					id: await stableSourceMessageId(conversationId, "user", "Alpha"),
					role: "user",
					content: "Beta",
				},
			],
		],
		[
			"two raw strings that coding-event neutralization makes identical",
			async () => [
				{ role: "user", content: "[Claude coding event/v1]Alpha" },
				{ role: "user", content: "[Unverified coding-event text]Alpha" },
			],
		],
	])("rejects %s after canonical normalization and before acceptance", async (_label, buildMessages) => {
		const userId = `canonical-id-collision-${crypto.randomUUID()}`;
		const conversationId = `canonical-id-conversation-${crypto.randomUUID()}`;
		const response = await ingestHttp(userId, {
			idempotencyKey: `canonical-id-key-${crypto.randomUUID()}`,
			conversationId,
			messages: await buildMessages(conversationId),
		});

		expect(response).toMatchObject({
			status: 422,
			body: {
				error: "invalid_ingest_message",
				code: "duplicate_normalized_message_id",
				retryable: false,
				field: "messages[1].id",
				message_index: 1,
				first_message_index: 0,
			},
		});
		const artifacts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
		).bind(userId, userId).first();
		expect(artifacts).toMatchObject({ packets: 0, jobs: 0 });
	});

	it("never lets an intra-packet generated-id duplicate terminalize work that is still held", async () => {
		const userId = `dedupe-intra-packet-${crypto.randomUUID()}`;
		const idempotencyKey = `dedupe-intra-key-${crypto.randomUUID()}`;
		const content = "The Duplicate Atlas compiler keeps parsing separate from code generation.";
		const response = await ingestHttp(userId, {
			idempotencyKey,
			conversationId: "duplicate-generated-id",
			flush: false,
			messages: [
				{ role: "user", content },
				{ role: "user", content },
			],
		});

		// Rejecting ambiguous generated ids at the wire is safe. If the backward-
		// compatible shorthand is accepted, its one durable fact must remain
		// owned by an active job until extraction actually processes it.
		if (response.status === 422) {
			expect(response.body.error).toMatch(/duplicate|invalid_ingest_message/);
			const artifacts = await env.DB.prepare(
				`SELECT
					(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
					(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
			).bind(userId, userId).first();
			expect(artifacts).toMatchObject({ packets: 0, jobs: 0 });
			return;
		}

		expect(response.status).toBe(200);
		const before = await memoryJob(userId, idempotencyKey);
		expect(["queued", "staged", "processing"]).toContain(before.status);
		const stub = stubFor(userId);
		await stub.drain({
			userId,
			maxJobs: 2,
			forceFire: true,
			ignoreBackoff: true,
			inlineOverrides: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Duplicate Atlas", category: "project", confidence: 0.96 },
						{ kind: "slice", on: "Duplicate Atlas", text: content, kind_detail: "other", confidence: 0.94 },
					],
					notes: "",
				},
			},
		});
		expect((await memoryJob(userId, idempotencyKey)).status).toBe("enriched");
		const node = await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ? AND label = 'Duplicate Atlas' AND deleted_at IS NULL LIMIT 1",
		).bind(userId).first();
		expect(node).toBeTruthy();
		await stub.resetAll();
	}, 30_000);

	it("accepts a reused id with changed content, deduplicates exact overlap, and isolates conversations", async () => {
		const userId = `dedupe-v2-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await runInDurableObject(stub, async (instance, state) => {
			const id = "host-message-1";
			const firstContent = "The Atlas compiler separates parsing from code generation.";
			const changedContent = "The Atlas compiler separates parsing from semantic analysis.";
			const inConversationA = dedupeOverrides("conversation-a");
			const inConversationB = dedupeOverrides("conversation-b");

			const first = await instance.addMessages(
				userId,
				[meaningfulMessage(id, firstContent)],
				{ overrides: inConversationA },
			);
			const changed = await instance.addMessages(
				userId,
				[meaningfulMessage(id, changedContent)],
				{ overrides: inConversationA },
			);
			const overlap = await instance.addMessages(
				userId,
				[meaningfulMessage(id, changedContent)],
				{ overrides: inConversationA },
			);
			const otherConversation = await instance.addMessages(
				userId,
				[meaningfulMessage(id, changedContent)],
				{ overrides: inConversationB },
			);

			expect(first).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(changed).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(overlap).toMatchObject({ held: 0, skipped: 1, fired: false });
			expect(otherConversation).toMatchObject({ held: 1, skipped: 0, fired: false });
			const chunk = await state.storage.get("chunk");
			const queued = [...(await state.storage.list({ prefix: "q:" })).values()]
				.filter((entry) => entry.kind === "extract");
			expect(queued).toHaveLength(2);
			expect(queued.flatMap((entry) => entry.messages)).toHaveLength(2);
			expect(chunk).toHaveLength(1);
			const identities = [
				...queued.flatMap((entry) => Object.values(entry.dedupeByMessage ?? {})),
				...chunk.map((message) => message._dedupe),
			];
			expect(new Set(identities).size).toBe(3);
			expect(identities.every((identity) => String(identity).startsWith("message:v2:"))).toBe(true);
		});
		await stub.resetAll();
	});

	it("fails legacy project-wide seen state open once context isolation is active", async () => {
		const userId = `dedupe-legacy-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		await runInDurableObject(stub, async (instance, state) => {
			const id = "legacy-host-message";
			const original = "The legacy Atlas parser keeps comments attached to syntax nodes.";
			const changed = "The legacy Atlas parser discards comments before syntax analysis.";
			await state.storage.put("seen", [id]);
			await state.storage.put("checkpoint", id);
			await state.storage.put("recent", [{
				id,
				role: "user",
				content: original,
				content_hash: await hashText(original),
				ts: T0,
			}]);

			const exactReplay = await instance.addMessages(
				userId,
				[meaningfulMessage(id, original)],
				{ overrides: dedupeOverrides("legacy-conversation") },
			);
			const contextReplay = await instance.addMessages(
				userId,
				[meaningfulMessage(id, original)],
				{ overrides: dedupeOverrides("legacy-conversation") },
			);
			const changedReplay = await instance.addMessages(
				userId,
				[meaningfulMessage(id, changed)],
				{ overrides: dedupeOverrides("legacy-conversation") },
			);

			expect(exactReplay).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(contextReplay).toMatchObject({ held: 0, skipped: 1, fired: false });
			expect(changedReplay).toMatchObject({ held: 1, skipped: 0, fired: false });
			const chunk = await state.storage.get("chunk");
			expect(chunk).toEqual([
				expect.objectContaining({ id, content: original, _dedupe: expect.stringMatching(/^message:v2:/) }),
				expect.objectContaining({ id, content: changed, _dedupe: expect.stringMatching(/^message:v2:/) }),
			]);
			expect(await state.storage.get("seen")).toEqual([id]);
		});
		await stub.resetAll();
	});
});

describe("MCP deterministic terminal evidence", () => {
	it("replays ignored input with one immutable receipt and no job or page", async () => {
		const userId = `mcp-ignored-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-ignored-key-${crypto.randomUUID()}`;
		const input = {
			idempotencyKey,
			conversationId: `conversation-${crypto.randomUUID()}`,
			messages: [{
				id: "utility-question",
				role: "user",
				content: "What is the weather today?",
				ts: T0,
			}],
		};

		const first = await stageMcp(userId, input);
		const replay = await stageMcp(userId, input);
		expect(first).toMatchObject({ fired: false, processing: false });
		expect(replay).toMatchObject({ fired: false, processing: false, duplicate: true });
		expect(replay.receipt_id).toBe(first.receipt_id);
		expect(replay.receipt.id).toBe(first.receipt.id);

		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ? AND idempotency_key = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs,
				(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts`,
		).bind(userId, idempotencyKey, userId, userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 0, pages: 0, receipts: 1 });
	});

	it("keeps an ignored MCP source owner unchanged when HTTP reuses its key", async () => {
		const userId = `mcp-source-owner-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-source-key-${crypto.randomUUID()}`;
		const input = {
			idempotencyKey,
			conversationId: `conversation-${crypto.randomUUID()}`,
			messages: [{
				id: "source-only-question",
				role: "user",
				content: "What is the weather today?",
				ts: T0,
			}],
		};
		const ignored = await stageMcp(userId, input);
		expect(ignored).toMatchObject({ fired: false, processing: false });
		const before = await env.DB.prepare(
			"SELECT * FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
		).bind(userId, idempotencyKey).first();

		const conflict = await ingestHttp(userId, input);
		expect(conflict.status).toBe(409);
		expect(conflict.body).toMatchObject({
			error: "idempotency_conflict",
			source_packet_id: before.id,
		});
		expect(await env.DB.prepare(
			"SELECT * FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
		).bind(userId, idempotencyKey).first()).toEqual(before);
		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts`,
		).bind(userId, userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 0, receipts: 1 });
	});

	it("removes an MCP queue entry only after observing a terminal D1 job", async () => {
		const userId = `mcp-terminal-proof-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const contentHash = "a".repeat(64);
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "mcp_enrich",
			status: "enriched",
			idempotencyKey: `mcp-terminal-${crypto.randomUUID()}`,
			payload: { pageId: `page_${crypto.randomUUID()}` },
			completedAt: Date.now(),
		});
		const stub = stubFor(userId);
		await stub.enqueueMcpJobOnce(userId, {
			jobId,
			pageId: `page_${crypto.randomUUID()}`,
			title: "Never inferred",
			userMessages: [],
			sourceMeta: { source_content_hash: contentHash },
		}, { handoffId: jobId, contentHash });

		const drained = await stub.drain({ userId, maxJobs: 1, ignoreBackoff: true });
		expect(drained.results).toEqual([
				expect.objectContaining({
					kind: "mcp",
					jobId,
					outcome: "enriched",
				}),
		]);
		await runInDurableObject(stub, async (_instance, state) => {
			expect((await state.storage.list({ prefix: "q:" })).size).toBe(0);
			expect((await state.storage.list({ prefix: "mcp-handoff:v1:" })).size).toBe(0);
		});
		await stub.resetAll();
	});

	it("retains and backs off terminal-pending MCP work without D1 terminal evidence", async () => {
		const userId = `mcp-terminal-pending-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const contentHash = "b".repeat(64);
		const stub = stubFor(userId);
		const accepted = await stub.enqueueMcpJobOnce(userId, {
			jobId,
			pageId: `page_${crypto.randomUUID()}`,
			title: "Missing owner",
			userMessages: [],
			sourceMeta: { source_content_hash: contentHash },
		}, { handoffId: jobId, contentHash });
		await runInDurableObject(stub, async (_instance, state) => {
			const entry = await state.storage.get(accepted.queueKey);
			await state.storage.put(accepted.queueKey, {
				...entry,
				phase: "terminal_pending",
				terminalReason: "adversarial missing D1 owner",
				settlementAttempts: 0,
				runAfter: 0,
			});
		});

		const drained = await stub.drain({ userId, maxJobs: 1, ignoreBackoff: true });
		expect(drained.results).toEqual([
			expect.objectContaining({
				kind: "mcp",
				jobId,
				outcome: "settlement_pending",
				retry: true,
			}),
		]);
		await runInDurableObject(stub, async (_instance, state) => {
			const retained = await state.storage.get(accepted.queueKey);
			expect(retained).toMatchObject({
				phase: "terminal_pending",
				settlementAttempts: 1,
			});
			expect(retained.runAfter).toBeGreaterThan(Date.now());
			expect((await state.storage.list({ prefix: "mcp-handoff:v1:" })).size).toBe(1);
		});
		await stub.resetAll();
	});

	it("does not repeat failure repair side effects while only the terminal announcement is pending", async () => {
		const userId = `mcp-announcement-pending-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const pageId = `page_${crypto.randomUUID()}`;
		const contentHash = "c".repeat(64);
		const job = {
			jobId,
			pageId,
			title: "Failed save",
			userMessages: [],
			sourceMeta: { source_content_hash: contentHash },
		};
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "mcp_enrich",
			status: "staged",
			idempotencyKey: `mcp-announcement-${crypto.randomUUID()}`,
			payload: { pageId },
		});
		await markMcpEnrichmentFailed(env, userId, job, "first terminal repair");
		const receiptsBefore = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ? AND outcome = 'enrich_failed'",
		).bind(userId).first();
		expect(receiptsBefore.n).toBe(1);

		const stub = stubFor(userId);
		const accepted = await stub.enqueueMcpJobOnce(userId, job, {
			handoffId: jobId,
			contentHash,
		});
		await runInDurableObject(stub, async (_instance, state) => {
			const entry = await state.storage.get(accepted.queueKey);
			await state.storage.put(accepted.queueKey, {
				...entry,
				phase: "announcement_pending",
				terminalReason: "first terminal repair",
				settlementAttempts: 1,
				runAfter: 0,
			});
		});

		const drained = await stub.drain({ userId, maxJobs: 1, ignoreBackoff: true });
		expect(drained.results[0]).toMatchObject({ kind: "mcp", jobId, outcome: "failed" });
		const receiptsAfter = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ? AND outcome = 'enrich_failed'",
		).bind(userId).first();
		expect(receiptsAfter.n).toBe(receiptsBefore.n);
		await stub.resetAll();
	});

	it("keeps the failed-enrichment receipt idempotent when terminal repair replays after a crash", async () => {
		const userId = `mcp-failure-repair-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const pageId = `page_${crypto.randomUUID()}`;
		const job = {
			jobId,
			pageId,
			title: "Failure replay",
			userMessages: [],
			sourceMeta: { source_content_hash: "d".repeat(64) },
		};
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "mcp_enrich",
			status: "staged",
			idempotencyKey: `mcp-failure-repair-${crypto.randomUUID()}`,
			payload: { pageId },
		});

		await markMcpEnrichmentFailed(env, userId, job, "repeatable terminal repair");
		await markMcpEnrichmentFailed(env, userId, job, "repeatable terminal repair");
		const receipts = await env.DB.prepare(
			"SELECT id FROM receipts WHERE user_id = ? AND outcome = 'enrich_failed' ORDER BY id",
		).bind(userId).all();
		expect(receipts.results).toHaveLength(1);
	});
});

describe("concurrent subset settlement", () => {
	it("CAS-merges eight disjoint subsets, counts each once, and emits one terminal transition", async () => {
		const userId = `settle-cas-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const key = `settle-cas-key-${crypto.randomUUID()}`;
		const messageIds = Array.from({ length: 8 }, (_, index) => `message-${index}`);
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "extract",
			status: "processing",
			idempotencyKey: key,
			payload: { message_ids: messageIds, remaining: messageIds, saved: {} },
		});

		const transitions = await Promise.all(messageIds.map((messageId) => settleMemoryJobs(
			env,
			userId,
			[{
				jobId,
				messageIds: [messageId],
				disposition: "processed",
				counts: { nodes: 1, slices: 2 },
			}],
			{ strict: true },
		)));
		const terminalTransitions = transitions.flat().filter((transition) => transition.status === "enriched");
		expect(terminalTransitions).toHaveLength(1);

		const row = await memoryJob(userId, key);
		const payload = JSON.parse(row.payload_json);
		expect(row.status).toBe("enriched");
		expect(payload.remaining).toEqual([]);
		expect(payload.saved).toMatchObject({ nodes: 8, slices: 16 });

		const duplicateTransitions = await Promise.all(messageIds.map((messageId) => settleMemoryJobs(
			env,
			userId,
			[{
				jobId,
				messageIds: [messageId],
				disposition: "processed",
				counts: { nodes: 100, slices: 100 },
			}],
			{ strict: true },
		)));
		expect(duplicateTransitions.flat()).toEqual([]);
		expect(JSON.parse((await memoryJob(userId, key)).payload_json).saved).toMatchObject({
			nodes: 8,
			slices: 16,
		});
	});

	it("never reintroduces a rejected cross-packet receipt in the terminal job webhook", async () => {
		const userId = `settle-webhook-owner-${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const sourceA = `src_${crypto.randomUUID()}`;
		const sourceB = `src_${crypto.randomUUID()}`;
		const receiptB = `receipt_${crypto.randomUUID()}`;
		const webhookId = `wh_${crypto.randomUUID()}`;
		const messageId = "owned-by-source-a";
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "extract",
			status: "processing",
			idempotencyKey: `settle-webhook-${crypto.randomUUID()}`,
			sourcePacketId: sourceA,
			payload: { message_ids: [messageId], remaining: [messageId] },
		});
		await env.DB.prepare(
			`INSERT INTO webhooks
			 (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
			 VALUES (?, ?, 'Ownership probe', 'http://127.0.0.1/hook', 'whsec_test', ?, 1, 'active', ?, ?)`,
		).bind(webhookId, userId, JSON.stringify(["memory.enriched"]), Date.now(), Date.now()).run();

		const terminalReceipt = {
			id: receiptB,
			outcome: "wrote",
			source: "ingest",
			source_mode: "ingest",
			source_packet_id: sourceB,
			idempotency_key: "wrong-packet",
			received: 1,
			digested: 1,
			skipped: 0,
			saved: { nodes: 1, slices: 0, events: 0, edges: 0, pages: 0, candidates: 0 },
			savedTotal: 1,
		};
		const queueKey = `q:0000000001-${crypto.randomUUID().slice(0, 8)}`;
		const stub = stubFor(userId);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("userId", userId);
			await state.storage.put(queueKey, {
				kind: "extract",
				phase: "settlement_pending",
				messages: [{ id: messageId, role: "user", content: "Synthetic pending settlement", ts: Date.now() }],
				jobByMessage: { [messageId]: jobId },
				dedupeByMessage: { [messageId]: `message:v2:${"e".repeat(64)}` },
				scopeKey: "global",
				overrides: {},
				attempts: 0,
				settlementAttempts: 0,
				runAfter: 0,
				enqueuedAt: Date.now(),
				terminal: {
					version: 1,
					action: "complete",
					outcome: "wrote",
					receipt: terminalReceipt,
					summary: "Synthetic cross-packet settlement",
					jobUpdates: [{
						jobId,
						messageIds: [messageId],
						disposition: "processed",
						counts: terminalReceipt.saved,
						receiptId: receiptB,
					}],
					processedIds: [messageId],
					processedIdentities: [`message:v2:${"e".repeat(64)}`],
					lastId: messageId,
					lastIdentity: `message:v2:${"e".repeat(64)}`,
					error: null,
				},
			});
		});

		const drained = await stub.drain({ userId, maxJobs: 1, ignoreBackoff: true });
		expect(drained.results[0]).toMatchObject({ kind: "extract", outcome: "wrote" });
		const job = await env.DB.prepare(
			"SELECT status, receipt_id, source_packet_id FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(jobId, userId).first();
		expect(job).toMatchObject({ status: "enriched", receipt_id: null, source_packet_id: sourceA });
		const delivery = await env.DB.prepare(
			`SELECT payload_json FROM webhook_deliveries
			 WHERE user_id = ? AND webhook_id = ? AND event = 'memory.enriched' LIMIT 1`,
		).bind(userId, webhookId).first();
		expect(delivery).toBeTruthy();
		const payload = JSON.parse(delivery.payload_json);
		expect(payload.data).toMatchObject({
			job_id: jobId,
			source_packet_id: sourceA,
			receipt_id: null,
			status: "enriched",
		});
		expect(payload.data.receipt_id).not.toBe(receiptB);
		await stub.resetAll();
	}, 30_000);
});

describe("legacy manual-collect idempotency", () => {
	const messagesFor = () => [{
		id: "manual-message",
		role: "user",
		content: "We decided the Manual Atlas cache key is project-qualified.",
		ts: T0,
	}];

	it("replays the first exact verdict without re-digesting or mutating page artifacts", async () => {
		const userId = `manual-replay-${crypto.randomUUID()}`;
		const idempotencyKey = `manual-replay-key-${crypto.randomUUID()}`;
		const base = {
			conversationId: `manual-conversation-${crypto.randomUUID()}`,
			idempotencyKey,
			digestResponse: "Manual Atlas uses a project-qualified cache key.",
		};
		const first = await saveConversation(env, null, userId, messagesFor(), base);
		expect(first.receipt?.id).toBeTruthy();
		const before = await manualCollectArtifacts(userId, idempotencyKey);

		const replay = await saveConversation(env, null, userId, messagesFor(), {
			...base,
			// A real model can be nondeterministic. An exact idempotency replay must
			// not execute this second digest or let it rewrite the first result.
			digestResponse: "MUTATION SENTINEL must never reach the saved page.",
		});
		const after = await manualCollectArtifacts(userId, idempotencyKey);

		expect(replay.receipt?.id).toBe(first.receipt.id);
		expect(after).toEqual(before);
		expect(after.pages[0].full_markdown).not.toContain("MUTATION SENTINEL");
	});

	it("resumes a source-only claim left by a crash instead of reporting processing forever", async () => {
		const userId = `manual-source-crash-${crypto.randomUUID()}`;
		const idempotencyKey = `manual-source-crash-key-${crypto.randomUUID()}`;
		const conversationId = `manual-conversation-${crypto.randomUUID()}`;
		const messages = messagesFor();
		const normalized = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "manual_collect",
			messages,
			conversationId,
			idempotencyKey,
		});
		const source = await storeSourcePacket(env, normalized.packet);
		expect(source.idempotent_replay).toBe(false);
		expect((await manualCollectArtifacts(userId, idempotencyKey))).toMatchObject({
			pages: [],
			runs: [],
			receipts: [],
			jobs: [],
		});

		const recovered = await saveConversation(env, null, userId, messages, {
			conversationId,
			idempotencyKey,
			digestResponse: "Recovered Manual Atlas completes after the source-only crash.",
		});
		expect(recovered.processing).toBe(false);
		expect(recovered.receipt?.id).toBeTruthy();
		const artifacts = await manualCollectArtifacts(userId, idempotencyKey);
		expect(artifacts.pages).toHaveLength(1);
		expect(artifacts.runs).toHaveLength(1);
		expect(artifacts.receipts).toHaveLength(1);
		expect(artifacts.jobs).toHaveLength(1);
	});

	it("never starts or persists a Google digest accepted at a deletion barrier", async () => {
		const userId = `manual-delete-admission-${crypto.randomUUID()}`;
		const idempotencyKey = `manual-delete-admission-key-${crypto.randomUUID()}`;
		const conversationId = `manual-delete-admission-conversation-${crypto.randomUUID()}`;
		const messages = messagesFor();
		const normalized = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "manual_collect",
			messages,
			conversationId,
			idempotencyKey,
		});
		const accepted = await storeSourcePacket(env, normalized.packet);
		const acceptedAt = Number(accepted.received_at ?? accepted.created_at);
		expect(acceptedAt).toBeGreaterThan(0);
		const barrierAt = acceptedAt;
		await env.DB.prepare(
			`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
			 VALUES (?, ?, ?, 'stage4-manual-admission-race')
			 ON CONFLICT(user_id) DO UPDATE SET barrier_at=excluded.barrier_at, created_at=excluded.created_at`,
		).bind(userId, barrierAt, barrierAt).run();
		// Force the legacy Date.now() substitution to land after the barrier. The
		// durable source acceptance remains before it, which is the race under test.
		while (Date.now() <= barrierAt) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}

		const googleEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			AI: { run: async () => { throw new Error("unexpected Workers AI invocation"); } },
			AI_ROUTING: "on",
			GCP_SERVICE_ACCOUNT: "{}",
			GCP_PROJECT_ID: "manual-admission-spec",
			GOOGLE_DAILY_GEN_TOKENS: "10000000",
			GOOGLE_MONTHLY_COST_MICROS: "1000000000",
		});
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		let providerInvocations = 0;
		provider.invoke = async () => {
			providerInvocations += 1;
			return {
				response: "Manual Atlas uses a project-qualified cache key.",
				usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
			};
		};
		const pin = buildPin({
			routes: { digest: { provider: "google-vertex", model: "gemini-2.5-flash" } },
		});

		try {
			const result = await withAiPin(pin, () => saveConversation(googleEnv, null, userId, messages, {
				conversationId,
				idempotencyKey,
			}));
			expect(result).toMatchObject({ cancelled: true, processing: false });
			expect(providerInvocations).toBe(0);
			const reservation = await env.DB.prepare(
				`SELECT status, memory_user_id, accepted_at FROM ai_provider_reservations
				 WHERE memory_user_id = ? AND scope = 'digest' ORDER BY created_at DESC LIMIT 1`,
			).bind(userId).first();
			expect(reservation).toMatchObject({
				status: "released",
				memory_user_id: userId,
				accepted_at: acceptedAt,
			});
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("fences a manual page commit at the exact deletion millisecond", async () => {
		const userId = `manual-page-delete-tie-${crypto.randomUUID()}`;
		const idempotencyKey = `manual-page-delete-tie-key-${crypto.randomUUID()}`;
		const conversationId = `manual-page-delete-tie-conversation-${crypto.randomUUID()}`;
		const messages = messagesFor();
		const normalized = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "manual_collect",
			messages,
			conversationId,
			idempotencyKey,
		});
		const sourcePacket = await storeSourcePacket(env, normalized.packet);
		const acceptedAt = Number(sourcePacket.received_at ?? sourcePacket.created_at);
		await env.DB.prepare(
			`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
			 VALUES (?, ?, ?, 'stage4-manual-page-tie')
			 ON CONFLICT(user_id) DO UPDATE SET barrier_at=excluded.barrier_at, created_at=excluded.created_at`,
		).bind(userId, acceptedAt, acceptedAt).run();

		const result = await saveMemoryPage(env, userId, {
			digest: "Manual Atlas uses a project-qualified cache key.",
			messages: normalized.messages,
			intent: parseCollectIntent(normalized.messages, {}),
			received: 1,
			keptLines: 1,
			conversationId,
			sourcePacket,
		});
		expect(result).toMatchObject({ cancelled: true, processing: false });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_pages WHERE user_id = ?",
		).bind(userId).first()).toEqual({ n: 0 });
		expect(await env.DB.prepare(
			"SELECT status FROM extraction_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first()).toEqual({ status: "cancelled_by_delete" });
	});

	it("serializes concurrent exact calls so the loser creates no second run, page, job, or receipt", async () => {
		const userId = `manual-concurrent-${crypto.randomUUID()}`;
		const idempotencyKey = `manual-concurrent-key-${crypto.randomUUID()}`;
		const input = {
			conversationId: `manual-conversation-${crypto.randomUUID()}`,
			idempotencyKey,
			digestResponse: "Concurrent Manual Atlas keeps one immutable page.",
		};
		const [left, right] = await Promise.all([
			saveConversation(env, null, userId, messagesFor(), input),
			saveConversation(env, null, userId, messagesFor(), input),
		]);
		const artifacts = await manualCollectArtifacts(userId, idempotencyKey);
		const receiptIds = [left.receipt?.id, right.receipt?.id].filter(Boolean);
		expect(receiptIds.length).toBeGreaterThanOrEqual(1);
		expect(new Set(receiptIds).size).toBe(1);
		const concurrentLoser = [left, right].find((result) => !result.receipt?.id);
		if (concurrentLoser) {
			expect(concurrentLoser).toMatchObject({ duplicate: true, processing: true });
		}
		expect(artifacts.pages).toHaveLength(1);
		expect(artifacts.runs).toHaveLength(1);
		expect(artifacts.receipts).toHaveLength(1);
		expect(artifacts.jobs).toHaveLength(1);

		const settledReplay = await saveConversation(env, null, userId, messagesFor(), input);
		expect(settledReplay).toMatchObject({ duplicate: true, processing: false });
		expect(settledReplay.receipt?.id).toBe(receiptIds[0]);
		expect(await manualCollectArtifacts(userId, idempotencyKey)).toEqual(artifacts);
	});
});
