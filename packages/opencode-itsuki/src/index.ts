/**
 * opencode-itsuki — Itsuki memory as a native OpenCode plugin.
 *
 * Two hooks carry the lifecycle, and the split between them is deliberate:
 *
 *   `chat.message` fires exactly once per genuinely new human turn, before the
 *   model runs, and carries the message id and creation time. That makes it
 *   the right place to decide "is this a real turn?", to seed the first-sight
 *   watermark, and to run recall.
 *
 *   `experimental.chat.messages.transform` fires per provider call with the
 *   message array actually being sent. That makes it the right place to
 *   INJECT, because what it edits is not persisted. Phase 0 proved that
 *   pushing the recall part onto `chat.message`'s `output.parts` does reach
 *   the model — but it also proved the part then travels into the host's
 *   title-generation call (#42386 is unfixed in 1.18.18). Injecting
 *   transiently keeps the model informed without writing our block into the
 *   user's transcript or their session titles.
 *
 *   `event` observes `session.status{idle}` for capture. The host does not
 *   await this hook and `dispose` follows idle by ~20ms, so capture stages to
 *   disk atomically first and delivers afterwards.
 *
 * Everything is exception-proof: `event` is dispatched fire-and-forget, so an
 * escaping rejection becomes a process-level unhandled rejection rather than a
 * handled error, and a throw from any hook is an unrecoverable Effect defect
 * in the host's fiber.
 */

import { CONFIG_ENV, type ItsukiConfig, resolveConfig, stateRoot } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { captureScope, SOURCE } from "./identity.js";
import { RECALL_OPEN_MARKER } from "./kernel/inject.js";
import { ItsukiTransport } from "./kernel/transport.js";
import type { CaptureScope } from "./kernel/types.js";
import {
	type HostMessage,
	type HostPart,
	isInternalAgent,
	isSyntheticUserTurn,
	planCaptureSpan,
	settleVerdict,
	userText,
} from "./messages.js";
import { SessionStore, withinOwnedSpan } from "./sessionstate.js";
import { Spool } from "./spool.js";
import { protectStateTree } from "./statetree.js";
import { buildTools } from "./tools.js";

/** A recall result waiting for the provider call that belongs to it. */
interface PendingInjection {
	sessionID: string;
	messageID: string;
	block: string;
	fingerprints: Set<string>;
	createdAt: number;
}

/** Pending injections expire: a turn that never reached the model is stale. */
const PENDING_TTL_MS = 60_000;
const PENDING_MAX = 32;

interface Runtime {
	config: ItsukiConfig;
	coordinator: Coordinator | null;
	spool: Spool;
	sessions: SessionStore;
	root: string;
	ready: boolean;
	/** Sessions known to be subagents; cached so we ask the host once. */
	subagents: Map<string, boolean>;
	pending: Map<string, PendingInjection>;
	/** Idle generations already handled, so a repeated idle is not a second capture. */
	handledIdle: Set<string>;
}

function makeRuntime(options: Record<string, unknown> | undefined): Runtime {
	const config = resolveConfig({ options });
	const root = stateRoot();
	const spool = new Spool(root);
	const sessions = new SessionStore(root);
	let coordinator: Coordinator | null = null;
	if (config.apiKey) {
		try {
			const transport = new ItsukiTransport({
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				userAgent: "opencode-itsuki",
				// Explicit, per-package: the vendored kernel default (10s) sits
				// too close to the service's own 9s save budget, and this
				// campaign does not modify the kernel.
				timeoutMs: config.capture.timeoutMs,
			});
			coordinator = new Coordinator({
				transport,
				spool,
				recall: config.recall,
				capture: config.capture,
			});
		} catch (error) {
			config.problems.push(error instanceof Error ? error.message : "The Itsuki API key is unusable.");
		}
	}
	return {
		config,
		coordinator,
		spool,
		sessions,
		root,
		ready: Boolean(coordinator),
		subagents: new Map(),
		pending: new Map(),
		handledIdle: new Set(),
	};
}

function pendingKey(sessionID: string, messageID: string): string {
	return `${sessionID}::${messageID}`;
}

function prunePending(runtime: Runtime, now: number): void {
	for (const [key, value] of runtime.pending) {
		if (now - value.createdAt > PENDING_TTL_MS) runtime.pending.delete(key);
	}
	while (runtime.pending.size > PENDING_MAX) {
		const oldest = runtime.pending.keys().next().value;
		if (typeof oldest !== "string") break;
		runtime.pending.delete(oldest);
	}
}

