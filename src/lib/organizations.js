/**
 * Organizations, membership and the capability matrix.
 *
 * Three rules hold everything else up:
 *
 *  1. Governance is not storage. A role decides what someone may DO; it never
 *     decides WHERE data lives. `managed_projects.memory_owner_user_id` remains
 *     the storage boundary and nothing in this file derives from or changes it.
 *
 *  2. The owner is a member. Rather than special-casing "is this the account
 *     that created it?" at every call site, the owner resolves to the `owner`
 *     role through the same path as everyone else — so a permission check that
 *     works for a member is already correct for the owner.
 *
 *  3. Nothing exists until it is needed. An account that never opens a team
 *     feature has no organization row, no membership row, and behaves exactly
 *     as it did before this file existed. Bootstrap is lazy and idempotent.
 */

import { newId } from "./ids.js";
import { sha256Hex } from "../auth.js";
import { managedMutationGuardStatement } from "./managed_projects.js";
import { grantRevocationStatements } from "./oauth.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./audit.js";

export const ORG_ROLES = ["owner", "admin", "member"];
export const PROJECT_ROLES = ["admin", "member", "viewer"];
export const MAX_ACTIVE_ORGANIZATIONS_PER_OWNER = 20;

export class OrgError extends Error {
	constructor(code, message, status = 400, currentOrganization = null) {
		super(message);
		this.name = "OrgError";
		this.code = code;
		this.status = status;
		this.currentOrganization = currentOrganization;
	}
}

const MEMBER_REVISION_PREFIX = "mrv1";
const MEMBER_REVISION_PATTERN = /^mrv1\.([0-9a-f]{64})\.([0-9a-f]{64})$/;

/**
 * Membership revisions deliberately expose neither a database id nor a
 * timestamp. The first digest identifies the immutable row generation; the
 * second identifies that generation's current role revision. PATCH compares
 * both. DELETE compares only the generation so removal wins a concurrent role
 * edit, while an old tab can never remove a newly-created replacement row.
 */
async function memberRevision(row) {
	const generation = await sha256Hex(`itsuki:membership:generation:${row.id}`);
	const revision = await sha256Hex(
		`itsuki:membership:revision:${row.id}:${Number(row.updated_at)}:${row.role}:${row.access_starts_at ?? ""}:${row.access_expires_at ?? ""}`,
	);
	return `${MEMBER_REVISION_PREFIX}.${generation}.${revision}`;
}

function parseExpectedMemberRevision(value) {
	if (value === null || value === undefined || String(value).trim() === "") {
		throw new OrgError(
			"precondition_required",
			"Reload this member, then try again. This change requires the member's current revision.",
			428,
		);
	}
	let revision = String(value).trim();
	if (revision.startsWith("W/")) revision = revision.slice(2).trim();
	if (revision.startsWith('"') && revision.endsWith('"')) revision = revision.slice(1, -1);
	const match = MEMBER_REVISION_PATTERN.exec(revision);
	if (!match) {
		throw new OrgError(
			"member_conflict",
			"This membership changed in another session. Reload before trying again.",
			412,
		);
	}
	return { value: revision, generation: match[1], state: match[2] };
}

async function currentMemberRevision(row) {
	return parseExpectedMemberRevision(await memberRevision(row));
}

function memberConflict() {
	return new OrgError(
		"member_conflict",
		"This membership changed in another session. Reload before trying again.",
		412,
	);
}

const MAX_ACCESS_HORIZON_MS = 10 * 366 * 24 * 60 * 60 * 1000;

function cleanAccessAt(value, field, now) {
	if (value === null || value === "") return null;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new OrgError("invalid_access_window", `${field} must be a nullable epoch-millisecond integer.`);
	}
	if (value > now + MAX_ACCESS_HORIZON_MS) {
		throw new OrgError("invalid_access_window", "Temporary access cannot be scheduled more than 10 years ahead.");
	}
	return value;
}

/** Validate a partial temporal-access patch while preserving omitted fields. */
export function normalizeAccessWindow(patch = {}, current = {}, { requireFuture = false, now = Date.now() } = {}) {
	const hasStart = Object.prototype.hasOwnProperty.call(patch, "access_starts_at");
	const hasEnd = Object.prototype.hasOwnProperty.call(patch, "access_expires_at");
	const accessStartsAt = hasStart
		? cleanAccessAt(patch.access_starts_at, "access_starts_at", now)
		: current.access_starts_at ?? null;
	const accessExpiresAt = hasEnd
		? cleanAccessAt(patch.access_expires_at, "access_expires_at", now)
		: current.access_expires_at ?? null;
	if (accessStartsAt !== null && accessExpiresAt !== null && accessExpiresAt <= accessStartsAt) {
		throw new OrgError("invalid_access_window", "access_expires_at must be later than access_starts_at.");
	}
	if (requireFuture && accessExpiresAt !== null && accessExpiresAt <= now) {
		throw new OrgError("access_window_expired", "Choose an access expiration in the future.");
	}
	return { access_starts_at: accessStartsAt, access_expires_at: accessExpiresAt };
}

export function membershipAccessStatus(row, now = Date.now()) {
	if (!row || row.role === "owner") return row ? "permanent" : "inactive";
	const starts = Number(row.access_starts_at);
	const expires = Number(row.access_expires_at);
	if (row.access_starts_at !== null && row.access_starts_at !== undefined && starts > now) return "scheduled";
	if (row.access_expires_at !== null && row.access_expires_at !== undefined && expires <= now) return "expired";
	if (row.access_starts_at === null && row.access_expires_at === null) return "permanent";
	return "active";
}

function membershipIsActive(row, now = Date.now()) {
	return ["active", "permanent"].includes(membershipAccessStatus(row, now));
}

function delegationWindowSql(alias, { ownerBypass = true } = {}) {
	const owner = ownerBypass ? `${alias}.role = 'owner' OR ` : "";
	return `(${owner}(
		(${alias}.access_starts_at IS NULL OR COALESCE(?, ?) >= ${alias}.access_starts_at)
		AND (${alias}.access_expires_at IS NULL OR (? IS NOT NULL AND ? <= ${alias}.access_expires_at))
	))`;
}

function delegationBindings({ accessStartsAt = null, accessExpiresAt = null, now }) {
	return [accessStartsAt, now, accessExpiresAt, accessExpiresAt];
}

