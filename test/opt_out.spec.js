import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, body, method = "POST") {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

function msg(id, content) {
	return { id, role: "user", content, ts: Date.now() };
}

async function ingest(userId, content, llmResponse) {
	return call("/v1/ingest", {
		userId,
		flush: true,
		messages: [msg(`${userId}-msg`, content)],
		_test: llmResponse ? { llmResponse } : undefined,
	});
}

async function save(userId, content, llmResponse) {
	return call("/v1/save", {
		userId,
		mode: "memory",
		content,
		_test: llmResponse ? { llmResponse } : undefined,
	});
}

async function collect(userId, content, digestResponse = "Private collect should not be stored.") {
	return call("/v1/save", {
		userId,
		mode: "conversation",
		conversationId: `${userId}-conversation`,
		messages: [msg(`${userId}-collect-msg`, content)],
		_test: { digestResponse },
	});
}

async function table(name, userId) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${name} WHERE user_id = ? ORDER BY created_at ASC`)
		.bind(userId)
		.all();
	return results ?? [];
}

async function receipts(userId) {
	const { results } = await env.DB.prepare("SELECT * FROM receipts WHERE user_id = ? ORDER BY created_at DESC")
		.bind(userId)
		.all();
	return results ?? [];
}

async function pendingCandidates(userId) {
	const { body } = await call(`/v1/candidates?userId=${encodeURIComponent(userId)}`, null, "GET");
	return body.candidates ?? [];
}

const griefMemory = {
	objects: [
		{ kind: "node", label: "Grandmother", category: "family", confidence: 0.95 },
		{ kind: "event", on: "Grandmother", action: "passed_away", text: "Grandmother passed away on July 7", importance: "life_significant", confidence: 0.95 },
	],
	notes: "",
};

const preferenceMemory = {
	objects: [
		{ kind: "node", label: "Response Preferences", category: "preference", confidence: 0.95 },
		{ kind: "slice", on: "Response Preferences", text: "User prefers short direct answers", kind_detail: "preference", confidence: 0.95 },
	],
	notes: "",
};

function expectOptOutReceipt(receipt) {
	expect(receipt).toMatchObject({ outcome: "no_write", reason: "user_opt_out", durable: false });
	expect(receipt.savedTotal).toBe(0);
	expect(receipt.saved).toMatchObject({ nodes: 0, events: 0, edges: 0, candidates: 0 });
}

describe("memory opt-out / do-not-remember", () => {
	it("/v1/ingest with do-not-remember grief creates no_write receipt and no graph node", async () => {
		const userId = "opt-ingest-grief";
		const res = await ingest(userId, "Do not remember this: my grandmother passed away on July 7.", griefMemory);
		expect(res.status).toBe(200);
		expect(res.body.fired).toBe(false);
		expectOptOutReceipt(res.body.receipt);
		expect(res.body.source_packet_id).toBeNull();
		expect(await table("nodes", userId)).toHaveLength(0);
		expect(await table("events", userId)).toHaveLength(0);
		expect(await table("source_packets", userId)).toHaveLength(0);
		expect(await table("memory_jobs", userId)).toHaveLength(0);
		expect(await table("memory_profiles", userId)).toHaveLength(0);
		expect((await receipts(userId))[0].outcome).toBe("no_write");
	});

	it("/v1/save with do-not-remember grief creates no_write receipt and no graph node", async () => {
		const userId = "opt-save-grief";
		const res = await save(userId, "Don't save this: my grandmother passed away on July 7.", griefMemory);
		expect(res.status).toBe(200);
		expect(res.body.fired).toBe(false);
		expectOptOutReceipt(res.body.receipt);
		expect(await table("nodes", userId)).toHaveLength(0);
		expect(await table("events", userId)).toHaveLength(0);
		expect(await table("source_packets", userId)).toHaveLength(0);
		expect(await table("memory_jobs", userId)).toHaveLength(0);
	});

	it("/v1/save conversation with do-not-remember creates no_write receipt and no page", async () => {
		const userId = "opt-collect-private";
		const res = await collect(userId, "Do not remember this chat: my private project launch date is August 3.");
		expect(res.status).toBe(200);
		expect(res.body.fired).toBe(false);
		expect(res.body.receipt).toMatchObject({ source: "save_conversation", source_mode: "manual_collect" });
		expectOptOutReceipt(res.body.receipt);
		expect(await table("memory_pages", userId)).toHaveLength(0);
		expect(await table("source_packets", userId)).toHaveLength(0);
		expect(await table("memory_jobs", userId)).toHaveLength(0);
	});

	it("opt-out text does not create a candidate", async () => {
		const userId = "opt-no-candidate";
		await ingest(userId, "This is private, do not remember: my friend Ahmed moved to Dubai.", {
			objects: [{ kind: "candidate", label: "Ahmed moved to Dubai", strength: "weak", confidence: 0.4 }],
			notes: "",
		});
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect(await table("nodes", userId)).toHaveLength(0);
	});

	it("opt-out text does not reinforce an existing event", async () => {
		const userId = "opt-no-reinforce";
		await save(userId, "Remember: my grandmother passed away on July 7.", griefMemory);
		let events = await table("events", userId);
		expect(events).toHaveLength(1);
		expect(events[0].reinforcement_count ?? 0).toBe(0);

		const res = await save(userId, "Do not remember this: my grandmother passed away on July 7.", griefMemory);
		expectOptOutReceipt(res.body.receipt);
		events = await table("events", userId);
		expect(events).toHaveLength(1);
		expect(events[0].reinforcement_count ?? 0).toBe(0);
	});

	it("normal Remember grief message still creates a durable event", async () => {
		const userId = "opt-normal-remember";
		const res = await save(userId, "Remember: my grandmother passed away on July 7.", griefMemory);
		expect(res.body.fired).toBe(true);
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ label: "Grandmother", category: "family" });
		expect((await table("events", userId))[0]).toMatchObject({ action: "passed_away", importance: "life_significant" });
	});

	it("normal preference still creates durable memory", async () => {
		const userId = "opt-normal-pref";
		const res = await save(userId, "I prefer short direct answers.", preferenceMemory);
		expect(res.body.fired).toBe(true);
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ category: "preference" });
		expect((await table("slices", userId))[0]).toMatchObject({ kind: "preference" });
	});

	it("junk still writes no memory", async () => {
		const userId = "opt-junk";
		const res = await ingest(userId, "ok thanks");
		expect(res.body.fired).toBe(false);
		expect(await table("nodes", userId)).toHaveLength(0);
		expect(await table("events", userId)).toHaveLength(0);
		expect(await pendingCandidates(userId)).toHaveLength(0);
	});

	it("duplicate existing memory still dedupes safely", async () => {
		const userId = "opt-duplicate";
		await save(userId, "Remember: my grandmother passed away on July 7.", griefMemory);
		await save(userId, "Remember: my grandmother passed away on July 7.", griefMemory);
		expect(await table("nodes", userId)).toHaveLength(1);
		expect(await table("events", userId)).toHaveLength(1);
		expect(await pendingCandidates(userId)).toHaveLength(0);
	});
});
