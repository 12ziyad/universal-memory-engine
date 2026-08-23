import { newId } from "./ids.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./audit.js";

export const MANAGED_PROJECT_HEADER = "x-itsuki-project";
export const MANAGED_PROJECT_LIMIT = 50;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]{8,80}$/;

export class ManagedProjectError extends Error {
	constructor(code, message, status = 400, currentProject = null) {
		super(message);
		this.name = "ManagedProjectError";
		this.code = code;
		this.status = status;
		this.currentProject = currentProject;
	}
}

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function projectRevision(row) {
	return `prv1.${await sha256Hex(`itsuki:project:revision:v1:${row.id}:${row.created_at}:${row.updated_at}`)}`;
}

function cleanExpectedRevision(value) {
	if (value === null || value === undefined || String(value).trim() === "") {
		throw new ManagedProjectError(
			"precondition_required",
			"Reload this project before saving so a newer change is not overwritten.",
			428,
		);
	}
	let revision = String(value).trim();
	if (revision.startsWith("W/")) revision = revision.slice(2).trim();
	if (revision.startsWith('"') && revision.endsWith('"')) revision = revision.slice(1, -1);
	return revision;
}

function projectConflict(currentProject) {
	return new ManagedProjectError(
		"project_conflict",
		"This project changed in another session. Reload the current values before saving again.",
		412,
		currentProject,
	);
}

function cleanName(value) {
	if (typeof value !== "string") {
		throw new ManagedProjectError("invalid_project_name", "Project name must be a string.");
	}
	const name = value.replace(/\s+/g, " ").trim();
	if (!name) throw new ManagedProjectError("invalid_project_name", "Project name is required.");
	if (name.length > NAME_MAX) {
		throw new ManagedProjectError("invalid_project_name", `Project name cannot exceed ${NAME_MAX} characters.`);
	}
	if (/[\u0000-\u001f\u007f]/.test(name)) {
		throw new ManagedProjectError("invalid_project_name", "Project name cannot contain control characters.");
	}
	return name;
}

function cleanDescription(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new ManagedProjectError("invalid_project_description", "Project description must be a string.");
	}
	const description = value.trim();
	if (description.length > DESCRIPTION_MAX) {
		throw new ManagedProjectError(
			"invalid_project_description",
			`Project description cannot exceed ${DESCRIPTION_MAX} characters.`,
		);
	}
	return description || null;
}