function activeTargetOrganizationMemberGuard(env, { userId, orgId, now = Date.now() }) {
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT EXISTS (
		   SELECT 1 FROM users u
		   JOIN organizations o ON o.id = ? AND o.status = 'active'
		   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
		  WHERE u.id = ? AND u.status = 'active'
		    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		    AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		    AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		 )`,
	).bind(orgId, userId, now, now);
}

/**
 * Fresh, privacy-safe delegation ceiling. A temporary administrator may grant
 * the same role strength, but never an access interval that outlives the
 * authority they are exercising. Owners are the sole permanent bypass.
 */
export async function assertDelegationAuthority(env, {
	actorUserId,
	orgId,
	projectId = null,
	accessStartsAt = null,
	accessExpiresAt = null,
	now = Date.now(),
} = {}) {
	if (!actorUserId || !orgId) {
		throw new OrgError("delegation_forbidden", "You no longer have permission to grant that access.", 403);
	}
	const orgWindow = delegationWindowSql("om");
	const bindings = delegationBindings({ accessStartsAt, accessExpiresAt, now });
	let row;
	if (!projectId) {
		row = await env.DB.prepare(
			`SELECT 1 AS ok
			   FROM users u
			   JOIN organizations o ON o.id = ? AND o.status = 'active'
			   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
			  WHERE u.id = ? AND u.status = 'active'
			    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			    AND om.role IN ('owner', 'admin')
			    AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
			    AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
			    AND ${orgWindow}
			  LIMIT 1`,
		).bind(orgId, actorUserId, now, now, ...bindings).first();
	} else {
		const projectWindow = delegationWindowSql("pm", { ownerBypass: false });
		row = await env.DB.prepare(
			`SELECT 1 AS ok
			   FROM users u
			   JOIN organizations o ON o.id = ? AND o.status = 'active'
			   JOIN managed_projects p ON p.id = ? AND p.status = 'active'
			   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
			   LEFT JOIN project_members pm
			     ON pm.project_id = p.id AND pm.org_id = o.id AND pm.user_id = u.id
			  WHERE u.id = ? AND u.status = 'active'
			    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			    AND COALESCE(p.organization_id, (
			      SELECT od.id FROM organizations od
			       WHERE od.owner_user_id = p.owner_user_id
			         AND od.is_default = 1 AND od.status = 'active' LIMIT 1
			    )) = o.id
			    AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
			    AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
			    AND (
			      (om.role IN ('owner', 'admin') AND ${orgWindow})
			      OR (
			        pm.role = 'admin'
			        AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
			        AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
			        AND ${orgWindow}
			        AND ${projectWindow}
			      )
			    )
			  LIMIT 1`,
		).bind(
			orgId, projectId, actorUserId, now, now,
			...bindings,
			now, now,
			...bindings,
			...bindings,
		).first();
	}
	if (!row?.ok) {
		throw new OrgError(
			"delegation_window_exceeded",
			"You cannot grant a role or access period broader than your current administrative access.",
			403,
		);
	}
	return { ok: true };
}

/** Put this in the same D1 batch as the delegated membership/invite write. */
export function delegationGuardStatement(env, options = {}) {
	const {
		actorUserId, orgId, projectId = null,
		accessStartsAt = null, accessExpiresAt = null, now = Date.now(),
	} = options;
	const orgWindow = delegationWindowSql("om");
	const bindings = delegationBindings({ accessStartsAt, accessExpiresAt, now });
	if (!projectId) {
		return env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
			   SELECT 1 FROM users u
			   JOIN organizations o ON o.id = ? AND o.status = 'active'
			   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
			   WHERE u.id = ? AND u.status = 'active'
			     AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			     AND om.role IN ('owner', 'admin')
			     AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
			     AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
			     AND ${orgWindow}
			 )`,
		).bind(orgId, actorUserId, now, now, ...bindings);
	}
	const projectWindow = delegationWindowSql("pm", { ownerBypass: false });
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT EXISTS (
		   SELECT 1 FROM users u
		   JOIN organizations o ON o.id = ? AND o.status = 'active'
		   JOIN managed_projects p ON p.id = ? AND p.status = 'active'
		   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
		   LEFT JOIN project_members pm
		     ON pm.project_id = p.id AND pm.org_id = o.id AND pm.user_id = u.id
		   WHERE u.id = ? AND u.status = 'active'
		     AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		     AND COALESCE(p.organization_id, (
		       SELECT od.id FROM organizations od
		        WHERE od.owner_user_id = p.owner_user_id
		          AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		     )) = o.id
		     AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		     AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		     AND (
		       (om.role IN ('owner', 'admin') AND ${orgWindow})
		       OR (
		         pm.role = 'admin'
		         AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		         AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		         AND ${orgWindow}
		         AND ${projectWindow}
		       )
		     )
		 )`,
	).bind(
		orgId, projectId, actorUserId, now, now,
		...bindings,
		now, now,
		...bindings,
		...bindings,
	);
}

async function publicMember(row) {
	if (!row) return null;
	return {
		id: row.id,
		user_id: row.user_id,
		email: row.email ?? null,
		name: row.name ?? null,
		role: row.role,
		joined_at: row.created_at,
		access_starts_at: row.role === "owner" ? null : row.access_starts_at ?? null,
		access_expires_at: row.role === "owner" ? null : row.access_expires_at ?? null,
		access_status: membershipAccessStatus(row),
		last_activity_at: Number(row.last_activity_at) > 0 ? Number(row.last_activity_at) : null,
		// Authentication/key activity only. This never implies that an admin can
		// inspect a member's memory content or transcript.
		last_activity_scope: "scoped_access",
		revision: await memberRevision(row),
	};
}

/**
 * Every capability the product gates on, and who holds it.
 *
 * This table is the authorization contract. It is deliberately one object
 * rather than scattered `if (role === "admin")` checks, because the question
 * "what can a viewer actually do?" has to be answerable by reading one thing,
 * and because a test can walk it exhaustively.
 *
 * `org` entries are satisfied by an organization role; `project` entries by a
 * project role. An organization owner or admin implicitly holds every project
 * capability inside their organization — administering an org you own but
 * being locked out of its projects would be a fiction.
 */
export const CAPABILITIES = {
	// --- organization ---
	"org.view": { org: ["owner", "admin", "member"] },
	"org.edit": { org: ["owner", "admin"] },
	"org.members.view": { org: ["owner", "admin", "member"] },
	"org.members.manage": { org: ["owner", "admin"] },
	"org.members.remove_owner": { org: [] },
	"org.delete": { org: ["owner"] },

	// --- project ---
	"project.view": { org: ["owner", "admin"], project: ["admin", "member", "viewer"] },
	"project.edit": { org: ["owner", "admin"], project: ["admin"] },
	"project.create": { org: ["owner", "admin"] },
	"project.members.view": { org: ["owner", "admin"], project: ["admin", "member", "viewer"] },
	"project.members.manage": { org: ["owner", "admin"], project: ["admin"] },
	"project.keys.view": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.keys.manage": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.memory.read": { org: ["owner", "admin"], project: ["admin", "member", "viewer"] },
	"project.memory.write": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.memory.delete": { org: ["owner", "admin"], project: ["admin"] },
	// Playground conversations can expose full transcripts and spend AI quota,
	// so ordinary memory-read access is deliberately not enough. Policy changes
	// and chat deletion are administrative even though members may use the chat.
	"project.playground.read": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.playground.use": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.playground.policy.edit": { org: ["owner", "admin"], project: ["admin"] },
	"project.playground.delete": { org: ["owner", "admin"], project: ["admin"] },
	"project.rules.edit": { org: ["owner", "admin"], project: ["admin"] },
	"project.categories.edit": { org: ["owner", "admin"], project: ["admin"] },
	// Retention inventory exposes only counts, but even viewing schedules and
	// failures is administrative. Activating a shorter policy is destructive,
	// so neither capability is delegated to developers/members/viewers.
	"project.retention.view": { org: ["owner", "admin"], project: ["admin"] },
	"project.retention.manage": { org: ["owner", "admin"], project: ["admin"] },
	"project.integrations.view": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.integrations.manage": { org: ["owner", "admin"], project: ["admin", "member"] },
	// The chooser can spend model quota even though its result is read-only.
	// Viewers may inspect memory but cannot initiate paid host automation.
	"project.chooser.use": { org: ["owner", "admin"], project: ["admin", "member"] },
	// Exports contain the project's complete memory payload. Viewers are kept
	// read-only at the product surface without receiving bulk portability access.
	"project.export": { org: ["owner", "admin"], project: ["admin", "member"] },
	"project.audit.view": { org: ["owner", "admin"], project: ["admin"] },
	"project.audit.export": { org: ["owner", "admin"], project: ["admin"] },
	"project.archive": { org: ["owner", "admin"], project: ["admin"] },
	// Destructive and irreversible: organization owner only, never delegated by
	// a project role. A project admin can empty a project's memory; only the
	// owner can remove the project itself.
	"project.transfer": { org: ["owner"] },
	"project.delete": { org: ["owner"] },
};

export function capabilityExists(capability) {
	return Object.prototype.hasOwnProperty.call(CAPABILITIES, capability);
}

/**
 * Does this membership hold this capability? `orgRole` and `projectRole` are
 * whatever resolveMembership() found — either may be null, and a null role
 * grants nothing.
 */
export function can(capability, { orgRole = null, projectRole = null } = {}) {
	const rule = CAPABILITIES[capability];
	if (!rule) return false;
	if (orgRole && (rule.org ?? []).includes(orgRole)) return true;
	if (projectRole && (rule.project ?? []).includes(projectRole)) return true;
	return false;
}

function quotedRoleList(roles = []) {
	// Every value originates in the static CAPABILITIES contract above, never
	// request data. Still validate the token shape so later edits fail closed.
	if (!roles.length) return "NULL";
	if (roles.some((role) => !/^[a-z_]+$/.test(role))) {
		throw new OrgError("invalid_capability", "Capability role configuration is invalid.", 500);
	}
	return roles.map((role) => `'${role}'`).join(",");
}

/**
 * Commit-time capability guard for a governed D1 mutation. Request-time RBAC
 * remains useful for a fast, clear 403; this statement closes the race where a
 * role is removed, expires, or is downgraded after that check but before the
 * mutation batch commits.
 */
export function capabilityGuardStatement(env, {
	actorUserId,
	orgId,
	projectId = null,
	capability,
	now = Date.now(),
} = {}) {
	const rule = CAPABILITIES[capability];
	if (!rule || !actorUserId || !orgId) {
		throw new OrgError("capability_forbidden", "You no longer have permission for this change.", 403);
	}
	const orgRoles = quotedRoleList(rule.org ?? []);
	const projectRoles = quotedRoleList(rule.project ?? []);
	if (!projectId) {
		return env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
			   SELECT 1 FROM users u
			   JOIN organizations o ON o.id = ? AND o.status = 'active'
			   JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
			    AND om.role IN (${orgRoles})
			  WHERE u.id = ? AND u.status = 'active'
			    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			    AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
			    AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
			 )`,
		).bind(orgId, actorUserId, now, now);
	}
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT EXISTS (
		   SELECT 1 FROM users u
		   JOIN organizations o ON o.id = ? AND o.status = 'active'
		   JOIN managed_projects p ON p.id = ? AND p.status = 'active'
		   LEFT JOIN organization_members om ON om.org_id = o.id AND om.user_id = u.id
		   LEFT JOIN project_members pm
		     ON pm.project_id = p.id AND pm.org_id = o.id AND pm.user_id = u.id
		  WHERE u.id = ? AND u.status = 'active'
		    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		    AND COALESCE(p.organization_id, (
		      SELECT od.id FROM organizations od
		       WHERE od.owner_user_id = p.owner_user_id
		         AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		    )) = o.id
		    AND (p.organization_id IS NULL OR p.owner_user_id = o.owner_user_id OR om.user_id IS NOT NULL)
		    AND (p.owner_user_id = u.id OR om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		    AND (p.owner_user_id = u.id OR om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		    AND (
		      p.owner_user_id = u.id
		      OR om.role IN (${orgRoles})
		      OR (
		        pm.role IN (${projectRoles})
		        AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		        AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		      )
		    )
		 )`,
	).bind(orgId, projectId, actorUserId, now, now, now, now);
}

/** Every capability a membership holds, for the UI to disable what it must. */
export function capabilitiesFor({ orgRole = null, projectRole = null } = {}) {
	return Object.keys(CAPABILITIES).filter((capability) => can(capability, { orgRole, projectRole }));
}

async function organizationRevision(row) {
	return `orv1.${await sha256Hex(`itsuki:organization:revision:v1:${row.id}:${row.created_at}:${row.updated_at}`)}`;
}

function cleanExpectedOrganizationRevision(value) {
	if (value === null || value === undefined || String(value).trim() === "") {
		throw new OrgError(
			"precondition_required",
			"Reload this organization before saving so a newer change is not overwritten.",
			428,
		);
	}
	let revision = String(value).trim();
	if (revision.startsWith("W/")) revision = revision.slice(2).trim();
	if (revision.startsWith('"') && revision.endsWith('"')) revision = revision.slice(1, -1);
	return revision;
}

function organizationConflict(currentOrganization) {
	return new OrgError(
		"organization_conflict",
		"This organization changed in another session. Reload the current values before saving again.",
		412,
		currentOrganization,
	);
}

async function publicOrg(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		is_default: Boolean(row.is_default),
		owner_user_id: row.owner_user_id,
		owner: row.owner_email !== undefined || row.owner_name !== undefined
			? { id: row.owner_user_id, name: row.owner_name ?? null, email: row.owner_email ?? null }
			: null,
		member_count: row.member_count === undefined ? null : Number(row.member_count ?? 0),
		project_count: row.project_count === undefined ? null : Number(row.project_count ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
		revision: await organizationRevision(row),
	};
}

/** Every active organization the account may currently enter. */
export async function listOrganizations(env, userId) {
	await ensureDefaultOrganization(env, userId);
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT o.id, o.owner_user_id, o.name, o.description, o.is_default,
		        o.created_at, o.updated_at, m.role, m.access_starts_at, m.access_expires_at,
		        owner.name AS owner_name, owner.email AS owner_email,
		        (SELECT COUNT(*) FROM organization_members om WHERE om.org_id = o.id) AS member_count,
		        (SELECT COUNT(*) FROM managed_projects p
		          WHERE p.status = 'active' AND COALESCE(p.organization_id, (
		            SELECT d.id FROM organizations d
		             WHERE d.owner_user_id = p.owner_user_id AND d.is_default = 1 AND d.status = 'active'
		             LIMIT 1
		          )) = o.id) AS project_count
		   FROM organizations o
		   JOIN organization_members m ON m.org_id = o.id AND m.user_id = ?
		   LEFT JOIN users owner ON owner.id = o.owner_user_id
		  WHERE o.status = 'active'
		    AND (m.role = 'owner' OR m.access_starts_at IS NULL OR m.access_starts_at <= ?)
		    AND (m.role = 'owner' OR m.access_expires_at IS NULL OR m.access_expires_at > ?)
		  ORDER BY (o.owner_user_id = ?) DESC, o.is_default DESC, o.created_at, o.name COLLATE NOCASE`,
	).bind(userId, now, now, userId).all();
	return Promise.all((results ?? []).map(async (row) => ({
		...await publicOrg(row),
		role: row.role,
		access_starts_at: row.role === "owner" ? null : row.access_starts_at ?? null,
		access_expires_at: row.role === "owner" ? null : row.access_expires_at ?? null,
		access_status: row.role === "owner" ? "permanent" : membershipAccessStatus(row),
		project_count: Number(row.project_count ?? 0),
	})));
}

