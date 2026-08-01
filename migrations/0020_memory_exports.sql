-- Migration number: 0020 	 2026-08-01T00:00:02.000Z
-- Memory exports: a job you start and come back to, rather than a request that
-- has to finish before the page responds. The work runs in the user's Durable
-- Object; this table is the record of it, and `data` holds the finished file.
--
-- `data` is capped by the exporter (see EXPORT_MAX_BYTES): a graph too large to
-- hold here fails with a message pointing at the direct download, which streams
-- and has no ceiling. It never silently truncates.

CREATE TABLE memory_exports (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	status TEXT NOT NULL,        -- queued | running | complete | failed
	format TEXT NOT NULL,        -- json
	entity TEXT,                 -- what the export covers
	object_count INTEGER,
	size_bytes INTEGER,
	error TEXT,
	data TEXT,
	created_at INTEGER,
	started_at INTEGER,
	completed_at INTEGER
);

CREATE INDEX idx_memory_exports_user ON memory_exports(user_id, created_at DESC);