function normalizedName(name) {
	return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateProjectInput(input, { requireName = false } = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new ManagedProjectError("invalid_project", "Project details must be a JSON object.");
	}
	const unknown = Object.keys(input).filter((key) => !["name", "description"].includes(key));
	if (unknown.length) {
		throw new ManagedProjectError(
			"unknown_project_field",
			`Unknown project field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
		);
	}
	if (requireName && !Object.prototype.hasOwnProperty.call(input, "name")) {
		throw new ManagedProjectError("invalid_project_name", "Project name is required.");
	}
}

async function publicProject(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		is_default: Boolean(row.is_default),
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
		revision: await projectRevision(row),
		// Governance identity, needed by membership resolution. The memory owner
		// is deliberately NOT exposed here: it is a storage id, never a field an
		// ordinary client should see or be able to echo back.
		owner_user_id: row.owner_user_id ?? null,
		organization_id: row.organization_id ?? null,
		effective_organization_id: row.effective_organization_id ?? row.organization_id ?? null,
		organization_name: row.organization_name ?? null,
		organization_role: row.organization_role ?? null,
		project_role: row.project_role ?? null,
	};
}

const PROJECT_COLUMNS =
	"id, owner_user_id, organization_id, memory_owner_user_id, name, description, is_default, status, created_at, updated_at";

/**
 * Migration 0039 deliberately left historical projects unclaimed. Until a row
 * is explicitly attached, its owner's active default organization is the
 * governance boundary. Keep that compatibility rule inside every access query
 * so a NULL never means "match whichever organization the actor owns".
 */
function effectiveOrganizationSql(projectAlias) {
	return `COALESCE(${projectAlias}.organization_id, (
		SELECT o.id FROM organizations o
		 WHERE o.owner_user_id = ${projectAlias}.owner_user_id
		   AND o.is_default = 1 AND o.status = 'active'
		 LIMIT 1
	))`;
}

async function managedProjectRowForUser(env, userId, projectId) {
	const effectiveOrganization = effectiveOrganizationSql("managed_projects");
	const now = Date.now();
	return env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS},
		        ${effectiveOrganization} AS effective_organization_id,
		        (SELECT o.name FROM organizations o WHERE o.id = ${effectiveOrganization}) AS organization_name,
		        (SELECT om.role FROM organization_members om
		          WHERE om.org_id = ${effectiveOrganization} AND om.user_id = ? LIMIT 1) AS organization_role,
		        (SELECT pmr.role FROM project_members pmr
		          WHERE pmr.project_id = managed_projects.id AND pmr.user_id = ?
		            AND pmr.org_id = ${effectiveOrganization} LIMIT 1) AS project_role
		   FROM managed_projects
		  WHERE id = ? AND status = 'active'
		    AND (
		      owner_user_id = ?
		      OR EXISTS (
		        SELECT 1 FROM project_members pm
		         WHERE pm.project_id = managed_projects.id AND pm.user_id = ?
		           AND pm.org_id = ${effectiveOrganization}
		           AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		           AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		           AND EXISTS (
		             SELECT 1 FROM organization_members om2
		              WHERE om2.org_id = pm.org_id AND om2.user_id = pm.user_id
		                AND (om2.role = 'owner' OR om2.access_starts_at IS NULL OR om2.access_starts_at <= ?)
		                AND (om2.role = 'owner' OR om2.access_expires_at IS NULL OR om2.access_expires_at > ?)
		           )
		      )
		      OR EXISTS (
		        SELECT 1 FROM organization_members om
		         WHERE om.org_id = ${effectiveOrganization}
		           AND om.user_id = ? AND om.role IN ('owner', 'admin')
		           AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		           AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		      )
		    )
		  LIMIT 1`,
	).bind(userId, userId, projectId, userId, userId, now, now, now, now, userId, now, now).first();
}

/**
 * A project this user may reach, whether they own it or were given access.
 *
 * The subtle half is that OWNERSHIP still decides the memory namespace. A
 * member reads and writes the owner's memory space, never one derived from
 * their own id — deriving from the caller would silently give every member a
 * private, empty copy of the project and quietly break the whole feature.
 */
export async function getManagedProjectForUser(env, userId, projectId) {
	const row = await managedProjectRowForUser(env, userId, projectId);
	return await publicProject(row);
}

function projectIdFromHeader(request) {
	const value = request.headers.get(MANAGED_PROJECT_HEADER);
	if (value === null) return null;
	const id = value.trim();
	if (!PROJECT_ID_PATTERN.test(id) || id !== value) {
		throw new ManagedProjectError(
			"invalid_project_id",
			`${MANAGED_PROJECT_HEADER} must contain one valid project id.`,
		);
	}
	return id;
}

export async function defaultManagedProjectId(ownerUserId) {
	const digest = await sha256Hex(`itsuki:managed-project:default:v1:${ownerUserId}`);
	return `proj_${digest.slice(0, 32)}`;
}

export async function ensureDefaultManagedProject(env, ownerUserId) {
	const existing = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		 WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
		 LIMIT 1`,
	).bind(ownerUserId).first();
	if (existing) return await publicProject(existing);

	const id = await defaultManagedProjectId(ownerUserId);
	const at = Date.now();
	try {
		await env.DB.batch([
			env.DB.prepare(
			`INSERT OR IGNORE INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
			 SELECT ?, ?, ?, 'Default project', 'default project', NULL, 1, 'active', ?, ?
			  WHERE EXISTS (
			    SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active'
			      AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			  )`,
			).bind(id, ownerUserId, ownerUserId, at, at, ownerUserId),
			auditInvariantStatement(
				env,
				`SELECT 1 FROM managed_projects p
				  JOIN users u ON u.id = p.owner_user_id AND u.status = 'active'
				 WHERE p.owner_user_id = ? AND p.is_default = 1 AND p.status = 'active'
				   AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)`,
				[ownerUserId],
			),
		]);
	} catch (error) {
		// A second live session can observe "missing" before the first commits.
		// The trigger enforces the unique default/name and raises ABORT even for
		// INSERT OR IGNORE; that exact collision means the winner is now reloadable.
		if (!/unique constraint|managed_project_name_conflict/i.test(String(error?.message ?? error))) throw error;
	}

	const row = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		 WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
		 LIMIT 1`,
	).bind(ownerUserId).first();
	if (!row) {
		throw new ManagedProjectError("project_store_unavailable", "The default project could not be loaded.", 503);
	}
	return await publicProject(row);
}