/**
 * Create a usable organization in one D1 transaction. There is no intermediate
 * empty organization: owner seat and starter project commit or roll back with
 * it, and the project's memory owner is fixed from its immutable id.
 */
export async function createOrganization(env, ownerUserId, input = {}, { auditIntent = null } = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new OrgError("invalid_organization", "Organization details must be a JSON object.");
	}
	const unknown = Object.keys(input).filter((key) => !["name", "description"].includes(key));
	if (unknown.length) throw new OrgError("unknown_org_field", `Unknown organization field: ${unknown[0]}.`);
	const name = cleanOrgName(input.name);
	if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
		throw new OrgError("invalid_org_description", "Organization description must be a string.");
	}
	const description = String(input.description ?? "").trim().slice(0, 500) || null;
	const orgId = newId("org");
	const projectId = newId("proj");
	const memoryOwnerUserId = `mem_${(await sha256Hex(`itsuki:managed-project:memory-owner:v1:${ownerUserId}:${projectId}`)).slice(0, 32)}`;
	const orgMemberId = newId("orgm");
	const projectMemberId = newId("prjm");
	const starterName = `${name} project`.slice(0, 80);
	const normalizedStarter = starterName.toLocaleLowerCase("en-US");
	const at = Date.now();
	let results;
	try {
		const statements = [
			managedMutationGuardStatement(env, { accountUserId: ownerUserId }),
			env.DB.prepare(
				`INSERT INTO organizations
				 (id, owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, 0, 'active', ?, ?
				  WHERE (SELECT COUNT(*) FROM organizations WHERE owner_user_id = ? AND status = 'active') < ?`,
			).bind(
				orgId, ownerUserId, name, name.toLocaleLowerCase("en-US"), description, at, at,
				ownerUserId, MAX_ACTIVE_ORGANIZATIONS_PER_OWNER,
			),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
				 SELECT ?, id, ?, 'owner', NULL, NULL, NULL, ?, ? FROM organizations WHERE id = ?`,
			).bind(orgMemberId, ownerUserId, at, at, orgId),
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized,
				  description, is_default, status, created_at, updated_at)
				 SELECT ?, ?, id, ?, ?, ?, NULL, 0, 'active', ?, ? FROM organizations WHERE id = ?`,
			).bind(projectId, ownerUserId, memoryOwnerUserId, starterName, normalizedStarter, at, at, orgId),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id,
				  access_starts_at, access_expires_at, created_at, updated_at)
				 SELECT ?, p.id, p.organization_id, ?, 'admin', NULL, NULL, NULL, ?, ?
				   FROM managed_projects p WHERE p.id = ? AND p.organization_id = ?`,
			).bind(projectMemberId, ownerUserId, at, at, projectId, orgId),
			env.DB.prepare(
				`INSERT INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 SELECT id, memory_owner_user_id, memory_owner_user_id, 'active', ?, ?
				   FROM managed_projects WHERE id = ?`,
			).bind(at, at, projectId),
		];
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				postconditions: [
					auditInvariantStatement(env, "SELECT 1 FROM organizations WHERE id = ? AND owner_user_id = ? AND status = 'active'", [orgId, ownerUserId]),
					auditInvariantStatement(env, "SELECT 1 FROM organization_members WHERE id = ? AND org_id = ? AND user_id = ? AND role = 'owner'", [orgMemberId, orgId, ownerUserId]),
					auditInvariantStatement(env, "SELECT 1 FROM managed_projects WHERE id = ? AND organization_id = ? AND owner_user_id = ? AND status = 'active'", [projectId, orgId, ownerUserId]),
					auditInvariantStatement(env, "SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND org_id = ? AND user_id = ?", [projectMemberId, projectId, orgId, ownerUserId]),
				],
				commitDetails: { orgId, projectId, targetType: "organization", targetId: orgId },
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const account = await env.DB.prepare(
				`SELECT 1 AS ok FROM users u WHERE u.id = ? AND u.status = 'active'
				  AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)`,
			).bind(ownerUserId).first();
			if (account?.ok) {
				const count = await env.DB.prepare(
					"SELECT COUNT(*) AS count FROM organizations WHERE owner_user_id = ? AND status = 'active'",
				).bind(ownerUserId).first();
				if (Number(count?.count ?? 0) >= MAX_ACTIVE_ORGANIZATIONS_PER_OWNER) {
					throw new OrgError(
						"organization_limit_reached",
						`An account can own at most ${MAX_ACTIVE_ORGANIZATIONS_PER_OWNER} active organizations.`,
						409,
					);
				}
			}
			throw new OrgError("account_inactive", "This account can no longer create an organization.", 403);
		}
		if (/unique constraint/i.test(String(error?.message ?? error))) {
			throw new OrgError(
				"starter_project_name_exists",
				"An active project already uses the starter project name. Rename it, then create this organization.",
				409,
			);
		}
		throw error;
	}
	if (Number(results?.[1]?.meta?.changes ?? 0) !== 1) {
		throw new OrgError(
			"organization_limit_reached",
			`An account can own at most ${MAX_ACTIVE_ORGANIZATIONS_PER_OWNER} active organizations.`,
			409,
		);
	}
	if (results.slice(2).some((result) => Number(result?.meta?.changes ?? 0) !== 1)) {
		throw new OrgError("organization_create_failed", "The organization could not be created. Try again.", 503);
	}
	const organization = await getOrganization(env, orgId);
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, organization_id, memory_owner_user_id, name, description,
		        is_default, status, created_at, updated_at
		   FROM managed_projects WHERE id = ? LIMIT 1`,
	).bind(projectId).first();
	const created = { organization, project };
	return auditIntent ? auditedMutationResult(created, auditIntent) : created;
}

