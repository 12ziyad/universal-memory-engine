-- Migration number: 0004 	 2026-07-06T00:00:00.000Z
-- Production product shell auth: accounts, browser sessions, and per-tool
-- connection tokens. Existing memory rows remain scoped by user_id.

ALTER TABLE users ADD COLUMN email_normalized TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN updated_at INTEGER;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';

CREATE UNIQUE INDEX idx_users_email_normalized
	ON users(email_normalized)
	WHERE email_normalized IS NOT NULL;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	session_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_seen_at INTEGER,
	revoked_at INTEGER,
	user_agent TEXT,
	ip_hash TEXT
);

CREATE UNIQUE INDEX idx_sessions_hash ON sessions(session_hash);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE connection_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	label TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	token_prefix TEXT,
	token_tail TEXT,
	type TEXT DEFAULT 'api',
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER,
	scopes_json TEXT DEFAULT '[]',
	status TEXT DEFAULT 'active'
);

CREATE UNIQUE INDEX idx_connection_tokens_hash ON connection_tokens(token_hash);
CREATE INDEX idx_connection_tokens_user_id ON connection_tokens(user_id);
CREATE INDEX idx_connection_tokens_status ON connection_tokens(user_id, status, revoked_at);

CREATE TABLE login_events (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	email_normalized TEXT,
	outcome TEXT,
	reason TEXT,
	created_at INTEGER,
	ip_hash TEXT
);

CREATE INDEX idx_login_events_user_id ON login_events(user_id);
CREATE INDEX idx_login_events_created_at ON login_events(created_at);
