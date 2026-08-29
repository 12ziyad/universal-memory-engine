/**
 * The shared transactional outbox (0063).
 *
 * Before this there were five modules and six `env.EMAIL.send` call sites, no
 * two alike, sharing only a renderer. Anything new would have been a sixth.
 * This is one queue, one claim, one drain, one place to answer "did we email
 * that person, and did it arrive?".
 *
 * WHAT EARNS AN EMAIL is a deliberately short list — see MAIL_KINDS. It is
 * short on purpose: the fastest way to make people stop reading your email is
 * to send them one for something they did not need to know. Saving a memory,
 * deleting one memory, a normal sign-in, a webhook firing, ordinary API use,
 * changing a setting — none of those are in here, and adding one should feel
 * like a decision, not a convenience.
 *
 * THE RULE THAT MATTERS MOST: a completion email is enqueued only from the
 * code path that has already VERIFIED the thing completed. "Your data is
 * deleted" is the single most load-bearing sentence this product sends. It is
 * never sent optimistically, never on intent, never before the residue check
 * passes. Everything else here follows from that.
 */

import { renderEmail } from "./email_template.js";
import { newId } from "./ids.js";

/**
 * The complete set of things worth an email. Pinned by test — a new kind
 * must be added here, and adding one to this list is the moment to ask
 * whether the recipient actually wants it.
 */
export const MAIL_KINDS = Object.freeze([
	"org_invitation",              // 1. you have been invited
	"ownership_transfer_offer",    // 2. someone wants to hand you a project
	"ownership_transfer_done",     //    ...and it happened (to both parties)
	"project_memory_purged",       // 3. after the purge is VERIFIED complete
	"project_deleted",             // 4. after deletion is VERIFIED complete
	"account_deletion_started",    // 5. we received it and are working
	"account_deletion_done",       //    ...and it is VERIFIED done
	"privacy_case_received",       // 6. acknowledgement, with a case id
	"privacy_case_resolved",       //    ...and the answer
	"security_incident",           // 7. something happened that affects YOU
	"account_security_event",      // 8. serious: new device, lockout, mass revoke
	"credential_security_change",  // 9. a credential changed in a way worth flagging
	"billing_event",               // 10. later, when there is billing
]);

const MAX_ATTEMPTS = 5;
const backoffMs = (attempt) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt - 1));
const STALE_SENDING_MS = 10 * 60 * 1000;

function senderAddress(env) {
	const configured = String(env?.INVITE_EMAIL_FROM ?? "").trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : "invites@notify.itsuki.app";
}

function publicOrigin(env) {
	return String(env?.PUBLIC_ORIGIN ?? "").trim() || "https://itsuki.app";
}

const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? "").trim());

/**
 * Queue one email. Returns { queued: false, reason } rather than throwing —
 * a lifecycle operation that genuinely succeeded must never be reported as
 * failed because the notification about it could not be filed.
 *
 * `dedupeKey` makes this idempotent: a retried lifecycle run enqueues the
 * same key and the second insert is ignored, so nobody is told twice.
 */
