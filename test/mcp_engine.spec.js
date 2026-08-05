/**
 * The MCP engine lane — receipt-first async saves on Engine v2.
 *
 * Covers the honesty contract end to end with deterministic model responses:
 *   - staging is instant, model-free, and truthful (staged ≠ saved)
 *   - background enrichment writes the SAME graph the SDK lane writes
 *   - a deliberately failed enrichment is VISIBLE: failed job row, failed
 *     page, admin error report — never a silent success (Graphiti #1164)
 *   - titles are never assembled from fragments: a bad title pass falls back
 *     to entity + date
 *   - assistant turns are context, never memory (trust attribution)
 *   - save_memory short-circuits the edge/reflexion passes below the
 *     entity threshold (the light path)
 */

import { env, createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
	stageMcpConversation,
	enrichMcpConversation,
	provisionalTitle,
	topEntityFromLines,
	reconcileTitle,
	durableUserMessages,
} from "../src/pipeline/mcp_engine.js";
import { runDirectSaveCommand } from "../src/pipeline/commands.js";
import { getConfig } from "../src/config.js";
import { claimMemoryJob, MEMORY_JOB_ACTIVE_LIMIT } from "../src/lib/db.js";
import worker from "../src/index.js";

const T0 = Date.parse("2026-08-01T14:00:00Z");

function conv() {
	return [
		{ id: "e1", role: "user", content: "I started a new job at Halcyon Robotics as a firmware engineer.", ts: T0 },
		{ id: "e2", role: "assistant", content: "Congratulations! You should really switch to decaf coffee.", ts: T0 + 60_000 },
		{ id: "e3", role: "user", content: "My sister Nadia moved to Porto with her husband Tomas.", ts: T0 + 120_000 },
	];
}

const CANNED_EXTRACTION = {
	objects: [
		{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
		{ kind: "node", label: "Nadia", category: "family", confidence: 0.9 },
		{ kind: "node", label: "Tomas", category: "person", confidence: 0.85 },
		{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
		{ kind: "event", on: "Nadia", text: "Moved to Porto", action: "moved", confidence: 0.9 },
	],
	notes: "",
};

// numberEntities orders shortlist first (empty for a fresh user), then call-1
// nodes in order: 1 Halcyon Robotics, 2 Nadia, 3 Tomas.
const CANNED_EDGES = {
	edges: [
		{ source_entity_id: 2, target_entity_id: 3, relation_type: "MARRIED_TO", fact: "Nadia is married to Tomas", valid_at: null, invalid_at: null },
	],
};
const CANNED_REFLEXION = { entities: [], facts: [], edges: [] };

async function stage(userId, overrides = {}, messages = conv(), input = {}) {
	const ctx = createExecutionContext();
	const res = await stageMcpConversation(env, ctx, userId, {
		...input,
		messages,
		conversationId: input.conversationId ?? `conv-${userId}`,
		testOverrides: {
			llmResponse: CANNED_EXTRACTION,
			edgeResponse: CANNED_EDGES,
			reflexionResponse: CANNED_REFLEXION,
			titleResponse: { title: "New Job At Halcyon Robotics" },
			...overrides,
		},
	});
	await waitOnExecutionContext(ctx);
	return res;
}

async function ingestHttp(userId, idempotencyKey, messages, extra = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
		body: JSON.stringify({ userId, idempotencyKey, messages, ...extra }),
	}), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function idempotencySnapshot(userId, idempotencyKey) {
	const source = await env.DB.prepare(
		`SELECT id, source_type, source_mode, content_hash, raw_meta_json, seen_count,
			created_at, updated_at FROM source_packets
		 WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
	).bind(userId, idempotencyKey).first();
	const jobs = await env.DB.prepare(
		`SELECT id, type, status, source_packet_id, receipt_id, payload_json, created_at, updated_at
		 FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? ORDER BY id`,
	).bind(userId, idempotencyKey).all();
	const receipts = await env.DB.prepare(
		`SELECT id, source, outcome, summary, detail, created_at
		 FROM receipts WHERE user_id = ? ORDER BY id`,
	).bind(userId).all();
	return { source, jobs: jobs.results ?? [], receipts: receipts.results ?? [] };
}

/** Drive the DO queue until every staged job resolved (bounded, no clock luck). */
async function drainUntilSettled(userId, maxRounds = 30, { reset = true } = {}) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) {
			// Drop DO state (including any re-armed alarm): D1 keeps everything
			// these tests assert on, and a live alarm firing into the test
			// pool's storage teardown reads as an "Isolated storage failed".
			if (reset) await stub.resetAll();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("mcp jobs did not settle");
}

async function mcpDurableState(userId) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	return runInDurableObject(stub, async (_instance, state) => {
		const entries = await state.storage.list({ prefix: "q:" });
		const markers = await state.storage.list({ prefix: "mcp-handoff:v1:" });
		const mcpEntries = [...entries.entries()].filter(([, entry]) => entry?.kind === "mcp");
		return {
			queueCount: mcpEntries.length,
			queueJobIds: mcpEntries.map(([, entry]) => entry.job?.jobId ?? null),
			markerCount: markers.size,
			markers: [...markers.values()],
		};
	});
}

async function mcpArtifactCounts(userId, idempotencyKey) {
	return env.DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM source_packets WHERE user_id = ? AND idempotency_key = ?) AS sources,
			(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs,
			(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages,
			(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts,
			(SELECT COUNT(*) FROM staged_memories WHERE user_id = ?) AS staged`,
	).bind(userId, idempotencyKey, userId, idempotencyKey, userId, userId, userId).first();
}

async function jobFor(userId) {
	return env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE user_id = ? AND type = 'mcp_enrich' ORDER BY created_at DESC LIMIT 1",
	).bind(userId).first();
}

