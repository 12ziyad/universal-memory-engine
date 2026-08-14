-- 0040 — enterprise settings: bounded access, governed categories,
-- transactional invitation delivery, and project retention control.
--
-- This migration is additive except for one intentional, data-preserving
-- constraint replacement below: active project names move from owner-wide to
-- effective-organization uniqueness. NULL temporal bounds mean permanent
-- access, NULL retention days mean keep until the project is explicitly
-- deleted, and existing memories keep their current built-in category until a
-- project category is explicitly assigned.

-- Organization access and project access are both time-bounded. Effective
-- project access is the intersection of these two windows; owners are never
-- made temporary by these columns.
ALTER TABLE organization_members ADD COLUMN access_starts_at INTEGER;
ALTER TABLE organization_members ADD COLUMN access_expires_at INTEGER;
ALTER TABLE project_members ADD COLUMN access_starts_at INTEGER;
ALTER TABLE project_members ADD COLUMN access_expires_at INTEGER;
ALTER TABLE organization_invitations ADD COLUMN access_starts_at INTEGER;
ALTER TABLE organization_invitations ADD COLUMN access_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_org_members_access
	ON organization_members(org_id, access_expires_at, access_starts_at);
CREATE INDEX IF NOT EXISTS idx_project_members_access
	ON project_members(project_id, access_expires_at, access_starts_at);

-- Permanent, content-free account erasure generations. The user row is
-- eventually removed, so checking only users.status cannot fence a request
-- that authenticated before teardown and commits after that row disappeared.
-- This tombstone is intentionally retained forever and contains no email,
-- name, project data, or credential material.
CREATE TABLE IF NOT EXISTS account_erasure_tombstones (
	user_id TEXT PRIMARY KEY,
	erased_at INTEGER NOT NULL
);

-- Active project names are unique inside their effective organization, not
-- across every organization an owner belongs to. Historical NULL-org projects
-- resolve to that owner's default organization; before lazy bootstrap they use
-- an owner-specific sentinel so unrelated accounts can never collide.
DROP INDEX IF EXISTS idx_managed_projects_active_name;
CREATE INDEX IF NOT EXISTS idx_managed_projects_org_name_lookup
	ON managed_projects(organization_id, name_normalized, status);
CREATE TRIGGER IF NOT EXISTS managed_projects_effective_org_name_insert
BEFORE INSERT ON managed_projects
WHEN NEW.status = 'active' AND EXISTS (
	SELECT 1 FROM managed_projects p
	 WHERE p.status = 'active' AND p.name_normalized = NEW.name_normalized
	   AND COALESCE(
		p.organization_id,
		(SELECT o.id FROM organizations o
		  WHERE o.owner_user_id = p.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1),
		'owner:' || p.owner_user_id
	   ) = COALESCE(
		NEW.organization_id,
		(SELECT o.id FROM organizations o
		  WHERE o.owner_user_id = NEW.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1),
		'owner:' || NEW.owner_user_id
	   )
)
BEGIN
	SELECT RAISE(ABORT, 'managed_project_name_conflict');
END;
CREATE TRIGGER IF NOT EXISTS managed_projects_effective_org_name_update
BEFORE UPDATE OF organization_id, owner_user_id, name_normalized, status ON managed_projects
WHEN NEW.status = 'active' AND EXISTS (
	SELECT 1 FROM managed_projects p
	 WHERE p.id != NEW.id AND p.status = 'active' AND p.name_normalized = NEW.name_normalized
	   AND COALESCE(
		p.organization_id,
		(SELECT o.id FROM organizations o
		  WHERE o.owner_user_id = p.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1),
		'owner:' || p.owner_user_id
	   ) = COALESCE(
		NEW.organization_id,
		(SELECT o.id FROM organizations o
		  WHERE o.owner_user_id = NEW.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1),
		'owner:' || NEW.owner_user_id
	   )
)
BEGIN
	SELECT RAISE(ABORT, 'managed_project_name_conflict');
END;

-- Colors are constrained by application validation to the accessible palette.
-- Memory rows keep the stable category id, never the editable display name.
ALTER TABLE project_categories ADD COLUMN color_token TEXT;
ALTER TABLE project_categories ADD COLUMN updated_by_user_id TEXT;
ALTER TABLE nodes ADD COLUMN project_category_id TEXT;
ALTER TABLE memory_pages ADD COLUMN project_category_id TEXT;
ALTER TABLE candidates ADD COLUMN project_category_id TEXT;
ALTER TABLE semantic_atom_candidates ADD COLUMN project_category_id TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_project_category
	ON nodes(user_id, project_category_id);
CREATE INDEX IF NOT EXISTS idx_pages_project_category
	ON memory_pages(user_id, project_category_id);
CREATE INDEX IF NOT EXISTS idx_candidates_project_category
	ON candidates(user_id, project_category_id);
CREATE INDEX IF NOT EXISTS idx_semantic_atom_candidates_project_category
	ON semantic_atom_candidates(user_id, project_id, project_category_id);

-- New packets receive a first-class managed-project id. Historical packets
-- remain readable through their existing scope metadata; retention never
-- guesses a tenant from the source-level `project_id` field.
ALTER TABLE source_packets ADD COLUMN managed_project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_source_packets_managed_project
	ON source_packets(managed_project_id, received_at, id);

