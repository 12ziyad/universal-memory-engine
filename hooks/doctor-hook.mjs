/**
 * Trusted /itsuki:doctor expansion hook. Claude exports sensitive userConfig
 * only to hook processes, so authenticated checks and explicit rebinding live
 * here, never in an untrusted shell or model-generated command.
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { probeMcp } from "./mcp-diagnostic.mjs";
import { validatePluginContract } from "./plugin-contract.mjs";
import {
	DEFAULT_DELIVERY_BASE_URL,
	bindOutbox,
	normalizeDeliveryBaseUrl,
	openHookDiagnostic,
	pluginDataFromArgs,
	validItsukiApiKey,
} from "./outbox.mjs";

const API_KEY = process.env.CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY;
const MAX_INPUT_BYTES = 64 * 1024;

function explicitServiceUrl(argv = process.argv.slice(2)) {
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--service-url-for-test") return argv[index + 1];
		if (String(argv[index]).startsWith("--service-url-for-test=")) {
			return String(argv[index]).slice("--service-url-for-test=".length);
		}
	}
	return DEFAULT_DELIVERY_BASE_URL;
}

async function readInput() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > MAX_INPUT_BYTES) return null;
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

async function staticConfigEvidence() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	try {
		const [manifest, hooks, legacyMcpPresent] = await Promise.all([
			readFile(resolve(root, ".claude-plugin", "plugin.json"), "utf8").then(JSON.parse),
			readFile(resolve(root, "hooks", "hooks.json"), "utf8").then(JSON.parse),
			lstat(resolve(root, ".mcp.json")).then(
				() => true,
				(error) => error?.code === "ENOENT" ? false : Promise.reject(error),
			),
		]);
		return validatePluginContract({ manifest, registered: hooks, legacyMcpPresent });
	} catch {
		return false;
	}
}

async function rootEvidence() {
	const executing = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const executingReal = await realpath(executing).catch(() => null);
	const advertised = process.env.CLAUDE_PLUGIN_ROOT;
	const advertisedReal = advertised ? await realpath(resolve(advertised)).catch(() => null) : null;
	const matches = Boolean(executingReal && advertisedReal && (
		process.platform === "win32"
			? executingReal.toLowerCase() === advertisedReal.toLowerCase()
			: executingReal === advertisedReal
	));
	return { matches };
}

async function boundedRecall(baseUrl) {
	let response;
	try {
		response = await fetch(`${baseUrl}/v1/recall`, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(2_000),
			headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({
				query: "Itsuki doctor connection check",
				memoryScope: { projectId: "itsuki_doctor", projectName: "Itsuki doctor", appId: "claude-code-plugin" },
				recallScope: "project_then_global",
			}),
		});
	} catch {
		return { outcome: "network_error", httpStatus: null };
	}
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel().catch(() => {});
		return { outcome: "credential_rejected", httpStatus: response.status };
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return { outcome: "http_error", httpStatus: response.status };
	}
	if (String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
		await response.body?.cancel().catch(() => {});
		return { outcome: "http_error", httpStatus: response.status };
	}
	const announced = Number(response.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > 256 * 1024) {
		await response.body?.cancel().catch(() => {});
		return { outcome: "http_error", httpStatus: response.status };
	}
	let total = 0;
	const chunks = [];
	if (!response.body?.getReader) return { outcome: "http_error", httpStatus: response.status };
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > 256 * 1024) {
				await reader.cancel().catch(() => {});
				return { outcome: "http_error", httpStatus: response.status };
			}
			chunks.push(Buffer.from(value));
		}
	} catch {
		return { outcome: "network_error", httpStatus: null };
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	try {
		const data = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
		if (!data || typeof data !== "object" || data.ok !== true || typeof data.context !== "string") {
			return { outcome: "http_error", httpStatus: response.status };
		}
	} catch {
		return { outcome: "http_error", httpStatus: response.status };
	}
	return { outcome: "ok", httpStatus: response.status };
}

function blocked(reason) {
	return { decision: "block", reason };
}

function transientHttpStatus(status) {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function restFailureDetail(result) {
	const status = result.httpStatus ? ` (HTTP ${result.httpStatus})` : "";
	if (result.outcome === "credential_rejected") {
		return `credential_rejected${status}; update itsuki_api_key through /plugin and reload Claude Code`;
	}
	if (result.outcome === "network_error") {
		return "network_error; check DNS, proxy/TLS interception, and connectivity to https://itsuki.app";
	}
	if (transientHttpStatus(result.httpStatus)) {
		return `http_error${status}; wait for the service or rate-limit window, then retry`;
	}
	return `http_error${status}; retry once, then update or reinstall the plugin if the response contract still fails`;
}

function mcpFailureDetail(result) {
	const status = result.httpStatus ? ` (HTTP ${result.httpStatus})` : "";
	if (result.outcome === "credential_rejected") {
		return `credential_rejected${status}; update itsuki_api_key through /plugin, reload, then verify plugin:itsuki in /mcp`;
	}
	if (result.outcome === "network_error") {
		return "network_error; check DNS, proxy/TLS interception, and connectivity to https://itsuki.app";
	}
	if (transientHttpStatus(result.httpStatus)) {
		return `protocol_error${status}; wait for the service or rate-limit window, then retry`;
	}
	return `protocol_error${status}; update or reinstall the plugin, reload, then verify plugin:itsuki in /mcp`;
}

async function main() {
	const input = await readInput();
	const pluginData = pluginDataFromArgs();
	let baseUrl = null;
	try { baseUrl = normalizeDeliveryBaseUrl(explicitServiceUrl()); } catch {}
	const commandAllowed = input?.hook_event_name === "UserPromptExpansion"
		&& input?.expansion_type === "slash_command"
		&& input?.command_source === "plugin"
		&& ["doctor", "itsuki:doctor"].includes(input?.command_name)
		&& typeof input?.prompt === "string"
		&& /^\/itsuki:doctor(?:\s+--bind-outbox)?\s*$/.test(input.prompt);
	const commandArgs = typeof input?.command_args === "string" ? input.command_args.trim() : "";
	const bindRequested = commandArgs === "--bind-outbox";
	const argumentsValid = (commandArgs === "" || bindRequested)
		&& input?.prompt.trim() === `/itsuki:doctor${bindRequested ? " --bind-outbox" : ""}`;
	if (!pluginData || !baseUrl) {
		return blocked("FAIL  trusted doctor hook -- invalid plugin-data path or service target; no binding or network request was performed.");
	}
	if (!commandAllowed || !argumentsValid) {
		return blocked("FAIL  trusted doctor hook -- the command name, source, prompt, or arguments were not the exact user-typed /itsuki:doctor contract; no binding or network request was performed.");
	}
	const diagnostic = await openHookDiagnostic({ pluginData });

	const keyValid = validItsukiApiKey(API_KEY);
	let bindOutcome = "not_requested";
	let boundCount = 0;
	if (bindRequested) {
		if (!keyValid) bindOutcome = "invalid_key";
		else {
			try {
				const result = await bindOutbox({ pluginData, apiKey: API_KEY, baseUrl });
				bindOutcome = "bound";
				boundCount = result.bound;
			} catch {
				bindOutcome = "failed";
			}
		}
	}

	let health = null;
	try { health = await diagnostic.inspect({ apiKey: API_KEY, baseUrl }); } catch {}
	const [root, staticConfigOk, recall, mcp] = await Promise.all([
		rootEvidence(),
		staticConfigEvidence(),
		keyValid ? boundedRecall(baseUrl) : { outcome: "skipped", httpStatus: null },
		keyValid ? probeMcp({ apiKey: API_KEY, baseUrl }) : { outcome: "skipped", toolsValid: false },
	]);
	let failures = 0;
	let warnings = 0;
	const lines = [];
	const pass = (name, detail) => lines.push(`PASS  ${name} -- ${detail}`);
	const fail = (name, detail) => { failures += 1; lines.push(`FAIL  ${name} -- ${detail}`); };
	const warn = (name, detail) => { warnings += 1; lines.push(`WARN  ${name} -- ${detail}`); };
	const skip = (name, detail) => lines.push(`SKIP  ${name} -- ${detail}`);
	pass("trusted invocation", "user-typed Itsuki plugin command reached UserPromptExpansion");
	if ([22, 24].includes(Number(process.versions.node.split(".")[0]))) pass("Node runtime", `Node ${process.versions.node} from the configured absolute executable`);
	else fail("Node runtime", `Node ${process.versions.node} is unsupported; select Node 22 or 24 LTS through /plugin`);
	if (root.matches) pass("installed plugin root", "CLAUDE_PLUGIN_ROOT matches this executing plugin copy");
	else fail("installed plugin root", "CLAUDE_PLUGIN_ROOT is missing or points at another copy; reload or reinstall the plugin");
	if (staticConfigOk) pass("installed configuration", "manifest, sensitive userConfig, MCP target, and hook registration are exact");
	else fail("installed configuration", "manifest or hook registration differs from the reviewed plugin; update or reinstall");
	if (baseUrl === DEFAULT_DELIVERY_BASE_URL) pass("service target", "installed hook uses the fixed https://itsuki.app origin");
	else warn("service target", "explicit loopback/development target used; this does not prove production");
	if (keyValid) pass("sensitive key", "trusted hook received a header-safe plugin credential (value hidden)");
	else fail("sensitive key", "trusted hook did not receive a valid key; configure itsuki_api_key through /plugin and reload");
	if (!health) fail("protected outbox", "metadata inspection failed; queued content was not deleted");
	else if (health.corruptEntries > 0 || health.permanentFailures > 0) {
		fail("protected outbox", `${health.corruptEntries} corrupt and ${health.permanentFailures} intervention entries; content remains protected`);
	} else pass("protected outbox", `${health.counts.pending} pending, ${health.counts.inflight} inflight, ${health.counts.failed} failed, ${health.counts.tmp} temporary, ${health.rawBytes} raw bytes, no corrupt entries`);
	if (bindRequested) {
		if (bindOutcome === "bound") pass("outbox binding", `${boundCount} exact queued entr${boundCount === 1 ? "y" : "ies"} rebound to the active key`);
		else fail("outbox binding", `${bindOutcome}; no unconfirmed fallback binding was attempted`);
	} else if (health?.bindingRequired > 0) {
		fail("outbox binding", `${health.bindingRequired} queued entr${health.bindingRequired === 1 ? "y needs" : "ies need"} confirmation; verify the account, then type /itsuki:doctor --bind-outbox`);
	}
	if (health?.authBlocked) fail("delivery authentication pause", "a prior 401/403 is still pausing delivery; confirm the account and use the explicit bind command or retry after the cooldown");
	if (!keyValid) {
		skip("authenticated REST", "blocked by missing or invalid plugin key");
		skip("MCP lifecycle", "blocked by missing or invalid plugin key");
	} else {
		if (recall.outcome === "ok") pass("authenticated REST", `account-root recall answered HTTP ${recall.httpStatus}`);
		else fail("authenticated REST", restFailureDetail(recall));
		if (mcp.outcome === "ok" && mcp.toolsValid) pass("MCP lifecycle", "initialize, initialized, tools/list, and harmless recall_memory passed");
		else fail("MCP lifecycle", mcpFailureDetail(mcp));
	}
	warn("live Claude registry", "confirm plugin:itsuki in /mcp and Itsuki hooks in /hooks; plugins cannot introspect those rendered UI panels");
	lines.push("");
	lines.push(failures
		? `${failures} check(s) failed; ${warnings} warning(s). No queued content was deleted.`
		: `All checks passed with ${warnings} warning(s).`);
	return blocked(lines.join("\n"));
}

let result;
try { result = await main(); }
catch { result = blocked("FAIL  trusted doctor hook -- diagnostic execution failed safely; no queued content was discarded."); }
process.stdout.write(JSON.stringify(result));
process.exitCode = 0;
