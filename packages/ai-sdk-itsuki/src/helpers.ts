/**
 * Standalone memory calls, for applications that want the pieces rather than
 * the automatic lifecycle.
 *
 * These are the escape hatch from the middleware: build your own prompt with
 * `retrieveMemories`, decide yourself what is worth storing with
 * `saveMemories`, or read the raw items with `getMemories`. Unlike the
 * middleware, these surface failures — a caller doing memory by hand wants to
 * know when the lookup failed.
 */

import { ItsukiMemory } from "./client.js";
import { resolveConfig, SOURCE, type ItsukiConfig, type ResolvedConfig } from "./config.js";
import { captureIdempotencyKey } from "./kernel/idempotency.js";
import { formatRecallBlock } from "./kernel/inject.js";
import { scrubText } from "./kernel/scrub.js";
import { bound } from "./util.js";
import type { CaptureMessage, MemoryListItem } from "./kernel/types.js";

export interface HelperOptions {
	signal?: AbortSignal;
}

function prepared(config: ItsukiConfig): { memory: ItsukiMemory; resolved: ResolvedConfig } {
	const resolved = resolveConfig(config);
	return { memory: new ItsukiMemory(resolved), resolved };
}

/**
 * The prompt-ready memory block for a query, or "" when there is nothing.
 * Throws on transport or authorization failure — a caller assembling a prompt
 * by hand should decide what an outage means for them.
 */
export async function retrieveMemories(
	prompt: string,
	config: ItsukiConfig,
	options: HelperOptions = {},
): Promise<string> {
	const { memory, resolved } = prepared(config);
	const payload = await memory.transport.recall(prompt, {
		userId: resolved.userId,
		limit: resolved.maxItems,
		recallScope: resolved.recallScope,
		projectId: resolved.projectId,
		conversationId: resolved.conversationId,
		timeoutMs: resolved.timeoutMs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return formatRecallBlock(payload["context"], resolved.maxContextChars) ?? "";
}

/** The raw recalled items, for callers doing their own formatting or ranking. */
export async function getMemories(
	prompt: string,
	config: ItsukiConfig,
	options: HelperOptions = {},
): Promise<MemoryListItem[]> {
	const { memory, resolved } = prepared(config);
	const payload = await memory.transport.recall(prompt, {
		userId: resolved.userId,
		limit: resolved.maxItems,
		recallScope: resolved.recallScope,
		projectId: resolved.projectId,
		conversationId: resolved.conversationId,
		timeoutMs: resolved.timeoutMs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	const items = payload["items"] ?? payload["nodes"] ?? [];
	if (!Array.isArray(items)) return [];
	return bound(items as MemoryListItem[], resolved.maxItems);
}

export interface SaveResult {
	sourcePacketId: string | null;
	duplicate: boolean;
}

/**
 * Store an exchange deliberately. Same derivation as automatic capture, so
 * saving the same messages twice stores one memory.
 */
export async function saveMemories(
	messages: CaptureMessage[],
	config: ItsukiConfig,
	options: HelperOptions = {},
): Promise<SaveResult> {
	const { memory, resolved } = prepared(config);
	const scrubbed = messages.map((message) => ({
		role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
		content: scrubText(message.content).text,
	}));
	const payload = await memory.transport.saveConversation(scrubbed, {
		idempotencyKey: captureIdempotencyKey({
			scope: {
				userId: resolved.userId,
				conversationId: resolved.conversationId,
				projectId: resolved.projectId,
				source: SOURCE,
			},
			messages: scrubbed,
		}),
		userId: resolved.userId,
		conversationId: resolved.conversationId,
		projectId: resolved.projectId,
		agentId: resolved.agentId,
		source: SOURCE,
		timeoutMs: resolved.captureTimeoutMs,
		...(options.signal ? { signal: options.signal } : {}),
	});
	return {
		sourcePacketId: typeof payload["source_packet_id"] === "string"
			? (payload["source_packet_id"] as string)
			: null,
		duplicate: payload["duplicate"] === true,
	};
}

/**
 * Wait for a staged write to finish background processing.
 * For tests, canaries and CLIs — never for a request path.
 */
export async function waitForMemory(
	sourcePacketId: string,
	config: ItsukiConfig,
	options: HelperOptions & { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Record<string, unknown>> {
	const { memory, resolved } = prepared(config);
	const budget = options.timeoutMs ?? 60_000;
	const interval = options.intervalMs ?? 1_500;
	const deadline = Date.now() + budget;
	let last: Record<string, unknown> = { status: "unknown" };

	for (;;) {
		last = await memory.transport.packetStatus(sourcePacketId, {
			userId: resolved.userId,
			...(options.signal ? { signal: options.signal } : {}),
		});
		const status = String(last["status"] ?? "");
		if (status === "enriched" || status === "failed" || status === "completed") return last;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { ...last, timed_out: true };
		await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
	}
}
