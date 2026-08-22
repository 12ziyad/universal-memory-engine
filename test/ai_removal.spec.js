/**
 * The removal proof (plan §12), mechanized.
 *
 * With no GOOGLE_* config and no policy, every lane resolves to Workers AI,
 * admission refuses Google, and the removal gate reads clean. Seeded Google
 * work makes the gate refuse until it is terminally settled — a pinned run
 * never re-resolves; it settles, and only then may removal proceed. The
 * standing half of the drill is the whole existing suite: the shared test env
 * defines no GOOGLE_* keys, so every green run is a Google-less regression.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveRoute, resetPolicyCacheForTests, routingMode } from "../src/ai/policy.js";
import { providerAdmission, resetProviderBudgetForTests } from "../src/ai/provider_budget.js";
import { removalGate } from "../src/ai/admin.js";
import { WRITE_PIN_LANES } from "../src/ai/pin.js";

beforeEach(() => {
	resetPolicyCacheForTests();
	resetProviderBudgetForTests();
});

describe("google-absent baseline", () => {
	it("the shared test env is google-less — the standing removal drill", () => {
		expect(env.GCP_SERVICE_ACCOUNT).toBeUndefined();
		expect(env.GCP_PROJECT_ID).toBeUndefined();
		expect(routingMode(env)).toBe("off");
	});

	it("every write lane resolves to workers-ai with routing off AND on", async () => {
		for (const lane of WRITE_PIN_LANES) {
			expect((await resolveRoute(env, lane, {})).provider).toBe("workers-ai");
		}
		const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
		for (const lane of WRITE_PIN_LANES) {
			expect((await resolveRoute(onEnv, lane, {})).provider).toBe("workers-ai");
		}
	});

	it("admission refuses google without credentials", async () => {
		const refused = await providerAdmission(env, "google-vertex", "generate_structured", { inputs: {} });
		expect(refused).toMatchObject({ allowed: false, reason: "no_credentials" });
	});
});

describe("the removal gate", () => {
	it("reads clean on a google-free database and dirty while google work is nonterminal", async () => {
		const before = await removalGate(env);
		expect(before.clean).toBe(true);

		const userId = `removal-${crypto.randomUUID()}`;
		const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`INSERT INTO extraction_runs (id, user_id, tool_name, status, created_pages_json, created_nodes_json,
				created_slices_json, created_events_json, created_edges_json, created_candidates_json,
				updated_objects_json, reinforced_objects_json, skipped_objects_json, created_at, updated_at, provider)
			 VALUES (?, ?, 'ingest', 'running', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, 'google-vertex')`,
		).bind(runId, userId, Date.now(), Date.now()).run();

		const dirty = await removalGate(env);
		expect(dirty.clean).toBe(false);
		expect(dirty.counts.nonterminal_google_runs).toBeGreaterThanOrEqual(1);

		// Settle terminally — the ONLY legal path to removal. Never a provider switch.
		await env.DB.prepare("UPDATE extraction_runs SET status = 'failed' WHERE id = ?").bind(runId).run();
		const after = await removalGate(env);
		expect(after.counts.nonterminal_google_runs).toBe(0);
	});
});
