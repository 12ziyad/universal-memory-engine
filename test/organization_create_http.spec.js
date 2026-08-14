import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie = null) {
	return {
		method,
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
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
	return { user: body.user, cookie: response.headers.get("set-cookie").split(";")[0] };
}

describe("organization create and discovery", () => {
	it("atomically creates a permanent owner seat and immutable-memory starter project", async () => {
		const account = await signup("org-owner");
		const response = await request("/auth/organizations", json("POST", {
			name: "Acme Research",
			description: "Internal research group",
		}, account.cookie));
		expect(response.status).toBe(201);
		const created = await response.json();
		expect(created.organization).toMatchObject({
			name: "Acme Research",
			description: "Internal research group",
			is_default: false,
			owner_user_id: account.user.id,
			owner: { id: account.user.id },
			member_count: 1,
			project_count: 1,
		});
		expect(created.organization.revision).toMatch(/^orv1\./);
		expect(created.project).toMatchObject({
			organization_id: created.organization.id,
			effective_organization_id: created.organization.id,
			organization_name: "Acme Research",
			organization_role: "owner",
			owner_user_id: account.user.id,
			is_default: false,
		});
		expect(created.project.revision).toMatch(/^prv1\./);

		const stored = await env.DB.prepare(
			"SELECT memory_owner_user_id, organization_id FROM managed_projects WHERE id = ?",
		).bind(created.project.id).first();
		expect(stored.memory_owner_user_id).toMatch(/^mem_[0-9a-f]{32}$/);
		expect(stored.memory_owner_user_id).not.toBe(account.user.id);
		expect(stored.organization_id).toBe(created.organization.id);
		const controlRows = await env.DB.batch([
			env.DB.prepare("SELECT role, access_starts_at, access_expires_at FROM organization_members WHERE org_id = ? AND user_id = ?")
				.bind(created.organization.id, account.user.id),
			env.DB.prepare("SELECT role, org_id FROM project_members WHERE project_id = ? AND user_id = ?")
				.bind(created.project.id, account.user.id),
			env.DB.prepare("SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?")
				.bind(created.project.id),
		]);
		expect(controlRows[0].results[0]).toEqual({ role: "owner", access_starts_at: null, access_expires_at: null });
		expect(controlRows[1].results[0]).toEqual({ role: "admin", org_id: created.organization.id });
		expect(controlRows[2].results[0]).toEqual({ memory_user_id: stored.memory_owner_user_id });

		const organizations = await (await request("/auth/organizations", {
			headers: { cookie: account.cookie },
		})).json();
		expect(organizations.organizations).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: created.organization.id, role: "owner", access_status: "permanent", project_count: 1 }),
		]));
		const projects = await (await request("/auth/projects", { headers: { cookie: account.cookie } })).json();
		expect(projects.projects).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: created.project.id,
				effective_organization_id: created.organization.id,
				organization_name: "Acme Research",
				organization_role: "owner",
			}),
		]));
	});

	it("does not disclose another account's organization or leave partial rows on a failed create", async () => {
		const owner = await signup("org-isolation-owner");
		const stranger = await signup("org-isolation-stranger");
		const created = await (await request("/auth/organizations", json("POST", {
			name: "Private tenant",
		}, owner.cookie))).json();
		const strangerOrganizations = await (await request("/auth/organizations", {
			headers: { cookie: stranger.cookie },
		})).json();
		expect(strangerOrganizations.organizations.map((row) => row.id)).not.toContain(created.organization.id);
		const strangerProjects = await (await request("/auth/projects", {
			headers: { cookie: stranger.cookie },
		})).json();
		expect(strangerProjects.projects.map((row) => row.id)).not.toContain(created.project.id);

		const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?")
			.bind(owner.user.id).first();
		const invalid = await request("/auth/organizations", json("POST", {
			name: "Private tenant",
			description: { not: "text" },
		}, owner.cookie));
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ code: "invalid_org_description" });
		const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ?")
			.bind(owner.user.id).first();
		expect(after.n).toBe(before.n);
	});

	it("authenticates before bounded JSON parsing", async () => {
		const unauthenticated = await request("/auth/organizations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(20_000),
		});
		expect(unauthenticated.status).toBe(401);
		const account = await signup("org-bounds");
		const oversized = await request("/auth/organizations", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: account.cookie },
			body: JSON.stringify({ name: "x".repeat(20_000) }),
		});
		expect(oversized.status).toBe(413);
	});
});
