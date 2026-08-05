import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { INGEST_DELIVERY_SCHEMA, INGEST_LIMITS } from "../src/lib/ingest_contract.mjs";
import { runObserveMessagesCommand } from "../src/pipeline/commands.js";
import { normalizeSourcePacket, storeSourcePacket } from "../src/pipeline/source.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(body) {
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json(), headers: response.headers };
}

async function handoffMarkerCount(userId) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	return runInDurableObject(stub, async (_instance, state) => {
		const markers = await state.storage.list({ prefix: "handoff:v1:" });
		return markers.size;
	});
}

const emptyExtraction = { objects: [], notes: "nothing extractable" };

function orderedDelivery(overrides = {}) {
	return {
		schema: INGEST_DELIVERY_SCHEMA,
		groupId: `claude_delivery_v1_${"c".repeat(40)}`,
		batchIndex: 0,
		batchCount: 2,
		sourceMessageCount: 3,
		segmentCount: 4,
		splitSourceMessages: 1,
		captureTruncated: true,
		truncationReason: "bounded_scan",
		...overrides,
	};
}

function bodyFor(userId, idempotencyKey, content, extra = {}) {
	return {
		userId,
		idempotencyKey,
		messages: [{ id: "m1", role: "user", content }],
		...extra,
	};
}

