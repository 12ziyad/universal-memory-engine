/**
 * Control-plane operations for provider routing. Session-admin only (the
 * routes in index.js enforce that); this module owns the D1 shapes.
 *
 * Policy writes are CAS-guarded on `version` and audited in the same batch —
 * there is no path that changes routing without leaving an actor-stamped audit
 * row. The emergency action can only ever REDUCE non-default provider usage.
 */

import { newId } from "../lib/ids.js";
import { ATOMIC_CAPTURE_MAX_ATTEMPTS } from "../pipeline/atomic_candidates.mjs";
import { breakerSnapshot } from "./provider_budget.js";
import { canonicalizePolicyModels, legalModesFor, resetPolicyCacheForTests, ROUTING_MODES, validatePolicyWrite } from "./policy.js";
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
	if (patch.allowlist !== undefined && patch.allowlist !== null && !Array.isArray(patch.allowlist)) {
		return { error: "invalid_policy", problems: ["allowlist must be an array, null, or omitted"] };
	}
	if (Array.isArray(patch.allowlist)
		&& patch.allowlist.some((member) => typeof member !== "string" || member.trim() === "")) {
		return { error: "invalid_policy", problems: ["allowlist members must be non-empty account-id strings"] };
	}
	const existing = await env.DB.prepare("SELECT * FROM ai_routing_policies WHERE capability = ?").bind(lane).first();
	let next = {
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
			? (Array.isArray(patch.allowlist) ? JSON.stringify(patch.allowlist) : null)
			: existing?.allowlist_json ?? null,
		disabled: patch.disabled !== undefined ? (patch.disabled ? 1 : 0) : Number(existing?.disabled ?? 0),
	};
	if (lane !== "__global__") {
		try {
			next = await canonicalizePolicyModels(lane, next);
		} catch (error) {
			return {
				error: "invalid_policy",
				problems: [String(error?.message ?? "provider model could not be resolved")],
			};
		}
		const problems = validatePolicyWrite(lane, next);
		if (problems.length) return { error: "invalid_policy", problems };
	}
	const now = Date.now();
	const mutationId = newId("aipolicymut");
	const version = Number(existing?.version ?? 0);
	if (expectedVersion !== null && expectedVersion !== version) return { error: "version_conflict", version };
	// Commit-time account fencing matters here. A session can pass the HTTP
	// authorization check, then lose its account to erasure before this batch
	// linearizes. The allowlist predicate also prevents a different admin from
	// re-introducing an already-erased account after its scrub completed.
	const fencedAllowlistJson = validAllowlistJson(next.allowlist_json);
	const statements = [];
	if (existing) {
		statements.push(env.DB.prepare(
			`UPDATE ai_routing_policies SET mode=?, primary_provider=?, primary_model=?, fallback_provider=?,
				fallback_model=?, shadow_provider=?, shadow_model=?, shadow_sample_pct=?, canary_pct=?,
				allowlist_json=?, disabled=?, version=version+1, updated_at=?, updated_by=?, mutation_id=?
			 WHERE capability=? AND version=?
			   AND NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			   )
			   AND NOT EXISTS (
				 SELECT 1
				   FROM account_erasure_tombstones erased
				   JOIN json_each(?) member ON CAST(member.value AS TEXT) = erased.user_id
			   )`,
		).bind(
			next.mode, next.primary_provider, next.primary_model, next.fallback_provider,
			next.fallback_model, next.shadow_provider, next.shadow_model, next.shadow_sample_pct, next.canary_pct,
			next.allowlist_json, next.disabled, now, actorUserId, mutationId, lane, version,
			actorUserId, fencedAllowlistJson,
		));
	} else {
		statements.push(env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, primary_provider, primary_model, fallback_provider,
				fallback_model, shadow_provider, shadow_model, shadow_sample_pct, canary_pct, allowlist_json,
				disabled, version, updated_at, updated_by, mutation_id)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
			  WHERE NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			  )
			    AND NOT EXISTS (
				 SELECT 1
				   FROM account_erasure_tombstones erased
				   JOIN json_each(?) member ON CAST(member.value AS TEXT) = erased.user_id
			    )`,
		).bind(
			lane, next.mode, next.primary_provider, next.primary_model, next.fallback_provider,
			next.fallback_model, next.shadow_provider, next.shadow_model, next.shadow_sample_pct, next.canary_pct,
			next.allowlist_json, next.disabled, now, actorUserId, mutationId,
			actorUserId, fencedAllowlistJson,
		));
	}
	// D1 batch statements do not fail merely because a version-fenced UPDATE
	// changed zero rows. Make the audit append depend on the post-mutation row,
	// otherwise a concurrent CAS loser would leave a ghost event describing a
	// policy state that never existed.
	statements.push(env.DB.prepare(
		`INSERT INTO ai_routing_policy_audit (id, capability, actor_user_id, changed_at, old_json, new_json, note)
		 SELECT ?, ?, ?, ?, ?, ?, ?
		  WHERE EXISTS (
			SELECT 1 FROM ai_routing_policies
			 WHERE capability = ? AND version = ? AND mutation_id = ?
		  )`,
	).bind(
		newId("aipolicy"),
		lane,
		actorUserId,
		now,
		existing ? JSON.stringify(publicPolicy(existing)) : null,
		JSON.stringify(publicPolicy(next)),
		note,
		lane,
		version + 1,
		mutationId,
	));
	const results = await env.DB.batch(statements);
	const changed = Number(results?.[0]?.meta?.changes ?? 0);
	if (changed !== 1) {
		const erasedActor = await env.DB.prepare(
			"SELECT 1 AS erased FROM account_erasure_tombstones WHERE user_id = ? LIMIT 1",
		).bind(actorUserId).first();
		if (erasedActor) return { error: "account_erased" };
		const erasedAllowlistMember = await env.DB.prepare(
			`SELECT 1 AS erased
			   FROM account_erasure_tombstones erased
			   JOIN json_each(?) member ON CAST(member.value AS TEXT) = erased.user_id
			  LIMIT 1`,
		).bind(fencedAllowlistJson).first();
		if (erasedAllowlistMember) return { error: "allowlist_contains_erased_account" };
		return { error: "version_conflict", version };
	}
	resetPolicyCacheForTests(); // this isolate sees its own change immediately
	return { ok: true, version: version + 1 };
}

function publicPolicy(row) {
	// Audit snapshots are operational state, not an identity database. Keep the
	// cardinality needed for review while excluding every raw allowlist member,
	// the actor-stamped updater, and the internal mutation ownership token.
	const { allowlist_json, mutation_id: _mutationId, updated_by: _updatedBy, ...rest } = row;
	return { ...rest, allowlist_count: countAllowlist(allowlist_json) };
}

function validAllowlistJson(value) {
	try {
		const parsed = JSON.parse(value ?? "[]");
		return JSON.stringify(Array.isArray(parsed) ? parsed.map(String) : []);
	} catch {
		return "[]";
	}
}

// Pins are JSON envelopes, not a single-provider scalar: a Workers-AI
// extraction can still carry Google on a later write lane or as its sampled
// shadow. Keep this SQL predicate schema-independent by walking the whole
// envelope. The model-prefix checks also catch a malformed/legacy pin whose
// provider field was lost but whose concrete Google model is still replayable.
const GOOGLE_PIN_REFERENCE_SQL = `(
	er.provider = 'google-vertex'
	OR lower(COALESCE(er.model, '')) GLOB 'gemini-*'
	OR lower(COALESCE(er.model, '')) GLOB 'semantic-ranker-*'
	OR lower(COALESCE(er.model, '')) GLOB 'text-embedding-*'
	OR (
		er.pin_json IS NOT NULL
		AND json_valid(er.pin_json)
		AND EXISTS (
			SELECT 1 FROM json_tree(er.pin_json) pin_ref
			 WHERE pin_ref.type = 'text'
			   AND (
				pin_ref.value = 'google-vertex'
				OR (
					pin_ref.key = 'model'
					AND (
						lower(CAST(pin_ref.value AS TEXT)) GLOB 'gemini-*'
						OR lower(CAST(pin_ref.value AS TEXT)) GLOB 'semantic-ranker-*'
						OR lower(CAST(pin_ref.value AS TEXT)) GLOB 'text-embedding-*'
					)
				)
			   )
		)
	)
)`;

const SHADOW_RECONCILE_LOOKBACK_MS = 30 * 86_400_000;

/**
 * The removal gate (plan §12 step 4): before the Google adapter and
 * credentials may be removed, every count here must be ZERO. A nonterminal
 * google-pinned run must settle terminally first; a pinned run NEVER
 * re-resolves to another provider — recovery is a separately identified new
 * run after its predecessor is provably terminal.
 */
export async function removalGate(env) {
	const now = Date.now();
	const [runs, atomic, shadow, reconcilableShadow, reservations, policies, override, probes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM extraction_runs er
			 WHERE er.status IN ('running', 'committing')
			   AND ${GOOGLE_PIN_REFERENCE_SQL}`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM semantic_atom_capture_runs r
			 WHERE r.provider = 'google-vertex' AND (
				r.status = 'running'
				OR (
					r.status = 'failed'
					AND r.error_code = 'interrupted_unknown'
					AND r.attempts < ?
					AND NOT EXISTS (
						SELECT 1 FROM semantic_atom_candidates c
						 WHERE c.user_id = r.user_id AND c.capture_run_id = r.id
					)
					AND EXISTS (
						SELECT 1 FROM ai_provider_reservations p
						 WHERE p.id = 'airesv_atom:v1:' || r.id || ':attempt:' || r.attempts
						   AND p.provider = r.provider
						   AND p.status = 'released'
					)
				)
			 )`,
		).bind(ATOMIC_CAPTURE_MAX_ATTEMPTS),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_shadow_jobs
			 WHERE status IN ('pending', 'running', 'invoking') AND (
				provider = 'google-vertex'
				OR lower(COALESCE(model, '')) GLOB 'gemini-*'
				OR lower(COALESCE(model, '')) GLOB 'semantic-ranker-*'
				OR lower(COALESCE(model, '')) GLOB 'text-embedding-*'
			 )`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM extraction_runs er
			 WHERE er.created_at > ?
			   AND er.status IN ('wrote', 'skipped', 'failed')
			   AND er.pin_json IS NOT NULL
			   AND json_valid(er.pin_json)
			   AND json_extract(er.pin_json, '$.shadow.sampled') = 1
			   AND (
				json_extract(er.pin_json, '$.shadow.provider') = 'google-vertex'
				OR lower(COALESCE(json_extract(er.pin_json, '$.shadow.model'), '')) GLOB 'gemini-*'
				OR lower(COALESCE(json_extract(er.pin_json, '$.shadow.model'), '')) GLOB 'semantic-ranker-*'
				OR lower(COALESCE(json_extract(er.pin_json, '$.shadow.model'), '')) GLOB 'text-embedding-*'
			   )
			   AND NOT EXISTS (
				SELECT 1 FROM ai_shadow_jobs sj WHERE sj.primary_run_id = er.id
			   )`,
		).bind(now - SHADOW_RECONCILE_LOOKBACK_MS),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_provider_reservations
			 WHERE provider = 'google-vertex' AND status IN ('reserved', 'invoking')`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_routing_policies
			 WHERE capability != '__global__' AND (
				primary_provider = 'google-vertex'
				OR fallback_provider = 'google-vertex'
				OR shadow_provider = 'google-vertex'
				OR mode IN ('google_only', 'google_primary_cf_fallback', 'cf_primary_google_fallback')
				OR (mode = 'canary' AND primary_provider = 'workers-ai')
			 )`,
		),
		env.DB.prepare(
			`SELECT CASE WHEN EXISTS (
				SELECT 1 FROM ai_provider_overrides
				 WHERE provider = 'google-vertex' AND disabled = 1
			 ) THEN 0 ELSE 1 END AS n`,
		),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_provider_health
			 WHERE provider = 'google-vertex' AND state = 'half_open'
			   AND COALESCE(probe_lease_until, 0) > ?`,
		).bind(now),
	]);
	const counts = {
		nonterminal_google_runs: Number(runs?.results?.[0]?.n ?? 0),
		nonterminal_google_atomic_runs: Number(atomic?.results?.[0]?.n ?? 0),
		pending_google_shadow_jobs: Number(shadow?.results?.[0]?.n ?? 0),
		reconcilable_google_shadow_runs: Number(reconcilableShadow?.results?.[0]?.n ?? 0),
		active_google_reservations: Number(reservations?.results?.[0]?.n ?? 0),
		google_admitting_policies: Number(policies?.results?.[0]?.n ?? 0),
		google_override_not_disabled: Number(override?.results?.[0]?.n ?? 1),
		active_google_probe_leases: Number(probes?.results?.[0]?.n ?? 0),
	};
	return { clean: Object.values(counts).every((n) => n === 0), counts };
}

