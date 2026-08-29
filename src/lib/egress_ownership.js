/**
 * Generalized egress ownership assertion (Phase 3).
 *
 * Itsuki has exactly one isolation primitive: every tenant query carries
 * `WHERE user_id = ?` bound to a SERVER-DERIVED memory-space id. For the
 * ordinary read doors that is sufficient — `resolveScopedMemory` mints the id
 * by hashing the caller's chosen external id into the authenticated owner's
 * namespace, so a client cannot name another tenant's space.
 *
 * Two kinds of route cannot rely on that alone, because they DISCOVER space
 * ids from stored provenance rather than deriving them from the request:
 *
 *   - /v1/graph's legacy per-subtenant inventory, which reads
 *     `source_packets.memory_user_id`; and
 *   - /v1/ops/overview's tenant discovery, which reads `receipts.user_id`
 *     alongside a `scope_json.owner_user_id` claim.
 *
 * Source provenance was historically client-extensible, so a row written
 * before that was fixed can still CLAIM an owner it does not belong to. A
 * discovery query that trusts the claim is a confused deputy: it would report
 * another space's aggregate inventory (node counts, job backlogs, latencies)
 * to whoever the row names as owner.
 *
 * The assertion below is the one both routes now share: a discovered space is
 * ours only if it is the owner's own root space, or if it RE-DERIVES from the
 * owner id and the row's own external id under the same deterministic hash
 * that minted it. A row that cannot prove that is dropped, never reported.
 * Shape checks (`id.startsWith("mem_")`) are deliberately not sufficient —
 * every foreign subtenant id in the system has exactly that shape.
 *
 * Fails CLOSED by construction: anything unprovable is excluded, matching
 * `resolveRetentionScope`, which throws rather than proceed on conflicting
 * provenance.
 */

import { sha256Hex } from "../auth.js";

/**
 * The memory-space identity primitive. A sub-tenant space id is the hash of
 * the caller's chosen external id NAMESPACED UNDER the authenticated owner,
 * which is what makes the id unforgeable: the same external id under two
 * different owners lands in two different spaces, and no client-supplied
 * string can name a space belonging to someone else.
 *
 * It lives here, beside the assertion that checks it, so the minting and the
 * proving can never drift apart — and so callers import a function rather
 * than receiving one, which is how the ops route once silently lost its
 * sub-tenants. `src/index.js` re-exports it for its historical importers.
 */
export async function scopedMemoryUserId(ownerUserId, externalUserId) {
	if (!externalUserId || externalUserId === ownerUserId) return ownerUserId;
	const digest = await sha256Hex(`uml-memory-scope:v1:${ownerUserId}:${externalUserId}`);
	return `mem_${digest.slice(0, 32)}`;
}

/**
 * Identity fields the SERVER owns. A client may choose which sub-tenant it is
 * writing as (`userId` / `external_user_id` — that is the whole point of the
 * multi-tenant API), but it may never assert WHO OWNS the resulting space.
 *
 * This exists because it was exploitable, not as a precaution. `resolveScope`
 * reads `scope.owner_user_id` from the same object the client's
 * `body.memoryScope` is spread into, and `resolveScopedMemory` only overrode
 * the camelCase spellings — so a snake_case `owner_user_id` in a request body
 * travelled all the way into `receipts.scope_json` and
 * `source_packets.owner_user_id`. Anything reading those as an ownership
 * claim — the ops rollup, the graph inventory, the webhook fan-out — was
 * reading attacker-controlled data.
 *
 * Both spellings are stripped: the server re-applies its own values
 * immediately afterwards, so removing them here can only remove a forgery.
 */
const SERVER_OWNED_SCOPE_KEYS = Object.freeze([
	"owner_user_id", "ownerUserId", "ownerId",
	"account_user_id", "accountUserId",
	"memory_user_id", "memoryUserId",
	"managed_project_id", "managedProjectId",
	"scope_user_id", "scopeUserId",
]);

/**
 * Strip server-owned identity keys from a client-supplied scope object.
 * Returns { scope, rejected } — `rejected` names what was removed, so a
 * caller can treat an attempted forgery as the security signal it is.
 */
export function sanitizeClientScopeInput(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { scope: {}, rejected: [] };
	const scope = {};
	const rejected = [];
	for (const [key, value] of Object.entries(input)) {
		if (SERVER_OWNED_SCOPE_KEYS.includes(key)) {
			// Only an ATTEMPT to set it counts; an explicit null or undefined
			// asserts nothing and is dropped quietly.
			if (value !== null && value !== undefined && value !== "") rejected.push(key);
			continue;
		}
		scope[key] = value;
	}
	return { scope, rejected };
}

/**
 * Is this discovered memory-space id genuinely inside the owner's namespace?
 *
 * @param deriveScopedId (ownerUserId, externalUserId) => Promise<string> —
 *        the derivation that minted the id. Defaults to the real one; the
 *        parameter exists so a test can prove the assertion itself, never so
 *        a caller can weaken it.
 */
export async function isOwnedMemorySpace(deriveScopedId, ownerUserId, memoryUserId, externalUserId) {
	const id = String(memoryUserId ?? "");
	if (!id) return false;
	// The owner's own root space needs no derivation — it IS the owner.
	if (id === ownerUserId) return true;
	// Every other space must re-derive. A row with no external id cannot
	// prove anything, so it is not ours.
	if (externalUserId === null || externalUserId === undefined || externalUserId === "") return false;
	try {
		return id === await deriveScopedId(ownerUserId, String(externalUserId));
	} catch {
		// A derivation that cannot be computed is not a proof of ownership.
		return false;
	}
}

/**
 * Filter discovered provenance rows down to the ones this owner can prove.
 * Returns { owned, dropped } so callers can both use the safe rows and
 * report how many claims were refused (a non-zero drop count is a security
 * signal, not routine noise).
 *
 * @param rows array of provenance rows
 * @param select (row) => ({ memoryUserId, externalUserId }) — column mapping,
 *        since callers name these columns differently.
 */
export async function filterOwnedMemorySpaces(deriveScopedId = scopedMemoryUserId, ownerUserId, rows, select) {
	const owned = [];
	let dropped = 0;
	for (const row of rows ?? []) {
		const { memoryUserId, externalUserId } = select(row);
		if (await isOwnedMemorySpace(deriveScopedId, ownerUserId, memoryUserId, externalUserId)) owned.push(row);
		else dropped += 1;
	}
	return { owned, dropped };
}
