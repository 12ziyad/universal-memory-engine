import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

async function request(path, init = {}) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`https://itsuki.app${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie = "") {
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
	return {
		user: body.user,
		cookie: response.headers.get("set-cookie").split(";")[0],
	};
}

describe("account bootstrap HTTP contract", () => {
	it("completes first-run setup once and atomically creates the default workspace", async () => {
		const account = await signup("first-run");
		const before = await request("/auth/bootstrap", { headers: { cookie: account.cookie } });
		expect(before.status).toBe(200);
		expect(await before.json()).toMatchObject({
			ok: true,
			onboarding: { required: true, completed: false },
			organizations: [],
			projects: [],
			scope: null,
		});

		const completed = await request("/auth/onboarding", json("POST", {
			workspaceName: "Acme Memory",
			useScope: "team",
			useCase: "Coding agents",
			heardAbout: "Codex",
			conversationSample: "We need durable project context.",
			conversationSampleConsent: true,
		}, account.cookie));
		expect(completed.status).toBe(200);
		const body = await completed.json();
		expect(body).toMatchObject({
			ok: true,
			changed: true,
			onboarding: {
				required: false,
				completed: true,
				workspace_name: "Acme Memory",
				use_scope: "team",
			},
			scope: { source: "saved", revision: 1 },
		});
		expect(body.organizations).toEqual([
			expect.objectContaining({ id: body.scope.organization_id, name: "Acme Memory", role: "owner" }),
		]);
		expect(body.projects).toEqual([
			expect.objectContaining({
				id: body.scope.project_id,
				name: "Default project",
				effective_organization_id: body.scope.organization_id,
			}),
		]);

		const repeated = await request("/auth/onboarding", json("POST", {
			workspaceName: "Must not replace",
			useScope: "personal",
			useCase: "Other",
		}, account.cookie));
		expect(repeated.status).toBe(200);
		expect(await repeated.json()).toMatchObject({
			changed: false,
			onboarding: { workspace_name: "Acme Memory", use_scope: "team" },
		});

		const controlPlane = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'")
				.bind(account.user.id),
			env.DB.prepare("SELECT COUNT(*) AS n FROM managed_projects WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'")
				.bind(account.user.id),
			env.DB.prepare("SELECT COUNT(*) AS n FROM account_onboarding WHERE user_id = ? AND completed_at IS NOT NULL")
				.bind(account.user.id),
		]);
		expect(controlPlane.map((result) => result.results[0].n)).toEqual([1, 1, 1]);
	});

	it("persists authorized organization/project scope with compare-and-set protection", async () => {
		const account = await signup("scope-cas");
		const onboarded = await request("/auth/onboarding", json("POST", {
			workspaceName: "Primary workspace",
			useScope: "product",
			useCase: "AI product",
		}, account.cookie));
		const first = await onboarded.json();
		expect(first.scope.revision).toBe(1);

		const created = await request("/auth/organizations", json("POST", {
			name: "Secondary workspace",
		}, account.cookie));
		expect(created.status).toBe(201);
		const secondary = await created.json();

		const selected = await request("/auth/scope", json("POST", {
			organizationId: secondary.organization.id,
			projectId: secondary.project.id,
			expectedRevision: 1,
		}, account.cookie));
		expect(selected.status).toBe(200);
		const selectedBody = await selected.json();
		expect(selectedBody.scope).toMatchObject({
			organization_id: secondary.organization.id,
			project_id: secondary.project.id,
			source: "saved",
			revision: 2,
		});

		const stale = await request("/auth/scope", json("POST", {
			organizationId: first.scope.organization_id,
			projectId: first.scope.project_id,
			expectedRevision: 1,
		}, account.cookie));
		expect(stale.status).toBe(412);
		expect(await stale.json()).toMatchObject({ error: "scope_conflict" });
	});

	it("authenticates before parsing onboarding bodies", async () => {
		const response = await request("/auth/onboarding", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(40_000),
		});
		expect(response.status).toBe(401);
	});
});
