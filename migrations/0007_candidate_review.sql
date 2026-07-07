-- Migration number: 0007 	 2026-07-07T00:00:00.000Z
-- Candidate review: richer candidate metadata and lifecycle status.

ALTER TABLE candidates ADD COLUMN label_guess TEXT;
ALTER TABLE candidates ADD COLUMN canonical_key TEXT;
ALTER TABLE candidates ADD COLUMN role_guess TEXT;
ALTER TABLE candidates ADD COLUMN cluster_guess TEXT;
ALTER TABLE candidates ADD COLUMN confidence REAL;
ALTER TABLE candidates ADD COLUMN status TEXT DEFAULT 'pending';
ALTER TABLE candidates ADD COLUMN first_seen_at INTEGER;
ALTER TABLE candidates ADD COLUMN last_seen_at INTEGER;
ALTER TABLE candidates ADD COLUMN session_count INTEGER DEFAULT 1;
ALTER TABLE candidates ADD COLUMN mention_count INTEGER DEFAULT 1;
ALTER TABLE candidates ADD COLUMN evidence_json TEXT DEFAULT '[]';
ALTER TABLE candidates ADD COLUMN possible_parent_id TEXT;
ALTER TABLE candidates ADD COLUMN possible_existing_node_id TEXT;
ALTER TABLE candidates ADD COLUMN expires_at INTEGER;
ALTER TABLE candidates ADD COLUMN reason TEXT;
ALTER TABLE candidates ADD COLUMN promoted_object_id TEXT;
ALTER TABLE candidates ADD COLUMN promoted_object_kind TEXT;
ALTER TABLE candidates ADD COLUMN reviewed_at INTEGER;

UPDATE candidates
SET
	label_guess = COALESCE(label_guess, label),
	canonical_key = COALESCE(canonical_key, lower(label)),
	cluster_guess = COALESCE(cluster_guess, cluster_hint),
	status = COALESCE(status, 'pending'),
	first_seen_at = COALESCE(first_seen_at, created_at),
	last_seen_at = COALESCE(last_seen_at, created_at),
	session_count = COALESCE(session_count, 1),
	mention_count = COALESCE(mention_count, mentions, 1),
	evidence_json = COALESCE(evidence_json, '[]'),
	reason = COALESCE(reason, 'legacy_candidate');

CREATE INDEX idx_candidates_user_status
	ON candidates(user_id, status, last_seen_at);
CREATE INDEX idx_candidates_user_canonical
	ON candidates(user_id, canonical_key);
