/**
 * The account vault — a third account state between active and deleted.
 *
 * A pre-launch product accumulates accounts that are neither wanted in the
 * operator console nor safe to destroy: real people who signed up, tried it,
 * and went quiet. Disabling them is a lie (it says "we locked you out") and
 * deleting them is irreversible. Vaulting shelves the account intact:
 *
 *   - it disappears from the operator console's default view (a launch
 *     starts from a clean slate, not a graveyard),
 *   - its live sessions stop resolving, because getSessionUser demands
 *     'active' — a shelved account should not be quietly logged in,
 *   - and EVERY door that proves the person is back wakes it automatically:
 *     browser sign-in, password sign-in, and API/MCP key use.
 *
 * That last property is the whole point. A vault you cannot walk out of is
 * just a nicer word for a ban, so waking is not an admin favour — it is the
 * ordinary consequence of using your account. Nothing about the account's
 * data changes on the way in or out: memories, projects, keys and history
 * are untouched, which is why the state lives in one column and not in a
 * migration that moves rows somewhere else.
 */

import { recordSecurityEvent } from "./security_events.js";

export const VAULT_STATUS = "dormant";

/** Statuses whose accounts still belong to a reachable person. */
export const REACHABLE_STATUSES = ["active", VAULT_STATUS];

/**
 * Wake a shelved account, if it is shelved. Safe to call on any account and
 * on every request: it is a no-op unless the status is exactly 'dormant',
 * and the UPDATE is a CAS so two concurrent doors cannot double-wake.
 *
 * Returns true when THIS call performed the wake.
 */
export async function wakeDormantAccount(env, user, { via = "session" } = {}) {
	if (!user || user.status !== VAULT_STATUS) return false;
	const woke = await env.DB.prepare(
		"UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = ?",
	).bind(Date.now(), user.id, VAULT_STATUS).run();
	if (Number(woke.meta?.changes ?? 0) !== 1) return false;
	// An account returning from the vault is the kind of thing an operator
	// should be able to see after the fact — it explains why a row that was
	// not in the console yesterday is in it today. Low severity: this is
	// expected behaviour, not an incident.
	await recordSecurityEvent(env, {
		kind: "account_woken_from_vault",
		severity: "low",
		groupKey: `account_woken:${user.id}`,
		details: { action: via },
		targetUserId: user.id,
	});
	// Mutate the caller's copy so the rest of the request sees the truth.
	user.status = "active";
	return true;
}
