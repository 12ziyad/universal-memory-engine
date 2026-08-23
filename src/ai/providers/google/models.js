import { googleModelCard } from "../../rate_cards.js";

/**
 * Pinned Google model ids and per-lane transport budgets.
 *
 * GA ids are stable snapshots on Vertex; dated -preview ids are the moving
 * ones. Never a -latest alias. VERIFY the exact current ids, region support,
 * request parameters, retirement dates, and prices before enabling live
 * traffic. The 2.5 generation models below retire on 2026-10-20, so the live
 * activation gate is intentionally HOLD until a separately tested 3.x model
 * migration is selected. This table is the single place ids change, and the
 * pin machinery owns WHEN a change may take effect (a claimed run replays its
 * recorded model regardless of edits here).
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

const GCP_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_REGION_RE = /^[a-z]{2,20}(?:-[a-z0-9]{1,20}){1,3}[0-9]$/;

function configurationError(status) {
	throw Object.assign(new Error(`google provider ${status}`), {
		aiErrorClass: "provider_misconfigured",
		googleStatus: status,
	});
}

/** Gemini 2.5 flash/flash-lite: thinking off for deterministic JSON lanes —
 * the structural analog of engine_v2's /no_think prompt hack. Pro cannot fully
 * disable thinking, one reason it is not a default here. */
export function thinkingBudgetFor(model) {
	return model.startsWith("gemini-2.5-flash") ? 0 : null;
}

export function googleRegion(env) {
	const region = String(env?.GCP_REGION ?? "us-central1");
	if (!GCP_REGION_RE.test(region)) configurationError("invalid_region");
	return region;
}

export function googleProject(env) {
	const project = env?.GCP_PROJECT_ID;
	if (!project) {
		throw Object.assign(new Error("google project unset"), {
			aiErrorClass: "provider_misconfigured",
			googleStatus: "no_project",
		});
	}
	const normalized = String(project);
	if (!GCP_PROJECT_ID_RE.test(normalized)) configurationError("invalid_project");
	return normalized;
}

/** Validate the complete authority before a bearer token is minted or attached.
 * The adapter has exactly two Google API authorities; user info, ports, HTTP,
 * and lookalike subdomains are never legal. */
export function assertGoogleApiUrl(env, value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		configurationError("invalid_endpoint");
	}
	const region = googleRegion(env);
	const allowedHosts = new Set([
		`${region}-aiplatform.googleapis.com`,
		"discoveryengine.googleapis.com",
	]);
	if (parsed.protocol !== "https:"
		|| parsed.port !== ""
		|| parsed.username !== ""
		|| parsed.password !== ""
		|| !allowedHosts.has(parsed.hostname)) {
		configurationError("invalid_endpoint");
	}
	return parsed.toString();
}

export function generateContentUrl(env, model) {
	const region = googleRegion(env);
	const project = googleProject(env);
	return assertGoogleApiUrl(env, `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`);
}

export function predictUrl(env, model) {
	const region = googleRegion(env);
	const project = googleProject(env);
	return assertGoogleApiUrl(env, `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:predict`);
}

export function rankUrl(env) {
	const project = googleProject(env);
	return assertGoogleApiUrl(env, `https://discoveryengine.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/rankingConfigs/default_ranking_config:rank`);
}

/** Is this an exact immutable Google id with an audited local rate card? */
export function isGoogleModelId(model) {
	return typeof model === "string"
		&& /^[a-z][a-z0-9.-]{0,127}$/.test(model)
		&& !model.endsWith("-latest")
		&& googleModelCard(model) != null;
}

function unitClassForCapability(capability) {
	if (capability === "embed_documents" || capability === "embed_query") return "embed_tokens";
	if (capability === "rerank") return "rank_units";
	return "gen_tokens";
}

/** Validate both transport identity and billing identity before admission. */
export function assertGoogleModelForCapability(model, capability) {
	if (typeof model !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(model)) {
		configurationError("invalid_model");
	}
	if (model.endsWith("-latest")) configurationError("moving_model_alias");
	const card = googleModelCard(model);
	if (!card) configurationError("unpriced_model");
	if (card.unitClass !== unitClassForCapability(capability)) {
		configurationError("model_capability_mismatch");
	}
	return model;
}
