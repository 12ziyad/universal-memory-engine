-- Migration number: 0006 	 2026-07-07T00:00:00.000Z
-- Final Auto Mode schema additions after 0005 was applied remotely.
-- Keep 0005 immutable: this file carries the owner/external scope columns,
-- profile rollups, and recall/pass-2 indexes needed by the final backend lane.

ALTER TABLE source_packets ADD COLUMN memory_user_id TEXT;
ALTER TABLE source_packets ADD COLUMN owner_user_id TEXT;
ALTER TABLE source_packets ADD COLUMN external_user_id TEXT;
ALTER TABLE source_packets ADD COLUMN agent_id TEXT;
ALTER TABLE source_packets ADD COLUMN topic TEXT;

UPDATE source_packets
SET
	memory_user_id = COALESCE(memory_user_id, user_id),
	owner_user_id = COALESCE(owner_user_id, user_id),
	external_user_id = COALESCE(external_user_id, user_id);

CREATE INDEX idx_source_packets_owner_external
	ON source_packets(owner_user_id, external_user_id);

CREATE TABLE memory_profiles (
	user_id TEXT PRIMARY KEY,
	profile_json TEXT DEFAULT '{}',
	cluster_hints_json TEXT DEFAULT '[]',
	family_summaries_json TEXT DEFAULT '[]',
	source_job_id TEXT,
	created_at INTEGER,
	updated_at INTEGER
);
