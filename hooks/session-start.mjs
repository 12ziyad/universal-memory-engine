/**
 * Claude SessionStart: drain the protected local outbox first, then recall
 * project memory. All status/context is aggregated into one JSON document and
 * every network wait is bounded below the hook's 15-second host timeout.
 */

import {
	DEFAULT_DELIVERY_BASE_URL,
	drainOutbox,
	inspectOutbox,
	normalizeDeliveryBaseUrl,
	pluginDataFromArgs,
	sanitizeMemoryScope,
	validItsukiApiKey,
} from "./outbox.mjs";
import {
	PROJECT_RECALL_SCOPE,
	claudeProjectDirectory,
	projectMemoryScope,
	resolveProjectIdentity,
} from "./project-identity.mjs";

const API_KEY = process.env.CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY;
function explicitServiceUrl(argv = process.argv.slice(2)) {
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--service-url-for-test") return argv[index + 1];
		if (String(argv[index]).startsWith("--service-url-for-test=")) {
			return String(argv[index]).slice("--service-url-for-test=".length);
		}
	}
	return DEFAULT_DELIVERY_BASE_URL;
}
let BASE_URL = null;
try { BASE_URL = normalizeDeliveryBaseUrl(explicitServiceUrl()); } catch {}
const CONFIGURED_TIMEOUT_MS = Number(process.env.ITSUKI_TIMEOUT_MS) > 0 ? Number(process.env.ITSUKI_TIMEOUT_MS) : 8_000;
const TOTAL_BUDGET_MS = 12_000;

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	if (!chunks.length) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

function keyProblem(key) {
	if (!key) return "the Itsuki plugin API key is not configured";
	if (!/^[!-~]+$/.test(key)) return "the Itsuki plugin API key contains characters that cannot go in an HTTP header";
	if (!validItsukiApiKey(key)) return "the Itsuki plugin API key has an invalid format";
	return null;
}

function setupFix() {
	return "Create a key at https://itsuki.app under API keys, configure itsuki_api_key for the plugin through /plugin, reload or restart Claude Code, then run /itsuki:doctor.";
}

function networkReason(error, timeoutMs) {
	if (error?.name === "AbortError" || error?.name === "TimeoutError") return `the configured memory service did not answer within ${timeoutMs / 1000}s`;
	return "could not reach the configured memory service (network, DNS, proxy, or TLS failure)";
}

async function readLimitedJson(response, controller, maxBytes = 256 * 1024) {
	const announced = Number(response.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > maxBytes) {
		controller.abort();
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.body?.getReader) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
		try { return JSON.parse(text); } catch { return null; }
	}
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			bytes += chunk.length;
			if (bytes > maxBytes) {
				controller.abort();
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(chunk);
		}
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
	catch { return null; }
}

