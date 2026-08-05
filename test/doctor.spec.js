import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	credentialFingerprint,
	drainOutbox,
	enqueueSession,
	inspectOutbox,
} from "../hooks/outbox.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCTOR_HOOK = join(ROOT, "hooks", "doctor-hook.mjs");
const KEY = "itsuki_live_DOCTOR_HOOK_CANARY_82731";
const roots = new Set();
const services = new Set();

afterEach(async () => {
	await Promise.all([...services].map((service) => service.close()));
	services.clear();
	await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
	roots.clear();
});

async function fixture(label = "doctor") {
	const root = await mkdtemp(join(tmpdir(), `itsuki-${label}-`));
	const configRoot = join(root, "claude-config");
	const pluginData = join(configRoot, "plugins", "data", "itsuki");
	await mkdir(pluginData, { recursive: true });
	roots.add(root);
	return { root, configRoot, pluginData };
}

async function service({
	oversizedInitialize = false,
	recallBody = { ok: true, context: "" },
	recallContentType = "application/json",
	notificationStatus = 202,
	notificationBody = "",
	toolsCapability = {},
	toolCallIsError = false,
	initializeErrorNull = false,
	toolsListBatch = false,
	initializeContentType = "application/json",
	omitToolSchema = false,
	extraMalformedTool = false,
	toolsNextCursor,
	invalidToolProperties = false,
	invalidToolRequired = false,
	extraInvalidContent = false,
	malformedSsePrefix = false,
} = {}) {
	const requests = [];
	const sockets = new Set();
	const sessionId = "doctor-session-7f3d";
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		let body = null;
		try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch {}
		requests.push({
			method: request.method,
			url: request.url,
			authorization: request.headers.authorization,
			protocolVersion: request.headers["mcp-protocol-version"],
			sessionId: request.headers["mcp-session-id"],
			body,
		});

		if (request.method === "POST" && request.url === "/v1/recall") {
			response.writeHead(200, { "content-type": recallContentType });
			response.end(JSON.stringify(recallBody));
			return;
		}
		if (request.method === "DELETE" && request.url === "/mcp") {
			response.statusCode = 204;
			response.end();
			return;
		}
		if (request.method === "POST" && request.url === "/mcp") {
			if (body?.method === "initialize") {
				if (oversizedInitialize) {
					const oversized = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { padding: "x".repeat(300_000) } });
					response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(oversized) });
					response.end(oversized);
					return;
				}
				response.writeHead(200, { "content-type": initializeContentType, "mcp-session-id": sessionId });
				response.end(JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					...(initializeErrorNull ? { error: null } : {}),
					result: {
						protocolVersion: "2025-06-18",
						capabilities: { tools: toolsCapability },
						serverInfo: { name: "itsuki-test", version: "0.0.0-test" },
					},
				}));
				return;
			}
			if (request.headers["mcp-protocol-version"] !== "2025-06-18"
				|| request.headers["mcp-session-id"] !== sessionId) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false }));
				return;
			}
			if (body?.method === "notifications/initialized") {
				response.statusCode = notificationStatus;
				response.end(notificationBody);
				return;
			}
			if (body?.method === "tools/list") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				const actual = JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: ["save_memory", "save_conversation", "recall_memory"].map((name, index) => ({
							name,
							...(omitToolSchema && index === 0 ? {} : {
								inputSchema: {
									type: "object",
									properties: invalidToolProperties && index === 0 ? [] : {},
									...(invalidToolRequired && index === 0 ? { required: [7] } : {}),
								},
							}),
						})).concat(extraMalformedTool ? [{ name: "broken_extra" }] : []),
						...(toolsNextCursor === undefined ? {} : { nextCursor: toolsNextCursor }),
					},
				});
				response.end(toolsListBatch
					? `data: ${JSON.stringify([JSON.parse(actual)])}\n\n`
					: `${malformedSsePrefix ? "data: null\n\n" : ""}data: ${actual}\n\n`);
				return;
			}
			if (body?.method === "tools/call") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						content: [
							{ type: "text", text: "Doctor recall completed." },
							...(extraInvalidContent ? [{ type: "image", data: 7 }] : []),
						],
						structuredContent: { ok: true, memories: [] },
						...(toolCallIsError === false ? {} : { isError: toolCallIsError }),
					},
				}));
				return;
			}
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: false }));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	let closed = false;
	const result = {
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		async close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
	services.add(result);
	return result;
}

function run(script, args, { env = {}, input = null } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill(), 35_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
		child.stdin.end(input === null ? "" : JSON.stringify(input));
	});
}

function hookInput(commandArgs = "", overrides = {}) {
	return {
		hook_event_name: "UserPromptExpansion",
		expansion_type: "slash_command",
		command_name: "itsuki:doctor",
		command_args: commandArgs,
		command_source: "plugin",
		prompt: `/itsuki:doctor${commandArgs ? ` ${commandArgs}` : ""}`,
		...overrides,
	};
}

