-- Migration number: 0047 	 2026-08-19
-- Safe memory updates: canonical revision tracking, immutable bounded history,
-- update idempotency, and projection convergence state.
--
-- Additive only. `revision` is NULL for every pre-feature row and is read as 1
-- (the captured baseline). Every system writer that changes a semantic field
-- bumps it; explicit updates CAS on it. History rows are customer content and
-- are erased by single-object delete, retention, project purge/delete, and
-- account erasure — never a permanent shadow copy.

ALTER TABLE nodes ADD COLUMN revision INTEGER;
ALTER TABLE memory_pages ADD COLUMN revision INTEGER;
ALTER TABLE slices ADD COLUMN revision INTEGER;
ALTER TABLE events ADD COLUMN revision INTEGER;

-- One row per recorded revision of one object. `snapshot_json` holds the
-- editable fields only, canonical key order; enough to reconstruct that
-- revision of the object's user-visible semantic content.
CREATE TABLE memory_revisions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	project_id TEXT,
	object_kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	parent_revision INTEGER,
	action TEXT NOT NULL,              -- baseline | system | update | rollback
	snapshot_json TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	actor_class TEXT NOT NULL,         -- user | token | system
	actor_ref TEXT,                    -- session user id or token id; never a secret
	idempotency_hash TEXT,
	rollback_of INTEGER,               -- for action='rollback': source revision
	reason TEXT,                       -- optional user-supplied correction reason (content)
	lifecycle_epoch INTEGER,
	created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_revisions_object_rev ON memory_revisions(object_id, revision);
CREATE INDEX idx_memory_revisions_user_object ON memory_revisions(user_id, object_id, revision DESC);
CREATE INDEX idx_memory_revisions_user ON memory_revisions(user_id, created_at);

-- Update/rollback idempotency claims. Replay of the same normalized request
-- returns the stored result; a different request under the same key conflicts.
CREATE TABLE memory_update_idempotency (
	user_id TEXT NOT NULL,
	idem_key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	object_id TEXT NOT NULL,
	action TEXT NOT NULL,
	result_revision INTEGER,
	result_json TEXT,                  -- bounded stored response (content; erasable)
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX idx_memory_update_idem_object ON memory_update_idempotency(user_id, object_id);

-- Convergence truth for derived projections of one object's current head.
-- status: pending | ready | failed. The cron sweep repairs pending/failed rows
-- by recomputing from the CURRENT canonical row, so completion order of
-- provider mutations can never leave a stale projection recorded as ready.
CREATE TABLE memory_projection_state (
	user_id TEXT NOT NULL,
	object_id TEXT NOT NULL,
	projection TEXT NOT NULL,          -- search | vector
	applied_revision INTEGER,
	status TEXT NOT NULL,
	attempts INTEGER DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, object_id, projection)
);
CREATE INDEX idx_memory_projection_pending ON memory_projection_state(status, updated_at);
