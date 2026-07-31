-- Migration number: 0015 	 2026-07-31T00:00:03.000Z
-- Automatic error reporting: every client or server failure lands here for
-- the admin Health tab. Users only ever see a friendly message.

CREATE TABLE error_reports (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	side TEXT,
	scope TEXT,
	message TEXT,
	created_at INTEGER
);
CREATE INDEX idx_error_reports_created ON error_reports(created_at);
