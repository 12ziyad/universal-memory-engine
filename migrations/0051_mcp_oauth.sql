-- Migration number: 0051 	 2026-08-21T00:00:00.000Z
-- MCP OAuth 2.1 — authorization for Itsuki's remote MCP server.
--
-- Separate from the Google OAuth used to sign in to the dashboard: there
-- Itsuki is a CLIENT; here Itsuki is the authorization server and the
-- protected resource.
--
-- Everything secret is stored as a SHA-256 hex hash only, exactly like
-- connection_tokens and sessions (src/auth.js). Raw codes, tokens, and client
-- secrets exist only in the issuing HTTP response and are never recoverable.
--
-- These tables live in D1 rather than KV deliberately: every mutation door in
-- this codebase re-proves its credential inside the same D1 batch that writes
-- (fence_guard + credentialGuardStatement), so a revoked grant must be visible
-- to that batch. A KV-held grant could not be fenced transactionally.

-- Registered clients. Dynamic Client Registration (RFC 7591) and
-- pre-registered clients share this table; DCR clients carry an expiry.
CREATE TABLE oauth_clients (
	client_id TEXT PRIMARY KEY,
	-- NULL for public clients (token_endpoint_auth_method = 'none'), which is
	-- what MCP clients use with PKCE.
	client_secret_hash TEXT,
	client_name TEXT,
	-- Exact-match registry. No wildcards, no prefix matching, ever.
	redirect_uris_json TEXT NOT NULL DEFAULT '[]',
	grant_types_json TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
	response_types_json TEXT NOT NULL DEFAULT '["code"]',
	token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
	scope TEXT,
	-- RFC 7592 registration management credential (hash only).
	registration_access_token_hash TEXT,
	software_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER,
	-- DCR registrations expire; pre-registered clients have NULL.
	expires_at INTEGER,
	status TEXT NOT NULL DEFAULT 'active',
	-- Which account registered it, when registration was authenticated.
	created_by_user_id TEXT
);

CREATE INDEX idx_oauth_clients_status ON oauth_clients(status, expires_at);

-- One consent grant: this user, this client, this project, these scopes.
-- The partial unique index makes "one live grant per (user, client, project)"
-- a database guarantee — a re-authorization updates the grant in place rather
-- than accumulating shadow grants that revocation could miss.
CREATE TABLE oauth_grants (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	client_id TEXT NOT NULL,
	project_id TEXT,
	scopes_json TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	updated_at INTEGER,
	revoked_at INTEGER,
	revoked_reason TEXT,
	last_used_at INTEGER
);

CREATE UNIQUE INDEX idx_oauth_grants_live_identity
	ON oauth_grants(user_id, client_id, COALESCE(project_id, ''))
	WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_grants_user ON oauth_grants(user_id, revoked_at);
CREATE INDEX idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX idx_oauth_grants_project ON oauth_grants(project_id);

-- Authorization codes: single-use, short-lived, PKCE-bound.
CREATE TABLE oauth_authorization_codes (
	code_hash TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL,
	client_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	project_id TEXT,
	scopes_json TEXT NOT NULL DEFAULT '[]',
	-- Bound at authorization time and re-checked at exchange (RFC 6749 §4.1.3).
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	code_challenge_method TEXT NOT NULL DEFAULT 'S256',
	-- RFC 8707 resource indicator.
	resource TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER
);

CREATE INDEX idx_oauth_codes_expiry ON oauth_authorization_codes(expires_at);
CREATE INDEX idx_oauth_codes_grant ON oauth_authorization_codes(grant_id);

-- Access and refresh tokens. Hash only; `rotated_from` + `consumed_at` give
-- refresh reuse detection (replaying a rotated refresh token revokes the
-- entire grant family).
CREATE TABLE oauth_tokens (
	id TEXT PRIMARY KEY,
	grant_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	client_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	scopes_json TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER,
	consumed_at INTEGER,
	rotated_from TEXT,
	last_used_at INTEGER
);

CREATE UNIQUE INDEX idx_oauth_tokens_hash ON oauth_tokens(token_hash);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id, kind);
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id, kind);
CREATE INDEX idx_oauth_tokens_expiry ON oauth_tokens(expires_at);

-- Server-side consent state. The browser never carries a signed blob we would
-- have to trust: it carries an opaque id, and everything decided is read back
-- from here. The CSRF token is bound to the session that opened the screen.
CREATE TABLE oauth_consent_requests (
	id TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	user_id TEXT,
	session_id TEXT,
	redirect_uri TEXT NOT NULL,
	state TEXT,
	scopes_json TEXT NOT NULL DEFAULT '[]',
	code_challenge TEXT NOT NULL,
	code_challenge_method TEXT NOT NULL DEFAULT 'S256',
	resource TEXT,
	project_id TEXT,
	csrf_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_at INTEGER
);

CREATE INDEX idx_oauth_consent_expiry ON oauth_consent_requests(expires_at);
