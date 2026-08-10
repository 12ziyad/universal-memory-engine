-- V3 / E6: governed projection of source-grounded candidates into the proven
-- semantic graph. Additive only.
--
-- A candidate remains a proposal until the deterministic gates accept,
-- reinforce, or ignore it. This ledger binds that decision to the exact source
-- episode and semantic object. It contains no new user prose.

CREATE TABLE IF NOT EXISTS semantic_atom_projections (
	candidate_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	project_id TEXT,
	source_episode_id TEXT NOT NULL,
	source_packet_id TEXT NOT NULL,
	extraction_run_id TEXT NOT NULL,
	outcome TEXT NOT NULL CONSTRAINT semantic_atom_projection_outcome
		CHECK (outcome IN ('promoted', 'reinforced', 'ignored')),
	reason TEXT,
	object_kind TEXT CONSTRAINT semantic_atom_projection_object_kind
		CHECK (object_kind IS NULL OR object_kind IN ('slice', 'event', 'edge')),
	object_id TEXT,
	schema_version TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	CONSTRAINT semantic_atom_projection_object_pair CHECK (
		(object_kind IS NULL AND object_id IS NULL)
		OR (object_kind IS NOT NULL AND object_id IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_semantic_atom_projections_user
	ON semantic_atom_projections (user_id, outcome, created_at);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_projections_project
	ON semantic_atom_projections (user_id, project_id, outcome, created_at);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_projections_packet
	ON semantic_atom_projections (user_id, source_packet_id);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_projections_object
	ON semantic_atom_projections (user_id, object_kind, object_id);

-- Attribute/cardinality travel with projected assertions so a single-valued
-- update can retire only the same attribute. They are NULL on all historical
-- rows, preserving legacy behavior exactly.
ALTER TABLE slices ADD COLUMN semantic_attribute TEXT;
ALTER TABLE slices ADD COLUMN semantic_cardinality TEXT
	CHECK (semantic_cardinality IS NULL OR semantic_cardinality IN ('single', 'multi', 'unknown'));
ALTER TABLE slices ADD COLUMN valid_from INTEGER;
ALTER TABLE slices ADD COLUMN valid_to INTEGER;

-- E5's precision must survive projection. Legacy rows stay NULL and retain the
-- existing date rendering contract.
ALTER TABLE events ADD COLUMN semantic_attribute TEXT;
ALTER TABLE events ADD COLUMN semantic_cardinality TEXT
	CHECK (semantic_cardinality IS NULL OR semantic_cardinality IN ('single', 'multi', 'unknown'));
ALTER TABLE events ADD COLUMN event_time_end INTEGER;
ALTER TABLE events ADD COLUMN event_time_precision TEXT
	CHECK (event_time_precision IS NULL OR event_time_precision IN ('day', 'week', 'month', 'year'));
ALTER TABLE events ADD COLUMN event_time_relation TEXT
	CHECK (event_time_relation IS NULL OR event_time_relation IN ('at', 'during', 'since', 'until', 'range'));

CREATE INDEX IF NOT EXISTS idx_slices_semantic_attribute
	ON slices (user_id, project_id, node_id, semantic_attribute, is_current)
	WHERE semantic_attribute IS NOT NULL AND deleted_at IS NULL;
