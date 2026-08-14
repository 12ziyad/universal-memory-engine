import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie, projectId = null) {
	return {
		method,
		headers: {
			"content-type": "application/json",
			cookie,
			...(projectId ? { "x-itsuki-project": projectId } : {}),
		},
		body: JSON.stringify(body),
	};
}

async function signup() {
	const response = await request("/auth/signup", json("POST", {
		email: `project-scope-${crypto.randomUUID()}@example.com`,
		password: "correct-horse",
		name: "Project scope owner",
		acceptTerms: true,
	}, ""));
	expect(response.status).toBe(201);
	return { cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function createOrganization(cookie, name) {
	const response = await request("/auth/organizations", json("POST", { name }, cookie));
	expect(response.status).toBe(201);
	return response.json();
}

describe("effective-organization project-name uniqueness", () => {
	it("allows one owner to reuse a project name across organizations but rejects it within one organization", async () => {
		const account = await signup();
		const north = await createOrganization(account.cookie, "North division");
		const south = await createOrganization(account.cookie, "South division");
		const name = "Shared roadmap";

		const northCreate = await request("/auth/projects", json("POST", {
			name,
			organization_id: north.organization.id,
		}, account.cookie, north.project.id));
		expect(northCreate.status).toBe(201);
		const northProject = (await northCreate.json()).project;

		const southCreate = await request("/auth/projects", json("POST", {
			name,
			organization_id: south.organization.id,
		}, account.cookie, south.project.id));
		expect(southCreate.status).toBe(201);
		const southProject = (await southCreate.json()).project;
		expect(southProject.id).not.toBe(northProject.id);
		expect(southProject.organization_id).toBe(south.organization.id);
		expect(northProject.organization_id).toBe(north.organization.id);

		const collision = await request("/auth/projects", json("POST", {
			name,
			organization_id: north.organization.id,
		}, account.cookie, north.project.id));
		expect(collision.status).toBe(409);
		expect(await collision.json()).toMatchObject({
			error: "project_name_exists",
			code: "project_name_exists",
		});

		const rows = await env.DB.prepare(
			`SELECT organization_id, COUNT(*) AS n FROM managed_projects
			  WHERE name_normalized = ? AND status = 'active'
			  GROUP BY organization_id ORDER BY organization_id`,
		).bind(name.toLowerCase()).all();
		expect(rows.results).toHaveLength(2);
		expect(rows.results.every((row) => Number(row.n) === 1)).toBe(true);
	});
});
