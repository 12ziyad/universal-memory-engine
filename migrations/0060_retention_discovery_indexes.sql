-- Launch hardening, part 2 of the read-amplification work (0058 was part 1).
--
-- Retention scope discovery (src/lib/retention.js) matches extraction_runs
-- and receipts rows by json_extract(scope_json, ...) values. Those branches
-- sat inside one big OR, and SQLite's OR-optimization requires EVERY disjunct
-- to be independently indexable — one bare JSON expression forced a full
-- table scan of both ledgers on every retention preview, activation, and run
-- batch. The code restructures the query into UNION arms; these expression
-- indexes make the scope_json arms index-served. The predicate is the exact
-- json_valid() term the queries already carry, so the partial-index
-- implication is trivial for the planner.
CREATE INDEX IF NOT EXISTS idx_extraction_runs_scope_project
  ON extraction_runs(json_extract(scope_json, '$.managed_project_id'))
  WHERE json_valid(scope_json);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_scope_owner
  ON extraction_runs(json_extract(scope_json, '$.owner_user_id'))
  WHERE json_valid(scope_json);

CREATE INDEX IF NOT EXISTS idx_receipts_scope_project
  ON receipts(json_extract(scope_json, '$.managed_project_id'))
  WHERE json_valid(scope_json);

CREATE INDEX IF NOT EXISTS idx_receipts_scope_owner
  ON receipts(json_extract(scope_json, '$.owner_user_id'))
  WHERE json_valid(scope_json);

-- The retention delete lane guards receipts against live memory_jobs rows by
-- (user_id, receipt_id); receipt_id had no index, so that NOT EXISTS was a
-- per-row scan of the user's jobs.
CREATE INDEX IF NOT EXISTS idx_memory_jobs_user_receipt
  ON memory_jobs(user_id, receipt_id);