export async function enqueueMail(env, { kind, to, toUserId = null, subject, blocks, dedupeKey = null, now = Date.now() } = {}) {
	try {
		if (!MAIL_KINDS.includes(kind)) return { queued: false, reason: "unknown_kind" };
		if (!validEmail(to)) return { queued: false, reason: "no_address" };
		const body = JSON.stringify({ ...blocks });
		const result = await env.DB.prepare(
			`INSERT INTO mail_outbox (id, kind, to_email, to_user_id, subject, body_json, status, attempts, run_after, created_at, updated_at, dedupe_key)
			 VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
			 ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		).bind(
			newId("mail"), kind, String(to).trim(), toUserId,
			String(subject).slice(0, 200), body, now, now, now, dedupeKey,
		).run();
		return { queued: Number(result.meta?.changes ?? 0) === 1 };
	} catch (error) {
		console.warn("mail enqueue failed:", error?.message ?? error);
		return { queued: false, reason: "enqueue_failed" };
	}
}

/**
 * Drain the outbox. Claim-then-send with a status CAS, so two overlapping
 * drains cannot double-send; a crash mid-send self-heals because a row stuck
 * in 'sending' past STALE_SENDING_MS is reclaimed.
 */
export async function processMailOutbox(env, { limit = 20, now = Date.now() } = {}) {
	const result = { sent: 0, failed: 0, skipped: 0 };

	// Recover anything a dead isolate left mid-flight.
	await env.DB.prepare(
		"UPDATE mail_outbox SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ?",
	).bind(now, now - STALE_SENDING_MS).run().catch(() => {});

	const { results: rows } = await env.DB.prepare(
		`SELECT id, kind, to_email, subject, body_json, attempts
		   FROM mail_outbox
		  WHERE status = 'queued' AND (run_after IS NULL OR run_after <= ?)
		  ORDER BY created_at LIMIT ?`,
	).bind(now, limit).all();
	if (!rows?.length) return result;

	// Unconfigured email marks rows skipped rather than letting them queue
	// forever — the product state is already correct either way, and a queue
	// that never drains is a lie about pending work.
	if (!env.EMAIL) {
		for (const row of rows) {
			await env.DB.prepare(
				"UPDATE mail_outbox SET status = 'skipped', updated_at = ?, last_error = 'email binding unavailable' WHERE id = ? AND status = 'queued'",
			).bind(now, row.id).run();
			result.skipped += 1;
		}
		return result;
	}

	for (const row of rows) {
		const attempt = Number(row.attempts ?? 0) + 1;
		const claim = await env.DB.prepare(
			`UPDATE mail_outbox SET status = 'sending', attempts = ?, updated_at = ?
			  WHERE id = ? AND status = 'queued' AND attempts = ?`,
		).bind(attempt, now, row.id, attempt - 1).run();
		if (Number(claim.meta?.changes ?? 0) !== 1) continue; // another drain owns it

		try {
			const content = JSON.parse(row.body_json);
			const { html, text } = renderEmail(content);
			await env.EMAIL.send({
				to: row.to_email,
				from: { email: senderAddress(env), name: "Itsuki" },
				subject: row.subject,
				text,
				html,
			});
			await env.DB.prepare(
				"UPDATE mail_outbox SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?",
			).bind(now, now, row.id).run();
			result.sent += 1;
		} catch (error) {
			const message = String(error?.message ?? error).slice(0, 200);
			const terminal = attempt >= MAX_ATTEMPTS;
			await env.DB.prepare(
				`UPDATE mail_outbox SET status = ?, run_after = ?, updated_at = ?, last_error = ? WHERE id = ?`,
			).bind(terminal ? "failed" : "queued", now + backoffMs(attempt), now, message, row.id).run();
			if (terminal) result.failed += 1;
			console.warn("mail send failed:", message);
		}
	}
	return result;
}

/* ==========================================================================
 * The messages themselves.
 *
 * Written to a person. Each one answers, in order: what happened, what it
 * means for you, and what you can do now. No marketing, no upsell, and no
 * cheerfulness where cheerfulness would be wrong — a deletion confirmation
 * is a receipt, not good news.
 * ======================================================================== */

const SIGN_OFF = "— Itsuki";

/** 1. Organization invitation (the existing invitation_email flow keeps its own). */
export function invitationMail(env, { orgName, inviterName, link, expiresLabel }) {
	return {
		subject: `${inviterName || "Someone"} invited you to ${orgName} on Itsuki`,
		blocks: {
			kicker: "Itsuki · invitation",
			heading: `You have been invited to ${orgName}`,
			intro: `${inviterName || "A colleague"} would like you to join their workspace on Itsuki.`,
			blocks: [
				{ type: "paragraph", text: "Itsuki is a memory layer: it remembers things across the AI tools a team uses, so context does not have to be re-explained every time." },
				{ type: "button", label: "Review the invitation", url: link },
				{ type: "note", text: `This link works once${expiresLabel ? ` and expires ${expiresLabel}` : ""}. If you were not expecting it, you can ignore this message — nothing happens until you accept.` },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 2a. Someone offers you a project. */
export function transferOfferMail(env, { projectName, fromName, fromEmail, link, expiresLabel }) {
	return {
		subject: `${fromName || fromEmail} wants to transfer "${projectName}" to you`,
		blocks: {
			kicker: "Itsuki · ownership transfer",
			heading: `You have been offered ownership of ${projectName}`,
			intro: `${fromName || fromEmail} would like to hand this project over to you. Nothing has changed yet — it becomes yours only if you accept.`,
			blocks: [
				{ type: "heading", text: "What you would be taking on" },
				{ type: "list", items: [
					"Governance of the project: its settings, members, and lifecycle.",
					"The ability to archive, purge or delete it — including its memory.",
					"Responsibility for the API keys and connections that write into it.",
				] },
				{ type: "paragraph", text: "The stored memory itself does not move or change hands in any technical sense — the memory-space and vector identities stay exactly as they are. What transfers is who governs it." },
				{ type: "button", label: "Review and accept", url: link },
				{ type: "note", text: `This offer expires ${expiresLabel}. If you do nothing, ownership stays where it is. If this is unexpected, tell ${fromEmail} before accepting.` },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 2b. It completed — sent to BOTH parties, worded for each. */
export function transferDoneMail(env, { projectName, toName, toEmail, fromName, fromEmail, forRecipient }) {
	return forRecipient
		? {
			subject: `You are now the owner of "${projectName}"`,
			blocks: {
				kicker: "Itsuki · ownership transfer",
				heading: `${projectName} is yours`,
				intro: `${fromName || fromEmail} transferred ownership to you, and you accepted.`,
				blocks: [
					{ type: "facts", rows: [
						["Project", projectName],
						["Previous owner", fromEmail],
						["Now owned by", toEmail],
					] },
					{ type: "paragraph", text: `${fromName || fromEmail} keeps administrator access, so nothing they were doing stops working. You can change that from the project's Members settings whenever you like.` },
					{ type: "button", label: "Open the project", url: `${publicOrigin(env)}/app#settings` },
				],
				footnote: SIGN_OFF,
			},
		}
		: {
			subject: `"${projectName}" now belongs to ${toEmail}`,
			blocks: {
				kicker: "Itsuki · ownership transfer",
				heading: `You handed over ${projectName}`,
				intro: `${toName || toEmail} accepted the transfer. They are now the owner.`,
				blocks: [
					{ type: "facts", rows: [
						["Project", projectName],
						["New owner", toEmail],
					] },
					{ type: "paragraph", text: "You have been kept on as an administrator, so your keys and connections keep working. If you meant to leave the project entirely, you can remove yourself from its Members settings." },
					{ type: "note", text: "If you did not expect this, contact founder@itsuki.app straight away." },
				],
				footnote: SIGN_OFF,
			},
		};
}

