/**
 * Stage 3 — organizations, membership and the capability matrix.
 *
 * The matrix is walked exhaustively rather than spot-checked. A capability
 * table is exactly the kind of thing that rots: someone adds a role, or widens
 * one rule "just for now", and nothing fails. Enumerating every
 * capability × role combination means a widened permission has to be written
 * down here too, deliberately.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	CAPABILITIES,
	ORG_ROLES,
	PROJECT_ROLES,
	assertDelegationAuthority,
	can,
	capabilitiesFor,
	delegationGuardStatement,
	ensureDefaultOrganization,
	listOrganizationMembers,
	listProjectMembers,
	removeOrganizationMember,
	removeProjectMember,
	resolveMembership,
	setOrganizationRole,
	setProjectRole,
	updateProjectRole,
} from "../src/lib/organizations.js";
import { acceptInvitation, createInvitation, describeInvitation, resendInvitation, revokeInvitation } from "../src/lib/invitations.js";
import { auditDiff, emailDomain, listAuditEvents, writeAudit } from "../src/lib/audit.js";
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

async function makeProject(ownerUserId, { orgId = null, name = "Test project" } = {}) {
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

describe("the capability matrix", () => {
	it("grants nothing at all to somebody with no roles", () => {
		for (const capability of Object.keys(CAPABILITIES)) {
			expect(can(capability, { orgRole: null, projectRole: null }), capability).toBe(false);
		}
		expect(capabilitiesFor({})).toEqual([]);
	});

	it("refuses a capability that does not exist", () => {
		expect(can("project.launch_missiles", { orgRole: "owner" })).toBe(false);
		expect(can("", { orgRole: "owner" })).toBe(false);
		expect(can(undefined, { orgRole: "owner" })).toBe(false);
	});

	it("never lets a viewer write, delete or administer", () => {
		const viewer = capabilitiesFor({ projectRole: "viewer" });
		for (const capability of viewer) {
			expect(capability, `viewer must not hold ${capability}`).toMatch(/\.view$|\.read$/);
		}
		expect(viewer).toContain("project.memory.read");
		expect(can("project.memory.write", { projectRole: "viewer" })).toBe(false);
		expect(can("project.memory.delete", { projectRole: "viewer" })).toBe(false);
		expect(can("project.keys.manage", { projectRole: "viewer" })).toBe(false);
		expect(can("project.rules.edit", { projectRole: "viewer" })).toBe(false);
		expect(can("project.members.manage", { projectRole: "viewer" })).toBe(false);
	});

	it("keeps a plain member out of policy and membership", () => {
		expect(can("project.memory.write", { projectRole: "member" })).toBe(true);
		expect(can("project.chooser.use", { projectRole: "member" })).toBe(true);
		expect(can("project.keys.manage", { projectRole: "member" })).toBe(true);
		expect(can("project.rules.edit", { projectRole: "member" })).toBe(false);
		expect(can("project.categories.edit", { projectRole: "member" })).toBe(false);
		expect(can("project.retention.view", { projectRole: "member" })).toBe(false);
		expect(can("project.retention.manage", { projectRole: "member" })).toBe(false);
		expect(can("project.members.manage", { projectRole: "member" })).toBe(false);
		expect(can("project.memory.delete", { projectRole: "member" })).toBe(false);
		expect(can("project.audit.view", { projectRole: "member" })).toBe(false);
	});

	it("keeps retention inventory and destructive policy changes admin-only", () => {
		for (const capability of ["project.retention.view", "project.retention.manage"]) {
			expect(can(capability, { orgRole: "owner" }), capability).toBe(true);
			expect(can(capability, { orgRole: "admin" }), capability).toBe(true);
			expect(can(capability, { projectRole: "admin" }), capability).toBe(true);
			expect(can(capability, { projectRole: "member" }), capability).toBe(false);
			expect(can(capability, { projectRole: "viewer" }), capability).toBe(false);
		}
	});

	it("keeps paid chooser use out of the viewer role", () => {
		expect(can("project.memory.read", { projectRole: "viewer" })).toBe(true);
		expect(can("project.chooser.use", { projectRole: "viewer" })).toBe(false);
		expect(can("project.chooser.use", { projectRole: "admin" })).toBe(true);
		expect(can("project.chooser.use", { orgRole: "admin" })).toBe(true);
	});

	/**
	 * Destroying or transferring a project is owner-only by design. A project
	 * admin can empty a project's memory, but removing the project itself is
	 * not something a delegated role should ever reach.
	 */
	it("reserves transfer and delete for the organization owner", () => {
		for (const role of PROJECT_ROLES) {
			expect(can("project.delete", { projectRole: role }), role).toBe(false);
			expect(can("project.transfer", { projectRole: role }), role).toBe(false);
		}
		expect(can("project.delete", { orgRole: "admin" })).toBe(false);
		expect(can("project.transfer", { orgRole: "admin" })).toBe(false);
		expect(can("project.delete", { orgRole: "owner" })).toBe(true);
		expect(can("project.transfer", { orgRole: "owner" })).toBe(true);
		expect(can("org.delete", { orgRole: "admin" })).toBe(false);
		expect(can("org.delete", { orgRole: "owner" })).toBe(true);
	});

	it("gives an org member no project access without an explicit project role", () => {
		expect(can("project.view", { orgRole: "member" })).toBe(false);
		expect(can("project.memory.read", { orgRole: "member" })).toBe(false);
		expect(can("org.view", { orgRole: "member" })).toBe(true);
		expect(can("org.members.manage", { orgRole: "member" })).toBe(false);
	});

	it("declares every rule against a known role, with no empty grants by accident", () => {
		for (const [capability, rule] of Object.entries(CAPABILITIES)) {
			for (const role of rule.org ?? []) expect(ORG_ROLES, capability).toContain(role);
			for (const role of rule.project ?? []) expect(PROJECT_ROLES, capability).toContain(role);
			const total = (rule.org ?? []).length + (rule.project ?? []).length;
			// One capability is deliberately ungrantable; everything else must be
			// reachable by somebody or it is dead code pretending to be a control.
			if (capability !== "org.members.remove_owner") {
				expect(total, `${capability} is granted to nobody`).toBeGreaterThan(0);
			}
		}
	});
});

