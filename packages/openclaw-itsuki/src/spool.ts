/**
 * A small, crash-safe outbox for captured spans.
 *
 * Same invariants as the Claude outbox (hooks/outbox.mjs), identical to the
 * published pi-itsuki spool, at a fraction of the
 * machinery: envelopes are written to a temp file and renamed into place, so a
 * crash mid-write can never leave a half-parsed envelope; the queue id IS the
 * content digest, so enqueueing the same span twice is a no-op; delivery
 * removes the envelope only after the server has acknowledged it.
 *
 * The bound is real and so is its accounting: when the spool is full the OLDEST
 * envelope is dropped and counted. A dropped span is reported by `/itsuki
 * doctor` — never silently forgotten, because a memory tool that quietly loses
 * writes is worse than one that admits it.
 */

import { createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const SPOOL_SCHEMA = "itsuki.openclaw-spool/v1";

export const SPOOL_LIMITS = Object.freeze({
	maxEntries: 64,
	maxEnvelopeBytes: 512 * 1024,
	maxDrainPerPass: 4,
});

export interface SpoolEnvelope {
	schema: string;
	idempotencyKey: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	scope: {
		userId?: string | null;
		conversationId?: string | null;
		source: string;
	};
	createdAt: string;
	attempts: number;
	lastErrorCode?: string | null;
}

export interface SpoolStats {
	depth: number;
	dropped: number;
}

function queueId(idempotencyKey: string): string {
	return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32);
}

export class Spool {
	private readonly root: string;
	private readonly dir: string;
	private readonly tmpDir: string;
	private readonly metaPath: string;

	constructor(root: string) {
		this.root = root;
		this.dir = join(root, "spool");
		this.tmpDir = join(root, "tmp");
		this.metaPath = join(root, "spool-meta.json");
	}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
	}

	private async readMeta(): Promise<{ dropped: number }> {
		try {
			const parsed = JSON.parse(await readFile(this.metaPath, "utf8")) as { dropped?: unknown };
			const dropped = Number(parsed?.dropped);
			return { dropped: Number.isFinite(dropped) && dropped >= 0 ? dropped : 0 };
		} catch {
			return { dropped: 0 };
		}
	}

	private async writeMeta(meta: { dropped: number }): Promise<void> {
		await this.atomicWrite(this.metaPath, JSON.stringify(meta));
	}

	/** Write to a unique temp file, then rename — never a partial file in place. */
	private async atomicWrite(destination: string, contents: string): Promise<void> {
		const tmp = join(this.tmpDir, `${createHash("sha256").update(destination + Math.random() + Date.now()).digest("hex").slice(0, 24)}.tmp`);
		await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
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

	private async listFiles(): Promise<string[]> {
		try {
			const names = await readdir(this.dir);
			return names.filter((name) => name.endsWith(".json")).sort();
		} catch {
			return [];
		}
	}

	async read(name: string): Promise<SpoolEnvelope | null> {
		try {
			const parsed = JSON.parse(await readFile(join(this.dir, name), "utf8")) as Partial<SpoolEnvelope>;
			if (parsed?.schema !== SPOOL_SCHEMA) return null;
			if (typeof parsed.idempotencyKey !== "string" || !Array.isArray(parsed.messages)) return null;
			return parsed as SpoolEnvelope;
		} catch {
			return null;
		}
	}

	async list(): Promise<Array<{ name: string; envelope: SpoolEnvelope }>> {
		const out: Array<{ name: string; envelope: SpoolEnvelope }> = [];
		for (const name of await this.listFiles()) {
			const envelope = await this.read(name);
			if (envelope) out.push({ name, envelope });
			// A file that will not parse is corrupt, not data. Remove it rather
			// than retrying it forever, and count it as a drop.
			else await this.dropCorrupt(name);
		}
		out.sort((a, b) => (a.envelope.createdAt < b.envelope.createdAt ? -1 : 1));
		return out;
	}

	private async dropCorrupt(name: string): Promise<void> {
		await rm(join(this.dir, name), { force: true }).catch(() => {});
		const meta = await this.readMeta();
		await this.writeMeta({ dropped: meta.dropped + 1 });
	}

	/**
	 * Take durable ownership of a span. Returns false when the envelope was
	 * already present (same content digest) — enqueue is idempotent.
	 */
	async enqueue(envelope: SpoolEnvelope): Promise<boolean> {
		await this.init();
		const serialized = JSON.stringify(envelope);
		if (Buffer.byteLength(serialized, "utf8") > SPOOL_LIMITS.maxEnvelopeBytes) {
			// Too large to spool is a terminal condition for this span; count it
			// so the loss is visible rather than imaginary.
			const meta = await this.readMeta();
			await this.writeMeta({ dropped: meta.dropped + 1 });
			return false;
		}
		const name = `${queueId(envelope.idempotencyKey)}.json`;
		const existing = await this.read(name);
		if (existing) return false;

		const current = await this.list();
		if (current.length >= SPOOL_LIMITS.maxEntries) {
			const oldest = current[0];
			if (oldest) {
				await rm(join(this.dir, oldest.name), { force: true }).catch(() => {});
				const meta = await this.readMeta();
				await this.writeMeta({ dropped: meta.dropped + 1 });
			}
		}
		await this.atomicWrite(join(this.dir, name), serialized);
		return true;
	}

	async update(name: string, envelope: SpoolEnvelope): Promise<void> {
		await this.atomicWrite(join(this.dir, name), JSON.stringify(envelope));
	}

	async remove(name: string): Promise<void> {
		await rm(join(this.dir, name), { force: true }).catch(() => {});
	}

	async stats(): Promise<SpoolStats> {
		const [files, meta] = await Promise.all([this.listFiles(), this.readMeta()]);
		return { depth: files.length, dropped: meta.dropped };
	}

	get directory(): string {
		return this.root;
	}
}