function cleanOrgName(value) {
	if (typeof value !== "string") throw new OrgError("invalid_org_name", "Organization name must be a string.");
	const name = value.replace(/\s+/g, " ").trim();
	if (!name) throw new OrgError("invalid_org_name", "Organization name is required.");
	if (name.length > 80) throw new OrgError("invalid_org_name", "Organization name cannot exceed 80 characters.");
	if (/[\u0000-\u001f\u007f]/.test(name)) {
		throw new OrgError("invalid_org_name", "Organization name cannot contain control characters.");
	}
	return name;
}

/**
 * The account's own organization, created on first use.
 *
 * Idempotent under concurrency: two tabs hitting Settings at once both run the
 * INSERT OR IGNORE against a unique partial index, and both then read back the
 * same row. Never returns without also ensuring the owner's membership row,
 * because an organization whose owner is not a member is one that nobody can
 * administer.
 */
export async function ensureDefaultOrganization(env, ownerUserId, { name } = {}) {
	const read = () => env.DB.prepare(
		`SELECT o.id, o.owner_user_id, o.name, o.description, o.is_default, o.created_at, o.updated_at,
		        u.name AS owner_name, u.email AS owner_email,
		        (SELECT COUNT(*) FROM organization_members m WHERE m.org_id = o.id) AS member_count,
		        (SELECT COUNT(*) FROM managed_projects p WHERE p.status = 'active' AND COALESCE(p.organization_id, (
		          SELECT d.id FROM organizations d WHERE d.owner_user_id = p.owner_user_id
		           AND d.is_default = 1 AND d.status = 'active' LIMIT 1
		        )) = o.id) AS project_count
		 FROM organizations o LEFT JOIN users u ON u.id = o.owner_user_id
		 WHERE o.owner_user_id = ? AND o.is_default = 1 AND o.status = 'active' LIMIT 1`,
	).bind(ownerUserId).first();

	let row = await read();
	const at = Date.now();
	const label = cleanOrgName(name || "My organization");
	const proposedOrgId = newId("org");
	try {
		await env.DB.batch([
			managedMutationGuardStatement(env, { accountUserId: ownerUserId }),
			env.DB.prepare(
				`INSERT OR IGNORE INTO organizations
				 (id, owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
				 SELECT ?, ?, ?, ?, NULL, 1, 'active', ?, ?
				  WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE owner_user_id = ? AND is_default = 1 AND status = 'active')`,
			).bind(
				proposedOrgId, ownerUserId, label, label.toLocaleLowerCase("en-US"), at, at, ownerUserId,
			),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 SELECT ?, o.id, ?, 'owner', NULL, ?, ? FROM organizations o
				  WHERE o.owner_user_id = ? AND o.is_default = 1 AND o.status = 'active'
				 ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at
				 WHERE organization_members.role != 'owner'`,
			).bind(newId("orgm"), ownerUserId, at, at, ownerUserId),
		]);
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw new OrgError("account_inactive", "This account can no longer create or repair an organization.", 403);
		}
		throw error;
	}
	row = row ?? await read();
	if (!row) throw new OrgError("org_store_unavailable", "Your organization could not be loaded.", 503);
	return await publicOrg(row);
}

export async function getOrganization(env, orgId) {
	return await publicOrg(await env.DB.prepare(
		`SELECT o.id, o.owner_user_id, o.name, o.description, o.is_default, o.created_at, o.updated_at,
		        u.name AS owner_name, u.email AS owner_email,
		        (SELECT COUNT(*) FROM organization_members m WHERE m.org_id = o.id) AS member_count,
		        (SELECT COUNT(*) FROM managed_projects p WHERE p.status = 'active' AND COALESCE(p.organization_id, (
		          SELECT d.id FROM organizations d WHERE d.owner_user_id = p.owner_user_id
		           AND d.is_default = 1 AND d.status = 'active' LIMIT 1
		        )) = o.id) AS project_count
		 FROM organizations o LEFT JOIN users u ON u.id = o.owner_user_id
		 WHERE o.id = ? AND o.status = 'active' LIMIT 1`,
	).bind(orgId).first());
}


export async function updateOrganization(env, orgId, patch = {}, expectedRevision, { auditIntent = null } = {}) {
	const expected = cleanExpectedOrganizationRevision(expectedRevision);
	const current = await getOrganization(env, orgId);
	if (!current) throw new OrgError("org_not_found", "That organization does not exist.", 404);
	if (current.revision !== expected) throw organizationConflict(current);
	const unknown = Object.keys(patch).filter((key) => !["name", "description"].includes(key));
	if (unknown.length) {
		throw new OrgError("unknown_org_field", `Unknown organization field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
	const name = Object.prototype.hasOwnProperty.call(patch, "name") ? cleanOrgName(patch.name) : current.name;
	let description = current.description;
	if (Object.prototype.hasOwnProperty.call(patch, "description")) {
		if (patch.description !== null && typeof patch.description !== "string") {
			throw new OrgError("invalid_org_description", "Organization description must be a string.");
		}
		description = String(patch.description ?? "").trim().slice(0, 500) || null;
	}
	if (name === current.name && description === current.description) {
		const noop = { organization: current, previousOrganization: current, changed: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const updatedAt = Math.max(Date.now(), Number(current.updated_at) + 1);
	const statement = env.DB.prepare(
		`UPDATE organizations SET name = ?, name_normalized = ?, description = ?, updated_at = ?
		 WHERE id = ? AND status = 'active' AND created_at = ? AND updated_at = ?`,
	).bind(
		name,
		name.toLocaleLowerCase("en-US"),
		description,
		updatedAt,
		orgId,
		current.created_at,
		current.updated_at,
	);
	let result;
	try {
		[result] = auditIntent
			? await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organizations WHERE id = ? AND status = 'active' AND created_at = ? AND updated_at = ?",
					[orgId, current.created_at, current.updated_at],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organizations WHERE id = ? AND status = 'active' AND updated_at = ?",
					[orgId, updatedAt],
				)],
			})
			: [await statement.run()];
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw organizationConflict(await getOrganization(env, orgId));
		}
		throw error;
	}
	if (Number(result?.meta?.changes ?? 0) !== 1) {
		throw organizationConflict(await getOrganization(env, orgId));
	}
	const mutation = {
		organization: await getOrganization(env, orgId),
		previousOrganization: current,
		changed: true,
	};
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/** The one compatibility rule for projects created before organization ids. */
async function effectiveProjectOrganizationId(env, project) {
	if (project?.organization_id) return project.organization_id;
	if (!project?.owner_user_id) return null;
	const row = await env.DB.prepare(
		`SELECT id FROM organizations
		  WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
		  LIMIT 1`,
	).bind(project.owner_user_id).first();
	return row?.id ?? null;
}

/** Validate the governance boundary before an invitation can grant a seat. */
export async function assertProjectOrganization(env, projectId, orgId) {
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, organization_id
		   FROM managed_projects WHERE id = ? AND status = 'active' LIMIT 1`,
	).bind(projectId).first();
	const effectiveOrgId = await effectiveProjectOrganizationId(env, project);
	if (!project || !effectiveOrgId || effectiveOrgId !== orgId) {
		throw new OrgError("project_org_mismatch", "That project does not belong to this organization.", 409);
	}
	return project;
}

/**
 * Resolve what this user may do with this project.
 *
 * Ownership is still authoritative — every project that exists today was
 * created before organizations did, and its owner must keep full control
 * without a migration having to invent membership rows for them. On top of
 * that, an explicit project_members row or an organization role can grant
 * access to someone who does not own it.
 *
 * Returns roles only. It deliberately does not decide anything; the caller
 * asks `can()` for the specific capability it needs, so a new endpoint cannot
 * accidentally inherit permission it was never granted.
 */
export async function resolveMembership(env, { userId, project = null, orgId = null }) {
	const ownsProject = Boolean(project) && project.owner_user_id === userId;
	const organizationId = orgId ?? await effectiveProjectOrganizationId(env, project);
	let owns = ownsProject;
	// For an explicit organization binding, ownership is valid only when both
	// sides name the same owner. A malformed/migrated project row must not turn
	// one account's project-owner shortcut into another organization's owner.
	if (owns && project?.organization_id && organizationId) {
		const organization = await env.DB.prepare(
			"SELECT owner_user_id FROM organizations WHERE id = ? AND status = 'active' LIMIT 1",
		).bind(organizationId).first();
		owns = organization?.owner_user_id === userId;
	}

	// A project with no organization belongs to its owner's default one. Read
	// it rather than create it: resolution runs on every authorised request and
	// must not write.
	let orgRole = null;
	let orgAccess = null;
	if (organizationId) {
		const row = await env.DB.prepare(
			"SELECT role, access_starts_at, access_expires_at FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1",
		).bind(organizationId, userId).first();
		orgAccess = row ? membershipAccessStatus(row) : "inactive";
		orgRole = membershipIsActive(row) ? row.role : null;
	}
	// The pre-organization world: whoever owns the project is its owner, even
	// if no organization row has ever been created for them.
	if (!orgRole && owns) orgRole = "owner";

	let projectRole = null;
	let projectAccess = null;
	if (project?.id && organizationId) {
		const row = await env.DB.prepare(
			"SELECT role, access_starts_at, access_expires_at FROM project_members WHERE project_id = ? AND org_id = ? AND user_id = ? LIMIT 1",
		).bind(project.id, organizationId, userId).first();
		projectAccess = row ? membershipAccessStatus(row) : "inactive";
		// A project seat never outruns the organization membership containing it.
		projectRole = orgRole && membershipIsActive(row) ? row.role : null;
	}
	if (!projectRole && owns) projectRole = "admin";

	return {
		orgId: organizationId,
		orgRole,
		projectRole,
		isOwner: orgRole === "owner",
		access: owns
			? { organization: "permanent", project: "permanent", effective: "permanent" }
			: {
				organization: orgAccess ?? "inactive",
				project: projectAccess ?? "inactive",
				effective: orgRole && projectRole ? "active" : "inactive",
			},
		capabilities: capabilitiesFor({ orgRole, projectRole }),
	};
}

/**
 * Projects this user can reach: the ones they own, plus the ones an explicit
 * membership or an organization role opens up. Ordered so a person's own
 * default project stays first, which is what the selector expects.
 */
export async function accessibleProjectIds(env, userId) {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT p.id FROM managed_projects p WHERE p.owner_user_id = ? AND p.status = 'active'
		   AND (
		     p.organization_id IS NULL OR EXISTS (
		       SELECT 1 FROM organizations own_org
		        WHERE own_org.id = p.organization_id AND own_org.status = 'active'
		          AND own_org.owner_user_id = p.owner_user_id
		     )
		   )
		 UNION
		 SELECT pm.project_id FROM project_members pm
		   JOIN managed_projects p2 ON p2.id = pm.project_id AND p2.status = 'active'
		   JOIN organization_members om2 ON om2.org_id = pm.org_id AND om2.user_id = pm.user_id
		  WHERE pm.user_id = ?
		    AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		    AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		    AND (om2.access_starts_at IS NULL OR om2.access_starts_at <= ?)
		    AND (om2.access_expires_at IS NULL OR om2.access_expires_at > ?)
		    AND pm.org_id = COALESCE(p2.organization_id, (
		      SELECT o2.id FROM organizations o2
		       WHERE o2.owner_user_id = p2.owner_user_id
		         AND o2.is_default = 1 AND o2.status = 'active'
		       LIMIT 1
		    ))
		 UNION
		 SELECT p3.id FROM managed_projects p3
		   JOIN organization_members om ON om.org_id = COALESCE(p3.organization_id, (
		     SELECT o3.id FROM organizations o3
		      WHERE o3.owner_user_id = p3.owner_user_id
		        AND o3.is_default = 1 AND o3.status = 'active'
		      LIMIT 1
		   ))
		  WHERE om.user_id = ? AND om.role IN ('owner', 'admin') AND p3.status = 'active'
		    AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		    AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)`,
	).bind(userId, userId, now, now, now, now, userId, now, now).all();
	return (results ?? []).map((row) => row.id);
}

