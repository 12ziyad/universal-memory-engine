/**
 * Durable admission and spend accounting for non-default AI providers.
 *
 * One stable logical-operation id owns one reservation. The INSERT winner is
 * the only caller allowed to cross reserved -> invoking; retries can observe a
 * prior row but can never invoke from it. Provider outcomes then move through
 * the explicit terminal states settled, released (proved unbilled), or
 * ambiguous_charged (billing cannot safely be disproved).
 *
 * D1 is authoritative for both money and breaker state. Every money movement
 * is in one transactional batch and guarded by a reservation CAS token. The
 * breaker cooldown and half-open probe lease also live in D1, so isolates do
 * not each acquire their own probe.
 */

import { utcDayKey } from "../lib/ai_budget.js";
import { estimateCostFromRateSnapshot, googleRateSnapshot } from "./rate_cards.js";

const DEFAULT_ID = "workers-ai";

const DAILY_UNIT_CEILINGS = Object.freeze({
	gen_tokens: { env: "GOOGLE_DAILY_GEN_TOKENS", fallback: 2_000_000 },
	embed_tokens: { env: "GOOGLE_DAILY_EMBED_TOKENS", fallback: 1_000_000 },
	rank_units: { env: "GOOGLE_DAILY_RANK_UNITS", fallback: 5_000 },
});
const MONTHLY_COST_ENV = "GOOGLE_MONTHLY_COST_MICROS";
const MONTHLY_COST_FALLBACK = 50_000_000;
// Must exceed the adapter's full bounded logical call: token exchange, a
// 60-second request, two explicit-response retries, and one 401 re-auth path.
// A shorter lease can admit a second half-open probe while the first is alive.
const RESERVATION_TTL_MS = 6 * 60_000;
const BREAKER_BASE_COOLDOWN_MS = 120_000;
const BREAKER_MAX_COOLDOWN_MS = 15 * 60_000;
const BREAKER_PROBE_LEASE_MS = 6 * 60_000;
const GENERIC_TRIP = 5;
const BILLING_TRIP = 2;
const MAX_OPERATION_ID_LENGTH = 256;
const MAX_RESERVED_ATTEMPTS = 10;

let lastBreaker = freshBreaker();

function freshBreaker() {
	return {
		state: "closed",
		reason: null,
		consecutiveFailures: 0,
		billingFailures: 0,
		openedAt: 0,
		cooldownMs: BREAKER_BASE_COOLDOWN_MS,
		cooldownUntil: 0,
		probeLeaseUntil: 0,
	};
}

function budgetError(code, message = code) {
	return Object.assign(new Error(message), { code, aiErrorClass: "provider_refused" });
}

function changesOf(result) {
	return Number(result?.meta?.changes ?? result?.changes ?? 0) || 0;
}

function boundedInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(number)));
}

