/**
 * Automatic memory as Mastra agent processors.
 *
 * This is the part Mem0's Mastra integration never had: `@mastra/mem0` was a
 * pair of tools the model had to choose to call, and it has been orphaned
 * against a pre-1.0 core for long enough that its docs page 404s. Processors
 * are the current, supported way to touch an agent's messages, and they give
 * memory a real lifecycle — `processInput` puts relevant memory in front of
 * the model, `processOutputResult` observes what settled.
 *
 * Neither processor can fail a run. A throw inside a processor propagates into
 * the agent's execution, so both wrap everything and degrade to a no-op.
 */

import type { Processor } from "@mastra/core/processors";

import type {
	HostSystemMessage,
	ProcessInputArgs,
	ProcessInputResult,
	ProcessOutputResult,
	ProcessOutputResultArgs,
} from "./mastra-types.js";

import type { ResolvedConfig } from "./config.js";
import { configFor, resolveIdentity, type ContextLike, type MessageLike } from "./identity.js";
import { conversationMessages, latestUserText, settledExchange } from "./messages.js";
import { emit, SKIP_REASONS } from "./kernel/events.js";
import { echoSessionKey, suppressEchoLines } from "./kernel/inject.js";
import { ItsukiMemory } from "./kernel/memory.js";

/** State shared between this processor's calls within one run. */
interface RunState {
	fingerprints?: Set<string>;
	sessionKey?: string | null;
	config?: ResolvedConfig;
}

const STATE_KEY = "itsuki";

/** The agent's own id, when the host supplies one, for attribution only. */
function agentIdOf(agent: unknown): string | undefined {
	const named = agent as { id?: unknown; name?: unknown } | undefined;
	const value = typeof named?.id === "string" ? named.id : named?.name;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runState(state: Record<string, unknown>): RunState {
	const existing = state[STATE_KEY];
	if (existing && typeof existing === "object") return existing as RunState;
	const created: RunState = {};
	state[STATE_KEY] = created;
	return created;
}

export interface ProcessorOptions {
	/** Share one configured memory client between the two processors. */
	memory?: ItsukiMemory;
}

/**
 * Injects relevant memory as a system message before the model is called.
 *
 * The block is marker-fenced and labelled as data, so anything a previous
 * session stored is read as context rather than as instructions.
 */
export class ItsukiRecall implements Processor {
	readonly id = "itsuki-recall";
	readonly name = "Itsuki recall";
	readonly description = "Injects relevant long-term memory before the model call.";

	private readonly config: ResolvedConfig;
	private readonly memory: ItsukiMemory;

	constructor(config: ResolvedConfig, options: ProcessorOptions = {}) {
		this.config = config;
		this.memory = options.memory ?? new ItsukiMemory(config);
	}

	async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
		const messages = args.messages ?? [];
		const systemMessages = args.systemMessages ?? [];
		const unchanged: ProcessInputResult = { messages, systemMessages };
		try {
			const identity = resolveIdentity(
				this.config,
				messages as MessageLike[],
				args.requestContext as ContextLike | undefined,
				agentIdOf(args.agent),
			);
			if (!identity.userId) {
				emit(this.config.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.noIdentity });
				return unchanged;
			}
			const effective = configFor(this.config, identity);
			const state = runState(args.state ?? {});
			state.config = effective;

			const query = latestUserText(messages as MessageLike[]);
			if (!query) {
				emit(this.config.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.noUserMessage });
				return unchanged;
			}

			const outcome = await this.memory.recall(query, effective, args.abortSignal);
			if (!outcome.block) return unchanged;

			state.fingerprints = outcome.fingerprints;
			state.sessionKey = echoSessionKey(effective.conversationId ?? effective.userId);

			return {
				messages,
				systemMessages: [
					...systemMessages,
					{ role: "system", content: outcome.block } as HostSystemMessage,
				],
			};
		} catch {
			// Recall is best-effort by design: the agent answers without memory
			// rather than not answering at all.
			emit(this.config.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.notReady });
			return unchanged;
		}
	}
}

/**
 * Captures the settled exchange once the agent has produced its answer.
 *
 * Runs on the resolved result rather than the stream, because a stream chunk
 * is not a settled exchange and half an answer is not a memory.
 */
export class ItsukiCapture implements Processor {
	readonly id = "itsuki-capture";
	readonly name = "Itsuki capture";
	readonly description = "Stores the settled exchange in long-term memory.";

	private readonly config: ResolvedConfig;
	private readonly memory: ItsukiMemory;

	constructor(config: ResolvedConfig, options: ProcessorOptions = {}) {
		this.config = config;
		this.memory = options.memory ?? new ItsukiMemory(config);
	}

	async processOutputResult(args: ProcessOutputResultArgs): Promise<ProcessOutputResult> {
		const messages = args.messages ?? [];
		try {
			// The processor is handed only what the model just produced. The user
			// turn that prompted it lives on the message list.
			const conversation = conversationMessages(args);
			if (args.abortSignal?.aborted) {
				emit(this.config.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.aborted });
				return messages;
			}

			const state = runState(args.state ?? {});
			const identity = resolveIdentity(
				this.config,
				conversation,
				args.requestContext as ContextLike | undefined,
				agentIdOf(args.agent),
			);
			if (!identity.userId) {
				emit(this.config.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.noIdentity });
				return messages;
			}
			const effective = state.config ?? configFor(this.config, identity);

			const answer = typeof args.result?.text === "string" ? args.result.text : "";
			// Whatever the model repeated back from what we injected is our own
			// memory coming home, not something the user said this turn.
			const deEchoed = state.fingerprints?.size && state.sessionKey
				? suppressEchoLines(answer, state.fingerprints, state.sessionKey)
				: answer;

			const exchange = settledExchange(conversation, deEchoed);
			if (exchange.length === 0) {
				emit(this.config.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.notSettled });
				return messages;
			}

			await this.memory.capture(exchange, effective, { signal: args.abortSignal });
			return messages;
		} catch {
			emit(this.config.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.errored });
			return messages;
		}
	}
}