/** Members of an organization, with the account details the UI needs. */
export async function listOrganizationMembers(env, orgId) {
	const { results } = await env.DB.prepare(
		`SELECT m.id, m.user_id, m.role, m.access_starts_at, m.access_expires_at,
		        m.created_at, m.updated_at, u.email, u.name,
		        MAX(
		          COALESCE((SELECT MAX(t.last_used_at) FROM connection_tokens t
		                     JOIN managed_projects p ON p.id = t.project_id
		                    WHERE t.user_id = m.user_id AND t.revoked_at IS NULL
		                      AND COALESCE(p.organization_id, (
		                        SELECT od.id FROM organizations od
		                         WHERE od.owner_user_id = p.owner_user_id
		                           AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		                      )) = m.org_id), 0),
		          COALESCE((SELECT MAX(a.created_at) FROM audit_events a
		                    WHERE a.actor_user_id = m.user_id AND a.org_id = m.org_id), 0)
		        ) AS last_activity_at
		   FROM organization_members m
		   LEFT JOIN users u ON u.id = m.user_id
		  WHERE m.org_id = ?
		  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC`,
	).bind(orgId).all();
	return Promise.all((results ?? []).map((row) => publicMember(row)));
}

export async function listProjectMembers(env, projectId) {
	const { results } = await env.DB.prepare(
		`SELECT m.id, m.user_id, m.role, m.access_starts_at, m.access_expires_at,
		        m.created_at, m.updated_at, u.email, u.name,
		        MAX(
		          COALESCE((SELECT MAX(t.last_used_at) FROM connection_tokens t
		                     WHERE t.user_id = m.user_id AND t.project_id = m.project_id AND t.revoked_at IS NULL), 0),
		          COALESCE((SELECT MAX(a.created_at) FROM audit_events a
		                    WHERE a.actor_user_id = m.user_id AND a.project_id = m.project_id), 0)
		        ) AS last_activity_at
		   FROM project_members m
		   JOIN managed_projects p ON p.id = m.project_id AND p.status = 'active'
		   LEFT JOIN users u ON u.id = m.user_id
		  WHERE m.project_id = ?
		    AND m.org_id = COALESCE(p.organization_id, (
		      SELECT o.id FROM organizations o
		       WHERE o.owner_user_id = p.owner_user_id
		         AND o.is_default = 1 AND o.status = 'active'
		       LIMIT 1
		    ))
		  ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.created_at ASC`,
	).bind(projectId).all();
	return Promise.all((results ?? []).map((row) => publicMember(row)));
}

