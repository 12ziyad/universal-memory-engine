import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	ITSUKI_LEGACY_RECALL_PREFIXES,
	formatItsukiRecallContext,
} from "../hooks/claude-capture.mjs";
import { readClaudeTranscriptTail } from "../hooks/claude-transcript-tail.mjs";
import { messagesFromClaudeTranscriptLines } from "../hooks/claude-transcript.mjs";
import { recallEchoFingerprintsFromText } from "../hooks/recall-echo.mjs";

const temporaryDirectories = [];

async function transcript(contents) {
	const directory = await mkdtemp(join(tmpdir(), "itsuki-claude-tail-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "transcript.jsonl");
	await writeFile(path, contents);
	return path;
}

function event(index, overrides = {}) {
	return {
		type: index % 2 === 0 ? "user" : "assistant",
		uuid: `event-${index}`,
		message: {
			content: index % 2 === 0
				? `I decided to keep durable event ${index}.`
				: `Architecture decision: keep durable event ${index}.`,
		},
		...overrides,
	};
}

function line(value) {
	return JSON.stringify(value);
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
		recursive: true,
		force: true,
	})));
});

describe("bounded Claude transcript tail", () => {
	it("finds a durable final event without retaining a huge early tool line", async () => {
		const hugeToolLine = line({ type: "progress", payload: "x".repeat(3 * 1024 * 1024) });
		const durable = line(event(1, { message: { content: "Architecture decision: keep the durable answer." } }));
		const path = await transcript(`${hugeToolLine}\n${durable}\n`);

		const result = await readClaudeTranscriptTail(path, {
			maxScannedBytes: 96 * 1024,
			maxLineBytes: 1024,
			readChunkBytes: 4096,
			maxScanMs: 2_000,
		});

		expect(result.lines).toEqual([durable]);
		expect(result.metadata.oversizedLines).toBe(1);
		expect(result.metadata.scanTruncated).toBe(true);
		expect(result.metadata.truncationReason).toBe("max_bytes");
		expect(result.metadata.scannedBytes).toBeLessThanOrEqual(96 * 1024);
	});

	it("bounds a huge unterminated final line by bytes and time", async () => {
		const path = await transcript("z".repeat(4 * 1024 * 1024));
		const before = performance.now();
		const result = await readClaudeTranscriptTail(path, {
			maxScannedBytes: 128 * 1024,
			maxLineBytes: 2048,
			readChunkBytes: 8192,
			maxScanMs: 1_000,
		});

		expect(result.lines).toEqual([]);
		expect(result.metadata.oversizedLines).toBe(1);
		expect(result.metadata.partialLineSkipped).toBe(true);
		expect(result.metadata.truncationReason).toBe("max_bytes");
		expect(result.metadata.scannedBytes).toBe(128 * 1024);
		expect(performance.now() - before).toBeLessThan(1_000);
	});

	it("honors the scan-time ceiling independently of the byte ceiling", async () => {
		const path = await transcript("q".repeat(1024 * 1024));
		const result = await readClaudeTranscriptTail(path, {
			maxScannedBytes: 1024 * 1024,
			maxLineBytes: 512,
			readChunkBytes: 1024,
			maxScanMs: 0.001,
		});

		expect(result.lines).toEqual([]);
		expect(result.metadata.truncationReason).toBe("max_time");
		expect(result.metadata.scannedBytes).toBeLessThan(1024 * 1024);
	});

	it("preserves UTF-8 text and byte offsets across tiny CRLF chunks", async () => {
		const first = line(event(0, { message: { content: "I decided to preserve café 雪." } }));
		const second = line(event(1, { message: { content: [{ type: "text", text: "Architecture decision: preserve emoji 🧠." }] } }));
		const contents = `${first}\r\n${second}\r\n`;
		const path = await transcript(contents);

		const result = await readClaudeTranscriptTail(path, {
			readChunkBytes: 7,
			maxScanMs: 2_000,
		});

		expect(result.lines).toEqual([first, second]);
		expect(result.records).toEqual([
			expect.objectContaining({
				raw: first,
				byteOffset: 0,
				byteLength: Buffer.byteLength(first),
				endOffset: Buffer.byteLength(first),
				newlineBytes: 2,
			}),
			expect.objectContaining({
				raw: second,
				byteOffset: Buffer.byteLength(`${first}\r\n`),
				byteLength: Buffer.byteLength(second),
				newlineBytes: 2,
			}),
		]);
		expect(result.records[0].recordEndOffset).toBe(Buffer.byteLength(`${first}\r\n`));
		expect(result.records[1].recordEndOffset).toBe(Buffer.byteLength(contents));
		const parsed = await messagesFromClaudeTranscriptLines(result.lines, {
			sessionId: "tail-parser-contract",
		});
		expect(parsed[0].content).toContain("café 雪");
		expect(parsed[1].content).toContain("emoji 🧠");
	});

	it("returns only the newest 80 eligible events in chronological order", async () => {
		const sourceLines = Array.from({ length: 105 }, (_, index) => line(event(index)));
		const path = await transcript(`${sourceLines.join("\n")}\n`);

		const result = await readClaudeTranscriptTail(path, { maxScanMs: 2_000 });

		expect(result.lines).toEqual(sourceLines.slice(25));
		expect(result.records).toHaveLength(80);
		expect(result.records.every((record, index, records) => index === 0
			|| record.byteOffset > records[index - 1].byteOffset)).toBe(true);
		expect(result.metadata.truncationReason).toBe("max_events");
	});

	it("admits tool-only candidates but excludes thinking, meta, recall, ignored-tool, and unknown rows", async () => {
		const first = line(event(0));
		const editUse = line({
			type: "assistant",
			uuid: "edit-use",
			message: { content: [{ type: "tool_use", id: "tool-edit", name: "Edit", input: { file_path: "src/app.js" } }] },
		});
		const editResult = line({
			type: "user",
			uuid: "edit-result",
			sourceToolAssistantUUID: "edit-use",
			message: { content: [{ type: "tool_result", tool_use_id: "tool-edit", content: "updated" }] },
		});
		const final = line(event(2, {
			message: { content: [{ type: "tool_use", name: "read" }, { type: "text", text: "I decided to keep the final durable choice." }] },
		}));
		const rows = [
			first,
			"{not json",
			line({ type: "progress", message: { content: "ignore" } }),
			line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private reasoning" }] } }),
			line({ type: "system", message: { content: "host context" } }),
			line({ type: "user", isMeta: true, message: { content: "plugin metadata" } }),
			line({ type: "user", message: { content: formatItsukiRecallContext("recalled private memory") } }),
			line({
				type: "user",
				message: { content: `<system-reminder>\n${ITSUKI_LEGACY_RECALL_PREFIXES[0]}legacy memory` },
			}),
			line({ type: "assistant", message: { content: [{ type: "future_unknown", value: "unknown" }] } }),
			line({ type: "assistant", message: { content: [{ type: "tool_use", name: "read" }] } }),
			line({ type: "assistant", message: { content: "Ordinary chatter without a durable outcome." } }),
			editUse,
			editResult,
			final,
		];
		const path = await transcript(rows.join("\n"));

		const result = await readClaudeTranscriptTail(path, { readChunkBytes: 11 });

		expect(result.lines).toEqual([first, editUse, editResult, final]);
		expect(result.metadata.malformedLines).toBe(1);
		expect(result.metadata.ineligibleLines).toBe(9);
		expect(result.metadata.captureExclusions).toMatchObject({
			inputRows: 9,
			ineligibleRows: 8,
			ignoredThinkingBlocks: 1,
			ignoredMetaRows: 1,
			ignoredRecallEvents: 2,
			ignoredNoiseEvents: 1,
		});
		expect(result.metadata.scanTruncated).toBe(false);
	});

	it("does not let repeated current or legacy recall banners consume the newest-event window", async () => {
		const eligible = Array.from({ length: 90 }, (_, index) => line(event(index)));
		const recalls = Array.from({ length: 90 }, (_, index) => line({
			type: "user",
			uuid: `recall-${index}`,
			message: {
				content: index % 2 === 0
					? formatItsukiRecallContext(`recalled context ${index}`)
					: `${ITSUKI_LEGACY_RECALL_PREFIXES[1]} (${index}). Do not claim memory.`,
			},
		}));
		const path = await transcript(`${[...eligible, ...recalls].join("\n")}\n`);

		const result = await readClaudeTranscriptTail(path, { maxEvents: 80, maxScanMs: 2_000 });

		expect(result.lines).toEqual(eligible.slice(10));
		expect(result.metadata.returnedEvents).toBe(80);
		expect(result.metadata.ineligibleLines).toBe(90);
		expect(result.metadata.truncationReason).toBe("max_events");
	});

	it("does not let more than 80 unmarked assistant recall echoes crowd out a durable outcome", async () => {
		const sessionId = "unmarked-echo-tail-session";
		const recalled = "Architecture decision: keep the retry ledger in D1.";
		const durable = line(event(1, {
			message: { content: "Architecture decision: keep the scheduler lease in the Durable Object." },
		}));
		const echoes = Array.from({ length: 96 }, (_, index) => line(event(100 + index, {
			type: "assistant",
			message: { content: "We decided to keep the retry ledger in D1." },
		})));
		const path = await transcript(`${[durable, ...echoes].join("\n")}\n`);
		const options = {
			maxEvents: 80,
			maxScanMs: 2_000,
			sessionId,
			recallFingerprints: recallEchoFingerprintsFromText(recalled, { sessionId }),
		};

		const result = await readClaudeTranscriptTail(path, options);
		const messages = await messagesFromClaudeTranscriptLines(result.records, options);

		expect(result.lines).toEqual([durable]);
		expect(result.metadata.returnedEvents).toBe(1);
		expect(result.metadata.captureExclusions).toMatchObject({
			inputRows: 96,
			ineligibleRows: 96,
			ignoredRecallEchoEvents: 96,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toContain("scheduler lease in the Durable Object");
		expect(messages[0].content).not.toContain("retry ledger in D1");
	});

	it("keeps an older durable deployment beyond more than 80 unmatched results and prose-noise rows", async () => {
		const deploymentUse = line({
			type: "assistant",
			uuid: "durable-deploy-use",
			message: {
				content: [{
					type: "tool_use",
					id: "durable-deploy",
					name: "Bash",
					input: { command: "npx wrangler deploy" },
				}],
			},
		});
		const deploymentResult = line({
			type: "user",
			uuid: "durable-deploy-result",
			message: {
				content: [{
					type: "tool_result",
					tool_use_id: "durable-deploy",
					content: "Deployment succeeded. Version: fixture-v1",
					is_error: false,
				}],
			},
		});
		const unmatchedResults = Array.from({ length: 96 }, (_, index) => line({
			type: "user",
			uuid: `unmatched-result-${index}`,
			message: {
				content: [{ type: "tool_result", tool_use_id: `missing-${index}`, content: "noise" }],
			},
		}));
		const proseNoise = Array.from({ length: 96 }, (_, index) => line({
			type: "assistant",
			uuid: `prose-noise-${index}`,
			message: { content: `Routine progress update ${index}.` },
		}));
		const path = await transcript(`${[deploymentUse, deploymentResult, ...unmatchedResults, ...proseNoise].join("\n")}\n`);

		const result = await readClaudeTranscriptTail(path, { maxEvents: 80, maxScanMs: 2_000 });
		const messages = await messagesFromClaudeTranscriptLines(result.records, {
			sessionId: "ignored-result-flood",
		});

		expect(result.lines).toEqual([deploymentUse, deploymentResult]);
		expect(result.metadata).toMatchObject({
			returnedEvents: 1,
			returnedRows: 2,
			companionRows: 1,
			capturableOutcomeRows: 1,
			correlationRowsScanned: 98,
			scanTruncated: false,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].sourceEvent).toMatchObject({ kind: "deployment_result", outcome: "success" });
	});

	it("fails closed and reports a physically complete orphan tool result", async () => {
		const orphan = line({
			type: "user",
			uuid: "complete-orphan-result",
			message: {
				content: [{ type: "tool_result", tool_use_id: "missing-call", content: "claimed success" }],
			},
		});
		const path = await transcript(`${orphan}\n`);

		const result = await readClaudeTranscriptTail(path, { maxScanMs: 2_000 });

		expect(result.lines).toEqual([]);
		expect(result.metadata).toMatchObject({
			scanTruncated: false,
			ambiguousToolResults: 1,
			ambiguousOutcomeRows: 1,
			unmatchedToolResults: 1,
			returnedEvents: 0,
		});
		expect(result.metadata.captureExclusions.ignoredToolEvents).toBe(1);
	});

	it("counts outcome rows at the cap and retains the tool call split across its boundary", async () => {
		const testUse = line({
			type: "assistant",
			uuid: "boundary-test-use",
			message: {
				content: [{ type: "tool_use", id: "boundary-test", name: "Bash", input: { command: "npm test" } }],
			},
		});
		const testResult = line({
			type: "user",
			uuid: "boundary-test-result",
			message: {
				content: [{ type: "tool_result", tool_use_id: "boundary-test", content: "24 tests passed", is_error: false }],
			},
		});
		const newerOutcomes = Array.from({ length: 79 }, (_, index) => line(event(1_000 + index)));
		const path = await transcript(`${[testUse, testResult, ...newerOutcomes].join("\n")}\n`);

		const result = await readClaudeTranscriptTail(path, { maxEvents: 80, maxScanMs: 2_000 });
		const messages = await messagesFromClaudeTranscriptLines(result.records, {
			sessionId: "split-pair-boundary",
		});

		expect(result.lines).toEqual([testUse, testResult, ...newerOutcomes]);
		expect(result.metadata).toMatchObject({
			returnedEvents: 80,
			returnedRows: 81,
			companionRows: 1,
			capturableOutcomeRows: 80,
			scanTruncated: false,
		});
		expect(messages).toHaveLength(80);
		expect(messages[0].sourceEvent.kind).toBe("test_result");
	});

	it("keeps exact reused-ID correlation stable when the byte boundary drops an earlier call", async () => {
		const reusedId = "boundary-reused-id";
		const readUse = line({
			type: "assistant",
			uuid: "boundary-read-use",
			message: { content: [{ type: "tool_use", id: reusedId, name: "Read", input: { file_path: "private.txt" } }] },
		});
		const bashUse = line({
			type: "assistant",
			uuid: "boundary-bash-use",
			message: { content: [{ type: "tool_use", id: reusedId, name: "Bash", input: { command: "npm test" } }] },
		});
		const readResult = line({
			type: "user",
			uuid: "boundary-read-result",
			sourceToolAssistantUUID: "boundary-read-use",
			message: { content: [{ type: "tool_result", tool_use_id: reusedId, content: "999 tests passed" }] },
		});
		const bashResult = line({
			type: "user",
			uuid: "boundary-bash-result",
			sourceToolAssistantUUID: "boundary-bash-use",
			message: { content: [{ type: "tool_result", tool_use_id: reusedId, content: "24 tests passed" }] },
		});
		const path = await transcript(`${[readUse, bashUse, readResult, bashResult].join("\n")}\n`);
		const common = { maxEvents: 1, maxScanMs: 2_000, sessionId: "exact-boundary-shift" };
		const wide = await readClaudeTranscriptTail(path, common);
		const narrow = await readClaudeTranscriptTail(path, {
			...common,
			maxScannedBytes: Buffer.byteLength(`${bashUse}\n${readResult}\n${bashResult}\n`) + 1,
			readChunkBytes: 97,
		});
		const wideMessages = await messagesFromClaudeTranscriptLines(wide.records, common);
		const narrowMessages = await messagesFromClaudeTranscriptLines(narrow.records, common);

		expect(wide.lines).toEqual([bashUse, bashResult]);
		expect(narrow.lines).toEqual([bashUse, bashResult]);
		expect(narrow.metadata).toMatchObject({
			scanTruncated: true,
			truncationReason: "max_bytes",
			correlationPrefixIncomplete: true,
			exactSourceMatches: 1,
			ambiguousToolResults: 1,
			invalidExactLinkResults: 1,
		});
		expect(narrowMessages).toHaveLength(1);
		expect(narrowMessages[0].id).toBe(wideMessages[0].id);
		expect(narrowMessages[0].content).toContain("Tests: 24 passed.");
		expect(JSON.stringify(narrowMessages)).not.toContain("999 tests passed");
	});

	it("fails closed when a byte boundary makes reused IDs look unique without exact links", async () => {
		const reusedId = "ambiguous-boundary-id";
		const readUse = line({
			type: "assistant",
			uuid: "ambiguous-boundary-read",
			message: { content: [{ type: "tool_use", id: reusedId, name: "Read", input: {} }] },
		});
		const bashUse = line({
			type: "assistant",
			uuid: "ambiguous-boundary-bash",
			message: { content: [{ type: "tool_use", id: reusedId, name: "Bash", input: { command: "npm test" } }] },
		});
		const readResult = line({
			type: "user",
			uuid: "ambiguous-boundary-read-result",
			message: { content: [{ type: "tool_result", tool_use_id: reusedId, content: "999 tests passed" }] },
		});
		const bashResult = line({
			type: "user",
			uuid: "ambiguous-boundary-bash-result",
			message: { content: [{ type: "tool_result", tool_use_id: reusedId, content: "24 tests passed" }] },
		});
		const path = await transcript(`${[readUse, bashUse, readResult, bashResult].join("\n")}\n`);
		const result = await readClaudeTranscriptTail(path, {
			maxEvents: 1,
			maxScanMs: 2_000,
			maxScannedBytes: Buffer.byteLength(`${bashUse}\n${readResult}\n${bashResult}\n`) + 1,
			readChunkBytes: 101,
		});

		expect(result.lines).toEqual([]);
		expect(result.metadata).toMatchObject({
			correlationPrefixIncomplete: true,
			ambiguousToolResults: 2,
			ambiguousOutcomeRows: 2,
			incompletePrefixResultsRejected: 2,
			returnedEvents: 0,
		});
		expect(result.metadata.captureExclusions.ignoredToolEvents).toBe(2);
	});

	it("requires exact links when malformed or oversized rows can hide a call", async () => {
		for (const hiddenKind of ["malformed", "oversized"]) {
			const id = `hidden-${hiddenKind}`;
			const hidden = hiddenKind === "malformed"
				? "{malformed tool call"
				: line({
					type: "assistant",
					uuid: `${id}-hidden-call`,
					padding: "x".repeat(2_000),
					message: { content: [{ type: "tool_use", id, name: "Read", input: {} }] },
				});
			const call = line({
				type: "assistant",
				uuid: `${id}-visible-call`,
				message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] },
			});
			const resultLine = line({
				type: "user",
				uuid: `${id}-result`,
				message: { content: [{ type: "tool_result", tool_use_id: id, content: "24 tests passed" }] },
			});
			const path = await transcript(`${hidden}\n${call}\n${resultLine}\n`);
			const result = await readClaudeTranscriptTail(path, {
				maxEvents: 1,
				maxLineBytes: hiddenKind === "oversized" ? 512 : 4_096,
				maxScanMs: 2_000,
			});

			expect(result.lines, hiddenKind).toEqual([]);
			expect(result.metadata, hiddenKind).toMatchObject({
				scanTruncated: false,
				correlationPrefixIncomplete: true,
				ambiguousToolResults: 1,
				incompletePrefixResultsRejected: 1,
			});
			expect(result.metadata[hiddenKind === "malformed" ? "malformedLines" : "oversizedLines"]).toBe(1);
		}
	});

	it("uses exact links instead of retaining unrelated reused-ID memory rows", async () => {
		const reusedId = "toolu_reused_across_memory";
		const memoryUse = line({
			type: "assistant",
			uuid: "reused-memory-use",
			message: {
				content: [{ type: "tool_use", id: reusedId, name: "mcp__itsuki__recall_memory", input: {} }],
			},
		});
		const deployUse = line({
			type: "assistant",
			uuid: "reused-deploy-use",
			message: {
				content: [{ type: "tool_use", id: reusedId, name: "Bash", input: { command: "npx wrangler deploy" } }],
			},
		});
		const memoryResult = line({
			type: "user",
			uuid: "ignored-memory-result",
			sourceToolAssistantUUID: "reused-memory-use",
			message: {
				content: [{ type: "tool_result", tool_use_id: reusedId, content: "ignored recalled material" }],
			},
		});
		const deployResult = line({
			type: "user",
			uuid: "reused-deploy-result",
			sourceToolAssistantUUID: "reused-deploy-use",
			message: {
				content: [{ type: "tool_result", tool_use_id: reusedId, content: "Deployment succeeded. Version: fixture-v2", is_error: false }],
			},
		});
		const path = await transcript(`${[memoryUse, deployUse, memoryResult, deployResult].join("\n")}\n`);

		const result = await readClaudeTranscriptTail(path, { maxEvents: 1, maxScanMs: 2_000 });
		const messages = await messagesFromClaudeTranscriptLines(result.records, {
			sessionId: "reused-memory-id",
		});

		expect(result.lines).toEqual([deployUse, deployResult]);
		expect(result.metadata).toMatchObject({
			returnedEvents: 1,
			returnedRows: 2,
			companionRows: 1,
			exactSourceMatches: 2,
			ambiguousToolResults: 0,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].sourceEvent).toMatchObject({ kind: "deployment_result", outcome: "success" });
		expect(JSON.stringify(messages)).not.toContain("recalled material");
	});

	it("returns deterministic absolute offsets on repeated reads", async () => {
		const rows = [line(event(0)), line(event(1)), line(event(2))];
		const path = await transcript(rows.join("\n"));

		const first = await readClaudeTranscriptTail(path, { readChunkBytes: 5 });
		const second = await readClaudeTranscriptTail(path, { readChunkBytes: 13 });

		expect(second.records).toEqual(first.records);
		expect(first.records.map(({ byteOffset }) => byteOffset)).toEqual([
			0,
			Buffer.byteLength(`${rows[0]}\n`),
			Buffer.byteLength(`${rows[0]}\n${rows[1]}\n`),
		]);
	});

	it("keeps fallback message IDs stable as the bounded tail window moves", async () => {
		const fallback = (index) => line(event(index, {
			uuid: undefined,
			timestamp: new Date(Date.UTC(2026, 7, 5, 0, 0, index)).toISOString(),
			message: {
				content: index % 2 === 0
					? `I decided to keep fallback byte-offset event ${index}.`
					: `Architecture decision: keep fallback byte-offset event ${index}.`,
			},
		}));
		const initialLines = Array.from({ length: 100 }, (_, index) => fallback(index));
		const appendedLines = Array.from({ length: 20 }, (_, index) => fallback(index + 100));
		const path = await transcript(`${initialLines.join("\n")}\n`);
		const at100 = await readClaudeTranscriptTail(path, { maxEvents: 80, readChunkBytes: 257 });
		const messagesAt100 = await messagesFromClaudeTranscriptLines(at100.records, {
			sessionId: "moving-byte-tail-session",
		});

		await appendFile(path, `${appendedLines.join("\n")}\n`, "utf8");
		const at120 = await readClaudeTranscriptTail(path, { maxEvents: 80, readChunkBytes: 509 });
		const messagesAt120 = await messagesFromClaudeTranscriptLines(at120.records, {
			sessionId: "moving-byte-tail-session",
		});
		const eventIndex = (content) => Number(/byte-offset event (\d+)/.exec(content)?.[1]);
		const firstIds = new Map(messagesAt100.map((message) => [eventIndex(message.content), message.id]));
		const movedIds = new Map(messagesAt120.map((message) => [eventIndex(message.content), message.id]));
		const firstOffsets = new Map(at100.records.map((record) => [
			JSON.parse(record.raw).message.content,
			record.byteOffset,
		]));
		const movedOffsets = new Map(at120.records.map((record) => [
			JSON.parse(record.raw).message.content,
			record.byteOffset,
		]));

		expect(messagesAt100).toHaveLength(80);
		expect(messagesAt120).toHaveLength(80);
		for (let index = 40; index < 100; index += 1) {
			const content = index % 2 === 0
				? `I decided to keep fallback byte-offset event ${index}.`
				: `Architecture decision: keep fallback byte-offset event ${index}.`;
			expect(movedOffsets.get(content)).toBe(firstOffsets.get(content));
			expect(movedIds.get(index)).toBe(firstIds.get(index));
			expect(movedIds.get(index)).toMatch(/^claude_capture_v1_f_[a-f0-9]{32}$/);
		}
	});

	it("ignores bytes appended after the snapshot and reports file growth", async () => {
		const original = line(event(0));
		const appended = line(event(1));
		const path = await transcript(original);

		const result = await readClaudeTranscriptTail(path, {
			onSnapshot: async () => appendFile(path, `\n${appended}`),
		});

		expect(result.lines).toEqual([original]);
		expect(result.metadata.snapshotBytes).toBe(Buffer.byteLength(original));
		expect(result.metadata.observedFileBytes).toBe(Buffer.byteLength(`${original}\n${appended}`));
		expect(result.metadata.fileGrew).toBe(true);
		expect(result.metadata.grewByBytes).toBe(Buffer.byteLength(`\n${appended}`));
		expect(result.metadata.fileChangedDuringScan).toBe(false);
		expect(result.metadata.scanTruncated).toBe(false);
		expect(result.records[0].recordEndOffset).toBe(Buffer.byteLength(original));
	});

	it("reports truncation during a fixed snapshot as an incomplete scan", async () => {
		const original = [line(event(0)), line(event(1)), line(event(2))].join("\n");
		const path = await transcript(original);
		const result = await readClaudeTranscriptTail(path, {
			onSnapshot: async ({ snapshotBytes }) => truncate(path, Math.floor(snapshotBytes / 2)),
		});

		expect(result.lines).toEqual([]);
		expect(result.metadata.fileChangedDuringScan).toBe(true);
		expect(result.metadata.fileShrank).toBe(true);
		expect(result.metadata.shrankByBytes).toBeGreaterThan(0);
		expect(result.metadata.scanTruncated).toBe(true);
		expect(result.metadata.truncationReason).toBe("file_changed");
	});
});
