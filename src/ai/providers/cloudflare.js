/**
 * The Cloudflare Workers AI provider — the incumbent, wrapped without change.
 *
 * `invoke` is byte-for-byte the call that lived in ai_meter.js before the
 * provider layer existed, including the options-arity branch: a model that
 * rejects a third argument behaves exactly as it always did. This file is THE
 * ONLY place in the tree allowed to touch `env.AI.run` — the architecture
 * census (src/lib/ai_call_census.js) fails the build on any other caller.
 *
 * The declaration is metadata for policy validation and the admin surface. It
 * is advisory: no caller may treat `constrained` support as a trust boundary —
 * local parse/validation at the call site remains the rule everywhere.
 */

export const cloudflareProvider = {
	// Canonical provider id. Matches the meaning ai_calls reads for a NULL
	// provider column and the (previously dead) LLM_PROVIDER var value.
	id: "workers-ai",
	declaration: {
		capabilities: {
			chat: { structured: ["prompt"] },
			generate_text: { structured: ["prompt"] },
			generate_structured: {
				structured: ["response_format_json_object", "response_format_json_schema", "guided_json", "prompt"],
				constrained: "best_effort",
			},
			embed_documents: { space: "cf/bge-base-en-v1.5@1", dims: 768 },
			embed_query: { space: "cf/bge-base-en-v1.5@1", dims: 768 },
			rerank: { maxCandidates: 120 },
		},
		// null = platform-bounded, exactly today's semantics. The registry
		// refuses to register any OTHER provider without a finite timeout.
		limits: { timeoutMs: null, retries: 0 },
		cost: { unit: "neurons", source: "binding_usage" },
	},
	async health(env) {
		return { ok: Boolean(env?.AI) };
	},
	async invoke(env, call) {
		return call.options === undefined
			? env.AI.run(call.model, call.inputs)
			: env.AI.run(call.model, call.inputs, call.options);
	},
};
