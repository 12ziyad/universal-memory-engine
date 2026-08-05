/**
 * Bounded parser for the observed Codex CLI 0.146.0-alpha.9.2 JSONL shape.
 *
 * Codex documents transcript_path as convenient but explicitly unstable. Every
 * unknown or malformed shape is therefore omitted; this parser never falls
 * back to treating arbitrary payload values as text. It deliberately does not
 * import or reuse the Claude transcript parser.
 */

import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";

import {
	emptyRedactions,
	filterRecalledEchoText,
	mergeRedactions,
	scrubCodexText,
	stripRecalledContext,
	truncateCodePoints,
	truncateCodePointsHeadTail,
} from "./codex-scrub.mjs";

export const CODEX_CAPTURE_SCHEMA = "itsuki.codex-capture/v1";
export const DEFAULT_CODEX_SCAN_LIMITS = Object.freeze({
	maxScannedBytes: 2 * 1024 * 1024,
	maxLineBytes: 256 * 1024,
	maxRows: 1_600,
	maxMessages: 24,
	maxMessageCharacters: 3_000,
	maxToolOutputCharacters: 64 * 1024,
	maxScanMs: 400,
});

const COUNTER_LIMIT = 1_000_000;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const META_ROW_TYPES = new Set([
	"session_meta",
	"turn_context",
	"compacted",
	"world_state",
	"inter_agent_communication_metadata",
]);
const SAFE_TEXT_BLOCK_TYPES = new Set(["input_text", "output_text"]);
const CALL_TYPES = new Map([
	["function_call", "function_call_output"],
	["custom_tool_call", "custom_tool_call_output"],
]);
const TOOL_KIND = new Map([
	["apply_patch", "workspace patch"],
	["shell_command", "local command"],
	["exec_command", "local command"],
	["exec", "local command"],
	["write_stdin", "background command"],
]);

