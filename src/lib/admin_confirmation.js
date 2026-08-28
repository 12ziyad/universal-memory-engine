/**
 * Admin step-up confirmations (0062) — a browser confirm() is not a control.
 *
 * The destructive admin actions (delete / promote / demote) now require a
 * server-minted single-use token, bound to actor + session + action + target
 * + the target's (role, status) at mint time, with a 5-minute TTL, PLUS the
 * typed target email checked by the door. Consumption is one CAS UPDATE, so
 * a replayed, expired, or stale-target token fails closed with a specific
 * reason. Only the SHA-256 of the token is stored — a leaked table row
 * authorizes nothing.
 */

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const STEP_UP_ACTIONS = new Set(["delete", "promote", "demote"]);

async function sha256Hex(value) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value ?? "")));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a confirmation for one action against one target-in-one-state.
 * The plaintext token exists only in this return value.
 */
export async function mintAdminConfirmation(env, { actorUserId, sessionId, action, target, now = Date.now() } = {}) {
	if (!STEP_UP_ACTIONS.has(action)) return { error: "unknown_action", status: 400 };
	if (!sessionId) return { error: "session_required", status: 401 };
	const token = randomToken();
	const expiresAt = now + CONFIRMATION_TTL_MS;
	await env.DB.prepare(
		`INSERT INTO admin_action_confirmations
			(id, token_hash, actor_user_id, session_id, action, target_user_id, target_role, target_status, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		`conf_${crypto.randomUUID()}`, await sha256Hex(token), actorUserId, sessionId,
		action, target.id, String(target.role ?? ""), String(target.status ?? ""), now, expiresAt,
	).run();
	return { token, expiresAt };
}

/**
 * Consume a confirmation. The CAS carries every binding, so success proves
 * all of them at once; on failure the row (if any) is read back purely to
 * name the reason. All failures are 409 — the door maps typed-text mismatch
 * to 403 separately, before ever consuming.
 */
export async function consumeAdminConfirmation(env, {
	token, actorUserId, sessionId, action, targetId, targetRole, targetStatus, now = Date.now(),
} = {}) {
	const tokenHash = await sha256Hex(token);
	const consumed = await env.DB.prepare(
		`UPDATE admin_action_confirmations SET used_at = ?
		 WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
		   AND actor_user_id = ? AND session_id = ? AND action = ? AND target_user_id = ?
		   AND target_role = ? AND target_status = ?`,
	).bind(now, tokenHash, now, actorUserId, sessionId ?? "", action, targetId,
		String(targetRole ?? ""), String(targetStatus ?? "")).run();
	if (Number(consumed.meta?.changes ?? 0) === 1) return { ok: true };

	const row = await env.DB.prepare(
		"SELECT used_at, expires_at, actor_user_id, session_id, action, target_user_id, target_role, target_status FROM admin_action_confirmations WHERE token_hash = ?",
	).bind(tokenHash).first();
	if (!row) return { ok: false, error: "confirmation_invalid", message: "That confirmation was never issued. Request a new one." };
	if (row.used_at) return { ok: false, error: "confirmation_replayed", message: "That confirmation was already used. Request a new one." };
	if (Number(row.expires_at) <= now) return { ok: false, error: "confirmation_expired", message: "The confirmation expired. Request a new one." };
	if (row.target_user_id === targetId && (row.target_role !== String(targetRole ?? "") || row.target_status !== String(targetStatus ?? ""))) {
		return { ok: false, error: "confirmation_stale_target", message: "The target account changed since the confirmation was issued. Reload and request a new one." };
	}
	return { ok: false, error: "confirmation_invalid", message: "The confirmation does not match this request. Request a new one." };
}

/** Cron hygiene: expired or spent tokens are dead weight within minutes. */
export async function purgeExpiredAdminConfirmations(env, { now = Date.now() } = {}) {
	const done = await env.DB.prepare(
		"DELETE FROM admin_action_confirmations WHERE expires_at <= ? OR used_at IS NOT NULL",
	).bind(now - CONFIRMATION_TTL_MS).run();
	return { purged: Number(done.meta?.changes ?? 0) };
}
