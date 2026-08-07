import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import { normalizeSourceEvent, SOURCE_EVENT_SCHEMA } from "../src/lib/source_event.mjs";
import { scrubText } from "../src/pipeline/scrub.js";
import { recallEchoFingerprintsForLine } from "./recall-echo.mjs";

export const CLAUDE_CAPTURE_SCHEMA = "itsuki.claude-capture/v1";
export { SOURCE_EVENT_SCHEMA };
export const CLAUDE_SOURCE_EVENT_SCHEMA = SOURCE_EVENT_SCHEMA;
export const CLAUDE_CAPTURE_MESSAGE_ID_VERSION = "claude_capture_v1";
export const DEFAULT_CLAUDE_CAPTURE_MAX_CHARS = 1_200;
export const DEFAULT_CLAUDE_CAPTURE_MAX_COMPANION_ROWS = 320;

export const ITSUKI_RECALL_CONTEXT_MARKER_V1 = "<itsuki-recalled-context-v1>";
export const ITSUKI_RECALL_CONTEXT_END_MARKER_V1 = "</itsuki-recalled-context-v1>";
export const ITSUKI_LEGACY_RECALL_PREFIXES = Object.freeze([
	"Itsuki project memory for ",
	"Itsuki project memory is unavailable this session",
]);

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell", "RunCommand"]);
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const CANONICAL_CAPTURE_TOOL_NAMES = new Set([
	"AskUserQuestion",
	"Bash",
	"Edit",
	"NotebookEdit",
	"PowerShell",
	"RunCommand",
	"Shell",
	"Write",
]);
const IGNORED_TOOL_NAMES = new Set([
	"read",
	"grep",
	"glob",
	"webfetch",
	"websearch",
	"toolsearch",
	"agent",
	"monitor",
	"taskcreate",
	"taskupdate",
	"taskstop",
	"artifact",
]);
const DURABLE_USER_RE = /\b(?:i|we)\s+(?:decided|choose|chose|prefer|want to keep|will always|will never|must|need to|use|keep|avoid|do not|don't)\b|\b(?:from now on|architecture decision|project convention|coding convention|always use|never use)\b/i;
const USER_PREFERENCE_RE = /\b(?:i|we)\s+(?:prefer|want to keep|will always|will never|always|never|avoid|do not|don't)\b|\b(?:from now on|always use|never use)\b/i;
const ASSISTANT_DECISION_RE = /\b(?:decided|architecture decision|design decision|convention|chose|choice|will keep|will use|will avoid)\b/i;
const ARCHITECTURE_DECISION_RE = /\b(?:architecture|architectural|design)\b/i;
const ASSISTANT_OUTCOME_RE = /\b(?:implemented|fixed|resolved|changed|added|removed|migrated|deployed|published|committed|tests? (?:now )?(?:pass|passed|passing)|build (?:passes|passed|succeeded)|lint (?:passes|passed|is clean))\b/i;
const UNRESOLVED_RE = /\b(?:unresolved|still failing|remains? blocked|blocked by|could not complete|cannot complete|not fixed|follow[- ]?up required)\b/i;
const DEPENDENCY_NOISE_RE = /^(?:npm\s+(?:warn|notice)|pnpm\s+(?:warn|notice)|yarn\s+warning|added\s+\d+\s+packages?|audited\s+\d+\s+packages?|collecting\s+|downloading\s+|installing\s+|requirement already satisfied\b)/i;
const DIFF_LINE_RE = /^(?:diff --git\b|index\s+[0-9a-f]+\.\.[0-9a-f]+|@@(?:\s|$)|\+\++(?:\s|$)|---+(?:\s|$))/i;
const STACK_LINE_RE = /^\s*(?:at\s+\S+|File\s+"[^"]+",\s+line\s+\d+|\.{3}\s+\d+\s+more\b)/i;
const PROGRESS_RE = /^\s*(?:[|/\\-]\s*)?(?:\d{1,3}%|\[[-= >.]+\])\s*$/;
const RAW_COMMAND_RE = /(?:^|[`$>]\s*|\b)(?:(?:npm|pnpm|yarn|bun)\s+(?:run|test|exec|install|add|remove|build|lint|deploy)\b|npx\s+\S+|git\s+(?:add|commit|push|pull|checkout|switch|reset|clean|status|diff|log)\b|wrangler\s+\S+|(?:cargo|go|dotnet|mvnw?|gradlew?)\s+(?:test|build|check|run|package|verify)\b|tsc(?:\.cmd)?\s+\S+|wrangler\s+\S+|curl\s+[-\w]|wget\s+[-\w]|(?:bash|sh|zsh|powershell|pwsh|cmd(?:\.exe)?)\s+(?:-|\/c)|(?:node|python(?:3)?|pytest|vitest|jest)\s+\S+)/i;
const RAW_CODE_RE = /^\s*(?:const|let|var|function|class|interface|type|import|export|def|#include)\b|^\s*["']?[A-Za-z_$][\w$.-]*["']?\s*(?::|[+*/%-]?=)\s*.+|(?:=>|[{};])\s*$/i;
// (The old NAMED_SECRET_RE extra pass was removed here — CLD-02: the shared
// scrub lane below covers every labeled class, and the bare-whitespace form
// over-redacted ordinary prose in durable capture.)

function sha256(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function codePointLength(value) {
	return Array.from(String(value ?? "")).length;
}

function boundedText(value, maxChars) {
	const points = Array.from(String(value ?? ""));
	if (points.length <= maxChars) {
		return { text: points.join(""), truncated: false, omittedCharacters: 0 };
	}
	const marker = "\n\u2026[output abbreviated]\u2026\n";
	const markerLength = codePointLength(marker);
	const keep = Math.max(0, maxChars - markerLength);
	const head = Math.floor(keep / 3);
	const tail = keep - head;
	return {
		text: `${points.slice(0, head).join("")}${marker}${points.slice(-tail).join("")}`,
		truncated: true,
		omittedCharacters: Math.max(0, points.length - keep),
	};
}

function normalizeWhitespace(value) {
	return String(value ?? "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.trim();
}

export function sanitizeItsukiRecallContextText(text) {
	// Recalled memory is user-derived. Neutralize literal delimiters before
	// wrapping so an embedded closing token cannot expose a suffix to the next
	// SessionEnd capture pass.
	return String(text ?? "")
		.replaceAll(ITSUKI_RECALL_CONTEXT_MARKER_V1, "&lt;itsuki-recalled-context-v1&gt;")
		.replaceAll(ITSUKI_RECALL_CONTEXT_END_MARKER_V1, "&lt;/itsuki-recalled-context-v1&gt;");
}

export function formatItsukiRecallContext(text) {
	const safe = sanitizeItsukiRecallContextText(text);
	return `${ITSUKI_RECALL_CONTEXT_MARKER_V1}\n${safe}\n${ITSUKI_RECALL_CONTEXT_END_MARKER_V1}`;
}

/**
 * Remove only Itsuki's versioned recalled-context blocks. Legacy unmarked
 * banners are dropped only when they begin the logical row (possibly inside
 * Claude's documented system-reminder wrapper), so ordinary discussion of
 * Itsuki is not mistaken for injected context.
 */
export function stripItsukiRecallContext(value) {
	let text = String(value ?? "");
	for (;;) {
		const start = text.indexOf(ITSUKI_RECALL_CONTEXT_MARKER_V1);
		if (start < 0) break;
		const end = text.indexOf(ITSUKI_RECALL_CONTEXT_END_MARKER_V1, start + ITSUKI_RECALL_CONTEXT_MARKER_V1.length);
		text = end < 0
			? text.slice(0, start)
			: `${text.slice(0, start)}${text.slice(end + ITSUKI_RECALL_CONTEXT_END_MARKER_V1.length)}`;
	}
	const logicalStart = text.trimStart().replace(/^<system-reminder>\s*/i, "");
	if (ITSUKI_LEGACY_RECALL_PREFIXES.some((prefix) => logicalStart.startsWith(prefix))) return "";
	return text;
}

function contentBlocks(row) {
	const content = row?.message?.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content : [];
}

function toolLeaf(name) {
	return String(name ?? "").trim().split("__").at(-1)?.toLowerCase() ?? "";
}

function isMemoryTool(name) {
	const leaf = toolLeaf(name);
	return ["recall_memory", "search_memory", "save_memory", "save_conversation"].includes(leaf);
}

function isBrowserTool(name) {
	return /(?:^|__)claude_browser__|(?:^|__)(?:computer|navigate|javascript_tool|read_page|preview_(?:start|stop|logs))$/i.test(String(name ?? ""));
}

function ignoredTool(name) {
	const leaf = toolLeaf(name);
	return !CANONICAL_CAPTURE_TOOL_NAMES.has(String(name ?? "").trim())
		|| isMemoryTool(name)
		|| isBrowserTool(name)
		|| IGNORED_TOOL_NAMES.has(leaf);
}

function rowAttributionIsMemory(row) {
	return isMemoryTool(row?.attributionMcpTool ?? row?.attribution_mcp_tool);
}

function rowContainsItsukiRecallContext(row) {
	return contentBlocks(row).some((block) => {
		if (block?.type !== "text" || typeof block.text !== "string") return false;
		const text = block.text;
		if (text.includes(ITSUKI_RECALL_CONTEXT_MARKER_V1)) return true;
		const logicalStart = text.trimStart().replace(/^<system-reminder>\s*/i, "");
		return ITSUKI_LEGACY_RECALL_PREFIXES.some((prefix) => logicalStart.startsWith(prefix));
	});
}

/** Predicate shared with the reverse tail reader. */
export function isClaudeCaptureEligibleRow(row, options = {}) {
	return analyzeCaptureRow(row, options).eligible;
}

/**
 * Rows that must remain visible while deciding which completed events belong
 * in a bounded tail. This is deliberately broader than independent capture
 * eligibility: ignored and memory tool calls still participate in the FIFO
 * correlation of reused tool-use IDs.
 */
export function isClaudeCaptureCorrelationRow(row, options = {}) {
	if (!row || typeof row !== "object" || Array.isArray(row) || row.isMeta === true) return false;
	if (isClaudeCaptureEligibleRow(row, options)) return true;
	const blocks = contentBlocks(row);
	if (rowAttributionIsMemory(row)) {
		return blocks.some((block) => block?.type === "tool_use" || block?.type === "tool_result");
	}
	return blocks.some((block) => block?.type === "tool_use");
}

function parseRecord(input, ordinal) {
	let row = input;
	let byteOffset = null;
	if (input && typeof input === "object" && !Array.isArray(input) && typeof input.raw === "string") {
		byteOffset = Number.isSafeInteger(input.byteOffset) && input.byteOffset >= 0 ? input.byteOffset : null;
		row = input.raw;
	}
	if (typeof row === "string") {
		try { row = JSON.parse(row); }
		catch { return { malformed: true, ordinal, byteOffset, row: null }; }
	}
	return {
		malformed: !row || typeof row !== "object" || Array.isArray(row),
		ordinal,
		byteOffset,
		row,
	};
}

function timestampOf(row) {
	const parsed = Date.parse(row?.timestamp ?? "");
	return Number.isFinite(parsed) ? parsed : null;
}

function identityNamespace(options = {}) {
	return [
		`session:${String(options.sessionId ?? "")}`,
		`transcript:${String(options.transcriptId ?? "")}`,
	];
}

function eventIdentity(record, kind, blockOrdinal, content, options, fallbackOccurrences) {
	const row = record.row;
	const hostId = String(row?.uuid ?? row?.event_id ?? row?.eventId ?? "").trim();
	let source;
	if (hostId) {
		source = ["host", hostId, kind, blockOrdinal];
	} else {
		const base = [
			...identityNamespace(options),
			row?.message?.id ?? row?.message_id ?? "",
			row?.timestamp ?? "",
			kind,
			blockOrdinal,
			sha256(content),
		];
		if (record.byteOffset == null) {
			// A caller that lacks both a host ID and an absolute transcript offset
			// cannot give identical duplicate rows a window-independent position.
			// Count only captured twins here; the production tail reader supplies
			// byteOffset, which is the stable path across moving windows.
			const occurrenceKey = base.join("\0");
			const occurrence = fallbackOccurrences.get(occurrenceKey) ?? 0;
			fallbackOccurrences.set(occurrenceKey, occurrence + 1);
			source = ["fallback", ...base, `occurrence:${occurrence}`];
		} else {
			source = ["fallback", ...base, `byte:${record.byteOffset}`];
		}
	}
	const digest = sha256([CLAUDE_CAPTURE_MESSAGE_ID_VERSION, ...source].join("\0"));
	return {
		id: `${CLAUDE_CAPTURE_MESSAGE_ID_VERSION}_${hostId ? "h" : "f"}_${digest.slice(0, 32)}`,
	};
}

function toolParentIdentity(record, use, blockOrdinal, options, fallbackOccurrences) {
	const row = record.row;
	const hostId = String(row?.uuid ?? row?.event_id ?? row?.eventId ?? "").trim();
	const base = [
		...identityNamespace(options),
		String(row?.message?.id ?? row?.message_id ?? ""),
		String(row?.timestamp ?? ""),
		String(use?.id ?? ""),
		String(use?.name ?? ""),
		blockOrdinal,
	];
	let source;
	if (hostId) {
		source = ["host", hostId, ...base.slice(3)];
	} else if (record.byteOffset !== null) {
		source = ["byte", ...base, record.byteOffset];
	} else {
		const occurrenceKey = base.join("\0");
		const occurrence = fallbackOccurrences.get(occurrenceKey) ?? 0;
		fallbackOccurrences.set(occurrenceKey, occurrence + 1);
		source = ["fallback", ...base, `occurrence:${occurrence}`];
	}
	return `claude_tool_v1_${sha256(source.join("\0")).slice(0, 40)}`;
}

function mergeRedactions(metadata, redactions) {
	for (const [kind, count] of Object.entries(redactions ?? {})) {
		metadata.redactions[kind] = (metadata.redactions[kind] ?? 0) + count;
	}
}

// Exported as a test seam: the canonical security corpus
// (test/fixtures/security_corpus.mjs) drives every scrubber in the stack.
//
// This is the shared server scrub lane verbatim (scrubText): since the
// labeled/prose/.env/JSON families moved server-side (SEC-01/SEC-02), the
// hook's old extra NAMED_SECRET_RE pass caught nothing the shared lane
// misses while its bare-whitespace separator ate ordinary prose — "token
// bucket", "bearer of bad news" — destroying legitimate capture content
// (CLD-02, found by the corpus).
export function scrubCaptureText(value) {
	const result = scrubText(value);
	return { text: result.text, redactions: { ...result.redactions } };
}

function redact(value, metadata) {
	const result = scrubCaptureText(value);
	for (const [kind, count] of Object.entries(result.redactions)) {
		metadata.redactions[kind] = (metadata.redactions[kind] ?? 0) + count;
	}
	return result.text;
}

function safeLines(value, { allowMarkdownBullets = false } = {}) {
	let inFence = false;
	let inDiff = false;
	const kept = [];
	for (const raw of normalizeWhitespace(value).split("\n")) {
		let line = raw.trim();
		if (/^```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!line) {
			inDiff = false;
			continue;
		}
		if (inFence) continue;
		if (DIFF_LINE_RE.test(line)) {
			inDiff = true;
			continue;
		}
		if (inDiff && /^[+-]/.test(line)) continue;
		if (/^\+/.test(line) || /^-\S/.test(line)) continue;
		if (/^[-*]\s+/.test(line)) {
			if (!allowMarkdownBullets) continue;
			line = line.replace(/^[-*]\s+/, "");
			if (!DURABLE_USER_RE.test(line) && !ASSISTANT_DECISION_RE.test(line) && !UNRESOLVED_RE.test(line)) continue;
		}
		if (STACK_LINE_RE.test(line) || DEPENDENCY_NOISE_RE.test(line) || PROGRESS_RE.test(line)) continue;
		kept.push(line);
	}
	return kept;
}

function selectTextLines(value, predicate) {
	return safeLines(stripItsukiRecallContext(value), { allowMarkdownBullets: true })
		.filter((line) => !RAW_COMMAND_RE.test(line) && !RAW_CODE_RE.test(line) && predicate(line));
}

function selectText(value, predicate, maxLines = 4) {
	return selectTextLines(value, predicate).slice(-maxLines).join("\n");
}

function recallEchoFingerprintSet(options = {}) {
	if (options.recallFingerprintSet instanceof Set) return options.recallFingerprintSet;
	return new Set(
		(Array.isArray(options.recallFingerprints) ? options.recallFingerprints : [])
			.filter((value) => /^sha256:[a-f0-9]{64}$/.test(value))
			.slice(0, 128),
	);
}

function suppressRecalledAssistantLines(value, options = {}) {
	const fingerprints = recallEchoFingerprintSet(options);
	const sessionId = String(options.sessionId ?? "").trim();
	if (!sessionId || fingerprints.size === 0) return { text: value, suppressed: 0 };
	const kept = [];
	let suppressed = 0;
	for (const line of String(value ?? "").split("\n")) {
		const variants = recallEchoFingerprintsForLine(line, { sessionId });
		if (variants.some((fingerprint) => fingerprints.has(fingerprint))) {
			suppressed += 1;
			continue;
		}
		kept.push(line);
	}
	return { text: kept.join("\n"), suppressed };
}

function durableTextEvent(row, options = {}, metadata = null) {
	const text = contentBlocks(row)
		.filter((block) => block?.type === "text")
		.map((block) => stripItsukiRecallContext(block.text))
		.filter(Boolean)
		.join("\n");
	if (!normalizeWhitespace(text)) return null;
	if (row.type === "user") {
		const selected = selectText(text, (line) => DURABLE_USER_RE.test(line));
		return selected ? {
			kind: USER_PREFERENCE_RE.test(selected) ? "user_preference" : "decision",
			origin: "user_text",
			status: "observed",
			summary: selected,
		} : null;
	}
	const candidates = selectTextLines(
		text,
		(line) => ASSISTANT_DECISION_RE.test(line) || ASSISTANT_OUTCOME_RE.test(line) || UNRESOLVED_RE.test(line),
	);
	if (options.suppressAssistantProse === true) {
		if (metadata) metadata.ignoredUnprotectedAssistantEvents += candidates.length;
		return null;
	}
	const filtered = suppressRecalledAssistantLines(candidates.join("\n"), options);
	if (metadata && filtered.suppressed > 0) {
		metadata.ignoredRecallEchoEvents += filtered.suppressed;
	}
	const selected = filtered.text.split("\n").filter(Boolean).slice(-4).join("\n");
	if (!selected) return null;
	const kind = UNRESOLVED_RE.test(selected)
		? "unresolved_issue"
		: ARCHITECTURE_DECISION_RE.test(selected)
			? "architecture_decision"
			: ASSISTANT_DECISION_RE.test(selected)
				? "decision"
				: /\b(?:fixed|resolved)\b/i.test(selected) ? "bug_fix" : "assistant_prose";
	return { kind, origin: "assistant_text", status: kind === "unresolved_issue" ? "blocked" : "observed", summary: selected };
}

const CAPTURE_EXCLUSION_COUNTER_KEYS = Object.freeze([
	"inputRows",
	"ineligibleRows",
	"ignoredThinkingBlocks",
	"ignoredMetaRows",
	"ignoredToolEvents",
	"ignoredRecallEvents",
	"ignoredRecallEchoEvents",
	"ignoredUnprotectedAssistantEvents",
	"ignoredNoiseEvents",
]);

function emptyCaptureExclusionEvidence(inputRows = 0) {
	return Object.fromEntries(CAPTURE_EXCLUSION_COUNTER_KEYS.map((key) => [key, key === "inputRows" ? inputRows : 0]));
}

function analyzeCaptureRow(row, options = {}) {
	const counters = emptyCaptureExclusionEvidence(1);
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		counters.ineligibleRows = 1;
		return { eligible: false, textEvent: null, blocks: [], counters };
	}
	if (row.isMeta === true) {
		counters.ignoredMetaRows = 1;
		return { eligible: false, textEvent: null, blocks: contentBlocks(row), counters };
	}
	const blocks = contentBlocks(row);
	if (rowAttributionIsMemory(row)) {
		counters.ignoredRecallEvents = 1;
		return { eligible: false, textEvent: null, blocks, counters };
	}
	if (row.type !== "user" && row.type !== "assistant") {
		counters.ineligibleRows = 1;
		return { eligible: false, textEvent: null, blocks, counters };
	}

	const textEvent = durableTextEvent(row, options, counters);
	const containsRecallContext = rowContainsItsukiRecallContext(row);
	const eligibleTool = blocks.some((block) => (
		block?.type === "tool_result"
		|| (block?.type === "tool_use" && !ignoredTool(block.name))
	));
	const eligible = Boolean(textEvent) || eligibleTool;
	counters.ignoredThinkingBlocks = blocks.filter((block) => block?.type === "thinking").length;
	counters.ignoredRecallEvents += blocks.filter((block) => block?.type === "tool_use" && isMemoryTool(block.name)).length;
	if (containsRecallContext) counters.ignoredRecallEvents += 1;
	if (!eligible) counters.ineligibleRows = 1;
	if (
		blocks.some((block) => block?.type === "text")
		&& !textEvent
		&& counters.ignoredRecallEchoEvents === 0
		&& counters.ignoredUnprotectedAssistantEvents === 0
		&& !containsRecallContext
	) counters.ignoredNoiseEvents = 1;
	return { eligible, textEvent, blocks, counters };
}

