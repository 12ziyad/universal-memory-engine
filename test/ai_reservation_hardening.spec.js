import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	assertNoActiveProviderInvocation,
	finishProviderCall,
	markReservationInvoking,
	providerAdmission as providerAdmissionRaw,
	reapExpiredReservations,
	recordProviderOutcome,
	releaseReservation,
	reserveSpend as reserveSpendRaw,
	resetProviderBudgetForTests,
	scrubProviderReservationLifecycle,
	settleReservation,
} from "../src/ai/provider_budget.js";
import {
	providerFailureIsDefinitelyUnbilled,
	providerUsageForAccounting,
} from "../src/ai/dispatch.js";
import { estimateCostFromRateSnapshot, googleRateSnapshot, RATE_CARD_VERSION } from "../src/ai/rate_cards.js";

const PROVIDER = "google-vertex";
const MODEL = "gemini-2.5-flash";
const INPUTS = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
const TEST_ACCEPTED_AT = 1_800_000_000_000;

function testLifecycle(reservationId, acceptedAt = TEST_ACCEPTED_AT) {
	return {
		memoryUserId: "provider-hardening-memory",
		acceptedAt,
		scope: "provider_test",
		scopeId: reservationId,
	};
}

function reserveSpend(testEnv, input) {
	return reserveSpendRaw(testEnv, {
		...input,
		lifecycle: input.lifecycle ?? testLifecycle(input.reservationId, input.now ?? TEST_ACCEPTED_AT),
	});
}

function providerAdmission(testEnv, provider, capability, call = {}, now = Date.now()) {
	const reservationId = call.meta?.reservationId;
	return providerAdmissionRaw(testEnv, provider, capability, {
		...call,
		...(provider === PROVIDER && reservationId && !call.lifecycle
			? { lifecycle: testLifecycle(reservationId, now) }
			: {}),
	}, now);
}

function budgetEnv(overrides = {}) {
	return Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
		GCP_SERVICE_ACCOUNT: "{}",
		GCP_PROJECT_ID: "test-project",
		GOOGLE_DAILY_GEN_TOKENS: "10000000",
		GOOGLE_DAILY_EMBED_TOKENS: "10000000",
		GOOGLE_DAILY_RANK_UNITS: "100000",
		GOOGLE_MONTHLY_COST_MICROS: "1000000000",
		...overrides,
	});
}

async function reservationRow(id) {
	return env.DB.prepare("SELECT * FROM ai_provider_reservations WHERE id = ?").bind(id).first();
}

beforeEach(() => resetProviderBudgetForTests());

describe("stable logical-operation ownership", () => {
	it("fails closed without a stable operation id", async () => {
		const admission = await providerAdmission(budgetEnv(), PROVIDER, "generate_structured", {
			model: MODEL,
			inputs: INPUTS,
			meta: {},
		});
		expect(admission).toEqual({ allowed: false, reason: "missing_operation_id" });
		const missingProject = await providerAdmission(
			budgetEnv({ GCP_PROJECT_ID: undefined }),
			PROVIDER,
			"generate_structured",
			{ model: MODEL, inputs: INPUTS, meta: { reservationId: crypto.randomUUID() } },
		);
		expect(missingProject).toEqual({ allowed: false, reason: "no_credentials" });
	});

	it("rejects unpriced, moving, and capability-mismatched models at admission before budget mutation", async () => {
		const now = Date.parse("2099-12-31T12:00:00.000Z");
		const attempts = [
			["gemini-future-ultra", "generate_structured", "model_rate_unpriced"],
			["gemini-2.5-flash-latest", "generate_structured", "model_rate_unpriced"],
			["gemini-embedding-001", "generate_structured", "model_capability_mismatch"],
		];
		const ids = [];
		for (const [model, capability, reason] of attempts) {
			const reservationId = crypto.randomUUID();
			ids.push(reservationId);
			await expect(providerAdmission(budgetEnv(), PROVIDER, capability, {
				model,
				inputs: INPUTS,
				meta: { reservationId },
			}, now)).resolves.toEqual({ allowed: false, reason });
		}

		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_provider_reservations WHERE id IN (?, ?, ?)",
		).bind(...ids).first("n")).toBe(0);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_provider_daily_totals WHERE day = '2099-12-31' AND provider = ?",
		).bind(PROVIDER).first("n")).toBe(0);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_provider_monthly_costs WHERE month = '2099-12' AND provider = ?",
		).bind(PROVIDER).first("n")).toBe(0);
	});

	it("allows exactly the INSERT winner to own a concurrent duplicate", async () => {
		const id = crypto.randomUUID();
		const calls = await Promise.allSettled([
			reserveSpend(budgetEnv(), { provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS, reservationId: id }),
			reserveSpend(budgetEnv(), { provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS, reservationId: id }),
		]);
		expect(calls.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejection = calls.find((result) => result.status === "rejected");
		expect(rejection.reason).toMatchObject({ code: "operation_in_progress" });
		const row = await reservationRow(id);
		const totals = await env.DB.prepare(
			"SELECT reserved_units FROM ai_provider_daily_totals WHERE day=? AND provider=? AND unit_class=?",
		).bind(row.day, PROVIDER, "gen_tokens").first();
		expect(Number(totals.reserved_units)).toBe(Number(row.estimated_units));
	});

	it("rejects estimate and retry-policy mismatches as operation-id conflicts", async () => {
		const id = crypto.randomUUID();
		await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: id, maxAttempts: 2,
		});
		await expect(reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured",
			inputs: { ...INPUTS, max_tokens: 101 }, reservationId: id, maxAttempts: 2,
		})).rejects.toMatchObject({ code: "operation_id_conflict" });
		await expect(reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured",
			inputs: INPUTS, reservationId: id, maxAttempts: 3,
		})).rejects.toMatchObject({ code: "operation_id_conflict" });
	});
});

