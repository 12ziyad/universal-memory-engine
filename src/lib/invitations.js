/**
 * Invitations — hash-only authority with optional transactional delivery.
 *
 * A copy-once link is always returned. When Cloudflare Email Sending is
 * configured, an encrypted outbox delivers the same single-use token. Email
 * failure never burns or rolls back an otherwise valid invitation.
 *
 * Security properties, in the order they matter:
 *
 *  - Only a SHA-256 of the token is stored. A dump of this table hands nobody
 *    a working join link, and even the inviter cannot recover the link after
 *    the response that created it.
 *  - The invitation is bound to a normalised email. Accepting while signed in
 *    as somebody else fails loudly; it never silently joins the wrong account.
 *  - Single use, and expiry is enforced at read time as well as by status, so
 *    a row that was never swept still cannot be redeemed.
 *  - Acceptance is idempotent under a double-click: the membership write and
 *    the status flip happen together, and a second attempt finds it consumed.
 *  - Nothing in a public response reveals whether an email has an account.
 */

import { newId } from "./ids.js";
import { isValidEmail, normalizeEmail, sha256Hex } from "../auth.js";
import {
	cancelInvitationEmail,
	invitationEmailConfigured,
	queueInvitationEmail,
} from "./invitation_email.js";
import {
	assertDelegationAuthority,
	assertProjectOrganization,
	delegationGuardStatement,
	membershipAccessStatus,
	normalizeAccessWindow,
	OrgError,
	PROJECT_ROLES,
} from "./organizations.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./audit.js";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITES = 50;

function newInviteToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the UI may see. Never includes the token or its hash. */
function publicInvite(row, { email = null } = {}) {
	if (!row) return null;
	const expired = row.status === "pending" && row.expires_at <= Date.now();
	return {
		id: row.id,
		email: email ?? row.email_normalized,
		org_role: row.org_role,
		project_role: row.project_role ?? null,
		project_id: row.project_id ?? null,
		status: expired ? "expired" : row.status,
		expires_at: row.expires_at,
		created_at: row.created_at,
		accepted_at: row.accepted_at ?? null,
		access_starts_at: row.access_starts_at ?? null,
		access_expires_at: row.access_expires_at ?? null,
		access_status: membershipAccessStatus({
			role: row.org_role,
			access_starts_at: row.access_starts_at ?? null,
			access_expires_at: row.access_expires_at ?? null,
		}),
		email_delivery: row.email_delivery_status
			? {
				status: row.email_delivery_status,
				attempts: Number(row.email_delivery_attempts ?? 0),
				last_error_code: row.email_delivery_error ?? null,
				updated_at: row.email_delivery_updated_at ?? null,
				sent_at: row.email_delivery_sent_at ?? null,
			}
			: { status: "copy_link_only", attempts: 0, last_error_code: null, updated_at: null, sent_at: null },
	};
}

export async function listInvitations(env, orgId) {
	const { results } = await env.DB.prepare(
		`SELECT i.id, i.org_id, i.project_id, i.email_normalized, i.org_role, i.project_role, i.status,
		        i.expires_at, i.accepted_at, i.access_starts_at, i.access_expires_at, i.created_at,
		        o.status AS email_delivery_status, o.attempts AS email_delivery_attempts,
		        o.last_error_code AS email_delivery_error, o.updated_at AS email_delivery_updated_at,
		        o.sent_at AS email_delivery_sent_at
		   FROM organization_invitations i
		   LEFT JOIN invitation_email_outbox o ON o.invitation_id = i.id
		  WHERE i.org_id = ? AND i.status IN ('pending', 'expired')
		  ORDER BY i.created_at DESC LIMIT 100`,
	).bind(orgId).all();
	return (results ?? []).map((row) => publicInvite(row));
}

/**
 * Mint an invitation. Returns the join link once — the caller must hand it
 * straight to the inviter, because it is not recoverable from anywhere after
 * this function returns.
 */