/**
 * Every project this user can open: their own first, then the ones membership
 * opens up. Someone else's project is marked `shared` so the selector can say
 * whose it is rather than implying they own it.
 */
export async function listManagedProjects(env, ownerUserId) {
	await ensureDefaultManagedProject(env, ownerUserId);
	const effectiveOrganization = effectiveOrganizationSql("managed_projects");
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS},
		        ${effectiveOrganization} AS effective_organization_id,
		        (SELECT o.name FROM organizations o WHERE o.id = ${effectiveOrganization}) AS organization_name,
		        (SELECT om.role FROM organization_members om
		          WHERE om.org_id = ${effectiveOrganization} AND om.user_id = ? LIMIT 1) AS organization_role,
		        (SELECT pmr.role FROM project_members pmr
		          WHERE pmr.project_id = managed_projects.id AND pmr.user_id = ?
		            AND pmr.org_id = ${effectiveOrganization} LIMIT 1) AS project_role
		   FROM managed_projects
		  WHERE status = 'active'
		    AND (
		      owner_user_id = ?
		      OR EXISTS (
		        SELECT 1 FROM project_members pm
		         WHERE pm.project_id = managed_projects.id AND pm.user_id = ?
		           AND pm.org_id = ${effectiveOrganization}
		           AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		           AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		           AND EXISTS (
		             SELECT 1 FROM organization_members om2
		              WHERE om2.org_id = pm.org_id AND om2.user_id = pm.user_id
		                AND (om2.role = 'owner' OR om2.access_starts_at IS NULL OR om2.access_starts_at <= ?)
		                AND (om2.role = 'owner' OR om2.access_expires_at IS NULL OR om2.access_expires_at > ?)
		           )
		      )
		      OR EXISTS (
		        SELECT 1 FROM organization_members om
		         WHERE om.org_id = ${effectiveOrganization}
		           AND om.user_id = ? AND om.role IN ('owner', 'admin')
		           AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		           AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		      )
		    )
		  ORDER BY (owner_user_id = ?) DESC, is_default DESC, created_at ASC, name COLLATE NOCASE ASC`,
	).bind(
		ownerUserId, ownerUserId,
		ownerUserId,
		ownerUserId, now, now, now, now,
		ownerUserId, now, now,
		ownerUserId,
	).all();
	return Promise.all((results ?? []).map(async (row) => ({
		...await publicProject(row),
		shared: row.owner_user_id !== ownerUserId,
	})));
}

export async function getManagedProject(env, ownerUserId, projectId) {
	const effectiveOrganization = effectiveOrganizationSql("managed_projects");
	const row = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS},
		        ${effectiveOrganization} AS effective_organization_id,
		        (SELECT o.name FROM organizations o WHERE o.id = ${effectiveOrganization}) AS organization_name,
		        (SELECT om.role FROM organization_members om
		          WHERE om.org_id = ${effectiveOrganization} AND om.user_id = ? LIMIT 1) AS organization_role,
		        (SELECT pm.role FROM project_members pm
		          WHERE pm.project_id = managed_projects.id AND pm.user_id = ?
		            AND pm.org_id = ${effectiveOrganization} LIMIT 1) AS project_role
		   FROM managed_projects
		 WHERE id = ? AND owner_user_id = ? AND status = 'active'
		 LIMIT 1`,
	).bind(ownerUserId, ownerUserId, projectId, ownerUserId).first();
	return await publicProject(row);
}

