/**
 * Durable provider/model identity.
 *
 * A policy may omit a Google model for operator convenience, but no durable
 * pin or shadow job may do so.  The admin write door canonicalizes the exact
 * adapter model once; row-wins replay then keeps that model even after the
 * policy/default for new work changes.  Legacy NULL pins fail closed.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPolicyChange } from "../src/ai/admin.js";
import { dispatchAi } from "../src/ai/dispatch.js";
import { buildPin, parsePin, resolveWritePin, serializePin, withAiPin } from "../src/ai/pin.js";
import { resetPolicyCacheForTests, resolveRoute } from "../src/ai/policy.js";
import { GOOGLE_DEFAULT_MODELS } from "../src/ai/providers/google/models.js";
import { resolveProvider } from "../src/ai/registry.js";
import { shadowJobId } from "../src/ai/shadow.js";
import { claimExtractionRun } from "../src/lib/db.js";
import { runExtraction } from "../src/pipeline/extract.js";

function routingEnv() {
	return Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
}

function owner(suffix) {
	return {
		toolName: "ingest",
		sourceMode: "auto_ingest",
		idempotencyKey: `concrete-model-${suffix}`,
	};
}

async function clearSpecPolicies() {
	await env.DB.prepare(
		"DELETE FROM ai_routing_policies WHERE capability IN ('extract', 'rerank', 'embed')",
	).run();
	resetPolicyCacheForTests();
}

beforeEach(clearSpecPolicies);
afterEach(clearSpecPolicies);

describe("policy model canonicalization", () => {
	it("persists concrete Google models for primary and shadow routes", async () => {
		expect(await applyPolicyChange(env, {
			lane: "extract",
			patch: { mode: "google_only", primary_model: null, allowlist: ["model-account"] },
			actorUserId: "model-spec",
		})).toMatchObject({ ok: true });
		expect(await applyPolicyChange(env, {
			lane: "rerank",
			patch: {
				mode: "shadow",
				shadow_provider: "google-vertex",
				shadow_model: null,
				allowlist: ["model-account"],
			},
			actorUserId: "model-spec",
		})).toMatchObject({ ok: true });

		const rows = await env.DB.prepare(
			`SELECT capability, primary_model, shadow_model
			 FROM ai_routing_policies
			 WHERE capability IN ('extract', 'rerank')`,
		).all();
		const byLane = Object.fromEntries(rows.results.map((row) => [row.capability, row]));
		expect(byLane.extract.primary_model).toBe(GOOGLE_DEFAULT_MODELS.extract);
		expect(byLane.rerank.shadow_model).toBe(GOOGLE_DEFAULT_MODELS.rerank);
	});

	it("fails closed when a row bypasses the admin door without a canonical model", async () => {
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies
			 (capability, mode, primary_provider, primary_model, allowlist_json, updated_at, updated_by)
			 VALUES ('extract', 'google_only', 'google-vertex', NULL, '["model-account"]', ?, 'bypass')
			 ON CONFLICT(capability) DO UPDATE SET
				mode='google_only', primary_provider='google-vertex', primary_model=NULL,
				allowlist_json=excluded.allowlist_json,
				updated_at=excluded.updated_at, updated_by='bypass'`,
		).bind(Date.now()).run();
		const route = await resolveRoute(routingEnv(), "extract", { accountUserId: "model-account" });
		expect(route).toMatchObject({ provider: "workers-ai", source: "invalid_policy" });
	});

	it("rejects unpriced, moving, and cross-capability Google models at write and read boundaries", async () => {
		for (const primaryModel of ["gemini-future-ultra", "gemini-2.5-flash-latest", "gemini-embedding-001"]) {
			const result = await applyPolicyChange(env, {
				lane: "extract",
				patch: {
					mode: "google_only",
					primary_model: primaryModel,
					allowlist: ["model-account"],
				},
				actorUserId: "model-spec",
			});
			expect(result).toMatchObject({ error: "invalid_policy" });
		}
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_routing_policies WHERE capability = 'extract'",
		).first("n")).toBe(0);

		await env.DB.prepare(
			`INSERT INTO ai_routing_policies
			 (capability, mode, primary_provider, primary_model, allowlist_json, updated_at, updated_by)
			 VALUES ('extract', 'google_only', 'google-vertex', 'gemini-future-ultra', '["model-account"]', ?, 'bypass')`,
		).bind(Date.now()).run();
		resetPolicyCacheForTests();
		expect(await resolveRoute(routingEnv(), "extract", { accountUserId: "model-account" }))
			.toMatchObject({ provider: "workers-ai", source: "invalid_policy" });
	});
});

describe("claim-time concrete model pins", () => {
	it("stores the resolved model once and row-wins replay keeps it after new work changes", async () => {
		const provider = await resolveProvider("google-vertex");
		const originalResolveModel = provider.resolveModel;
		let configuredDefault = "gemini-2.5-flash";
		provider.resolveModel = (call) => (
			typeof call?.model === "string" && call.model.startsWith("gemini-")
				? call.model
				: configuredDefault
		);
		try {
			const firstPolicy = await applyPolicyChange(env, {
				lane: "extract",
				patch: { mode: "google_only", primary_model: null, allowlist: ["model-account"] },
				actorUserId: "model-spec",
			});
			expect(firstPolicy).toMatchObject({ ok: true, version: 1 });
			const firstPin = await resolveWritePin(routingEnv(), {
				accountUserId: "model-account",
				runKey: "stable-run",
			});
			expect(firstPin.routes.extract).toEqual({
				provider: "google-vertex",
				model: "gemini-2.5-flash",
			});

			const userId = `model-pin-${crypto.randomUUID()}`;
			const id = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
			const claimed = await claimExtractionRun(env, userId, {
				id,
				...owner(id),
				provider: firstPin.routes.extract.provider,
				model: firstPin.routes.extract.model,
				pin_json: serializePin(firstPin),
				pinResolvedFresh: true,
			});
			expect(claimed.claimed).toBe(true);

			// Change the provider's configured default. The already-canonical policy
			// and run still name A; only an explicit policy rewrite may opt new work
			// into B.
			configuredDefault = "gemini-2.5-pro";
			resetPolicyCacheForTests();
			expect((await resolveWritePin(routingEnv(), {
				accountUserId: "model-account",
				runKey: "new-run-before-rewrite",
			})).routes.extract.model).toBe("gemini-2.5-flash");

			expect(await applyPolicyChange(env, {
				lane: "extract",
				patch: { primary_model: null },
				actorUserId: "model-spec",
				expectedVersion: 1,
			})).toMatchObject({ ok: true, version: 2 });
			const laterPin = await resolveWritePin(routingEnv(), {
				accountUserId: "model-account",
				runKey: "stable-run",
			});
			expect(laterPin.routes.extract.model).toBe("gemini-2.5-pro");

			const replay = await claimExtractionRun(env, userId, {
				id,
				...owner(id),
				provider: laterPin.routes.extract.provider,
				model: laterPin.routes.extract.model,
				pin_json: serializePin(laterPin),
				pinResolvedFresh: true,
			});
			expect(replay.claimed).toBe(false);
			expect(parsePin(replay.row.pin_json).routes.extract.model).toBe("gemini-2.5-flash");
			expect(replay.row.model).toBe("gemini-2.5-flash");
		} finally {
			provider.resolveModel = originalResolveModel;
		}
	});

	it("persists a concrete sampled-shadow model into both run and outbox job", async () => {
		const accountUserId = "model-shadow-account";
		expect(await applyPolicyChange(env, {
			lane: "extract",
			patch: {
				mode: "shadow",
				shadow_provider: "google-vertex",
				shadow_model: null,
				shadow_sample_pct: 100,
				allowlist: [accountUserId],
			},
			actorUserId: "model-spec",
		})).toMatchObject({ ok: true });

		const userId = `model-shadow-${crypto.randomUUID()}`;
		const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		const result = await runExtraction(routingEnv(), userId, [
			{ role: "user", content: "I adopted a cat named Miso last week." },
		], [], {
			llmResponse: { objects: [{ kind: "node", label: "Miso", category: "pet", summary: "Cat adopted last week." }] },
			meta: { accountUserId },
		}, { runId });
		expect(result.outcome).toBe("wrote");

		const run = await env.DB.prepare("SELECT pin_json FROM extraction_runs WHERE id = ?").bind(runId).first();
		expect(parsePin(run.pin_json).shadow).toMatchObject({
			provider: "google-vertex",
			model: GOOGLE_DEFAULT_MODELS.extract,
			sampled: true,
		});
		const job = await env.DB.prepare("SELECT provider, model FROM ai_shadow_jobs WHERE id = ?")
			.bind(await shadowJobId(runId)).first();
		expect(job).toEqual({ provider: "google-vertex", model: GOOGLE_DEFAULT_MODELS.extract });
	});

	it("refuses a legacy non-default NULL-model pin instead of consulting today's default", async () => {
		const malformed = buildPin({
			routes: { extract: { provider: "google-vertex", model: null } },
		});
		await expect(withAiPin(malformed, () => dispatchAi(env, {
			model: "@cf/meta/llama",
			inputs: { messages: [{ role: "user", content: "test" }] },
			meta: { task: "extract", reservationId: `legacy-${crypto.randomUUID()}` },
		}))).rejects.toMatchObject({ aiErrorClass: "pinned_model_missing" });
	});
});
