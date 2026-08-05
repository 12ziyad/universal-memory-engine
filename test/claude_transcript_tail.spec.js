import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeTranscriptTail } from "../hooks/claude-transcript-tail.mjs";
import { messagesFromClaudeTranscriptLines } from "../hooks/claude-transcript.mjs";

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
		message: { content: `message ${index}` },
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
		const durable = line(event(1, { message: { content: "keep the durable answer" } }));
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
		const first = line(event(0, { message: { content: "café 雪" } }));
		const second = line(event(1, { message: { content: [{ type: "text", text: "emoji 🧠" }] } }));
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
		expect(parsed.map((message) => message.content)).toEqual(["café 雪", "emoji 🧠"]);
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

	it("skips malformed, unknown, and non-textual rows with visible counters", async () => {
		const first = line(event(0));
		const final = line(event(2, {
			message: { content: [{ type: "tool_use", name: "read" }, { type: "text", text: "final text" }] },
		}));
		const rows = [
			first,
			"{not json",
			line({ type: "progress", message: { content: "ignore" } }),
			line({ type: "assistant", message: { content: [{ type: "tool_use", name: "read" }] } }),
			final,
		];
		const path = await transcript(rows.join("\n"));

		const result = await readClaudeTranscriptTail(path, { readChunkBytes: 11 });

		expect(result.lines).toEqual([first, final]);
		expect(result.metadata.malformedLines).toBe(1);
		expect(result.metadata.ineligibleLines).toBe(2);
		expect(result.metadata.scanTruncated).toBe(false);
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
			message: { content: `fallback byte-offset event ${index}` },
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
		const firstIds = new Map(messagesAt100.map((message) => [message.content, message.id]));
		const movedIds = new Map(messagesAt120.map((message) => [message.content, message.id]));
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
			const content = `fallback byte-offset event ${index}`;
			expect(movedOffsets.get(content)).toBe(firstOffsets.get(content));
			expect(movedIds.get(content)).toBe(firstIds.get(content));
			expect(movedIds.get(content)).toMatch(/^claude_msg_v1_f_[a-f0-9]{32}$/);
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
