import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	ITSUKI_LEGACY_RECALL_PREFIXES,
	formatItsukiRecallContext,
} from "../hooks/claude-transcript.mjs";
import {
	DEFAULT_DELIVERY_BASE_URL,
	credentialFingerprint,
	persistRecallEchoGuard,
	readRecallEchoGuard,
} from "../hooks/outbox.mjs";
import {
	RECALL_ECHO_MAX_SESSIONS,
	RECALL_ECHO_STORE_FILENAME,
	RECALL_ECHO_STORE_SCHEMA,
	updateRecallEchoStore,
} from "../hooks/recall-echo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_END = join(ROOT, "hooks", "session-end.mjs");
const CLAUDE_SESSION_END_BUDGET_MS = 1_500;

function seedSecurityRunner(root, mode) {
	if (process.platform !== "win32") {
		return Promise.resolve({ ok: true, protected: true, guard_trusted: true });
	}
	return new Promise((resolvePromise, reject) => {
		const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
		const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const helper = join(ROOT, "hooks", "outbox-security.ps1");
		const child = spawn(powershell, [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
			"-File", helper, "-Path", root, "-Mode", mode,
		], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill(), 8_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`test ACL seed failed: ${stderr.trim() || `exit ${code}`}`));
				return;
			}
			try { resolvePromise(JSON.parse(stdout)); }
			catch (error) { reject(error); }
		});
	});
}

