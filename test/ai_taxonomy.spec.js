/**
 * The fallback taxonomy, made unrepresentable (plan §5.3).
 *
 *   inference_fallback — read-only lanes only. Write lanes REJECT fallback
 *   modes at the policy door and again at read time.
 *   admission_reroute — new runs only, at claim time, recorded on the pin.
 *   Space-bound lanes (embeddings) can never reach a foreign space by any
 *   automatic decision.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { legalModesFor, resetPolicyCacheForTests, resolveRoute, validatePolicyWrite } from "../src/ai/policy.js";
import { applyPolicyChange } from "../src/ai/admin.js";

beforeEach(() => resetPolicyCacheForTests());

describe("policy legality matrix", () => {
	it("write lanes reject fallback modes; read lanes allow them", () => {
		for (const lane of ["extract", "edges", "reflexion", "extract_atomic", "digest"]) {
			expect(legalModesFor(lane)).not.toContain("cf_primary_google_fallback");
			expect(legalModesFor(lane)).not.toContain("google_primary_cf_fallback");
			expect(validatePolicyWrite(lane, { mode: "cf_primary_google_fallback" }).length).toBeGreaterThan(0);
		}
		expect(legalModesFor("rerank")).toContain("cf_primary_google_fallback");
		expect(legalModesFor("playground_chat")).toContain("google_primary_cf_fallback");
	});

	it("embedding lanes are space-bound: only cloudflare_only and shadow are legal", () => {
		for (const lane of ["embed", "embed_profile"]) {
			expect(legalModesFor(lane)).toEqual(["cloudflare_only", "shadow"]);
			expect(validatePolicyWrite(lane, { mode: "google_only" }).length).toBeGreaterThan(0);
		}
	});

	it("the admin door refuses an illegal write, and an illegally-stored mode resolves cloudflare-only", async () => {
		const refused = await applyPolicyChange(env, {
			lane: "extract",
			patch: { mode: "google_primary_cf_fallback" },
			actorUserId: "spec-admin",
		});
		expect(refused.error).toBe("invalid_policy");

		// Defense in depth: a row smuggled past the door still resolves default.
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, primary_provider, updated_at, updated_by)
			 VALUES ('embed', 'google_only', 'google-vertex', ?, 'smuggled')
			 ON CONFLICT(capability) DO UPDATE SET mode='google_only', primary_provider='google-vertex'`,
		).bind(Date.now()).run();
		resetPolicyCacheForTests();
		const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
		const route = await resolveRoute(onEnv, "embed", {});
		expect(route.provider).toBe("workers-ai");
		expect(route.source).toBe("illegal_mode");
		await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = 'embed'").run();
	});

	it("a legal policy write lands with CAS + audit, and version conflicts refuse", async () => {
		const first = await applyPolicyChange(env, {
			lane: "rerank",
			patch: { mode: "cloudflare_only" },
			actorUserId: "spec-admin",
			note: "taxonomy spec",
		});
		expect(first.ok).toBe(true);
		const stale = await applyPolicyChange(env, {
			lane: "rerank",
			patch: { mode: "cloudflare_only" },
			actorUserId: "spec-admin",
			expectedVersion: 999,
		});
		expect(stale.error).toBe("version_conflict");
		const audit = await env.DB.prepare(
			"SELECT actor_user_id, note FROM ai_routing_policy_audit WHERE capability = 'rerank' ORDER BY changed_at DESC LIMIT 1",
		).first();
		expect(audit).toMatchObject({ actor_user_id: "spec-admin", note: "taxonomy spec" });
	});
});