export async function createInvitation(env, {
	orgId,
	projectId = null,
	email,
	orgRole = "member",
	projectRole = null,
	invitedByUserId,
	origin,
	accessStartsAt = null,
	accessExpiresAt = null,
	auditIntent = null,
}) {
	const normalized = normalizeEmail(email);
	if (!isValidEmail(normalized)) throw new OrgError("invalid_email", "Enter a valid email address.");
	if (!["admin", "member"].includes(orgRole)) {
		throw new OrgError("invalid_role", "Choose either admin or member for the organization role.");
	}
	if (projectRole !== null && !PROJECT_ROLES.includes(projectRole)) {
		throw new OrgError("invalid_role", "Choose admin, member or viewer for the project role.");
	}
	if (projectRole !== null && !projectId) {
		throw new OrgError("invalid_project", "Choose a project for that project role.");
	}
	if (projectId) await assertProjectOrganization(env, projectId, orgId);

	const alreadyMember = await env.DB.prepare(
		`SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
		  WHERE m.org_id = ? AND u.email_normalized = ? LIMIT 1`,
	).bind(orgId, normalized).first();
	if (alreadyMember) throw new OrgError("already_member", "That person is already a member.", 409);

	const token = newInviteToken();
	const at = Date.now();
	const access = normalizeAccessWindow({
		access_starts_at: accessStartsAt,
		access_expires_at: accessExpiresAt,
	}, {}, { requireFuture: true, now: at });
	const id = newId("inv");
	await assertDelegationAuthority(env, {
		actorUserId: invitedByUserId,
		orgId,
		projectId: projectRole ? projectId : null,
		accessStartsAt: access.access_starts_at,
		accessExpiresAt: access.access_expires_at,
		now: at,
	});
	// D1 batch is one transaction: stale pending rows are first made terminal,
	// replacement never revokes the old working link unless the new hashed
	// invitation is durably inserted too, and the live cap is checked inside the
	// insert. Concurrent sends therefore serialize to at most fifty live links.
	let results;
	try {
		const statements = [
		delegationGuardStatement(env, {
			actorUserId: invitedByUserId,
			orgId,
			projectId: projectRole ? projectId : null,
			accessStartsAt: access.access_starts_at,
			accessExpiresAt: access.access_expires_at,
			now: at,
		}),
		env.DB.prepare(
			`UPDATE organization_invitations SET status = 'expired', updated_at = ?
			  WHERE org_id = ? AND status = 'pending' AND expires_at <= ?
			  RETURNING id`,
		).bind(at, orgId, at),
		env.DB.prepare(
			`UPDATE organization_invitations SET status = 'revoked', updated_at = ?
			  WHERE org_id = ? AND email_normalized = ? AND status = 'pending'
			  RETURNING id`,
		).bind(at, orgId, normalized),
		env.DB.prepare(
			`INSERT INTO organization_invitations
			 (id, org_id, project_id, email_normalized, org_role, project_role, token_hash, status,
			  invited_by_user_id, expires_at, access_starts_at, access_expires_at, created_at, updated_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?
			  WHERE (SELECT COUNT(*) FROM organization_invitations
			          WHERE org_id = ? AND status = 'pending' AND expires_at > ?) < ?`,
		).bind(
			id, orgId, projectId, normalized, orgRole, projectRole,
			await sha256Hex(token), invitedByUserId, at + INVITE_TTL_MS,
			access.access_starts_at, access.access_expires_at, at, at,
			orgId, at, MAX_PENDING_INVITES,
		),
		];
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_invitations WHERE id = ? AND org_id = ? AND status = 'pending'",
					[id, orgId],
				)],
				commitDetails: { targetType: "invitation", targetId: id },
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw new OrgError(
				"delegation_window_exceeded",
				"You cannot grant a role or access period broader than your current administrative access.",
				403,
			);
		}
		throw error;
	}
	if (Number(results?.[3]?.meta?.changes ?? 0) !== 1) {
		throw new OrgError("invite_limit_reached", `An organization can have at most ${MAX_PENDING_INVITES} pending invitations.`, 409);
	}
	// The replacement and new token committed together. Clear encrypted payloads
	// for every superseded link only after that commit; a mail cleanup failure
	// must never roll back or invalidate the new invitation.
	try {
		const expired = results?.[1]?.results ?? [];
		const replaced = results?.[2]?.results ?? [];
		await Promise.all([
			...(expired ?? []).map((item) => cancelInvitationEmail(env, item.id, "invitation_expired")),
			...(replaced ?? []).map((item) => cancelInvitationEmail(env, item.id, "invitation_replaced")),
		]);
	} catch (error) {
		console.warn("invitation replacement email cleanup failed:", error?.message ?? error);
	}

	const row = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status,
		        expires_at, accepted_at, access_starts_at, access_expires_at, created_at
		   FROM organization_invitations WHERE id = ? LIMIT 1`,
	).bind(id).first();

	let delivery = { status: "copy_link_only", attempts: 0, last_error_code: null, updated_at: null, sent_at: null };
	try {
		const queued = await queueInvitationEmail(env, {
			invitationId: id,
			orgId,
			projectId,
			recipientEmail: normalized,
			token,
		});
		if (queued?.configured) {
			delivery = {
				status: queued.status ?? (queued.queued ? "queued" : "copy_link_only"),
				attempts: Number(queued.attempts ?? 0),
				last_error_code: null,
				updated_at: queued.created_at ?? at,
				sent_at: queued.sent_at ?? null,
			};
		}
	} catch (error) {
		console.warn("invitation email queue failed:", error?.message ?? error);
		delivery = {
			status: invitationEmailConfigured(env) ? "queue_failed" : "copy_link_only",
			attempts: 0,
			last_error_code: invitationEmailConfigured(env) ? "email_queue_failed" : null,
			updated_at: at,
			sent_at: null,
		};
	}

	const created = {
		invitation: { ...publicInvite(row), email_delivery: delivery },
		email_delivery: delivery,
		// Internal content-free transition ids let the HTTP layer audit resend /
		// replacement. It removes this field before returning to the browser.
		replaced_invitation_ids: (results?.[2]?.results ?? []).map((item) => item.id).filter(Boolean).slice(0, 10),
		expired_invitation_count: (results?.[1]?.results ?? []).length,
		// Shown once. Everything downstream stores only the hash.
		link: `${String(origin ?? "").replace(/\/+$/, "")}/app#invite=${token}`,
	};
	return auditIntent ? auditedMutationResult(created, auditIntent) : created;
}

