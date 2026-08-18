-- Migration number: 0043     2026-08-18T00:00:00.000Z
-- Dashboard project-attributed AI series. The dashboard constrains every read
-- by managed_project_id and a bounded created_at window; keep that lookup on a
-- single covering prefix as the append-only AI ledger grows.

CREATE INDEX IF NOT EXISTS idx_ai_calls_project_created
	ON ai_calls(managed_project_id, created_at DESC)
	WHERE managed_project_id IS NOT NULL;
