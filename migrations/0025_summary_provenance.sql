-- Migration number: 0025 	 2026-08-03T12:00:00.000Z
-- Summary provenance (fix round 1, Part 3.4).
--
-- A node's summary is composed from specific slices and events. Recording
-- WHICH ones (their ids, as JSON) is what makes deletion real: when a fact is
-- deleted, every summary built from it is identifiable and regenerated from
-- surviving facts only — no third pass, no residue. Additive only, as always
-- (FTS5 virtual tables block full SQL exports; nothing here rewrites rows).

ALTER TABLE nodes ADD COLUMN summary_sources_json TEXT;
