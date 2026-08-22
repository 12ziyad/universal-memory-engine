/**
 * Non-default-provider spend control: admission, RESERVE/SETTLE accounting,
 * and a circuit breaker. Everything here fails CLOSED for Google — "closed"
 * merely means the router resolves to Workers AI, which is degradation, not
 * outage. (The inverse of the CF neuron breaker, deliberately: tripping THAT
 * halts the product; tripping THIS falls back to the incumbent.)
 *
 * The monetary ceiling is enforced by TRANSACTIONAL reserve-before-call /
 * settle-after-call accounting, not cached counters:
 *
 *   RESERVE = one fenced D1 batch — insert the reservation row (idempotent by
 *   deterministic id; a fresh per-attempt token marks whether THIS attempt's
 *   insert won), increment the daily unit total and monthly cost total only
 *   under that token guard (a retried batch can never double-increment), then
 *   a fence_guard INSERT-SELECT that poisons the whole batch if any touched
 *   ceiling is exceeded post-increment. Admitted ⇔ batch committed ⇔ row and
 *   increments exist exactly once. Crash safety is transactional: totals can
 *   never move without a matching reapable reservation row.
 *
 *   SETTLE/RELEASE = idempotent CAS transitions (reserved→settled|released)
 *   with the totals adjusted under the same token discipline. Expired
 *   reservations are reaped by the cron back to the pool.
 *
 * Unit classes are NOT interchangeable — gen_tokens, embed_tokens and
 * rank_units carry separate daily ceilings; the monthly cost_micros ceiling
 * spans all classes on a pinned rate-card version.
 *
 * Documented maximum overshoot: concurrent in-flight calls × input-estimate
 * error only (output is reserved at worst case). GCP quota clamps remain the
 * last line of defence; GCP budget alerts are informational, never control.
 */

import { utcDayKey } from "../lib/ai_budget.js";
import { estimateGoogleCostMicros, RATE_CARD_VERSION } from "./rate_cards.js";

const DEFAULT_ID = "workers-ai";

const DAILY_UNIT_CEILINGS = Object.freeze({
	gen_tokens: { env: "GOOGLE_DAILY_GEN_TOKENS", fallback: 2_000_000 },
	embed_tokens: { env: "GOOGLE_DAILY_EMBED_TOKENS", fallback: 1_000_000 },
	rank_units: { env: "GOOGLE_DAILY_RANK_UNITS", fallback: 5_000 },
});
const MONTHLY_COST_ENV = "GOOGLE_MONTHLY_COST_MICROS";
const MONTHLY_COST_FALLBACK = 50_000_000; // $50/month

const RESERVATION_TTL_MS = 5 * 60_000;

export function unitClassOf(capability) {
	if (capability === "embed_documents" || capability === "embed_query") return "embed_tokens";
	if (capability === "rerank") return "rank_units";
	return "gen_tokens";
}

function ceilingFor(env, unitClass) {
	const spec = DAILY_UNIT_CEILINGS[unitClass] ?? DAILY_UNIT_CEILINGS.gen_tokens;
	const raw = Number(env?.[spec.env] ?? spec.fallback);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : spec.fallback;
}

function monthlyCostCeiling(env) {
	const raw = Number(env?.[MONTHLY_COST_ENV] ?? MONTHLY_COST_FALLBACK);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MONTHLY_COST_FALLBACK;
}

export function monthKey(now = Date.now()) {
	return utcDayKey(now).slice(0, 7);
}

/** Worst-case unit estimate for a prospective call. Output is reserved at the
 * full requested budget; only the input share can under-estimate. */
