/**
 * Configuration for the Mastra adapter.
 *
 * Mastra already has a first-class notion of who a conversation belongs to —
 * `resource` for the person and `thread` for the conversation — so the usual
 * "who is this?" problem mostly answers itself here. `defaultUserId` exists
 * only for single-tenant apps that never set a resource; when neither is
 * present the adapter skips rather than guessing, because guessing means
 * writing one user's memory into another user's space.
 */

import type { EventHook } from "./kernel/events.js";
import type { MemoryRuntimeConfig } from "./kernel/memory.js";
import { DEFAULT_BASE_URL, validApiKeyShape, validateBaseUrl } from "./kernel/transport.js";
import type { RecallScope } from "./kernel/types.js";

export const SOURCE = "mastra";
export const USER_AGENT = "mastra-itsuki";

export const SETUP_HINT =
	"Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY in your server environment.";

export interface ItsukiConfig {
	/** Falls back to ITSUKI_API_KEY. */
	apiKey?: string;
	/** Falls back to ITSUKI_BASE_URL, then https://itsuki.app. */
	baseUrl?: string;
	/**
	 * Used when a run carries no Mastra `resource`. Single-tenant apps set
	 * this; multi-tenant apps should pass a resource instead.
	 */
	defaultUserId?: string;
	/** Project attribution; also enables project-scoped recall. */
	projectId?: string;
	/** Defaults to project_then_global when projectId is set, else global. */
	recallScope?: RecallScope;
	/** Hard ceiling on injected memory. Defaults to 4000 characters. */
	maxContextChars?: number;
	/** Hard ceiling on recalled items. Defaults to 10. */
	maxItems?: number;
	/** Budget for a recall, including retries. Defaults to 6000ms. */
	timeoutMs?: number;
	/** Budget for a capture, including retries. Defaults to 15000ms. */
	captureTimeoutMs?: number;
	/** Retries for reads and idempotent writes. Defaults to 2. */
	maxRetries?: number;
	/** Content-free instrumentation. Never receives message text. */
	onEvent?: EventHook;

	// Test seams. Not part of the supported surface.
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

/** The base configuration, before a run's resource and thread are known. */
export interface ResolvedConfig extends MemoryRuntimeConfig {
	defaultUserId: string | undefined;
}

function clampNumber(value: number | undefined, fallback: number, low: number, high: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(value, low), high);
}

function readEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	const value = env?.[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveConfig(config: ItsukiConfig = {}): ResolvedConfig {
	const apiKey = (typeof config.apiKey === "string" && config.apiKey.trim())
		? config.apiKey.trim()
		: readEnv("ITSUKI_API_KEY");
	if (!apiKey) throw new Error(`The Itsuki API key is not configured. ${SETUP_HINT}`);
	if (!validApiKeyShape(apiKey)) {
		throw new Error(`The Itsuki API key is malformed — it looks like itsuki_live_… ${SETUP_HINT}`);
	}

	const baseUrl = validateBaseUrl(config.baseUrl ?? readEnv("ITSUKI_BASE_URL") ?? DEFAULT_BASE_URL);
	const projectId = config.projectId?.trim() || undefined;
	const defaultUserId = config.defaultUserId?.trim() || undefined;

	return {
		apiKey,
		baseUrl,
		source: SOURCE,
		userAgent: USER_AGENT,
		defaultUserId,
		// Filled in per run from the Mastra resource/thread; see identity.ts.
		userId: defaultUserId ?? "",
		conversationId: undefined,
		projectId,
		agentId: undefined,
		recallScope: config.recallScope ?? (projectId ? "project_then_global" : "global"),
		maxContextChars: clampNumber(config.maxContextChars, 4_000, 1, 100_000),
		maxItems: clampNumber(config.maxItems, 10, 1, 50),
		timeoutMs: clampNumber(config.timeoutMs, 6_000, 500, 120_000),
		captureTimeoutMs: clampNumber(config.captureTimeoutMs, 15_000, 500, 120_000),
		maxRetries: clampNumber(config.maxRetries, 2, 0, 5),
		onEvent: config.onEvent,
		fetchImpl: config.fetchImpl,
		sleepImpl: config.sleepImpl,
		random: config.random,
		now: config.now,
	};
}
