/**
 * The hook runner: one process invocation per hook event.
 *
 * Contract (antigravity.google/docs/hooks, verified 2026-08-16): stdin is JSON,
 * stdout is JSON, field names are camelCase, and the handler has a `timeout` in
 * seconds (default 30 — we set 10 explicitly).
 *
 * Budget shape, because the host will kill us at the deadline:
 *
 *   parse + read transcript + stage locally   (<= ~2s, no network)
 *   -> WRITE THE RESPONSE and flush stdout
 *   -> one bounded drain attempt (3s), best effort
 *
 * Anything the kill interrupts is already durable in the spool and is drained
 * by a later invocation or by `antigravity-itsuki doctor`.
 *
 * `Stop` must ALWAYS answer `{"decision":"stop"}`. Returning "continue" would
 * re-enter the host's execution loop — a memory plugin must never do that.
 */

import { appDataDirs, resolveConfig, stateRoot } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { captureScope } from "./identity.js";
import { ItsukiTransport } from "./kernel/transport.js";
import { SessionStore, withinOwnedSpan } from "./sessionstate.js";
import { Spool } from "./spool.js";
import { readTranscript, type TranscriptTurn } from "./transcript.js";

export type HookEvent = "PreInvocation" | "PostInvocation" | "Stop" | "PreToolUse" | "PostToolUse";

export interface HookPayload {
	conversationId?: string;
	workspacePaths?: string[];
	transcriptPath?: string;
	artifactDirectoryPath?: string;
	modelName?: string;
	// Stop
	executionNum?: number;
	terminationReason?: string;
	error?: string;
	fullyIdle?: boolean;
	// Pre/PostInvocation
	invocationNum?: number;
	initialNumSteps?: number;
}

/**
 * Termination reasons that represent a settled, successful human turn.
 *
 * DELIBERATELY EMPTY until probe P8 records the real values from a live host.
 * Google's docs give the field an "e.g." list, not an exhaustive one, so
 * hardcoding a guess would mean capturing turns we do not understand. With no
 * verified value, nothing is ever captured — see PROBES.md.
 */
/**
 * Observed on a real host (Antigravity CLI 1.1.13, Windows, 2026-08-16) for a
 * successful turn: `terminationReason: "NO_TOOL_CALL"`, `fullyIdle: true`, and
 * `error` present but an EMPTY STRING.
 *
 * Note what this is not: the docs' own example value is `model_stop`, which
 * never appeared. Hardcoding the documented example would have meant capture
 * silently never firing — which is exactly why this list stayed empty until a
 * real host filled it.
 */
export const VERIFIED_SUCCESS_TERMINATIONS: string[] = ["NO_TOOL_CALL"];

export interface HookResult {
	response: Record<string, unknown>;
	/** Why we did or did not act — for the doctor, never for stdout. */
	note: string;
}

function buildRuntime(env: NodeJS.ProcessEnv) {
	const config = resolveConfig(env);
	const root = stateRoot(env);
	const spool = new Spool(root);
	const sessions = new SessionStore(root);
	let coordinator: Coordinator | null = null;
	if (config.apiKey) {
		try {
			coordinator = new Coordinator({
				transport: new ItsukiTransport({
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					userAgent: "antigravity-itsuki",
					timeoutMs: config.capture.timeoutMs,
				}),
				spool,
				recall: config.recall,
				capture: { ...config.capture, drainTimeoutMs: config.capture.inHookDrainMs },
			});
		} catch {
			coordinator = null;
		}
	}
	return { config, coordinator, spool, sessions, root };
}

