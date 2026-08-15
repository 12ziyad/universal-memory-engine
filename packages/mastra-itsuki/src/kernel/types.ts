// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/types.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * The shapes every Itsuki host adapter agrees on.
 *
 * Kept separate from any one host's vocabulary: a Vercel `ModelMessage`, a
 * Mastra `MastraDBMessage` and an OpenClaw turn all collapse to the same two
 * fields before anything is sent, and the tenancy fields below are the only
 * ones that decide WHERE a memory lands.
 */

export interface CaptureMessage {
	role: "user" | "assistant";
	content: string;
}

/**
 * Where a call writes and reads.
 *
 * `userId` is the only field that selects a memory space, and it never comes
 * from a model — it comes from the host application's own identity for the
 * end user. Everything else is attribution the server records but does not
 * trust for ownership (the authenticated connection's project binding wins).
 */
export interface CaptureScope {
	/** Isolated end-user memory space. Absent means the API key's own space. */
	userId?: string | undefined;
	/** Stable id for this conversation/thread — the de-duplication anchor. */
	conversationId?: string | undefined;
	/** Which adapter produced this, for source-lane filtering and cleanup. */
	source: string;
	/** Optional project attribution; enables project-scoped recall. */
	projectId?: string | undefined;
	/** Optional agent attribution in multi-agent hosts. */
	agentId?: string | undefined;
	/** Optional host run/step id, recorded as source provenance. */
	runId?: string | undefined;
}

export type RecallScope = "global" | "project_only" | "project_then_global";

/** One item as returned by the inventory endpoints. */
export interface MemoryListItem {
	id: string;
	kind?: string;
	label?: string;
	summary?: string;
	category?: string;
	[key: string]: unknown;
}
