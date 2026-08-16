/**
 * What counts as a settled, capturable turn on OpenCode.
 *
 * Every rule here was measured in Phase 0 (run 31911313462), not inferred:
 *
 *  - A SUCCESSFUL assistant message walks
 *      finish=undefined,completed=N -> finish="stop",completed=N -> finish="stop",completed=Y
 *    and only then does `session.status{idle}` / `session.idle` fire.
 *
 *  - A FAILED turn also ends with `time.completed` SET. Its distinguishing
 *    marks are `finish` never reaching "stop" and an `error` on the message.
 *    So `completed` alone is NOT a success signal — using it would have
 *    captured failures as successes. `finish === "stop"` is the gate.
 *
 *  - The final `message.updated` for a failed turn arrives AFTER
 *    `session.idle`, so capture must re-read the transcript rather than
 *    trust whatever the event carried.
 *
 * Anything not positively recognised as success is skipped. The allowlist is
 * deliberately one value wide.
 */

import { stripRecallBlocks } from "./kernel/inject.js";
import type { CaptureMessage } from "./kernel/types.js";

/** The only finish value Phase 0 observed on a completed, error-free turn. */
export const SUCCESS_FINISHES = Object.freeze(["stop"] as const);

export interface HostPart {
	id?: string;
	type?: string;
	text?: string;
	synthetic?: boolean;
	ignored?: boolean;
	state?: { status?: string } | undefined;
	[key: string]: unknown;
}

export interface HostMessageInfo {
	id?: string;
	role?: string;
	sessionID?: string;
	finish?: string | undefined;
	error?: unknown;
	time?: { created?: number; completed?: number } | undefined;
	[key: string]: unknown;
}

export interface HostMessage {
	info?: HostMessageInfo;
	parts?: HostPart[];
}

export type SettleVerdict =
	| { ok: true; assistant: HostMessageInfo }
	| { ok: false; reason: "no_assistant" | "not_finished" | "bad_finish" | "errored" | "tool_incomplete" | "empty" };

function isToolPart(part: HostPart): boolean {
	return part?.type === "tool";
}

/** A tool call still running (or failed) means the turn is not settled. */
function toolUnsettled(part: HostPart): boolean {
	const status = part?.state?.status;
	if (typeof status !== "string") return false;
	return status !== "completed";
}

/**
 * Decide whether the final assistant message of a session represents a
 * settled, successful, attributable turn.
 */
export function settleVerdict(messages: HostMessage[]): SettleVerdict {
	let lastAssistant: HostMessage | undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m?.info?.role === "assistant") {
			lastAssistant = m;
			break;
		}
	}
	if (!lastAssistant?.info) return { ok: false, reason: "no_assistant" };
	const info = lastAssistant.info;

	if (info.error !== undefined && info.error !== null) return { ok: false, reason: "errored" };
	if (typeof info.time?.completed !== "number") return { ok: false, reason: "not_finished" };
	if (typeof info.finish !== "string" || !(SUCCESS_FINISHES as readonly string[]).includes(info.finish)) {
		return { ok: false, reason: "bad_finish" };
	}
	for (const part of lastAssistant.parts ?? []) {
		if (isToolPart(part) && toolUnsettled(part)) return { ok: false, reason: "tool_incomplete" };
	}
	if (!assistantText(lastAssistant)) return { ok: false, reason: "empty" };
	return { ok: true, assistant: info };
}

/**
 * The model-visible text a user actually wrote.
 *
 * Our own injected recall is `synthetic: true`, and any recall block that
 * somehow lost that flag is stripped by marker as a second line of defence —
 * capturing our own injection back would poison memory with its own echo.
 */
export function userText(message: HostMessage): string {
	const chunks: string[] = [];
	for (const part of message.parts ?? []) {
		if (part?.type !== "text") continue;
		if (part.synthetic === true) continue;
		if (part.ignored === true) continue;
		const text = typeof part.text === "string" ? part.text : "";
		if (text) chunks.push(text);
	}
	return stripRecallBlocks(chunks.join("\n")).trim();
}

/**
 * The assistant's answer. Text parts only: reasoning, tool calls, tool
 * results, step markers, files and patches are all excluded — they are
 * machinery, not something the user decided.
 */
export function assistantText(message: HostMessage): string {
	const chunks: string[] = [];
	for (const part of message.parts ?? []) {
		if (part?.type !== "text") continue;
		if (part.ignored === true) continue;
		if (part.synthetic === true) continue;
		const text = typeof part.text === "string" ? part.text : "";
		if (text) chunks.push(text);
	}
	return stripRecallBlocks(chunks.join("\n")).trim();
}

export interface SpanPlan {
	messages: CaptureMessage[];
	assistantMessageID: string | null;
	userMessageIDs: string[];
	/** Newest time.created across included messages — the AUD-01 watermark. */
	maxCreatedAt: number | null;
}

/**
 * Build the capture span from the owned window.
 *
 * `isOwned` decides membership (first-sight watermark, see sessionstate.ts).
 * Only genuine user/assistant pairs survive; a user turn with no answer, or
 * an answer with no question, is not a conversation worth remembering.
 */
export function planCaptureSpan(
	messages: HostMessage[],
	isOwned: (info: HostMessageInfo) => boolean,
): SpanPlan {
	const out: CaptureMessage[] = [];
	const userIds: string[] = [];
	let assistantMessageID: string | null = null;
	let maxCreatedAt: number | null = null;
	const noteCreated = (info: HostMessageInfo) => {
		const created = info.time?.created;
		if (typeof created === "number" && Number.isFinite(created)) {
			maxCreatedAt = maxCreatedAt === null ? created : Math.max(maxCreatedAt, created);
		}
	};

	for (const message of messages) {
		const info = message.info;
		if (!info || !info.id) continue;
		if (!isOwned(info)) continue;
		if (info.role === "user") {
			const text = userText(message);
			if (text) {
				out.push({ role: "user", content: text });
				userIds.push(info.id);
				noteCreated(info);
			}
			continue;
		}
		if (info.role === "assistant") {
			// Only completed, error-free assistant messages contribute text.
			if (info.error !== undefined && info.error !== null) continue;
			if (typeof info.time?.completed !== "number") continue;
			const text = assistantText(message);
			if (text) {
				out.push({ role: "assistant", content: text });
				assistantMessageID = info.id;
				noteCreated(info);
			}
		}
	}

	// A span must contain at least one user turn AND one assistant answer.
	const hasUser = out.some((m) => m.role === "user");
	const hasAssistant = out.some((m) => m.role === "assistant");
	if (!hasUser || !hasAssistant) return { messages: [], assistantMessageID: null, userMessageIDs: [], maxCreatedAt: null };
	return { messages: out, assistantMessageID, userMessageIDs: userIds, maxCreatedAt };
}

/**
 * Internal agents the host runs on its own behalf. Their sessions are not
 * conversations and must never be captured or injected into — the title
 * generator in particular re-reads the user's message, which is how a
 * plugin's injected context leaks into session titles (#42386).
 */
export const INTERNAL_AGENTS = Object.freeze(["compaction", "title", "summary"]);

export function isInternalAgent(agent: string | undefined): boolean {
	return typeof agent === "string" && INTERNAL_AGENTS.includes(agent);
}

/**
 * The compaction auto-continue turn: the host synthesises a user message to
 * restart the model after compacting. Every part is synthetic, and it is not
 * something a human said.
 */
export function isSyntheticUserTurn(parts: HostPart[] | undefined): boolean {
	const list = parts ?? [];
	if (list.length === 0) return false;
	return list.every((p) => p?.synthetic === true);
}
