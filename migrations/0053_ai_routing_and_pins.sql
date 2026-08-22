-- Migration number: 0053 	 2026-08-22T00:00:01.000Z
-- Provider routing, deterministic pins, and reserve/settle spend accounting
-- (Phase 0B of the provider-adapter campaign). Everything here is INERT until
-- the AI_ROUTING var leaves "off": no code path reads these tables before the
-- routing engine is consulted, and no canonical table changes meaning.

-- Deterministic-retry pins. Nullable on purpose: NULL = legacy behavior
-- (Workers AI + config-of-the-day), so no historical row is invalidated and
-- full provider removal leaves nothing dangling. The claim-time ownership
-- re-read in src/lib/db.js enforces row-wins replay over these columns.
ALTER TABLE extraction_runs ADD COLUMN provider TEXT;
ALTER TABLE extraction_runs ADD COLUMN model TEXT;
ALTER TABLE extraction_runs ADD COLUMN pin_json TEXT;
-- The atomic lane already records model + schema_version (migration 0035);
-- it gains the provider half of the pin.
ALTER TABLE semantic_atom_capture_runs ADD COLUMN provider TEXT;

-- Per-capability routing policy. One row per capability plus the '__global__'
-- emergency row; every change is CAS-guarded on `version` and audited.
CREATE TABLE ai_routing_policies (
	capability TEXT PRIMARY KEY,
	mode TEXT NOT NULL DEFAULT 'cloudflare_only',
	primary_provider TEXT NOT NULL DEFAULT 'workers-ai',
	primary_model TEXT,
	fallback_provider TEXT,
	fallback_model TEXT,
	shadow_provider TEXT,
	shadow_model TEXT,
	shadow_sample_pct INTEGER NOT NULL DEFAULT 100,
	canary_pct INTEGER NOT NULL DEFAULT 0,
	allowlist_json TEXT,
	disabled INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL
);

CREATE TABLE ai_routing_policy_audit (
	id TEXT PRIMARY KEY,
	capability TEXT NOT NULL,
	actor_user_id TEXT NOT NULL,
	changed_at INTEGER NOT NULL,
	old_json TEXT,
	new_json TEXT,
	note TEXT
);
CREATE INDEX idx_ai_policy_audit_capability ON ai_routing_policy_audit(capability, changed_at);

-- The phone-friendly kill switch: read through the same cached snapshot as
-- policy, so disable propagates within one TTL with no deploy. The effective
-- state is AND of flag and override — this row can only ever REDUCE usage.
CREATE TABLE ai_provider_overrides (
	provider TEXT PRIMARY KEY,
	disabled INTEGER NOT NULL DEFAULT 0,
	actor_user_id TEXT,
	reason TEXT,
	updated_at INTEGER NOT NULL
);

-- Best-effort breaker convergence across isolates; content-free.
CREATE TABLE ai_provider_health (
	provider TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	reason TEXT,
	consecutive_failures INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

-- Reserve/settle spend ledger. Unit classes are NOT interchangeable —
-- gen_tokens, embed_tokens and rank_units carry separate daily ceilings; the
-- monthly monetary ceiling spans classes in conservative integer cost_micros
-- priced on a pinned rate-card version. Totals move ONLY inside the fenced
-- reservation batches in src/ai/provider_budget.js.
CREATE TABLE ai_provider_daily_totals (
	day TEXT NOT NULL,
	provider TEXT NOT NULL,
	unit_class TEXT NOT NULL,
	used_units INTEGER NOT NULL DEFAULT 0,
	reserved_units INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER,
	PRIMARY KEY (day, provider, unit_class)
);

CREATE TABLE ai_provider_monthly_costs (
	month TEXT NOT NULL,
	provider TEXT NOT NULL,
	used_cost_micros INTEGER NOT NULL DEFAULT 0,
	reserved_cost_micros INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER,
	PRIMARY KEY (month, provider)
);

CREATE TABLE ai_provider_reservations (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	unit_class TEXT NOT NULL,
	day TEXT NOT NULL,
	month TEXT NOT NULL,
	estimated_units INTEGER NOT NULL,
	estimated_cost_micros INTEGER NOT NULL,
	rate_card_version TEXT NOT NULL,
	attempt_token TEXT NOT NULL,
	settle_token TEXT,
	status TEXT NOT NULL,
	actual_units INTEGER,
	actual_cost_micros INTEGER,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_reservations_reap ON ai_provider_reservations(status, expires_at);
