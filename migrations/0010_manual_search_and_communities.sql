-- Migration number: 0010 	 2026-07-12T00:00:00.000Z
-- MCP-manual derived search profiles, FTS5 retrieval, and topic communities.
-- These tables are side indexes only. Canonical graph/page writes remain in the
-- existing tables and must never depend on a derived-profile refresh succeeding.

CREATE TABLE IF NOT EXISTS manual_search_profiles (
	user_id TEXT NOT NULL,
	object_kind TEXT NOT NULL CHECK (object_kind IN ('node', 'page')),
	object_id TEXT NOT NULL,
	identity_text TEXT NOT NULL DEFAULT '',
	semantic_text TEXT NOT NULL DEFAULT '',
	context_text TEXT NOT NULL DEFAULT '',
	profile_hash TEXT NOT NULL,
	source_updated_at INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, object_kind, object_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_search_profiles_object
	ON manual_search_profiles(user_id, object_id, object_kind);

-- The FTS index stores only tokens. manual_search_profiles remains the external
-- content table and the three triggers keep both representations consistent.
CREATE VIRTUAL TABLE IF NOT EXISTS manual_search_fts USING fts5(
	identity_text,
	semantic_text,
	context_text,
	content = 'manual_search_profiles',
	content_rowid = 'rowid',
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS manual_search_profiles_ai
AFTER INSERT ON manual_search_profiles
BEGIN
	INSERT INTO manual_search_fts(rowid, identity_text, semantic_text, context_text)
	VALUES (new.rowid, new.identity_text, new.semantic_text, new.context_text);
END;

CREATE TRIGGER IF NOT EXISTS manual_search_profiles_ad
AFTER DELETE ON manual_search_profiles
BEGIN
	INSERT INTO manual_search_fts(manual_search_fts, rowid, identity_text, semantic_text, context_text)
	VALUES ('delete', old.rowid, old.identity_text, old.semantic_text, old.context_text);
END;

CREATE TRIGGER IF NOT EXISTS manual_search_profiles_au
AFTER UPDATE ON manual_search_profiles
BEGIN
	INSERT INTO manual_search_fts(manual_search_fts, rowid, identity_text, semantic_text, context_text)
	VALUES ('delete', old.rowid, old.identity_text, old.semantic_text, old.context_text);
	INSERT INTO manual_search_fts(rowid, identity_text, semantic_text, context_text)
	VALUES (new.rowid, new.identity_text, new.semantic_text, new.context_text);
END;

CREATE TABLE IF NOT EXISTS topic_communities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	label TEXT NOT NULL,
	summary TEXT,
	confidence REAL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (user_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_topic_communities_user
	ON topic_communities(user_id, updated_at);

CREATE TABLE IF NOT EXISTS node_topic_communities (
	user_id TEXT NOT NULL,
	community_id TEXT NOT NULL,
	node_id TEXT NOT NULL,
	confidence REAL,
	source_packet_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, community_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_node_topic_communities_node
	ON node_topic_communities(user_id, node_id, community_id);

-- Backfill active graph objects. The `legacy:` marker deliberately differs
-- from runtime SHA-256 hashes so the first bounded MCP refresh can hydrate a
-- richer profile and its single semantic vector.
INSERT INTO manual_search_profiles
	(user_id, object_kind, object_id, identity_text, semantic_text, context_text,
	 profile_hash, source_updated_at, created_at, updated_at)
SELECT
	n.user_id,
	'node',
	n.id,
	trim(
		COALESCE(n.label, '') || ' ' ||
		COALESCE(n.canonical_label, '') || ' ' ||
		COALESCE(n.aliases_json, '') || ' ' ||
		CASE WHEN instr(trim(COALESCE(n.label, '')), ' ') > 0 THEN
			lower(
				substr(trim(n.label), 1, 1) ||
				substr(ltrim(substr(trim(n.label), instr(trim(n.label), ' ') + 1)), 1, 1)
			) ||
			CASE WHEN n.category = 'organization' AND lower(n.label) GLOB '* united*' THEN
				' ' || lower(
					substr(trim(n.label), 1, 1) ||
					substr(ltrim(substr(trim(n.label), instr(trim(n.label), ' ') + 1)), 1, 1)
				) || 'fc'
			ELSE '' END || ' '
		ELSE '' END ||
		COALESCE((
			SELECT group_concat(identity.canonical_key, ' ')
			FROM manual_node_identities AS identity
			WHERE identity.user_id = n.user_id AND identity.node_id = n.id
		), '')
	),
	trim(COALESCE(n.summary, '')),
	trim(
		COALESCE(n.category, '') || ' ' ||
		COALESCE(n.role, '') || ' ' ||
		COALESCE(n.state, '') || ' ' ||
		COALESCE(n.cluster, '')
	),
	'legacy:node:' || n.id || ':' || COALESCE(n.updated_at, n.created_at, 0),
	COALESCE(n.updated_at, n.created_at, 0),
	COALESCE(n.created_at, 0),
	COALESCE(n.updated_at, n.created_at, 0)
FROM nodes AS n
WHERE n.deleted_at IS NULL
	AND n.archived_at IS NULL
	AND n.suppressed_at IS NULL
ON CONFLICT(user_id, object_kind, object_id) DO NOTHING;

INSERT INTO manual_search_profiles
	(user_id, object_kind, object_id, identity_text, semantic_text, context_text,
	 profile_hash, source_updated_at, created_at, updated_at)
SELECT
	p.user_id,
	'page',
	p.id,
	trim(
		COALESCE(p.title, '') || ' ' ||
		COALESCE(p.canonical_title, '') || ' ' ||
		COALESCE(p.topic_filter, '') || ' ' ||
		COALESCE((
			SELECT group_concat(identity.canonical_key, ' ')
			FROM manual_page_identities AS identity
			WHERE identity.user_id = p.user_id AND identity.page_id = p.id
		), '')
	),
	trim(substr(
		COALESCE(p.short_summary, '') || ' ' ||
		COALESCE(p.sections_json, '') || ' ' ||
		COALESCE(p.key_points_json, '') || ' ' ||
		COALESCE(p.decisions_json, '') || ' ' ||
		COALESCE(p.next_steps_json, '') || ' ' ||
		COALESCE(p.related_concepts_json, '') || ' ' ||
		COALESCE(p.full_markdown, ''),
		1,
		12000
	)),
	trim(
		COALESCE(p.node_id, '') || ' ' ||
		COALESCE(p.source_thread_id, '') || ' ' ||
		COALESCE(p.source_conversation_id, '') || ' ' ||
		COALESCE(p.cluster, '')
	),
	'legacy:page:' || p.id || ':' || COALESCE(p.updated_at, p.created_at, 0),
	COALESCE(p.updated_at, p.created_at, 0),
	COALESCE(p.created_at, 0),
	COALESCE(p.updated_at, p.created_at, 0)
FROM memory_pages AS p
WHERE p.deleted_at IS NULL
	AND p.archived_at IS NULL
	AND p.suppressed_at IS NULL
ON CONFLICT(user_id, object_kind, object_id) DO NOTHING;

-- Creating triggers does not index rows that predate them. A rebuild is cheap
-- here and is also a consistency fence if a partially-created local schema is
-- repaired before this migration is recorded.
INSERT INTO manual_search_fts(manual_search_fts) VALUES ('rebuild');