describe("pinned accounting and conservative terminal states", () => {
	it("rejects any reservation without an exact capability-matched immutable rate card", async () => {
		const deniedIds = [];
		for (const model of ["gemini-future-ultra", "gemini-2.5-flash-latest"]) {
			const reservationId = crypto.randomUUID();
			deniedIds.push(reservationId);
			await expect(reserveSpend(budgetEnv(), {
				provider: PROVIDER, model, capability: "generate_structured", inputs: INPUTS,
				reservationId,
			})).rejects.toMatchObject({ code: "model_rate_unpriced" });
		}
		const mismatchId = crypto.randomUUID();
		deniedIds.push(mismatchId);
		await expect(reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: "gemini-embedding-001", capability: "generate_structured", inputs: INPUTS,
			reservationId: mismatchId,
		})).rejects.toMatchObject({ code: "model_capability_mismatch" });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_provider_reservations WHERE id IN (?, ?, ?)",
		).bind(...deniedIds).first("n")).toBe(0);
	});

	it("pins the verified Ranking API price per 100-document query", () => {
		const rate = googleRateSnapshot("semantic-ranker-default-004", "rank_units");
		expect(rate).toMatchObject({ version: RATE_CARD_VERSION, rankPer100Micros: 1000 });
		expect(estimateCostFromRateSnapshot(rate, { records: 1 })).toBe(1000);
		expect(estimateCostFromRateSnapshot(rate, { records: 100 })).toBe(1000);
		expect(estimateCostFromRateSnapshot(rate, { records: 101 })).toBe(2000);
	});

	it("stores a concrete rate snapshot and settles from D1 truth, not a mutated handle", async () => {
		const reservation = await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(), maxAttempts: 3,
		});
		const stored = await reservationRow(reservation.id);
		expect(stored).toMatchObject({
			model: MODEL,
			capability: "generate_structured",
			unit_class: "gen_tokens",
			input_rate_per_million_micros: 300000,
			output_rate_per_million_micros: 2500000,
			max_attempts: 3,
		});
		expect(Number(stored.estimated_units)).toBe(Number(stored.base_estimated_units) * 3);
		expect((await markReservationInvoking(env, reservation)).applied).toBe(true);

		// A caller-side mutation cannot reprice or under-release the D1 ledger.
		reservation.inputRatePerMillionMicros = 0;
		reservation.outputRatePerMillionMicros = 0;
		reservation.estimatedUnits = 1;
		reservation.estimatedCostMicros = 0;
		await settleReservation(env, reservation, { inputTokens: 10, outputTokens: 5 });
		const terminal = await reservationRow(reservation.id);
		expect(terminal.status).toBe("settled");
		expect(Number(terminal.actual_units)).toBe(15);
		expect(Number(terminal.actual_cost_micros)).toBe(16);
	});

	it("charges the full reservation for missing usage, but releases a proven non-200", async () => {
		const ambiguous = await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(), maxAttempts: 3,
		});
		await markReservationInvoking(env, ambiguous);
		await finishProviderCall(env, PROVIDER, { reservation: ambiguous }, {
			ok: true, usageKnown: false, ambiguousReason: "usage_missing",
		});
		const ambiguousRow = await reservationRow(ambiguous.id);
		expect(ambiguousRow.status).toBe("ambiguous_charged");
		expect(Number(ambiguousRow.actual_units)).toBe(Number(ambiguousRow.estimated_units));
		expect(Number(ambiguousRow.actual_cost_micros)).toBe(Number(ambiguousRow.estimated_cost_micros));

		const explicit503 = { status: 503, retryable: true };
		expect(providerFailureIsDefinitelyUnbilled(explicit503, "provider_unavailable")).toBe(true);
		expect(providerFailureIsDefinitelyUnbilled({ status: 0 }, "provider_unavailable")).toBe(false);
		expect(providerFailureIsDefinitelyUnbilled({ status: 0 }, "provider_misconfigured")).toBe(true);
		expect(providerFailureIsDefinitelyUnbilled({ status: 200 }, "provider_bad_response")).toBe(false);
		const unbilled = await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(), maxAttempts: 3,
		});
		await markReservationInvoking(env, unbilled);
		await finishProviderCall(env, PROVIDER, { reservation: unbilled }, {
			ok: false,
			errorClass: "provider_unavailable",
			definitelyNotCharged: providerFailureIsDefinitelyUnbilled(explicit503, "provider_unavailable"),
		});
		expect((await reservationRow(unbilled.id)).status).toBe("released");
	});

	it("conservatively charges an explicit Google 504 because upstream completion is unknowable", async () => {
		const gatewayTimeout = { status: 504, retryable: false };
		expect(providerFailureIsDefinitelyUnbilled(gatewayTimeout, "timeout")).toBe(false);
		const reservation = await reserveSpend(budgetEnv(), {
			provider: PROVIDER,
			model: MODEL,
			capability: "generate_structured",
			inputs: INPUTS,
			reservationId: crypto.randomUUID(),
			maxAttempts: 1,
		});
		await markReservationInvoking(env, reservation);
		await finishProviderCall(env, PROVIDER, { reservation }, {
			ok: false,
			errorClass: "timeout",
			definitelyNotCharged: providerFailureIsDefinitelyUnbilled(gatewayTimeout, "timeout"),
			ambiguousReason: "timeout_outcome_unknown",
		});
		const row = await reservationRow(reservation.id);
		expect(row.status).toBe("ambiguous_charged");
		expect(Number(row.actual_units)).toBe(Number(row.estimated_units));
		expect(Number(row.actual_cost_micros)).toBe(Number(row.estimated_cost_micros));
	});

	it.each([
		[400, "provider_bad_request", true, "released"],
		[401, "auth_expired", true, "released"],
		[403, "provider_misconfigured", true, "released"],
		[404, "provider_bad_request", true, "released"],
		[429, "rate_limited", true, "released"],
		[500, "provider_unavailable", true, "released"],
		[503, "provider_unavailable", true, "released"],
		[408, "provider_bad_request", false, "ambiguous_charged"],
		[499, "provider_bad_request", false, "ambiguous_charged"],
		[422, "provider_bad_request", false, "ambiguous_charged"],
	])("settles HTTP %i according to explicit billing evidence", async (status, errorClass, definitelyUnbilled, expectedStatus) => {
		const providerError = { status, retryable: false };
		const testProvider = `${PROVIDER}-http-${status}`;
		expect(providerFailureIsDefinitelyUnbilled(providerError, errorClass)).toBe(definitelyUnbilled);

		const reservation = await reserveSpend(budgetEnv(), {
			provider: testProvider,
			model: MODEL,
			capability: "generate_structured",
			inputs: INPUTS,
			reservationId: crypto.randomUUID(),
			maxAttempts: 1,
		});
		await markReservationInvoking(env, reservation);
		await finishProviderCall(env, testProvider, { reservation }, {
			ok: false,
			errorClass,
			definitelyNotCharged: providerFailureIsDefinitelyUnbilled(providerError, errorClass),
			ambiguousReason: `http_${status}_outcome_unknown`,
		});

		const row = await reservationRow(reservation.id);
		expect(row.status).toBe(expectedStatus);
		if (expectedStatus === "ambiguous_charged") {
			expect(Number(row.actual_units)).toBe(Number(row.estimated_units));
			expect(Number(row.actual_cost_micros)).toBe(Number(row.estimated_cost_micros));
		}
	});

	it("includes thought tokens exactly once in terminal usage", () => {
		expect(providerUsageForAccounting("generate_structured", INPUTS, {
			usage: { prompt_tokens: 10, completion_tokens: 5, thoughts_tokens: 7, total_tokens: 22 },
		})).toEqual({ inputTokens: 10, outputTokens: 12, records: null, actualUnits: 22, usageKnown: true });
		expect(providerUsageForAccounting("generate_structured", INPUTS, {
			usage: { prompt_tokens: 10, completion_tokens: 5, thoughts_tokens: 7, total_tokens: 30 },
		}).outputTokens).toBe(20);
	});

	it("keeps an invoking row reapable when settlement cannot update its ledger", async () => {
		const reservation = await reserveSpend(budgetEnv(), {
			provider: "google-test-ledger", model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(),
		});
		await markReservationInvoking(env, reservation);
		await env.DB.prepare(
			"DELETE FROM ai_provider_daily_totals WHERE day=? AND provider=? AND unit_class=?",
		).bind(reservation.day, reservation.provider, reservation.unitClass).run();
		await expect(finishProviderCall(env, reservation.provider, { reservation }, {
			ok: true, usageKnown: true, inputTokens: 1, outputTokens: 1, actualUnits: 2,
		})).rejects.toThrow();
		expect((await reservationRow(reservation.id)).status).toBe("invoking");
	});
});