/** 3. Project memory purged — enqueued ONLY after verification. */
export function memoryPurgedMail(env, { projectName, verified }) {
	return {
		subject: `The memory in "${projectName}" has been deleted`,
		blocks: {
			kicker: "Itsuki · deletion",
			heading: `${projectName} is empty`,
			intro: "The purge you asked for has finished, and we have checked that it actually finished.",
			blocks: [
				{ type: "facts", rows: [
					["Project", projectName],
					["Memory spaces cleared", String(verified?.spaces ?? "—")],
					["Rows remaining", String(verified?.residual ?? 0)],
				] },
				{ type: "paragraph", text: "Every memory in this project is gone: the root space and each SDK subtenant, together with their sources, vectors, prepared exports and any queued work that had not run yet. The project itself is still here and is active again — only its memory was removed." },
				{ type: "note", text: "We send this only after the residue check passes, which is why it may arrive a little after you pressed the button. If anything had remained, you would have got a different message." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 4. Project permanently deleted — enqueued ONLY after verification. */
export function projectDeletedMail(env, { projectName }) {
	return {
		subject: `"${projectName}" has been permanently deleted`,
		blocks: {
			kicker: "Itsuki · deletion",
			heading: `${projectName} is gone`,
			intro: "The project and everything inside it has been permanently deleted. This is the confirmation, sent after the deletion was verified complete.",
			blocks: [
				{ type: "list", items: [
					"All memory, sources, vectors and prepared exports.",
					"Its API keys, connections and members.",
					"Its settings and configuration.",
				] },
				{ type: "paragraph", text: "A content-free tombstone remains — a record that a project with this identifier existed and was deleted, holding none of its content. That record is what lets us answer honestly if anyone ever asks whether the data is really gone." },
				{ type: "note", text: "This cannot be undone. If this was not what you intended, contact founder@itsuki.app — we cannot restore the data, but we should understand what happened." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 5a. Account deletion received. */
export function accountDeletionStartedMail(env, { email }) {
	return {
		subject: "We received your account deletion request",
		blocks: {
			kicker: "Itsuki · account",
			heading: "Your deletion request is being processed",
			intro: "We have your request to delete your Itsuki account, and work has started.",
			blocks: [
				{ type: "paragraph", text: "Deletion runs in passes: your account is closed to new writes immediately, in-flight work is cancelled, and then every memory space you own is erased and checked. We will write again when it is finished and verified — not before." },
				{ type: "paragraph", text: "You can still sign in until the erasure completes, but nothing new will be stored." },
				{ type: "note", text: "If you did not ask for this, reply to this message immediately — while it is still in progress it can be stopped." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 5b. Account deletion VERIFIED complete. */
export function accountDeletionDoneMail(env, { email }) {
	return {
		subject: "Your Itsuki account has been deleted",
		blocks: {
			kicker: "Itsuki · account",
			heading: "Your account is deleted",
			intro: "This is the last message you will get from us. Your account and its memory have been erased, and we have verified it.",
			blocks: [
				{ type: "list", items: [
					"Every memory, source, vector and prepared export you owned.",
					"Your sessions, API keys, connections and sign-in identities.",
					"Your profile and account record.",
				] },
				{ type: "paragraph", text: "What deliberately remains is content-free: a tombstone recording that an account was erased, and accountability rows showing that actions took place — none of which carry your data, your address, or anything you wrote." },
				{ type: "note", text: "This address is not on any list and will not be contacted again. If you ever want to come back, you are welcome to sign up fresh." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 6a. Privacy request / complaint acknowledged, with a case id. */
export function privacyCaseReceivedMail(env, { caseId, kind, dueLabel }) {
	return {
		subject: `We received your ${kind === "security_report" ? "security report" : "privacy request"} (${caseId.slice(0, 13)})`,
		blocks: {
			kicker: "Itsuki · trust & safety",
			heading: "Your case is open",
			intro: "Thank you for writing. This is not an automated brush-off — a person reads every one of these, and your case has a tracked clock on it.",
			blocks: [
				{ type: "facts", rows: [
					["Case", caseId],
					["Type", kind.replace(/_/g, " ")],
					...(dueLabel ? [["We will respond by", dueLabel]] : []),
				] },
				{ type: "paragraph", text: "Quote the case reference if you need to add anything. You can see the status of everything you have filed from Support inside the app." },
				{ type: "note", text: "If this concerns an active security issue, please do not post details publicly until we have replied." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 6b. Privacy case resolved. */
export function privacyCaseResolvedMail(env, { caseId, resolution, note }) {
	const outcome = {
		fixed: "We found the problem and fixed it.",
		answered: "We have answered your question below.",
		no_action: "We looked into it and concluded no change was needed.",
		duplicate: "This was already being handled under another case.",
		spam: "We closed this case.",
	}[resolution] ?? "This case is now closed.";
	return {
		subject: `Your case ${caseId.slice(0, 13)} has been resolved`,
		blocks: {
			kicker: "Itsuki · trust & safety",
			heading: "We have an answer for you",
			intro: outcome,
			blocks: [
				...(note ? [{ type: "paragraph", text: note }] : []),
				{ type: "facts", rows: [["Case", caseId], ["Outcome", String(resolution ?? "closed").replace(/_/g, " ")]] },
				{ type: "paragraph", text: "If this does not settle it for you, reply and the case will be reopened — a closed case is not a final word, it is our best answer so far." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 7. A security incident that actually affects this person. */
export function securityIncidentMail(env, { summary, whatWeDid, whatYouShouldDo }) {
	return {
		subject: "An important security notice about your Itsuki account",
		blocks: {
			kicker: "Itsuki · security",
			heading: "Something happened that affects your account",
			intro: "We are writing because this involves your account specifically. We would rather tell you plainly and early than wait until we have a tidier story.",
			blocks: [
				{ type: "heading", text: "What happened" },
				{ type: "paragraph", text: summary },
				{ type: "heading", text: "What we have done" },
				{ type: "paragraph", text: whatWeDid },
				...(whatYouShouldDo ? [{ type: "heading", text: "What you should do" }, { type: "paragraph", text: whatYouShouldDo }] : []),
				{ type: "note", text: "Questions go to founder@itsuki.app and reach a person, not a queue." },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 8. Serious account-security event — NOT ordinary sign-ins. */
export function accountSecurityMail(env, { event, detail, when }) {
	const heading = {
		new_device: "A new device signed in to your account",
		locked: "Your account was temporarily locked",
		sessions_revoked: "You were signed out everywhere",
	}[event] ?? "A security change on your account";
	return {
		subject: heading,
		blocks: {
			kicker: "Itsuki · security",
			heading,
			intro: "This is the kind of thing worth telling you about even when it turns out to be you.",
			blocks: [
				{ type: "facts", rows: [["Event", String(event).replace(/_/g, " ")], ...(when ? [["When", when]] : [])] },
				...(detail ? [{ type: "paragraph", text: detail }] : []),
				{ type: "paragraph", text: "If this was you, there is nothing to do. If it was not, change your password and sign out of all sessions from Settings, then write to founder@itsuki.app." },
				{ type: "button", label: "Review your account", url: `${publicOrigin(env)}/app#settings` },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 9. A credential change worth flagging — not routine key management. */
export function credentialSecurityMail(env, { summary, detail }) {
	return {
		subject: "A credential on your Itsuki account changed",
		blocks: {
			kicker: "Itsuki · security",
			heading: "A credential changed",
			intro: summary,
			blocks: [
				...(detail ? [{ type: "paragraph", text: detail }] : []),
				{ type: "paragraph", text: "If you made this change, ignore this. If you did not, revoke the credential from Connect and write to founder@itsuki.app." },
				{ type: "button", label: "Open API keys", url: `${publicOrigin(env)}/app#keys` },
			],
			footnote: SIGN_OFF,
		},
	};
}

/** 10. Billing — the shape is here for when there is billing. */
export function billingMail(env, { event, amount, detail }) {
	return {
		subject: `Itsuki billing: ${String(event).replace(/_/g, " ")}`,
		blocks: {
			kicker: "Itsuki · billing",
			heading: String(event).replace(/_/g, " "),
			intro: detail ?? "",
			blocks: [
				...(amount ? [{ type: "facts", rows: [["Amount", amount]] }] : []),
				{ type: "button", label: "View your plan", url: `${publicOrigin(env)}/app#usage` },
			],
			footnote: SIGN_OFF,
		},
	};
}
