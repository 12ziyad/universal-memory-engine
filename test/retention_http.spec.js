import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { newId } from "../src/lib/ids.js";
import {
	ensureDefaultOrganization,
	listProjectMembers,
	setProjectRole,
	updateProjectRole,
} from "../src/lib/organizations.js";
import { RETENTION_CONFIRMATION } from "../src/lib/retention.js";

const DAY = 24 * 60 * 60 * 1000;

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie, projectId = null) {
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
	const response = await request("/auth/signup", json("POST", {
		email: `${label}-${crypto.randomUUID()}@example.com`,
		password: "correct-horse",
		name: label,
		acceptTerms: true,
	}));
	expect(response.status).toBe(201);
	return {
		...(await response.json()),
		cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
	};
}

async function settings(account, projectId = null) {
	const response = await request("/v1/settings", {
		headers: {
			cookie: account.cookie,
			...(projectId ? { "x-itsuki-project": projectId } : {}),
		},
	});
	expect(response.status).toBe(200);
	return response.json();
}

describe("retention HTTP contract", () => {
	it("keeps inventory and policy mutation admin-only with immediate role refresh", async () => {
		const owner = await signup("retention-owner");
		const collaborator = await signup("retention-viewer");
		const selected = await settings(owner);
		const org = await ensureDefaultOrganization(env, owner.user.id);
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, collaborator.user.id, owner.user.id, now, now).run();
		await setProjectRole(env, selected.project.id, org.id, collaborator.user.id, "viewer", owner.user.id);

		for (const [method, path, body, capability] of [
			["GET", "/v1/settings/retention", null, "project.retention.view"],
			["POST", "/v1/settings/retention/preview", { class: "source_episodes", days: 30, expected_version: 0 }, "project.retention.view"],
			["PUT", "/v1/settings/retention", { class: "source_episodes", days: null, expected_version: 0 }, "project.retention.manage"],
		]) {
			const response = await request(path, body === null
				? { method, headers: { cookie: collaborator.cookie, "x-itsuki-project": selected.project.id } }
				: json(method, body, collaborator.cookie, selected.project.id));
			expect(response.status, path).toBe(403);
			expect(await response.json()).toMatchObject({ error: "forbidden", capability });
		}

		const membership = (await listProjectMembers(env, selected.project.id))
			.find((row) => row.user_id === collaborator.user.id);
		await updateProjectRole(
			env,
			selected.project.id,
			org.id,
			collaborator.user.id,
			"admin",
			membership.revision,
		);
		const allowed = await request("/v1/settings/retention", {
			headers: { cookie: collaborator.cookie, "x-itsuki-project": selected.project.id },
		});
		expect(allowed.status).toBe(200);
		const body = await allowed.json();
		expect(body.policies).toHaveLength(7);
		expect(body.policies.every((policy) => policy.days === null)).toBe(true);
	});

	it("binds activation to an exact preview and refuses cross-project run ids", async () => {
		const owner = await signup("retention-activation");
		const selected = await settings(owner);
		const projectId = selected.project.id;
		const boundary = await env.DB.prepare(
			"SELECT memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(projectId).first();
		const deliveryId = `delivery_${crypto.randomUUID()}`;
		const oldAt = Date.now() - 60 * DAY;
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.added', 'delivered', '{"private":true}', ?, ?)`,
		).bind(deliveryId, boundary.memory_owner_user_id, `hook_${crypto.randomUUID()}`, oldAt, oldAt).run();

		const registryBefore = await env.DB.prepare(
			"SELECT last_seen_at FROM project_memory_spaces WHERE project_id = ? AND memory_user_id = ?",
		).bind(projectId, boundary.memory_owner_user_id).first();
		const previewResponse = await request("/v1/settings/retention/preview", json("POST", {
			class: "webhook_deliveries",
			days: 30,
			expected_version: 0,
		}, owner.cookie, projectId));
		expect(previewResponse.status).toBe(200);
		const { preview } = await previewResponse.json();
		expect(preview).toMatchObject({ inventory: { total: 1 }, mutation_free: true });
		expect(await env.DB.prepare(
			"SELECT last_seen_at FROM project_memory_spaces WHERE project_id = ? AND memory_user_id = ?",
		).bind(projectId, boundary.memory_owner_user_id).first()).toEqual(registryBefore);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM retention_runs WHERE project_id = ?")
			.bind(projectId).first()).toMatchObject({ n: 0 });

		const wrong = await request("/v1/settings/retention", json("PUT", {
			class: "webhook_deliveries",
			days: 30,
			expected_version: 0,
			preview_cutoff_at: preview.cutoff_at,
			preview_inventory_hash: preview.inventory_hash,
			confirmation: "apply retention",
		}, owner.cookie, projectId));
		expect(wrong.status).toBe(400);
		expect(await wrong.json()).toMatchObject({ error: "retention_confirmation_required" });

		const activatedResponse = await request("/v1/settings/retention", json("PUT", {
			class: "webhook_deliveries",
			days: 30,
			expected_version: 0,
			preview_cutoff_at: preview.cutoff_at,
			preview_inventory_hash: preview.inventory_hash,
			confirmation: RETENTION_CONFIRMATION,
		}, owner.cookie, projectId));
		expect(activatedResponse.status).toBe(200);
		const activated = await activatedResponse.json();
		expect(activated).toMatchObject({ policy: { version: 1 }, run: { status: "queued" } });

		const createOther = await request("/auth/projects", json("POST", {
			name: `Other retention project ${crypto.randomUUID()}`,
			organization_id: selected.organization.id,
		}, owner.cookie, projectId));
		expect(createOther.status).toBe(201);
		const otherProject = (await createOther.json()).project;
		const forged = await request("/v1/settings/retention/process", json("POST", {
			run_id: activated.run.id,
		}, owner.cookie, otherProject.id));
		expect(forged.status).toBe(404);
		expect(await forged.json()).toMatchObject({ error: "retention_run_not_found" });
		expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = ?")
			.bind(deliveryId).first()).toBeTruthy();

		const processed = await request("/v1/settings/retention/process", json("POST", {
			run_id: activated.run.id,
		}, owner.cookie, projectId));
		expect(processed.status).toBe(200);
		expect(await processed.json()).toMatchObject({ run: { status: "completed" } });
		expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = ?")
			.bind(deliveryId).first()).toBeNull();

		const stale = await request("/v1/settings/retention", json("PUT", {
			class: "webhook_deliveries", days: null, expected_version: 0,
		}, owner.cookie, projectId));
		expect(stale.status).toBe(412);
		expect(await stale.json()).toMatchObject({ error: "retention_conflict", current: { version: 1 } });
	});

	it("rejects invalid and oversized retention request bodies before mutation", async () => {
		const owner = await signup("retention-body");
		const selected = await settings(owner);
		const oversized = await request("/v1/settings/retention/preview", {
			method: "POST",
			headers: { cookie: owner.cookie, "x-itsuki-project": selected.project.id, "content-type": "application/json" },
			body: JSON.stringify({ class: "source_episodes", days: 30, expected_version: 0, padding: "x".repeat(20_000) }),
		});
		expect(oversized.status).toBe(413);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM retention_policies WHERE project_id = ?")
			.bind(selected.project.id).first()).toMatchObject({ n: 0 });
	});
});
