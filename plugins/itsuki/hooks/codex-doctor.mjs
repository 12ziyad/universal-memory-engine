/**
 * Codex diagnostics (closes CDX-03).
 *
 * The Claude adapter has `/itsuki:doctor` because Claude plugins can register a
 * slash command. Codex plugins register hooks, not commands, so there is no
 * in-session surface to hang a doctor on — which left a Codex user with no way
 * to answer "is this working, and if not, which part?" other than reading
 * source. The honest shape for that host is a script the user runs directly:
 *
 *     node <plugin-root>/hooks/codex-doctor.mjs
 *     node <plugin-root>/hooks/codex-doctor.mjs --json
 *
 * It reports the same classes the Claude doctor reports: installed version,
 * configuration, endpoint, credential PRESENCE, connectivity, local outbox and
 * backlog, last failure and retry state, and project identity.
 *
 * The credential is never printed, never hashed into the output, and never
 * logged. It is read from the environment, used for one bounded authenticated
 * request, and described only as valid-shaped or not.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_ITSUKI_BASE_URL,
	inspectCodexOutbox,
	normalizeServiceBaseUrl,
	pluginDataFromEnvironment,
	resolveCodexProjectScope,
	validItsukiApiKey,
} from "./codex-outbox.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_KEY = process.env.ITSUKI_API_KEY
	?? process.env.CODEX_PLUGIN_OPTION_ITSUKI_API_KEY
	?? process.env.PLUGIN_OPTION_ITSUKI_API_KEY;
const REQUEST_TIMEOUT_MS = 15_000;

function argFlag(name) {
	return process.argv.slice(2).includes(name);
}

async function manifestEvidence() {
	try {
		const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
		return { name: manifest.name ?? null, version: manifest.version ?? null };
	} catch {
		return { name: null, version: null };
	}
}

async function mcpTargetEvidence() {
	try {
		const mcp = JSON.parse(await readFile(join(PLUGIN_ROOT, ".mcp.json"), "utf8"));
		const server = mcp?.mcpServers?.itsuki ?? Object.values(mcp?.mcpServers ?? {})[0] ?? null;
		return { url: server?.url ?? null, type: server?.type ?? null };
	} catch {
		return { url: null, type: null };
	}
}

async function hooksRegistered() {
	try {
		const hooks = JSON.parse(await readFile(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"));
		return {
			sessionStart: Array.isArray(hooks?.hooks?.SessionStart) && hooks.hooks.SessionStart.length > 0,
			sessionEnd: Array.isArray(hooks?.hooks?.SessionEnd) && hooks.hooks.SessionEnd.length > 0,
		};
	} catch {
		return { sessionStart: false, sessionEnd: false };
	}
}

/** One bounded, harmless authenticated read. Proves the credential and the
 *  network path together without writing anything. */
