/**
 * Stage 3 HTTP authorization contract.
 *
 * The capability matrix is only useful when every real HTTP door enforces it.
 * These tests deliberately use live session cookies and a shared project: a
 * browser role downgrade must take effect on the very next request, without a
 * logout or UI refresh.
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import {
	ensureDefaultOrganization,
	listOrganizationMembers,
	listProjectMembers,
	removeProjectMember,
	setOrganizationRole,
	setProjectRole,
	updateProjectRole,
} from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";
import { saveMemoryRules } from "../src/pipeline/rules.js";

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

function memberMutation(method, body, cookie, projectId, revision) {
	const init = json(method, body, cookie, projectId);
	if (revision) init.headers["if-match"] = revision;
	return init;
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

async function sharedProject(role = "viewer") {
	const owner = await signup(`rbac-owner-${newId("x")}`);
	const collaborator = await signup(`rbac-collaborator-${newId("x")}`);
	const createdProject = await request("/auth/projects", json("POST", {
		name: `Shared ${newId("x")}`,
	}, owner.cookie));
	expect(createdProject.status).toBe(201);
	const { project } = await createdProject.json();
	expect(project.is_default).toBe(false);
	// Most containment tests deliberately exercise the pre-0039 compatibility
	// shape. New projects are organization-owned now, so make this fixture an
	// explicit historical NULL-org row rather than relying on the create API.
	await env.DB.prepare("UPDATE managed_projects SET organization_id = NULL WHERE id = ?")
		.bind(project.id).run();
	project.organization_id = null;
	const storage = await env.DB.prepare(
		"SELECT memory_owner_user_id, organization_id FROM managed_projects WHERE id = ?",
	).bind(project.id).first();
	expect(storage?.memory_owner_user_id).toMatch(/^mem_/);
	expect(storage?.memory_owner_user_id).not.toBe(owner.user.id);
	expect(storage?.organization_id).toBeNull();
	const org = await ensureDefaultOrganization(env, owner.user.id);
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
	).bind(newId("orgm"), org.id, collaborator.user.id, owner.user.id, at, at).run();
	await setProjectRole(env, project.id, org.id, collaborator.user.id, role, owner.user.id);
	return {
		owner,
		collaborator,
		project,
		org,
		memoryOwnerUserId: storage.memory_owner_user_id,
	};
}

async function changeOrgRole(orgId, userId, role) {
	const member = (await listOrganizationMembers(env, orgId)).find((row) => row.user_id === userId);
	return setOrganizationRole(env, orgId, userId, role, member?.revision);
}

async function changeProjectRole(projectId, orgId, userId, role) {
	const member = (await listProjectMembers(env, projectId)).find((row) => row.user_id === userId);
	return updateProjectRole(env, projectId, orgId, userId, role, member?.revision);
}

async function removeProjectRole(projectId, userId) {
	const member = (await listProjectMembers(env, projectId)).find((row) => row.user_id === userId);
	return removeProjectMember(env, projectId, userId, member?.revision);
}

async function expectForbidden(response, capability) {
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ error: "forbidden", capability });
}

async function mcpCall(token, name, args = {}, projectId = null) {
	return request("/mcp", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(projectId ? { "x-itsuki-project": projectId } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

describe("Stage 3 HTTP role enforcement", () => {
	it("resolves a genuine NULL-org project to its owner's organization for discovery and mutation", async () => {
		const { owner, collaborator, project, org } = await sharedProject("viewer");
		await changeOrgRole(org.id, collaborator.user.id, "admin");
		await removeProjectRole(project.id, collaborator.user.id);
		const collaboratorOrg = await ensureDefaultOrganization(env, collaborator.user.id);

		const listed = await request("/auth/projects", { headers: { cookie: collaborator.cookie } });
		expect(listed.status).toBe(200);
		expect((await listed.json()).projects.map((row) => row.id)).toContain(project.id);

		const settings = await request("/v1/settings", {
			headers: { cookie: collaborator.cookie, "x-itsuki-project": project.id },
		});
		expect(settings.status).toBe(200);
		const settingsBody = await settings.json();
		expect(settingsBody.organization.id).toBe(org.id);

		const nextName = `Owner organization ${newId("x")}`;
		const changeRequest = json("PATCH", {
			name: nextName,
		}, collaborator.cookie, project.id);
		changeRequest.headers["if-match"] = settingsBody.organization.revision;
		const changed = await request("/v1/settings/organization", changeRequest);
		expect(changed.status).toBe(200);
		expect((await changed.json()).organization).toMatchObject({ id: org.id, name: nextName });
		expect((await env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(org.id).first()).name).toBe(nextName);
		expect((await env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(collaboratorOrg.id).first()).name)
			.not.toBe(nextName);
		expect((await env.DB.prepare("SELECT organization_id FROM managed_projects WHERE id = ?").bind(project.id).first()).organization_id)
			.toBeNull();
		expect(owner.user.id).not.toBe(collaborator.user.id);
	});

	it("keeps a NULL-project invitation in the owner's organization when an organization admin sends it", async () => {
		const { collaborator, project, org } = await sharedProject("viewer");
		await changeOrgRole(org.id, collaborator.user.id, "admin");
		await removeProjectRole(project.id, collaborator.user.id);
		const collaboratorOrg = await ensureDefaultOrganization(env, collaborator.user.id);
		const invitee = await signup(`null-org-invitee-${newId("x")}`);

		const response = await request("/v1/settings/invitations", json("POST", {
			email: invitee.email,
			org_role: "member",
			project_role: "viewer",
		}, collaborator.cookie, project.id));
		expect(response.status).toBe(201);
		const invitation = await response.json();
		const stored = await env.DB.prepare(
			"SELECT org_id, project_id FROM organization_invitations WHERE id = ?",
		).bind(invitation.invitation.id).first();
		expect(stored).toMatchObject({ org_id: org.id, project_id: project.id });
		expect(stored.org_id).not.toBe(collaboratorOrg.id);

		const token = new URL(invitation.link).hash.slice("#invite=".length);
		const accepted = await request("/v1/settings/invitations/accept", json("POST", { token }, invitee.cookie));
		expect(accepted.status).toBe(200);
		const membership = await env.DB.prepare(
			"SELECT org_id, role FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, invitee.user.id).first();
		expect(membership).toMatchObject({ org_id: org.id, role: "viewer" });
		const listed = await request("/auth/projects", { headers: { cookie: invitee.cookie } });
		expect((await listed.json()).projects.map((row) => row.id)).toContain(project.id);
	});

	it("rejects a mismatched project-member organization on a genuine NULL-org project", async () => {
		const owner = await signup(`null-org-owner-${newId("x")}`);
		const outsider = await signup(`null-org-outsider-${newId("x")}`);
		const created = await request("/auth/projects", json("POST", { name: `Boundary ${newId("x")}` }, owner.cookie));
		expect(created.status).toBe(201);
		const { project } = await created.json();
		const ownerOrg = await ensureDefaultOrganization(env, owner.user.id);
		const outsiderOrg = await ensureDefaultOrganization(env, outsider.user.id);
		await expect(setProjectRole(env, project.id, outsiderOrg.id, outsider.user.id, "admin"))
			.rejects.toMatchObject({ code: "project_org_mismatch" });
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO project_members
			 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
		).bind(newId("prjm"), project.id, outsiderOrg.id, outsider.user.id, outsider.user.id, at, at).run();

		const direct = await request("/v1/settings", {
			headers: { cookie: outsider.cookie, "x-itsuki-project": project.id },
		});
		expect(direct.status).toBe(404);
		expect(await direct.json()).toMatchObject({ code: "project_not_found" });
		const listed = await request("/auth/projects", { headers: { cookie: outsider.cookie } });
		expect((await listed.json()).projects.map((row) => row.id)).not.toContain(project.id);

		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), ownerOrg.id, outsider.user.id, owner.user.id, at, at).run();
		// A forged row is never silently repaired by the creation helper. Remove
		// the invalid generation before granting a legitimate seat.
		await env.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
			.bind(project.id, outsider.user.id).run();
		await setProjectRole(env, project.id, ownerOrg.id, outsider.user.id, "viewer", owner.user.id);
		expect(await env.DB.prepare(
			"SELECT org_id, role FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, outsider.user.id).first()).toMatchObject({ org_id: ownerOrg.id, role: "viewer" });
		expect((await request("/v1/settings", {
			headers: { cookie: outsider.cookie, "x-itsuki-project": project.id },
		})).status).toBe(200);
	});

	it("does not disclose or mutate a forged cross-organization project-member row in owner Settings", async () => {
		const { owner, collaborator, project, org } = await sharedProject("member");
		const outsider = await signup(`forged-member-${newId("x")}`);
		const outsiderOrg = await ensureDefaultOrganization(env, outsider.user.id);
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO project_members
			 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
		).bind(newId("prjm"), project.id, outsiderOrg.id, outsider.user.id, outsider.user.id, at, at).run();

		const visible = await request("/v1/settings", {
			headers: { cookie: owner.cookie, "x-itsuki-project": project.id },
		});
		expect(visible.status).toBe(200);
		const visibleBody = await visible.json();
		expect(visibleBody.members.map((row) => row.user_id)).toContain(collaborator.user.id);
		expect(visibleBody.members.map((row) => row.user_id)).not.toContain(outsider.user.id);
		const legitimateRevision = visibleBody.members.find((row) => row.user_id === collaborator.user.id).revision;

		for (const method of ["PATCH", "DELETE"]) {
			const response = await request(
				`/v1/settings/members/${encodeURIComponent(outsider.user.id)}`,
				memberMutation(method, method === "PATCH" ? { role: "viewer" } : {}, owner.cookie, project.id, legitimateRevision),
			);
			expect(response.status, method).toBe(412);
			expect(await response.json()).toMatchObject({ error: "member_conflict" });
		}
		expect(await env.DB.prepare(
			"SELECT org_id, role FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, outsider.user.id).first()).toMatchObject({ org_id: outsiderOrg.id, role: "admin" });

		const legitimate = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "viewer" }, owner.cookie, project.id, legitimateRevision),
		);
		expect(legitimate.status).toBe(200);
		expect((await legitimate.json()).member.role).toBe("viewer");
		expect(org.id).not.toBe(outsiderOrg.id);
	});

	it("keeps a viewer read-only across memory, Playground, keys, rules, integrations and exports", async () => {
		const { collaborator, project, memoryOwnerUserId } = await sharedProject("viewer");
		const headers = { cookie: collaborator.cookie, "x-itsuki-project": project.id };

		expect((await request("/v1/graph", { headers })).status).toBe(200);
		expect((await request("/v1/settings", { headers })).status).toBe(200);
		await expectForbidden(await request("/v1/playground", { headers }), "project.playground.read");
		await expectForbidden(await request("/v1/playground/thread", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: "{ malformed and must not be parsed",
		}), "project.playground.use");
		await expectForbidden(await request("/v1/playground/preview", json("POST", {
			message: "A viewer must not spend preview quota.",
		}, collaborator.cookie, project.id)), "project.playground.use");

		await expectForbidden(await request("/v1/save", json("POST", {
			content: "A viewer must never persist this sentence.",
		}, collaborator.cookie, project.id)), "project.memory.write");
		await expectForbidden(await request("/v1/rules", json("PUT", {
			rules: { excludes: ["salary"] },
		}, collaborator.cookie, project.id)), "project.rules.edit");
		await expectForbidden(await request("/v1/playground/chat", json("POST", {
			message: "A viewer must not spend or capture a Playground turn.",
		}, collaborator.cookie, project.id)), "project.playground.use");
		await expectForbidden(await request("/v1/playground/thread", json("POST", {
			title: "Viewer thread",
		}, collaborator.cookie, project.id)), "project.playground.use");
		await expectForbidden(await request("/auth/tokens", json("POST", {
			type: "api", label: "Viewer key",
		}, collaborator.cookie, project.id)), "project.keys.manage");
		await expectForbidden(await request("/v1/webhooks", {
			headers,
		}), "project.integrations.view");
		await expectForbidden(await request("/v1/webhooks", json("POST", {
			name: "viewer hook", url: "https://example.com/hook", events: ["memory.added"],
		}, collaborator.cookie, project.id)), "project.integrations.manage");
		await expectForbidden(await request("/v1/export", { headers }), "project.export");
		await expectForbidden(await request("/v1/exports", { headers }), "project.export");
		await expectForbidden(await request("/v1/exports", json("POST", {
			entity: "Denied viewer export",
		}, collaborator.cookie, project.id)), "project.export");
		await expectForbidden(await request("/v1/exports/download?id=export_denied", { headers }), "project.export");
		const deniedExports = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_exports WHERE user_id = ?",
		).bind(memoryOwnerUserId).first();
		expect(Number(deniedExports?.n ?? 0)).toBe(0);
		await expectForbidden(await request("/v1/actions/delete-all", json("POST", {
			confirm: "DELETE ALL",
		}, collaborator.cookie, project.id)), "project.memory.delete");
	});

	it("authenticates export creation before reading a bounded body and leaves no denied job", async () => {
		const { collaborator, project, memoryOwnerUserId } = await sharedProject("viewer");
		const oversized = JSON.stringify({ entity: "x".repeat(17 * 1024) });
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_exports WHERE user_id = ?",
		).bind(memoryOwnerUserId).first();

		const unauthenticated = await request("/v1/exports", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(oversized.length) },
			body: oversized,
		});
		expect(unauthenticated.status).toBe(401);

		const viewer = await request("/v1/exports", {
			method: "POST",
			headers: {
				cookie: collaborator.cookie,
				"x-itsuki-project": project.id,
				"content-type": "application/json",
				"content-length": String(oversized.length),
			},
			body: oversized,
		});
		await expectForbidden(viewer, "project.export");
		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_exports WHERE user_id = ?",
		).bind(memoryOwnerUserId).first();
		expect(Number(after?.n ?? 0)).toBe(Number(before?.n ?? 0));
	});

	it("authenticates scoped memory reset before reading its bounded body", async () => {
		const { owner, project, memoryOwnerUserId } = await sharedProject("viewer");
		const at = Date.now();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Reset guard', 'project', 'active', ?, ?)",
		).bind(newId("node"), memoryOwnerUserId, at, at).run();
		const oversized = JSON.stringify({ confirm: "DELETE ALL", padding: "x".repeat(17 * 1024) });
		const denied = await request("/v1/actions/delete-all", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(oversized.length) },
			body: oversized,
		});
		expect(denied.status).toBe(401);
		expect(await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ? AND label = 'Reset guard'",
		).bind(memoryOwnerUserId).first()).not.toBeNull();

		const tooLarge = await request("/v1/actions/delete-all", {
			method: "POST",
			headers: {
				cookie: owner.cookie,
				"x-itsuki-project": project.id,
				"content-type": "application/json",
				"content-length": String(oversized.length),
			},
			body: oversized,
		});
		expect(tooLarge.status).toBe(413);
		expect(await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ? AND label = 'Reset guard'",
		).bind(memoryOwnerUserId).first()).not.toBeNull();
	});

	it("allows project members and admins through every export door", async () => {
		for (const role of ["member", "admin"]) {
			const { collaborator, project, memoryOwnerUserId } = await sharedProject(role);
			const headers = { cookie: collaborator.cookie, "x-itsuki-project": project.id };
			const readyId = `export_${role}_${crypto.randomUUID()}`;
			const data = JSON.stringify({ format: "itsuki-export", role });
			await env.DB.prepare(
				`INSERT INTO memory_exports
				 (id, user_id, status, format, entity, object_count, size_bytes, data, created_at, completed_at)
				 VALUES (?, ?, 'complete', 'json', 'All memories', 0, ?, ?, ?, ?)`,
			).bind(readyId, memoryOwnerUserId, data.length, data, Date.now(), Date.now()).run();

			const immediate = await request("/v1/export", { headers });
			expect(immediate.status, `${role} immediate export`).toBe(200);
			expect(immediate.headers.get("content-disposition")).toContain("attachment");

			const list = await request("/v1/exports", { headers });
			expect(list.status, `${role} export list`).toBe(200);
			expect((await list.json()).exports.map((row) => row.id)).toContain(readyId);

			const download = await request(`/v1/exports/download?id=${encodeURIComponent(readyId)}`, { headers });
			expect(download.status, `${role} export download`).toBe(200);
			expect(await download.json()).toEqual({ format: "itsuki-export", role });

			const before = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM memory_exports WHERE user_id = ?",
			).bind(memoryOwnerUserId).first();
			const created = await request("/v1/exports", json("POST", {
				entity: `${role} authorized export`,
			}, collaborator.cookie, project.id));
			expect(created.status, `${role} export create`).toBe(201);
			expect((await created.json()).export.id).toMatch(/^export_/);
			const after = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM memory_exports WHERE user_id = ?",
			).bind(memoryOwnerUserId).first();
			expect(Number(after?.n ?? 0)).toBe(Number(before?.n ?? 0) + 1);
		}
	});

	it("allows organization administrators to export without an explicit project seat", async () => {
		const { collaborator, project, org } = await sharedProject("viewer");
		await changeOrgRole(org.id, collaborator.user.id, "admin");
		await removeProjectRole(project.id, collaborator.user.id);
		const headers = { cookie: collaborator.cookie, "x-itsuki-project": project.id };
		expect((await request("/v1/export", { headers })).status).toBe(200);
		expect((await request("/v1/exports", { headers })).status).toBe(200);
	});

	it("lets members use Playground without granting policy, deletion, or graph repair", async () => {
		const { collaborator, project } = await sharedProject("member");
		const created = await request("/v1/playground/thread", json("POST", {
			title: "Member workspace",
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(200);
		const { thread } = await created.json();
		expect(thread?.id).toMatch(/^pgthread_/);
		expect((await request("/v1/playground", {
			headers: { cookie: collaborator.cookie, "x-itsuki-project": project.id },
		})).status).toBe(200);

		await expectForbidden(await request("/v1/playground/thread", json("POST", {
			delete: true,
			threadId: thread.id,
		}, collaborator.cookie, project.id)), "project.playground.delete");
		await expectForbidden(await request("/v1/playground/settings", json("PUT", {
			threadId: thread.id,
			settings: { capture: "always" },
		}, collaborator.cookie, project.id)), "project.playground.policy.edit");
		await expectForbidden(await request("/v1/actions/repair-graph", json("POST", {
			confirmJunk: true,
		}, collaborator.cookie, project.id)), "project.memory.delete");
		const oversized = await request("/v1/playground/thread", json("POST", {
			title: "x".repeat(17 * 1024),
		}, collaborator.cookie, project.id));
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ error: "request_too_large", limit: 16 * 1024 });

		const zeroScopeKey = await request("/auth/tokens", json("POST", {
			type: "api",
			label: "No memory scope",
			scopes: [],
		}, collaborator.cookie, project.id));
		expect(zeroScopeKey.status).toBe(201);
		const { token } = await zeroScopeKey.json();
		const choose = await request("/v1/mcp/choose", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ prompt: "choose a safe action" }),
		});
		expect(choose.status).toBe(403);
		expect(await choose.json()).toMatchObject({ error: "forbidden", code: "insufficient_scope" });
	});

	it("requires a literal delete operation and leaves the conversation intact on invalid input", async () => {
		const { owner, project } = await sharedProject("admin");
		const created = await request("/v1/playground/thread", json("POST", {
			title: "Keep this conversation",
		}, owner.cookie, project.id));
		expect(created.status).toBe(200);
		const { thread } = await created.json();

		const invalid = await request("/v1/playground/thread", json("POST", {
			delete: "false",
			threadId: thread.id,
		}, owner.cookie, project.id));
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: "invalid_delete" });

		const remaining = await request(`/v1/playground?thread=${encodeURIComponent(thread.id)}`, {
			headers: { cookie: owner.cookie, "x-itsuki-project": project.id },
		});
		expect(remaining.status).toBe(200);
		expect((await remaining.json()).threads.map((item) => item.id)).toContain(thread.id);
	});

	it("shares the MCP chooser quota across caller-controlled external user ids", async () => {
		const { collaborator, project } = await sharedProject("member");
		const created = await request("/auth/tokens", json("POST", {
			type: "api",
			label: "Chooser limiter",
			scopes: ["memory:read"],
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(201);
		const { token, tokenRecord } = await created.json();
		const oversized = await request("/v1/mcp/choose", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ request: "x".repeat(17 * 1024) }),
		});
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({ error: "request_too_large", limit: 16 * 1024 });

		const seen = [];
		const counts = new Map();
		const previousLimiter = env.SAVE_LIMITER;
		env.SAVE_LIMITER = {
			async limit({ key }) {
				seen.push(key);
				const count = (counts.get(key) ?? 0) + 1;
				counts.set(key, count);
				return { success: count === 1 };
			},
		};
		try {
			const choose = (userId) => request("/v1/mcp/choose", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ userId, request: "Thanks!" }),
			});
			expect((await choose("external-customer-a")).status).toBe(200);
			expect((await choose("external-customer-b")).status).toBe(429);
		} finally {
			env.SAVE_LIMITER = previousLimiter;
		}

		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
		expect(seen[0]).toContain(`token:${tokenRecord.id}`);
		expect(seen[0]).toContain(`project:${project.id}`);
		expect(seen[0]).not.toMatch(/external-customer/);
	});

	it("denies a viewer chooser use before limiter work and allows a member", async () => {
		const { collaborator, project, org, memoryOwnerUserId } = await sharedProject("viewer");
		const viewerKey = await request("/auth/tokens", json("POST", {
			type: "api", label: "Viewer chooser probe", scopes: ["memory:read"],
		}, collaborator.cookie, project.id));
		// Viewers cannot mint keys themselves. Seed one as an historical credential
		// while they still have a member seat, then exercise it after downgrade.
		expect(viewerKey.status).toBe(403);
		await changeProjectRole(project.id, org.id, collaborator.user.id, "member");
		const created = await request("/auth/tokens", json("POST", {
			type: "api", label: "Chooser role probe", scopes: ["memory:read"],
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(201);
		const { token } = await created.json();

		const previousLimiter = env.SAVE_LIMITER;
		let limiterCalls = 0;
		const durableCounts = () => env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM source_packets WHERE user_id = ?) AS packets,
				(SELECT COUNT(*) FROM extraction_runs WHERE user_id = ?) AS runs,
				(SELECT COUNT(*) FROM receipts WHERE user_id = ?) AS receipts`,
		).bind(memoryOwnerUserId, memoryOwnerUserId, memoryOwnerUserId).first();
		const before = await durableCounts();
		env.SAVE_LIMITER = {
			async limit() {
				limiterCalls += 1;
				return { success: true };
			},
		};
		try {
			await changeProjectRole(project.id, org.id, collaborator.user.id, "viewer");
			const denied = await request("/v1/mcp/choose", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ request: "Thanks!" }),
			});
			await expectForbidden(denied, "project.chooser.use");
			expect(limiterCalls).toBe(0);
			expect(await durableCounts()).toEqual(before);

			await changeProjectRole(project.id, org.id, collaborator.user.id, "member");
			const allowed = await request("/v1/mcp/choose", {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ request: "Thanks!" }),
			});
			expect(allowed.status).toBe(200);
			expect(limiterCalls).toBe(1);
		} finally {
			env.SAVE_LIMITER = previousLimiter;
		}
	});

	it("applies a role downgrade to an already-live session on the next request", async () => {
		const { owner, collaborator, project, org } = await sharedProject("admin");
		const save = () => request("/v1/save", json("POST", {
			content: "Role refresh probe",
			_test: { llmResponse: { objects: [] } },
		}, collaborator.cookie, project.id));

		expect((await save()).status).toBe(200);
		await changeProjectRole(project.id, org.id, collaborator.user.id, "viewer");
		await expectForbidden(await save(), "project.memory.write");
	});

	it("makes project membership mutations conditional, removal-winning and ABA-safe", async () => {
		const { owner, collaborator, project, org } = await sharedProject("admin");
		const readSettings = async () => (await request("/v1/settings", {
			headers: { cookie: owner.cookie, "x-itsuki-project": project.id },
		})).json();
		const first = (await readSettings()).members.find((row) => row.user_id === collaborator.user.id);
		expect(first.revision).toMatch(/^mrv1\.[0-9a-f]{64}\.[0-9a-f]{64}$/);

		const missing = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "viewer" }, owner.cookie, project.id),
		);
		expect(missing.status).toBe(428);
		expect(await missing.json()).toMatchObject({ error: "precondition_required" });
		const missingDelete = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id),
		);
		expect(missingDelete.status).toBe(428);
		expect(await missingDelete.json()).toMatchObject({ error: "precondition_required" });

		const changed = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "viewer" }, owner.cookie, project.id, first.revision),
		);
		expect(changed.status).toBe(200);
		const changedBody = await changed.json();
		expect(changedBody).toMatchObject({ changed: true, member: { role: "viewer" } });
		expect(changedBody.member.revision).not.toBe(first.revision);

		const stalePatch = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "member" }, owner.cookie, project.id, first.revision),
		);
		expect(stalePatch.status).toBe(412);
		expect(await stalePatch.json()).toMatchObject({ error: "member_conflict" });

		// Even though this is the pre-PATCH revision, it names the same immutable
		// generation, so DELETE wins and a later stale PATCH cannot resurrect it.
		const removed = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, first.revision),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toMatchObject({ removed: true, already_removed: false });
		const afterDeletePatch = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "admin" }, owner.cookie, project.id, changedBody.member.revision),
		);
		expect(afterDeletePatch.status).toBe(412);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, collaborator.user.id).first()).toMatchObject({ n: 0 });

		const replacement = await setProjectRole(
			env, project.id, org.id, collaborator.user.id, "member", owner.user.id,
		);
		const staleDelete = await request(
			`/v1/settings/members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, first.revision),
		);
		expect(staleDelete.status).toBe(412);
		expect(await staleDelete.json()).toMatchObject({ error: "member_conflict" });
		expect((await listProjectMembers(env, project.id)).find((row) => row.user_id === collaborator.user.id))
			.toMatchObject({ role: "member", revision: replacement.member.revision });

		const events = await env.DB.prepare(
			`SELECT action, metadata_json FROM audit_events
			  WHERE project_id = ? AND target_id = ?
			    AND outcome = 'ok'
			    AND action IN ('project.member.role_changed', 'project.member.removed')
			  ORDER BY created_at ASC`,
		).bind(project.id, collaborator.user.id).all();
		expect(events.results.map((row) => ({ action: row.action, metadata: JSON.parse(row.metadata_json) })))
			.toEqual([
				{ action: "project.member.role_changed", metadata: { project_role: { from: "admin", to: "viewer" } } },
				{ action: "project.member.removed", metadata: { project_role: { from: "viewer", to: null } } },
			]);
	});

	it("removes organization access atomically without letting a stale delete touch a replacement", async () => {
		const { owner, collaborator, project, org } = await sharedProject("viewer");
		const settings = await (await request("/v1/settings", {
			headers: { cookie: owner.cookie, "x-itsuki-project": project.id },
		})).json();
		const first = settings.org_members.find((row) => row.user_id === collaborator.user.id);
		const missingDelete = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id),
		);
		expect(missingDelete.status).toBe(428);
		expect(await missingDelete.json()).toMatchObject({ error: "precondition_required" });

		const changed = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("PATCH", { role: "admin" }, owner.cookie, project.id, first.revision),
		);
		expect(changed.status).toBe(200);
		const changedBody = await changed.json();
		expect(changedBody).toMatchObject({ changed: true, member: { role: "admin" } });

		const removed = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, first.revision),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toMatchObject({ removed: true, already_removed: false });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_members WHERE org_id = ? AND user_id = ?",
		).bind(org.id, collaborator.user.id).first()).toMatchObject({ n: 0 });

		const repeated = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, changedBody.member.revision),
		);
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({ removed: false, already_removed: true });

		const at = Date.now() + 1;
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, collaborator.user.id, owner.user.id, at, at).run();
		await setProjectRole(env, project.id, org.id, collaborator.user.id, "viewer", owner.user.id);
		const staleDelete = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, first.revision),
		);
		expect(staleDelete.status).toBe(412);
		expect(await staleDelete.json()).toMatchObject({ error: "member_conflict" });
		expect((await listProjectMembers(env, project.id)).find((row) => row.user_id === collaborator.user.id).role)
			.toBe("viewer");

		const auditCount = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM audit_events WHERE action = 'org.member.removed' AND target_id = ? AND outcome = 'ok'",
		).bind(collaborator.user.id).first();
		expect(Number(auditCount.n)).toBe(1);
	});

	it("quarantines implicit organization-admin project keys permanently while preserving personal keys", async () => {
		const { owner, collaborator, project, org } = await sharedProject("viewer");
		await changeOrgRole(org.id, collaborator.user.id, "admin");
		await removeProjectRole(project.id, collaborator.user.id);
		const sharedKeyResponse = await request("/auth/tokens", json("POST", {
			type: "api", label: "Implicit org admin key", scopes: ["memory:read"],
		}, collaborator.cookie, project.id));
		expect(sharedKeyResponse.status).toBe(201);
		const sharedKey = await sharedKeyResponse.json();

		const projects = await (await request("/auth/projects", { headers: { cookie: collaborator.cookie } })).json();
		const personalProject = projects.projects.find((row) => row.owner_user_id === collaborator.user.id && row.is_default);
		expect(personalProject?.id).toMatch(/^proj_/);
		const personalKeyResponse = await request("/auth/tokens", json("POST", {
			type: "api", label: "Personal key", scopes: ["memory:read"],
		}, collaborator.cookie, personalProject.id));
		expect(personalKeyResponse.status).toBe(201);
		const personalKey = await personalKeyResponse.json();

		const member = (await listOrganizationMembers(env, org.id))
			.find((row) => row.user_id === collaborator.user.id);
		const removed = await request(
			`/v1/settings/org-members/${encodeURIComponent(collaborator.user.id)}`,
			memberMutation("DELETE", {}, owner.cookie, project.id, member.revision),
		);
		expect(removed.status).toBe(200);
		const at = Date.now() + 1;
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, collaborator.user.id, owner.user.id, at, at).run();

		const oldShared = await request("/v1/graph", {
			headers: { authorization: `Bearer ${sharedKey.token}` },
		});
		expect(oldShared.status).toBe(401);
		expect(await env.DB.prepare("SELECT revoked_at FROM connection_tokens WHERE id = ?")
			.bind(sharedKey.tokenRecord.id).first()).toEqual({ revoked_at: expect.any(Number) });
		expect(await env.DB.prepare("SELECT revoked_at FROM connection_tokens WHERE id = ?")
			.bind(personalKey.tokenRecord.id).first()).toEqual({ revoked_at: null });
		expect((await request("/v1/graph", {
			headers: { authorization: `Bearer ${personalKey.token}` },
		})).status).toBe(200);
	});

	it("binds a member-created key to shared storage and refreshes HTTP and MCP access", async () => {
		const { owner, collaborator, project, org, memoryOwnerUserId } = await sharedProject("member");
		const created = await request("/auth/tokens", json("POST", {
			type: "api",
			label: "Shared project agent",
			scopes: ["memory:read", "memory:write"],
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(201);
		const { token, tokenRecord } = await created.json();
		expect(tokenRecord.project_id).toBe(project.id);

		const boundary = await env.DB.prepare(
			"SELECT memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(project.id).first();
		expect(boundary?.memory_owner_user_id).toBe(memoryOwnerUserId);
		expect(boundary?.memory_owner_user_id).toMatch(/^mem_/);
		expect(boundary?.memory_owner_user_id).not.toBe(owner.user.id);
		expect(boundary?.memory_owner_user_id).not.toBe(collaborator.user.id);

		const tokenJson = (path, body, projectId = null) => request(path, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...(projectId ? { "x-itsuki-project": projectId } : {}),
			},
			body: JSON.stringify(body),
		});
		const save = (content = "Shared credential boundary probe") => tokenJson("/v1/save", {
			content,
			_test: { llmResponse: { objects: [] } },
		});
		expect((await save()).status).toBe(200);
		const packet = await env.DB.prepare(
			"SELECT user_id, owner_user_id, managed_project_id FROM source_packets WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(boundary.memory_owner_user_id).first();
		expect(packet).toMatchObject({
			user_id: boundary.memory_owner_user_id,
			owner_user_id: boundary.memory_owner_user_id,
			managed_project_id: project.id,
		});
		const scopedSave = await tokenJson("/v1/save", {
			content: "Scoped registry boundary probe",
			userId: "external-customer-one",
			_test: { llmResponse: { objects: [] } },
		});
		expect(scopedSave.status).toBe(200);
		const scopedPacket = await env.DB.prepare(
			`SELECT user_id, owner_user_id, managed_project_id FROM source_packets
			  WHERE managed_project_id = ? AND user_id <> ?
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(project.id, memoryOwnerUserId).first();
		expect(scopedPacket).toMatchObject({
			owner_user_id: memoryOwnerUserId,
			managed_project_id: project.id,
		});
		const scopedMemoryId = scopedPacket.user_id;
		expect(scopedMemoryId).toMatch(/^mem_/);
		expect(scopedMemoryId).not.toBe(memoryOwnerUserId);
		const spaces = await env.DB.prepare(
			"SELECT memory_owner_user_id, memory_user_id FROM project_memory_spaces WHERE project_id = ? ORDER BY memory_user_id",
		).bind(project.id).all();
		expect(spaces.results).toEqual(expect.arrayContaining([
			{ memory_owner_user_id: memoryOwnerUserId, memory_user_id: memoryOwnerUserId },
			{ memory_owner_user_id: memoryOwnerUserId, memory_user_id: scopedMemoryId },
		]));

		const collaboratorProjects = await (await request("/auth/projects", {
			headers: { cookie: collaborator.cookie },
		})).json();
		const collaboratorDefault = collaboratorProjects.projects.find((item) => item.owner_user_id === collaborator.user.id);
		expect(collaboratorDefault?.id).toMatch(/^proj_/);
		const switched = await request("/v1/graph", {
			headers: {
				authorization: `Bearer ${token}`,
				"x-itsuki-project": collaboratorDefault.id,
			},
		});
		expect(switched.status).toBe(403);
		expect(await switched.json()).toMatchObject({ code: "project_scope_mismatch" });

		await changeProjectRole(project.id, org.id, collaborator.user.id, "viewer");
		expect((await request("/v1/graph", {
			headers: { authorization: `Bearer ${token}` },
		})).status).toBe(200);
		const deniedHttpContent = "HTTP downgrade write must fail";
		await expectForbidden(await save(deniedHttpContent), "project.memory.write");

		const recall = await mcpCall(token, "recall_memory", { query: "shared boundary probe" });
		expect(recall.status).toBe(200);
		expect(await recall.text()).toContain("structuredContent");
		const deniedMcpContent = "Viewer MCP write must fail";
		const deniedSave = await mcpCall(token, "save_memory", { content: deniedMcpContent });
		expect(deniedSave.status).toBe(200);
		// A downgraded role narrows the connection on the next request: the
		// write tools stop being offered, and calling one anyway still fails.
		// Either refusal shape is correct — what matters is the write below.
		const deniedText = await deniedSave.text();
		expect(
			/insufficient_scope|"isError":true|not found/.test(deniedText),
			deniedText.slice(0, 200),
		).toBe(true);
		const deniedWrites = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ? AND text IN (?, ?)",
		).bind(memoryOwnerUserId, deniedHttpContent, deniedMcpContent).first();
		expect(Number(deniedWrites?.n ?? 0)).toBe(0);

		await removeProjectRole(project.id, collaborator.user.id);
		const removedHttp = await request("/v1/graph", {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(removedHttp.status).toBe(401);
		expect(await removedHttp.json()).toMatchObject({ error: "unauthorized" });
		const removedMcp = await mcpCall(token, "recall_memory", { query: "must be blocked" });
		expect(removedMcp.status).toBe(401);
		await setProjectRole(env, project.id, org.id, collaborator.user.id, "member", owner.user.id);
		expect((await request("/v1/graph", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
	});

	it("never lets managed credential or request rules erase the project policy across doors", async () => {
		const { collaborator, project, memoryOwnerUserId } = await sharedProject("member");
		await saveMemoryRules(env, memoryOwnerUserId, { excludes: ["salary"] });
		const created = await request("/auth/tokens", json("POST", {
			type: "api",
			label: "Narrow-only policy key",
			scopes: ["memory:read", "memory:write"],
			rules: { excludes: ["health"] },
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(201);
		const { token } = await created.json();
		const tokenJson = (path, body) => request(path, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const objects = (blockedLabel, allowedLabel) => ({ objects: [
			{ kind: "node", label: blockedLabel, category: "other", confidence: 0.95 },
			{ kind: "slice", on: blockedLabel, text: "Salary is confidential", kind_detail: "fact", confidence: 0.95 },
			{ kind: "node", label: allowedLabel, category: "place", confidence: 0.95 },
			{ kind: "slice", on: allowedLabel, text: `Moved to ${allowedLabel}`, kind_detail: "fact", confidence: 0.95 },
		] });

		const direct = await tokenJson("/v1/save", {
			content: "My salary is confidential and I moved to Aveiro.",
			rules: { excludes: ["address"] },
			_test: { llmResponse: objects("Salary direct", "Aveiro") },
		});
		expect(direct.status).toBe(200);
		expect(Object.keys((await direct.json()).receipt?.skippedReasons ?? {})).toContain("excluded_by_rule");

		const ingest = await tokenJson("/v1/ingest", {
			flush: true,
			messages: [{ id: "managed-ingest", role: "user", content: "My salary changed and I moved to Braga." }],
			rules: { excludes: ["address"] },
			_test: { llmResponse: objects("Salary ingest", "Braga") },
		});
		expect(ingest.status).toBe(200);

		const turn = await tokenJson("/v1/turn", {
			messages: [{ id: "managed-turn", role: "user", content: "My salary changed and I moved to Porto." }],
			rules: { excludes: ["address"] },
			_test: { llmResponse: objects("Salary turn", "Porto") },
		});
		expect(turn.status).toBe(200);

		const mcp = await mcpCall(token, "save_conversation", {
			messages: [{ id: "managed-mcp", role: "user", content: "My salary is one hundred thousand." }],
			idempotencyKey: `managed-policy-${crypto.randomUUID()}`,
		});
		expect(mcp.status).toBe(200);
		expect(await mcp.text()).toMatch(/excluded by the project.*policy/i);

		const { results } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(memoryOwnerUserId).all();
		const labels = results.map((row) => row.label);
		expect(labels).toContain("Aveiro");
		expect(labels).not.toEqual(expect.arrayContaining(["Salary direct", "Salary ingest", "Salary turn"]));
		const mcpLeak = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM staged_memories WHERE user_id = ? AND text LIKE '%salary%'",
		).bind(memoryOwnerUserId).first();
		expect(Number(mcpLeak?.n ?? 0)).toBe(0);
	});

	it("refreshes queued managed parent policy while retaining credential and request narrowing", async () => {
		const { collaborator, project, memoryOwnerUserId } = await sharedProject("member");
		// Make the actor's personal policy explicitly weaker. A shared-project
		// drain must never confuse this row with the immutable memory owner's.
		await saveMemoryRules(env, collaborator.user.id, { excludes: [] });
		const created = await request("/auth/tokens", json("POST", {
			type: "api",
			label: "Queued policy refresh key",
			scopes: ["memory:read", "memory:write"],
			rules: { excludes: ["health"] },
		}, collaborator.cookie, project.id));
		expect(created.status).toBe(201);
		const { token } = await created.json();
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(memoryOwnerUserId));
		const setHeld = (held) => runInDurableObject(stub, async (_instance, state) => {
			if (held) await state.storage.put("lease", { until: Date.now() + 120_000, token: "managed-policy-hold" });
			else await state.storage.delete("lease");
		});
		const ingest = (id, content, llmResponse) => request("/v1/ingest", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				flush: true,
				messages: [{ id, role: "user", content }],
				rules: { excludes: ["address"] },
				_test: { llmResponse },
			}),
		});
		const proposal = (objects) => ({ objects, notes: "" });
		const fact = (label, text, category = "project") => [
			{ kind: "node", label, category, confidence: 0.95 },
			{ kind: "slice", on: label, text, kind_detail: "fact", confidence: 0.95 },
		];

		// Tightening after durable acceptance reaches the queued write.
		await saveMemoryRules(env, memoryOwnerUserId, { excludes: [] });
		await setHeld(true);
		expect((await ingest(
			"managed-policy-tighten",
			"The Falcon queue runs its smoke suite first.",
			proposal(fact("Falcon queued policy", "Runs its smoke suite first")),
		)).status).toBe(200);
		await saveMemoryRules(env, memoryOwnerUserId, { excludes: ["falcon"] });
		await setHeld(false);
		await stub.drain({ userId: memoryOwnerUserId, maxJobs: 8 });
		expect((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND label = ? AND deleted_at IS NULL",
		).bind(memoryOwnerUserId, "Falcon queued policy").first()).n).toBe(0);
		await stub.resetAll();

		// Relaxing the parent permits Falcon, while immutable key/request child
		// layers still deny Health and Address rather than disappearing on reload.
		await saveMemoryRules(env, memoryOwnerUserId, { excludes: ["falcon"] });
		await setHeld(true);
		expect((await ingest(
			"managed-policy-relax",
			"Falcon runs smoke tests. Health telemetry is private. Address records are private.",
			proposal([
				...fact("Falcon relaxed policy", "Runs smoke tests"),
				...fact("Health queued policy", "Health telemetry is private", "health"),
				...fact("Address queued policy", "Address records are private", "place"),
			]),
		)).status).toBe(200);
		await saveMemoryRules(env, memoryOwnerUserId, { excludes: [] });
		await setHeld(false);
		await stub.drain({ userId: memoryOwnerUserId, maxJobs: 8 });
		const labels = (await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(memoryOwnerUserId).all()).results.map((row) => row.label);
		expect(labels).toContain("Falcon relaxed policy");
		expect(labels).not.toEqual(expect.arrayContaining(["Health queued policy", "Address queued policy"]));
		await stub.resetAll();
	}, 30_000);

	it("does not reveal a same-named project from another organization", async () => {
		const alpha = await signup(`rbac-alpha-${newId("x")}`);
		const beta = await signup(`rbac-beta-${newId("x")}`);
		const accounts = [];
		for (const account of [alpha, beta]) {
			const created = await request("/auth/projects", json("POST", {
				name: "Identical project",
			}, account.cookie));
			expect(created.status).toBe(201);
			const { project } = await created.json();
			const org = await ensureDefaultOrganization(env, account.user.id);
			await env.DB.prepare(
				"UPDATE managed_projects SET organization_id = ?, updated_at = ? WHERE id = ?",
			).bind(org.id, Date.now(), project.id).run();
			accounts.push({ account, project, org });
		}

		const alphaProjects = await (await request("/auth/projects", { headers: { cookie: alpha.cookie } })).json();
		const betaProjects = await (await request("/auth/projects", { headers: { cookie: beta.cookie } })).json();
		const alphaProject = accounts[0].project;
		const betaProject = accounts[1].project;
		expect(alphaProject.id).not.toBe(betaProject.id);
		expect(accounts[0].org.id).not.toBe(accounts[1].org.id);
		expect(alphaProjects.projects.map((project) => project.id)).toContain(alphaProject.id);
		expect(alphaProjects.projects.map((project) => project.id)).not.toContain(betaProject.id);
		expect(betaProjects.projects.map((project) => project.id)).toContain(betaProject.id);
		expect(betaProjects.projects.map((project) => project.id)).not.toContain(alphaProject.id);

		const forged = await request("/v1/graph", {
			headers: { cookie: alpha.cookie, "x-itsuki-project": betaProject.id },
		});
		expect(forged.status).toBe(404);
		expect(await forged.json()).toMatchObject({
			error: "project_not_found",
			code: "project_not_found",
		});
	});
});