function hash(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function bump(metadata, key, amount = 1) {
	const next = Number(metadata[key] ?? 0) + amount;
	metadata[key] = Math.min(COUNTER_LIMIT, Math.max(0, Number.isFinite(next) ? Math.floor(next) : COUNTER_LIMIT));
}

function captureMetadata(seed = {}) {
	return {
		schema: CODEX_CAPTURE_SCHEMA,
		inputRows: 0,
		parsedRows: 0,
		candidateMessages: 0,
		returnedMessages: 0,
		omittedMessages: 0,
		malformedRows: 0,
		oversizedRows: 0,
		unknownRows: 0,
		ignoredMetaRows: 0,
		ignoredDeveloperSystemRows: 0,
		ignoredReasoningRows: 0,
		ignoredEncryptedRows: 0,
		ignoredCommentaryRows: 0,
		ignoredEventDuplicates: 0,
		ignoredNoiseRows: 0,
		ignoredRecallEchoRows: 0,
		ignoredUnprotectedAssistantRows: 0,
		missingStableIdentityRows: 0,
		ambiguousMessageIdentityRows: 0,
		ignoredToolRows: 0,
		unmatchedToolOutputs: 0,
		ambiguousToolCalls: 0,
		duplicateMessages: 0,
		truncatedMessages: 0,
		truncatedToolOutputs: 0,
		omittedRows: Math.min(COUNTER_LIMIT, Math.max(0, Number(seed.omittedRows ?? 0) || 0)),
		omittedBytes: Math.min(COUNTER_LIMIT, Math.max(0, Number(seed.omittedBytes ?? 0) || 0)),
		scanBytes: Math.min(COUNTER_LIMIT, Math.max(0, Number(seed.scanBytes ?? 0) || 0)),
		timeLimitExceeded: seed.timeLimitExceeded ? 1 : 0,
		fileChanged: seed.fileChanged ? 1 : 0,
		redactions: emptyRedactions(),
	};
}

function plainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeCallId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function safeToolName(value) {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return /^[a-z][a-z0-9_.:-]{0,63}$/.test(normalized) ? normalized : null;
}

function toolDescriptor(payload) {
	const name = safeToolName(payload?.name);
	const namespace = safeToolName(payload?.namespace);
	if (!name || namespace === "collaboration") return { eligible: false, kind: null };
	return { eligible: TOOL_KIND.has(name), kind: TOOL_KIND.get(name) ?? null };
}

function extractMessageText(payload, role, metadata) {
	if (!Array.isArray(payload?.content)) return "";
	const requiredType = role === "user" ? "input_text" : "output_text";
	const parts = [];
	let unknownBlock = false;
	for (const block of payload.content) {
		if (!plainObject(block) || !SAFE_TEXT_BLOCK_TYPES.has(block.type)) {
			unknownBlock = true;
			continue;
		}
		if (block.type !== requiredType || typeof block.text !== "string") {
			unknownBlock = true;
			continue;
		}
		parts.push(block.text);
	}
	if (unknownBlock) bump(metadata, "unknownRows");
	return parts.join("\n");
}

function normalizeCapturedText(raw, metadata, limit) {
	const withoutRecall = stripRecalledContext(raw)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
	if (!withoutRecall || !/[\p{L}\p{N}]/u.test(withoutRecall)) return "";
	const scrubbed = scrubCodexText(withoutRecall);
	mergeRedactions(metadata.redactions, scrubbed.redactions);
	const bounded = truncateCodePointsHeadTail(scrubbed.text, limit);
	if (bounded.truncated) bump(metadata, "truncatedMessages");
	return bounded.text.trim();
}

function outputText(output, limit) {
	const pieces = [];
	if (typeof output === "string") pieces.push(output);
	else if (Array.isArray(output)) {
		for (const block of output) {
			if (plainObject(block) && SAFE_TEXT_BLOCK_TYPES.has(block.type) && typeof block.text === "string") {
				pieces.push(block.text);
			}
		}
	}
	return truncateCodePointsHeadTail(pieces.join("\n"), limit);
}

function durableProseKind(content, role) {
	if (role === "user") {
		if (/\b(?:fix|implement|add|remove|change|build|create|refactor|debug|test|verify|deploy|ship|investigate|diagnose|review|update|configure|support|remember|require|must|prefer|preference|decision|architecture|constraint|migration|bug|error|issue|never|do not)\b/i.test(content)) {
			return /\bprefer(?:ence)?\b/i.test(content) ? "user_preference" : "user_prompt";
		}
		return null;
	}
	if (/\barchitecture decision\b|\b(?:chose|choose|decision)\b.*\b(?:architecture|design|storage|database|queue|protocol)\b/i.test(content)) return "architecture_decision";
	if (/\b(?:root cause|bug (?:was )?fixed|fixed the bug|resolved the defect)\b/i.test(content)) return "bug_fix";
	if (/\b(?:unresolved|blocked|remaining issue|still failing|could not complete)\b/i.test(content)) return "unresolved_issue";
	if (/\b(?:implemented|fixed|added|removed|changed|created|built|refactored|verified|configured|updated|deployed|shipped|completed|tests? (?:pass|passed|fail|failed)|typecheck (?:pass|passed|fail|failed)|build (?:pass|passed|succeeded|failed))\b/i.test(content)) return "assistant_prose";
	return null;
}

function sourceEvent({ sessionId, discriminator, kind, sequence, outcome, toolName, exitCode, truncated = false }) {
	return {
		schema: "itsuki.source-event/v1",
		kind,
		event_id: `codex_event_${hash(`itsuki-codex-event:v1\0${sessionId}\0${discriminator}`).slice(0, 40)}`,
		...(outcome ? { outcome } : {}),
		...(toolName ? { tool_name: toolName } : {}),
		...(Number.isSafeInteger(exitCode) && exitCode >= -255 && exitCode <= 255 ? { exit_code: exitCode } : {}),
		sequence: Math.min(1_000_000, Math.max(0, sequence)),
		...(truncated ? { truncated: true } : {}),
	};
}

function explicitExitCode(text) {
	const match = /\b(?:process\s+)?exit(?:ed)?(?:\s+with)?(?:\s+code|\s+status)?\s*[:=]?\s*(-?\d+)\b/i.exec(text);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) && value >= -255 && value <= 255 ? value : null;
}

function explicitToolStatus(text, callStatus) {
	if (/\b(?:process\s+)?exit(?:ed)?(?:\s+with)?(?:\s+code|\s+status)?\s*[:=]?\s*[1-9]\d*\b/i.test(text)) return "failed";
	if (/\bscript failed\b|"(?:isError|success)"\s*:\s*(?:true|false)/i.test(text)) {
		if (/"isError"\s*:\s*true|"success"\s*:\s*false|\bscript failed\b/i.test(text)) return "failed";
	}
	if (/\b(?:process\s+)?exit(?:ed)?(?:\s+with)?(?:\s+code|\s+status)?\s*[:=]?\s*0\b/i.test(text)) return "succeeded";
	if (/\bscript completed\b|^Done!\s*$/m.test(text) || /"success"\s*:\s*true/i.test(text)) return "succeeded";
	if (callStatus === "completed") return "succeeded";
	if (callStatus === "failed") return "failed";
	return null;
}

