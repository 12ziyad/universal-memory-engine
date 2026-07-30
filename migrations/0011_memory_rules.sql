-- Migration number: 0011 	 2026-07-30T00:00:00.000Z
-- Per-user memory rules: what to collect, what to refuse, capture defaults,
-- and the /v1/turn auto-collect switch. One row per user.

CREATE TABLE memory_rules (
	user_id TEXT PRIMARY KEY,
	custom_instructions TEXT DEFAULT '',
	includes_json TEXT DEFAULT '[]',
	excludes_json TEXT DEFAULT '[]',
	custom_categories_json TEXT DEFAULT '[]',
	capture_default TEXT DEFAULT 'auto',
	auto_collect INTEGER DEFAULT 1,
	retention_days INTEGER,
	created_at INTEGER,
	updated_at INTEGER
);