async function pageById(pageId) {
	return env.DB.prepare("SELECT * FROM memory_pages WHERE id = ?").bind(pageId).first();
}

describe("staging (sync phase)", () => {
	it("returns the receipt-first contract instantly, with a deterministic provisional title", async () => {
		const userId = `stage-${crypto.randomUUID()}`;
		const res = await stage(userId);
		expect(res.processing).toBe(true);
		expect(res.job_status).toBe("staged");
		expect(res.page_id).toMatch(/^page_/);
		expect(res.staged_facts).toBe(2);
		// Top entity + date — never fragment salad. Entity ranking is
		// deterministic: "Halcyon Robotics" is the first multi-word proper run.
		expect(res.title).toBe("Halcyon Robotics — Aug 1, 2026");
		expect(res.summary).toContain("Staged");
		expect(res.summary).not.toMatch(/\bSaved\b/);
		const page = await pageById(res.page_id);
		expect(page.enrich_status).toBe("staged");
		expect(page.full_markdown).toContain("What you said");
	});

	it("refuses thin input with an honest zero — no page, no job (the July bug, deterministic)", async () => {
		const userId = `thin-${crypto.randomUUID()}`;
		const ctx = createExecutionContext();
		const res = await stageMcpConversation(env, ctx, userId, {
			messages: [
				{ id: "t1", role: "user", content: "hey", ts: T0 },
				{ id: "t2", role: "assistant", content: "Hello! How can I help?", ts: T0 + 1 },
				{ id: "t3", role: "user", content: "lol nice", ts: T0 + 2 },
				{ id: "t4", role: "user", content: "ok save this conversation", ts: T0 + 3 },
			],
		});
		await waitOnExecutionContext(ctx);
		expect(res.processing).toBe(false);
		expect(res.fired).toBe(false);
		expect(res.summary).toContain("Saved: 0");
		const pages = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_pages WHERE user_id = ?").bind(userId).first();
		expect(pages.n).toBe(0);
		expect(await jobFor(userId)).toBeNull();
	});

	it("answers a duplicate re-send with the existing page instead of staging twice", async () => {
		const userId = `dup-${crypto.randomUUID()}`;
		const first = await stage(userId);
		await drainUntilSettled(userId);
		const receiptsBefore = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ?",
		).bind(userId).first();
		const again = await stage(userId);
		expect(again.duplicate).toBe(true);
		expect(again.page_id).toBe(first.page_id);
		expect(again.processing).toBe(false);
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND type = 'mcp_enrich'",
		).bind(userId).first();
		expect(jobs.n).toBe(1);
		const receiptsAfter = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ?",
		).bind(userId).first();
		expect(receiptsAfter.n).toBe(receiptsBefore.n);
	});

	it("serializes concurrent exact MCP retries before page and receipt writes", async () => {
		const userId = `mcp-concurrent-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-concurrent-key-${crypto.randomUUID()}`;
		const [left, right] = await Promise.all([
			stage(userId, {}, conv(), { idempotencyKey }),
			stage(userId, {}, conv(), { idempotencyKey }),
		]);
		expect([left.fired, right.fired].filter(Boolean)).toHaveLength(1);
		expect([left.duplicate, right.duplicate].filter(Boolean)).toHaveLength(1);
		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ? AND idempotency_key = ?) AS sources,
				(SELECT COUNT(*) FROM memory_jobs WHERE user_id = ? AND idempotency_key = ?) AS jobs,
				(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?) AS pages,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts`,
		).bind(userId, idempotencyKey, userId, idempotencyKey, userId, userId).first();
		expect(counts).toMatchObject({ sources: 1, jobs: 1, pages: 1, receipts: 1 });
	});
});

describe("crash-safe MCP handoff", () => {
	it("repairs an interruption after the D1 job claim and converges to one durable handoff", async () => {
		const userId = `mcp-claim-crash-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-claim-crash-key-${crypto.randomUUID()}`;
		await expect(stage(userId, { _testMcpFault: "after_job_claim" }, conv(), { idempotencyKey }))
			.rejects.toThrow("injected MCP interruption (after_job_claim)");
		expect(await mcpArtifactCounts(userId, idempotencyKey)).toMatchObject({
			sources: 1,
			jobs: 1,
			pages: 0,
			receipts: 0,
			staged: 0,
		});
		expect(await mcpDurableState(userId)).toMatchObject({ queueCount: 0, markerCount: 0 });

		const retry = await stage(userId, {}, conv(), { idempotencyKey });
		expect(retry).toMatchObject({ duplicate: true, processing: true, job_status: "staged" });
		expect(await mcpArtifactCounts(userId, idempotencyKey)).toMatchObject({
			sources: 1,
			jobs: 1,
			pages: 1,
			receipts: 1,
			staged: 2,
		});
		const accepted = await mcpDurableState(userId);
		expect(accepted).toMatchObject({ queueCount: 1, markerCount: 1 });
		expect(accepted.queueJobIds).toEqual([retry.job_id]);
		expect(accepted.markers[0]).toMatchObject({
			jobId: retry.job_id,
			state: "queued",
			contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});

		await drainUntilSettled(userId, 30, { reset: false });
		expect((await jobFor(userId)).status).toBe("enriched");
		const terminal = await mcpDurableState(userId);
		expect(terminal).toMatchObject({ queueCount: 0, markerCount: 0 });
		await env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId)).resetAll();
	});

	it("repairs a lost response after the atomic local enqueue without duplicating anything", async () => {
		const userId = `mcp-enqueue-crash-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-enqueue-crash-key-${crypto.randomUUID()}`;
		await expect(stage(userId, { _testMcpFault: "after_local_enqueue" }, conv(), { idempotencyKey }))
			.rejects.toThrow("injected MCP interruption (after_local_enqueue)");
		expect(await mcpArtifactCounts(userId, idempotencyKey)).toMatchObject({
			sources: 1,
			jobs: 1,
			pages: 1,
			receipts: 1,
			staged: 2,
		});
		const beforeRetry = await mcpDurableState(userId);
		expect(beforeRetry).toMatchObject({ queueCount: 1, markerCount: 1 });

		const retry = await stage(userId, {}, conv(), { idempotencyKey });
		expect(retry).toMatchObject({ duplicate: true, processing: true, job_status: "staged" });
		expect(await mcpArtifactCounts(userId, idempotencyKey)).toMatchObject({
			sources: 1,
			jobs: 1,
			pages: 1,
			receipts: 1,
			staged: 2,
		});
		const afterRetry = await mcpDurableState(userId);
		expect(afterRetry).toMatchObject({ queueCount: 1, markerCount: 1 });
		expect(afterRetry.queueJobIds).toEqual([retry.job_id]);
		expect(afterRetry.markers[0].queueKey).toBe(beforeRetry.markers[0].queueKey);

		await drainUntilSettled(userId, 30, { reset: false });
		expect((await jobFor(userId)).status).toBe("enriched");
		const terminal = await mcpDurableState(userId);
		expect(terminal).toMatchObject({ queueCount: 0, markerCount: 0 });
		await env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId)).resetAll();
	});
});

describe("account-wide idempotency ownership", () => {
	it("rejects ingest-to-MCP key reuse without mutating the ingest packet, job, or receipt", async () => {
		const userId = `ingest-to-mcp-${crypto.randomUUID()}`;
		const idempotencyKey = `cross-lane-${crypto.randomUUID()}`;
		const conversationId = `same-payload-${crypto.randomUUID()}`;
		const messages = conv();
		const ingest = await ingestHttp(userId, idempotencyKey, messages, {
			conversationId,
			_test: {
				llmResponse: CANNED_EXTRACTION,
				edgeResponse: CANNED_EDGES,
				reflexionResponse: CANNED_REFLEXION,
			},
		});
		expect(ingest.status).toBe(200);
		const before = await idempotencySnapshot(userId, idempotencyKey);

		const conflict = await stage(userId, {}, messages, { idempotencyKey, conversationId });
		expect(conflict).toMatchObject({
			ok: false,
			idempotencyConflict: true,
			error: "idempotency_conflict",
			http_status: 409,
			source_packet_id: before.source.id,
		});
		expect(await idempotencySnapshot(userId, idempotencyKey)).toEqual(before);
	});

	it("rejects MCP-to-ingest key reuse without mutating the MCP packet, job, or receipt", async () => {
		const userId = `mcp-to-ingest-${crypto.randomUUID()}`;
		const idempotencyKey = `cross-lane-${crypto.randomUUID()}`;
		const conversationId = `same-payload-${crypto.randomUUID()}`;
		const messages = conv();
		const mcp = await stage(userId, {}, messages, { idempotencyKey, conversationId });
		expect(mcp).toMatchObject({ fired: true, processing: true });
		const before = await idempotencySnapshot(userId, idempotencyKey);

		const conflict = await ingestHttp(userId, idempotencyKey, messages, { conversationId });
		expect(conflict.status).toBe(409);
		expect(conflict.body).toMatchObject({
			error: "idempotency_conflict",
			code: "idempotency_conflict",
			source_packet_id: before.source.id,
		});
		expect(await idempotencySnapshot(userId, idempotencyKey)).toEqual(before);
	});

	it("treats different MCP content under the same key as a no-write conflict", async () => {
		const userId = `mcp-content-conflict-${crypto.randomUUID()}`;
		const idempotencyKey = `mcp-content-key-${crypto.randomUUID()}`;
		await stage(userId, {}, conv(), { idempotencyKey });
		const before = await idempotencySnapshot(userId, idempotencyKey);
		const conflict = await stage(userId, {}, [
			{ id: "changed", role: "user", content: "I moved to a different city." },
		], { idempotencyKey });
		expect(conflict).toMatchObject({
			ok: false,
			idempotencyConflict: true,
			error: "idempotency_conflict",
			http_status: 409,
		});
		expect(await idempotencySnapshot(userId, idempotencyKey)).toEqual(before);
	});
});

describe("atomic active-job capacity", () => {
	it("admits only one of two concurrent claims for the final slot and still returns existing keys", async () => {
		const userId = `job-cap-${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`WITH RECURSIVE seq(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
			)
			INSERT INTO memory_jobs
				(id, user_id, type, status, idempotency_key, attempts, payload_json,
				 run_after, created_at, updated_at)
			SELECT 'job_cap_' || ? || '_' || n, ?, 'extract', 'queued',
				'cap_key_' || ? || '_' || n, 0, '{}', ?, ?, ? FROM seq`,
		).bind(MEMORY_JOB_ACTIVE_LIMIT - 1, userId, userId, userId, now, now, now).run();

		const [left, right] = await Promise.all([
			claimMemoryJob(env, userId, { idempotencyKey: `final-left-${userId}` }),
			claimMemoryJob(env, userId, { idempotencyKey: `final-right-${userId}` }),
		]);
		expect([left, right].filter((result) => result.claimed)).toHaveLength(1);
		const rejected = [left, right].find((result) => result.capacityExceeded);
		expect(rejected).toMatchObject({
			claimed: false,
			capacityExceeded: true,
			activeLimit: MEMORY_JOB_ACTIVE_LIMIT,
		});
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status IN ('queued', 'staged', 'processing')",
		).bind(userId).first();
		expect(count.n).toBe(MEMORY_JOB_ACTIVE_LIMIT);

		const winner = [left, right].find((result) => result.claimed);
		const winnerKey = winner === left ? `final-left-${userId}` : `final-right-${userId}`;
		const replay = await claimMemoryJob(env, userId, { idempotencyKey: winnerKey });
		expect(replay).toMatchObject({ claimed: false, id: winner.id });
		expect(replay.capacityExceeded).toBeUndefined();
	});
});

