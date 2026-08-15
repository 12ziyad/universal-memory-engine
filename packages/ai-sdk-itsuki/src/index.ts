/**
 * ai-sdk-itsuki — Itsuki memory for the Vercel AI SDK.
 *
 *   import { openai } from "@ai-sdk/openai";
 *   import { generateText } from "ai";
 *   import { withItsuki } from "ai-sdk-itsuki";
 *
 *   const model = withItsuki(openai("gpt-5.2"), { userId: "u_42" });
 *   const { text } = await generateText({ model, prompt: "What am I learning?" });
 *
 * `withItsuki` wraps whatever model you already use. It is not a provider and
 * it bundles no provider: your API keys, your model ids and your provider's
 * behaviour are untouched. Memory is added in front of the call and observed
 * after it.
 */

import { wrapLanguageModel, type LanguageModel } from "ai";

import type { WrappableModel } from "./ai-types.js";

import { itsukiMiddleware } from "./middleware.js";
import { resolveConfig, type ItsukiConfig } from "./config.js";
import {
	getMemories,
	retrieveMemories,
	saveMemories,
	waitForMemory,
	type HelperOptions,
	type SaveResult,
} from "./helpers.js";
import { ItsukiMemory } from "./client.js";

/**
 * Wrap a language model so every call recalls before and captures after.
 *
 * The returned model is a drop-in replacement: pass it anywhere the AI SDK
 * accepts a model — generateText, streamText, generateObject, an Agent.
 */
export function withItsuki(model: WrappableModel, config: ItsukiConfig): LanguageModel {
	return wrapLanguageModel({
		model,
		middleware: itsukiMiddleware(config),
	});
}

export interface ItsukiToolkit {
	/** The middleware, for chaining with your own. */
	middleware: ReturnType<typeof itsukiMiddleware>;
	/** Wrap a model with this configuration. */
	wrap: (model: WrappableModel) => LanguageModel;
	/** Prompt-ready memory block for a query. */
	retrieveMemories: (prompt: string, options?: HelperOptions) => Promise<string>;
	/** Raw recalled items. */
	getMemories: (prompt: string, options?: HelperOptions) => Promise<unknown[]>;
	/** Store an exchange deliberately. */
	saveMemories: (
		messages: Array<{ role: "user" | "assistant"; content: string }>,
		options?: HelperOptions,
	) => Promise<SaveResult>;
	/** Wait for a staged write to finish processing. Tests and canaries only. */
	waitForMemory: (
		sourcePacketId: string,
		options?: HelperOptions & { timeoutMs?: number; intervalMs?: number },
	) => Promise<Record<string, unknown>>;
}

/**
 * One configured entry point: the middleware plus the standalone calls, all
 * sharing a single validated configuration.
 */
export function createItsuki(config: ItsukiConfig): ItsukiToolkit {
	// Fail here, at construction, rather than at the first model call.
	resolveConfig(config);
	const middleware = itsukiMiddleware(config);
	return {
		middleware,
		wrap: (model: WrappableModel) => wrapLanguageModel({ model, middleware }),
		retrieveMemories: (prompt, options) => retrieveMemories(prompt, config, options),
		getMemories: (prompt, options) => getMemories(prompt, config, options),
		saveMemories: (messages, options) => saveMemories(messages, config, options),
		waitForMemory: (sourcePacketId, options) => waitForMemory(sourcePacketId, config, options),
	};
}

export { itsukiMiddleware, INJECTION_MARKER } from "./middleware.js";
export { retrieveMemories, getMemories, saveMemories, waitForMemory } from "./helpers.js";
export { ItsukiMemory } from "./client.js";
export { ItsukiError } from "./kernel/errors.js";
export {
	RECALL_OPEN_MARKER,
	RECALL_CLOSE_MARKER,
	RECALL_PREAMBLE,
} from "./kernel/inject.js";
export type { ItsukiConfig, CaptureMode, CallOverrides, ResolvedConfig } from "./config.js";
export type { ErrorClass } from "./kernel/errors.js";
export type { ItsukiEvent, EventHook } from "./kernel/events.js";
export type { CaptureMessage, RecallScope, MemoryListItem } from "./kernel/types.js";
export type { HelperOptions, SaveResult } from "./helpers.js";
export type { RecallOutcome, CaptureOutcome } from "./client.js";
