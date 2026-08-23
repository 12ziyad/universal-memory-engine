-- Passwordless identity, one-time account onboarding, and durable UI scope.
-- Additive-only: existing accounts are marked complete so this release never
-- strands an established user behind a first-run flow.

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'email')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON auth_identities(user_id, provider);

CREATE INDEX IF NOT EXISTS idx_auth_identities_email
  ON auth_identities(provider_email, provider)
  WHERE provider_email IS NOT NULL;

INSERT OR IGNORE INTO auth_identities
  (id, user_id, provider, provider_subject, provider_email, email_verified_at, created_at, updated_at)
SELECT
  'aid_' || lower(hex(randomblob(16))),
  id,
  'google',
  google_sub,
  email_normalized,
  email_verified_at,
  created_at,
  updated_at
FROM users
WHERE google_sub IS NOT NULL AND trim(google_sub) <> '';

CREATE TABLE IF NOT EXISTS auth_email_challenges (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_hmac TEXT NOT NULL,
  code_mac TEXT NOT NULL,
  browser_token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'signin' CHECK (purpose IN ('signin')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  invalidated_at INTEGER,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_auth_email_challenges_email_created
  ON auth_email_challenges(email_hmac, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_email_challenges_expiry
  ON auth_email_challenges(expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- Housekeeping also ages out consumed/invalidated rows at their original
-- ten-minute expiry. This broad index keeps the bounded cron slice indexable
-- without an OR scan over terminal-state columns.
CREATE INDEX IF NOT EXISTS idx_auth_email_challenges_cleanup
  ON auth_email_challenges(expires_at, id);

CREATE TABLE IF NOT EXISTS account_onboarding (
  user_id TEXT PRIMARY KEY,
  organization_id TEXT,
  project_id TEXT,
  workspace_name TEXT,
  use_scope TEXT CHECK (use_scope IS NULL OR use_scope IN ('personal', 'team', 'product')),
  use_case TEXT,
  use_case_other TEXT,
  heard_about TEXT,
  heard_about_other TEXT,
  conversation_sample TEXT,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES managed_projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_account_onboarding_completed
  ON account_onboarding(completed_at)
  WHERE completed_at IS NOT NULL;

-- Established accounts remain established. Only identities created after this
-- migration enter the first-run onboarding flow.
INSERT OR IGNORE INTO account_onboarding
  (user_id, completed_at, created_at, updated_at, revision)
SELECT id, CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000, 1
FROM users;

CREATE TABLE IF NOT EXISTS user_scope_preferences (
  user_id TEXT PRIMARY KEY,
  selected_org_id TEXT,
  selected_project_id TEXT,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_org_id) REFERENCES organizations(id) ON DELETE SET NULL,
  FOREIGN KEY (selected_project_id) REFERENCES managed_projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_org_project_preferences (
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES managed_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_org_project_preferences_project
  ON user_org_project_preferences(project_id, user_id);
