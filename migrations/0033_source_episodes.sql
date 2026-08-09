-- V3 / P0-D: searchable source episodes.
--
-- WHY. 64.6% of the LLM-judge baseline's misses are "never stored": the fact was
-- in the conversation and no memory was written for it. Once extraction has
-- declined a message there is nothing left to find, because the only durable
-- trace is a 240-character snippet inside source_packets.raw_meta_json, which is
-- not indexed and is not a retrieval surface. One conservative model pass
-- therefore makes allowed evidence permanently unrecoverable.
--
-- WHAT THIS IS NOT. An episode is NOT an unscrubbed copy of the conversation.
-- Secret scrubbing already ran before anything durable saw the text
-- (src/pipeline/ingest.js calls scrubMessages before the packet is normalised),
-- and the writer additionally enforces the account's exclude rules and fails
-- closed if it cannot load them. There is no privacy-bypassing archive here:
-- content the user asked us never to keep does not reach this table.
--
-- DELETION IS HARD, NOT SOFT. Everywhere else a tombstone is right, because the
-- row is derived memory and its history has support value. This row is the
-- user's own words. A soft-deleted episode is retained text with a flag on it,
-- so erasure removes the row and the FTS triggers remove its tokens with it.

CREATE TABLE IF NOT EXISTS source_episodes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	-- Scope, mirroring source_packets exactly. Every read filters on user_id and,
	-- for scoped recall, project_id. Nothing here may be reachable from another
	-- account, another sub-tenant, or another project.
	memory_user_id TEXT,
	owner_user_id TEXT,
	external_user_id TEXT,
	project_id TEXT,
	project_name TEXT,
	-- Provenance: which accepted write, which conversation, which message.
	source_packet_id TEXT,
	conversation_id TEXT,
	thread_id TEXT,
	session_id TEXT,
	message_id TEXT,
	message_index INTEGER NOT NULL DEFAULT 0,
	role TEXT NOT NULL DEFAULT 'user',
	-- The permitted text: scrubbed, rules-filtered, capped.
	text TEXT NOT NULL,
	text_hash TEXT NOT NULL,
	-- BF-1: when it was written, and separately when we saw it.
	source_time INTEGER,
	source_time_offset_minutes INTEGER,
	source_time_precision TEXT,
	observed_at INTEGER,
	created_at INTEGER NOT NULL,
	-- Replay writes the same episode twice; identity makes that a no-op rather
	-- than a duplicate. A message id is unique within an account by construction
	-- (stableSourceMessageId hashes conversation + role + content).
	UNIQUE (user_id, source_packet_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_source_episodes_user
	ON source_episodes (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_source_episodes_packet
	ON source_episodes (user_id, source_packet_id);
CREATE INDEX IF NOT EXISTS idx_source_episodes_project
	ON source_episodes (user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_source_episodes_conversation
	ON source_episodes (user_id, conversation_id, message_index);
CREATE INDEX IF NOT EXISTS idx_source_episodes_source_time
	ON source_episodes (user_id, source_time)
	WHERE source_time IS NOT NULL;

-- The FTS index stores tokens only; source_episodes stays the external content
-- table, and the three triggers keep the two representations consistent. This
-- is what makes erasure converge: removing the row removes its tokens in the
-- same statement, so a deleted episode cannot survive in the search index.
CREATE VIRTUAL TABLE IF NOT EXISTS source_episodes_fts USING fts5(
	text,
	content = 'source_episodes',
	content_rowid = 'rowid',
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS source_episodes_ai
AFTER INSERT ON source_episodes
BEGIN
	INSERT INTO source_episodes_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS source_episodes_ad
AFTER DELETE ON source_episodes
BEGIN
	INSERT INTO source_episodes_fts(source_episodes_fts, rowid, text)
	VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS source_episodes_au
AFTER UPDATE ON source_episodes
BEGIN
	INSERT INTO source_episodes_fts(source_episodes_fts, rowid, text)
	VALUES ('delete', old.rowid, old.text);
	INSERT INTO source_episodes_fts(rowid, text) VALUES (new.rowid, new.text);
END;
