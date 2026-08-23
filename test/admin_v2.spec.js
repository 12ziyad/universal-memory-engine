/**
 * Admin v2 console + visit beacon + password change + recall receipt copy.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { formatReceipt } from "../src/pipeline/receipt.js";
import { providerOperationId } from "../src/lib/ai_meter.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe("provider health check", () => {
	it("stays dark without Google credentials and does not require an operation key", async () => {
		const admin = await signupAccount("health-dark");
		await makeAdmin(admin.user.id);
		const res = await request("/v1/admin/ai-routing/health-check", {
			method: "POST",
			headers: { cookie: admin.cookie },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			google_vertex: { ok: false, error_class: "no_credentials" },
		});
	});

	it("requires a bounded stable operation key before a credentialed live probe", async () => {
		const admin = await signupAccount("health-key");
		await makeAdmin(admin.user.id);
		const credentialed = {
			...env,
			GCP_PROJECT_ID: "test-project",
			GCP_SERVICE_ACCOUNT: "{}",
		};
		for (const key of [null, "short", "        ", "x".repeat(129)]) {
			const headers = { cookie: admin.cookie };
			if (key != null) headers["Idempotency-Key"] = key;
			const res = await request("/v1/admin/ai-routing/health-check", {
				method: "POST",
				headers,
			}, credentialed);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_idempotency_key" });
		}
		const reservations = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_provider_reservations",
		).first("n");
		expect(Number(reservations)).toBe(0);
	});

	it("routes a valid probe through reservation and ai-call accounting before local credential refusal", async () => {
		const admin = await signupAccount("health-accounted");
		await makeAdmin(admin.user.id);
		const key = `health-${crypto.randomUUID()}`;
		const reservationId = await providerOperationId({
			scope: "admin_provider_health",
			scopeId: `${admin.user.id}:${key}`,
			task: "provider_health",
			ordinal: 0,
		});
		const res = await request("/v1/admin/ai-routing/health-check", {
			method: "POST",
			headers: { cookie: admin.cookie, "Idempotency-Key": key },
		}, {
			...env,
			GCP_PROJECT_ID: "test-project",
			GCP_SERVICE_ACCOUNT: "{}",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			google_vertex: { ok: false, error_class: "provider_misconfigured" },
		});
		const reservation = await env.DB.prepare(
			"SELECT provider, status FROM ai_provider_reservations WHERE id = ?",
		).bind(reservationId).first();
		expect(reservation).toMatchObject({ provider: "google-vertex", status: "released" });
		const call = await env.DB.prepare(
			`SELECT provider, scope, scope_id, task, ok, error_class FROM ai_calls
			 WHERE user_id = ? AND scope_id = ? ORDER BY created_at DESC LIMIT 1`,
		).bind(admin.user.id, reservationId).first();
		expect(call).toMatchObject({
			provider: "google-vertex",
			scope: "provider_health",
			scope_id: reservationId,
			task: "provider_health",
			ok: 0,
			error_class: "provider_misconfigured",
		});

		const replay = await request("/v1/admin/ai-routing/health-check", {
			method: "POST",
			headers: { cookie: admin.cookie, "Idempotency-Key": key },
		}, {
			...env,
			GCP_PROJECT_ID: "test-project",
			GCP_SERVICE_ACCOUNT: "{}",
		});
		expect(replay.status).toBe(409);
		expect(await replay.json()).toEqual({
			error: "health_probe_key_already_used",
			google_vertex: {
				ok: false,
				error_class: "duplicate_probe",
				reservation_status: "released",
			},
		});
		const afterReplay = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_calls
			 WHERE user_id = ? AND scope_id = ? AND task = 'provider_health'`,
		).bind(admin.user.id, reservationId).first("n");
		expect(Number(afterReplay)).toBe(1);
	});

	it("does not resurrect an erased admin identity when an admitted health meter flushes late", async () => {
		const admin = await signupAccount("health-erasure-race");
		await makeAdmin(admin.user.id);
		const key = `health-race-${crypto.randomUUID()}`;
		const reservationId = await providerOperationId({
			scope: "admin_provider_health",
			scopeId: `${admin.user.id}:${key}`,
			task: "provider_health",
			ordinal: 0,
		});
		const dailyCallsBefore = Number(await env.DB.prepare(
			"SELECT COALESCE(SUM(calls), 0) AS n FROM ai_daily_totals",
		).first("n"));
		let releaseFlush;
		let markFlushReady;
		const flushReady = new Promise((resolve) => { markFlushReady = resolve; });
		const flushReleased = new Promise((resolve) => { releaseFlush = resolve; });
		const aiCallStatements = new WeakSet();
		const wrapStatement = (statement, tracksAiCall) => {
			const wrapped = new Proxy(statement, {
				get(prepared, property) {
					if (property === "bind") {
						return (...args) => wrapStatement(prepared.bind(...args), tracksAiCall);
					}
					const value = Reflect.get(prepared, property);
					return typeof value === "function" ? value.bind(prepared) : value;
				},
			});
			if (tracksAiCall) aiCallStatements.add(wrapped);
			return wrapped;
		};
		const DB = new Proxy(env.DB, {
			get(db, property) {
				if (property === "prepare") return (sql) => wrapStatement(
					db.prepare(sql),
					String(sql).includes("INSERT INTO ai_calls"),
				);
				if (property === "batch") return async (statements) => {
					if (statements.some((statement) => aiCallStatements.has(statement))) {
						markFlushReady();
						await flushReleased;
					}
					return db.batch(statements);
				};
				const value = Reflect.get(db, property);
				return typeof value === "function" ? value.bind(db) : value;
			},
		});
		const racedEnv = {
			...env,
			DB,
			GCP_PROJECT_ID: "test-project",
			GCP_SERVICE_ACCOUNT: "{}",
		};

		const inFlight = request("/v1/admin/ai-routing/health-check", {
			method: "POST",
			headers: { cookie: admin.cookie, "Idempotency-Key": key },
		}, racedEnv);
		await flushReady;
		expect((await deleteAccountCompletely(env, admin.user.id)).deleted).toBe(true);
		releaseFlush();
		const response = await inFlight;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			google_vertex: { ok: false, error_class: "provider_misconfigured" },
		});

		const resurrected = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? OR account_user_id = ?",
		).bind(admin.user.id, admin.user.id).first("n");
		expect(Number(resurrected)).toBe(0);
		const accounted = await env.DB.prepare(
			`SELECT * FROM ai_calls
			  WHERE provider = 'google-vertex' AND task = 'provider_health'
			    AND user_id IS NULL AND account_user_id IS NULL
			    AND scope IS NULL AND scope_id IS NULL
			  ORDER BY created_at DESC, id DESC LIMIT 1`,
		).first();
		expect(accounted).toMatchObject({
			user_id: null,
			account_user_id: null,
			scope: null,
			scope_id: null,
			managed_project_id: null,
			task: "provider_health",
		});
		const serialized = JSON.stringify(accounted);
		expect(serialized).not.toContain(admin.user.id);
		expect(serialized.toLowerCase()).not.toContain(admin.email.toLowerCase());
		const dailyCallsAfter = Number(await env.DB.prepare(
			"SELECT COALESCE(SUM(calls), 0) AS n FROM ai_daily_totals",
		).first("n"));
		expect(dailyCallsAfter - dailyCallsBefore).toBe(1);
	});
});

function jsonInit(body, cookie) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	};
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

async function makeAdmin(userId) {
	await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run();
}

describe("visit beacon", () => {
	it("increments an aggregate counter and stores nothing personal", async () => {
		const day = new Date().toISOString().slice(0, 10);
		const before = await env.DB.prepare("SELECT count FROM site_visits WHERE day = ? AND kind = 'landing'").bind(day).first();
		const res = await request("/v1/beacon", jsonInit({ kind: "landing" }));
		expect(res.status).toBe(200);
		const after = await env.DB.prepare("SELECT * FROM site_visits WHERE day = ? AND kind = 'landing'").bind(day).first();
		expect(Number(after.count)).toBe(Number(before?.count ?? 0) + 1);
		expect(Object.keys(after).sort()).toEqual(["count", "day", "kind"]);
	});

	it("coerces unknown kinds", async () => {
		await request("/v1/beacon", jsonInit({ kind: "evil<script>" }));
		const day = new Date().toISOString().slice(0, 10);
		const row = await env.DB.prepare("SELECT count FROM site_visits WHERE day = ? AND kind = 'other'").bind(day).first();
		expect(Number(row?.count ?? 0)).toBeGreaterThanOrEqual(1);
	});
});

describe("admin users + actions", () => {
	it("gates the users list and supports search", async () => {
		const admin = await signupAccount("adm");
		const denied = await request("/v1/admin/users", { headers: { cookie: admin.cookie } });
		expect(denied.status).toBe(403);
		await makeAdmin(admin.user.id);
		const res = await request(`/v1/admin/users?query=${admin.email.slice(0, 8)}`, { headers: { cookie: admin.cookie } });
		expect(res.status).toBe(200);
		const users = (await res.json()).users;
		expect(users.some((u) => u.id === admin.user.id)).toBe(true);
	});

	it("disables, re-enables, and deletes a target account", async () => {
		const admin = await signupAccount("boss");
		await makeAdmin(admin.user.id);
		const victim = await signupAccount("victim");

		const disable = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "disable" }, admin.cookie));
		expect(disable.status).toBe(200);
		const loginDisabled = await request("/auth/login", jsonInit({ email: victim.email, password: "correct-horse" }));
		expect(loginDisabled.status).toBe(401);

		const enable = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "enable" }, admin.cookie));
		expect(enable.status).toBe(200);
		const loginEnabled = await request("/auth/login", jsonInit({ email: victim.email, password: "correct-horse" }));
		expect(loginEnabled.status).toBe(200);

		const del = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie));
		expect(del.status).toBe(200);
		const gone = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(victim.user.id).first();
		expect(gone).toBeNull();
	});

	it("protects the admin from locking themselves out", async () => {
		const admin = await signupAccount("selfsafe");
		await makeAdmin(admin.user.id);
		for (const action of ["delete", "demote", "disable"]) {
			const res = await request("/v1/admin/users/action", jsonInit({ userId: admin.user.id, action }, admin.cookie));
			expect(res.status).toBe(400);
		}
	});
});

describe("change password", () => {
	it("changes with the current password and rejects a wrong one", async () => {
		const account = await signupAccount("pw");
		const wrong = await request("/auth/password", jsonInit({ currentPassword: "not-it", newPassword: "brand-new-pass" }, account.cookie));
		expect(wrong.status).toBe(400);
		const ok = await request("/auth/password", jsonInit({ currentPassword: "correct-horse", newPassword: "brand-new-pass" }, account.cookie));
		expect(ok.status).toBe(200);
		const login = await request("/auth/login", jsonInit({ email: account.email, password: "brand-new-pass" }));
		expect(login.status).toBe(200);
	});
});

describe("error reporting", () => {
	it("stores truncated client reports and never errors back", async () => {
		const res = await request("/v1/error-report", jsonInit({
			scope: "graph-render",
			message: "x".repeat(1000),
		}));
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT side, scope, length(message) AS len FROM error_reports ORDER BY created_at DESC LIMIT 1",
		).first();
		expect(row.side).toBe("client");
		expect(row.scope).toBe("graph-render");
		expect(Number(row.len)).toBeLessThanOrEqual(400);
	});

	it("surfaces reports to admins in stats", async () => {
		const admin = await signupAccount("errsee");
		await makeAdmin(admin.user.id);
		const res = await request("/v1/admin/stats", { headers: { cookie: admin.cookie } });
		expect(res.status).toBe(200);
		const stats = await res.json();
		expect(Array.isArray(stats.error_reports)).toBe(true);
	});
});

describe("recall receipt copy", () => {
	it("never phrases lookups as failed saves", () => {
		expect(formatReceipt({ outcome: "recalled" })).toMatch(/lookup completed/i);
		expect(formatReceipt({ outcome: "no_recall" })).toMatch(/lookup skipped/i);
		expect(formatReceipt({ outcome: "recalled" })).not.toContain("Saved: 0");
	});
});