describe("distributed breaker and crash recovery", () => {
	it("never lets a stalled caller resurrect an expired reservation", async () => {
		const now = 1_800_000_000_000;
		const reservation = await reserveSpend(budgetEnv(), {
			provider: PROVIDER,
			model: MODEL,
			capability: "generate_structured",
			inputs: INPUTS,
			reservationId: crypto.randomUUID(),
			now,
		});
		const stored = await reservationRow(reservation.id);
		const afterExpiry = Number(stored.expires_at) + 1;
		expect((await markReservationInvoking(env, reservation, { now: afterExpiry })).applied).toBe(false);
		expect((await reservationRow(reservation.id)).status).toBe("reserved");
		// The normal admission failure path performs this release. Assert it stays
		// possible while the provider invocation itself remained fenced off.
		expect((await releaseReservation(env, reservation, afterExpiry)).applied).toBe(true);
		expect((await reservationRow(reservation.id)).status).toBe("released");
	});

	it("opens globally and grants exactly one half-open probe lease", async () => {
		const base = 1_800_000_000_000;
		await Promise.all([
			recordProviderOutcome(env, PROVIDER, false, "billing", base),
			recordProviderOutcome(env, PROVIDER, false, "billing", base + 1),
		]);
		let health = await env.DB.prepare("SELECT * FROM ai_provider_health WHERE provider=?").bind(PROVIDER).first();
		expect(health.state).toBe("open");
		expect(Number(health.billing_failures)).toBeGreaterThanOrEqual(2);
		const blocked = await providerAdmission(budgetEnv(), PROVIDER, "generate_structured", {
			model: MODEL, inputs: INPUTS, meta: { reservationId: crypto.randomUUID() },
		}, base + 10);
		expect(blocked).toEqual({ allowed: false, reason: "breaker_open" });

		const probeAt = Number(health.cooldown_until) + 1;
		const probes = await Promise.all([
			providerAdmission(budgetEnv(), PROVIDER, "generate_structured", {
				model: MODEL, inputs: INPUTS, meta: { reservationId: crypto.randomUUID() },
			}, probeAt),
			providerAdmission(budgetEnv(), PROVIDER, "generate_structured", {
				model: MODEL, inputs: INPUTS, meta: { reservationId: crypto.randomUUID() },
			}, probeAt),
		]);
		const owner = probes.find((probe) => probe.allowed);
		expect(probes.filter((probe) => probe.allowed)).toHaveLength(1);
		expect(probes.find((probe) => !probe.allowed)?.reason).toBe("breaker_probe_in_flight");
		// A Google logical call can legitimately still be alive after 90 seconds.
		// The distributed probe lease must cover the full bounded retry window.
		const stillBlocked = await providerAdmission(budgetEnv(), PROVIDER, "generate_structured", {
			model: MODEL, inputs: INPUTS, meta: { reservationId: crypto.randomUUID() },
		}, probeAt + 90_001);
		expect(stillBlocked).toEqual({ allowed: false, reason: "breaker_probe_in_flight" });
		await finishProviderCall(env, PROVIDER, owner, {
			ok: true, usageKnown: true, inputTokens: 1, outputTokens: 1, actualUnits: 2, now: probeAt + 90_002,
		});
		health = await env.DB.prepare("SELECT state, probe_token FROM ai_provider_health WHERE provider=?").bind(PROVIDER).first();
		expect(health).toMatchObject({ state: "closed", probe_token: null });
	});

	it("concurrent reapers count only CAS-winning transitions", async () => {
		const now = Date.now();
		const reserved = await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(), now,
		});
		const invoking = await reserveSpend(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured", inputs: INPUTS,
			reservationId: crypto.randomUUID(), now,
		});
		await markReservationInvoking(env, invoking, { now });
		await env.DB.prepare(
			"UPDATE ai_provider_reservations SET expires_at=1 WHERE id IN (?, ?)",
		).bind(reserved.id, invoking.id).run();
		const counts = await Promise.all([
			reapExpiredReservations(env, { limit: 10, now: now + 1 }),
			reapExpiredReservations(env, { limit: 10, now: now + 1 }),
		]);
		expect(counts[0] + counts[1]).toBe(2);
		expect((await reservationRow(reserved.id)).status).toBe("released");
		const invokedRow = await reservationRow(invoking.id);
		expect(invokedRow.status).toBe("ambiguous_charged");
		expect(Number(invokedRow.actual_units)).toBe(Number(invokedRow.estimated_units));
	});
});

