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
