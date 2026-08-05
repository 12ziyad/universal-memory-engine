/**
 * Idempotent replay must never claim an acceptance that did not happen.
 *
 * The bug: re-sending content the gate had REJECTED came back as "Already
 * saved — this exact content was accepted earlier", with savedTotal 0. Nothing
 * had been saved; it was skipped. The replay branch reached for that sentence
 * whenever it could not read the original receipt, and a gate-rejected packet
 * is exactly the case where the receipt was not linked to the job.
 *
 * Two halves are tested: the pure wording function against every outcome, and
 * the live route, where a rejected save is re-sent and must say so.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { replaySummary } from "../src/pipeline/receipt.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

describe("replaySummary never invents an acceptance", () => {
	it("says 'already saved' only when the original was actually accepted", () => {
		expect(replaySummary({ outcome: "accepted", reason: "extraction accepted" })).toMatch(/already saved/i);
		expect(replaySummary({ outcome: "saved" })).toMatch(/already saved/i);
		// The original receipt's own words win when we have them.
		expect(replaySummary({ outcome: "accepted" }, "Saved: 1 node (Kingfisher).")).toBe("Saved: 1 node (Kingfisher).");
	});

	it("says skipped, and why, when the gate rejected the original", () => {
		const s = replaySummary({ outcome: "ignored", reason: "nothing durable here (chatter, a question, or a duplicate)" });
		expect(s).toMatch(/not saved/i);
		expect(s).toMatch(/skipped/i);
		expect(s).toContain("nothing durable here");
		expect(s).not.toMatch(/already saved/i);
		expect(s).not.toMatch(/accepted/i);
	});

	it("never claims acceptance for any non-accepting outcome", () => {
		for (const outcome of ["ignored", "skipped", "opted_out", "failed", "queue_full"]) {
			const s = replaySummary({ outcome, reason: "some reason" });
			expect(s, outcome).not.toMatch(/already saved/i);
			expect(s, outcome).toMatch(/not saved/i);
		}
	});

	it("with no readable verdict, states only that the content was seen before", () => {
		const s = replaySummary(null, null);
		expect(s).not.toMatch(/already saved/i);
		expect(s).toMatch(/seen before/i);
		expect(s).toMatch(/nothing new was saved/i);
	});
});

describe("live replay of gate-rejected content", () => {
	it("re-sending rejected chatter reports skipped, not saved", async () => {
		const userId = `replay-gate-${crypto.randomUUID()}`;
		// Deterministic gate rejection: the extractor proposes nothing durable.
		const nothing = { objects: [], notes: "" };
		const body = {
			userId,
			flush: true,
			conversationId: "replay-gate-conv",
			messages: [{ id: "m1", role: "user", content: "what do you think about that though" }],
			_test: { llmResponse: nothing },
		};

		const first = await call("/v1/ingest", body);
		expect(first.status).toBe(200);
		expect(first.body.counts?.savedTotal ?? 0).toBe(0);

		const again = await call("/v1/ingest", body);
		expect(again.status).toBe(200);
		expect(again.body.counts?.savedTotal ?? 0).toBe(0);

		// Whether or not the replay branch fires, the one forbidden outcome is
		// claiming this content was saved when it never was.
		expect(again.body.summary).not.toMatch(/already saved/i);
		expect(again.body.summary).not.toMatch(/accepted earlier/i);
		// Any of the honest forms is fine: an explicit "not saved", the gate's own
		// "Saved: 0 …" verdict, or a plain "seen before". Only acceptance is banned.
		expect(again.body.summary).toMatch(/not saved|saved:\s*0|nothing durable|no durable|seen before/i);
	}, 30000);

	it("a genuinely accepted save still replays as accepted", async () => {
		const userId = `replay-ok-${crypto.randomUUID()}`;
		const good = {
			objects: [
				{ kind: "node", label: "Halcyon", category: "project", matches_existing: null, confidence: 0.95 },
				{ kind: "slice", on: "Halcyon", text: "Halcyon ships on Tuesdays", kind_detail: "progress", confidence: 0.9 },
			],
			notes: "",
		};
		const body = {
			userId,
			flush: true,
			conversationId: "replay-ok-conv",
			messages: [{ id: "m1", role: "user", content: "Halcyon ships on Tuesdays" }],
			_test: { llmResponse: good },
		};

		const first = await call("/v1/ingest", body);
		expect(first.status).toBe(200);

		const again = await call("/v1/ingest", body);
		expect(again.status).toBe(200);
		// This one WAS accepted, so acceptance language is correct and required.
		expect(again.body.summary).not.toMatch(/not saved/i);
	}, 30000);
});
