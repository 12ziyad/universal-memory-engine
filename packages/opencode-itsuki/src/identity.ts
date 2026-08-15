/**
 * Tenancy derivation — the security boundary of this package.
 *
 * The frozen rule (report §14.1), restated because every line below exists to
 * enforce it:
 *
 *   credential  = the account boundary. The API key alone decides the account,
 *                 and the server enforces it. Nothing here can widen it.
 *   userId      = an OPTIONAL stable sub-tenant, and only ever from configuration.
 *   project     = attribution only. Never a tenancy boundary.
 *   sessionID   = session scoping only (watermarks, dedup). Never identity.
 *
 * Consequently: no username, folder name, git remote, worktree path, model
 * output, transcript content or tool argument may reach `userId`. OpenCode
 * exposes no per-end-user identity, so a shared install either names its
 * sub-tenant in configuration or gets exactly one space — never a guess.
 */

import type { CaptureScope } from "./kernel/types.js";

export const SOURCE = "opencode";

export interface IdentityInput {
	/** From configuration only. */
	userId: string | undefined;
	/** From configuration only. Attribution, not tenancy. */
	projectId: string | undefined;
	/** Host session id — scoping and dedup, never identity. */
	sessionID: string;
}

/**
 * Build the scope for one call.
 *
 * `conversationId` carries the host session so the server can group a thread;
 * it is explicitly NOT part of the tenancy decision.
 */
export function captureScope(input: IdentityInput): CaptureScope {
	const scope: CaptureScope = { source: SOURCE, conversationId: input.sessionID };
	if (input.userId) scope.userId = input.userId;
	if (input.projectId) scope.projectId = input.projectId;
	return scope;
}

/**
 * A defensive assertion used at every call site that could be tempted to pass
 * host-derived text as identity. Returns the configured value or undefined —
 * never a fallback derived from its input.
 */
export function configuredTenant(configured: string | undefined): string | undefined {
	if (typeof configured !== "string") return undefined;
	const trimmed = configured.trim();
	return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

/**
 * Session-scoped state key. Hashing is not required (a session id is not a
 * secret), but it must be filesystem-safe and length-bounded, because it names
 * files in the state tree and host ids are opaque.
 */
export function sessionStateKey(sessionID: string): string | null {
	const trimmed = String(sessionID ?? "").trim();
	if (!trimmed) return null;
	const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
	return safe.length > 0 ? safe : null;
}