function stableOperationId(value) {
	if (typeof value !== "string" || !value || value !== value.trim()) return null;
	if (value.length > MAX_OPERATION_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
	return value;
}

function lifecycleId(value) {
	return stableOperationId(value);
}

function lifecycleTimestamp(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizeLifecycle(input = {}) {
	return {
		memoryUserId: lifecycleId(input?.memoryUserId ?? input?.memory_user_id),
		accountUserId: lifecycleId(input?.accountUserId ?? input?.account_user_id),
		managedProjectId: lifecycleId(input?.managedProjectId ?? input?.managed_project_id),
		projectLifecycleEpoch: Number.isInteger(Number(input?.projectLifecycleEpoch ?? input?.project_lifecycle_epoch))
			? Number(input?.projectLifecycleEpoch ?? input?.project_lifecycle_epoch)
			: null,
		acceptedAt: lifecycleTimestamp(input?.acceptedAt ?? input?.accepted_at),
		scope: lifecycleId(input?.scope),
		scopeId: lifecycleId(input?.scopeId ?? input?.scope_id),
		lifecycleExempt: input?.lifecycleExempt === true || Number(input?.lifecycle_exempt) === 1,
	};
}

function validHealthExemption(lifecycle) {
	return lifecycle.lifecycleExempt === true
		&& lifecycle.scope === "provider_health"
		&& Boolean(lifecycle.scopeId)
		&& lifecycle.memoryUserId == null
		&& lifecycle.accountUserId == null
		&& lifecycle.managedProjectId == null
		&& lifecycle.acceptedAt == null;
}

function completeUserLifecycle(lifecycle) {
	return lifecycle.lifecycleExempt === false
		&& Boolean(lifecycle.memoryUserId)
		&& Boolean(lifecycle.scope)
		&& Boolean(lifecycle.scopeId)
		&& lifecycle.acceptedAt != null;
}

export function unitClassOf(capability) {
	if (capability === "embed_documents" || capability === "embed_query") return "embed_tokens";
	if (capability === "rerank") return "rank_units";
	return "gen_tokens";
}

function ceilingFor(env, unitClass) {
	const spec = DAILY_UNIT_CEILINGS[unitClass] ?? DAILY_UNIT_CEILINGS.gen_tokens;
	return boundedInteger(env?.[spec.env], spec.fallback, 1);
}

function monthlyCostCeiling(env) {
	return boundedInteger(env?.[MONTHLY_COST_ENV], MONTHLY_COST_FALLBACK, 1);
}

export function monthKey(now = Date.now()) {
	return utcDayKey(now).slice(0, 7);
}

/** A UTF-8 byte is a conservative upper bound for one provider token. */
export function estimateUnits(capability, inputs) {
	const unitClass = unitClassOf(capability);
	if (unitClass === "rank_units") {
		return {
			unitClass,
			units: Math.max(1, Array.isArray(inputs?.contexts) ? inputs.contexts.length : 1),
			inputTokens: 0,
			outputTokens: 0,
		};
	}
	let bytes;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(inputs ?? {})).length;
	} catch {
		bytes = 16_384;
	}
	const inputTokens = Math.max(1, bytes);
	if (unitClass === "embed_tokens") return { unitClass, units: inputTokens, inputTokens, outputTokens: 0 };
	const outputTokens = Number.isFinite(inputs?.max_tokens) ? Math.max(0, Math.floor(inputs.max_tokens)) : 4096;
	return { unitClass, units: inputTokens + outputTokens, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// D1-authoritative circuit breaker
// ---------------------------------------------------------------------------

export function resetProviderBudgetForTests() {
	lastBreaker = freshBreaker();
}

export function breakerSnapshot() {
	return { ...lastBreaker };
}

function rememberHealth(row) {
	if (!row) return;
	lastBreaker = {
		state: row.state,
		reason: row.reason ?? null,
		consecutiveFailures: Number(row.consecutive_failures ?? 0),
		billingFailures: Number(row.billing_failures ?? 0),
		openedAt: Number(row.opened_at ?? 0),
		cooldownMs: Number(row.cooldown_ms ?? BREAKER_BASE_COOLDOWN_MS),
		cooldownUntil: Number(row.cooldown_until ?? 0),
		probeLeaseUntil: Number(row.probe_lease_until ?? 0),
	};
}

async function ensureHealthRow(env, providerId, now) {
	if (!env?.DB) throw budgetError("control_unreadable", "provider control database unavailable");
	await env.DB.prepare(
		`INSERT INTO ai_provider_health
			(provider, state, reason, consecutive_failures, updated_at, billing_failures,
			 opened_at, cooldown_ms, cooldown_until, probe_token, probe_lease_until)
		 VALUES (?, 'closed', NULL, 0, ?, 0, NULL, ?, NULL, NULL, NULL)
		 ON CONFLICT(provider) DO NOTHING`,
	).bind(providerId, now, BREAKER_BASE_COOLDOWN_MS).run();
}

async function readHealth(env, providerId) {
	const row = await env.DB.prepare(
		`SELECT state, reason, consecutive_failures, billing_failures, opened_at,
			cooldown_ms, cooldown_until, probe_token, probe_lease_until, updated_at
		 FROM ai_provider_health WHERE provider = ?`,
	).bind(providerId).first();
	rememberHealth(row);
	return row;
}

async function acquireBreakerGate(env, providerId, now) {
	await ensureHealthRow(env, providerId, now);
	const [healthResult, overrideResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT state, reason, consecutive_failures, billing_failures, opened_at,
				cooldown_ms, cooldown_until, probe_token, probe_lease_until, updated_at
			 FROM ai_provider_health WHERE provider = ?`,
		).bind(providerId),
		env.DB.prepare("SELECT disabled FROM ai_provider_overrides WHERE provider = ?").bind(providerId),
	]);
	const health = healthResult?.results?.[0] ?? null;
	rememberHealth(health);
	if (!health) return { allowed: false, reason: "control_unreadable" };
	if (Number(overrideResult?.results?.[0]?.disabled ?? 0) === 1) return { allowed: false, reason: "disabled" };

	if (health.state === "closed") return { allowed: true, healthGate: { kind: "closed", token: null } };
	if (health.state === "open" && Number(health.cooldown_until ?? 0) > now) {
		return { allowed: false, reason: "breaker_open" };
	}
	if (health.state === "half_open" && Number(health.probe_lease_until ?? 0) > now) {
		return { allowed: false, reason: "breaker_probe_in_flight" };
	}
	if (health.state !== "open" && health.state !== "half_open") {
		return { allowed: false, reason: "breaker_invalid_state" };
	}

	const probeToken = crypto.randomUUID();
	const leaseUntil = now + BREAKER_PROBE_LEASE_MS;
	const result = await env.DB.prepare(
		`UPDATE ai_provider_health
		 SET state = 'half_open', probe_token = ?, probe_lease_until = ?, updated_at = ?
		 WHERE provider = ? AND (
			(state = 'open' AND COALESCE(cooldown_until, 0) <= ?)
			OR (state = 'half_open' AND COALESCE(probe_lease_until, 0) <= ?)
		 )`,
	).bind(probeToken, leaseUntil, now, providerId, now, now).run();
	if (changesOf(result) !== 1) return { allowed: false, reason: "breaker_probe_in_flight" };
	lastBreaker = { ...lastBreaker, state: "half_open", probeLeaseUntil: leaseUntil };
	return { allowed: true, probe: true, probeToken, healthGate: { kind: "probe", token: probeToken } };
}

async function abandonProbe(env, providerId, probeToken, now = Date.now()) {
	if (!probeToken || !env?.DB) return;
	await env.DB.prepare(
		`UPDATE ai_provider_health
		 SET state = 'open', probe_token = NULL, probe_lease_until = NULL,
			cooldown_until = ?, updated_at = ?
		 WHERE provider = ? AND state = 'half_open' AND probe_token = ?`,
	).bind(now + 1_000, now, providerId, probeToken).run();
}

/** Atomically records one globally ordered provider outcome. */
export async function recordProviderOutcome(env, providerId, ok, errorClass = null, now = Date.now(), probeToken = null) {
	if (providerId === DEFAULT_ID) return;
	await ensureHealthRow(env, providerId, now);
	if (probeToken) {
		if (ok) {
			await env.DB.prepare(
				`UPDATE ai_provider_health SET
					state = 'closed', reason = NULL, consecutive_failures = 0, billing_failures = 0,
					opened_at = NULL, cooldown_ms = ?, cooldown_until = NULL,
					probe_token = NULL, probe_lease_until = NULL, updated_at = ?
				 WHERE provider = ? AND state = 'half_open' AND probe_token = ?`,
			).bind(BREAKER_BASE_COOLDOWN_MS, now, providerId, probeToken).run();
		} else {
			const billingDelta = errorClass === "billing" || errorClass === "rate_limited" ? 1 : 0;
			await env.DB.prepare(
				`UPDATE ai_provider_health SET
					state = 'open', reason = ?,
					consecutive_failures = consecutive_failures + 1,
					billing_failures = billing_failures + ?, opened_at = ?,
					cooldown_ms = MIN(MAX(COALESCE(cooldown_ms, ?), ?) * 2, ?),
					cooldown_until = ? + MIN(MAX(COALESCE(cooldown_ms, ?), ?) * 2, ?),
					probe_token = NULL, probe_lease_until = NULL, updated_at = ?
				 WHERE provider = ? AND state = 'half_open' AND probe_token = ?`,
			).bind(
				errorClass ?? "error", billingDelta, now,
				BREAKER_BASE_COOLDOWN_MS, BREAKER_BASE_COOLDOWN_MS, BREAKER_MAX_COOLDOWN_MS,
				now, BREAKER_BASE_COOLDOWN_MS, BREAKER_BASE_COOLDOWN_MS, BREAKER_MAX_COOLDOWN_MS,
				now, providerId, probeToken,
			).run();
		}
		await readHealth(env, providerId);
		return;
	}

	if (ok) {
		// A stale in-flight success must never close a breaker another call opened.
		await env.DB.prepare(
			`UPDATE ai_provider_health SET reason = NULL, consecutive_failures = 0,
				billing_failures = 0, updated_at = ?
			 WHERE provider = ? AND state = 'closed'`,
		).bind(now, providerId).run();
	} else {
		const billingDelta = errorClass === "billing" || errorClass === "rate_limited" ? 1 : 0;
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE ai_provider_health SET
					consecutive_failures = consecutive_failures + 1,
					billing_failures = billing_failures + ?, reason = ?, updated_at = ?
				 WHERE provider = ? AND state = 'closed'`,
			).bind(billingDelta, errorClass ?? "error", now, providerId),
			env.DB.prepare(
				`UPDATE ai_provider_health SET
					state = 'open', opened_at = ?, cooldown_ms = ?, cooldown_until = ?,
					probe_token = NULL, probe_lease_until = NULL, updated_at = ?
				 WHERE provider = ? AND state = 'closed'
					AND (consecutive_failures >= ? OR billing_failures >= ?)`,
			).bind(now, BREAKER_BASE_COOLDOWN_MS, now + BREAKER_BASE_COOLDOWN_MS, now, providerId, GENERIC_TRIP, BILLING_TRIP),
		]);
	}
	await readHealth(env, providerId);
}

