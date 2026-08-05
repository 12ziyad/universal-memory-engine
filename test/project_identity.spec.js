import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	CLAUDE_CODE_APP_ID,
	PROJECT_RECALL_SCOPE,
	PROJECT_SOURCE_SCOPE,
	claudeProjectDirectory,
	projectMemoryScope,
	resolveProjectIdentity,
} from "../hooks/project-identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function captureHookRequest(script, payload, env = {}) {
	let resolveRequest;
	const requestReceived = new Promise((resolve) => { resolveRequest = resolve; });
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ context: "" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();

	const child = spawn(process.execPath, [
		join(ROOT, "hooks", script),
		"--service-url-for-test", `http://127.0.0.1:${port}`,
	], {
		cwd: ROOT,
		env: {
			...process.env,
			CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: "itsuki_live_synthetic_test",
			ITSUKI_API_KEY: "",
			ITSUKI_BASE_URL: `http://127.0.0.1:${port}`,
			ITSUKI_PROJECT_ID: "",
			CLAUDE_PROJECT_DIR: "",
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(JSON.stringify(payload));
	const [code] = await once(child, "exit");
	const body = await requestReceived;
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return { body, code };
}

describe("Claude hook project identity", () => {
	it("uses canonical realpath identity while exposing only the basename", async () => {
		const canonical = "C:\\private-parent\\canonical\\atlas";
		const first = await resolveProjectIdentity("C:\\aliases\\atlas-one", {
			platform: "win32",
			projectIdOverride: "",
			realpathFn: async () => canonical,
		});
		const second = await resolveProjectIdentity("D:\\other-alias\\atlas-two", {
			platform: "win32",
			projectIdOverride: "",
			realpathFn: async () => canonical,
		});

		expect(first.projectId).toBe(second.projectId);
		expect(first.projectId).toMatch(/^local_[a-f0-9]{32}$/);
		expect(first.projectName).toBe("atlas-one");
		expect(second.projectName).toBe("atlas-two");
		expect(JSON.stringify(first)).not.toContain("private-parent");
	});

	it("distinguishes canonical paths with the same basename", async () => {
		const options = {
			platform: "win32",
			projectIdOverride: "",
			realpathFn: async (value) => value,
		};
		const first = await resolveProjectIdentity("C:\\teams\\one\\shared", options);
		const second = await resolveProjectIdentity("D:\\teams\\two\\shared", options);

		expect(first.projectName).toBe("shared");
		expect(second.projectName).toBe("shared");
		expect(first.projectId).not.toBe(second.projectId);
	});

	it("normalizes Windows path case for stable IDs", async () => {
		const options = {
			platform: "win32",
			projectIdOverride: "",
			realpathFn: async (value) => value,
		};
		const mixedCase = await resolveProjectIdentity("C:\\Work\\Atlas", options);
		const lowerCase = await resolveProjectIdentity("c:\\work\\atlas", options);

		expect(mixedCase.projectId).toBe(lowerCase.projectId);
	});

	it("honors an explicit project ID and builds the shared scope shape", async () => {
		const identity = await resolveProjectIdentity("C:\\private\\atlas", {
			platform: "win32",
			projectIdOverride: "team-atlas",
			realpathFn: async (value) => value,
		});

		expect(identity.projectId).toBe("team-atlas");
		expect(projectMemoryScope(identity)).toEqual({
			projectId: "team-atlas",
			projectName: "atlas",
			appId: CLAUDE_CODE_APP_ID,
			sourceScope: PROJECT_SOURCE_SCOPE,
		});
	});

	it("prefers Claude's stable project root over a changed event cwd", () => {
		const root = join(ROOT, "stable-root");
		const changed = join(root, "packages", "worker");
		expect(claudeProjectDirectory(changed, { CLAUDE_PROJECT_DIR: root })).toBe(root);
		expect(claudeProjectDirectory(changed, {})).toBe(changed);
		expect(claudeProjectDirectory({ malformed: true }, {})).toBe(process.cwd());
	});

	it("replaces the colliding basename subtenant with an opaque project scope", async () => {
		const firstCwd = join(ROOT, "synthetic-a", "shared-name");
		const secondCwd = join(ROOT, "synthetic-b", "shared-name");
		expect(`project:${basename(firstCwd)}`).toBe(`project:${basename(secondCwd)}`);

		const first = await captureHookRequest("session-start.mjs", { cwd: firstCwd });
		const second = await captureHookRequest("session-start.mjs", { cwd: secondCwd });

		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(first.body.userId).toBeUndefined();
		expect(second.body.userId).toBeUndefined();
		expect(first.body.memoryScope.projectId).toMatch(/^local_[a-f0-9]{32}$/);
		expect(first.body.memoryScope.projectId).not.toBe(second.body.memoryScope.projectId);
		expect(first.body).toMatchObject({
			query: "project decisions, conventions, architecture, and fixes for shared-name",
			memoryScope: {
				projectName: "shared-name",
				appId: CLAUDE_CODE_APP_ID,
				sourceScope: PROJECT_SOURCE_SCOPE,
			},
			recallScope: PROJECT_RECALL_SCOPE,
		});
		expect(JSON.stringify(first.body)).not.toContain("synthetic-a");
		expect(JSON.stringify(second.body)).not.toContain("synthetic-b");
	});

	it("stages identical project metadata from SessionEnd without userId or paths", async () => {
		const cwd = join(ROOT, "synthetic-a", "shared-name");
		const stableEnv = { CLAUDE_PROJECT_DIR: cwd };
		const start = await captureHookRequest("session-start.mjs", { cwd }, stableEnv);
		const temp = await mkdtemp(join(tmpdir(), "itsuki-project-identity-"));
		const configRoot = join(temp, "claude-config");
		const pluginData = join(configRoot, "plugins", "data", "itsuki");
		const transcriptPath = join(temp, "synthetic.jsonl");
		await mkdir(pluginData, { recursive: true });
		await writeFile(transcriptPath, `${JSON.stringify({
			type: "user",
			uuid: "synthetic-event-id",
			timestamp: "2026-08-05T00:00:00.000Z",
			message: { content: "synthetic project decision" },
		})}\n`, "utf8");

		try {
			const payload = {
				cwd: join(cwd, "packages", "worker"),
				session_id: "synthetic-session",
				transcript_path: transcriptPath,
			};
			const child = spawn(process.execPath, [join(ROOT, "hooks", "session-end.mjs"), "--plugin-data", pluginData], {
				cwd: ROOT,
				env: {
					...process.env,
					CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: "itsuki_live_synthetic_project_identity",
					CLAUDE_PLUGIN_DATA: pluginData,
					CLAUDE_CONFIG_DIR: configRoot,
					ITSUKI_API_KEY: "",
					ITSUKI_BASE_URL: "https://itsuki.app",
					ITSUKI_PROJECT_ID: "",
					...stableEnv,
				},
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => { stdout += chunk; });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.stdin.end(JSON.stringify(payload));
			const [code] = await once(child, "exit");
			const staged = await readdir(join(pluginData, "outbox", "v1", "staged"));
			expect(staged).toHaveLength(1);
			const aggregate = JSON.parse(await readFile(join(pluginData, "outbox", "v1", "staged", staged[0]), "utf8"));

			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(JSON.parse(stdout).systemMessage).toContain("queued locally");
			expect(aggregate.userId).toBeUndefined();
			expect(aggregate.memory_scope).toEqual(start.body.memoryScope);
			expect(aggregate.conversation_id).toMatch(/^claude_session_v1_[a-f0-9]{32}$/);
			expect(JSON.stringify(aggregate)).not.toContain("synthetic-a");
			expect(JSON.stringify(aggregate)).not.toContain("itsuki-project-identity-");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}, 10_000);

	it("passes ITSUKI_PROJECT_ID through both the hook scope and display metadata", async () => {
		const request = await captureHookRequest("session-start.mjs", { cwd: join(ROOT, "private", "atlas") }, {
			ITSUKI_PROJECT_ID: "explicit-atlas",
		});

		expect(request.code).toBe(0);
		expect(request.body.memoryScope).toMatchObject({
			projectId: "explicit-atlas",
			projectName: "atlas",
		});
		expect(JSON.stringify(request.body)).not.toContain("private");
	});
});
