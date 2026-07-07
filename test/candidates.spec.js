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
		_test: { llmResponse },
	});
}

async function save(userId, content, llmResponse) {
	return call("/v1/save", {
		userId,
		mode: "memory",
		content,
		_test: { llmResponse },
	});
}

async function table(name, userId) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${name} WHERE user_id = ? ORDER BY created_at ASC`)
		.bind(userId)
		.all();
	return results ?? [];
}

async function pendingCandidates(userId) {
	const { body } = await call(`/v1/candidates?userId=${encodeURIComponent(userId)}`, null, "GET");
	return body.candidates ?? [];
}

const candidateOnly = (label, strength = "weak", confidence = 0.45) => ({
	objects: [{ kind: "candidate", label, strength, confidence }],
	notes: "",
});

describe("candidate doctrine", () => {
	it("grandmother death becomes a durable event, not a candidate", async () => {
		const userId = "cand-grandmother";
		const res = await ingest(
			userId,
			"my grandmother just died im so sad, she died on 7th july, 7.10 pm",
			candidateOnly("Grandmother death", "strong", 0.4),
		);
		expect(res.body.fired).toBe(true);
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ label: "Grandmother", category: "family" });
		expect((await table("events", userId))[0]).toMatchObject({ action: "passed_away", importance: "life_significant" });
	});

	it("explicit Remember uses the durable path", async () => {
		const userId = "cand-remember";
		await ingest(userId, "Remember: my grandmother passed away.", candidateOnly("Grandmother", "strong", 0.4));
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("events", userId))[0]).toMatchObject({ action: "passed_away" });
	});

	it("strong preference is durable preference memory", async () => {
		const userId = "cand-pref";
		await ingest(userId, "I prefer short direct answers.", candidateOnly("Short direct answers", "medium", 0.45));
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ category: "preference" });
		expect((await table("slices", userId))[0]).toMatchObject({ kind: "preference" });
	});

	it("project workflow rule is durable", async () => {
		const userId = "cand-rule";
		await ingest(userId, "For Project Alpha, deploy after tests and dry-run.", candidateOnly("Deploy rule", "medium", 0.45));
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0].label).toContain("Project Alpha");
		expect((await table("slices", userId))[0]).toMatchObject({ kind: "decision" });
	});

	it("skill action is durable skill node plus event", async () => {
		const userId = "cand-skill";
		await ingest(userId, "I started learning Flutter.", candidateOnly("Flutter", "medium", 0.45));
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ label: "Flutter", category: "skill" });
		expect((await table("events", userId))[0]).toMatchObject({ action: "started" });
	});

	it("weak maybe remains a candidate", async () => {
		const userId = "cand-weak";
		await ingest(userId, "Maybe I will learn guitar someday.", candidateOnly("Guitar", "weak", 0.35));
		const candidates = await pendingCandidates(userId);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ labelGuess: "Guitar", status: "pending" });
		expect(await table("nodes", userId)).toHaveLength(0);
	});

	it("junk stays no_write/ignored", async () => {
		const userId = "cand-junk";
		const res = await ingest(userId, "ok thanks", { objects: [], notes: "" });
		expect(res.body.fired).toBe(false);
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect(await table("nodes", userId)).toHaveLength(0);
	});

	it("candidate promotion creates graph-visible durable memory", async () => {
		const userId = "cand-promote";
		await ingest(userId, "Maybe I will learn guitar someday.", candidateOnly("Guitar", "weak", 0.35));
		const [candidate] = await pendingCandidates(userId);
		const promoted = await call(`/v1/candidates/${candidate.id}/promote`, { userId, action: "promote_to_node" });
		expect(promoted.status).toBe(200);
		expect(promoted.body.receipt.outcome).toBe("promoted_from_candidate");
		expect(await pendingCandidates(userId)).toHaveLength(0);
		expect((await table("nodes", userId))[0]).toMatchObject({ label: "Guitar" });
		const recalled = await call("/v1/recall", { userId, query: "guitar" });
		expect(recalled.body.context).toContain("Guitar");
	});

	it("candidate reject removes it from review and recall", async () => {
		const userId = "cand-reject";
		await ingest(userId, "Maybe I will learn guitar someday.", candidateOnly("Guitar", "weak", 0.35));
		const [candidate] = await pendingCandidates(userId);
		const rejected = await call(`/v1/candidates/${candidate.id}/reject`, { userId });
		expect(rejected.status).toBe(200);
		expect(await pendingCandidates(userId)).toHaveLength(0);
		const recalled = await call("/v1/recall", { userId, query: "guitar" });
		expect(recalled.body.count).toBe(0);
	});

	it("duplicate durable memory reinforces without graph spam", async () => {
		const userId = "cand-duplicate";
		const llmResponse = {
			objects: [
				{ kind: "node", label: "Flutter", category: "skill", confidence: 0.95 },
				{ kind: "event", on: "Flutter", action: "started", text: "Started learning Flutter", importance: "ordinary", confidence: 0.95 },
			],
			notes: "",
		};
		await save(userId, "I started learning Flutter.", llmResponse);
		await save(userId, "I started learning Flutter.", llmResponse);
		expect(await table("nodes", userId)).toHaveLength(1);
		expect(await table("events", userId)).toHaveLength(1);
		expect(await pendingCandidates(userId)).toHaveLength(0);
	});
});
