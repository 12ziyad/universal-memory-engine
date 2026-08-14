import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { ensureDefaultOrganization, setProjectRole } from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";

async function request(path, init = {}, runtimeEnv = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://example.com${path}`, init), runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie = null) {
	return { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) };
}

async function signup(label) {
	const response = await request("/auth/signup", json("POST", {
		email: `${label}-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: label, acceptTerms: true,
	}));
	const body = await response.json();
	return { user: body.user, cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function fixture() {
	const owner = await signup("audit-owner");
	const viewer = await signup("audit-viewer");
	const created = await request("/auth/projects", json("POST", { name: `Audit ${newId("x")}` }, owner.cookie));
	const { project } = await created.json();
	const org = await ensureDefaultOrganization(env, owner.user.id);
	const at = Date.now();
	await env.DB.prepare(
		`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
	).bind(newId("orgm"), org.id, viewer.user.id, owner.user.id, at, at).run();
	await setProjectRole(env, project.id, org.id, viewer.user.id, "viewer", owner.user.id);
	return { owner, viewer, project, org };
}

describe("audit HTTP enterprise contract", () => {
	it("preserves same-millisecond tuple pagination and exports under a distinct capability", async () => {
		const f = await fixture();
		const at = Date.now();
		await env.DB.batch(Array.from({ length: 5 }, (_, index) => env.DB.prepare(
			`INSERT INTO audit_events
			 (id, org_id, project_id, actor_type, action, target_type, target_id, outcome, created_at)
			 VALUES (?, ?, ?, 'system', 'project.member.changed', 'member', ?, 'ok', ?)`,
		).bind(`aud_http_${index}_${crypto.randomUUID()}`, f.org.id, f.project.id, `member_${index}`, at)));

		const headers = { cookie: f.owner.cookie, "x-itsuki-project": f.project.id };
		const first = await (await request("/v1/settings/audit?limit=2", { headers })).json();
		expect(first.events).toHaveLength(2);
		expect(first.next_cursor).toBeTruthy();
		const second = await (await request(`/v1/settings/audit?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, { headers })).json();
		expect(second.events).toHaveLength(2);
		expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(4);

		const viewerHeaders = { cookie: f.viewer.cookie, "x-itsuki-project": f.project.id };
		const denied = await request("/v1/settings/audit/export", { headers: viewerHeaders });
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ capability: "project.audit.export" });
		const exported = await request("/v1/settings/audit/export?limit=10&action=project.member.changed", { headers });
		expect(exported.status).toBe(200);
		expect(exported.headers.get("content-type")).toContain("text/csv");
		expect(exported.headers.get("content-disposition")).toContain("attachment");
		expect(Number(exported.headers.get("x-itsuki-export-count"))).toBe(5);
		expect(await exported.text()).toContain("project.member.changed");
	});

	it("rejects malformed query filters instead of silently changing their meaning", async () => {
		const f = await fixture();
		const headers = { cookie: f.owner.cookie, "x-itsuki-project": f.project.id };
		for (const [query, code] of [
			["limit=0", "invalid_audit_limit"],
			["limit=201", "invalid_audit_limit"],
			["cursor=not-a-cursor", "invalid_audit_cursor"],
			["from=yesterday", "invalid_audit_time"],
			["from=20&to=10", "invalid_audit_range"],
			["action=contains%20spaces", "invalid_audit_action"],
		]) {
			const response = await request(`/v1/settings/audit?${query}`, { headers });
			expect(response.status, query).toBe(400);
			expect(await response.json(), query).toMatchObject({ error: code });
		}
		const tooLargeExport = await request("/v1/settings/audit/export?limit=20001", { headers });
		expect(tooLargeExport.status).toBe(400);
		expect(await tooLargeExport.json()).toMatchObject({ error: "invalid_audit_limit" });
	});

	it("echoes one safe correlation id and exposes it to cross-origin clients", async () => {
		const accepted = crypto.randomUUID();
		const health = await request("/health", { headers: { "x-request-id": accepted } });
		expect(health.headers.get("x-request-id")).toBe(accepted);

		const hostile = `sk-live-${"private".repeat(40)}`;
		const replaced = await request("/health", { headers: { "x-request-id": hostile } });
		expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
		expect(replaced.headers.get("x-request-id")).not.toContain("private");

		const priorCors = env.ENABLE_CORS;
		env.ENABLE_CORS = "true";
		try {
			const cors = await request("/v1/ingest/limits", { headers: { origin: "https://client.example" } });
			expect(cors.headers.get("access-control-expose-headers")).toContain("x-request-id");
			expect(cors.headers.get("x-request-id")).toBeTruthy();
			const preflight = await request("/v1/ingest/limits", {
				method: "OPTIONS",
				headers: { origin: "https://client.example", "access-control-request-headers": "x-request-id" },
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-headers")).toContain("x-request-id");
		} finally {
			env.ENABLE_CORS = priorCors;
		}
	});

	it("maps governed replay to 409 and audit outage to 503 without a second mutation", async () => {
		const f = await fixture();
		const requestId = crypto.randomUUID();
		const headers = {
			cookie: f.owner.cookie,
			"content-type": "application/json",
			"x-request-id": requestId,
		};
		const before = Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM managed_projects WHERE owner_user_id = ?",
		).bind(f.owner.user.id).first()).n);
		const first = await request("/auth/projects", {
			method: "POST", headers, body: JSON.stringify({ name: `Replay ${newId("x")}` }),
		});
		expect(first.status).toBe(201);
		const replay = await request("/auth/projects", {
			method: "POST", headers, body: JSON.stringify({ name: `Different ${newId("x")}` }),
		});
		expect(replay.status).toBe(409);
		expect(replay.headers.get("x-request-id")).toBe(requestId);
		expect(await replay.json()).toMatchObject({ error: "audit_request_replayed" });
		const afterReplay = Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM managed_projects WHERE owner_user_id = ?",
		).bind(f.owner.user.id).first()).n);
		expect(afterReplay).toBe(before + 1);

		const failedDb = new Proxy(env.DB, {
			get(target, property) {
				if (property === "prepare") return (sql) => {
					if (/^\s*INSERT\s+INTO\s+audit_events/i.test(String(sql))) {
						throw new Error("injected audit outage");
					}
					return target.prepare(sql);
				};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const unavailableId = crypto.randomUUID();
		const unavailable = await request("/auth/projects", {
			method: "POST",
			headers: { ...headers, "x-request-id": unavailableId },
			body: JSON.stringify({ name: `Unavailable ${newId("x")}` }),
		}, { ...env, DB: failedDb });
		expect(unavailable.status).toBe(503);
		expect(unavailable.headers.get("x-request-id")).toBe(unavailableId);
		expect(await unavailable.json()).toMatchObject({ error: "audit_unavailable" });
		const afterOutage = Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM managed_projects WHERE owner_user_id = ?",
		).bind(f.owner.user.id).first()).n);
		expect(afterOutage).toBe(afterReplay);
	});
});
