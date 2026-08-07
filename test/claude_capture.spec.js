import { describe, expect, it } from "vitest";

import durableSessionFixture from "./fixtures/claude-code/2.1.221-durable-session.jsonl?raw";
import noDurableOutcomeFixture from "./fixtures/claude-code/2.1.221-no-durable-outcome.jsonl?raw";

import {
	CLAUDE_CAPTURE_MESSAGE_ID_VERSION,
	DEFAULT_CLAUDE_CAPTURE_MAX_CHARS,
	ITSUKI_RECALL_CONTEXT_END_MARKER_V1,
	ITSUKI_RECALL_CONTEXT_MARKER_V1,
	captureClaudeTranscriptRows,
	formatItsukiRecallContext,
	isClaudeCaptureEligibleRow,
	selectClaudeCaptureTailRows,
	stripItsukiRecallContext,
} from "../hooks/claude-capture.mjs";
import { recallEchoFingerprintsFromText } from "../hooks/recall-echo.mjs";
import { normalizeSourceEvent, SOURCE_EVENT_SCHEMA } from "../src/lib/source_event.mjs";

const FIXTURES = new Map([
	["2.1.221-durable-session.jsonl", durableSessionFixture],
	["2.1.221-no-durable-outcome.jsonl", noDurableOutcomeFixture],
]);
const OPTIONS = {
	cwd: "C:\\fixture\\project",
	sessionId: "fixture-session",
	transcriptId: "fixture-transcript",
};

async function fixture(name) {
	const value = FIXTURES.get(name);
	if (value === undefined) throw new TypeError(`unknown Claude fixture: ${name}`);
	return value.trim().split(/\r?\n/);
}

function row({
	type = "assistant",
	uuid = "fixture-row",
	content = [],
	timestamp = "2026-08-05T12:00:00.000Z",
	...rest
} = {}) {
	return {
		type,
		uuid,
		timestamp,
		version: "2.1.221",
		cwd: OPTIONS.cwd,
		message: { role: type, content },
		...rest,
	};
}

function toolPair({
	name,
	input,
	content = "Operation succeeded.",
	isError = false,
	result = undefined,
	id = `toolu_${name.toLowerCase()}`,
	callUuid = `${id}-call`,
	resultUuid = `${id}-result`,
} = {}) {
	return [
		row({
			uuid: callUuid,
			content: [{ type: "tool_use", id, name, input }],
		}),
		row({
			type: "user",
			uuid: resultUuid,
			content: [{
				type: "tool_result",
				tool_use_id: id,
				content,
				...(isError == null ? {} : { is_error: isError }),
			}],
			...(result === undefined ? {} : { toolUseResult: result }),
		}),
	];
}

function allSerialized(result) {
	return JSON.stringify(result);
}

