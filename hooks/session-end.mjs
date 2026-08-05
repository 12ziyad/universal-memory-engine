/**
 * Claude SessionEnd: scrub and atomically queue locally. There is deliberately
 * no network path in this process; Claude's default SessionEnd budget is about
 * 1.5 seconds and plugin timeout fields do not extend that global budget.
 */

import { existsSync } from "node:fs";

import { readClaudeTranscriptTail } from "./claude-transcript-tail.mjs";
import { transformClaudeTranscriptLines } from "./claude-transcript.mjs";
import {
	DEFAULT_DELIVERY_BASE_URL,
	OutboxCapacityError,
	OutboxSecurityError,
	credentialFingerprint,
	enqueueSession,
	normalizeDeliveryBaseUrl,
	pluginDataFromArgs,
	prepareProtectedOutbox,
	readRecallEchoGuard,
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

async function messagesFromTranscript(
	path,
	sessionId,
	cwd,
	recallFingerprints = [],
	suppressAssistantProse = false,
	protectionResultPromise = null,
) {
	if (!path || !existsSync(path)) return { messages: [], metadata: null };
	const tail = await readClaudeTranscriptTail(path, {
		sessionId,
		recallFingerprints,
		suppressAssistantProse,
		maxEvents: 80,
		maxScannedBytes: 8 * 1024 * 1024,
		// Leave most of Claude's host budget for the single durable spool, while
		// tolerating ordinary scheduler pauses before the first tail read.
		maxScanMs: 400,
		maxLineBytes: 256 * 1024,
	});
	const protectionResult = protectionResultPromise ? await protectionResultPromise : null;
	if (protectionResult?.status === "fulfilled" && protectionResult.value?.guardTrusted === false) {
		recallFingerprints = [];
		suppressAssistantProse = true;
	}
	const transformed = await transformClaudeTranscriptLines(tail.records, {
		sessionId,
		transcriptId: path,
		cwd,
		recallFingerprints,
		suppressAssistantProse,
		captureExclusions: tail.metadata.captureExclusions,
	});
	return {
		messages: transformed.messages,
		metadata: {
			...tail.metadata,
			recallEchoProtectionUnavailable: suppressAssistantProse,
			capture: transformed.metadata,
		},
	};
}

function notQueued(reason) {
	return { systemMessage: `Itsuki: this session was NOT queued locally — ${reason}` };
}

function captureOmissionNote(metadata) {
	const details = [];
	if (metadata?.truncationReason === "max_events") details.push("at least one older completed durable coding outcome beyond the newest 80 outcomes");
	else if (metadata?.truncationReason === "max_bytes") details.push("older records beyond the bounded 8 MiB shutdown scan");
	else if (metadata?.truncationReason === "max_time") details.push("older records not reached within the 400 ms shutdown scan budget");
	if (Number(metadata?.oversizedLines ?? 0) > 0) details.push(`${metadata.oversizedLines} record${metadata.oversizedLines === 1 ? "" : "s"} larger than the 256 KiB line-safety limit`);
	if (Number(metadata?.malformedLines ?? 0) > 0) details.push(`${metadata.malformedLines} malformed JSONL record${metadata.malformedLines === 1 ? "" : "s"}`);
	if (Number(metadata?.capture?.omittedEvents ?? 0) > 0) details.push(`${metadata.capture.omittedEvents} older derived coding event${metadata.capture.omittedEvents === 1 ? "" : "s"} beyond the 80-event capture limit`);
	if (Number(metadata?.capture?.truncatedEvents ?? 0) > 0) details.push(`${metadata.capture.truncatedEvents} derived coding event summar${metadata.capture.truncatedEvents === 1 ? "y was" : "ies were"} abbreviated to the safe capture limit`);
	if (Number(metadata?.ambiguousOutcomeRows ?? 0) > 0) details.push(`${metadata.ambiguousOutcomeRows} tool outcome${metadata.ambiguousOutcomeRows === 1 ? "" : "s"} excluded because its call identity was ambiguous`);
	if (Number(metadata?.companionLimitRejectedOutcomeRows ?? 0) > 0) details.push(`${metadata.companionLimitRejectedOutcomeRows} tool outcome${metadata.companionLimitRejectedOutcomeRows === 1 ? "" : "s"} excluded because its required companion rows exceeded the safety bound`);
	if (Number(metadata?.closureEventLimitRejectedOutcomeRows ?? 0) > 0) details.push(`${metadata.closureEventLimitRejectedOutcomeRows} linked tool outcome${metadata.closureEventLimitRejectedOutcomeRows === 1 ? "" : "s"} excluded because their dependency closure exceeded the event bound`);
	if (metadata?.recallEchoProtectionUnavailable) details.push("assistant-authored prose excluded because the protected recall-echo filter was unavailable");
	if (metadata?.fileGrew) details.push("records appended after the snapshot boundary");
	if (metadata?.fileShrank || metadata?.fileChangedDuringScan) details.push("records affected by a concurrent transcript rewrite");
	if (!details.length) return "";
	return ` The bounded shutdown snapshot omitted ${details.join(", ")}; the source transcript was not modified, and the omission reason is recorded with every batch.`;
}

function safetyDroppedOutcomeCount(metadata) {
	return [
		metadata?.ambiguousOutcomeRows,
		metadata?.companionLimitRejectedOutcomeRows,
		metadata?.closureEventLimitRejectedOutcomeRows,
	].reduce((sum, value) => sum + (Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
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
	// The Windows ACL helper is a bounded child process. Start it before the
	// bounded transcript read so first-use protection and tail scanning overlap
	// inside Claude's fixed shutdown budget; enqueue revalidates the marker.
	const protectionResultPromise = prepareProtectedOutbox({ pluginData }).then(
		(value) => ({ status: "fulfilled", value }),
		(reason) => ({ status: "rejected", reason }),
	);
	let recallFingerprints = [];
	let suppressAssistantProse = false;
	try {
		const recallGuard = await readRecallEchoGuard({
			pluginData,
			sessionId: payload.session_id,
		});
		if (recallGuard.status === "armed") recallFingerprints = recallGuard.fingerprints;
		else if (recallGuard.status !== "no_context") suppressAssistantProse = true;
	} catch {
		// Continue capturing tool outcomes and explicit user decisions, but fail
		// closed for assistant prose when prior recalled text cannot be excluded.
		suppressAssistantProse = true;
	}

	const transcriptPromise = messagesFromTranscript(
		payload.transcript_path,
		payload.session_id,
		payload.cwd,
		recallFingerprints,
		suppressAssistantProse,
		protectionResultPromise,
	);
	const [protectionResult, transcriptResult] = await Promise.all([
		protectionResultPromise,
		Promise.allSettled([transcriptPromise]).then(([result]) => result),
	]);
	if (transcriptResult.status === "rejected") {
		return notQueued("the session transcript could not be read. If this repeats, run /itsuki:doctor.");
	}
	if (protectionResult.status === "rejected") {
		if (protectionResult.reason instanceof OutboxSecurityError) {
			return notQueued("the protected outbox could not be secured. No transcript text was written; run /itsuki:doctor.");
		}
		return notQueued("the protected outbox could not be prepared (for example, disk or permission failure). Run /itsuki:doctor.");
	}
	const transcript = transcriptResult.value;
	const { messages, metadata } = transcript;
	if (!messages.length) {
		if (metadata?.recallEchoProtectionUnavailable) {
			return notQueued("assistant-authored prose was excluded because the protected recall-echo filter could not be read. Explicit user decisions and tool outcomes remain eligible; run /itsuki:doctor.");
		}
		if (metadata?.scanTruncated || metadata?.malformedLines > 0 || metadata?.oversizedLines > 0 || metadata?.fileChangedDuringScan || metadata?.fileGrew || metadata?.fileShrank) {
			return notQueued("the bounded transcript scan found no eligible message before its safety limit. The transcript remains on disk; run /itsuki:doctor.");
		}
		if (safetyDroppedOutcomeCount(metadata) > 0) {
			return notQueued("one or more tool outcomes were excluded because their call identity or dependency closure was not safe to attribute. The transcript remains on disk; run /itsuki:doctor.");
		}
		return {};
	}
	const omissionNote = captureOmissionNote(metadata);

	const project = await resolveProjectIdentity(claudeProjectDirectory(payload.cwd));
	try {
		const queued = await enqueueSession({
			pluginData,
			messages,
			sessionId: payload.session_id,
			memoryScope: projectMemoryScope(project),
			captureMetadata: metadata,
			// SessionEnd has a hard host budget. Persist one scrubbed aggregate now;
			// SessionStart performs Unicode segmentation and wire batching later.
			deferMaterialization: true,
			credentialFingerprint: credentialFingerprint(API_KEY, BASE_URL),
		});
		if (queued.credentialMismatch) {
			return {
				systemMessage:
					"Itsuki: this session is already protected locally but is bound to a different API key. " +
					`It will not be sent with the active key; run /itsuki:doctor and confirm before rebinding.${omissionNote}`,
			};
		}
		if (!queued.bound) {
			return {
				systemMessage:
					"Itsuki: queued locally in the protected outbox, but it is not bound to a valid key and service origin yet. " +
					`Configure the plugin key/service and run /itsuki:doctor to bind and deliver it.${omissionNote}`,
			};
		}
		if (queued.duplicate && Number(queued.acceptedBatches ?? 0) === Number(queued.batchCount ?? 1)) {
			return {
				systemMessage: `Itsuki: this exact session was already accepted by the memory service; no duplicate was queued.${omissionNote}`,
			};
		}
		if (queued.duplicate && Number(queued.failedBatches ?? 0) > 0) {
			return {
				systemMessage: `Itsuki: this exact session remains protected locally and requires delivery intervention; run /itsuki:doctor.${omissionNote}`,
			};
		}
		const batchText = Number(queued.batchCount) > 1 ? ` in ${queued.batchCount} ordered batches` : "";
		return {
			systemMessage: queued.duplicate
				? `Itsuki: this session is already queued locally${batchText}; the exact retry will not create another copy.${omissionNote}`
				: `Itsuki: queued locally${batchText}; delivery will be retried at the next session start.${omissionNote}`,
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