function runHook(data, baseUrl, { key = KEY, commandArgs = "", input = hookInput(commandArgs), extraEnv = {} } = {}) {
	return run(DOCTOR_HOOK, ["--plugin-data", data.pluginData, "--service-url-for-test", baseUrl], {
		env: {
			CLAUDE_CONFIG_DIR: data.configRoot,
			CLAUDE_PLUGIN_DATA: data.pluginData,
			CLAUDE_PLUGIN_ROOT: ROOT,
			CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: key,
			...extraEnv,
		},
		input,
	});
}

describe("trusted Itsuki doctor", () => {
	it("runs authenticated REST and the MCP lifecycle only inside UserPromptExpansion", async () => {
		const data = await fixture("doctor-hook-healthy");
		const endpoint = await service();
		const result = await runHook(data, endpoint.url);

		expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({ decision: "block" });
		expect(output.reason).toMatch(/^PASS  trusted invocation/m);
		expect(output.reason).toMatch(/^PASS  installed configuration/m);
		expect(output.reason).toMatch(/^PASS  authenticated REST/m);
		expect(output.reason).toMatch(/^PASS  MCP lifecycle/m);
		expect(output.reason).not.toMatch(/^FAIL /m);
		expect(output.reason).toMatch(/^All checks passed with \d+ warning\(s\)\.$/m);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("DOCTOR_HOOK_CANARY_82731");
		expect(endpoint.requests.filter(({ url }) => url === "/v1/recall")).toHaveLength(1);
		expect(endpoint.requests.filter(({ url }) => url === "/mcp").map(({ method, body }) => `${method}:${body?.method ?? "delete"}`)).toEqual([
			"POST:initialize",
			"POST:notifications/initialized",
			"POST:tools/list",
			"POST:tools/call",
			"DELETE:delete",
		]);
		for (const request of endpoint.requests) expect(request.authorization).toBe(`Bearer ${KEY}`);
	}, 30_000);

	it("does not probe the network when the sensitive hook credential is missing", async () => {
		const data = await fixture("doctor-no-key");
		const endpoint = await service();
		const result = await runHook(data, endpoint.url, { key: "" });

		expect(result.code).toBe(0);
		expect(endpoint.requests).toEqual([]);
		const reason = JSON.parse(result.stdout).reason;
		expect(reason).toMatch(/^FAIL  sensitive key/m);
		expect(reason).toMatch(/^SKIP  authenticated REST/m);
		expect(reason).toMatch(/^SKIP  MCP lifecycle/m);
	}, 30_000);

	it("binds only when the user directly types the exact trusted slash-command argument", async () => {
		const data = await fixture("doctor-bind");
		const endpoint = await service();
		await enqueueSession({
			pluginData: data.pluginData,
			messages: [{ id: "unbound-doctor", role: "user", content: "Protected unbound doctor test.", ts: 1_800_000_000_000 }],
			sessionId: "doctor-bind-session",
			memoryScope: { projectId: "doctor-bind" },
			credentialFingerprint: null,
		});

		await runHook(data, endpoint.url);
		let health = await inspectOutbox({ pluginData: data.pluginData, apiKey: KEY, baseUrl: endpoint.url });
		expect(health.bindingRequired).toBe(1);

		const bound = await runHook(data, endpoint.url, { commandArgs: "--bind-outbox" });
		health = await inspectOutbox({ pluginData: data.pluginData, apiKey: KEY, baseUrl: endpoint.url });
		expect(bound.code).toBe(0);
		expect(health).toMatchObject({ bindingRequired: 0, credentialMismatch: 0 });
		const reason = JSON.parse(bound.stdout).reason;
		expect(reason).toMatch(/^PASS  outbox binding -- 1 exact queued entry rebound/m);
		expect(reason).not.toMatch(/^FAIL /m);
		expect(reason).toMatch(/^All checks passed with \d+ warning\(s\)\.$/m);
		expect(endpoint.requests.some(({ url }) => url === "/v1/ingest")).toBe(false);
	}, 30_000);

	it("rejects spoofed bare-doctor expansion input without network or binding work", async () => {
		const data = await fixture("doctor-spoof");
		const endpoint = await service();
		const spoofed = await runHook(data, endpoint.url, {
			input: hookInput("--bind-outbox", { command_name: "doctor", prompt: "/doctor --bind-outbox" }),
		});

		expect(spoofed.code).toBe(0);
		expect(JSON.parse(spoofed.stdout).reason).toContain("command name, source, prompt, or arguments were not the exact");
		expect(endpoint.requests).toEqual([]);
		await expect(lstat(join(data.pluginData, "outbox"))).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	it("ignores inherited service origins and uses only the explicit test target", async () => {
		const data = await fixture("doctor-origin");
		const intended = await service();
		const attacker = await service();
		await runHook(data, intended.url, { extraEnv: { ITSUKI_BASE_URL: attacker.url } });

		expect(intended.requests.length).toBeGreaterThan(0);
		expect(attacker.requests).toEqual([]);
	}, 30_000);

	it("reports bounded DNS failure categories directly", async () => {
		const data = await fixture("doctor-dns");
		const result = await runHook(data, "https://doctor-dns-failure.invalid");

		expect(result.code).toBe(0);
		const reason = JSON.parse(result.stdout).reason;
		expect(reason).toMatch(/^FAIL  authenticated REST -- network_error/m);
		expect(reason).toMatch(/^FAIL  MCP lifecycle -- network_error/m);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("DOCTOR_HOOK_CANARY_82731");
	}, 30_000);

	it("rejects a syntactically valid REST body whose receipt says the operation failed", async () => {
		const data = await fixture("doctor-rest-contract");
		const endpoint = await service({ recallBody: { ok: false, context: "" } });
		const result = await runHook(data, endpoint.url);

		expect(JSON.parse(result.stdout).reason).toMatch(/^FAIL  authenticated REST -- http_error \(HTTP 200\)/m);
	}, 30_000);

	it("rejects a valid-looking REST receipt under a lookalike media type", async () => {
		const data = await fixture("doctor-rest-media-type");
		const endpoint = await service({ recallContentType: "application/json-seq" });
		const result = await runHook(data, endpoint.url);

		expect(JSON.parse(result.stdout).reason).toMatch(/^FAIL  authenticated REST -- http_error \(HTTP 200\)/m);
	}, 30_000);

	it.each([
		["wrong status", 200, ""],
		["nonempty body", 202, " "],
	])("rejects an initialized notification with $label", async (_label, notificationStatus, notificationBody) => {
		const data = await fixture(`doctor-notification-${notificationStatus}-${notificationBody.length}`);
		const endpoint = await service({ notificationStatus, notificationBody });
		const result = await runHook(data, endpoint.url);

		expect(JSON.parse(result.stdout).reason).toMatch(/^FAIL  MCP lifecycle -- protocol_error/m);
	}, 30_000);

	it("fails a bounded oversized MCP response without persisting its body", async () => {
		const data = await fixture("doctor-oversized");
		const endpoint = await service({ oversizedInitialize: true });
		const result = await runHook(data, endpoint.url);

		const reason = JSON.parse(result.stdout).reason;
		expect(reason).toMatch(/^PASS  authenticated REST/m);
		expect(reason).toMatch(/^FAIL  MCP lifecycle -- protocol_error/m);
		expect(result.stdout.length).toBeLessThan(4_000);
	}, 30_000);

	it.each([
		["null tools capability", { toolsCapability: null }],
		["non-boolean tools capability flag", { toolsCapability: { listChanged: "yes" } }],
		["contradictory tool error receipt", { toolCallIsError: true }],
		["non-boolean tool error marker", { toolCallIsError: "true" }],
		["result plus an error member", { initializeErrorNull: true }],
		["removed JSON-RPC batch response", { toolsListBatch: true }],
		["lookalike JSON media type", { initializeContentType: "application/json-seq" }],
		["missing tool input schema", { omitToolSchema: true }],
		["malformed extra tool", { extraMalformedTool: true }],
		["invalid tools cursor", { toolsNextCursor: 7 }],
		["invalid tool properties", { invalidToolProperties: true }],
		["invalid tool required list", { invalidToolRequired: true }],
		["invalid extra recall content", { extraInvalidContent: true }],
		["malformed extra SSE event", { malformedSsePrefix: true }],
	])("rejects a false-success MCP contract with %s", async (_label, options) => {
		const data = await fixture("doctor-mcp-false-success");
		const endpoint = await service(options);
		const result = await runHook(data, endpoint.url);

		expect(JSON.parse(result.stdout).reason).toMatch(/^FAIL  MCP lifecycle -- protocol_error/m);
	}, 30_000);

	it("surfaces an active delivery authentication pause even when read probes pass", async () => {
		const data = await fixture("doctor-auth-block");
		const endpoint = await service();
		await enqueueSession({
			pluginData: data.pluginData,
			messages: [{ id: "auth-block", role: "user", content: "Retain on rejected key.", ts: 1_800_000_000_000 }],
			sessionId: "doctor-auth-block",
			memoryScope: { projectId: "doctor-auth" },
			credentialFingerprint: credentialFingerprint(KEY, endpoint.url),
		});
		await drainOutbox({
			pluginData: data.pluginData,
			apiKey: KEY,
			baseUrl: endpoint.url,
			fetchFn: async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
		});
		const result = await runHook(data, endpoint.url);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).reason).toMatch(/^FAIL  delivery authentication pause/m);
	}, 30_000);
});
