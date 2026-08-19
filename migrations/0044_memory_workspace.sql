-- Migration number: 0044 	 2026-08-18T20:00:00.000Z
-- Memories workspace: object -> source provenance, plus the indexes the
-- server-side inventory, source and suggestion lists sort and filter on.
--
-- WHY A LINK TABLE. A memory page already carries source_packet_id. A node,
-- slice or event does not: the only durable trace of "which accepted write
-- produced this object" lives inside extraction_runs.created_*_json, which is
-- a JSON blob and therefore neither indexable nor joinable. Rendering a SOURCE
-- column from that would mean a full scan of every extraction run per page of
-- results. This table is that same fact, normalised once and indexed, so the
-- inventory can name a memory's origin in one indexed join.
--
-- IT ADDS NO NEW INFORMATION. Every row here is derived from extraction_runs,
-- which the account already owns; the backfill below reads exactly that. There
-- is no text column, so a link row can never hold memory content, a snippet, a
-- credential or a URL — only ids and the project the write belonged to.
--
-- DELETION. Rows are keyed by user_id and carry project_id, so account erasure
-- and project retention reach them with the same predicates every other memory
-- table uses. A dangling link (object deleted, link retained) is harmless: the
-- read path joins against live objects and drops links whose object is gone.

CREATE TABLE IF NOT EXISTS memory_source_links (
	user_id TEXT NOT NULL,
	-- node | slice | event. Pages are deliberately absent: memory_pages already
	-- has its own source_packet_id column and the read path uses it directly.
	object_kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	source_packet_id TEXT NOT NULL,
	project_id TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, object_kind, object_id, source_packet_id)
);

-- "Which memories came from this source?" — the Sources detail tab.
CREATE INDEX IF NOT EXISTS idx_memory_source_links_packet
	ON memory_source_links (user_id, source_packet_id, object_kind);
-- "Which source produced this memory?" — the inventory SOURCE column.
CREATE INDEX IF NOT EXISTS idx_memory_source_links_object
	ON memory_source_links (user_id, object_id);
-- Project retention and erasure sweep by scope.
CREATE INDEX IF NOT EXISTS idx_memory_source_links_project
	ON memory_source_links (user_id, project_id);

-- Backfill from the runs that already recorded this. json_each expands the
-- created_*_json arrays; every element is an object with an `id` field, so a
-- malformed or legacy element yields NULL and is filtered out rather than
-- writing a link to nothing.
INSERT OR IGNORE INTO memory_source_links
	(user_id, object_kind, object_id, source_packet_id, project_id, created_at)
SELECT r.user_id, 'node', json_extract(j.value, '$.id'), r.source_packet_id,
	json_extract(r.scope_json, '$.project_id'), COALESCE(r.created_at, 0)
FROM extraction_runs r, json_each(r.created_nodes_json) j
WHERE r.source_packet_id IS NOT NULL
	AND json_valid(r.created_nodes_json)
	AND json_extract(j.value, '$.id') IS NOT NULL;

INSERT OR IGNORE INTO memory_source_links
	(user_id, object_kind, object_id, source_packet_id, project_id, created_at)
SELECT r.user_id, 'slice', json_extract(j.value, '$.id'), r.source_packet_id,
	json_extract(r.scope_json, '$.project_id'), COALESCE(r.created_at, 0)
FROM extraction_runs r, json_each(r.created_slices_json) j
WHERE r.source_packet_id IS NOT NULL
	AND json_valid(r.created_slices_json)
	AND json_extract(j.value, '$.id') IS NOT NULL;

INSERT OR IGNORE INTO memory_source_links
	(user_id, object_kind, object_id, source_packet_id, project_id, created_at)
SELECT r.user_id, 'event', json_extract(j.value, '$.id'), r.source_packet_id,
	json_extract(r.scope_json, '$.project_id'), COALESCE(r.created_at, 0)
FROM extraction_runs r, json_each(r.created_events_json) j
WHERE r.source_packet_id IS NOT NULL
	AND json_valid(r.created_events_json)
	AND json_extract(j.value, '$.id') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inventory read paths.
--
-- Every list below is keyset-paginated on (sort_key DESC, id DESC) inside one
-- account, so the covering shape is (user_id, sort_expression, id). The sort
-- expression matches the SQL the reader emits exactly — COALESCE(...) included
-- — otherwise SQLite plans a scan and sort instead of walking the index.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_nodes_inventory_sort
	ON nodes (user_id, COALESCE(updated_at, created_at, 0), id);
CREATE INDEX IF NOT EXISTS idx_memory_pages_inventory_sort
	ON memory_pages (user_id, COALESCE(updated_at, created_at, 0), id);
CREATE INDEX IF NOT EXISTS idx_slices_inventory_sort
	ON slices (user_id, COALESCE(last_seen_at, created_at, 0), id);
CREATE INDEX IF NOT EXISTS idx_events_inventory_sort
	ON events (user_id, COALESCE(happened_at, created_at, 0), id);
CREATE INDEX IF NOT EXISTS idx_candidates_inventory_sort
	ON candidates (user_id, COALESCE(last_seen_at, created_at, 0), id);
CREATE INDEX IF NOT EXISTS idx_source_packets_inventory_sort
	ON source_packets (user_id, COALESCE(updated_at, created_at, 0), id);

-- Category facet and filter, for both object kinds that carry one.
CREATE INDEX IF NOT EXISTS idx_nodes_project_category
	ON nodes (user_id, project_category_id);
CREATE INDEX IF NOT EXISTS idx_memory_pages_project_category
	ON memory_pages (user_id, project_category_id);

-- Processing state for a source is the latest accept-time job for its packet.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_packet_recent
	ON memory_jobs (user_id, source_packet_id, created_at);

-- Connections satellite: edges touching one node, in both directions.
CREATE INDEX IF NOT EXISTS idx_edges_from_node
	ON edges (user_id, from_node, id);
CREATE INDEX IF NOT EXISTS idx_edges_to_node
	ON edges (user_id, to_node, id);
