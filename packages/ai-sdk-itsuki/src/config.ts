/**
 * Configuration resolution and the guards that run before anything else.
 *
 * Two of these guards exist because the failure they prevent is silent and
 * expensive: a missing `userId` would write every end user's memory into one
 * shared space (and you would only find out by reading someone else's facts
 * back), and a key resolved in a browser bundle is a key published to the
 * world. Both refuse at construction, where a developer sees them, rather
 * than at the first call, where a user does.
 */

import { type EventHook } from "./kernel/events.js";
import { validApiKeyShape, validateBaseUrl, DEFAULT_BASE_URL } from "./kernel/transport.js";
import type { RecallScope } from "./kernel/types.js";

export const SOURCE = "ai-sdk";
export const USER_AGENT = "ai-sdk-itsuki";

/** How the settled turn reaches Itsuki once a generation finishes. */
export type CaptureMode = "background" | "blocking" | "off";

export interface ItsukiConfig {
	/** Falls back to ITSUKI_API_KEY. Never read from a browser bundle. */
	apiKey?: string;
	/** Falls back to ITSUKI_BASE_URL, then https://itsuki.app. */
	baseUrl?: string;
	/**
	 * The end user this model call belongs to — YOUR application's stable id
	 * for them. Required: there is no safe default for "whose memory is this".
	 */
	userId: string;
	/** Stable id for the thread. The de-duplication anchor for capture. */
	conversationId?: string;
	/** Project attribution; also enables project-scoped recall. */
	projectId?: string;
	/** Agent attribution in multi-agent applications. */
	agentId?: string;
	/** Defaults to project_then_global when projectId is set, else global. */
	recallScope?: RecallScope;
	/** Turn recall off and keep capture (default: recall on). */
	recall?: boolean;
	/**
	 * background (default): stage after the response is returned.
	 * blocking: stage before returning, adding the staging round trip to
	 *   latency but guaranteeing the write left the process — the right choice
	 *   on a serverless platform that freezes after the response, unless you
	 *   pass waitUntil.
	 * off: recall only.
	 */
	capture?: CaptureMode;
	/**
	 * Hand a background capture to the platform so it survives the response.
	 * On Vercel this is `waitUntil` from `@vercel/functions`, or Next.js
	 * `after()`. Without it, a background capture on a freeze-after-response
	 * platform can be cut off mid-flight.
	 */
	waitUntil?: (promise: Promise<unknown>) => void;
	/** Hard ceiling on injected memory. Defaults to 4000 characters. */
	maxContextChars?: number;
	/** Hard ceiling on recalled items. Defaults to 10. */
	maxItems?: number;
	/** Budget for the recall call, including retries. Defaults to 6000ms. */
	timeoutMs?: number;
	/** Budget for the capture call, including retries. Defaults to 15000ms. */
	captureTimeoutMs?: number;
	/** Retries for reads and idempotent writes. Defaults to 2. */
	maxRetries?: number;
	/** Content-free instrumentation. Never receives message text. */
	onEvent?: EventHook;
	/** Opt in to constructing with a key in a browser. Almost always wrong. */
	dangerouslyAllowBrowser?: boolean;