export function estimateUnits(capability, inputs) {
	const unitClass = unitClassOf(capability);
	if (unitClass === "rank_units") {
		return { unitClass, units: Math.max(1, Array.isArray(inputs?.contexts) ? inputs.contexts.length : 1), inputTokens: 0, outputTokens: 0 };
	}
	let bytes = 0;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(inputs ?? {})).length;
	} catch {
		bytes = 16_384;
	}
	const inputTokens = Math.ceil(bytes / 4);
	if (unitClass === "embed_tokens") return { unitClass, units: inputTokens, inputTokens, outputTokens: 0 };
	const outputTokens = Number.isFinite(inputs?.max_tokens) ? Math.max(0, inputs.max_tokens) : 4096;
	return { unitClass, units: inputTokens + outputTokens, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Circuit breaker — module state is one global scalar per isolate (no per-user
// data), converged across isolates through a best-effort ai_provider_health
// row written at most every 30s and read through a 60s cache.
// ---------------------------------------------------------------------------

const BREAKER_BASE_COOLDOWN_MS = 120_000;
const BREAKER_MAX_COOLDOWN_MS = 15 * 60_000;
const GENERIC_TRIP = 5;
const BILLING_TRIP = 2;
const HEALTH_WRITE_THROTTLE_MS = 30_000;
const HEALTH_READ_TTL_MS = 60_000;

let breaker = freshBreaker();
let healthCache = { at: 0, row: null };
let lastHealthWrite = 0;

function freshBreaker() {
	return { state: "closed", consecutiveFailures: 0, billingFailures: 0, openedAt: 0, cooldownMs: BREAKER_BASE_COOLDOWN_MS, reason: null, probeInFlight: false };
}

export function resetProviderBudgetForTests() {
	breaker = freshBreaker();
	healthCache = { at: 0, row: null };
	lastHealthWrite = 0;
}

export function breakerSnapshot() {
	return { state: breaker.state, reason: breaker.reason, consecutiveFailures: breaker.consecutiveFailures, openedAt: breaker.openedAt, cooldownMs: breaker.cooldownMs };
}

async function persistHealth(env, now) {
	if (!env?.DB || now - lastHealthWrite < HEALTH_WRITE_THROTTLE_MS) return;
	lastHealthWrite = now;
	try {
		await env.DB.prepare(
			`INSERT INTO ai_provider_health (provider, state, reason, consecutive_failures, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(provider) DO UPDATE SET
				state = excluded.state, reason = excluded.reason,
				consecutive_failures = excluded.consecutive_failures, updated_at = excluded.updated_at`,
		).bind("google-vertex", breaker.state, breaker.reason, breaker.consecutiveFailures, now).run();
	} catch (error) {
		console.warn("ai provider health write failed:", error?.message ?? error);
	}
}

async function readPersistedState(env, now) {
	if (!env?.DB) return null;
	if (healthCache.row !== null && now - healthCache.at < HEALTH_READ_TTL_MS) return healthCache.row;
	try {
		const [health, override] = await env.DB.batch([
			env.DB.prepare("SELECT state, reason, updated_at FROM ai_provider_health WHERE provider = ?").bind("google-vertex"),
			env.DB.prepare("SELECT disabled FROM ai_provider_overrides WHERE provider = ?").bind("google-vertex"),
		]);
		const row = {
			health: health?.results?.[0] ?? null,
			disabled: Number(override?.results?.[0]?.disabled ?? 0) === 1,
		};
		healthCache = { at: now, row };
		return row;
	} catch (error) {
		// Fail CLOSED: an unreadable control surface means no Google spend.
		console.warn("ai provider health read failed:", error?.message ?? error);
		return { unreadable: true };
	}
}

/** Called by dispatch after every non-default provider call. */
export async function recordProviderOutcome(env, providerId, ok, errorClass = null, now = Date.now()) {
	if (providerId === DEFAULT_ID) return;
	if (ok) {
		if (breaker.state !== "closed") console.warn(JSON.stringify({ event: "ai_breaker_closed", provider: providerId }));
		breaker = freshBreaker();
		await persistHealth(env, now);
		return;
	}
	breaker.consecutiveFailures += 1;
	if (errorClass === "billing" || errorClass === "rate_limited") breaker.billingFailures += 1;
	const shouldTrip = breaker.billingFailures >= BILLING_TRIP || breaker.consecutiveFailures >= GENERIC_TRIP;
	if (shouldTrip) {
		const reopening = breaker.state === "half_open" || breaker.state === "open";
		breaker.state = "open";
		breaker.openedAt = now;
		breaker.reason = errorClass ?? "error";
		breaker.cooldownMs = reopening
			? Math.min(breaker.cooldownMs * 2, BREAKER_MAX_COOLDOWN_MS)
			: BREAKER_BASE_COOLDOWN_MS;
		breaker.probeInFlight = false;
		console.warn(JSON.stringify({ event: "ai_breaker_open", provider: providerId, reason: breaker.reason, cooldown_ms: breaker.cooldownMs }));
	}
	await persistHealth(env, now);
}

function breakerAdmits(now) {
	if (breaker.state === "closed") return { allowed: true };
	if (breaker.state === "open") {
		if (now - breaker.openedAt < breaker.cooldownMs) return { allowed: false, reason: "breaker_open" };
		breaker.state = "half_open";
		breaker.probeInFlight = false;
	}
	// half_open: exactly one probe call per isolate at a time.
	if (breaker.probeInFlight) return { allowed: false, reason: "breaker_probe_in_flight" };
	breaker.probeInFlight = true;
	return { allowed: true, probe: true };
}

// ---------------------------------------------------------------------------
// Reserve / settle
// ---------------------------------------------------------------------------

function tokenGuard(reservationId, attemptToken) {
	return `(SELECT attempt_token FROM ai_provider_reservations WHERE id = '${reservationId.replaceAll("'", "''")}') = '${attemptToken.replaceAll("'", "''")}'`;
}

/**
 * The fenced reserve batch. Returns a reservation handle on admit, or null
 * when a ceiling refused it. Throws only on genuine storage failure — which
 * the caller must treat as refusal (fail closed).
 */
export async function reserveSpend(env, {
	provider = "google-vertex",
	model = null,
	capability,
	inputs,
	reservationId,
	now = Date.now(),
}) {
	const { unitClass, units, inputTokens, outputTokens } = estimateUnits(capability, inputs);
	const day = utcDayKey(now);
	const month = monthKey(now);
	const costMicros = estimateGoogleCostMicros({
		model,
		unitClass,
		inputTokens,
		outputTokens,
		records: unitClass === "rank_units" ? units : 0,
	});
	const id = reservationId ?? crypto.randomUUID();
	const attemptToken = crypto.randomUUID();
	const dailyCeiling = ceilingFor(env, unitClass);
	const costCeiling = monthlyCostCeiling(env);
	const expiresAt = now + RESERVATION_TTL_MS;
	const guard = tokenGuard(id, attemptToken);

	try {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO ai_provider_reservations
					(id, provider, unit_class, day, month, estimated_units, estimated_cost_micros,
					 rate_card_version, attempt_token, settle_token, status, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?)
				 ON CONFLICT(id) DO NOTHING`,
			).bind(id, provider, unitClass, day, month, units, costMicros, RATE_CARD_VERSION, attemptToken, expiresAt, now, now),
			env.DB.prepare(
				`INSERT INTO ai_provider_daily_totals (day, provider, unit_class, used_units, reserved_units, updated_at)
				 VALUES (?, ?, ?, 0, CASE WHEN ${guard} THEN ? ELSE 0 END, ?)
				 ON CONFLICT(day, provider, unit_class) DO UPDATE SET
					reserved_units = reserved_units + (CASE WHEN ${guard} THEN excluded.reserved_units ELSE 0 END),
					updated_at = excluded.updated_at`,
			).bind(day, provider, unitClass, units, now),
			env.DB.prepare(
				`INSERT INTO ai_provider_monthly_costs (month, provider, used_cost_micros, reserved_cost_micros, updated_at)
				 VALUES (?, ?, 0, CASE WHEN ${guard} THEN ? ELSE 0 END, ?)
				 ON CONFLICT(month, provider) DO UPDATE SET
					reserved_cost_micros = reserved_cost_micros + (CASE WHEN ${guard} THEN excluded.reserved_cost_micros ELSE 0 END),
					updated_at = excluded.updated_at`,
			).bind(month, provider, costMicros, now),
			// The ceiling fence: if THIS attempt's insert won and any touched
			// ceiling is exceeded post-increment, poison the whole batch.
			env.DB.prepare(
				`INSERT INTO fence_guard (violation)
				 SELECT 1 WHERE ${guard} AND (
					(SELECT used_units + reserved_units FROM ai_provider_daily_totals
					 WHERE day = ? AND provider = ? AND unit_class = ?) > ?
					OR (SELECT used_cost_micros + reserved_cost_micros FROM ai_provider_monthly_costs
					 WHERE month = ? AND provider = ?) > ?
				 )`,
			).bind(day, provider, unitClass, dailyCeiling, month, provider, costCeiling),
		]);
	} catch (error) {
		if (String(error?.message ?? "").includes("fence_guard")) {
			return null; // ceiling refused — batch rolled back, nothing counted
		}
		throw error;
	}

	const row = await env.DB.prepare(
		"SELECT attempt_token, status, estimated_units, estimated_cost_micros, unit_class, day, month FROM ai_provider_reservations WHERE id = ?",
	).bind(id).first();
	if (!row) return null;
	// A pre-existing row (token mismatch) means this operation was already
	// admitted by an earlier attempt: reuse it, never re-count.
	if (row.status !== "reserved") return null; // already settled/released — do not spend again
	return {
		id,
		provider,
		unitClass: row.unit_class,
		day: row.day,
		month: row.month,
		estimatedUnits: Number(row.estimated_units),
		estimatedCostMicros: Number(row.estimated_cost_micros),
	};
}

async function transitionReservation(env, reservation, toStatus, { actualUnits = null, actualCostMicros = null, now = Date.now() } = {}) {
	if (!env?.DB || !reservation?.id) return;
	const settleToken = crypto.randomUUID();
	const escaped = reservation.id.replaceAll("'", "''");
	const settleGuard = `(SELECT settle_token FROM ai_provider_reservations WHERE id = '${escaped}') = '${settleToken.replaceAll("'", "''")}'`;
	const used = toStatus === "settled" ? Math.max(0, Math.round(actualUnits ?? reservation.estimatedUnits)) : 0;
	const usedCost = toStatus === "settled" ? Math.max(0, Math.round(actualCostMicros ?? reservation.estimatedCostMicros)) : 0;
	try {
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE ai_provider_reservations
				 SET status = ?, settle_token = ?, actual_units = ?, actual_cost_micros = ?, updated_at = ?
				 WHERE id = ? AND status = 'reserved'`,
			).bind(toStatus, settleToken, actualUnits, actualCostMicros, now, reservation.id),
			env.DB.prepare(
				`UPDATE ai_provider_daily_totals SET
					reserved_units = MAX(0, reserved_units - (CASE WHEN ${settleGuard} THEN ? ELSE 0 END)),
					used_units = used_units + (CASE WHEN ${settleGuard} THEN ? ELSE 0 END),
					updated_at = ?
				 WHERE day = ? AND provider = ? AND unit_class = ?`,
			).bind(reservation.estimatedUnits, used, now, reservation.day, reservation.provider, reservation.unitClass),
			env.DB.prepare(
				`UPDATE ai_provider_monthly_costs SET
					reserved_cost_micros = MAX(0, reserved_cost_micros - (CASE WHEN ${settleGuard} THEN ? ELSE 0 END)),
					used_cost_micros = used_cost_micros + (CASE WHEN ${settleGuard} THEN ? ELSE 0 END),
					updated_at = ?
				 WHERE month = ? AND provider = ?`,
			).bind(reservation.estimatedCostMicros, usedCost, now, reservation.month, reservation.provider),
		]);
	} catch (error) {
		console.warn("ai reservation transition failed:", error?.message ?? error);
	}
}

/** Settle to provider-reported actuals (re-priced on the reservation's pinned
 * card version by the caller). Idempotent: a repeat no-ops on the CAS. */
export async function settleReservation(env, reservation, { actualUnits, actualCostMicros, now = Date.now() } = {}) {
	return transitionReservation(env, reservation, "settled", { actualUnits, actualCostMicros, now });
}

/** Return an unused reservation to the pool. */
export async function releaseReservation(env, reservation, now = Date.now()) {
	return transitionReservation(env, reservation, "released", { now });
}

/** Cron duty: expired `reserved` rows are crashes — release them. Bounded. */
export async function reapExpiredReservations(env, { limit = 25, now = Date.now() } = {}) {
	if (!env?.DB) return 0;
	const rows = await env.DB.prepare(
		`SELECT id, provider, unit_class, day, month, estimated_units, estimated_cost_micros
		 FROM ai_provider_reservations WHERE status = 'reserved' AND expires_at < ? LIMIT ?`,
	).bind(now, limit).all();
	let reaped = 0;
	for (const row of rows?.results ?? []) {
		await transitionReservation(env, {
			id: row.id,
			provider: row.provider,
			unitClass: row.unit_class,
			day: row.day,
			month: row.month,
			estimatedUnits: Number(row.estimated_units),
			estimatedCostMicros: Number(row.estimated_cost_micros),
		}, "released", { now });
		reaped += 1;
	}
	return reaped;
}

// ---------------------------------------------------------------------------
// Admission — one answer covering kill switch, override, credentials, breaker
// and the fenced reservation. Never throws; every failure refuses.
// ---------------------------------------------------------------------------

export async function providerAdmission(env, providerId, capability, call = {}, now = Date.now()) {
	if (providerId === DEFAULT_ID) return { allowed: true };
	try {
		if (String(env?.AI_ROUTING_KILL ?? "") === "1") return { allowed: false, reason: "kill" };
		if (providerId === "google-vertex" && !env?.GCP_SERVICE_ACCOUNT) return { allowed: false, reason: "no_credentials" };

		const persisted = await readPersistedState(env, now);
		if (persisted?.unreadable) return { allowed: false, reason: "control_unreadable" };
		if (persisted?.disabled) return { allowed: false, reason: "disabled" };
		if (persisted?.health?.state === "open" && Number(persisted.health.updated_at ?? 0) > breaker.openedAt && breaker.state === "closed") {
			// Another isolate tripped the breaker more recently than anything we
			// observed locally — treat the persisted open as authoritative.
			return { allowed: false, reason: "breaker_open_persisted" };
		}

		const gate = breakerAdmits(now);
		if (!gate.allowed) return { allowed: false, reason: gate.reason };

		const reservation = await reserveSpend(env, {
			provider: providerId,
			model: call.model ?? null,
			capability,
			inputs: call.inputs,
			reservationId: call.meta?.reservationId ?? null,
			now,
		}).catch((error) => {
			console.warn("ai spend reserve failed:", error?.message ?? error);
			return null; // storage failure = refusal (fail closed)
		});
		if (!reservation) {
			if (gate.probe) breaker.probeInFlight = false;
			return { allowed: false, reason: "ceiling" };
		}
		return { allowed: true, reservation, probe: Boolean(gate.probe) };
	} catch (error) {
		console.warn("ai provider admission failed:", error?.message ?? error);
		return { allowed: false, reason: "admission_error" };
	}
}

/** Dispatch calls this after the provider returns (or throws). */
export async function finishProviderCall(env, providerId, admission, { ok, errorClass = null, actualUnits = null, actualCostMicros = null } = {}) {
	if (providerId === DEFAULT_ID) return;
	if (admission?.probe) breaker.probeInFlight = false;
	if (admission?.reservation) {
		if (ok) await settleReservation(env, admission.reservation, { actualUnits, actualCostMicros });
		else await releaseReservation(env, admission.reservation);
	}
	await recordProviderOutcome(env, providerId, ok, errorClass);
}
