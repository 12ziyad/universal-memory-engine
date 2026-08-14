/**
 * openclaw-itsuki — Itsuki memory as a native OpenClaw plugin.
 *
 * Recall runs in `agent_turn_prepare`, so relevant memory is already in the
 * prompt before the model reads it — the agent never has to choose to look.
 * Capture runs in `agent_end`, which OpenClaw documents as the post-turn
 * observation hook (30s budget, fire-and-forget on gateway paths).
 *
 * This plugin deliberately does NOT claim the exclusive memory slot. OpenClaw
 * treats memory plugins as an exclusive category, and claiming it disables
 * `memory-core` for every agent in the install — the documented failure that
 * makes a slot-claiming memory plugin unusable in multi-agent setups. Itsuki
 * runs ALONGSIDE built-in memory: MEMORY.md, daily notes and `memory_search`
 * keep working exactly as before.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig, stateRoot, type ItsukiConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { type CaptureScope, senderTenant } from "./identity.js";
import { echoSessionKey } from "./inject.js";
import { isSettledExchange, planCaptureSpan } from "./messages.js";
import { SessionStore } from "./sessionstate.js";
import { Spool } from "./spool.js";
import { ItsukiTransport, validApiKeyShape } from "./transport.js";

const SOURCE = "openclaw";
const PLUGIN_ID = "itsuki";

/** Runs OpenClaw starts on its own. A cron tick is not a conversation. */
const SYSTEM_TRIGGERS = new Set(["cron", "heartbeat", "exec-event", "exec_event", "system"]);

interface Runtime {
	config: ItsukiConfig;
	coordinator: Coordinator;
	spool: Spool;
	sessions: SessionStore;
	ready: boolean;
	problem: string | null;
}

interface AgentCtxLike {
	sessionKey?: string;
	sessionId?: string;
	channel?: string;
	senderId?: string;
	trigger?: string;
	jobId?: string;
	pluginConfig?: Record<string, unknown>;
}

function setupHint(): string {
	return "Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY in the Gateway environment (or plugins.entries.itsuki.config.apiKey) and restart the Gateway.";
}

function sessionKeyOf(ctx: AgentCtxLike): string {
	return ctx.sessionKey ?? ctx.sessionId ?? "unknown-session";
}

/**
 * Has the operator granted conversation access?
 *
 * OpenClaw gates conversation-reading hooks (`agent_end` and friends) for
 * non-bundled plugins behind `plugins.entries.<id>.hooks.allowConversationAccess`.
 * That key is a SIBLING of `entries.<id>.config`, so it is NOT inside
 * `api.pluginConfig` — it has to be read from the full `api.config`. (Audit
 * finding: the first implementation read `pluginConfig.hooks` and would have
 * warned falsely in every correctly-configured gateway.)
 *
 * The host enforces the gate itself — this check exists only so the plugin can
 * TELL the operator why nothing is happening, instead of sitting silently
 * inert. Read defensively: the shape is host-owned and may move, and a wrong
 * read here must degrade to a spurious warning, never a crash.
 */
export function conversationAccessGranted(hostConfig: unknown, pluginConfig?: unknown): boolean {
	const entry = (hostConfig as {
		plugins?: { entries?: Record<string, { hooks?: { allowConversationAccess?: unknown } }> };
	} | undefined)?.plugins?.entries?.[PLUGIN_ID];
	if (entry?.hooks && typeof entry.hooks === "object" && entry.hooks.allowConversationAccess === true) {
		return true;
	}
	// Forward-compat fallback: accept the flag inside pluginConfig too, in case
	// a future host surfaces it there.
	const hooks = (pluginConfig as { hooks?: unknown } | undefined)?.hooks;
	if (hooks && typeof hooks === "object") {
		return (hooks as { allowConversationAccess?: unknown }).allowConversationAccess === true;
	}
	return false;
}

/** A system-originated run has no user asking anything. */
function isUserTurn(ctx: AgentCtxLike): boolean {
	if (ctx.jobId) return false;
	const trigger = typeof ctx.trigger === "string" ? ctx.trigger.toLowerCase() : "";
	return !SYSTEM_TRIGGERS.has(trigger);
}

