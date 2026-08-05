/**
 * Stage 4 paid-inference recovery regressions.
 *
 * These tests use deterministic model callbacks only. They pin the two crash
 * boundaries where a storage-level queue lease is not enough to guarantee that
 * a paid extraction is attempted once:
 *   1. graph commit succeeds, but the DO has not persisted settlement state;
 *   2. the outer drain lease expires while inference is still in flight.
 */

import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { enrichMcpConversation, stageMcpConversation } from "../src/pipeline/mcp_engine.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const emptyEdges = { edges: [] };
const emptyReflexion = { entities: [], facts: [], edges: [] };

const message = (id, content) => ({ id, role: "user", content, ts: Date.now() });

function proposal(label) {
	return {
		objects: [
			{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.98 },
			{ kind: "slice", on: label, text: `${label} uses a crash-safe extraction ledger`, kind_detail: "detail", confidence: 0.96 },
		],
		notes: "deterministic test proposal",
	};
}

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

async function holdLease(stub) {
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put("lease", { until: Date.now() + 60_000, token: "test-hold" });
	});
}

async function releaseLease(stub) {
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.delete("lease");
	});
}

async function enqueueOnly(userId, id, label) {
	const stub = stubFor(userId);
	await holdLease(stub);
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify({
			userId,
			messages: [message(id, `I am building ${label} with durable crash recovery`)],
			flush: true,
			idempotencyKey: `paid-recovery:${userId}:${id}`,
			_test: {
				llmResponse: proposal(label),
				edgeResponse: emptyEdges,
				reflexionResponse: emptyReflexion,
			},
		}),
	}), env, ctx);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ fired: true });
	expect(await queueEntries(stub)).toHaveLength(1);
	await releaseLease(stub);
	return stub;
}

async function queueEntries(stub) {
	return runInDurableObject(stub, async (_instance, state) => (
		[...(await state.storage.list({ prefix: "q:" })).values()]
	));
}

