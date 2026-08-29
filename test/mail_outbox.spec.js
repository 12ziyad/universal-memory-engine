/* The shared transactional outbox and the ten things that earn an email.
 *
 * The rule these tests exist to defend is not "email works" — it is that a
 * completion email is only ever sent by a path that has already VERIFIED the
 * thing completed, and that routine product activity never triggers one.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import {
	MAIL_KINDS,
	enqueueMail,
	processMailOutbox,
	memoryPurgedMail,
	projectDeletedMail,
	accountDeletionDoneMail,
	privacyCaseReceivedMail,
	transferOfferMail,
	transferDoneMail,
} from "../src/lib/mail.js";
import { renderEmail } from "../src/lib/email_template.js";

const mailEnv = (send) => ({ ...env, EMAIL: { send } });

async function rowsFor(kind) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM mail_outbox WHERE kind = ? ORDER BY created_at DESC",
	).bind(kind).all();
	return results ?? [];
}

describe("what earns an email", () => {
	it("is a short, closed list — routine product activity is not on it", () => {
		// If this list grows, that should be a decision someone made on
		// purpose. Nobody wants mail because a memory was saved.
		expect(MAIL_KINDS).toHaveLength(13);
		for (const routine of [
			"memory_saved", "memory_deleted", "login", "google_login",
			"recall", "webhook_delivered", "settings_changed", "api_call",
		]) {
			expect(MAIL_KINDS).not.toContain(routine);
		}
		expect(MAIL_KINDS).toContain("account_deletion_done");
		expect(MAIL_KINDS).toContain("privacy_case_received");
	});

	it("refuses an unknown kind rather than inventing one", async () => {
		const result = await enqueueMail(env, { kind: "marketing_blast", to: "a@example.com", subject: "hi", blocks: {} });
		expect(result.queued).toBe(false);
		expect(result.reason).toBe("unknown_kind");
	});

	it("refuses a missing or malformed address instead of queueing junk", async () => {
		for (const to of [null, "", "not-an-email"]) {
			const result = await enqueueMail(env, { kind: "billing_event", to, subject: "x", blocks: {} });
			expect(result.queued).toBe(false);
			expect(result.reason).toBe("no_address");
		}
	});
});

describe("the queue", () => {
	it("sends once, records it, and does not send again", async () => {
		const to = `outbox-${crypto.randomUUID()}@example.com`;
		await enqueueMail(env, {
			kind: "billing_event", to, subject: "Probe one",
			blocks: { kicker: "k", heading: "h", blocks: [{ type: "paragraph", text: "body" }] },
		});
		const send = vi.fn(async () => ({ messageId: "m1" }));
		const first = await processMailOutbox(mailEnv(send), { limit: 50 });
		expect(first.sent).toBeGreaterThanOrEqual(1);
		const mine = send.mock.calls.filter(([m]) => m.to === to);
		expect(mine).toHaveLength(1);
		expect(mine[0][0].subject).toBe("Probe one");
		expect(mine[0][0].html).toContain("body");

		send.mockClear();
		await processMailOutbox(mailEnv(send), { limit: 50 });
		expect(send.mock.calls.filter(([m]) => m.to === to)).toHaveLength(0);
	});

	it("is idempotent on the dedupe key — one event, one email", async () => {
		const to = `dedupe-${crypto.randomUUID()}@example.com`;
		const key = `probe:${crypto.randomUUID()}`;
		const payload = { kind: "project_deleted", to, subject: "Deleted", blocks: { kicker: "k", heading: "h" }, dedupeKey: key };
		expect((await enqueueMail(env, payload)).queued).toBe(true);
		// A retried lifecycle run enqueues the same key again.
		expect((await enqueueMail(env, payload)).queued).toBe(false);
		const { results } = await env.DB.prepare("SELECT id FROM mail_outbox WHERE dedupe_key = ?").bind(key).all();
		expect(results).toHaveLength(1);
	});

	it("retries a failing send with backoff, then gives up rather than looping", async () => {
		const to = `retry-${crypto.randomUUID()}@example.com`;
		await enqueueMail(env, { kind: "billing_event", to, subject: "Retry probe", blocks: { kicker: "k", heading: "h" } });
		const boom = vi.fn(async () => { throw new Error("provider down"); });
		let now = Date.now();
		for (let attempt = 1; attempt <= 5; attempt++) {
			await processMailOutbox(mailEnv(boom), { limit: 50, now });
			now += 2 * 60 * 60 * 1000; // past any backoff
		}
		const row = (await env.DB.prepare("SELECT status, attempts, last_error FROM mail_outbox WHERE to_email = ?").bind(to).first());
		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(5);
		expect(row.last_error).toContain("provider down");
	});

	it("marks rows skipped rather than queueing forever with no email binding", async () => {
		const to = `noemail-${crypto.randomUUID()}@example.com`;
		await enqueueMail(env, { kind: "billing_event", to, subject: "No binding", blocks: { kicker: "k", heading: "h" } });
		const bare = { ...env };
		delete bare.EMAIL;
		const result = await processMailOutbox(bare, { limit: 50 });
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		const row = await env.DB.prepare("SELECT status FROM mail_outbox WHERE to_email = ?").bind(to).first();
		expect(row.status).toBe("skipped");
	});

	it("reclaims a row a dead isolate left mid-send", async () => {
		const to = `stale-${crypto.randomUUID()}@example.com`;
		await enqueueMail(env, { kind: "billing_event", to, subject: "Stale", blocks: { kicker: "k", heading: "h" } });
		await env.DB.prepare(
			"UPDATE mail_outbox SET status = 'sending', updated_at = ? WHERE to_email = ?",
		).bind(Date.now() - 60 * 60 * 1000, to).run();
		const send = vi.fn(async () => ({ messageId: "m" }));
		await processMailOutbox(mailEnv(send), { limit: 50 });
		expect(send.mock.calls.some(([m]) => m.to === to)).toBe(true);
	});
});

describe("the messages themselves", () => {
	it("say what happened without shouting, and carry no tracking", () => {
		const { html, text } = renderEmail(memoryPurgedMail(env, {
			projectName: "Atlas", verified: { spaces: 3, residual: 0 },
		}).blocks);
		expect(text).toContain("Atlas");
		expect(text).toContain("Memory spaces cleared: 3");
		// The honest framing: this arrives after the check, and says so.
		expect(text).toMatch(/residue check/i);
		// No remote anything — a delivered message never phones home.
		expect(html).not.toMatch(/<img|<script|@import|url\(/);
	});

	it("does not congratulate anyone on a deletion", () => {
		const deleted = renderEmail(projectDeletedMail(env, { projectName: "Atlas" }).blocks).text;
		const account = renderEmail(accountDeletionDoneMail(env, { email: "x@example.com" }).blocks).text;
		for (const body of [deleted, account]) {
			expect(body).not.toMatch(/congratulations|great news|excited|🎉/i);
		}
		// And they state what deliberately remains, rather than implying
		// nothing does.
		expect(deleted).toMatch(/tombstone/i);
		expect(account).toMatch(/content-free/i);
	});

	it("gives a privacy case its id and the date we owe an answer", () => {
		const { text } = renderEmail(privacyCaseReceivedMail(env, {
			caseId: "case_abc123def456", kind: "privacy_request", dueLabel: "2026-09-05",
		}).blocks);
		expect(text).toContain("case_abc123def456");
		expect(text).toContain("2026-09-05");
		expect(text).toMatch(/a person reads/i);
	});

	it("tells each side of a transfer the thing that side needs to know", () => {
		const shared = { projectName: "Atlas", toEmail: "new@example.com", fromEmail: "old@example.com" };
		const toNew = renderEmail(transferDoneMail(env, { ...shared, forRecipient: true }).blocks).text;
		const toOld = renderEmail(transferDoneMail(env, { ...shared, forRecipient: false }).blocks).text;
		expect(toNew).toMatch(/is yours/i);
		expect(toOld).toMatch(/handed over/i);
		// The old owner is told they kept admin — the thing they would
		// otherwise panic about.
		expect(toOld).toMatch(/administrator/i);
	});

	it("makes an offer read as an offer, not as a completed act", () => {
		const { text } = renderEmail(transferOfferMail(env, {
			projectName: "Atlas", fromName: "Sam", fromEmail: "sam@example.com",
			link: "https://itsuki.app/app#transfer=1.2", expiresLabel: "2026-09-05",
		}).blocks);
		expect(text).toMatch(/Nothing has changed yet/i);
		expect(text).toMatch(/only if you accept/i);
		expect(text).toContain("https://itsuki.app/app#transfer=1.2");
	});
});
