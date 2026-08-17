/**
 * Project-wide dashboard analytics.
 *
 * This module is intentionally metadata-only. It never selects labels, memory
 * text, receipt detail/summary, job payloads, or raw AI usage. The selected
 * managed project is the security boundary: its immutable root memory owner
 * plus memory spaces explicitly registered as active for that project.
 */

import {
	aiBudget,
	countWritesThisMonth,
	derivedNeurons,
	startOfNextUtcMonth,
} from "../lib/ai_budget.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = Object.freeze({ "1d": 1, "7d": 7, "30d": 30, "90d": 90 });
const ACTIVE_JOB_STATUSES = Object.freeze(["awaiting_source", "queued", "staged", "processing"]);
const TERMINAL_JOB_STATUSES = new Set(["enriched", "failed", "completed"]);
const JOB_TYPES = Object.freeze(["extract", "mcp_enrich"]);
const STUCK_AFTER_MS = 15 * 60 * 1000;

export class DashboardRangeError extends Error {
	constructor(range) {
		super("range must be one of 1d, 7d, 30d, or 90d");
		this.name = "DashboardRangeError";
		this.code = "invalid_dashboard_range";
		this.status = 400;
		this.range = range;
	}
}

function number(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value) {
	if (value == null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function roundRatio(numerator, denominator) {
	if (!denominator) return null;
	return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function compareNullableStrings(a, b) {
	return String(a ?? "").localeCompare(String(b ?? ""));
}

function rows(result) {
	return Array.isArray(result?.results) ? result.results : [];
}

function periodBounds(range, now) {
	const days = RANGE_DAYS[range];
	if (!days) throw new DashboardRangeError(range);
	const duration = days * DAY_MS;
	const currentFrom = now - duration;
	const previousFrom = currentFrom - duration;
	return {
		days,
		current: { from_ms: currentFrom, to_ms: now },
		previous: { from_ms: previousFrom, to_ms: currentFrom },
	};
}

function emptyOperationPeriod(bounds) {
	return {
		operations: {
			total: 0,
			saves: 0,
			recalls: 0,
			saved_objects: 0,
			skipped: 0,
			matched: null,
			matched_operations: 0,
			matched_samples: 0,
			outcomes: [],
			lanes: [],
		},
		daily: Array.from({ length: bounds.days }, (_, index) => ({
			from_ms: bounds.from_ms + index * DAY_MS,
			to_ms: bounds.from_ms + (index + 1) * DAY_MS,
			total: 0,
			saves: 0,
			recalls: 0,
			saved_objects: 0,
			skipped: 0,
			matched: null,
			matched_operations: 0,
			matched_samples: 0,
		})),
		latency_ms: {
			p50: null,
			p95: null,
			p99: null,
			samples: 0,
			eligible: 0,
			coverage: null,
		},
	};
}

function operationPeriods(bounds, receiptRows, dailyRows, latencyRows) {
	const periods = {
		current: emptyOperationPeriod({ ...bounds.current, days: bounds.days }),
		previous: emptyOperationPeriod({ ...bounds.previous, days: bounds.days }),
	};
	const outcomes = { current: new Map(), previous: new Map() };
	const lanes = { current: new Map(), previous: new Map() };

	for (const row of receiptRows) {
		const period = row.period === "previous" ? "previous" : row.period === "current" ? "current" : null;
		if (!period) continue;
		const count = number(row.count);
		const isRecall = row.source === "recall";
		const target = periods[period].operations;
		target.total += count;
		target[isRecall ? "recalls" : "saves"] += count;
		target.saved_objects += number(row.saved_objects);
		target.skipped += number(row.skipped);
		const matchedSamples = number(row.matched_samples);
		if (matchedSamples > 0) {
			target.matched = number(target.matched) + number(row.matched);
			target.matched_operations += number(row.matched_operations);
			target.matched_samples += matchedSamples;
		}

		const outcome = row.outcome == null ? null : String(row.outcome);
		outcomes[period].set(outcome, (outcomes[period].get(outcome) ?? 0) + count);
		const laneKey = JSON.stringify([row.source ?? null, row.source_mode ?? null]);
		const lane = lanes[period].get(laneKey) ?? {
			source: row.source ?? null,
			source_mode: row.source_mode ?? null,
			count: 0,
		};
		lane.count += count;
		lanes[period].set(laneKey, lane);
	}

	for (const period of ["current", "previous"]) {
		periods[period].operations.outcomes = [...outcomes[period]].map(([outcome, count]) => ({ outcome, count }))
			.sort((a, b) => compareNullableStrings(a.outcome, b.outcome));
		periods[period].operations.lanes = [...lanes[period].values()]
			.sort((a, b) => compareNullableStrings(a.source, b.source)
				|| compareNullableStrings(a.source_mode, b.source_mode));
	}

	for (const row of dailyRows) {
		const period = row.period === "previous" ? "previous" : row.period === "current" ? "current" : null;
		const bucket = Number(row.bucket_index);
		if (!period || !Number.isInteger(bucket) || bucket < 0 || bucket >= bounds.days) continue;
		const matchedSamples = number(row.matched_samples);
		periods[period].daily[bucket] = {
			...periods[period].daily[bucket],
			total: number(row.total),
			saves: number(row.saves),
			recalls: number(row.recalls),
			saved_objects: number(row.saved_objects),
			skipped: number(row.skipped),
			matched: matchedSamples > 0 ? number(row.matched) : null,
			matched_operations: number(row.matched_operations),
			matched_samples: matchedSamples,
		};
	}

	const latencyByPeriod = new Map(latencyRows.map((row) => [String(row.period), row]));
	for (const period of ["current", "previous"]) {
		const row = latencyByPeriod.get(period);
		const samples = number(row?.samples);
		const eligible = periods[period].operations.total;
		periods[period].latency_ms = {
			p50: nullableNumber(row?.p50),
			p95: nullableNumber(row?.p95),
			p99: nullableNumber(row?.p99),
			samples,
			eligible,
			coverage: roundRatio(samples, eligible),
		};
	}

	return periods;
}

function cancellationKind(row) {
	const kind = String(row.cancellation ?? "none");
	return ["cancelled_by_delete", "cancelled_by_retention"].includes(kind) ? kind : null;
}

function buildJobs(now, groupedRows, periodRows, recentRows) {
	const knownCurrent = Object.fromEntries(ACTIVE_JOB_STATUSES.map((status) => [status, 0]));
	const statusCounts = [];
	const currentStatusCounts = [];
	const terminal = {
		enriched: 0,
		completed: 0,
		genuine_failures: 0,
		cancelled_by_delete: 0,
		cancelled_by_retention: 0,
	};
	let total = 0;
	let backlogDepth = 0;
	let oldestPendingAt = null;
	let stuck = 0;
	let jobsWithRetries = 0;
	let maxAttempts = 0;

	for (const row of groupedRows) {
		const status = String(row.status ?? "unknown");
		const count = number(row.count);
		const cancelled = cancellationKind(row);
		total += count;
		statusCounts.push({ status, cancellation: cancelled, count });
		jobsWithRetries += number(row.jobs_with_retries);
		maxAttempts = Math.max(maxAttempts, number(row.max_attempts));

		if (!TERMINAL_JOB_STATUSES.has(status)) {
			backlogDepth += count;
			currentStatusCounts.push({ status, count });
			if (status in knownCurrent) knownCurrent[status] += count;
			const oldest = nullableNumber(row.oldest_created_at);
			if (oldest != null) oldestPendingAt = Math.min(oldestPendingAt ?? oldest, oldest);
			stuck += number(row.stuck_count);
		}
		if (status === "enriched") terminal.enriched += count;
		else if (status === "completed") terminal.completed += count;
		else if (status === "failed") {
			if (cancelled) terminal[cancelled] += count;
			else terminal.genuine_failures += count;
		}
	}

	statusCounts.sort((a, b) => compareNullableStrings(a.status, b.status)
		|| compareNullableStrings(a.cancellation, b.cancellation));
	currentStatusCounts.sort((a, b) => compareNullableStrings(a.status, b.status));

	const emptyPeriod = () => ({
		accepted: 0,
		settled: 0,
		enriched: 0,
		completed: 0,
		genuine_failures: 0,
		cancelled_by_delete: 0,
		cancelled_by_retention: 0,
		accepted_jobs_with_retries: 0,
	});
	const periods = { current: emptyPeriod(), previous: emptyPeriod() };
	for (const row of periodRows) {
		const period = row.period === "previous" ? "previous" : row.period === "current" ? "current" : null;
		if (!period) continue;
		for (const key of Object.keys(periods[period])) periods[period][key] = number(row[key]);
	}

	const recent = recentRows.slice(0, 50).map((row) => ({
		id: String(row.id),
		type: String(row.type),
		status: String(row.status),
		attempts: number(row.attempts),
		created_at: nullableNumber(row.created_at),
		updated_at: nullableNumber(row.updated_at),
		completed_at: nullableNumber(row.completed_at),
		cancel_reason: row.cancel_reason == null || row.cancel_reason === "none" ? null : String(row.cancel_reason),
		source: row.source == null ? null : String(row.source),
	}));

	return {
		as_of_ms: now,
		current: {
			statuses: knownCurrent,
			status_counts: currentStatusCounts,
			backlog_depth: backlogDepth,
			oldest_pending_at_ms: oldestPendingAt,
			oldest_pending_age_ms: oldestPendingAt == null ? null : Math.max(0, now - oldestPendingAt),
			stuck_over_15m: stuck,
			stuck_after_ms: STUCK_AFTER_MS,
		},
		all_time: {
			total,
			status_counts: statusCounts,
			terminal,
			jobs_with_retries: jobsWithRetries,
			max_attempts: maxAttempts,
		},
		periods,
		recent,
		recent_limit: 50,
		recent_truncated: recentRows.length > 50,
	};
}

function emptyAiPeriod() {
	return {
		calls: 0,
		successful_calls: 0,
		failed_calls: 0,
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0,
		token_reported_calls: 0,
		measured_neurons: 0,
		measured_neuron_calls: 0,
		derived_neuron_top_up: 0,
		total_neurons_estimate: 0,
	};
}

function shapeAiPeriod(row) {
	if (!row) return emptyAiPeriod();
	const calls = number(row.calls);
	const measuredCalls = number(row.measured_neuron_calls);
	const measured = number(row.measured_neurons);
	const inputReportedCalls = number(row.input_reported_calls);
	const outputReportedCalls = number(row.output_reported_calls);
	const totalReportedCalls = number(row.token_reported_calls);
	const input = inputReportedCalls > 0 ? number(row.input_tokens) : null;
	const output = outputReportedCalls > 0 ? number(row.output_tokens) : null;
	const totalTokens = totalReportedCalls > 0 ? number(row.total_tokens) : null;
	const unreportedCalls = Math.max(0, calls - measuredCalls);
	const topUp = unreportedCalls > 0
		? Math.max(0, derivedNeurons(row.unmeasured_input_tokens, row.unmeasured_output_tokens))
		: 0;
	return {
		calls,
		successful_calls: number(row.successful_calls),
		failed_calls: number(row.failed_calls),
		input_tokens: input,
		output_tokens: output,
		total_tokens: totalTokens,
		token_reported_calls: totalReportedCalls,
		measured_neurons: measured,
		measured_neuron_calls: measuredCalls,
		derived_neuron_top_up: Math.round(topUp * 1_000_000) / 1_000_000,
		total_neurons_estimate: Math.round((measured + topUp) * 1_000_000) / 1_000_000,
	};
}

async function accountAiAnalytics(env, accountUserId, bounds, now) {
	if (!accountUserId) {
		return { scope: "account", available: false, current: null, previous: null, quota: null };
	}
	try {
		const result = await env.DB.prepare(
			`WITH periods(period, from_ms, to_ms) AS (
				VALUES ('current', ?3, ?4), ('previous', ?2, ?3)
			)
			SELECT p.period,
			       COUNT(a.id) AS calls,
			       COALESCE(SUM(CASE WHEN a.ok = 1 THEN 1 ELSE 0 END), 0) AS successful_calls,
			       COALESCE(SUM(CASE WHEN a.ok = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
			       COALESCE(SUM(a.input_tokens), 0) AS input_tokens,
			       COALESCE(SUM(a.output_tokens), 0) AS output_tokens,
			       COALESCE(SUM(a.total_tokens), 0) AS total_tokens,
			       COALESCE(SUM(CASE WHEN a.input_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS input_reported_calls,
			       COALESCE(SUM(CASE WHEN a.output_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS output_reported_calls,
			       COALESCE(SUM(CASE WHEN a.total_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS token_reported_calls,
			       COALESCE(SUM(a.neurons), 0) AS measured_neurons,
			       COALESCE(SUM(CASE WHEN a.neurons IS NOT NULL THEN 1 ELSE 0 END), 0) AS measured_neuron_calls,
			       COALESCE(SUM(CASE WHEN a.neurons IS NULL THEN a.input_tokens ELSE 0 END), 0) AS unmeasured_input_tokens,
			       COALESCE(SUM(CASE WHEN a.neurons IS NULL THEN a.output_tokens ELSE 0 END), 0) AS unmeasured_output_tokens
			  FROM periods p
			  LEFT JOIN ai_calls a
			    ON a.account_user_id = ?1
			   AND a.created_at >= p.from_ms AND a.created_at < p.to_ms
			 GROUP BY p.period`,
		).bind(accountUserId, bounds.previous.from_ms, bounds.current.from_ms, bounds.current.to_ms).all();
		const byPeriod = new Map(rows(result).map((row) => [String(row.period), row]));
		const used = await countWritesThisMonth(env, { accountUserId }, now);
		const limit = aiBudget(env).monthlyWrites;
		return {
			scope: "account",
			available: true,
			current: shapeAiPeriod(byPeriod.get("current")),
			previous: shapeAiPeriod(byPeriod.get("previous")),
			quota: {
				unit: "ai_writes",
				scope: "account",
				period: "calendar_month_utc",
				used,
				limit,
				remaining: Math.max(0, limit - used),
				resets_at: new Date(startOfNextUtcMonth(now)).toISOString(),
				capped: used >= limit,
			},
		};
	} catch (error) {
		console.warn(JSON.stringify({ event: "dashboard_ai_unavailable", error: String(error?.message ?? error) }));
		return { scope: "account", available: false, current: null, previous: null, quota: null };
	}
}

function currentSignals(jobs, ai, now) {
	const signals = [];
	if (jobs.current.stuck_over_15m > 0) {
		signals.push({ type: "jobs_stuck", code: "jobs_stuck", severity: "warning", count: jobs.current.stuck_over_15m, observed_at_ms: now });
	}
	if (jobs.current.backlog_depth > 0) {
		signals.push({ type: "jobs_backlog", code: "jobs_backlog", severity: "info", count: jobs.current.backlog_depth, observed_at_ms: now });
	}
	if (ai.available && ai.quota?.capped) {
		signals.push({ type: "ai_quota_capped", code: "ai_quota_capped", severity: "warning", count: 1, observed_at_ms: now });
	}
	return signals;
}

/**
 * Aggregate the exact selected managed project. `now` is injectable so range
 * boundary and zero-fill tests are deterministic.
 */
export async function projectDashboard(env, {
	projectId,
	memoryOwnerUserId,
	accountUserId,
	range = "7d",
	now = Date.now(),
} = {}) {
	if (!projectId || !memoryOwnerUserId) throw new Error("managed project scope is required");
	const at = number(now, Date.now());
	const bounds = periodBounds(range, at);
	const scopeCte = `scope_users(user_id) AS (
		SELECT ?1
		UNION
		SELECT memory_user_id
		  FROM project_memory_spaces
		 WHERE project_id = ?2
		   AND memory_owner_user_id = ?1
		   AND state = 'active'
	)`;

	const inventoryStatement = env.DB.prepare(
		`WITH ${scopeCte}
		 SELECT
		   (SELECT COUNT(*) FROM scope_users) AS memory_spaces,
		   (SELECT COUNT(*) FROM nodes n JOIN scope_users s ON s.user_id = n.user_id
		     WHERE n.deleted_at IS NULL AND n.archived_at IS NULL AND n.suppressed_at IS NULL) AS nodes,
		   (SELECT COUNT(*) FROM memory_pages p JOIN scope_users s ON s.user_id = p.user_id
		     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.suppressed_at IS NULL) AS pages,
		   (SELECT COUNT(*) FROM slices x JOIN scope_users s ON s.user_id = x.user_id
		     WHERE x.deleted_at IS NULL) AS slices,
		   (SELECT COUNT(*) FROM events e JOIN scope_users s ON s.user_id = e.user_id
		     WHERE e.deleted_at IS NULL) AS events,
		   (SELECT COUNT(*) FROM edges g JOIN scope_users s ON s.user_id = g.user_id
		     WHERE g.deleted_at IS NULL) AS edges`,
	).bind(memoryOwnerUserId, projectId);

	const receiptStatement = env.DB.prepare(
		`WITH ${scopeCte}
		 SELECT CASE WHEN r.created_at >= ?4 THEN 'current' ELSE 'previous' END AS period,
		        r.source, r.source_mode, r.outcome, COUNT(*) AS count,
		        COALESCE(SUM(r.saved_total), 0) AS saved_objects,
		        COALESCE(SUM(r.skipped), 0) AS skipped,
		        COALESCE(SUM(r.matched), 0) AS matched,
		        COALESCE(SUM(CASE WHEN r.matched > 0 THEN 1 ELSE 0 END), 0) AS matched_operations,
		        COUNT(r.matched) AS matched_samples
		   FROM receipts r JOIN scope_users s ON s.user_id = r.user_id
		  WHERE r.created_at >= ?3 AND r.created_at < ?5
		  GROUP BY period, r.source, r.source_mode, r.outcome`,
	).bind(memoryOwnerUserId, projectId, bounds.previous.from_ms, bounds.current.from_ms, bounds.current.to_ms);

	const dailyStatement = env.DB.prepare(
		`WITH ${scopeCte}, ranged AS (
			SELECT CASE WHEN r.created_at >= ?4 THEN 'current' ELSE 'previous' END AS period,
			       CAST((r.created_at - CASE WHEN r.created_at >= ?4 THEN ?4 ELSE ?3 END) / ${DAY_MS} AS INTEGER) AS bucket_index,
			       r.source, r.saved_total, r.skipped, r.matched
			  FROM receipts r JOIN scope_users s ON s.user_id = r.user_id
			 WHERE r.created_at >= ?3 AND r.created_at < ?5
		)
		SELECT period, bucket_index, COUNT(*) AS total,
		       SUM(CASE WHEN source = 'recall' THEN 0 ELSE 1 END) AS saves,
		       SUM(CASE WHEN source = 'recall' THEN 1 ELSE 0 END) AS recalls,
		       COALESCE(SUM(saved_total), 0) AS saved_objects,
		       COALESCE(SUM(skipped), 0) AS skipped,
		       COALESCE(SUM(matched), 0) AS matched,
		       COALESCE(SUM(CASE WHEN matched > 0 THEN 1 ELSE 0 END), 0) AS matched_operations,
		       COUNT(matched) AS matched_samples
		  FROM ranged GROUP BY period, bucket_index`,
	).bind(memoryOwnerUserId, projectId, bounds.previous.from_ms, bounds.current.from_ms, bounds.current.to_ms);

	const latencyStatement = env.DB.prepare(
		`WITH ${scopeCte}, samples AS (
			SELECT CASE WHEN r.created_at >= ?4 THEN 'current' ELSE 'previous' END AS period,
			       r.latency_ms
			  FROM receipts r JOIN scope_users s ON s.user_id = r.user_id
			 WHERE r.created_at >= ?3 AND r.created_at < ?5
			   AND r.latency_ms IS NOT NULL AND r.latency_ms >= 0
		), ranked AS (
			SELECT period, latency_ms,
			       ROW_NUMBER() OVER (PARTITION BY period ORDER BY latency_ms) AS rank,
			       COUNT(*) OVER (PARTITION BY period) AS samples
			  FROM samples
		)
		SELECT period, MAX(samples) AS samples,
		       MAX(CASE WHEN rank = CAST((samples * 50 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p50,
		       MAX(CASE WHEN rank = CAST((samples * 95 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p95,
		       MAX(CASE WHEN rank = CAST((samples * 99 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p99
		  FROM ranked GROUP BY period`,
	).bind(memoryOwnerUserId, projectId, bounds.previous.from_ms, bounds.current.from_ms, bounds.current.to_ms);

	const jobsStatement = env.DB.prepare(
		`WITH ${scopeCte}
		 SELECT j.status,
		        CASE
		          WHEN j.status = 'failed' AND (j.error = 'cancelled_by_delete' OR substr(j.error, 1, 20) = 'cancelled_by_delete:') THEN 'cancelled_by_delete'
		          WHEN j.status = 'failed' AND (j.error = 'cancelled_by_retention' OR substr(j.error, 1, 23) = 'cancelled_by_retention:') THEN 'cancelled_by_retention'
		          ELSE 'none'
		        END AS cancellation,
		        COUNT(*) AS count,
		        MIN(j.created_at) AS oldest_created_at,
		        SUM(CASE WHEN j.attempts > 0 THEN 1 ELSE 0 END) AS jobs_with_retries,
		        MAX(COALESCE(j.attempts, 0)) AS max_attempts,
		        SUM(CASE WHEN j.status NOT IN ('enriched', 'failed', 'completed') AND j.created_at < ?3 THEN 1 ELSE 0 END) AS stuck_count
		   FROM memory_jobs j JOIN scope_users s ON s.user_id = j.user_id
		  WHERE j.type IN ('${JOB_TYPES[0]}', '${JOB_TYPES[1]}')
		  GROUP BY j.status, cancellation`,
	).bind(memoryOwnerUserId, projectId, at - STUCK_AFTER_MS);

	const jobPeriodsStatement = env.DB.prepare(
		`WITH ${scopeCte}, periods(period, from_ms, to_ms) AS (
			VALUES ('current', ?4, ?5), ('previous', ?3, ?4)
		), jobs AS (
			SELECT j.* FROM memory_jobs j JOIN scope_users s ON s.user_id = j.user_id
			 WHERE j.type IN ('${JOB_TYPES[0]}', '${JOB_TYPES[1]}')
		)
		SELECT p.period,
		       COALESCE(SUM(CASE WHEN j.created_at >= p.from_ms AND j.created_at < p.to_ms THEN 1 ELSE 0 END), 0) AS accepted,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms THEN 1 ELSE 0 END), 0) AS settled,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms AND j.status = 'enriched' THEN 1 ELSE 0 END), 0) AS enriched,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms AND j.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms AND j.status = 'failed'
		                          AND NOT (COALESCE(j.error, '') = 'cancelled_by_delete' OR substr(COALESCE(j.error, ''), 1, 20) = 'cancelled_by_delete:')
		                          AND NOT (COALESCE(j.error, '') = 'cancelled_by_retention' OR substr(COALESCE(j.error, ''), 1, 23) = 'cancelled_by_retention:') THEN 1 ELSE 0 END), 0) AS genuine_failures,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms AND j.status = 'failed'
		                          AND (j.error = 'cancelled_by_delete' OR substr(j.error, 1, 20) = 'cancelled_by_delete:') THEN 1 ELSE 0 END), 0) AS cancelled_by_delete,
		       COALESCE(SUM(CASE WHEN j.completed_at >= p.from_ms AND j.completed_at < p.to_ms AND j.status = 'failed'
		                          AND (j.error = 'cancelled_by_retention' OR substr(j.error, 1, 23) = 'cancelled_by_retention:') THEN 1 ELSE 0 END), 0) AS cancelled_by_retention,
		       COALESCE(SUM(CASE WHEN j.created_at >= p.from_ms AND j.created_at < p.to_ms AND j.attempts > 0 THEN 1 ELSE 0 END), 0) AS accepted_jobs_with_retries
		  FROM periods p
		  LEFT JOIN jobs j
		    ON (j.created_at >= p.from_ms AND j.created_at < p.to_ms)
		    OR (j.completed_at >= p.from_ms AND j.completed_at < p.to_ms)
		 GROUP BY p.period`,
	).bind(memoryOwnerUserId, projectId, bounds.previous.from_ms, bounds.current.from_ms, bounds.current.to_ms);

	const recentJobsStatement = env.DB.prepare(
		`WITH ${scopeCte}
		 SELECT j.id, j.type, j.status, j.attempts,
		        j.created_at, j.updated_at, j.completed_at,
		        CASE
		          WHEN j.status = 'failed' AND (j.error = 'cancelled_by_delete' OR substr(j.error, 1, 20) = 'cancelled_by_delete:') THEN 'cancelled_by_delete'
		          WHEN j.status = 'failed' AND (j.error = 'cancelled_by_retention' OR substr(j.error, 1, 23) = 'cancelled_by_retention:') THEN 'cancelled_by_retention'
		          ELSE NULL
		        END AS cancel_reason,
		        r.source
		   FROM memory_jobs j
		   JOIN scope_users s ON s.user_id = j.user_id
		   LEFT JOIN receipts r ON r.id = j.receipt_id AND r.user_id = j.user_id
		  WHERE j.type IN ('${JOB_TYPES[0]}', '${JOB_TYPES[1]}')
		  ORDER BY j.created_at DESC, j.id DESC
		  LIMIT 51`,
	).bind(memoryOwnerUserId, projectId);

	// Keep required metadata reads in bounded D1 batches. The inventory query
	// uses scalar subqueries (not a large compound SELECT), which stays within
	// D1's statement limits while preserving one request timestamp and bounds.
	const [inventoryResult, receiptResult, dailyResult, latencyResult] = await env.DB.batch([
		inventoryStatement,
		receiptStatement,
		dailyStatement,
		latencyStatement,
	]);
	const [jobsResult, jobPeriodsResult, recentJobsResult] = await env.DB.batch([
		jobsStatement,
		jobPeriodsStatement,
		recentJobsStatement,
	]);

	const inventoryRow = rows(inventoryResult)[0] ?? {};
	const inventory = {
		as_of_ms: at,
		nodes: number(inventoryRow.nodes),
		pages: number(inventoryRow.pages),
		slices: number(inventoryRow.slices),
		events: number(inventoryRow.events),
		edges: number(inventoryRow.edges),
	};
	inventory.total_objects = inventory.nodes + inventory.pages + inventory.slices + inventory.events + inventory.edges;

	const periods = operationPeriods(bounds, rows(receiptResult), rows(dailyResult), rows(latencyResult));
	const jobs = buildJobs(at, rows(jobsResult), rows(jobPeriodsResult), rows(recentJobsResult));
	const ai = await accountAiAnalytics(env, accountUserId, bounds, at);

	return {
		ok: true,
		schema: "itsuki.dashboard/v1",
		generated_at: new Date(at).toISOString(),
		scope: {
			kind: "managed_project",
			project_id: projectId,
			memory_spaces: number(inventoryRow.memory_spaces, 1),
		},
		range: {
			key: range,
			days: bounds.days,
			semantics: "rolling_24h",
			timezone: "UTC",
			current: bounds.current,
			previous: bounds.previous,
			bucket_ms: DAY_MS,
		},
		inventory,
		periods,
		jobs,
		ai,
		signals: currentSignals(jobs, ai, at),
	};
}
