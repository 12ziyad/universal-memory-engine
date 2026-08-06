/** Codex SessionEnd: bounded transcript scan and network-free protected spool. */

import { isAbsolute } from "node:path";

import { readCodexTranscript } from "./codex-transcript.mjs";
import {
	CodexOutboxError,
	credentialBindingFor,
	DEFAULT_ITSUKI_BASE_URL,
	enqueueCodexCapture,
	pluginDataFromEnvironment,
	prepareCodexOutbox,
	readCodexRecallGuard,
	resolveCodexProjectScope,
} from "./codex-outbox.mjs";

const MAX_STDIN_BYTES = 64 * 1024;

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

function safeSessionEndPayload(value) {
	return Boolean(
		value
		&& value.hook_event_name === "SessionEnd"
		&& value.reason === "other"
		&& typeof value.session_id === "string"
		&& value.session_id.length > 0
		&& value.session_id.length <= 200
		&& typeof value.transcript_path === "string"
		&& isAbsolute(value.transcript_path)
		&& typeof value.cwd === "string"
		&& value.cwd.length <= 32_768,
	);
}

function status(message) {
	return { systemMessage: `Itsuki: ${message}` };
}

async function main() {
	const payload = await readBoundedStdin();
	if (!safeSessionEndPayload(payload)) {
		return status("the Codex SessionEnd payload was not recognized; nothing was queued.");
	}
	const pluginData = pluginDataFromEnvironment();
	if (!pluginData) return status("Codex did not provide a safe plugin-data directory; nothing was queued.");
	let credentialBinding;
	try {
		credentialBinding = credentialBindingFor(
			process.env.ITSUKI_API_KEY,
			process.env.ITSUKI_BASE_URL ?? DEFAULT_ITSUKI_BASE_URL,
		);
	} catch {
		return status("a valid API key and bare HTTPS service origin are required to bind the protected queue; nothing was queued.");
	}

	let memoryScope;
	let prepared;
	try {
		memoryScope = await resolveCodexProjectScope(payload.cwd);
	} catch (error) {
		if (error?.code === "invalid_project_id") {
			return status("ITSUKI_PROJECT_ID is invalid; nothing was queued under a fallback project identity.");
		}
		return status("the Codex project identity was unavailable; nothing was queued.");
	}
	try {
		prepared = await prepareCodexOutbox({ pluginData, mode: "EnsureAll" });
	} catch {
		return status("the bounded transcript snapshot or protected local queue was unavailable; no transcript text was written.");
	}
	let recallGuard = { state: "missing", fingerprints: [] };
	try { recallGuard = await readCodexRecallGuard({ pluginData, sessionId: payload.session_id, prepared }); } catch {}
	let transcript;
	try {
		transcript = await readCodexTranscript(payload.transcript_path, {
			sessionId: payload.session_id,
			recallEchoFingerprints: recallGuard.fingerprints,
			suppressAssistantProse: recallGuard.state === "missing",
		});
	} catch {
		return status("the bounded transcript snapshot was unavailable; no transcript text was written.");
	}
	if (!transcript.messages.length) {
		const incomplete = transcript.metadata.malformedRows > 0
			|| transcript.metadata.oversizedRows > 0
			|| transcript.metadata.omittedRows > 0
			|| transcript.metadata.omittedBytes > 0
			|| transcript.metadata.timeLimitExceeded > 0
			|| transcript.metadata.fileChanged > 0;
		return status(incomplete
			? "the safety-bounded snapshot found no eligible durable outcome before an omission; nothing was queued."
			: "this session contained no eligible durable coding outcome; nothing was queued.");
	}

	try {
		const queued = await enqueueCodexCapture({
			pluginData,
			messages: transcript.messages,
			sessionId: payload.session_id,
			memoryScope,
			capture: transcript.metadata,
			prepared,
			credentialBinding,
		});
		if (queued.quarantined) {
			return status("this exact capture was previously rejected permanently by the memory service and remains quarantined; it was not re-queued.");
		}
		if (queued.rebound) {
			return status("this exact capture was already protected locally and is now bound to the active API key for delivery.");
		}
		return status(queued.duplicate
			? "this exact scrubbed Codex capture is already protected locally; no duplicate was added."
			: "scrubbed durable Codex outcomes were queued in the protected local outbox for the next SessionStart.");
	} catch (error) {
		if (error instanceof CodexOutboxError && error.code === "outbox_full") {
			return status("the protected local outbox is full; no existing capture was removed and this snapshot was not queued.");
		}
		return status("the scrubbed snapshot could not be written to the protected local outbox; nothing was queued.");
	}
}

let output;
try { output = await main(); }
catch { output = status("an unexpected local SessionEnd error occurred; nothing was queued."); }
process.stdout.write(JSON.stringify(output));
process.exitCode = 0;
