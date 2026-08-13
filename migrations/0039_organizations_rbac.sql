-- 0039 — organizations, membership, invitations, categories, audit.
--
-- Additive only. Nothing here rewrites an existing row, and every table is
-- keyed so that an account which never touches a team feature keeps working
-- exactly as before: no organization row is created until an organization API
-- is first used, and a project with no members still resolves through its
-- owner.
--
-- The memory namespace is deliberately absent from all of this. Membership and
-- roles are GOVERNANCE; managed_projects.memory_owner_user_id remains the
-- storage boundary and is never derived from, or changed by, anything below.

CREATE TABLE IF NOT EXISTS organizations (
	id TEXT PRIMARY KEY,
	owner_user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	name_normalized TEXT NOT NULL,
	description TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'active',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_default ON organizations(owner_user_id)
	WHERE is_default = 1;

-- Roles are stored as text with a CHECK rather than a lookup table: the set is
-- small, closed, and read on every authorised request.
CREATE TABLE IF NOT EXISTS organization_members (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	invited_by_user_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_unique ON organization_members(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

CREATE TABLE IF NOT EXISTS project_members (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
	invited_by_user_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_unique ON project_members(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Only the HASH of an invitation token is stored. The token itself is returned
-- exactly once, at creation, and is unrecoverable afterwards — a leaked
-- database must not hand anyone a working join link.
CREATE TABLE IF NOT EXISTS organization_invitations (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	project_id TEXT,
	email_normalized TEXT NOT NULL,
	org_role TEXT NOT NULL CHECK (org_role IN ('admin', 'member')),
	project_role TEXT CHECK (project_role IN ('admin', 'member', 'viewer')),
	token_hash TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
	invited_by_user_id TEXT NOT NULL,
	accepted_by_user_id TEXT,
	expires_at INTEGER NOT NULL,
	accepted_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_token ON organization_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_org_invites_org ON organization_invitations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON organization_invitations(email_normalized, status);

-- Named categories a project files memories under. The canonical typed set in
-- config.js stays where it is; these are additions, keyed by the project's
-- immutable memory owner so they follow the data rather than the display name.
CREATE TABLE IF NOT EXISTS project_categories (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	memory_owner_user_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	created_by_user_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_categories_slug ON project_categories(project_id, slug);
CREATE INDEX IF NOT EXISTS idx_project_categories_owner ON project_categories(memory_owner_user_id, status);

-- Content-free by construction. There is no column here that can hold memory
-- text, an instruction, a token or a key: only ids, action codes, an outcome
-- and an allowlisted metadata diff. An audit log that quietly accumulates
-- private content is a second copy of the thing it is meant to protect.
CREATE TABLE IF NOT EXISTS audit_events (
	id TEXT PRIMARY KEY,
	org_id TEXT,
	project_id TEXT,
	actor_user_id TEXT,
	actor_type TEXT NOT NULL DEFAULT 'user',
	action TEXT NOT NULL,
	target_type TEXT,
	target_id TEXT,
	outcome TEXT NOT NULL DEFAULT 'ok',
	reason TEXT,
	metadata_json TEXT,
	request_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_user_id, created_at DESC);

-- A project's owning organization. NULL means "not yet claimed by an org",
-- which is every project that exists today; resolution treats NULL as the
-- owner's default organization without rewriting a single row.
ALTER TABLE managed_projects ADD COLUMN organization_id TEXT;
CREATE INDEX IF NOT EXISTS idx_managed_projects_org ON managed_projects(organization_id, status);
