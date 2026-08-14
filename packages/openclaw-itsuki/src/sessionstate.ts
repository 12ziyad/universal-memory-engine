/**
 * Per-session durable state: the capture watermark and the recall-echo
 * fingerprints.
 *
 * Pi could keep its watermark inside the host's own session tree
 * (`pi.appendEntry`), which made it survive `/resume` for free. OpenClaw has no
 * equivalent surface for an installed plugin — `api.runtime.state.openKeyedStore`
 * is documented as available only to bundled plugins and trusted official
 * installations — so this adapter keeps its own small store, atomically written
 * under the OpenClaw state root.
 *
 * Everything here is bounded and one-way: the session key is hashed into the
 * filename (a session key can name a channel and a person), fingerprints are
 * hashes rather than text, and old sessions are pruned.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SESSION_STATE_SCHEMA = "itsuki.openclaw-session/v1";

export const SESSION_LIMITS = Object.freeze({
	maxFingerprints: 512,
	maxSessions: 256,
	maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

export interface SessionState {
	schema: string;
	/** Number of host messages already owned by a capture. */
	watermarkCount: number;
	/** Digest of the owned prefix, so a rewritten history is detectable. */
	watermarkDigest: string;
	/** Fingerprints of context this plugin injected, for echo suppression. */
	fingerprints: string[];
	updatedAt: string;
}

function emptyState(): SessionState {
	return {
		schema: SESSION_STATE_SCHEMA,
		watermarkCount: 0,
		watermarkDigest: "",
		fingerprints: [],
		updatedAt: new Date(0).toISOString(),
	};
}

/** A session key can carry channel and person identifiers; never use it raw. */
export function sessionFileName(sessionKey: string): string {
	return `${createHash("sha256").update(String(sessionKey ?? ""), "utf8").digest("hex").slice(0, 32)}.json`;
}

export class SessionStore {
	private readonly dir: string;
	private readonly tmpDir: string;

	constructor(root: string) {
		this.dir = join(root, "sessions");
		this.tmpDir = join(root, "tmp");
	}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await mkdir(this.tmpDir, { recursive: true });
	}

	private async atomicWrite(destination: string, contents: string): Promise<void> {
		const tmp = join(
			this.tmpDir,
			`${createHash("sha256").update(destination + Math.random() + Date.now()).digest("hex").slice(0, 24)}.tmp`,
		);
		await writeFile(tmp, contents, "utf8");
		await rename(tmp, destination).catch(async (error: NodeJS.ErrnoException) => {
			// Windows refuses rename onto an existing file; replace deliberately.
			if (error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "EACCES") {
				await rm(destination, { force: true });
				await rename(tmp, destination);
				return;
			}
			await rm(tmp, { force: true }).catch(() => {});
			throw error;
		});
	}

	async read(sessionKey: string): Promise<SessionState> {
		try {
			const parsed = JSON.parse(
				await readFile(join(this.dir, sessionFileName(sessionKey)), "utf8"),
			) as Partial<SessionState>;
			if (parsed?.schema !== SESSION_STATE_SCHEMA) return emptyState();
			const count = Number(parsed.watermarkCount);
			return {
				schema: SESSION_STATE_SCHEMA,
				watermarkCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
				watermarkDigest: typeof parsed.watermarkDigest === "string" ? parsed.watermarkDigest : "",
				fingerprints: Array.isArray(parsed.fingerprints)
					? parsed.fingerprints.filter((f): f is string => typeof f === "string").slice(-SESSION_LIMITS.maxFingerprints)
					: [],
				updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
			};
		} catch {
			// Absent or unparseable state is not an error: an empty watermark
			// means "capture from the beginning", and content-derived identity
			// makes any resulting overlap a no-op at the server.
			return emptyState();
		}
	}

	async write(sessionKey: string, state: SessionState): Promise<void> {
		await this.init();
		const bounded: SessionState = {
			...state,
			schema: SESSION_STATE_SCHEMA,
			fingerprints: state.fingerprints.slice(-SESSION_LIMITS.maxFingerprints),
			updatedAt: new Date().toISOString(),
		};
		await this.atomicWrite(join(this.dir, sessionFileName(sessionKey)), JSON.stringify(bounded));
	}

	/** Drop sessions that are too old or beyond the count bound. */
	async prune(now: number = Date.now()): Promise<number> {
		let removed = 0;
		let names: string[];
		try {
			names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
		} catch {
			return 0;
		}
		const entries: Array<{ name: string; mtime: number }> = [];
		for (const name of names) {
			try {
				const info = await stat(join(this.dir, name));
				if (now - info.mtimeMs > SESSION_LIMITS.maxAgeMs) {
					await rm(join(this.dir, name), { force: true });
					removed += 1;
					continue;
				}
				entries.push({ name, mtime: info.mtimeMs });
			} catch {
				// Raced with another gateway; leave it.
			}
		}
		entries.sort((a, b) => a.mtime - b.mtime);
		while (entries.length > SESSION_LIMITS.maxSessions) {
			const oldest = entries.shift();
			if (!oldest) break;
			await rm(join(this.dir, oldest.name), { force: true }).catch(() => {});
			removed += 1;
		}
		return removed;
	}

	async count(): Promise<number> {
		try {
			return (await readdir(this.dir)).filter((n) => n.endsWith(".json")).length;
		} catch {
			return 0;
		}
	}
}
