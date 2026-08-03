/**
 * Part 7.1–7.3 — entity resolution biased to split, and same-fact dedup.
 * The named bugs from the Aug 2 report, as permanent regressions:
 * Meridian Freight→Meridian Labs, Clara→Amara, coffee-switch→Black Coffee
 * must NEVER merge; daily repetition must refresh, not insert.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function ingest(userId, id, content, llmResponse) {
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify({
			userId,
			flush: true,
			messages: [{ id, role: "user", content, ts: Date.now() }],
			_test: { llmResponse },
		}),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response.json();
}

const nodeOnly = (label, category = "organization") => ({
	objects: [
		{ kind: "node", label, category, matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `A fact about ${label}`, kind_detail: "other", confidence: 0.9 },
	],
	notes: "",
});

async function labels(userId) {
	const { results } = await env.DB.prepare(
		"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL ORDER BY label",
	).bind(userId).all();
	return results.map((r) => r.label);
}

describe("7.1/7.2 — bias to split", () => {
	it("Meridian Freight and Meridian Labs are two organizations, always", async () => {
		const userId = `res-meridian-${crypto.randomUUID()}`;
		await ingest(userId, "m1", "I work with Meridian Freight", nodeOnly("Meridian Freight"));
		await ingest(userId, "m2", "Meridian Labs is a different company", nodeOnly("Meridian Labs"));
		expect(await labels(userId)).toEqual(["Meridian Freight", "Meridian Labs"]);
	});

	it("Clara and Amara are two people", async () => {
		const userId = `res-clara-${crypto.randomUUID()}`;
		await ingest(userId, "m1", "Clara is a friend", nodeOnly("Clara", "person"));
		await ingest(userId, "m2", "Amara is my sister", nodeOnly("Amara", "person"));
		expect(await labels(userId)).toEqual(["Amara", "Clara"]);
	});

	it("a category clash blocks even a high-similarity merge", async () => {
		const userId = `res-cat-${crypto.randomUUID()}`;
		await ingest(userId, "m1", "Porto is where I live", nodeOnly("Porto", "place"));
		await ingest(userId, "m2", "Porto is our shipping project", nodeOnly("Portos", "project"));
		expect((await labels(userId)).length).toBe(2);
	});

	it("an exact re-mention still merges (no over-splitting)", async () => {
		const userId = `res-exact-${crypto.randomUUID()}`;
		await ingest(userId, "m1", "I work at Halcyon Robotics", nodeOnly("Halcyon Robotics"));
		await ingest(userId, "m2", "Halcyon Robotics is hiring", nodeOnly("Halcyon Robotics"));
		expect(await labels(userId)).toEqual(["Halcyon Robotics"]);
	});

	it("an explicitly stated alias merges, and the merge is auditable on the receipt", async () => {
		const userId = `res-alias-${crypto.randomUUID()}`;
		await ingest(userId, "m1", "I work at International Business Machines", nodeOnly("International Business Machines"));
		await env.DB.prepare("UPDATE nodes SET aliases_json = ? WHERE user_id = ?")
			.bind(JSON.stringify(["IBM"]), userId).run();
		await ingest(userId, "m2", "IBM gave everyone a bonus", nodeOnly("IBM"));
		expect(await labels(userId)).toEqual(["International Business Machines"]);
		const receipt = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE user_id = ? AND outcome = 'wrote' ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		expect(String(receipt.detail)).toContain('"basis":"alias"');
	});
});

describe("7.3 — same-fact dedup is a visible NOOP", () => {
	it("daily 'working on X' refreshes one row instead of creating thirty", async () => {
		const userId = `res-noop-${crypto.randomUUID()}`;
		const fact = {
			objects: [
				{ kind: "node", label: "Thesis", category: "project", matches_existing: null, confidence: 0.95 },
				{ kind: "slice", on: "Thesis", text: "Working on the thesis", kind_detail: "other", confidence: 0.9 },
			],
			notes: "",
		};
		for (let day = 1; day <= 4; day++) {
			await ingest(userId, `d${day}`, `Day ${day}: still working on the thesis project`, fact);
		}
		const { results: slices } = await env.DB.prepare(
			"SELECT text FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(slices).toHaveLength(1);

		// The receipt names the repetition as a NOOP, not a save.
		const receipt = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE user_id = ? AND outcome = 'wrote' ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		const detail = JSON.parse(receipt.detail);
		expect(detail.duplicates_noop).toBeGreaterThan(0);
	});

	it("dedup is content-based, not kind-based", async () => {
		const userId = `res-kind-${crypto.randomUUID()}`;
		const withKind = (kind) => ({
			objects: [
				{ kind: "node", label: "Marathon", category: "goal", matches_existing: null, confidence: 0.95 },
				{ kind: "slice", on: "Marathon", text: "Trains five days a week", kind_detail: kind, confidence: 0.9 },
			],
			notes: "",
		});
		await ingest(userId, "k1", "I train five days a week for the marathon", withKind("progress"));
		await ingest(userId, "k2", "training five days a week for the marathon still", withKind("other"));
		const { results: slices } = await env.DB.prepare(
			"SELECT text FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(slices).toHaveLength(1);
	});
});
