-- Migration number: 0050 	 2026-08-21T00:00:00.000Z
-- Conversation Pages: deterministic conversation identity + per-advance
-- source links.
--
-- conversation_key is set ONLY by the explicit conversation doors
-- (MCP save_conversation, REST /v1/save mode:"conversation") when the caller
-- supplied a stable conversation/thread id and CONVERSATION_PAGES is "on".
-- Existing rows keep NULL: unknown provenance is recorded truthfully, never
-- invented. Code may later adopt a legacy page into an identity only when
-- exactly one live page carries the same source_conversation_id in scope —
-- an evidence-based claim, CAS-guarded, and enforced by the unique index.
--
-- The partial unique index is the convergence authority: at most one LIVE
-- page per (account, project, conversation). A deleted page frees the key
-- (deliberate: suppression, not the index, is what blocks re-materializing a
-- deleted conversation page).

ALTER TABLE memory_pages ADD COLUMN conversation_key TEXT;
-- Truthful cached count of distinct linked messages across all advances,
-- maintained at finalize time; NULL on legacy rows (unknown, not zero).
ALTER TABLE memory_pages ADD COLUMN message_count INTEGER;

CREATE UNIQUE INDEX idx_memory_pages_conversation_identity
	ON memory_pages(user_id, COALESCE(project_id, ''), conversation_key)
	WHERE conversation_key IS NOT NULL AND deleted_at IS NULL;

-- One row per accepted explicit batch (advance) linked to a Conversation
-- Page. Ids only — the packet remains the content authority — but a link that
-- outlives the objects it names is still a record, so lifecycle deletion
-- covers this table (see src/lib/lifecycle_census.js).
CREATE TABLE conversation_page_sources (
	user_id TEXT NOT NULL,
	page_id TEXT NOT NULL,
	source_packet_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	created_at INTEGER,
	PRIMARY KEY (user_id, page_id, source_packet_id)
);

CREATE INDEX idx_conversation_page_sources_packet
	ON conversation_page_sources(user_id, source_packet_id);
CREATE INDEX idx_conversation_page_sources_page_seq
	ON conversation_page_sources(user_id, page_id, seq);
