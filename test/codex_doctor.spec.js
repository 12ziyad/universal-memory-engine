/**
 * CDX-03 — Codex diagnostics.
 *
 * Codex plugins register hooks, not slash commands, so the Claude adapter's
 * `/itsuki:doctor` has no equivalent surface in that host. The gap this closes
 * is that a Codex user had NO way to answer "is this working, and which part
 * is broken?" without reading source. The doctor is therefore a script the
 * user runs directly.
 *
 * The rule these tests exist to hold: it must be genuinely diagnostic, and it
 * must never print the credential.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(ROOT, "plugins", "itsuki");
const DOCTOR = join(PLUGIN_ROOT, "hooks", "codex-doctor.mjs");
const KEY = "itsuki_live_CODEX_DOCTOR_CANARY_55913";
const roots = new Set();

afterEach(async () => {
	await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
	roots.clear();
});

async function fixture(label) {
	const root = await mkdtemp(join(tmpdir(), `itsuki-${label}-`));
	const pluginData = join(root, "plugin-data");
	await mkdir(pluginData, { recursive: true });
	roots.add(root);
	return { root, pluginData };
}

function run(args = [], env = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [DOCTOR, ...args], {
			cwd: ROOT,
			// A clean environment: no inherited ITSUKI_* from the developer shell.
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: process.env.HOME,
				USERPROFILE: process.env.USERPROFILE,
				// Standing campaign lesson: the Codex queue's ACL runner needs the
				// real Windows PowerShell and a Windows TEMP; an MSYS TEMP breaks it.
				// Passing it here is what makes the outbox check exercisable at all.
				...(process.platform === "win32"
					? { ITSUKI_SYSTEM_POWERSHELL: process.env.ITSUKI_SYSTEM_POWERSHELL ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") }
					: {}),
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill(), 40_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
	});
}

describe("Codex doctor (CDX-03)", () => {
	it("reports version, endpoint, MCP target, outbox, and project identity", async () => {
		const data = await fixture("codex-doctor-report");
		// Unreachable loopback: connectivity must FAIL honestly rather than hang
		// or be quietly skipped, and every offline check must still report.
		const result = await run([], {
			PLUGIN_DATA: data.pluginData,
			ITSUKI_API_KEY: KEY,
			ITSUKI_BASE_URL: "http://127.0.0.1:9",
		});

		const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
		expect(result.stdout).toMatch(new RegExp(`^PASS  plugin version -- itsuki ${manifest.version.replace(/\./g, "\\.")}`, "m"));
		expect(result.stdout).toMatch(/^PASS  hook registration -- SessionStart and SessionEnd are both registered/m);
		expect(result.stdout).toMatch(/^PASS  MCP target -- http https:\/\/itsuki\.app\/mcp$/m);
		expect(result.stdout).toMatch(/^PASS  credential -- an Itsuki API key is present and header-safe \(value hidden\)$/m);
		expect(result.stdout).toMatch(/^PASS  protected outbox -- 0 queued entries, 0 quarantined/m);
		expect(result.stdout).toMatch(/^PASS  project identity -- this directory derives local_[0-9a-f]{32}/m);
		expect(result.stdout).toMatch(/an SDK or REST caller must carry it to see the same memory/);
		// Connectivity against a dead port is a failure, stated plainly.
		expect(result.stdout).toMatch(/^FAIL  connectivity/m);
		expect(result.code).toBe(1);
	}, 45_000);

	it("never prints the credential, in text or JSON output", async () => {
		const data = await fixture("codex-doctor-secret");
		const text = await run([], { PLUGIN_DATA: data.pluginData, ITSUKI_API_KEY: KEY, ITSUKI_BASE_URL: "http://127.0.0.1:9" });
		const asJson = await run(["--json"], { PLUGIN_DATA: data.pluginData, ITSUKI_API_KEY: KEY, ITSUKI_BASE_URL: "http://127.0.0.1:9" });

		for (const result of [text, asJson]) {
			const all = `${result.stdout}\n${result.stderr}`;
			expect(all).not.toContain(KEY);
			expect(all).not.toContain("CODEX_DOCTOR_CANARY_55913");
			// Not a hash of it either — a fingerprint is still a credential oracle.
			expect(all).not.toMatch(/[0-9a-f]{40,}/);
		}
		expect(JSON.parse(asJson.stdout)).toHaveProperty("checks");
	}, 45_000);

	it("says the key is missing rather than reporting a healthy system", async () => {
		const data = await fixture("codex-doctor-nokey");
		const result = await run([], { PLUGIN_DATA: data.pluginData, ITSUKI_BASE_URL: "http://127.0.0.1:9" });

		expect(result.stdout).toMatch(/^FAIL  credential -- no Itsuki API key in the environment/m);
		expect(result.stdout).toMatch(/^SKIP  connectivity -- blocked by a missing or invalid credential$/m);
		expect(result.code).toBe(1);
	}, 45_000);

	it("names a malformed key as malformed, not as a network problem", async () => {
		const data = await fixture("codex-doctor-badkey");
		const result = await run([], { PLUGIN_DATA: data.pluginData, ITSUKI_API_KEY: "not a real key", ITSUKI_BASE_URL: "http://127.0.0.1:9" });

		expect(result.stdout).toMatch(/^FAIL  credential -- the configured Itsuki API key is not a valid key shape/m);
		expect(result.stdout).not.toContain("not a real key");
	}, 45_000);

	it("reports a missing plugin-data directory instead of an empty queue", async () => {
		const result = await run([], { ITSUKI_API_KEY: KEY, ITSUKI_BASE_URL: "http://127.0.0.1:9" });
		expect(result.stdout).toMatch(/^FAIL  protected outbox -- no plugin-data directory in the environment/m);
	}, 45_000);

	it("names an ITSUKI_PROJECT_ID override instead of silently honouring it", async () => {
		const data = await fixture("codex-doctor-override");
		const result = await run([], {
			PLUGIN_DATA: data.pluginData,
			ITSUKI_API_KEY: KEY,
			ITSUKI_BASE_URL: "http://127.0.0.1:9",
			ITSUKI_PROJECT_ID: "local_pinned_codex_project",
		});
		expect(result.stdout).toMatch(/^PASS  project identity -- this directory derives local_pinned_codex_project \(ITSUKI_PROJECT_ID override in effect\)/m);
	}, 45_000);

	it("derives the SAME project id as the Claude adapter for one directory (SRV-07)", async () => {
		const { resolveCodexProjectScope } = await import("../plugins/itsuki/hooks/codex-outbox.mjs");
		const { resolveProjectIdentity } = await import("../hooks/project-identity.mjs");
		const codex = await resolveCodexProjectScope(ROOT);
		const claude = await resolveProjectIdentity(ROOT);
		expect(codex.projectId).toBe(claude.projectId);
	});
});