export async function revokeInvitation(env, orgId, invitationId, { auditIntent = null } = {}) {
	const statement = env.DB.prepare(
		"UPDATE organization_invitations SET status = 'revoked', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'",
	).bind(Date.now(), invitationId, orgId);
	let result;
	try {
		[result] = auditIntent
			? await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_invitations WHERE id = ? AND org_id = ? AND status = 'pending'",
					[invitationId, orgId],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM organization_invitations WHERE id = ? AND org_id = ? AND status = 'revoked'",
					[invitationId, orgId],
				)],
			})
			: [await statement.run()];
	} catch (error) {
		if (auditIntent && /fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw new OrgError("invitation_not_found", "That invitation is no longer pending.", 404);
		}
		throw error;
	}
	if (!(result.meta?.changes ?? 0)) {
		throw new OrgError("invitation_not_found", "That invitation is no longer pending.", 404);
	}
	await cancelInvitationEmail(env, invitationId, "invitation_revoked").catch((error) => {
		console.warn("invitation revoke email cleanup failed:", error?.message ?? error);
	});
	const mutation = { ok: true, revoked: true };
	return auditIntent ? auditedMutationResult(mutation, auditIntent) : mutation;
}

/** Rotate a live invitation without changing the access that was approved. */
export async function resendInvitation(env, {
	orgId,
	invitationId,
	invitedByUserId,
	origin,
	auditIntent = null,
}) {
	const row = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, token_hash,
		        status, expires_at, access_starts_at, access_expires_at
		   FROM organization_invitations
		  WHERE id = ? AND org_id = ? LIMIT 1`,
	).bind(invitationId, orgId).first();
	// Keep cross-org and guessed-id failures indistinguishable.
	if (!row || row.status !== "pending" || Number(row.expires_at) <= Date.now()) {
		throw new OrgError("invitation_not_found", "That invitation is no longer pending.", 404);
	}
	const token = newInviteToken();
	const tokenHash = await sha256Hex(token);
	const id = newId("inv");
	const consumedHash = await sha256Hex(`itsuki:invitation-resend-consumed:v1:${id}:${token}`);
	const at = Date.now();
	await assertDelegationAuthority(env, {
		actorUserId: invitedByUserId,
		orgId,
		projectId: row.project_role ? row.project_id : null,
		accessStartsAt: row.access_starts_at ?? null,
		accessExpiresAt: row.access_expires_at ?? null,
		now: at,
	});
	try {
		const statements = [
			delegationGuardStatement(env, {
				actorUserId: invitedByUserId,
				orgId,
				projectId: row.project_role ? row.project_id : null,
				accessStartsAt: row.access_starts_at ?? null,
				accessExpiresAt: row.access_expires_at ?? null,
				now: at,
			}),
			env.DB.prepare(
				`UPDATE organization_invitations SET status = 'revoked', token_hash = ?, updated_at = ?
				  WHERE id = ? AND org_id = ? AND status = 'pending' AND token_hash = ? AND expires_at > ?`,
			).bind(consumedHash, at, invitationId, orgId, row.token_hash, at),
			// Abort the entire batch when another resend/revoke/accept won. This
			// generation check is what prevents two concurrent resends from both
			// returning links when only the later one remains usable.
			env.DB.prepare(
				`INSERT INTO fence_guard (violation)
				 SELECT 1 WHERE NOT EXISTS (
					SELECT 1 FROM organization_invitations
					 WHERE id = ? AND org_id = ? AND status = 'revoked' AND token_hash = ?
				 )`,
			).bind(invitationId, orgId, consumedHash),
			env.DB.prepare(
				`INSERT INTO organization_invitations
				 (id, org_id, project_id, email_normalized, org_role, project_role, token_hash, status,
				  invited_by_user_id, expires_at, access_starts_at, access_expires_at, created_at, updated_at)
				 SELECT ?, org_id, project_id, email_normalized, org_role, project_role, ?, 'pending',
				        ?, ?, access_starts_at, access_expires_at, ?, ?
				   FROM organization_invitations
				  WHERE id = ? AND org_id = ? AND status = 'revoked' AND token_hash = ?`,
			).bind(
				id, tokenHash, invitedByUserId, at + INVITE_TTL_MS, at, at,
				invitationId, orgId, consumedHash,
			),
		];
		if (auditIntent) {
			await commitAuditedBatch(env, auditIntent, statements, {
				postconditions: [
					auditInvariantStatement(env, "SELECT 1 FROM organization_invitations WHERE id = ? AND org_id = ? AND status = 'revoked' AND token_hash = ?", [invitationId, orgId, consumedHash]),
					auditInvariantStatement(env, "SELECT 1 FROM organization_invitations WHERE id = ? AND org_id = ? AND status = 'pending'", [id, orgId]),
				],
				commitDetails: { targetType: "invitation", targetId: id },
			});
		} else {
			await env.DB.batch(statements);
		}
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			// Distinguish authority loss from another actor consuming this invite.
			await assertDelegationAuthority(env, {
				actorUserId: invitedByUserId,
				orgId,
				projectId: row.project_role ? row.project_id : null,
				accessStartsAt: row.access_starts_at ?? null,
				accessExpiresAt: row.access_expires_at ?? null,
				now: Date.now(),
			});
			throw new OrgError("invitation_conflict", "That invitation changed while it was being resent.", 409);
		}
		throw error;
	}
	await cancelInvitationEmail(env, invitationId, "invitation_replaced").catch((error) => {
		console.warn("invitation resend email cleanup failed:", error?.message ?? error);
	});
	const createdRow = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status,
		        expires_at, accepted_at, access_starts_at, access_expires_at, created_at
		   FROM organization_invitations WHERE id = ? LIMIT 1`,
	).bind(id).first();
	let delivery = { status: "copy_link_only", attempts: 0, last_error_code: null, updated_at: null, sent_at: null };
	try {
		const queued = await queueInvitationEmail(env, {
			invitationId: id,
			orgId,
			projectId: row.project_id ?? null,
			recipientEmail: row.email_normalized,
			token,
		});
		if (queued?.configured) {
			delivery = {
				status: queued.status ?? (queued.queued ? "queued" : "copy_link_only"),
				attempts: Number(queued.attempts ?? 0),
				last_error_code: null,
				updated_at: queued.created_at ?? at,
				sent_at: queued.sent_at ?? null,
			};
		}
	} catch (error) {
		console.warn("invitation resend email queue failed:", error?.message ?? error);
		delivery = {
			status: invitationEmailConfigured(env) ? "queue_failed" : "copy_link_only",
			attempts: 0,
			last_error_code: invitationEmailConfigured(env) ? "email_queue_failed" : null,
			updated_at: at,
			sent_at: null,
		};
	}
	const created = {
		invitation: { ...publicInvite(createdRow), email_delivery: delivery },
		email_delivery: delivery,
		replaced_invitation_ids: [invitationId],
		expired_invitation_count: 0,
		link: `${String(origin ?? "").replace(/\/+$/, "")}/app#invite=${token}`,
	};
	return auditIntent ? auditedMutationResult(created, auditIntent) : created;
}