export async function createManagedProject(env, ownerUserId, input = {}, {
	organizationId = null,
	auditIntent = null,
} = {}) {
	validateProjectInput(input, { requireName: true });
	await ensureDefaultManagedProject(env, ownerUserId);
	const name = cleanName(input.name);
	const description = cleanDescription(input.description);
	const id = newId("proj");
	const memoryOwnerUserId = await managedProjectMemoryOwnerId(ownerUserId, { id, is_default: false });
	const at = Date.now();
	try {
		const statement = env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized, description,
			  is_default, status, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?
			 WHERE (SELECT COUNT(*) FROM managed_projects
			         WHERE owner_user_id = ? AND organization_id IS ? AND status = 'active') < ?`,
		).bind(
			id,
			ownerUserId,
			organizationId,
			memoryOwnerUserId,
			name,
			normalizedName(name),
			description,
			at,
			at,
			ownerUserId,
			organizationId,
			MANAGED_PROJECT_LIMIT,
		);
		let result;
		if (auditIntent) {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					`SELECT 1 WHERE
					 (SELECT COUNT(*) FROM managed_projects
					   WHERE owner_user_id = ? AND organization_id IS ? AND status = 'active') < ?
					 AND NOT EXISTS (
					   SELECT 1 FROM managed_projects
					    WHERE owner_user_id = ? AND organization_id IS ? AND status = 'active' AND name_normalized = ?
					 )`,
					[ownerUserId, organizationId, MANAGED_PROJECT_LIMIT,
						ownerUserId, organizationId, normalizedName(name)],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM managed_projects WHERE id = ? AND owner_user_id = ? AND organization_id IS ? AND status = 'active' AND updated_at = ?",
					[id, ownerUserId, organizationId, at],
				)],
				commitDetails: { orgId: organizationId, projectId: id, targetId: id },
			});
		} else result = await statement.run();
		if ((result.meta?.changes ?? 0) !== 1) {
			throw new ManagedProjectError(
				"project_limit_reached",
				`An organization can have at most ${MANAGED_PROJECT_LIMIT} active projects.`,
				409,
			);
		}
	} catch (error) {
		if (error instanceof ManagedProjectError) throw error;
		if (/unique constraint|managed_project_name_conflict/i.test(String(error?.message ?? error))) {
			throw new ManagedProjectError("project_name_exists", "A project with that name already exists.", 409);
		}
		// Audited compare-and-set invariants intentionally collapse to one
		// content-free fence error. Re-read only this organization's bounded
		// name/count state so an ordinary collision remains a truthful 409 while
		// lifecycle/capability fence failures keep failing closed.
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const collision = await env.DB.prepare(
				`SELECT 1 AS ok FROM managed_projects
				  WHERE owner_user_id = ? AND organization_id IS ?
				    AND status = 'active' AND name_normalized = ? LIMIT 1`,
			).bind(ownerUserId, organizationId, normalizedName(name)).first();
			if (collision) {
				throw new ManagedProjectError("project_name_exists", "A project with that name already exists.", 409);
			}
			const active = await env.DB.prepare(
				`SELECT COUNT(*) AS n FROM managed_projects
				  WHERE owner_user_id = ? AND organization_id IS ? AND status = 'active'`,
			).bind(ownerUserId, organizationId).first();
			if (Number(active?.n ?? 0) >= MANAGED_PROJECT_LIMIT) {
				throw new ManagedProjectError(
					"project_limit_reached",
					`An organization can have at most ${MANAGED_PROJECT_LIMIT} active projects.`,
					409,
				);
			}
		}
		throw error;
	}
	const project = await getManagedProject(env, ownerUserId, id);
	return auditIntent ? auditedMutationResult(project, auditIntent) : project;
}

export async function updateManagedProject(env, ownerUserId, projectId, input = {}, expectedRevision, options = {}) {
	const auditIntent = options?.auditIntent ?? null;
	validateProjectInput(input);
	const expected = cleanExpectedRevision(expectedRevision);
	const current = await getManagedProject(env, ownerUserId, projectId);
	if (!current) throw new ManagedProjectError("project_not_found", "That project does not exist.", 404);
	if (current.revision !== expected) throw projectConflict(current);
	const name = Object.prototype.hasOwnProperty.call(input, "name") ? cleanName(input.name) : current.name;
	const description = Object.prototype.hasOwnProperty.call(input, "description")
		? cleanDescription(input.description)
		: current.description;
	if (name === current.name && description === current.description) {
		const unchanged = { project: current, previousProject: current, changed: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	const updatedAt = Math.max(Date.now(), Number(current.updated_at) + 1);
	try {
		const statement = env.DB.prepare(
			`UPDATE managed_projects
			 SET name = ?, name_normalized = ?, description = ?, updated_at = ?
			 WHERE id = ? AND owner_user_id = ? AND status = 'active'
			   AND created_at = ? AND updated_at = ?`,
		).bind(
			name,
			normalizedName(name),
			description,
			updatedAt,
			projectId,
			ownerUserId,
			current.created_at,
			current.updated_at,
		);
		let result;
		if (auditIntent) {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM managed_projects WHERE id = ? AND owner_user_id = ? AND status = 'active' AND created_at = ? AND updated_at = ?",
					[projectId, ownerUserId, current.created_at, current.updated_at],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM managed_projects WHERE id = ? AND owner_user_id = ? AND status = 'active' AND updated_at = ? AND name = ? AND description IS ?",
					[projectId, ownerUserId, updatedAt, name, description],
				)],
			});
		} else result = await statement.run();
		if (Number(result?.meta?.changes ?? 0) !== 1) {
			throw projectConflict(await getManagedProject(env, ownerUserId, projectId));
		}
	} catch (error) {
		if (error instanceof ManagedProjectError) throw error;
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw projectConflict(await getManagedProject(env, ownerUserId, projectId));
		}
		if (/unique constraint|managed_project_name_conflict/i.test(String(error?.message ?? error))) {
			throw new ManagedProjectError("project_name_exists", "A project with that name already exists.", 409);
		}
		throw error;
	}
	const updated = {
		project: await getManagedProject(env, ownerUserId, projectId),
		previousProject: current,
		changed: true,
	};
	return auditIntent ? auditedMutationResult(updated, auditIntent) : updated;
}

export async function managedProjectMemoryOwnerId(ownerUserId, project) {
	if (project?.is_default) return ownerUserId;
	const digest = await sha256Hex(`itsuki:managed-project:memory-owner:v1:${ownerUserId}:${project?.id}`);
	return `mem_${digest.slice(0, 32)}`;
}

/**
 * Retention and erasure need a finite, authoritative inventory of every hashed
 * memory tenant belonging to a managed project. This write is awaited at the
 * project boundary, before a managed write can be accepted.
 */
export async function registerProjectMemorySpace(env, {
	projectId,
	memoryOwnerUserId,
	memoryUserId = memoryOwnerUserId,
} = {}) {
	for (const [field, value] of Object.entries({ projectId, memoryOwnerUserId, memoryUserId })) {
		if (typeof value !== "string" || !value || value.length > 160) {
			throw new ManagedProjectError("invalid_memory_space", `${field} is not a valid managed memory-space identifier.`, 500);
		}
	}
	const at = Date.now();
	const result = await env.DB.prepare(
		`INSERT INTO project_memory_spaces
		 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
		 SELECT id, ?, ?, 'active', ?, ? FROM managed_projects
		  WHERE id = ? AND status = 'active'
		    AND (memory_owner_user_id = ? OR memory_owner_user_id IS NULL)
		 ON CONFLICT(project_id, memory_user_id) DO UPDATE SET
			memory_owner_user_id = excluded.memory_owner_user_id,
			state = CASE WHEN project_memory_spaces.state = 'deleting' THEN 'deleting' ELSE 'active' END,
			last_seen_at = MAX(project_memory_spaces.last_seen_at, excluded.last_seen_at)`,
	).bind(
		memoryOwnerUserId, memoryUserId, at, at, projectId, memoryOwnerUserId,
	).run();
	if (Number(result?.meta?.changes ?? 0) !== 1) {
		throw new ManagedProjectError("project_not_found", "That project does not exist.", 404);
	}
	return { projectId, memoryOwnerUserId, memoryUserId };
}

/**
 * Commit-time guard for a managed write. Resolution and registration happen
 * before model work; account erasure can archive the project while that work
 * is in flight. Put this statement in the SAME D1 batch as every durable
 * write so an archived project makes the transaction fail atomically.
 */
export function managedProjectActiveGuardStatement(env, projectId) {
	if (typeof projectId !== "string" || !projectId || projectId.length > 160) {
		throw new ManagedProjectError("invalid_project_id", "A valid managed project is required for this write.", 400);
	}
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT EXISTS (
			SELECT 1 FROM managed_projects WHERE id = ? AND status = 'active'
		 )`,
	).bind(projectId);
}

