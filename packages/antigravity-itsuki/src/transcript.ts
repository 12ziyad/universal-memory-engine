/**
 * Reading Antigravity's conversation transcript — the untrusted input.
 *
 * Google documents the PATH
 * (`<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`)
 * and the extension (`.jsonl`) and nothing else. The entry schema is not
 * published anywhere official, and the changelog shows the file being
 * rewritten in place during compaction (CLI 1.1.13 fixed corruption caused by
 * exactly that). Phase-0 probe P7 — which would have captured real fixtures —
 * could not run: it needs a Google sign-in, which this campaign was not given.
 *
 * So this module does two things and refuses to guess about a third:
 *
 *  1. It treats the file as hostile: the path is canonicalised and required to
 *     sit under the documented brain root, symlink/junction components are
 *     rejected, and only a bounded tail is read.
 *
 *  2. It parses defensively and CLASSIFIES what it found. A shape it cannot
 *     positively recognise as a verified schema yields `unverified`, and the
 *     lifecycle then does nothing automatic. Automatic capture stays HELD
 *     until a real fixture is recorded and registered below — that is the
 *     honest state, not a bug to code around.
 */

import { realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/** Never read more than this from the tail, whatever the file claims. */
export const MAX_TAIL_BYTES = 512 * 1024;
/** A single line longer than this is treated as corrupt, not parsed. */
export const MAX_LINE_BYTES = 128 * 1024;

/**
 * Verified transcript schemas.
 *
 * DELIBERATELY EMPTY. An entry is added only when a real fixture has been
 * captured from a real host and committed under `test/fixtures/transcripts/`.
 * Until then `classify()` returns `unverified` and no automatic lifecycle
 * behaviour runs. See PROBES.md (P7).
 */
export interface TranscriptSchema {
	id: string;
	/** Host versions this fixture was captured from. */
	hosts: string[];
	/** Returns true when a parsed entry set matches this schema. */
	matches: (entries: Array<Record<string, unknown>>) => boolean;
	/** Pull out conversation turns once matched. */
	extract: (entries: Array<Record<string, unknown>>) => TranscriptTurn[];
}

export const VERIFIED_SCHEMAS: TranscriptSchema[] = [];

export interface TranscriptTurn {
	role: "user" | "assistant";
	text: string;
	/** Stable per-entry identity, used for dedup anchors. */
	id: string | null;
	createdAt: number | null;
}

export type TranscriptResult =
	| { status: "ok"; schema: string; turns: TranscriptTurn[]; entries: number }
	| { status: "unverified"; entries: number; sampleKeys: string[] }
	| { status: "unreadable"; reason: string }
	| { status: "refused"; reason: string };

/**
 * Validate that `transcriptPath` really is the host's transcript for this
 * conversation and contains no link that could redirect the read.
 */
export function validateTranscriptPath(
	transcriptPath: string,
	appDataDirs: string[],
): { ok: true; resolved: string } | { ok: false; reason: string } {
	if (typeof transcriptPath !== "string" || !transcriptPath.trim()) {
		return { ok: false, reason: "empty path" };
	}
	if (!isAbsolute(transcriptPath)) return { ok: false, reason: "not absolute" };

	let resolved: string;
	try {
		// realpath collapses every symlink, junction and reparse point.
		resolved = realpathSync.native(transcriptPath);
	} catch (error) {
		return { ok: false, reason: `unresolvable: ${String(error)}` };
	}

	// Every component up to the file must itself be link-free, so a directory
	// swapped for a junction cannot redirect a later read.
	let cursor = dirname(resolved);
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		try {
			if (lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: "symlinked directory in path" };
		} catch {
			break;
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}

	const roots = appDataDirs
		.filter((d) => typeof d === "string" && d.trim())
		.map((d) => {
			try {
				return realpathSync.native(resolve(d));
			} catch {
				return resolve(d);
			}
		});
	const contained = roots.some((root) => {
		const withSep = root.endsWith(sep) ? root : root + sep;
		return resolved === root || resolved.startsWith(withSep);
	});
	if (!contained) return { ok: false, reason: "outside the documented app data root" };
	if (!resolved.endsWith(".jsonl")) return { ok: false, reason: "not a .jsonl file" };
	try {
		if (!statSync(resolved).isFile()) return { ok: false, reason: "not a regular file" };
	} catch (error) {
		return { ok: false, reason: `unstattable: ${String(error)}` };
	}
	return { ok: true, resolved };
}

/** Read at most the last `MAX_TAIL_BYTES` of a file, without loading it whole. */
export async function readTail(path: string, maxBytes = MAX_TAIL_BYTES): Promise<string> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, maxBytes);
		const position = Math.max(0, size - length);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, position);
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

/** Parse JSONL defensively: bad lines are skipped, never thrown. */
export function parseEntries(text: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const lines = text.split(/\r?\n/);
	// A tail read almost always begins mid-line; drop that fragment.
	for (let i = 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line) continue;
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) continue;
		const trimmed = line.trim();
		if (!trimmed || trimmed[0] !== "{") continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				out.push(parsed as Record<string, unknown>);
			}
		} catch {
			// A truncated or rewritten line is expected during compaction.
		}
	}
	return out;
}

/**
 * Decide whether the entries match a schema we have actually verified.
 * No match means no automatic behaviour — never a guess.
 */
export function classify(entries: Array<Record<string, unknown>>): TranscriptResult {
	if (entries.length === 0) {
		return { status: "unverified", entries: 0, sampleKeys: [] };
	}
	for (const schema of VERIFIED_SCHEMAS) {
		try {
			if (schema.matches(entries)) {
				return { status: "ok", schema: schema.id, turns: schema.extract(entries), entries: entries.length };
			}
		} catch {
			// A schema that throws on real data is not a match.
		}
	}
	const keys = new Set<string>();
	for (const entry of entries.slice(-20)) for (const key of Object.keys(entry)) keys.add(key);
	return { status: "unverified", entries: entries.length, sampleKeys: [...keys].sort().slice(0, 24) };
}

/** The whole read path, end to end. Never throws. */
export async function readTranscript(
	transcriptPath: string,
	appDataDirs: string[],
): Promise<TranscriptResult> {
	const validated = validateTranscriptPath(transcriptPath, appDataDirs);
	if (!validated.ok) return { status: "refused", reason: validated.reason };
	try {
		const text = await readTail(validated.resolved);
		return classify(parseEntries(text));
	} catch (error) {
		return { status: "unreadable", reason: String(error) };
	}
}