describe("primary provider lifecycle linearization", () => {
	it("fences an equal-millisecond erase before invocation and invokes zero times", async () => {
		const memoryUserId = `primary-erase-first-${crypto.randomUUID()}`;
		const acceptedAt = 1_800_000_100_000;
		const reservationId = crypto.randomUUID();
		const reservation = await reserveSpendRaw(budgetEnv(), {
			provider: PROVIDER,
			model: MODEL,
			capability: "generate_structured",
			inputs: INPUTS,
			reservationId,
			now: acceptedAt,
			lifecycle: {
				memoryUserId,
				acceptedAt,
				scope: "provider_test",
				scopeId: reservationId,
			},
		});
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at) VALUES (?, ?, ?)",
		).bind(memoryUserId, acceptedAt, acceptedAt).run();
		let providerInvocations = 0;
		const claimed = await markReservationInvoking(env, reservation, { now: acceptedAt });
		if (claimed.applied) providerInvocations += 1;
		expect(claimed.applied).toBe(false);
		expect(providerInvocations).toBe(0);
	});

	it("makes invoke-first erase wait through lease expiry until conservative retirement", async () => {
		const memoryUserId = `primary-invoke-first-${crypto.randomUUID()}`;
		const acceptedAt = Date.now();
		const reservationId = crypto.randomUUID();
		const reservation = await reserveSpendRaw(budgetEnv(), {
			provider: PROVIDER,
			model: MODEL,
			capability: "generate_structured",
			inputs: INPUTS,
			reservationId,
			now: acceptedAt,
			lifecycle: {
				memoryUserId,
				acceptedAt,
				scope: "provider_test",
				scopeId: reservationId,
			},
		});
		expect((await markReservationInvoking(env, reservation, { now: acceptedAt })).applied).toBe(true);
		await expect(assertNoActiveProviderInvocation(env, { memoryUserId }))
			.rejects.toMatchObject({ code: "provider_invocation_in_flight", retryable: true });
		await env.DB.prepare("UPDATE ai_provider_reservations SET expires_at = ? WHERE id = ?")
			.bind(acceptedAt - 1, reservation.id).run();
		await expect(assertNoActiveProviderInvocation(env, { memoryUserId }))
			.rejects.toMatchObject({ code: "provider_invocation_in_flight" });
		expect(await reapExpiredReservations(env, { now: acceptedAt + 1, limit: 10 })).toBe(1);
		await expect(assertNoActiveProviderInvocation(env, { memoryUserId })).resolves.toBeUndefined();
		await scrubProviderReservationLifecycle(env, { memoryUserId });
		const row = await reservationRow(reservation.id);
		expect(row).toMatchObject({
			status: "ambiguous_charged",
			memory_user_id: null,
			accepted_at: null,
			scope_id: null,
		});
	});

	it("atomically rejects stale project epochs, retention cutoffs, and cancelled save owners", async () => {
		const suffix = crypto.randomUUID().replaceAll("-", "");
		const memoryUserId = `mem_${suffix}`;
		const projectId = `proj_${suffix}`;
		const ownerUserId = `owner_${suffix}`;
		const acceptedAt = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized,
				  is_default, status, lifecycle_state, lifecycle_epoch, created_at, updated_at)
				 VALUES (?, ?, ?, 'Fence project', ?, 0, 'active', 'active', 0, ?, ?)`,
			).bind(projectId, ownerUserId, memoryUserId, `fence-${suffix}`, acceptedAt, acceptedAt),
			env.DB.prepare(
				`INSERT INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			).bind(projectId, memoryUserId, memoryUserId, acceptedAt, acceptedAt),
		]);

		const projectReservationId = crypto.randomUUID();
		const projectReservation = await reserveSpendRaw(budgetEnv(), {
			provider: PROVIDER, model: "semantic-ranker-default-004", capability: "rerank",
			inputs: { query: "q", contexts: ["c"] }, reservationId: projectReservationId,
			now: acceptedAt,
			lifecycle: {
				memoryUserId, accountUserId: ownerUserId, managedProjectId: projectId,
				acceptedAt, scope: "recall", scopeId: projectReservationId,
			},
		});
		await env.DB.prepare(
			"UPDATE managed_projects SET status='archived', lifecycle_state='archiving', lifecycle_epoch=1 WHERE id=?",
		).bind(projectId).run();
		expect((await markReservationInvoking(env, projectReservation, { now: acceptedAt })).applied).toBe(false);

		await env.DB.prepare(
			"UPDATE managed_projects SET status='active', lifecycle_state='active', lifecycle_epoch=2 WHERE id=?",
		).bind(projectId).run();
		const retentionReservationId = crypto.randomUUID();
		const retentionReservation = await reserveSpendRaw(budgetEnv(), {
			provider: PROVIDER, model: "gemini-embedding-001", capability: "embed_query",
			inputs: { text: ["query"] }, reservationId: retentionReservationId,
			now: acceptedAt,
			lifecycle: {
				memoryUserId, accountUserId: ownerUserId, managedProjectId: projectId,
				acceptedAt, scope: "recall", scopeId: retentionReservationId,
			},
		});
		await env.DB.prepare(
			`INSERT INTO retention_fences
			 (project_id, class, cutoff_at, policy_version, created_at, updated_at)
			 VALUES (?, 'semantic_memory', ?, 1, ?, ?)`,
		).bind(projectId, acceptedAt, acceptedAt, acceptedAt).run();
		expect((await markReservationInvoking(env, retentionReservation, { now: acceptedAt })).applied).toBe(false);

		const extractionRunId = `extract_${suffix}`;
		await env.DB.prepare(
			`INSERT INTO extraction_runs
			 (id, user_id, tool_name, status, created_pages_json, created_nodes_json,
			  created_slices_json, created_events_json, created_edges_json,
			  created_candidates_json, updated_objects_json, reinforced_objects_json,
			  skipped_objects_json, created_at, updated_at)
			 VALUES (?, ?, 'ingest', 'running', '[]','[]','[]','[]','[]','[]','[]','[]','[]',?,?)`,
		).bind(extractionRunId, memoryUserId, acceptedAt, acceptedAt).run();
		const saveReservationId = crypto.randomUUID();
		const saveReservation = await reserveSpendRaw(budgetEnv(), {
			provider: PROVIDER, model: MODEL, capability: "generate_structured",
			inputs: INPUTS, reservationId: saveReservationId, now: acceptedAt,
			lifecycle: {
				memoryUserId, accountUserId: ownerUserId, managedProjectId: projectId,
				acceptedAt: acceptedAt + 1, scope: "save", scopeId: extractionRunId,
			},
		});
		await env.DB.prepare("UPDATE extraction_runs SET status='cancelled' WHERE id=?")
			.bind(extractionRunId).run();
		expect((await markReservationInvoking(env, saveReservation, { now: acceptedAt + 1 })).applied).toBe(false);
	});
});
