-- Migration number: 0018 	 2026-08-01T00:00:00.000Z
-- Playground threads: a real conversation surface inside the app, so someone
-- can watch memory being captured while they talk instead of pressing two
-- isolated test buttons. Threads and messages only — the memory itself still
-- lives in nodes/slices/events, written by the one extraction pipeline.
--
-- `settings_json` holds the per-thread memory rules from the Settings tab.
-- They are merged over the account's saved rules at extraction time; nothing
-- here is a second rules system.

CREATE TABLE playground_threads (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	title TEXT,
	settings_json TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE INDEX idx_pg_threads_user ON playground_threads(user_id, updated_at DESC);

CREATE TABLE playground_messages (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL,          -- user | assistant
	content TEXT NOT NULL,
	extraction_json TEXT,        -- what the pipeline captured from this message
	created_at INTEGER
);

CREATE INDEX idx_pg_messages_thread ON playground_messages(thread_id, created_at);
-- The per-user daily message cap counts through this one.
CREATE INDEX idx_pg_messages_user_time ON playground_messages(user_id, created_at);
