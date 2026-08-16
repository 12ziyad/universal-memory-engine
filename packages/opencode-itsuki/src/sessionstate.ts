/**
 * Package-owned watermarks.
 *
 * Pi keeps its watermark inside the host's own session tree, so a fork
 * inherits it for free. OpenCode offers a plugin no persisted session-state
 * API at all, so the watermark lives here instead, and the "don't re-capture
 * inherited history" property has to be achieved a different way.
 *
 * That way is FIRST-SIGHT SEEDING, and the exact seed point matters. Seeding
 * at the end of the transcript would swallow the very turn the user just
 * typed. Phase-0 (P4) proved the host hands us the boundary we need before the
 * model runs: `chat.message` carries `input.messageID` / `output.message.id`
 * and `output.message.time.created` for the human message being sent. So the
 * watermark is seeded IMMEDIATELY BEFORE that message: everything strictly
 * older is inherited history and is never captured; the current exchange
 * stays capturable.
 *
 * A fork therefore starts fresh at its own first sight, and copied history —
 * whose messages are all older than the seed — is skipped without needing any
 * fork-lineage API the host does not expose.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { sessionStateKey } from "./identity.js";

export const SESSION_SCHEMA = "itsuki.opencode-session/v1";

export interface SessionState {
	schema: string;
	sessionID: string;
	/** Message id of the first human turn we ever saw in this session. */
	seedMessageID: string | null;
	/** Its creation time. Anything strictly older is inherited history. */
	seedCreatedAt: number | null;
	/** Newest assistant message id already captured. */
	lastCapturedMessageID: string | null;
	/**
	 * Creation time of the newest message already captured (AUD-01).
	 *
	 * The seed watermark alone only excludes history from BEFORE first sight.
	 * Without this second watermark, every later capture in a growing session
	 * spans from the seed again — a superset of the previous span, under a
	 * fresh idempotency key the server cannot collapse, so each turn re-uploads
	 * the whole conversation so far.
	 */
	capturedThroughCreatedAt: number | null;
	lastCapturedAt: number | null;
	/** Idempotency keys already staged, newest last, bounded. */
	recentKeys: string[];
}

const MAX_RECENT_KEYS = 50;

function emptyState(sessionID: string): SessionState {
	return {
		schema: SESSION_SCHEMA,
		sessionID,
		seedMessageID: null,
		seedCreatedAt: null,
		lastCapturedMessageID: null,
		lastCapturedAt: null,
		capturedThroughCreatedAt: null,
		recentKeys: [],
	};
}

export class SessionStore {
	private readonly dir: string;
	private readonly cache = new Map<string, SessionState>();

	constructor(root: string) {
		this.dir = join(root, "sessions");
	}

	private pathFor(sessionID: string): string | null {
		const key = sessionStateKey(sessionID);
		return key ? join(this.dir, `${key}.json`) : null;
	}

	load(sessionID: string): SessionState {
		const cached = this.cache.get(sessionID);
		if (cached) return cached;
		const path = this.pathFor(sessionID);
		let state = emptyState(sessionID);
		if (path && existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionState;
				if (parsed?.schema === SESSION_SCHEMA && parsed.sessionID === sessionID) {
					state = { ...emptyState(sessionID), ...parsed };
					if (!Array.isArray(state.recentKeys)) state.recentKeys = [];
				}
			} catch {
				// A corrupt state file must not resurrect old history: fall back
				// to a fresh state, which re-seeds at the next human turn.
				state = emptyState(sessionID);
			}
		}
		this.cache.set(sessionID, state);
		return state;
	}

	save(state: SessionState): boolean {
		const path = this.pathFor(state.sessionID);
		if (!path) return false;
		this.cache.set(state.sessionID, state);
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			const tmp = `${path}.${process.pid}.tmp`;
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeSync(fd, JSON.stringify(state));
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Seed on first sight of a human turn. Idempotent: a session already seeded
	 * keeps its original seed, so later turns never move the boundary forward
	 * and lose an un-captured exchange.
	 */
	seed(sessionID: string, messageID: string, createdAt: number | null): SessionState {
		const state = this.load(sessionID);
		if (state.seedMessageID) return state;
		state.seedMessageID = messageID;
		state.seedCreatedAt = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : null;
		this.save(state);
		return state;
	}

	/** Has this exact capture already been staged? */
	hasKey(sessionID: string, key: string): boolean {
		return this.load(sessionID).recentKeys.includes(key);
	}

	noteCaptured(
		sessionID: string,
		key: string,
		assistantMessageID: string | null,
		at: number,
		capturedThroughCreatedAt?: number | null,
	): void {
		const state = this.load(sessionID);
		if (!state.recentKeys.includes(key)) state.recentKeys.push(key);
		while (state.recentKeys.length > MAX_RECENT_KEYS) state.recentKeys.shift();
		state.lastCapturedMessageID = assistantMessageID;
		state.lastCapturedAt = at;
		if (typeof capturedThroughCreatedAt === "number" && Number.isFinite(capturedThroughCreatedAt)) {
			state.capturedThroughCreatedAt = Math.max(state.capturedThroughCreatedAt ?? -Infinity, capturedThroughCreatedAt);
		}
		this.save(state);
	}

	forget(sessionID: string): void {
		this.cache.delete(sessionID);
		const path = this.pathFor(sessionID);
		try {
			if (path && existsSync(path)) unlinkSync(path);
		} catch {
			/* best effort */
		}
	}
}

export interface SeenMessage {
	id: string;
	role: string;
	createdAt: number | null;
	completedAt: number | null;
}

/**
 * Is this message inside the span we own?
 *
 * Older than the seed → inherited history (or a fork's copy) → never ours.
 * Already captured → not ours again.
 */
export function withinOwnedSpan(state: SessionState, message: SeenMessage): boolean {
	if (!state.seedMessageID) return false;
	// AUD-01: the captured-through gate must run BEFORE the seed-id shortcut,
	// or the seed turn itself is re-included in every later span forever.
	const capturedThrough = state.capturedThroughCreatedAt;
	if (capturedThrough !== null) {
		if (message.createdAt === null) return false;
		if (message.createdAt <= capturedThrough) return false;
	}
	if (message.id === state.seedMessageID) return true;
	if (state.seedCreatedAt === null || message.createdAt === null) {
		// Without comparable timestamps the only safe answer is "not ours":
		// capturing history we cannot date is how duplicates are born.
		return false;
	}
	return message.createdAt >= state.seedCreatedAt;
}
