-- Migration number: 0026 	 2026-08-03T18:00:00.000Z
-- Read-your-writes for every lane (fix round 1, Part 8.2).
--
-- The 0.3 trace measured the gap: a user says "my name is X" and asks
-- "what's my name" five seconds later, while extraction is still running.
-- MCP staged pages exposed only their first line; add()/ingest() content
-- lived ONLY in Durable Object storage and was invisible to recall entirely.
--
-- staged_memories holds the SCRUBBED per-message text of every accepted
-- write, from stage time until its job settles. Recall reads it as one more
-- signal, so the answer comes back instead of "still processing". When
-- enrichment lands, the row is settled (soft, for audit) and stops matching:
-- the graph now holds the same content, better structured. This table is a
-- staging index, never a source of truth — deleting all of it would cost
-- nothing but a few seconds of read-your-writes.
--
-- Additive only, as always: FTS5 external-content + triggers mirror the
-- manual_search_profiles pattern already in 0010.

CREATE TABLE IF NOT EXISTS staged_memories (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	job_id TEXT,
	source_packet_id TEXT,
	lane TEXT,
	message_id TEXT,
	text TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_staged_memories_live
	ON staged_memories(user_id, settled_at, created_at);
CREATE INDEX IF NOT EXISTS idx_staged_memories_job
	ON staged_memories(user_id, job_id);

CREATE VIRTUAL TABLE IF NOT EXISTS staged_memories_fts USING fts5(
	text,
	content = 'staged_memories',
	content_rowid = 'rowid',
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS staged_memories_ai
AFTER INSERT ON staged_memories
BEGIN
	INSERT INTO staged_memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS staged_memories_ad
AFTER DELETE ON staged_memories
BEGIN
	INSERT INTO staged_memories_fts(staged_memories_fts, rowid, text)
	VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS staged_memories_au
AFTER UPDATE ON staged_memories
BEGIN
	INSERT INTO staged_memories_fts(staged_memories_fts, rowid, text)
	VALUES ('delete', old.rowid, old.text);
	INSERT INTO staged_memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
