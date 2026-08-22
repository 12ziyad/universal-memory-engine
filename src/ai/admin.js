/**
 * Control-plane operations for provider routing. Session-admin only (the
 * routes in index.js enforce that); this module owns the D1 shapes.
 *
 * Policy writes are CAS-guarded on `version` and audited in the same batch —
 * there is no path that changes routing without leaving an actor-stamped audit
 * row. The emergency action can only ever REDUCE non-default provider usage.
 */

import { newId } from "../lib/ids.js";
import { breakerSnapshot } from "./provider_budget.js";
import { legalModesFor, resetPolicyCacheForTests, ROUTING_MODES, validatePolicyWrite } from "./policy.js";
import { WRITE_PIN_LANES } from "./pin.js";

/** Lanes the admin surface offers rows for (a row may not exist yet). */
export const POLICY_LANES = Object.freeze([
	"extract", "edges", "reflexion", "extract_atomic", "digest",
	"mcp_title", "manual_router", "rules_category_preview",
	"playground_preview", "playground_chat", "embed", "embed_profile", "rerank",
]);

export async function routingOverview(env) {
	const [policies, overrides, health, audit, providerDay, monthly, shadow] = await env.DB.batch([
		env.DB.prepare("SELECT * FROM ai_routing_policies"),
		env.DB.prepare("SELECT * FROM ai_provider_overrides"),
		env.DB.prepare("SELECT * FROM ai_provider_health"),
		env.DB.prepare("SELECT capability, actor_user_id, changed_at, note FROM ai_routing_policy_audit ORDER BY changed_at DESC LIMIT 20"),
		env.DB.prepare("SELECT * FROM ai_provider_daily_totals WHERE day = date('now')"),
		env.DB.prepare("SELECT * FROM ai_provider_monthly_costs WHERE month = strftime('%Y-%m','now')"),
		env.DB.prepare(`SELECT status, COUNT(*) AS n FROM ai_shadow_jobs
			WHERE created_at > (unixepoch() - 86400) * 1000 GROUP BY status`),
	]);
	const policyRows = Object.fromEntries((policies?.results ?? []).map((row) => [row.capability, {
		mode: row.mode,
		primary_provider: row.primary_provider,
		primary_model: row.primary_model,
		fallback_provider: row.fallback_provider,
		fallback_model: row.fallback_model,
		shadow_provider: row.shadow_provider,
		shadow_model: row.shadow_model,
		shadow_sample_pct: row.shadow_sample_pct,
		canary_pct: row.canary_pct,
		allowlist_count: countAllowlist(row.allowlist_json),
		disabled: Number(row.disabled) === 1,
		version: row.version,
		updated_at: row.updated_at,
		updated_by: row.updated_by,
		legal_modes: legalModesFor(row.capability),
	}]));
	return {
		master_gate: {
			ai_routing: String(env?.AI_ROUTING ?? "off"),
			kill: String(env?.AI_ROUTING_KILL ?? "") === "1",
		},
		lanes: POLICY_LANES.map((lane) => ({
			lane,
			pinned_by_saves: WRITE_PIN_LANES.includes(lane),
			policy: policyRows[lane] ?? null,
			legal_modes: legalModesFor(lane),
		})),
		global_disabled: Boolean(policyRows.__global__?.disabled),
		overrides: (overrides?.results ?? []).map((row) => ({
			provider: row.provider, disabled: Number(row.disabled) === 1, reason: row.reason, updated_at: row.updated_at,
		})),
		provider_health: (health?.results ?? []),
		breaker_local: breakerSnapshot(),
		credentials: { google_vertex: env?.GCP_SERVICE_ACCOUNT ? "present" : "absent", gcp_project: env?.GCP_PROJECT_ID ?? null },
		today: providerDay?.results ?? [],
		month: monthly?.results ?? [],
		shadow_24h: Object.fromEntries((shadow?.results ?? []).map((row) => [row.status, Number(row.n)])),
		audit_tail: audit?.results ?? [],
		modes: ROUTING_MODES,
	};
}

function countAllowlist(json) {
	try {
		const list = JSON.parse(json ?? "null");
		return Array.isArray(list) ? list.length : 0;
	} catch {
		return 0;
	}
}

