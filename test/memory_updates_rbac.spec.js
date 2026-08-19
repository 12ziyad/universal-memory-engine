/**
 * Safe memory updates — authorization, tenancy, lifecycle, and MCP parity.
 *
 * Sessions and Bearer keys re-resolve fresh project membership per call; the
 * update door additionally re-fences project status + epoch inside the commit
 * batch. MCP advertises update tools only to connections whose EFFECTIVE
 * scopes (declared ∩ current role) permit them.
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function jsonRequest(path, body, { cookie, project, bearer, method = "POST", headers = {} } = {}) {
	return request(path, {
		method,
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
			...(project ? { "x-itsuki-project": project } : {}),
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix = "upd-rbac") {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await jsonRequest("/auth/signup", { email, password: "correct-horse", name: prefix, acceptTerms: true });
	expect(res.status).toBe(201);
	const body = await res.json();
	return { user: body.user, cookie: cookieFrom(res) };
}

/** Owner + explicit project + api/mcp tokens + the project's memory owner id. */
async function projectWorld(prefix = "upd-rbac") {
	const owner = await signupAccount(prefix);
	const created = await jsonRequest("/auth/projects", { name: `${prefix}-${crypto.randomUUID().slice(0, 6)}` }, { cookie: owner.cookie });
	expect(created.status).toBe(201);
	const project = (await created.json()).project;
	const tokenRes = await jsonRequest("/auth/tokens", { type: "api", label: "upd" }, { cookie: owner.cookie, project: project.id });
	expect(tokenRes.status).toBe(201);
	const token = (await tokenRes.json()).token;
	const row = await env.DB.prepare("SELECT memory_owner_user_id FROM managed_projects WHERE id = ?").bind(project.id).first();
	return { owner, project, token, memoryOwner: row.memory_owner_user_id };
}

async function seedNode(userId, projectId = null, label = "RBAC node") {
	const id = `node_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, project_id, label, category, state, summary, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'tool', 'active', 'Summary.', ?, ?)`,
	).bind(id, userId, projectId, label, Date.now(), Date.now()).run();
	return id;
}

const idem = () => `idem-${crypto.randomUUID()}`;

async function mcpBearer(token, body) {
	return request("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
}

async function mcpJson(response) {
	const text = await response.text();
	const data = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
	return JSON.parse(data || text);
}

describe("Bearer token updates on a managed project", () => {
	it("updates through the token, records a content-free audit event, and refuses a viewer", async () => {
		const world = await projectWorld();
		const nodeId = await seedNode(world.memoryOwner, null);

		const res = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "Corrected by the member.",
			idempotencyKey: idem(),
			expectedRevision: 1,
		}, { bearer: world.token, method: "PATCH" });
		expect(res.status).toBe(200);
		expect((await res.json()).revision).toBe(2);

		// Audit: recorded, and content-free — neither the old nor the new text.
		const audit = await env.DB.prepare(
			"SELECT action, target_id, metadata_json FROM audit_events WHERE action = 'project.memory.updated' AND target_id = ?",
		).bind(nodeId).first();
		expect(audit).toBeTruthy();
		expect(String(audit.metadata_json ?? "")).not.toContain("Corrected by the member");
		expect(String(audit.metadata_json ?? "")).toContain("summary");

		// A viewer on the same project: history readable, update forbidden.
		const viewer = await signupAccount("upd-viewer");
		const org = await env.DB.prepare(
			"SELECT id FROM organizations WHERE owner_user_id = ? LIMIT 1",
		).bind(world.owner.user.id).first();
		expect(org?.id).toBeTruthy();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)",
			).bind(`om_${crypto.randomUUID()}`, org.id, viewer.user.id, Date.now(), Date.now()),
			env.DB.prepare(
				"INSERT INTO project_members (id, org_id, project_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'viewer', ?, ?)",
			).bind(`pm_${crypto.randomUUID()}`, org.id, world.project.id, viewer.user.id, Date.now(), Date.now()),
		]);
		const viewerPatch = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "Viewer vandalism", idempotencyKey: idem(), expectedRevision: 2,
		}, { cookie: viewer.cookie, project: world.project.id, method: "PATCH" });
		expect(viewerPatch.status).toBe(403);
		expect((await viewerPatch.json()).capability).toBe("project.memory.write");
		const viewerHistory = await jsonRequest(`/v1/memories/${nodeId}/history`, undefined, {
			cookie: viewer.cookie, project: world.project.id, method: "GET",
		});
		expect(viewerHistory.status).toBe(200);
		expect((await viewerHistory.json()).current_revision).toBe(2);
	});

	it("cross-account and forged-project access cannot reach the object", async () => {
		const worldA = await projectWorld("upd-a");
		const worldB = await projectWorld("upd-b");
		const nodeId = await seedNode(worldA.memoryOwner, null);

		// B's token cannot address A's project at all.
		const forged = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "cross-tenant", idempotencyKey: idem(), expectedRevision: 1,
		}, { bearer: worldB.token, method: "PATCH", headers: { "x-itsuki-project": worldA.project.id } });
		expect([403, 404]).toContain(forged.status);

		// B's token in its own project simply cannot see A's object: 404.
		const invisible = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "cross-tenant", idempotencyKey: idem(), expectedRevision: 1,
		}, { bearer: worldB.token, method: "PATCH" });
		expect(invisible.status).toBe(404);

		const row = await env.DB.prepare("SELECT summary, COALESCE(revision,1) AS revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("Summary.");
		expect(row.revision).toBe(1);
	});

	it("SDK subtenants are isolated from the root space and from each other", async () => {
		const world = await projectWorld("upd-sub");
		const rootNode = await seedNode(world.memoryOwner, null);

		// Subtenant cannot see or edit the root-space object.
		const subPatch = await jsonRequest(`/v1/memories/${rootNode}?userId=ext-alice`, {
			summary: "subtenant reach", idempotencyKey: idem(), expectedRevision: 1,
		}, { bearer: world.token, method: "PATCH" });
		expect(subPatch.status).toBe(404);
		const subHistory = await jsonRequest(`/v1/memories/${rootNode}/history?userId=ext-alice`, undefined, {
			bearer: world.token, method: "GET",
		});
		expect(subHistory.status).toBe(404);
	});

	it("an archived project refuses updates with a stable error and a revoked key gets 401", async () => {
		const world = await projectWorld("upd-arch");
		const nodeId = await seedNode(world.memoryOwner, null);
		await env.DB.prepare("UPDATE managed_projects SET status = 'archived', archived_at = ? WHERE id = ?")
			.bind(Date.now(), world.project.id).run();
		const archived = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "into the archive", idempotencyKey: idem(), expectedRevision: 1,
		}, { bearer: world.token, method: "PATCH" });
		expect([404, 409]).toContain(archived.status);
		const row = await env.DB.prepare("SELECT summary FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("Summary.");

		await env.DB.prepare("UPDATE managed_projects SET status = 'active', archived_at = NULL WHERE id = ?")
			.bind(world.project.id).run();
		await env.DB.prepare("UPDATE connection_tokens SET status = 'revoked', revoked_at = ? WHERE token_prefix = ?")
			.bind(Date.now(), world.token.slice(0, 18)).run();
		const revoked = await jsonRequest(`/v1/memories/${nodeId}`, {
			summary: "after revocation", idempotencyKey: idem(), expectedRevision: 1,
		}, { bearer: world.token, method: "PATCH" });
		expect(revoked.status).toBe(401);
	});
});

