/**
 * First-run account bootstrap and durable UI scope.
 *
 * This module deliberately owns no HTTP concerns. Routes authenticate the
 * actor and reserve an audit intent; these functions validate and commit the
 * authoritative account/organization/project state in one D1 transaction.
 */

import { newId } from "./ids.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./audit.js";
import {
	defaultManagedProjectId,
	getManagedProjectForUser,
	listManagedProjects,
	managedMutationGuardStatement,
} from "./managed_projects.js";
import { accessibleProjectIds, listOrganizations } from "./organizations.js";

export const ONBOARDING_CONVERSATION_SAMPLE_LIMIT = 20_000;
export const ONBOARDING_USE_SCOPES = ["personal", "team", "product"];

const ONBOARDING_FIELDS = new Set([
	"workspaceName",
	"useScope",
	"useCase",
	"useCaseOther",
	"heardAbout",
	"heardAboutOther",
	"conversationSample",
	"conversationSampleConsent",
]);

export class AccountBootstrapError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.name = "AccountBootstrapError";
		this.code = code;
		this.status = status;
	}
}

function cleanRequiredText(value, field, max) {
	if (typeof value !== "string") {
		throw new AccountBootstrapError(`invalid_${field}`, `${field} must be a string.`);
	}
	const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!cleaned) throw new AccountBootstrapError(`invalid_${field}`, `${field} is required.`);
	if (cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) {
		throw new AccountBootstrapError(`invalid_${field}`, `${field} is not valid.`);
	}
	return cleaned;
}

function cleanOptionalText(value, field, max) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") {
		throw new AccountBootstrapError(`invalid_${field}`, `${field} must be a string.`);
	}
	const cleaned = value.normalize("NFKC").trim();
	if (!cleaned) return null;
	if (cleaned.length > max || /\u0000/.test(cleaned)) {
		throw new AccountBootstrapError(`invalid_${field}`, `${field} is not valid.`);
	}
	return cleaned;
}

function cleanId(value, field) {
	if (typeof value !== "string" || !value || value.length > 160 || value !== value.trim()) {
		throw new AccountBootstrapError(`invalid_${field}`, `A valid ${field} is required.`);
	}
	return value;
}

function normalizedNow(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : Date.now();
}

