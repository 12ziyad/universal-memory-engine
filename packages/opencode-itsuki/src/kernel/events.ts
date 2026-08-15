// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/events.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * Content-free instrumentation.
 *
 * An adapter that logs what it remembered is an adapter that leaks the user's
 * memory into whatever aggregates the host's logs. So the event stream carries
 * shapes and outcomes only: counts, durations, error classes, opaque ids.
 * There is deliberately no field anywhere below that can hold message text, a
 * recalled memory, a query, or a credential.
 *
 * No OpenTelemetry dependency: hosts bridge this to whatever they already run
 * (examples/otel.ts shows the five-line bridge).
 */

import type { ErrorClass } from "./errors.js";

export type ItsukiEvent =
	| { type: "recall.ok"; ms: number; count: number; injectedChars: number }
	| { type: "recall.fail"; ms: number; errorClass: ErrorClass }
	| { type: "recall.skipped"; reason: string }
	| { type: "capture.staged"; ms: number; messages: number; batches: number; packetId: string | null }
	| { type: "capture.fail"; ms: number; errorClass: ErrorClass }
	| { type: "capture.skipped"; reason: string }
	| { type: "inject.truncated"; fromChars: number; toChars: number }
	| { type: "tool.ok"; tool: string; ms: number }
	| { type: "tool.fail"; tool: string; ms: number; errorClass: ErrorClass };

export type EventHook = (event: ItsukiEvent) => void;

/**
 * Emit without ever letting instrumentation break the host.
 * A throwing hook is the host's bug, and it must not become a failed turn.
 */
export function emit(hook: EventHook | undefined, event: ItsukiEvent): void {
	if (!hook) return;
	try {
		hook(event);
	} catch {
		// Deliberately swallowed: telemetry is never load-bearing.
	}
}

/** Fixed reasons, so a skip can never carry user text into a log line. */
export const SKIP_REASONS = Object.freeze({
	disabled: "disabled",
	notReady: "not_ready",
	noIdentity: "no_identity",
	noUserMessage: "no_user_message",
	emptyQuery: "empty_query",
	notSettled: "not_settled",
	aborted: "aborted",
	errored: "errored",
	nothingToCapture: "nothing_to_capture",
	duplicate: "duplicate",
	systemTurn: "system_turn",
} as const);

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];