describe("POST /v1/ingest contract", () => {
	it("publishes the authoritative current wire limits without authentication", async () => {
		const request = new Request("http://example.com/v1/ingest/limits");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			schema: "itsuki.ingest-limits/v1",
			limits: INGEST_LIMITS,
			character_unit: "unicode_code_points",
			request_encoding: "utf-8-json",
			delivery_schema: INGEST_DELIVERY_SCHEMA,
		});
	});

	it("returns a machine-readable 413 before parsing an oversized JSON body", async () => {
		const raw = JSON.stringify(bodyFor(
			`limit-bytes-${crypto.randomUUID()}`,
			`limit-bytes-${crypto.randomUUID()}`,
			"x".repeat(INGEST_LIMITS.maxRequestBytes),
		));
		expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(INGEST_LIMITS.maxRequestBytes);
		const response = await call(raw);
		expect(response.status).toBe(413);
		expect(response.body).toMatchObject({
			error: "ingest_request_too_large",
			code: "ingest_request_too_large",
			field: "request",
			limit: INGEST_LIMITS.maxRequestBytes,
			unit: "bytes",
			retryable: false,
			limits: INGEST_LIMITS,
		});
	});

	it.each([
		[INGEST_LIMITS.maxRequestBytes - 1, 200],
		[INGEST_LIMITS.maxRequestBytes, 200],
		[INGEST_LIMITS.maxRequestBytes + 1, 413],
	])("enforces the actual HTTP JSON boundary at %i UTF-8 bytes", async (targetBytes, expectedStatus) => {
		const base = JSON.stringify(bodyFor(
			`http-byte-boundary-${targetBytes}-${crypto.randomUUID()}`,
			`http-byte-key-${targetBytes}-${crypto.randomUUID()}`,
			"ok thanks",
		));
		const raw = `${base}${" ".repeat(targetBytes - new TextEncoder().encode(base).byteLength)}`;
		expect(new TextEncoder().encode(raw).byteLength).toBe(targetBytes);

		const response = await call(raw);
		expect(response.status).toBe(expectedStatus);
		if (expectedStatus === 413) {
			expect(response.body).toMatchObject({
				error: "ingest_request_too_large",
				actual: targetBytes,
				limit: INGEST_LIMITS.maxRequestBytes,
			});
		}
	});

	it.each([31, 80])("returns a machine-readable 422 for %i current messages", async (count) => {
		const response = await call({
			userId: `limit-count-${count}-${crypto.randomUUID()}`,
			messages: Array.from({ length: count }, (_, index) => ({ id: `m${index}`, role: "user", content: "x" })),
		});
		expect(response.status).toBe(422);
		expect(response.body).toMatchObject({
			error: "ingest_message_count_exceeded",
			code: "ingest_message_count_exceeded",
			field: "messages",
			limit: INGEST_LIMITS.maxMessages,
			actual: count,
			unit: "messages",
		});
	});

	it.each([
		["array content", [{ id: "bad-content", role: "user", content: Array.from({ length: 13_001 }, () => "x") }]],
		["array message", [["not", "a", "message"]]],
		["empty id", [{ id: "", role: "user", content: "I started learning Rust." }]],
		["non-string id", [{ id: {}, role: "user", content: "I started learning Rust." }]],
		["duplicate ids", [
			{ id: "same", role: "user", content: "I started learning Rust." },
			{ id: "same", role: "user", content: "I started learning Go." },
		]],
	])("rejects malformed %s before any D1 or Durable Object mutation", async (_label, messages) => {
		const userId = `invalid-message-${crypto.randomUUID()}`;
		const response = await call({
			userId,
			idempotencyKey: `invalid-message-key-${crypto.randomUUID()}`,
			messages,
		});
		expect(response).toMatchObject({
			status: 422,
			body: {
				error: "invalid_ingest_message",
				code: "invalid_ingest_message",
				retryable: false,
			},
		});

		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
		).bind(userId, userId).first();
		expect(counts).toMatchObject({ packets: 0, jobs: 0 });
		expect(await handoffMarkerCount(userId)).toBe(0);
	});

	it("drains an already-spooled v1 Claude envelope above the new count limit", async () => {
		const response = await call({
			userId: `legacy-v1-${crypto.randomUUID()}`,
			source: "plugin",
			idempotencyKey: `claude-outbox:v1:${"9".repeat(64)}`,
			messages: Array.from({ length: 31 }, (_, index) => ({ id: `m${index}`, role: "user", content: "ok" })),
		});
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, counts: { received: 31 } });
		expect(response.headers.get("x-itsuki-ingest-contract")).toBe("legacy-claude-outbox-v1");
	});

	it("drains an already-spooled v1 envelope above the new byte limit but below the former 2 MiB cap", async () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({
			id: `assistant-${index}`,
			role: "assistant",
			content: "\u0001".repeat(4_001),
		}));
		messages.push({ id: "user-noise", role: "user", content: "ok thanks" });
		const body = {
			userId: `legacy-v1-bytes-${crypto.randomUUID()}`,
			source: "plugin",
			idempotencyKey: `claude-outbox:v1:${"8".repeat(64)}`,
			messages,
		};
		const serialized = JSON.stringify(body);
		const bytes = new TextEncoder().encode(serialized).byteLength;
		expect(bytes).toBeGreaterThan(INGEST_LIMITS.maxRequestBytes);
		expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);

		const response = await call(serialized);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, counts: { received: 31 } });
	});

	it("persists ordered delivery through packet, job, receipt, and status", async () => {
		const userId = `delivery-${crypto.randomUUID()}`;
		const delivery = orderedDelivery();
		const response = await call(bodyFor(
			userId,
			`claude-outbox:v2:${"d".repeat(64)}`,
			"ok thanks",
			{ source: "plugin", delivery },
		));
		expect(response.status).toBe(200);
		expect(response.body.receipt.delivery).toEqual(delivery);

		const packet = await env.DB.prepare(
			"SELECT id, raw_meta_json FROM source_packets WHERE id = ? AND user_id = ?",
		).bind(response.body.source_packet_id, userId).first();
		expect(JSON.parse(packet.raw_meta_json).delivery).toEqual(delivery);

		const job = await env.DB.prepare(
			"SELECT id, payload_json, receipt_id FROM memory_jobs WHERE source_packet_id = ? AND user_id = ?",
		).bind(packet.id, userId).first();
		expect(JSON.parse(job.payload_json).delivery).toEqual(delivery);
		expect(job.receipt_id).toBe(response.body.receipt_id);

		const receipt = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE id = ? AND user_id = ?",
		).bind(response.body.receipt_id, userId).first();
		expect(JSON.parse(receipt.detail).delivery).toEqual(delivery);

		const request = new Request(
			`http://example.com/v1/packets/${encodeURIComponent(packet.id)}/status?userId=${encodeURIComponent(userId)}`,
			{ headers: { "x-api-key": env.API_KEY } },
		);
		const ctx = createExecutionContext();
		const statusResponse = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(statusResponse.status).toBe(200);
		expect(await statusResponse.json()).toMatchObject({
			ok: true,
			job_id: job.id,
			source_packet_id: packet.id,
			delivery,
		});
	});

	it("preserves the full successful extraction receipt while retry state stays compact", async () => {
		const userId = `delivery-write-${crypto.randomUUID()}`;
		const delivery = orderedDelivery({ batchIndex: 1 });
		const label = `Receipt Atlas ${crypto.randomUUID().slice(0, 8)}`;
		const response = await call(bodyFor(
			userId,
			`claude-outbox:v2:${"a".repeat(64)}`,
			`I decided ${label} will use an immutable deployment ledger.`,
			{
				source: "plugin",
				flush: true,
				delivery,
				memoryScope: {
					projectId: `project-${crypto.randomUUID()}`,
					projectName: "Receipt proof",
				},
				_test: {
					llmResponse: {
						objects: [
							{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.99 },
							{ kind: "slice", on: label, text: `${label} uses an immutable deployment ledger`, kind_detail: "detail", confidence: 0.99 },
						],
						notes: "deterministic receipt proof",
					},
					edgeResponse: { edges: [] },
					reflexionResponse: { entities: [], facts: [], edges: [] },
				},
			},
		));
		expect(response.status).toBe(200);

		const job = await env.DB.prepare(
			"SELECT status, receipt_id FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(response.body.job_id, userId).first();
		expect(job?.status).toBe("enriched");
		const stored = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE id = ? AND user_id = ?",
		).bind(job.receipt_id, userId).first();
		const receipt = JSON.parse(stored.detail);
		expect(receipt).toMatchObject({
			delivery,
			project_name: "Receipt proof",
			actions: {
				createdNodes: [expect.objectContaining({ label })],
				createdSlices: [expect.objectContaining({ node_id: expect.any(String) })],
			},
			skippedReasons: {},
			saved: {
				newNodeLabels: [label],
				reinforcedSlices: 0,
				reinforcedEvents: 0,
				reinforcedEdges: 0,
			},
		});
		expect(receipt.created_at).toEqual(expect.any(Number));
	});

	it("returns the full canonical receipt when a command waits for terminal extraction", async () => {
		const userId = `inline-receipt-${crypto.randomUUID()}`;
		const delivery = orderedDelivery({ batchIndex: 0 });
		const label = `Inline Atlas ${crypto.randomUUID().slice(0, 8)}`;
		const ctx = createExecutionContext();
		const result = await runObserveMessagesCommand(env, ctx, userId, [{
			id: "inline-receipt-message",
			role: "user",
			content: `I decided ${label} will use an immutable deployment ledger.`,
		}], {
			flush: true,
			waitBudgetMs: 5_000,
			conversationId: `conversation-${crypto.randomUUID()}`,
			idempotencyKey: `inline-receipt-${crypto.randomUUID()}`,
			delivery,
			memoryScope: {
				projectId: `project-${crypto.randomUUID()}`,
				projectName: "Inline receipt proof",
			},
			source: "plugin",
			sourceMode: "ingest",
			overrides: {
				llmResponse: {
					objects: [
						{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.99 },
						{ kind: "slice", on: label, text: `${label} uses an immutable deployment ledger`, kind_detail: "detail", confidence: 0.99 },
					],
					notes: "deterministic inline receipt proof",
				},
				edgeResponse: { edges: [] },
				reflexionResponse: { entities: [], facts: [], edges: [] },
			},
		});
		await waitOnExecutionContext(ctx);
		expect(result.receipt).toMatchObject({
			delivery,
			project_name: "Inline receipt proof",
			actions: {
				createdNodes: [expect.objectContaining({ label })],
				createdSlices: [expect.objectContaining({ node_id: expect.any(String) })],
			},
			skippedReasons: {},
			saved: {
				newNodeLabels: [label],
				reinforcedSlices: 0,
				reinforcedEvents: 0,
				reinforcedEdges: 0,
			},
		});
	});

	it("accepts ordered batches independently and replays only the retried batch", async () => {
		const userId = `delivery-retry-${crypto.randomUUID()}`;
		const key0 = `claude-outbox:v2:${"e".repeat(64)}`;
		const key1 = `claude-outbox:v2:${"f".repeat(64)}`;
		const firstBody = bodyFor(userId, key0, "ok thanks zero", {
			source: "plugin",
			delivery: orderedDelivery({ batchIndex: 0 }),
		});
		const secondBody = bodyFor(userId, key1, "ok thanks one", {
			source: "plugin",
			delivery: orderedDelivery({ batchIndex: 1 }),
			messages: [{ id: "m2", role: "user", content: "ok thanks one" }],
		});

		const first = await call(firstBody);
		const retry = await call(firstBody);
		const second = await call(secondBody);
		expect([first.status, retry.status, second.status]).toEqual([200, 200, 200]);
		expect(retry.body).toMatchObject({
			duplicate: true,
			job_id: first.body.job_id,
			source_packet_id: first.body.source_packet_id,
		});
		expect(second.body.source_packet_id).not.toBe(first.body.source_packet_id);

		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS packets, (SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs FROM source_packets WHERE user_id = ?",
		).bind(userId, userId).first();
		expect(rows).toMatchObject({ packets: 2, jobs: 2 });
	});
});