/**
 * What a signed-in person sees before deciding to accept. Deliberately thin:
 * the organization's name and the role on offer, nothing about its projects,
 * members or data. A leaked link must not become a reconnaissance tool.
 */
export async function describeInvitation(env, token, user = null) {
	const row = await env.DB.prepare(
		`SELECT i.id, i.org_id, i.email_normalized, i.org_role, i.project_role, i.project_id,
		        i.status, i.expires_at, i.access_starts_at, i.access_expires_at, o.name AS org_name
		   FROM organization_invitations i
		   LEFT JOIN organizations o ON o.id = i.org_id
		  WHERE i.token_hash = ? LIMIT 1`,
	).bind(await sha256Hex(String(token ?? ""))).first();
	if (!row) return { ok: false, reason: "invalid" };
	if (row.status !== "pending") return { ok: false, reason: row.status };
	if (row.expires_at <= Date.now()) return { ok: false, reason: "expired" };
	if (!user || normalizeEmail(user.email) !== row.email_normalized) {
		return {
			ok: false,
			reason: "wrong_account",
			message: "This invitation belongs to a different account. Sign in with the invited account to continue.",
		};
	}
	return {
		ok: true,
		organization: row.org_name ?? "an organization",
		account_matches: true,
		org_role: row.org_role,
		project_role: row.project_role ?? null,
		access_starts_at: row.access_starts_at ?? null,
		access_expires_at: row.access_expires_at ?? null,
	};
}