/**
 * Commit-time account + managed-project fence for accepted work.
 *
 * Authentication and project resolution happen before model/DO work. Account
 * erasure can start in that interval, so every later D1 mutation must put this
 * statement in the SAME batch as the row it is about to create/update. The
 * permanent tombstone closes the post-user-delete race; the active user and
 * project checks close the quiescing interval before deletion completes.
 */
export function managedMutationGuardStatement(env, {
	accountUserId = null,
	projectId = null,
	access = "write",
	allowErasedAccounting = false,
	memoryUserId = null,
} = {}) {
	const now = Date.now();
	if (!new Set(["read", "write"]).has(access)) {
		throw new ManagedProjectError("invalid_write_guard", "Managed lifecycle access must be read or write.", 500);
	}
	const projectRoles = access === "read" ? "'admin', 'member', 'viewer'" : "'admin', 'member'";
	if (accountUserId !== null && (typeof accountUserId !== "string" || !accountUserId || accountUserId.length > 160)) {
		throw new ManagedProjectError("invalid_account_id", "A valid account is required for this write.", 400);
	}
	if (projectId !== null && (typeof projectId !== "string" || !projectId || projectId.length > 160)) {
		throw new ManagedProjectError("invalid_project_id", "A valid managed project is required for this write.", 400);
	}
	if (!accountUserId && !projectId) {
		throw new ManagedProjectError("missing_write_guard", "A managed write guard requires an account or project.", 500);
	}
	if (allowErasedAccounting && memoryUserId !== null
		&& (typeof memoryUserId !== "string" || !memoryUserId || memoryUserId.length > 256)) {
		throw new ManagedProjectError("invalid_memory_space", "A valid memory space is required for erased accounting.", 400);
	}
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT (
		   ? = 1 AND EXISTS (
		     SELECT 1 FROM account_erasure_tombstones WHERE user_id = ? OR user_id = ?
		   )
		 ) AND (
		   (? IS NOT NULL AND (
		     EXISTS (SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?)
		     OR NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
		   ))
		   OR (? IS NOT NULL AND NOT EXISTS (
		     SELECT 1 FROM managed_projects p
		      WHERE p.id = ? AND p.status = 'active'
		        AND CASE
		          -- A project-only guard is used by deterministic compatibility
		          -- materialization where there is no human actor. It still proves
		          -- the project and its effective organization are live.
		          WHEN ? IS NULL THEN (
		            COALESCE(p.organization_id, (
		              SELECT o.id FROM organizations o
		               WHERE o.owner_user_id = p.owner_user_id
		                 AND o.is_default = 1 AND o.status = 'active' LIMIT 1
		            )) IS NULL
		            OR EXISTS (
		              SELECT 1 FROM organizations o
		               WHERE o.id = COALESCE(p.organization_id, (
		                 SELECT od.id FROM organizations od
		                  WHERE od.owner_user_id = p.owner_user_id
		                    AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		               )) AND o.status = 'active'
		            )
		          )
		          -- With an authenticated account, this is also the commit-time
		          -- project memory capability check selected by the trusted caller
		          -- (write by default; read only for content-free recall bookkeeping).
		          -- It closes the interval between
		          -- HTTP/MCP authorization and a later source/graph/receipt/DO
		          -- commit: a removed, expired, or downgraded member cannot finish
		          -- already-authorized work.
		          ELSE (
		            -- Genuine pre-organization compatibility project.
		            (
		              p.organization_id IS NULL AND p.owner_user_id = ?
		              AND NOT EXISTS (
		                SELECT 1 FROM organizations legacy_org
		                 WHERE legacy_org.owner_user_id = p.owner_user_id
		                   AND legacy_org.is_default = 1 AND legacy_org.status = 'active'
		              )
		            )
		            OR EXISTS (
		              SELECT 1 FROM organizations o
		               WHERE o.id = COALESCE(p.organization_id, (
		                 SELECT od.id FROM organizations od
		                  WHERE od.owner_user_id = p.owner_user_id
		                    AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		               )) AND o.status = 'active'
		                 AND (
		                   -- The storage owner shortcut is valid only when it is
		                   -- also the active organization's real owner.
		                   (p.owner_user_id = ? AND o.owner_user_id = ?)
		                   OR EXISTS (
		                     SELECT 1 FROM organization_members om
		                      WHERE om.org_id = o.id AND om.user_id = ?
		                        AND om.role IN ('owner', 'admin')
		                        AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		                        AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		                   )
		                   OR (
		                     EXISTS (
		                       SELECT 1 FROM organization_members om
		                        WHERE om.org_id = o.id AND om.user_id = ?
		                          AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		                          AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		                     )
		                     AND EXISTS (
		                       SELECT 1 FROM project_members pm
		                        WHERE pm.project_id = p.id AND pm.org_id = o.id AND pm.user_id = ?
		                          AND pm.role IN (${projectRoles})
		                          AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		                          AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		                     )
		                   )
		                 )
		            )
		          )
		        END
		   ))
		 )`,
	).bind(
		allowErasedAccounting ? 1 : 0, accountUserId, memoryUserId,
		accountUserId, accountUserId, accountUserId,
		projectId, projectId,
		accountUserId,
		accountUserId,
		accountUserId, accountUserId,
		accountUserId, now, now,
		accountUserId, now, now,
		accountUserId, now, now,
	);
}

async function resolvedManagedProject(env, result) {
	// Resolution is used by read-only settings, preview, and chooser routes. It
	// must stay read-only: managed write doors register their exact (possibly
	// subtenant) memory space before accepting data, while retention discovery
	// always includes the immutable project root even before first write.
	return result;
}

/**
 * Resolve the server-owned project boundary for a session or key. A token's
 * project is immutable; request headers may confirm it but never replace it.
 */
export async function resolveManagedProject(env, request, auth) {
	if (!auth || auth.type === "legacy") return null;
	const requestedId = projectIdFromHeader(request);
	// An OAuth grant carries its own project binding, exactly like a
	// project-bound connection token: the consent screen named that project and
	// the user approved THAT. A caller-supplied project header must never move
	// an OAuth connection to a project the user never authorized.
	const credentialBoundProjectId = ["token", "oauth"].includes(auth.type)
		? auth.token?.projectId ?? null
		: null;
	const explicitTokenProjectId = credentialBoundProjectId;
	// A key minted before migration 0038 has NULL project_id. It is permanently
	// bound to the deterministic default project; NULL must never mean
	// "caller may choose any project". An OAuth grant on the default project
	// stores NULL for the same reason and is bound the same way.
	if (["token", "oauth"].includes(auth.type) && !explicitTokenProjectId) {
		const defaultProject = await ensureDefaultManagedProject(env, auth.userId);
		if (requestedId && requestedId !== defaultProject.id) {
			throw new ManagedProjectError(
				"project_scope_mismatch",
				"This credential is bound to a different project and cannot switch projects.",
				403,
			);
		}
		return resolvedManagedProject(env, {
			project: defaultProject,
			accountUserId: auth.userId,
			memoryOwnerUserId: auth.userId,
		});
	}
	if (explicitTokenProjectId && requestedId && explicitTokenProjectId !== requestedId) {
		throw new ManagedProjectError(
			"project_scope_mismatch",
			"This credential is bound to a different project and cannot switch projects.",
			403,
		);
	}

	// Explicit project ids take one indexed lookup. Only historical keys with
	// NULL project_id and sessions with no selection need the lazy,
	// deterministic default-project bootstrap.
	if (explicitTokenProjectId || requestedId) {
		const selectedId = explicitTokenProjectId ?? requestedId;
		// A project-bound key belongs to the account that created the credential,
		// but that account may be a collaborator rather than the project owner.
		// Resolve access afresh and take the storage identity from the project row;
		// never derive a shared project's memory space from the key creator.
		const row = await managedProjectRowForUser(env, auth.userId, selectedId);
		const project = await publicProject(row);
		if (!project) {
			throw new ManagedProjectError("project_not_found", "That project does not exist.", 404);
		}
		return resolvedManagedProject(env, {
			project,
			accountUserId: auth.userId,
			// Derived from the project's OWNER, never from the caller. A member
			// works inside the owner's memory space; deriving from whoever is
			// signed in would hand each member a private empty copy.
			memoryOwnerUserId: row.memory_owner_user_id
				?? await managedProjectMemoryOwnerId(project.owner_user_id ?? auth.userId, project),
		});
	}

	const defaultProject = await ensureDefaultManagedProject(env, auth.userId);
	return resolvedManagedProject(env, {
		project: defaultProject,
		accountUserId: auth.userId,
		memoryOwnerUserId: auth.userId,
	});
}
