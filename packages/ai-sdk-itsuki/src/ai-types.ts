/**
 * The provider-spec types, derived from what `ai` actually exports.
 *
 * The spec types themselves (`LanguageModelV4CallOptions`,
 * `LanguageModelV4StreamPart`, …) live in `@ai-sdk/provider` and are NOT
 * re-exported by `ai` — the names `ai` exports under those words mean
 * something else entirely (`LanguageModelStreamPart` there is the UI-facing
 * stream part, not the provider one). Importing `@ai-sdk/provider` directly
 * would put a second version-pinned peer between this package and the host.
 *
 * So the types are read back off `LanguageModelMiddleware`, which `ai` does
 * export and which is exactly the provider-spec middleware. That has a second
 * benefit worth more than the tidiness: when the AI SDK renames the spec
 * generation again — V2 → V3 → V4 inside a year — these derivations keep
 * pointing at whatever the installed version's middleware speaks, and the
 * typecheck tells us if the SHAPE changed rather than only the name.
 */

import type { LanguageModelMiddleware, wrapLanguageModel } from "ai";

type TransformParamsFn = NonNullable<LanguageModelMiddleware["transformParams"]>;
type WrapGenerateFn = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapStreamFn = NonNullable<LanguageModelMiddleware["wrapStream"]>;

/** The provider-spec call options a middleware receives and returns. */
export type ModelCallOptions = Parameters<TransformParamsFn>[0]["params"];

export type ModelPrompt = ModelCallOptions["prompt"];
export type ModelMessage = ModelPrompt[number];

/** The settled result of a non-streaming generation. */
export type GenerateResult = Awaited<ReturnType<WrapGenerateFn>>;
export type ModelContent = GenerateResult["content"][number];

/** The streaming result, and the parts that flow through its stream. */
export type StreamResult = Awaited<ReturnType<WrapStreamFn>>;
export type ModelStreamPart =
	StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

/** Whatever this AI SDK version accepts as a wrappable model. */
export type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A text part, in both prompt and result positions. */
export interface TextLike {
	type: "text";
	text: string;
}

export function isTextLike(part: unknown): part is TextLike {
	return typeof part === "object"
		&& part !== null
		&& (part as { type?: unknown }).type === "text"
		&& typeof (part as { text?: unknown }).text === "string";
}
