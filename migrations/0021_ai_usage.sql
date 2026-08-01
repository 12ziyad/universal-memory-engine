-- Migration number: 0021 	 2026-08-02T00:00:00.000Z
-- Workers AI accounting.
--
-- We are about to triple the number of model calls per save in the v2 engine,
-- and nobody could say what one save costs today. This records it, permanently.
--
-- `ai_calls` is one row per Workers AI call: which model, tokens in and out as
-- the binding reported them, and the raw usage blob so a later change in what
-- Workers AI returns is visible rather than silently averaged away. `neurons`
-- is only ever populated when the binding actually hands one back — a derived
-- figure does not belong in a column named after a billed unit.
--
-- The rollups on `receipts` are the per-save totals, so "what does a save cost"
-- is one query and not a join.

CREATE TABLE ai_calls (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	scope TEXT,                  -- save | recall | playground_chat | other
	scope_id TEXT,               -- extraction_run_id or recall packet id
	model TEXT NOT NULL,
	task TEXT,                   -- extract | digest | pass2 | embed | ...
	input_tokens INTEGER,
	output_tokens INTEGER,
	total_tokens INTEGER,
	neurons REAL,                -- ONLY if the binding reports it. Never derived.
	duration_ms INTEGER,
	ok INTEGER DEFAULT 1,
	raw_usage_json TEXT,
	created_at INTEGER
);

CREATE INDEX idx_ai_calls_scope ON ai_calls(scope, created_at);
CREATE INDEX idx_ai_calls_user ON ai_calls(user_id, created_at);
CREATE INDEX idx_ai_calls_scope_id ON ai_calls(scope_id);

-- Per-save rollups.
ALTER TABLE receipts ADD COLUMN ai_calls INTEGER;
ALTER TABLE receipts ADD COLUMN ai_input_tokens INTEGER;
ALTER TABLE receipts ADD COLUMN ai_output_tokens INTEGER;
ALTER TABLE receipts ADD COLUMN ai_neurons REAL;