/**
 * Change a member's role. The organization owner is immovable: demoting them
 * would leave an organization nobody can administer, and there is no transfer
 * flow yet to hand the seat over first.
 */
export async function setOrganizationRole(
	env, orgId, targetUserId, role, expectedRevision, patch = {}, actorUserId = null, { auditIntent = null } = {},
) {
	const expected = parseExpectedMemberRevision(expectedRevision);
	const org = await getOrganization(env, orgId);
	if (!org) throw new OrgError("org_not_found", "That organization does not exist.", 404);
	const current = await env.DB.prepare(
		`SELECT id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
		   FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1`,
	).bind(orgId, targetUserId).first();
	if (!current || (await currentMemberRevision(current)).value !== expected.value) throw memberConflict();
	const nextRole = role ?? current.role;
	if (!ORG_ROLES.includes(nextRole) || nextRole === "owner") {
		throw new OrgError("invalid_role", "Choose either admin or member.");
	}
	if (org.owner_user_id === targetUserId || current.role === "owner") {
		throw new OrgError("owner_immutable", "The organization owner's role cannot be changed.", 409);
	}
	const access = normalizeAccessWindow(patch, current, { requireFuture: true });
	if (current.role === nextRole
		&& access.access_starts_at === (current.access_starts_at ?? null)
		&& access.access_expires_at === (current.access_expires_at ?? null)) {
		const noop = { ok: true, changed: false, previous_role: current.role, member: await publicMember(current) };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const nextUpdatedAt = Math.max(Date.now(), Number(current.updated_at) + 1);
	if (actorUserId) {
		await assertDelegationAuthority(env, {
			actorUserId, orgId,
			accessStartsAt: access.access_starts_at,
			accessExpiresAt: access.access_expires_at,
			now: nextUpdatedAt,
		});
	}
	const statement = env.DB.prepare(
		`UPDATE organization_members
		    SET role = ?, access_starts_at = ?, access_expires_at = ?, updated_at = ?
		  WHERE org_id = ? AND user_id = ? AND id = ? AND updated_at = ? AND role != 'owner'`,
	).bind(
		nextRole, access.access_starts_at, access.access_expires_at, nextUpdatedAt,
		orgId, targetUserId, current.id, current.updated_at,
	);
	let result;
	try {
		const preconditions = [
			auditInvariantStatement(
				env,
				"SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND updated_at = ? AND role != 'owner'",
				[orgId, targetUserId, current.id, current.updated_at],
			),
		];
		if (actorUserId) preconditions.unshift(delegationGuardStatement(env, {
				actorUserId, orgId,
				accessStartsAt: access.access_starts_at,
				accessExpiresAt: access.access_expires_at,
				now: nextUpdatedAt,
			}));
		if (auditIntent) {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions,
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND role = ? AND updated_at = ? AND access_starts_at IS ? AND access_expires_at IS ?",
					[orgId, targetUserId, current.id, nextRole, nextUpdatedAt, access.access_starts_at, access.access_expires_at],
				)],
			});
		} else if (actorUserId) {
			result = (await env.DB.batch([...preconditions.slice(0, -1), statement])).at(-1);
		} else {
			result = await statement.run();
		}
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await env.DB.prepare(
				`SELECT id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
				   FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1`,
			).bind(orgId, targetUserId).first();
			if (!latest || (await currentMemberRevision(latest)).value !== expected.value) throw memberConflict();
			throw new OrgError("delegation_window_exceeded", "Your administrative access changed before this grant could be saved.", 403);
		}
		throw error;
	}
	if (!(result.meta?.changes ?? 0)) throw memberConflict();
	const next = { ...current, role: nextRole, ...access, updated_at: nextUpdatedAt };
	const mutation = { ok: true, changed: true, previous_role: current.role, member: await publicMember(next) };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/**
 * Org-wide credential quarantine for one user, shared by admin removal and
 * self-service leave so the two doors can never drift: however a membership
 * ends, the same credentials die in the same batch. Reaches every active
 * project whose EFFECTIVE organization is this one, including historical
 * NULL-organization projects mapped through the owner's default org.
 */
function organizationCredentialRevocationStatements(env, { userId, orgId, now, reason }) {
	return [
		env.DB.prepare(
			`UPDATE connection_tokens SET status = 'revoked', revoked_at = ?
			  WHERE user_id = ? AND revoked_at IS NULL
			    AND project_id IN (
			      SELECT p.id FROM managed_projects p
			       WHERE p.status = 'active'
			         AND COALESCE(p.organization_id, (
			           SELECT o.id FROM organizations o
			            WHERE o.owner_user_id = p.owner_user_id
			              AND o.is_default = 1 AND o.status = 'active'
			            LIMIT 1
			         )) = ?
			    )`,
		).bind(now, userId, orgId),
		// Same reach for OAuth grants: every grant this user holds on a project
		// belonging to this organization dies with the membership, in the same
		// batch, so leave-and-re-add cannot revive an old authorization.
		env.DB.prepare(
			`UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ?
			  WHERE user_id = ? AND revoked_at IS NULL
			    AND (project_id IS NULL OR project_id IN (
			      SELECT p.id FROM managed_projects p
			       WHERE p.status = 'active'
			         AND COALESCE(p.organization_id, (
			           SELECT o.id FROM organizations o
			            WHERE o.owner_user_id = p.owner_user_id
			              AND o.is_default = 1 AND o.status = 'active'
			            LIMIT 1
			         )) = ?
			    ))`,
		).bind(now, reason, userId, orgId),
		env.DB.prepare(
			`UPDATE oauth_tokens SET revoked_at = ?
			  WHERE user_id = ? AND revoked_at IS NULL
			    AND grant_id IN (SELECT id FROM oauth_grants WHERE user_id = ? AND revoked_at IS NOT NULL)`,
		).bind(now, userId, userId),
	];
}

export async function removeOrganizationMember(env, orgId, targetUserId, expectedRevision, { auditIntent = null } = {}) {
	const expected = parseExpectedMemberRevision(expectedRevision);
	const org = await getOrganization(env, orgId);
	if (!org) throw new OrgError("org_not_found", "That organization does not exist.", 404);
	const current = await env.DB.prepare(
		`SELECT id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
		   FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1`,
	).bind(orgId, targetUserId).first();
	if (!current) {
		const noop = { ok: true, removed: false, already_removed: true, previous_role: null };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const currentRevision = await currentMemberRevision(current);
	if (currentRevision.generation !== expected.generation) throw memberConflict();
	if (org.owner_user_id === targetUserId || current.role === "owner") {
		throw new OrgError("owner_immutable", "The organization owner cannot be removed.", 409);
	}
	// Organization admins can mint project-bound credentials without an
	// explicit project_members row. Quarantine credentials for every active
	// project whose EFFECTIVE organization is this one, including historical
	// NULL-organization projects mapped through the owner's default org. This is
	// a set-based statement inside the removal batch so a remove/re-add can never
	// revive an old credential generation.
	const revokedAt = Date.now();
	const statements = [
		env.DB.prepare(
			`DELETE FROM project_members
			  WHERE org_id = ? AND user_id = ?
			    AND EXISTS (
			      SELECT 1 FROM organization_members
			       WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'
			    )`,
		).bind(orgId, targetUserId, orgId, targetUserId, current.id),
		 env.DB.prepare(
			"DELETE FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'",
		).bind(orgId, targetUserId, current.id),
		...organizationCredentialRevocationStatements(env, {
			userId: targetUserId, orgId, now: revokedAt, reason: "org_membership_removed",
		}),
	];
	let results;
	try {
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'",
					[orgId, targetUserId, current.id],
				)],
				postconditions: [
					auditInvariantStatement(env, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)", [orgId, targetUserId]),
					auditInvariantStatement(env, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE org_id = ? AND user_id = ?)", [orgId, targetUserId]),
				],
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) throw memberConflict();
		throw error;
	}
	if (!(results?.[1]?.meta?.changes ?? 0)) {
		const after = await env.DB.prepare(
			"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1",
		).bind(orgId, targetUserId).first();
		if (!after) {
			const noop = { ok: true, removed: false, already_removed: true, previous_role: null };
			return auditIntent ? auditedMutationResult(noop, auditIntent) : noop;
		}
		throw memberConflict();
	}
	const mutation = { ok: true, removed: true, already_removed: false, previous_role: current.role };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