// ---------------------------------------------------------------------------
// Reserve / invoke / settle
// ---------------------------------------------------------------------------

function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function reservationGuard(id, column, token) {
	return `(SELECT ${column} FROM ai_provider_reservations WHERE id = ${sqlLiteral(id)}) = ${sqlLiteral(token)}`;
}

function normalizeAttempts(value) {
	return boundedInteger(value, 1, 1, MAX_RESERVED_ATTEMPTS);
}

function rowToReservation(row) {
	if (!row) return null;
	return {
		id: row.id,
		provider: row.provider,
		model: row.model,
		capability: row.capability,
		unitClass: row.unit_class,
		day: row.day,
		month: row.month,
		estimatedUnits: Number(row.estimated_units),
		estimatedCostMicros: Number(row.estimated_cost_micros),
		baseEstimatedUnits: Number(row.base_estimated_units),
		baseEstimatedCostMicros: Number(row.base_estimated_cost_micros),
		maxAttempts: Number(row.max_attempts),
		rateCardVersion: row.rate_card_version,
		inputRatePerMillionMicros: Number(row.input_rate_per_million_micros),
		outputRatePerMillionMicros: Number(row.output_rate_per_million_micros),
		rankRatePer100Micros: Number(row.rank_rate_per_100_micros),
		attemptToken: row.attempt_token,
		status: row.status,
		memoryUserId: row.memory_user_id ?? null,
		accountUserId: row.account_user_id ?? null,
		managedProjectId: row.managed_project_id ?? null,
		projectLifecycleEpoch: row.project_lifecycle_epoch == null ? null : Number(row.project_lifecycle_epoch),
		acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
		scope: row.scope ?? null,
		scopeId: row.scope_id ?? null,
		lifecycleExempt: Number(row.lifecycle_exempt ?? 0) === 1,
	};
}

async function readOwnedReservation(env, reservation) {
	if (!env?.DB || !reservation?.id || !reservation?.attemptToken) return null;
	const row = await env.DB.prepare(
		"SELECT * FROM ai_provider_reservations WHERE id = ? AND attempt_token = ?",
	).bind(reservation.id, reservation.attemptToken).first();
	return rowToReservation(row);
}

function sameOperation(row, expected) {
	return row.provider === expected.provider
		&& row.model === expected.model
		&& row.capability === expected.capability
		&& row.unit_class === expected.unitClass
		&& Number(row.base_estimated_units) === expected.baseEstimatedUnits
		&& Number(row.base_estimated_cost_micros) === expected.baseEstimatedCostMicros
		&& Number(row.max_attempts) === expected.maxAttempts
		&& (row.memory_user_id ?? null) === expected.lifecycle.memoryUserId
		&& (row.account_user_id ?? null) === expected.lifecycle.accountUserId
		&& (row.managed_project_id ?? null) === expected.lifecycle.managedProjectId
		&& (row.project_lifecycle_epoch == null ? null : Number(row.project_lifecycle_epoch)) === expected.lifecycle.projectLifecycleEpoch
		&& (row.accepted_at == null ? null : Number(row.accepted_at)) === expected.lifecycle.acceptedAt
		&& (row.scope ?? null) === expected.lifecycle.scope
		&& (row.scope_id ?? null) === expected.lifecycle.scopeId
		&& Number(row.lifecycle_exempt ?? 0) === (expected.lifecycle.lifecycleExempt ? 1 : 0);
}

function existingReservationError(status) {
	if (status === "reserved" || status === "invoking") return "operation_in_progress";
	if (status === "settled") return "operation_already_settled";
	if (status === "released") return "operation_released";
	if (status === "ambiguous_charged") return "operation_ambiguous";
	return "operation_state_unknown";
}

/**
 * Resolve project ownership/epoch from server-owned control-plane rows.  The
 * meter names the memory/project scope, but the reservation snapshots the
 * authoritative project epoch and account owner directly from D1 so a stale
 * worker cannot supply a newer generation by metadata.
 */
