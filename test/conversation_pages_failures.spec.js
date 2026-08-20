/**
 * Conversation Pages — failure and authorship semantics (Campaign A).
 *
 * What a processing failure must NEVER do on the explicit conversation doors:
 *   - a failed CREATE leaves an honestly-failed staged page and a failed
 *     page-follower job on the REST lane — never a phantom success;
 *   - a failed ADVANCE restores the page's prior enriched content untouched —
 *     the batch failed, the page's history did not — and a receipt says so;
 *   - a user's own wording is never reverted by a later advance: the advance
 *     keeps their text and records page_text_kept_user_authored;
 *   - an exact replay of an advance batch changes nothing (duplicate answer,
 *     same links, same revision, same markdown);
 *   - explicit batches with NO conversation id stay one-page-per-batch with
 *     conversation_key NULL, and an exact replay creates nothing new.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import { applyMemoryChange } from "../src/lib/memory_versions.js";
import worker from "../src/index.js";

const T0 = Date.parse("2026-08-02T09:00:00Z");

const CANNED = {
	llmResponse: {
		objects: [
			{ kind: "node", label: "Halcyon Robotics", category: "organization", confidence: 0.9 },
			{ kind: "slice", on: "Halcyon Robotics", text: "Works as a firmware engineer at Halcyon Robotics", kind_detail: "other", confidence: 0.9 },
		],
		notes: "",
	},
	edgeResponse: { edges: [] },
	reflexionResponse: { entities: [], facts: [], edges: [] },
	titleResponse: { title: "Job At Halcyon Robotics" },
};

const CANNED_GROWN = {
	...CANNED,
	llmResponse: {
		objects: [
			{ kind: "node", label: "Porto", category: "place", confidence: 0.9 },
			{ kind: "slice", on: "Porto", text: "Sister Nadia moved to Porto", kind_detail: "other", confidence: 0.9 },
		],
		notes: "",
	},
};

function batchOne() {
	return [
		{ id: "c1", role: "user", content: "I started a new job at Halcyon Robotics as a firmware engineer.", ts: T0 },
		{ id: "c2", role: "assistant", content: "Congratulations on the new role!", ts: T0 + 60_000 },
	];
}

function batchGrown() {
	return [
		...batchOne(),
		{ id: "c3", role: "user", content: "My sister Nadia moved to Porto last month.", ts: T0 + 120_000 },
	];
}

async function stage(userId, messages, input = {}, overrides = {}) {
	const ctx = createExecutionContext();
	const res = await stageMcpConversation(env, ctx, userId, {
		...input,
		messages,
		testOverrides: { ...CANNED, ...overrides },
	});
	await waitOnExecutionContext(ctx);
	return res;
}

async function drainUntilSettled(userId, maxRounds = 30, { reset = true } = {}) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) {
			if (reset) await stub.resetAll();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("conversation jobs did not settle");
}

async function livePages(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

async function pageSources(userId, pageId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM conversation_page_sources WHERE user_id = ? AND page_id = ? ORDER BY seq",
	).bind(userId, pageId).all();
	return results ?? [];
}

async function jobById(userId, jobId) {
	return env.DB.prepare(
		"SELECT * FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(jobId, userId).first();
}

async function saveHttp(userId, body) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request("http://example.com/v1/save", {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
		body: JSON.stringify({ userId, ...body }),
	}), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

describe("failed extraction on the REST door (create case)", () => {
	it("fails the staged page and the page-follower job honestly — never a phantom success", async () => {
		const userId = `rest-fail-${crypto.randomUUID()}`;
		// Unparseable extraction on every attempt → llm_failed → the ingest
		// lane's bounded retries → the extract job dead-letters as failed.
		const res = await saveHttp(userId, {
			mode: "conversation",
			conversationId: "rest-fail-1",
			messages: batchOne(),
			_test: { llmResponse: "%% not json at all %%" },
		});
		expect(res.status).toBe(200);
		// The door staged the page half truthfully before any verdict existed.
		expect(res.body.conversation_page).toMatchObject({ status: "staged", advance: false });
		const pageId = res.body.conversation_page.id;
		const packetId = res.body.source_packet_id;
		expect(packetId).toMatch(/^src_/);
		await drainUntilSettled(userId);

		// The batch's extract job is terminally failed.
		const extract = await env.DB.prepare(
			"SELECT id, status FROM memory_jobs WHERE user_id = ? AND source_packet_id = ? AND type != 'mcp_enrich' LIMIT 1",
		).bind(userId, packetId).first();
		expect(extract.status).toBe("failed");

		// The page-follower job carries the failure — still identifiable as the
		// follower (lane page_follow), pointing at the page it could not finish.
		const follower = await env.DB.prepare(
			"SELECT * FROM memory_jobs WHERE user_id = ? AND type = 'mcp_enrich' AND idempotency_key = ? LIMIT 1",
		).bind(userId, `pagefollow:v1:${packetId}`).first();
		expect(follower.status).toBe("failed");
		expect(follower.error).toContain("extraction ended failed");
		const followerPayload = JSON.parse(follower.payload_json);
		expect(followerPayload.lane).toBe("page_follow");
		expect(followerPayload.pageId).toBe(pageId);

		// The staged page ends failed — visible, not deleted, never "enriched".
		const page = await env.DB.prepare("SELECT * FROM memory_pages WHERE id = ?").bind(pageId).first();
		expect(page.enrich_status).toBe("failed");
		expect(page.deleted_at).toBeNull();
		expect(page.conversation_key).toBe("rest-fail-1");

		// A user-visible receipt records the failure, and it auto-reported.
		const receipt = await env.DB.prepare(
			"SELECT summary FROM receipts WHERE user_id = ? AND id = ? LIMIT 1",
		).bind(userId, `receipt_mcp_failed_${follower.id}`).first();
		expect(receipt.summary).toContain("could not finish");
		const reports = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM error_reports WHERE user_id = ? AND scope = 'mcp_enrich'",
		).bind(userId).first();
		expect(Number(reports.n)).toBeGreaterThan(0);
	});
});

describe("failed extraction during an advance (MCP door)", () => {
	it("restores the page's prior enriched content; the advance job and receipt say failed", async () => {
		const userId = `adv-fail-${crypto.randomUUID()}`;
		const first = await stage(userId, batchOne(), { conversationId: "conv-fail-adv" });
		expect(first.page_id).toMatch(/^page_/);
		await drainUntilSettled(userId, 30, { reset: false });
		const [before] = await livePages(userId);
		expect(before.enrich_status).toBe("enriched");

		const second = await stage(
			userId,
			batchGrown(),
			{ conversationId: "conv-fail-adv" },
			{ llmResponse: "%% not json at all %%" },
		);
		expect(second.processing).toBe(true);
		expect(second.page_id).toBe(first.page_id);
		await drainUntilSettled(userId);

		// Same page, prior enriched content byte-for-byte, never left failed.
		const [after] = await livePages(userId);
		expect(after.id).toBe(before.id);
		expect(after.enrich_status).toBe("enriched");
		expect(after.full_markdown).toBe(before.full_markdown);
		expect(after.title).toBe(before.title);

		// The advance's job is the thing that failed — visibly.
		const job = await jobById(userId, second.job_id);
		expect(job.status).toBe("failed");
		expect(job.error).toContain("llm_failed");

		// And the receipt records exactly that contract.
		const receipt = await env.DB.prepare(
			"SELECT summary FROM receipts WHERE user_id = ? AND id = ? LIMIT 1",
		).bind(userId, `receipt_mcp_failed_${second.job_id}`).first();
		expect(receipt.summary).toContain("could not finish");
		expect(receipt.summary).toContain("keeps its last enriched content");
	});
});

describe("user authorship outranks the advance", () => {
	it("never reverts the user's own wording; the advance records it kept their text", async () => {
		const userId = `authored-${crypto.randomUUID()}`;
		await stage(userId, batchOne(), { conversationId: "conv-authored" });
		await drainUntilSettled(userId, 30, { reset: false });
		const [page] = await livePages(userId);
		expect(page.enrich_status).toBe("enriched");

		// The user rewrites the page in their own words through the safe-update
		// system — a forward revision whose snapshot pins the text as theirs.
		const MY_TEXT = "MY OWN WORDS about Halcyon";
		const ctx = createExecutionContext();
		const edit = await applyMemoryChange(env, ctx, {
			userId,
			actorClass: "user",
			actorRef: userId,
			id: page.id,
			mode: "update",
			patch: { full_markdown: MY_TEXT },
			expectedRevision: Number(page.revision ?? 1),
			idempotencyKey: `user-edit-${crypto.randomUUID()}`,
		});
		await waitOnExecutionContext(ctx);
		expect(edit.ok).toBe(true);

		const second = await stage(userId, batchGrown(), { conversationId: "conv-authored" }, CANNED_GROWN);
		expect(second.page_id).toBe(page.id);
		await drainUntilSettled(userId);

		// The page keeps EXACTLY the user's text, back at enriched.
		const [after] = await livePages(userId);
		expect(after.id).toBe(page.id);
		expect(after.full_markdown).toBe(MY_TEXT);
		expect(after.enrich_status).toBe("enriched");

		// The batch's memories still landed in the graph — nothing was dropped.
		const nodes = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(nodes.results.map((n) => n.label)).toContain("Porto");

		// The advance succeeded and says truthfully that it kept the user's text.
		const job = await jobById(userId, second.job_id);
		expect(job.status).toBe("enriched");
		expect(JSON.parse(job.payload_json).page_text_kept_user_authored).toBe(true);

		// Both accepted batches remain linked as this page's sources.
		expect(await pageSources(userId, page.id)).toHaveLength(2);
	});
});

describe("exact replay of an advance batch", () => {
	it("answers duplicate and changes nothing: links, revision, and markdown all hold", async () => {
		const userId = `replay-adv-${crypto.randomUUID()}`;
		await stage(userId, batchOne(), { conversationId: "conv-replay" });
		await drainUntilSettled(userId, 30, { reset: false });
		const advance = await stage(userId, batchGrown(), { conversationId: "conv-replay" }, CANNED_GROWN);
		expect(advance.processing).toBe(true);
		await drainUntilSettled(userId, 30, { reset: false });

		const [before] = await livePages(userId);
		expect(before.enrich_status).toBe("enriched");
		expect(await pageSources(userId, before.id)).toHaveLength(2);

		const replay = await stage(userId, batchGrown(), { conversationId: "conv-replay" }, CANNED_GROWN);
		expect(replay.duplicate).toBe(true);
		expect(replay.processing).toBe(false);
		expect(replay.page_id).toBe(before.id);
		await drainUntilSettled(userId);

		const [after] = await livePages(userId);
		expect(after.id).toBe(before.id);
		expect(Number(after.revision)).toBe(Number(before.revision));
		expect(after.full_markdown).toBe(before.full_markdown);
		expect(await pageSources(userId, after.id)).toHaveLength(2);
		const jobs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND type = 'mcp_enrich'",
		).bind(userId).first();
		expect(Number(jobs.n)).toBe(2);
	});
});

describe("explicit batches without any conversation id", () => {
	it("stays one page per batch with conversation_key NULL; exact replay creates nothing", async () => {
		const userId = `nokey-${crypto.randomUUID()}`;
		const first = await stage(userId, batchOne(), {});
		expect(first.page_id).toMatch(/^page_/);
		await drainUntilSettled(userId, 30, { reset: false });
		const second = await stage(
			userId,
			[{ id: "p1", role: "user", content: "My sister Nadia moved to Porto last month.", ts: T0 + 120_000 }],
			{},
			CANNED_GROWN,
		);
		expect(second.page_id).toMatch(/^page_/);
		expect(second.page_id).not.toBe(first.page_id);
		await drainUntilSettled(userId, 30, { reset: false });

		const pages = await livePages(userId);
		expect(pages).toHaveLength(2);
		for (const page of pages) {
			expect(page.conversation_key).toBeNull();
			expect(page.enrich_status).toBe("enriched");
		}

		const replay = await stage(userId, batchOne(), {});
		expect(replay.duplicate).toBe(true);
		expect(replay.page_id).toBe(first.page_id);
		await drainUntilSettled(userId);

		const afterPages = await livePages(userId);
		expect(afterPages).toHaveLength(2);
		for (const page of afterPages) {
			expect(await pageSources(userId, page.id)).toHaveLength(1);
		}
	});
});
