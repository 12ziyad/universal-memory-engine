-- Per-user entitlements + the upgrade-request queue (launch hardening).
--
-- user_entitlements: one row per user, every column nullable. A missing row
-- or a NULL column falls back to the env default (AI_MONTHLY_WRITES, the
-- daily-neuron default, the Huba defaults). expires_at lets the owner grant a
-- temporary bump that lapses on its own — expired numeric overrides are
-- ignored at read time, no cleanup job needed. early_access survives expiry:
-- it marks who was here before launch+30d so grandfathering later is a WHERE
-- clause, not archaeology.
CREATE TABLE IF NOT EXISTS user_entitlements (
  user_id TEXT PRIMARY KEY,
  daily_neurons INTEGER CHECK (daily_neurons IS NULL OR daily_neurons > 0),
  monthly_writes INTEGER CHECK (monthly_writes IS NULL OR monthly_writes > 0),
  huba_daily_messages INTEGER CHECK (huba_daily_messages IS NULL OR huba_daily_messages > 0),
  early_access INTEGER NOT NULL DEFAULT 0 CHECK (early_access IN (0, 1)),
  expires_at INTEGER,
  note TEXT,
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Everyone who signed up before this migration is pre-launch by definition.
INSERT OR IGNORE INTO user_entitlements (user_id, early_access, created_at, updated_at)
SELECT id, 1,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM users;

-- upgrade_requests: the "Request more" queue. No payment processor — the
-- owner grants manually from the admin portal. usage_json is a snapshot of
-- the requester's usage at request time so the admin view needs no join
-- archaeology. The notify_* columns are a mini-outbox: the owner email is
-- attempted inline and retried from cron until sent or exhausted.
CREATE TABLE IF NOT EXISTS upgrade_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('saves', 'huba', 'other')),
  note TEXT,
  usage_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'granted', 'dismissed')),
  resolved_at INTEGER,
  resolved_by TEXT,
  grant_json TEXT,
  notify_status TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending', 'sent', 'failed', 'skipped')),
  notify_attempts INTEGER NOT NULL DEFAULT 0 CHECK (notify_attempts >= 0),
  notify_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One open request per user per kind: pressing the button twice edits the
-- note instead of stacking duplicates in the owner's queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_upgrade_requests_open_unique
  ON upgrade_requests(user_id, kind) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_upgrade_requests_status_created
  ON upgrade_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_upgrade_requests_user_created
  ON upgrade_requests(user_id, created_at DESC);

-- The cron drain slice: only undelivered notifications, indexable.
CREATE INDEX IF NOT EXISTS idx_upgrade_requests_notify
  ON upgrade_requests(notify_after)
  WHERE notify_status = 'pending';
