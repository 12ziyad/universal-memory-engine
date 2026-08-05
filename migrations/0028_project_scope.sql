-- Migration number: 0028 	 2026-08-05T00:00:00.000Z
-- Project-scoped but account-discoverable memory.
--
-- NULL project_id is the authenticated account's global memory. A non-NULL
-- project_id is an isolated project inside that same account tenant. Existing
-- rows intentionally remain NULL; this migration never moves or rewrites data.

ALTER TABLE source_packets ADD COLUMN project_id TEXT;
ALTER TABLE source_packets ADD COLUMN project_name TEXT;

ALTER TABLE nodes ADD COLUMN project_id TEXT;
ALTER TABLE nodes ADD COLUMN project_name TEXT;

ALTER TABLE slices ADD COLUMN project_id TEXT;
ALTER TABLE slices ADD COLUMN project_name TEXT;

ALTER TABLE events ADD COLUMN project_id TEXT;
ALTER TABLE events ADD COLUMN project_name TEXT;

ALTER TABLE edges ADD COLUMN project_id TEXT;
ALTER TABLE edges ADD COLUMN project_name TEXT;

ALTER TABLE candidates ADD COLUMN project_id TEXT;
ALTER TABLE candidates ADD COLUMN project_name TEXT;

ALTER TABLE memory_pages ADD COLUMN project_id TEXT;
ALTER TABLE memory_pages ADD COLUMN project_name TEXT;

ALTER TABLE staged_memories ADD COLUMN project_id TEXT;
ALTER TABLE staged_memories ADD COLUMN project_name TEXT;

ALTER TABLE memory_suppressions ADD COLUMN project_id TEXT;
ALTER TABLE memory_suppressions ADD COLUMN project_name TEXT;

CREATE INDEX idx_source_packets_user_project
	ON source_packets(user_id, project_id, created_at);
CREATE INDEX idx_source_packets_owner_project
	ON source_packets(owner_user_id, project_id, updated_at);
CREATE INDEX idx_nodes_user_project
	ON nodes(user_id, project_id);
CREATE INDEX idx_slices_user_project_node
	ON slices(user_id, project_id, node_id);
CREATE INDEX idx_events_user_project_node
	ON events(user_id, project_id, node_id);
CREATE INDEX idx_edges_user_project
	ON edges(user_id, project_id);
CREATE INDEX idx_candidates_user_project
	ON candidates(user_id, project_id);
CREATE INDEX idx_memory_pages_user_project
	ON memory_pages(user_id, project_id, updated_at);
CREATE INDEX idx_staged_memories_user_project_live
	ON staged_memories(user_id, project_id, settled_at, created_at);
CREATE INDEX idx_memory_suppressions_project_lookup
	ON memory_suppressions(user_id, project_id, kind, canonical_key);