function safeEvidence(text, metadata) {
	const evidence = [];
	for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
		const line = rawLine.trim();
		if (!line || line.length > 240) continue;
		if (!(
			/^(?:Test Files|Tests|Test Suites|Suites)\s+\d+\s+(?:passed|failed|skipped)(?:\s|$)/i.test(line)
			|| /^\d+\s+(?:tests?\s+)?(?:passed|failed|skipped)(?:\s|$)/i.test(line)
			|| /^(?:Build|Typecheck|Lint)\s+(?:succeeded|completed|passed|failed)\.?$/i.test(line)
			|| /^(?:Process exited with code|Exit code:)\s*\d+\.?$/i.test(line)
		)) continue;
		const scrubbed = scrubCodexText(line);
		mergeRedactions(metadata.redactions, scrubbed.redactions);
		evidence.push(truncateCodePoints(scrubbed.text, 180).text);
		if (evidence.length === 3) break;
	}
	return evidence;
}

function messageId(sessionId, discriminator, role, content) {
	return `codex_${hash(`itsuki-codex-message:v1\0${sessionId}\0${discriminator}\0${role}\0${content}`).slice(0, 40)}`;
}

function stableMessageIdentity(row, payload) {
	if (typeof payload?.id === "string" && payload.id.length > 0 && payload.id.length <= 200) return `id:${payload.id}`;
	if (typeof row?.timestamp === "string" && row.timestamp.length > 0 && row.timestamp.length <= 80 && Number.isFinite(Date.parse(row.timestamp))) {
		return `timestamp:${row.timestamp}`;
	}
	return null;
}

function parsedRowsFromBuffers(lineBuffers, limits, seed = {}, deadline = Number.POSITIVE_INFINITY) {
	const metadata = captureMetadata(seed);
	const rows = [];
	for (let index = 0; index < lineBuffers.length; index += 1) {
		if (Date.now() > deadline) {
			metadata.timeLimitExceeded = 1;
			bump(metadata, "omittedRows", lineBuffers.length - index);
			return { rows: [], metadata };
		}
		const buffer = lineBuffers[index];
		bump(metadata, "inputRows");
		if (buffer.length === 0 || /^\s*$/.test(buffer.toString("ascii"))) continue;
		if (buffer.length > limits.maxLineBytes) {
			bump(metadata, "oversizedRows");
			continue;
		}
		let text;
		try { text = TEXT_DECODER.decode(buffer); }
		catch {
			bump(metadata, "malformedRows");
			continue;
		}
		try {
			const value = JSON.parse(text);
			if (!plainObject(value)) throw new TypeError("row");
			rows.push(value);
			bump(metadata, "parsedRows");
		} catch {
			bump(metadata, "malformedRows");
		}
	}
	return { rows, metadata };
}

function splitBoundedLines(buffer, limits, seed = {}) {
	let view = buffer;
	let omittedBytes = Number(seed.omittedBytes ?? 0) || 0;
	if (seed.startedMidFile) {
		const newline = view.indexOf(0x0a);
		if (newline < 0) return { lines: [], seed: { ...seed, omittedRows: (seed.omittedRows ?? 0) + 1, omittedBytes: omittedBytes + view.length } };
		omittedBytes += newline + 1;
		view = view.subarray(newline + 1);
	}
	const lines = [];
	let start = 0;
	for (let index = 0; index <= view.length; index += 1) {
		if (index === view.length || view[index] === 0x0a) {
			let line = view.subarray(start, index);
			if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
			lines.push(line);
			start = index + 1;
		}
	}
	let omittedRows = Number(seed.omittedRows ?? 0) || 0;
	if (lines.length > limits.maxRows) {
		omittedRows += lines.length - limits.maxRows;
		lines.splice(0, lines.length - limits.maxRows);
	}
	return { lines, seed: { ...seed, omittedRows, omittedBytes } };
}

