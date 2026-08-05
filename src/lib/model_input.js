/**
 * Deterministic context guard for Workers AI chat-generation calls.
 *
 * Context windows are model-specific. We reserve 4,096 tokens for output and
 * a further 4,096 for the provider's chat template / tokenizer variance, then
 * treat the remainder as a UTF-8 BYTE ceiling for the complete serialized
 * input object, capped at 24,576 bytes across every configured model. A byte
 * ceiling is deliberately more conservative than estimating tokens from
 * JavaScript string length, and cannot be bypassed by multibyte Unicode or
 * JSON control-character escapes.
 *
 * When context must be bounded, older non-system turns give way first. Inside
 * a bounded turn we keep both its beginning and, preferentially, its tail so
 * the newest/source slice remains intact whenever the fixed prompt permits it.
 * Every omission is labelled inside the prompt and returned as content-free
 * metadata. Fixed system/schema data is never silently cut: if that alone
 * cannot fit, the caller receives ModelInputBoundaryError before inference.
 */

export const MODEL_CONTEXT_TOKENS = 32_768;
export const MODEL_OUTPUT_RESERVE_TOKENS = 4_096;
export const MODEL_TEMPLATE_RESERVE_TOKENS = 4_096;
export const MODEL_INPUT_MAX_UTF8_BYTES =
	MODEL_CONTEXT_TOKENS - MODEL_OUTPUT_RESERVE_TOKENS - MODEL_TEMPLATE_RESERVE_TOKENS;
export const MODEL_MIN_SOURCE_UTF8_BYTES = 512;

// Current Cloudflare model-page context windows for every chat model exposed
// by this deployment. Unknown operator/eval overrides use the smallest current
// profile (32,000), never the larger Qwen assumption.
export const MODEL_CONTEXT_TOKENS_BY_ID = Object.freeze({
	"@cf/meta/llama-3.1-8b-instruct-fp8": 32_000,
	"@cf/meta/llama-3.2-1b-instruct": 60_000,
	"@cf/qwen/qwen3-30b-a3b-fp8": 32_768,
	"@cf/openai/gpt-oss-120b": 128_000,
	"@cf/google/gemma-4-26b-a4b-it": 256_000,
	"@cf/moonshotai/kimi-k2.6": 262_144,
});
export const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_000;

const MAX_GRAPHEME_UTF8_BYTES = 256;
const TAIL_SHARE = 0.75;
const encoder = new TextEncoder();

export class ModelInputBoundaryError extends Error {
	constructor(reason, metadata) {
		super(`model input boundary: ${reason}`);
		this.name = "ModelInputBoundaryError";
		this.code = "model_input_boundary";
		this.metadata = Object.freeze({ ...metadata, blocked: true, error: reason });
	}
}

export function utf8Bytes(value) {
	return encoder.encode(String(value ?? "")).byteLength;
}

/** Exact bytes sent as the binding's JSON-serializable input. */
export function serializedInputBytes(value) {
	let serialized;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new ModelInputBoundaryError("input_not_serializable", {
			limit_bytes: MODEL_INPUT_MAX_UTF8_BYTES,
			original_bytes: null,
			final_bytes: null,
			cause: error?.name ?? "serialization_error",
		});
	}
	if (serialized === undefined) {
		throw new ModelInputBoundaryError("input_not_serializable", {
			limit_bytes: MODEL_INPUT_MAX_UTF8_BYTES,
			original_bytes: null,
			final_bytes: null,
		});
	}
	return encoder.encode(serialized).byteLength;
}

function requestedOutputTokens(inputs) {
	const configured = Number(inputs?.max_tokens);
	return Number.isFinite(configured) && configured > 0
		? Math.ceil(configured)
		: MODEL_OUTPUT_RESERVE_TOKENS;
}

function modelContext(model) {
	const id = String(model ?? "");
	const known = MODEL_CONTEXT_TOKENS_BY_ID[id];
	return known
		? { tokens: known, profile: id }
		: { tokens: UNKNOWN_MODEL_CONTEXT_TOKENS, profile: "conservative_unknown" };
}

function inputLimit(inputs, ceiling, contextTokens) {
	const outputTokens = Math.max(MODEL_OUTPUT_RESERVE_TOKENS, requestedOutputTokens(inputs));
	const contextRemainder = contextTokens - outputTokens - MODEL_TEMPLATE_RESERVE_TOKENS;
	return {
		outputTokens,
		limit: Math.min(ceiling, contextRemainder),
	};
}

