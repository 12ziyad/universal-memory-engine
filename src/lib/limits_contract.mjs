/**
 * The machine-readable limits document behind GET /v1/limits.
 *
 * Mirrors ingest_contract.mjs: frozen constants a client can fetch once and
 * trust. The rate figures are derived from RATE_BUCKETS — the same object the
 * enforcement path reads — so the published numbers cannot drift from the
 * enforced ones. test/limits.spec.js additionally pins them to the binding
 * declarations in wrangler.jsonc.
 *
 * Deliberately absent: RateLimit-Remaining/Reset figures (the Workers binding
 * is eventually consistent and cannot count), and the account-wide AI ceiling
 * (operational, and publishing it would tell a hostile caller exactly how much
 * traffic halts inference for everyone).
 */

import { RATE_BUCKETS } from "./rate.js";

export const LIMITS_SCHEMA = "itsuki.limits/v1";

const APPLIES_TO = Object.freeze({
	auth: Object.freeze(["/auth/*"]),
	save: Object.freeze(["POST /v1/save", "POST /v1/turn", "mcp:save_memory", "mcp:save_conversation"]),
	recall: Object.freeze(["POST /v1/recall", "mcp:recall_memory"]),
	delete: Object.freeze(["DELETE /v1/memories", "DELETE /v1/memories/:id", "mcp:delete_memory", "mcp:delete_all_memories"]),
	import: Object.freeze(["POST /v1/ingest"]),
	read: Object.freeze(["GET /v1/memories", "GET /v1/memories/:id", "mcp:list_memories", "mcp:get_memory", "mcp:whoami"]),
});

export const RATE_LIMITS_DOC = Object.freeze({
	unit: "requests",
	buckets: Object.freeze(Object.fromEntries(
		Object.entries(RATE_BUCKETS).map(([name, bucket]) => [name, Object.freeze({
			limit: bucket.limit,
			period_s: bucket.period_s,
			applies_to: APPLIES_TO[name] ?? Object.freeze([]),
		})]),
	)),
	scope: "per credential, per project",
	accuracy: "eventually consistent; protection, not accounting",
	on_exceeded: Object.freeze({
		http_status: 429,
		headers: Object.freeze(["retry-after", "ratelimit-limit"]),
		mcp: "tool result with isError and error=rate_limited; the connection stays up",
	}),
});
