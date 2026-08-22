/**
 * Request/response normalization: repo shapes in, repo shapes out.
 *
 * The whole detachability contract lives here: the adapter RETURNS responses
 * the existing parsers already read — OpenAI-ish `choices[]` + `usage` for
 * text (responseText/responseTruncated/readUsage), `{data:[vec]}` for
 * embeddings, `{response:[{id,score}]}` for rerank, a top-level `refusal` for
 * safety blocks (responseRefused), so NO call site ever learns a Google shape
 * existed.
 */

import { thinkingBudgetFor } from "./models.js";

// Memory text is the user's own life; default thresholds intermittently block
// exactly the payload (deaths, diagnoses, breakups). BLOCK_NONE everywhere —
// content classes Google blocks regardless map to `refusal`, never retried.
const SAFETY_OFF = [
	{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
	{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

/**
 * JSON-Schema → Vertex responseSchema (OpenAPI 3.0 subset).
 *  - type ["string","null"]  → { type: "string", nullable: true }
 *  - additionalProperties    → stripped (local validation is the trust boundary)
 *  - $ref / anyOf / oneOf / allOf / patternProperties → HARD FAIL, typed: a
 *    future schema author must find out, never get a silently-dropped keyword.
 */
export function translateJsonSchema(schema) {
	if (schema == null || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(translateJsonSchema);
	for (const forbidden of ["$ref", "anyOf", "oneOf", "allOf", "patternProperties"]) {
		if (forbidden in schema) {
			// Special case: the anyOf-null idiom `{anyOf:[{type:X},{type:"null"}]}`
			// translates cleanly to nullable X.
			if (forbidden === "anyOf" && Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
				const nullArm = schema.anyOf.find((a) => a?.type === "null");
				const realArm = schema.anyOf.find((a) => a?.type !== "null");
				if (nullArm && realArm) return { ...translateJsonSchema(realArm), nullable: true };
			}
			throw Object.assign(new Error(`schema keyword ${forbidden} is not translatable to Vertex responseSchema`), {
				aiErrorClass: "schema_untranslatable",
			});
		}
	}
	const out = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "additionalProperties") continue;
		if (key === "type" && Array.isArray(value)) {
			const nonNull = value.filter((t) => t !== "null");
			out.type = nonNull[0] ?? "string";
			if (value.includes("null")) out.nullable = true;
			continue;
		}
		if (key === "properties" && value && typeof value === "object") {
			out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translateJsonSchema(v)]));
			continue;
		}
		if (key === "items") {
			out.items = translateJsonSchema(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}

/** Repo chat input → generateContent body. */
export function buildGenerateContent({ messages = [], temperature, max_tokens, response_format, guided_json }, model) {
	const systemParts = [];
	const contents = [];
	for (const message of messages) {
		const text = String(message?.content ?? "");
		if (message?.role === "system") {
			systemParts.push({ text });
			continue;
		}
		contents.push({ role: message?.role === "assistant" ? "model" : "user", parts: [{ text }] });
	}
	const generationConfig = {
		...(Number.isFinite(temperature) ? { temperature } : {}),
		...(Number.isFinite(max_tokens) ? { maxOutputTokens: max_tokens } : {}),
	};
	const thinkingBudget = thinkingBudgetFor(model);
	if (thinkingBudget !== null) generationConfig.thinkingConfig = { thinkingBudget };
	const schema = response_format?.json_schema ?? guided_json ?? null;
	if (schema || response_format?.type === "json_object") {
		generationConfig.responseMimeType = "application/json";
		if (schema) generationConfig.responseSchema = translateJsonSchema(schema);
	}
	return {
		...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
		contents,
		generationConfig,
		safetySettings: SAFETY_OFF,
	};
}

const REFUSAL_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION", "SPII", "IMAGE_SAFETY"]);

/** generateContent response → the OpenAI-ish shape the repo already parses. */
export function parseGenerateContent(json) {
	const candidate = json?.candidates?.[0] ?? null;
	const blockReason = json?.promptFeedback?.blockReason ?? null;
	const finishReason = candidate?.finishReason ?? null;
	const refused = Boolean(blockReason) || REFUSAL_FINISH.has(finishReason);
	const text = (candidate?.content?.parts ?? [])
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("");
	const usageMeta = json?.usageMetadata ?? {};
	const usage = {
		prompt_tokens: Number(usageMeta.promptTokenCount ?? 0) || 0,
		completion_tokens: Number(usageMeta.candidatesTokenCount ?? 0) || 0,
		total_tokens: Number(usageMeta.totalTokenCount ?? 0) || 0,
		// Extra counts ride along verbatim; readUsage keeps unknowns in `raw`.
		...(usageMeta.thoughtsTokenCount != null ? { thoughts_tokens: Number(usageMeta.thoughtsTokenCount) } : {}),
		...(usageMeta.cachedContentTokenCount != null ? { cached_tokens: Number(usageMeta.cachedContentTokenCount) } : {}),
	};
	return {
		choices: [{
			message: { content: text },
			finish_reason: finishReason === "MAX_TOKENS" ? "length" : refused ? "content_filter" : "stop",
		}],
		usage,
		model_version: json?.modelVersion ?? null,
		// responseRefused (llm.js) checks res.refusal — enum only, no content.
		...(refused ? { refusal: { reason: blockReason ?? finishReason } } : {}),
	};
}

/** Repo embed input → :predict body. `intent` is the task-type asymmetry the
 * CF path does not have; document vs query matters for retrieval quality. */
export function buildEmbed({ text, intent = "document" }, { outputDimensionality = 768 } = {}) {
	return {
		instances: [{
			task_type: intent === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
			content: String(text ?? ""),
		}],
		parameters: { outputDimensionality, autoTruncate: true },
	};
}

/** :predict response → { data:[vec], usage } with dim assert + L2 normalize.
 * MRL-truncated gemini-embedding vectors are NOT unit-normalized; cosine
 * against an unnormalized vector silently mis-ranks, so normalization here is
 * mandatory, not cosmetic. */
export function parseEmbed(json, { expectedDim = 768 } = {}) {
	const prediction = json?.predictions?.[0] ?? null;
	const values = prediction?.embeddings?.values ?? prediction?.embeddings?.[0]?.values ?? null;
	if (!Array.isArray(values)) {
		throw Object.assign(new Error("embedding response missing values"), { aiErrorClass: "provider_bad_response" });
	}
	if (values.length !== expectedDim) {
		throw Object.assign(new Error(`embedding_dim_mismatch: got ${values.length}, expected ${expectedDim}`), {
			aiErrorClass: "embedding_dim_mismatch",
		});
	}
	let norm = 0;
	for (const v of values) norm += v * v;
	norm = Math.sqrt(norm) || 1;
	const normalized = values.map((v) => v / norm);
	const tokens = Number(prediction?.embeddings?.statistics?.token_count ?? 0) || 0;
	return { data: [normalized], usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens } };
}

/** Repo rerank input → Discovery Engine :rank body. Ids are input indexes —
 * the provider can reorder and drop, NEVER introduce: there is no channel
 * through which a candidate outside `contexts` could come back. */
export function buildRank({ query, contexts = [] }, model) {
	return {
		model,
		query: String(query ?? ""),
		records: contexts.map((c, i) => ({ id: String(i), content: String(c?.text ?? "") })),
		topN: contexts.length,
		ignoreRecordDetailsInResponse: true,
	};
}

export function parseRank(json) {
	const records = Array.isArray(json?.records) ? json.records : [];
	return {
		response: records
			.map((r) => ({ id: Number(r?.id), score: Number(r?.score ?? 0) }))
			.filter((r) => Number.isInteger(r.id)),
	};
}