async function connectivityEvidence(baseUrl) {
	if (!validItsukiApiKey(API_KEY)) return { outcome: "skipped", status: null };
	try {
		const response = await fetch(`${baseUrl}/v1/status`, {
			headers: { authorization: `Bearer ${API_KEY}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) return { outcome: "credential_rejected", status: response.status };
		if (!response.ok) return { outcome: "http_error", status: response.status };
		await response.json().catch(() => null);
		return { outcome: "ok", status: response.status };
	} catch (error) {
		return { outcome: error?.name === "TimeoutError" ? "timeout" : "network_error", status: null };
	}
}

function ageText(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	const hours = Math.floor(minutes / 60);
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export async function runCodexDoctor({ env = process.env, now = Date.now() } = {}) {
	const lines = [];
	let failures = 0;
	let warnings = 0;
	const checks = [];
	const record = (level, name, detail) => {
		checks.push({ level, name, detail });
		lines.push(`${level}  ${name} -- ${detail}`);
		if (level === "FAIL") failures += 1;
		if (level === "WARN") warnings += 1;
	};

	const [manifest, mcp, hooks] = await Promise.all([manifestEvidence(), mcpTargetEvidence(), hooksRegistered()]);

	if (manifest.version) record("PASS", "plugin version", `${manifest.name ?? "itsuki"} ${manifest.version} (installed manifest)`);
	else record("FAIL", "plugin version", "the installed .codex-plugin/plugin.json could not be read; reinstall the plugin");

	record(hooks.sessionStart && hooks.sessionEnd ? "PASS" : "FAIL", "hook registration",
		hooks.sessionStart && hooks.sessionEnd
			? "SessionStart and SessionEnd are both registered in hooks.json"
			: `hooks.json is incomplete (SessionStart ${hooks.sessionStart ? "ok" : "missing"}, SessionEnd ${hooks.sessionEnd ? "ok" : "missing"}); reinstall the plugin`);

	let baseUrl = DEFAULT_ITSUKI_BASE_URL;
	try { baseUrl = normalizeServiceBaseUrl(env.ITSUKI_BASE_URL ?? DEFAULT_ITSUKI_BASE_URL); } catch {}
	if (baseUrl === DEFAULT_ITSUKI_BASE_URL) record("PASS", "service target", `hooks deliver to ${baseUrl}`);
	else record("WARN", "service target", `a non-default target is configured (${baseUrl}); this does not prove production`);

	if (mcp.url) record("PASS", "MCP target", `${mcp.type ?? "http"} ${mcp.url}`);
	else record("FAIL", "MCP target", ".mcp.json does not declare an Itsuki MCP server; memory tools will not appear in Codex");

	// PRESENCE and SHAPE only. The value never reaches the output.
	const keyValid = validItsukiApiKey(API_KEY);
	if (keyValid) record("PASS", "credential", "an Itsuki API key is present and header-safe (value hidden)");
	else if (API_KEY) record("FAIL", "credential", "the configured Itsuki API key is not a valid key shape; re-copy it from https://itsuki.app under API keys");
	else record("FAIL", "credential", "no Itsuki API key in the environment; set ITSUKI_API_KEY for this Codex session");

	const connectivity = await connectivityEvidence(baseUrl);
	if (connectivity.outcome === "ok") record("PASS", "connectivity", `authenticated read answered HTTP ${connectivity.status}`);
	else if (connectivity.outcome === "skipped") record("SKIP", "connectivity", "blocked by a missing or invalid credential");
	else if (connectivity.outcome === "credential_rejected") record("FAIL", "connectivity", `the service rejected this credential (HTTP ${connectivity.status}); confirm the key belongs to the intended account`);
	else if (connectivity.outcome === "timeout") record("FAIL", "connectivity", `no answer within ${REQUEST_TIMEOUT_MS / 1000}s; check network egress to ${baseUrl}`);
	else record("FAIL", "connectivity", `could not reach ${baseUrl} (${connectivity.outcome}${connectivity.status ? ` HTTP ${connectivity.status}` : ""})`);

	// Local capture/delivery state: what is queued, what is stuck, and whether a
	// key rotation has stranded captures against a previous credential.
	const pluginData = pluginDataFromEnvironment(env);
	let outbox = null;
	if (!pluginData) {
		record("FAIL", "protected outbox", "no plugin-data directory in the environment; Codex did not provide PLUGIN_DATA, so captures cannot be queued");
	} else {
		try {
			outbox = await inspectCodexOutbox({ pluginData, apiKey: API_KEY, baseUrl });
			const oldest = outbox.oldestPendingAt ? ageText(now - outbox.oldestPendingAt) : null;
			if (outbox.quarantined > 0) {
				record("FAIL", "protected outbox", `${outbox.count} queued and ${outbox.quarantined} quarantined entr${outbox.quarantined === 1 ? "y" : "ies"} (${outbox.bytes} bytes); quarantined content is preserved, never deleted`);
			} else {
				record("PASS", "protected outbox", `${outbox.count} queued entr${outbox.count === 1 ? "y" : "ies"}, 0 quarantined, ${outbox.bytes} bytes${oldest ? `, oldest waiting ${oldest}` : ""}`);
			}
			if (outbox.bindingMismatch === null) {
				record("SKIP", "credential binding", "cannot compare queued entries without a valid credential");
			} else if (outbox.bindingMismatch > 0) {
				record("FAIL", "credential binding", `${outbox.bindingMismatch} queued entr${outbox.bindingMismatch === 1 ? "y was" : "ies were"} captured under a different key or origin and will not deliver to this account; captures are preserved — rebind deliberately rather than deleting them`);
			} else {
				record("PASS", "credential binding", "every queued entry matches the active key and origin");
			}
			if (outbox.count > 0 && outbox.oldestPendingAt && now - outbox.oldestPendingAt > 24 * 60 * 60 * 1000) {
				record("WARN", "delivery backlog", `the oldest queued capture is ${oldest} old; delivery runs at SessionStart, so start a Codex session in this project to drain it`);
			}
		} catch (error) {
			record("FAIL", "protected outbox", `inspection failed (${error?.code ?? error?.name ?? "error"}); queued content was not modified`);
		}
	}

	// Project identity: the single most common "my memory is missing" cause.
	try {
		const scope = await resolveCodexProjectScope(process.cwd());
		const overridden = Boolean(String(env.ITSUKI_PROJECT_ID ?? "").trim());
		record("PASS", "project identity", `this directory derives ${scope.projectId}${overridden ? " (ITSUKI_PROJECT_ID override in effect)" : ""}; project memory saved here is recalled under that id, and an SDK or REST caller must carry it to see the same memory`);
	} catch (error) {
		record("FAIL", "project identity", `the project scope could not be resolved (${error?.code ?? "error"}); project-scoped recall may fall back to account-global memory`);
	}

	record("WARN", "live Codex registry", "confirm the Itsuki MCP server and hooks are enabled in Codex; a plugin cannot introspect the host's rendered panels");

	lines.push("");
	lines.push(failures
		? `${failures} check(s) failed; ${warnings} warning(s). No queued content was deleted.`
		: `All checks passed with ${warnings} warning(s).`);

	return { ok: failures === 0, failures, warnings, checks, report: lines.join("\n") };
}

// Executed directly by a user; never imported by a hook on the hot path.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const result = await runCodexDoctor();
	if (argFlag("--json")) process.stdout.write(JSON.stringify({ ok: result.ok, failures: result.failures, warnings: result.warnings, checks: result.checks }, null, 2) + "\n");
	else process.stdout.write(`${result.report}\n`);
	process.exitCode = result.ok ? 0 : 1;
}
