/** Enterprise General settings: opaque CAS and organization-owned creation. */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { ensureDefaultOrganization, setProjectRole } from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie, { projectId = null, ifMatch = null } = {}) {
	return {
		method,
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
			...(projectId ? { "x-itsuki-project": projectId } : {}),
			...(ifMatch ? { "if-match": ifMatch } : {}),
		},
		body: JSON.stringify(body),
	};
}

function cookieFrom(response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function signup(label) {
	const email = `${label}-${crypto.randomUUID()}@example.com`;
	const password = "correct-horse";
	const response = await request("/auth/signup", json("POST", {
		email, password, name: label, acceptTerms: true,
	}));
	expect(response.status).toBe(201);
	return { email, password, cookie: cookieFrom(response), ...(await response.json()) };
}

async function secondSession(account) {
	const response = await request("/auth/login", json("POST", {
		email: account.email, password: account.password,
	}));
	expect(response.status).toBe(200);
	const cookie = cookieFrom(response);
	expect(cookie).not.toBe(account.cookie);
	return cookie;
}

async function settings(cookie, projectId = null) {
	const response = await request("/v1/settings", {
		headers: { cookie, ...(projectId ? { "x-itsuki-project": projectId } : {}) },
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function createProject(cookie, body, projectId = null) {
	return request("/auth/projects", json("POST", body, cookie, { projectId }));
}

function oneWinnerOneConflict(responses) {
	expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 412]);
	return {
		winner: responses.find((response) => response.status === 200),
		conflict: responses.find((response) => response.status === 412),
	};
}

describe("General settings compare-and-set", () => {
	it("returns opaque revisions and requires If-Match on every General writer", async () => {
		const account = await signup("general-precondition");
		const current = await settings(account.cookie);
		expect(current.project.revision).toMatch(/^prv1\.[0-9a-f]{64}$/);
		expect(current.organization.revision).toMatch(/^orv1\.[0-9a-f]{64}$/);
		// The General usage row reads {used, limit, unit} — served for real now,
		// so the dashboard's "No project quota is configured" branch is dead.
		expect(current.project_usage).toMatchObject({ used: 0, unit: "AI saves this month" });
		expect(current.project_usage.limit).toBeGreaterThan(0);

		for (const [path, body] of [
			["/v1/settings/project", { name: "Blind project overwrite" }],
			["/v1/settings/organization", { name: "Blind org overwrite" }],
			[`/auth/projects/${current.project.id}`, { name: "Blind legacy overwrite" }],
		]) {
			const response = await request(path, json("PATCH", body, account.cookie, {
				projectId: current.project.id,
			}));
			expect(response.status, path).toBe(428);
			expect(await response.json()).toMatchObject({
				error: "precondition_required", code: "precondition_required",
			});
		}
	});

	it("authenticates before bounded parsing on the legacy project writer", async () => {
		const account = await signup("general-bounded-legacy");
		const current = await settings(account.cookie);
		const oversized = JSON.stringify({ description: "x".repeat(20 * 1024) });

		const anonymous = await request(`/auth/projects/${current.project.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "if-match": current.project.revision },
			body: oversized,
		});
		expect(anonymous.status).toBe(401);

		const authenticated = await request(`/auth/projects/${current.project.id}`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				cookie: account.cookie,
				"if-match": current.project.revision,
			},
			body: oversized,
		});
		expect(authenticated.status).toBe(413);
		expect(await authenticated.json()).toMatchObject({ error: "request_too_large" });
	});

	it("allows one project update across two sessions and closes the legacy PATCH bypass", async () => {
		const account = await signup("project-general-race");
		const otherCookie = await secondSession(account);
		const initial = await settings(account.cookie);
		const projectId = initial.project.id;
		const otherRead = await settings(otherCookie, projectId);
		expect(otherRead.project.revision).toBe(initial.project.revision);

		const responses = await Promise.all([
			request("/v1/settings/project", json("PATCH", {
				name: "Settings winner candidate", description: "first session",
			}, account.cookie, { projectId, ifMatch: initial.project.revision })),
			request(`/auth/projects/${projectId}`, json("PATCH", {
				name: "Legacy winner candidate", description: "second session",
			}, otherCookie, { ifMatch: otherRead.project.revision })),
		]);
		const { winner, conflict } = oneWinnerOneConflict(responses);
		const winnerBody = await winner.json();
		const conflictBody = await conflict.json();
		expect(conflictBody).toMatchObject({
			error: "project_conflict", code: "project_conflict", project: winnerBody.project,
		});
		expect(winnerBody.project.revision).not.toBe(initial.project.revision);
		const final = await settings(account.cookie, projectId);
		expect(final.project).toEqual(winnerBody.project);

		const audits = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM audit_events WHERE project_id = ? AND action = 'project.updated'",
		).bind(projectId).first();
		expect(Number(audits?.n ?? 0)).toBe(2);
		const outcomes = await env.DB.prepare(
			"SELECT outcome FROM audit_events WHERE project_id = ? AND action = 'project.updated' ORDER BY outcome",
		).bind(projectId).all();
		expect(outcomes.results.map((row) => row.outcome).sort()).toEqual(["conflict", "ok"]);
	});

	it("allows one organization update across two live sessions", async () => {
		const account = await signup("org-general-race");
		const otherCookie = await secondSession(account);
		const [left, right] = await Promise.all([settings(account.cookie), settings(otherCookie)]);
		expect(right.organization.revision).toBe(left.organization.revision);

		const responses = await Promise.all([
			request("/v1/settings/organization", json("PATCH", {
				name: "Organization Alpha", description: "first session",
			}, account.cookie, { projectId: left.project.id, ifMatch: left.organization.revision })),
			request("/v1/settings/organization", json("PATCH", {
				name: "Organization Beta", description: "second session",
			}, otherCookie, { projectId: right.project.id, ifMatch: right.organization.revision })),
		]);
		const { winner, conflict } = oneWinnerOneConflict(responses);
		const winnerBody = await winner.json();
		const conflictBody = await conflict.json();
		expect(conflictBody).toMatchObject({
			error: "organization_conflict",
			code: "organization_conflict",
			organization: winnerBody.organization,
		});
		expect(winnerBody.organization.revision).not.toBe(left.organization.revision);
		const final = await settings(account.cookie);
		expect(final.organization).toEqual(winnerBody.organization);

		const audits = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ? AND action = 'org.updated'",
		).bind(final.organization.id).first();
		expect(Number(audits?.n ?? 0)).toBe(2);
		const outcomes = await env.DB.prepare(
			"SELECT outcome FROM audit_events WHERE org_id = ? AND action = 'org.updated' ORDER BY outcome",
		).bind(final.organization.id).all();
		expect(outcomes.results.map((row) => row.outcome).sort()).toEqual(["conflict", "ok"]);
	});
});

describe("organization-scoped project creation", () => {
	it("creates under the selected organization and keeps its storage owner immutable", async () => {
		const owner = await signup("org-project-owner");
		const selected = await settings(owner.cookie);
		const createdResponse = await createProject(owner.cookie, {
			name: "Enterprise Atlas",
			description: "Organization memory workspace",
			organization_id: selected.organization.id,
		}, selected.project.id);
		expect(createdResponse.status).toBe(201);
		const { project } = await createdResponse.json();
		expect(project).toMatchObject({
			organization_id: selected.organization.id,
			owner_user_id: owner.user.id,
			name: "Enterprise Atlas",
		});
		expect(project.revision).toMatch(/^prv1\.[0-9a-f]{64}$/);

		const boundary = await env.DB.prepare(
			"SELECT owner_user_id, organization_id, memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(project.id).first();
		expect(boundary).toMatchObject({ owner_user_id: owner.user.id, organization_id: selected.organization.id });
		expect(boundary.memory_owner_user_id).toMatch(/^mem_/);
		expect(boundary.memory_owner_user_id).not.toBe(owner.user.id);

		const orgRename = await request("/v1/settings/organization", json("PATCH", {
			name: "Renamed organization",
		}, owner.cookie, { projectId: project.id, ifMatch: selected.organization.revision }));
		expect(orgRename.status).toBe(200);
		expect((await env.DB.prepare(
			"SELECT memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(project.id).first()).memory_owner_user_id).toBe(boundary.memory_owner_user_id);
	});

	it("lets an organization admin create, denies members and foreign organization ids", async () => {
		const owner = await signup("org-create-owner");
		const admin = await signup("org-create-admin");
		const member = await signup("org-create-member");
		const base = await settings(owner.cookie);
		const org = await ensureDefaultOrganization(env, owner.user.id);
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
			).bind(newId("orgm"), org.id, admin.user.id, owner.user.id, at, at),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), org.id, member.user.id, owner.user.id, at, at),
		]);
		await setProjectRole(env, base.project.id, org.id, member.user.id, "admin", owner.user.id);

		const created = await createProject(admin.cookie, {
			name: "Admin-created project",
			organization_id: org.id,
		}, base.project.id);
		expect(created.status).toBe(201);
		const adminProject = (await created.json()).project;
		expect(adminProject).toMatchObject({ organization_id: org.id, owner_user_id: owner.user.id });
		const stored = await env.DB.prepare(
			"SELECT owner_user_id, memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(adminProject.id).first();
		expect(stored.owner_user_id).toBe(owner.user.id);
		expect(stored.memory_owner_user_id).not.toBe(admin.user.id);
		expect((await (await request("/auth/projects", { headers: { cookie: owner.cookie } })).json())
			.projects.map((item) => item.id)).toContain(adminProject.id);

		const deniedMember = await createProject(member.cookie, {
			name: "Member must not create", organization_id: org.id,
		}, base.project.id);
		expect(deniedMember.status).toBe(403);
		expect(await deniedMember.json()).toMatchObject({ error: "forbidden", capability: "project.create" });

		const adminOwnOrg = await ensureDefaultOrganization(env, admin.user.id);
		const deniedForeign = await createProject(admin.cookie, {
			name: "Cross-org forgery", organization_id: adminOwnOrg.id,
		}, base.project.id);
		expect(deniedForeign.status).toBe(403);
		expect(await deniedForeign.json()).toMatchObject({ error: "forbidden", capability: "project.create" });
		expect(await env.DB.prepare(
			"SELECT id FROM managed_projects WHERE name = 'Cross-org forgery'",
		).first()).toBeNull();
	});
});