export function buildRuntime(
	pluginConfig: Record<string, unknown> | undefined,
	env: NodeJS.ProcessEnv = process.env,
	log: (line: string) => void = () => {},
): Runtime {
	const config = resolveConfig(pluginConfig, env);
	const root = stateRoot(env, homedir, join);
	const spool = new Spool(root);
	const sessions = new SessionStore(root);

	if (!config.apiKey) {
		return { config, spool, sessions, ready: false, problem: `the Itsuki API key is not configured. ${setupHint()}`, coordinator: null as unknown as Coordinator };
	}
	if (!validApiKeyShape(config.apiKey)) {
		return { config, spool, sessions, ready: false, problem: `the Itsuki API key has an invalid format. ${setupHint()}`, coordinator: null as unknown as Coordinator };
	}

	let transport: ItsukiTransport;
	try {
		transport = new ItsukiTransport({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			timeoutMs: config.capture.timeoutMs,
		});
	} catch (error) {
		return { config, spool, sessions, ready: false, problem: (error as Error).message, coordinator: null as unknown as Coordinator };
	}

	const coordinator = new Coordinator({
		transport,
		spool,
		recall: config.recall,
		capture: config.capture,
		log,
	});
	return { config, spool, sessions, coordinator, ready: true, problem: null };
}

/**
 * Resolve the memory scope for one run, or REFUSE with null.
 *
 * Tenancy can only ever NARROW: the credential decides the project, and this
 * picks an optional sub-tenant inside it. In `per-sender` mode the sub-tenant
 * is a one-way hash of channel + sender, so two channels cannot collide and a
 * platform user id never becomes a durable key inside Itsuki.
 *
 * In `per-sender` mode a turn WITHOUT derivable sender identity gets NO scope
 * at all — memory is skipped for that turn. The first implementation fell back
 * to owner scope, which the audit rejected: on a channel that does not supply
 * sender ids, every stranger would have silently shared (and recalled!) the
 * owner's memory space. Skipping is the only answer that cannot mix tenants.
 */
export function resolveScope(config: ItsukiConfig, ctx: AgentCtxLike): CaptureScope | null {
	const conversationId = ctx.sessionKey ?? ctx.sessionId;
	if (config.tenancy !== "per-sender") {
		return { userId: config.userId, conversationId, source: SOURCE };
	}
	const tenant = senderTenant(ctx.channel, ctx.senderId);
	if (!tenant) return null;
	return { userId: tenant, conversationId, source: SOURCE };
}

/** The subset of OpenClaw's plugin API this adapter uses. */
export interface ItsukiPluginApi {
	pluginConfig?: Record<string, unknown>;
	/** The full resolved OpenClaw config (host-owned shape). */
	config?: unknown;
	logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
	on: (hook: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown, opts?: { priority?: number; timeoutMs?: number }) => void;
	registerTool?: (tool: unknown) => void;
}

