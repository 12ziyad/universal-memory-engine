/**
 * Itsuki memory as AI SDK language-model middleware.
 *
 * `transformParams` puts relevant memory in front of the model before it
 * reads anything; `wrapGenerate` and `wrapStream` capture the exchange once it
 * has actually settled. The model is never asked to decide either — an agent
 * that has to remember to look things up is an agent that forgets.
 *
 * Two invariants shape everything below:
 *
 *  1. The wrapped provider must come out unchanged. Tool calls, structured
 *     output, usage, warnings, provider metadata and stream ordering are the
 *     provider's business; this middleware adds a system block on the way in
 *     and observes on the way out. It never rewrites a result.
 *  2. Nothing here may fail a turn. Recall failure means the model answers
 *     without memory; capture failure means the exchange is not stored. Both
 *     are visible through the event hook and invisible to the end user.
 */

import type { LanguageModelMiddleware } from "ai";

import type { ModelCallOptions, ModelStreamPart } from "./ai-types.js";

import {
	readCallOverrides,
	resolveConfig,
	withOverrides,
	type ItsukiConfig,
	type ResolvedConfig,
} from "./config.js";
import { ItsukiMemory } from "./client.js";
import {
	assistantTextFromContent,
	injectContext,
	latestUserText,
	settledExchange,
} from "./messages.js";
import { emit, SKIP_REASONS } from "./kernel/events.js";
import { RECALL_OPEN_MARKER, suppressEchoLines, echoSessionKey } from "./kernel/inject.js";

/**
 * What one call decided, carried from transformParams to the wrap hooks.
 *
 * Keyed by the params object the SDK threads through the chain, so two
 * concurrent calls on the same wrapped model never read each other's tenancy —
 * the failure a module-level "current call" variable would produce under any
 * real server load.
 */
interface CallState {
	config: ResolvedConfig;
	fingerprints: Set<string>;
	injected: boolean;
}

const CALL_STATE = new WeakMap<ModelCallOptions, CallState>();

/** Strip our namespace so the provider is handed only what it understands. */
function withoutItsukiOptions(
	params: ModelCallOptions,
): ModelCallOptions {
	const options = params.providerOptions;
	if (!options || !("itsuki" in options)) return params;
	const { itsuki: _itsuki, ...rest } = options as Record<string, unknown>;
	return {
		...params,
		providerOptions: rest as typeof options,
	};
}

export function itsukiMiddleware(config: ItsukiConfig): LanguageModelMiddleware {
	const base = resolveConfig(config);
	const memory = new ItsukiMemory(base);

	/** Hand a background capture to the platform, or let it run detached. */
	const schedule = (promise: Promise<unknown>, effective: ResolvedConfig): void => {
		const safe = promise.then(
			() => undefined,
			() => undefined,
		);
		if (effective.waitUntil) {
			try {
				effective.waitUntil(safe);
				return;
			} catch {
				// A host whose waitUntil rejects outside a request scope still
				// gets the capture attempt; it just loses the guarantee.
			}
		}
		void safe;
	};

	const captureSettled = async (
		params: ModelCallOptions,
		assistantText: string,
	): Promise<void> => {
		const state = CALL_STATE.get(params);
		const effective = state?.config ?? base;

		if (effective.capture === "off") {
			emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.disabled });
			return;
		}
		if (params.abortSignal?.aborted) {
			emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.aborted });
			return;
		}

		// Anything the model repeated back from what we injected is not a new
		// fact the user stated — it is our own memory coming home. Storing it
		// is how a memory system slowly convinces itself of its own output.
		const sessionKey = echoSessionKey(effective.conversationId ?? effective.userId);
		const deEchoed = state && sessionKey && state.fingerprints.size > 0
			? suppressEchoLines(assistantText, state.fingerprints, sessionKey)
			: assistantText;

		const messages = settledExchange(params.prompt, deEchoed);
		if (messages.length === 0) {
			emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.notSettled });
			return;
		}

		const promise = memory.capture(messages, effective);
		if (effective.capture === "blocking") {
			await promise;
			return;
		}
		schedule(promise, effective);
	};

	return {
		specificationVersion: "v4",

		async transformParams({ params }) {
			const overrides = readCallOverrides(params.providerOptions?.["itsuki"]);
			const effective = withOverrides(base, overrides);
			const clean = withoutItsukiOptions(params);

			const state: CallState = {
				config: effective,
				fingerprints: new Set<string>(),
				injected: false,
			};

			if (!effective.recall) {
				emit(effective.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.disabled });
				CALL_STATE.set(clean, state);
				return clean;
			}

			const query = overrides.query ?? latestUserText(params.prompt);
			if (!query.trim()) {
				emit(effective.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.noUserMessage });
				CALL_STATE.set(clean, state);
				return clean;
			}

			const outcome = await memory.recall(query, effective, params.abortSignal);
			if (!outcome.block) {
				CALL_STATE.set(clean, state);
				return clean;
			}

			state.fingerprints = outcome.fingerprints;
			state.injected = true;
			const next: ModelCallOptions = {
				...clean,
				prompt: injectContext(clean.prompt, outcome.block),
			};
			CALL_STATE.set(next, state);
			return next;
		},

		async wrapGenerate({ doGenerate, params }) {
			const result = await doGenerate();
			// The result is returned exactly as the provider produced it. Capture
			// observes; it never edits.
			await captureSettled(params, assistantTextFromContent(result.content));
			return result;
		},

		async wrapStream({ doStream, params }) {
			const { stream, ...rest } = await doStream();

			let text = "";
			let finished = false;
			let errored = false;

			const state = CALL_STATE.get(params);
			const effective = state?.config ?? base;
			if (effective.capture === "off") {
				emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.disabled });
				return { stream, ...rest };
			}

			const tap = new TransformStream<ModelStreamPart, ModelStreamPart>({
				transform(chunk, controller) {
					// Enqueue first, always: the host's stream must never wait on
					// this middleware's bookkeeping.
					controller.enqueue(chunk);
					if (chunk.type === "text-delta") text += chunk.delta;
					else if (chunk.type === "finish") finished = true;
					else if (chunk.type === "error") errored = true;
				},
				flush() {
					// flush only runs when the source closed on its own. A
					// cancelled or aborted stream never reaches here, which is
					// exactly the behaviour we want: a half-spoken answer is not
					// a settled exchange.
					if (errored) {
						emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.errored });
						return;
					}
					if (!finished) {
						emit(effective.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.notSettled });
						return;
					}
					schedule(captureSettled(params, text), effective);
				},
			});

			return { stream: stream.pipeThrough(tap), ...rest };
		},
	};
}

/** Exported for tests and for callers that want to detect their own injection. */
export const INJECTION_MARKER = RECALL_OPEN_MARKER;