async function resolveReservationLifecycle(env, input = {}) {
	const lifecycle = normalizeLifecycle(input);
	if (validHealthExemption(lifecycle)) return lifecycle;
	if (!completeUserLifecycle(lifecycle)) return lifecycle;

	let projectId = lifecycle.managedProjectId;
	if (!projectId && lifecycle.memoryUserId) {
		const memberships = await env.DB.prepare(
			`SELECT DISTINCT pms.project_id
			   FROM project_memory_spaces pms
			  WHERE pms.memory_user_id = ?
			  ORDER BY pms.project_id LIMIT 2`,
		).bind(lifecycle.memoryUserId).all();
		const ids = (memberships?.results ?? []).map((row) => row.project_id).filter(Boolean);
		if (ids.length > 1) throw budgetError(
			"lifecycle_context_ambiguous",
			"the memory space belongs to more than one managed project",
		);
		projectId = ids[0] ?? null;
	}

	if (!projectId) return lifecycle;
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, lifecycle_epoch
		   FROM managed_projects WHERE id = ? LIMIT 1`,
	).bind(projectId).first();
	return {
		...lifecycle,
		managedProjectId: projectId,
		accountUserId: lifecycle.accountUserId ?? project?.owner_user_id ?? null,
		projectLifecycleEpoch: project == null ? null : Number(project.lifecycle_epoch ?? 0),
	};
}

/**
 * Transactionally reserve the worst-case spend for one logical operation.
 * Returns null only for a monetary ceiling refusal; all identity/state
 * conflicts are typed errors so callers cannot mistake them for fresh work.
 */
export async function reserveSpend(env, {
	provider = "google-vertex",
	model = null,
	capability,
	inputs,
	reservationId,
	maxAttempts = 1,
	lifecycle: lifecycleInput = {},
	healthGate = null,
	now = Date.now(),
}) {
	if (!env?.DB) throw budgetError("control_unreadable", "provider budget database unavailable");
	const id = stableOperationId(reservationId);
	if (!id) throw budgetError("missing_operation_id", "a stable reservationId is required");
	const lifecycle = await resolveReservationLifecycle(env, lifecycleInput);
	const { unitClass, units: baseUnits, inputTokens, outputTokens } = estimateUnits(capability, inputs);
	const attempts = normalizeAttempts(maxAttempts);
	const rate = googleRateSnapshot(model, unitClass);
	const concreteModel = rate.model;
	const baseCostMicros = estimateCostFromRateSnapshot(rate, {
		inputTokens,
		outputTokens,
		records: unitClass === "rank_units" ? baseUnits : 0,
	});
	const units = baseUnits * attempts;
	const costMicros = baseCostMicros * attempts;
	const day = utcDayKey(now);
	const month = monthKey(now);
	const attemptToken = crypto.randomUUID();
	const dailyCeiling = ceilingFor(env, unitClass);
	const costCeiling = monthlyCostCeiling(env);
	const expiresAt = now + RESERVATION_TTL_MS;
	const guard = reservationGuard(id, "attempt_token", attemptToken);
	const expected = {
		provider,
		model: concreteModel,
		capability,
		unitClass,
		baseEstimatedUnits: baseUnits,
		baseEstimatedCostMicros: baseCostMicros,
		maxAttempts: attempts,
		lifecycle,
	};

	const columns = `(id, provider, model, capability, unit_class, day, month,
		estimated_units, estimated_cost_micros, rate_card_version,
		input_rate_per_million_micros, output_rate_per_million_micros,
		rank_rate_per_100_micros, base_estimated_units, base_estimated_cost_micros,
		max_attempts, attempt_token,
		memory_user_id, account_user_id, managed_project_id, project_lifecycle_epoch,
		accepted_at, scope, scope_id, lifecycle_exempt,
		settle_token, status, expires_at, created_at, updated_at)`;
	let insert;
	if (healthGate) {
		insert = env.DB.prepare(
			`INSERT INTO ai_provider_reservations ${columns}
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
			        ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?
			 WHERE EXISTS (
				SELECT 1 FROM ai_provider_health WHERE provider = ? AND (
					(? = 'closed' AND state = 'closed') OR
					(? = 'probe' AND state = 'half_open' AND probe_token = ? AND COALESCE(probe_lease_until, 0) >= ?)
				)
				 )
				 AND NOT EXISTS (
					SELECT 1 FROM ai_provider_overrides
					 WHERE provider = ? AND disabled = 1
				 )
				 ON CONFLICT(id) DO NOTHING`,
		).bind(
			id, provider, concreteModel, capability, unitClass, day, month,
			units, costMicros, rate.version, rate.inputPerMillionMicros,
			rate.outputPerMillionMicros, rate.rankPer100Micros, baseUnits,
			baseCostMicros, attempts, attemptToken,
			lifecycle.memoryUserId, lifecycle.accountUserId, lifecycle.managedProjectId,
			lifecycle.projectLifecycleEpoch, lifecycle.acceptedAt, lifecycle.scope,
			lifecycle.scopeId, lifecycle.lifecycleExempt ? 1 : 0,
			expiresAt, now, now,
			provider, healthGate.kind, healthGate.kind, healthGate.token, now,
			provider,
		);
	} else {
		insert = env.DB.prepare(
			`INSERT INTO ai_provider_reservations ${columns}
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
			        ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'reserved', ?, ?, ?
			 WHERE NOT EXISTS (
				SELECT 1 FROM ai_provider_overrides WHERE provider = ? AND disabled = 1
			 )
			 ON CONFLICT(id) DO NOTHING`,
		).bind(
			id, provider, concreteModel, capability, unitClass, day, month,
			units, costMicros, rate.version, rate.inputPerMillionMicros,
			rate.outputPerMillionMicros, rate.rankPer100Micros, baseUnits,
			baseCostMicros, attempts, attemptToken,
			lifecycle.memoryUserId, lifecycle.accountUserId, lifecycle.managedProjectId,
			lifecycle.projectLifecycleEpoch, lifecycle.acceptedAt, lifecycle.scope,
			lifecycle.scopeId, lifecycle.lifecycleExempt ? 1 : 0,
			expiresAt, now, now, provider,
		);
	}

	try {
		await env.DB.batch([
			insert,
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
			// If this INSERT won, exceeding either ceiling poisons and rolls back
			// the entire D1 batch, including the reservation row and increments.
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
		if (String(error?.message ?? "").includes("fence_guard")) return null;
		throw error;
	}

	const row = await env.DB.prepare("SELECT * FROM ai_provider_reservations WHERE id = ?").bind(id).first();
	if (!row) throw budgetError("breaker_state_changed", "provider health changed during reservation");
	if (!sameOperation(row, expected)) throw budgetError("operation_id_conflict", "reservationId belongs to a different operation");
	if (row.attempt_token !== attemptToken) throw budgetError(existingReservationError(row.status));
	if (row.status !== "reserved") throw budgetError(existingReservationError(row.status));
	return rowToReservation(row);
}

function healthGuardSql(provider, healthGate, now) {
	const enabled = `NOT EXISTS (SELECT 1 FROM ai_provider_overrides
		WHERE provider = ${sqlLiteral(provider)} AND disabled = 1)`;
	if (!healthGate) return enabled;
	if (healthGate.kind === "probe") {
		return `${enabled} AND EXISTS (SELECT 1 FROM ai_provider_health WHERE provider = ${sqlLiteral(provider)}
			AND state = 'half_open' AND probe_token = ${sqlLiteral(healthGate.token)}
			AND COALESCE(probe_lease_until, 0) >= ${Number(now)})`;
	}
	return `${enabled} AND EXISTS (SELECT 1 FROM ai_provider_health
		WHERE provider = ${sqlLiteral(provider)} AND state = 'closed')`;
}

function invocationLifecycleGuardSql() {
	return `(
		provider != 'google-vertex'
		OR (
			lifecycle_exempt = 1
			AND scope = 'provider_health'
			AND scope_id IS NOT NULL
			AND memory_user_id IS NULL
			AND account_user_id IS NULL
			AND managed_project_id IS NULL
			AND accepted_at IS NULL
		)
		OR (
			lifecycle_exempt = 0
			AND memory_user_id IS NOT NULL
			AND accepted_at IS NOT NULL
			AND scope IS NOT NULL
			AND scope_id IS NOT NULL
			-- A tie is fenced too: millisecond timestamps never create an
			-- erasure escape hatch; at worst a genuinely new tied operation waits.
			AND NOT EXISTS (
				SELECT 1 FROM deletion_barriers b
				 WHERE b.user_id = ai_provider_reservations.memory_user_id
				   AND b.barrier_at >= ai_provider_reservations.accepted_at
			)
			AND NOT EXISTS (
				SELECT 1 FROM account_erasure_tombstones t
				 WHERE t.user_id = ai_provider_reservations.memory_user_id
				    OR t.user_id = ai_provider_reservations.account_user_id
			)
			AND (
				managed_project_id IS NULL OR EXISTS (
					SELECT 1 FROM managed_projects p
					 WHERE p.id = ai_provider_reservations.managed_project_id
					   AND p.status = 'active'
					   AND (p.lifecycle_state IS NULL OR p.lifecycle_state = 'active')
					   AND p.lifecycle_epoch = ai_provider_reservations.project_lifecycle_epoch
				)
			)
			-- Membership is authoritative even when an older caller omitted an
			-- explicit project id. Any inactive/ambiguous registry row fails closed.
			AND NOT EXISTS (
				SELECT 1 FROM project_memory_spaces pms
				LEFT JOIN managed_projects p ON p.id = pms.project_id
				 WHERE pms.memory_user_id = ai_provider_reservations.memory_user_id
				   AND (
					p.id IS NULL OR pms.state != 'active' OR p.status != 'active'
					OR (p.lifecycle_state IS NOT NULL AND p.lifecycle_state != 'active')
					OR (ai_provider_reservations.managed_project_id IS NOT NULL
						AND p.id != ai_provider_reservations.managed_project_id)
					OR (ai_provider_reservations.project_lifecycle_epoch IS NOT NULL
						AND p.lifecycle_epoch != ai_provider_reservations.project_lifecycle_epoch)
				   )
			)
			-- Retention fences are monotonic. Content accepted at or before a
			-- relevant cutoff may not start an external call after the fence wins.
			AND (
				managed_project_id IS NULL OR NOT EXISTS (
					SELECT 1 FROM retention_fences rf
					 WHERE rf.project_id = ai_provider_reservations.managed_project_id
					   AND rf.class IN ('semantic_memory','source_episodes','playground_transcripts')
					   AND rf.cutoff_at >= ai_provider_reservations.accepted_at
				)
			)
			-- Save children (extract, atomic capture, embedding and rerank) all
			-- inherit this durable owner. Cancellation before admission is final.
			AND (
				scope != 'save' OR EXISTS (
					SELECT 1 FROM extraction_runs er
					 WHERE er.id = ai_provider_reservations.scope_id
					   AND er.user_id = ai_provider_reservations.memory_user_id
					   AND er.status = 'running'
				)
			)
			-- Atomic capture retries outlive their parent extraction run. Their
			-- own durable capture row is therefore the cancellation owner.
			AND (
				scope != 'atomic_capture' OR EXISTS (
					SELECT 1 FROM semantic_atom_capture_runs ar
					 WHERE ar.id = ai_provider_reservations.scope_id
					   AND ar.user_id = ai_provider_reservations.memory_user_id
					   AND ar.status = 'running'
				)
			)
		)
	)`;
}

/** Only the reservation INSERT winner can acquire the provider invocation. */
export async function markReservationInvoking(env, reservation, { healthGate = null, now = Date.now() } = {}) {
	if (!env?.DB || !reservation?.id || !reservation?.attemptToken) return { applied: false };
	const result = await env.DB.prepare(
		`UPDATE ai_provider_reservations SET status = 'invoking', invoked_at = ?, expires_at = ?, updated_at = ?
		 WHERE id = ? AND status = 'reserved' AND attempt_token = ? AND expires_at >= ?
			AND ${healthGuardSql(reservation.provider, healthGate, now)}
			AND ${invocationLifecycleGuardSql()}`,
	).bind(now, now + RESERVATION_TTL_MS, now, reservation.id, reservation.attemptToken, now).run();
	const applied = changesOf(result) === 1;
	if (applied) reservation.status = "invoking";
	return { applied, status: applied ? "invoking" : null };
}

function providerInvocationInFlightError() {
	const error = new Error("A bounded primary provider invocation is still in flight; retry lifecycle cleanup after it settles or is conservatively retired.");
	error.name = "LifecycleFenceError";
	error.code = "provider_invocation_in_flight";
	error.status = 503;
	error.retryable = true;
	return error;
}

/**
 * Destructive lifecycle counterpart to reserved -> invoking.  `invoking`
 * remains blocking even after its lease timestamp: only the conservative
 * reaper may turn an expired, outcome-unknown call into ambiguous_charged.
 */
export async function assertNoActiveProviderInvocation(env, {
	memoryUserId = null,
	accountUserId = null,
	managedProjectId = null,
	acceptedThrough = null,
} = {}) {
	if (!env?.DB) throw budgetError("control_unreadable", "provider lifecycle database unavailable");
	const clauses = [];
	const bindings = [];
	if (memoryUserId) {
		clauses.push("r.memory_user_id = ?");
		bindings.push(memoryUserId);
	}
	if (accountUserId) {
		clauses.push("r.account_user_id = ? OR r.memory_user_id = ?");
		bindings.push(accountUserId, accountUserId);
	}
	if (managedProjectId) {
		clauses.push(`r.managed_project_id = ? OR r.memory_user_id IN (
			SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		)`);
		bindings.push(managedProjectId, managedProjectId);
	}
	if (!clauses.length) return;
	const accepted = acceptedThrough != null && Number.isFinite(Number(acceptedThrough))
		? " AND (r.accepted_at IS NULL OR r.accepted_at <= ?)"
		: "";
	if (accepted) bindings.push(Number(acceptedThrough));
	const row = await env.DB.prepare(
		`SELECT 1 AS active
		   FROM ai_provider_reservations r
		  WHERE r.provider = 'google-vertex'
		    AND r.status = 'invoking'
		    AND r.lifecycle_exempt = 0
		    AND (
		      (${clauses.join(") OR (")})
		      OR r.memory_user_id IS NULL OR r.accepted_at IS NULL
		    )${accepted}
		  LIMIT 1`,
	).bind(...bindings).first();
	if (row) throw providerInvocationInFlightError();
}

/**
 * Remove tenant provenance from non-invoking spend rows after the caller has
 * installed its lifecycle fence and passed assertNoActiveProviderInvocation.
 * Monetary/model/rate evidence is retained. A stale in-memory reservation can
 * no longer cross the lifecycle guard, and an erased operation cannot replay
 * through the ledger with its old tenant fingerprint.
 */
export async function scrubProviderReservationLifecycle(env, {
	memoryUserId = null,
	accountUserId = null,
	managedProjectId = null,
	acceptedThrough = null,
} = {}) {
	if (!env?.DB) throw budgetError("control_unreadable", "provider lifecycle database unavailable");
	const clauses = [];
	const bindings = [];
	if (memoryUserId) {
		clauses.push("memory_user_id = ?");
		bindings.push(memoryUserId);
	}
	if (accountUserId) {
		clauses.push("account_user_id = ? OR memory_user_id = ?");
		bindings.push(accountUserId, accountUserId);
	}
	if (managedProjectId) {
		clauses.push(`managed_project_id = ? OR memory_user_id IN (
			SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		)`);
		bindings.push(managedProjectId, managedProjectId);
	}
	if (!clauses.length) return 0;
	const accepted = acceptedThrough != null && Number.isFinite(Number(acceptedThrough))
		? " AND (accepted_at IS NULL OR accepted_at <= ?)"
		: "";
	if (accepted) bindings.push(Number(acceptedThrough));
	const result = await env.DB.prepare(
		`UPDATE ai_provider_reservations
		    SET memory_user_id = NULL, account_user_id = NULL,
		        managed_project_id = NULL, project_lifecycle_epoch = NULL,
		        accepted_at = NULL, scope = NULL, scope_id = NULL,
		        updated_at = MAX(updated_at, ?)
		  WHERE provider = 'google-vertex'
		    AND lifecycle_exempt = 0
		    AND status != 'invoking'
		    AND ((${clauses.join(") OR (")}))${accepted}`,
	).bind(Date.now(), ...bindings).run();
	return changesOf(result);
}

async function transitionReservation(env, reservation, toStatus, {
	actualUnits = 0,
	actualCostMicros = 0,
	fullReservation = false,
	ambiguousReason = null,
	fromStatuses = ["invoking"],
	now = Date.now(),
} = {}) {
	if (!env?.DB || !reservation?.id || !reservation?.attemptToken) return { applied: false };
	// The D1 row, not a mutable in-memory handle, is monetary truth. This also
	// pins terminal accounting to the concrete model/rates/estimate originally
	// admitted even if a caller accidentally mutates or reuses its JS object.
	const stored = await readOwnedReservation(env, reservation);
	if (!stored) return { applied: false };
	const allowed = fromStatuses.filter((status) => ["reserved", "invoking"].includes(status));
	if (!allowed.length) throw new TypeError("reservation transition has no valid source state");
	const settleToken = crypto.randomUUID();
	const settleGuard = reservationGuard(stored.id, "settle_token", settleToken);
	const used = fullReservation ? stored.estimatedUnits : Math.max(0, Math.round(actualUnits));
	const usedCost = fullReservation ? stored.estimatedCostMicros : Math.max(0, Math.round(actualCostMicros));
	const sources = allowed.map(sqlLiteral).join(", ");
	const estimatedUnits = Math.max(0, Math.round(stored.estimatedUnits));
	const estimatedCost = Math.max(0, Math.round(stored.estimatedCostMicros));

	await env.DB.batch([
		env.DB.prepare(
			`UPDATE ai_provider_reservations
			 SET status = ?, settle_token = ?, actual_units = ?, actual_cost_micros = ?,
				ambiguous_reason = ?, terminal_at = ?, updated_at = ?
			 WHERE id = ? AND attempt_token = ? AND status IN (${sources})`,
		).bind(toStatus, settleToken, used, usedCost, ambiguousReason, now, now, stored.id, stored.attemptToken),
		// Never hide ledger drift with MAX(0). If the row or reserved balance is
		// absent, poison the batch and leave the reservation retryable/reapable.
		env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE ${settleGuard} AND (
				(SELECT COUNT(*) FROM ai_provider_daily_totals
				 WHERE day = ? AND provider = ? AND unit_class = ?) <> 1
				OR COALESCE((SELECT reserved_units FROM ai_provider_daily_totals
				 WHERE day = ? AND provider = ? AND unit_class = ?), -1) < ?
				OR (SELECT COUNT(*) FROM ai_provider_monthly_costs WHERE month = ? AND provider = ?) <> 1
				OR COALESCE((SELECT reserved_cost_micros FROM ai_provider_monthly_costs
				 WHERE month = ? AND provider = ?), -1) < ?
			 )`,
		).bind(
			stored.day, stored.provider, stored.unitClass,
			stored.day, stored.provider, stored.unitClass, estimatedUnits,
			stored.month, stored.provider,
			stored.month, stored.provider, estimatedCost,
		),
		env.DB.prepare(
			`UPDATE ai_provider_daily_totals SET
				reserved_units = reserved_units - ?, used_units = used_units + ?, updated_at = ?
			 WHERE day = ? AND provider = ? AND unit_class = ? AND ${settleGuard}`,
		).bind(estimatedUnits, used, now, stored.day, stored.provider, stored.unitClass),
		env.DB.prepare(
			`UPDATE ai_provider_monthly_costs SET
				reserved_cost_micros = reserved_cost_micros - ?, used_cost_micros = used_cost_micros + ?, updated_at = ?
			 WHERE month = ? AND provider = ? AND ${settleGuard}`,
		).bind(estimatedCost, usedCost, now, stored.month, stored.provider),
	]);
	// D1 batch metadata may report connection-level changes rather than a
	// statement-local CAS count. The unique settle token is definitive evidence
	// that this caller won; concurrent reapers must never both claim success.
	const terminal = await env.DB.prepare(
		"SELECT status, settle_token FROM ai_provider_reservations WHERE id = ?",
	).bind(stored.id).first();
	const applied = terminal?.status === toStatus && terminal?.settle_token === settleToken;
	if (applied) reservation.status = toStatus;
	return { applied, status: applied ? toStatus : null, actualUnits: used, actualCostMicros: usedCost };
}

