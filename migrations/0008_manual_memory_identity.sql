-- Migration number: 0008 	 2026-07-10T00:00:00.000Z
-- MCP manual-door identity claims. This table is intentionally isolated from
-- AutoMode: it serializes creation of one canonical manual identity per user
-- without changing trigger/hold/fire behavior or rewriting existing node rows.

CREATE TABLE manual_node_identities (
	user_id TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	node_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, canonical_key)
);

CREATE INDEX idx_manual_node_identities_node
	ON manual_node_identities(user_id, node_id);

-- Exact manual fact claims complement node identity claims. They are kept in a
-- side table so the MCP lane can serialize create-vs-reinforce decisions without
-- imposing new uniqueness or merge behavior on the API/AutoMode tables.
CREATE TABLE manual_fact_identities (
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

CREATE INDEX idx_manual_fact_identities_object
	ON manual_fact_identities(user_id, object_kind, object_id);

CREATE INDEX idx_manual_fact_identities_nodes
	ON manual_fact_identities(user_id, owner_node_id, related_node_id);

-- MCP manual page claims and a revision used for optimistic page reinforcement.
-- API /v1/save does not use either primitive, so its behavior is unchanged.
ALTER TABLE memory_pages ADD COLUMN manual_revision INTEGER DEFAULT 0;

CREATE TABLE manual_page_identities (
	user_id TEXT NOT NULL,
	canonical_key TEXT NOT NULL,
	page_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, canonical_key)
);

CREATE INDEX idx_manual_page_identities_page
	ON manual_page_identities(user_id, page_id);
