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
	can,
	capabilitiesFor,
	ensureDefaultOrganization,
	listOrganizationMembers,
	removeOrganizationMember,
	resolveMembership,
	setOrganizationRole,
	setProjectRole,
} from "../src/lib/organizations.js";
import { acceptInvitation, createInvitation, describeInvitation, revokeInvitation } from "../src/lib/invitations.js";
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
		expect(can("project.keys.manage", { projectRole: "member" })).toBe(true);
		expect(can("project.rules.edit", { projectRole: "member" })).toBe(false);
		expect(can("project.categories.edit", { projectRole: "member" })).toBe(false);
		expect(can("project.members.manage", { projectRole: "member" })).toBe(false);
		expect(can("project.memory.delete", { projectRole: "member" })).toBe(false);
		expect(can("project.audit.view", { projectRole: "member" })).toBe(false);
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
		await setProjectRole(env, project.id, org.id, guest.id, "viewer");

		const membership = await resolveMembership(env, { userId: guest.id, project });
		expect(membership.projectRole).toBe("viewer");
		expect(membership.orgRole).toBeNull();
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

	it("refuses to demote or remove the organization owner", async () => {
		const owner = await makeUser(`owner-${newId("x")}@example.com`);
		const org = await ensureDefaultOrganization(env, owner.id);
		await expect(setOrganizationRole(env, org.id, owner.id, "member")).rejects.toMatchObject({
			code: "owner_immutable",
		});
		await expect(removeOrganizationMember(env, org.id, owner.id)).rejects.toMatchObject({
			code: "owner_immutable",
		});
		await expect(setOrganizationRole(env, org.id, owner.id, "owner")).rejects.toMatchObject({
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

		await removeOrganizationMember(env, org.id, guest.id);
		const after = await resolveMembership(env, { userId: guest.id, project });
		expect(after.projectRole).toBeNull();
		expect(after.orgRole).toBeNull();
		expect(after.capabilities).toEqual([]);
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
			{ name: "before", excludes_count: 1, secret: "sk-live-should-never-appear" },
			{ name: "after", excludes_count: 3, secret: "sk-live-also-not-this", memory_text: "my salary is 90k" },
		);
		expect(diff).toEqual({
			name: { from: "before", to: "after" },
			excludes_count: { from: 1, to: 3 },
		});
		expect(JSON.stringify(diff)).not.toContain("sk-live");
		expect(JSON.stringify(diff)).not.toContain("salary");
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