function pinnedRate(reservation) {
	return {
		version: reservation.rateCardVersion,
		model: reservation.model,
		unitClass: reservation.unitClass,
		inputPerMillionMicros: reservation.inputRatePerMillionMicros,
		outputPerMillionMicros: reservation.outputRatePerMillionMicros,
		rankPer100Micros: reservation.rankRatePer100Micros,
	};
}

/** Settle only from invoking and price actual usage on the stored rate. */
export async function settleReservation(env, reservation, {
	inputTokens = null,
	outputTokens = null,
	records = null,
	actualUnits = null,
	now = Date.now(),
} = {}) {
	const stored = await readOwnedReservation(env, reservation);
	if (!stored) return { applied: false };
	const finalUnits = actualUnits == null
		? (stored.unitClass === "rank_units"
			? Math.max(1, Number(records ?? stored.baseEstimatedUnits ?? 1))
			: Math.max(0, Number(inputTokens ?? 0)) + Math.max(0, Number(outputTokens ?? 0)))
		: Math.max(0, Number(actualUnits));
	const finalCost = estimateCostFromRateSnapshot(pinnedRate(stored), {
		inputTokens: Math.max(0, Number(inputTokens ?? 0)),
		outputTokens: Math.max(0, Number(outputTokens ?? 0)),
		records: Math.max(1, Number(records ?? finalUnits)),
	});
	return transitionReservation(env, stored, "settled", {
		// Provider-reported terminal usage is billing truth. Known non-200
		// retries are not charged; transport ambiguity takes the separate
		// ambiguous_charged path and is never mislabeled as measured usage.
		actualUnits: finalUnits,
		actualCostMicros: finalCost,
		fromStatuses: ["invoking"],
		now,
	});
}

