-- Migration number: 0055 	 2026-08-22T00:00:04.000Z
-- Make provider spend admission a durable, distributed state machine.
--
-- The reservation row is the immutable price/model snapshot for one stable
-- operation id. A caller owns an invocation only while its attempt_token owns
-- the reserved -> invoking transition. Unknown provider outcomes are charged
-- conservatively rather than returned to the available-spend pool.
ALTER TABLE ai_provider_reservations ADD COLUMN model TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN capability TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN input_rate_per_million_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_reservations ADD COLUMN output_rate_per_million_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_reservations ADD COLUMN rank_rate_per_100_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_reservations ADD COLUMN base_estimated_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_reservations ADD COLUMN base_estimated_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_reservations ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_provider_reservations ADD COLUMN invoked_at INTEGER;
ALTER TABLE ai_provider_reservations ADD COLUMN ambiguous_reason TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN terminal_at INTEGER;

-- Content-free lifecycle provenance for the external-call linearization
-- point.  These values are server-derived from the active AI meter; request
-- metadata is never trusted for them.  A Google reservation may cross
-- reserved -> invoking only while the memory/account/project/run fences still
-- match this snapshot.  The narrow exemption is reserved for the synthetic
-- provider-health probe, whose fixed prompt contains no user content.
ALTER TABLE ai_provider_reservations ADD COLUMN memory_user_id TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN account_user_id TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN managed_project_id TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN project_lifecycle_epoch INTEGER;
ALTER TABLE ai_provider_reservations ADD COLUMN accepted_at INTEGER;
ALTER TABLE ai_provider_reservations ADD COLUMN scope TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN scope_id TEXT;
ALTER TABLE ai_provider_reservations ADD COLUMN lifecycle_exempt INTEGER NOT NULL DEFAULT 0
	CHECK (lifecycle_exempt IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_ai_reservations_memory_lifecycle
	ON ai_provider_reservations(memory_user_id, status, accepted_at);
CREATE INDEX IF NOT EXISTS idx_ai_reservations_account_lifecycle
	ON ai_provider_reservations(account_user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_reservations_project_lifecycle
	ON ai_provider_reservations(managed_project_id, status, project_lifecycle_epoch);

-- Pre-hardening terminal rows did not carry an explicit terminal timestamp.
-- Backfill it from their last durable transition without guessing for a live
-- reserved row whose outcome still belongs to the reaper.
UPDATE ai_provider_reservations
SET terminal_at = COALESCE(updated_at, created_at)
WHERE terminal_at IS NULL
  AND status NOT IN ('reserved', 'invoking');

-- Unique mutation ownership for policy CAS + audit. Timestamps and actors are
-- not unique under concurrent same-admin writes, so the audit append must key
-- off a token written only by the winning mutation.
ALTER TABLE ai_routing_policies ADD COLUMN mutation_id TEXT;

-- The breaker row, rather than isolate memory, owns the cooldown and the
-- single half-open probe lease. This makes all Workers isolates converge on
-- one decision and lets an expired probe recover after a crash.
ALTER TABLE ai_provider_health ADD COLUMN billing_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_provider_health ADD COLUMN opened_at INTEGER;
ALTER TABLE ai_provider_health ADD COLUMN cooldown_ms INTEGER NOT NULL DEFAULT 120000;
ALTER TABLE ai_provider_health ADD COLUMN cooldown_until INTEGER;
ALTER TABLE ai_provider_health ADD COLUMN probe_token TEXT;
ALTER TABLE ai_provider_health ADD COLUMN probe_lease_until INTEGER;

UPDATE ai_provider_health
SET opened_at = CASE WHEN state = 'open' THEN updated_at ELSE opened_at END,
	cooldown_until = CASE WHEN state = 'open' THEN updated_at + cooldown_ms ELSE cooldown_until END
WHERE state = 'open';