describe("MCP update tools", () => {
	it("advertises update tools to write connections, hides them from read-only ones, and updates end to end", async () => {
		const world = await projectWorld("upd-mcp");

		const list = await mcpBearer(world.token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		const tools = (await mcpJson(list)).result.tools.map((t) => t.name);
		expect(tools).toContain("update_memory");
		expect(tools).toContain("rollback_memory");
		expect(tools).toContain("memory_history");

		// A read-only-scoped key must not see the write tools at all.
		const readTokenRes = await jsonRequest("/auth/tokens", { type: "api", label: "ro", scopes: ["memory:read"] },
			{ cookie: world.owner.cookie, project: world.project.id });
		const readToken = (await readTokenRes.json()).token;
		const roList = await mcpBearer(readToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		const roTools = (await mcpJson(roList)).result.tools.map((t) => t.name);
		expect(roTools).not.toContain("update_memory");
		expect(roTools).not.toContain("rollback_memory");
		expect(roTools).toContain("memory_history");

		// Full round trip through the MCP door.
		const nodeId = await seedNode(world.memoryOwner, null, "MCP target");
		const call = await mcpBearer(world.token, {
			jsonrpc: "2.0", id: 3, method: "tools/call",
			params: { name: "update_memory", arguments: {
				id: nodeId, expectedRevision: 1, fields: { label: "MCP corrected" }, idempotencyKey: idem(),
			} },
		});
		const callBody = await mcpJson(call);
		expect(JSON.stringify(callBody)).toContain("revision 2");

		const historyCall = await mcpBearer(world.token, {
			jsonrpc: "2.0", id: 4, method: "tools/call",
			params: { name: "memory_history", arguments: { id: nodeId } },
		});
		const historyBody = await mcpJson(historyCall);
		expect(JSON.stringify(historyBody)).toContain("baseline");

		const rollback = await mcpBearer(world.token, {
			jsonrpc: "2.0", id: 5, method: "tools/call",
			params: { name: "rollback_memory", arguments: {
				id: nodeId, toRevision: 1, expectedRevision: 2, idempotencyKey: idem(),
			} },
		});
		expect(JSON.stringify(await mcpJson(rollback))).toContain("revision 3");
		const row = await env.DB.prepare("SELECT label FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.label).toBe("MCP target");

		// Stale revision through MCP is a structured refusal, not an overwrite.
		const stale = await mcpBearer(world.token, {
			jsonrpc: "2.0", id: 6, method: "tools/call",
			params: { name: "update_memory", arguments: {
				id: nodeId, expectedRevision: 1, fields: { label: "stale" }, idempotencyKey: idem(),
			} },
		});
		expect(JSON.stringify(await mcpJson(stale))).toContain("stale_revision");
	});
});
