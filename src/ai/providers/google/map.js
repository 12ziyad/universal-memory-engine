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

/** Input keywords whose semantics this adapter can preserve exactly in the
 * documented Vertex responseSchema subset. `additionalProperties` is accepted
 * only as a local-validation constraint and deliberately omitted on the wire.
 * Everything else fails closed; Google otherwise ignores unsupported fields. */
export const GOOGLE_RESPONSE_SCHEMA_KEYWORDS = Object.freeze([
	"type",
	"nullable",
	"properties",
	"required",
	"items",
	"anyOf",
	"enum",
	"format",
	"description",
	"propertyOrdering",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"additionalProperties",
]);

const SCHEMA_KEYWORDS = new Set(GOOGLE_RESPONSE_SCHEMA_KEYWORDS);
const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const SCHEMA_FORMATS = new Set(["date", "date-time", "duration", "time"]);

function schemaError(message) {
	return Object.assign(new Error(message), { aiErrorClass: "schema_untranslatable" });
}

function plainObject(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value, keyword) {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw schemaError(`schema keyword ${keyword} must be an array of strings`);
	}
	if (new Set(value).size !== value.length) throw schemaError(`schema keyword ${keyword} contains duplicates`);
	return [...value];
}

/** JSON-Schema → Vertex responseSchema (the explicitly supported subset). */
export function translateJsonSchema(schema) {
	if (!plainObject(schema)) throw schemaError("schema must be an object");
	for (const key of Object.keys(schema)) {
		if (!SCHEMA_KEYWORDS.has(key)) throw schemaError(`schema keyword ${key} is not translatable to Vertex responseSchema`);
	}

	// JSON Schema's nullable union idiom maps to Vertex's explicit nullable.
	// Preserve sibling constraints as well as the real arm instead of silently
	// discarding them.
	if (Array.isArray(schema.anyOf) && schema.anyOf.length === 2) {
		const nullArm = schema.anyOf.find((arm) => plainObject(arm) && arm.type === "null" && Object.keys(arm).length === 1);
		const realArm = schema.anyOf.find((arm) => arm !== nullArm);
		if (nullArm && plainObject(realArm)) {
			const siblings = { ...schema };
			delete siblings.anyOf;
			return { ...translateJsonSchema(realArm), ...translateJsonSchema(siblings), nullable: true };
		}
	}

	const out = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "additionalProperties") {
			if (typeof value !== "boolean") throw schemaError("schema keyword additionalProperties must be boolean");
			continue;
		}
		if (key === "type") {
			if (Array.isArray(value)) {
				const unique = [...new Set(value)];
				const nonNull = unique.filter((entry) => entry !== "null");
				if (unique.length !== 2 || nonNull.length !== 1 || !unique.includes("null") || !SCHEMA_TYPES.has(nonNull[0])) {
					throw schemaError("schema type arrays must contain one supported type plus null");
				}
				out.type = nonNull[0];
				out.nullable = true;
				continue;
			}
			if (!SCHEMA_TYPES.has(value)) throw schemaError(`schema type ${String(value)} is unsupported`);
			out.type = value;
			continue;
		}
		if (key === "nullable") {
			if (typeof value !== "boolean") throw schemaError("schema keyword nullable must be boolean");
			out.nullable = value;
			continue;
		}
		if (key === "properties") {
			if (!plainObject(value)) throw schemaError("schema keyword properties must be an object");
			out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, translateJsonSchema(child)]));
			continue;
		}
		if (key === "items") {
			out.items = translateJsonSchema(value);
			continue;
		}
		if (key === "anyOf") {
			if (!Array.isArray(value) || value.length === 0) throw schemaError("schema keyword anyOf must be a non-empty array");
			out.anyOf = value.map(translateJsonSchema);
			continue;
		}
		if (key === "enum") {
			const values = stringList(value, key);
			if (values.length === 0) throw schemaError("schema keyword enum must not be empty");
			out.enum = values;
			continue;
		}
		if (key === "format") {
			if (!SCHEMA_FORMATS.has(value)) throw schemaError(`schema format ${String(value)} is unsupported`);
			out.format = value;
			continue;
		}
		if (key === "description") {
			if (typeof value !== "string") throw schemaError("schema keyword description must be a string");
			out.description = value;
			continue;
		}
		if (key === "required" || key === "propertyOrdering") {
			out[key] = stringList(value, key);
			continue;
		}
		if (key === "minimum" || key === "maximum") {
			if (!Number.isFinite(value)) throw schemaError(`schema keyword ${key} must be finite`);
			out[key] = value;
			continue;
		}
		if (key === "minItems" || key === "maxItems") {
			if (!Number.isInteger(value) || value < 0) throw schemaError(`schema keyword ${key} must be a non-negative integer`);
			out[key] = value;
		}
	}

	if (out.minimum != null && out.maximum != null && out.minimum > out.maximum) {
		throw schemaError("schema minimum must not exceed maximum");
	}
	if (out.minItems != null && out.maxItems != null && out.minItems > out.maxItems) {
		throw schemaError("schema minItems must not exceed maxItems");
	}
	for (const keyword of ["required", "propertyOrdering"]) {
		if (out[keyword] && out.properties) {
			const unknown = out[keyword].find((name) => !(name in out.properties));
			if (unknown) throw schemaError(`schema keyword ${keyword} references unknown property ${unknown}`);
		}
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

/** :predict response → { data:[vec], usage } with dim assert + defensive L2
 * normalization. Google documents Gemini embeddings as normalized, but the
 * local canonicalization keeps the stored vector invariant explicit. */
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
	if (values.some((value) => !Number.isFinite(value))) {
		throw Object.assign(new Error("embedding response contains a non-finite value"), {
			aiErrorClass: "provider_bad_response",
		});
	}
	let norm = 0;
	for (const v of values) norm += v * v;
	norm = Math.sqrt(norm);
	if (!Number.isFinite(norm) || norm === 0) {
		throw Object.assign(new Error("embedding response has zero magnitude"), {
			aiErrorClass: "provider_bad_response",
		});
	}
	const normalized = values.map((v) => v / norm);
	const statistics = prediction?.embeddings?.statistics ?? {};
	const tokens = Number(statistics.token_count ?? 0) || 0;
	const truncated = statistics.truncated === true;
	return {
		data: [normalized],
		truncated,
		usage: {
			prompt_tokens: tokens,
			completion_tokens: 0,
			total_tokens: tokens,
			embedding_truncated: truncated,
		},
	};
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
