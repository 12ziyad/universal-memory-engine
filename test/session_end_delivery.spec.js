import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_DELIVERY_BASE_URL, credentialFingerprint } from "../hooks/outbox.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_END = join(ROOT, "hooks", "session-end.mjs");
const CLAUDE_SESSION_END_BUDGET_MS = 1_500;

async function fixture({ transcriptContents } = {}) {
	const root = await mkdtemp(join(tmpdir(), "itsuki-session-end-delivery-"));
	const configRoot = join(root, "claude-config");
	const pluginData = join(configRoot, "plugins", "data", "itsuki");
	const projectDir = join(root, "project");
	const transcriptPath = join(root, "transcript.jsonl");
	await Promise.all([
		mkdir(pluginData, { recursive: true }),
		mkdir(projectDir, { recursive: true }),
		writeFile(transcriptPath, transcriptContents ?? `${JSON.stringify({
			type: "user",
			uuid: "host-event-durable-decision",
			timestamp: "2026-08-05T00:00:00.000Z",
			message: { content: "Keep the durable session-end decision even when the network is unavailable." },
		})}\n`, "utf8"),
	]);
	return {
		root,
		configRoot,
		pluginData,
		payload: {
			cwd: projectDir,
			session_id: "session-end-delivery-regression",
			transcript_path: transcriptPath,
		},
	};
}