function normalizeOnboardingInput(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new AccountBootstrapError("invalid_onboarding", "Onboarding details must be a JSON object.");
	}
	const unknown = Object.keys(input).filter((key) => !ONBOARDING_FIELDS.has(key));
	if (unknown.length) {
		throw new AccountBootstrapError(
			"unknown_onboarding_field",
			`Unknown onboarding field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
		);
	}
	const workspaceName = cleanRequiredText(input.workspaceName, "workspace_name", 80);
	const useScope = cleanRequiredText(input.useScope, "use_scope", 20).toLocaleLowerCase("en-US");
	if (!ONBOARDING_USE_SCOPES.includes(useScope)) {
		throw new AccountBootstrapError("invalid_use_scope", "use_scope must be personal, team, or product.");
	}
	const useCase = cleanRequiredText(input.useCase, "use_case", 80);
	const useCaseOther = cleanOptionalText(input.useCaseOther, "use_case_other", 500);
	const heardAbout = cleanOptionalText(input.heardAbout, "heard_about", 80);
	const heardAboutOther = cleanOptionalText(input.heardAboutOther, "heard_about_other", 500);
	const conversationSample = cleanOptionalText(
		input.conversationSample,
		"conversation_sample",
		ONBOARDING_CONVERSATION_SAMPLE_LIMIT,
	);
	if (conversationSample && input.conversationSampleConsent !== true) {
		throw new AccountBootstrapError(
			"conversation_sample_consent_required",
			"Explicit consent is required before a conversation sample can be stored.",
		);
	}
	if (input.conversationSampleConsent !== undefined && typeof input.conversationSampleConsent !== "boolean") {
		throw new AccountBootstrapError(
			"invalid_conversation_sample_consent",
			"conversationSampleConsent must be a boolean.",
		);
	}
	return {
		workspaceName,
		useScope,
		useCase,
		useCaseOther,
		heardAbout,
		heardAboutOther,
		conversationSample,
	};
}

async function assertActiveAccount(env, userId) {
	const row = await env.DB.prepare(
		`SELECT 1 AS ok FROM users u
		  WHERE u.id = ? AND u.status = 'active'
		    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		  LIMIT 1`,
	).bind(userId).first();
	if (!row?.ok) {
		throw new AccountBootstrapError("account_inactive", "This account is no longer active.", 403);
	}
}

async function onboardingRow(env, userId) {
	return env.DB.prepare(
		`SELECT user_id, organization_id, project_id, workspace_name, use_scope,
		        use_case, use_case_other, heard_about, heard_about_other,
		        conversation_sample, completed_at, created_at, updated_at, revision
		   FROM account_onboarding WHERE user_id = ? LIMIT 1`,
	).bind(userId).first();
}

function publicOnboarding(row) {
	return {
		required: !row?.completed_at,
		completed: Boolean(row?.completed_at),
		organization_id: row?.organization_id ?? null,
		project_id: row?.project_id ?? null,
		workspace_name: row?.workspace_name ?? null,
		use_scope: row?.use_scope ?? null,
		use_case: row?.use_case ?? null,
		use_case_other: row?.use_case_other ?? null,
		heard_about: row?.heard_about ?? null,
		heard_about_other: row?.heard_about_other ?? null,
		completed_at: row?.completed_at ?? null,
		revision: Number(row?.revision ?? 0),
	};
}

async function listOrganizationsWithoutBootstrap(env, userId, now) {
	const { results } = await env.DB.prepare(
		`SELECT o.id, o.owner_user_id, o.name, o.description, o.is_default,
		        o.created_at, o.updated_at, m.role, m.access_starts_at, m.access_expires_at,
		        owner.name AS owner_name, owner.email AS owner_email,
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
	return (results ?? []).map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		is_default: Boolean(row.is_default),
		owner_user_id: row.owner_user_id,
		owner: { id: row.owner_user_id, name: row.owner_name ?? null, email: row.owner_email ?? null },
		role: row.role,
		access_starts_at: row.role === "owner" ? null : row.access_starts_at ?? null,
		access_expires_at: row.role === "owner" ? null : row.access_expires_at ?? null,
		access_status: row.role === "owner" ? "permanent" : "active",
		project_count: Number(row.project_count ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
		revision: null,
	}));
}

async function listProjectsWithoutBootstrap(env, userId) {
	const ids = await accessibleProjectIds(env, userId);
	const projects = [];
	for (const projectId of ids ?? []) {
		const project = await getManagedProjectForUser(env, userId, projectId);
		if (project) projects.push({ ...project, shared: project.owner_user_id !== userId });
	}
	return projects;
}

function projectOrganizationId(project) {
	return project?.effective_organization_id ?? project?.organization_id ?? null;
}