async function fixture({ transcriptContents, seedNoContext = true } = {}) {
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
			message: { content: "I decided to keep the durable session-end outcome even when the network is unavailable." },
		})}\n`, "utf8"),
	]);
	if (seedNoContext) {
		const guard = await persistRecallEchoGuard({
			pluginData,
			sessionId: "session-end-delivery-regression",
			context: "",
			allowCreate: true,
			securityRunner: seedSecurityRunner,
		});
		if (guard.status !== "no_context" || guard.persisted !== true) {
			throw new Error("failed to seed the explicit no-context SessionEnd guard");
		}
	}
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

function assistantDecisionTranscript(content) {
	return `${JSON.stringify({
		type: "assistant",
		uuid: "assistant-recall-guard-regression",
		timestamp: "2026-08-05T00:00:00.000Z",
		message: { content },
	})}\n`;
}

describe("SessionEnd host-budget delivery", () => {
	it("allows assistant durable prose only when a fresh explicit no-context guard exists", async () => {
		const content = "Architecture decision: keep the explicit no-context capture path enabled.";
		const data = await fixture({ transcriptContents: assistantDecisionTranscript(content) });
		try {
			expect(await readRecallEchoGuard({
				pluginData: data.pluginData,
				sessionId: data.payload.session_id,
			})).toEqual({ status: "no_context", fingerprints: [] });

			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const staged = await readStagedGroup(data.pluginData);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(staged.messages).toEqual([
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining(content),
				}),
			]);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it.each(["missing", "deleted", "evicted"])(
		"fails closed for assistant prose when the session guard is %s",
		async (condition) => {
			const content = `Architecture decision: ${condition} recall guards must fail closed.`;
			const data = await fixture({
				transcriptContents: assistantDecisionTranscript(content),
				seedNoContext: condition !== "missing",
			});
			const sidecarPath = join(
				data.pluginData,
				"outbox",
				"v1",
				"control",
				RECALL_ECHO_STORE_FILENAME,
			);
			try {
				if (condition === "deleted") {
					await rm(sidecarPath, { force: true });
				} else if (condition === "evicted") {
					let store = { schema: RECALL_ECHO_STORE_SCHEMA, sessions: [] };
					store = updateRecallEchoStore(store, {
						sessionId: data.payload.session_id,
						status: "no_context",
					});
					for (let index = 0; index < RECALL_ECHO_MAX_SESSIONS; index += 1) {
						store = updateRecallEchoStore(store, {
							sessionId: `newer-session-${index}`,
							status: "no_context",
						});
					}
					expect(store.sessions).toHaveLength(RECALL_ECHO_MAX_SESSIONS);
					await writeFile(sidecarPath, JSON.stringify(store), "utf8");
					expect(await readRecallEchoGuard({
						pluginData: data.pluginData,
						sessionId: data.payload.session_id,
					})).toEqual({ status: "missing", fingerprints: [] });
				}

				const result = await runSessionEnd({
					baseUrl: await unusedLocalEndpoint(),
					payload: data.payload,
					pluginData: data.pluginData,
				});

				expect(result).toMatchObject({ code: 0, hostTerminated: false });
				expect(JSON.parse(result.stdout).systemMessage).toContain("assistant-authored prose was excluded");
				expect(await stagedGroups(data.pluginData)).toEqual([]);
			} finally {
				await rm(data.root, { recursive: true, force: true });
			}
		},
		10_000,
	);

	it.runIf(process.platform === "win32")(
		"fails closed for assistant prose after repairing recall-guard ACL drift",
		async () => {
			const content = "Architecture decision: a drifted guard must never authorize assistant prose.";
			const data = await fixture({ transcriptContents: assistantDecisionTranscript(content) });
			const guardPath = join(
				data.pluginData,
				"outbox",
				"v1",
				"control",
				RECALL_ECHO_STORE_FILENAME,
			);
			try {
				const broadened = spawnSync("icacls.exe", [guardPath, "/grant", "*S-1-1-0:(F)"], {
					encoding: "utf8",
					windowsHide: true,
				});
				expect(broadened.status, broadened.stderr || broadened.stdout).toBe(0);

				const result = await runSessionEnd({
					baseUrl: await unusedLocalEndpoint(),
					payload: data.payload,
					pluginData: data.pluginData,
				});

				expect(result).toMatchObject({ code: 0, hostTerminated: false });
				expect(JSON.parse(result.stdout).systemMessage).toContain("assistant-authored prose was excluded");
				expect(await stagedGroups(data.pluginData)).toEqual([]);
			} finally {
				await rm(data.root, { recursive: true, force: true });
			}
		},
		10_000,
	);

	it("reports an all-orphan tool outcome as explicitly not queued", async () => {
		const transcriptContents = JSON.stringify({
			type: "user",
			uuid: "orphan-session-end-result",
			message: { content: [{ type: "tool_result", tool_use_id: "missing-session-end-call", content: "done" }] },
		});
		const data = await fixture({ transcriptContents });
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			const output = JSON.parse(result.stdout);
			expect(output.systemMessage).toContain("NOT queued locally");
			expect(output.systemMessage).toContain("call identity or dependency closure was not safe");
			expect(await stagedGroups(data.pluginData)).toEqual([]);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("records ambiguity evidence when another durable event is queued", async () => {
		const toolUseId = "toolu_mixed_ambiguous_session_end";
		const decision = "I decided to keep the safe mixed-capture outcome.";
		const transcriptContents = [
			JSON.stringify({
				type: "assistant",
				uuid: "mixed-ambiguous-call-one",
				message: { content: [{ type: "tool_use", id: toolUseId, name: "Write", input: { file_path: "src/one.ts" } }] },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "mixed-ambiguous-call-two",
				message: { content: [{ type: "tool_use", id: toolUseId, name: "Write", input: { file_path: "src/two.ts" } }] },
			}),
			JSON.stringify({
				type: "user",
				uuid: "mixed-ambiguous-result",
				message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }] },
			}),
			JSON.stringify({
				type: "user",
				uuid: "mixed-safe-decision",
				message: { content: decision },
			}),
		].join("\n");
		const data = await fixture({ transcriptContents });
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const output = JSON.parse(result.stdout);
			const staged = await readStagedGroup(data.pluginData);

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(output.systemMessage).toContain("excluded because its call identity was ambiguous");
			expect(staged.messages).toEqual([
				expect.objectContaining({ content: expect.stringContaining(decision) }),
			]);
			expect(staged.capture).toMatchObject({
				captureTruncated: true,
				truncationReason: "ambiguous_tool_result",
				captureEvidence: expect.objectContaining({ ambiguousOutcomeRows: 1 }),
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("reports a newly omitted orphan outcome when the safe payload is already queued", async () => {
		const decision = "I decided to keep duplicate snapshots content-stable.";
		const safeRow = JSON.stringify({
			type: "user",
			uuid: "duplicate-omission-safe-decision",
			timestamp: "2026-08-05T00:00:00.000Z",
			message: { content: decision },
		});
		const orphanRow = JSON.stringify({
			type: "user",
			uuid: "duplicate-omission-orphan-result",
			message: { content: [{ type: "tool_result", tool_use_id: "missing-duplicate-call", content: "done" }] },
		});
		const data = await fixture({ transcriptContents: `${safeRow}\n` });
		try {
			const baseUrl = await unusedLocalEndpoint();
			const first = await runSessionEnd({
				baseUrl,
				payload: data.payload,
				pluginData: data.pluginData,
			});
			expect(first).toMatchObject({ code: 0, hostTerminated: false });
			expect(JSON.parse(first.stdout).systemMessage).toContain("queued locally");

			await writeFile(
				data.payload.transcript_path,
				`${safeRow}\n${orphanRow}\n`,
				"utf8",
			);
			const replay = await runSessionEnd({
				baseUrl,
				payload: data.payload,
				pluginData: data.pluginData,
			});
			const output = JSON.parse(replay.stdout);
			const staged = await readStagedGroup(data.pluginData);

			expect(replay).toMatchObject({ code: 0, hostTerminated: false });
			expect(output.systemMessage).toContain("already queued locally");
			expect(output.systemMessage).toContain("excluded because its call identity was ambiguous");
			expect(staged.messages).toEqual([
				expect.objectContaining({ content: expect.stringContaining(decision) }),
			]);
			// Capture evidence describes the immutable first queued snapshot. The
			// current run's later omission is surfaced in the hook status above.
			expect(staged.capture).toMatchObject({
				captureTruncated: false,
				truncationReason: null,
				captureEvidence: expect.objectContaining({ ambiguousOutcomeRows: 0 }),
			});
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 15_000);

	it("queues nothing when the transcript contains only recalled context and ineligible private/meta rows", async () => {
		const transcriptContents = [
			JSON.stringify({
				type: "user",
				uuid: "plugin-recall-current",
				message: { content: formatItsukiRecallContext("Private recalled project context must not feed back.") },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "plugin-recall-legacy",
				message: { content: `${ITSUKI_LEGACY_RECALL_PREFIXES[0]}legacy project: do not feed back` },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "private-thinking-only",
				message: { content: [{ type: "thinking", thinking: "unsupported private reasoning" }] },
			}),
			JSON.stringify({ type: "system", message: { content: "host system context" } }),
			JSON.stringify({ type: "meta", message: { content: "plugin metadata" } }),
			JSON.stringify({
				type: "assistant",
				uuid: "unknown-block-only",
				message: { content: [{ type: "future_unknown", value: "unknown payload" }] },
			}),
		].join("\n");
		const data = await fixture({ transcriptContents });
		try {
			const result = await runSessionEnd({
				baseUrl: await unusedLocalEndpoint(),
				payload: data.payload,
				pluginData: data.pluginData,
			});

			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(JSON.parse(result.stdout)).toEqual({});
			expect(await stagedGroups(data.pluginData)).toEqual([]);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 5_000);

	it("derives one bounded event spool from a near-8 MiB transcript without retaining raw prose", async () => {
		const rows = Array.from({ length: 32 }, (_, index) => JSON.stringify({
			type: "assistant",
			uuid: `host-event-near-limit-${index}`,
			timestamp: `2026-08-05T00:00:${String(index).padStart(2, "0")}.000Z`,
			message: {
				content: `Architecture decision ${String(index).padStart(2, "0")}: ${"x".repeat((250 * 1024) - 96)}:FINAL-OUTCOME-${index}`,
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
			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			expect(result.elapsedMs).toBeLessThan(CLAUDE_SESSION_END_BUDGET_MS);
			const staged = await readStagedGroup(data.pluginData);
			const pending = await readdir(join(data.pluginData, "outbox", "v1", "pending"));
			const manifests = await readdir(join(data.pluginData, "outbox", "v1", "groups"));
			expect(staged.schema).toBe("itsuki.outbox-staged-group/v2");
			expect(staged.messages).toHaveLength(32);
			expect(staged.messages.every((message) => Array.from(message.content).length <= 1_200)).toBe(true);
			expect(staged.messages.every((message) => message.source_event?.truncated === true)).toBe(true);
			expect(staged.messages.at(-1).content).toContain("FINAL-OUTCOME-31");
			expect(Buffer.byteLength(JSON.stringify(staged), "utf8")).toBeLessThan(64 * 1024);
			expect(JSON.stringify(staged)).not.toContain("[Itsuki segment ");
			expect(pending).toEqual([]);
			expect(manifests).toEqual([]);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("queues the final durable event from behind a huge early line within the 1.5s host budget", async () => {
		const hugeEarlyMarker = "HUGE_EARLY_PROGRESS_MUST_NOT_BE_QUEUED";
		const finalContent = "I decided to keep the final durable event even when an early transcript row is enormous.";
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
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining(finalContent),
					source_event: expect.objectContaining({
						schema: "itsuki.source-event/v1",
						kind: "decision",
					}),
				}),
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
			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			const envelope = await readStagedGroup(data.pluginData);
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
			expect(result).toMatchObject({ code: 0, hostTerminated: false });
			const envelope = await readStagedGroup(data.pluginData);
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
