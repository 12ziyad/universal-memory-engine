/**
 * The AI budget: one plan for everyone, two numbers, two different jobs.
 *
 *   AI_MONTHLY_WRITES       — per-user calendar-month cap on AI-processed
 *                             writes. Counted in D1 (exact), enforced at the
 *                             HTTP/MCP doors, fails CLOSED: an unreadable
 *                             quota means unbounded spend of unknown size.
 *   AI_DAILY_NEURON_CEILING — account-wide daily inference halt. The wallet
 *                             backstop: Cloudflare offers no hard spend cap on
 *                             Workers AI. Read from the ai_daily_totals rollup
 *                             (one PK row), cached per isolate, fails OPEN with
 *                             a loud log: a D1 blip must not take inference
 *                             down for every user, and the exposure is one
 *                             cache-TTL of ordinary spend.
 *
 * Why writes, not neurons, for the per-user cap: neurons is only recorded when
 * Workers AI reports it (ai_meter rule: never derived into the billed column),
 * so a neuron cap silently under-counts by the unreported share. A write count
 * is exact, model-independent, and legible — "820 of 1,000 saves this month".
 * Neurons stay the unit of the global breaker, where the question really is
 * "how much have we spent" and a lagging approximate answer is acceptable.
 *
 * Shaped like playgroundLimits(env): env-tunable, defaults inline.
 */

const DEFAULT_MONTHLY_WRITES = 1000;
const DEFAULT_DAILY_NEURON_CEILING = 1_500_000;
// Per-user daily allowance: ~100 direct saves at the measured ~150 neurons a
// save. The user-facing promise is "about 100 saves a day"; the unit is
// neurons so a heavy conversation save honestly consumes more of the day
// than a one-line note.
const DEFAULT_DAILY_NEURONS_PER_USER = 15_000;
// Huba AI: generous on day one (people poke a new assistant hard), steady
// after. An answer costs ~20–35 neurons, so even 50 messages is ~1,500
// neurons — noise next to the save allowance.
const DEFAULT_HUBA_FIRST_DAY_MESSAGES = 50;
const DEFAULT_HUBA_DAILY_MESSAGES = 20;

/** Scopes that count against the per-user MONTHLY write quota. Recall is
 * deliberately excluded: RECALL_LIMITER bounds it and its inference share is
 * small. Huba is not a save — it has its own per-message daily quota and
 * counts against the daily-neuron dimension below instead. */
export const QUOTA_SCOPES = Object.freeze(["save", "playground_chat"]);

/** Scopes EXEMPT from the per-user daily-neuron quota. An exclusion list, not
 * an inclusion list, so a future scope can never become an unmetered cost
 * hole by omission. recall: a capped user must still read everything they
 * stored (and one query embedding is ~1–3 neurons). provider_health /
 * shadow_extract: operator-synthetic, not user work. */
export const DAILY_NEURON_EXEMPT_SCOPES = Object.freeze(["recall", "provider_health", "shadow_extract"]);

export function aiBudget(env) {
	const monthly = Number(env?.AI_MONTHLY_WRITES ?? DEFAULT_MONTHLY_WRITES);
	const ceiling = Number(env?.AI_DAILY_NEURON_CEILING ?? DEFAULT_DAILY_NEURON_CEILING);
	const daily = Number(env?.AI_DAILY_NEURONS_PER_USER ?? DEFAULT_DAILY_NEURONS_PER_USER);
	const hubaFirstDay = Number(env?.HUBA_FIRST_DAY_MESSAGES ?? DEFAULT_HUBA_FIRST_DAY_MESSAGES);
	const hubaDaily = Number(env?.HUBA_DAILY_MESSAGES ?? DEFAULT_HUBA_DAILY_MESSAGES);
	return {
		monthlyWrites: Number.isFinite(monthly) && monthly > 0 ? Math.floor(monthly) : DEFAULT_MONTHLY_WRITES,
		dailyNeuronCeiling: Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : DEFAULT_DAILY_NEURON_CEILING,
		dailyNeuronsPerUser: Number.isFinite(daily) && daily > 0 ? Math.floor(daily) : DEFAULT_DAILY_NEURONS_PER_USER,
		hubaFirstDayMessages: Number.isFinite(hubaFirstDay) && hubaFirstDay > 0 ? Math.floor(hubaFirstDay) : DEFAULT_HUBA_FIRST_DAY_MESSAGES,
		hubaDailyMessages: Number.isFinite(hubaDaily) && hubaDaily > 0 ? Math.floor(hubaDaily) : DEFAULT_HUBA_DAILY_MESSAGES,
	};
}