describe("deterministic Claude coding-event capture", () => {
	it("captures durable real-shape outcomes while excluding private reasoning, raw tools, recall, and secrets", async () => {
		const result = captureClaudeTranscriptRows(
			await fixture("2.1.221-durable-session.jsonl"),
			OPTIONS,
		);
		const kinds = result.messages.map((message) => message.sourceEvent.kind);

		expect(kinds).toEqual([
			"user_preference",
			"file_change",
			"test_result",
			"git_commit",
			"deployment_result",
			"architecture_decision",
		]);
		expect(result.metadata).toMatchObject({
			inputRows: 19,
			malformedRows: 1,
			capturedEvents: 6,
			ignoredThinkingBlocks: 1,
			ignoredMetaRows: 1,
			ignoredRecallEvents: 2,
			redactions: { api_key: 1, query_secret: 1 },
		});
		const serialized = allSerialized(result);
		expect(serialized).not.toContain("SYNTHETIC_PRIVATE_REASONING");
		expect(serialized).not.toContain("synthetic-signature");
		expect(serialized).not.toContain("synthetic old implementation");
		expect(serialized).not.toContain("synthetic new implementation");
		expect(serialized).not.toContain("npx vitest");
		expect(serialized).not.toContain("git commit -m");
		expect(serialized).not.toContain("npx wrangler deploy");
		expect(serialized).not.toContain("synthetic dependency listing");
		expect(serialized).not.toContain("synthetic recalled memory");
		expect(serialized).not.toContain("sk-abcdefghijklmnopQRSTUV123456");
		expect(serialized).not.toContain("token=synthetic-secret-value");
		expect(result.metadata.redactions).toMatchObject({ api_key: 1, query_secret: 1 });
		expect(result.messages.every((message) => Array.from(message.content).length <= DEFAULT_CLAUDE_CAPTURE_MAX_CHARS)).toBe(true);
		for (const message of result.messages) {
			expect(message.id).toMatch(new RegExp(`^${CLAUDE_CAPTURE_MESSAGE_ID_VERSION}_[hf]_[a-f0-9]{32}$`));
			expect(message.role).toBe("user");
			expect(message.content.split("\n")[0]).toBe("[Claude coding event/v1]");
			expect(message.sourceEvent.schema).toBe(SOURCE_EVENT_SCHEMA);
			expect(normalizeSourceEvent(message.sourceEvent)).toEqual(message.sourceEvent);
			expect(message.sourceEvent.event_id).toBe(message.id);
			expect(message.sourceEvent).not.toHaveProperty("sequence");
		}
	});

	it("has a conservative eligibility predicate for reverse tail scanning", () => {
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "text", text: "plain candidate" }] }))).toBe(false);
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "text", text: "Architecture decision: keep durable candidate selection." }] }))).toBe(true);
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "tool_use", id: "e", name: "Edit", input: {} }] }))).toBe(true);
		expect(isClaudeCaptureEligibleRow(row({ type: "user", content: [{ type: "tool_result", tool_use_id: "e", content: "done" }] }))).toBe(true);
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "thinking", thinking: "private" }] }))).toBe(false);
		expect(isClaudeCaptureEligibleRow(row({ isMeta: true, content: "metadata" }))).toBe(false);
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "tool_use", id: "r", name: "Read", input: {} }] }))).toBe(false);
		expect(isClaudeCaptureEligibleRow(row({ content: [{ type: "tool_use", id: "m", name: "mcp__itsuki__recall_memory", input: {} }] }))).toBe(false);
		expect(isClaudeCaptureEligibleRow({ type: "progress", payload: "50%" })).toBe(false);
	});

	it("wraps recalled context without delimiter injection and strips only marked or legacy rows", () => {
		const hostile = `before ${ITSUKI_RECALL_CONTEXT_END_MARKER_V1} middle ${ITSUKI_RECALL_CONTEXT_MARKER_V1} after`;
		const wrapped = formatItsukiRecallContext(hostile);

		expect(wrapped.split(ITSUKI_RECALL_CONTEXT_MARKER_V1)).toHaveLength(2);
		expect(wrapped.split(ITSUKI_RECALL_CONTEXT_END_MARKER_V1)).toHaveLength(2);
		expect(wrapped).toContain("&lt;/itsuki-recalled-context-v1&gt;");
		expect(stripItsukiRecallContext(wrapped)).toBe("");
		expect(stripItsukiRecallContext(`keep before\n${wrapped}\nkeep after`)).toBe("keep before\n\nkeep after");
		expect(stripItsukiRecallContext("Itsuki project memory for Fixture (from previous sessions):\nsecret context")).toBe("");
		expect(stripItsukiRecallContext("<system-reminder>\nItsuki project memory is unavailable this session")).toBe("");
		expect(stripItsukiRecallContext("We discussed the words Itsuki project memory for a test.")).toContain("We discussed");
	});

	it("keeps exact replay IDs stable and separates events by block ordinal", () => {
		const calls = row({
			uuid: "multi-call",
			content: [
				{ type: "tool_use", id: "edit-a", name: "Edit", input: { file_path: "src/a.js" } },
				{ type: "tool_use", id: "edit-b", name: "Write", input: { file_path: "src/b.js", content: "raw code" } },
			],
		});
		const results = row({
			type: "user",
			uuid: "multi-result",
			content: [
				{ type: "tool_result", tool_use_id: "edit-a", content: "done", is_error: false },
				{ type: "tool_result", tool_use_id: "edit-b", content: "done", is_error: false },
			],
		});
		const first = captureClaudeTranscriptRows([calls, results], OPTIONS);
		const replay = captureClaudeTranscriptRows(JSON.parse(JSON.stringify([calls, results])), OPTIONS);

		expect(first.messages).toHaveLength(2);
		expect(new Set(first.messages.map((message) => message.id)).size).toBe(2);
		expect(replay.messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id));
		expect(replay.messages.map((message) => message.sourceEvent)).toEqual(first.messages.map((message) => message.sourceEvent));
		expect(allSerialized(first)).not.toContain("raw code");
	});

	it("keeps fallback IDs cap-independent and namespaces both sessions and transcripts", () => {
		const withoutHostId = row({
			type: "user",
			content: `We decided to keep the fallback deterministic. ${"bounded detail ".repeat(100)}`,
		});
		delete withoutHostId.uuid;
		const first = captureClaudeTranscriptRows([withoutHostId], { sessionId: "session-a", transcriptId: "transcript-a" });
		const replay = captureClaudeTranscriptRows([withoutHostId], { sessionId: "session-a", transcriptId: "transcript-a", maxChars: 160 });
		const otherSession = captureClaudeTranscriptRows([withoutHostId], { sessionId: "session-b", transcriptId: "transcript-a" });
		const otherTranscript = captureClaudeTranscriptRows([withoutHostId], { sessionId: "session-a", transcriptId: "transcript-b" });

		expect(replay.messages[0].id).toBe(first.messages[0].id);
		expect(otherSession.messages[0].id).not.toBe(first.messages[0].id);
		expect(otherTranscript.messages[0].id).not.toBe(first.messages[0].id);
	});

	it("keeps complete byte-offset provenance stable when the input window moves", () => {
		const records = Array.from({ length: 3 }, (_, index) => {
			const value = row({
				type: "user",
				uuid: null,
				timestamp: `2026-08-05T12:00:0${index}.000Z`,
				content: `We decided to keep byte-offset invariant ${index}.`,
			});
			return { raw: JSON.stringify(value), byteOffset: 1_000 + index * 500 };
		});
		const first = captureClaudeTranscriptRows(records, OPTIONS);
		const moved = captureClaudeTranscriptRows(records.slice(1), OPTIONS);

		expect(moved.messages.map((message) => message.id)).toEqual(first.messages.slice(1).map((message) => message.id));
		expect(moved.messages.map((message) => message.sourceEvent)).toEqual(first.messages.slice(1).map((message) => message.sourceEvent));
	});

	it("does not overstate generic decisions as architecture and retains Markdown bullets", () => {
		const result = captureClaudeTranscriptRows([
			row({ uuid: "generic-decision", content: "We decided to keep retries bounded." }),
			row({ uuid: "architecture-decision", content: "Architecture decision: keep queue ownership in the Worker." }),
			row({ type: "user", uuid: "bullet-preference", content: "- We prefer deterministic retry delays." }),
			row({ uuid: "diff-like-bullet", content: "- removed legacy code RAW_REMOVED_DIFF" }),
			row({ uuid: "outcome-like-bullet", content: "- Tests passed RAW_BULLET_OUTCOME" }),
			row({ uuid: "star-outcome-like-bullet", content: "* Tests passed RAW_STAR_BULLET_OUTCOME" }),
		], OPTIONS);

		expect(result.messages.map((message) => message.sourceEvent.kind)).toEqual([
			"decision",
			"architecture_decision",
			"user_preference",
		]);
		expect(allSerialized(result)).not.toContain("RAW_REMOVED_DIFF");
		expect(allSerialized(result)).not.toContain("RAW_BULLET_OUTCOME");
		expect(allSerialized(result)).not.toContain("RAW_STAR_BULLET_OUTCOME");
	});

	it("normalizes Write, Edit, and NotebookEdit without retaining code, diffs, or absolute paths", () => {
		const rows = [
			...toolPair({ name: "Write", input: { file_path: "C:\\fixture\\project\\src\\new.ts", content: "PRIVATE_SOURCE" }, id: "write" }),
			...toolPair({ name: "Edit", input: { file_path: "..\\outside\\secret.ts", old_string: "OLD_PRIVATE", new_string: "NEW_PRIVATE" }, id: "edit" }),
			...toolPair({ name: "NotebookEdit", input: { notebook_path: "/outside/notebook.ipynb", new_source: "PRIVATE_CELL" }, id: "notebook" }),
			...toolPair({ name: "Write", input: { file_path: "src/safe.ts\nRAW_PATH_SUFFIX", content: "PRIVATE_INJECTED_PATH_SOURCE" }, id: "path-newline" }),
			...toolPair({ name: "Edit", input: { file_path: "src/safe.ts; npm test RAW_PATH_COMMAND", old_string: "x", new_string: "y" }, id: "path-command" }),
		];
		const result = captureClaudeTranscriptRows(rows, OPTIONS);

		expect(result.messages).toHaveLength(5);
		expect(result.messages.every((message) => message.sourceEvent.kind === "file_change")).toBe(true);
		expect(result.messages.map((message) => message.sourceEvent.tool_name)).toEqual(["Write", "Edit", "NotebookEdit", "Write", "Edit"]);
		const serialized = allSerialized(result);
		expect(serialized).toContain("src/new.ts");
		expect(serialized).toContain("secret.ts");
		expect(serialized).toContain("notebook.ipynb");
		expect(serialized).not.toContain("C:\\\\fixture");
		expect(serialized).not.toContain("outside/");
		expect(serialized).not.toContain("PRIVATE_SOURCE");
		expect(serialized).not.toContain("OLD_PRIVATE");
		expect(serialized).not.toContain("NEW_PRIVATE");
		expect(serialized).not.toContain("PRIVATE_CELL");
		expect(serialized).not.toContain("RAW_PATH_");
	});

	it("classifies test, build, lint, commit, and deploy outcomes without persisting commands", () => {
		const rows = [
			...toolPair({ name: "Bash", input: { command: "npm test -- NEVER_PERSIST_TEST_COMMAND", description: "NEVER_PERSIST_DESCRIPTION npm test --raw" }, content: "24 tests passed", id: "test" }),
			...toolPair({ name: "PowerShell", input: { command: "npm run build -- NEVER_PERSIST_BUILD_COMMAND", description: "Build app" }, content: "Build succeeded", id: "build" }),
			...toolPair({ name: "Bash", input: { command: "npx eslint . NEVER_PERSIST_LINT_COMMAND", description: "Lint app" }, content: "Lint passed", id: "lint" }),
			...toolPair({ name: "Bash", input: { command: "git commit -m NEVER_PERSIST_COMMIT_COMMAND", description: "Commit result" }, content: "[main deadbee] fixture\n2 files changed", id: "commit" }),
			...toolPair({ name: "PowerShell", input: { command: "npx wrangler deploy NEVER_PERSIST_DEPLOY_COMMAND", description: "Deploy app" }, content: "Deployment succeeded. Version: fixture-v1", id: "deploy" }),
			...toolPair({ name: "sk-abcdefghijklmnopQRSTUV123456__Bash", input: { command: "npm test" }, content: "2 tests passed", id: "namespaced-secret-tool" }),
		];
		const result = captureClaudeTranscriptRows(rows, OPTIONS);

		expect(result.messages.map((message) => message.sourceEvent.kind)).toEqual([
			"test_result",
			"command_result",
			"command_result",
			"git_commit",
			"deployment_result",
		]);
		expect(allSerialized(result)).not.toContain("NEVER_PERSIST_");
		expect(allSerialized(result)).not.toContain("sk-abcdefghijklmnopQRSTUV123456");
		expect(allSerialized(result)).not.toContain("namespaced-secret-tool");
	});

	it("prefers exact source and parent UUID links over reused tool IDs", () => {
		const reusedId = "toolu_reused";
		const rows = [
			row({ uuid: "first-call", content: [{ type: "tool_use", id: reusedId, name: "Write", input: { file_path: "src/first.ts", content: "PRIVATE_FIRST" } }] }),
			row({ uuid: "second-call", content: [{ type: "tool_use", id: reusedId, name: "Bash", input: { command: "npm test" } }] }),
			row({
				type: "user",
				uuid: "second-result",
				sourceToolAssistantUUID: "second-call",
				parentUuid: "first-call",
				content: [{ type: "tool_result", tool_use_id: reusedId, content: "24 tests passed", is_error: false }],
			}),
			row({
				type: "user",
				uuid: "first-result",
				parentUuid: "first-call",
				content: [{ type: "tool_result", tool_use_id: reusedId, content: "done", is_error: false }],
			}),
		];
		const result = captureClaudeTranscriptRows(rows, OPTIONS);

		expect(result.messages.map((message) => message.sourceEvent.kind)).toEqual(["test_result", "file_change"]);
		expect(result.messages[0].content).toContain("Tests: 24 passed.");
		expect(result.messages[1].content).toContain("src/first.ts");
		expect(new Set(result.messages.map((message) => message.sourceEvent.parent_event_id)).size).toBe(2);
		expect(result.metadata).toMatchObject({
			exactSourceMatches: 1,
			exactParentMatches: 1,
			fifoMatches: 0,
			ambiguousToolResults: 0,
		});
		expect(allSerialized(result)).not.toContain("PRIVATE_");
	});

	it("fails closed on reused IDs without exact host evidence", () => {
		const reusedId = "toolu_ambiguous_reuse";
		const result = captureClaudeTranscriptRows([
			row({ uuid: "ambiguous-first-call", content: [{ type: "tool_use", id: reusedId, name: "Write", input: { file_path: "src/first.ts" } }] }),
			row({ uuid: "ambiguous-second-call", content: [{ type: "tool_use", id: reusedId, name: "Write", input: { file_path: "src/second.ts" } }] }),
			row({ type: "user", uuid: "ambiguous-first-result", content: [{ type: "tool_result", tool_use_id: reusedId, content: "done" }] }),
			row({ type: "user", uuid: "ambiguous-second-result", content: [{ type: "tool_result", tool_use_id: reusedId, content: "done" }] }),
		], OPTIONS);

		expect(result.messages).toEqual([]);
		expect(result.metadata).toMatchObject({
			ambiguousToolResults: 2,
			reusedIdResultsRejected: 2,
			ignoredToolEvents: 2,
		});
	});

	it("uses exact links so ignored reused calls cannot relabel later results", () => {
		const reusedId = "toolu_ignored_reuse";
		const result = captureClaudeTranscriptRows([
			row({ uuid: "ignored-read-call", content: [{ type: "tool_use", id: reusedId, name: "Read", input: { file_path: "PRIVATE_READ_PATH" } }] }),
			row({ uuid: "kept-write-call", content: [{ type: "tool_use", id: reusedId, name: "Write", input: { file_path: "src/kept.ts", content: "PRIVATE_WRITE_CONTENT" } }] }),
			row({ type: "user", uuid: "ignored-read-result", sourceToolAssistantUUID: "ignored-read-call", content: [{ type: "tool_result", tool_use_id: reusedId, content: "PRIVATE_READ_RESULT", is_error: true }] }),
			row({ type: "user", uuid: "kept-write-result", sourceToolAssistantUUID: "kept-write-call", content: [{ type: "tool_result", tool_use_id: reusedId, content: "done", is_error: false }] }),
		], OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].sourceEvent).toMatchObject({ kind: "file_change", outcome: "success" });
		expect(result.messages[0].content).toContain("src/kept.ts");
		expect(result.metadata.exactSourceMatches).toBe(2);
		expect(allSerialized(result)).not.toContain("PRIVATE_");
	});

	it("rejects unlinked results when the scanned prefix is truncated", () => {
		const rows = [
			row({ uuid: "truncated-call", content: [{ type: "tool_use", id: "truncated-id", name: "Bash", input: { command: "npm test" } }] }),
			row({ type: "user", uuid: "truncated-result", content: [{ type: "tool_result", tool_use_id: "truncated-id", content: "24 tests passed" }] }),
		];
		const selection = selectClaudeCaptureTailRows(rows, {
			...OPTIONS,
			maxEvents: 1,
			prefixTruncated: true,
		});
		const captured = captureClaudeTranscriptRows(rows, { ...OPTIONS, prefixTruncated: true });

		expect(selection.rows).toEqual([]);
		expect(selection.metadata).toMatchObject({
			ambiguousToolResults: 1,
			ambiguousOutcomeRows: 1,
			incompletePrefixResultsRejected: 1,
			selectedOutcomeRows: 0,
		});
		expect(captured.messages).toEqual([]);
		expect(captured.metadata).toMatchObject({
			ambiguousToolResults: 1,
			incompletePrefixResultsRejected: 1,
			ignoredToolEvents: 1,
		});
	});

	it("selects a linear, bounded tail from thousands of exact-linked reused IDs", () => {
		const reusedId = "toolu_performance_reuse";
		const rows = [];
		for (let index = 0; index < 2_000; index += 1) {
			rows.push(row({
				uuid: `performance-call-${index}`,
				content: [{ type: "tool_use", id: reusedId, name: "Write", input: { file_path: `src/${index}.ts` } }],
			}));
			rows.push(row({
				type: "user",
				uuid: `performance-result-${index}`,
				sourceToolAssistantUUID: `performance-call-${index}`,
				content: [{ type: "tool_result", tool_use_id: reusedId, content: "done" }],
			}));
		}
		const startedAt = performance.now();
		const selection = selectClaudeCaptureTailRows(rows, { ...OPTIONS, maxEvents: 80 });

		expect(performance.now() - startedAt).toBeLessThan(1_500);
		expect(selection.rows).toHaveLength(160);
		expect(selection.metadata).toMatchObject({
			exactSourceMatches: 2_000,
			selectedOutcomeRows: 80,
			companionRows: 80,
			companionClosureLimitReached: false,
		});
	});

	it("rejects a tool outcome when its row-level companion closure exceeds the cap", () => {
		const calls = Array.from({ length: 20 }, (_, index) => row({
			uuid: `bounded-call-${index}`,
			content: [{ type: "tool_use", id: `bounded-${index}`, name: "Write", input: { file_path: `src/${index}.ts` } }],
		}));
		const results = row({
			type: "user",
			uuid: "bounded-results",
			content: calls.map((_, index) => ({
				type: "tool_result",
				tool_use_id: `bounded-${index}`,
				content: "done",
			})),
		});
		const selection = selectClaudeCaptureTailRows([...calls, results], {
			...OPTIONS,
			maxEvents: 1,
			maxCompanionRows: 8,
		});

		expect(selection.rows).toEqual([]);
		expect(selection.metadata).toMatchObject({
			selectedOutcomeRows: 0,
			maxCompanionRows: 8,
			companionClosureLimitReached: true,
			companionLimitRejectedOutcomeRows: 1,
		});
	});

	it("selects one exact outcome without merging an independent result that shares its call row", () => {
		const sharedCall = row({
			uuid: "shared-independent-calls",
			content: [
				{ type: "tool_use", id: "shared-a", name: "Write", input: { file_path: "src/a.ts" } },
				{ type: "tool_use", id: "shared-b", name: "Write", input: { file_path: "src/b.ts" } },
			],
		});
		const resultA = row({
			type: "user",
			uuid: "shared-result-a",
			sourceToolAssistantUUID: "shared-independent-calls",
			content: [{ type: "tool_result", tool_use_id: "shared-a", content: "done" }],
		});
		const resultB = row({
			type: "user",
			uuid: "shared-result-b",
			sourceToolAssistantUUID: "shared-independent-calls",
			content: [{ type: "tool_result", tool_use_id: "shared-b", content: "done" }],
		});
		const selection = selectClaudeCaptureTailRows([sharedCall, resultA, resultB], {
			...OPTIONS,
			maxEvents: 1,
		});
		const captured = captureClaudeTranscriptRows(selection.rows, OPTIONS);

		expect(selection.rows).toEqual([sharedCall, resultB]);
		expect(selection.metadata).toMatchObject({
			selectedOutcomeRows: 1,
			companionRows: 1,
			companionLimitRejectedOutcomeRows: 0,
		});
		expect(captured.messages).toHaveLength(1);
		expect(captured.messages[0].content).toContain("src/b.ts");
	});

	it("keeps only a scrubbed concise failure and drops stack, diff, dependency, and progress noise", () => {
		const hugeNoise = Array.from({ length: 500 }, (_, index) => `Downloading dependency ${index} [==========] 50%`).join("\n");
		const rows = toolPair({
			name: "PowerShell",
			input: { command: "node PRIVATE_RAW_COMMAND --token PRIVATE_RAW_TOKEN", description: "Check the local helper" },
			content:
				`${hugeNoise}\nError: request failed with sk-abcdefghijklmnopQRSTUV123456\n` +
				"    at privateFunction (C:\\private\\secret.js:4:2)\n" +
				"-private old diff\n+private new diff\nExited with code 2",
			isError: true,
			result: { interrupted: false, exitCode: 2, stdout: "", stderr: "Error: request failed with sk-abcdefghijklmnopQRSTUV123456" },
			id: "failure",
		});
		const result = captureClaudeTranscriptRows(rows, OPTIONS);
		const [message] = result.messages;

		expect(result.messages).toHaveLength(1);
		expect(message.sourceEvent).toMatchObject({ kind: "error", outcome: "failure", exit_code: 2, truncated: true });
		expect(Array.from(message.content).length).toBeLessThanOrEqual(DEFAULT_CLAUDE_CAPTURE_MAX_CHARS);
		expect(result.metadata.redactions.api_key).toBe(1);
		expect(message.content).not.toContain("PRIVATE_RAW_COMMAND");
		expect(message.content).not.toContain("PRIVATE_RAW_TOKEN");
		expect(message.content).not.toContain("privateFunction");
		expect(message.content).not.toContain("private old diff");
		expect(message.content).not.toContain("Downloading dependency");
	});

	it("derives structural evidence without forwarding logs, diffs, descriptions, or short secrets", () => {
		const call = row({
			uuid: "structural-call",
			content: [{ type: "tool_use", id: "structural", name: "Bash", input: { command: "npm test", description: "RAW_DESCRIPTION_PAYLOAD" } }],
		});
		const resultRow = row({
			type: "user",
			uuid: "structural-result",
			content: [{
				type: "tool_result",
				tool_use_id: "structural",
				content: "+ added failing test RAW_DIFF_PAYLOAD\n- removed fixture RAW_REMOVED_DIFF\nError: password=hunter2 RAW_LOG_PAYLOAD\nTests: 1 failed, 9 passed, 10 total",
				is_error: true,
			}],
		});
		const result = captureClaudeTranscriptRows([call, resultRow], OPTIONS);
		const serialized = allSerialized(result);

		expect(result.messages[0].content).toContain("Tests: 1 failed, 9 passed, 10 total.");
		expect(serialized).not.toMatch(/RAW_(?:DESCRIPTION_PAYLOAD|DIFF_PAYLOAD|REMOVED_DIFF|LOG_PAYLOAD)|hunter2/);
		// The shared scrubber now covers labeled secrets too (campaign SEC-01), so
		// `password=hunter2` may be counted there instead of by this hook's own
		// named-secret net. Either counter proves the redaction was recorded; both
		// layers are kept deliberately, so assert on the total.
		const secretRedactions = (result.metadata.redactions.named_secret ?? 0)
			+ (result.metadata.redactions.labeled_secret ?? 0);
		expect(secretRedactions).toBe(1);
	});

	it("derives failure from structured status without null-timeout or success contradictions", () => {
		const rows = toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: "fixture process ended",
			isError: false,
			result: { timedOutAfterMs: null, exitCode: 2, stdout: "", stderr: "" },
			id: "status",
		});
		const result = captureClaudeTranscriptRows(rows, OPTIONS);

		expect(result.messages[0].sourceEvent).toMatchObject({ outcome: "failure", exit_code: 2 });
		expect(result.messages[0].content).toContain("status=failed");
		expect(result.messages[0].content).not.toContain("timed out");
	});

	it("lets a positive failed-test count override a contradictory success flag", () => {
		const result = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: "Tests: 1 failed, 9 passed, 10 total",
			isError: false,
			id: "contradictory-test-status",
		}), OPTIONS);

		expect(result.messages[0].sourceEvent.outcome).toBe("failure");
		expect(result.messages[0].content).toContain("status=failed");
	});

	it.each([
		["go test ./...", "ok example.invalid/pkg 0.123s", "success"],
		["dotnet test", "Passed: 12, Failed: 0, Skipped: 1", "success"],
		["mvn test", "Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\nBUILD SUCCESS", "success"],
		["gradle test", "BUILD SUCCESSFUL in 2s", "success"],
		["rspec", "12 examples, 0 failures", "success"],
		["phpunit", "OK (12 tests, 34 assertions)", "success"],
		["dotnet test", "Passed: 11, Failed: 1, Skipped: 0", "failure"],
		["mvn test", "Tests run: 12, Failures: 1, Errors: 0\nBUILD FAILURE", "failure"],
		["rspec", "12 examples, 1 failure", "failure"],
		["phpunit", "FAILURES!\nTests: 12, Assertions: 34, Failures: 1", "failure"],
	])("recognizes content-minimal test outcome %s => %s", (command, content, outcome) => {
		const result = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command },
			content,
			isError: null,
			id: `family-${command.replace(/\W+/g, "-")}-${outcome}`,
		}), OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].sourceEvent).toMatchObject({ kind: "test_result", outcome });
		expect(result.messages[0].content).not.toContain("example.invalid");
	});

	it.each([
		["mvn package", "[INFO] BUILD FAILURE", "failure"],
		["npm run build", "BUILD FAILURE", "failure"],
		["npm run build", "", "unknown"],
		["npm run build", "BUILD SUCCESSFUL", "success"],
		["npm run lint", "Lint passed", "success"],
	])("does not infer build/lint success without narrow evidence: %s", (command, content, outcome) => {
		const result = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command },
			content,
			isError: null,
			id: `command-${command.replace(/\W+/g, "-")}-${outcome}`,
		}), OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].sourceEvent).toMatchObject({ kind: "command_result", outcome });
	});

	it("strips recalled result markers before status classification", () => {
		const recalledFailure = formatItsukiRecallContext("Tests: 1 failed, 99 passed.");
		const recalledSuccess = formatItsukiRecallContext("Tests: 100 passed.");
		const hostSuccess = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: recalledFailure,
			isError: false,
			id: "recall-status-host-success",
		}), OPTIONS);
		const hostFailure = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: recalledSuccess,
			isError: true,
			id: "recall-status-host-failure",
		}), OPTIONS);
		const noHostStatus = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: recalledFailure,
			isError: null,
			id: "recall-status-unknown",
		}), OPTIONS);

		expect(hostSuccess.messages[0].sourceEvent.outcome).toBe("success");
		expect(hostFailure.messages[0].sourceEvent.outcome).toBe("failure");
		expect(noHostStatus.messages[0].sourceEvent.outcome).toBe("unknown");
		for (const result of [hostSuccess, hostFailure, noHostStatus]) {
			expect(allSerialized(result)).not.toMatch(/1 failed|99 passed|100 passed/);
		}
	});

	it("recognizes an unstructured Error line without forwarding that line", () => {
		const call = row({
			uuid: "unstructured-error-call",
			content: [{ type: "tool_use", id: "unstructured-error", name: "Bash", input: { command: "node fixture.js" } }],
		});
		const resultRow = row({
			type: "user",
			uuid: "unstructured-error-result",
			content: [{ type: "tool_result", tool_use_id: "unstructured-error", content: "Error: RAW_UNSTRUCTURED_LOG" }],
		});
		const result = captureClaudeTranscriptRows([call, resultRow], OPTIONS);

		expect(result.messages[0].sourceEvent).toMatchObject({ kind: "error", outcome: "failure" });
		expect(result.messages[0].content).not.toContain("RAW_UNSTRUCTURED_LOG");
	});

	it("bounds a large test log to final outcome evidence", () => {
		const log = [
			...Array.from({ length: 2_000 }, (_, index) => `transient progress line ${index}`),
			"Test Suites: 1 failed, 49 passed, 50 total",
			"Tests: 1 failed, 499 passed, 500 total",
		].join("\n");
		const result = captureClaudeTranscriptRows(toolPair({
			name: "Bash",
			input: { command: "npx vitest run", description: "Run full suite" },
			content: log,
			isError: true,
			id: "large-test",
		}), OPTIONS);
		const [message] = result.messages;

		expect(message.sourceEvent).toMatchObject({ kind: "test_result", outcome: "failure", truncated: true });
		expect(message.content).toContain("499 passed");
		expect(message.content).not.toContain("transient progress line 0");
		expect(Array.from(message.content).length).toBeLessThanOrEqual(DEFAULT_CLAUDE_CAPTURE_MAX_CHARS);
	});

	it("captures a scrubbed user answer but ignores read, progress, browser, and recall traffic", () => {
		const rows = [
			...toolPair({
				name: "AskUserQuestion",
				input: { questions: [{ question: "Paste a value", options: [{ label: "credentialvalue" }] }] },
				content: "answered",
				result: { answers: { value: "credentialvalue" } },
				id: "ask-secret",
			}),
			...toolPair({
				name: "AskUserQuestion",
				input: { questions: [{ question: "Which architecture?" }] },
				content: "answered",
				result: { answers: { architecture: "I prefer the Worker-owned queue with sk-abcdefghijklmnopQRSTUV123456 removed." } },
				id: "ask",
			}),
			...toolPair({ name: "Read", input: { file_path: "private" }, content: "PRIVATE_READ_RESULT", id: "read" }),
			...toolPair({ name: "mcp__Claude_Browser__navigate", input: { url: "https://private.test" }, content: "PRIVATE_BROWSER_RESULT", isError: true, id: "browser" }),
			...toolPair({ name: "mcp__itsuki__recall_memory", input: { query: "private" }, content: "PRIVATE_RECALL_RESULT", id: "recall" }),
			{ type: "progress", payload: "PRIVATE_PROGRESS" },
		];
		const result = captureClaudeTranscriptRows(rows, OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].sourceEvent.kind).toBe("user_preference");
		expect(result.messages[0].content).toContain("[REDACTED:api-key]");
		expect(allSerialized(result)).not.toContain("PRIVATE_READ_RESULT");
		expect(allSerialized(result)).not.toContain("PRIVATE_BROWSER_RESULT");
		expect(allSerialized(result)).not.toContain("PRIVATE_RECALL_RESULT");
		expect(allSerialized(result)).not.toContain("PRIVATE_PROGRESS");
		expect(allSerialized(result)).not.toContain("credentialvalue");
	});

	it("blocks memory-attributed correlation and strips recalled context echoed by a shell", () => {
		const attributedCall = row({
			uuid: "attributed-call",
			attributionMcpTool: "mcp__itsuki__recall_memory",
			content: [{ type: "tool_use", id: "attributed", name: "Bash", input: { command: "npm test" } }],
		});
		const attributedResult = row({
			type: "user",
			uuid: "attributed-result",
			content: [{ type: "tool_result", tool_use_id: "attributed", content: "Tests: 99 passed. PRIVATE_ATTRIBUTED_RECALL", is_error: false }],
		});
		const echoed = toolPair({
			name: "Bash",
			input: { command: "npm test" },
			content: formatItsukiRecallContext("Tests: 88 passed. PRIVATE_ECHOED_RECALL"),
			id: "echoed-recall",
		});
		const result = captureClaudeTranscriptRows([attributedCall, attributedResult, ...echoed], OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].sourceEvent.kind).toBe("test_result");
		expect(allSerialized(result)).not.toMatch(/PRIVATE_(?:ATTRIBUTED|ECHOED)_RECALL/);
	});

	it("suppresses near-exact unmarked assistant echoes without dropping a new outcome", () => {
		const recalled = "Architecture decision: keep the retry ledger in D1.";
		const options = {
			...OPTIONS,
			recallFingerprints: recallEchoFingerprintsFromText(recalled, OPTIONS),
		};
		const result = captureClaudeTranscriptRows([
			row({
				uuid: "unmarked-recall-echo",
				content:
					"We decided to keep the retry ledger in D1.\n" +
					"Architecture decision: move retry ownership into the Durable Object.",
			}),
			row({
				type: "user",
				uuid: "explicit-user-restatement",
				content: "We decided to keep the retry ledger in D1.",
			}),
		], options);

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0].content).toContain("move retry ownership into the Durable Object");
		expect(result.messages[0].content).not.toContain("keep the retry ledger in D1");
		expect(result.messages[1].sourceEvent.kind).toBe("decision");
		expect(result.metadata.ignoredRecallEchoEvents).toBe(1);
	});

	it("filters recalled lines before applying the four-line assistant outcome cap", () => {
		const recalled = "Architecture decision: keep the retry ledger in D1.";
		const options = {
			...OPTIONS,
			recallFingerprints: recallEchoFingerprintsFromText(recalled, OPTIONS),
		};
		const result = captureClaudeTranscriptRows([
			row({
				uuid: "new-outcome-before-four-echoes",
				content: [
					"Architecture decision: keep the scheduler lease in the Durable Object.",
					...Array.from({ length: 4 }, () => "We decided to keep the retry ledger in D1."),
				].join("\n"),
			}),
		], options);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toContain("scheduler lease in the Durable Object");
		expect(result.messages[0].content).not.toContain("retry ledger in D1");
		expect(result.metadata.ignoredRecallEchoEvents).toBe(4);
	});

	it("separates fail-closed unprotected assistant prose from confirmed recall echoes", () => {
		const result = captureClaudeTranscriptRows([
			row({
				uuid: "unprotected-assistant-outcome",
				content: "Architecture decision: keep this unverified assistant assertion.",
			}),
		], { ...OPTIONS, suppressAssistantProse: true });

		expect(result.messages).toEqual([]);
		expect(result.metadata).toMatchObject({
			ignoredRecallEchoEvents: 0,
			ignoredUnprotectedAssistantEvents: 1,
		});
	});

	it("rejects raw command prose and redacts short named secrets in durable text", () => {
		const result = captureClaudeTranscriptRows([
			row({ type: "user", uuid: "raw-command-prose", content: "We decided to run npm test --token hunter2." }),
			row({ uuid: "cargo-command-prose", content: "We decided to run cargo test RAW_CARGO_COMMAND." }),
			row({ uuid: "go-command-prose", content: "We decided to run go test ./... RAW_GO_COMMAND." }),
			row({ uuid: "code-assignment-prose", content: 'status = "fixed RAW_CODE_ASSIGNMENT"' }),
			// CLD-02 contract update (§3.2 justified): capture scrubbing is now the
			// shared server lane verbatim — labeled values redact only in
			// separator forms (=, :, is/was) with the D8 value-shape guard, and
			// quoted multi-word passphrases are caught by the quoted alternates.
			// The old bare-whitespace form ("credential hunter2") is gone on
			// purpose: it ate ordinary prose ("token bucket", "bearer of bad
			// news") in durable capture. A 1-char value (pwd=x) is prose noise,
			// not a credential, under the same guard.
			row({ type: "user", uuid: "named-secret-prose", content: 'We prefer pwd=x9$k42q, password is "two words", and credential: hunter2z for fixture access.' }),
		], OPTIONS);

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toContain("pwd=[REDACTED:secret]");
		expect(result.messages[0].content).toContain("password is [REDACTED:secret]");
		expect(allSerialized(result)).not.toContain("hunter2z");
		expect(allSerialized(result)).not.toContain("two words");
		expect(allSerialized(result)).not.toMatch(/RAW_(?:CARGO_COMMAND|GO_COMMAND|CODE_ASSIGNMENT)/);
		expect(result.metadata.redactions.labeled_secret).toBe(3);
	});

	it("returns no messages for a real-shape transcript with no durable outcome", async () => {
		const result = captureClaudeTranscriptRows(
			await fixture("2.1.221-no-durable-outcome.jsonl"),
			OPTIONS,
		);

		expect(result.messages).toEqual([]);
		expect(result.metadata.capturedEvents).toBe(0);
		expect(result.metadata.ignoredThinkingBlocks).toBe(1);
		expect(allSerialized(result)).not.toContain("SYNTHETIC_PRIVATE_REASONING");
	});
});
