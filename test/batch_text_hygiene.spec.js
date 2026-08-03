/**
 * 7.4 — no raw batch text on nodes.
 *
 * The disease (Aug 2 load test): fallback text and candidate evidence were
 * built from the CONCATENATED chunk, so one noise line ("ugh the traffic on
 * Avenida…") got smeared across five nodes' slices/events and poisoned
 * recall's keyword seeds on every query. Slice/event text must come from ONE
 * message; anything stitched across messages is rejected.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function ingest(userId, messages, llmResponse) {
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify({ userId, flush: true, messages, _test: { llmResponse } }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response.json();
}

const NOISE = "The traffic on Avenida ruined my whole morning commute today";

describe("7.4: per-message text only", () => {
	it("fallback slice/event text comes from the object's own message, never the batch", async () => {
		const userId = `hyg-fallback-${crypto.randomUUID()}`;
		// Low-confidence node → the durable-signal fallback materializes an
		// event. Its text must come from m1 alone; m2's traffic line must
		// appear NOWHERE.
		await ingest(userId, [
			{ id: "m1", role: "user", content: "I started training for the Porto half marathon", ts: Date.now() },
			{ id: "m2", role: "user", content: NOISE, ts: Date.now() },
		], {
			objects: [
				{ kind: "node", label: "Porto Half Marathon", category: "skill", matches_existing: null, confidence: 0.3 },
			],
			notes: "",
		});
		const scans = [
			["slices", "text"], ["events", "text"], ["nodes", "summary"],
		];
		for (const [table, col] of scans) {
			const { results } = await env.DB.prepare(
				`SELECT ${col} AS v FROM ${table} WHERE user_id = ?`,
			).bind(userId).all();
			for (const row of results ?? []) {
				expect(String(row.v ?? "")).not.toContain("Avenida");
			}
		}
		// Candidate evidence too — the old lane stored the whole chunk there.
		const { results: cands } = await env.DB.prepare(
			"SELECT evidence_json FROM candidates WHERE user_id = ?",
		).bind(userId).all();
		for (const c of cands ?? []) {
			expect(String(c.evidence_json ?? "")).not.toContain("Avenida");
		}
	});

	it("the empty-proposal fallback probes messages individually", async () => {
		const userId = `hyg-empty-${crypto.randomUUID()}`;
		await ingest(userId, [
			{ id: "e1", role: "user", content: "I got married to Ines last weekend", ts: Date.now() },
			{ id: "e2", role: "user", content: NOISE, ts: Date.now() },
		], { objects: [], notes: "" });
		// Whatever the fallback materialized, none of it may carry m2's text.
		for (const table of ["slices", "events", "candidates"]) {
			const col = table === "candidates" ? "evidence_json" : "text";
			const { results } = await env.DB.prepare(
				`SELECT ${col} AS v FROM ${table} WHERE user_id = ?`,
			).bind(userId).all();
			for (const row of results ?? []) {
				expect(String(row.v ?? "")).not.toContain("Avenida");
			}
		}
	});

	it("rejects a slice stitched together from several messages (batch_text_blob)", async () => {
		const userId = `hyg-blob-${crypto.randomUUID()}`;
		const m1 = "My sister Amara moved from Boston to Porto in the spring and loves the coastline there";
		const m2 = "I have been planning the container logistics rollout for the Antwerp harbour project since January";
		const m3 = "Our ceramics teacher Teodor критiques glazes and runs the studio schedule every Thursday evening";
		const stitched = `${m1}. ${m2}. ${m3}`;
		const res = await ingest(userId, [
			{ id: "b1", role: "user", content: m1, ts: Date.now() },
			{ id: "b2", role: "user", content: m2, ts: Date.now() },
			{ id: "b3", role: "user", content: m3, ts: Date.now() },
		], {
			objects: [
				{ kind: "node", label: "Amara", category: "family", matches_existing: null, confidence: 0.95 },
				{ kind: "slice", on: "Amara", text: stitched, kind_detail: "other", confidence: 0.9 },
				{ kind: "slice", on: "Amara", text: "Moved from Boston to Porto in the spring", kind_detail: "progress", confidence: 0.9 },
			],
			notes: "",
		});
		const { results: slices } = await env.DB.prepare(
			"SELECT text FROM slices WHERE user_id = ?",
		).bind(userId).all();
		// The single-message fact survived; the stitched blob did not.
		expect(slices.some((s) => s.text.includes("Moved from Boston"))).toBe(true);
		expect(slices.some((s) => s.text.includes("Antwerp"))).toBe(false);
		void res; // the sync response carries the accepted receipt; the verdict lands in D1
		const run = await env.DB.prepare(
			"SELECT skipped_objects_json FROM extraction_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		expect(String(run?.skipped_objects_json ?? "")).toContain("batch_text_blob");
	});
});
