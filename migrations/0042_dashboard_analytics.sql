-- Project dashboard read paths. Each aggregate joins the selected project's
-- finite memory-space registry, then constrains the ledger by time. These
-- composite indexes keep that metadata-only fan-in bounded as ledgers grow.

CREATE INDEX IF NOT EXISTS idx_receipts_user_created
	ON receipts(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_user_created
	ON memory_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_user_completed
	ON memory_jobs(user_id, completed_at DESC)
	WHERE completed_at IS NOT NULL;
