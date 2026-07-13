-- Migration number: 0009 	 2026-07-11T00:00:00.000Z
-- Forward-only repair for databases that applied the original, shorter 0008
-- before the manual fact/page identity tables were appended to that filename.
-- Keep these definitions in a new migration: D1 records applied migrations by
-- filename and does not replay an older file after its contents change.

CREATE TABLE IF NOT EXISTS manual_node_identities (
	user_id TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	node_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_manual_node_identities_node
	ON manual_node_identities(user_id, node_id);

CREATE TABLE IF NOT EXISTS manual_fact_identities (
	user_id TEXT NOT NULL,
	fact_key TEXT NOT NULL,
	object_kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	owner_node_id TEXT NOT NULL,
	related_node_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_manual_fact_identities_object
	ON manual_fact_identities(user_id, object_kind, object_id);

CREATE INDEX IF NOT EXISTS idx_manual_fact_identities_nodes
	ON manual_fact_identities(user_id, owner_node_id, related_node_id);

CREATE TABLE IF NOT EXISTS manual_page_identities (
	user_id TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	page_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_manual_page_identities_page
	ON manual_page_identities(user_id, page_id);

-- MCP manual page compare-and-swap state lives outside memory_pages. This avoids
-- depending on the manual_revision column that some databases never received.
-- write_token is a transient, single-batch capability. It is NULL at rest and
-- is cleared after the guarded page update so a stale plan cannot replay it.
CREATE TABLE IF NOT EXISTS manual_page_versions (
	user_id TEXT NOT NULL,
	page_id TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 0,
	write_token TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_page_versions_page
	ON manual_page_versions(page_id, user_id);

-- Cleanup advances this per-user epoch before releasing a page identity. A
-- creator planned against an older epoch can no longer reclaim that identity
-- after archive/delete/reset, while a newly planned save reads the new epoch.
CREATE TABLE IF NOT EXISTS manual_page_write_epochs (
	user_id TEXT PRIMARY KEY,
	epoch INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

-- Give active legacy manual_collect pages a deterministic starting revision.
-- This includes compatibility /v1/save pages because that lane uses the same
-- source_mode; only MCP updates consume the ledger in this patch.
INSERT INTO manual_page_versions (user_id, page_id, revision, write_token, updated_at)
SELECT user_id, id, 0, NULL, COALESCE(updated_at, created_at, 0)
FROM memory_pages
WHERE source_mode = 'manual_collect'
	AND deleted_at IS NULL
	AND archived_at IS NULL
	AND suppressed_at IS NULL
ON CONFLICT(user_id, page_id) DO NOTHING;
