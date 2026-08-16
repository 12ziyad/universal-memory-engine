/**
 * Installer safety: ownership, atomicity, link resistance, quoting, and the
 * promise that uninstall does not take a user's queued memories with it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildHookCommand, buildHooksJson, install, MARKER_FILE, readMarker, uninstall } from "../src/install.js";
import { Spool } from "../src/spool.js";

let home: string;
let bundle: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "itsuki-inst-"));
	bundle = join(home, "bundle");
	mkdirSync(join(bundle, "skills", "itsuki-doctor"), { recursive: true });
	writeFileSync(join(bundle, "plugin.json"), JSON.stringify({ name: "itsuki", description: "d" }));
	writeFileSync(join(bundle, "skills", "itsuki-doctor", "SKILL.md"), "---\nname: itsuki-doctor\ndescription: d\n---\n");
	env = { HOME: home, USERPROFILE: home, ITSUKI_STATE_DIR: join(home, "state") } as NodeJS.ProcessEnv;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const target = () => join(home, ".gemini", "config", "plugins", "itsuki");

function doInstall(over: Record<string, unknown> = {}) {
	return install({
		bundleDir: bundle,
		scriptPath: "/opt/itsuki/hook-entry.js",
		nodePath: "/usr/bin/node",
		version: "0.1.0",
		env,
		...over,
	});
}

describe("hook command construction", () => {
	it("emits an unquoted command from safe absolute paths", () => {
		const result = buildHookCommand("/usr/bin/node", "/opt/itsuki/hook.js", "Stop");
		expect(result).toEqual({ ok: true, command: "/usr/bin/node /opt/itsuki/hook.js Stop" });
	});

	it("REFUSES a path with a space rather than emitting an ambiguous command", () => {
		// The shell Antigravity uses to run hook commands is undocumented
		// (probe P11), so the only safe command is one needing no quoting.
		const result = buildHookCommand("C:/Program Files/node.exe", "/opt/h.js", "Stop");
		expect(result.ok).toBe(false);
	});

	it.each(['/opt/a"b/h.js', "/opt/a'b/h.js", "/opt/a&b/h.js", "/opt/a;b/h.js", "/opt/a$b/h.js", "/opt/a(b)/h.js", "/opt/a!b/h.js", "/opt/a|b/h.js", "/opt/a`b/h.js"])(
		"refuses shell metacharacter in %s",
		(script) => {
			expect(buildHookCommand("/usr/bin/node", script, "Stop").ok).toBe(false);
		},
	);

	it("SEC-03: refuses control characters, including a NUL byte, in a hook path", () => {
		// A NUL in a path is a truncation vector: the string the guard inspects
		// and the bytes an exec layer ultimately uses can disagree. The \s class
		// covers tab and newline but not the rest of the control range, so control
		// characters are matched explicitly.
		const ctrl = (code: number) => String.fromCharCode(code);
		for (const code of [0x00, 0x01, 0x07, 0x1b, 0x1f, 0x7f]) {
			expect(buildHookCommand("/usr/bin/node", `/opt/a${ctrl(code)}b/h.js`, "Stop").ok).toBe(false);
			expect(buildHookCommand(`/usr/bin/no${ctrl(code)}de`, "/opt/h.js", "Stop").ok).toBe(false);
		}
	});

	it("builds the documented top-level named-block hooks.json shape", () => {
		const result = buildHooksJson("/usr/bin/node", "/opt/h.js");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Named block at the TOP level — not Claude Code's {"hooks":{...}} wrapper.
		expect(Object.keys(result.hooks)).toEqual(["itsuki"]);
		expect(result.hooks["itsuki"]).toHaveProperty("PreInvocation");
		expect(result.hooks["itsuki"]).toHaveProperty("Stop");
		expect(JSON.stringify(result.hooks)).not.toContain('"hooks"');
		// Only the two events we actually implement.
		expect(Object.keys(result.hooks["itsuki"]!).sort()).toEqual(["PreInvocation", "Stop"]);
		// Explicit timeout, inside the host's own budget.
		const block = result.hooks["itsuki"] as Record<string, Array<Record<string, unknown>>>;
		expect(block["Stop"]![0]!["timeout"]).toBe(10);
		expect(block["PreInvocation"]![0]!["timeout"]).toBe(10);
	});

	it("never emits an event we do not handle", () => {
		const result = buildHooksJson("/usr/bin/node", "/opt/h.js");
		const text = JSON.stringify(result);
		for (const absent of ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostInvocation", "PreCompact"]) {
			expect(text).not.toContain(absent);
		}
	});
});

describe("install", () => {
	it("installs the bundle and writes an ownership marker", () => {
		const outcome = doInstall();
		expect(outcome.ok).toBe(true);
		expect(existsSync(join(target(), "plugin.json"))).toBe(true);
		expect(existsSync(join(target(), "hooks.json"))).toBe(true);
		const marker = readMarker(target());
		expect(marker?.version).toBe("0.1.0");
		expect(marker!.files).toContain("plugin.json");
	});

	it("REFUSES to overwrite a directory it does not own", () => {
		mkdirSync(target(), { recursive: true });
		writeFileSync(join(target(), "somebody-elses.json"), "{}");
		const outcome = doInstall();
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("not installed by Itsuki");
		// And it really did not touch it.
		expect(existsSync(join(target(), "somebody-elses.json"))).toBe(true);
		expect(existsSync(join(target(), "plugin.json"))).toBe(false);
	});

	it("is idempotent: reinstalling over our own install succeeds", () => {
		expect(doInstall().ok).toBe(true);
		const second = doInstall({ version: "0.1.1" });
		expect(second.ok).toBe(true);
		expect(readMarker(target())?.version).toBe("0.1.1");
	});

	it("leaves no staging or retired directories behind", () => {
		doInstall();
		doInstall({ version: "0.1.1" });
		const parent = join(home, ".gemini", "config", "plugins");
		const leftovers = require("node:fs").readdirSync(parent).filter((n: string) => n.includes("itsuki-"));
		expect(leftovers).toEqual([]);
	});

	it("now SUCCEEDS for a space-containing path, via the launcher (P11)", () => {
		// This used to assert failure. The host's parser ignores quotes, so a
		// space could not appear in the hook command — but the stock Windows
		// Node path has one. The launcher moves the quoting somewhere it works,
		// so a space is no longer a refusal.
		const outcome = doInstall({ scriptPath: "/opt/my plugins/hook.js" });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const hooks = JSON.parse(readFileSync(join(target(), "hooks.json"), "utf8"));
		const cmd = String(hooks["itsuki"]["Stop"][0]["command"]);
		// The command minus its trailing event argument carries no space.
		expect(cmd.endsWith(" Stop")).toBe(true);
		expect(cmd.slice(0, -" Stop".length)).not.toContain(" ");
	});

	it("still fails cleanly, installing nothing, when a path cannot be embedded safely", () => {
		// A quote would close the launcher's own quoting; refusing is correct.
		const outcome = doInstall({ scriptPath: '/opt/ev"il/hook.js' });
		expect(outcome.ok).toBe(false);
		expect(existsSync(target())).toBe(false);
	});
});

describe("uninstall", () => {
	it("removes only what the manifest lists", () => {
		doInstall();
		writeFileSync(join(target(), "user-added.txt"), "mine");
		const outcome = uninstall({ env });
		expect(outcome.ok).toBe(true);
		// The user's own file survives, so the directory survives with it.
		expect(existsSync(join(target(), "user-added.txt"))).toBe(true);
		expect(existsSync(join(target(), "plugin.json"))).toBe(false);
	});

	it("removes the directory entirely when nothing foreign remains", () => {
		doInstall();
		expect(uninstall({ env }).ok).toBe(true);
		expect(existsSync(target())).toBe(false);
	});

	it("REFUSES to delete a directory without our marker", () => {
		mkdirSync(target(), { recursive: true });
		writeFileSync(join(target(), "x.json"), "{}");
		const outcome = uninstall({ env });
		expect(outcome.ok).toBe(false);
		expect(existsSync(join(target(), "x.json"))).toBe(true);
	});

	it("preserves queued memories and the credential by default", () => {
		doInstall();
		const stateDir = env["ITSUKI_STATE_DIR"] as string;
		const spool = new Spool(stateDir);
		spool.stage({
			schema: "itsuki.antigravity-spool/v1",
			idempotencyKey: "k1",
			scope: { source: "antigravity" },
			messages: [{ role: "user", content: "remember me" }],
			discriminator: null,
			stagedAt: Date.now(),
			attempts: 0,
		});
		const outcome = uninstall({ env });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.preservedState).toBe(true);
		expect(new Spool(stateDir).stats().depth).toBe(1);
	});

	it("refuses --purge while memories are still queued, unless forced", () => {
		doInstall();
		const stateDir = env["ITSUKI_STATE_DIR"] as string;
		new Spool(stateDir).stage({
			schema: "itsuki.antigravity-spool/v1",
			idempotencyKey: "k1",
			scope: { source: "antigravity" },
			messages: [{ role: "user", content: "unsent" }],
			discriminator: null,
			stagedAt: Date.now(),
			attempts: 0,
		});
		const refused = uninstall({ env, purge: true });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("still queued");
		expect(new Spool(stateDir).stats().depth).toBe(1);

		const forced = uninstall({ env, purge: true, force: true });
		expect(forced.ok).toBe(true);
		expect(existsSync(stateDir)).toBe(false);
	});

	it("is a no-op when nothing is installed", () => {
		const outcome = uninstall({ env });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.removed).toBe(0);
	});
});