-- Every observed memory space is registered because subtenant ids are hashed
-- and cannot be reconstructed later. This is the authoritative finite set a
-- project-scoped retention run is allowed to inspect.
CREATE TABLE IF NOT EXISTS project_memory_spaces (
	project_id TEXT NOT NULL,
	memory_owner_user_id TEXT NOT NULL,
	memory_user_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active'
		CHECK (state IN ('active', 'archived', 'deleting')),
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, memory_user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_memory_spaces_owner
	ON project_memory_spaces(memory_owner_user_id, state);

-- Invitation mail is an encrypted, crash-recoverable outbox. The ciphertext
-- is cleared as soon as delivery reaches a terminal state. The database never
-- stores a usable invitation token in plaintext.
CREATE TABLE IF NOT EXISTS invitation_email_outbox (
	id TEXT PRIMARY KEY,
	invitation_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	project_id TEXT,
	recipient_email TEXT NOT NULL,
	payload_ciphertext TEXT,
	payload_iv TEXT,
	status TEXT NOT NULL DEFAULT 'queued'
		CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
	attempts INTEGER NOT NULL DEFAULT 0,
	run_after INTEGER,
	provider_message_id TEXT,
	last_error_code TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	sent_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_email_invitation
	ON invitation_email_outbox(invitation_id);
CREATE INDEX IF NOT EXISTS idx_invitation_email_dispatch
	ON invitation_email_outbox(status, run_after, created_at);

-- No row means the compatibility default: keep forever. `days` NULL is the
-- explicit keep-forever setting. Security audit is stored in this model but is
-- not user-shortenable in the first release.
CREATE TABLE IF NOT EXISTS retention_policies (
	project_id TEXT NOT NULL,
	memory_owner_user_id TEXT NOT NULL,
	class TEXT NOT NULL CHECK (class IN (
		'playground_transcripts',
		'source_episodes',
		'semantic_memory',
		'export_blobs',
		'webhook_deliveries',
		'operational_records',
		'security_audit'
	)),
	days INTEGER CHECK (days IS NULL OR (days >= 1 AND days <= 3650)),
	version INTEGER NOT NULL DEFAULT 1,
	effective_at INTEGER NOT NULL,
	updated_by_user_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, class)
);
CREATE INDEX IF NOT EXISTS idx_retention_policies_due
	ON retention_policies(class, days, effective_at);

-- A preview is immutable evidence of what was counted. Execute requests bind
-- to its inventory hash and policy version so a stale tab cannot activate a
-- different deletion set. JSON fields contain counters/cursors only, never
-- labels, messages, prompts, URLs, email addresses, or memory text.
CREATE TABLE IF NOT EXISTS retention_runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	memory_owner_user_id TEXT NOT NULL,
	class TEXT NOT NULL,
	policy_version INTEGER NOT NULL,
	cutoff_at INTEGER,
	mode TEXT NOT NULL CHECK (mode IN ('preview', 'execute', 'scheduled')),
	status TEXT NOT NULL CHECK (status IN (
		'queued', 'running', 'retry', 'completed', 'failed', 'cancelled'
	)),
	inventory_hash TEXT,
	inventory_json TEXT NOT NULL DEFAULT '{}',
	checkpoint_json TEXT NOT NULL DEFAULT '{}',
	deleted_json TEXT NOT NULL DEFAULT '{}',
	error_code TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	actor_user_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_retention_runs_dispatch
	ON retention_runs(status, updated_at, created_at);
CREATE INDEX IF NOT EXISTS idx_retention_runs_project
	ON retention_runs(project_id, created_at DESC);

-- Fences stop an accepted pre-cutoff packet from being committed after a
-- retention sweep. They are monotonic: lengthening a policy never resurrects
-- data and never moves a fence backwards.
CREATE TABLE IF NOT EXISTS retention_fences (
	project_id TEXT NOT NULL,
	class TEXT NOT NULL,
	cutoff_at INTEGER NOT NULL,
	policy_version INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, class)
);

-- Governed settings/security writes reserve one durable intent before state
-- mutation. The request dedupe value is an opaque SHA-256 digest; it never
-- stores a member id, invitation token, request body, or other caller text.
ALTER TABLE audit_events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_request_dedupe
	ON audit_events(COALESCE(actor_user_id, 'system'), request_id, dedupe_key)
	WHERE request_id IS NOT NULL AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_pending_reconcile
	ON audit_events(outcome, created_at, id);

-- Content-free completion outbox. `committed` on audit_events is already
-- terminal proof that state and audit marker shared one D1 transaction; this
-- table only enriches that truth with a bounded final outcome and allowlisted
-- metadata, and is safe to retry idempotently from cron.
CREATE TABLE IF NOT EXISTS audit_event_completions (
	event_id TEXT PRIMARY KEY,
	org_id TEXT,
	project_id TEXT,
	target_type TEXT,
	target_id TEXT,
	outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'noop', 'denied', 'conflict', 'failed', 'failed_partial')),
	reason TEXT,
	metadata_json TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_completion_dispatch
	ON audit_event_completions(created_at, event_id);

-- A shared managed project stores transcripts under its immutable memory root,
-- so retain the signed-in account and selected project as nullable provenance.
-- Historical rows stay NULL and continue to use the legacy owner-only scope.
ALTER TABLE playground_threads ADD COLUMN account_user_id TEXT;
ALTER TABLE playground_threads ADD COLUMN managed_project_id TEXT;
ALTER TABLE playground_messages ADD COLUMN account_user_id TEXT;
ALTER TABLE playground_messages ADD COLUMN managed_project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pg_threads_account_project
	ON playground_threads(account_user_id, managed_project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_messages_account_project
	ON playground_messages(account_user_id, managed_project_id, created_at);
