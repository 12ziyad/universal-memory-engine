-- Migration number: 0054 	 2026-08-22T00:00:02.000Z
-- Shadow-extraction outbox (Phase 2 of the provider-adapter campaign).
--
-- CONTENT-MINIMIZED BY DESIGN: no prompt text and no model output is ever
-- stored here. The job row carries pointers + the pin; the drain re-derives
-- the input from the immutable source packet at execution time (so erasure is
-- structurally safe) and stores only content-free comparison metrics. The
-- table is user-scoped, joins PURGE_SPACE_TABLES, and is retention-capped by
-- the cron sweep. waitUntil may accelerate delivery later; D1 + cron IS the
-- durability mechanism, with claim/lease/attempts/terminal-status recovery.
CREATE TABLE ai_shadow_jobs (
	id TEXT PRIMARY KEY,              -- shadow_<sha256(primary_run_id)> — idempotent enqueue
	user_id TEXT NOT NULL,
	account_user_id TEXT,
	primary_run_id TEXT NOT NULL,     -- extraction_runs.id (join key to the primary ledger)
	provider TEXT NOT NULL,
	model TEXT,
	prompt_version TEXT,
	status TEXT NOT NULL,             -- pending|running|done|failed|cancelled_erased|cancelled_removed|dead_letter
	attempts INTEGER NOT NULL DEFAULT 0,
	lease_until INTEGER,
	comparison_json TEXT,             -- content-free metrics ONLY (counts, hashed-key overlap, enums)
	input_tokens INTEGER,
	output_tokens INTEGER,
	duration_ms INTEGER,
	error_class TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_shadow_jobs_drain ON ai_shadow_jobs(status, lease_until);
CREATE INDEX idx_shadow_jobs_user ON ai_shadow_jobs(user_id, created_at);
CREATE INDEX idx_shadow_jobs_created ON ai_shadow_jobs(created_at);
