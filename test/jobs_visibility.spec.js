/**
 * Part 2 — visibility. The packet id on every receipt is a public handle:
 * status endpoint, jobs ledger, terminal webhooks, admin queue counters.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { createWebhook } from "../src/pipeline/webhooks.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

async function call(method, path, body) {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

describe("packet status endpoint (2.1)", () => {
	it("answers correctly for an accepted-and-enriched packet", async () => {
		const userId = `vis-status-${crypto.randomUUID()}`;
		const save = await call("POST", "/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "I am building project Falcon this month" }],
			_test: { llmResponse: canned("Falcon") },
		});
		expect(save.status).toBe(200);
		const packetId = save.body.source_packet_id;
		expect(packetId).toBeTruthy();

		const status = await call("GET", `/v1/packets/${encodeURIComponent(packetId)}/status?userId=${encodeURIComponent(userId)}`);
		expect(status.status).toBe(200);
		expect(status.body.status).toBe("enriched");
		expect(status.body.lane).toBe("ingest");
		expect(status.body.counts.nodes).toBeGreaterThan(0);
		expect(status.body.job_id).toBeTruthy();
	});

	it("404s on an unknown packet id instead of guessing", async () => {
		const res = await call("GET", `/v1/packets/src_does_not_exist/status?userId=vis-nobody`);
		expect(res.status).toBe(404);
		expect(res.body.error).toBe("not_found");
	});
});

describe("jobs ledger (2.2)", () => {
	it("lists the caller's jobs with status filtering", async () => {
		const userId = `vis-jobs-${crypto.randomUUID()}`;
		await call("POST", "/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "I am building project Osprey this month" }],
			_test: { llmResponse: canned("Osprey") },
		});
		const listed = await call("GET", `/v1/jobs?status=enriched&userId=${encodeURIComponent(userId)}`);
		expect(listed.status).toBe(200);
		expect(listed.body.jobs.length).toBe(1);
		expect(listed.body.jobs[0].status).toBe("enriched");
		expect(listed.body.jobs[0].source_packet_id).toBeTruthy();

		const none = await call("GET", `/v1/jobs?status=failed&userId=${encodeURIComponent(userId)}`);
		expect(none.body.jobs.length).toBe(0);
	});
});

describe("terminal webhooks (2.3)", () => {
	it("memory.enriched fires once when the job settles", async () => {
		const userId = `vis-hook-${crypto.randomUUID()}`;
		await createWebhook(env, userId, {
			name: "test",
			url: "https://example.com/hook",
			events: ["memory.enriched", "memory.failed"],
		});
		await call("POST", "/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "I am building project Heron this month" }],
			_test: { llmResponse: canned("Heron") },
		});
		const { results } = await env.DB.prepare(
			"SELECT event, payload_json FROM webhook_deliveries WHERE user_id = ? AND event = 'memory.enriched'",
		).bind(userId).all();
		expect(results.length).toBe(1);
		const payload = JSON.parse(results[0].payload_json);
		expect(payload.data.status).toBe("enriched");
		expect(payload.data.job_id).toBeTruthy();
	});
});

describe("admin queue counters (2.4)", () => {
	it("queueCounters reports depth, oldest age, failures, and the unparseable rate", async () => {
		const { queueCounters } = await import("../src/pipeline/jobs_api.js");
		const counters = await queueCounters(env);
		expect(counters).toHaveProperty("queue_depth");
		expect(counters).toHaveProperty("oldest_pending_age_s");
		expect(counters).toHaveProperty("failed_24h");
		expect(counters.edge_pass_unparseable_24h).toHaveProperty("rate");
	});
});
