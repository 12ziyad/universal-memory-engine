-- Migration number: 0002 	 2026-06-26T00:00:00.000Z
-- Receipts (Priority 5): one row per save attempt, so the UI "Saves" page can
-- show exactly what each tool call saved/skipped. `detail` holds the full
-- structured receipt as JSON; the flat columns make counts cheap to query.

CREATE TABLE receipts (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	source TEXT,            -- save_memory | save_conversation | ingest | ui_test
	outcome TEXT,           -- wrote | meaningful_no_write | llm_failed | db_write_failed
	summary TEXT,           -- the human one-liner returned to the tool
	saved_total INTEGER DEFAULT 0,
	saved_nodes INTEGER DEFAULT 0,
	saved_slices INTEGER DEFAULT 0,
	saved_events INTEGER DEFAULT 0,
	saved_edges INTEGER DEFAULT 0,
	saved_candidates INTEGER DEFAULT 0,
	updated_nodes INTEGER DEFAULT 0,
	skipped INTEGER DEFAULT 0,
	received INTEGER,
	digested INTEGER,
	detail TEXT,            -- JSON: full receipt (labels, skippedReasons, …)
	created_at INTEGER
);

CREATE INDEX idx_receipts_user_id ON receipts(user_id);
CREATE INDEX idx_receipts_created_at ON receipts(created_at);