/** One action: every lane to cloudflare_only, the google override disabled,
 * one audit row. Effective within one policy-cache TTL, no deploy. */
export async function emergencyDisable(env, { actorUserId, reason = "emergency" }) {
	const now = Date.now();
	const mutationId = newId("aipolicymut");
	const results = await env.DB.batch([
		env.DB.prepare(
			`UPDATE ai_routing_policies
			    SET mode='cloudflare_only', version=version+1, updated_at=?, updated_by=?, mutation_id=?
			  WHERE capability != '__global__'
			    AND NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			    )`,
		).bind(now, actorUserId, mutationId, actorUserId),
		env.DB.prepare(
			`INSERT INTO ai_routing_policies
			 (capability, mode, disabled, version, updated_at, updated_by, mutation_id)
			 SELECT '__global__', 'cloudflare_only', 1, 1, ?, ?, ?
			  WHERE NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			  )
			 ON CONFLICT(capability) DO UPDATE SET
			   disabled=1, version=version+1, updated_at=excluded.updated_at,
			   updated_by=excluded.updated_by, mutation_id=?
			 WHERE NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			 )`,
		).bind(now, actorUserId, mutationId, actorUserId, mutationId, actorUserId),
		env.DB.prepare(
			`INSERT INTO ai_provider_overrides (provider, disabled, actor_user_id, reason, updated_at)
			 SELECT 'google-vertex', 1, ?, ?, ?
			  WHERE NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			  )
			 ON CONFLICT(provider) DO UPDATE SET
			   disabled=1, actor_user_id=excluded.actor_user_id,
			   reason=excluded.reason, updated_at=excluded.updated_at
			 WHERE NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			 )`,
		).bind(actorUserId, reason, now, actorUserId, actorUserId),
		env.DB.prepare(
			`INSERT INTO ai_routing_policy_audit (id, capability, actor_user_id, changed_at, old_json, new_json, note)
			 SELECT ?, '__global__', ?, ?, NULL, '{"emergency":true}', ?
			  WHERE EXISTS (
				 SELECT 1 FROM ai_routing_policies
				  WHERE capability='__global__' AND mutation_id=?
			  )
			    AND NOT EXISTS (
				 SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?
			    )`,
		).bind(newId("aipolicy"), actorUserId, now, reason, mutationId, actorUserId),
	]);
	if (Number(results?.[1]?.meta?.changes ?? 0) !== 1) return { error: "account_erased" };
	resetPolicyCacheForTests();
	return { ok: true, max_staleness_seconds: 60 };
}