/**
 * Redeem an invitation for the signed-in user.
 *
 * The email check is the whole security model of the accept step: a link that
 * reached the wrong inbox must not let that person in. It fails with a typed
 * reason rather than a generic error so the UI can say which account is
 * needed — without revealing anything about the organization.
 */
export async function acceptInvitation(env, token, user, { auditIntent = null } = {}) {
	const hash = await sha256Hex(String(token ?? ""));
	const row = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status, expires_at,
		        access_starts_at, access_expires_at
		   FROM organization_invitations WHERE token_hash = ? LIMIT 1`,
	).bind(hash).first();
	if (!row) return { ok: false, reason: "invalid", message: "That invitation link is not valid." };
	if (row.status === "accepted") {
		const denied = { ok: false, reason: "accepted", message: "That invitation has already been used." };
		return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
	}
	if (row.status !== "pending") {
		const denied = { ok: false, reason: row.status, message: "That invitation is no longer active." };
		return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
	}
	if (row.expires_at <= Date.now()) {
		const at = Date.now();
		const statement = env.DB.prepare("UPDATE organization_invitations SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
			.bind(at, row.id);
		if (auditIntent) {
			await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(env, "SELECT 1 FROM organization_invitations WHERE id = ? AND status = 'pending'", [row.id])],
				postconditions: [auditInvariantStatement(env, "SELECT 1 FROM organization_invitations WHERE id = ? AND status = 'expired'", [row.id])],
				commitDetails: { orgId: row.org_id, projectId: row.project_id ?? null, targetType: "invitation", targetId: row.id },
			});
		} else {
			await statement.run();
		}
		await cancelInvitationEmail(env, row.id, "invitation_expired").catch(() => {});
		const denied = { ok: false, reason: "expired", message: "That invitation has expired. Ask for a new link." };
		return auditIntent ? auditedMutationResult(denied, auditIntent) : denied;
	}
	if (normalizeEmail(user.email) !== row.email_normalized) {
		const denied = {
			ok: false,
			reason: "wrong_account",
			message: "This invitation belongs to a different account. Sign in with the invited account to accept it.",
		};
		return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
	}
	if (row.access_expires_at !== null && Number(row.access_expires_at) <= Date.now()) {
		await cancelInvitationEmail(env, row.id, "access_expired").catch(() => {});
		const denied = { ok: false, reason: "access_expired", message: "The access period on this invitation has ended. Ask for a new link." };
		return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
	}
	if (row.project_id && row.project_role) {
		await assertProjectOrganization(env, row.project_id, row.org_id);
		const existingProjectMember = await env.DB.prepare(
			"SELECT org_id FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1",
		).bind(row.project_id, user.id).first();
		if (existingProjectMember && existingProjectMember.org_id !== row.org_id) {
			throw new OrgError(
				"project_org_mismatch",
				"That account already has a project membership in a different organization.",
				409,
			);
		}
	}

	const at = Date.now();
	const live = `id = ? AND token_hash = ? AND status = 'pending'
		AND expires_at > ? AND email_normalized = ?
		AND (access_expires_at IS NULL OR access_expires_at > ?)`;
	const statements = [
		env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
			   SELECT 1
			     FROM users u
			     JOIN organizations o ON o.id = ? AND o.status = 'active'
			     JOIN organization_invitations i ON i.id = ? AND i.org_id = o.id
			    WHERE u.id = ? AND u.status = 'active'
			      AND NOT EXISTS (
			        SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id
			      )
			      AND i.token_hash = ? AND i.status = 'pending'
			      AND i.expires_at > ? AND i.email_normalized = ?
			      AND (i.access_expires_at IS NULL OR i.access_expires_at > ?)
			      AND (
			        i.project_id IS NULL OR i.project_role IS NULL OR EXISTS (
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
			 )`,
		).bind(row.org_id, row.id, user.id, hash, at, row.email_normalized, at),
		env.DB.prepare(
			`INSERT INTO organization_members
				(id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
			 SELECT ?, org_id, ?, org_role, invited_by_user_id, access_starts_at, access_expires_at, ?, ?
			   FROM organization_invitations WHERE ${live}
			 ON CONFLICT(org_id, user_id) DO NOTHING`,
		).bind(newId("orgm"), user.id, at, at, row.id, hash, at, row.email_normalized, at),
	];
	if (row.project_id && row.project_role) {
		statements.push(env.DB.prepare(
			`INSERT INTO project_members
				(id, project_id, org_id, user_id, role, invited_by_user_id, access_starts_at, access_expires_at, created_at, updated_at)
			 SELECT ?, project_id, org_id, ?, project_role, invited_by_user_id, access_starts_at, access_expires_at, ?, ?
			   FROM organization_invitations WHERE ${live}
			 ON CONFLICT(project_id, user_id) DO NOTHING`,
		).bind(newId("prjm"), user.id, at, at, row.id, hash, at, row.email_normalized, at));
		statements.push(env.DB.prepare(
			`INSERT INTO project_memory_spaces
			 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 SELECT id, COALESCE(memory_owner_user_id, owner_user_id), COALESCE(memory_owner_user_id, owner_user_id),
			        'active', ?, ?
			   FROM managed_projects WHERE id = ? AND status = 'active'
			 ON CONFLICT(project_id, memory_user_id) DO UPDATE SET
				last_seen_at = MAX(project_memory_spaces.last_seen_at, excluded.last_seen_at)`,
		).bind(at, at, row.project_id));
	}
	statements.push(env.DB.prepare(
		`UPDATE organization_invitations
		    SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
		  WHERE ${live}`,
	).bind(user.id, at, at, row.id, hash, at, row.email_normalized, at));

	// Membership grants and token consumption commit or roll back as one D1
	// transaction. A failure can neither burn the link nor leave partial access.
	let results;
	try {
		results = auditIntent
			? await commitAuditedBatch(env, auditIntent, statements, {
				postconditions: [
					auditInvariantStatement(env, "SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?", [row.org_id, user.id]),
					auditInvariantStatement(env, "SELECT 1 FROM organization_invitations WHERE id = ? AND status = 'accepted' AND accepted_by_user_id = ?", [row.id, user.id]),
					...(row.project_id && row.project_role ? [auditInvariantStatement(env, "SELECT 1 FROM project_members WHERE project_id = ? AND org_id = ? AND user_id = ?", [row.project_id, row.org_id, user.id])] : []),
				],
				commitDetails: { orgId: row.org_id, projectId: row.project_id ?? null, targetType: "invitation", targetId: row.id },
			})
			: await env.DB.batch(statements);
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const denied = {
				ok: false,
				reason: "account_inactive",
				message: "This account or organization changed before the invitation could be accepted. Sign in again or ask an administrator for a new invitation.",
			};
			return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
		}
		throw error;
	}
	const consumed = results.at(-1);
	if (Number(consumed?.meta?.changes ?? 0) !== 1) {
		const latest = await env.DB.prepare(
			"SELECT status, expires_at, access_expires_at FROM organization_invitations WHERE id = ? LIMIT 1",
		).bind(row.id).first();
		const reason = latest?.status === "pending" && Number(latest.expires_at) <= Date.now()
			? "expired"
			: latest?.status === "pending" && latest.access_expires_at !== null && Number(latest.access_expires_at) <= Date.now()
				? "access_expired"
				: latest?.status ?? "accepted";
		if (latest?.status !== "pending") {
			await cancelInvitationEmail(env, row.id, "invitation_unavailable").catch(() => {});
		}
		const denied = {
			ok: false,
			reason,
			message: reason === "expired"
				? "That invitation has expired. Ask for a new link."
				: reason === "access_expired"
					? "The access period on this invitation has ended. Ask for a new link."
				: reason === "accepted"
					? "That invitation has already been used."
					: "That invitation is no longer active.",
		};
		return auditIntent ? commitAuditedNoop(env, auditIntent, denied) : denied;
	}
	await cancelInvitationEmail(env, row.id, "invitation_accepted").catch((error) => {
		console.warn("invitation accept email cleanup failed:", error?.message ?? error);
	});
	const accepted = { ok: true, org_id: row.org_id, project_id: row.project_id ?? null, invitation_id: row.id };
	return auditIntent ? auditedMutationResult(accepted, auditIntent) : accepted;
}
