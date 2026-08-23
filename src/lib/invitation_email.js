/**
 * Transactional invitation email over Cloudflare Email Sending.
 *
 * The invitation token is encrypted before it enters D1 and is erased as soon
 * as delivery reaches a terminal state. Email is a delivery aid, never the
 * authority: the hash-only invitation record remains the single-use gate and
 * the copy-once link returned to the inviter remains the recovery path.
 */

import { newId } from "./ids.js";
import { renderEmail } from "./email_template.js";
import { writeAudit } from "./audit.js";

const DEFAULT_ORIGIN = "https://itsuki.app";
const DEFAULT_SENDER = "invites@notify.itsuki.app";
const MAX_ATTEMPTS = 5;
const MAX_BATCH = 25;
const STALE_SENDING_MS = 10 * 60 * 1000;
export const TERMINAL_INVITATION_PII_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REDACTED_EMAIL = "redacted@invalid";

function bytesToBase64Url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
	const normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function publicOrigin(env) {
	try {
		const url = new URL(env.PUBLIC_ORIGIN || DEFAULT_ORIGIN);
		return `${url.protocol}//${url.host}`;
	} catch {
		return DEFAULT_ORIGIN;
	}
}

function senderAddress(env) {
	const value = String(env.INVITE_EMAIL_FROM || DEFAULT_SENDER).trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+$/.test(value) ? value : DEFAULT_SENDER;
}

async function encryptionKey(env) {
	const secret = String(env.INVITATION_EMAIL_KEY || "");
	if (secret.length < 32) throw new Error("invitation_email_key_unavailable");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associatedData({ invitationId, orgId, recipientEmail }) {
	return new TextEncoder().encode(
		JSON.stringify([String(invitationId), String(orgId), String(recipientEmail).toLowerCase()]),
	);
}

async function encryptToken(env, token, scope) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: associatedData(scope) },
		await encryptionKey(env),
		new TextEncoder().encode(JSON.stringify({ token: String(token) })),
	);
	return {
		ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
		iv: bytesToBase64Url(iv),
	};
}

async function decryptToken(env, row) {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: base64UrlToBytes(row.payload_iv),
			additionalData: associatedData({
				invitationId: row.invitation_id,
				orgId: row.org_id,
				recipientEmail: row.recipient_email,
			}),
		},
		await encryptionKey(env),
		base64UrlToBytes(row.payload_ciphertext),
	);
	const parsed = JSON.parse(new TextDecoder().decode(plaintext));
	if (!parsed?.token || typeof parsed.token !== "string") throw new Error("invitation_email_payload_invalid");
	return parsed.token;
}

export function invitationEmailConfigured(env) {
	return Boolean(env?.EMAIL && String(env?.INVITATION_EMAIL_KEY || "").length >= 32);
}

