-- 0062: Trust & Safety — the machinery behind the public promises.
--
-- Three tables:
--   trust_cases                — privacy requests / security reports / abuse
--                                reports / support, each with a status ladder
--                                and (for the DPDP-facing kinds) a 7-day
--                                response clock. The 7-day promise in the
--                                Privacy policy stops being a manual habit and
--                                becomes a due date the admin console counts
--                                down.
--   security_events            — append-only, storm-suppressed operational
--                                security signals. UNIQUE(group_key, bucket_at)
--                                with 10-minute buckets: a 10k-row storm is one
--                                row with count = 10000, not 10k emails.
--   admin_action_confirmations — hashed single-use step-up tokens for the
--                                destructive admin actions (delete / promote /
--                                demote), bound to actor + session + action +
--                                target + target-state, 5-minute TTL.
--
-- The notify_* columns are the 0059 mini-outbox pattern: the owner email is
-- attempted inline and retried from cron until sent or exhausted; the admin
-- tab is always the source of truth, email is never load-bearing.

CREATE TABLE IF NOT EXISTS trust_cases (
  id TEXT PRIMARY KEY,
  -- Nullable ON PURPOSE and no users FK: account erasure scrubs the link and
  -- the message but keeps the content-free case skeleton (kind, severity,
  -- timestamps) as accountability evidence.
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('privacy_request', 'security_report', 'abuse_report', 'support')),
  category TEXT CHECK (category IS NULL OR category IN ('question', 'access', 'export', 'correction', 'deletion')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'acknowledged', 'investigating', 'resolved')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('fixed', 'answered', 'no_action', 'duplicate', 'spam')),
  -- Scrubbed through src/pipeline/scrub.js before it is stored; capped app-side.
  message TEXT NOT NULL,
  -- JSON array of { at, by, text } — operator-only; never returned to the reporter.
  admin_notes TEXT,
  received_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER,
  resolved_by TEXT,
  -- received + 7 days for privacy_request AND security_report; NULL otherwise.
  response_due_at INTEGER,
  updated_at INTEGER NOT NULL,
  notify_status TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending', 'sent', 'failed', 'skipped')),
  notify_attempts INTEGER NOT NULL DEFAULT 0 CHECK (notify_attempts >= 0),
  notify_after INTEGER
);

-- No one-open-case unique index on purpose: two security reports are two
-- facts. The abuse valve is an app-side cap (3 cases per user per 24h).
CREATE INDEX IF NOT EXISTS idx_trust_cases_status_received
  ON trust_cases(status, received_at DESC);

-- The due-clock slice: only cases that still owe a response, indexable.
CREATE INDEX IF NOT EXISTS idx_trust_cases_due
  ON trust_cases(response_due_at)
  WHERE response_due_at IS NOT NULL AND status != 'resolved';

-- The cron drain slice: only undelivered notifications, indexable.
CREATE INDEX IF NOT EXISTS idx_trust_cases_notify
  ON trust_cases(notify_after)
  WHERE notify_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_trust_cases_user_received
  ON trust_cases(user_id, received_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  -- Storm suppression key: same group in the same 10-minute bucket collapses
  -- into one row whose count carries the volume and whose severity escalates.
  group_key TEXT NOT NULL,
  bucket_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  -- rank 0..3 mirrors severity so escalation math stays in one UPDATE;
  -- base_severity_rank is the strongest EMITTED severity, severity_rank adds
  -- the storm bonus on top (>=10 in a bucket +1, >=100 +2, capped at critical).
  severity_rank INTEGER NOT NULL CHECK (severity_rank BETWEEN 0 AND 3),
  base_severity_rank INTEGER NOT NULL CHECK (base_severity_rank BETWEEN 0 AND 3),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  -- Allowlist-enforced in src/lib/security_events.js: counts, enums, opaque
  -- ids, ip-hash prefixes. Structurally no memory text, secrets or addresses.
  details_json TEXT NOT NULL DEFAULT '{}',
  -- Account references live in columns, never inside details_json, so account
  -- erasure can sever them with one UPDATE.
  actor_user_id TEXT,
  target_user_id TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  -- Email only for high/critical: rows born lower are 'skipped' and flip to
  -- 'pending' if a storm escalates them across the line.
  notify_status TEXT NOT NULL DEFAULT 'skipped' CHECK (notify_status IN ('pending', 'sent', 'failed', 'skipped')),
  notify_attempts INTEGER NOT NULL DEFAULT 0 CHECK (notify_attempts >= 0),
  notify_after INTEGER,
  notified_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_security_events_group_bucket
  ON security_events(group_key, bucket_at);

CREATE INDEX IF NOT EXISTS idx_security_events_last
  ON security_events(last_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_notify
  ON security_events(notify_after)
  WHERE notify_status = 'pending';

CREATE TABLE IF NOT EXISTS admin_action_confirmations (
  id TEXT PRIMARY KEY,
  -- SHA-256 of the token; the plaintext exists only in the minting response.
  token_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('delete', 'promote', 'demote')),
  target_user_id TEXT NOT NULL,
  -- The target's state at mint time: consumption re-checks both, so a token
  -- minted against one reality cannot authorize a different one.
  target_role TEXT NOT NULL,
  target_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_confirmations_token
  ON admin_action_confirmations(token_hash);

-- The cron purge slice: expired tokens are swept every tick.
CREATE INDEX IF NOT EXISTS idx_admin_confirmations_expiry
  ON admin_action_confirmations(expires_at);
