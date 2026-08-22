/**
 * Capability identity for every AI call.
 *
 * Capability is EXPLICIT, never inferred from input shape: `{messages}` is
 * shared by five semantically different lanes, and the digest call historically
 * carried no task at all. Call sites either pass `meta.capability` directly or
 * are mapped here from the task string they already send. An unmapped task
 * resolves to null, which routes as "cloudflare only, no policy" — unknown work
 * never becomes eligible for a non-default provider by accident.
 */

export const CAPABILITIES = Object.freeze({
	GENERATE_STRUCTURED: "generate_structured",
	GENERATE_TEXT: "generate_text",
	CHAT: "chat",
	EMBED_DOCUMENTS: "embed_documents",
	EMBED_QUERY: "embed_query",
	RERANK: "rerank",
});

/** Task-string → capability, for callers not yet passing meta.capability. */
const TASK_CAPABILITY = Object.freeze({
	extract: "generate_structured",
	edges: "generate_structured",
	reflexion: "generate_structured",
	extract_atomic: "generate_structured",
	digest: "generate_text",
	summary: "generate_text",
	mcp_title: "generate_structured",
	manual_router: "generate_structured",
	rules_category_preview: "generate_structured",
	playground_preview: "generate_structured",
	playground_chat: "chat",
	embed: "embed_documents",
	embed_profile: "embed_documents",
	rerank: "rerank",
	eval: "generate_text",
});

export function capabilityOf(meta = {}) {
	if (typeof meta.capability === "string" && meta.capability) return meta.capability;
	return TASK_CAPABILITY[meta.task] ?? null;
}

/** Write-producing capabilities: cross-provider fallback is forbidden inside a
 * run, and provider choice is pinned at claim time (src/ai/pin.js). */
export const WRITE_CAPABILITIES = Object.freeze(new Set(["generate_structured", "generate_text"]));

/** Embedding capabilities are SPACE-BOUND: automatic cross-provider routing is
 * structurally rejected by the policy legality matrix — a provider whose
 * semantic space differs from the live index must never be reachable by an
 * automatic decision. */
export const SPACE_BOUND_CAPABILITIES = Object.freeze(new Set(["embed_documents", "embed_query"]));