/** CAS policy write + audit, one batch. Returns { ok } or { error, problems }. */
export async function applyPolicyChange(env, { lane, patch = {}, actorUserId, expectedVersion = null, note = null }) {
	if (!POLICY_LANES.includes(lane) && lane !== "__global__") return { error: "unknown_lane" };
	const existing = await env.DB.prepare("SELECT * FROM ai_routing_policies WHERE capability = ?").bind(lane).first();
	const next = {
		mode: patch.mode ?? existing?.mode ?? "cloudflare_only",
		primary_provider: patch.primary_provider ?? existing?.primary_provider ?? "workers-ai",
		primary_model: patch.primary_model !== undefined ? patch.primary_model : existing?.primary_model ?? null,
		fallback_provider: patch.fallback_provider !== undefined ? patch.fallback_provider : existing?.fallback_provider ?? null,
		fallback_model: patch.fallback_model !== undefined ? patch.fallback_model : existing?.fallback_model ?? null,
		shadow_provider: patch.shadow_provider !== undefined ? patch.shadow_provider : existing?.shadow_provider ?? null,
		shadow_model: patch.shadow_model !== undefined ? patch.shadow_model : existing?.shadow_model ?? null,
		shadow_sample_pct: patch.shadow_sample_pct ?? existing?.shadow_sample_pct ?? 100,
		canary_pct: patch.canary_pct ?? existing?.canary_pct ?? 0,
		allowlist_json: patch.allowlist !== undefined
			? (Array.isArray(patch.allowlist) && patch.allowlist.length ? JSON.stringify(patch.allowlist.map(String)) : null)
			: existing?.allowlist_json ?? null,
		disabled: patch.disabled !== undefined ? (patch.disabled ? 1 : 0) : Number(existing?.disabled ?? 0),
	};
	if (lane !== "__global__") {
		const problems = validatePolicyWrite(lane, next);
		if (problems.length) return { error: "invalid_policy", problems };
	}
	const now = Date.now();
	const version = Number(existing?.version ?? 0);
	if (expectedVersion !== null && expectedVersion !== version) return { error: "version_conflict", version };
	const statements = [];
	if (existing) {
		statements.push(env.DB.prepare(
			`UPDATE ai_routing_policies SET mode=?, primary_provider=?, primary_model=?, fallback_provider=?,
				fallback_model=?, shadow_provider=?, shadow_model=?, shadow_sample_pct=?, canary_pct=?,
				allowlist_json=?, disabled=?, version=version+1, updated_at=?, updated_by=?
			 WHERE capability=? AND version=?`,
		).bind(
			next.mode, next.primary_provider, next.primary_model, next.fallback_provider,
			next.fallback_model, next.shadow_provider, next.shadow_model, next.shadow_sample_pct, next.canary_pct,
			next.allowlist_json, next.disabled, now, actorUserId, lane, version,
		));
	} else {
		statements.push(env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, primary_provider, primary_model, fallback_provider,
				fallback_model, shadow_provider, shadow_model, shadow_sample_pct, canary_pct, allowlist_json,
				disabled, version, updated_at, updated_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		).bind(
			lane, next.mode, next.primary_provider, next.primary_model, next.fallback_provider,
			next.fallback_model, next.shadow_provider, next.shadow_model, next.shadow_sample_pct, next.canary_pct,
			next.allowlist_json, next.disabled, now, actorUserId,
		));
	}
	statements.push(env.DB.prepare(
		`INSERT INTO ai_routing_policy_audit (id, capability, actor_user_id, changed_at, old_json, new_json, note)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		newId("aipolicy"),
		lane,
		actorUserId,
		now,
		existing ? JSON.stringify(publicPolicy(existing)) : null,
		JSON.stringify(next),
		note,
	));
	const results = await env.DB.batch(statements);
	const changed = Number(results?.[0]?.meta?.changes ?? 0);
	if (existing && changed !== 1) return { error: "version_conflict", version };
	resetPolicyCacheForTests(); // this isolate sees its own change immediately
	return { ok: true, version: version + 1 };
}

function publicPolicy(row) {
	const { allowlist_json, ...rest } = row;
	return { ...rest, allowlist_count: countAllowlist(allowlist_json) };
}

/**
 * The removal gate (plan §12 step 4): before the Google adapter and
 * credentials may be removed, every count here must be ZERO. A nonterminal
 * google-pinned run must settle terminally first; a pinned run NEVER
 * re-resolves to another provider — recovery is a separately identified new
 * run after its predecessor is provably terminal.
 */
export async function removalGate(env) {
	const [runs, atomic, shadow, reservations, policies] = await env.DB.batch([
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM extraction_runs
			 WHERE provider = 'google-vertex' AND status IN ('running', 'committing')`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM semantic_atom_capture_runs
			 WHERE provider = 'google-vertex' AND status = 'running'`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_shadow_jobs
			 WHERE status IN ('pending', 'running') AND provider = 'google-vertex'`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_provider_reservations
			 WHERE provider = 'google-vertex' AND status = 'reserved'`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_routing_policies
			 WHERE capability != '__global__' AND (
				primary_provider = 'google-vertex' OR mode IN ('google_only', 'google_primary_cf_fallback')
				OR (mode = 'shadow' AND shadow_provider = 'google-vertex' AND disabled = 0)
			 )`,
		),
	]);
	const counts = {
		nonterminal_google_runs: Number(runs?.results?.[0]?.n ?? 0),
		nonterminal_google_atomic_runs: Number(atomic?.results?.[0]?.n ?? 0),
		pending_google_shadow_jobs: Number(shadow?.results?.[0]?.n ?? 0),
		active_google_reservations: Number(reservations?.results?.[0]?.n ?? 0),
		google_admitting_policies: Number(policies?.results?.[0]?.n ?? 0),
	};
	return { clean: Object.values(counts).every((n) => n === 0), counts };
}

/** One action: every lane to cloudflare_only, the google override disabled,
 * one audit row. Effective within one policy-cache TTL, no deploy. */
export async function emergencyDisable(env, { actorUserId, reason = "emergency" }) {
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare("UPDATE ai_routing_policies SET mode='cloudflare_only', version=version+1, updated_at=?, updated_by=?").bind(now, actorUserId),
		env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, disabled, version, updated_at, updated_by)
			 VALUES ('__global__', 'cloudflare_only', 1, 1, ?, ?)
			 ON CONFLICT(capability) DO UPDATE SET disabled=1, version=version+1, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
		).bind(now, actorUserId),
		env.DB.prepare(
			`INSERT INTO ai_provider_overrides (provider, disabled, actor_user_id, reason, updated_at)
			 VALUES ('google-vertex', 1, ?, ?, ?)
			 ON CONFLICT(provider) DO UPDATE SET disabled=1, actor_user_id=excluded.actor_user_id, reason=excluded.reason, updated_at=excluded.updated_at`,
		).bind(actorUserId, reason, now),
		env.DB.prepare(
			`INSERT INTO ai_routing_policy_audit (id, capability, actor_user_id, changed_at, old_json, new_json, note)
			 VALUES (?, '__global__', ?, ?, NULL, '{"emergency":true}', ?)`,
		).bind(newId("aipolicy"), actorUserId, now, reason),
	]);
	resetPolicyCacheForTests();
	return { ok: true, max_staleness_seconds: 60 };
}
