/**
 * Rate limiting helpers, shared by the HTTP router and the MCP door.
 *
 * These live in lib/ (not index.js) because src/index.js imports from
 * src/mcp/server.js — the MCP tools could never import them from index.js
 * without a cycle. index.js re-imports from here, so call sites are unchanged.
 *
 * RATE_BUCKETS is the single source of truth for the numbers: tooMany()'s
 * `ratelimit-limit` header and GET /v1/limits both read it, so the published
 * figures cannot drift from the enforced ones. The binding declarations in
 * wrangler.jsonc must match — test/limits.spec.js pins that equivalence.
 */

export const RATE_BUCKETS = Object.freeze({
	auth: Object.freeze({ binding: "AUTH_LIMITER", limit: 10, period_s: 60 }),
	save: Object.freeze({ binding: "SAVE_LIMITER", limit: 60, period_s: 60 }),
	recall: Object.freeze({ binding: "RECALL_LIMITER", limit: 120, period_s: 60 }),
	delete: Object.freeze({ binding: "DELETE_LIMITER", limit: 30, period_s: 60 }),
	import: Object.freeze({ binding: "IMPORT_LIMITER", limit: 300, period_s: 60 }),
	read: Object.freeze({ binding: "READ_LIMITER", limit: 240, period_s: 60 }),
});

/**
 * Workers rate limiting. No-ops when the binding is absent (tests, local dev
 * without unsafe bindings), fails open on errors — protection, not a gate.
 */
export async function allowRate(binding, key) {
	if (!binding?.limit) return true;
	try {
		const { success } = await binding.limit({ key: String(key ?? "anon") });
		return success !== false;
	} catch (error) {
		// Fail open — rate limiting is protection, not a gate — but never silently.
		console.warn("rate limiter unavailable:", error?.message ?? error);
		return true;
	}
}

/**
 * A rate-limit bucket must describe the authenticated actor and project, never
 * the caller-selected external memory subject. Otherwise an SDK can rotate
 * userId on every request and buy a fresh quota bucket each time.
 */
export function managedActorRateKey(prefix, context) {
	const auth = context.auth ?? {};
	const actor = auth.type === "token"
		? `token:${auth.token?.id ?? "unknown"}`
		: auth.type === "session"
			? `session:${auth.userId}`
			: "legacy:configured";
	const projectId = context.managedProject?.id ?? "unmanaged";
	return `${prefix}:${actor}:project:${projectId}`;
}