function preferredScope({ organizations, projects, onboarding, globalPreference, perOrgPreferences }) {
	const orgById = new Map(organizations.map((org) => [org.id, org]));
	const projectById = new Map(projects.map((project) => [project.id, project]));
	const projectsByOrg = new Map();
	for (const project of projects) {
		const orgId = projectOrganizationId(project);
		if (!orgId || !orgById.has(orgId)) continue;
		if (!projectsByOrg.has(orgId)) projectsByOrg.set(orgId, []);
		projectsByOrg.get(orgId).push(project);
	}
	const validPair = (orgId, projectId) => {
		const project = projectById.get(projectId);
		return Boolean(orgById.has(orgId) && project && projectOrganizationId(project) === orgId);
	};
	if (validPair(globalPreference?.selected_org_id, globalPreference?.selected_project_id)) {
		return {
			organization_id: globalPreference.selected_org_id,
			project_id: globalPreference.selected_project_id,
			source: "saved",
			revision: Number(globalPreference.revision ?? 0),
		};
	}
	const globalOrgId = globalPreference?.selected_org_id;
	const globalOrgLast = perOrgPreferences.get(globalOrgId);
	if (validPair(globalOrgId, globalOrgLast)) {
		return {
			organization_id: globalOrgId,
			project_id: globalOrgLast,
			source: "per_org",
			revision: Number(globalPreference?.revision ?? 0),
		};
	}
	if (validPair(onboarding?.organization_id, onboarding?.project_id)) {
		return {
			organization_id: onboarding.organization_id,
			project_id: onboarding.project_id,
			source: "onboarding",
			revision: Number(globalPreference?.revision ?? 0),
		};
	}
	for (const org of organizations) {
		const candidates = projectsByOrg.get(org.id) ?? [];
		if (!candidates.length) continue;
		const savedProjectId = perOrgPreferences.get(org.id);
		const project = candidates.find((item) => item.id === savedProjectId)
			?? candidates.find((item) => item.is_default)
			?? candidates[0];
		return {
			organization_id: org.id,
			project_id: project.id,
			source: "fallback",
			revision: Number(globalPreference?.revision ?? 0),
		};
	}
	return null;
}

/**
 * Read the selector bootstrap without trusting stored ids. A revoked seat,
 * archived project, expired membership, or cross-organization preference is
 * omitted and replaced in memory only; GET never rewrites user preference.
 */
export async function readBootstrap(env, userId, { now = Date.now() } = {}) {
	cleanId(userId, "user_id");
	const at = normalizedNow(now);
	await assertActiveAccount(env, userId);
	const onboarding = await onboardingRow(env, userId);
	const completed = Boolean(onboarding?.completed_at);
	const [organizations, projects, globalPreference, perOrgRows] = await Promise.all([
		completed ? listOrganizations(env, userId) : listOrganizationsWithoutBootstrap(env, userId, at),
		completed ? listManagedProjects(env, userId) : listProjectsWithoutBootstrap(env, userId),
		env.DB.prepare(
			"SELECT selected_org_id, selected_project_id, updated_at, revision FROM user_scope_preferences WHERE user_id = ? LIMIT 1",
		).bind(userId).first(),
		env.DB.prepare(
			"SELECT org_id, project_id, updated_at FROM user_org_project_preferences WHERE user_id = ?",
		).bind(userId).all(),
	]);
	const perOrgPreferences = new Map((perOrgRows?.results ?? []).map((row) => [row.org_id, row.project_id]));
	return {
		onboarding: publicOnboarding(onboarding),
		organizations,
		projects,
		scope: preferredScope({
			organizations,
			projects,
			onboarding,
			globalPreference,
			perOrgPreferences,
		}),
	};
}