describe("background enrichment (the same engine as every other door)", () => {
	it("writes the v2 graph — typed edges included — and marks the page enriched", async () => {
		const userId = `enrich-${crypto.randomUUID()}`;
		const res = await stage(userId);
		await drainUntilSettled(userId);

		const nodes = await env.DB.prepare("SELECT label, category FROM nodes WHERE user_id = ?").bind(userId).all();
		const labels = nodes.results.map((n) => n.label).sort();
		expect(labels).toEqual(["Halcyon Robotics", "Nadia", "Tomas"]);
		const edges = await env.DB.prepare("SELECT type, fact FROM edges WHERE user_id = ?").bind(userId).all();
		expect(edges.results.map((e) => e.type)).toContain("MARRIED_TO");
		expect(edges.results[0].fact).toContain("married");

		const page = await pageById(res.page_id);
		expect(page.enrich_status).toBe("enriched");
		expect(page.title).toBe("New Job At Halcyon Robotics");
		expect(page.full_markdown).toContain("Relationships");
		const job = await jobFor(userId);
		expect(job.status).toBe("enriched");
		expect(JSON.parse(job.payload_json).edges).toBe(1);
	});

	it("a deliberately failed enrichment is VISIBLE: failed job, failed page, admin report", async () => {
		const userId = `fail-${crypto.randomUUID()}`;
		// Unparseable extraction on every attempt → llm_failed → bounded
		// retries → failed. Never a silent success.
		const res = await stage(userId, { llmResponse: "%% not json at all %%" });
		await drainUntilSettled(userId);

		const job = await jobFor(userId);
		expect(job.status).toBe("failed");
		expect(job.error).toContain("llm_failed");
		const page = await pageById(res.page_id);
		expect(page.enrich_status).toBe("failed");
		expect(page.deleted_at).toBeNull();
		const report = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM error_reports WHERE user_id = ? AND scope = 'mcp_enrich'",
		).bind(userId).first();
		expect(report.n).toBeGreaterThan(0);
		// The user-visible receipt says it could not finish — it never claims success.
		const receipts = await env.DB.prepare(
			"SELECT summary FROM receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		expect(receipts.summary).toContain("could not finish");
	});

	it("cleans up the provisional page when nothing durable survives extraction", async () => {
		const userId = `empty-${crypto.randomUUID()}`;
		// The message passes the deterministic door gate, but the engine (and
		// its gates) find nothing worth keeping.
		const res = await stage(userId, {
			llmResponse: { objects: [], notes: "" },
			edgeResponse: { edges: [] },
		}, [
			{ id: "z1", role: "user", content: "I was thinking about maybe possibly considering things generally.", ts: T0 },
		]);
		expect(res.processing).toBe(true);
		await drainUntilSettled(userId);
		const page = await pageById(res.page_id);
		expect(page.deleted_at).not.toBeNull();
		const job = await jobFor(userId);
		expect(job.status).toBe("enriched");
		expect(JSON.parse(job.payload_json).page_deleted).toBe(true);
	});
});

