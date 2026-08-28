/* Trust cases (0062): the tracked queue behind the 7-day response promise.
 *
 * Pins: kind→severity mapping and the due clock on the DPDP-facing kinds;
 * secrets scrubbed BEFORE storage; the 3-per-24h abuse valve; the reporter
 * door (session-only, own cases only, never operator notes); the admin
 * lifecycle as audited mutations with optimistic concurrency; the immediate
 * vs digest email split; and account erasure keeping the content-free
 * skeleton while removing the message, notes and account link.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src";
import {
	createTrustCase,
	processTrustCaseNotifications,
	RESPONSE_DUE_MS,
} from "../src/lib/trust_cases.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";

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

describe("createTrustCase", () => {
	it("maps kind to severity and puts the 7-day clock on the DPDP-facing kinds", async () => {
		const who = await signupAccount("clock");
		const t0 = Date.now();
		const privacy = await createTrustCase(env, { userId: who.user.id, kind: "privacy_request", category: "deletion", message: "please delete", now: t0 });
		expect(privacy.severity).toBe("medium");
		expect(privacy.response_due_at).toBe(t0 + RESPONSE_DUE_MS);
		const security = await createTrustCase(env, { userId: who.user.id, kind: "security_report", message: "found a hole", now: t0 });
		expect(security.severity).toBe("high");
		expect(security.response_due_at).toBe(t0 + RESPONSE_DUE_MS);
		const support = await createTrustCase(env, { userId: who.user.id, kind: "support", message: "it broke", now: t0 });
		expect(support.severity).toBe("low");
		expect(support.response_due_at).toBeNull();
	});

	it("refuses junk and caps a reporter at three cases per day", async () => {
		const who = await signupAccount("cap");
		expect((await createTrustCase(env, { userId: who.user.id, kind: "nonsense", message: "x" })).error).toBe("invalid_kind");
		expect((await createTrustCase(env, { userId: who.user.id, kind: "support", message: "   " })).error).toBe("message_required");
		expect((await createTrustCase(env, { userId: who.user.id, kind: "support", message: "y".repeat(2001) })).error).toBe("message_too_long");
		expect((await createTrustCase(env, { userId: who.user.id, kind: "privacy_request", category: "evil", message: "x" })).error).toBe("invalid_category");
		const t0 = Date.now();
		for (let i = 0; i < 3; i++) {
			const ok = await createTrustCase(env, { userId: who.user.id, kind: "support", message: `report ${i}`, now: t0 + i });
			expect(ok.error).toBeUndefined();
		}
		const fourth = await createTrustCase(env, { userId: who.user.id, kind: "support", message: "one more", now: t0 + 10 });
		expect(fourth.error).toBe("trust_case_limit");
		expect(fourth.status).toBe(429);
	});

	it("scrubs secrets before the message is stored — same scrubber as the save doors", async () => {
		const who = await signupAccount("scrub");
		const created = await createTrustCase(env, {
			userId: who.user.id, kind: "support",
			message: "my key sk-abcdefghijklmnop1234 leaked into a memory",
		});
		expect(created.message).not.toContain("sk-abcdefghijklmnop1234");
		expect(created.message).toContain("[REDACTED:api-key]");
		const stored = await env.DB.prepare("SELECT message FROM trust_cases WHERE id = ?").bind(created.id).first();
		expect(stored.message).not.toContain("sk-abcdefghijklmnop1234");
	});
});

describe("the report door", () => {
	it("requires a session, files the case, and shows the reporter their own cases only", async () => {
		expect((await request("/v1/trust/report", jsonInit({ kind: "support", message: "hi" }))).status).toBe(401);

		const alice = await signupAccount("alice");
		const bob = await signupAccount("bob");
		const filed = await request("/v1/trust/report", jsonInit({ kind: "privacy_request", category: "access", message: "what do you hold on me?" }, alice.cookie));
		expect(filed.status).toBe(201);
		const body = await filed.json();
		expect(body.case.status).toBe("received");
		expect(body.case.response_due_at).toBeGreaterThan(Date.now());

		const mine = await request("/v1/trust/cases", { headers: { cookie: alice.cookie } });
		expect(mine.status).toBe(200);
		const cases = (await mine.json()).cases;
		expect(cases.some((c) => c.id === body.case.id)).toBe(true);
		// Never the operator's notes — not even as an empty field.
		for (const c of cases) expect("admin_notes" in c).toBe(false);

		const theirs = await request("/v1/trust/cases", { headers: { cookie: bob.cookie } });
		expect((await theirs.json()).cases.some((c) => c.id === body.case.id)).toBe(false);
	});
});

describe("the admin door", () => {
	it("gates the overview and walks a case through its audited lifecycle", async () => {
		const admin = await signupAccount("trustadm");
		const reporter = await signupAccount("reporter");
		expect((await request("/v1/admin/trust/overview")).status).toBe(401);
		expect((await request("/v1/admin/trust/overview", { headers: { cookie: reporter.cookie } })).status).toBe(403);
		await makeAdmin(admin.user.id);

		const filed = await request("/v1/trust/report", jsonInit({ kind: "security_report", message: "the door is ajar" }, reporter.cookie));
		const caseId = (await filed.json()).case.id;

		const overview = await request("/v1/admin/trust/overview", { headers: { cookie: admin.cookie } });
		expect(overview.status).toBe(200);
		const data = await overview.json();
		expect(data.meta.open).toBeGreaterThanOrEqual(1);
		const listed = data.cases.find((c) => c.id === caseId);
		expect(listed.email).toBe(reporter.email);
		expect(listed.response_due_at).toBeGreaterThan(Date.now());

		const act = (payload) => request("/v1/admin/trust/cases/action", jsonInit(payload, admin.cookie));

		// resolve without a resolution is refused before anything mutates.
		expect((await act({ caseId, action: "resolve" })).status).toBe(400);

		const ack = await act({ caseId, action: "acknowledge" });
		expect(ack.status).toBe(200);
		expect((await ack.json()).case.status).toBe("acknowledged");
		// Acknowledging twice is an invalid transition, not a silent no-op.
		expect((await act({ caseId, action: "acknowledge" })).status).toBe(409);

		const note = await act({ caseId, action: "note", note: "checked the logs, nothing exploited" });
		expect(note.status).toBe(200);
		expect((await note.json()).case.admin_notes).toHaveLength(1);

		const resolved = await act({ caseId, action: "resolve", resolution: "fixed" });
		expect(resolved.status).toBe(200);
		expect((await resolved.json()).case.resolution).toBe("fixed");

		const reopened = await act({ caseId, action: "reopen" });
		expect(reopened.status).toBe(200);
		expect((await reopened.json()).case.status).toBe("investigating");

		// The whole walk is in the audit ledger.
		const feed = await request("/v1/admin/audit-feed?limit=50", { headers: { cookie: admin.cookie } });
		const actions = (await feed.json()).entries
			.filter((entry) => entry.target?.id === caseId)
			.map((entry) => entry.action);
		for (const expected of ["trust.case.acknowledge", "trust.case.note", "trust.case.resolve", "trust.case.reopen"]) {
			expect(actions).toContain(expected);
		}
	});

	it("reclassifies with the clock anchored to receipt, not to the reclassification", async () => {
		const admin = await signupAccount("reclass");
		await makeAdmin(admin.user.id);
		const reporter = await signupAccount("reclassr");
		const filed = await request("/v1/trust/report", jsonInit({ kind: "support", message: "actually please delete my data" }, reporter.cookie));
		const filedCase = (await filed.json()).case;
		expect(filedCase.response_due_at).toBeNull();

		const res = await request("/v1/admin/trust/cases/action", jsonInit({
			caseId: filedCase.id, action: "reclassify", kind: "privacy_request", category: "deletion",
		}, admin.cookie));
		expect(res.status).toBe(200);
		const updated = (await res.json()).case;
		expect(updated.kind).toBe("privacy_request");
		expect(updated.response_due_at).toBe(filedCase.received_at + RESPONSE_DUE_MS);
	});
});

describe("owner notifications", () => {
	it("emails a security report immediately and digests the rest after the delay", async () => {
		const who = await signupAccount("notify");
		const t0 = Date.now() + 60 * 60 * 1000; // clear of any door-created rows
		const urgent = await createTrustCase(env, { userId: who.user.id, kind: "security_report", message: "urgent hole", now: t0 });
		const calm = await createTrustCase(env, { userId: who.user.id, kind: "privacy_request", message: "calm question", now: t0 + 1 });
		expect(urgent.error).toBeUndefined();
		expect(calm.error).toBeUndefined();

		const send = vi.fn(async () => ({ messageId: "msg_trust_1" }));
		const mailEnv = { ...env, EMAIL: { send }, OWNER_NOTIFY_EMAIL: "owner@example.com" };

		// At t0+1s only the urgent row is due — the digest row waits 30 minutes.
		await processTrustCaseNotifications(mailEnv, { now: t0 + 1000, limit: 20 });
		const urgentMails = send.mock.calls.filter(([m]) => m.subject.includes("security_report"));
		expect(urgentMails).toHaveLength(1);
		expect(urgentMails[0][0].to).toBe("owner@example.com");
		expect(urgentMails[0][0].text).toContain("urgent hole");

		send.mockClear();
		const later = await processTrustCaseNotifications(mailEnv, { now: t0 + 31 * 60 * 1000, limit: 20 });
		expect(later.sent).toBeGreaterThanOrEqual(1);
		const digestMails = send.mock.calls.filter(([m]) => m.subject.includes("new report"));
		expect(digestMails).toHaveLength(1);
		expect(digestMails[0][0].text).toContain("calm question");

		// Exactly-once: nothing left to send.
		send.mockClear();
		await processTrustCaseNotifications(mailEnv, { now: t0 + 60 * 60 * 1000, limit: 20 });
		expect(send).not.toHaveBeenCalled();
	});

	it("marks rows skipped rather than queueing forever when email is unconfigured", async () => {
		const who = await signupAccount("noconf");
		const t0 = Date.now() + 2 * 60 * 60 * 1000;
		const created = await createTrustCase(env, { userId: who.user.id, kind: "security_report", message: "hello?", now: t0 });
		const bare = { ...env };
		delete bare.EMAIL;
		delete bare.OWNER_NOTIFY_EMAIL;
		const result = await processTrustCaseNotifications(bare, { now: t0 + 1000, limit: 20 });
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		const row = await env.DB.prepare("SELECT notify_status FROM trust_cases WHERE id = ?").bind(created.id).first();
		expect(row.notify_status).toBe("skipped");
	});
});

describe("account erasure", () => {
	it("keeps the content-free skeleton and removes the message, notes and link", async () => {
		const who = await signupAccount("eraseme");
		const created = await createTrustCase(env, { userId: who.user.id, kind: "privacy_request", category: "deletion", message: "erase me and my words" });
		expect(created.error).toBeUndefined();

		const result = await deleteAccountCompletely(env, who.user.id);
		expect(result.deleted).toBe(true);

		const row = await env.DB.prepare("SELECT * FROM trust_cases WHERE id = ?").bind(created.id).first();
		expect(row).toBeTruthy();
		expect(row.user_id).toBeNull();
		expect(row.message).toBe("[erased]");
		expect(row.admin_notes).toBeNull();
		// The accountability skeleton survives: kind, severity, and the clock.
		expect(row.kind).toBe("privacy_request");
		expect(row.response_due_at).toBeTruthy();
	});

	it("severs an erased admin's provenance from other reporters' cases", async () => {
		const admin = await signupAccount("eraseadm");
		await makeAdmin(admin.user.id);
		const reporter = await signupAccount("erasereporter");
		const filed = await request("/v1/trust/report", jsonInit({ kind: "support", message: "note me" }, reporter.cookie));
		const caseId = (await filed.json()).case.id;
		const act = (payload) => request("/v1/admin/trust/cases/action", jsonInit(payload, admin.cookie));
		expect((await act({ caseId, action: "note", note: "looked into it" })).status).toBe(200);
		expect((await act({ caseId, action: "resolve", resolution: "answered" })).status).toBe(200);

		const result = await deleteAccountCompletely(env, admin.user.id);
		expect(result.deleted).toBe(true);

		const row = await env.DB.prepare(
			"SELECT resolved_by, admin_notes, user_id FROM trust_cases WHERE id = ?",
		).bind(caseId).first();
		// The acting admin's id is gone; the reporter's case is untouched.
		expect(row.resolved_by).toBeNull();
		expect(row.user_id).toBe(reporter.user.id);
		const notes = JSON.parse(row.admin_notes);
		expect(notes).toHaveLength(1);
		expect(notes[0].by).toBeNull();
		expect(notes[0].text).toBe("looked into it");
	});
});
