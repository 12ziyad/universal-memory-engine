/**
 * The removal proof (plan §12), mechanized.
 *
 * With no GCP provider credentials and no policy, every lane resolves to
 * Workers AI, admission refuses Google, and the removal gate reads clean. Seeded Google
 * work makes the gate refuse until it is terminally settled — a pinned run
 * never re-resolves; it settles, and only then may removal proceed. The
 * standing half of the drill is the whole existing suite: the shared test env
 * defines deterministic fake app-auth values but no GCP provider credentials.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveRoute, resetPolicyCacheForTests, routingMode } from "../src/ai/policy.js";
import {
	markReservationInvoking,
	providerAdmission,
	releaseReservation,
	reserveSpend,
	resetProviderBudgetForTests,
} from "../src/ai/provider_budget.js";
import { emergencyDisable, removalGate } from "../src/ai/admin.js";
import { WRITE_PIN_LANES } from "../src/ai/pin.js";
import { drainShadowJobs, reconcileShadowJobs, shadowJobId } from "../src/ai/shadow.js";
import {
	atomicCaptureProviderOperationId,
	ATOMIC_CAPTURE_MAX_ATTEMPTS,
} from "../src/pipeline/atomic_candidates.mjs";

beforeEach(() => {
	resetPolicyCacheForTests();
	resetProviderBudgetForTests();
});

describe("Google provider-credential-absent baseline", () => {
	it("the shared test env has only deterministic app-auth fakes", () => {
		expect(env.API_KEY).toBe("itsuki_test_only_not_a_secret");
		expect(env.GOOGLE_CLIENT_ID).toBe("test-client-id.apps.googleusercontent.com");
		expect(env.GOOGLE_CLIENT_SECRET).toBe("test-client-secret-not-a-secret");
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
	async function seedPinnedRun({ status = "running", provider = "workers-ai", model = null, pin }) {
		const userId = `removal-pin-${crypto.randomUUID()}`;
		const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO extraction_runs (id, user_id, tool_name, status, created_pages_json, created_nodes_json,
				created_slices_json, created_events_json, created_edges_json, created_candidates_json,
				updated_objects_json, reinforced_objects_json, skipped_objects_json, created_at, updated_at,
				provider, model, pin_json)
			 VALUES (?, ?, 'ingest', ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]',
				?, ?, ?, ?, ?)`,
		).bind(runId, userId, status, now, now, provider, model, JSON.stringify(pin)).run();
		return { runId, userId };
	}

	it("reads clean on a google-free database and dirty while google work is nonterminal", async () => {
		await emergencyDisable(env, { actorUserId: "removal-test" });
		const before = await removalGate(env);
		expect(before.clean).toBe(true);
		expect(before.counts.google_override_not_disabled).toBe(0);

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

	it("blocks on invoking shadow work until deterministic lease-expiry retirement", async () => {
		await emergencyDisable(env, { actorUserId: "removal-invoking-shadow-test" });
		const now = Date.now();
		const id = `shadow_invoking_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`INSERT INTO ai_shadow_jobs
			 (id, user_id, primary_run_id, provider, model, status, attempts,
			  claim_token, lease_until, created_at, updated_at)
			 VALUES (?, ?, ?, 'google-vertex', 'gemini-2.5-flash', 'invoking', 1,
			  'live-provider-owner', ?, ?, ?)`,
		).bind(id, `user_${id}`, `run_${id}`, now + 60_000, now, now).run();

		let gate = await removalGate(env);
		expect(gate.clean).toBe(false);
		expect(gate.counts.pending_google_shadow_jobs).toBe(1);
		await drainShadowJobs(env, { limit: 5, now: now + 1 });
		expect((await removalGate(env)).clean).toBe(false);

		await drainShadowJobs(env, { limit: 5, now: now + 60_001 });
		expect(await env.DB.prepare(
			"SELECT status, error_class, claim_token, lease_until FROM ai_shadow_jobs WHERE id = ?",
		).bind(id).first()).toEqual({
			status: "dead_letter",
			error_class: "invocation_lease_expired",
			claim_token: null,
			lease_until: null,
		});
		gate = await removalGate(env);
		expect(gate.clean).toBe(true);
		expect(gate.counts.pending_google_shadow_jobs).toBe(0);
	});

	it("blocks every direct, fallback, shadow, mode-implied, disabled, and canary policy reference", async () => {
		const now = Date.now();
		const rows = [
			["remove-primary", "cloudflare_only", "google-vertex", null, null, 1],
			["remove-fallback", "cloudflare_only", "workers-ai", "google-vertex", null, 1],
			["remove-shadow", "cloudflare_only", "workers-ai", null, "google-vertex", 1],
			["remove-google-only", "google_only", "workers-ai", null, null, 1],
			["remove-google-primary", "google_primary_cf_fallback", "workers-ai", null, null, 1],
			["remove-google-fallback", "cf_primary_google_fallback", "workers-ai", null, null, 1],
			["remove-canary", "canary", "workers-ai", null, null, 1],
		];
		await env.DB.batch(rows.map(([capability, mode, primary, fallback, shadow, disabled]) =>
			env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, fallback_provider, shadow_provider,
				  disabled, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'removal-test')`,
			).bind(capability, mode, primary, fallback, shadow, disabled, now)));

		const dirty = await removalGate(env);
		expect(dirty.clean).toBe(false);
		expect(dirty.counts.google_admitting_policies).toBe(rows.length);
		await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability LIKE 'remove-%'").run();
		expect((await removalGate(env)).counts.google_admitting_policies).toBe(0);
	});

	it("blocks invoking reservations and only released recoverable interrupted atomic attempts", async () => {
		const now = Date.now();
		const reservationId = `removal-reservation-${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO ai_provider_reservations
			 (id, provider, unit_class, day, month, estimated_units, estimated_cost_micros,
			  rate_card_version, attempt_token, status, expires_at, created_at, updated_at)
			 VALUES (?, 'google-vertex', 'tokens', '2026-08-22', '2026-08', 1, 1,
			  'spec', 'attempt', 'invoking', ?, ?, ?)`,
		).bind(reservationId, now + 60_000, now, now).run();
		let dirty = await removalGate(env);
		expect(dirty.clean).toBe(false);
		expect(dirty.counts.active_google_reservations).toBeGreaterThanOrEqual(1);
		await env.DB.prepare(
			"UPDATE ai_provider_reservations SET status = 'settled', terminal_at = ? WHERE id = ?",
		).bind(now, reservationId).run();

		const userId = `removal-atomic-${crypto.randomUUID()}`;
		const runId = `atomic_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`INSERT INTO semantic_atom_capture_runs
			 (id, user_id, source_packet_id, chunk_key, status, model, schema_version,
			  accepted_at, attempts, error_code, created_at, updated_at, completed_at, provider)
			 VALUES (?, ?, ?, 'chunk-0', 'failed', 'test-model', 'v1', ?, 1,
			  'interrupted_unknown', ?, ?, ?, 'google-vertex')`,
		).bind(runId, userId, `packet-${crypto.randomUUID()}`, now, now, now, now).run();

		// A missing durable attempt reservation is not permission to retry. Unknown,
		// settled, and ambiguous outcomes are terminal/fail-closed for removal too.
		dirty = await removalGate(env);
		expect(dirty.counts.nonterminal_google_atomic_runs).toBe(0);

		const atomicReservationId = atomicCaptureProviderOperationId(runId, 1);
		await env.DB.prepare(
			`INSERT INTO ai_provider_reservations
			 (id, provider, model, capability, unit_class, day, month,
			  estimated_units, estimated_cost_micros, rate_card_version,
			  attempt_token, status, expires_at, created_at, updated_at, terminal_at)
			 VALUES (?, 'google-vertex', 'gemini-2.5-flash', 'generate_structured',
			  'tokens', '2026-08-22', '2026-08', 1, 1, 'spec', 'atomic-attempt',
			  'released', ?, ?, ?, ?)`,
		).bind(atomicReservationId, now, now, now, now).run();
		dirty = await removalGate(env);
		expect(dirty.clean).toBe(false);
		expect(dirty.counts.nonterminal_google_atomic_runs).toBeGreaterThanOrEqual(1);

		await env.DB.prepare(
			"UPDATE ai_provider_reservations SET status = 'ambiguous_charged', ambiguous_reason = 'provider_outcome_unknown' WHERE id = ?",
		).bind(atomicReservationId).run();
		expect((await removalGate(env)).counts.nonterminal_google_atomic_runs).toBe(0);

		await env.DB.prepare(
			"UPDATE ai_provider_reservations SET status = 'settled', ambiguous_reason = NULL WHERE id = ?",
		).bind(atomicReservationId).run();
		expect((await removalGate(env)).counts.nonterminal_google_atomic_runs).toBe(0);

		await env.DB.prepare("DELETE FROM ai_provider_reservations WHERE id = ?").bind(atomicReservationId).run();
		expect((await removalGate(env)).counts.nonterminal_google_atomic_runs).toBe(0);

		// An exhausted interrupted row has no legal reclaim left and is terminal.
		await env.DB.prepare(
			`INSERT INTO ai_provider_reservations
			 (id, provider, model, capability, unit_class, day, month,
			  estimated_units, estimated_cost_micros, rate_card_version,
			  attempt_token, status, expires_at, created_at, updated_at, terminal_at)
			 VALUES (?, 'google-vertex', 'gemini-2.5-flash', 'generate_structured',
			  'tokens', '2026-08-22', '2026-08', 1, 1, 'spec', 'atomic-attempt',
			  'released', ?, ?, ?, ?)`,
		).bind(atomicReservationId, now, now, now, now).run();
		await env.DB.prepare(
			"UPDATE semantic_atom_capture_runs SET attempts = ? WHERE id = ?",
		).bind(ATOMIC_CAPTURE_MAX_ATTEMPTS, runId).run();
		expect((await removalGate(env)).counts.nonterminal_google_atomic_runs).toBe(0);
		await env.DB.prepare("DELETE FROM ai_provider_reservations WHERE id IN (?, ?)")
			.bind(reservationId, atomicReservationId).run();
	});

	it("finds Google in any nested route even when the top-level extraction provider is Workers AI", async () => {
		await emergencyDisable(env, { actorUserId: "removal-pin-test" });
		const { runId } = await seedPinnedRun({
			pin: {
				v: 1,
				routes: {
					extract: { provider: "workers-ai", model: "@cf/qwen/qwen3-30b-a3b-fp8" },
					edges: { provider: "google-vertex", model: "gemini-2.5-flash" },
				},
				shadow: null,
			},
		});
		const { runId: modelOnlyRunId } = await seedPinnedRun({
			pin: {
				v: 1,
				routes: {
					extract: { provider: "workers-ai", model: null },
					digest: { provider: "workers-ai", model: "gemini-2.5-flash-lite" },
				},
				shadow: null,
			},
		});

		const gate = await removalGate(env);
		expect(gate.clean).toBe(false);
		expect(gate.counts.nonterminal_google_runs).toBeGreaterThanOrEqual(2);
		await env.DB.prepare("DELETE FROM extraction_runs WHERE id = ?").bind(runId).run();
		await env.DB.prepare("DELETE FROM extraction_runs WHERE id = ?").bind(modelOnlyRunId).run();
	});

	it("finds a running sampled Google shadow even before its outbox row exists", async () => {
		await emergencyDisable(env, { actorUserId: "removal-running-shadow-test" });
		const { runId } = await seedPinnedRun({
			pin: {
				v: 1,
				routes: { extract: { provider: "workers-ai", model: null } },
				shadow: { provider: "google-vertex", model: "gemini-2.5-flash", sampled: true },
			},
		});

		const gate = await removalGate(env);
		expect(gate.clean).toBe(false);
		expect(gate.counts.nonterminal_google_runs).toBeGreaterThanOrEqual(1);
		expect(gate.counts.pending_google_shadow_jobs).toBe(0);
		await env.DB.prepare("DELETE FROM extraction_runs WHERE id = ?").bind(runId).run();
	});

	it("blocks a terminal sampled Google pin until reconciliation writes a removal marker", async () => {
		await emergencyDisable(env, { actorUserId: "removal-terminal-shadow-test" });
		const { runId } = await seedPinnedRun({
			status: "wrote",
			pin: {
				v: 1,
				routes: { extract: { provider: "workers-ai", model: null } },
				shadow: { provider: "google-vertex", model: "gemini-2.5-flash", sampled: true },
			},
		});

		const before = await removalGate(env);
		expect(before.clean).toBe(false);
		expect(before.counts.reconcilable_google_shadow_runs).toBeGreaterThanOrEqual(1);

		expect(await reconcileShadowJobs(env, { limit: 10 })).toBeGreaterThanOrEqual(1);
		expect(await env.DB.prepare(
			"SELECT status FROM ai_shadow_jobs WHERE primary_run_id = ?",
		).bind(runId).first()).toEqual({ status: "cancelled_removed" });
		expect((await removalGate(env)).clean).toBe(true);
	});

	it("a clean removal gate is a durable fence against shadow resurrection", async () => {
		await emergencyDisable(env, { actorUserId: "removal-reconcile-fence-test" });
		const { runId } = await seedPinnedRun({
			status: "wrote",
			pin: {
				v: 1,
				routes: { extract: { provider: "workers-ai", model: null } },
				// Malformed legacy shape: the provider id was lost, but the concrete
				// Google model remains. It is still removal-fenced.
				shadow: { provider: "workers-ai", model: "gemini-2.5-flash", sampled: true },
			},
		});
		await reconcileShadowJobs(env, { limit: 10 });
		expect((await removalGate(env)).clean).toBe(true);

		// Even if a terminal marker is later removed, the durable disabled
		// override makes reconciliation recreate only a terminal removal marker,
		// never executable provider work.
		await env.DB.prepare("DELETE FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).run();
		expect(await reconcileShadowJobs(env, { limit: 10 })).toBeGreaterThanOrEqual(1);
		expect(await env.DB.prepare(
			"SELECT status FROM ai_shadow_jobs WHERE id = ?",
		).bind(await shadowJobId(runId)).first()).toEqual({ status: "cancelled_removed" });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_shadow_jobs WHERE primary_run_id = ? AND status IN ('pending', 'running')",
		).bind(runId).first()).toEqual({ n: 0 });
	});

	it("fences a stale isolate between reservation and invocation when emergency disable wins", async () => {
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO ai_provider_overrides (provider, disabled, updated_at)
			 VALUES ('google-vertex', 0, ?)
			 ON CONFLICT(provider) DO UPDATE SET disabled=0, updated_at=excluded.updated_at`,
		).bind(now).run();
		const reservation = await reserveSpend(env, {
			provider: "google-vertex",
			model: "gemini-2.5-flash-lite",
			capability: "generate_structured",
			inputs: { messages: [{ role: "user", content: "health" }] },
			reservationId: `stale-isolate-${crypto.randomUUID()}`,
			now,
		});
		expect(reservation).toBeTruthy();

		await emergencyDisable(env, { actorUserId: "removal-race-test" });
		const invoking = await markReservationInvoking(env, reservation, { now: now + 1 });
		expect(invoking.applied).toBe(false);
		expect((await releaseReservation(env, reservation, now + 1)).applied).toBe(true);
		const row = await env.DB.prepare(
			"SELECT status FROM ai_provider_reservations WHERE id = ?",
		).bind(reservation.id).first();
		expect(row.status).toBe("released");
		expect((await removalGate(env)).clean).toBe(true);
	});
});