/** Content-free counters for rows excluded before the transcript transform. */
export function claudeCaptureExclusionEvidence(row, options = {}) {
	return { ...analyzeCaptureRow(row, options).counters };
}

function mergeCaptureExclusionEvidence(target, source) {
	for (const key of CAPTURE_EXCLUSION_COUNTER_KEYS) {
		target[key] = (target[key] ?? 0) + Number(source?.[key] ?? 0);
	}
}

function toolResultText(block, row) {
	const parts = [];
	const addPart = (value) => {
		if (typeof value !== "string" || !value) return;
		if (parts.some((part) => part.includes(value))) return;
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			if (value.includes(parts[index])) parts.splice(index, 1);
		}
		parts.push(value);
	};
	addPart(block?.content);
	for (const nested of Array.isArray(block?.content) ? block.content : []) {
		if (nested?.type === "text") addPart(nested.text);
	}
	const result = row?.toolUseResult;
	if (typeof result === "string") addPart(result);
	else if (result && typeof result === "object" && !Array.isArray(result)) {
		addPart(result.stdout);
		addPart(result.stderr);
	}
	return parts.join("\n");
}

function resultStatus(block, row, text, { classifiedCommand = false } = {}) {
	const structured = row?.toolUseResult;
	let structuredSuccess = false;
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		if (structured.interrupted === true) return "interrupted";
		const timeout = structured.timedOutAfterMs ?? structured.timed_out_after_ms;
		if (timeout !== null && timeout !== undefined && Number.isFinite(Number(timeout)) && Number(timeout) > 0) return "timed_out";
		const structuredStatus = String(structured.status ?? "").toLowerCase();
		if (["failed", "failure", "error"].includes(structuredStatus)) return "failed";
		if (["timed_out", "timeout"].includes(structuredStatus)) return "timed_out";
		structuredSuccess = ["succeeded", "success", "completed", "complete"].includes(structuredStatus);
	}
	const exitCode = resultExitCode(row, text);
	if (exitCode !== null && exitCode !== 0) return "failed";
	if (block?.is_error === true) return "failed";
	if (block?.is_error === false && !classifiedCommand) return "succeeded";
	if (/\b[1-9]\d{0,6}\s+(?:tests?\s+)?(?:failed|errors?)\b/i.test(text)) return "failed";
	if (/\b(?:timed?\s*out|timeout)\b/i.test(text)) return "timed_out";
	const withoutZeroFailures = String(text ?? "")
		.replace(/\b0\s+(?:tests?\s+)?(?:failed|failures?|errors?)\b/gi, "")
		.replace(/\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi, "");
	if (
		/\bexit(?:ed)?\s+(?:code|status)\s*[1-9]\d*\b/i.test(withoutZeroFailures)
		|| /(?:^|\n)\s*(?:fatal|error)\b:?/i.test(withoutZeroFailures)
		|| /\b(?:command|build|deployment|test(?:s|\s+suite)?)\s+(?:failed|failure)\b/i.test(withoutZeroFailures)
		|| /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]\d{0,6}\b/i.test(withoutZeroFailures)
		|| /\b[1-9]\d{0,6}\s+(?:failures?|errors?)\b/i.test(withoutZeroFailures)
		|| /\bfailures?!/i.test(withoutZeroFailures)
	) return "failed";
	if (exitCode === 0) return "succeeded";
	if (block?.is_error === false) return "succeeded";
	if (structuredSuccess) return "succeeded";
	return "unknown";
}