export function register(api: ItsukiPluginApi): void {
	const log = (line: string) => api.logger?.info?.(line);
	let runtime: Runtime | null = null;

	function ensure(ctx: AgentCtxLike | undefined): Runtime {
		// Built once per plugin lifetime, from the first hook's resolved config
		// (falling back to the registration-time api.pluginConfig). A config
		// change lands when the host reloads the plugin (gateway restart) —
		// this function deliberately does NOT hot-swap credentials mid-flight.
		const configured = ctx?.pluginConfig ?? api.pluginConfig;
		if (!runtime) runtime = buildRuntime(configured, process.env, log);
		return runtime;
	}

	// ------------------------------------------------------------ gateway

	api.on("gateway_start", async (_event, rawCtx) => {
		const active = ensure(rawCtx as AgentCtxLike);
		// No blocking network dependency at startup: validate and restore only.
		await active.spool.init().catch(() => {});
		await active.sessions.init().catch(() => {});
		await active.sessions.prune().catch(() => {});
		if (!active.ready) {
			api.logger?.warn?.(`itsuki inactive — ${active.problem}`);
			return;
		}
		// OpenClaw blocks conversation-reading hooks for non-bundled plugins
		// until the operator opts in. Without it this plugin loads and captures
		// NOTHING, so say so loudly rather than looking healthy while inert.
		if (!conversationAccessGranted(api.config, api.pluginConfig)) {
			api.logger?.warn?.(
				"itsuki: capture and recall are blocked — set plugins.entries.itsuki.hooks.allowConversationAccess=true to let this plugin read conversations, then restart the Gateway.",
			);
		}
		const stats = await active.spool.stats().catch(() => ({ depth: 0, dropped: 0 }));
		log(`itsuki ready spool=${stats.depth} dropped=${stats.dropped}`);
	});

	api.on("gateway_stop", async () => {
		const active = runtime;
		runtime = null;
		if (!active?.ready) return;
		// Bounded: one drain pass, then let the finalizer proceed.
		await active.coordinator.drain().catch(() => {});
	});

	// ------------------------------------------------------------- recall

	api.on("agent_turn_prepare", async (rawEvent, rawCtx) => {
		const ctx = (rawCtx ?? {}) as AgentCtxLike;
		const active = ensure(ctx);
		if (!active.ready) return;
		if (!isUserTurn(ctx)) return;

		const event = (rawEvent ?? {}) as { prompt?: unknown };
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return;

		const scope = resolveScope(active.config, ctx);
		// Per-sender mode with no derivable sender: no scope, no memory. Never
		// fall back to the owner's space for an unidentified stranger.
		if (!scope) return;
		const sessionKey = sessionKeyOf(ctx);
		const echoKey = echoSessionKey(sessionKey);
		const outcome = await active.coordinator.recall(prompt, scope, { echoKey });
		if (!outcome.block) return;

		// Persist the fingerprints with the session so an echo is still
		// suppressed after a Gateway restart.
		if (outcome.fingerprints.length > 0) {
			const state = await active.sessions.read(sessionKey);
			await active.sessions
				.write(sessionKey, {
					...state,
					fingerprints: [...new Set([...state.fingerprints, ...outcome.fingerprints])],
				})
				.catch(() => {});
		}
		return { prependContext: outcome.block };
	}, { priority: 50, timeoutMs: 8_000 });

	// ------------------------------------------------------------ capture

	async function captureSettled(active: Runtime, ctx: AgentCtxLike, event: { messages?: unknown; success?: unknown; error?: unknown }): Promise<void> {
		if (!active.ready || !active.config.capture.enabled) return;
		// A cron tick or heartbeat is not a conversation. Capturing automation
		// output would pollute memory with machine noise — and in per-sender
		// mode a system run has no sender, so there is nobody to attribute it
		// to. (Audit finding: the first implementation captured these.)
		if (!isUserTurn(ctx)) return;
		const scope = resolveScope(active.config, ctx);
		if (!scope) return;
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		if (messages.length === 0) return;

		const sessionKey = sessionKeyOf(ctx);
		const state = await active.sessions.read(sessionKey);
		const echoKey = echoSessionKey(sessionKey);
		const transform = active.coordinator.makeTransform(new Set(state.fingerprints), echoKey);
		const span = planCaptureSpan(messages, { count: state.watermarkCount, digest: state.watermarkDigest }, transform);

		if (!isSettledExchange(event, span)) {
			// Not a settled exchange: advance nothing, capture nothing. A failed
			// or aborted run must be re-capturable once it genuinely completes.
			return;
		}

		const staged = await active.coordinator.stage(span.messages, scope);
		// The watermark advances the moment the span is durably owned — before
		// any network call — so a crash mid-delivery cannot re-capture it inside
		// a larger span under a different key.
		await active.sessions.write(sessionKey, {
			...state,
			watermarkCount: span.watermarkCount,
			watermarkDigest: span.watermarkDigest,
		});
		if (staged.status !== "staged") return;
		await active.coordinator.drain();
	}

	api.on("agent_end", async (rawEvent, rawCtx) => {
		const ctx = (rawCtx ?? {}) as AgentCtxLike;
		const active = ensure(ctx);
		await captureSettled(active, ctx, (rawEvent ?? {}) as { messages?: unknown; success?: unknown; error?: unknown });
	}, { timeoutMs: 20_000 });

	// Compaction rewrites what the model can see. Take ownership of the
	// outstanding span first so a long session cannot lose its unsaved tail.
	api.on("before_compaction", async (rawEvent, rawCtx) => {
		const ctx = (rawCtx ?? {}) as AgentCtxLike;
		const active = ensure(ctx);
		const event = (rawEvent ?? {}) as { messages?: unknown };
		if (!Array.isArray(event.messages)) return;
		await captureSettled(active, ctx, { messages: event.messages, success: true });
	});

	// `session_end` fires for compaction too. Only a true termination is final;
	// treating compaction as the end would double-capture the same tail.
	api.on("session_end", async (rawEvent, rawCtx) => {
		const ctx = (rawCtx ?? {}) as AgentCtxLike;
		const event = (rawEvent ?? {}) as { reason?: unknown };
		if (event.reason === "compaction") return;
		const active = ensure(ctx);
		if (!active.ready) return;
		await active.coordinator.drain().catch(() => {});
	});

	// Subagents: attribution only. A child run must never widen authority, and
	// its own turns already flow through agent_turn_prepare/agent_end.
	api.on("subagent_spawned", async (_event, rawCtx) => {
		const ctx = (rawCtx ?? {}) as AgentCtxLike;
		log(`itsuki subagent start session=${echoSessionKey(sessionKeyOf(ctx)) ?? "unknown"}`);
	});

	// -------------------------------------------------------------- tools

	api.registerTool?.({
		name: "itsuki_recall",
		description: "Search long-term Itsuki memory for facts, decisions, and preferences from earlier sessions.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: { query: { type: "string", description: "What to look for, in natural language." } },
		},
		async execute(_id: string, params: { query?: string }, toolCtx?: AgentCtxLike) {
			const ctx = (toolCtx ?? {}) as AgentCtxLike;
			const active = ensure(ctx);
			if (!active.ready) {
				return { content: [{ type: "text", text: `Itsuki is not connected: ${active.problem}` }] };
			}
			const scope = resolveScope(active.config, ctx);
			if (!scope) {
				return { content: [{ type: "text", text: "Memory is per-sender here and this run has no sender identity, so recall is unavailable." }] };
			}
			const sessionKey = sessionKeyOf(ctx);
			const outcome = await active.coordinator.recall(String(params?.query ?? ""), scope, {
				echoKey: echoSessionKey(sessionKey),
			});
			if (!outcome.block) {
				return {
					content: [{
						type: "text",
						text: outcome.status === "failed"
							? `Itsuki recall failed (${outcome.code ?? "unknown"}). Memory is unavailable right now; continue without it.`
							: "No stored memory matched that.",
					}],
				};
			}
			return { content: [{ type: "text", text: outcome.block }] };
		},
	});

	api.registerTool?.({
		name: "itsuki_save",
		description: "Store one durable fact in Itsuki memory so later sessions can recall it.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["content"],
			properties: { content: { type: "string", description: "The fact to remember, in plain language." } },
		},
		async execute(_id: string, params: { content?: string }, toolCtx?: AgentCtxLike) {
			const ctx = (toolCtx ?? {}) as AgentCtxLike;
			const active = ensure(ctx);
			if (!active.ready) {
				return { content: [{ type: "text", text: `Itsuki is not connected: ${active.problem}` }] };
			}
			const text = String(params?.content ?? "").trim();
			if (!text) return { content: [{ type: "text", text: "Nothing to save: content was empty." }] };

			const scope = resolveScope(active.config, ctx);
			if (!scope) {
				return { content: [{ type: "text", text: "Memory is per-sender here and this run has no sender identity, so nothing was saved." }] };
			}
			const staged = await active.coordinator.stage([{ role: "user", content: text }], scope);
			if (staged.status !== "staged") {
				return { content: [{ type: "text", text: `Itsuki did not accept that (${staged.status}).` }] };
			}
			const drained = await active.coordinator.drain();
			const health = await active.coordinator.health();
			// Never claim a save without a receipt.
			return {
				content: [{
					type: "text",
					text: drained.delivered > 0
						? `Saved. Receipt ${health.lastReceiptId ?? "(pending)"}.`
						: "Queued locally; Itsuki has not acknowledged it yet. It will be delivered automatically.",
				}],
			};
		},
	});
}

/**
 * The canonical entry shape from the OpenClaw plugin SDK.
 *
 * `definePluginEntry` is the documented form for non-channel plugins. The
 * import is resolved from the host at load time (openclaw is a peer
 * dependency), which is exactly how OpenClaw loads bundled and installed
 * plugins alike.
 */
export default definePluginEntry({
	id: PLUGIN_ID,
	name: "Itsuki Memory",
	description: "Bounded recall before each agent turn, exactly-once capture after it settles. Runs alongside OpenClaw's built-in memory.",
	register(api: unknown) {
		register(api as ItsukiPluginApi);
	},
});