/** PreInvocation: bounded recall, injected as an ephemeral step. */
export async function handlePreInvocation(
	payload: HookPayload,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookResult> {
	const runtime = buildRuntime(env);
	if (!runtime.coordinator || !runtime.config.recall.enabled) {
		return { response: {}, note: "recall disabled or unconfigured" };
	}
	const conversationId = String(payload.conversationId ?? "");
	if (!conversationId) return { response: {}, note: "no conversationId" };

	const transcript = await readTranscript(String(payload.transcriptPath ?? ""), appDataDirs(env));
	if (transcript.status !== "ok") {
		// Unknown / refused / unreadable transcript => no automatic behaviour.
		return { response: {}, note: `transcript ${transcript.status}` };
	}
	const lastUser = [...transcript.turns].reverse().find((t) => t.role === "user");
	if (!lastUser?.text) return { response: {}, note: "no user turn" };

	// Once per turn: a PreInvocation fires per MODEL CALL, many times per turn.
	const state = runtime.sessions.load(conversationId);
	const turnKey = lastUser.id ?? String(lastUser.createdAt ?? "");
	if (state.lastRecallTurnKey === turnKey) {
		return { response: {}, note: "already recalled for this turn" };
	}

	const outcome = await runtime.coordinator.recall(
		lastUser.text,
		captureScope({ userId: runtime.config.userId, projectId: runtime.config.projectId, sessionID: conversationId }),
	);
	state.lastRecallTurnKey = turnKey;
	runtime.sessions.save(state);

	if (!outcome.block) return { response: {}, note: `recall ${outcome.status}` };
	return {
		response: { injectSteps: [{ ephemeralMessage: outcome.block }] },
		note: `recalled ${outcome.count}`,
	};
}

/** Stop: capture, but only for a settled, successful, verified turn. */
export async function handleStop(
	payload: HookPayload,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookResult> {
	// The response never varies: we must not block the host's loop.
	const response = { decision: "stop" };
	const runtime = buildRuntime(env);
	if (!runtime.coordinator || !runtime.config.capture.enabled) {
		return { response, note: "capture disabled or unconfigured" };
	}
	if (payload.fullyIdle !== true) return { response, note: "not fullyIdle" };
	if (payload.error) return { response, note: "turn carried an error" };

	const reason = String(payload.terminationReason ?? "");
	if (!VERIFIED_SUCCESS_TERMINATIONS.includes(reason)) {
		// The docs' list is explicitly non-exhaustive. Until P8 records the
		// real success values, an unrecognised reason is never captured.
		return { response, note: `termination "${reason}" is not a verified success reason (capture HELD)` };
	}

	const conversationId = String(payload.conversationId ?? "");
	if (!conversationId) return { response, note: "no conversationId" };

	const transcript = await readTranscript(String(payload.transcriptPath ?? ""), appDataDirs(env));
	if (transcript.status !== "ok") return { response, note: `transcript ${transcript.status}` };

	const state = runtime.sessions.load(conversationId);
	if (!state.seedMessageID) {
		// First sight: seed immediately before the current human turn so this
		// exchange stays capturable and prior history does not.
		const lastUser = [...transcript.turns].reverse().find((t) => t.role === "user");
		if (!lastUser?.id) return { response, note: "no anchorable user turn" };
		runtime.sessions.seed(conversationId, lastUser.id, lastUser.createdAt);
	}

	const fresh = runtime.sessions.load(conversationId);
	const owned = (turn: TranscriptTurn): boolean =>
		withinOwnedSpan(fresh, {
			id: turn.id ?? "",
			role: turn.role,
			createdAt: turn.createdAt,
			completedAt: null,
		});

	const messages = transcript.turns
		.filter(owned)
		.map((t) => ({ role: t.role, content: t.text }))
		.filter((m) => m.content.trim().length > 0);
	if (!messages.some((m) => m.role === "user") || !messages.some((m) => m.role === "assistant")) {
		return { response, note: "span is not a complete exchange" };
	}

	const scope = captureScope({
		userId: runtime.config.userId,
		projectId: runtime.config.projectId,
		sessionID: conversationId,
	});
	const staged = runtime.coordinator.stage(messages, scope, (key) => runtime.sessions.hasKey(conversationId, key));
	if (staged.status !== "staged") return { response, note: `stage ${staged.status}` };
	for (const key of staged.keys) {
		runtime.sessions.noteCaptured(conversationId, key, null, Date.now());
	}
	return { response, note: `staged ${staged.batches}` };
}

/** Deliver whatever is spooled, within a hard budget. */
export async function drainAfterResponse(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const runtime = buildRuntime(env);
	if (!runtime.coordinator) return;
	try {
		await runtime.coordinator.drain(runtime.config.capture.inHookDrainMs);
	} catch {
		/* the spool survives for the next invocation */
	}
}

export async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buf.length;
		// A hook payload is small. Anything enormous is not one.
		if (total > 4 * 1024 * 1024) break;
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function parsePayload(raw: string): HookPayload {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookPayload) : {};
	} catch {
		return {};
	}
}

/** Entry point used by the shipped hook command. Never throws, always answers. */
export async function runHook(
	event: string,
	raw: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; note: string }> {
	const payload = parsePayload(raw);
	try {
		if (event === "PreInvocation") {
			const result = await handlePreInvocation(payload, env);
			return { stdout: JSON.stringify(result.response), note: result.note };
		}
		if (event === "Stop") {
			const result = await handleStop(payload, env);
			return { stdout: JSON.stringify(result.response), note: result.note };
		}
	} catch (error) {
		// A hook that fails must still answer, and must never block the agent.
		if (event === "Stop") return { stdout: JSON.stringify({ decision: "stop" }), note: `error: ${String(error)}` };
		return { stdout: "{}", note: `error: ${String(error)}` };
	}
	return { stdout: event === "Stop" ? JSON.stringify({ decision: "stop" }) : "{}", note: "unhandled event" };
}