describe("paid extraction recovery", () => {
	it("does not call the model again after the graph committed before DO settlement persistence", async () => {
		const userId = `paid-post-commit-${crypto.randomUUID()}`;
		const label = `PostCommit-${crypto.randomUUID().slice(0, 8)}`;
		const stub = await enqueueOnly(userId, "post-commit-message", label);
		let modelCalls = 0;
		const countedProposal = () => {
			modelCalls += 1;
			return proposal(label);
		};

		// Abort after the graph/run commit and before the DO can persist
		// `phase: settlement_pending`. Function-valued hooks exist only in the
		// local test call and cannot cross the public JSON/RPC boundary.
		await expect(runInDurableObject(stub, async (instance) => instance.drain({
			userId,
			maxJobs: 1,
			ignoreBackoff: true,
			inlineOverrides: {
				llmResponse: countedProposal,
				edgeResponse: emptyEdges,
				reflexionResponse: emptyReflexion,
				_testAfterExtraction: () => { throw new Error("simulated post-graph interruption"); },
			},
		}))).rejects.toThrow(/simulated post-graph interruption/);
		expect(modelCalls).toBe(1);

		const committedRun = await env.DB.prepare(
			"SELECT id, status FROM extraction_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		expect(committedRun?.status).toBe("wrote");
		const committedNodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(Number(committedNodes?.n)).toBe(1);
		expect(await queueEntries(stub)).toHaveLength(1);
		expect((await queueEntries(stub))[0]?.phase).not.toBe("settlement_pending");

		await runInDurableObject(stub, async (instance) => instance.drain({
			userId,
			maxJobs: 1,
			ignoreBackoff: true,
			inlineOverrides: {
				llmResponse: countedProposal,
				edgeResponse: emptyEdges,
				reflexionResponse: emptyReflexion,
			},
		}));

		// Recovery must use the durable committed-run record, not pay for the
		// same inference again merely to rediscover canonical graph rows.
		expect(modelCalls).toBe(1);
		const job = await env.DB.prepare(
			"SELECT status FROM memory_jobs WHERE user_id = ? AND type = 'extract' LIMIT 1",
		).bind(userId).first();
		expect(job?.status).toBe("enriched");
		expect(await queueEntries(stub)).toHaveLength(0);
		await stub.resetAll();
	}, 30_000);

	it("does not start a second model call when another drain acquires an expired outer lease", async () => {
		const userId = `paid-lease-expiry-${crypto.randomUUID()}`;
		const label = `LeaseExpiry-${crypto.randomUUID().slice(0, 8)}`;
		const stub = await enqueueOnly(userId, "lease-expiry-message", label);
		let modelCalls = 0;
		let releaseModel;
		let markStarted;
		const modelReleased = new Promise((resolve) => { releaseModel = resolve; });
		const modelStarted = new Promise((resolve) => { markStarted = resolve; });
		const blockedProposal = async () => {
			modelCalls += 1;
			markStarted();
			await modelReleased;
			return proposal(label);
		};

		await runInDurableObject(stub, async (instance, state) => {
			const options = {
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					llmResponse: blockedProposal,
					edgeResponse: emptyEdges,
					reflexionResponse: emptyReflexion,
				},
			};
			const first = instance.drain(options);
			await modelStarted;

			// Stand in for a model call that outlives LEASE_MS without making this
			// offline test wait two minutes. The original request is still alive.
			const firstLease = await state.storage.get("lease");
			await state.storage.put("lease", { ...firstLease, until: Date.now() - 1 });
			const second = instance.drain(options);

			// Current behavior reaches the same model hook immediately. A fixed
			// implementation returns/defer-requeues the second drain instead.
			await Promise.race([
				second.then(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 50)),
			]);
			releaseModel();
			await Promise.allSettled([first, second]);
		});

		expect(modelCalls).toBe(1);
		await stub.resetAll();
	}, 30_000);

	it("fences concurrent MCP inference and replays the committed page and receipt exactly", async () => {
		const userId = `paid-mcp-fence-${crypto.randomUUID()}`;
		const label = `McpFence-${crypto.randomUUID().slice(0, 8)}`;
		const expectedFact = `${label} uses a crash-safe extraction ledger`;
		const stub = stubFor(userId);
		await holdLease(stub);

		const ctx = createExecutionContext();
		const staged = await stageMcpConversation(env, ctx, userId, {
			conversationId: `conversation-${crypto.randomUUID()}`,
			messages: [message("mcp-fence-message", `I am building ${expectedFact}`)],
			testOverrides: {
				llmResponse: proposal(label),
				edgeResponse: emptyEdges,
				reflexionResponse: emptyReflexion,
				titleResponse: { title: `${label} Crash Safe Ledger` },
			},
		});
		await waitOnExecutionContext(ctx);
		expect(staged.processing).toBe(true);
		const entries = await queueEntries(stub);
		expect(entries).toHaveLength(1);

		let modelCalls = 0;
		let markStarted;
		let releaseModel;
		const modelStarted = new Promise((resolve) => { markStarted = resolve; });
		const modelReleased = new Promise((resolve) => { releaseModel = resolve; });
		const job = {
			...entries[0].job,
			testOverrides: {
				...(entries[0].job.testOverrides ?? {}),
				llmResponse: async () => {
					modelCalls += 1;
					markStarted();
					await modelReleased;
					return proposal(label);
				},
			},
		};

		const first = enrichMcpConversation(env, userId, job);
		await modelStarted;
		let concurrentResult;
		const concurrent = enrichMcpConversation(env, userId, { ...job }).then((result) => {
			concurrentResult = result;
			return result;
		});
		await Promise.race([
			concurrent,
			new Promise((resolve) => setTimeout(resolve, 50)),
		]);
		const callsWhileBlocked = modelCalls;
		releaseModel();
		const [firstResult] = await Promise.all([first, concurrent]);

		expect(callsWhileBlocked).toBe(1);
		expect(modelCalls).toBe(1);
		expect(firstResult).toMatchObject({ done: true });
		expect(concurrentResult).toMatchObject({ retry: true, inProgress: true });

		const committed = await env.DB.prepare(
			`SELECT id, status, receipt_id FROM extraction_runs
			 WHERE user_id = ? AND tool_name = 'save_conversation'
			 ORDER BY created_at DESC LIMIT 1`,
		).bind(userId).first();
		expect(committed?.id).toMatch(/^run_mcp_/);
		expect(committed?.status).toBe("wrote");
		expect(committed?.receipt_id).toBeTruthy();

		const replay = await enrichMcpConversation(env, userId, { ...job });
		expect(replay).toMatchObject({ done: true });
		expect(modelCalls).toBe(1);

		const page = await env.DB.prepare(
			"SELECT full_markdown, receipt_id FROM memory_pages WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(job.pageId, userId).first();
		expect(page?.full_markdown).toContain(expectedFact);
		expect(page?.receipt_id).toBe(committed.receipt_id);
		const receipts = await env.DB.prepare(
			"SELECT id FROM receipts WHERE user_id = ? AND extraction_run_id = ? ORDER BY id",
		).bind(userId, committed.id).all();
		expect(receipts.results?.map((row) => row.id)).toEqual([committed.receipt_id]);

		await stub.resetAll();
	}, 30_000);
});