describe("trust attribution", () => {
	it("assistant wording never reaches extraction as memory — context only", async () => {
		const userId = `trust-${crypto.randomUUID()}`;
		let sawNewSlice = null;
		let sawAssistantContext = null;
		const job = {
			jobId: `job_${crypto.randomUUID()}`,
			pageId: null,
			userMessages: conv().filter((m) => m.role === "user"),
			contextMessages: conv().filter((m) => m.role === "assistant"),
			sourceMeta: {},
			lastTs: T0,
			testOverrides: {
				llmResponse: ({ packet }) => {
					sawNewSlice = JSON.stringify(packet.new_slice);
					sawAssistantContext = JSON.stringify(packet.assistant_context);
					return CANNED_EXTRACTION;
				},
				edgeResponse: CANNED_EDGES,
				reflexionResponse: CANNED_REFLEXION,
				titleResponse: { title: "New Job At Halcyon Robotics" },
			},
		};
		await enrichMcpConversation(env, userId, job);
		// The only source of new memory contains no assistant text…
		expect(sawNewSlice).not.toContain("decaf");
		// …while the assistant turn is still available as labeled context.
		expect(sawAssistantContext).toContain("decaf");
	});

	it("rejects a fact whose words are not grounded in what was sent (fabrication guard)", async () => {
		const userId = `ground-${crypto.randomUUID()}`;
		const res = await stage(userId, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
					{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", confidence: 0.9 },
					// Whole-cloth: nothing in the conversation mentions any of this.
					{ kind: "slice", on: "Halcyon Robotics", text: "Prefers decaf oat-milk cappuccinos every morning", confidence: 0.9 },
				],
			},
			edgeResponse: { edges: [] },
		});
		await drainUntilSettled(userId);
		const slices = await env.DB.prepare("SELECT text FROM slices WHERE user_id = ?").bind(userId).all();
		const texts = slices.results.map((s) => s.text).join("\n");
		expect(texts).toContain("firmware engineer");
		expect(texts).not.toContain("decaf");
		void res;
	});

	it("keeps assistant lines on the page only in capture mode, under a derived heading", async () => {
		const userId = `capture-${crypto.randomUUID()}`;
		const messages = [
			...conv(),
			{ id: "e4", role: "user", content: "Please save everything from this whole conversation.", ts: T0 + 180_000 },
		];
		const res = await stage(userId, {}, messages);
		await drainUntilSettled(userId);
		const page = await pageById(res.page_id);
		expect(page.full_markdown).toContain("assistant, derived");
		expect(page.full_markdown).toContain("decaf");
		// The derived line exists on the page — but never in the graph.
		const slices = await env.DB.prepare("SELECT text FROM slices WHERE user_id = ?").bind(userId).all();
		for (const slice of slices.results) expect(slice.text).not.toContain("decaf");
	});
});

