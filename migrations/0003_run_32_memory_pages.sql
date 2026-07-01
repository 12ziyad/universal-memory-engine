-- Migration number: 0003 	 2026-07-01T00:00:00.000Z
-- Run 3.2: memory pages, extraction runs, suppression, and lightweight
-- resolver reinforcement metadata.

CREATE TABLE memory_pages (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	node_id TEXT,
	node_kind TEXT DEFAULT 'memory_page',
	source_mode TEXT DEFAULT 'manual_collect',
	title TEXT NOT NULL,
	canonical_title TEXT NOT NULL,
	topic_filter TEXT,
	short_summary TEXT,
	full_markdown TEXT,
	sections_json TEXT,
	key_points_json TEXT,
	decisions_json TEXT,
	next_steps_json TEXT,
	related_concepts_json TEXT,
	evidence_json TEXT,
	source_thread_id TEXT,
	source_conversation_id TEXT,
	extraction_run_id TEXT,
	receipt_id TEXT,
	created_at INTEGER,
	updated_at INTEGER,
	last_seen_at INTEGER,
	heat_score REAL DEFAULT 1,
	confidence REAL DEFAULT 0.8,
	health_state TEXT DEFAULT 'active',
	importance_class TEXT DEFAULT 'ordinary',
	cluster TEXT,
	role_type TEXT,
	deleted_at INTEGER,
	archived_at INTEGER,
	suppressed_at INTEGER
);

CREATE TABLE extraction_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	tool_name TEXT,
	source_mode TEXT,
	topic_filter TEXT,
	receipt_id TEXT,
	status TEXT,
	created_pages_json TEXT DEFAULT '[]',
	created_nodes_json TEXT DEFAULT '[]',
	created_slices_json TEXT DEFAULT '[]',
	created_events_json TEXT DEFAULT '[]',
	created_edges_json TEXT DEFAULT '[]',
	updated_objects_json TEXT DEFAULT '[]',
	reinforced_objects_json TEXT DEFAULT '[]',
	skipped_objects_json TEXT DEFAULT '[]',
	error TEXT,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE TABLE memory_suppressions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	label TEXT,
	reason TEXT,
	source_object_id TEXT,
	suppressed_until INTEGER,
	created_at INTEGER
);

ALTER TABLE nodes ADD COLUMN canonical_label TEXT;
ALTER TABLE nodes ADD COLUMN aliases_json TEXT;
ALTER TABLE nodes ADD COLUMN mention_count INTEGER DEFAULT 1;
ALTER TABLE nodes ADD COLUMN session_count INTEGER DEFAULT 1;
ALTER TABLE nodes ADD COLUMN last_seen_at INTEGER;
ALTER TABLE nodes ADD COLUMN heat_score REAL DEFAULT 1;
ALTER TABLE nodes ADD COLUMN confidence REAL;
ALTER TABLE nodes ADD COLUMN health_state TEXT DEFAULT 'active';
ALTER TABLE nodes ADD COLUMN importance_class TEXT DEFAULT 'ordinary';
ALTER TABLE nodes ADD COLUMN cluster TEXT;
ALTER TABLE nodes ADD COLUMN deleted_at INTEGER;
ALTER TABLE nodes ADD COLUMN archived_at INTEGER;
ALTER TABLE nodes ADD COLUMN suppressed_at INTEGER;

ALTER TABLE slices ADD COLUMN page_id TEXT;
ALTER TABLE slices ADD COLUMN reinforcement_count INTEGER DEFAULT 0;
ALTER TABLE slices ADD COLUMN last_seen_at INTEGER;
ALTER TABLE slices ADD COLUMN deleted_at INTEGER;

ALTER TABLE events ADD COLUMN reinforcement_count INTEGER DEFAULT 0;
ALTER TABLE events ADD COLUMN last_seen_at INTEGER;
ALTER TABLE events ADD COLUMN confidence REAL;
ALTER TABLE events ADD COLUMN deleted_at INTEGER;

ALTER TABLE edges ADD COLUMN reinforcement_count INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN weight REAL DEFAULT 1;
ALTER TABLE edges ADD COLUMN confidence REAL;
ALTER TABLE edges ADD COLUMN last_seen_at INTEGER;
ALTER TABLE edges ADD COLUMN evidence_count INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN deleted_at INTEGER;

ALTER TABLE candidates ADD COLUMN deleted_at INTEGER;
ALTER TABLE candidates ADD COLUMN suppressed_at INTEGER;

ALTER TABLE receipts ADD COLUMN extraction_run_id TEXT;
ALTER TABLE receipts ADD COLUMN saved_pages INTEGER DEFAULT 0;

CREATE INDEX idx_memory_pages_user_id ON memory_pages(user_id);
CREATE INDEX idx_memory_pages_canonical_title ON memory_pages(user_id, canonical_title);
CREATE INDEX idx_memory_pages_topic ON memory_pages(user_id, topic_filter);
CREATE INDEX idx_memory_pages_updated_at ON memory_pages(updated_at);
CREATE INDEX idx_extraction_runs_user_id ON extraction_runs(user_id);
CREATE INDEX idx_extraction_runs_created_at ON extraction_runs(created_at);
CREATE INDEX idx_memory_suppressions_lookup ON memory_suppressions(user_id, kind, canonical_key);
