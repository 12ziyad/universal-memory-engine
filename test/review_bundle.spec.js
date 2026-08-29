/* The sanitized AI Review Bundle (Phase 3).
 *
 * The bundle exists to be handed to someone outside the company, so these
 * tests are written from the reviewer's side of the table: seed the database
 * with exactly the things that must NOT escape — memory content, emails,
 * account ids, a trust report containing a credential, audit metadata — then
 * assert the bundle carries none of it while still being substantive enough
 * to review.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { buildReviewBundle, assertBundleIsSanitized, BUNDLE_SCHEMA, SUBPROCESSORS } from "../src/lib/review_bundle.js";
import { createTrustCase } from "../src/lib/trust_cases.js";
import { recordSecurityEvent } from "../src/lib/security_events.js";
import html from "../public/index.html?raw";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

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

describe("the door", () => {
	it("is admin-only", async () => {
		expect((await request("/v1/admin/review-bundle")).status).toBe(401);
		const user = await signupAccount("bundle-user");
		expect((await request("/v1/admin/review-bundle", { headers: { cookie: user.cookie } })).status).toBe(403);
		await makeAdmin(user.user.id);
		const ok = await request("/v1/admin/review-bundle", { headers: { cookie: user.cookie } });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-disposition")).toContain("itsuki-review-bundle-");
	});
});

describe("what the bundle refuses to carry", () => {
	it("omits memory content, emails, and account ids even when the database is full of them", async () => {
		// Seed exactly the things that must not escape.
		const reporter = await signupAccount("bundle-reporter");
		const admin = await signupAccount("bundle-admin");
		await makeAdmin(admin.user.id);
		const secretish = "sk-abcdefghijklmnop1234";
		const filed = await createTrustCase(env, {
			userId: reporter.user.id,
			kind: "security_report",
			message: `my key ${secretish} leaked and my email is ${reporter.email}`,
		});
		expect(filed.error).toBeUndefined();
		await recordSecurityEvent(env, {
			kind: "admin_role_change", severity: "high",
			groupKey: `admin_role_change:${reporter.user.id}`,
			actorUserId: admin.user.id, targetUserId: reporter.user.id,
		});
		// A real audited mutation, so audit_events has rows with metadata.
		await request("/v1/admin/trust/cases/action", jsonInit({
			caseId: filed.id, action: "note", note: `contacted ${reporter.email} about it`,
		}, admin.cookie));

		const res = await request("/v1/admin/review-bundle", { headers: { cookie: admin.cookie } });
		expect(res.status).toBe(200);
		const text = await res.text();

		// The reporter's identity and words are absent.
		expect(text).not.toContain(reporter.email);
		expect(text).not.toContain(admin.email);
		expect(text).not.toContain(reporter.user.id);
		expect(text).not.toContain(admin.user.id);
		expect(text).not.toContain(secretish);
		expect(text).not.toContain("leaked and my email");
		expect(text).not.toContain("contacted");
		// No email address of ANY kind, including the owner notify address.
		expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
		// No account or memory-space identifier of any kind.
		expect(text).not.toMatch(/\b(?:user_[0-9a-f-]{8,}|mem_[0-9a-f]{8,})\b/);
	});

	it("never carries a secret binding's value", async () => {
		const admin = await signupAccount("bundle-secrets");
		await makeAdmin(admin.user.id);
		const loaded = {
			...env,
			API_KEY: "itsuki_live_bundle_test_key_value",
			AUTH_EMAIL_SECRET: "auth-email-secret-value-1234567890",
			// Assembled at runtime: a literal PEM header in the tree would trip
			// the credential scanner (test/ai_credential_scan.spec.js), which is
			// a gate worth keeping sharp rather than adding an exception to.
			GCP_SERVICE_ACCOUNT: `{"private_key":"${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}abc"}`,
			OWNER_NOTIFY_EMAIL: "owner@example.com",
		};
		const bundle = await buildReviewBundle(loaded);
		const text = JSON.stringify(bundle);
		for (const value of [loaded.API_KEY, loaded.AUTH_EMAIL_SECRET, loaded.GCP_SERVICE_ACCOUNT, loaded.OWNER_NOTIFY_EMAIL]) {
			expect(text).not.toContain(value);
		}
		expect(assertBundleIsSanitized(bundle, loaded)).toBe(true);
	});

	it("reports provider credentials as presence, never as value", async () => {
		const bundle = await buildReviewBundle({ ...env, GCP_SERVICE_ACCOUNT: '{"private_key":"secret-material"}' });
		const credentials = bundle.ai_routing?.credentials;
		if (credentials) {
			expect(JSON.stringify(credentials)).not.toContain("secret-material");
			expect(JSON.stringify(credentials)).toMatch(/present|absent|null/);
		}
	});
});

describe("the sanitization assertion itself", () => {
	// The assertion is the load-bearing control, so it is tested by being
	// FED violations — a guard that has never refused anything is not a guard.
	it("throws on a leaked secret value", () => {
		const loaded = { ...env, API_KEY: "itsuki_live_super_secret_value" };
		expect(() => assertBundleIsSanitized({ oops: "itsuki_live_super_secret_value" }, loaded))
			.toThrow(/leaked the value of API_KEY/);
	});

	it("throws on any email address", () => {
		expect(() => assertBundleIsSanitized({ note: "ping someone@example.com" }, env))
			.toThrow(/leaked an email address/);
	});

	it("throws on an account or memory-space identifier", () => {
		expect(() => assertBundleIsSanitized({ who: "user_1a2b3c4d5e6f" }, env))
			.toThrow(/leaked an identifier/);
		expect(() => assertBundleIsSanitized({ space: "mem_0123456789abcdef" }, env))
			.toThrow(/leaked an identifier/);
	});

	it("throws on a content-bearing field name, however nested", () => {
		expect(() => assertBundleIsSanitized({ trust: { cases: [{ message: "hello" }] } }, env))
			.toThrow(/forbidden field: message/);
		expect(() => assertBundleIsSanitized({ audit: { rows: [{ metadata_json: "{}" }] } }, env))
			.toThrow(/forbidden field: metadata_json/);
	});

	it("ignores a short or absent secret rather than false-positiving on it", () => {
		expect(assertBundleIsSanitized({ ok: true }, { ...env, API_KEY: "" })).toBe(true);
		expect(assertBundleIsSanitized({ ok: true }, { ...env, API_KEY: undefined })).toBe(true);
	});
});

describe("what the bundle does carry — it must be worth reviewing", () => {
	it("carries schema, config, governance allowlists, and the legality matrix", async () => {
		const bundle = await buildReviewBundle(env);
		expect(bundle.schema).toBe(BUNDLE_SCHEMA);
		expect(bundle.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(bundle.version.latest_migration).toBe("0062_trust_safety.sql");
		expect(bundle.version.tables).toBeGreaterThan(50);
		// Config a reviewer actually asks about.
		expect(bundle.configuration.maintenance_mode).toBeDefined();
		expect(bundle.configuration.memory_v3).toBeTruthy();
		// The governance contract: what CAN be recorded, without what WAS.
		expect(bundle.governance.auditable_fields).toContain("severity");
		expect(bundle.governance.security_event_fields).toContain("ip_hash_prefix");
		expect(bundle.governance.trust_kinds).toContain("privacy_request");
		expect(bundle.governance.severities).toEqual(["low", "medium", "high", "critical"]);
		// The AI legality matrix — the provider governance evidence.
		expect(bundle.ai_routing.known_providers).toContain("workers-ai");
		expect(bundle.ai_routing.legality_matrix.length).toBeGreaterThan(5);
		expect(bundle.ai_routing.legality_matrix[0]).toHaveProperty("legal_modes");
	});

	it("counts trust cases and security events without naming anyone", async () => {
		const who = await signupAccount("bundle-counts");
		const created = await createTrustCase(env, { userId: who.user.id, kind: "privacy_request", category: "deletion", message: "please erase me" });
		expect(created.error).toBeUndefined();
		await recordSecurityEvent(env, { kind: "bundle_probe", severity: "low", groupKey: `bundle_probe:${crypto.randomUUID()}` });

		const bundle = await buildReviewBundle(env);
		const privacy = bundle.trust.by_kind_status_severity.find((row) => row.kind === "privacy_request");
		expect(privacy.n).toBeGreaterThanOrEqual(1);
		expect(bundle.trust.meta.open).toBeGreaterThanOrEqual(1);
		const probe = bundle.security_events.by_kind_severity.find((row) => row.kind === "bundle_probe");
		expect(probe.rows).toBeGreaterThanOrEqual(1);
		// Rows describe shape only.
		for (const row of bundle.trust.by_kind_status_severity) {
			expect(Object.keys(row).sort()).toEqual(["kind", "n", "severity", "status"]);
		}
	});

	it("discloses the same subprocessors the legal page publishes", async () => {
		const bundle = await buildReviewBundle(env);
		expect(bundle.subprocessors).toEqual(SUBPROCESSORS);
		// The bundle and the published page must not drift apart.
		const legal = html.slice(html.indexOf("subprocessors: {"), html.indexOf("subprocessors: {") + 4000);
		for (const entry of SUBPROCESSORS) {
			expect(legal).toContain(entry.name);
		}
	});

	it("states plainly what it excludes", async () => {
		const bundle = await buildReviewBundle(env);
		expect(bundle.disclosure.excludes).toMatch(/Memory content/);
		expect(bundle.disclosure.excludes).toMatch(/email addresses/);
		expect(bundle.disclosure.excludes).toMatch(/credentials/);
	});
});

describe("the console control", () => {
	it("is wired into the admin health tab", () => {
		expect(html).toContain("async function downloadReviewBundle()");
		expect(html).toContain('fetch("/v1/admin/review-bundle"');
		expect(html).toContain('onclick="downloadReviewBundle()"');
	});
});