	// Test seams. Not part of the supported surface.
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

export interface ResolvedConfig {
	apiKey: string;
	baseUrl: string;
	source: string;
	userAgent: string;
	userId: string;
	conversationId: string | undefined;
	projectId: string | undefined;
	agentId: string | undefined;
	recallScope: RecallScope;
	recall: boolean;
	capture: CaptureMode;
	waitUntil: ((promise: Promise<unknown>) => void) | undefined;
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

export const SETUP_HINT =
	"Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY in your server environment.";

function clampNumber(value: number | undefined, fallback: number, low: number, high: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(value, low), high);
}

function readEnv(name: string): string | undefined {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	const value = env?.[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A browser has no server-side secret store, so a key here is a leaked key. */
function looksLikeBrowser(): boolean {
	return typeof (globalThis as { window?: unknown }).window !== "undefined"
		&& typeof (globalThis as { document?: unknown }).document !== "undefined";
}

export function resolveConfig(config: ItsukiConfig): ResolvedConfig {
	if (!config || typeof config !== "object") {
		throw new Error(`ai-sdk-itsuki needs a configuration object with a userId. ${SETUP_HINT}`);
	}

	if (looksLikeBrowser() && config.dangerouslyAllowBrowser !== true) {
		throw new Error(
			"ai-sdk-itsuki refuses to construct in a browser: the API key would ship to every visitor. "
			+ "Call it from a server route, or pass dangerouslyAllowBrowser: true if you have proxied the key.",
		);
	}

	const userId = typeof config.userId === "string" ? config.userId.trim() : "";
	if (!userId) {
		throw new Error(
			"ai-sdk-itsuki needs a userId — your application's stable id for this end user. "
			+ "Without one, every user's memory would land in the same space.",
		);
	}
	if (/[\u0000-\u001f\u007f]/.test(userId)) {
		throw new Error("userId must not contain control characters.");
	}

	const apiKey = (typeof config.apiKey === "string" && config.apiKey.trim())
		? config.apiKey.trim()
		: readEnv("ITSUKI_API_KEY");
	if (!apiKey) {
		throw new Error(`The Itsuki API key is not configured. ${SETUP_HINT}`);
	}
	if (!validApiKeyShape(apiKey)) {
		throw new Error(`The Itsuki API key is malformed — it looks like itsuki_live_… ${SETUP_HINT}`);
	}

	const baseUrl = validateBaseUrl(config.baseUrl ?? readEnv("ITSUKI_BASE_URL") ?? DEFAULT_BASE_URL);
	const projectId = config.projectId?.trim() || undefined;

	return {
		apiKey,
		baseUrl,
		source: SOURCE,
		userAgent: USER_AGENT,
		userId,
		conversationId: config.conversationId?.trim() || undefined,
		projectId,
		agentId: config.agentId?.trim() || undefined,
		recallScope: config.recallScope ?? (projectId ? "project_then_global" : "global"),
		recall: config.recall !== false,
		capture: config.capture ?? "background",
		waitUntil: config.waitUntil,
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

/**
 * Per-call overrides arriving through `providerOptions.itsuki`.
 *
 * This is the AI SDK's documented channel for handing middleware data that
 * the model call itself should not see. It comes from the calling server
 * code, never from the model, which is why it is allowed to move tenancy.
 */
export interface CallOverrides {
	userId?: string;
	conversationId?: string;
	projectId?: string;
	agentId?: string;
	recallScope?: RecallScope;
	query?: string;
	capture?: CaptureMode;
	recall?: boolean;
}

const RECALL_SCOPES = new Set<string>(["global", "project_only", "project_then_global"]);
const CAPTURE_MODES = new Set<string>(["background", "blocking", "off"]);

export function readCallOverrides(raw: unknown): CallOverrides {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const out: CallOverrides = {};
	const text = (key: string): string | undefined => {
		const value = source[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	const userId = text("userId");
	if (userId) out.userId = userId;
	const conversationId = text("conversationId");
	if (conversationId) out.conversationId = conversationId;
	const projectId = text("projectId");
	if (projectId) out.projectId = projectId;
	const agentId = text("agentId");
	if (agentId) out.agentId = agentId;
	const query = text("query");
	if (query) out.query = query;
	const recallScope = text("recallScope");
	if (recallScope && RECALL_SCOPES.has(recallScope)) out.recallScope = recallScope as RecallScope;
	const capture = text("capture");
	if (capture && CAPTURE_MODES.has(capture)) out.capture = capture as CaptureMode;
	if (typeof source["recall"] === "boolean") out.recall = source["recall"] as boolean;
	return out;
}

/** Apply per-call overrides on top of the resolved configuration. */
export function withOverrides(config: ResolvedConfig, overrides: CallOverrides): ResolvedConfig {
	if (Object.keys(overrides).length === 0) return config;
	const projectId = overrides.projectId ?? config.projectId;
	return {
		...config,
		userId: overrides.userId ?? config.userId,
		conversationId: overrides.conversationId ?? config.conversationId,
		projectId,
		agentId: overrides.agentId ?? config.agentId,
		recallScope: overrides.recallScope
			?? (overrides.projectId && !config.projectId ? "project_then_global" : config.recallScope),
		recall: overrides.recall ?? config.recall,
		capture: overrides.capture ?? config.capture,
	};
}