describe("titles", () => {
	it("never assembles a title from fragments: an ungrounded title pass falls back to entity + date", async () => {
		const config = getConfig(env);
		const title = await reconcileTitle(env, config, {
			entityLabels: ["Halcyon Robotics", "Nadia"],
			factLines: ["Works as a firmware engineer at Halcyon Robotics"],
			fallbackTs: T0,
			// The word-salad family that started this: plausible words, none of
			// them grounded in a saved entity.
			titleResponse: { title: "Report Got Welcome Correction" },
		});
		expect(title).toBe("Halcyon Robotics — Aug 1, 2026");
	});

	it("accepts a grounded, well-formed title from the pass", async () => {
		const config = getConfig(env);
		const title = await reconcileTitle(env, config, {
			entityLabels: ["Halcyon Robotics"],
			factLines: ["Works as a firmware engineer at Halcyon Robotics"],
			fallbackTs: T0,
			titleResponse: { title: "new firmware job at Halcyon" },
		});
		expect(title).toBe("New Firmware Job At Halcyon");
	});

	it("provisional titles rank multi-word proper entities over sentence-start words", () => {
		expect(topEntityFromLines(["Great news everyone. I signed with Meridian Labs yesterday."])).toBe("Meridian Labs");
		expect(provisionalTitle(["hello there"], T0)).toBe("Conversation — Aug 1, 2026");
	});

	it("filters bare save instructions out of the durable count", () => {
		const durable = durableUserMessages([
			{ role: "user", content: "save this conversation to itsuki" },
			{ role: "user", content: "I adopted a dog named Biscuit." },
		]);
		expect(durable).toHaveLength(1);
		expect(durable[0].content).toContain("Biscuit");
	});

	it("chatter decoration cannot smuggle control input past the door (live-found inputs)", () => {
		// Both slipped the first deployed gate on production — pinned here.
		const durable = durableUserMessages([
			{ role: "user", content: "hey" },
			{ role: "user", content: "sure lol" },
			{ role: "user", content: "haha cool. ok save this conversation" },
		]);
		expect(durable).toHaveLength(0);
	});
});