export async function setProjectRole(
	env, projectId, orgId, targetUserId, role, invitedBy = null, accessPatch = {}, { auditIntent = null } = {},
) {
	if (!PROJECT_ROLES.includes(role)) throw new OrgError("invalid_role", "Choose admin, member or viewer.");
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, organization_id
		   FROM managed_projects WHERE id = ? AND status = 'active' LIMIT 1`,
	).bind(projectId).first();
	const effectiveOrgId = await effectiveProjectOrganizationId(env, project);
	if (!project || !effectiveOrgId || effectiveOrgId !== orgId) {
		throw new OrgError("project_org_mismatch", "That project does not belong to this organization.", 409);
	}
	const at = Date.now();
	const access = normalizeAccessWindow(accessPatch, {}, { requireFuture: true, now: at });
	if (invitedBy) {
		await assertDelegationAuthority(env, {
			actorUserId: invitedBy, orgId, projectId,
			accessStartsAt: access.access_starts_at,
			accessExpiresAt: access.access_expires_at,
			now: at,
		});
	}
	const orgMember = await env.DB.prepare(
		`SELECT role, access_starts_at, access_expires_at FROM organization_members
		  WHERE org_id = ? AND user_id = ? LIMIT 1`,
	).bind(orgId, targetUserId).first();
	if (!membershipIsActive(orgMember, at)) {
		throw new OrgError("inactive_org_membership", "This person needs active organization access before receiving a project role.", 409);
	}
	const memberId = newId("prjm");
	const statement = env.DB.prepare(
		`INSERT INTO project_members
		 (id, project_id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(project_id, user_id) DO NOTHING`,
	).bind(
		memberId, projectId, orgId, targetUserId, role, invitedBy,
		access.access_starts_at, access.access_expires_at, at, at,
	);
	let inserted;
	try {
		const guards = [];
		if (invitedBy) guards.push(delegationGuardStatement(env, {
				actorUserId: invitedBy, orgId, projectId,
				accessStartsAt: access.access_starts_at,
				accessExpiresAt: access.access_expires_at,
				now: at,
			}));
		guards.push(
			activeTargetOrganizationMemberGuard(env, { userId: targetUserId, orgId, now: at }),
		);
		if (auditIntent) {
			[inserted] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [
					...guards,
					auditInvariantStatement(
						env,
						"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)",
						[projectId, targetUserId],
					),
				],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM project_members WHERE id = ? AND project_id = ? AND org_id = ? AND user_id = ? AND role = ?",
					[memberId, projectId, orgId, targetUserId, role],
				)],
			});
		} else {
			inserted = (await env.DB.batch([...guards, statement])).at(-1);
		}
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			if (invitedBy) await assertDelegationAuthority(env, {
					actorUserId: invitedBy, orgId, projectId,
					accessStartsAt: access.access_starts_at,
					accessExpiresAt: access.access_expires_at,
					now: Date.now(),
				});
			throw new OrgError(
				auditIntent ? "member_conflict" : "inactive_org_membership",
				auditIntent
					? "This project membership or your authorization changed before the role could be saved. Reload and try again."
					: "This person's account or organization access changed before the role could be saved.",
				409,
			);
		}
		throw error;
	}
	const member = await env.DB.prepare(
		`SELECT id, project_id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
		   FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
	).bind(projectId, targetUserId).first();
	if (!member || member.org_id !== orgId) {
		throw new OrgError("project_org_mismatch", "That project membership belongs to another organization.", 409);
	}
	const mutation = { ok: true, created: Boolean(inserted.meta?.changes ?? 0), member: await publicMember(member) };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

export async function updateProjectRole(
	env, projectId, orgId, targetUserId, role, expectedRevision, patch = {}, actorUserId = null, { auditIntent = null } = {},
) {
	const expected = parseExpectedMemberRevision(expectedRevision);
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, organization_id
		   FROM managed_projects WHERE id = ? AND status = 'active' LIMIT 1`,
	).bind(projectId).first();
	const effectiveOrgId = await effectiveProjectOrganizationId(env, project);
	if (!project || !effectiveOrgId || effectiveOrgId !== orgId) {
		throw new OrgError("project_org_mismatch", "That project does not belong to this organization.", 409);
	}
	const current = await env.DB.prepare(
		`SELECT id, project_id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
		   FROM project_members
		  WHERE project_id = ? AND org_id = ? AND user_id = ? LIMIT 1`,
	).bind(projectId, orgId, targetUserId).first();
	if (!current || (await currentMemberRevision(current)).value !== expected.value) throw memberConflict();
	const nextRole = role ?? current.role;
	if (!PROJECT_ROLES.includes(nextRole)) throw new OrgError("invalid_role", "Choose admin, member or viewer.");
	const access = normalizeAccessWindow(patch, current, { requireFuture: true });
	if (current.role === nextRole
		&& access.access_starts_at === (current.access_starts_at ?? null)
		&& access.access_expires_at === (current.access_expires_at ?? null)) {
		const noop = { ok: true, changed: false, previous_role: current.role, member: await publicMember(current) };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const nextUpdatedAt = Math.max(Date.now(), Number(current.updated_at) + 1);
	if (actorUserId) {
		await assertDelegationAuthority(env, {
			actorUserId, orgId, projectId,
			accessStartsAt: access.access_starts_at,
			accessExpiresAt: access.access_expires_at,
			now: nextUpdatedAt,
		});
	}
	const statement = env.DB.prepare(
		`UPDATE project_members
		    SET role = ?, access_starts_at = ?, access_expires_at = ?, updated_at = ?
		  WHERE project_id = ? AND org_id = ? AND user_id = ? AND id = ? AND updated_at = ?`,
	).bind(
		nextRole, access.access_starts_at, access.access_expires_at, nextUpdatedAt,
		projectId, orgId, targetUserId, current.id, current.updated_at,
	);
	let result;
	try {
		const guards = [activeTargetOrganizationMemberGuard(env, { userId: targetUserId, orgId, now: nextUpdatedAt })];
		if (actorUserId) guards.unshift(delegationGuardStatement(env, {
				actorUserId, orgId, projectId,
				accessStartsAt: access.access_starts_at,
				accessExpiresAt: access.access_expires_at,
				now: nextUpdatedAt,
			}));
		if (auditIntent) {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [
					...guards,
					auditInvariantStatement(
						env,
						"SELECT 1 FROM project_members WHERE project_id = ? AND org_id = ? AND user_id = ? AND id = ? AND updated_at = ?",
						[projectId, orgId, targetUserId, current.id, current.updated_at],
					),
				],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM project_members WHERE project_id = ? AND org_id = ? AND user_id = ? AND id = ? AND role = ? AND updated_at = ? AND access_starts_at IS ? AND access_expires_at IS ?",
					[projectId, orgId, targetUserId, current.id, nextRole, nextUpdatedAt, access.access_starts_at, access.access_expires_at],
				)],
			});
		} else if (actorUserId) {
			result = (await env.DB.batch([guards[0], statement])).at(-1);
		} else {
			result = await statement.run();
		}
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await env.DB.prepare(
				`SELECT id, project_id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
				   FROM project_members WHERE project_id = ? AND org_id = ? AND user_id = ? LIMIT 1`,
			).bind(projectId, orgId, targetUserId).first();
			if (!latest || (await currentMemberRevision(latest)).value !== expected.value) throw memberConflict();
			throw new OrgError("delegation_window_exceeded", "Your administrative access changed before this grant could be saved.", 403);
		}
		throw error;
	}
	if (!(result.meta?.changes ?? 0)) throw memberConflict();
	const next = { ...current, role: nextRole, ...access, updated_at: nextUpdatedAt };
	const mutation = { ok: true, changed: true, previous_role: current.role, member: await publicMember(next) };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/**
 * Project-scoped credential quarantine, shared by admin removal and
 * self-service leave for the same never-drift reason as the org-wide builder.
 */
function projectCredentialRevocationStatements(env, { userId, projectId, now = Date.now(), reason }) {
	return [
		env.DB.prepare(
			`UPDATE connection_tokens SET status = 'revoked', revoked_at = ?
			  WHERE user_id = ? AND project_id = ? AND revoked_at IS NULL`,
		).bind(now, userId, projectId),
		// An OAuth grant is a credential for this project too: losing project
		// membership must not leave a live MCP authorization behind.
		...grantRevocationStatements(env, { userId, projectId, now, reason }),
	];
}

export async function removeProjectMember(env, projectId, targetUserId, expectedRevision, { auditIntent = null } = {}) {
	const expected = parseExpectedMemberRevision(expectedRevision);
	const current = await env.DB.prepare(
		`SELECT id, project_id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at
		   FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
	).bind(projectId, targetUserId).first();
	if (!current) {
		const noop = { ok: true, removed: false, already_removed: true, previous_role: null };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	if ((await currentMemberRevision(current)).generation !== expected.generation) throw memberConflict();
	const statements = [
		env.DB.prepare(
			"DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND id = ?",
		).bind(projectId, targetUserId, current.id),
		...projectCredentialRevocationStatements(env, {
			userId: targetUserId, projectId, reason: "project_membership_removed",
		}),
	];
	let results;
	try {
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND id = ?",
					[projectId, targetUserId, current.id],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)",
					[projectId, targetUserId],
				)],
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) throw memberConflict();
		throw error;
	}
	const result = results[0];
	if (!(result.meta?.changes ?? 0)) {
		const after = await env.DB.prepare(
			"SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1",
		).bind(projectId, targetUserId).first();
		if (!after) {
			const noop = { ok: true, removed: false, already_removed: true, previous_role: null };
			return auditIntent ? auditedMutationResult(noop, auditIntent) : noop;
		}
		throw memberConflict();
	}
	const mutation = { ok: true, removed: true, already_removed: false, previous_role: current.role };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/**
 * Why leaving refuses implicit access with a 409 rather than a quiet noop: a
 * project owner, or an organization owner/admin reaching the project through
 * their org role, has no seat row to delete. Their access is derived, so
 * "leaving" would change nothing while claiming otherwise — a lie about the
 * caller's own security posture. Org-level access ends by leaving the
 * organization; ownership cannot be walked away from at all.
 */
