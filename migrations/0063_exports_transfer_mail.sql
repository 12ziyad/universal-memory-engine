-- 0063: three things the product promised but could not do.
--
--   1. memory_exports gains R2 storage + a record of DIRECT downloads.
--      The blob used to live in `data TEXT`, which D1 caps at ~2MB, so a
--      2.7MB memory space failed every export job while the direct download
--      (which streams and stores nothing) succeeded. Bytes move to R2; the
--      row stays as the history. And a direct download now leaves a row too,
--      because "did my export work?" had no answer for a personal account.
--
--   2. project_ownership_transfers — ownership used to change the instant the
--      owner clicked, with no acceptance and no email. A transfer is a
--      two-party act: it is offered, and it is accepted.
--
--   3. mail_outbox — one shared, claimed, retried outbox for transactional
--      email. Every existing sender was bespoke (five modules, six send
--      sites, one shared renderer); anything new should not be a sixth.

-- ——— 1. exports ————————————————————————————————————————————————————————

-- Where the bytes actually are. NULL = legacy/inline (`data`) or nothing yet.
ALTER TABLE memory_exports ADD COLUMN r2_key TEXT;
-- 'job' (prepared, downloadable again) or 'direct' (streamed once, recorded).
ALTER TABLE memory_exports ADD COLUMN kind TEXT NOT NULL DEFAULT 'job';
-- Bytes as delivered, so the history can state a real size for both kinds.
ALTER TABLE memory_exports ADD COLUMN delivered_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_memory_exports_user_kind
  ON memory_exports(user_id, kind, created_at DESC);

-- ——— 2. ownership transfer ————————————————————————————————————————————

CREATE TABLE IF NOT EXISTS project_ownership_transfers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  -- SHA-256 of the accept token. The plaintext exists only in the email.
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  -- The project's revision when the offer was made. Consumption re-checks it,
  -- so an offer cannot be accepted against a project that moved underneath it.
  expected_revision TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES managed_projects(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_token ON project_ownership_transfers(token_hash);
-- At most one live offer per project: a second offer would race the first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_open
  ON project_ownership_transfers(project_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_transfer_to ON project_ownership_transfers(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_expiry ON project_ownership_transfers(expires_at) WHERE status = 'pending';

-- ——— 3. the shared transactional outbox ————————————————————————————————

CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  -- What happened. One of the deliberately SHORT list of things worth an
  -- email; routine product activity is not in it and must never be added
  -- without the same test that pins this set.
  kind TEXT NOT NULL,
  -- Recipient. Kept denormalised because an account-deletion email has to
  -- survive the deletion of the account it is about.
  to_email TEXT NOT NULL,
  to_user_id TEXT,
  subject TEXT NOT NULL,
  -- Rendered at enqueue time, for the same reason: the facts an email states
  -- must be the facts as they were when it was earned.
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  -- Idempotency: one email per (kind, subject-of-the-event). A retried
  -- lifecycle run must not mail the same person twice.
  dedupe_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_outbox_dedupe
  ON mail_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_outbox_drain
  ON mail_outbox(run_after) WHERE status IN ('queued', 'sending');
CREATE INDEX IF NOT EXISTS idx_mail_outbox_user
  ON mail_outbox(to_user_id, created_at DESC);
