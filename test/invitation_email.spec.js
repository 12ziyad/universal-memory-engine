import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelInvitationEmail,
	getInvitationEmailDelivery,
	processInvitationEmailOutbox,
	queueInvitationEmail,
	scrubTerminalInvitationPii,
	TERMINAL_INVITATION_PII_RETENTION_MS,
} from "../src/lib/invitation_email.js";
import { acceptInvitation, createInvitation, revokeInvitation } from "../src/lib/invitations.js";

const KEY = "test-only-invitation-email-key-32-bytes-minimum";

async function fixture({ status = "pending", expiresAt = Date.now() + 86_400_000 } = {}) {
	const stamp = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
	const userId = `usr_${stamp}`;
	const orgId = `org_${stamp}`;
	const projectId = `proj_${stamp}`;
	const invitationId = `inv_${stamp}`;
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
			 VALUES (?, ?, ?, 'Owner', ?, ?, 'active', 'user')`,
		).bind(userId, `owner-${stamp}@example.com`, `owner-${stamp}@example.com`, now, now),
		env.DB.prepare(
			`INSERT INTO organizations
			 (id, owner_user_id, name, name_normalized, description, is_default, status, created_at, updated_at)
			 VALUES (?, ?, 'Acme & Partners', ?, NULL, 1, 'active', ?, ?)`,
		).bind(orgId, userId, `acme-${stamp}`, now, now),
		env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'owner', NULL, ?, ?)`,
		).bind(`om_${stamp}`, orgId, userId, now, now),
		env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, description,
			  is_default, status, organization_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'Launch <Alpha>', ?, NULL, 0, 'active', ?, ?, ?)`,
		).bind(projectId, userId, `mem_${stamp}`, `launch-${stamp}`, orgId, now, now),
		env.DB.prepare(
			`INSERT INTO organization_invitations
			 (id, org_id, project_id, email_normalized, org_role, project_role, token_hash,
			  status, invited_by_user_id, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'invitee@example.com', 'member', 'viewer', ?, ?, ?, ?, ?, ?)`,
		).bind(invitationId, orgId, projectId, `hash_${stamp}`, status, userId, expiresAt, now, now),
	]);
	return { invitationId, orgId, projectId, userId };
}

function mailEnv(send = vi.fn(async () => ({ messageId: "msg_123" }))) {
	return {
		DB: env.DB,
		EMAIL: { send },
		INVITATION_EMAIL_KEY: KEY,
		PUBLIC_ORIGIN: "https://itsuki.app",
		INVITE_EMAIL_FROM: "invites@notify.itsuki.app",
	};
}

describe("invitation email outbox", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM invitation_email_outbox").run();
	});

	it("falls back honestly to the copy-once link when email is not configured", async () => {
		const ids = await fixture();
		const result = await queueInvitationEmail({ DB: env.DB }, {
			...ids,
			recipientEmail: "invitee@example.com",
			token: "secret-token",
		});
		expect(result).toEqual({ configured: false, status: "copy_link_only" });
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM invitation_email_outbox").first();
		expect(Number(count.n)).toBe(0);
	});

	it("stores only encrypted token material, sends once, and erases the ciphertext", async () => {
		const ids = await fixture();
		const send = vi.fn(async () => ({ messageId: "msg_delivered" }));
		const testEnv = mailEnv(send);
		const token = "copy-once-super-secret";
		const queued = await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token,
		});
		expect(queued.configured).toBe(true);
		expect(queued.queued).toBe(true);

		// Retrying the HTTP response path must not mint a second delivery.
		await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token,
		});
		const encrypted = await env.DB.prepare(
			"SELECT payload_ciphertext, payload_iv FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(ids.invitationId).first();
		expect(encrypted.payload_ciphertext).not.toContain(token);
		expect(encrypted.payload_iv).toBeTruthy();

		const delivered = await processInvitationEmailOutbox(testEnv, { now: Date.now() });
		expect(delivered).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
		expect(send).toHaveBeenCalledTimes(1);
		const message = send.mock.calls[0][0];
		expect(message.to).toBe("invitee@example.com");
		expect(message.from.email).toBe("invites@notify.itsuki.app");
		expect(message.text).toContain(`/app#invite=${encodeURIComponent(token)}`);
		expect(message.text).not.toContain("project description");
		expect(message.html).toContain("Acme &amp; Partners");
		expect(message.html).toContain("Launch &lt;Alpha&gt;");

		const row = await env.DB.prepare(
			"SELECT status, payload_ciphertext, payload_iv, provider_message_id FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(ids.invitationId).first();
		expect(row).toEqual(expect.objectContaining({
			status: "sent",
			payload_ciphertext: null,
			payload_iv: null,
			provider_message_id: "msg_delivered",
		}));
		await processInvitationEmailOutbox(testEnv, { now: Date.now() + 60_000 });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("backs off transient failures and becomes terminal without retaining a usable link", async () => {
		const ids = await fixture();
		const send = vi.fn(async () => { throw new Error("provider unavailable with sensitive detail"); });
		const testEnv = mailEnv(send);
		await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token: "retry-secret",
		});
		// Queueing timestamps after fixture setup; start just beyond that write so
		// the first deterministic dispatch cannot land a millisecond too early.
		const start = Date.now() + 1_000;
		for (let attempt = 0; attempt < 5; attempt++) {
			await processInvitationEmailOutbox(testEnv, { now: start + attempt * 2 * 60 * 60 * 1000 });
		}
		const row = await env.DB.prepare(
			`SELECT status, attempts, payload_ciphertext, payload_iv, last_error_code
			 FROM invitation_email_outbox WHERE invitation_id = ?`,
		).bind(ids.invitationId).first();
		expect(row.status).toBe("failed");
		expect(Number(row.attempts)).toBe(5);
		expect(row.payload_ciphertext).toBeNull();
		expect(row.payload_iv).toBeNull();
		expect(row.last_error_code).toBe("email_delivery_failed");
		expect(JSON.stringify(row)).not.toContain("sensitive detail");
	});

	it("does not queue an expired or revoked invitation or contact the provider", async () => {
		const ids = await fixture({ status: "revoked" });
		const send = vi.fn();
		const testEnv = mailEnv(send);
		const queued = await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token: "revoked-secret",
		});
		expect(queued).toMatchObject({ configured: true, queued: false, status: "suppressed" });
		const result = await processInvitationEmailOutbox(testEnv, { now: Date.now() });
		expect(result.claimed).toBe(0);
		expect(send).not.toHaveBeenCalled();
		const row = await getInvitationEmailDelivery(testEnv, ids.invitationId);
		expect(row).toBeNull();
	});

	it("cannot queue recipient data after the inviter or organization is quiesced", async () => {
		const ids = await fixture();
		const testEnv = mailEnv();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
				.bind(ids.userId, Date.now()),
			env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(ids.userId),
		]);
		const queued = await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token: "must-not-survive",
		});
		expect(queued).toMatchObject({ configured: true, queued: false, status: "suppressed" });
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(ids.invitationId).first();
		expect(Number(count.n)).toBe(0);
	});

	it("scrubs never-registered recipient and provider PII 30 days after terminal state", async () => {
		const now = Date.now();
		const terminalAt = now - TERMINAL_INVITATION_PII_RETENTION_MS - 1;
		const old = await fixture({ status: "revoked", expiresAt: terminalAt });
		const pending = await fixture({ status: "pending", expiresAt: now + 86_400_000 });
		await env.DB.batch([
			env.DB.prepare("UPDATE organization_invitations SET updated_at = ? WHERE id = ?")
				.bind(terminalAt, old.invitationId),
			env.DB.prepare(
				`INSERT INTO invitation_email_outbox
				 (id, invitation_id, org_id, project_id, recipient_email, status, attempts,
				  provider_message_id, last_error_code, created_at, updated_at, sent_at)
				 VALUES (?, ?, ?, ?, 'never-registered@example.com', 'sent', 1,
				  'provider-personal-id', 'provider diagnostic', ?, ?, ?)`,
			).bind(`mail_${crypto.randomUUID()}`, old.invitationId, old.orgId, old.projectId, terminalAt, terminalAt, terminalAt),
		]);

		const first = await scrubTerminalInvitationPii(env, { now });
		expect(first).toMatchObject({ invitations_scrubbed: 1, deliveries_scrubbed: 1, retention_days: 30 });
		expect(await env.DB.prepare(
			"SELECT email_normalized FROM organization_invitations WHERE id = ?",
		).bind(old.invitationId).first()).toEqual({ email_normalized: "redacted@invalid" });
		expect(await env.DB.prepare(
			`SELECT recipient_email, provider_message_id, last_error_code, payload_ciphertext, payload_iv
			 FROM invitation_email_outbox WHERE invitation_id = ?`,
		).bind(old.invitationId).first()).toEqual({
			recipient_email: "redacted@invalid",
			provider_message_id: null,
			last_error_code: null,
			payload_ciphertext: null,
			payload_iv: null,
		});
		expect(await env.DB.prepare(
			"SELECT email_normalized, status FROM organization_invitations WHERE id = ?",
		).bind(pending.invitationId).first()).toMatchObject({ email_normalized: "invitee@example.com", status: "pending" });
		expect(await scrubTerminalInvitationPii(env, { now })).toMatchObject({
			invitations_scrubbed: 0,
			deliveries_scrubbed: 0,
		});
	});

	it("revocation clears a queued token immediately and is idempotent", async () => {
		const ids = await fixture();
		const testEnv = mailEnv();
		await queueInvitationEmail(testEnv, {
			...ids,
			recipientEmail: "invitee@example.com",
			token: "queued-secret",
		});
		expect((await cancelInvitationEmail(testEnv, ids.invitationId)).cancelled).toBe(true);
		expect((await cancelInvitationEmail(testEnv, ids.invitationId)).cancelled).toBe(false);
		const raw = await env.DB.prepare(
			"SELECT status, payload_ciphertext, payload_iv FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(ids.invitationId).first();
		expect(raw).toEqual({ status: "suppressed", payload_ciphertext: null, payload_iv: null });
	});

	it("replacement, explicit revoke and acceptance immediately clear superseded ciphertext", async () => {
		const ids = await fixture();
		const send = vi.fn(async () => ({ messageId: "should-not-send-old" }));
		const testEnv = mailEnv(send);
		const first = await createInvitation(testEnv, {
			orgId: ids.orgId,
			projectId: ids.projectId,
			email: "invitee@example.com",
			projectRole: "viewer",
			invitedByUserId: ids.userId,
			origin: "https://itsuki.app",
		});
		expect(first.email_delivery.status).toBe("queued");
		const second = await createInvitation(testEnv, {
			orgId: ids.orgId,
			projectId: ids.projectId,
			email: "invitee@example.com",
			projectRole: "member",
			invitedByUserId: ids.userId,
			origin: "https://itsuki.app",
		});
		const replaced = await env.DB.prepare(
			"SELECT status, payload_ciphertext FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(first.invitation.id).first();
		expect(replaced).toEqual({ status: "suppressed", payload_ciphertext: null });
		await revokeInvitation(testEnv, ids.orgId, second.invitation.id);
		const revoked = await env.DB.prepare(
			"SELECT status, payload_ciphertext FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(second.invitation.id).first();
		expect(revoked).toEqual({ status: "suppressed", payload_ciphertext: null });

		const acceptEmail = `accept-${crypto.randomUUID()}@example.com`;
		const acceptUser = `usr_${crypto.randomUUID()}`;
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
			 VALUES (?, ?, ?, 'Invitee', ?, ?, 'active', 'user')`,
		).bind(acceptUser, acceptEmail, acceptEmail, at, at).run();
		const acceptedInvite = await createInvitation(testEnv, {
			orgId: ids.orgId,
			projectId: ids.projectId,
			email: acceptEmail,
			projectRole: "viewer",
			invitedByUserId: ids.userId,
			origin: "https://itsuki.app",
		});
		const token = decodeURIComponent(acceptedInvite.link.split("#invite=")[1]);
		expect(await acceptInvitation(testEnv, token, { id: acceptUser, email: acceptEmail }))
			.toMatchObject({ ok: true, org_id: ids.orgId, project_id: ids.projectId });
		const acceptedDelivery = await env.DB.prepare(
			"SELECT status, payload_ciphertext FROM invitation_email_outbox WHERE invitation_id = ?",
		).bind(acceptedInvite.invitation.id).first();
		expect(acceptedDelivery).toEqual({ status: "suppressed", payload_ciphertext: null });
		await processInvitationEmailOutbox(testEnv, { now: Date.now() + 1_000 });
		expect(send).not.toHaveBeenCalled();
	});
});
