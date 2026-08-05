import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ROOT = join(ROOT, "plugins", "itsuki");
const SCRIPT = join(PLUGIN_ROOT, "hooks", "codex-session-end.mjs");
const FIXTURE = join(ROOT, "test", "fixtures", "codex", "0.146.0-alpha.9.2-lifecycle.jsonl");
const roots = [];
const servers = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(resolve);
	})));
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runHook(payload, env, timeoutMs = 5_000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const childEnv = { ...process.env, ...env };
		for (const [name, value] of Object.entries(childEnv)) {
			if (value === undefined || value === null) delete childEnv[name];
		}
		const child = spawn(process.execPath, [SCRIPT], {
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout = [];
		const stderr = [];
		let bytes = 0;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Codex SessionEnd integration hook timed out"));
		}, timeoutMs);
		for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
			stream.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > 64 * 1024) child.kill();
				else chunks.push(Buffer.from(chunk));
			});
		}
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				elapsed: Date.now() - started,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
	});
}

async function networkCanary() {
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(request.url);
		response.statusCode = 500;
		response.end("SessionEnd must never reach this server");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

describe("Codex SessionEnd host-budget capture", () => {
	it("stages one scrubbed protected snapshot without any network request or transcript output", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-session-end-"));
		roots.push(root);
		const pluginData = join(root, "plugin data");
		const transcriptPath = join(root, "rollout.jsonl");
		await writeFile(transcriptPath, await readFile(FIXTURE));
		const canary = await networkCanary();
		const payload = {
			session_id: "codex-session-end-integration",
			transcript_path: transcriptPath,
			cwd: root,
			hook_event_name: "SessionEnd",
			model: "gpt-5.6",
			reason: "other",
		};
		const result = await runHook(payload, {
			PLUGIN_ROOT,
			PLUGIN_DATA: pluginData,
			CLAUDE_PLUGIN_ROOT: "C:\\wrong-compat-root",
			CLAUDE_PLUGIN_DATA: "C:\\wrong-compat-data",
			ITSUKI_BASE_URL: canary.url,
			ITSUKI_API_KEY: "itsuki_live_SESSIONEND_NETWORK_CANARY",
		});

		expect(result.code).toBe(0);
		expect(result.elapsed).toBeLessThan(3_000);
		expect(result.stderr).toBe("");
		expect(canary.requests).toEqual([]);
		const output = JSON.parse(result.stdout);
		expect(output.systemMessage).toMatch(/queued in the protected local outbox/i);
		expect(result.stdout).not.toContain(transcriptPath);
		expect(result.stdout).not.toMatch(/FIXTURESECRET|PRIVATE_FUNCTION_LOG|COMMENTARY_SENTINEL/);
		const staged = join(pluginData, "codex-outbox", "v1", "staged");
		const names = await readdir(staged);
		expect(names).toHaveLength(1);
		const raw = await readFile(join(staged, names[0]), "utf8");
		expect(raw).toContain("[REDACTED:api-key]");
		expect(raw).not.toMatch(/FIXTURESECRET|PRIVATE_FUNCTION_LOG|PRIVATE_CUSTOM_LOG|COMMENTARY_SENTINEL/);
		expect(JSON.parse(raw).capture.ignoredUnprotectedAssistantRows).toBe(1);
	});

	it("fails closed with advisory-only output for malformed input", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-session-end-malformed-"));
		roots.push(root);
		const pluginData = join(root, "plugin data");
		const result = await runHook("{malformed", { PLUGIN_ROOT, PLUGIN_DATA: pluginData });
		expect(result.code).toBe(0);
		expect(result.elapsed).toBeLessThan(3_000);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).systemMessage).toMatch(/nothing was queued/i);
		await expect(readdir(join(pluginData, "codex-outbox", "v1", "staged"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not create an unbound queue when the API key is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-session-end-unbound-"));
		roots.push(root);
		const pluginData = join(root, "plugin data");
		const transcriptPath = join(root, "rollout.jsonl");
		await writeFile(transcriptPath, await readFile(FIXTURE));
		const result = await runHook(
			{ session_id: "unbound", transcript_path: transcriptPath, cwd: root, hook_event_name: "SessionEnd", model: "gpt-5.6", reason: "other" },
			{
				PLUGIN_ROOT,
				PLUGIN_DATA: pluginData,
				ITSUKI_API_KEY: undefined,
				CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: undefined,
			},
		);
		expect(result.code).toBe(0);
		expect(result.elapsed).toBeLessThan(3_000);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).systemMessage).toMatch(/nothing was queued/i);
		await expect(readdir(join(pluginData, "codex-outbox", "v1", "staged"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects an invalid explicit project ID instead of queuing under a path fallback", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-session-end-project-"));
		roots.push(root);
		const pluginData = join(root, "plugin data");
		const transcriptPath = join(root, "rollout.jsonl");
		await writeFile(transcriptPath, await readFile(FIXTURE));
		const result = await runHook(
			{ session_id: "invalid-project", transcript_path: transcriptPath, cwd: root, hook_event_name: "SessionEnd", model: "gpt-5.6", reason: "other" },
			{
				PLUGIN_ROOT,
				PLUGIN_DATA: pluginData,
				ITSUKI_API_KEY: "itsuki_live_INVALID_PROJECT_TEST",
				ITSUKI_PROJECT_ID: " invalid-project",
			},
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).systemMessage).toMatch(/ITSUKI_PROJECT_ID is invalid/i);
		await expect(readdir(join(pluginData, "codex-outbox", "v1", "staged"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