/** Release is legal only when billing is known not to have occurred. */
export async function releaseReservation(env, reservation, now = Date.now()) {
	return transitionReservation(env, reservation, "released", {
		actualUnits: 0,
		actualCostMicros: 0,
		fromStatuses: ["reserved", "invoking"],
		now,
	});
}

/** Conservatively consume the full reservation after an ambiguous outcome. */
export async function markReservationAmbiguous(env, reservation, reason = "provider_outcome_unknown", now = Date.now()) {
	return transitionReservation(env, reservation, "ambiguous_charged", {
		fullReservation: true,
		ambiguousReason: String(reason ?? "provider_outcome_unknown").slice(0, 80),
		fromStatuses: ["invoking"],
		now,
	});
}

/**
 * Expired reservations are recovered with CAS evidence. A never-invoked row is
 * released; an invoking row is charged because the provider outcome is not
 * provably absent. Concurrent reapers count only the winning transition.
 */
export async function reapExpiredReservations(env, { limit = 25, now = Date.now() } = {}) {
	if (!env?.DB) return 0;
	const rows = await env.DB.prepare(
		`SELECT * FROM ai_provider_reservations
		 WHERE status IN ('reserved', 'invoking') AND expires_at < ?
		 ORDER BY expires_at LIMIT ?`,
	).bind(now, boundedInteger(limit, 25, 1, 250)).all();
	let reaped = 0;
	for (const row of rows?.results ?? []) {
		const reservation = rowToReservation(row);
		try {
			const result = row.status === "reserved"
				? await releaseReservation(env, reservation, now)
				: await markReservationAmbiguous(env, reservation, "expired_inflight", now);
			if (result.applied) reaped += 1;
		} catch (error) {
			console.warn(JSON.stringify({
				event: "ai_reservation_reap_failed",
				reservation_id: reservation.id,
				error: String(error?.message ?? error).slice(0, 160),
			}));
		}
	}
	return reaped;
}

