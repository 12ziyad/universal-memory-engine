import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_CODEX_SCAN_LIMITS,
	parseCodexTranscriptText,
	readCodexTranscript,
} from "../plugins/itsuki/hooks/codex-transcript.mjs";
import { recallEchoFingerprintsFromText } from "../plugins/itsuki/hooks/codex-scrub.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, "test", "fixtures", "codex", "0.146.0-alpha.9.2-lifecycle.jsonl");
const temporaryRoots = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function row(payload, type = "response_item") {
	return JSON.stringify({ timestamp: "2026-08-05T00:00:00.000Z", type, payload });
}

describe("Codex 0.146.0-alpha.9.2 transcript capture", () => {
	it("captures only user/final prose and correlated durable tool outcomes", async () => {
		const fixture = await readFile(FIXTURE, "utf8");
		const first = parseCodexTranscriptText(fixture, { sessionId: "fixture-session" });
		const second = parseCodexTranscriptText(fixture, { sessionId: "fixture-session" });

		expect(second).toEqual(first);
		expect(first.messages.map((message) => message.role)).toEqual(["user", "tool", "tool", "assistant"]);
		expect(first.messages).toHaveLength(4);
		expect(new Set(first.messages.map((message) => message.id)).size).toBe(4);
		const captured = JSON.stringify(first.messages);
		expect(captured).toContain("[REDACTED:api-key]");
		expect(captured).toContain("[REDACTED:token]");
		expect(captured).toContain("Tests 12 passed");
		expect(captured).not.toMatch(/COMMENTARY_SENTINEL|DEVELOPER_SENTINEL|SYSTEM_SENTINEL/);
		expect(captured).not.toMatch(/REASONING_SUMMARY|ENCRYPTED_REASONING|PRIVATE_FUNCTION_LOG|PRIVATE_CUSTOM_LOG/);
		expect(captured).not.toMatch(/UNMATCHED_OUTPUT|AGENT_MESSAGE_DUPLICATE|FIXTURESECRET|ZYXWVUT/);
		expect(first.metadata.ignoredDeveloperSystemRows).toBe(2);
		expect(first.metadata.ignoredReasoningRows).toBe(1);
		expect(first.metadata.ignoredEncryptedRows).toBe(1);
		expect(first.metadata.ignoredCommentaryRows).toBe(1);
		expect(first.metadata.ignoredEventDuplicates).toBeGreaterThanOrEqual(4);
		expect(first.metadata.unmatchedToolOutputs).toBe(1);
		expect(first.metadata.redactions.api_key).toBeGreaterThanOrEqual(1);
		expect(first.metadata.redactions.bearer_token).toBeGreaterThanOrEqual(1);
	});

	it("fails closed for malformed, unknown, invalid-UTF8, and oversized rows", () => {
		const valid = row({
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Implemented the bounded parser." }],
			id: "valid-final",
		});
		const unknown = row({ type: "future_private_payload", text: "UNKNOWN_PRIVATE_SENTINEL" });
		const oversized = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `OVERSIZED_PRIVATE_SENTINEL${"x".repeat(DEFAULT_CODEX_SCAN_LIMITS.maxLineBytes)}` }] } });
		const buffer = Buffer.concat([
			Buffer.from(`${valid}\n{malformed\n${unknown}\n${oversized}\n`, "utf8"),
			Buffer.from([0xff, 0xfe, 0x0a]),
		]);
		const parsed = parseCodexTranscriptText(buffer.toString("latin1"), { sessionId: "unsafe-shapes" });

		// latin1-to-UTF8 makes the final line valid Unicode, so malformed coverage
		// comes from the broken JSON row; a file test below covers fatal UTF-8.
		expect(parsed.messages).toHaveLength(1);
		expect(JSON.stringify(parsed.messages)).not.toMatch(/UNKNOWN_PRIVATE|OVERSIZED_PRIVATE/);
		expect(parsed.metadata.malformedRows).toBeGreaterThanOrEqual(1);
		expect(parsed.metadata.oversizedRows).toBe(1);
		expect(parsed.metadata.unknownRows).toBeGreaterThanOrEqual(1);
	});

	it("does not attribute an output when a call_id is reused or mismatched", () => {
		const transcript = [
			row({ type: "custom_tool_call", name: "exec", status: "completed", call_id: "ambiguous", input: "one", id: "one" }),
			row({ type: "custom_tool_call", name: "exec", status: "completed", call_id: "ambiguous", input: "two", id: "two" }),
			row({ type: "custom_tool_call_output", call_id: "ambiguous", output: "Script completed\nExit code: 0", id: "output" }),
			row({ type: "function_call", name: "shell_command", arguments: "{}", call_id: "wrong-kind", id: "three" }),
			row({ type: "custom_tool_call_output", call_id: "wrong-kind", output: "Script completed", id: "wrong-output" }),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "ambiguous-session" });
		expect(parsed.messages).toEqual([]);
		expect(parsed.metadata.ambiguousToolCalls).toBe(1);
		expect(parsed.metadata.ignoredToolRows).toBeGreaterThanOrEqual(1);
	});

	it("fails closed for duplicate outputs and output-before-call ordering", () => {
		const transcript = [
			row({ type: "function_call_output", call_id: "future-call", output: "Process exited with code 0", id: "early" }),
			row({ type: "function_call", name: "shell_command", arguments: "{}", call_id: "future-call", id: "late-call" }),
			row({ type: "function_call", name: "shell_command", arguments: "{}", call_id: "duplicate-output", id: "call" }),
			row({ type: "function_call_output", call_id: "duplicate-output", output: "Process exited with code 0", id: "first" }),
			row({ type: "function_call_output", call_id: "duplicate-output", output: "Process exited with code 0", id: "second" }),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "ordering-session" });
		expect(parsed.messages).toEqual([]);
		expect(parsed.metadata.ambiguousToolCalls).toBe(3);
	});

	it("never derives prose identity from bounded-tail position", () => {
		const message = row({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Implement stable transcript identity." }],
		});
		const shifted = parseCodexTranscriptText(`${row({ type: "token_count" }, "event_msg")}\n${message}`, { sessionId: "stable-id" });
		const unshifted = parseCodexTranscriptText(message, { sessionId: "stable-id" });
		expect(shifted.messages[0].id).toBe(unshifted.messages[0].id);

		const missing = parseCodexTranscriptText(JSON.stringify({
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Implement no positional fallback." }] },
		}), { sessionId: "missing-id" });
		expect(missing.messages).toEqual([]);
		expect(missing.metadata.missingStableIdentityRows).toBe(1);
	});

	it("preserves distinct host message IDs but fails closed for one ID with conflicting content", () => {
		const sameContent = "Implement the same explicit requirement.";
		const distinct = parseCodexTranscriptText([
			row({ type: "message", role: "user", content: [{ type: "input_text", text: sameContent }], id: "host-one" }),
			row({ type: "message", role: "user", content: [{ type: "input_text", text: sameContent }], id: "host-two" }),
		].join("\n"), { sessionId: "distinct-host-ids" });
		expect(distinct.messages).toHaveLength(2);
		expect(new Set(distinct.messages.map(({ id }) => id)).size).toBe(2);

		const conflicting = parseCodexTranscriptText([
			row({ type: "message", role: "user", content: [{ type: "input_text", text: "Implement option one." }], id: "reused-host-id" }),
			row({ type: "message", role: "user", content: [{ type: "input_text", text: "Implement option two." }], id: "reused-host-id" }),
		].join("\n"), { sessionId: "conflicting-host-id" });
		expect(conflicting.messages).toEqual([]);
		expect(conflicting.metadata.ambiguousMessageIdentityRows).toBe(2);
	});

	it("classifies an assistant final assertion as unproven rather than successful", () => {
		const parsed = parseCodexTranscriptText(row({
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Implemented the fix and all tests pass." }],
			id: "bare-assistant-claim",
		}), { sessionId: "assistant-trust" });
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0].source_event).toMatchObject({ kind: "assistant_prose", outcome: "unknown" });
	});

	it("removes recalled context echoed by a correlated tool output before classifying evidence", () => {
		const recalled = "Tests 99 passed";
		const transcript = [
			row({ type: "function_call", name: "shell_command", arguments: "{}", call_id: "echoed-tool", status: "completed", id: "call" }),
			row({ type: "function_call_output", call_id: "echoed-tool", output: `Process exited with code 0\n${recalled}`, id: "output" }),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, {
			sessionId: "tool-recall-echo",
			recallEchoFingerprints: recallEchoFingerprintsFromText(recalled),
		});
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0].source_event).toMatchObject({ kind: "command_result", outcome: "success" });
		expect(parsed.messages[0].content).not.toContain(recalled);
		expect(parsed.metadata.ignoredRecallEchoRows).toBe(1);
	});

	it("keeps the newest bounded messages and records content-free omissions", () => {
		const rows = Array.from({ length: 40 }, (_, index) => row({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: `Implement durable outcome number ${index}.` }],
			id: `user-${index}`,
		}));
		const parsed = parseCodexTranscriptText(rows.join("\n"), { sessionId: "bounded-messages" });
		expect(parsed.messages).toHaveLength(DEFAULT_CODEX_SCAN_LIMITS.maxMessages);
		expect(parsed.messages[0].content).toContain("number 16");
		expect(parsed.metadata.candidateMessages).toBe(40);
		expect(parsed.metadata.omittedMessages).toBe(16);
		expect(Object.values(parsed.metadata).some((value) => String(value).includes("outcome number"))).toBe(false);
	});

	it("drops a conversational transcript with no durable coding outcome", () => {
		const transcript = [
			row({ type: "message", role: "user", content: [{ type: "input_text", text: "Hello there." }], id: "hello" }),
			row({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I am checking." }], id: "checking" }),
			row({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Hello!" }], id: "greeting" }),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "no-durable-outcome" });
		expect(parsed.messages).toEqual([]);
		expect(parsed.metadata.ignoredCommentaryRows).toBe(1);
		expect(parsed.metadata.ignoredNoiseRows).toBe(2);
	});

	it("retains a test result at the bounded tail of a large tool log", () => {
		const transcript = [
			row({ type: "function_call", name: "shell_command", arguments: "{}", call_id: "large-log", id: "call" }),
			row({
				type: "function_call_output",
				call_id: "large-log",
				output: `${"dependency progress noise\n".repeat(4_000)}Process exited with code 0\nTests 91 passed`,
				id: "output",
			}),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "large-log-session" });
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0].content).toContain("Tests 91 passed");
		expect(parsed.messages[0].content).not.toContain("dependency progress noise");
		expect(parsed.messages[0].source_event).toMatchObject({
			schema: "itsuki.source-event/v1",
			kind: "test_result",
			outcome: "success",
			tool_name: "RunCommand",
			exit_code: 0,
			truncated: true,
		});
		expect(parsed.metadata.truncatedToolOutputs).toBe(1);
	});

	it("records content-free file-change and architecture-decision provenance", () => {
		const transcript = [
			row({ type: "function_call", name: "apply_patch", arguments: "PRIVATE_DIFF_MUST_NOT_CAPTURE", call_id: "patch", id: "patch-call" }),
			row({ type: "function_call_output", call_id: "patch", output: "Done!", id: "patch-output" }),
			row({
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: "Architecture decision: use a protected local queue for shutdown durability." }],
				id: "architecture",
			}),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "provenance-session" });
		expect(parsed.messages.map((message) => message.source_event.kind)).toEqual(["file_change", "architecture_decision"]);
		expect(parsed.messages[0].source_event).toMatchObject({ tool_name: "Write", outcome: "success" });
		expect(JSON.stringify(parsed.messages)).not.toContain("PRIVATE_DIFF");
	});

	it("reads only a bounded file tail and rejects invalid UTF-8 without leaking it", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-transcript-"));
		temporaryRoots.push(root);
		const path = join(root, "rollout.jsonl");
		const final = row({
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Verified the final bounded outcome." }],
			id: "final",
		});
		const prefix = Buffer.alloc(DEFAULT_CODEX_SCAN_LIMITS.maxScannedBytes + 512, 0x61);
		await writeFile(path, Buffer.concat([prefix, Buffer.from("\n"), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(`${final}\n`)]));
		const parsed = await readCodexTranscript(path, { sessionId: "tail-session" });
		expect(parsed.messages.at(-1)?.content).toContain("final bounded outcome");
		expect(parsed.metadata.omittedBytes).toBeGreaterThan(0);
		expect(parsed.metadata.malformedRows).toBe(1);
	});

	it("fails closed when the file changes during its snapshot or its time budget is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "itsuki-codex-transcript-change-"));
		temporaryRoots.push(root);
		const path = join(root, "rollout.jsonl");
		const final = row({
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Implemented the snapshot invariant." }],
			id: "final",
		});
		await writeFile(path, `${final}\n`, "utf8");
		const changed = await readCodexTranscript(path, {
			sessionId: "changed-session",
			afterSnapshotRead: async () => writeFile(path, `${final}\n${final}\n`, "utf8"),
		});
		expect(changed.messages).toEqual([]);
		expect(changed.metadata.fileChanged).toBe(1);

		const timedOut = parseCodexTranscriptText(final, { sessionId: "timed-session", limits: { maxScanMs: 0 } });
		expect(timedOut.messages).toEqual([]);
		expect(timedOut.metadata.timeLimitExceeded).toBe(1);
		expect(timedOut.metadata.omittedBytes).toBeGreaterThan(0);
	});
});
