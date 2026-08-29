/**
 * Ownership transfer as a two-party act (0063).
 *
 * It used to happen the instant the owner clicked: no acceptance, no notice,
 * no email. Someone could be handed responsibility for a project — its
 * memory, its keys, its deletion controls — without ever agreeing to it, and
 * without either party getting a record that it happened.
 *
 * Now it is an OFFER. The owner makes it (proving it is them), the recipient
 * accepts it, and only then does `transferProjectOwnership` run its existing
 * atomic swap. Both people are emailed at the end. An offer expires on its
 * own, can be withdrawn, and cannot outlive a change to the project it
 * describes.
 */

import { newId } from "./ids.js";
import { transferProjectOwnership, projectRevision } from "./project_lifecycle.js";
import { enqueueMail, transferOfferMail, transferDoneMail } from "./mail.js";

/** Long enough to notice an email, short enough that stale offers die. */
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value ?? "")));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publicOrigin(env) {
	return String(env?.PUBLIC_ORIGIN ?? "").trim() || "https://itsuki.app";
}

function fail(code, message, status = 400) {
	return { error: code, message, status };
}

/**
 * Offer ownership to an existing member. Returns { offer } or an error shape.
 * The recipient must already be an active member of the project's
 * organization — you cannot hand a project to a stranger, which is also why
 * the picker is empty until someone has been invited.
 */
export async function offerProjectOwnership(env, {
	actorUserId, projectId, recipientUserId, now = Date.now(),
} = {}) {
	const project = await env.DB.prepare(
		"SELECT id, name, owner_user_id, organization_id, status, is_default FROM managed_projects WHERE id = ?",
	).bind(projectId).first();
	if (!project) return fail("project_not_found", "That project no longer exists.", 404);
	if (project.owner_user_id !== actorUserId) {
		return fail("forbidden", "Only the project's owner can transfer it.", 403);
	}
	if (Number(project.is_default ?? 0) === 1) {
		return fail("default_project", "The default project cannot be transferred.", 409);
	}
	if (project.status !== "active") {
		return fail("project_inactive", "Restore the project before transferring it.", 409);
	}
	if (!recipientUserId || recipientUserId === actorUserId) {
		return fail("invalid_recipient", "Choose a different member to transfer to.", 400);
	}

	// The recipient has to be a real, active member of this organization —
	// the same rule the atomic swap enforces, checked here so the offer is
	// refused at the point a person can still do something about it.
	const member = await env.DB.prepare(
		// Membership itself is the row: organization_members has no status
		// column, so presence IS active. The user's own status still gates —
		// a disabled account cannot be handed a project.
		`SELECT u.id, u.email, u.name
		   FROM organization_members om
		   JOIN users u ON u.id = om.user_id
		  WHERE om.org_id = ? AND om.user_id = ?
		    AND COALESCE(u.status, 'active') = 'active'`,
	).bind(project.organization_id, recipientUserId).first();
	if (!member) {
		return fail("recipient_not_member", "That person is not an active member of this organization. Invite them first.", 409);
	}

	const from = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(actorUserId).first();
	const token = randomToken();
	const id = newId("xfer");
	const expiresAt = now + OFFER_TTL_MS;

	try {
		const inserted = await env.DB.prepare(
			`INSERT INTO project_ownership_transfers
			   (id, project_id, org_id, from_user_id, to_user_id, token_hash, status, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
		).bind(id, projectId, project.organization_id, actorUserId, recipientUserId, await sha256Hex(token), now, expiresAt).run();
		if (Number(inserted.meta?.changes ?? 0) !== 1) {
			return fail("offer_exists", "There is already a pending transfer for this project.", 409);
		}
	} catch (error) {
		// The partial unique index on (project_id) WHERE status='pending' is
		// what makes two simultaneous offers impossible; a constraint failure
		// here means the other one won.
		if (/UNIQUE|constraint/i.test(String(error?.message ?? error))) {
			return fail("offer_exists", "There is already a pending transfer for this project. Cancel it first.", 409);
		}
		throw error;
	}

	await enqueueMail(env, {
		kind: "ownership_transfer_offer",
		to: member.email,
		toUserId: member.id,
		dedupeKey: `xfer_offer:${id}`,
		...transferOfferMail(env, {
			projectName: project.name,
			fromName: from?.name,
			fromEmail: from?.email ?? "the current owner",
			link: `${publicOrigin(env)}/app#transfer=${id}.${token}`,
			expiresLabel: new Date(expiresAt).toISOString().slice(0, 10),
		}),
	});

	return {
		offer: {
			id,
			project_id: projectId,
			to: { id: member.id, email: member.email, name: member.name },
			status: "pending",
			created_at: now,
			expires_at: expiresAt,
		},
	};
}

/** What the recipient sees before deciding. Token-gated, no side effects. */
export async function describeTransferOffer(env, { offerId, token, viewerUserId, now = Date.now() } = {}) {
	const row = await env.DB.prepare(
		"SELECT * FROM project_ownership_transfers WHERE id = ? AND token_hash = ?",
	).bind(offerId, await sha256Hex(token)).first();
	if (!row) return fail("offer_not_found", "That transfer link is not valid.", 404);
	if (row.to_user_id !== viewerUserId) {
		return fail("not_recipient", "This transfer was offered to a different account. Sign in as that account to accept it.", 403);
	}
	if (row.status !== "pending") return fail("offer_closed", `This transfer was already ${row.status}.`, 409);
	if (Number(row.expires_at) <= now) return fail("offer_expired", "This transfer offer has expired. Ask the owner to send a new one.", 409);

	const project = await env.DB.prepare("SELECT id, name, status FROM managed_projects WHERE id = ?").bind(row.project_id).first();
	const from = await env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(row.from_user_id).first();
	return {
		offer: {
			id: row.id,
			project: project ? { id: project.id, name: project.name, status: project.status } : null,
			from: { email: from?.email ?? null, name: from?.name ?? null },
			expires_at: Number(row.expires_at),
		},
	};
}