/** Queue one delivery. Repeated calls for one invitation are idempotent. */
export async function queueInvitationEmail(env, {
	invitationId,
	orgId,
	projectId = null,
	recipientEmail,
	token,
} = {}) {
	if (!invitationEmailConfigured(env)) {
		return { configured: false, status: "copy_link_only" };
	}
	const email = String(recipientEmail || "").trim().toLowerCase();
	if (!invitationId || !orgId || !token || !/^[^\s@]+@[^\s@]+$/.test(email)) {
		throw new Error("invitation_email_invalid");
	}
	const encrypted = await encryptToken(env, token, { invitationId, orgId, recipientEmail: email });
	const now = Date.now();
	const id = newId("mail");
	const inserted = await env.DB.prepare(
		`INSERT INTO invitation_email_outbox
		 (id, invitation_id, org_id, project_id, recipient_email, payload_ciphertext, payload_iv,
		  status, attempts, run_after, created_at, updated_at)
		 SELECT ?, i.id, i.org_id, i.project_id, i.email_normalized, ?, ?, 'queued', 0, ?, ?, ?
		   FROM organization_invitations i
		   JOIN organizations o ON o.id = i.org_id AND o.status = 'active'
		   JOIN users u ON u.id = i.invited_by_user_id AND u.status = 'active'
		  WHERE i.id = ? AND i.org_id = ? AND i.email_normalized = ?
		    AND i.status = 'pending' AND i.expires_at > ?
		    AND NOT EXISTS (
		      SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = i.invited_by_user_id
		    )
		    AND (
		      i.project_id IS NULL OR EXISTS (
		        SELECT 1 FROM managed_projects p
		         WHERE p.id = i.project_id AND p.status = 'active'
		           AND COALESCE(p.organization_id, (
		             SELECT d.id FROM organizations d
		              WHERE d.owner_user_id = p.owner_user_id
		                AND d.is_default = 1 AND d.status = 'active'
		              LIMIT 1
		           )) = i.org_id
		      )
		    )
		 ON CONFLICT(invitation_id) DO NOTHING`,
	).bind(
		id,
		encrypted.ciphertext,
		encrypted.iv,
		now,
		now,
		now,
		invitationId,
		orgId,
		email,
		now,
	).run();
	const row = await env.DB.prepare(
		"SELECT id, status, attempts, created_at, sent_at FROM invitation_email_outbox WHERE invitation_id = ?",
	).bind(invitationId).first();
	if (!row && Number(inserted?.meta?.changes ?? 0) === 0) {
		return { configured: true, queued: false, status: "suppressed", reason: "invitation_unavailable" };
	}
	return { configured: true, queued: row?.status === "queued", ...row };
}

export async function cancelInvitationEmail(env, invitationId, reason = "invitation_unavailable") {
	if (!invitationId) return { cancelled: false };
	const result = await env.DB.prepare(
		`UPDATE invitation_email_outbox
		 SET status = 'suppressed', payload_ciphertext = NULL, payload_iv = NULL,
		     last_error_code = ?, run_after = NULL, updated_at = ?
		 WHERE invitation_id = ? AND status IN ('queued', 'sending')`,
	).bind(String(reason).slice(0, 64), Date.now(), invitationId).run();
	return { cancelled: Number(result?.meta?.changes ?? 0) > 0 };
}

export async function getInvitationEmailDelivery(env, invitationId) {
	if (!invitationId) return null;
	const row = await env.DB.prepare(
		`SELECT id, invitation_id, status, attempts, last_error_code, created_at, updated_at, sent_at
		 FROM invitation_email_outbox WHERE invitation_id = ?`,
	).bind(invitationId).first();
	return row ?? null;
}

/**
 * Invitation authority is short lived, so recipient/provider data is too.
 * Live pending invitations retain the normalized address needed for the
 * signed-in-account match. Thirty days after a terminal transition, the
 * address and provider diagnostics are irreversibly replaced/cleared while
 * ids, roles, statuses and timestamps remain available for content-free audit.
 */
