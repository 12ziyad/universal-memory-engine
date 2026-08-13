/**
 * Invitations — joining an organization without a mail server.
 *
 * Itsuki has no transactional email. Rather than pretend ("we've sent them an
 * email") the flow is honest about what actually happens: the server mints a
 * link, shows it to the inviter EXACTLY ONCE, and the inviter delivers it
 * however they already talk to that person. The UI says so in those words.
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
import { OrgError, PROJECT_ROLES, setProjectRole } from "./organizations.js";

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
	};
}

export async function listInvitations(env, orgId) {
	const { results } = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status,
		        expires_at, accepted_at, created_at
		   FROM organization_invitations
		  WHERE org_id = ? AND status IN ('pending', 'expired')
		  ORDER BY created_at DESC LIMIT 100`,
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
}) {
	const normalized = normalizeEmail(email);
	if (!isValidEmail(normalized)) throw new OrgError("invalid_email", "Enter a valid email address.");
	if (!["admin", "member"].includes(orgRole)) {
		throw new OrgError("invalid_role", "Choose either admin or member for the organization role.");
	}
	if (projectRole !== null && !PROJECT_ROLES.includes(projectRole)) {
		throw new OrgError("invalid_role", "Choose admin, member or viewer for the project role.");
	}

	const alreadyMember = await env.DB.prepare(
		`SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
		  WHERE m.org_id = ? AND u.email_normalized = ? LIMIT 1`,
	).bind(orgId, normalized).first();
	if (alreadyMember) throw new OrgError("already_member", "That person is already a member.", 409);

	const pending = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM organization_invitations WHERE org_id = ? AND status = 'pending'",
	).bind(orgId).first();
	if (Number(pending?.n ?? 0) >= MAX_PENDING_INVITES) {
		throw new OrgError("invite_limit_reached", `An organization can have at most ${MAX_PENDING_INVITES} pending invitations.`, 409);
	}

	// Re-inviting the same address replaces the outstanding link rather than
	// stacking a second one: two live tokens for one seat is a revocation bug
	// waiting to happen.
	await env.DB.prepare(
		"UPDATE organization_invitations SET status = 'revoked', updated_at = ? WHERE org_id = ? AND email_normalized = ? AND status = 'pending'",
	).bind(Date.now(), orgId, normalized).run();

	const token = newInviteToken();
	const at = Date.now();
	const id = newId("inv");
	await env.DB.prepare(
		`INSERT INTO organization_invitations
		 (id, org_id, project_id, email_normalized, org_role, project_role, token_hash, status,
		  invited_by_user_id, expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
	).bind(
		id, orgId, projectId, normalized, orgRole, projectRole,
		await sha256Hex(token), invitedByUserId, at + INVITE_TTL_MS, at, at,
	).run();

	const row = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status,
		        expires_at, accepted_at, created_at
		   FROM organization_invitations WHERE id = ? LIMIT 1`,
	).bind(id).first();

	return {
		invitation: publicInvite(row),
		// Shown once. Everything downstream stores only the hash.
		link: `${String(origin ?? "").replace(/\/+$/, "")}/app#invite=${token}`,
	};
}

export async function revokeInvitation(env, orgId, invitationId) {
	const result = await env.DB.prepare(
		"UPDATE organization_invitations SET status = 'revoked', updated_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'",
	).bind(Date.now(), invitationId, orgId).run();
	if (!(result.meta?.changes ?? 0)) {
		throw new OrgError("invitation_not_found", "That invitation is no longer pending.", 404);
	}
	return { ok: true };
}

/**
 * What a signed-in person sees before deciding to accept. Deliberately thin:
 * the organization's name and the role on offer, nothing about its projects,
 * members or data. A leaked link must not become a reconnaissance tool.
 */
export async function describeInvitation(env, token) {
	const row = await env.DB.prepare(
		`SELECT i.id, i.org_id, i.email_normalized, i.org_role, i.project_role, i.project_id,
		        i.status, i.expires_at, o.name AS org_name
		   FROM organization_invitations i
		   LEFT JOIN organizations o ON o.id = i.org_id
		  WHERE i.token_hash = ? LIMIT 1`,
	).bind(await sha256Hex(String(token ?? ""))).first();
	if (!row) return { ok: false, reason: "invalid" };
	if (row.status !== "pending") return { ok: false, reason: row.status };
	if (row.expires_at <= Date.now()) return { ok: false, reason: "expired" };
	return {
		ok: true,
		organization: row.org_name ?? "an organization",
		email: row.email_normalized,
		org_role: row.org_role,
		project_role: row.project_role ?? null,
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
export async function acceptInvitation(env, token, user) {
	const hash = await sha256Hex(String(token ?? ""));
	const row = await env.DB.prepare(
		`SELECT id, org_id, project_id, email_normalized, org_role, project_role, status, expires_at
		   FROM organization_invitations WHERE token_hash = ? LIMIT 1`,
	).bind(hash).first();
	if (!row) return { ok: false, reason: "invalid", message: "That invitation link is not valid." };
	if (row.status === "accepted") {
		return { ok: false, reason: "accepted", message: "That invitation has already been used." };
	}
	if (row.status !== "pending") {
		return { ok: false, reason: row.status, message: "That invitation is no longer active." };
	}
	if (row.expires_at <= Date.now()) {
		await env.DB.prepare("UPDATE organization_invitations SET status = 'expired', updated_at = ? WHERE id = ?")
			.bind(Date.now(), row.id).run();
		return { ok: false, reason: "expired", message: "That invitation has expired. Ask for a new link." };
	}
	if (normalizeEmail(user.email) !== row.email_normalized) {
		return {
			ok: false,
			reason: "wrong_account",
			message: `This invitation was issued for ${row.email_normalized}. Sign in with that account to accept it.`,
		};
	}

	const at = Date.now();
	// Consume the invitation first and only on the condition that it is still
	// pending. If two clicks race, exactly one UPDATE reports a change and only
	// that one goes on to write membership.
	const consumed = await env.DB.prepare(
		`UPDATE organization_invitations
		    SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
		  WHERE id = ? AND status = 'pending'`,
	).bind(user.id, at, at, row.id).run();
	if (!(consumed.meta?.changes ?? 0)) {
		return { ok: false, reason: "accepted", message: "That invitation has already been used." };
	}

	await env.DB.prepare(
		`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, NULL, ?, ?)
		 ON CONFLICT(org_id, user_id) DO UPDATE SET updated_at = excluded.updated_at`,
	).bind(newId("orgm"), row.org_id, user.id, row.org_role, at, at).run();

	if (row.project_id && row.project_role) {
		await setProjectRole(env, row.project_id, row.org_id, user.id, row.project_role);
	}
	return { ok: true, org_id: row.org_id, project_id: row.project_id ?? null };
}
