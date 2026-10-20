-- Aven's AI tool keys use a third grant purpose, "agent": read, search, add and
-- capture memory in one project, never edit, delete or manage. SQLite cannot
-- change a CHECK in place, so the table is rebuilt with the same rows.
CREATE TABLE aven_background_grants_next (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('automation','github_connection','agent')),
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
INSERT INTO aven_background_grants_next SELECT id,token_hash,user_id,project_id,purpose,resource_id,created_at,revoked_at FROM aven_background_grants;
DROP TABLE aven_background_grants;
ALTER TABLE aven_background_grants_next RENAME TO aven_background_grants;
CREATE INDEX idx_aven_background_owner ON aven_background_grants(user_id, project_id);