/**
 * Accept. Consumes the offer under a CAS, re-checks every precondition
 * through the existing atomic swap, then tells both people.
 */
export async function acceptProjectOwnership(env, { offerId, token, accepterUserId, now = Date.now() } = {}) {
	const described = await describeTransferOffer(env, { offerId, token, viewerUserId: accepterUserId, now });
	if (described.error) return described;

	// Claim it before doing the work: a double-click must not run the swap
	// twice, and the loser of the race gets a clean "already accepted".
	const claim = await env.DB.prepare(
		"UPDATE project_ownership_transfers SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'",
	).bind(now, offerId).run();
	if (Number(claim.meta?.changes ?? 0) !== 1) {
		return fail("offer_closed", "That transfer was already handled.", 409);
	}

	const row = await env.DB.prepare("SELECT * FROM project_ownership_transfers WHERE id = ?").bind(offerId).first();
	let result;
	try {
		// The real swap, with all of its own fences: capability, membership,
		// project state, and the postcondition proving storage identity did
		// not move. If any of that has changed since the offer, this throws
		// and the offer goes back to pending so it can be retried honestly.
		// The revision is read fresh HERE rather than replayed from the offer.
		// The offer's job is to prove consent — that this person agreed to
		// take the project. Concurrency is the swap's job, and it re-proves
		// capability, membership, project state and storage identity inside
		// one batch. Replaying a stale revision would only mean an offer
		// silently rotted whenever the owner renamed the project.
		const fresh = await env.DB.prepare("SELECT * FROM managed_projects WHERE id = ?").bind(row.project_id).first();
		result = await transferProjectOwnership(env, {
			actorUserId: row.from_user_id,
			projectId: row.project_id,
			recipientUserId: row.to_user_id,
			expectedRevision: fresh ? await projectRevision(fresh) : null,
		});
	} catch (error) {
		await env.DB.prepare(
			"UPDATE project_ownership_transfers SET status = 'pending', responded_at = NULL WHERE id = ? AND status = 'accepted'",
		).bind(offerId).run().catch(() => {});
		return fail(
			error?.code ?? "transfer_failed",
			error?.message ?? "The project changed while the transfer was being accepted. Ask the owner to offer it again.",
			error?.status ?? 409,
		);
	}

	const [to, from, project] = await Promise.all([
		env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(row.to_user_id).first(),
		env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(row.from_user_id).first(),
		env.DB.prepare("SELECT name FROM managed_projects WHERE id = ?").bind(row.project_id).first(),
	]);
	const shared = {
		projectName: project?.name ?? "your project",
		toName: to?.name, toEmail: to?.email ?? "the new owner",
		fromName: from?.name, fromEmail: from?.email ?? "the previous owner",
	};
	// Both parties, always. A handover that only one side hears about is how
	// people discover months later that they own something.
	await enqueueMail(env, {
		kind: "ownership_transfer_done", to: to?.email, toUserId: row.to_user_id,
		dedupeKey: `xfer_done_to:${offerId}`,
		...transferDoneMail(env, { ...shared, forRecipient: true }),
	});
	await enqueueMail(env, {
		kind: "ownership_transfer_done", to: from?.email, toUserId: row.from_user_id,
		dedupeKey: `xfer_done_from:${offerId}`,
		...transferDoneMail(env, { ...shared, forRecipient: false }),
	});

	return { ok: true, project: result.project, previous_owner_role: result.previous_owner_role };
}

/** The owner changes their mind, or the recipient says no. */
export async function closeTransferOffer(env, { offerId, actorUserId, outcome = "cancelled", now = Date.now() } = {}) {
	const row = await env.DB.prepare("SELECT * FROM project_ownership_transfers WHERE id = ?").bind(offerId).first();
	if (!row) return fail("offer_not_found", "That transfer no longer exists.", 404);
	const allowed = outcome === "declined" ? row.to_user_id : row.from_user_id;
	if (actorUserId !== allowed) return fail("forbidden", "You cannot change that transfer.", 403);
	const done = await env.DB.prepare(
		"UPDATE project_ownership_transfers SET status = ?, responded_at = ? WHERE id = ? AND status = 'pending'",
	).bind(outcome, now, offerId).run();
	if (Number(done.meta?.changes ?? 0) !== 1) return fail("offer_closed", "That transfer was already handled.", 409);
	return { ok: true, status: outcome };
}

/** Pending offer for a project, for the settings UI. */
export async function pendingTransferFor(env, projectId) {
	const row = await env.DB.prepare(
		`SELECT t.id, t.to_user_id, t.created_at, t.expires_at, u.email, u.name
		   FROM project_ownership_transfers t LEFT JOIN users u ON u.id = t.to_user_id
		  WHERE t.project_id = ? AND t.status = 'pending'`,
	).bind(projectId).first();
	return row ? {
		id: row.id,
		to: { id: row.to_user_id, email: row.email, name: row.name },
		created_at: Number(row.created_at),
		expires_at: Number(row.expires_at),
	} : null;
}

/** Cron hygiene: an offer nobody answered stops being pending. */
export async function expireStaleTransfers(env, { now = Date.now() } = {}) {
	const done = await env.DB.prepare(
		"UPDATE project_ownership_transfers SET status = 'expired', responded_at = ? WHERE status = 'pending' AND expires_at <= ?",
	).bind(now, now).run();
	return { expired: Number(done.meta?.changes ?? 0) };
}