function resultExitCode(row, text) {
	const structured = row?.toolUseResult;
	const direct = structured && typeof structured === "object" && !Array.isArray(structured)
		? Number(structured.exitCode ?? structured.exit_code ?? structured.returnCode ?? structured.return_code)
		: Number.NaN;
	if (Number.isSafeInteger(direct) && direct >= -255 && direct <= 255) return direct;
	const match = /\b(?:exit(?:ed)?\s+(?:code|status)|return\s+code)\s*[:=]?\s*(-?\d{1,3})\b/i.exec(text);
	const parsed = Number(match?.[1]);
	return Number.isSafeInteger(parsed) && parsed >= -255 && parsed <= 255 ? parsed : null;
}

function canonicalOutcome(status) {
	if (status === "succeeded") return "success";
	if (["failed", "timed_out", "interrupted", "blocked"].includes(status)) return "failure";
	if (status === "partial") return "partial";
	return "unknown";
}

function canonicalToolName(value) {
	const name = String(value ?? "").trim();
	return CANONICAL_CAPTURE_TOOL_NAMES.has(name) ? name : null;
}

function safeProjectPath(value, cwd) {
	const raw = normalizeWhitespace(value).split("\n", 1)[0].replace(/\t/g, " ").replace(/\\/g, "/");
	if (!raw) return "a project file";
	if (RAW_COMMAND_RE.test(raw)) return "a project file";
	const display = (candidate) => candidate
		.replace(/[^\p{L}\p{N} ._@/+=~-]/gu, "_")
		.replace(/\s{2,}/g, " ")
		.slice(0, 240) || "a project file";
	const normalizedCwd = normalizeWhitespace(cwd).split("\n", 1)[0].replace(/\t/g, " ").replace(/\\/g, "/").replace(/\/$/, "");
	if (normalizedCwd && raw.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
		return display(raw.slice(normalizedCwd.length + 1));
	}
	if (/^(?:[a-z]:\/|\/)/i.test(raw) || isAbsolute(raw)) return display(basename(raw));
	const candidate = raw.replace(/^\.\//, "");
	if (candidate.split("/").includes("..")) return display(basename(candidate));
	return display(candidate);
}

function commandKind(command) {
	const text = String(command ?? "").trim().toLowerCase();
	// Only classify one directly invoked command. Shell composition, output
	// redirection, wrappers such as `echo`, and substitutions can mention a
	// command without executing the claimed operation.
	if (!text || /[\r\n;&|<>`]/.test(text) || /\$\(/.test(text)) return null;
	if (
		/(?:^|\s)(?:--help|--version|--listtests|--list-tests|--collect-only|--collectonly|--fixtures|--showconfig|--printconfig|--dry-run|--if-present|-h)(?:[=\s]|$)/.test(text)
		|| /^(?:(?:npx|bunx|yarn\s+dlx|pnpm\s+(?:dlx|exec))\s+)?vitest\s+list\b/.test(text)
	) return null;
	const packageExec = "(?:(?:npx|bunx|yarn\\s+dlx|pnpm\\s+(?:dlx|exec))\\s+)?";
	const commit = /^git(?:\.exe)?\s+commit\b/.test(text);
	if (commit) {
		if (/(?:^|\s)-n(?:\s|$)/.test(text)) return null;
		return { kind: "git_commit", family: "git", noun: "Git commit" };
	}
	const deploy = new RegExp(
		`^(?:${packageExec}wrangler(?:\\.cmd)?\\s+(?:deploy|publish|pages\\s+deploy)|${packageExec}vercel(?:\\s+deploy)?|${packageExec}netlify\\s+deploy|fly(?:ctl)?\\s+deploy|firebase\\s+deploy|kubectl\\s+apply|helm\\s+upgrade|gcloud\\s+[^\\s]+(?:\\s+[^\\s]+)*\\s+deploy|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?deploy)\\b`,
	).test(text);
	if (deploy) {
		return { kind: "deployment_result", family: "deploy", noun: "Deployment" };
	}
	if (new RegExp(`^(?:${packageExec}(?:vitest|jest|pytest|unittest)|go\\s+test|cargo\\s+test|dotnet\\s+test|mvnw?\\s+test|gradlew?\\s+test|rspec|phpunit|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test)\\b`).test(text)) {
		if (/(?:^|\s)--list(?:[=\s]|$)/.test(text)) return null;
		return { kind: "test_result", family: "test", noun: "Tests" };
	}
	if (new RegExp(`^(?:${packageExec}(?:eslint|stylelint|pylint|flake8|ruff(?:\\s+check)?|biome\\s+(?:check|lint)|golangci-lint)|cargo\\s+clippy|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?lint)\\b`).test(text)) {
		return { kind: "command_result", family: "lint", noun: "Lint" };
	}
	if (new RegExp(`^(?:${packageExec}tsc(?:\\.cmd)?(?:\\s+--noemit)?|cargo\\s+(?:build|check)|go\\s+build|dotnet\\s+build|mvnw?\\s+(?:package|verify)|gradlew?\\s+build|(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?build)\\b`).test(text)) {
		return { kind: "command_result", family: "build", noun: "Build" };
	}
	return null;
}

function structuralTestEvidence(lines) {
	const facts = [];
	for (const line of lines) {
		const counts = [];
		for (const match of line.matchAll(/\b(\d{1,7})\s+(passed|failed|failures?|skipped|pending|todo|total|errors?|warnings?)\b/gi)) {
			const label = /^failures?$/i.test(match[2]) ? "failed" : match[2].toLowerCase();
			counts.push(`${match[1]} ${label}`);
		}
		for (const match of line.matchAll(/\b(passed|failed|failures?|errors?|skipped)\s*:\s*(\d{1,7})\b/gi)) {
			const label = /^failures?$/i.test(match[1]) ? "failed" : match[1].toLowerCase();
			counts.push(`${match[2]} ${label}`);
		}
		const testsRun = /\btests?\s+run\s*:\s*(\d{1,7})\b/i.exec(line)?.[1];
		if (testsRun) counts.push(`${testsRun} total`);
		const examples = /\b(\d{1,7})\s+examples?\b/i.exec(line)?.[1];
		if (examples) counts.push(`${examples} total`);
		const phpTests = /\bok\s*\(\s*(\d{1,7})\s+tests?\b/i.exec(line)?.[1];
		if (phpTests) counts.push(`${phpTests} total`);
		if (counts.length === 0) {
			const tests = /\b(\d{1,7})\s+tests?\s+(passed|failed|skipped)\b/i.exec(line);
			if (tests) counts.push(`${tests[1]} ${tests[2].toLowerCase()}`);
		}
		if (counts.length === 0 && /^ok\s+\S+(?:\s+\d+(?:\.\d+)?s)?\s*$/i.test(line)) {
			facts.push("Go test package passed.");
			continue;
		}
		if (counts.length === 0) continue;
		const label = /\btest\s+suites?\b/i.test(line)
			? "Test suites"
			: /\btest\s+files?\b/i.test(line) ? "Test files" : "Tests";
		facts.push(`${label}: ${[...new Set(counts)].join(", ")}.`);
	}
	return [...new Set(facts)].slice(-2);
}

function structuralGitEvidence(lines) {
	const joined = lines.join(" ");
	const digest = /(?:\bcommit\s+|\[[^\]]*\s)([0-9a-f]{7,40})\b/i.exec(joined)?.[1];
	const change = /\b(\d{1,7})\s+files? changed(?:,\s*(\d{1,7})\s+insertions?\(\+\))?(?:,\s*(\d{1,7})\s+deletions?\(-\))?/i.exec(joined);
	const changed = change
		? `Files changed: ${change[1]}${change[2] ? `; insertions: ${change[2]}` : ""}${change[3] ? `; deletions: ${change[3]}` : ""}.`
		: "";
	return [digest ? `Commit: ${digest}.` : "", changed].filter(Boolean);
}

function structuralDeploymentEvidence(lines) {
	const facts = [];
	const joined = lines.join(" ");
	if (/\b(?:no|not|without)\s+(?:deployment|deploy(?:ment|ed|ing)?)\b/i.test(joined)) return [];
	const version = /\bversion(?:\s+id)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\b/i.exec(joined)?.[1];
	if (version) facts.push(`Deployment version: ${version}.`);
	for (const line of lines) {
		if (!/\b(?:deployed(?:\s+to)?|production(?:\s+url)?|website(?:\s+url)?|worker(?:\s+url)?|preview(?:\s+url)?|deployment\s+url)\s*[:=-]?\s*https?:\/\//i.test(line)) continue;
		for (const match of line.matchAll(/https?:\/\/[^\s<>'"]+/gi)) {
			try {
				const host = new URL(match[0]).hostname;
				if (/^[A-Za-z0-9.-]{1,253}$/.test(host)) facts.push(`Deployment host: ${host}.`);
			} catch {
				// An invalid URL is raw output, not durable evidence.
			}
		}
	}
	return [...new Set(facts)].slice(-2);
}

function structuralFailureEvidence(lines) {
	const joined = lines.join(" ");
	if (/\b(?:permission|access) denied\b/i.test(joined)) return ["Failure category: permission denied."];
	if (/\b(?:command|file|module) not found\b|\bno such file\b/i.test(joined)) return ["Failure category: required resource not found."];
	if (/\b(?:timed?\s*out|timeout)\b/i.test(joined)) return ["Failure category: timeout."];
	const count = lines.map((line) => /\b(\d{1,7})\s+errors?\b/i.exec(line)?.[1]).find(Boolean);
	return count ? [`Reported errors: ${count}.`] : [];
}

function positiveOutcomeEvidence(event, text) {
	const kind = event?.kind;
	const lines = safeLines(stripItsukiRecallContext(text));
	const joined = lines.join("\n");
	if (kind === "test_result") {
		return lines.some((line) => /\b[1-9]\d{0,6}\s+(?:tests?\s+)?passed\b/i.test(line))
			|| /\bpassed\s*:\s*[1-9]\d{0,6}\b/i.test(joined)
			|| /^ok\s+\S+(?:\s+\d+(?:\.\d+)?s)?\s*$/im.test(joined)
			|| /\btests?\s+run\s*:\s*[1-9]\d{0,6}\b/i.test(joined)
				&& !/\b(?:failures?|errors?)\s*:\s*[1-9]\d{0,6}\b/i.test(joined)
			|| /\b[1-9]\d{0,6}\s+examples?\s*,\s*0\s+failures?\b/i.test(joined)
			|| /\bok\s*\(\s*[1-9]\d{0,6}\s+tests?\b/i.test(joined)
			|| /\bbuild\s+(?:success|successful)\b/i.test(joined);
	}
	if (kind === "deployment_result") return structuralDeploymentEvidence(lines).length > 0;
	if (kind === "git_commit") return structuralGitEvidence(lines).length > 0;
	if (kind === "command_result" && event?.family === "build") {
		return /\bbuild\s+(?:succeeded|success|successful)\b/i.test(joined);
	}
	if (kind === "command_result" && event?.family === "lint") {
		return /\blint(?:ing)?\s+(?:passed|succeeded|success|successful)\b/i.test(joined);
	}
	return false;
}

function explicitlyNoOutcome(kind, text) {
	const value = String(text ?? "");
	if (kind === "test_result") {
		if (/\bno test (?:files?|cases?|suites?) (?:found|collected|executed|ran)\b/i.test(value)) return true;
		const passed = /\b0\s+(?:tests?\s+)?passed\b/i.test(value)
			|| /\bpassed\s*[:=]\s*0\b/i.test(value)
			|| /\btests?\s+run\s*:\s*0\b/i.test(value)
			|| /\b0\s+examples?\b/i.test(value)
			|| /\bok\s*\(\s*0\s+tests?\b/i.test(value);
		const failed = /\b[1-9]\d{0,6}\s+(?:tests?\s+)?failed\b/i.test(value)
			|| /\b(?:failed|failures?)\s*[:=]\s*[1-9]\d*/i.test(value)
			|| /\b[1-9]\d*\s+failures?\b/i.test(value);
		return passed && !failed;
	}
	if (kind === "deployment_result") {
		return /\b(?:no|not|without)\s+(?:deployment|deploy(?:ment|ed|ing)?)\b/i.test(value);
	}
	return false;
}

function evidenceFor(kind, text, status) {
	const lines = safeLines(stripItsukiRecallContext(text));
	if (kind === "test_result") return structuralTestEvidence(lines).join("\n");
	if (kind === "deployment_result") return structuralDeploymentEvidence(lines).join("\n");
	if (kind === "git_commit") return structuralGitEvidence(lines).join("\n");
	return status === "succeeded" ? "" : structuralFailureEvidence(lines).join("\n");
}

function fileToolEvent(use, block, row, options) {
	const toolName = canonicalToolName(use.name);
	if (!toolName || !FILE_TOOLS.has(toolName)) return null;
	const leaf = toolName.toLowerCase();
	const input = use.input && typeof use.input === "object" ? use.input : {};
	const rawPath = input.file_path ?? input.filePath ?? input.notebook_path ?? input.notebookPath;
	const file = safeProjectPath(rawPath, options.cwd);
	const scrubbedResult = scrubCaptureText(stripItsukiRecallContext(toolResultText(block, row)));
	const text = scrubbedResult.text;
	const status = resultStatus(block, row, text);
	const kind = "file_change";
	const action = leaf.startsWith("write") ? "wrote" : leaf.startsWith("notebook") ? "updated notebook" : "edited";
	const failure = status === "succeeded" ? "" : evidenceFor(kind, text, status);
	return {
		kind,
		origin: "tool_result",
		status,
		toolFamily: leaf.startsWith("notebook") ? "notebook" : leaf,
		toolName: String(use.name ?? ""),
		parentEventId: use.parentEventId,
		exitCode: resultExitCode(row, text),
		redactions: scrubbedResult.redactions,
		truncated: codePointLength(text) > codePointLength(failure),
		summary: `${status === "succeeded" ? "Coding agent" : "Coding agent attempt"} ${action} ${file}; ${status.replace("_", " ")}.${failure ? `\n${failure}` : ""}`,
	};
}

function answerEvent(use, block, row) {
	if (canonicalToolName(use.name) !== "AskUserQuestion") return null;
	const result = row?.toolUseResult;
	const answers = result && typeof result === "object" && !Array.isArray(result) ? result.answers : null;
	const values = answers && typeof answers === "object"
		? (Array.isArray(answers) ? answers : Object.values(answers))
		: [];
	const selected = values.flatMap((value) => {
		if (typeof value === "string") return [value];
		if (value && typeof value === "object") return Object.values(value).filter((item) => typeof item === "string");
		return [];
	}).map((value) => normalizeWhitespace(stripItsukiRecallContext(value)))
		.filter((value) => value
			&& value.length <= 600
			&& !RAW_COMMAND_RE.test(value)
			&& !RAW_CODE_RE.test(value)
			&& DURABLE_USER_RE.test(value)
			&& !(value.length <= 128 && /^[A-Za-z0-9+/=_-]{6,}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)))
		.slice(0, 3)
		.join("\n");
	if (!selected) return null;
	return {
		kind: USER_PREFERENCE_RE.test(selected) ? "user_preference" : "decision",
		origin: "tool_result",
		status: resultStatus(block, row, toolResultText(block, row)),
		toolFamily: "ask_user",
		toolName: String(use.name ?? ""),
		parentEventId: use.parentEventId,
		summary: `User stated a durable coding preference or decision:\n${selected}`,
	};
}

function shellToolEvent(use, block, row) {
	const input = use.input && typeof use.input === "object" ? use.input : {};
	const classified = commandKind(input.command);
	const scrubbedResult = scrubCaptureText(stripItsukiRecallContext(toolResultText(block, row)));
	const text = scrubbedResult.text;
	let status = resultStatus(block, row, text, { classifiedCommand: Boolean(classified) });
	if (!classified && !["failed", "timed_out", "interrupted"].includes(status)) return null;
	const event = classified ?? { kind: "error", family: "shell", noun: "Command" };
	const positiveEvidence = classified ? positiveOutcomeEvidence(event, text) : false;
	if (classified && status === "unknown" && positiveEvidence) status = "succeeded";
	if (classified && status === "succeeded" && explicitlyNoOutcome(event.kind, text)) status = "unknown";
	const evidence = evidenceFor(event.kind, text, status);
	return {
		kind: status === "succeeded" ? event.kind : (classified ? event.kind : "error"),
		origin: "tool_result",
		status,
		toolFamily: event.family,
		toolName: String(use.name ?? ""),
		parentEventId: use.parentEventId,
		exitCode: resultExitCode(row, text),
		redactions: scrubbedResult.redactions,
		truncated: codePointLength(text) > codePointLength(evidence),
		omittedCharacters: Math.max(0, codePointLength(text) - codePointLength(evidence)),
		summary: `${event.noun} ${status.replace("_", " ")}.${evidence ? `\n${evidence}` : ""}`,
	};
}

function toolEvent(use, block, row, options) {
	if (!use || ignoredTool(use.name)) return null;
	const answer = answerEvent(use, block, row);
	if (answer) return answer;
	const toolName = canonicalToolName(use.name);
	if (FILE_TOOLS.has(toolName)) return fileToolEvent(use, block, row, options);
	if (SHELL_TOOLS.has(toolName)) return shellToolEvent(use, block, row);
	return null;
}

function rowHostId(row) {
	return String(row?.uuid ?? row?.event_id ?? row?.eventId ?? "").trim();
}

function nonemptyDistinctStrings(...values) {
	return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function resultHostLink(row, block) {
	const sources = nonemptyDistinctStrings(
		block?.sourceToolAssistantUUID,
		block?.source_tool_assistant_uuid,
		row?.sourceToolAssistantUUID,
		row?.source_tool_assistant_uuid,
	);
	const parents = nonemptyDistinctStrings(
		block?.parentUuid,
		block?.parent_uuid,
		row?.parentUuid,
		row?.parent_uuid,
	);
	if (sources.length > 0) return { kind: "source_uuid", ids: sources };
	if (parents.length > 0) return { kind: "parent_uuid", ids: parents };
	return { kind: null, ids: [] };
}

/**
 * Build one immutable call/result correlation graph for both selection and
 * capture. Host UUID linkage is authoritative. The legacy FIFO is allowed only
 * when the complete prefix is present and the tool-use ID occurs exactly once;
 * a reused ID is not identity evidence.
 */
function correlateClaudeToolResults(records, analyses, options = {}) {
	const callKey = (record, blockOrdinal) => `${record.ordinal}:${blockOrdinal}`;
	const resultKey = (record, blockOrdinal) => `${record.ordinal}:${blockOrdinal}`;
	const callsById = new Map();
	const callsByHost = new Map();
	const callsByKey = new Map();
	const toolParentOccurrences = new Map();

	for (const record of records) {
		if (record.malformed || record.row?.isMeta === true) continue;
		const row = record.row;
		const analysis = analyses[record.ordinal];
		for (const [blockOrdinal, block] of contentBlocks(row).entries()) {
			if (block?.type !== "tool_use" || !block.id) continue;
			const id = String(block.id);
			const hostId = rowHostId(row);
			const use = {
				...block,
				blockOrdinal,
				callKey: callKey(record, blockOrdinal),
				recordOrdinal: record.ordinal,
				ignored: rowAttributionIsMemory(row) || !analysis?.eligible || ignoredTool(block.name),
				parentEventId: toolParentIdentity(record, block, blockOrdinal, options, toolParentOccurrences),
				available: false,
				consumed: false,
			};
			const idCalls = callsById.get(id) ?? [];
			idCalls.push(use);
			callsById.set(id, idCalls);
			if (hostId) {
				const byId = callsByHost.get(hostId) ?? new Map();
				const hostCalls = byId.get(id) ?? [];
				hostCalls.push(use);
				byId.set(id, hostCalls);
				callsByHost.set(hostId, byId);
			}
			callsByKey.set(use.callKey, use);
		}
	}

	const fifoHeads = new Map();
	const matchesByResultKey = new Map();
	const ambiguousResultKeys = new Set();
	const metrics = {
		exactSourceMatches: 0,
		exactParentMatches: 0,
		fifoMatches: 0,
		ambiguousToolResults: 0,
		invalidExactLinkResults: 0,
		reusedIdResultsRejected: 0,
		incompletePrefixResultsRejected: 0,
		unmatchedToolResults: 0,
	};

	const consumeUniqueFifo = (id) => {
		const queue = callsById.get(id) ?? [];
		let head = fifoHeads.get(id) ?? 0;
		while (head < queue.length && (queue[head].consumed || !queue[head].available)) {
			if (!queue[head].available) break;
			head += 1;
		}
		fifoHeads.set(id, head);
		const use = queue[head];
		if (!use?.available || use.consumed) return null;
		use.consumed = true;
		fifoHeads.set(id, head + 1);
		return use;
	};

	const rejectAmbiguous = (key, reason) => {
		ambiguousResultKeys.add(key);
		metrics.ambiguousToolResults += 1;
		if (reason === "invalid_exact_link") metrics.invalidExactLinkResults += 1;
		else if (reason === "reused_id") metrics.reusedIdResultsRejected += 1;
		else if (reason === "incomplete_prefix") metrics.incompletePrefixResultsRejected += 1;
		else if (reason === "unmatched") metrics.unmatchedToolResults += 1;
	};

	for (const record of records) {
		if (record.malformed || record.row?.isMeta === true) continue;
		const row = record.row;
		for (const [blockOrdinal, block] of contentBlocks(row).entries()) {
			if (block?.type === "tool_use") {
				const use = callsByKey.get(callKey(record, blockOrdinal));
				if (use) use.available = true;
				continue;
			}
			if (block?.type !== "tool_result") continue;
			const key = resultKey(record, blockOrdinal);
			const id = String(block.tool_use_id ?? "");
			const link = resultHostLink(row, block);
			let use = null;
			let mode = null;

			if (link.kind) {
				// Conflicting aliases or a non-unique call within the linked host row
				// are not exact evidence and must never fall back to an ID-only match.
				if (link.ids.length === 1) {
					const linked = callsByHost.get(link.ids[0])?.get(id) ?? [];
					if (linked.length === 1 && linked[0].available && !linked[0].consumed) {
						use = linked[0];
						use.consumed = true;
						mode = link.kind;
					}
				}
				if (!use) rejectAmbiguous(key, "invalid_exact_link");
			} else if (options.prefixTruncated === true) {
				rejectAmbiguous(key, "incomplete_prefix");
			} else {
				const idCalls = callsById.get(id) ?? [];
				if (idCalls.length > 1) {
					rejectAmbiguous(key, "reused_id");
				} else if (idCalls.length === 1) {
					use = consumeUniqueFifo(id);
					mode = use ? "fifo" : null;
					if (!use) rejectAmbiguous(key, "unmatched");
				} else {
					rejectAmbiguous(key, "unmatched");
				}
			}

			if (!use) continue;
			if (mode === "source_uuid") metrics.exactSourceMatches += 1;
			else if (mode === "parent_uuid") metrics.exactParentMatches += 1;
			else metrics.fifoMatches += 1;
			const match = {
				resultKey: key,
				resultRecordOrdinal: record.ordinal,
				mode,
				use,
			};
			matchesByResultKey.set(key, match);
		}
	}

	return {
		ambiguousResultKeys,
		matchesByResultKey,
		metrics,
		resultKey,
	};
}

/**
 * Select the newest completed/capturable outcome rows while retaining the
 * earlier tool-use rows required to reproduce their exact or unique-ID
 * correlations.
 * Unmatched results, successful unclassified shell output, and prose noise do
 * not consume the outcome budget.
 */
export function selectClaudeCaptureTailRows(rows, options = {}) {
	const maxEvents = Number(options.maxEvents);
	if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
		throw new TypeError("maxEvents must be a positive safe integer");
	}
	const maxCompanionRows = Number(
		options.maxCompanionRows ?? DEFAULT_CLAUDE_CAPTURE_MAX_COMPANION_ROWS,
	);
	if (!Number.isSafeInteger(maxCompanionRows) || maxCompanionRows < 0) {
		throw new TypeError("maxCompanionRows must be a non-negative safe integer");
	}
	const inputs = Array.from(rows ?? []);
	const records = inputs.map((row, ordinal) => parseRecord(row, ordinal));
	const analyses = records.map((record) => (
		record.malformed
			? { eligible: false, textEvent: null, blocks: [], counters: emptyCaptureExclusionEvidence(0) }
			: analyzeCaptureRow(record.row, options)
	));
	const exclusionEvidence = analyses.map((analysis) => ({ ...analysis.counters }));
	const correlation = correlateClaudeToolResults(records, analyses, options);
	const outcomes = [];
	const unsafeRowOrdinals = new Set();
	let ambiguousOutcomeRows = 0;

	for (const record of records) {
		if (record.malformed) continue;
		const row = record.row;
		if (row?.isMeta === true) continue;
		const blocks = contentBlocks(row);
		let capturable = !rowAttributionIsMemory(row)
			&& Boolean(analyses[record.ordinal].textEvent);
		let ambiguous = false;
		for (const [blockOrdinal, block] of blocks.entries()) {
			if (block?.type !== "tool_result") continue;
			const key = correlation.resultKey(record, blockOrdinal);
			const use = correlation.matchesByResultKey.get(key)?.use;
			if (!use) {
				exclusionEvidence[record.ordinal].ignoredToolEvents += 1;
				if (correlation.ambiguousResultKeys.has(key)) ambiguous = true;
				continue;
			}
			if (use.ignored) {
				exclusionEvidence[record.ordinal].ignoredToolEvents += 1;
				continue;
			}
			if (toolEvent(use, block, row, options)) capturable = true;
			else exclusionEvidence[record.ordinal].ignoredToolEvents += 1;
		}
		if (ambiguous) {
			unsafeRowOrdinals.add(record.ordinal);
			if (!rowAttributionIsMemory(row) && analyses[record.ordinal].eligible) {
				ambiguousOutcomeRows += 1;
			}
			capturable = false;
		}
		if (capturable) {
			outcomes.push(record.ordinal);
		}
	}

	// Outcome rows depend on the call rows for the result blocks they actually
	// contain. Dependencies are directed: two independent exact-linked results
	// may share one assistant call row without forcing both outcomes into the
	// tail. If a required call row is itself an outcome, close over its direct
	// dependencies too. Every expansion is capped before it is committed.
	const directDependencies = Array.from({ length: records.length }, () => new Set());
	for (const match of correlation.matchesByResultKey.values()) {
		directDependencies[match.resultRecordOrdinal].add(match.use.recordOrdinal);
	}
	const outcomeOrdinals = new Set(outcomes);
	const selectedOrdinals = new Set();
	const selectedOutcomeOrdinals = new Set();
	const companionLimitRejectedOutcomeOrdinals = new Set();
	const closureEventLimitRejectedOutcomeOrdinals = new Set();
	for (let index = outcomes.length - 1; index >= 0 && selectedOutcomeOrdinals.size < maxEvents; index -= 1) {
		const outcomeOrdinal = outcomes[index];
		if (selectedOutcomeOrdinals.has(outcomeOrdinal)) continue;
		const candidateRows = new Set();
		const candidateOutcomes = new Set();
		const pendingOutcomes = [outcomeOrdinal];
		let unsafe = false;
		let exceedsEventLimit = false;
		let exceedsCompanionLimit = false;
		while (pendingOutcomes.length > 0 && !unsafe && !exceedsEventLimit && !exceedsCompanionLimit) {
			const ordinal = pendingOutcomes.pop();
			if (selectedOutcomeOrdinals.has(ordinal) || candidateOutcomes.has(ordinal)) continue;
			candidateOutcomes.add(ordinal);
			if (!selectedOrdinals.has(ordinal)) candidateRows.add(ordinal);
			if (selectedOutcomeOrdinals.size + candidateOutcomes.size > maxEvents) {
				exceedsEventLimit = true;
				break;
			}
			for (const dependency of directDependencies[ordinal]) {
				if (unsafeRowOrdinals.has(dependency)) {
					unsafe = true;
					break;
				}
				if (!selectedOrdinals.has(dependency)) candidateRows.add(dependency);
				if (outcomeOrdinals.has(dependency)
					&& !selectedOutcomeOrdinals.has(dependency)
					&& !candidateOutcomes.has(dependency)) {
					pendingOutcomes.push(dependency);
				}
			}
			const prospectiveRows = selectedOrdinals.size + candidateRows.size;
			const prospectiveOutcomes = selectedOutcomeOrdinals.size + candidateOutcomes.size;
			if (prospectiveRows - prospectiveOutcomes > maxCompanionRows) {
				exceedsCompanionLimit = true;
			}
		}
		if (unsafe) continue;
		if (exceedsEventLimit) {
			for (const ordinal of candidateOutcomes) closureEventLimitRejectedOutcomeOrdinals.add(ordinal);
			continue;
		}
		if (exceedsCompanionLimit) {
			for (const ordinal of candidateOutcomes) companionLimitRejectedOutcomeOrdinals.add(ordinal);
			continue;
		}
		for (const ordinal of candidateRows) selectedOrdinals.add(ordinal);
		for (const ordinal of candidateOutcomes) selectedOutcomeOrdinals.add(ordinal);
	}

	const excludedCaptureEvidence = emptyCaptureExclusionEvidence(0);
	for (const record of records) {
		if (!selectedOrdinals.has(record.ordinal)) {
			mergeCaptureExclusionEvidence(excludedCaptureEvidence, exclusionEvidence[record.ordinal]);
		}
	}

	return {
		rows: inputs.filter((_, ordinal) => selectedOrdinals.has(ordinal)),
		metadata: {
			capturableOutcomeRows: outcomes.length,
			selectedOutcomeRows: selectedOutcomeOrdinals.size,
			companionRows: selectedOrdinals.size - selectedOutcomeOrdinals.size,
			maxCompanionRows,
			companionClosureRows: selectedOrdinals.size,
			companionClosureLimitReached: companionLimitRejectedOutcomeOrdinals.size > 0,
			companionLimitRejectedOutcomeRows: companionLimitRejectedOutcomeOrdinals.size,
			closureEventLimitRejectedOutcomeRows: closureEventLimitRejectedOutcomeOrdinals.size,
			ambiguousOutcomeRows,
			...correlation.metrics,
			excludedCaptureEvidence,
		},
	};
}

function publicMessage(record, event, blockOrdinal, metadata, maxChars, options, fallbackOccurrences) {
	mergeRedactions(metadata, event.redactions);
	const safeSummary = redact(event.summary, metadata);
	const header = `[Claude coding event/v1]\nkind=${event.kind}; status=${event.status}\n`;
	const fullContent = `${header}${safeSummary}`;
	const bounded = boundedText(fullContent, maxChars);
	const identity = eventIdentity(record, event.kind, blockOrdinal, fullContent, options, fallbackOccurrences);
	const timestamp = timestampOf(record.row);
	const sourceTruncated = Boolean(event.truncated || bounded.truncated);
	if (sourceTruncated) metadata.truncatedEvents += 1;
	const sourceEvent = normalizeSourceEvent({
		schema: SOURCE_EVENT_SCHEMA,
		kind: event.kind,
		event_id: identity.id,
		...(event.parentEventId ? { parent_event_id: event.parentEventId } : {}),
		...(canonicalToolName(event.toolName) ? { tool_name: canonicalToolName(event.toolName) } : {}),
		outcome: canonicalOutcome(event.status),
		...(Number.isSafeInteger(event.exitCode) ? { exit_code: event.exitCode } : {}),
		truncated: sourceTruncated,
	});
	if (!sourceEvent) throw new TypeError("capture produced invalid source-event metadata");
	return {
		id: identity.id,
		role: "user",
		content: bounded.text,
		...(timestamp === null ? {} : { ts: timestamp }),
		sourceEvent,
	};
}

/**
 * Convert sanitized Claude transcript rows into bounded, deterministic coding
 * observations. Tool inputs and results are used only transiently to classify
 * an event; raw commands, diffs, code, logs, and hidden reasoning are never
 * returned.
 */
export function captureClaudeTranscriptRows(rows, options = {}) {
	const maxChars = Number(options.maxChars ?? DEFAULT_CLAUDE_CAPTURE_MAX_CHARS);
	if (!Number.isSafeInteger(maxChars) || maxChars < 160 || maxChars > DEFAULT_CLAUDE_CAPTURE_MAX_CHARS) {
		throw new TypeError(`maxChars must be an integer from 160 to ${DEFAULT_CLAUDE_CAPTURE_MAX_CHARS}`);
	}
	const records = Array.from(rows ?? [], (row, ordinal) => parseRecord(row, ordinal));
	const analyses = records.map((record) => (
		record.malformed
			? { eligible: false, textEvent: null, blocks: [], counters: emptyCaptureExclusionEvidence(0) }
			: analyzeCaptureRow(record.row, options)
	));
	const correlation = correlateClaudeToolResults(records, analyses, options);
	const metadata = {
		schema: CLAUDE_CAPTURE_SCHEMA,
		inputRows: 0,
		malformedRows: records.filter((record) => record.malformed).length,
		ineligibleRows: 0,
		capturedEvents: 0,
		ignoredThinkingBlocks: 0,
		ignoredMetaRows: 0,
		ignoredToolEvents: 0,
		ignoredRecallEvents: 0,
		ignoredRecallEchoEvents: 0,
		ignoredUnprotectedAssistantEvents: 0,
		ignoredNoiseEvents: 0,
		truncatedEvents: 0,
		redactions: {},
		...correlation.metrics,
	};
	const messages = [];
	const seen = new Set();
	const fallbackOccurrences = new Map();
	for (const record of records) {
		if (record.malformed) {
			metadata.inputRows += 1;
			continue;
		}
		const row = record.row;
		const analysis = analyses[record.ordinal];
		mergeCaptureExclusionEvidence(metadata, analysis.counters);
		if (row?.isMeta === true) {
			continue;
		}
		const blocks = analysis.blocks;
		if (rowAttributionIsMemory(row)) {
			continue;
		}
		if (!analysis.eligible) {
			continue;
		}
		const textEvent = analysis.textEvent;
		if (textEvent) {
			const firstTextOrdinal = Math.max(0, blocks.findIndex((block) => block?.type === "text"));
			const message = publicMessage(record, textEvent, firstTextOrdinal, metadata, maxChars, options, fallbackOccurrences);
			if (!seen.has(message.id)) {
				seen.add(message.id);
				messages.push(message);
			}
		}

		for (const [blockOrdinal, block] of blocks.entries()) {
			if (block?.type === "thinking") {
				continue;
			}
			if (block?.type === "tool_use") {
				continue;
			}
			if (block?.type !== "tool_result") continue;
			const use = correlation.matchesByResultKey.get(
				correlation.resultKey(record, blockOrdinal),
			)?.use;
			if (!use || use.ignored || ignoredTool(use.name)) {
				metadata.ignoredToolEvents += 1;
				continue;
			}
			const event = toolEvent(use, block, row, options);
			if (!event) {
				metadata.ignoredToolEvents += 1;
				continue;
			}
			const message = publicMessage(record, event, blockOrdinal, metadata, maxChars, options, fallbackOccurrences);
			if (!seen.has(message.id)) {
				seen.add(message.id);
				messages.push(message);
			}
		}
	}
	metadata.capturedEvents = messages.length;
	return { messages, metadata };
}