async function refuseImplicitOnlyProjectLeave(env, { userId, project, orgId }) {
	let implicit = project.owner_user_id === userId;
	if (!implicit && orgId) {
		const seat = await env.DB.prepare(
			"SELECT role FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1",
		).bind(orgId, userId).first();
		implicit = seat?.role === "owner" || seat?.role === "admin";
	}
	if (implicit) {
		throw new OrgError(
			"not_a_member",
			"You have no project seat to leave: your access comes from project ownership or an organization role. Leave the organization to give up org-level access; ownership cannot be left.",
			409,
		);
	}
}

/**
 * Self-service exit from one project seat.
 *
 * Deliberately weaker than removeProjectMember in exactly one way: no If-Match
 * revision. Leaving your own seat is not ABA-sensitive — there is only one
 * seat with your name on it and you can only leave it once — so demanding a
 * revision would add a read round trip before an action whose outcome is the
 * same either way. The id-scoped DELETE still makes concurrent calls
 * converge: one wins, the other reads the empty seat back and reports it
 * honestly as { left: false, already_left: true }.
 */
export async function leaveProject(env, { userId, projectId }, { auditIntent = null } = {}) {
	const project = await env.DB.prepare(
		`SELECT id, owner_user_id, organization_id
		   FROM managed_projects WHERE id = ? AND status = 'active' LIMIT 1`,
	).bind(projectId).first();
	if (!project) throw new OrgError("project_not_found", "That project does not exist.", 404);
	const orgId = await effectiveProjectOrganizationId(env, project);
	const current = await env.DB.prepare(
		`SELECT id, project_id, org_id, user_id, role, created_at, updated_at
		   FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`,
	).bind(projectId, userId).first();
	if (!current) {
		await refuseImplicitOnlyProjectLeave(env, { userId, project, orgId });
		const noop = { ok: true, left: false, already_left: true, previous_role: null };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const statements = [
		env.DB.prepare(
			"DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND id = ?",
		).bind(projectId, userId, current.id),
		...projectCredentialRevocationStatements(env, {
			userId, projectId, reason: "project_membership_left",
		}),
	];
	let results;
	try {
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND id = ?",
					[projectId, userId, current.id],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)",
					[projectId, userId],
				)],
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			// The precondition raced a concurrent leave or an admin removal. The
			// caller's stated goal — not holding this seat — may already hold, and
			// then a repeat must not dress the outcome up as a conflict.
			const after = await env.DB.prepare(
				"SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1",
			).bind(projectId, userId).first();
			if (!after) {
				return commitAuditedNoop(env, auditIntent, {
					ok: true, left: false, already_left: true, previous_role: null,
				});
			}
			throw memberConflict();
		}
		throw error;
	}
	if (!(results[0].meta?.changes ?? 0)) {
		const after = await env.DB.prepare(
			"SELECT id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1",
		).bind(projectId, userId).first();
		if (!after) {
			const noop = { ok: true, left: false, already_left: true, previous_role: null };
			return auditIntent ? auditedMutationResult(noop, auditIntent) : noop;
		}
		throw memberConflict();
	}
	const mutation = { ok: true, left: true, already_left: false, previous_role: current.role };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/**
 * Self-service exit from an organization: the caller's own seat, every project
 * seat they hold inside it, and every credential those seats justified, in one
 * atomic batch. Mirrors removeOrganizationMember exactly except for who asks —
 * and being self-targeted needs no If-Match revision (see leaveProject for why
 * self-leave is not ABA-sensitive). No organization or project data is touched.
 *
 * The owner can never leave. Ownership transfer does not exist, so an owner
 * walking out would orphan the organization with nobody able to administer
 * it; the only honest exit an owner has is deleting the organization.
 */
export async function leaveOrganization(env, { userId, orgId }, { auditIntent = null } = {}) {
	const org = await getOrganization(env, orgId);
	if (!org) throw new OrgError("org_not_found", "That organization does not exist.", 404);
	const current = await env.DB.prepare(
		`SELECT id, org_id, user_id, role, created_at, updated_at
		   FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1`,
	).bind(orgId, userId).first();
	if (org.owner_user_id === userId || current?.role === "owner") {
		throw new OrgError(
			"owner_immutable",
			"The organization owner cannot leave. Ownership cannot be transferred yet, so deleting the organization is the only way to give it up.",
			409,
		);
	}
	if (!current) {
		const noop = { ok: true, left: false, already_left: true, previous_role: null };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const revokedAt = Date.now();
	const statements = [
		env.DB.prepare(
			`DELETE FROM project_members
			  WHERE org_id = ? AND user_id = ?
			    AND EXISTS (
			      SELECT 1 FROM organization_members
			       WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'
			    )`,
		).bind(orgId, userId, orgId, userId, current.id),
		env.DB.prepare(
			"DELETE FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'",
		).bind(orgId, userId, current.id),
		...organizationCredentialRevocationStatements(env, {
			userId, orgId, now: revokedAt, reason: "org_membership_left",
		}),
	];
	let results;
	try {
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ? AND id = ? AND role != 'owner'",
					[orgId, userId, current.id],
				)],
				postconditions: [
					auditInvariantStatement(env, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)", [orgId, userId]),
					auditInvariantStatement(env, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE org_id = ? AND user_id = ?)", [orgId, userId]),
				],
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			// Same convergence rule as leaveProject: a lost race with a concurrent
			// leave or an admin removal is a satisfied goal, not a conflict.
			const after = await env.DB.prepare(
				"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1",
			).bind(orgId, userId).first();
			if (!after) {
				return commitAuditedNoop(env, auditIntent, {
					ok: true, left: false, already_left: true, previous_role: null,
				});
			}
			throw memberConflict();
		}
		throw error;
	}
	if (!(results?.[1]?.meta?.changes ?? 0)) {
		const after = await env.DB.prepare(
			"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1",
		).bind(orgId, userId).first();
		if (!after) {
			const noop = { ok: true, left: false, already_left: true, previous_role: null };
			return auditIntent ? auditedMutationResult(noop, auditIntent) : noop;
		}
		throw memberConflict();
	}
	const mutation = { ok: true, left: true, already_left: false, previous_role: current.role };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}
