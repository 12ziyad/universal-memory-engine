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
const DEFAULT_DAILY_NEURON_CEILING = 750_000;

/** Scopes that count against the per-user write quota. Recall is deliberately
 * excluded: RECALL_LIMITER bounds it and its inference share is small. */
export const QUOTA_SCOPES = Object.freeze(["save", "playground_chat"]);

export function aiBudget(env) {
	const monthly = Number(env?.AI_MONTHLY_WRITES ?? DEFAULT_MONTHLY_WRITES);
	const ceiling = Number(env?.AI_DAILY_NEURON_CEILING ?? DEFAULT_DAILY_NEURON_CEILING);
	return {
		monthlyWrites: Number.isFinite(monthly) && monthly > 0 ? Math.floor(monthly) : DEFAULT_MONTHLY_WRITES,
		dailyNeuronCeiling: Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : DEFAULT_DAILY_NEURON_CEILING,
	};
}

/** First instant of the current UTC calendar month, in epoch ms. */
export function startOfUtcMonth(now = Date.now()) {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
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

	const used = await countWritesThisMonth(env, identity, now); // throws → caller refuses (fail closed)
	if (used >= budget.monthlyWrites) {
		const resetsAtMs = startOfNextUtcMonth(now);
		return {
			reason: "monthly",
			error: "ai_quota_exhausted",
			capped: "monthly_ai",
			used,
			limit: budget.monthlyWrites,
			resetsAt: new Date(resetsAtMs).toISOString(),
			retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
			message: `You've used all ${budget.monthlyWrites} AI saves in this month's plan. The quota resets on ${new Date(resetsAtMs).toISOString().slice(0, 10)}.`,
		};
	}
	return null;
}

/**
 * The published half of the budget for GET /v1/limits. The global ceiling is
 * NOT here: it is operational, and publishing it would tell a hostile caller
 * exactly how much traffic halts inference for everyone.
 */
export function aiLimitsDocument(env) {
	const budget = aiBudget(env);
	return {
		monthly_writes: budget.monthlyWrites,
		unit: "ai_writes",
		period: "calendar_month_utc",
		counted_scopes: [...QUOTA_SCOPES],
		on_exceeded: {
			http_status: 429,
			error: "ai_quota_exhausted",
			headers: ["retry-after", "ratelimit-limit"],
			turn: "HTTP 200 — recall still answers; collect reports capped=monthly_ai",
			mcp: "tool result with isError and error=ai_quota_exhausted",
		},
	};
}
