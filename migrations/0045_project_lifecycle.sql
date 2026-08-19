-- Migration number: 0045 	 2026-08-19T12:00:00.000Z
-- Project lifecycle subsystem: archive/restore, project-wide memory purge,
-- permanent project deletion, and ownership transfer. Additive only.
--
-- BACKWARD COMPATIBILITY. The currently deployed Worker pivots every write,
-- read, and Durable Object fence on managed_projects.status IN
-- ('active','archived'). That column keeps exactly that meaning: any lifecycle
-- operation that must fence producers sets status='archived' first, so every
-- already-deployed fence_guard, resolver filter, and DO lifecycle assertion
-- engages with no code change. The new columns refine — never replace — that
-- coarse state, so pre-existing rows (lifecycle_state NULL, epoch 0) remain
-- fully valid under both the old and the new Worker.
--
-- CONTENT SAFETY. Every table below stores identifiers, counters, cursors,
-- hashes, and timestamps only — never memory text, names, emails, tokens,
-- secrets, or URLs. inventory_json / checkpoint_json carry bounded counts and
-- opaque cursor ids; the confirmation table stores only a token HASH.

ALTER TABLE managed_projects ADD COLUMN lifecycle_state TEXT;
ALTER TABLE managed_projects ADD COLUMN lifecycle_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE managed_projects ADD COLUMN lifecycle_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_managed_projects_lifecycle
	ON managed_projects (lifecycle_state, status, updated_at);

-- One durable, checkpointed run per lifecycle operation. The partial unique
-- index is the concurrency contract: at most one non-terminal run may exist
-- per project, so a conflicting request loses the INSERT race and returns a
-- stable 409 (or resumes, when it carries the same idempotency key).
CREATE TABLE IF NOT EXISTS project_lifecycle_runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	org_id TEXT,
	memory_owner_user_id TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('memory_purge', 'project_delete', 'archive', 'restore')),
	status TEXT NOT NULL CHECK (status IN (
		'accepted', 'running', 'verifying', 'completed',
		'failed_retryable', 'failed_terminal', 'cancelled'
	)),
	phase TEXT NOT NULL DEFAULT 'pending',
	lifecycle_epoch INTEGER NOT NULL,
	actor_user_id TEXT,
	idempotency_key TEXT NOT NULL,
	expected_revision TEXT,
	inventory_hash TEXT,
	inventory_json TEXT NOT NULL DEFAULT '{}',
	checkpoint_json TEXT NOT NULL DEFAULT '{}',
	error_code TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	completed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_lifecycle_runs_idem
	ON project_lifecycle_runs (project_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_lifecycle_runs_one_active
	ON project_lifecycle_runs (project_id)
	WHERE status IN ('accepted', 'running', 'verifying', 'failed_retryable');
CREATE INDEX IF NOT EXISTS idx_project_lifecycle_runs_dispatch
	ON project_lifecycle_runs (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_project_lifecycle_runs_project
	ON project_lifecycle_runs (project_id, created_at DESC);

-- Server-bound two-step confirmation. The opaque token is returned exactly
-- once by preview; only its SHA-256 lands here, bound to actor, session,
-- project, action, epoch, revision, and the preview's inventory hash. Expired,
-- replayed, cross-actor, cross-session, or cross-project presentations fail.
CREATE TABLE IF NOT EXISTS project_lifecycle_confirmations (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL,
	project_id TEXT NOT NULL,
	action TEXT NOT NULL,
	actor_user_id TEXT NOT NULL,
	session_ref TEXT,
	lifecycle_epoch INTEGER NOT NULL,
	expected_revision TEXT NOT NULL,
	inventory_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_project_lifecycle_confirmations_project
	ON project_lifecycle_confirmations (project_id, action, created_at DESC);

-- Permanent, content-free evidence that a project was deleted. The
-- managed_projects row itself is also retained (status='archived',
-- lifecycle_state='deleted') because its unique memory_owner_user_id index is
-- what permanently reserves the storage identity against any reuse.
CREATE TABLE IF NOT EXISTS project_tombstones (
	project_id TEXT PRIMARY KEY,
	org_id TEXT,
	memory_owner_user_id TEXT NOT NULL,
	action TEXT NOT NULL DEFAULT 'project_delete',
	lifecycle_epoch INTEGER NOT NULL,
	run_id TEXT,
	by_user_id TEXT,
	created_at INTEGER NOT NULL
);
