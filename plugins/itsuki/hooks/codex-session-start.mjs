/** Codex SessionStart: bounded protected delivery, then bounded project recall. */

import {
	DEFAULT_ITSUKI_BASE_URL,
	drainCodexOutbox,
	formatCodexRecallContext,
	persistCodexRecallGuard,
	pluginDataFromEnvironment,
	prepareCodexOutbox,
	recallCodexContext,
	resolveCodexProjectScope,
} from "./codex-outbox.mjs";

const MAX_STDIN_BYTES = 64 * 1024;
const TOTAL_BUDGET_MS = 3_500;

async function readBoundedStdin() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > MAX_STDIN_BYTES) return null;
		chunks.push(Buffer.from(chunk));
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

function validPayload(value) {
	return Boolean(
		value
		&& value.hook_event_name === "SessionStart"
		&& ["startup", "resume", "clear", "compact"].includes(value.source)
		&& typeof value.session_id === "string"
		&& value.session_id.length > 0
		&& value.session_id.length <= 200
		&& typeof value.cwd === "string"
		&& value.cwd.length <= 32_768,
	);
}

function output(systemMessage, additionalContext = "") {
	return {
		continue: true,
		...(systemMessage ? { systemMessage } : {}),
		...(additionalContext ? {
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext,
			},
		} : {}),
	};
}

async function main() {
	const startedAt = Date.now();
	const payload = await readBoundedStdin();
	if (!validPayload(payload)) return output("Itsuki: the Codex SessionStart payload was not recognized; memory recall was skipped.");
	const pluginData = pluginDataFromEnvironment();
	const apiKey = process.env.ITSUKI_API_KEY;
	const baseUrl = process.env.ITSUKI_BASE_URL ?? DEFAULT_ITSUKI_BASE_URL;
	let memoryScope;
	try { memoryScope = await resolveCodexProjectScope(payload.cwd); }
	catch (error) {
		if (error?.code === "invalid_project_id") {
			return output("Itsuki: ITSUKI_PROJECT_ID is invalid; protected delivery and project recall were skipped.");
		}
		throw error;
	}
	const statuses = [];
	let prepared = null;

	if (pluginData) {
		try {
			prepared = await prepareCodexOutbox({ pluginData, mode: "EnsureAll" });
			const drained = await drainCodexOutbox({
				pluginData,
				apiKey,
				baseUrl,
				maxEntries: 4,
				maxDurationMs: Math.min(1_600, Math.max(1, TOTAL_BUDGET_MS - (Date.now() - startedAt) - 1_100)),
				prepared,
			});
			if (drained.delivered > 0) {
				const packets = (drained.accepted ?? []).map((entry) => entry.sourcePacketId).filter(Boolean);
				statuses.push(`delivered ${drained.delivered} protected local capture${drained.delivered === 1 ? "" : "s"}${packets.length ? ` (packet${packets.length === 1 ? "" : "s"}: ${packets.join(", ")})` : ""}`);
			}
			if (drained.quarantined > 0) statuses.push(`${drained.quarantined} capture${drained.quarantined === 1 ? " was" : "s were"} permanently rejected by the service and moved to the protected quarantine for review`);
			if (drained.bindingMismatch > 0) statuses.push(`${drained.bindingMismatch} capture${drained.bindingMismatch === 1 ? " is" : "s are"} bound to a different API key or service origin and remain${drained.bindingMismatch === 1 ? "s" : ""} preserved`);
			if (drained.preserved > 0) statuses.push(`${drained.preserved} local capture${drained.preserved === 1 ? " remains" : "s remain"} protected for retry`);
			if (drained.status === "auth") statuses.push("delivery is paused because the API key was rejected");
			else if (["retryable", "budget_exhausted", "busy", "cleanup_busy", "backoff"].includes(drained.status)) statuses.push("bounded delivery will retry later");
		} catch {
			statuses.push("the protected local queue could not be inspected; queued content was preserved");
		}
	} else {
		statuses.push("Codex did not provide a safe plugin-data directory, so local delivery was skipped");
	}

	if (!prepared) return output(`Itsuki: ${statuses.join("; ") || "protected local state was unavailable"}.`);
	const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
	if (remaining <= 100) return output(`Itsuki: ${statuses.join("; ") || "the bounded startup budget was exhausted"}.`);
	let recalled;
	try {
		recalled = await recallCodexContext({
			apiKey,
			baseUrl,
			memoryScope,
			timeoutMs: Math.min(1_000, remaining),
		});
	} catch {
		recalled = { status: "unavailable", context: "" };
	}
	if (recalled.status === "key_unavailable") statuses.push("recall needs a valid ITSUKI_API_KEY");
	else if (recalled.status === "auth") statuses.push("recall was rejected by the configured API key");
	else if (recalled.status !== "ok") statuses.push("project recall was unavailable within its bound");
	else statuses.push(recalled.context ? "project memory recalled" : "no project memory matched");
	let context = "";
	try {
		await persistCodexRecallGuard({
			pluginData,
			sessionId: payload.session_id,
			context: recalled.status === "ok" ? recalled.context : "",
			prepared,
		});
		context = formatCodexRecallContext(recalled.context ?? "");
	} catch {
		statuses.push("recalled text was not injected because its protected echo guard could not be persisted");
	}
	return output(`Itsuki: ${statuses.join("; ")}.`, context);
}

let result;
try { result = await main(); }
catch { result = output("Itsuki: an unexpected bounded SessionStart error occurred; the Codex session continues normally."); }
process.stdout.write(JSON.stringify(result));
process.exitCode = 0;