describe("save_memory light path", () => {
	it("skips the edge and reflexion passes for a single atomic fact", async () => {
		const userId = `light-${crypto.randomUUID()}`;
		let edgeCalled = false;
		let reflexionCalled = false;
		const ctx = createExecutionContext();
		const res = await runDirectSaveCommand(env, ctx, userId, {
			content: "I switched from coffee to tea.",
			overrides: {
				profile: "mcp",
				lightPath: true,
				llmResponse: {
					objects: [
						{ kind: "node", label: "Tea", category: "preference", confidence: 0.9 },
						{ kind: "slice", on: "Tea", text: "Switched from coffee to tea", confidence: 0.9 },
					],
				},
				edgeResponse: () => { edgeCalled = true; return { edges: [] }; },
				reflexionResponse: () => { reflexionCalled = true; return { entities: [], facts: [], edges: [] }; },
			},
		});
		await waitOnExecutionContext(ctx);
		expect(res.receipt?.outcome).toBe("wrote");
		expect(edgeCalled).toBe(false);
		expect(reflexionCalled).toBe(false);
	});

	it("still earns the passes with two co-mentioned entities", async () => {
		const userId = `heavy-${crypto.randomUUID()}`;
		let edgeCalled = false;
		const ctx = createExecutionContext();
		const res = await runDirectSaveCommand(env, ctx, userId, {
			content: "My brother Karim works at Vantage Bank.",
			overrides: {
				profile: "mcp",
				lightPath: true,
				llmResponse: {
					objects: [
						{ kind: "node", label: "Karim", category: "family", confidence: 0.9 },
						{ kind: "node", label: "Vantage Bank", category: "organization", confidence: 0.9 },
						{ kind: "slice", on: "Karim", text: "Karim works at Vantage Bank", confidence: 0.9 },
					],
				},
				edgeResponse: () => {
					edgeCalled = true;
					return { edges: [{ source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT", fact: "Karim works at Vantage Bank" }] };
				},
				reflexionResponse: { entities: [], facts: [], edges: [] },
			},
		});
		await waitOnExecutionContext(ctx);
		expect(res.receipt?.outcome).toBe("wrote");
		expect(edgeCalled).toBe(true);
		const edges = await env.DB.prepare("SELECT type FROM edges WHERE user_id = ?").bind(userId).all();
		expect(edges.results.map((e) => e.type)).toContain("WORKS_AT");
	});
});