/** Ask the host once whether a session is a subagent child. */
async function isSubagent(runtime: Runtime, client: any, sessionID: string): Promise<boolean> {
	const cached = runtime.subagents.get(sessionID);
	if (cached !== undefined) return cached;
	let verdict = false;
	try {
		const response = await client?.session?.get?.({ path: { id: sessionID } });
		const info = response?.data ?? response;
		verdict = Boolean(info?.parentID);
	} catch {
		// Unknown parentage is treated as "not a subagent" for RECALL (the
		// cost is a harmless extra lookup) but capture re-checks independently.
		verdict = false;
	}
	runtime.subagents.set(sessionID, verdict);
	return verdict;
}

async function readMessages(client: any, sessionID: string): Promise<HostMessage[]> {
	const response = await client?.session?.messages?.({ path: { id: sessionID } });
	const data = response?.data ?? response;
	return Array.isArray(data) ? (data as HostMessage[]) : [];
}

/** Never let instrumentation or a broken host shape reach the session. */
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		/* deliberately swallowed */
	}
}

export const ItsukiPlugin = async (input: any, options?: Record<string, unknown>) => {
	const runtime = makeRuntime(options);
	safely(() => protectStateTree(runtime.root));

	const client = input?.client;
	const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
		try {
			void client?.app?.log?.({ body: { service: "itsuki", level, message, ...(extra ? { extra } : {}) } });
		} catch {
			/* logging is never load-bearing */
		}
	};

	if (runtime.config.problems.length > 0) {
		for (const problem of runtime.config.problems) log("warn", problem);
	}

	const scopeFor = (sessionID: string): CaptureScope =>
		captureScope({
			userId: runtime.config.userId,
			projectId: runtime.config.projectId,
			sessionID,
		});

	// ------------------------------------------------------------ capture

	const captureSettled = async (sessionID: string): Promise<void> => {
		const coordinator = runtime.coordinator;
		if (!coordinator || !runtime.config.capture.enabled) return;
		if (await isSubagent(runtime, client, sessionID)) return;

		const messages = await readMessages(client, sessionID);
		if (messages.length === 0) return;

		// idle is not success: re-read and judge the transcript itself.
		const verdict = settleVerdict(messages);
		if (!verdict.ok) return;

		const state = runtime.sessions.load(sessionID);
		if (!state.seedMessageID) return; // never saw the human turn: not ours

		const span = planCaptureSpan(messages, (info) =>
			withinOwnedSpan(state, {
				id: String(info.id ?? ""),
				role: String(info.role ?? ""),
				createdAt: typeof info.time?.created === "number" ? info.time.created : null,
				completedAt: typeof info.time?.completed === "number" ? info.time.completed : null,
			}),
		);
		if (span.messages.length === 0) return;
		if (span.assistantMessageID && span.assistantMessageID === state.lastCapturedMessageID) return;

		const scope = scopeFor(sessionID);
		const outcome = coordinator.stage(span.messages, scope, (key) => runtime.sessions.hasKey(sessionID, key));
		if (outcome.status !== "staged") return;

		for (const key of outcome.keys) {
			runtime.sessions.noteCaptured(sessionID, key, span.assistantMessageID, Date.now());
		}
		log("info", "itsuki staged a settled turn", { batches: outcome.batches });

		// Delivery is separate and resumable — the bytes are already durable.
		void coordinator.drain().catch(() => undefined);
	};

	// -------------------------------------------------------------- hooks

	const hooks: Record<string, unknown> = {
		"chat.message": async (hookInput: any, output: any) => {
			try {
				const coordinator = runtime.coordinator;
				const sessionID = String(hookInput?.sessionID ?? output?.message?.sessionID ?? "");
				if (!sessionID) return;

				// The host's own internal agents are not conversations.
				if (isInternalAgent(hookInput?.agent)) return;
				// The compaction auto-continue turn is synthesised, not typed.
				if (isSyntheticUserTurn(output?.parts as HostPart[] | undefined)) return;

				const messageID = String(hookInput?.messageID ?? output?.message?.id ?? "");
				if (!messageID) return;

				// Seed the watermark IMMEDIATELY BEFORE this human message, so
				// this exchange stays capturable and everything older does not.
				const created = Number(output?.message?.time?.created);
				runtime.sessions.seed(sessionID, messageID, Number.isFinite(created) ? created : null);

				if (!coordinator || !runtime.config.recall.enabled) return;
				if (await isSubagent(runtime, client, sessionID)) return;

				const query = userText({ info: output?.message, parts: output?.parts });
				if (!query) return;
				// Our own block already present: never recall on an echo.
				if (query.includes(RECALL_OPEN_MARKER)) return;

				const outcome = await coordinator.recall(query, scopeFor(sessionID));
				if (!outcome.block) return;

				prunePending(runtime, Date.now());
				runtime.pending.set(pendingKey(sessionID, messageID), {
					sessionID,
					messageID,
					block: outcome.block,
					fingerprints: outcome.fingerprints,
					createdAt: Date.now(),
				});
			} catch {
				// A recall problem must never become the user's problem.
			}
		},

		/**
		 * Transient injection. What we push here is sent to the model and then
		 * discarded with the request — it never lands in the transcript, so it
		 * cannot reach title generation or any later summarisation.
		 */
		"experimental.chat.messages.transform": async (_hookInput: any, output: any) => {
			try {
				const messages = output?.messages;
				if (!Array.isArray(messages) || messages.length === 0) return;
				if (runtime.pending.size === 0) return;

				// The turn this call belongs to is the newest user message.
				let target: any;
				for (let i = messages.length - 1; i >= 0; i -= 1) {
					if (messages[i]?.info?.role === "user") {
						target = messages[i];
						break;
					}
				}
				const info = target?.info;
				if (!info?.id || !info?.sessionID) return;

				const key = pendingKey(String(info.sessionID), String(info.id));
				const pending = runtime.pending.get(key);
				if (!pending) return;

				if (!Array.isArray(target.parts)) return;
				// Idempotent within a retry loop: never inject twice.
				const already = target.parts.some(
					(p: HostPart) => typeof p?.text === "string" && p.text.includes(RECALL_OPEN_MARKER),
				);
				if (already) return;

				// A fully-formed TextPart: the host's Part type requires id,
				// sessionID and messageID (TextPartInput's optional id is the
				// server-assigned door, not this one).
				target.parts.push({
					id: `prt_itsuki${Math.random().toString(36).slice(2, 14)}`,
					sessionID: String(info.sessionID),
					messageID: String(info.id),
					type: "text",
					text: pending.block,
					synthetic: true,
				});
			} catch {
				/* injection is best-effort by design */
			}
		},

		// NOTE: the parameter is taken raw and destructured INSIDE the try.
		// Destructuring in the parameter position throws before any handler
		// can catch it, and the host dispatches this hook fire-and-forget
		// (`void hook.event?.(...)`), so such a throw becomes a process-level
		// unhandled rejection rather than a caught error.
		event: async (payload: any) => {
			try {
				const event = payload?.event;
				const type = event?.type;
				const properties = event?.properties ?? {};
				if (type === "session.status") {
					const status = properties?.status?.type;
					if (status !== "idle") return;
					const sessionID = String(properties?.sessionID ?? "");
					if (!sessionID) return;
					// Phase 0: the error path emits idle TWICE. One capture per idle.
					const generation = `${sessionID}:${runtime.sessions.load(sessionID).lastCapturedMessageID ?? "none"}`;
					if (runtime.handledIdle.has(generation)) return;
					runtime.handledIdle.add(generation);
					if (runtime.handledIdle.size > 256) {
						const first = runtime.handledIdle.values().next().value;
						if (typeof first === "string") runtime.handledIdle.delete(first);
					}
					await captureSettled(sessionID);
					return;
				}
				if (type === "session.deleted") {
					const sessionID = String(properties?.sessionID ?? "");
					if (sessionID) runtime.sessions.forget(sessionID);
				}
			} catch {
				// `event` is dispatched fire-and-forget by the host: an escaping
				// rejection would surface as a process-level unhandled rejection.
			}
		},

		"experimental.session.compacting": async (hookInput: any) => {
			try {
				const sessionID = String(hookInput?.sessionID ?? "");
				if (sessionID) await captureSettled(sessionID);
			} catch {
				/* compaction must proceed regardless */
			}
		},

		dispose: async () => {
			try {
				// ~20ms after idle the process exits. This is a best-effort
				// flush, never the durability mechanism — that already happened.
				await runtime.coordinator?.drain(runtime.config.capture.drainTimeoutMs);
			} catch {
				/* the spool survives; the next run drains it */
			}
		},
	};

	if (runtime.config.tools.enabled) {
		hooks["tool"] = buildTools({
			runtime: {
				config: runtime.config,
				coordinator: runtime.coordinator,
				spool: runtime.spool,
				envNames: CONFIG_ENV,
				source: SOURCE,
			},
			scopeFor,
		});
	}

	return hooks;
};

export default { id: "itsuki", server: ItsukiPlugin };
