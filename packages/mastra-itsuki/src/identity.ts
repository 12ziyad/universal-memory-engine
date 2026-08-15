/**
 * Who a run belongs to, and where its memory goes.
 *
 * Mastra already names both halves: `resource` is the person and `thread` is
 * the conversation, and both ride on every stored message. So identity is read
 * from the run itself rather than configured twice, and the one thing that can
 * never supply it is the model — a tool argument or a sentence in a prompt has
 * no authority over which memory space a write lands in.
 */

import type { ResolvedConfig } from "./config.js";

/** The minimum message shape this adapter reads. */
export interface MessageLike {
	role?: string;
	resourceId?: string | undefined;
	threadId?: string | undefined;
	content?: unknown;
}

/** A RequestContext-shaped object: anything with a typed get(). */
export interface ContextLike {
	get?: (key: string) => unknown;
}

/**
 * Keys an application may set on the Mastra RequestContext to override
 * identity for one run. Server-side code sets these; a model cannot.
 */
export const CONTEXT_KEYS = Object.freeze({
	userId: "itsuki.userId",
	conversationId: "itsuki.conversationId",
	projectId: "itsuki.projectId",
	agentId: "itsuki.agentId",
});

function contextString(context: ContextLike | undefined, key: string): string | undefined {
	if (!context || typeof context.get !== "function") return undefined;
	try {
		const value = context.get(key);
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		// A RequestContext that throws on an unknown key must not break a turn.
		return undefined;
	}
}

function firstFrom(messages: readonly MessageLike[], field: "resourceId" | "threadId"): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const value = messages[i]?.[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export interface RunIdentity {
	userId: string | undefined;
	conversationId: string | undefined;
	projectId: string | undefined;
	agentId: string | undefined;
}

/**
 * Resolve one run's identity.
 *
 * Order: an explicit RequestContext override, then Mastra's own resource and
 * thread, then the configured single-tenant default. An undefined userId is a
 * refusal, not a fallback — the caller skips rather than writing somewhere
 * arbitrary.
 */
export function resolveIdentity(
	config: ResolvedConfig,
	messages: readonly MessageLike[],
	context?: ContextLike,
	agentId?: string,
): RunIdentity {
	return {
		userId: contextString(context, CONTEXT_KEYS.userId)
			?? firstFrom(messages, "resourceId")
			?? config.defaultUserId,
		conversationId: contextString(context, CONTEXT_KEYS.conversationId)
			?? firstFrom(messages, "threadId"),
		projectId: contextString(context, CONTEXT_KEYS.projectId) ?? config.projectId,
		agentId: contextString(context, CONTEXT_KEYS.agentId) ?? (agentId?.trim() || undefined),
	};
}

/** Apply a run's identity to the base configuration. */
export function configFor(config: ResolvedConfig, identity: RunIdentity): ResolvedConfig {
	const projectId = identity.projectId ?? config.projectId;
	return {
		...config,
		userId: identity.userId ?? "",
		conversationId: identity.conversationId,
		projectId,
		agentId: identity.agentId,
		recallScope: identity.projectId && !config.projectId
			? "project_then_global"
			: config.recallScope,
	};
}
