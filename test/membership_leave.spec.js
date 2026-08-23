/**
 * Self-service membership leave.
 *
 * Leaving is the mirror image of removal with one deliberate asymmetry: no
 * If-Match revision, because a seat can only be left once by the one person
 * sitting in it. Everything else must match the removal contract exactly —
 * atomic seat + credential quarantine, honest repeats, audit through the
 * intent machinery — and these tests pin that the two doors cannot drift.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import {
	ensureDefaultOrganization,
	leaveOrganization,
	leaveProject,
	setProjectRole,
} from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";

async function makeUser(email) {
	const id = newId("usr");
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', 'user')`,
	).bind(id, email, email.toLowerCase(), email.split("@")[0], at, at).run();
	return { id, email };
}

async function makeProject(ownerUserId, { orgId = null, name = `Project ${newId("x")}` } = {}) {
	const id = newId("proj");
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO managed_projects
		 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description, is_default, status,
		  organization_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, NULL, 0, 'active', ?, ?, ?)`,
	).bind(id, ownerUserId, `mem_${id}`, name, name.toLowerCase(), orgId, at, at).run();
	return { id, owner_user_id: ownerUserId, organization_id: orgId };
}

async function addOrgMember(orgId, userId, role = "member") {
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(newId("orgm"), orgId, userId, role, at, at).run();
}

async function seedProjectToken(userId, projectId) {
	const id = newId("tok");
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO connection_tokens
		 (id, user_id, token_hash, label, type, scopes_json, status, created_at, project_id)
		 VALUES (?, ?, ?, 'leave seed', 'api', '["memory:read"]', 'active', ?, ?)`,
	).bind(id, userId, `hash_${newId("x")}`, at, projectId).run();
	return id;
}

async function seedGrant(userId, projectId) {
	const grantId = newId("grant");
	const tokenId = newId("otok");
	const at = Date.now();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO oauth_grants (id, user_id, client_id, project_id, scopes_json, created_at)
			 VALUES (?, ?, 'client_leave_test', ?, '["memory:read"]', ?)`,
		).bind(grantId, userId, projectId, at),
		env.DB.prepare(
			`INSERT INTO oauth_tokens (id, grant_id, user_id, client_id, kind, token_hash, scopes_json, created_at, expires_at)
			 VALUES (?, ?, ?, 'client_leave_test', 'refresh', ?, '["memory:read"]', ?, ?)`,
		).bind(tokenId, grantId, userId, `hash_${newId("x")}`, at, at + 86_400_000),
	]);
	return { grantId, tokenId };
}

async function seatCount(projectId, userId) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND user_id = ?",
	).bind(projectId, userId).first();
	return Number(row.n);
}

async function orgSeatCount(orgId, userId) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM organization_members WHERE org_id = ? AND user_id = ?",
	).bind(orgId, userId).first();
	return Number(row.n);
}

describe("leaveProject", () => {
	it("removes only the caller's own seat and quarantines only their credentials for that project", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const member = await makeUser(`member-${newId("x")}@example.com`);
		const bystander = await makeUser(`bystander-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		const otherProject = await makeProject(owner.id, { orgId: org.id });
		await addOrgMember(org.id, member.id);
		await addOrgMember(org.id, bystander.id);
		await setProjectRole(env, project.id, org.id, member.id, "member");
		await setProjectRole(env, project.id, org.id, bystander.id, "viewer");
		await setProjectRole(env, otherProject.id, org.id, member.id, "member");
		const tokenHere = await seedProjectToken(member.id, project.id);
		const tokenElsewhere = await seedProjectToken(member.id, otherProject.id);
		const { grantId, tokenId } = await seedGrant(member.id, project.id);

		const left = await leaveProject(env, { userId: member.id, projectId: project.id });
		expect(left).toMatchObject({ ok: true, left: true, already_left: false, previous_role: "member" });

		// Exactly one seat gone: theirs, in this project. The org seat and every
		// other person's seat are none of leaveProject's business.
		expect(await seatCount(project.id, member.id)).toBe(0);
		expect(await seatCount(project.id, bystander.id)).toBe(1);
		expect(await seatCount(otherProject.id, member.id)).toBe(1);
		expect(await orgSeatCount(org.id, member.id)).toBe(1);

		expect(await env.DB.prepare("SELECT status, revoked_at FROM connection_tokens WHERE id = ?").bind(tokenHere).first())
			.toMatchObject({ status: "revoked" });
		expect(await env.DB.prepare("SELECT status, revoked_at FROM connection_tokens WHERE id = ?").bind(tokenElsewhere).first())
			.toMatchObject({ status: "active", revoked_at: null });
		expect(await env.DB.prepare("SELECT revoked_reason FROM oauth_grants WHERE id = ?").bind(grantId).first())
			.toMatchObject({ revoked_reason: "project_membership_left" });
		expect((await env.DB.prepare("SELECT revoked_at FROM oauth_tokens WHERE id = ?").bind(tokenId).first()).revoked_at)
			.not.toBeNull();

		expect(await leaveProject(env, { userId: member.id, projectId: project.id }))
			.toMatchObject({ ok: true, left: false, already_left: true });
	});

	it("refuses implicit-only access instead of pretending an owner or org admin left", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const orgAdmin = await makeUser(`admin-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await addOrgMember(org.id, orgAdmin.id, "admin");

		await expect(leaveProject(env, { userId: orgAdmin.id, projectId: project.id }))
			.rejects.toMatchObject({ code: "not_a_member", status: 409 });
		await expect(leaveProject(env, { userId: owner.id, projectId: project.id }))
			.rejects.toMatchObject({ code: "not_a_member", status: 409 });
		// Nothing was quietly changed on either refusal.
		expect(await orgSeatCount(org.id, orgAdmin.id)).toBe(1);
		expect(await orgSeatCount(org.id, owner.id)).toBe(1);
	});

	it("converges concurrent leaves to exactly one departure", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const member = await makeUser(`member-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await addOrgMember(org.id, member.id);
		await setProjectRole(env, project.id, org.id, member.id, "member");

		const results = await Promise.all([
			leaveProject(env, { userId: member.id, projectId: project.id }),
			leaveProject(env, { userId: member.id, projectId: project.id }),
		]);
		expect(results.filter((result) => result.left)).toHaveLength(1);
		expect(results.filter((result) => result.already_left)).toHaveLength(1);
		expect(await seatCount(project.id, member.id)).toBe(0);
	});
});

describe("leaveOrganization", () => {
	it("removes the org seat and every project seat in that org, quarantining credentials, without crossing org lines", async () => {
		const ownerA = await makeUser(`owner-a-${newId("x")}@example.com`);
		const ownerB = await makeUser(`owner-b-${newId("x")}@example.com`);
		const member = await makeUser(`member-${newId("x")}@example.com`);
		const orgA = await ensureDefaultOrganization(env, ownerA.id);
		const orgB = await ensureDefaultOrganization(env, ownerB.id);
		const projectA1 = await makeProject(ownerA.id, { orgId: orgA.id });
		const projectA2 = await makeProject(ownerA.id, { orgId: orgA.id });
		const projectB = await makeProject(ownerB.id, { orgId: orgB.id });
		await addOrgMember(orgA.id, member.id);
		await addOrgMember(orgB.id, member.id);
		await setProjectRole(env, projectA1.id, orgA.id, member.id, "member");
		await setProjectRole(env, projectA2.id, orgA.id, member.id, "viewer");
		await setProjectRole(env, projectB.id, orgB.id, member.id, "member");
		const tokenA = await seedProjectToken(member.id, projectA1.id);
		const tokenB = await seedProjectToken(member.id, projectB.id);
		const { grantId } = await seedGrant(member.id, projectA1.id);

		const left = await leaveOrganization(env, { userId: member.id, orgId: orgA.id });
		expect(left).toMatchObject({ ok: true, left: true, already_left: false, previous_role: "member" });

		expect(await orgSeatCount(orgA.id, member.id)).toBe(0);
		expect(await seatCount(projectA1.id, member.id)).toBe(0);
		expect(await seatCount(projectA2.id, member.id)).toBe(0);
		// The other organization is untouched: leaving is per-org, never global.
		expect(await orgSeatCount(orgB.id, member.id)).toBe(1);
		expect(await seatCount(projectB.id, member.id)).toBe(1);

		expect(await env.DB.prepare("SELECT status FROM connection_tokens WHERE id = ?").bind(tokenA).first())
			.toMatchObject({ status: "revoked" });
		expect(await env.DB.prepare("SELECT status, revoked_at FROM connection_tokens WHERE id = ?").bind(tokenB).first())
			.toMatchObject({ status: "active", revoked_at: null });
		expect(await env.DB.prepare("SELECT revoked_reason FROM oauth_grants WHERE id = ?").bind(grantId).first())
			.toMatchObject({ revoked_reason: "org_membership_left" });

		// Leaving quarantines credentials; it never destroys org or project data.
		expect(await env.DB.prepare("SELECT status FROM managed_projects WHERE id = ?").bind(projectA1.id).first())
			.toMatchObject({ status: "active" });
		expect(await env.DB.prepare("SELECT status FROM organizations WHERE id = ?").bind(orgA.id).first())
			.toMatchObject({ status: "active" });

		expect(await leaveOrganization(env, { userId: member.id, orgId: orgA.id }))
			.toMatchObject({ ok: true, left: false, already_left: true });
	});

	it("never lets the owner leave, and changes nothing when it refuses", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		await expect(leaveOrganization(env, { userId: owner.id, orgId: org.id }))
			.rejects.toMatchObject({ code: "owner_immutable", status: 409 });
		expect(await orgSeatCount(org.id, owner.id)).toBe(1);
		expect(await env.DB.prepare("SELECT status FROM organizations WHERE id = ?").bind(org.id).first())
			.toMatchObject({ status: "active" });
	});
});

/* ---------------------------- HTTP contract ------------------------------ */

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function json(method, body, cookie, projectId) {
	return {
		method,
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
			...(projectId ? { "x-itsuki-project": projectId } : {}),
		},
		body: JSON.stringify(body),
	};
}

