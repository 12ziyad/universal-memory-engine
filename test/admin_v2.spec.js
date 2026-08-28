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

		// Deletion is step-up gated: a bare request must refuse with 428, and
		// succeed only with a minted token plus the target's email typed back.
		const bare = await request("/v1/admin/users/action", jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie));
		expect(bare.status).toBe(428);
		expect((await bare.json()).error).toBe("confirmation_required");

		const mint = await request("/v1/admin/users/confirm", jsonInit({ userId: victim.user.id, action: "delete" }, admin.cookie));
		expect(mint.status).toBe(200);
		const confirmation = await mint.json();
		expect(confirmation.confirm_text).toBe(victim.email);

		const del = await request("/v1/admin/users/action", jsonInit({
			userId: victim.user.id, action: "delete",
			confirmation_token: confirmation.token, confirm_text: victim.email,
		}, admin.cookie));
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

describe("the operator ledger", () => {
	it("is admin-only, like every other operator route", async () => {
		const plain = await signupAccount("feed-plain");
		expect((await request("/v1/admin/audit-feed")).status).toBe(401);
		expect((await request("/v1/admin/audit-feed", { headers: { cookie: plain.cookie } })).status).toBe(403);
	});

	it("returns actor, action and outcome — and never the metadata blob", async () => {
		const admin = await signupAccount("feed-admin");
		await makeAdmin(admin.user.id);
		// A real audit row, with a metadata_json payload that must not escape.
		await env.DB.prepare(
			`INSERT INTO audit_events (id, actor_user_id, actor_type, action, target_type, target_id,
			 outcome, reason, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		).bind("aud-feed-1", admin.user.id, "user", "project.member.removed", "project", "prj_1",
			"ok", null, JSON.stringify({ secret_payload: "must-not-leak" }), Date.now()).run();

		const res = await request("/v1/admin/audit-feed?limit=50", { headers: { cookie: admin.cookie } });
		expect(res.status).toBe(200);
		const body = await res.json();
		const entry = body.entries.find((row) => row.action === "project.member.removed");
		expect(entry).toBeTruthy();
		expect(entry.actor.email).toBe(admin.user.email);
		expect(entry.target).toEqual({ type: "project", id: "prj_1" });
		expect(entry.outcome).toBe("ok");
		// The whole point of the endpoint's contract: operators see that a thing
		// happened and to what, never what was inside it.
		expect(JSON.stringify(body)).not.toContain("must-not-leak");
		expect(JSON.stringify(body)).not.toContain("metadata_json");
	});

	it("pages backwards by timestamp, not by offset", async () => {
		const admin = await signupAccount("feed-page");
		await makeAdmin(admin.user.id);
		const base = Date.now();
		for (let i = 0; i < 4; i++) {
			await env.DB.prepare(
				`INSERT INTO audit_events (id, actor_user_id, actor_type, action, outcome, created_at)
				 VALUES (?,?,?,?,?,?)`,
			).bind(`aud-page-${i}`, admin.user.id, "user", "account.scope.selected", "ok", base - i * 1000).run();
		}
		const first = await (await request("/v1/admin/audit-feed?limit=2", { headers: { cookie: admin.cookie } })).json();
		expect(first.entries.length).toBe(2);
		expect(first.next_before).toBeTruthy();
		// Offset paging repeats or skips rows as new events land mid-read; a
		// timestamp cursor cannot.
		const second = await (await request(`/v1/admin/audit-feed?limit=2&before=${first.next_before}`, { headers: { cookie: admin.cookie } })).json();
		const firstIds = first.entries.map((e) => e.at);
		for (const entry of second.entries) expect(firstIds).not.toContain(entry.at);
		expect(second.entries.every((e) => e.at < first.next_before)).toBe(true);
	});

	it("a short page reports no cursor, so the reader stops", async () => {
		const admin = await signupAccount("feed-end");
		await makeAdmin(admin.user.id);
		const body = await (await request("/v1/admin/audit-feed?limit=300", { headers: { cookie: admin.cookie } })).json();
		expect(body.entries.length).toBeLessThan(300);
		expect(body.next_before).toBe(null);
	});
});

describe("error reports are scrubbed before they persist", () => {
	it("a secret quoted in an error message never reaches the table", async () => {
		// An extraction failure can quote the payload that broke it. Without
		// scrubbing, error_reports becomes a copy of whatever secret or memory
		// text happened to be in that payload — the one table the census can
		// delete but nothing sanitised on the way in.
		const { reportServerError } = await import("../src/lib/report.js");
		const leaky = new Error('parse failed near "sk-proj-Abc123456789012345678901234567890123456789"');
		await reportServerError(env, "test-scrub", leaky, null, { reportId: "err_scrub_pin" });
		const row = await env.DB.prepare(
			"SELECT message FROM error_reports WHERE id = ?",
		).bind("err_scrub_pin").first();
		expect(row).toBeTruthy();
		expect(row.message).not.toContain("sk-proj-Abc12345");
		expect(row.message).toContain("parse failed");
	});
});
