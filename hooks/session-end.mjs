/**
 * Claude SessionEnd: scrub and atomically queue locally. There is deliberately
 * no network path in this process; Claude's default SessionEnd budget is about
 * 1.5 seconds and plugin timeout fields do not extend that global budget.
 */

import { existsSync } from "node:fs";

import { readClaudeTranscriptTail } from "./claude-transcript-tail.mjs";
import { messagesFromClaudeTranscriptLines } from "./claude-transcript.mjs";
import {
	DEFAULT_DELIVERY_BASE_URL,
	OutboxCapacityError,
	OutboxSecurityError,
	credentialFingerprint,
	enqueueSession,
	normalizeDeliveryBaseUrl,
	pluginDataFromArgs,
} from "./outbox.mjs";
import { claudeProjectDirectory, projectMemoryScope, resolveProjectIdentity } from "./project-identity.mjs";

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

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

async function messagesFromTranscript(path, sessionId) {
	if (!path || !existsSync(path)) return { messages: [], metadata: null };
	const tail = await readClaudeTranscriptTail(path, {
		maxEvents: 80,
		maxScannedBytes: 8 * 1024 * 1024,
		maxScanMs: 200,
		maxLineBytes: 256 * 1024,
	});
	return {
		messages: await messagesFromClaudeTranscriptLines(tail.records, { sessionId, transcriptId: path }),
		metadata: tail.metadata,
	};
}

function notQueued(reason) {
	return { systemMessage: `Itsuki: this session was NOT queued locally — ${reason}` };
}

async function main() {
	const pluginData = pluginDataFromArgs();
	if (!pluginData) {
		return notQueued("Claude did not provide an absolute protected plugin-data directory. Run /itsuki:doctor.");
	}

	const payload = await readStdin();
	if (payload === null) {
		return notQueued("Claude Code sent a SessionEnd payload this hook could not parse. The coding session is unaffected.");
	}
	if (!payload.transcript_path || !existsSync(payload.transcript_path)) {
		return notQueued("the session transcript file was not found. If this repeats, run /itsuki:doctor.");
	}

	let transcript;
	try {
		transcript = await messagesFromTranscript(payload.transcript_path, payload.session_id);
	} catch {
		return notQueued("the session transcript could not be read. If this repeats, run /itsuki:doctor.");
	}
	const { messages, metadata } = transcript;
	if (!messages.length) {
		if (metadata?.scanTruncated || metadata?.malformedLines > 0 || metadata?.oversizedLines > 0 || metadata?.fileChangedDuringScan || metadata?.fileGrew || metadata?.fileShrank) {
			return notQueued("the bounded transcript scan found no eligible message before its safety limit. The transcript remains on disk; run /itsuki:doctor.");
		}
		return {};
	}
	const captureLimited = metadata?.truncationReason === "max_bytes"
		|| metadata?.truncationReason === "max_time"
		|| metadata?.oversizedLines > 0
		|| metadata?.fileChangedDuringScan
		|| metadata?.fileGrew
		|| metadata?.fileShrank;

	const project = await resolveProjectIdentity(claudeProjectDirectory(payload.cwd));
	try {
		const queued = await enqueueSession({
			pluginData,
			messages,
			sessionId: payload.session_id,
			memoryScope: projectMemoryScope(project),
			credentialFingerprint: credentialFingerprint(API_KEY, BASE_URL),
		});
		if (queued.credentialMismatch) {
			return {
				systemMessage:
					"Itsuki: this session is already protected locally but is bound to a different API key. " +
					"It will not be sent with the active key; run /itsuki:doctor and confirm before rebinding.",
			};
		}
		if (!queued.bound) {
			return {
				systemMessage:
					"Itsuki: queued locally in the protected outbox, but it is not bound to a valid key and service origin yet. " +
					"Configure the plugin key/service and run /itsuki:doctor to bind and deliver it.",
			};
		}
		if (queued.duplicate && (queued.state === "done" || queued.state === "accepted")) {
			return {
				systemMessage: "Itsuki: this exact session was already accepted by the memory service; no duplicate was queued.",
			};
		}
		if (queued.duplicate && queued.state === "failed") {
			return {
				systemMessage: "Itsuki: this exact session remains protected locally and requires delivery intervention; run /itsuki:doctor.",
			};
		}
		return {
			systemMessage: queued.duplicate
				? "Itsuki: this session is already queued locally; the exact retry will not create another copy."
				: `Itsuki: queued locally; delivery will be retried at the next session start.${captureLimited ? " The bounded shutdown snapshot may have omitted oversized, older, or concurrently appended transcript records; the source transcript was not modified." : ""}`,
		};
	} catch (error) {
		if (error instanceof OutboxCapacityError) {
			return notQueued(`${error.message} No undelivered entry was evicted; run /itsuki:doctor.`);
		}
		if (error instanceof OutboxSecurityError) {
			return notQueued("the protected outbox could not be secured. No transcript text was written; run /itsuki:doctor.");
		}
		return notQueued("the protected outbox could not be written (for example, disk or permission failure). Run /itsuki:doctor.");
	}
}

let output;
try {
	output = await main();
} catch {
	output = notQueued("an unexpected local hook error occurred. The coding session is unaffected; run /itsuki:doctor.");
}
process.stdout.write(JSON.stringify(output ?? {}));
process.exitCode = 0;
