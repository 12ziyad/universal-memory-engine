-- V3 / E4: source-grounded zero-to-many semantic atom candidates.
--
-- This is an additive, write-only experiment lane. It does not participate in
-- recall until a later ablation earns that behavior. Every candidate points to
-- an already-scrubbed, rules-permitted source episode; no model output is ever
-- accepted as provenance by itself.

CREATE TABLE IF NOT EXISTS semantic_atom_capture_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	project_id TEXT,
	project_name TEXT,
	source_packet_id TEXT NOT NULL,
	extraction_run_id TEXT,
	chunk_key TEXT NOT NULL,
	status TEXT NOT NULL CONSTRAINT semantic_atom_capture_status
		CHECK (status IN ('running', 'completed', 'empty', 'failed', 'cancelled_by_delete')),
	model TEXT NOT NULL,
	schema_version TEXT NOT NULL,
	accepted_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 1,
	replay_count INTEGER NOT NULL DEFAULT 0,
	proposed_count INTEGER NOT NULL DEFAULT 0,
	accepted_count INTEGER NOT NULL DEFAULT 0,
	stored_count INTEGER NOT NULL DEFAULT 0,
	rejected_count INTEGER NOT NULL DEFAULT 0,
	duplicate_count INTEGER NOT NULL DEFAULT 0,
	truncated INTEGER NOT NULL DEFAULT 0,
	rejected_reasons_json TEXT,
	error_code TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER,
	UNIQUE (user_id, source_packet_id, chunk_key)
);

CREATE INDEX IF NOT EXISTS idx_semantic_atom_capture_runs_user
	ON semantic_atom_capture_runs (user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_capture_runs_packet
	ON semantic_atom_capture_runs (user_id, source_packet_id, chunk_key);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_capture_runs_extraction
	ON semantic_atom_capture_runs (user_id, extraction_run_id);

CREATE TABLE IF NOT EXISTS semantic_atom_candidates (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	memory_user_id TEXT,
	owner_user_id TEXT,
	external_user_id TEXT,
	project_id TEXT,
	project_name TEXT,
	capture_run_id TEXT NOT NULL,
	extraction_run_id TEXT,
	source_episode_id TEXT NOT NULL,
	source_packet_id TEXT NOT NULL,
	chunk_key TEXT NOT NULL,
	source_message_id TEXT NOT NULL,
	start_code_point INTEGER NOT NULL,
	end_code_point INTEGER NOT NULL,
	evidence_quote TEXT NOT NULL,
	evidence_hash TEXT NOT NULL,
	-- Stable across a later rescue/re-chunk of the same accepted source span.
	-- The candidate id still records the exact extraction chunk; this key stops
	-- that operational reshaping from creating duplicate semantic rows.
	dedupe_key TEXT NOT NULL,
	atom_type TEXT NOT NULL,
	entity TEXT NOT NULL,
	entity_type TEXT NOT NULL,
	attribute TEXT NOT NULL,
	value TEXT NOT NULL,
	assertion TEXT NOT NULL,
	raw_temporal_phrase TEXT,
	cardinality TEXT NOT NULL,
	confidence REAL NOT NULL,
	source_time INTEGER,
	source_time_offset_minutes INTEGER,
	source_time_precision TEXT,
	observed_at INTEGER,
	extraction_model TEXT NOT NULL,
	schema_version TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'candidate' CONSTRAINT semantic_atom_candidate_status
		CHECK (status IN ('candidate', 'promoted', 'ignored', 'superseded', 'historical')),
	created_at INTEGER NOT NULL,
	CONSTRAINT semantic_atom_span CHECK (
		start_code_point >= 0 AND end_code_point > start_code_point
	),
	CONSTRAINT semantic_atom_confidence CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_user
	ON semantic_atom_candidates (user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_project
	ON semantic_atom_candidates (user_id, project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_packet
	ON semantic_atom_candidates (user_id, source_packet_id, source_message_id);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_capture_run
	ON semantic_atom_candidates (user_id, capture_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_atom_candidates_dedupe
	ON semantic_atom_candidates (user_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_entity
	ON semantic_atom_candidates (user_id, project_id, entity, attribute);
