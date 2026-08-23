/**
 * The Google Vertex AI provider. Lives ENTIRELY under this directory, is
 * loaded lazily by the registry, and is dead code without GCP_SERVICE_ACCOUNT
 * + GCP_PROJECT_ID. Deleting this directory plus the registry's one lazy
 * branch is the whole code-side removal — the architecture census proves it.
 */

import { googleFetch } from "./client.js";
import { buildEmbed, buildGenerateContent, buildRank, parseEmbed, parseGenerateContent, parseRank } from "./map.js";
import {
	generateContentUrl,
	GOOGLE_DEFAULT_MODELS,
	GOOGLE_MAX_TIMEOUT_MS,
	GOOGLE_TIMEOUTS_MS,
	assertGoogleModelForCapability,
	predictUrl,
	rankUrl,
} from "./models.js";

function laneOf(call) {
	return call?.meta?.task ?? null;
}

/** Resolve the exact concrete model the transport will call. Pure by design:
 * dispatch uses this same function before admission so reservations, pins,
 * rate cards, and provider invocation all name one identical model. */
export function resolveGoogleModel(call, capability = call?.capability) {
	const fallbackLane = capability === "rerank" ? "rerank" : "extract";
	const defaultModel = capability === "embed_documents" || capability === "embed_query"
		? GOOGLE_DEFAULT_MODELS.embed
		: GOOGLE_DEFAULT_MODELS[laneOf(call) ?? fallbackLane] ?? GOOGLE_DEFAULT_MODELS[fallbackLane];
	// Omission selects an audited default. Any explicit model must itself be an
	// exact, immutable, capability-matched ID with an exact rate card; silently
	// replacing an unknown policy/pin would destroy both replay and spend truth.
	return assertGoogleModelForCapability(
		typeof call?.model === "string" && call.model ? call.model : defaultModel,
		capability,
	);
}

function timeoutFor(call) {
	return GOOGLE_TIMEOUTS_MS[laneOf(call)] ?? GOOGLE_MAX_TIMEOUT_MS;
}

export const googleProvider = {
	id: "google-vertex",
	resolveModel: resolveGoogleModel,
	declaration: {
		capabilities: {
			chat: { structured: ["prompt"] },
			generate_text: { structured: ["prompt"] },
			generate_structured: {
				structured: ["response_format_json_object", "response_format_json_schema", "guided_json", "prompt"],
				constrained: "best_effort",
			},
			embed_documents: { space: "gemini-embedding-001/768-mrl-norm/cosine/v2", dims: 768 },
			embed_query: { space: "gemini-embedding-001/768-mrl-norm/cosine/v2", dims: 768 },
			rerank: { maxCandidates: 200 },
		},
		limits: { timeoutMs: GOOGLE_MAX_TIMEOUT_MS, retries: 2 },
		cost: { unit: "tokens", source: "usage_metadata" },
	},

	/** A health probe is a normal, billable call descriptor. The dispatch layer
	 * must admit, reserve, invoke, settle, and meter it; this provider never
	 * opens an unaccounted direct-transport escape hatch. */
	healthCall() {
		return {
			model: GOOGLE_DEFAULT_MODELS.playground_chat,
			inputs: {
				messages: [{ role: "user", content: "Reply with the single word: ok" }],
				temperature: 0,
				max_tokens: 8,
			},
			meta: { task: "provider_health", capability: "chat" },
		};
	},

	async invoke(env, call) {
		const capability = call.capability;
		if (capability === "embed_documents" || capability === "embed_query") {
			const model = resolveGoogleModel(call, capability);
			const text = Array.isArray(call.inputs?.text) ? call.inputs.text[0] : call.inputs?.text;
			const json = await googleFetch(env, {
				url: predictUrl(env, model),
				body: buildEmbed({ text, intent: capability === "embed_query" ? "query" : "document" }),
				timeoutMs: timeoutFor(call),
			}, { });
			if (call.meta) {
				call.meta.retryCount = json.__retry_count ?? 0;
				call.meta.ambiguousRetryCount = json.__ambiguous_retry_count ?? 0;
			}
			return parseEmbed(json);
		}
		if (capability === "rerank") {
			const model = resolveGoogleModel(call, capability);
			const json = await googleFetch(env, {
				url: rankUrl(env),
				body: buildRank(call.inputs ?? {}, model),
				timeoutMs: timeoutFor(call),
			});
			if (call.meta) {
				call.meta.retryCount = json.__retry_count ?? 0;
				call.meta.ambiguousRetryCount = json.__ambiguous_retry_count ?? 0;
			}
			return parseRank(json);
		}
		// generate_structured / generate_text / chat → generateContent.
		const model = resolveGoogleModel(call, capability);
		const json = await googleFetch(env, {
			url: generateContentUrl(env, model),
			body: buildGenerateContent(call.inputs ?? {}, model),
			timeoutMs: timeoutFor(call),
		});
		const parsed = parseGenerateContent(json);
		if (call.meta) {
			call.meta.retryCount = json.__retry_count ?? 0;
			call.meta.ambiguousRetryCount = json.__ambiguous_retry_count ?? 0;
			call.meta.modelVersion = parsed.model_version ?? null;
		}
		return parsed;
	},
};