describe("crash-safe ingest handoff", () => {
	it("repairs a retry after D1 job creation but before Durable Object acceptance", async () => {
		const userId = `handoff-after-job-${crypto.randomUUID()}`;
		const body = bodyFor(
			userId,
			`handoff-after-job-key-${crypto.randomUUID()}`,
			"I started learning fault-tolerant distributed systems",
			{ flush: true, _test: { _testIngestFault: "after_job_claim", llmResponse: emptyExtraction } },
		);

		const interrupted = await call(body);
		expect(interrupted.status).toBe(500);
		expect(await handoffMarkerCount(userId)).toBe(0);

		const retry = await call({ ...body, _test: { llmResponse: emptyExtraction } });
		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ ok: true });
		expect(retry.body.duplicate).not.toBe(true);
		expect(retry.body.source_packet_id).toMatch(/^src_/);
		expect(retry.body.job_id).toMatch(/^job_/);
		expect(await handoffMarkerCount(userId)).toBe(0);

		const counts = await env.DB.prepare(
			`SELECT COUNT(*) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs,
				(SELECT COUNT(*) FROM staged_memories WHERE user_id = ?) AS staged
			 FROM source_packets WHERE user_id = ?`,
		).bind(userId, body.idempotencyKey, userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 1, staged: 1 });
	});

	it("repairs a retry after Durable Object enqueue but before the HTTP response", async () => {
		const userId = `handoff-after-do-${crypto.randomUUID()}`;
		const body = bodyFor(
			userId,
			`handoff-after-do-key-${crypto.randomUUID()}`,
			"I started studying Byzantine fault tolerance every weekend",
			{ flush: true, _test: { _testIngestFault: "after_do_accept", llmResponse: emptyExtraction } },
		);

		const interrupted = await call(body);
		expect(interrupted.status).toBe(500);
		expect(await handoffMarkerCount(userId)).toBe(1);

		const retry = await call({ ...body, _test: { llmResponse: emptyExtraction } });
		expect(retry.status).toBe(200);
		expect(retry.body).toMatchObject({ ok: true, duplicate: true });
		expect(await handoffMarkerCount(userId)).toBe(0);

		const counts = await env.DB.prepare(
			`SELECT COUNT(*) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs
			 FROM source_packets WHERE user_id = ?`,
		).bind(userId, body.idempotencyKey, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 1 });
	});

	it("links a known noise verdict across the D1-only repair window", async () => {
		for (const repair of ["none", "after_job_claim"]) {
			const userId = `handoff-noise-${repair}-${crypto.randomUUID()}`;
			const fault = repair === "after_job_claim"
				? { _testIngestFault: "after_job_claim" }
				: null;
			const body = bodyFor(
				userId,
				`handoff-noise-key-${crypto.randomUUID()}`,
				"ok thanks",
				fault ? { _test: fault } : {},
			);
			if (fault) expect((await call(body)).status).toBe(500);

			const response = await call({ ...body, _test: {} });
			expect(response.status).toBe(200);
			expect(response.body.receipt).toMatchObject({
				outcome: "ignored",
				source_packet_id: response.body.source_packet_id,
				skipped: 1,
			});
			expect(response.body.duplicate).not.toBe(true);

			const job = await env.DB.prepare(
				"SELECT status, receipt_id, source_packet_id FROM memory_jobs WHERE id = ? AND user_id = ?",
			).bind(response.body.job_id, userId).first();
			expect(job).toMatchObject({
				status: "enriched",
				receipt_id: response.body.receipt_id,
				source_packet_id: response.body.source_packet_id,
			});
			const receipt = await env.DB.prepare(
				"SELECT outcome, source_packet_id, detail FROM receipts WHERE id = ? AND user_id = ?",
			).bind(job.receipt_id, userId).first();
			expect(receipt).toMatchObject({ outcome: "ignored", source_packet_id: response.body.source_packet_id });
			expect(JSON.parse(receipt.detail)).toMatchObject({
				outcome: "ignored",
				source_packet_id: response.body.source_packet_id,
				skipped: 1,
			});
		}
	});

	it("never lets an accepted door receipt replace a fast terminal engine receipt", async () => {
		const userId = `receipt-race-${crypto.randomUUID()}`;
		const response = await call(bodyFor(
			userId,
			`receipt-race-key-${crypto.randomUUID()}`,
			"I started studying linearizability every morning",
			{ flush: true, _test: { llmResponse: emptyExtraction } },
		));
		expect(response.status).toBe(200);
		expect(response.body.receipt.outcome).toBe("accepted");

		const job = await env.DB.prepare(
			"SELECT status, receipt_id, source_packet_id FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(response.body.job_id, userId).first();
		expect(job.status).toBe("enriched");
		expect(job.source_packet_id).toBe(response.body.source_packet_id);
		expect(job.receipt_id).toBeTruthy();
		expect(job.receipt_id).not.toBe(response.body.receipt_id);
		const finalReceipt = await env.DB.prepare(
			"SELECT outcome, source_packet_id FROM receipts WHERE id = ? AND user_id = ?",
		).bind(job.receipt_id, userId).first();
		expect(finalReceipt.source_packet_id).toBe(response.body.source_packet_id);
		expect(finalReceipt.outcome).not.toBe("accepted");
	});

	it("does not synthesize a canonical ignored link for an unknown terminal replay", async () => {
		const userId = `terminal-no-receipt-${crypto.randomUUID()}`;
		const body = bodyFor(userId, `terminal-no-receipt-key-${crypto.randomUUID()}`, "ok thanks");
		const first = await call(body);
		expect(first.status).toBe(200);
		await env.DB.prepare("UPDATE memory_jobs SET receipt_id = NULL WHERE id = ? AND user_id = ?")
			.bind(first.body.job_id, userId).run();
		await env.DB.prepare("DELETE FROM receipts WHERE id = ? AND user_id = ?")
			.bind(first.body.receipt_id, userId).run();

		const replay = await call(body);
		expect(replay.status).toBe(200);
		expect(replay.body).toMatchObject({ duplicate: true, job_id: first.body.job_id });
		const job = await env.DB.prepare("SELECT status, receipt_id FROM memory_jobs WHERE id = ? AND user_id = ?")
			.bind(first.body.job_id, userId).first();
		expect(job).toMatchObject({ status: "enriched", receipt_id: null });
	});

	it("converges concurrent identical submissions on one packet, job, and handoff", async () => {
		const userId = `handoff-concurrent-${crypto.randomUUID()}`;
		const body = bodyFor(
			userId,
			`handoff-concurrent-key-${crypto.randomUUID()}`,
			"I started practicing resilient queue design every morning",
			{ flush: true, _test: { llmResponse: emptyExtraction } },
		);

		const responses = await Promise.all(Array.from({ length: 8 }, () => call(body)));
		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect(new Set(responses.map((response) => response.body.source_packet_id)).size).toBe(1);
		expect(new Set(responses.map((response) => response.body.job_id)).size).toBe(1);
		expect(new Set(responses.map((response) => response.body.receipt_id)).size).toBe(1);
		expect(responses.some((response) => response.body.duplicate === true)).toBe(true);
		expect(await handoffMarkerCount(userId)).toBe(0);
		const receiptCount = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM receipts
			 WHERE user_id = ? AND source_packet_id = ? AND id = ?`,
		).bind(userId, responses[0].body.source_packet_id, responses[0].body.receipt_id).first();
		expect(receiptCount.n).toBe(1);

		const counts = await env.DB.prepare(
			`SELECT COUNT(*) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs,
				(SELECT COUNT(*) FROM staged_memories WHERE user_id = ?) AS staged
			 FROM source_packets WHERE user_id = ?`,
		).bind(userId, body.idempotencyKey, userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 1, staged: 1 });
	});
});

describe("permanent ingest idempotency", () => {
	it("keeps a source-only repair ledger when atomic capacity rejects a new job", async () => {
		const userId = `capacity-ledger-${crypto.randomUUID()}`;
		const now = Date.now();
		const statements = Array.from({ length: 200 }, (_, index) => env.DB.prepare(
			`INSERT INTO memory_jobs
				(id, user_id, type, status, idempotency_key, attempts, payload_json, run_after, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'queued', ?, 0, '{}', ?, ?, ?)`,
		).bind(`job_capacity_${index}_${crypto.randomUUID()}`, userId, `seed-${index}`, now, now, now));
		await env.DB.batch(statements.slice(0, 100));
		await env.DB.batch(statements.slice(100));

		const key = `capacity-ledger-key-${crypto.randomUUID()}`;
		const body = bodyFor(userId, key, "Queue admission control protects account capacity.");
		// Reproduce the race loser/crash ledger: source ownership committed while
		// another request filled the final active slot before this job claim.
		const normalized = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "ingest",
			messages: body.messages,
			idempotencyKey: key,
			scope: {
				memoryUserId: userId,
				ownerUserId: "legacy",
				externalUserId: userId,
				projectId: null,
				projectName: null,
			},
		});
		await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
		const rejected = await call(body);
		expect(rejected).toMatchObject({
			status: 429,
			body: { error: "queue_full", queue_depth: 200 },
		});
		expect(await handoffMarkerCount(userId)).toBe(0);
		let counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
		).bind(userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 200 });

		const conflict = await call(bodyFor(userId, key, "different content at the same capacity key"));
		expect(conflict).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
		counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs`,
		).bind(userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 200 });

		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'enriched', completed_at = ? WHERE user_id = ? AND idempotency_key = 'seed-0'",
		).bind(Date.now(), userId).run();
		const repaired = await call(body);
		expect(repaired.status).toBe(200);
		expect(repaired.body).toMatchObject({ ok: true, counts: { held: 1 } });
		expect(repaired.body.duplicate).not.toBe(true);
		expect(await handoffMarkerCount(userId)).toBe(1);
		counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND status IN ('queued','staged','processing')) AS active`,
		).bind(userId, userId, userId).first();
		expect(counts).toMatchObject({ packets: 1, jobs: 201, active: 200 });
	}, 30_000);

	it("returns the original packet/job/receipt after the former 24-hour window", async () => {
		const userId = `permanent-replay-${crypto.randomUUID()}`;
		const body = bodyFor(userId, `permanent-key-${crypto.randomUUID()}`, "ok thanks");
		const first = await call(body);
		expect(first.status).toBe(200);

		await env.DB.prepare(
			"UPDATE memory_jobs SET created_at = 1, updated_at = 1 WHERE id = ? AND user_id = ?",
		).bind(first.body.job_id, userId).run();
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS jobs FROM memory_jobs WHERE user_id = ?",
		).bind(userId).first();

		const replay = await call(body);
		expect(replay.status).toBe(200);
		expect(replay.body).toMatchObject({
			duplicate: true,
			job_id: first.body.job_id,
			source_packet_id: first.body.source_packet_id,
			receipt_id: first.body.receipt_id,
		});
		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS jobs FROM memory_jobs WHERE user_id = ?",
		).bind(userId).first();
		expect(after.jobs).toBe(before.jobs);
	});

	it("returns the original terminal failure without silently resetting the job", async () => {
		const userId = `failed-retry-${crypto.randomUUID()}`;
		const body = bodyFor(userId, `failed-retry-key-${crypto.randomUUID()}`, "ok thanks");
		const first = await call(body);
		expect(first.status).toBe(200);
		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'failed', error = 'synthetic failure', completed_at = ? WHERE id = ? AND user_id = ?",
		).bind(Date.now(), first.body.job_id, userId).run();

		const retry = await call(body);
		expect(retry.status).toBe(200);
		expect(retry.body.duplicate).toBe(true);
		expect(retry.body).toMatchObject({
			job_id: first.body.job_id,
			source_packet_id: first.body.source_packet_id,
		});
		const job = await env.DB.prepare(
			"SELECT status, error, completed_at FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(first.body.job_id, userId).first();
		expect(job.status).toBe("failed");
		expect(job.error).toBe("synthetic failure");
		expect(job.completed_at).not.toBeNull();
	});

	it("returns 409 without mutating the packet, job, receipt, or checkpoint", async () => {
		const userId = `idempotency-conflict-${crypto.randomUUID()}`;
		const key = `conflict-key-${crypto.randomUUID()}`;
		const first = await call(bodyFor(userId, key, "ok thanks"));
		expect(first.status).toBe(200);
		const before = await env.DB.prepare(
			`SELECT sp.content_hash, sp.raw_meta_json,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts
			 FROM source_packets sp WHERE sp.id = ? AND sp.user_id = ?`,
		).bind(userId, userId, first.body.source_packet_id, userId).first();

		const conflict = await call(bodyFor(userId, key, "different durable content"));
		expect(conflict.status).toBe(409);
		expect(conflict.body).toMatchObject({
			error: "idempotency_conflict",
			code: "idempotency_conflict",
			source_packet_id: first.body.source_packet_id,
		});

		const after = await env.DB.prepare(
			`SELECT sp.content_hash, sp.raw_meta_json,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ?) AS jobs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts
			 FROM source_packets sp WHERE sp.id = ? AND sp.user_id = ?`,
		).bind(userId, userId, first.body.source_packet_id, userId).first();
		expect(after).toEqual(before);
	});

	it("serializes concurrent conflicting claims without overwriting the winner", async () => {
		const userId = `idempotency-race-${crypto.randomUUID()}`;
		const key = `race-key-${crypto.randomUUID()}`;
		const [left, right] = await Promise.all([
			call(bodyFor(userId, key, "ok thanks left")),
			call(bodyFor(userId, key, "ok thanks right")),
		]);
		expect([left.status, right.status].sort()).toEqual([200, 409]);

		const packet = await env.DB.prepare(
			"SELECT content_preview, raw_meta_json FROM source_packets WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, key).first();
		const stored = JSON.parse(packet.raw_meta_json).messages[0].snippet;
		expect(["ok thanks left", "ok thanks right"]).toContain(stored);
		expect(packet.content_preview).toBe(stored);
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, key).first();
		expect(jobs.n).toBe(1);
	});

	it.each([
		["empty", []],
		["assistant-only", [{ id: "assistant-context", role: "assistant", content: "The build completed successfully." }]],
	])("terminalizes an authenticated %s packet instead of leaking an active job", async (_label, messages) => {
		const userId = `context-only-${crypto.randomUUID()}`;
		const idempotencyKey = `context-only-key-${crypto.randomUUID()}`;
		const body = { userId, idempotencyKey, messages };

		const first = await call(body);
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({
			ok: true,
			processing: false,
			receipt: { outcome: "ignored" },
		});

		const job = await env.DB.prepare(
			"SELECT status, receipt_id, payload_json FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(first.body.job_id, userId).first();
		expect(job).toMatchObject({
			status: "enriched",
			receipt_id: first.body.receipt_id,
		});
		expect(JSON.parse(job.payload_json)).toMatchObject({ remaining: [] });
		const active = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status IN ('queued', 'staged', 'processing')",
		).bind(userId).first();
		expect(active.n).toBe(0);

		const replay = await call(body);
		expect(replay.status).toBe(200);
		expect(replay.body).toMatchObject({
			duplicate: true,
			job_id: first.body.job_id,
			receipt_id: first.body.receipt_id,
			receipt: { outcome: "ignored" },
		});
	});
});