function transformRows(rows, metadata, { sessionId, limits, recallEchoFingerprints, suppressAssistantProse, deadline }) {
	const calls = new Map();
	const ambiguous = new Set();
	const outputCounts = new Map();
	const messageIdentities = new Map();
	for (let index = 0; index < rows.length; index += 1) {
		if (Date.now() > deadline) {
			metadata.timeLimitExceeded = 1;
			bump(metadata, "omittedRows", rows.length - index);
			return [];
		}
		const row = rows[index];
		if (row.type === "response_item" && plainObject(row.payload) && row.payload.type === "message") {
			const identity = stableMessageIdentity(row, row.payload);
			if (identity) {
				const fingerprint = hash(JSON.stringify({ role: row.payload.role, phase: row.payload.phase, content: row.payload.content }));
				const existing = messageIdentities.get(identity);
				if (!existing) messageIdentities.set(identity, { fingerprint, count: 1, ambiguous: false });
				else {
					existing.count += 1;
					if (existing.fingerprint !== fingerprint) existing.ambiguous = true;
				}
			}
		}
		if (row.type === "response_item" && plainObject(row.payload)
			&& (row.payload.type === "function_call_output" || row.payload.type === "custom_tool_call_output")) {
			const outputId = safeCallId(row.payload.call_id);
			if (outputId) outputCounts.set(outputId, (outputCounts.get(outputId) ?? 0) + 1);
		}
		if (row.type !== "response_item" || !plainObject(row.payload) || !CALL_TYPES.has(row.payload.type)) continue;
		const callId = safeCallId(row.payload.call_id);
		if (!callId) {
			bump(metadata, "ignoredToolRows");
			continue;
		}
		if (calls.has(callId)) {
			ambiguous.add(callId);
			continue;
		}
		calls.set(callId, {
			index,
			callType: row.payload.type,
			expectedOutput: CALL_TYPES.get(row.payload.type),
			status: safeToolName(row.payload.status),
			...toolDescriptor(row.payload),
		});
	}

	const candidates = [];
	const processedMessageIdentities = new Set();
	for (let index = 0; index < rows.length; index += 1) {
		if (Date.now() > deadline) {
			metadata.timeLimitExceeded = 1;
			bump(metadata, "omittedRows", rows.length - index);
			metadata.omittedMessages = Math.min(COUNTER_LIMIT, metadata.omittedMessages + candidates.length);
			metadata.candidateMessages = Math.min(COUNTER_LIMIT, candidates.length);
			metadata.returnedMessages = 0;
			return [];
		}
		const row = rows[index];
		if (META_ROW_TYPES.has(row.type)) {
			bump(metadata, "ignoredMetaRows");
			continue;
		}
		if (row.type === "event_msg") {
			if (row.payload?.type === "agent_message" || row.payload?.type === "user_message") bump(metadata, "ignoredEventDuplicates");
			else bump(metadata, "ignoredMetaRows");
			continue;
		}
		if (row.type !== "response_item" || !plainObject(row.payload)) {
			bump(metadata, "unknownRows");
			continue;
		}
		const payload = row.payload;
		if (payload.type === "reasoning") {
			bump(metadata, "ignoredReasoningRows");
			if (typeof payload.encrypted_content === "string" && payload.encrypted_content) bump(metadata, "ignoredEncryptedRows");
			continue;
		}
		if (CALL_TYPES.has(payload.type)) {
			if (!toolDescriptor(payload).eligible) bump(metadata, "ignoredToolRows");
			continue;
		}
		if (payload.type === "message") {
			const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
			if (role === "developer" || role === "system") {
				bump(metadata, "ignoredDeveloperSystemRows");
				continue;
			}
			if (role === "assistant" && payload.phase === "commentary") {
				bump(metadata, "ignoredCommentaryRows");
				continue;
			}
			if ((role !== "user" && role !== "assistant") || (role === "assistant" && payload.phase !== "final_answer")) {
				bump(metadata, "unknownRows");
				continue;
			}
			const stableIdentity = stableMessageIdentity(row, payload);
			if (!stableIdentity) {
				bump(metadata, "missingStableIdentityRows");
				continue;
			}
			const identityState = messageIdentities.get(stableIdentity);
			if (!identityState || identityState.ambiguous) {
				bump(metadata, "ambiguousMessageIdentityRows");
				continue;
			}
			if (processedMessageIdentities.has(stableIdentity)) {
				bump(metadata, "duplicateMessages");
				continue;
			}
			processedMessageIdentities.add(stableIdentity);
			if (role === "assistant" && suppressAssistantProse) {
				bump(metadata, "ignoredUnprotectedAssistantRows");
				continue;
			}
			let rawText = extractMessageText(payload, role, metadata);
			if (role === "assistant" && recallEchoFingerprints?.length) {
				const filtered = filterRecalledEchoText(rawText, recallEchoFingerprints);
				if (filtered.removed > 0) bump(metadata, "ignoredRecallEchoRows");
				rawText = filtered.text;
			}
			const content = normalizeCapturedText(
				rawText,
				metadata,
				limits.maxMessageCharacters,
			);
			if (!content) continue;
			const eventKind = durableProseKind(content, role);
			if (!eventKind) {
				bump(metadata, "ignoredNoiseRows");
				continue;
			}
			candidates.push({
				index,
				message: {
					id: messageId(sessionId, stableIdentity, role, content),
					role,
					content,
					source_event: sourceEvent({
						sessionId,
						discriminator: stableIdentity,
						kind: eventKind,
						sequence: index,
						// A final answer is an assistant assertion, not proof that a tool
						// actually changed or verified anything. Tool evidence is captured
						// separately with its own success/failure outcome.
						outcome: "unknown",
						truncated: Array.from(content).length >= limits.maxMessageCharacters,
					}),
				},
			});
			continue;
		}
		if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
			const callId = safeCallId(payload.call_id);
			if (!callId || !calls.has(callId)) {
				bump(metadata, "unmatchedToolOutputs");
				continue;
			}
			if (ambiguous.has(callId) || (outputCounts.get(callId) ?? 0) !== 1 || index <= calls.get(callId).index) {
				bump(metadata, "ambiguousToolCalls");
				continue;
			}
			const call = calls.get(callId);
			if (!call.eligible || call.expectedOutput !== payload.type) {
				bump(metadata, "ignoredToolRows");
				continue;
			}
			const boundedOutput = outputText(payload.output, limits.maxToolOutputCharacters);
			if (boundedOutput.truncated) bump(metadata, "truncatedToolOutputs");
			let text = boundedOutput.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			if (recallEchoFingerprints?.length) {
				const filtered = filterRecalledEchoText(text, recallEchoFingerprints);
				if (filtered.removed > 0) bump(metadata, "ignoredRecallEchoRows");
				text = filtered.text;
			}
			const status = explicitToolStatus(text, call.status);
			if (!status) {
				bump(metadata, "ignoredToolRows");
				continue;
			}
			const evidence = safeEvidence(text, metadata);
			const content = `Codex tool outcome: ${call.kind} ${status}.${evidence.length ? ` Evidence: ${evidence.join("; ")}` : ""}`;
			const eventKind = call.kind === "workspace patch"
				? "file_change"
				: evidence.some((line) => /\b(?:tests?|test files|test suites|suites)\b/i.test(line))
					? "test_result"
					: "command_result";
			candidates.push({
				index,
				message: {
					id: messageId(sessionId, callId, "tool", content),
					role: "tool",
					content,
					source_event: sourceEvent({
						sessionId,
						discriminator: callId,
						kind: eventKind,
						sequence: index,
						outcome: status === "succeeded" ? "success" : "failure",
						toolName: call.kind === "workspace patch" ? "Write" : "RunCommand",
						exitCode: explicitExitCode(text),
						truncated: boundedOutput.truncated,
					}),
				},
			});
			continue;
		}
		if (payload.type === "agent_message") {
			bump(metadata, "ignoredEventDuplicates");
			continue;
		}
		bump(metadata, "unknownRows");
	}

	metadata.candidateMessages = Math.min(COUNTER_LIMIT, candidates.length);
	const retained = candidates.length > limits.maxMessages
		? candidates.slice(candidates.length - limits.maxMessages)
		: candidates;
	metadata.omittedMessages = Math.min(COUNTER_LIMIT, candidates.length - retained.length);
	metadata.returnedMessages = retained.length;
	return retained.sort((left, right) => left.index - right.index).map(({ message }) => message);
}

