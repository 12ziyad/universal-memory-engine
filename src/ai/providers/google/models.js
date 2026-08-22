/**
 * Pinned Google model ids and per-lane transport budgets.
 *
 * GA ids are stable snapshots on Vertex; dated -preview ids are the moving
 * ones. Never a -latest alias. VERIFY the exact current ids against the Vertex
 * model catalog before enabling any live traffic — this table is the single
 * place they change, and the pin machinery owns WHEN a change may take effect
 * (a claimed run replays its recorded model regardless of edits here).
 */

export const GOOGLE_DEFAULT_MODELS = Object.freeze({
	extract: "gemini-2.5-flash",
	edges: "gemini-2.5-flash",
	reflexion: "gemini-2.5-flash",
	extract_atomic: "gemini-2.5-flash",
	digest: "gemini-2.5-flash-lite",
	summary: "gemini-2.5-flash-lite",
	mcp_title: "gemini-2.5-flash-lite",
	manual_router: "gemini-2.5-flash-lite",
	rules_category_preview: "gemini-2.5-flash-lite",
	playground_preview: "gemini-2.5-flash-lite",
	playground_chat: "gemini-2.5-flash-lite",
	eval: "gemini-2.5-flash",
	embed: "gemini-embedding-001",
	embed_profile: "gemini-embedding-001",
	rerank: "semantic-ranker-default-004",
});

/** Transport timeouts (AbortController) per lane; the fallback is the
 * declaration's limit. The repo's Workers AI path has platform bounds; a raw
 * fetch has none, so every Google call carries one of these. */
export const GOOGLE_TIMEOUTS_MS = Object.freeze({
	extract: 60_000,
	edges: 30_000,
	reflexion: 30_000,
	extract_atomic: 60_000,
	digest: 20_000,
	summary: 20_000,
	mcp_title: 20_000,
	manual_router: 20_000,
	rules_category_preview: 20_000,
	playground_preview: 20_000,
	playground_chat: 20_000,
	eval: 60_000,
	embed: 10_000,
	embed_profile: 10_000,
	rerank: 10_000,
});

export const GOOGLE_MAX_TIMEOUT_MS = 60_000;

/** Gemini 2.5 flash/flash-lite: thinking off for deterministic JSON lanes —
 * the structural analog of engine_v2's /no_think prompt hack. Pro cannot fully
 * disable thinking, one reason it is not a default here. */
export function thinkingBudgetFor(model) {
	return model.startsWith("gemini-2.5-flash") ? 0 : null;
}

export function googleRegion(env) {
	return String(env?.GCP_REGION ?? "us-central1");
}

export function googleProject(env) {
	const project = env?.GCP_PROJECT_ID;
	if (!project) {
		throw Object.assign(new Error("google project unset"), {
			aiErrorClass: "provider_misconfigured",
			googleStatus: "no_project",
		});
	}
	return String(project);
}

export function generateContentUrl(env, model) {
	const region = googleRegion(env);
	const project = googleProject(env);
	return `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
}

export function predictUrl(env, model) {
	const region = googleRegion(env);
	const project = googleProject(env);
	return `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:predict`;
}

export function rankUrl(env) {
	const project = googleProject(env);
	return `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/global/rankingConfigs/default_ranking_config:rank`;
}

/** Is this id one of ours (vs a Workers AI @cf/ id the caller sent)? */
export function isGoogleModelId(model) {
	return typeof model === "string" && !model.startsWith("@cf/") && model.length > 0;
}
