import { newId } from "./ids.js";

export const MANAGED_PROJECT_HEADER = "x-itsuki-project";
export const MANAGED_PROJECT_LIMIT = 50;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const PROJECT_ID_PATTERN = /^proj_[A-Za-z0-9_-]{8,80}$/;

export class ManagedProjectError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.name = "ManagedProjectError";
		this.code = code;
		this.status = status;
	}
}

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function publicProject(row) {
	if (!row) return null;
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		is_default: Boolean(row.is_default),
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
		// Governance identity, needed by membership resolution. The memory owner
		// is deliberately NOT exposed here: it is a storage id, never a field an
		// ordinary client should see or be able to echo back.
		owner_user_id: row.owner_user_id ?? null,
		organization_id: row.organization_id ?? null,
	};
}

const PROJECT_COLUMNS =
	"id, owner_user_id, organization_id, name, description, is_default, status, created_at, updated_at";

/**
 * A project this user may reach, whether they own it or were given access.
 *
 * The subtle half is that OWNERSHIP still decides the memory namespace. A
 * member reads and writes the owner's memory space, never one derived from
 * their own id — deriving from the caller would silently give every member a
 * private, empty copy of the project and quietly break the whole feature.
 */
export async function getManagedProjectForUser(env, userId, projectId) {
	const row = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		  WHERE id = ? AND status = 'active'
		    AND (
		      owner_user_id = ?
		      OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = managed_projects.id AND pm.user_id = ?)
		      OR EXISTS (
		        SELECT 1 FROM organization_members om
		         WHERE om.org_id = managed_projects.organization_id
		           AND om.user_id = ? AND om.role IN ('owner', 'admin')
		      )
		    )
		  LIMIT 1`,
	).bind(projectId, userId, userId, userId).first();
	return publicProject(row);
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
	if (existing) return publicProject(existing);

	const id = await defaultManagedProjectId(ownerUserId);
	const at = Date.now();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO managed_projects
		 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'Default project', 'default project', NULL, 1, 'active', ?, ?)`,
	).bind(id, ownerUserId, ownerUserId, at, at).run();

	const row = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		 WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
		 LIMIT 1`,
	).bind(ownerUserId).first();
	if (!row) {
		throw new ManagedProjectError("project_store_unavailable", "The default project could not be loaded.", 503);
	}
	return publicProject(row);
}

/**
 * Every project this user can open: their own first, then the ones membership
 * opens up. Someone else's project is marked `shared` so the selector can say
 * whose it is rather than implying they own it.
 */
export async function listManagedProjects(env, ownerUserId) {
	await ensureDefaultManagedProject(env, ownerUserId);
	const { results } = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		  WHERE status = 'active'
		    AND (
		      owner_user_id = ?
		      OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = managed_projects.id AND pm.user_id = ?)
		      OR EXISTS (
		        SELECT 1 FROM organization_members om
		         WHERE om.org_id = managed_projects.organization_id
		           AND om.user_id = ? AND om.role IN ('owner', 'admin')
		      )
		    )
		  ORDER BY (owner_user_id = ?) DESC, is_default DESC, created_at ASC, name COLLATE NOCASE ASC`,
	).bind(ownerUserId, ownerUserId, ownerUserId, ownerUserId).all();
	return (results ?? []).map((row) => ({
		...publicProject(row),
		shared: row.owner_user_id !== ownerUserId,
	}));
}

export async function getManagedProject(env, ownerUserId, projectId) {
	const row = await env.DB.prepare(
		`SELECT ${PROJECT_COLUMNS} FROM managed_projects
		 WHERE id = ? AND owner_user_id = ? AND status = 'active'
		 LIMIT 1`,
	).bind(projectId, ownerUserId).first();
	return publicProject(row);
}