async function signup(label) {
	const email = `${label}-${crypto.randomUUID()}@example.com`;
	const response = await request("/auth/signup", json("POST", {
		email,
		password: "correct-horse",
		name: label,
		acceptTerms: true,
	}));
	expect(response.status).toBe(201);
	const body = await response.json();
	return {
		user: body.user,
		email,
		cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
	};
}

async function joinedProject(role = "viewer") {
	const owner = await signup(`leave-owner-${newId("x")}`);
	const collaborator = await signup(`leave-collaborator-${newId("x")}`);
	const createdProject = await request("/auth/projects", json("POST", {
		name: `Leave ${newId("x")}`,
	}, owner.cookie));
	expect(createdProject.status).toBe(201);
	const { project } = await createdProject.json();
	const org = await ensureDefaultOrganization(env, owner.user.id);
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
	).bind(newId("orgm"), org.id, collaborator.user.id, owner.user.id, at, at).run();
	await setProjectRole(env, project.id, org.id, collaborator.user.id, role, owner.user.id);
	return { owner, collaborator, project, org };
}

describe("HTTP leave doors", () => {
	it("refuses the unauthenticated before ever parsing a body", async () => {
		for (const path of ["/v1/settings/members/leave", "/v1/settings/org-members/leave"]) {
			const response = await request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				// Deliberately not JSON: a 400 here would prove the body was read
				// before the caller was identified.
				body: "not json",
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: "unauthorized" });
		}
	});

	it("lets a viewer leave — no capability gate — and hands back an authorized scope in the same response", async () => {
		const { collaborator, project, org } = await joinedProject("viewer");

		const response = await request("/v1/settings/members/leave", json("POST", {}, collaborator.cookie, project.id));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ ok: true, left: true, already_left: false });
		// The fresh scope must already exclude the project that was just left,
		// and name a fallback the caller is still authorized for.
		expect(body.projects.map((row) => row.id)).not.toContain(project.id);
		expect(body.scope.project_id).toBeTruthy();
		expect(body.scope.project_id).not.toBe(project.id);
		expect(body.projects.map((row) => row.id)).toContain(body.scope.project_id);
		expect(body.organizations.length).toBeGreaterThan(0);

		expect(await seatCount(project.id, collaborator.user.id)).toBe(0);
		const event = await env.DB.prepare(
			`SELECT actor_user_id, org_id, outcome, metadata_json FROM audit_events
			  WHERE project_id = ? AND action = 'project.member.left' AND target_id = ?`,
		).bind(project.id, collaborator.user.id).first();
		expect(event).toMatchObject({ actor_user_id: collaborator.user.id, org_id: org.id, outcome: "ok" });
		expect(JSON.parse(event.metadata_json)).toEqual({ project_role: { from: "viewer", to: null } });

		// House behavior: authorization is re-derived per request, so leaving
		// quarantines credentials but never kills the session itself.
		const me = await request("/auth/me", { headers: { cookie: collaborator.cookie } });
		expect((await me.json()).authenticated).toBe(true);
	});

	it("leaves the organization through the org door and refuses the owner honestly", async () => {
		const { owner, collaborator, project, org } = await joinedProject("viewer");

		const response = await request("/v1/settings/org-members/leave", json("POST", {
			orgId: org.id,
		}, collaborator.cookie, project.id));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ ok: true, left: true, already_left: false });
		expect(body.projects.map((row) => row.id)).not.toContain(project.id);

		expect(await orgSeatCount(org.id, collaborator.user.id)).toBe(0);
		expect(await seatCount(project.id, collaborator.user.id)).toBe(0);
		const event = await env.DB.prepare(
			`SELECT actor_user_id, project_id, outcome, metadata_json FROM audit_events
			  WHERE org_id = ? AND action = 'org.member.left' AND target_id = ?`,
		).bind(org.id, collaborator.user.id).first();
		expect(event).toMatchObject({ actor_user_id: collaborator.user.id, project_id: null, outcome: "ok" });
		expect(JSON.parse(event.metadata_json)).toEqual({ org_role: { from: "member", to: null } });

		const refused = await request("/v1/settings/org-members/leave", json("POST", {}, owner.cookie, project.id));
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: "owner_immutable" });
		expect(await orgSeatCount(org.id, owner.user.id)).toBe(1);
	});

	it("rate-limits leave by the caller, before any mutation", async () => {
		const { collaborator, project } = await joinedProject("viewer");
		const previousLimiter = env.SAVE_LIMITER;
		const seen = [];
		env.SAVE_LIMITER = {
			async limit({ key }) {
				seen.push(key);
				return { success: false };
			},
		};
		try {
			const limited = await request("/v1/settings/members/leave", json("POST", {}, collaborator.cookie, project.id));
			expect(limited.status).toBe(429);
		} finally {
			env.SAVE_LIMITER = previousLimiter;
		}
		expect(seen).toEqual([`membership-leave:${collaborator.user.id}`]);
		// 429 means refused, and refused means the seat is still there.
		expect(await seatCount(project.id, collaborator.user.id)).toBe(1);
	});
});
