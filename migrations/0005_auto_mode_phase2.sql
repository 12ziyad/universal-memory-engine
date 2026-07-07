-- Migration number: 0005 	 2026-07-07T00:00:00.000Z
-- Auto Mode Phase 2: source packets, resolved scope metadata, idempotency keys,
-- and a lightweight job ledger for post-write/pass-2 work.

CREATE TABLE source_packets (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	scope_user_id TEXT NOT NULL,
	workspace_id TEXT DEFAULT 'default',
	app_id TEXT,
	session_id TEXT,
	source_scope TEXT,
	source_type TEXT NOT NULL,
	source_mode TEXT,
	source_id TEXT,
	source_role TEXT,
	conversation_id TEXT,
	thread_id TEXT,
	idempotency_key TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	content_preview TEXT,
	message_count INTEGER DEFAULT 0,
	raw_meta_json TEXT DEFAULT '{}',
	seen_count INTEGER DEFAULT 1,
	received_at INTEGER,
	created_at INTEGER,
	updated_at INTEGER
);

CREATE UNIQUE INDEX idx_source_packets_user_idempotency
	ON source_packets(user_id, idempotency_key);
CREATE INDEX idx_source_packets_user_created
	ON source_packets(user_id, created_at);
CREATE INDEX idx_source_packets_hash
	ON source_packets(user_id, content_hash);
CREATE INDEX idx_source_packets_conversation
	ON source_packets(user_id, conversation_id);

CREATE TABLE memory_jobs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	type TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued',
	idempotency_key TEXT,
	source_packet_id TEXT,
	extraction_run_id TEXT,
	receipt_id TEXT,
	attempts INTEGER DEFAULT 0,
	payload_json TEXT DEFAULT '{}',
	error TEXT,
	run_after INTEGER,
	created_at INTEGER,
	updated_at INTEGER,
	completed_at INTEGER
);

CREATE UNIQUE INDEX idx_memory_jobs_user_idempotency
	ON memory_jobs(user_id, idempotency_key);
CREATE INDEX idx_memory_jobs_user_status
	ON memory_jobs(user_id, status, run_after);
CREATE INDEX idx_memory_jobs_extraction_run
	ON memory_jobs(user_id, extraction_run_id);

ALTER TABLE extraction_runs ADD COLUMN source_packet_id TEXT;
ALTER TABLE extraction_runs ADD COLUMN idempotency_key TEXT;
ALTER TABLE extraction_runs ADD COLUMN scope_json TEXT;
ALTER TABLE extraction_runs ADD COLUMN job_id TEXT;

ALTER TABLE receipts ADD COLUMN source_packet_id TEXT;
ALTER TABLE receipts ADD COLUMN idempotency_key TEXT;
ALTER TABLE receipts ADD COLUMN scope_json TEXT;

ALTER TABLE memory_pages ADD COLUMN source_packet_id TEXT;
ALTER TABLE memory_pages ADD COLUMN input_hash TEXT;
ALTER TABLE memory_pages ADD COLUMN idempotency_key TEXT;
ALTER TABLE memory_pages ADD COLUMN scope_json TEXT;

CREATE INDEX idx_extraction_runs_source_packet
	ON extraction_runs(user_id, source_packet_id);
CREATE INDEX idx_receipts_source_packet
	ON receipts(user_id, source_packet_id);
CREATE INDEX idx_memory_pages_source_packet
	ON memory_pages(user_id, source_packet_id);
