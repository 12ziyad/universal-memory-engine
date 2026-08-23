-- Migration number: 0056 	 2026-08-22T00:00:04.000Z
-- Fenced ownership and completion-time retention for the shadow outbox.
--
-- A lease without an ownership token lets an expired worker settle work that a
-- newer worker already reclaimed. terminal_at separates "when this sample was
-- accepted" from "when its observational record became eligible to expire".
ALTER TABLE ai_shadow_jobs ADD COLUMN claim_token TEXT;
ALTER TABLE ai_shadow_jobs ADD COLUMN terminal_at INTEGER;

UPDATE ai_shadow_jobs
   SET terminal_at = COALESCE(terminal_at, updated_at)
 WHERE status IN (
   'done', 'failed', 'cancelled_erased', 'cancelled_removed',
   'cancelled_lifecycle', 'dead_letter'
 );

-- The hashed id is deterministic, but the primary-run uniqueness is the
-- invariant the outbox actually relies on. This also fences alternate
-- cancellation-marker ids created by an account-erasure transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_shadow_jobs_primary_run
  ON ai_shadow_jobs(primary_run_id);

CREATE INDEX IF NOT EXISTS idx_ai_shadow_jobs_due
  ON ai_shadow_jobs(status, lease_until, created_at, id);

CREATE INDEX IF NOT EXISTS idx_ai_shadow_jobs_terminal
  ON ai_shadow_jobs(status, terminal_at, id);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_shadow_reconcile
  ON extraction_runs(status, created_at, id)
  WHERE pin_json IS NOT NULL;