function onboardingStatements(env, userId, input, { proposedOrgId, defaultProjectId, at }) {
	const ownDefaultOrg = `(SELECT id FROM organizations
		WHERE owner_user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1)`;
	const ownDefaultProject = `(SELECT id FROM managed_projects
		WHERE owner_user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1)`;
	const onboardingOpen = `NOT EXISTS (
		SELECT 1 FROM account_onboarding WHERE user_id = ? AND completed_at IS NOT NULL
	)`;
	return [
		managedMutationGuardStatement(env, { accountUserId: userId }),
		env.DB.prepare(
			`INSERT OR IGNORE INTO organizations
			 (id, owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
			 SELECT ?, ?, ?, ?, NULL, 1, 'active', ?, ?
			  WHERE ${onboardingOpen}
			    AND NOT EXISTS (
			      SELECT 1 FROM organizations WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
			    )`,
		).bind(
			proposedOrgId, userId, input.workspaceName, input.workspaceName.toLocaleLowerCase("en-US"),
			at, at, userId, userId,
		),
		// A placeholder created by an older lazy bootstrap becomes the company
		// name. Never overwrite an established/custom organization name.
		env.DB.prepare(
			`UPDATE organizations SET name = ?, name_normalized = ?, updated_at = ?
			  WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
			    AND (id = ? OR name_normalized = 'my organization')
			    AND ${onboardingOpen}`,
		).bind(
			input.workspaceName, input.workspaceName.toLocaleLowerCase("en-US"), at,
			userId, proposedOrgId, userId,
		),
		env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
			 SELECT ?, ${ownDefaultOrg}, ?, 'owner', NULL, NULL, NULL, ?, ?
			  WHERE ${onboardingOpen} AND ${ownDefaultOrg} IS NOT NULL
			 ON CONFLICT(org_id, user_id) DO UPDATE SET
			   role = 'owner', access_starts_at = NULL, access_expires_at = NULL,
			   updated_at = excluded.updated_at
			 WHERE organization_members.role != 'owner'
			    OR organization_members.access_starts_at IS NOT NULL
			    OR organization_members.access_expires_at IS NOT NULL`,
		).bind(
			newId("orgm"), userId, userId, at, at, userId, userId,
		),
		// Legacy defaults used the owner's default organization implicitly. Make
		// the link explicit without changing their memory namespace or id.
		env.DB.prepare(
			`UPDATE managed_projects SET organization_id = ${ownDefaultOrg}, updated_at = ?
			  WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
			    AND organization_id IS NULL AND ${onboardingOpen}`,
		).bind(userId, at, userId, userId),
		// If an old/incomplete account already has a project literally named
		// Default project, promote it rather than colliding with the name trigger.
		env.DB.prepare(
			`UPDATE managed_projects SET is_default = 1, organization_id = ${ownDefaultOrg}, updated_at = ?
			  WHERE id = (
			    SELECT p.id FROM managed_projects p
			     WHERE p.owner_user_id = ? AND p.status = 'active' AND p.name_normalized = 'default project'
			       AND COALESCE(p.organization_id, ${ownDefaultOrg}) = ${ownDefaultOrg}
			     ORDER BY p.created_at ASC LIMIT 1
			  )
			    AND NOT EXISTS (
			      SELECT 1 FROM managed_projects WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
			    )
			    AND ${onboardingOpen}`,
		).bind(userId, at, userId, userId, userId, userId, userId),
		env.DB.prepare(
			`INSERT OR IGNORE INTO managed_projects
			 (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized,
			  description, is_default, status, created_at, updated_at)
			 SELECT ?, ?, ${ownDefaultOrg}, ?, 'Default project', 'default project', NULL, 1, 'active', ?, ?
			  WHERE ${onboardingOpen}
			    AND ${ownDefaultOrg} IS NOT NULL
			    AND NOT EXISTS (
			      SELECT 1 FROM managed_projects WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'
			    )`,
		).bind(defaultProjectId, userId, userId, userId, at, at, userId, userId, userId),
		env.DB.prepare(
			`INSERT INTO project_members
			 (id, project_id, org_id, user_id, role, invited_by_user_id,
			  access_starts_at, access_expires_at, created_at, updated_at)
			 SELECT ?, ${ownDefaultProject}, ${ownDefaultOrg}, ?, 'admin', NULL, NULL, NULL, ?, ?
			  WHERE ${onboardingOpen} AND ${ownDefaultProject} IS NOT NULL AND ${ownDefaultOrg} IS NOT NULL
			 ON CONFLICT(project_id, user_id) DO UPDATE SET
			   org_id = excluded.org_id, role = 'admin', access_starts_at = NULL,
			   access_expires_at = NULL, updated_at = excluded.updated_at
			 WHERE project_members.org_id != excluded.org_id OR project_members.role != 'admin'
			    OR project_members.access_starts_at IS NOT NULL OR project_members.access_expires_at IS NOT NULL`,
		).bind(
			newId("prjm"), userId, userId, userId, at, at, userId, userId, userId,
		),
		env.DB.prepare(
			`INSERT INTO project_memory_spaces
			 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 SELECT p.id, p.memory_owner_user_id, p.memory_owner_user_id, 'active', ?, ?
			   FROM managed_projects p
			  WHERE p.id = ${ownDefaultProject} AND ${onboardingOpen}
			 ON CONFLICT(project_id, memory_user_id) DO UPDATE SET
			   memory_owner_user_id = excluded.memory_owner_user_id,
			   state = CASE WHEN project_memory_spaces.state = 'deleting' THEN 'deleting' ELSE 'active' END,
			   last_seen_at = MAX(project_memory_spaces.last_seen_at, excluded.last_seen_at)`,
		).bind(at, at, userId, userId),
		env.DB.prepare(
			`INSERT INTO account_onboarding
			 (user_id, organization_id, project_id, workspace_name, use_scope, use_case,
			  use_case_other, heard_about, heard_about_other, conversation_sample,
			  completed_at, created_at, updated_at, revision)
			 SELECT ?, ${ownDefaultOrg}, ${ownDefaultProject}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
			  WHERE ${ownDefaultOrg} IS NOT NULL AND ${ownDefaultProject} IS NOT NULL
			 ON CONFLICT(user_id) DO UPDATE SET
			   organization_id = excluded.organization_id,
			   project_id = excluded.project_id,
			   workspace_name = excluded.workspace_name,
			   use_scope = excluded.use_scope,
			   use_case = excluded.use_case,
			   use_case_other = excluded.use_case_other,
			   heard_about = excluded.heard_about,
			   heard_about_other = excluded.heard_about_other,
			   conversation_sample = excluded.conversation_sample,
			   completed_at = excluded.completed_at,
			   updated_at = excluded.updated_at,
			   revision = account_onboarding.revision + 1
			 WHERE account_onboarding.completed_at IS NULL`,
		).bind(
			userId, userId, userId,
			input.workspaceName, input.useScope, input.useCase, input.useCaseOther,
			input.heardAbout, input.heardAboutOther, input.conversationSample,
			at, at, at,
			userId, userId,
		),
		env.DB.prepare(
			`INSERT INTO user_scope_preferences
			 (user_id, selected_org_id, selected_project_id, updated_at, revision)
			 SELECT user_id, organization_id, project_id, ?, 1 FROM account_onboarding
			  WHERE user_id = ? AND completed_at = ?
			 ON CONFLICT(user_id) DO UPDATE SET
			   selected_org_id = excluded.selected_org_id,
			   selected_project_id = excluded.selected_project_id,
			   updated_at = excluded.updated_at,
			   revision = user_scope_preferences.revision + 1`,
		).bind(at, userId, at),
		env.DB.prepare(
			`INSERT INTO user_org_project_preferences
			 (user_id, org_id, project_id, updated_at)
			 SELECT user_id, organization_id, project_id, ? FROM account_onboarding
			  WHERE user_id = ? AND completed_at = ?
			 ON CONFLICT(user_id, org_id) DO UPDATE SET
			   project_id = excluded.project_id, updated_at = excluded.updated_at`,
		).bind(at, userId, at),
	];
}

/** Create the user's own default organization/project and initial scope once. */
export async function completeOnboarding(env, userId, input = {}, {
	auditIntent = null,
	now = Date.now(),
} = {}) {
	cleanId(userId, "user_id");
	const normalized = normalizeOnboardingInput(input);
	await assertActiveAccount(env, userId);
	const existing = await onboardingRow(env, userId);
	if (existing?.completed_at) {
		const noop = { ...await readBootstrap(env, userId, { now }), changed: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, noop) : noop;
	}
	const at = normalizedNow(now);
	const proposedOrgId = newId("org");
	const defaultProjectId = await defaultManagedProjectId(userId);
	const statements = onboardingStatements(env, userId, normalized, { proposedOrgId, defaultProjectId, at });
	const postconditions = [
		auditInvariantStatement(
			env,
			`SELECT 1 FROM account_onboarding a
			  JOIN organizations o ON o.id = a.organization_id AND o.owner_user_id = a.user_id
			   AND o.is_default = 1 AND o.status = 'active'
			  JOIN organization_members om ON om.org_id = o.id AND om.user_id = a.user_id AND om.role = 'owner'
			  JOIN managed_projects p ON p.id = a.project_id AND p.owner_user_id = a.user_id
			   AND p.organization_id = o.id AND p.is_default = 1 AND p.status = 'active'
			  JOIN project_members pm ON pm.project_id = p.id AND pm.org_id = o.id
			   AND pm.user_id = a.user_id AND pm.role = 'admin'
			  JOIN project_memory_spaces ms ON ms.project_id = p.id
			   AND ms.memory_owner_user_id = p.memory_owner_user_id
			   AND ms.memory_user_id = p.memory_owner_user_id
			 WHERE a.user_id = ? AND a.completed_at IS NOT NULL`,
			[userId],
		),
		auditInvariantStatement(
			env,
			`SELECT 1 FROM user_scope_preferences s
			  JOIN account_onboarding a ON a.user_id = s.user_id
			 WHERE s.user_id = ? AND s.selected_org_id = a.organization_id
			   AND s.selected_project_id = a.project_id`,
			[userId],
		),
	];
	try {
		if (auditIntent) {
			await commitAuditedBatch(env, auditIntent, statements, {
				postconditions,
				commitDetails: { targetType: "account", targetId: userId },
			});
		} else {
			await env.DB.batch([...statements, ...postconditions]);
		}
	} catch (error) {
		// Two first-run tabs may race. The winner is the authoritative result;
		// never translate a harmless retry into a second workspace.
		const winner = await onboardingRow(env, userId);
		// An audited attempt owns a pending intent. It cannot borrow another
		// request's winning state and report that its own intent committed.
		if (auditIntent) throw error;
		if (!winner?.completed_at) {
			if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
				throw new AccountBootstrapError(
					"onboarding_commit_rejected",
					"Your account changed while onboarding. Reload and try again.",
					409,
				);
			}
			throw error;
		}
	}
	const result = { ...await readBootstrap(env, userId, { now: at }), changed: true };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

function effectiveOrganizationPredicate() {
	return `COALESCE(p.organization_id, (
		SELECT d.id FROM organizations d
		 WHERE d.owner_user_id = p.owner_user_id AND d.is_default = 1 AND d.status = 'active' LIMIT 1
	))`;
}

/**
 * Persist a selector choice only after fresh server-side authorization. The
 * project is authoritative; the organization id must match its effective
 * governance boundary and can never retarget storage.
 */
export async function saveScope(env, userId, selection = {}, {
	auditIntent = null,
	now = Date.now(),
	expectedRevision = null,
} = {}) {
	cleanId(userId, "user_id");
	if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
		throw new AccountBootstrapError("invalid_scope", "Scope must be a JSON object.");
	}
	const unknown = Object.keys(selection).filter((key) => !["organizationId", "projectId"].includes(key));
	if (unknown.length) throw new AccountBootstrapError("unknown_scope_field", `Unknown scope field: ${unknown[0]}.`);
	const organizationId = cleanId(selection.organizationId, "organization_id");
	const projectId = cleanId(selection.projectId, "project_id");
	const at = normalizedNow(now);
	if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
		throw new AccountBootstrapError("invalid_scope_revision", "expectedRevision must be a positive integer.");
	}
	await assertActiveAccount(env, userId);
	const onboarding = await onboardingRow(env, userId);
	if (!onboarding?.completed_at) {
		throw new AccountBootstrapError("onboarding_required", "Finish account setup before changing scope.", 409);
	}
	const [project, organizationAccess, currentPreference] = await Promise.all([
		getManagedProjectForUser(env, userId, projectId),
		env.DB.prepare(
			`SELECT 1 AS ok FROM organizations o
			  LEFT JOIN organization_members om ON om.org_id = o.id AND om.user_id = ?
			 WHERE o.id = ? AND o.status = 'active'
			   AND (o.owner_user_id = ? OR (
			     om.user_id IS NOT NULL
			     AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
			     AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
			   )) LIMIT 1`,
		).bind(userId, organizationId, userId, at, at).first(),
		env.DB.prepare(
			"SELECT selected_org_id, selected_project_id, revision FROM user_scope_preferences WHERE user_id = ? LIMIT 1",
		).bind(userId).first(),
	]);
	if (!project || !organizationAccess?.ok) {
		throw new AccountBootstrapError("scope_forbidden", "You no longer have access to that scope.", 403);
	}
	if (projectOrganizationId(project) !== organizationId) {
		throw new AccountBootstrapError(
			"scope_mismatch",
			"That project does not belong to the selected organization.",
			409,
		);
	}
	if (expectedRevision !== null && Number(currentPreference?.revision ?? 0) !== expectedRevision) {
		throw new AccountBootstrapError("scope_conflict", "The selected scope changed in another session.", 412);
	}
	const statements = [
		managedMutationGuardStatement(env, { accountUserId: userId, projectId, access: "read" }),
		env.DB.prepare(
			`INSERT INTO user_scope_preferences
			 (user_id, selected_org_id, selected_project_id, updated_at, revision)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(user_id) DO UPDATE SET
			   selected_org_id = excluded.selected_org_id,
			   selected_project_id = excluded.selected_project_id,
			   updated_at = excluded.updated_at,
			   revision = user_scope_preferences.revision + 1`,
		).bind(userId, organizationId, projectId, at),
		env.DB.prepare(
			`INSERT INTO user_org_project_preferences (user_id, org_id, project_id, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, org_id) DO UPDATE SET
			   project_id = excluded.project_id, updated_at = excluded.updated_at`,
		).bind(userId, organizationId, projectId, at),
	];
	const preconditions = expectedRevision === null ? [] : [
		auditInvariantStatement(
			env,
			"SELECT 1 FROM user_scope_preferences WHERE user_id = ? AND revision = ?",
			[userId, expectedRevision],
		),
	];
	const effectiveOrganization = effectiveOrganizationPredicate();
	const postconditions = [
		auditInvariantStatement(
			env,
			`SELECT 1 FROM user_scope_preferences s
			  JOIN managed_projects p ON p.id = s.selected_project_id AND p.status = 'active'
			 WHERE s.user_id = ? AND s.selected_org_id = ? AND s.selected_project_id = ?
			   AND ${effectiveOrganization} = ?`,
			[userId, organizationId, projectId, organizationId],
		),
		auditInvariantStatement(
			env,
			`SELECT 1 FROM user_org_project_preferences
			 WHERE user_id = ? AND org_id = ? AND project_id = ?`,
			[userId, organizationId, projectId],
		),
	];
	try {
		if (auditIntent) {
			await commitAuditedBatch(env, auditIntent, statements, {
				preconditions,
				postconditions,
				commitDetails: { orgId: organizationId, projectId, targetType: "scope", targetId: userId },
			});
		} else {
			await env.DB.batch([...preconditions, ...statements, ...postconditions]);
		}
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await env.DB.prepare(
				"SELECT revision FROM user_scope_preferences WHERE user_id = ? LIMIT 1",
			).bind(userId).first();
			if (expectedRevision !== null && Number(latest?.revision ?? 0) !== expectedRevision) {
				throw new AccountBootstrapError("scope_conflict", "The selected scope changed in another session.", 412);
			}
			throw new AccountBootstrapError("scope_forbidden", "You no longer have access to that scope.", 403);
		}
		throw error;
	}
	const result = { ...await readBootstrap(env, userId, { now: at }), changed: true };
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}