async function recallProject(project, memoryScope, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${BASE_URL}/v1/recall`, {
			method: "POST",
			signal: controller.signal,
			redirect: "manual",
			headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({
				query: `project decisions, conventions, architecture, and fixes for ${project.projectName}`,
				memoryScope,
				recallScope: PROJECT_RECALL_SCOPE,
			}),
		});
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => {});
			return { unavailable: `the server rejected the configured Itsuki plugin key (HTTP ${response.status})`, fix: setupFix() };
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return { unavailable: `the memory service answered HTTP ${response.status}`, fix: "The session continues normally; run /itsuki:doctor if this repeats." };
		}
		if (String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
			await response.body?.cancel().catch(() => {});
			return { unavailable: "the memory service sent an unexpected response type", fix: "Run /itsuki:doctor. The session continues normally." };
		}
		const data = await readLimitedJson(response, controller);
		if (!data || data.ok !== true || typeof data.context !== "string") {
			return { unavailable: "the memory service sent an unreadable, oversized, or unsuccessful recall receipt", fix: "Run /itsuki:doctor. The session continues normally." };
		}
		return { context: data.context.trim() };
	} catch (error) {
		return { unavailable: networkReason(error, timeoutMs), fix: "Run /itsuki:doctor. The session continues normally." };
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const startedAt = Date.now();
	const payload = await readStdin();
	const pluginData = pluginDataFromArgs();
	const project = await resolveProjectIdentity(claudeProjectDirectory(payload.cwd));
	const memoryScope = sanitizeMemoryScope(projectMemoryScope(project));
	const system = [];
	let unavailable = null;
	let skipRecall = false;
	let drainedHealth = null;

	if (!BASE_URL) {
		system.push("Itsuki: the configured memory service URL is invalid or unsafe; no queued data was sent. Run /itsuki:doctor.");
		unavailable = { reason: "the configured memory service URL is invalid or unsafe", fix: "Use an HTTPS service URL (or loopback HTTP for development), then run /itsuki:doctor." };
		skipRecall = true;
	}

	if (!pluginData) {
		system.push("Itsuki: Claude did not provide a protected plugin-data directory; local delivery is unavailable. Run /itsuki:doctor.");
	} else if (BASE_URL) {
		try {
			const drained = await drainOutbox({ pluginData, apiKey: API_KEY, baseUrl: BASE_URL });
			drainedHealth = drained.health ?? null;
			if (drained.delivered > 0) {
				const packetIds = drained.accepted.map((item) => item.sourcePacketId).filter(Boolean);
				system.push(
					`Itsuki: delivered ${drained.delivered} locally queued session${drained.delivered === 1 ? "" : "s"}; ` +
					`the server accepted ${drained.delivered === 1 ? "it" : "them"}, and enrichment may continue` +
					`${packetIds.length ? ` (packet${packetIds.length === 1 ? "" : "s"}: ${packetIds.join(", ")})` : ""}.`,
				);
			}
			if (drained.authBlocked) {
				system.push("Itsuki: local delivery is paused because the API key was rejected; protected sessions remain queued. Run /itsuki:doctor.");
				skipRecall = true;
				unavailable = {
					reason: "the API key was rejected while delivering the protected local queue",
					fix: setupFix(),
				};
			}
			if (drained.bindingRequired > 0) {
				system.push(`Itsuki: ${drained.bindingRequired} protected queued session${drained.bindingRequired === 1 ? " requires" : "s require"} explicit API-key binding; run /itsuki:doctor.`);
			}
			if (drained.permanentFailures > 0 || drained.health?.permanentFailures > 0) {
				const count = drained.health?.permanentFailures || drained.permanentFailures;
				system.push(`Itsuki: ${count} queued session${count === 1 ? "" : "s"} require intervention and remain protected; run /itsuki:doctor.`);
			}
			if (drained.retried > 0) {
				system.push(`Itsuki: delivery will retry later for ${drained.retried} queued session${drained.retried === 1 ? "" : "s"}.`);
			}
			if (drained.transportUnavailable) {
				skipRecall = true;
				unavailable = { reason: "the memory service was unreachable while delivering the protected local queue", fix: "Queued data was preserved; run /itsuki:doctor when connectivity returns." };
			}
		} catch {
			system.push("Itsuki: the protected local outbox could not be inspected; no queued data was discarded. Run /itsuki:doctor.");
		}
	}

	const problem = keyProblem(API_KEY);
	if (problem) {
		if (pluginData) {
			try {
				const health = drainedHealth ?? (BASE_URL ? await inspectOutbox({ pluginData, apiKey: API_KEY, baseUrl: BASE_URL }) : null);
				if (health?.counts.pending > 0) system.push(`Itsuki: ${health.counts.pending} protected session${health.counts.pending === 1 ? " is" : "s are"} waiting for a valid key.`);
			} catch {}
		}
		unavailable = { reason: problem, fix: setupFix() };
		skipRecall = true;
	}

	let context = "";
	if (!skipRecall) {
		const remaining = Math.max(1, TOTAL_BUDGET_MS - (Date.now() - startedAt));
		if (remaining < 250) {
			unavailable = { reason: "the local delivery work used this hook's recall budget", fix: "The session continues normally; recall will retry next session." };
		} else {
			const recalled = await recallProject(project, memoryScope, Math.min(CONFIGURED_TIMEOUT_MS, remaining));
			context = recalled.context ?? "";
			if (recalled.unavailable) unavailable = { reason: recalled.unavailable, fix: recalled.fix };
		}
	}

	const output = {};
	if (system.length) output.systemMessage = system.join(" ");
	if (context) {
		output.hookSpecificOutput = {
			hookEventName: "SessionStart",
			additionalContext:
				`Itsuki project memory for ${project.projectName} (from previous sessions):\n${context}\n` +
				"(Use this as established context. New durable outcomes are queued locally at SessionEnd and delivered on a later SessionStart.)",
		};
	} else if (unavailable) {
		output.systemMessage = `${output.systemMessage ? `${output.systemMessage} ` : ""}Itsuki: ${unavailable.reason}. Project memory is OFF for this session. ${unavailable.fix}`;
		output.hookSpecificOutput = {
			hookEventName: "SessionStart",
			additionalContext:
				`Itsuki project memory is unavailable this session (${unavailable.reason}). ` +
				`Do not claim memory of previous sessions. If asked, say: ${unavailable.fix}`,
		};
	}
	return output;
}

let output;
try { output = await main(); }
catch {
	output = {
		systemMessage: "Itsuki: an unexpected startup hook error occurred. The coding session continues normally; run /itsuki:doctor.",
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: "Itsuki project memory is unavailable this session. Do not claim memory of previous sessions.",
		},
	};
}
process.stdout.write(JSON.stringify(output ?? {}));
process.exitCode = 0;