export async function createManagedProject(env, ownerUserId, input = {}) {
	validateProjectInput(input, { requireName: true });
	await ensureDefaultManagedProject(env, ownerUserId);
	const name = cleanName(input.name);
	const description = cleanDescription(input.description);
	const id = newId("proj");
	const memoryOwnerUserId = await managedProjectMemoryOwnerId(ownerUserId, { id, is_default: false });
	const at = Date.now();
	try {
		const result = await env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?
			 WHERE (SELECT COUNT(*) FROM managed_projects WHERE owner_user_id = ? AND status = 'active') < ?`,
		).bind(
			id,
			ownerUserId,
			memoryOwnerUserId,
			name,
			normalizedName(name),
			description,
			at,
			at,
			ownerUserId,
			MANAGED_PROJECT_LIMIT,
		).run();
		if ((result.meta?.changes ?? 0) !== 1) {
			throw new ManagedProjectError(
				"project_limit_reached",
				`An account can have at most ${MANAGED_PROJECT_LIMIT} active projects.`,
				409,
			);
		}
	} catch (error) {
		if (error instanceof ManagedProjectError) throw error;
		if (/unique constraint/i.test(String(error?.message ?? error))) {
			throw new ManagedProjectError("project_name_exists", "A project with that name already exists.", 409);
		}
		throw error;
	}
	return getManagedProject(env, ownerUserId, id);
}

export async function updateManagedProject(env, ownerUserId, projectId, input = {}) {
	validateProjectInput(input);
	const current = await getManagedProject(env, ownerUserId, projectId);
	if (!current) throw new ManagedProjectError("project_not_found", "That project does not exist.", 404);
	const name = Object.prototype.hasOwnProperty.call(input, "name") ? cleanName(input.name) : current.name;
	const description = Object.prototype.hasOwnProperty.call(input, "description")
		? cleanDescription(input.description)
		: current.description;
	try {
		await env.DB.prepare(
			`UPDATE managed_projects
			 SET name = ?, name_normalized = ?, description = ?, updated_at = ?
			 WHERE id = ? AND owner_user_id = ? AND status = 'active'`,
		).bind(name, normalizedName(name), description, Date.now(), projectId, ownerUserId).run();
	} catch (error) {
		if (/unique constraint/i.test(String(error?.message ?? error))) {
			throw new ManagedProjectError("project_name_exists", "A project with that name already exists.", 409);
		}
		throw error;
	}
	return getManagedProject(env, ownerUserId, projectId);
}

export async function managedProjectMemoryOwnerId(ownerUserId, project) {
	if (project?.is_default) return ownerUserId;
	const digest = await sha256Hex(`itsuki:managed-project:memory-owner:v1:${ownerUserId}:${project?.id}`);
	return `mem_${digest.slice(0, 32)}`;
}

/**
 * Resolve the server-owned project boundary for a session or key. A token's
 * project is immutable; request headers may confirm it but never replace it.
 */
export async function resolveManagedProject(env, request, auth) {
	if (!auth || auth.type === "legacy") return null;
	const requestedId = projectIdFromHeader(request);
	const explicitTokenProjectId = auth.type === "token" ? auth.token?.projectId : null;
	// A key minted before migration 0038 has NULL project_id. It is permanently
	// bound to the deterministic default project; NULL must never mean
	// "caller may choose any project".
	if (auth.type === "token" && !explicitTokenProjectId) {
		const defaultProject = await ensureDefaultManagedProject(env, auth.userId);
		if (requestedId && requestedId !== defaultProject.id) {
			throw new ManagedProjectError(
				"project_scope_mismatch",
				"This credential is bound to a different project and cannot switch projects.",
				403,
			);
		}
		return {
			project: defaultProject,
			accountUserId: auth.userId,
			memoryOwnerUserId: auth.userId,
		};
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
		// A bearer key is bound to one project and its holder is the owner by
		// construction; a browser session may be a member of someone else's.
		const project = auth.type === "token"
			? await getManagedProject(env, auth.userId, selectedId)
			: await getManagedProjectForUser(env, auth.userId, selectedId);
		if (!project) {
			throw new ManagedProjectError("project_not_found", "That project does not exist.", 404);
		}
		return {
			project,
			accountUserId: auth.userId,
			// Derived from the project's OWNER, never from the caller. A member
			// works inside the owner's memory space; deriving from whoever is
			// signed in would hand each member a private empty copy.
			memoryOwnerUserId: await managedProjectMemoryOwnerId(project.owner_user_id ?? auth.userId, project),
		};
	}

	const defaultProject = await ensureDefaultManagedProject(env, auth.userId);
	return {
		project: defaultProject,
		accountUserId: auth.userId,
		memoryOwnerUserId: auth.userId,
	};
}
