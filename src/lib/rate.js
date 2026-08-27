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
 * without unsafe bindings — deliberate, and the only fail-open that applies
 * unconditionally).
 *
 * When the binding EXISTS but throws, the failure policy is per-path:
 *   - write-shaped buckets (save / import / delete) pass { fail: "closed" }
 *     and REFUSE. A broken limiter under write pressure is exactly when the
 *     brakes matter most: every allowed write spends inference and mutates
 *     data, so the exposure of failing open is unbounded.
 *   - auth / recall / read default to fail open. They spend no inference and
 *     mutate nothing, and a limiter blip must not lock people out of signing
 *     in or reading their own memory. Auth abuse stays bounded by the
 *     passwordless attempt caps and OAuth provider limits.
 */
export async function allowRate(binding, key, { fail = "open" } = {}) {
	if (!binding?.limit) return true;
	try {
		const { success } = await binding.limit({ key: String(key ?? "anon") });
		return success !== false;
	} catch (error) {
		// Never silent, whichever way it fails.
		console.warn(`rate limiter unavailable (fail ${fail}):`, error?.message ?? error);
		return fail !== "closed";
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