export async function scrubTerminalInvitationPii(env, { now = Date.now(), limit = MAX_BATCH } = {}) {
	const boundedLimit = Math.max(1, Math.min(MAX_BATCH, Number(limit) || MAX_BATCH));
	const cutoff = now - TERMINAL_INVITATION_PII_RETENTION_MS;
	// A link is invalid at expires_at even if no earlier request persisted its
	// derived status. Normalize a bounded set so never-registered recipients do
	// not remain pending (and retain email) forever.
	const expired = await env.DB.prepare(
		`UPDATE organization_invitations
		    SET status = 'expired', updated_at = ?
		  WHERE id IN (
		    SELECT id FROM organization_invitations
		     WHERE status = 'pending' AND expires_at <= ?
		     ORDER BY expires_at, id LIMIT ?
		  )`,
	).bind(now, now, boundedLimit).run();
	await env.DB.prepare(
		`UPDATE invitation_email_outbox
		    SET status = 'suppressed', payload_ciphertext = NULL, payload_iv = NULL,
		        last_error_code = 'invitation_expired', run_after = NULL, updated_at = ?
		  WHERE status IN ('queued', 'sending')
		    AND invitation_id IN (
		      SELECT id FROM organization_invitations WHERE status = 'expired'
		    )`,
	).bind(now).run();
	const invitations = await env.DB.prepare(
		`UPDATE organization_invitations
		    SET email_normalized = ?
		  WHERE id IN (
		    SELECT id FROM organization_invitations
		     WHERE status IN ('accepted', 'revoked', 'expired')
		       AND email_normalized != ?
		       AND CASE WHEN status = 'expired' THEN expires_at ELSE updated_at END <= ?
		     ORDER BY CASE WHEN status = 'expired' THEN expires_at ELSE updated_at END, id
		     LIMIT ?
		  )`,
	).bind(REDACTED_EMAIL, REDACTED_EMAIL, cutoff, boundedLimit).run();
	const deliveries = await env.DB.prepare(
		`UPDATE invitation_email_outbox
		    SET recipient_email = ?, provider_message_id = NULL, last_error_code = NULL,
		        payload_ciphertext = NULL, payload_iv = NULL
		  WHERE id IN (
		    SELECT o.id FROM invitation_email_outbox o
		     WHERE o.status IN ('sent', 'failed', 'suppressed')
		       AND o.recipient_email != ?
		       AND (
		         o.updated_at <= ? OR EXISTS (
		           SELECT 1 FROM organization_invitations i
		            WHERE i.id = o.invitation_id AND i.status = 'expired' AND i.expires_at <= ?
		         )
		       )
		     ORDER BY o.updated_at, o.id LIMIT ?
		  )`,
	).bind(REDACTED_EMAIL, REDACTED_EMAIL, cutoff, cutoff, boundedLimit).run();
	return {
		expired: Number(expired?.meta?.changes ?? 0),
		invitations_scrubbed: Number(invitations?.meta?.changes ?? 0),
		deliveries_scrubbed: Number(deliveries?.meta?.changes ?? 0),
		retention_days: 30,
	};
}

function emailContent(env, row, token) {
	const orgName = String(row.org_name || "an organization").slice(0, 120);
	const projectName = row.project_name ? String(row.project_name).slice(0, 120) : null;
	const link = `${publicOrigin(env)}/app#invite=${encodeURIComponent(token)}`;
	const expires = new Date(Number(row.expires_at)).toISOString().replace("T", " ").replace(".000Z", " UTC");
	const access = projectName
		? `You have been invited to ${orgName}, with access to the ${projectName} project.`
		: `You have been invited to ${orgName}.`;
	const subject = projectName
		? `Invitation to ${orgName} - ${projectName}`
		: `Invitation to ${orgName}`;
	return {
		subject,
		...renderEmail({
			kicker: "Itsuki · workspace invitation",
			heading: `You're invited to ${orgName}`,
			intro: access,
			blocks: [
				{ type: "paragraph", text: `Sign in or create an Itsuki account using ${row.recipient_email}.` },
				{ type: "button", label: "Review invitation", url: link },
				// "project details", not "descriptions": the reassurance now also
				// renders in the plain-text body, which must never carry a project
				// description — this wording keeps that guard mechanically testable.
				{ type: "note", text: `This link works once and expires ${expires}. Itsuki invitation emails never include memory content, project details, API keys, or webhook secrets.` },
			],
		}),
	};
}

async function suppressRow(env, id, code, now) {
	await env.DB.prepare(
		`UPDATE invitation_email_outbox
		 SET status = 'suppressed', payload_ciphertext = NULL, payload_iv = NULL,
		     last_error_code = ?, run_after = NULL, updated_at = ? WHERE id = ?`,
	).bind(code, now, id).run();
}

/**
 * Deliver a bounded batch. A conditional claim prevents duplicate sends when
 * two cron invocations overlap; stale claims are recoverable after ten minutes.
 */
