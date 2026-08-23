import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMAIL_CHALLENGE_COOKIE,
	purgeExpiredEmailChallenges,
	startEmailChallenge,
	verifyEmailChallenge,
} from "../src/lib/passwordless_auth.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";
import worker from "../src/index.js";

const AUTH_EMAIL_SECRET = "test-only-passwordless-secret-at-least-32-bytes";

function testEnv(send = vi.fn(async () => ({ messageId: "msg_otp" }))) {
	return {
		DB: env.DB,
		EMAIL: { send },
		AUTH_EMAIL_SECRET,
		INVITE_EMAIL_FROM: "invites@notify.itsuki.app",
	};
}

function request(path, cookie = null) {
	const headers = new Headers({
		"user-agent": "Itsuki focused auth test",
		"cf-connecting-ip": "203.0.113.8",
	});
	if (cookie) headers.set("cookie", cookie.split(";", 1)[0]);
	return new Request(`https://itsuki.app${path}`, { method: "POST", headers });
}

function deliveredCode(send) {
	const mail = send.mock.calls[0][0];
	return mail.text.match(/verification code is: (\d{6})/)[1];
}

function challengeId(cookie) {
	const pair = cookie.split(";", 1)[0];
	return decodeURIComponent(pair.slice(pair.indexOf("=") + 1)).split(".", 1)[0];
}

