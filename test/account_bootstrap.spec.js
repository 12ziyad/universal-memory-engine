import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	AccountBootstrapError,
	ONBOARDING_CONVERSATION_SAMPLE_LIMIT,
	completeOnboarding,
	readBootstrap,
	saveScope,
} from "../src/lib/account_bootstrap.js";
import { createOrganization, ensureDefaultOrganization } from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";
import { createManagedProject, ensureDefaultManagedProject } from "../src/lib/managed_projects.js";

async function makeUser(label) {
	const id = newId("usr");
	const email = `${label}-${id}@example.com`;
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', 'user')`,
	).bind(id, email, email, label, at, at).run();
	return id;
}

const details = (workspaceName = "Acme") => ({
	workspaceName,
	useScope: "product",
	useCase: "AI agent memory",
	useCaseOther: "Customer support agents",
	heardAbout: "Codex",
	heardAboutOther: null,
	conversationSample: "A short, deliberately consented sample.",
	conversationSampleConsent: true,
});

describe("account onboarding and durable scope", () => {
	it("creates one owned organization, default project, root space, onboarding, and scope atomically", async () => {
		const userId = await makeUser("founder");
		const result = await completeOnboarding(env, userId, details("Itsuki"), { now: 1_800_000_000_000 });

		expect(result.changed).toBe(true);
		expect(result.onboarding).toMatchObject({
			completed: true,
			required: false,
			workspace_name: "Itsuki",
			use_scope: "product",
			use_case: "AI agent memory",
		});
		expect(result.organizations).toHaveLength(1);
		expect(result.organizations[0]).toMatchObject({ name: "Itsuki", owner_user_id: userId, role: "owner" });
		expect(result.projects).toHaveLength(1);
		expect(result.projects[0]).toMatchObject({ name: "Default project", owner_user_id: userId });
		expect(result.scope).toMatchObject({
			organization_id: result.organizations[0].id,
			project_id: result.projects[0].id,
		});

		const rows = await env.DB.prepare(
			`SELECT
			 (SELECT COUNT(*) FROM organization_members WHERE user_id = ? AND role = 'owner') AS org_members,
			 (SELECT COUNT(*) FROM project_members WHERE user_id = ? AND role = 'admin') AS project_members,
			 (SELECT COUNT(*) FROM project_memory_spaces WHERE project_id = ? AND memory_user_id = ?) AS spaces,
			 (SELECT COUNT(*) FROM user_org_project_preferences WHERE user_id = ?) AS per_org`,
		).bind(userId, userId, result.projects[0].id, userId, userId).first();
		expect(rows).toEqual({ org_members: 1, project_members: 1, spaces: 1, per_org: 1 });
	});

	it("is idempotent and never overwrites the first completed profile", async () => {
		const userId = await makeUser("retry");
		const first = await completeOnboarding(env, userId, details("First workspace"));
		const second = await completeOnboarding(env, userId, details("Wrong retry"));
		expect(second.changed).toBe(false);
		expect(second.onboarding.workspace_name).toBe("First workspace");
		expect(second.scope.project_id).toBe(first.scope.project_id);
		const counts = await env.DB.prepare(
			`SELECT
			 (SELECT COUNT(*) FROM organizations WHERE owner_user_id = ?) AS orgs,
			 (SELECT COUNT(*) FROM managed_projects WHERE owner_user_id = ?) AS projects`,
		).bind(userId, userId).first();
		expect(counts).toEqual({ orgs: 1, projects: 1 });
	});

	it("requires explicit consent for an optional conversation sample", async () => {
		const userId = await makeUser("privacy");
		await expect(completeOnboarding(env, userId, {
			...details(),
			conversationSampleConsent: false,
		})).rejects.toMatchObject({
			name: "AccountBootstrapError",
			code: "conversation_sample_consent_required",
		});
		expect(await readBootstrap(env, userId)).toMatchObject({ onboarding: { required: true } });
	});

	it("rejects an oversized conversation sample before creating any workspace rows", async () => {
		const userId = await makeUser("oversize");
		await expect(completeOnboarding(env, userId, {
			...details(),
			conversationSample: "x".repeat(ONBOARDING_CONVERSATION_SAMPLE_LIMIT + 1),
		})).rejects.toMatchObject({ code: "invalid_conversation_sample", status: 400 });
		const counts = await env.DB.prepare(
			`SELECT
			 (SELECT COUNT(*) FROM organizations WHERE owner_user_id = ?) AS orgs,
			 (SELECT COUNT(*) FROM managed_projects WHERE owner_user_id = ?) AS projects,
			 (SELECT COUNT(*) FROM account_onboarding WHERE user_id = ?) AS onboarding`,
		).bind(userId, userId, userId).first();
		expect(counts).toEqual({ orgs: 0, projects: 0, onboarding: 0 });
	});

	it("adopts an existing legacy default workspace without changing its ids or memory namespace", async () => {
		const userId = await makeUser("legacy");
		const legacyOrg = await ensureDefaultOrganization(env, userId);
		const legacyProject = await ensureDefaultManagedProject(env, userId);
		expect(legacyOrg.name).toBe("My organization");

		const completed = await completeOnboarding(env, userId, details("Renamed company"));
		expect(completed.scope).toMatchObject({
			organization_id: legacyOrg.id,
			project_id: legacyProject.id,
		});
		expect(completed.organizations.find((org) => org.id === legacyOrg.id)?.name).toBe("Renamed company");
		const row = await env.DB.prepare(
			"SELECT organization_id, memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(legacyProject.id).first();
		expect(row).toEqual({ organization_id: legacyOrg.id, memory_owner_user_id: userId });
	});

	it("keeps an invited collaborator's shared scope visible before creating their own workspace", async () => {
		const ownerId = await makeUser("owner");
		const collaboratorId = await makeUser("collaborator");
		const owner = await completeOnboarding(env, ownerId, details("Owner org"));
		const orgId = owner.scope.organization_id;
		const projectId = owner.scope.project_id;
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), orgId, collaboratorId, ownerId, at, at),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
			).bind(newId("prjm"), projectId, orgId, collaboratorId, ownerId, at, at),
		]);

		const before = await readBootstrap(env, collaboratorId);
		expect(before.onboarding.required).toBe(true);
		expect(before.organizations.map((item) => item.id)).toContain(orgId);
		expect(before.projects.map((item) => item.id)).toContain(projectId);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?")
			.bind(collaboratorId).first("n")).toBe(0);

		const after = await completeOnboarding(env, collaboratorId, details("Collaborator org"));
		expect(after.organizations).toHaveLength(2);
		expect(after.projects).toHaveLength(2);
		expect(after.scope.organization_id).not.toBe(orgId);
	});

	it("authorizes project/org pairs and remembers the last project per organization", async () => {
		const userId = await makeUser("scope");
		const first = await completeOnboarding(env, userId, details("Primary"));
		const secondOrg = await createOrganization(env, userId, { name: "Secondary" });
		const secondProject = secondOrg.project;

		const selectedSecond = await saveScope(env, userId, {
			organizationId: secondOrg.organization.id,
			projectId: secondProject.id,
		}, { expectedRevision: first.scope.revision });
		expect(selectedSecond.scope).toMatchObject({
			organization_id: secondOrg.organization.id,
			project_id: secondProject.id,
		});

		await expect(saveScope(env, userId, {
			organizationId: first.scope.organization_id,
			projectId: secondProject.id,
		})).rejects.toMatchObject({ code: "scope_mismatch", status: 409 });

		await saveScope(env, userId, {
			organizationId: first.scope.organization_id,
			projectId: first.scope.project_id,
		});
		const perOrg = await env.DB.prepare(
			"SELECT project_id FROM user_org_project_preferences WHERE user_id = ? AND org_id = ?",
		).bind(userId, secondOrg.organization.id).first("project_id");
		expect(perOrg).toBe(secondProject.id);
	});

	it("falls back safely from an archived saved project and rejects stale selector revisions", async () => {
		const userId = await makeUser("stale");
		const initial = await completeOnboarding(env, userId, details("Scope safety"));
		const extra = await createManagedProject(env, userId, { name: "Temporary" }, {
			organizationId: initial.scope.organization_id,
		});
		const changed = await saveScope(env, userId, {
			organizationId: initial.scope.organization_id,
			projectId: extra.id,
		}, { expectedRevision: initial.scope.revision });
		expect(changed.scope.project_id).toBe(extra.id);

		await expect(saveScope(env, userId, {
			organizationId: initial.scope.organization_id,
			projectId: initial.scope.project_id,
		}, { expectedRevision: initial.scope.revision })).rejects.toMatchObject({
			code: "scope_conflict",
			status: 412,
		});

		await env.DB.prepare(
			"UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?",
		).bind(Date.now(), Date.now(), extra.id).run();
		const fallback = await readBootstrap(env, userId);
		expect(fallback.scope).toMatchObject({
			organization_id: initial.scope.organization_id,
			project_id: initial.scope.project_id,
		});
		expect(fallback.projects.map((project) => project.id)).not.toContain(extra.id);
	});
});
