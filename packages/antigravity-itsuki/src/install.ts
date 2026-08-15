/**
 * Installer, updater and uninstaller.
 *
 * Rules that shape every function here:
 *
 *  - Never overwrite a directory we do not own. An ownership marker with an
 *    exact file manifest is written at install; anything present without it is
 *    someone else's and is refused, not clobbered.
 *  - Every mutation is atomic: stage into a temp sibling, then rename.
 *  - No path component may be a symlink/junction, on the way in or out.
 *  - Hook commands are absolute and free of shell metacharacters, because the
 *    shell Antigravity uses to run them is undocumented (probe P11) — so the
 *    only safe command is one that needs no quoting at all.
 *  - Uninstall preserves the user's spool and credentials unless they ask,
 *    explicitly and separately, to purge.
 */

import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { credentialsPath, PLUGIN_ID, pluginInstallDir, stateRoot } from "./config.js";
import { Spool } from "./spool.js";
import { protectStateTree } from "./statetree.js";

export const MARKER_FILE = ".itsuki-install.json";
export const MARKER_SCHEMA = "itsuki.antigravity-install/v1";

export interface InstallMarker {
	schema: string;
	version: string;
	installId: string;
	installedAt: number;
	files: string[];
}

export type InstallOutcome =
	| { ok: true; dir: string; files: number; note: string }
	| { ok: false; reason: string };

/** Refuse to touch anything reachable through a link. */
export function assertNoLinks(path: string): { ok: true } | { ok: false; reason: string } {
	let cursor = resolve(path);
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		try {
			if (lstatSync(cursor).isSymbolicLink()) {
				return { ok: false, reason: `refusing to follow a link at ${cursor}` };
			}
		} catch {
			// Missing components are fine — they will be created.
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return { ok: true };
}

export function readMarker(dir: string): InstallMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")) as InstallMarker;
		return parsed?.schema === MARKER_SCHEMA ? parsed : null;
	} catch {
		return null;
	}
}

function listFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full, base));
		else out.push(full.slice(base.length + 1).split(sep).join("/"));
	}
	return out;
}

/**
 * The hook command. Absolute node, absolute script, one bare event name.
 *
 * If either absolute path contains a character that any plausible shell would
 * treat specially, we refuse rather than emit a command that might be
 * mis-tokenised — the host's shell and quoting rules are undocumented, and a
 * mis-parsed command fails silently.
 */
export function buildHookCommand(nodePath: string, scriptPath: string, event: string): { ok: true; command: string } | { ok: false; reason: string } {
	// Shell metacharacters, any whitespace, AND the whole control range.
	// A NUL is the important one: the string this guard inspects and the bytes
	// an exec layer eventually uses can disagree across it, so a path that
	// looks safe here can execute as something shorter (SEC-03).
	// Written as explicit code-point checks rather than a regex literal. This
	// pattern travels through several escaping layers, and a mis-escaped \s
	// silently degrades to "the letter s" — which would reject nearly every
	// real path while still looking like a working guard.
	const SHELL_SPECIAL = new Set(Array.from("\"'`$&|;<>()*?!\\"));
	const isRisky = (value: string): boolean => {
		for (const char of value) {
			const code = char.codePointAt(0) ?? 0;
			// Everything at or below space (NUL, tab, CR, LF, …) and DEL.
			if (code <= 0x20 || code === 0x7f) return true;
			if (SHELL_SPECIAL.has(char)) return true;
		}
		return false;
	};
	for (const [label, value] of [["node", nodePath], ["script", scriptPath]] as const) {
		if (isRisky(value)) {
			return {
				ok: false,
				reason: `the ${label} path contains a character that is unsafe in an unquoted hook command (${value}). Reinstall from a path without spaces or shell metacharacters, or set ITSUKI_STATE_DIR and install elsewhere.`,
			};
		}
	}
	return { ok: true, command: `${nodePath} ${scriptPath} ${event}` };
}

export interface HooksFile {
	[block: string]: Record<string, unknown>;
}

/**
 * Antigravity's documented hooks.json shape: NAMED BLOCKS at the top level,
 * each mapping event names to handler lists. (Mem0's bundle wraps everything
 * in a Claude-Code-style `{"hooks": {...}}` object, which is not this schema.)
 *
 * PreInvocation and Stop take a flat handler list and ignore matchers.
 */
export function buildHooksJson(nodePath: string, scriptPath: string): { ok: true; hooks: HooksFile } | { ok: false; reason: string } {
	const pre = buildHookCommand(nodePath, scriptPath, "PreInvocation");
	if (!pre.ok) return pre;
	const stop = buildHookCommand(nodePath, scriptPath, "Stop");
	if (!stop.ok) return stop;
	return {
		ok: true,
		hooks: {
			itsuki: {
				PreInvocation: [{ type: "command", command: pre.command, timeout: 10 }],
				Stop: [{ type: "command", command: stop.command, timeout: 10 }],
			},
		},
	};
}

export interface InstallInput {
	/** Directory holding plugin.json + skills/ as shipped in the package. */
	bundleDir: string;
	targetDir?: string;
	nodePath?: string;
	/** Absolute path to the installed hook entry script. */
	scriptPath: string;
	version: string;
	env?: NodeJS.ProcessEnv;
}

