-- Migration number: 0013 	 2026-07-31T00:00:01.000Z
-- Google sign-in: stable Google account id for linking. An account whose
-- password_hash is NULL is a Google-only account.

ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE INDEX idx_users_google_sub ON users(google_sub);