/** First instant of the current UTC calendar month, in epoch ms. */
export function startOfUtcMonth(now = Date.now()) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** First instant of the current UTC day, in epoch ms. */
export function startOfUtcDay(now = Date.now()) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** First instant of the NEXT UTC day — when daily quotas reset. */
export function startOfNextUtcDay(now = Date.now()) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** First instant of the NEXT UTC month — when the quota resets. */
export function startOfNextUtcMonth(now = Date.now()) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** 'YYYY-MM-DD' for the current UTC day — the ai_daily_totals key. */
export function utcDayKey(now = Date.now()) {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Blended-average rate for the derived neuron top-up: calls that reported no
 * neurons (embeddings, some models) are estimated from token sums at READ
 * time — never written into a column named after the billed unit (the
 * ai_meter rule). The figures are the Cloudflare published table, validated
 * against a binding-reported call to five significant figures in
 * evals/locomo/ai_cost.js. The daily rollup carries only token SUMS, not
 * per-model rows, so the top-up uses the extraction model's rate — the
 * dominant unreported cost — which slightly OVER-estimates embedding-heavy
 * traffic. For a circuit breaker, erring high is the correct direction.
 */
const DERIVED_RATE = Object.freeze({ inputPerMillion: 4625, outputPerMillion: 30475 });

export function derivedNeurons(inputTokens, outputTokens) {
	return ((Number(inputTokens) || 0) * DERIVED_RATE.inputPerMillion
		+ (Number(outputTokens) || 0) * DERIVED_RATE.outputPerMillion) / 1e6;
}

/**
 * AI-processed writes this UTC month for one identity. Counted on
 * account_user_id — the authenticated account, which a caller cannot rotate —
 * with user_id as the fallback ONLY for legacy operator-door rows (which have
 * no account attribution and require the operator master key anyway).
 * COUNT(DISTINCT scope_id): one save is one write regardless of how many
 * model calls it took.
 */
export async function countWritesThisMonth(env, identity, now = Date.now()) {
	const since = startOfUtcMonth(now);
	const placeholders = QUOTA_SCOPES.map(() => "?").join(", ");
	if (identity?.accountUserId) {
		const row = await env.DB.prepare(
			`SELECT COUNT(DISTINCT scope_id) AS writes FROM ai_calls
			 WHERE account_user_id = ? AND created_at >= ? AND scope IN (${placeholders})`,
		).bind(identity.accountUserId, since, ...QUOTA_SCOPES).first();
		return Number(row?.writes ?? 0);
	}
	const row = await env.DB.prepare(
		`SELECT COUNT(DISTINCT scope_id) AS writes FROM ai_calls
		 WHERE user_id = ? AND account_user_id IS NULL AND created_at >= ? AND scope IN (${placeholders})`,
	).bind(identity?.userId ?? null, since, ...QUOTA_SCOPES).first();
	return Number(row?.writes ?? 0);
}

/**
 * Everyone who signs up before launch+30d is marked early_access, so
 * grandfathering later is a WHERE clause instead of archaeology. Launch day
 * is 2026-08-28; the cutoff is fixed, not env-tunable — a moving flag would
 * make "early" meaningless. Migration 0059 stamped every pre-existing user.
 */
export const EARLY_ACCESS_CUTOFF_MS = Date.UTC(2026, 8, 27); // 2026-09-27T00:00Z

export async function stampEarlyAccess(env, userId, now = Date.now()) {
	if (!env?.DB || !userId || now >= EARLY_ACCESS_CUTOFF_MS) return;
	try {
		await env.DB.prepare(
			"INSERT OR IGNORE INTO user_entitlements (user_id, early_access, created_at, updated_at) VALUES (?, 1, ?, ?)",
		).bind(userId, now, now).run();
	} catch (error) {
		// Best-effort: an entitlement stamp must never break account creation.
		console.warn("early-access stamp failed:", error?.message ?? error);
	}
}

/**
 * Per-user entitlement overrides (migration 0059). A missing row or NULL
 * column falls back to the env default. Numeric overrides past expires_at are
 * ignored at read time — a temporary grant lapses on its own with no cleanup
 * job — while early_access survives expiry (it records who was here, not what
 * they may spend). Reads are quota reads: a throw propagates and the caller
 * fails CLOSED, exactly like the monthly counter.
 */
export async function loadEntitlements(env, userId, now = Date.now()) {
	if (!env?.DB || !userId) return null;
	const row = await env.DB.prepare(
		`SELECT daily_neurons, monthly_writes, huba_daily_messages, early_access, expires_at, note
		 FROM user_entitlements WHERE user_id = ?`,
	).bind(userId).first();
	if (!row) return null;
	const expired = row.expires_at != null && Number(row.expires_at) <= now;
	const positive = (value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
	};
	return {
		earlyAccess: Number(row.early_access) === 1,
		dailyNeurons: expired ? null : positive(row.daily_neurons),
		monthlyWrites: expired ? null : positive(row.monthly_writes),
		hubaDailyMessages: expired ? null : positive(row.huba_daily_messages),
		expiresAt: row.expires_at ?? null,
		note: row.note ?? null,
	};
}

/**
 * Neurons this account spent today, on the same measured-else-derived rule
 * the breaker uses — per CALL rather than per rollup, because here the sum
 * must be per account. Keyed on account_user_id (rotating body.userId cannot
 * buy a fresh allowance), with the legacy operator-door fallback matching
 * countWritesThisMonth.
 */
export async function neuronsSpentTodayForAccount(env, identity, now = Date.now()) {
	const since = startOfUtcDay(now);
	const exempt = DAILY_NEURON_EXEMPT_SCOPES.map(() => "?").join(", ");
	const spendExpr = `SUM(CASE WHEN neurons IS NOT NULL THEN neurons
		ELSE (COALESCE(input_tokens, 0) * ${DERIVED_RATE.inputPerMillion}
			+ COALESCE(output_tokens, 0) * ${DERIVED_RATE.outputPerMillion}) / 1e6 END)`;
	if (identity?.accountUserId) {
		const row = await env.DB.prepare(
			`SELECT ${spendExpr} AS neurons FROM ai_calls
			 WHERE account_user_id = ? AND created_at >= ?
			   AND (scope IS NULL OR scope NOT IN (${exempt}))`,
		).bind(identity.accountUserId, since, ...DAILY_NEURON_EXEMPT_SCOPES).first();
		return Number(row?.neurons ?? 0);
	}
	const row = await env.DB.prepare(
		`SELECT ${spendExpr} AS neurons FROM ai_calls
		 WHERE user_id = ? AND account_user_id IS NULL AND created_at >= ?
		   AND (scope IS NULL OR scope NOT IN (${exempt}))`,
	).bind(identity?.userId ?? null, since, ...DAILY_NEURON_EXEMPT_SCOPES).first();
	return Number(row?.neurons ?? 0);
}

/** Huba messages this account sent today (one metered call per message). */
export async function hubaMessagesToday(env, identity, now = Date.now()) {
	const since = startOfUtcDay(now);
	if (identity?.accountUserId) {
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_calls
			 WHERE account_user_id = ? AND created_at >= ? AND scope = 'huba_chat'`,
		).bind(identity.accountUserId, since).first();
		return Number(row?.n ?? 0);
	}
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM ai_calls
		 WHERE user_id = ? AND account_user_id IS NULL AND created_at >= ? AND scope = 'huba_chat'`,
	).bind(identity?.userId ?? null, since).first();
	return Number(row?.n ?? 0);
}

/**
 * Account-wide breaker state, cached per isolate. This caches NO per-user or
 * request-scoped data — one global scalar, identical for every request in the
 * isolate — so module state is safe here. The TTL bounds staleness to one
 * minute of spend, which is the accepted exposure of the fail-open policy.
 */
let breakerCache = { day: null, at: 0, neurons: 0 };
const BREAKER_TTL_MS = 60_000;

/** Test hook: reset the isolate cache so specs can exercise cold reads. */
export function resetBreakerCacheForTests() {
	breakerCache = { day: null, at: 0, neurons: 0 };
}

async function dailyNeuronsSpent(env, now = Date.now()) {
	const day = utcDayKey(now);
	if (breakerCache.day === day && (now - breakerCache.at) < BREAKER_TTL_MS) {
		return breakerCache.neurons;
	}
	const row = await env.DB.prepare(
		`SELECT calls, input_tokens, output_tokens, measured_neurons, measured_neuron_calls
		 FROM ai_daily_totals WHERE day = ?`,
	).bind(day).first();
	const measured = Number(row?.measured_neurons ?? 0);
	const unreportedCalls = Number(row?.calls ?? 0) - Number(row?.measured_neuron_calls ?? 0);
	// Token sums include the measured calls too; attribute the derived estimate
	// only when something actually went unreported, and never let it reduce the
	// measured figure.
	const topUp = unreportedCalls > 0
		? Math.max(0, derivedNeurons(row?.input_tokens, row?.output_tokens) - measured)
		: 0;
	const neurons = measured + topUp;
	breakerCache = { day, at: now, neurons };
	return neurons;
}

/**
 * The admission decision for an AI-processed write. Returns null (allowed) or
 * a refusal descriptor the caller shapes for its own door (REST 429, turn
 * degrade, MCP isError).
 *
 * Failure policy is deliberately asymmetric:
 *   - per-user quota read fails → REFUSE (fail closed; blast radius one user,
 *     and an unreadable quota means unbounded spend of unknown size)
 *   - breaker read fails → ALLOW on the last cached value, loudly (a D1 blip
 *     must not halt inference for every user; exposure ≈ one TTL of spend)
 */
export async function checkAiBudget(env, identity, now = Date.now()) {
	if (!env?.DB) return null; // no metering store at all (unit harnesses)
	const budget = aiBudget(env);

	let spentToday = null;
	try {
		spentToday = await dailyNeuronsSpent(env, now);
	} catch (error) {
		console.warn(JSON.stringify({ event: "ai_breaker_unavailable", error: String(error?.message ?? error) }));
	}
	if (spentToday !== null && spentToday >= budget.dailyNeuronCeiling) {
		return {
			reason: "ceiling",
			error: "ai_capacity_paused",
			retryAfterSeconds: Math.max(1, Math.ceil((Date.UTC(
				new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1,
			) - now) / 1000)),
			// Account-wide event, so the copy must never read as a personal limit.
			message: "Itsuki has hit its daily processing ceiling and is catching up. Saves are paused until 00:00 UTC — nothing you sent was lost, and nothing about this is specific to this account.",
		};
	}

	// Everything below is a quota read: a throw propagates and the caller
	// refuses (fail closed) — an unreadable quota means unbounded spend of
	// unknown size.
	const entitlements = await loadEntitlements(env, identity?.accountUserId ?? identity?.userId ?? null, now);

	// Per-user daily neurons — the "about 100 saves a day" allowance.
	const dailyLimit = entitlements?.dailyNeurons ?? budget.dailyNeuronsPerUser;
	const usedToday = await neuronsSpentTodayForAccount(env, identity, now);
	if (usedToday >= dailyLimit) {
		const resetsAtMs = startOfNextUtcDay(now);
		const resetsAtIso = new Date(resetsAtMs).toISOString();
		return {
			reason: "daily",
			error: "ai_quota_exhausted",
			capped: "daily_neurons",
			used: Math.round(usedToday),
			limit: dailyLimit,
			resetsAt: resetsAtIso,
			retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
			usage: { used: Math.round(usedToday), limit: dailyLimit, unit: "neurons", resets_at: resetsAtIso },
			message: "You've used today's save allowance. It resets at 00:00 UTC — recall keeps working, nothing already saved is affected, and you can request more from the Usage page.",
		};
	}

	const monthlyLimit = entitlements?.monthlyWrites ?? budget.monthlyWrites;
	const used = await countWritesThisMonth(env, identity, now);
	if (used >= monthlyLimit) {
		const resetsAtMs = startOfNextUtcMonth(now);
		return {
			reason: "monthly",
			error: "ai_quota_exhausted",
			capped: "monthly_ai",
			used,
			limit: monthlyLimit,
			resetsAt: new Date(resetsAtMs).toISOString(),
			retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
			usage: { used, limit: monthlyLimit, unit: "ai_writes", resets_at: new Date(resetsAtMs).toISOString() },
			message: `You've used all ${monthlyLimit} AI saves in this month's plan. The quota resets on ${new Date(resetsAtMs).toISOString().slice(0, 10)}.`,
		};
	}
	return null;
}

/**
 * The Huba AI admission decision: per-message daily cap, generous on the
 * account's first UTC day. Same fail-closed posture as the write quota.
 */
export async function checkHubaBudget(env, identity, { userCreatedAt = null } = {}, now = Date.now()) {
	if (!env?.DB) return null;
	const budget = aiBudget(env);
	const entitlements = await loadEntitlements(env, identity?.accountUserId ?? identity?.userId ?? null, now);
	const firstDay = userCreatedAt != null && startOfUtcDay(Number(userCreatedAt)) === startOfUtcDay(now);
	const limit = entitlements?.hubaDailyMessages
		?? (firstDay ? budget.hubaFirstDayMessages : budget.hubaDailyMessages);
	const used = await hubaMessagesToday(env, identity, now);
	if (used >= limit) {
		const resetsAtMs = startOfNextUtcDay(now);
		const resetsAtIso = new Date(resetsAtMs).toISOString();
		return {
			reason: "huba_daily",
			error: "ai_quota_exhausted",
			capped: "huba_daily_messages",
			used,
			limit,
			resetsAt: resetsAtIso,
			retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
			usage: { used, limit, unit: "messages", resets_at: resetsAtIso },
			message: "Huba has answered today's allowance of questions for this account. It resets at 00:00 UTC — the docs stay open, and you can request more from the Usage page.",
		};
	}
	return { allowed: true, used, limit, resetsAt: new Date(startOfNextUtcDay(now)).toISOString() };
}

/**
 * The published half of the budget for GET /v1/limits. The account-wide
 * GLOBAL ceiling is NOT here: it is operational, and publishing it would tell
 * a hostile caller exactly how much traffic halts inference for everyone.
 * The per-user daily allowance IS here — it is a product fact a caller must
 * be able to read before hitting it.
 */
export function aiLimitsDocument(env) {
	const budget = aiBudget(env);
	return {
		monthly_writes: budget.monthlyWrites,
		unit: "ai_writes",
		period: "calendar_month_utc",
		counted_scopes: [...QUOTA_SCOPES],
		daily: {
			limit: budget.dailyNeuronsPerUser,
			unit: "neurons",
			approx_saves: Math.round(budget.dailyNeuronsPerUser / 150),
			period: "utc_day",
			resets: "00:00 UTC",
			recall_metered: false,
		},
		huba: {
			first_day_messages: budget.hubaFirstDayMessages,
			daily_messages: budget.hubaDailyMessages,
			period: "utc_day",
		},
		on_exceeded: {
			http_status: 429,
			error: "ai_quota_exhausted",
			headers: ["retry-after", "ratelimit-limit"],
			turn: "HTTP 200 — recall still answers; collect reports the capped dimension",
			mcp: "tool result with isError and error=ai_quota_exhausted",
		},
	};
}
