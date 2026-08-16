/**
 * The hook launcher shim.
 *
 * Measured on a real host (Antigravity CLI 1.1.13, Windows, 2026-08-16): the
 * hook command parser does NOT honour quotes. A command of the form
 * `"C:/Program Files/nodejs/node.exe" script Stop` simply never runs, while the
 * same command via a space-free path runs fine. So a hook command must contain
 * no spaces at all — which would rule out the stock Windows Node location,
 * `C:\Program Files\nodejs\node.exe`.
 *
 * The way out is one level of indirection. We write a tiny launcher inside our
 * own owner-only state tree and point the hook at THAT. The launcher is
 * interpreted by cmd.exe / sh, both of which quote correctly, so the awkward
 * path is handled where quoting actually works.
 *
 * 8.3 short paths are used only as a secondary fallback for the rarer case of a
 * state directory that itself contains a space, because 8.3 generation can be
 * disabled system-wide (`fsutil 8dot3name`) and must never be the only route.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Characters that make a path unusable in an unquoted hook command. */
const SHELL_SPECIAL = new Set(Array.from("\"'`$&|;<>()*?!" + String.fromCharCode(92)));

export function pathIsHookSafe(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return false;
		if ("\"'`$&|;<>()*?!\\".includes(char)) return false;
	}
	return true;
}

/**
 * Values interpolated INTO the launcher must not be able to break out of the
 * quoting the launcher itself provides.
 */
export function safeToEmbed(value: string): boolean {
	if (value.includes('"')) return false;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		// Newlines would add lines to the script; NUL truncates.
		if (code === 0x00 || code === 0x0a || code === 0x0d) return false;
	}
	// cmd.exe expands %VAR% and delayed-expansion !VAR!; refuse both outright
	// rather than reason about escaping them.
	if (value.includes("%") || value.includes("!")) return false;
	return true;
}

/** Windows 8.3 short path, or null when 8.3 generation is disabled. */
export function shortPath(path: string): string | null {
	if (process.platform !== "win32") return null;
	try {
		const out = execFileSync(
			"cmd.exe",
			["/d", "/c", "for %I in (" + path + ") do @echo %~sI"],
			{ stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8" },
		);
		const candidate = String(out).trim().split(/\r?\n/)[0] ?? "";
		if (!candidate || candidate.includes(" ")) return null;
		return candidate.split(String.fromCharCode(92)).join("/");
	} catch {
		return null;
	}
}

export interface LauncherResult {
	ok: true;
	/** Path to reference from hooks.json — guaranteed hook-safe. */
	command: string;
	launcherPath: string;
	strategy: "direct" | "launcher" | "launcher-shortpath";
}
export interface LauncherFailure {
	ok: false;
	reason: string;
}

/**
 * Ensure there is a hook-safe way to invoke `nodePath scriptPath <event>`.
 * Never throws.
 */
export function ensureLauncher(
	stateRoot: string,
	nodePath: string,
	scriptPath: string,
): LauncherResult | LauncherFailure {
	// Fast path: everything is already safe, so no indirection is needed.
	if (pathIsHookSafe(nodePath) && pathIsHookSafe(scriptPath)) {
		return { ok: true, command: `${nodePath} ${scriptPath}`, launcherPath: "", strategy: "direct" };
	}
	if (!safeToEmbed(nodePath) || !safeToEmbed(scriptPath)) {
		return {
			ok: false,
			reason:
				"the Node or script path contains a character that cannot be safely embedded in a launcher (a quote, newline, %, or !). Move the installation to a simpler path.",
		};
	}

	const binDir = join(stateRoot, "bin");
	const isWindows = process.platform === "win32";
	const launcherPath = join(binDir, isWindows ? "itsuki-hook.cmd" : "itsuki-hook.sh");

	try {
		mkdirSync(binDir, { recursive: true, mode: 0o700 });
		const body = isWindows
			? `@echo off\r\nsetlocal\r\n"${nodePath}" "${scriptPath}" %*\r\n`
			: `#!/bin/sh\nexec "${nodePath}" "${scriptPath}" "$@"\n`;
		writeFileSync(launcherPath, body, { mode: 0o700 });
		if (!isWindows) chmodSync(launcherPath, 0o700);
	} catch (error) {
		return { ok: false, reason: `could not write the hook launcher: ${String(error)}` };
	}

	const forward = launcherPath.split(String.fromCharCode(92)).join("/");
	if (pathIsHookSafe(forward)) {
		return { ok: true, command: forward, launcherPath, strategy: "launcher" };
	}

	// The state directory itself contains a space (a home directory like
	// "C:\Users\Ada Lovelace"). 8.3 is the last resort, and only a resort.
	const short = shortPath(launcherPath);
	if (short && pathIsHookSafe(short)) {
		return { ok: true, command: short, launcherPath, strategy: "launcher-shortpath" };
	}
	return {
		ok: false,
		reason:
			`the state directory path (${launcherPath}) contains a space and Windows 8.3 short names are unavailable, so no hook-safe command can be built. ` +
			"Set ITSUKI_STATE_DIR to a path without spaces and run install again.",
	};
}