// ---------------------------------------------------------------------------
// Admission / finish
// ---------------------------------------------------------------------------

const OPERATION_REFUSALS = new Set([
	"missing_operation_id",
	"operation_id_conflict",
	"operation_in_progress",
	"operation_already_settled",
	"operation_released",
	"operation_ambiguous",
	"operation_state_unknown",
	"lifecycle_context_missing",
	"lifecycle_context_ambiguous",
	"lifecycle_fenced",
	"invoke_claim_unavailable",
]);

export function isOperationRefusal(reason) {
	return OPERATION_REFUSALS.has(reason);
}

export async function providerAdmission(env, providerId, capability, call = {}, now = Date.now()) {
	if (providerId === DEFAULT_ID) return { allowed: true };
	if (String(env?.AI_ROUTING_KILL ?? "") === "1") return { allowed: false, reason: "kill" };
	if (providerId === "google-vertex" && (!env?.GCP_SERVICE_ACCOUNT || !env?.GCP_PROJECT_ID)) {
		return { allowed: false, reason: "no_credentials" };
	}
	const reservationId = stableOperationId(call.meta?.reservationId ?? call.meta?.operationId ?? null);
	if (!reservationId) return { allowed: false, reason: "missing_operation_id" };
	if (typeof call.model !== "string" || !call.model) return { allowed: false, reason: "missing_concrete_model" };
	const lifecycle = normalizeLifecycle(call.lifecycle ?? {});
	if (providerId === "google-vertex"
		&& !validHealthExemption(lifecycle)
		&& !completeUserLifecycle(lifecycle)) {
		return { allowed: false, reason: "lifecycle_context_missing" };
	}

	let gate;
	try {
		gate = await acquireBreakerGate(env, providerId, now);
	} catch (error) {
		console.warn("ai provider health read failed:", error?.message ?? error);
		return { allowed: false, reason: "control_unreadable" };
	}
	if (!gate.allowed) return gate;

	let reservation;
	try {
		reservation = await reserveSpend(env, {
			provider: providerId,
			model: call.model,
			capability,
			inputs: call.inputs,
			reservationId,
			maxAttempts: call.maxAttempts,
			lifecycle,
			healthGate: gate.healthGate,
			now,
		});
	} catch (error) {
		await abandonProbe(env, providerId, gate.probeToken, now).catch(() => {});
		const reason = typeof error?.code === "string" ? error.code : "reserve_unavailable";
		if (reason === "reserve_unavailable") console.warn("ai spend reserve failed:", error?.message ?? error);
		return { allowed: false, reason };
	}
	if (!reservation) {
		await abandonProbe(env, providerId, gate.probeToken, now).catch(() => {});
		return { allowed: false, reason: "ceiling" };
	}

	try {
		const invoking = await markReservationInvoking(env, reservation, { healthGate: gate.healthGate, now });
		if (!invoking.applied) {
			await releaseReservation(env, reservation, now);
			await abandonProbe(env, providerId, gate.probeToken, now).catch(() => {});
			return {
				allowed: false,
				reason: providerId === "google-vertex" && !reservation.lifecycleExempt
					? "lifecycle_fenced"
					: "breaker_state_changed",
			};
		}
	} catch (error) {
		await releaseReservation(env, reservation, now).catch(() => {});
		await abandonProbe(env, providerId, gate.probeToken, now).catch(() => {});
		console.warn("ai reservation invoke claim failed:", error?.message ?? error);
		return { allowed: false, reason: "invoke_claim_unavailable" };
	}
	return { allowed: true, reservation, probe: Boolean(gate.probe), probeToken: gate.probeToken ?? null };
}

