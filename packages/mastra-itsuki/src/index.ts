/**
 * mastra-itsuki — Itsuki memory for Mastra.
 *
 *   import { Agent } from "@mastra/core/agent";
 *   import { createItsuki } from "mastra-itsuki";
 *
 *   const itsuki = createItsuki({ defaultUserId: "user_42" });
 *
 *   const agent = new Agent({
 *     id: "support",
 *     model: "openai/gpt-5.2",
 *     instructions: "You help customers.",
 *     inputProcessors: [itsuki.recall],
 *     outputProcessors: [itsuki.capture],
 *     tools: itsuki.tools,
 *   });
 *
 * Two tiers, usable together or separately. The processors give the agent
 * memory automatically — recall before the model call, capture after the
 * answer settles. The tools let the model ask deliberately when you would
 * rather it decided.
 */

import { resolveConfig, type ItsukiConfig, type ResolvedConfig } from "./config.js";
import { ItsukiCapture, ItsukiRecall } from "./processors.js";
import { itsukiTools, type ToolOptions } from "./tools.js";
import { ItsukiMemory } from "./kernel/memory.js";

export interface ItsukiIntegration {
	/** Add to an Agent's inputProcessors. */
	recall: ItsukiRecall;
	/** Add to an Agent's outputProcessors. */
	capture: ItsukiCapture;
	/** Model-callable tools. Deletion is absent unless enabled. */
	tools: Record<string, unknown>;
	/** The shared client, for scripts, canaries and workflow steps. */
	memory: ItsukiMemory;
	/** The validated configuration. */
	config: ResolvedConfig;
}

/**
 * Build the processors, tools and client from one validated configuration.
 * Everything shares a single transport, so an agent makes one connection.
 */
export function createItsuki(
	config: ItsukiConfig = {},
	options: ToolOptions = {},
): ItsukiIntegration {
	const resolved = resolveConfig(config);
	const memory = options.memory ?? new ItsukiMemory(resolved);
	return {
		recall: new ItsukiRecall(resolved, { memory }),
		capture: new ItsukiCapture(resolved, { memory }),
		tools: itsukiTools(resolved, { ...options, memory }),
		memory,
		config: resolved,
	};
}

export { ItsukiRecall, ItsukiCapture } from "./processors.js";
export { itsukiTools } from "./tools.js";
export { resolveConfig, SOURCE, USER_AGENT } from "./config.js";
export { CONTEXT_KEYS, resolveIdentity } from "./identity.js";
export { ItsukiMemory } from "./kernel/memory.js";
export { ItsukiError } from "./kernel/errors.js";
export {
	RECALL_OPEN_MARKER,
	RECALL_CLOSE_MARKER,
	RECALL_PREAMBLE,
} from "./kernel/inject.js";
export type { ItsukiConfig, ResolvedConfig } from "./config.js";
export type { ToolOptions } from "./tools.js";
export type { RunIdentity } from "./identity.js";
export type { ErrorClass } from "./kernel/errors.js";
export type { ItsukiEvent, EventHook } from "./kernel/events.js";
export type { CaptureMessage, RecallScope, MemoryListItem } from "./kernel/types.js";
