export const MEMORY_READ_SCOPE = "memory:read";
export const MEMORY_WRITE_SCOPE = "memory:write";
/**
 * Destructive scope. Deliberately NOT implied by memory:write — a token that
 * may write must not be able to erase. Only OAuth-issued credentials are held
 * to it; legacy connection tokens keep their historical semantics (write plus
 * the live project.memory.delete capability), documented as a compatibility
 * path, so existing integrations neither break nor silently gain reach.
 */
export const MEMORY_DELETE_SCOPE = "memory:delete";

/** The scope vocabulary an OAuth authorization request may ask for. */
export const OAUTH_SCOPES = Object.freeze([
	MEMORY_READ_SCOPE,
	MEMORY_WRITE_SCOPE,
	MEMORY_DELETE_SCOPE,
]);

const ALL_SCOPES = new Set(["*", "memory:*"]);

export function tokenAllowsScope(scopes = [], requiredScope = null) {
	if (!requiredScope) return true;
	const set = new Set((scopes ?? []).map((scope) => String(scope ?? "").trim()).filter(Boolean));
	if ([...ALL_SCOPES].some((scope) => set.has(scope))) return true;
	if (requiredScope === MEMORY_READ_SCOPE) {
		return set.has(MEMORY_READ_SCOPE) || set.has(MEMORY_WRITE_SCOPE);
	}
	if (requiredScope === MEMORY_WRITE_SCOPE) {
		return set.has(MEMORY_WRITE_SCOPE);
	}
	return set.has(requiredScope);
}

/**
 * Every stored scope literal that satisfies `requiredScope` — the exact set
 * `tokenAllowsScope` would accept, expressed as data.
 *
 * Commit-time fences compare stored scope strings in SQL, where the layered
 * rules above cannot be expressed. They previously accepted only the exact
 * scope or '*', so a credential carrying 'memory:*' passed the request-time
 * check and then tripped the fence — the mutation aborted with a confusing
 * project_state_changed instead of succeeding. Both sides now derive their
 * accepted literals from this one function.
 */
export function scopeLiteralsSatisfying(requiredScope = null) {
	if (!requiredScope) return [];
	const literals = new Set([requiredScope, ...ALL_SCOPES]);
	if (requiredScope === MEMORY_READ_SCOPE) literals.add(MEMORY_WRITE_SCOPE);
	return [...literals];
}
