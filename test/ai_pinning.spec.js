/**
 * Deterministic provider pinning (migration 0053).
 *
 * The invariant: A RUN ID NEVER CHANGES PROVIDER. The claim stores the pin,
 * every re-claim executes the ROW's pin (row-wins), and the throw fires only
 * for a caller explicitly forcing a contradicting pin — a code bug, never a
 * routine policy flip. Shadow sampling is decided once, at claim, into the
 * pin; a sampled `wrote` commit enqueues its shadow job in the SAME batch.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { claimExtractionRun } from "../src/lib/db.js";
import { runExtraction } from "../src/pipeline/extract.js";
import { resetPolicyCacheForTests } from "../src/ai/policy.js";
import { shadowJobId } from "../src/ai/shadow.js";

const PIN_A = JSON.stringify({ v: 1, routes: { extract: { provider: "workers-ai", model: "@cf/x/a" } } });
const PIN_B = JSON.stringify({ v: 1, routes: { extract: { provider: "google-vertex", model: "gemini-2.5-flash" } } });

function owner(suffix) {
	return {
		toolName: "ingest",
		sourceMode: "auto_ingest",
		idempotencyKey: `pin-idem-${suffix}`,
	};
}

describe("claim-time pin storage and row-wins replay", () => {
	it("stores the fresh pin on first claim and keeps it on re-claim", async () => {
		const userId = `pinuser-${crypto.randomUUID()}`;
		const id = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		const first = await claimExtractionRun(env, userId, {
			id, ...owner(id), provider: "workers-ai", model: "@cf/x/a", pin_json: PIN_A, pinResolvedFresh: true,
		});
		expect(first.claimed).toBe(true);
		expect(first.row.pin_json).toBe(PIN_A);
		expect(first.row.provider).toBe("workers-ai");

		// A retry that raced a policy flip resolves a DIFFERENT fresh pin — it
		// must lose to the row silently, never throw, never overwrite.
		const second = await claimExtractionRun(env, userId, {
			id, ...owner(id), provider: "google-vertex", model: "gemini-2.5-flash", pin_json: PIN_B, pinResolvedFresh: true,
		});
		expect(second.claimed).toBe(false);
		expect(second.row.pin_json).toBe(PIN_A);
	});

	it("throws only when a caller FORCES a contradicting pin", async () => {
		const userId = `pinuser-${crypto.randomUUID()}`;
		const id = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		await claimExtractionRun(env, userId, { id, ...owner(id), pin_json: PIN_A, pinResolvedFresh: true });
		await expect(claimExtractionRun(env, userId, { id, ...owner(id), pin_json: PIN_B }))
			.rejects.toThrow("different provider pin");
	});

	it("legacy NULL-pin rows accept pinned callers without a throw", async () => {
		const userId = `pinuser-${crypto.randomUUID()}`;
		const id = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		await claimExtractionRun(env, userId, { id, ...owner(id) }); // legacy: no pin
		const replay = await claimExtractionRun(env, userId, { id, ...owner(id), pin_json: PIN_B, pinResolvedFresh: true });
		expect(replay.claimed).toBe(false);
		expect(replay.row.pin_json).toBe(null);
	});
});

describe("end-to-end: policy → pin → atomic shadow enqueue", () => {
	beforeEach(() => resetPolicyCacheForTests());

	it("a shadow-sampled save records its pin and enqueues the outbox job in the commit", async () => {
		const userId = `pinshadow-${crypto.randomUUID()}`;
		const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, shadow_provider, shadow_model, shadow_sample_pct, allowlist_json, updated_at, updated_by)
			 VALUES ('extract', 'shadow', 'google-vertex', 'gemini-2.5-flash', 100, ?, ?, 'spec')`,
		).bind(JSON.stringify([userId]), Date.now()).run();
		const routedEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });

		const result = await runExtraction(routedEnv, userId, [
			{ role: "user", content: "I adopted a cat named Miso last week." },
		], [], {
			llmResponse: { objects: [{ kind: "node", label: "Miso", category: "pet", summary: "Cat adopted last week." }] },
			meta: { account_user_id: userId },
		}, { runId });

		expect(result.outcome).toBe("wrote");
		const row = await env.DB.prepare(
			"SELECT provider, model, pin_json FROM extraction_runs WHERE id = ?",
		).bind(runId).first();
		const pin = JSON.parse(row.pin_json);
		expect(pin.shadow).toMatchObject({ provider: "google-vertex", sampled: true });
		// The outbox job exists because the commit batch carried it.
		const job = await env.DB.prepare(
			"SELECT * FROM ai_shadow_jobs WHERE id = ?",
		).bind(await shadowJobId(runId)).first();
		expect(job).toMatchObject({ user_id: userId, primary_run_id: runId, provider: "google-vertex", status: "pending" });
	});

	it("with AI_ROUTING off, no pin is written and no shadow job appears", async () => {
		const userId = `pinoff-${crypto.randomUUID()}`;
		const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		const result = await runExtraction(env, userId, [
			{ role: "user", content: "I started learning cello." },
		], [], {
			llmResponse: { objects: [{ kind: "node", label: "Cello", category: "hobby", summary: "New instrument." }] },
		}, { runId });
		expect(result.outcome).toBe("wrote");
		const row = await env.DB.prepare("SELECT provider, pin_json FROM extraction_runs WHERE id = ?").bind(runId).first();
		expect(row.pin_json).toBe(null);
		expect(row.provider).toBe(null);
		const job = await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE id = ?").bind(await shadowJobId(runId)).first();
		expect(job).toBe(null);
	});
});
