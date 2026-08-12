-- Enterprise managed projects. Additive only.
--
-- Existing `project_id` columns describe source/repository provenance inside a
-- memory space. Managed projects are the server-owned isolation boundary above
-- that metadata. The default project maps to the historical account user_id,
-- so no existing memory row needs to be rewritten.

CREATE TABLE managed_projects (
	id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	memory_owner_user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	name_normalized TEXT NOT NULL,
	description TEXT,
	is_default INTEGER NOT NULL DEFAULT 0
		CONSTRAINT managed_projects_default_bool CHECK (is_default IN (0, 1)),
	status TEXT NOT NULL DEFAULT 'active'
		CONSTRAINT managed_projects_status CHECK (status IN ('active', 'archived')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	archived_at INTEGER
);

CREATE UNIQUE INDEX idx_managed_projects_active_name
	ON managed_projects (owner_user_id, name_normalized)
	WHERE status = 'active';

CREATE UNIQUE INDEX idx_managed_projects_one_default
	ON managed_projects (owner_user_id)
	WHERE is_default = 1 AND status = 'active';

CREATE INDEX idx_managed_projects_owner
	ON managed_projects (owner_user_id, status, is_default DESC, created_at);

CREATE UNIQUE INDEX idx_managed_projects_memory_owner
	ON managed_projects (memory_owner_user_id);

-- NULL means a key minted before managed projects existed. It is interpreted
-- as bound to that account's deterministic default project. New keys always
-- persist an explicit project id and can never switch projects at request time.
ALTER TABLE connection_tokens ADD COLUMN project_id TEXT;

CREATE INDEX idx_connection_tokens_project
	ON connection_tokens (user_id, project_id, status, revoked_at);