function runSessionEnd({
	baseUrl,
	payload,
	pluginData,
	budgetMs = CLAUDE_SESSION_END_BUDGET_MS,
	pluginKey = "itsuki_live_session_end_regression",
	legacyKey = "",
	explicitService = true,
}) {
	return new Promise((resolve, reject) => {
		const startedAt = performance.now();
		let stdout = "";
		let stderr = "";
		let hostTerminated = false;
		const env = {
			...process.env,
			CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: pluginKey,
			ITSUKI_API_KEY: legacyKey,
			CLAUDE_PLUGIN_DATA: pluginData,
			CLAUDE_CONFIG_DIR: join(pluginData, "..", "..", ".."),
			CLAUDE_PROJECT_DIR: payload.cwd,
			ITSUKI_BASE_URL: baseUrl,
			ITSUKI_PROJECT_ID: "session-end-regression-project",
			ITSUKI_TIMEOUT_MS: "10000",
		};
		if (pluginKey === null) delete env.CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY;
		const args = [SESSION_END];
		if (explicitService) args.push("--service-url-for-test", baseUrl);
		const child = spawn(process.execPath, args, {
			cwd: ROOT,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });

		const hostTimer = setTimeout(() => {
			hostTerminated = true;
			child.kill();
		}, budgetMs);
		child.once("error", (error) => {
			clearTimeout(hostTimer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(hostTimer);
			resolve({
				code,
				signal,
				hostTerminated,
				elapsedMs: Math.round(performance.now() - startedAt),
				stdout,
				stderr,
			});
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

async function stagedGroups(pluginData) {
	try {
		return (await readdir(join(pluginData, "outbox", "v1", "staged")))
			.filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function readStagedGroup(pluginData) {
	const names = await stagedGroups(pluginData);
	expect(names).toHaveLength(1);
	return JSON.parse(await readFile(join(pluginData, "outbox", "v1", "staged", names[0]), "utf8"));
}

function expectAtMostOneJsonDocument(stdout) {
	const output = stdout.trim();
	if (!output) return;
	const parsed = JSON.parse(output);
	expect(parsed).toEqual(expect.any(Object));
}

async function slowEndpoint() {
	let requestCount = 0;
	const sockets = new Set();
	const server = createServer(() => {
		requestCount += 1;
		// Intentionally never acknowledge: the host budget, not the hook's
		// optimistic HTTP timeout, is the contract this regression exercises.
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		requestCount: () => requestCount,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

async function unusedLocalEndpoint() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${server.address().port}`;
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return url;
}

describe("SessionEnd host-budget delivery", () => {
	it("spools a near-8 MiB valid capture once without eager segmentation or dozens of fsyncs", async () => {
		const rows = Array.from({ length: 32 }, (_, index) => JSON.stringify({
			type: index % 2 === 0 ? "user" : "assistant",
			uuid: `host-event-near-limit-${index}`,
			timestamp: `2026-08-05T00:00:${String(index).padStart(2, "0")}.000Z`,
			message: {
				content: `${String(index).padStart(2, "0")}:${"x".repeat((250 * 1024) - 64)}:FINAL-OUTCOME-${index}`,
			},
		}));
		const transcriptContents = `${rows.join("\n")}\n`;
		expect(Buffer.byteLength(transcriptContents, "utf8")).toBeGreaterThan(7.5 * 1024 * 1024);
		expect(rows.every((row) => Buffer.byteLength(row, "utf8") < 256 * 1024)).toBe(true);
		const data = await fixture({ transcriptContents });
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const staged = await readStagedGroup(data.pluginData);
			const pending = await readdir(join(data.pluginData, "outbox", "v1", "pending"));
			const manifests = await readdir(join(data.pluginData, "outbox", "v1", "groups"));

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(result.elapsedMs).toBeLessThan(CLAUDE_SESSION_END_BUDGET_MS);
			expect(staged.schema).toBe("itsuki.outbox-staged-group/v1");
			expect(staged.messages).toHaveLength(32);
			expect(staged.messages.at(-1).content).toContain("FINAL-OUTCOME-31");
			expect(JSON.stringify(staged)).not.toContain("[Itsuki segment ");
			expect(pending).toEqual([]);
			expect(manifests).toEqual([]);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("queues the final durable event from behind a huge early line within the 1.5s host budget", async () => {
		const hugeEarlyMarker = "HUGE_EARLY_PROGRESS_MUST_NOT_BE_QUEUED";
		const finalContent = "Keep the final durable event even when an early transcript row is enormous.";
		const hugeEarlyLine = JSON.stringify({
			type: "progress",
			payload: `${hugeEarlyMarker}:${"x".repeat((8 * 1024 * 1024) + (512 * 1024))}`,
		});
		const finalLine = JSON.stringify({
			type: "user",
			uuid: "host-event-after-huge-early-line",
			timestamp: "2026-08-05T00:00:01.000Z",
			message: { content: finalContent },
		});
		const data = await fixture({ transcriptContents: `${hugeEarlyLine}\n${finalLine}\n` });
		const endpoint = await slowEndpoint();
		try {
			const result = await runSessionEnd({
				baseUrl: endpoint.url,
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const output = JSON.parse(result.stdout);
			const envelope = await readStagedGroup(data.pluginData);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(result.elapsedMs).toBeLessThan(CLAUDE_SESSION_END_BUDGET_MS);
			expect(endpoint.requestCount()).toBe(0);
			expect(envelope.messages).toEqual([
				expect.objectContaining({ role: "user", content: finalContent }),
			]);
			expect(JSON.stringify(envelope)).not.toContain(hugeEarlyMarker);
			expect(output.systemMessage).toContain("The bounded shutdown snapshot omitted older records");
			expect(output.systemMessage).toContain("1 record larger than the 256 KiB line-safety limit");
			expect(output.systemMessage).toContain("the source transcript was not modified");
			expect(envelope.capture).toMatchObject({
				captureTruncated: true,
				truncationReason: "max_bytes",
			});
		} finally {
			await endpoint.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("hands slow-endpoint work to a durable local envelope before Claude's 1.5s budget", async () => {
		const data = await fixture();
		const endpoint = await slowEndpoint();
		try {
			const result = await runSessionEnd({
				baseUrl: endpoint.url,
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const pending = await stagedGroups(data.pluginData);
			expectAtMostOneJsonDocument(result.stdout);

			expect({
				code: result.code,
				hostTerminated: result.hostTerminated,
				requestCount: endpoint.requestCount(),
				pendingEnvelopeCount: pending.length,
			}).toEqual({
				code: 0,
				hostTerminated: false,
				requestCount: 0,
				pendingEnvelopeCount: 1,
			});
			expect(result.elapsedMs).toBeLessThan(CLAUDE_SESSION_END_BUDGET_MS);
		} finally {
			await endpoint.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 5_000);

	it("preserves the envelope when delivery is offline instead of reporting an unrecoverable loss", async () => {
		const data = await fixture();
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});
			expectAtMostOneJsonDocument(result.stdout);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(await stagedGroups(data.pluginData)).toHaveLength(1);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 5_000);

	it("does not bind hooks with a legacy environment key that the installed MCP server ignores", async () => {
		const data = await fixture();
		const legacyKey = "itsuki_live_legacy_hook_key_must_not_bind";
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
				pluginKey: null,
				legacyKey,
			});
			const envelope = await readStagedGroup(data.pluginData);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(JSON.parse(result.stdout).systemMessage).toContain("not bound to a valid key");
			expect(envelope.credential_fingerprint).toBeNull();
			expect(JSON.stringify(envelope)).not.toContain(legacyKey);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 5_000);

	it("ignores an inherited service URL and binds installed hooks only to the manifest origin", async () => {
		const data = await fixture();
		const endpoint = await slowEndpoint();
		try {
			const result = await runSessionEnd({
				baseUrl: endpoint.url,
				payload: data.payload,
				pluginData: data.pluginData,
				explicitService: false,
			});
			const envelope = await readStagedGroup(data.pluginData);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(endpoint.requestCount()).toBe(0);
			expect(envelope.credential_fingerprint).toBe(credentialFingerprint(
				"itsuki_live_session_end_regression",
				DEFAULT_DELIVERY_BASE_URL,
			));
		} finally {
			await endpoint.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 5_000);
});
