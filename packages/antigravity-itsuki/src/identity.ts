/**
 * Tenancy for the Antigravity integration — same frozen boundary as every
 * other Itsuki adapter (report §14.1):
 *
 *   credential      = the account. Fixed by the key, enforced by the server.
 *   configured user = an OPTIONAL stable sub-tenant, from configuration only.
 *   workspace/project = attribution. Never a tenancy boundary.
 *   conversationId  = session scoping only. Never identity.
 *
 * Antigravity exposes `workspacePaths` and a `conversationId`, and neither may
 * become a tenant: a folder name is not a person, and a conversation is not an
 * account. A shared install either names its sub-tenant in configuration or
 * gets exactly one space.
 */

import type { CaptureScope } from "./kernel/types.js";

export const SOURCE = "antigravity";

export interface IdentityInput {
	userId: string | undefined;
	projectId: string | undefined;
	sessionID: string;
}

export function captureScope(input: IdentityInput): CaptureScope {
	const scope: CaptureScope = { source: SOURCE, conversationId: input.sessionID };
	if (input.userId) scope.userId = input.userId;
	if (input.projectId) scope.projectId = input.projectId;
	return scope;
}

/** Filesystem-safe, bounded key derived from an opaque host conversation id. */
export function sessionStateKey(sessionID: string): string | null {
	const trimmed = String(sessionID ?? "").trim();
	if (!trimmed) return null;
	const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
	return safe.length > 0 ? safe : null;
}
