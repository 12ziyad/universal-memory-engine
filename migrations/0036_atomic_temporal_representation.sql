-- V3 / E5: deterministic temporal representation for source-grounded atoms.
--
-- The E4 candidate already preserves the exact raw phrase, its exact scrubbed
-- source episode, authoritative source time, offset, and observed time. These
-- additive columns store only what deterministic code can resolve from that
-- evidence. NULL is meaningful: absent, vague, invalid, or anchorless phrases
-- are never converted into invented dates.
--
-- This remains a write-only candidate lane. The index prepares a later bounded
-- temporal retrieval ablation but does not put candidates into recall by itself.

ALTER TABLE semantic_atom_candidates ADD COLUMN event_time INTEGER;
ALTER TABLE semantic_atom_candidates ADD COLUMN event_time_end INTEGER;
ALTER TABLE semantic_atom_candidates ADD COLUMN event_time_precision TEXT
	CHECK (event_time_precision IS NULL OR event_time_precision IN ('day', 'week', 'month', 'year'));
ALTER TABLE semantic_atom_candidates ADD COLUMN event_time_relation TEXT
	CHECK (event_time_relation IS NULL OR event_time_relation IN ('at', 'during', 'since', 'until', 'range'));
ALTER TABLE semantic_atom_candidates ADD COLUMN event_time_source TEXT
	CHECK (event_time_source IS NULL OR event_time_source = 'phrase');
ALTER TABLE semantic_atom_candidates ADD COLUMN event_time_anchor TEXT
	CHECK (event_time_anchor IS NULL OR event_time_anchor IN ('source_time', 'observed_at'));
ALTER TABLE semantic_atom_candidates ADD COLUMN temporal_schema TEXT;

ALTER TABLE semantic_atom_capture_runs ADD COLUMN temporal_phrase_count INTEGER NOT NULL DEFAULT 0
	CHECK (temporal_phrase_count >= 0);
ALTER TABLE semantic_atom_capture_runs ADD COLUMN temporal_resolved_count INTEGER NOT NULL DEFAULT 0
	CHECK (temporal_resolved_count >= 0);
ALTER TABLE semantic_atom_capture_runs ADD COLUMN temporal_unresolved_count INTEGER NOT NULL DEFAULT 0
	CHECK (temporal_unresolved_count >= 0);
ALTER TABLE semantic_atom_capture_runs ADD COLUMN temporal_anchor_missing_count INTEGER NOT NULL DEFAULT 0
	CHECK (temporal_anchor_missing_count >= 0);

CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_event_time
	ON semantic_atom_candidates (user_id, project_id, event_time, status)
	WHERE event_time IS NOT NULL;