export async function processInvitationEmailOutbox(env, { limit = 20, now = Date.now() } = {}) {
	const boundedLimit = Math.max(1, Math.min(MAX_BATCH, Number(limit) || 20));
	const pii = await scrubTerminalInvitationPii(env, { now, limit: boundedLimit });
	const result = { claimed: 0, sent: 0, retried: 0, failed: 0, suppressed: 0, pii };
	if (!invitationEmailConfigured(env)) return { ...result, configured: false };

	await env.DB.prepare(
		`UPDATE invitation_email_outbox SET status = 'queued', run_after = ?, updated_at = ?
		 WHERE status = 'sending' AND updated_at < ?`,
	).bind(now, now, now - STALE_SENDING_MS).run();

	const { results: pending } = await env.DB.prepare(
		`SELECT o.*, i.status AS invitation_status, i.expires_at, i.invited_by_user_id,
		        g.name AS org_name, p.name AS project_name
		 FROM invitation_email_outbox o
		 JOIN organization_invitations i ON i.id = o.invitation_id AND i.org_id = o.org_id
		 JOIN organizations g ON g.id = o.org_id
		 LEFT JOIN managed_projects p ON p.id = o.project_id
		 WHERE o.status = 'queued' AND COALESCE(o.run_after, 0) <= ?
		 ORDER BY o.created_at, o.id LIMIT ?`,
	).bind(now, boundedLimit).all();

	for (const row of pending ?? []) {
		const claim = await env.DB.prepare(
			`UPDATE invitation_email_outbox
			 SET status = 'sending', attempts = attempts + 1, updated_at = ?
			 WHERE id = ? AND status = 'queued' AND COALESCE(run_after, 0) <= ?`,
		).bind(now, row.id, now).run();
		if (Number(claim?.meta?.changes ?? 0) !== 1) continue;
		result.claimed++;
		const attempt = Number(row.attempts ?? 0) + 1;

		if (row.invitation_status !== "pending" || Number(row.expires_at) <= now) {
			await suppressRow(env, row.id, "invitation_unavailable", now);
			await writeAudit(env, {
				orgId: row.org_id,
				projectId: row.project_id,
				actorUserId: row.invited_by_user_id,
				actorType: "system",
				action: "org.invitation.email_suppressed",
				targetType: "invitation",
				targetId: row.invitation_id,
				metadata: { delivery_status: "suppressed" },
			});
			result.suppressed++;
			continue;
		}

		try {
			const token = await decryptToken(env, row);
			const content = emailContent(env, row, token);
			const response = await env.EMAIL.send({
				to: row.recipient_email,
				from: { email: senderAddress(env), name: "Itsuki" },
				subject: content.subject,
				text: content.text,
				html: content.html,
			});
			await env.DB.prepare(
				`UPDATE invitation_email_outbox
				 SET status = 'sent', payload_ciphertext = NULL, payload_iv = NULL,
				     provider_message_id = ?, last_error_code = NULL, run_after = NULL,
				     sent_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
			).bind(String(response?.messageId || "").slice(0, 200) || null, now, now, row.id).run();
			await writeAudit(env, {
				orgId: row.org_id,
				projectId: row.project_id,
				actorUserId: row.invited_by_user_id,
				actorType: "system",
				action: "org.invitation.email_sent",
				targetType: "invitation",
				targetId: row.invitation_id,
				metadata: { delivery_status: "sent" },
			});
			result.sent++;
		} catch {
			if (attempt >= MAX_ATTEMPTS) {
				await env.DB.prepare(
					`UPDATE invitation_email_outbox
					 SET status = 'failed', payload_ciphertext = NULL, payload_iv = NULL,
					     last_error_code = 'email_delivery_failed', run_after = NULL, updated_at = ?
					 WHERE id = ? AND status = 'sending'`,
				).bind(now, row.id).run();
				await writeAudit(env, {
					orgId: row.org_id,
					projectId: row.project_id,
					actorUserId: row.invited_by_user_id,
					actorType: "system",
					action: "org.invitation.email_failed",
					targetType: "invitation",
					targetId: row.invitation_id,
					outcome: "failed",
					reason: "email_delivery_failed",
					metadata: { delivery_status: "failed" },
				});
				result.failed++;
			} else {
				const backoff = Math.min(60 * 60 * 1000, 30_000 * (2 ** (attempt - 1)));
				await env.DB.prepare(
					`UPDATE invitation_email_outbox
					 SET status = 'queued', last_error_code = 'email_delivery_retry',
					     run_after = ?, updated_at = ? WHERE id = ? AND status = 'sending'`,
				).bind(now + backoff, now, row.id).run();
				result.retried++;
			}
		}
	}
	return { ...result, configured: true };
}
