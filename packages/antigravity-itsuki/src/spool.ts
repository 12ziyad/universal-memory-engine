/**
 * The durable spool — the reason capture survives at all.
 *
 * OpenCode does not await the `event` hook (`void hook.event?.(...)` in
 * plugin/index.ts), and Phase-0 measured `dispose` arriving 19–21ms after
 * `session.idle` before the process exits. A capture that waits on the network
 * at idle is therefore cut off mid-flight and lost silently.
 *
 * So the durability point is local and synchronous-ish: write the envelope to
 * a temp file and `rename` it into place. `rename` within one directory is
 * atomic on POSIX and on NTFS, so a reader never sees a half-written
 * envelope, and a process killed at any instant leaves either nothing or a
 * complete record. Only after that does the network drain run, as a separate,
 * resumable step.
 *
 * Everything here is owner-only (0700 dirs / 0600 files on POSIX; on Windows
 * the ACL work lives in statetree.ts because it needs a child process).
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

import type { CaptureMessage, CaptureScope } from "./kernel/types.js";

export const SPOOL_SCHEMA = "itsuki.antigravity-spool/v1";

export const SPOOL_LIMITS = Object.freeze({
	/** Envelopes kept on disk. Oldest are dropped first and counted. */
	maxEnvelopes: 200,
	/** A single envelope larger than this is refused rather than stored. */
	maxEnvelopeBytes: 512 * 1024,
	/** Delivery attempts before an envelope is quarantined. */
	maxAttempts: 5,
});

export interface SpoolEnvelope {
	schema: string;
	/** Stable across retries — the exactly-once anchor. */
	idempotencyKey: string;
	scope: CaptureScope;
	messages: CaptureMessage[];
	/** Which batch of a split span this is, for the key discriminator. */
	discriminator: string | null;
	stagedAt: number;
	attempts: number;
}

export interface SpoolStats {
	depth: number;
	dropped: number;
	quarantined: number;
}

function safeName(key: string): string {
	// Envelope filenames must be derived, never taken from caller text.
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class Spool {
	private readonly dir: string;
	private readonly quarantineDir: string;
	private dropped = 0;
	private ready = false;

	constructor(root: string) {
		this.dir = join(root, "spool");
		this.quarantineDir = join(root, "quarantine");
	}

	/** Lazily created so a read-only home never breaks plugin load. */
	private ensure(): boolean {
		if (this.ready) return true;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
			this.ready = true;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Stage one envelope durably. Returns true only when the bytes are on disk
	 * under their final name — the caller may report "staged" only on true.
	 */
	stage(envelope: SpoolEnvelope): boolean {
		if (!this.ensure()) return false;
		let serialized: string;
		try {
			serialized = JSON.stringify(envelope);
		} catch {
			return false;
		}
		if (Buffer.byteLength(serialized, "utf8") > SPOOL_LIMITS.maxEnvelopeBytes) return false;

		this.trim();

		const base = safeName(envelope.idempotencyKey);
		const finalPath = join(this.dir, `${base}.json`);
		// Same key, already staged: the write is already durable. Staging it
		// again would be a duplicate, which is exactly what the key prevents.
		if (existsSync(finalPath)) return true;

		const tempPath = join(this.dir, `.${base}.${process.pid}.tmp`);
		try {
			const fd = openSync(tempPath, "w", 0o600);
			try {
				writeSync(fd, serialized);
				// fsync before rename: rename is atomic, but only over bytes the
				// filesystem has actually committed.
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tempPath, finalPath);
			return true;
		} catch {
			try {
				if (existsSync(tempPath)) unlinkSync(tempPath);
			} catch {
				/* best effort */
			}
			return false;
		}
	}

	/** Envelopes awaiting delivery, oldest first. Corrupt files are quarantined. */
	list(): Array<{ path: string; envelope: SpoolEnvelope }> {
		if (!existsSync(this.dir)) return [];
		let names: string[];
		try {
			names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
		} catch {
			return [];
		}
		const out: Array<{ path: string; envelope: SpoolEnvelope; mtime: number }> = [];
		for (const name of names) {
			const path = join(this.dir, name);
			try {
				const raw = readFileSync(path, "utf8");
				const parsed = JSON.parse(raw) as SpoolEnvelope;
				if (parsed?.schema !== SPOOL_SCHEMA || !Array.isArray(parsed.messages) || !parsed.idempotencyKey) {
					this.quarantine(path, "schema");
					continue;
				}
				out.push({ path, envelope: parsed, mtime: statSync(path).mtimeMs });
			} catch {
				this.quarantine(path, "unreadable");
			}
		}
		out.sort((a, b) => a.mtime - b.mtime);
		return out.map(({ path, envelope }) => ({ path, envelope }));
	}

	/** Delivered (or terminally undeliverable): remove it. */
	remove(path: string): void {
		try {
			if (existsSync(path)) unlinkSync(path);
		} catch {
			/* best effort */
		}
	}

	/** Record one failed attempt; quarantine once the budget is spent. */
	recordAttempt(path: string, envelope: SpoolEnvelope): void {
		const next = { ...envelope, attempts: (envelope.attempts ?? 0) + 1 };
		if (next.attempts >= SPOOL_LIMITS.maxAttempts) {
			this.quarantine(path, "attempts");
			return;
		}
		try {
			const tmp = `${path}.tmp`;
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeSync(fd, JSON.stringify(next));
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, path);
		} catch {
			/* leaving the old count is safer than losing the envelope */
		}
	}

	/**
	 * Move a file aside. Quarantine is METADATA ONLY — the content never
	 * travels, because an unparseable transcript fragment is exactly the sort
	 * of thing that should not be copied around.
	 */
	private quarantine(path: string, reason: string): void {
		if (!this.ensure()) return;
		try {
			const size = existsSync(path) ? statSync(path).size : 0;
			const note = {
				schema: "itsuki.antigravity-quarantine/v1",
				reason,
				bytes: size,
				at: Date.now(),
				digest: existsSync(path)
					? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32)
					: null,
			};
			const target = join(this.quarantineDir, `${safeName(path + String(note.at))}.json`);
			const fd = openSync(target, "w", 0o600);
			try {
				writeSync(fd, JSON.stringify(note));
			} finally {
				closeSync(fd);
			}
		} catch {
			/* best effort */
		}
		this.remove(path);
	}

	/** Enforce the depth bound, dropping oldest first. */
	private trim(): void {
		let entries: Array<{ path: string; mtime: number }>;
		try {
			entries = readdirSync(this.dir)
				.filter((n) => n.endsWith(".json"))
				.map((n) => {
					const p = join(this.dir, n);
					return { path: p, mtime: statSync(p).mtimeMs };
				});
		} catch {
			return;
		}
		if (entries.length < SPOOL_LIMITS.maxEnvelopes) return;
		entries.sort((a, b) => a.mtime - b.mtime);
		const excess = entries.length - SPOOL_LIMITS.maxEnvelopes + 1;
		for (let i = 0; i < excess; i += 1) {
			const entry = entries[i];
			if (!entry) continue;
			this.remove(entry.path);
			this.dropped += 1;
		}
	}

	stats(): SpoolStats {
		let depth = 0;
		let quarantined = 0;
		try {
			if (existsSync(this.dir)) depth = readdirSync(this.dir).filter((n) => n.endsWith(".json")).length;
		} catch {
			/* ignore */
		}
		try {
			if (existsSync(this.quarantineDir)) quarantined = readdirSync(this.quarantineDir).length;
		} catch {
			/* ignore */
		}
		return { depth, dropped: this.dropped, quarantined };
	}
}