/** Dispatch calls this exactly once after an invocation returns or throws. */
export async function finishProviderCall(env, providerId, admission, {
	ok,
	errorClass = null,
	usageKnown = true,
	ambiguousOutcome = false,
	definitelyNotCharged = false,
	inputTokens = null,
	outputTokens = null,
	records = null,
	actualUnits = null,
	ambiguousReason = null,
	now = Date.now(),
} = {}) {
	if (providerId === DEFAULT_ID) return { applied: false };
	let transition = null;
	let accountingError = null;
	try {
		if (admission?.reservation) {
			if (ok && usageKnown && !ambiguousOutcome) {
				transition = await settleReservation(env, admission.reservation, {
					inputTokens, outputTokens, records, actualUnits, now,
				});
			} else if (!ok && definitelyNotCharged) {
				transition = await releaseReservation(env, admission.reservation, now);
			} else {
				transition = await markReservationAmbiguous(
					env,
					admission.reservation,
					ambiguousReason ?? (ok ? (ambiguousOutcome ? "retry_outcome_unknown" : "usage_missing") : errorClass ?? "provider_outcome_unknown"),
					now,
				);
			}
		}
	} catch (error) {
		accountingError = error;
	}

	let breakerError = null;
	// A repeated terminal callback must not increment the breaker twice. A D1
	// transition error is different: still record the provider outcome so a
	// failing accounting plane cannot leave the provider breaker optimistic.
	if (transition?.applied !== false || accountingError) {
		try {
			await recordProviderOutcome(env, providerId, Boolean(ok), errorClass, now, admission?.probeToken ?? null);
		} catch (error) {
			breakerError = error;
		}
	}
	if (accountingError) throw accountingError;
	if (breakerError) throw breakerError;
	return transition ?? { applied: false };
}