describe("passwordless email authentication", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM auth_email_challenges").run();
	});

	it("stores only MACs, binds the challenge to the browser, and sends one code", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_1" }));
		const email = `otp-${crypto.randomUUID()}@example.com`;
		const result = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });

		expect(result.status).toBe(202);
		expect(result.cookie).toContain(`${EMAIL_CHALLENGE_COOKIE}=`);
		expect(result.cookie).toContain("HttpOnly");
		expect(result.cookie).toContain("SameSite=Strict");
		expect(result.cookie).toContain("Secure");
		expect(send).toHaveBeenCalledTimes(1);
		const code = deliveredCode(send);
		const row = await env.DB.prepare(
			"SELECT code_mac, browser_token_hash, email_hmac FROM auth_email_challenges WHERE email_normalized = ?",
		).bind(email).first();
		expect(row.code_mac).not.toContain(code);
		expect(row.browser_token_hash).not.toContain(result.cookie.split(".")[1] || "never");
		expect(JSON.stringify(row)).not.toContain(email);
	});

	it("creates a verified account, identity, and shared session for the correct code", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_2" }));
		const email = `new-${crypto.randomUUID()}@example.com`;
		const started = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		const verified = await verifyEmailChallenge(
			testEnv(send),
			request("/auth/email/verify", started.cookie),
			{ code: deliveredCode(send) },
		);

		expect(verified.status).toBe(201);
		expect(verified.created).toBe(true);
		expect(verified.user.email).toBe(email);
		expect(verified.session.cookie).toContain("uml_session=");
		expect(verified.cookie).toContain("Max-Age=0");
		const identity = await env.DB.prepare(
			"SELECT provider, provider_subject, email_verified_at FROM auth_identities WHERE user_id = ?",
		).bind(verified.user.id).first();
		expect(identity.provider).toBe("email");
		expect(identity.provider_subject).toBe(email);
		expect(Number(identity.email_verified_at)).toBeGreaterThan(0);
		const challenge = await env.DB.prepare(
			"SELECT email_normalized FROM auth_email_challenges WHERE id = ?",
		).bind(challengeId(started.cookie)).first();
		expect(challenge.email_normalized).toBe("");
	});

	it("links a verified email to the existing password account instead of duplicating it", async () => {
		const stamp = crypto.randomUUID();
		const id = `user_${stamp}`;
		const email = `existing-${stamp}@example.com`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO users (id, email, email_normalized, password_hash, password_salt, name,
			 created_at, updated_at, status, role)
			 VALUES (?, ?, ?, 'pbkdf2_sha256$100000$x$y', 'salt', 'Existing', ?, ?, 'active', 'user')`,
		).bind(id, email, email, now, now).run();
		const send = vi.fn(async () => ({ messageId: "msg_3" }));
		const started = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		const verified = await verifyEmailChallenge(
			testEnv(send), request("/auth/email/verify", started.cookie), { code: deliveredCode(send) },
		);

		expect(verified.status).toBe(200);
		expect(verified.created).toBe(false);
		expect(verified.user.id).toBe(id);
		const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email_normalized = ?").bind(email).first();
		expect(Number(users.n)).toBe(1);
	});

	it("rate-limits resend durably without sending a second message", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_4" }));
		const email = `cooldown-${crypto.randomUUID()}@example.com`;
		const first = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		const second = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		expect(first.status).toBe(202);
		expect(second.status).toBe(429);
		expect(second.retryAfter).toBe(60);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not spend attempts from a different browser and locks after five wrong codes", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_5" }));
		const email = `attempts-${crypto.randomUUID()}@example.com`;
		const started = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		const alien = await verifyEmailChallenge(
			testEnv(send),
			request("/auth/email/verify", `${EMAIL_CHALLENGE_COOKIE}=alien.invalid; Path=/`),
			{ code: "000000" },
		);
		expect(alien.status).toBe(401);
		const id = challengeId(started.cookie);
		let row = await env.DB.prepare("SELECT attempts FROM auth_email_challenges WHERE id = ?").bind(id).first();
		expect(Number(row.attempts)).toBe(0);

		for (let index = 0; index < 5; index++) {
			await verifyEmailChallenge(testEnv(send), request("/auth/email/verify", started.cookie), { code: "000000" });
		}
		row = await env.DB.prepare(
			"SELECT attempts, invalidated_at, email_normalized FROM auth_email_challenges WHERE id = ?",
		).bind(id).first();
		expect(Number(row.attempts)).toBe(5);
		expect(Number(row.invalidated_at)).toBeGreaterThan(0);
		expect(row.email_normalized).toBe("");
		const replay = await verifyEmailChallenge(
			testEnv(send), request("/auth/email/verify", started.cookie), { code: deliveredCode(send) },
		);
		expect(replay.status).toBe(401);
	});

	it("invalidates the challenge when synchronous delivery fails", async () => {
		const send = vi.fn(async () => { throw new Error("provider unavailable"); });
		const email = `failed-${crypto.randomUUID()}@example.com`;
		const result = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		expect(result.status).toBe(503);
		const row = await env.DB.prepare(
			"SELECT invalidated_at, email_normalized FROM auth_email_challenges ORDER BY created_at DESC LIMIT 1",
		).first();
		expect(Number(row.invalidated_at)).toBeGreaterThan(0);
		expect(row.email_normalized).toBe("");
	});

	it("deletes expired challenges in bounded cron slices and ages terminal rows at their original TTL", async () => {
		const now = Date.now();
		const insert = (id, expiresAt, consumedAt = null, invalidatedAt = null) => env.DB.prepare(
			`INSERT INTO auth_email_challenges
			 (id, email_normalized, email_hmac, code_mac, browser_token_hash, purpose,
			  attempts, max_attempts, expires_at, consumed_at, invalidated_at,
			  created_at, last_sent_at)
			 VALUES (?, ?, ?, 'mac', 'browser', 'signin', 0, 5, ?, ?, ?, ?, ?)`,
		).bind(id, `${id}@example.com`, `hmac-${id}`, expiresAt, consumedAt, invalidatedAt, now - 20_000, now - 20_000);
		await env.DB.batch([
			insert("emc_cleanup_expired_a", now - 3_000),
			insert("emc_cleanup_expired_consumed", now - 2_000, now - 10_000, null),
			insert("emc_cleanup_expired_invalidated", now - 1_000, null, now - 5_000),
			insert("emc_cleanup_live", now + 60_000),
			insert("emc_cleanup_terminal_future", now + 60_000, now - 5_000, null),
		]);

		await expect(purgeExpiredEmailChallenges(testEnv(), { now, limit: 2 }))
			.resolves.toEqual({ deleted: 2, limit: 2 });
		let count = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_email_challenges").first("n");
		expect(Number(count)).toBe(3);
		await expect(purgeExpiredEmailChallenges(testEnv(), { now, limit: 2 }))
			.resolves.toEqual({ deleted: 1, limit: 2 });
		count = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_email_challenges").first("n");
		expect(Number(count)).toBe(2);
		const remaining = await env.DB.prepare("SELECT id FROM auth_email_challenges ORDER BY id").all();
		expect(remaining.results.map((row) => row.id)).toEqual([
			"emc_cleanup_live",
			"emc_cleanup_terminal_future",
		]);
		await expect(purgeExpiredEmailChallenges(testEnv(), { now: now + 60_000, limit: 2 }))
			.resolves.toEqual({ deleted: 2, limit: 2 });
	});

	it("wires bounded challenge cleanup into scheduled housekeeping", async () => {
		const scheduledTime = Date.now();
		const insert = (id, expiresAt) => env.DB.prepare(
			`INSERT INTO auth_email_challenges
			 (id, email_normalized, email_hmac, code_mac, browser_token_hash, purpose,
			  attempts, max_attempts, expires_at, consumed_at, invalidated_at,
			  created_at, last_sent_at)
			 VALUES (?, '', ?, 'mac', 'browser', 'signin', 0, 5, ?, NULL, NULL, ?, ?)`,
		).bind(id, `hmac-${id}`, expiresAt, scheduledTime - 20_000, scheduledTime - 20_000);
		await env.DB.batch([
			insert("emc_scheduled_expired", scheduledTime - 1),
			insert("emc_scheduled_live", scheduledTime + 60_000),
		]);

		const waits = [];
		await worker.scheduled(
			{ scheduledTime, cron: "*/5 * * * *" },
			{ ...env, ...testEnv() },
			{ waitUntil(promise) { waits.push(Promise.resolve(promise)); } },
		);
		await Promise.allSettled(waits);

		expect(await env.DB.prepare("SELECT id FROM auth_email_challenges WHERE id = ?")
			.bind("emc_scheduled_expired").first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM auth_email_challenges WHERE id = ?")
			.bind("emc_scheduled_live").first("id")).toBe("emc_scheduled_live");
	});

	it("removes both active and plaintext-scrubbed challenge residue during complete account erasure", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_erasure" }));
		const email = `erase-${crypto.randomUUID()}@example.com`;
		const runtime = { ...env, ...testEnv(send) };
		const consumed = await startEmailChallenge(runtime, request("/auth/email/start"), { email });
		const verified = await verifyEmailChallenge(
			runtime,
			request("/auth/email/verify", consumed.cookie),
			{ code: deliveredCode(send) },
		);
		send.mockClear();
		const active = await startEmailChallenge(runtime, request("/auth/email/start"), { email });
		expect(active.status).toBe(202);
		const unrelatedId = `emc_unrelated_${crypto.randomUUID()}`;
		const stamp = Date.now();
		await env.DB.prepare(
			`INSERT INTO auth_email_challenges
			 (id, email_normalized, email_hmac, code_mac, browser_token_hash, purpose,
			  attempts, max_attempts, expires_at, consumed_at, invalidated_at, created_at, last_sent_at)
			 VALUES (?, '', 'unrelated-hmac', 'mac', 'browser', 'signin', 1, 5, ?, ?, NULL, ?, ?)`,
		).bind(unrelatedId, stamp + 60_000, stamp, stamp, stamp).run();
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM auth_email_challenges WHERE email_hmac = (SELECT email_hmac FROM auth_email_challenges WHERE id = ?)",
		).bind(challengeId(consumed.cookie)).first("n");
		expect(Number(before)).toBe(2);

		expect((await deleteAccountCompletely(runtime, verified.user.id)).deleted).toBe(true);
		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM auth_email_challenges WHERE id IN (?, ?)",
		).bind(challengeId(consumed.cookie), challengeId(active.cookie)).first("n");
		expect(Number(after)).toBe(0);
		expect(await env.DB.prepare("SELECT id FROM auth_email_challenges WHERE id = ?")
			.bind(unrelatedId).first("id")).toBe(unrelatedId);
	});

	it("fails account erasure closed when the email-HMAC secret is unavailable, then converges on retry", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_erasure_retry" }));
		const email = `erase-retry-${crypto.randomUUID()}@example.com`;
		const runtime = { ...env, ...testEnv(send) };
		const started = await startEmailChallenge(runtime, request("/auth/email/start"), { email });
		const verified = await verifyEmailChallenge(
			runtime,
			request("/auth/email/verify", started.cookie),
			{ code: deliveredCode(send) },
		);
		const challengeIdValue = challengeId(started.cookie);

		await expect(deleteAccountCompletely({ ...runtime, AUTH_EMAIL_SECRET: undefined }, verified.user.id))
			.rejects.toThrow(/AUTH_EMAIL_SECRET/i);
		expect(await env.DB.prepare("SELECT status FROM users WHERE id = ?")
			.bind(verified.user.id).first("status")).toBe("active");
		expect(await env.DB.prepare("SELECT id FROM auth_email_challenges WHERE id = ?")
			.bind(challengeIdValue).first("id")).toBe(challengeIdValue);

		expect((await deleteAccountCompletely(runtime, verified.user.id)).deleted).toBe(true);
		expect(await env.DB.prepare("SELECT id FROM auth_email_challenges WHERE id = ?")
			.bind(challengeIdValue).first()).toBeNull();
	});

	it("delivers the unified template with the code in both surfaces and no remote loads", async () => {
		const send = vi.fn(async () => ({ messageId: "msg_template" }));
		const email = `template-${crypto.randomUUID()}@example.com`;
		const result = await startEmailChallenge(testEnv(send), request("/auth/email/start"), { email });
		expect(result.status).toBe(202);
		const mail = send.mock.calls[0][0];
		const code = deliveredCode(send);
		expect(mail.subject).toBe("Your Itsuki sign-in code");
		expect(mail.text).toContain(code);
		expect(mail.html).toContain(code);
		expect(mail.html).toContain("Itsuki · secure access");
		// A sign-in code email carries no links at all, and never loads anything
		// remote — no images, scripts, styles, or fonts to phone home with.
		expect(mail.html).not.toMatch(/https?:/);
		expect(mail.html).not.toMatch(/<img|<link|<script|@import|url\(|src=/i);
		expect(mail.text).not.toContain("<");
	});

	it("falls back to the allowlisted sender when INVITE_EMAIL_FROM is malformed", async () => {
		const garbageSend = vi.fn(async () => ({ messageId: "msg_garbage_sender" }));
		const garbage = await startEmailChallenge(
			{ ...testEnv(garbageSend), INVITE_EMAIL_FROM: "not an address" },
			request("/auth/email/start"),
			{ email: `sender-a-${crypto.randomUUID()}@example.com` },
		);
		expect(garbage.status).toBe(202);
		expect(garbageSend.mock.calls[0][0].from.email).toBe("invites@notify.itsuki.app");

		const customSend = vi.fn(async () => ({ messageId: "msg_custom_sender" }));
		const custom = await startEmailChallenge(
			{ ...testEnv(customSend), INVITE_EMAIL_FROM: "  Codes@Notify.Itsuki.App  " },
			request("/auth/email/start"),
			{ email: `sender-b-${crypto.randomUUID()}@example.com` },
		);
		expect(custom.status).toBe(202);
		expect(customSend.mock.calls[0][0].from.email).toBe("codes@notify.itsuki.app");
	});
});
