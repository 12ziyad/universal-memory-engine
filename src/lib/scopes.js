export const MEMORY_READ_SCOPE = "memory:read";
export const MEMORY_WRITE_SCOPE = "memory:write";

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
