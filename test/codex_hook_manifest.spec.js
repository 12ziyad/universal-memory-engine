import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_ROOT = join(ROOT, "plugins", "itsuki", "hooks");
const temporaryRoots = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runWindowsLauncher(cwd, env, hook = "SessionStart", payload = {}) {
	const registered = JSON.parse(await readFile(join(HOOK_ROOT, "hooks.json"), "utf8"));
	const command = registered.hooks[hook][0].hooks[0].commandWindows;
	return new Promise((resolve, reject) => {
		const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const child = spawn(executable, [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
		], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => resolve({
			code,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
		}));
		child.stdin.end(JSON.stringify(payload));
	});
}

describe("Codex-native lifecycle hook contract", () => {
	it("uses the default plugin hooks file and the exact supported lifecycle matchers", async () => {
		const manifest = JSON.parse(await readFile(join(ROOT, "plugins", "itsuki", ".codex-plugin", "plugin.json"), "utf8"));
		const registered = JSON.parse(await readFile(join(HOOK_ROOT, "hooks.json"), "utf8"));
		expect(manifest.hooks).toBeUndefined();
		expect(Object.keys(registered.hooks)).toEqual(["SessionStart", "SessionEnd"]);
		expect(registered.hooks.SessionStart[0].matcher).toBe("^(startup|resume|clear|compact)$");
		expect(registered.hooks.SessionEnd[0].matcher).toBe("^other$");
		const start = registered.hooks.SessionStart[0].hooks[0];
		const end = registered.hooks.SessionEnd[0].hooks[0];
		expect(start).toMatchObject({
			type: "command",
			command: "/bin/sh \"$PLUGIN_ROOT/hooks/codex-launch.sh\" SessionStart",
			commandWindows: expect.stringContaining("[Environment]::SystemDirectory"),
			// 10 s host kill timeout: the hook self-bounds at 3.8 s internally, but
			// launcher (PowerShell + Node) startup happens before that budget
			// starts counting, and delivery now uses realistic 2 s request caps.
			timeout: 10,
			additionalContextLimit: 5000,
		});
		expect(end).toMatchObject({
			type: "command",
			command: "/bin/sh \"$PLUGIN_ROOT/hooks/codex-launch.sh\" SessionEnd",
			commandWindows: expect.stringContaining("[Environment]::SystemDirectory"),
			timeout: 3,
		});
		for (const command of [start.commandWindows, end.commandWindows]) {
			expect(command).toContain("[Environment]::SystemDirectory");
			expect(command).toContain("[string]::IsNullOrWhiteSpace($itsukiPluginRoot)");
			expect(command).toContain("[IO.Path]::IsPathRooted($itsukiPluginRoot)");
			expect(command).not.toContain("%SystemRoot%");
			expect(command).not.toContain("${PLUGIN_ROOT}");
		}
	});

	it("is self-contained and never routes Codex rows through Claude capture", async () => {
		const names = await readdir(HOOK_ROOT);
		const sources = await Promise.all(names.filter((name) => name.endsWith(".mjs")).map(async (name) => ({
			name,
			text: await readFile(join(HOOK_ROOT, name), "utf8"),
		})));
		for (const source of sources) {
			expect(source.text, source.name).not.toMatch(/from\s+["']\.\.\//);
		}
		const parser = sources.find(({ name }) => name === "codex-transcript.mjs").text;
		const outbox = sources.find(({ name }) => name === "codex-outbox.mjs").text;
		const sessionEnd = sources.find(({ name }) => name === "codex-session-end.mjs").text;
		const sessionStart = sources.find(({ name }) => name === "codex-session-start.mjs").text;
		expect(parser).not.toMatch(/claude-(?:capture|transcript)|hooks\/claude/i);
		expect(sessionEnd).not.toMatch(/\bfetch\s*\(|https?:\/\//i);
		expect(sessionEnd).toContain("readCodexTranscript");
		expect(`${sessionStart}\n${sessionEnd}`).not.toContain("CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY");
		expect(outbox).not.toMatch(/execFile\(\s*["']powershell\.exe["']/i);
		const windowsLauncher = await readFile(join(HOOK_ROOT, "codex-launch.ps1"), "utf8");
		const posixLauncher = await readFile(join(HOOK_ROOT, "codex-launch.sh"), "utf8");
		const readme = await readFile(join(ROOT, "plugins", "itsuki", "README.md"), "utf8");
		expect(windowsLauncher).toContain("outside the active worktree");
		expect(windowsLauncher).toContain("node.exe");
		expect(windowsLauncher).toContain('$env:PSModulePath = [IO.Path]::Combine($PSHOME, "Modules")');
		expect(windowsLauncher).toContain('"NODE_OPTIONS"');
		expect(windowsLauncher).not.toMatch(/\b(?:Get-Item|Test-Path|Join-Path|Get-Location)\b/);
		expect(posixLauncher).toContain("unset NODE_OPTIONS NODE_PATH");
		expect(posixLauncher).toContain("outside the active worktree");
		expect(readme).toContain('[shell_environment_policy.filters]');
		expect(readme).toContain('"ITSUKI_API_KEY" = "exclude"');
		expect(readme).toContain("files have higher precedence than user configuration in trusted projects");
	});

	it.runIf(process.platform === "win32")("ignores a repository-local node.exe even when the worktree leads PATH", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "itsuki-codex-shadow-"));
		temporaryRoots.push(worktree);
		await mkdir(join(worktree, ".git"));
		await copyFile(process.env.ComSpec, join(worktree, "node.exe"));
		const result = await runWindowsLauncher(worktree, {
			...process.env,
			PLUGIN_ROOT: join(ROOT, "plugins", "itsuki"),
			PATH: `${worktree};${dirname(process.execPath)};${process.env.PATH}`,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({ continue: true });
	});

	it.runIf(process.platform === "win32")("clears inherited Node preloads before the trusted hook runtime starts", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-preload-"));
		temporaryRoots.push(root);
		const preload = join(root, "preload.cjs");
		const marker = join(root, "preload-marker.txt");
		await writeFile(preload, "require('node:fs').writeFileSync(process.env.ITSUKI_PRELOAD_MARKER, process.env.ITSUKI_API_KEY || 'missing');\n", "utf8");
		const result = await runWindowsLauncher(ROOT, {
			...process.env,
			PLUGIN_ROOT: join(ROOT, "plugins", "itsuki"),
			ITSUKI_API_KEY: "itsuki_live_fake_preload_secret_123456",
			ITSUKI_PRELOAD_MARKER: marker,
			NODE_OPTIONS: `--require=${preload}`,
			NODE_PATH: root,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.runIf(process.platform === "win32")("rejects a missing plugin root before a cwd launcher can run", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-missing-root-"));
		temporaryRoots.push(root);
		const cwdHooks = join(root, "hooks");
		const marker = join(root, "cwd-launcher-marker.txt");
		await mkdir(cwdHooks);
		await writeFile(join(cwdHooks, "codex-launch.ps1"), `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', $env:ITSUKI_API_KEY)\n`, "utf8");
		const env = {
			...process.env,
			ITSUKI_API_KEY: "itsuki_live_fake_cwd_secret_123456",
		};
		delete env.PLUGIN_ROOT;
		const result = await runWindowsLauncher(root, env);
		expect(result.code).not.toBe(0);
		await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.runIf(process.platform === "win32")("does not auto-load commands from an inherited PowerShell module path", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-psmodule-"));
		temporaryRoots.push(root);
		const moduleRoot = join(root, "Microsoft.PowerShell.Management");
		const marker = join(root, "module-marker.txt");
		await mkdir(moduleRoot);
		await writeFile(join(moduleRoot, "Microsoft.PowerShell.Management.psm1"), [
			"[IO.File]::WriteAllText($env:ITSUKI_PSMODULE_MARKER, 'PSMODULE_KEY=' + [Environment]::GetEnvironmentVariable('ITSUKI_API_KEY', 'Process'))",
			"function Get-Item { throw 'probe stop' }",
			"Export-ModuleMember -Function Get-Item",
		].join("\n"), "utf8");
		await writeFile(join(moduleRoot, "Microsoft.PowerShell.Management.psd1"), [
			"@{",
			"  RootModule='Microsoft.PowerShell.Management.psm1'",
			"  ModuleVersion='99.0.0'",
			"  GUID='11111111-1111-1111-1111-111111111111'",
			"  FunctionsToExport=@('Get-Item')",
			"  CmdletsToExport=@()",
			"}",
		].join("\n"), "utf8");
		const result = await runWindowsLauncher(ROOT, {
			...process.env,
			PLUGIN_ROOT: join(ROOT, "plugins", "itsuki"),
			ITSUKI_API_KEY: "itsuki_live_fake_module_secret_123456",
			ITSUKI_PSMODULE_MARKER: marker,
			PSModulePath: `${root};${process.env.PSModulePath ?? ""}`,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.runIf(process.platform === "win32")("rebuilds the nested ACL verifier path instead of trusting poisoned Windows variables", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-systemroot-"));
		temporaryRoots.push(root);
		const pluginData = join(root, "plugin-data");
		const transcriptPath = join(root, "rollout.jsonl");
		await copyFile(join(ROOT, "test", "fixtures", "codex", "0.146.0-alpha.9.2-lifecycle.jsonl"), transcriptPath);
		const payload = {
			session_id: "poisoned-systemroot-proof",
			transcript_path: transcriptPath,
			cwd: root,
			hook_event_name: "SessionEnd",
			model: "gpt-5.6",
			reason: "other",
		};
		const poisonedRoot = join(root, "fake-windows");
		const result = await runWindowsLauncher(root, {
			...process.env,
			PLUGIN_ROOT: join(ROOT, "plugins", "itsuki"),
			PLUGIN_DATA: pluginData,
			ITSUKI_API_KEY: "itsuki_live_fake_systemroot_secret_123456",
			SystemRoot: poisonedRoot,
			WINDIR: poisonedRoot,
			ITSUKI_SYSTEM_POWERSHELL: join(poisonedRoot, "powershell.exe"),
		}, "SessionEnd", payload);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).systemMessage).toMatch(/queued in the protected local outbox/i);
		expect(await readdir(join(pluginData, "codex-outbox", "v1", "staged"))).toHaveLength(1);
	});
});
