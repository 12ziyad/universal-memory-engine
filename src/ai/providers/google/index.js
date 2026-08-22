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
	isGoogleModelId,
	predictUrl,
	rankUrl,
} from "./models.js";

function laneOf(call) {
	return call?.meta?.task ?? null;
}

function modelFor(call, fallbackLane) {
	// A pinned/policy model that is actually a Google id wins; the caller's
	// @cf/ id never leaks into a Google URL.
	if (isGoogleModelId(call.model) && call.model !== call.requestedModel) return call.model;
	return GOOGLE_DEFAULT_MODELS[laneOf(call) ?? fallbackLane] ?? GOOGLE_DEFAULT_MODELS[fallbackLane];
}

function timeoutFor(call) {
	return GOOGLE_TIMEOUTS_MS[laneOf(call)] ?? GOOGLE_MAX_TIMEOUT_MS;
}

export const googleProvider = {
	id: "google-vertex",
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

	/** One tiny metered call from the admin surface proves auth + enablement. */
	async health(env) {
		try {
			const model = GOOGLE_DEFAULT_MODELS.playground_chat;
			const json = await googleFetch(env, {
				url: generateContentUrl(env, model),
				body: buildGenerateContent({ messages: [{ role: "user", content: "Reply with the single word: ok" }], temperature: 0, max_tokens: 8 }, model),
				timeoutMs: 10_000,
			});
			const parsed = parseGenerateContent(json);
			return { ok: Boolean(parsed.choices?.[0]?.message?.content), model_version: parsed.model_version ?? null };
		} catch (error) {
			return { ok: false, error_class: error?.aiErrorClass ?? "error", status: error?.status ?? null };
		}
	},

	async invoke(env, call) {
		const capability = call.capability;
		if (capability === "embed_documents" || capability === "embed_query") {
			const model = GOOGLE_DEFAULT_MODELS.embed;
			const text = Array.isArray(call.inputs?.text) ? call.inputs.text[0] : call.inputs?.text;
			const json = await googleFetch(env, {
				url: predictUrl(env, model),
				body: buildEmbed({ text, intent: capability === "embed_query" ? "query" : "document" }),
				timeoutMs: timeoutFor(call),
			}, { });
			if (call.meta) call.meta.retryCount = json.__retry_count ?? 0;
			return parseEmbed(json);
		}
		if (capability === "rerank") {
			const model = modelFor(call, "rerank");
			const json = await googleFetch(env, {
				url: rankUrl(env),
				body: buildRank(call.inputs ?? {}, model),
				timeoutMs: timeoutFor(call),
			});
			if (call.meta) call.meta.retryCount = json.__retry_count ?? 0;
			return parseRank(json);
		}
		// generate_structured / generate_text / chat → generateContent.
		const model = modelFor(call, "extract");
		const json = await googleFetch(env, {
			url: generateContentUrl(env, model),
			body: buildGenerateContent(call.inputs ?? {}, model),
			timeoutMs: timeoutFor(call),
		});
		const parsed = parseGenerateContent(json);
		if (call.meta) {
			call.meta.retryCount = json.__retry_count ?? 0;
			call.meta.modelVersion = parsed.model_version ?? null;
		}
		return parsed;
	},
};
