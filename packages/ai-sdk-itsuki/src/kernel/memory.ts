// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/memory.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * The recall and capture operations every TypeScript adapter performs.
 *
 * Both are total: recall never throws to a caller and capture never throws to
 * a caller. That is the fail-open decision made concrete — a memory service
 * that is down must cost the host a degraded answer, never a failed request.
 * Outcomes are reported through the return type and the event hook instead.
 *
 * The host-specific part — WHEN to call these, and what counts as a settled
 * exchange in that host's lifecycle — deliberately stays in each package.
 */

import { planBatches } from "./batching.js";
import { emit, SKIP_REASONS, type EventHook } from "./events.js";
import { ItsukiError } from "./errors.js";
import { echoFingerprints, echoSessionKey, formatRecallBlock } from "./inject.js";
import { captureIdempotencyKey } from "./idempotency.js";
import { scrubText } from "./scrub.js";
import { ItsukiTransport } from "./transport.js";
import type { CaptureMessage, RecallScope } from "./types.js";


/** What ItsukiMemory needs from a package's resolved configuration. */
export interface MemoryRuntimeConfig {
	apiKey: string;
	baseUrl: string;
	/** The adapter's source lane, e.g. "ai-sdk" or "mastra". */
	source: string;
	/** The adapter's User-Agent, so server logs name the real caller. */
	userAgent: string;
	userId: string;
	conversationId: string | undefined;
	projectId: string | undefined;
	agentId: string | undefined;
	recallScope: RecallScope;
	maxContextChars: number;
	maxItems: number;
	timeoutMs: number;
	captureTimeoutMs: number;
	maxRetries: number;
	onEvent: EventHook | undefined;
	fetchImpl: typeof fetch | undefined;
	sleepImpl: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
	random: (() => number) | undefined;
	now: (() => number) | undefined;
}

export interface RecallOutcome {
	/** The block to inject, already bounded and marker-wrapped. Null when empty. */
	block: string | null;
	/** Line fingerprints of what was injected, for echo suppression on capture. */
	fingerprints: Set<string>;
	count: number;
	failed: boolean;
}

export interface CaptureOutcome {
	staged: boolean;
	packetIds: string[];
	skipped?: string;
	failed?: boolean;
}

const EMPTY_RECALL: RecallOutcome = Object.freeze({
	block: null,
	fingerprints: new Set<string>(),
	count: 0,
	failed: false,
}) as RecallOutcome;

export class ItsukiMemory {
	readonly transport: ItsukiTransport;
	private readonly onEvent: EventHook | undefined;

	constructor(config: MemoryRuntimeConfig) {
		this.transport = new ItsukiTransport({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			userAgent: config.userAgent,
			timeoutMs: config.timeoutMs,
			maxRetries: config.maxRetries,
			...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
			...(config.sleepImpl ? { sleepImpl: config.sleepImpl } : {}),
			...(config.random ? { random: config.random } : {}),
			...(config.now ? { now: config.now } : {}),
		});
		this.onEvent = config.onEvent;
	}

	/**
	 * Look up memory for a query and format it for injection.
	 * Never throws: a recall failure degrades the answer, it does not fail it.
	 */
	async recall(
		query: string,
		config: MemoryRuntimeConfig,
		signal?: AbortSignal,
	): Promise<RecallOutcome> {
		const trimmed = query.trim();
		if (!trimmed) {
			emit(this.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.emptyQuery });
			return EMPTY_RECALL;
		}
		const started = Date.now();
		try {
			const payload = await this.transport.recall(trimmed, {
				userId: config.userId,
				limit: config.maxItems,
				recallScope: config.recallScope,
				projectId: config.projectId,
				conversationId: config.conversationId,
				timeoutMs: config.timeoutMs,
				...(signal ? { signal } : {}),
			});
			const block = formatRecallBlock(payload["context"], config.maxContextChars);
			const count = Number(payload["count"] ?? 0);
			const sessionKey = echoSessionKey(config.conversationId ?? config.userId);
			const fingerprints = block && sessionKey
				? echoFingerprints(String(payload["context"] ?? ""), sessionKey)
				: new Set<string>();
			emit(this.onEvent, {
				type: "recall.ok",
				ms: Date.now() - started,
				count: Number.isFinite(count) ? count : 0,
				injectedChars: block ? block.length : 0,
			});
			return { block, fingerprints, count: Number.isFinite(count) ? count : 0, failed: false };
		} catch (error) {
			emit(this.onEvent, {
				type: "recall.fail",
				ms: Date.now() - started,
				errorClass: error instanceof ItsukiError ? error.errorClass : "unknown",
			});
			return { block: null, fingerprints: new Set<string>(), count: 0, failed: true };
		}
	}

	/**
	 * Stage a settled exchange. Never throws.
	 *
	 * The idempotency key is derived from the content, so a retried request, a
	 * reconnected stream and a re-executed step all compute the same key and
	 * the server keeps one memory.
	 */
	async capture(
		messages: CaptureMessage[],
		config: MemoryRuntimeConfig,
		options: { signal?: AbortSignal | undefined } = {},
	): Promise<CaptureOutcome> {
		if (messages.length === 0) {
			emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.nothingToCapture });
			return { staged: false, packetIds: [], skipped: SKIP_REASONS.nothingToCapture };
		}

		// Scrub before anything leaves the process: a pasted key must not
		// become a durable memory, and the placeholder keeps the sentence
		// meaningful.
		const scrubbed = messages.map((message) => ({
			role: message.role,
			content: scrubText(message.content).text,
		}));
		const batches = planBatches(scrubbed);
		if (batches.length === 0) {
			emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.nothingToCapture });
			return { staged: false, packetIds: [], skipped: SKIP_REASONS.nothingToCapture };
		}

		const started = Date.now();
		const packetIds: string[] = [];
		try {
			for (let index = 0; index < batches.length; index += 1) {
				const batch = batches[index]!;
				const idempotencyKey = captureIdempotencyKey({
					scope: {
						userId: config.userId,
						conversationId: config.conversationId,
						projectId: config.projectId,
						source: config.source,
					},
					messages: batch,
					discriminator: batches.length > 1 ? `batch:${index}/${batches.length}` : undefined,
				});
				const payload = await this.transport.saveConversation(batch, {
					idempotencyKey,
					userId: config.userId,
					conversationId: config.conversationId,
					projectId: config.projectId,
					agentId: config.agentId,
					source: config.source,
					timeoutMs: config.captureTimeoutMs,
					...(options.signal ? { signal: options.signal } : {}),
				});
				const packetId = payload["source_packet_id"];
				if (typeof packetId === "string") packetIds.push(packetId);
			}
			emit(this.onEvent, {
				type: "capture.staged",
				ms: Date.now() - started,
				messages: scrubbed.length,
				batches: batches.length,
				packetId: packetIds[0] ?? null,
			});
			return { staged: true, packetIds };
		} catch (error) {
			emit(this.onEvent, {
				type: "capture.fail",
				ms: Date.now() - started,
				errorClass: error instanceof ItsukiError ? error.errorClass : "unknown",
			});
			return { staged: false, packetIds, failed: true };
		}
	}
}