export function install(input: InstallInput): InstallOutcome {
	const env = input.env ?? process.env;
	const target = input.targetDir ?? pluginInstallDir(env);
	const nodePath = input.nodePath ?? process.execPath;

	const links = assertNoLinks(target);
	if (!links.ok) return { ok: false, reason: links.reason };

	if (existsSync(target)) {
		const marker = readMarker(target);
		if (!marker) {
			return {
				ok: false,
				reason: `${target} exists but was not installed by Itsuki. Refusing to overwrite it — remove it yourself if it is safe to.`,
			};
		}
	}

	const hooks = buildHooksJson(nodePath, input.scriptPath);
	if (!hooks.ok) return { ok: false, reason: hooks.reason };

	const staging = `${target}.itsuki-staging-${process.pid}`;
	try {
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging, { recursive: true, mode: 0o700 });
		cpSync(input.bundleDir, staging, { recursive: true });
		writeFileSync(join(staging, "hooks.json"), JSON.stringify(hooks.hooks, null, 2), { mode: 0o600 });

		const files = listFiles(staging).filter((f) => f !== MARKER_FILE);
		const marker: InstallMarker = {
			schema: MARKER_SCHEMA,
			version: input.version,
			installId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			installedAt: Date.now(),
			files,
		};
		writeFileSync(join(staging, MARKER_FILE), JSON.stringify(marker, null, 2), { mode: 0o600 });

		// Atomic swap: the old tree steps aside, the new one takes its place.
		const retired = `${target}.itsuki-retired-${process.pid}`;
		mkdirSync(dirname(target), { recursive: true });
		if (existsSync(target)) renameSync(target, retired);
		try {
			renameSync(staging, target);
		} catch (error) {
			if (existsSync(retired)) renameSync(retired, target);
			throw error;
		}
		rmSync(retired, { recursive: true, force: true });
		try {
			chmodSync(target, 0o700);
		} catch {
			/* best effort on platforms without POSIX modes */
		}
		protectStateTree(stateRoot(env), env);
		return { ok: true, dir: target, files: files.length, note: `installed ${files.length} files` };
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		return { ok: false, reason: `install failed: ${String(error)}` };
	}
}

/** Remove empty directories bottom-up. Anything non-empty is left alone. */
function pruneEmptyDirs(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(dir, name);
		try {
			if (lstatSync(full).isDirectory()) pruneEmptyDirs(full);
		} catch {
			/* skip */
		}
	}
	try {
		// rmdirSync refuses a non-empty directory by design, which is exactly
		// the guarantee wanted here. (rmSync without `recursive` throws on a
		// directory outright, so it cannot be used for this.)
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		/* leave it */
	}
}

export type UninstallOutcome =
	| { ok: true; removed: number; preservedState: boolean; note: string }
	| { ok: false; reason: string };

export interface UninstallInput {
	targetDir?: string;
	/** Remove the spool, watermarks and stored credential too. */
	purge?: boolean;
	/** Required alongside purge when the spool still holds undelivered work. */
	force?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function uninstall(input: UninstallInput = {}): UninstallOutcome {
	const env = input.env ?? process.env;
	const target = input.targetDir ?? pluginInstallDir(env);
	if (!existsSync(target)) return { ok: true, removed: 0, preservedState: true, note: "nothing installed" };

	const links = assertNoLinks(target);
	if (!links.ok) return { ok: false, reason: links.reason };

	const marker = readMarker(target);
	if (!marker) {
		return {
			ok: false,
			reason: `${target} has no Itsuki install marker. Refusing to delete a directory this tool did not create.`,
		};
	}

	// Check every precondition BEFORE removing anything. Doing this after the
	// files are gone would leave a half-uninstalled plugin that cannot even be
	// retried, because the marker it needs has already been deleted.
	if (input.purge) {
		const pending = new Spool(stateRoot(env)).stats().depth;
		if (pending > 0 && !input.force) {
			return {
				ok: false,
				reason: `${pending} memor${pending === 1 ? "y is" : "ies are"} still queued for delivery. Run "antigravity-itsuki doctor" to drain them, or pass --force to discard them permanently.`,
			};
		}
	}

	let removed = 0;
	// Remove only what the manifest claims, so a file a user added survives.
	for (const relative of marker.files) {
		const full = join(target, ...relative.split("/"));
		try {
			if (existsSync(full)) {
				rmSync(full, { force: true });
				removed += 1;
			}
		} catch {
			/* keep going: a partial uninstall is better than an aborted one */
		}
	}
	try {
		rmSync(join(target, MARKER_FILE), { force: true });
		rmSync(join(target, "hooks.json"), { force: true });
	} catch {
		/* best effort */
	}
	// Our own now-empty directories are residue, not the user's files: prune
	// them bottom-up, stopping the moment something foreign appears.
	pruneEmptyDirs(target);

	if (!input.purge) {
		return { ok: true, removed, preservedState: true, note: "state and credentials preserved" };
	}

	const root = stateRoot(env);
	try {
		rmSync(root, { recursive: true, force: true });
		rmSync(credentialsPath(env), { force: true });
	} catch {
		/* best effort */
	}
	return { ok: true, removed, preservedState: false, note: "state and credentials removed" };
}
