-- Migration number: 0023 	 2026-08-02T00:00:00.000Z
-- Webhooks: announce memory changes to a caller's endpoint.
--
-- secret: per-webhook HMAC key, generated server-side, shown once at
-- creation. A webhook without signing is a hole — anyone who learns the URL
-- could post fake events into someone's system.
--
-- metadata_only: the privacy differentiator. ON means deliveries say THAT a
-- memory changed (kind, counts, ids) and never what it says.

CREATE TABLE webhooks (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT,
	url TEXT NOT NULL,
	secret TEXT NOT NULL,
	events_json TEXT NOT NULL,
	metadata_only INTEGER DEFAULT 0,
	status TEXT DEFAULT 'active',
	created_at INTEGER,
	updated_at INTEGER
);

CREATE INDEX idx_webhooks_user ON webhooks(user_id, status);

-- The delivery log the user can see: status, timestamps, response codes,
-- attempts. payload_json is what was SENT (so metadata-only rows contain no
-- memory content by construction).
CREATE TABLE webhook_deliveries (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	webhook_id TEXT NOT NULL,
	event TEXT,
	status TEXT DEFAULT 'pending',
	attempts INTEGER DEFAULT 0,
	response_code INTEGER,
	error TEXT,
	payload_json TEXT,
	created_at INTEGER,
	delivered_at INTEGER
);

CREATE INDEX idx_webhook_deliveries_user ON webhook_deliveries(user_id, created_at);
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