export function parseCodexTranscriptBuffer(buffer, options = {}) {
	const limits = { ...DEFAULT_CODEX_SCAN_LIMITS, ...(options.limits ?? {}) };
	const startedAt = Date.now();
	const scanBudgetMs = Math.min(2_000, Math.max(0, Number(limits.maxScanMs) || 0));
	const deadline = startedAt + scanBudgetMs;
	const bounded = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
	if (scanBudgetMs === 0) {
		return { messages: [], metadata: captureMetadata({ omittedBytes: bounded.length, scanBytes: 0, timeLimitExceeded: true }) };
	}
	const tail = bounded.length > limits.maxScannedBytes
		? bounded.subarray(bounded.length - limits.maxScannedBytes)
		: bounded;
	const split = splitBoundedLines(tail, limits, {
		startedMidFile: bounded.length > limits.maxScannedBytes,
		omittedBytes: Math.max(0, bounded.length - limits.maxScannedBytes),
	});
	const parsed = parsedRowsFromBuffers(split.lines, limits, { ...split.seed, scanBytes: tail.length }, deadline);
	if (parsed.metadata.timeLimitExceeded) return { messages: [], metadata: parsed.metadata };
	const sessionId = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : "unknown-session";
	return { messages: transformRows(parsed.rows, parsed.metadata, {
		sessionId,
		limits,
		recallEchoFingerprints: options.recallEchoFingerprints ?? [],
		suppressAssistantProse: options.suppressAssistantProse === true,
		deadline,
	}), metadata: parsed.metadata };
}