function unicodeUnits(text) {
	const value = String(text ?? "");
	let segments;
	try {
		segments = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
			? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((part) => part.segment)
			: Array.from(value);
	} catch {
		segments = Array.from(value);
	}

	// A pathological combining/ZWJ sequence can be one unbounded grapheme.
	// Preserve ordinary graphemes, but split a giant one at Unicode code-point
	// boundaries so it cannot bypass the byte ceiling or force an avoidable fail.
	const units = [];
	for (const segment of segments) {
		if (utf8Bytes(segment) <= MAX_GRAPHEME_UTF8_BYTES) units.push(segment);
		else units.push(...Array.from(segment));
	}
	return units;
}

function retainedParts(units, keepUnits) {
	const keep = Math.max(0, Math.min(units.length, Math.floor(keepUnits)));
	if (keep >= units.length) return { head: units.join(""), tail: "", retained: units.join("") };
	if (keep === 0) return { head: "", tail: "", retained: "" };
	const tailCount = Math.max(1, Math.ceil(keep * TAIL_SHARE));
	const headCount = Math.max(0, keep - tailCount);
	const head = headCount ? units.slice(0, headCount).join("") : "";
	const tail = units.slice(units.length - tailCount).join("");
	return { head, tail, retained: head + tail };
}

function boundedContent(original, units, keepUnits) {
	if (keepUnits >= units.length) {
		return {
			content: original,
			kept_units: units.length,
			omitted_units: 0,
			original_content_bytes: utf8Bytes(original),
			retained_content_bytes: utf8Bytes(original),
			omitted_content_bytes: 0,
		};
	}
	const parts = retainedParts(units, keepUnits);
	const originalBytes = utf8Bytes(original);
	const retainedBytes = utf8Bytes(parts.retained);
	const omittedBytes = Math.max(0, originalBytes - retainedBytes);
	const omittedUnits = Math.max(0, units.length - Math.max(0, Math.floor(keepUnits)));
	const marker = `[Itsuki model-input boundary: omitted ${omittedBytes} UTF-8 byte(s) ` +
		`across ${omittedUnits} Unicode unit(s); preserved beginning and newest/source tail.]`;
	const content = parts.head
		? `${parts.head}\n${marker}\n${parts.tail}`
		: `${marker}${parts.tail ? `\n${parts.tail}` : ""}`;
	return {
		content,
		kept_units: Math.max(0, Math.floor(keepUnits)),
		omitted_units: omittedUnits,
		original_content_bytes: originalBytes,
		retained_content_bytes: retainedBytes,
		omitted_content_bytes: omittedBytes,
	};
}

function messageCandidate(message) {
	return message && typeof message.content === "string" && String(message.role ?? "user") !== "system";
}

function metadataFor({
	originalBytes,
	finalBytes,
	limit,
	outputTokens,
	contextTokens,
	contextProfile,
	boundedMessages,
	error = null,
}) {
	return Object.freeze({
		bounded: boundedMessages.length > 0,
		error,
		context_tokens: contextTokens,
		context_profile: contextProfile,
		output_reserve_tokens: outputTokens,
		template_reserve_tokens: MODEL_TEMPLATE_RESERVE_TOKENS,
		limit_bytes: limit,
		original_bytes: originalBytes,
		final_bytes: finalBytes,
		omitted_serialized_bytes: Math.max(0, originalBytes - finalBytes),
		bounded_messages: boundedMessages.map((item) => Object.freeze({ ...item })),
	});
}

/**
 * Bound a Workers AI chat input without mutating the caller's object.
 * Non-chat inputs (for example embeddings' `{ text: [...] }`) pass through.
 */
