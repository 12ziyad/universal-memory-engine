/**
 * The Requests page.
 *
 * The rule that matters most: metadata only. The admin analytics already work
 * this way and this page must too, so the strictest spec here reads a real
 * saved memory back out of the graph and asserts none of its words appear
 * anywhere in the /v1/requests payload.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function authed(body) {
	return {
		method: "POST",
		headers: { "x-api-key": env.API_KEY, "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

const SECRET_SENTENCE = "I started boxing training at Ironside Gym on Tuesdays";

async function seed(userId) {
	await request("/v1/save", authed({
		userId,
		content: `${SECRET_SENTENCE}.`,
		_test: {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
					{ kind: "slice", on: "Boxing", text: SECRET_SENTENCE, kind_detail: "progress", confidence: 0.95 },
				],
			},
		},
	}));
	await request("/v1/recall", authed({ userId, query: "what am I training?" }));
}

function rowsFor(body, type) {
	return body.requests.filter((r) => (type === "recall" ? r.source === "recall" : r.source !== "recall"));
}

describe("GET /v1/requests", () => {
	it("returns metadata and no memory content whatsoever", async () => {
		const userId = `rq-privacy-${crypto.randomUUID()}`;
		await seed(userId);

		const res = await request(`/v1/requests?userId=${userId}`, { headers: { "x-api-key": env.API_KEY } });
		expect(res.status).toBe(200);
		const raw = await res.text();

		// Not one word of what was stored, and not the columns that carry it.
		expect(raw).not.toContain("Boxing");
		expect(raw).not.toContain("Ironside");
		expect(raw.toLowerCase()).not.toContain("boxing");
		const body = JSON.parse(raw);
		for (const row of body.requests) {
			expect(row.summary).toBeUndefined();
			expect(row.detail).toBeUndefined();
			expect(Object.keys(row).sort()).toEqual([
				"created_at", "extraction_run_id", "id", "latency_ms", "matched", "outcome",
				"saved_nodes", "saved_pages", "saved_total", "skipped", "source", "source_mode", "updated_nodes",
			]);
		}
	});

	it("records how long the memory work took", async () => {
		const userId = `rq-latency-${crypto.randomUUID()}`;
		await seed(userId);
		const body = await (await request(`/v1/requests?userId=${userId}`, { headers: { "x-api-key": env.API_KEY } })).json();

		const save = rowsFor(body, "save").find((r) => Number(r.saved_total) > 0);
		expect(save).toBeTruthy();
		expect(Number.isFinite(save.latency_ms)).toBe(true);
		expect(save.latency_ms).toBeGreaterThanOrEqual(0);

		const recall = rowsFor(body, "recall")[0];
		expect(recall).toBeTruthy();
		expect(Number.isFinite(recall.latency_ms)).toBe(true);
		expect(Number.isFinite(recall.matched)).toBe(true);
	});

	it("honours the range and needs read scope", async () => {
		const userId = `rq-range-${crypto.randomUUID()}`;
		await seed(userId);
		const body = await (await request(`/v1/requests?userId=${userId}&range=1d`, { headers: { "x-api-key": env.API_KEY } })).json();
		expect(body.range.days).toBe(1);
		expect(body.requests.length).toBeGreaterThan(0);

		const anon = await request(`/v1/requests?userId=${userId}`);
		expect(anon.status).toBe(401);
	});

	it("shows nothing from another account", async () => {
		const mine = `rq-mine-${crypto.randomUUID()}`;
		const theirs = `rq-theirs-${crypto.randomUUID()}`;
		await seed(mine);
		const body = await (await request(`/v1/requests?userId=${theirs}`, { headers: { "x-api-key": env.API_KEY } })).json();
		expect(body.requests).toEqual([]);
	});
});

describe("the requests screen", () => {
	async function page() {
		const { default: html } = await import("../public/index.html?raw");
		return { html, script: html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "" };
	}

	it("is a rail item under Activity with the six columns", async () => {
		const { html, script } = await page();
		expect(html).toContain('data-view="requests"');
		expect(script).toContain('requests: "Requests"');
		expect(script).toContain("<th>Time</th><th>Type</th><th>Entities</th><th>Event</th><th>Latency</th><th>Status</th>");
	});

	it("has search, a type filter, a range picker, a refresh, and a chart", async () => {
		const { script } = await page();
		expect(script).toContain('id="rqSearch"');
		expect(script).toContain('id="rqType"');
		expect(script).toContain("function setRequestRange(");
		expect(script).toContain("onclick=\"loadRequests()\"");
		expect(script).toContain("function requestChart(");
	});

	it("builds the Event column from counts, never from the receipt summary", async () => {
		const { script } = await page();
		expect(script).toContain("function requestEvent(");
		// If this ever reads row.summary the page starts printing memory content.
		expect(script).not.toMatch(/requestEvent[\s\S]{0,600}row\.summary/);
		expect(script).not.toMatch(/renderRequestsTable[\s\S]{0,1400}row\.summary/);
	});

	it("invites the person to act when there is nothing yet", async () => {
		const { script } = await page();
		expect(script).toContain("Nothing has reached your memory yet.");
		expect(script).toContain("Open the Playground");
		expect(script).not.toContain(">No data<");
	});
});
