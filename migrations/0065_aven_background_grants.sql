-- Explicit first-party background delegation, independent of browser sessions.
-- Tokens are hash-only here; Aven retains encrypted credentials server-side.
CREATE TABLE aven_background_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('automation','github_connection')),
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_aven_background_owner ON aven_background_grants(user_id, project_id);