export function parseCodexTranscriptText(text, options = {}) {
	return parseCodexTranscriptBuffer(Buffer.from(String(text ?? ""), "utf8"), options);
}

export async function readCodexTranscript(path, options = {}) {
	if (typeof path !== "string" || !path) throw new TypeError("invalid transcript path");
	const limits = { ...DEFAULT_CODEX_SCAN_LIMITS, ...(options.limits ?? {}) };
	const scanBudgetMs = Math.min(2_000, Math.max(0, Number(limits.maxScanMs) || 0));
	const deadline = Date.now() + scanBudgetMs;
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("transcript is not a regular file");
	if (scanBudgetMs === 0) {
		return { messages: [], metadata: captureMetadata({ omittedBytes: info.size, scanBytes: 0, timeLimitExceeded: true }) };
	}
	const size = info.size;
	const start = Math.max(0, size - limits.maxScannedBytes);
	const length = size - start;
	const handle = await open(path, "r");
	let buffer;
	let handleInfo;
	try {
		buffer = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const result = await handle.read(buffer, offset, length - offset, start + offset);
			if (!result.bytesRead) break;
			offset += result.bytesRead;
			if (Date.now() > deadline) break;
		}
		buffer = buffer.subarray(0, offset);
		if (typeof options.afterSnapshotRead === "function") await options.afterSnapshotRead();
		handleInfo = await handle.stat();
	} finally {
		await handle.close();
	}
	const pathInfo = await lstat(path).catch(() => null);
	const changed = !pathInfo
		|| handleInfo.size !== info.size
		|| handleInfo.mtimeMs !== info.mtimeMs
		|| pathInfo.size !== info.size
		|| pathInfo.mtimeMs !== info.mtimeMs
		|| (Number.isSafeInteger(info.ino) && info.ino !== 0 && pathInfo.ino !== info.ino)
		|| (Number.isSafeInteger(info.dev) && pathInfo.dev !== info.dev);
	if (changed || Date.now() > deadline || buffer.length !== length) {
		return {
			messages: [],
			metadata: captureMetadata({
				omittedBytes: start + Math.max(0, length - buffer.length),
				scanBytes: buffer.length,
				fileChanged: changed,
				timeLimitExceeded: Date.now() > deadline || buffer.length !== length,
			}),
		};
	}
	const split = splitBoundedLines(buffer, limits, {
		startedMidFile: start > 0,
		omittedBytes: start,
	});
	const parsed = parsedRowsFromBuffers(split.lines, limits, { ...split.seed, scanBytes: buffer.length }, deadline);
	if (parsed.metadata.timeLimitExceeded) return { messages: [], metadata: parsed.metadata };
	const sessionId = typeof options.sessionId === "string" && options.sessionId ? options.sessionId : "unknown-session";
	return { messages: transformRows(parsed.rows, parsed.metadata, {
		sessionId,
		limits,
		recallEchoFingerprints: options.recallEchoFingerprints ?? [],
		suppressAssistantProse: options.suppressAssistantProse === true,
		deadline,
	}), metadata: parsed.metadata };
}
