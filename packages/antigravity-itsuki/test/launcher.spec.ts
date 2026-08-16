/**
 * P11 — the Windows default Node lives at `C:\Program Files\nodejs\node.exe`.
 *
 * Measured on a real host: the hook command parser ignores quotes, so a quoted
 * space-containing command never runs. The launcher moves the quoting into a
 * cmd/sh script, where it actually works.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHooksJsonWithLauncher } from "../src/install.js";
import { ensureLauncher, pathIsHookSafe, safeToEmbed } from "../src/launcher.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "itsuki-lnch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const WIN_NODE = "C:/Program Files/nodejs/node.exe";
const SCRIPT = "C:/Users/dev/itsuki/dist/hook-entry.js";

describe("hook-safety classification", () => {
	it("rejects spaces, because the host's parser ignores quotes", () => {
		expect(pathIsHookSafe(WIN_NODE)).toBe(false);
		expect(pathIsHookSafe("C:/PROGRA~1/nodejs/node.exe")).toBe(true);
	});

	it.each(['a"b', "a'b", "a`b", "a$b", "a&b", "a|b", "a;b", "a<b", "a>b", "a(b", "a!b", "a*b"])(
		"rejects the shell metacharacter in %s",
		(p) => expect(pathIsHookSafe(p)).toBe(false),
	);

	it("rejects control characters including NUL", () => {
		for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f]) {
			expect(pathIsHookSafe(`a${String.fromCharCode(code)}b`)).toBe(false);
		}
	});
});

describe("embedding safety — nothing may break out of the launcher's quoting", () => {
	it("refuses a quote, which would close our own quoting", () => {
		expect(safeToEmbed('C:/a"b/node.exe')).toBe(false);
	});
	it("refuses newlines, which would add lines to the script", () => {
		expect(safeToEmbed("C:/a\nb")).toBe(false);
		expect(safeToEmbed("C:/a\rb")).toBe(false);
	});
	it("refuses cmd variable expansion, both %VAR% and !VAR!", () => {
		expect(safeToEmbed("C:/%PATH%/node.exe")).toBe(false);
		expect(safeToEmbed("C:/!PATH!/node.exe")).toBe(false);
	});
	it("accepts an ordinary space-containing path", () => {
		expect(safeToEmbed(WIN_NODE)).toBe(true);
	});
});

describe("ensureLauncher", () => {
	it("uses no indirection when both paths are already safe", () => {
		const r = ensureLauncher(root, "C:/PROGRA~1/nodejs/node.exe", SCRIPT);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.strategy).toBe("direct");
			expect(existsSync(join(root, "bin"))).toBe(false);
		}
	});

	it("writes a launcher for the real Windows default Node path", () => {
		const r = ensureLauncher(root, WIN_NODE, SCRIPT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.strategy).toBe("launcher");
		expect(pathIsHookSafe(r.command)).toBe(true);
		const body = readFileSync(r.launcherPath, "utf8");
		// The awkward path is quoted INSIDE the script, where quoting works.
		expect(body).toContain(`"${WIN_NODE}"`);
		expect(body).toContain(`"${SCRIPT}"`);
	});

	it("forwards the event argument through the launcher", () => {
		const r = ensureLauncher(root, WIN_NODE, SCRIPT);
		if (!r.ok) throw new Error("expected a launcher");
		const body = readFileSync(r.launcherPath, "utf8");
		expect(body.includes("%*") || body.includes('"$@"')).toBe(true);
	});

	it("refuses rather than emitting a launcher that could be broken out of", () => {
		const r = ensureLauncher(root, 'C:/Program Files/no"de.exe', SCRIPT);
		expect(r.ok).toBe(false);
	});

	it("does NOT depend on 8.3 short names for the common case", () => {
		// The strategy for a normal state dir must be plain "launcher": 8.3 is
		// only a last resort, and can be disabled system-wide.
		const r = ensureLauncher(root, WIN_NODE, SCRIPT);
		if (!r.ok) throw new Error("expected success");
		expect(r.strategy).toBe("launcher");
	});
});

describe("buildHooksJsonWithLauncher", () => {
	it("produces a hook-safe command for the Windows default Node", () => {
		const r = buildHooksJsonWithLauncher(root, WIN_NODE, SCRIPT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const block = r.hooks["itsuki"] as Record<string, Array<Record<string, unknown>>>;
		for (const event of ["PreInvocation", "Stop"]) {
			const cmd = String(block[event]![0]!["command"]);
			expect(cmd.endsWith(` ${event}`)).toBe(true);
			// The command minus the event argument must contain no space.
			expect(pathIsHookSafe(cmd.slice(0, cmd.length - event.length - 1))).toBe(true);
			expect(block[event]![0]!["timeout"]).toBe(10);
		}
	});

	it("still emits only the two events we implement", () => {
		const r = buildHooksJsonWithLauncher(root, WIN_NODE, SCRIPT);
		if (!r.ok) throw new Error("expected success");
		expect(Object.keys(r.hooks["itsuki"]!).sort()).toEqual(["PreInvocation", "Stop"]);
		const text = JSON.stringify(r.hooks);
		for (const absent of ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostInvocation"]) {
			expect(text).not.toContain(absent);
		}
	});
});