describe("membership resolution", () => {
	it("treats a pre-organization project's owner as its owner", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const project = await makeProject(owner.id);
		const membership = await resolveMembership(env, { userId: owner.id, project });
		expect(membership.orgRole).toBe("owner");
		expect(membership.projectRole).toBe("admin");
		expect(can("project.delete", membership)).toBe(true);
	});

	it("gives a stranger nothing", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const stranger = await makeUser(`stranger-${newId("x")}@example.com`);
		const project = await makeProject(owner.id);
		const membership = await resolveMembership(env, { userId: stranger.id, project });
		expect(membership.orgRole).toBeNull();
		expect(membership.projectRole).toBeNull();
		expect(membership.capabilities).toEqual([]);
		expect(can("project.view", membership)).toBe(false);
	});

	it("grants exactly the project role that was given, and no more", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const guest = await makeUser(`guest-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, guest.id, owner.id, at, at).run();
		await setProjectRole(env, project.id, org.id, guest.id, "viewer");

		const membership = await resolveMembership(env, { userId: guest.id, project });
		expect(membership.projectRole).toBe("viewer");
		expect(membership.orgRole).toBe("member");
		expect(can("project.memory.read", membership)).toBe(true);
		expect(can("project.memory.write", membership)).toBe(false);
		expect(can("project.delete", membership)).toBe(false);
	});

	it("lets an organization admin reach its projects, but not delete them", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const admin = await makeUser(`admin-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, ?, 'admin', ?, ?)`,
		).bind(newId("orgm"), org.id, admin.id, Date.now(), Date.now()).run();

		const membership = await resolveMembership(env, { userId: admin.id, project });
		expect(membership.orgRole).toBe("admin");
		expect(can("project.edit", membership)).toBe(true);
		expect(can("project.rules.edit", membership)).toBe(true);
		expect(can("project.delete", membership)).toBe(false);
		expect(can("project.transfer", membership)).toBe(false);
	});

	it("bootstraps one organization per account, idempotently under concurrency", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const [a, b, c] = await Promise.all([
			ensureDefaultOrganization(env, owner.id),
			ensureDefaultOrganization(env, owner.id),
			ensureDefaultOrganization(env, owner.id),
		]);
		expect(a.id).toBe(b.id);
		expect(b.id).toBe(c.id);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?",
		).bind(owner.id).first();
		expect(Number(rows.n)).toBe(1);
		const members = await listOrganizationMembers(env, a.id);
		expect(members).toHaveLength(1);
		expect(members[0].role).toBe("owner");
	});

	it("never leaks account activity from one organization into another", async () => {
		const ownerA = await makeUser(`owner-a-${newId("x")}@example.com`);
		const ownerB = await makeUser(`owner-b-${newId("x")}@example.com`);
		const member = await makeUser(`member-${newId("x")}@example.com`);
		const orgA = await ensureDefaultOrganization(env, ownerA.id);
		const orgB = await ensureDefaultOrganization(env, ownerB.id);
		const projectA = await makeProject(ownerA.id, { orgId: orgA.id, name: `A ${newId("x")}` });
		const projectB = await makeProject(ownerB.id, { orgId: orgB.id, name: `B ${newId("x")}` });
		const at = Date.now();
		for (const org of [orgA, orgB]) {
			await env.DB.prepare(
				`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), org.id, member.id, org.owner_user_id, at, at).run();
		}
		await setProjectRole(env, projectA.id, orgA.id, member.id, "member", ownerA.id);
		await setProjectRole(env, projectB.id, orgB.id, member.id, "member", ownerB.id);
		const activeAt = at + 5000;
		await env.DB.prepare(
			`INSERT INTO connection_tokens
			 (id, user_id, token_hash, label, type, scopes_json, status, created_at, last_used_at, project_id)
			 VALUES (?, ?, ?, 'B only', 'api', '["memory:read"]', 'active', ?, ?, ?)`,
		).bind(newId("tok"), member.id, `hash_${newId("x")}`, at, activeAt, projectB.id).run();

		const orgAMember = (await listOrganizationMembers(env, orgA.id)).find((row) => row.user_id === member.id);
		const orgBMember = (await listOrganizationMembers(env, orgB.id)).find((row) => row.user_id === member.id);
		const projectAMember = (await listProjectMembers(env, projectA.id)).find((row) => row.user_id === member.id);
		const projectBMember = (await listProjectMembers(env, projectB.id)).find((row) => row.user_id === member.id);
		expect(orgAMember.last_activity_at).toBeNull();
		expect(projectAMember.last_activity_at).toBeNull();
		expect(orgBMember.last_activity_at).toBe(activeAt);
		expect(projectBMember.last_activity_at).toBe(activeAt);
	});

	it("cannot recreate a project seat after the target account is quiesced", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const target = await makeUser(`target-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id, name: `Race ${newId("x")}` });
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, target.id, owner.id, at, at).run();

		// Model a request that passed its pre-read immediately before account
		// erasure removed the target's authority rows.
		await env.DB.batch([
			env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
				.bind(target.id, at + 1),
			env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(target.id),
			env.DB.prepare("DELETE FROM organization_members WHERE org_id = ? AND user_id = ?")
				.bind(org.id, target.id),
		]);
		await expect(setProjectRole(env, project.id, org.id, target.id, "member", owner.id))
			.rejects.toMatchObject({ code: "inactive_org_membership", status: 409 });
		expect(await env.DB.prepare(
			"SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, target.id).first()).toBeNull();
	});

	it("caps temporary administrators' organization and project grants at their own live window", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const temporaryAdmin = await makeUser(`temporary-admin-${newId("x")}@example.com`);
		const target = await makeUser(`target-${newId("x")}@example.com`);
		const ownerTarget = await makeUser(`owner-target-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id, name: `Delegation ${newId("x")}` });
		const now = Date.now();
		const adminExpiresAt = now + 120_000;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, access_starts_at, access_expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)`,
			).bind(newId("orgm"), org.id, temporaryAdmin.id, now - 1000, adminExpiresAt, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?)`,
			).bind(newId("orgm"), org.id, target.id, owner.id, now, now + 30_000, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), org.id, ownerTarget.id, owner.id, now, now),
		]);

		await expect(createInvitation(env, {
			orgId: org.id,
			email: `permanent-${newId("x")}@example.com`,
			orgRole: "admin",
			invitedByUserId: temporaryAdmin.id,
			origin: "https://itsuki.app",
		})).rejects.toMatchObject({ code: "delegation_window_exceeded", status: 403 });
		const narrowInvite = await createInvitation(env, {
			orgId: org.id,
			email: `narrow-${newId("x")}@example.com`,
			orgRole: "admin",
			invitedByUserId: temporaryAdmin.id,
			origin: "https://itsuki.app",
			accessStartsAt: now,
			accessExpiresAt: now + 60_000,
		});
		expect(narrowInvite.invitation.access_expires_at).toBe(now + 60_000);

		let targetOrg = (await listOrganizationMembers(env, org.id)).find((row) => row.user_id === target.id);
		await expect(setOrganizationRole(
			env, org.id, target.id, "admin", targetOrg.revision,
			{ access_expires_at: adminExpiresAt + 1 }, temporaryAdmin.id,
		)).rejects.toMatchObject({ code: "delegation_window_exceeded", status: 403 });
		const orgNarrow = await setOrganizationRole(
			env, org.id, target.id, "admin", targetOrg.revision,
			{ access_expires_at: now + 90_000 }, temporaryAdmin.id,
		);
		expect(orgNarrow.member).toMatchObject({ role: "admin", access_expires_at: now + 90_000 });

		await expect(setProjectRole(env, project.id, org.id, target.id, "admin", temporaryAdmin.id))
			.rejects.toMatchObject({ code: "delegation_window_exceeded", status: 403 });
		const projectNarrow = await setProjectRole(env, project.id, org.id, target.id, "admin", temporaryAdmin.id, {
			access_starts_at: now,
			access_expires_at: now + 60_000,
		});
		expect(projectNarrow.member).toMatchObject({ role: "admin", access_expires_at: now + 60_000 });
		await expect(updateProjectRole(
			env, project.id, org.id, target.id, "admin", projectNarrow.member.revision,
			{ access_expires_at: adminExpiresAt + 1 }, temporaryAdmin.id,
		)).rejects.toMatchObject({ code: "delegation_window_exceeded", status: 403 });

		// Owners have the explicit permanent bypass.
		expect((await setProjectRole(env, project.id, org.id, ownerTarget.id, "admin", owner.id)).member)
			.toMatchObject({ role: "admin", access_expires_at: null });

		// Deterministic commit-time race: authorization succeeds, then the actor's
		// seat expires before the state batch. The fence aborts the write.
		await assertDelegationAuthority(env, {
			actorUserId: temporaryAdmin.id,
			orgId: org.id,
			accessExpiresAt: now + 30_000,
			now,
		});
		await env.DB.prepare(
			"UPDATE organization_members SET access_expires_at = ?, updated_at = ? WHERE org_id = ? AND user_id = ?",
		).bind(now - 1, now + 1, org.id, temporaryAdmin.id).run();
		const raceTarget = await makeUser(`race-target-${newId("x")}@example.com`);
		await expect(env.DB.batch([
			delegationGuardStatement(env, {
				actorUserId: temporaryAdmin.id,
				orgId: org.id,
				accessExpiresAt: now + 10_000,
				now: now + 2,
			}),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, access_expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'admin', ?, ?, ?, ?)`,
			).bind(newId("orgm"), org.id, raceTarget.id, temporaryAdmin.id, now + 10_000, now + 2, now + 2),
		])).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare(
			"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, raceTarget.id).first()).toBeNull();
	});

	it("refuses to demote or remove the organization owner", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const revision = (await listOrganizationMembers(env, org.id)).find((row) => row.user_id === owner.id).revision;
		await expect(setOrganizationRole(env, org.id, owner.id, "member", revision)).rejects.toMatchObject({
			code: "owner_immutable",
		});
		await expect(removeOrganizationMember(env, org.id, owner.id, revision)).rejects.toMatchObject({
			code: "owner_immutable",
		});
		await expect(setOrganizationRole(env, org.id, owner.id, "owner", revision)).rejects.toMatchObject({
			code: "invalid_role",
		});
	});

	it("takes project access away when someone leaves the organization", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const guest = await makeUser(`guest-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?)`,
		).bind(newId("orgm"), org.id, guest.id, Date.now(), Date.now()).run();
		await setProjectRole(env, project.id, org.id, guest.id, "admin");
		expect((await resolveMembership(env, { userId: guest.id, project })).projectRole).toBe("admin");

		const revision = (await listOrganizationMembers(env, org.id)).find((row) => row.user_id === guest.id).revision;
		await removeOrganizationMember(env, org.id, guest.id, revision);
		const after = await resolveMembership(env, { userId: guest.id, project });
		expect(after.projectRole).toBeNull();
		expect(after.orgRole).toBeNull();
		expect(after.capabilities).toEqual([]);
	});

	it("makes project removal win stale role edits without touching a replacement seat", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const guest = await makeUser(`guest-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, guest.id, owner.id, at, at).run();
		await setProjectRole(env, project.id, org.id, guest.id, "admin", owner.id);
		const first = (await listProjectMembers(env, project.id)).find((row) => row.user_id === guest.id);

		await expect(updateProjectRole(env, project.id, org.id, guest.id, "viewer"))
			.rejects.toMatchObject({ code: "precondition_required", status: 428 });
		const changed = await updateProjectRole(env, project.id, org.id, guest.id, "viewer", first.revision);
		expect(changed).toMatchObject({ changed: true, previous_role: "admin", member: { role: "viewer" } });
		await expect(updateProjectRole(env, project.id, org.id, guest.id, "member", first.revision))
			.rejects.toMatchObject({ code: "member_conflict", status: 412 });

		// DELETE compares the immutable generation rather than the stale role
		// revision, so removal wins this ordering too.
		expect(await removeProjectMember(env, project.id, guest.id, first.revision))
			.toMatchObject({ removed: true, previous_role: "viewer" });
		await expect(updateProjectRole(env, project.id, org.id, guest.id, "admin", changed.member.revision))
			.rejects.toMatchObject({ code: "member_conflict", status: 412 });

		const replacement = await setProjectRole(env, project.id, org.id, guest.id, "member", owner.id);
		expect(replacement.member.revision).not.toBe(first.revision);
		await expect(removeProjectMember(env, project.id, guest.id, first.revision))
			.rejects.toMatchObject({ code: "member_conflict", status: 412 });
		expect((await listProjectMembers(env, project.id)).find((row) => row.user_id === guest.id).role).toBe("member");
	});

	it("removes an organization seat and its project seats atomically and reports repeats honestly", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const guest = await makeUser(`guest-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?)`,
		).bind(newId("orgm"), org.id, guest.id, at, at).run();
		await setProjectRole(env, project.id, org.id, guest.id, "viewer", owner.id);
		const first = (await listOrganizationMembers(env, org.id)).find((row) => row.user_id === guest.id);
		const changed = await setOrganizationRole(env, org.id, guest.id, "admin", first.revision);

		const removed = await removeOrganizationMember(env, org.id, guest.id, first.revision);
		expect(removed).toMatchObject({ removed: true, previous_role: "admin" });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, guest.id).first()).toMatchObject({ n: 0 });
		expect(await removeOrganizationMember(env, org.id, guest.id, changed.member.revision))
			.toMatchObject({ removed: false, already_removed: true });

		const replacementAt = at + 10;
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?)`,
		).bind(newId("orgm"), org.id, guest.id, replacementAt, replacementAt).run();
		await setProjectRole(env, project.id, org.id, guest.id, "member", owner.id);
		await expect(removeOrganizationMember(env, org.id, guest.id, first.revision))
			.rejects.toMatchObject({ code: "member_conflict", status: 412 });
		expect((await resolveMembership(env, { userId: guest.id, project })).projectRole).toBe("member");
	});
});

describe("invitations", () => {
	async function setup() {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		return { owner, org, project };
	}

	it("returns the link once and stores only a hash of it", async () => {
		const { owner, org } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		expect(created.link).toContain("#invite=");
		const token = created.link.split("#invite=")[1];
		expect(token).toMatch(/^[0-9a-f]{64}$/);

		const row = await env.DB.prepare(
			"SELECT token_hash FROM organization_invitations WHERE id = ?",
		).bind(created.invitation.id).first();
		// The raw token must appear nowhere in storage.
		expect(row.token_hash).not.toBe(token);
		expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
		// And the public shape must never carry it either.
		expect(JSON.stringify(created.invitation)).not.toContain(token);
	});

	it("refuses to be accepted by a different signed-in account", async () => {
		const { owner, org } = await setup();
		const invited = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, email: invited, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const token = created.link.split("#invite=")[1];
		const wrongPerson = await makeUser(`wrong-${newId("x")}@example.com`);

		const result = await acceptInvitation(env, token, wrongPerson);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("wrong_account");
		const members = await listOrganizationMembers(env, org.id);
		expect(members.map((m) => m.user_id)).not.toContain(wrongPerson.id);
	});

	it("cannot recreate memberships after the invited account is quiesced", async () => {
		const { owner, org, project } = await setup();
		const email = `erased-invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "viewer",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const invitee = await makeUser(email);
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
				.bind(invitee.id, at),
			env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(invitee.id),
		]);

		const result = await acceptInvitation(env, created.link.split("#invite=")[1], invitee);
		expect(result).toMatchObject({ ok: false, reason: "account_inactive" });
		expect(await env.DB.prepare(
			"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, invitee.id).first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, invitee.id).first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT status, accepted_by_user_id FROM organization_invitations WHERE id = ?",
		).bind(created.invitation.id).first()).toEqual({ status: "pending", accepted_by_user_id: null });
	});

	it("is single use, even when two clicks race", async () => {
		const { owner, org, project } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "member",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const token = created.link.split("#invite=")[1];
		const invitee = await makeUser(email);

		const [first, second] = await Promise.all([
			acceptInvitation(env, token, invitee),
			acceptInvitation(env, token, invitee),
		]);
		expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM organization_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, invitee.id).first();
		expect(Number(rows.n)).toBe(1);

		const third = await acceptInvitation(env, token, invitee);
		expect(third.ok).toBe(false);
		expect(third.reason).toBe("accepted");
	});

	it("grants exactly the roles the invitation named", async () => {
		const { owner, org, project } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "viewer",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const invitee = await makeUser(email);
		expect((await acceptInvitation(env, created.link.split("#invite=")[1], invitee)).ok).toBe(true);

		const membership = await resolveMembership(env, { userId: invitee.id, project });
		expect(membership.orgRole).toBe("member");
		expect(membership.projectRole).toBe("viewer");
		expect(can("project.memory.write", membership)).toBe(false);
	});

	it("intersects organization and project access windows and reports their status", async () => {
		const { owner, org, project } = await setup();
		const email = `temporary-${newId("x")}@example.com`;
		const startsAt = Date.now() + 60_000;
		const expiresAt = startsAt + 3_600_000;
		const created = await createInvitation(env, {
			orgId: org.id,
			projectId: project.id,
			email,
			orgRole: "member",
			projectRole: "member",
			invitedByUserId: owner.id,
			origin: "https://itsuki.app",
			accessStartsAt: startsAt,
			accessExpiresAt: expiresAt,
		});
		expect(created.invitation).toMatchObject({
			access_starts_at: startsAt,
			access_expires_at: expiresAt,
			access_status: "scheduled",
		});
		const invitee = await makeUser(email);
		const token = created.link.split("#invite=")[1];
		expect(await describeInvitation(env, token, invitee)).toMatchObject({ ok: true, account_matches: true });
		expect((await acceptInvitation(env, token, invitee)).ok).toBe(true);

		let membership = await resolveMembership(env, { userId: invitee.id, project });
		expect(membership).toMatchObject({ orgRole: null, projectRole: null });
		let listed = (await listProjectMembers(env, project.id)).find((row) => row.user_id === invitee.id);
		expect(listed).toMatchObject({ access_status: "scheduled", access_starts_at: startsAt, access_expires_at: expiresAt });

		const activeAt = Date.now() - 1;
		await env.DB.batch([
			env.DB.prepare("UPDATE organization_members SET access_starts_at = ? WHERE org_id = ? AND user_id = ?")
				.bind(activeAt, org.id, invitee.id),
			env.DB.prepare("UPDATE project_members SET access_starts_at = ? WHERE project_id = ? AND user_id = ?")
				.bind(activeAt, project.id, invitee.id),
		]);
		membership = await resolveMembership(env, { userId: invitee.id, project });
		expect(membership).toMatchObject({ orgRole: "member", projectRole: "member" });

		await env.DB.prepare("UPDATE organization_members SET access_expires_at = ? WHERE org_id = ? AND user_id = ?")
			.bind(Date.now() - 1, org.id, invitee.id).run();
		membership = await resolveMembership(env, { userId: invitee.id, project });
		expect(membership).toMatchObject({ orgRole: null, projectRole: null });
	});

	it("does not disclose invitation recipient or organization to the wrong account", async () => {
		const { owner, org } = await setup();
		const email = `private-invite-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const wrong = await makeUser(`wrong-${newId("x")}@example.com`);
		const described = await describeInvitation(env, created.link.split("#invite=")[1], wrong);
		expect(described).toMatchObject({ ok: false, reason: "wrong_account" });
		expect(JSON.stringify(described)).not.toContain(email);
		expect(JSON.stringify(described)).not.toContain(org.name);
	});

	it("does not let an older invitation overwrite roles assigned after it was issued", async () => {
		const { owner, org, project } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "viewer",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const invitee = await makeUser(email);
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, invitee.id, owner.id, at, at).run();
		await setProjectRole(env, project.id, org.id, invitee.id, "admin", owner.id);

		expect((await acceptInvitation(env, created.link.split("#invite=")[1], invitee)).ok).toBe(true);
		const membership = await resolveMembership(env, { userId: invitee.id, project });
		expect(membership.orgRole).toBe("admin");
		expect(membership.projectRole).toBe("admin");
	});

	it("cannot be redeemed once revoked or expired", async () => {
		const { owner, org } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const revoked = await createInvitation(env, {
			orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		await revokeInvitation(env, org.id, revoked.invitation.id);
		const invitee = await makeUser(email);
		expect((await acceptInvitation(env, revoked.link.split("#invite=")[1], invitee)).reason).toBe("revoked");

		const email2 = `invitee2-${newId("x")}@example.com`;
		const stale = await createInvitation(env, {
			orgId: org.id, email: email2, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		await env.DB.prepare("UPDATE organization_invitations SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, stale.invitation.id).run();
		const invitee2 = await makeUser(email2);
		expect((await acceptInvitation(env, stale.link.split("#invite=")[1], invitee2)).reason).toBe("expired");
	});

	it("replaces an outstanding invitation rather than issuing a second live link", async () => {
		const { owner, org } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const first = await createInvitation(env, {
			orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const second = await createInvitation(env, {
			orgId: org.id, email, orgRole: "admin", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const invitee = await makeUser(email);
		expect((await acceptInvitation(env, first.link.split("#invite=")[1], invitee)).ok).toBe(false);
		expect((await acceptInvitation(env, second.link.split("#invite=")[1], invitee)).ok).toBe(true);
	});

	it("resends by rotating exactly one live generation while preserving approved access", async () => {
		const { owner, org, project } = await setup();
		const email = `resend-${newId("x")}@example.com`;
		const startsAt = Date.now() + 60_000;
		const expiresAt = startsAt + 3_600_000;
		const original = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "viewer",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
			accessStartsAt: startsAt, accessExpiresAt: expiresAt,
		});
		const attempts = await Promise.allSettled([
			resendInvitation(env, {
				orgId: org.id, invitationId: original.invitation.id,
				invitedByUserId: owner.id, origin: "https://itsuki.app",
			}),
			resendInvitation(env, {
				orgId: org.id, invitationId: original.invitation.id,
				invitedByUserId: owner.id, origin: "https://itsuki.app",
			}),
		]);
		expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((item) => item.status === "rejected")[0].reason)
			.toMatchObject({ code: "invitation_conflict", status: 409 });
		const resent = attempts.find((item) => item.status === "fulfilled").value;
		expect(resent).toMatchObject({
			invitation: {
				org_role: "member", project_role: "viewer",
				access_starts_at: startsAt, access_expires_at: expiresAt,
			},
			email_delivery: { status: "copy_link_only" },
		});
		const invitee = await makeUser(email);
		expect((await acceptInvitation(env, original.link.split("#invite=")[1], invitee)).ok).toBe(false);
		expect((await acceptInvitation(env, resent.link.split("#invite=")[1], invitee)).ok).toBe(true);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM organization_invitations WHERE org_id = ? AND email_normalized = ? AND status = 'pending'",
		).bind(org.id, email).first()).n)).toBe(0);
		await expect(resendInvitation(env, {
			orgId: org.id, invitationId: resent.invitation.id,
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		})).rejects.toMatchObject({ code: "invitation_not_found", status: 404 });
	});

	it("leaves exactly one live invitation when duplicate sends race", async () => {
		const { owner, org } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const [first, second] = await Promise.all([
			createInvitation(env, {
				orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
			}),
			createInvitation(env, {
				orgId: org.id, email, orgRole: "admin", invitedByUserId: owner.id, origin: "https://itsuki.app",
			}),
		]);
		const live = await env.DB.prepare(
			"SELECT id FROM organization_invitations WHERE org_id = ? AND email_normalized = ? AND status = 'pending'",
		).bind(org.id, email).all();
		expect(live.results).toHaveLength(1);
		const invitee = await makeUser(email);
		const accepted = await Promise.all([
			acceptInvitation(env, first.link.split("#invite=")[1], invitee),
			acceptInvitation(env, second.link.split("#invite=")[1], invitee),
		]);
		expect(accepted.filter((result) => result.ok)).toHaveLength(1);
	});

	it("enforces the pending invitation cap atomically across different-email races", async () => {
		const { owner, org } = await setup();
		const at = Date.now();
		const statements = Array.from({ length: 49 }, (_, index) => env.DB.prepare(
			`INSERT INTO organization_invitations
			 (id, org_id, email_normalized, org_role, token_hash, status, invited_by_user_id,
			  expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, 'pending', ?, ?, ?, ?)`,
		).bind(
			newId("inv"), org.id, `cap-${index}-${newId("x")}@example.com`,
			`hash_${crypto.randomUUID()}`, owner.id, at + 60_000, at, at,
		));
		await env.DB.batch(statements);
		const attempts = await Promise.allSettled(["left", "right"].map((side) => createInvitation(env, {
			orgId: org.id,
			email: `cap-race-${side}-${newId("x")}@example.com`,
			orgRole: "member",
			invitedByUserId: owner.id,
			origin: "https://itsuki.app",
		})));
		expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.find((result) => result.status === "rejected");
		expect(rejected.reason).toMatchObject({ code: "invite_limit_reached", status: 409 });
		const live = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM organization_invitations WHERE org_id = ? AND status = 'pending'",
		).bind(org.id).first();
		expect(Number(live.n)).toBe(50);
	});

	it("expires stale pending rows atomically so they cannot exhaust the live invitation cap", async () => {
		const { owner, org } = await setup();
		const at = Date.now();
		const staleIds = Array.from({ length: 50 }, () => newId("inv"));
		await env.DB.batch(staleIds.map((id, index) => env.DB.prepare(
			`INSERT INTO organization_invitations
			 (id, org_id, email_normalized, org_role, token_hash, status, invited_by_user_id,
			  expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, 'pending', ?, ?, ?, ?)`,
		).bind(
			id, org.id, `stale-${index}-${newId("x")}@example.com`,
			`hash_${crypto.randomUUID()}`, owner.id, at - 1, at - 10, at - 10,
		)));
		await env.DB.prepare(
			`INSERT INTO invitation_email_outbox
			 (id, invitation_id, org_id, recipient_email, payload_ciphertext, payload_iv,
			  status, attempts, created_at, updated_at)
			 VALUES (?, ?, ?, 'stale@example.com', 'encrypted-live-token', 'iv', 'queued', 0, ?, ?)`,
		).bind(newId("invmail"), staleIds[0], org.id, at, at).run();

		const created = await createInvitation(env, {
			orgId: org.id,
			email: `fresh-${newId("x")}@example.com`,
			orgRole: "member",
			invitedByUserId: owner.id,
			origin: "https://itsuki.app",
		});
		expect(created.expired_invitation_count).toBe(50);
		const states = await env.DB.prepare(
			"SELECT status, COUNT(*) AS n FROM organization_invitations WHERE org_id = ? GROUP BY status",
		).bind(org.id).all();
		expect(Object.fromEntries(states.results.map((row) => [row.status, Number(row.n)])))
			.toEqual({ expired: 50, pending: 1 });
		expect(await env.DB.prepare(
			"SELECT status, payload_ciphertext, payload_iv FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(staleIds[0]).first()).toEqual({
			status: "suppressed", payload_ciphertext: null, payload_iv: null,
		});
	});

	it("rolls back all access and keeps the token live when a membership write fails", async () => {
		const { owner, org, project } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const created = await createInvitation(env, {
			orgId: org.id, projectId: project.id, email, orgRole: "member", projectRole: "viewer",
			invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const invitee = await makeUser(email);
		const trigger = `fail_invite_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`CREATE TRIGGER ${trigger} BEFORE INSERT ON project_members
			 WHEN NEW.user_id = '${invitee.id}' BEGIN SELECT RAISE(ABORT, 'forced invite failure'); END`,
		).run();
		try {
			await expect(acceptInvitation(env, created.link.split("#invite=")[1], invitee)).rejects.toThrow(/forced invite failure/i);
		} finally {
			await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
		}
		expect(await env.DB.prepare(
			"SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, invitee.id).first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT id FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, invitee.id).first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT status, accepted_at FROM organization_invitations WHERE id = ?",
		).bind(created.invitation.id).first()).toMatchObject({ status: "pending", accepted_at: null });
		expect((await acceptInvitation(env, created.link.split("#invite=")[1], invitee)).ok).toBe(true);
	});

	it("does not revoke the working link when its replacement cannot be inserted", async () => {
		const { owner, org } = await setup();
		const email = `invitee-${newId("x")}@example.com`;
		const existing = await createInvitation(env, {
			orgId: org.id, email, orgRole: "member", invitedByUserId: owner.id, origin: "https://itsuki.app",
		});
		const trigger = `fail_invite_create_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`CREATE TRIGGER ${trigger} BEFORE INSERT ON organization_invitations
			 WHEN NEW.email_normalized = '${email}' BEGIN SELECT RAISE(ABORT, 'forced invite create failure'); END`,
		).run();
		try {
			await expect(createInvitation(env, {
				orgId: org.id, email, orgRole: "admin", invitedByUserId: owner.id, origin: "https://itsuki.app",
			})).rejects.toThrow(/forced invite create failure/i);
		} finally {
			await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
		}
		expect(await env.DB.prepare(
			"SELECT status FROM organization_invitations WHERE id = ?",
		).bind(existing.invitation.id).first()).toEqual({ status: "pending" });
		const invitee = await makeUser(email);
		expect((await acceptInvitation(env, existing.link.split("#invite=")[1], invitee)).ok).toBe(true);
	});

	it("tells an unknown token nothing about anything", async () => {
		expect(await describeInvitation(env, "0".repeat(64))).toEqual({ ok: false, reason: "invalid" });
		expect(await describeInvitation(env, "")).toEqual({ ok: false, reason: "invalid" });
	});

	it("refuses an invalid email or role before writing anything", async () => {
		const { owner, org } = await setup();
		await expect(createInvitation(env, {
			orgId: org.id, email: "not-an-email", invitedByUserId: owner.id, origin: "https://itsuki.app",
		})).rejects.toMatchObject({ code: "invalid_email" });
		await expect(createInvitation(env, {
			orgId: org.id, email: "a@b.com", orgRole: "owner", invitedByUserId: owner.id, origin: "https://itsuki.app",
		})).rejects.toMatchObject({ code: "invalid_role" });
	});
});

describe("audit", () => {
	it("keeps private content out by construction, not by good manners", async () => {
		const diff = auditDiff(
			{
				name: "before", description: "client salary is private", excludes_count: 1,
				secret: "sk-live-should-never-appear",
			},
			{
				name: "after", description: "new confidential acquisition", excludes_count: 3,
				secret: "sk-live-also-not-this", memory_text: "my salary is 90k",
			},
		);
		expect(diff).toEqual({
			name_changed: { from: false, to: true },
			description_changed: { from: false, to: true },
			excludes_count: { from: 1, to: 3 },
		});
		const serialized = JSON.stringify(diff);
		expect(serialized).not.toContain("sk-live");
		expect(serialized).not.toContain("salary");
		expect(serialized).not.toContain("acquisition");
	});

	it("stores only the domain of an invited address", () => {
		expect(emailDomain("Someone.Private@Example.COM")).toBe("example.com");
		expect(emailDomain("nonsense")).toBeNull();
	});

	it("records scoped events and never fails the action it describes", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await writeAudit(env, {
			orgId: org.id, projectId: project.id, actorUserId: owner.id,
			action: "project.rules.updated", targetType: "rules", targetId: project.id,
			metadata: { excludes_count: { from: 0, to: 2 } },
		});
		const page = await listAuditEvents(env, { projectId: project.id });
		expect(page.events).toHaveLength(1);
		expect(page.events[0].action).toBe("project.rules.updated");
		expect(page.events[0].actor).toBe(owner.email);
		expect(page.events[0].metadata).toEqual({ excludes_count: { from: 0, to: 2 } });

		// A broken write must not throw into the caller.
		await expect(writeAudit({ DB: null }, { action: "x" })).resolves.toBeNull();
		await expect(writeAudit(env, {})).resolves.toBeNull();
	});

	it("sanitizes hostile metadata again at the audit write boundary", async () => {
		const owner = await makeUser(`audit-hostile-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		const project = await makeProject(owner.id, { orgId: org.id });
		await writeAudit(env, {
			orgId: org.id,
			projectId: project.id,
			actorUserId: owner.id,
			action: "project.updated",
			metadata: {
				name_changed: { from: false, to: true },
				memory_text: "my salary is 90k",
				secret: "sk-live-never-store-this",
				description: { from: "private before", to: "private after" },
			},
		});
		const stored = await env.DB.prepare(
			"SELECT metadata_json FROM audit_events WHERE project_id = ? AND action = 'project.updated' ORDER BY created_at DESC LIMIT 1",
		).bind(project.id).first();
		expect(JSON.parse(stored.metadata_json)).toEqual({ name_changed: { from: false, to: true } });
		expect(stored.metadata_json).not.toMatch(/salary|sk-live|private/i);
	});

	it("never returns another project's events", async () => {
		const a = await makeUser(`a-${newId("x")}@example.com`);
		const b = await makeUser(`b-${newId("x")}@example.com`);
		const pa = await makeProject(a.id);
		const pb = await makeProject(b.id);
		await writeAudit(env, { projectId: pa.id, actorUserId: a.id, action: "project.updated" });
		await writeAudit(env, { projectId: pb.id, actorUserId: b.id, action: "project.updated" });
		const page = await listAuditEvents(env, { projectId: pa.id });
		expect(page.events).toHaveLength(1);
		expect(page.events[0].target_id).not.toBe(pb.id);
	});
});