export function guardModelInput(inputs, { maxBytes = MODEL_INPUT_MAX_UTF8_BYTES, model = null } = {}) {
	if (!inputs || typeof inputs !== "object" || !Array.isArray(inputs.messages)) {
		return { inputs, boundary: null };
	}
	const ceiling = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
		? Math.floor(Number(maxBytes))
		: MODEL_INPUT_MAX_UTF8_BYTES;
	const { tokens: contextTokens, profile: contextProfile } = modelContext(model);
	const { outputTokens, limit } = inputLimit(inputs, ceiling, contextTokens);
	const originalBytes = serializedInputBytes(inputs);
	if (limit <= 0) {
		throw new ModelInputBoundaryError("output_and_template_reserve_exhaust_context", {
			context_tokens: contextTokens,
			context_profile: contextProfile,
			output_reserve_tokens: outputTokens,
			template_reserve_tokens: MODEL_TEMPLATE_RESERVE_TOKENS,
			limit_bytes: limit,
			original_bytes: originalBytes,
			final_bytes: null,
		});
	}
	if (originalBytes <= limit) {
		return {
			inputs,
			boundary: metadataFor({
				originalBytes,
				finalBytes: originalBytes,
				limit,
				outputTokens,
				contextTokens,
				contextProfile,
				boundedMessages: [],
			}),
		};
	}

	const messages = inputs.messages.map((message) => (
		message && typeof message === "object" ? { ...message } : message
	));
	const guardedInputs = { ...inputs, messages };
	const candidates = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => messageCandidate(message));
	const newestSource = [...candidates].reverse().find(({ message }) => message.role === "user") ?? candidates.at(-1);
	// Preserve the authoritative newest user/source turn ahead of every other
	// trimmable turn, including assistant context that happens to follow it.
	const reductionOrder = newestSource
		? [...candidates.filter(({ index }) => index !== newestSource.index), newestSource]
		: candidates;
	const boundedMessages = [];

	for (const { message, index } of reductionOrder) {
		if (serializedInputBytes(guardedInputs) <= limit) break;
		const original = message.content;
		const units = unicodeUnits(original);
		const minimum = boundedContent(original, units, 0);
		message.content = minimum.content;
		const minimumBytes = serializedInputBytes(guardedInputs);

		let chosen = minimum;
		if (minimumBytes <= limit) {
			// Keep as much of this older message as possible. Later/newer messages
			// stay complete unless reducing all older context was insufficient.
			let low = 0;
			let high = units.length;
			while (low <= high) {
				const mid = Math.floor((low + high) / 2);
				const attempt = boundedContent(original, units, mid);
				message.content = attempt.content;
				if (serializedInputBytes(guardedInputs) <= limit) {
					chosen = attempt;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			}
		}
		message.content = chosen.content;
		boundedMessages.push({
			index,
			role: String(message.role ?? "user"),
			original_content_bytes: chosen.original_content_bytes,
			retained_content_bytes: chosen.retained_content_bytes,
			omitted_content_bytes: chosen.omitted_content_bytes,
			omitted_unicode_units: chosen.omitted_units,
		});
	}

	const finalBytes = serializedInputBytes(guardedInputs);
	if (finalBytes > limit) {
		throw new ModelInputBoundaryError("fixed_prompt_exceeds_safe_context", {
			context_tokens: contextTokens,
			context_profile: contextProfile,
			output_reserve_tokens: outputTokens,
			template_reserve_tokens: MODEL_TEMPLATE_RESERVE_TOKENS,
			limit_bytes: limit,
			original_bytes: originalBytes,
			final_bytes: finalBytes,
			bounded_messages: boundedMessages,
		});
	}
	const boundedSource = newestSource
		? boundedMessages.find((message) => message.index === newestSource.index)
		: null;
	if (boundedSource) {
		const usefulMinimum = Math.min(
			MODEL_MIN_SOURCE_UTF8_BYTES,
			boundedSource.original_content_bytes,
		);
		if (boundedSource.retained_content_bytes < usefulMinimum) {
			throw new ModelInputBoundaryError("newest_source_tail_cannot_fit", {
				context_tokens: contextTokens,
				context_profile: contextProfile,
				output_reserve_tokens: outputTokens,
				template_reserve_tokens: MODEL_TEMPLATE_RESERVE_TOKENS,
				limit_bytes: limit,
				original_bytes: originalBytes,
				final_bytes: finalBytes,
				minimum_source_bytes: usefulMinimum,
				bounded_messages: boundedMessages,
			});
		}
	}

	return {
		inputs: guardedInputs,
		boundary: metadataFor({
			originalBytes,
			finalBytes,
			limit,
			outputTokens,
			contextTokens,
			contextProfile,
			boundedMessages,
		}),
	};
}
