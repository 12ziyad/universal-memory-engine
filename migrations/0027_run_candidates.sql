-- Migration number: 0027 	 2026-08-03T21:00:00.000Z
-- Candidates belong on the extraction ledger (found by the Part 9 gate).
--
-- extraction_runs records what each save created so delete-by-source can walk
-- it back. Candidates — the "weak maybe" waiting room — were the one created
-- object kind missing from that ledger, so a bulk delete removed every node,
-- slice, event and edge of a run and left its candidates behind, carrying
-- their evidence text with them. The acceptance run measured exactly that:
-- eight fictional candidates survived a "complete" delete.
--
-- Additive only.

ALTER TABLE extraction_runs ADD COLUMN created_candidates_json TEXT;
