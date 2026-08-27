-- Launch hardening: stop the two biggest silent read-amplifiers.
--
-- 1) The reconciliation sweep (src/pipeline/sweep.js) filters memory_jobs on
--    (status, updated_at) and (status, completed_at). Every existing index on
--    memory_jobs leads with user_id, so both cron queries were full table
--    scans, 576x/day, over a table nothing prunes — the bulk of the measured
--    5.29M rows read/24h with near-zero users.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_updated
  ON memory_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_completed
  ON memory_jobs(status, completed_at);

-- 2) Retention scope discovery (src/lib/retention.js) ORs an un-indexable
--    json_extract(raw_meta_json, '$.managed_project_id') branch into its
--    source_packets/extraction_runs/receipts scans, forcing full scans. That
--    branch exists only for rows written before migration 0040 introduced the
--    first-class managed_project_id column (the one insert path in
--    src/pipeline/source.js has set the column ever since). Materialize the
--    historical values so the JSON branch can be dropped from the queries.
--    Idempotent, fills NULLs only, never overwrites a first-class value —
--    matching the COALESCE precedence the read side already used.
UPDATE source_packets
   SET managed_project_id = json_extract(raw_meta_json, '$.managed_project_id')
 WHERE managed_project_id IS NULL
   AND raw_meta_json IS NOT NULL
   AND json_valid(raw_meta_json)
   AND json_type(raw_meta_json, '$.managed_project_id') = 'text';
