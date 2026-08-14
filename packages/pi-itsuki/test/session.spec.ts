/**
 * Reading pi's session tree correctly is what makes capture exactly-once
 * across `/resume`, `/fork` and compaction. These tests use the entry shapes
 * documented in pi's session-format.md.
 */

import { describe, expect, it } from "vitest";

import {
	CAPTURE_STATE_SCHEMA,
	CAPTURE_STATE_TYPE,
	collectCaptureSpan,
	readCaptureState,
} from "../src/session.js";

const identity = (text: string) => text;

function message(id: string, role: string, content: unknown) {
	return { type: "message", id, parentId: null, timestamp: "", message: { role, content } };
}

function watermark(id: string, watermarkEntryId: string, key = "pi:v1:x") {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "",
		customType: CAPTURE_STATE_TYPE,
		data: {
			schema: CAPTURE_STATE_SCHEMA,
			watermarkEntryId,
			idempotencyKey: key,
			state: "spooled",
			at: "",
		},
	};
}

describe("what gets captured", () => {
	it("takes user and assistant text, in order", () => {
		const branch = [
			message("a1", "user", "first"),
			message("a2", "assistant", [{ type: "text", text: "second" }]),
		];
		const span = collectCaptureSpan(branch, null, identity);
		expect(span.messages).toEqual([
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
		]);
		expect(span.watermarkEntryId).toBe("a2");
	});

	it("never captures thinking, tool calls, tool results, or other extensions' messages", () => {
		const branch = [
			message("a1", "user", "keep me"),
			message("a2", "assistant", [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
				{ type: "text", text: "visible answer" },
			]),
			message("a3", "toolResult", [{ type: "text", text: "command output" }]),
			{ type: "message", id: "a4", message: { role: "custom", customType: "other-ext", content: "not ours" } },
			{ type: "custom", id: "a5", customType: "some-other-state", data: { x: 1 } },
		];
		const span = collectCaptureSpan(branch, null, identity);
		expect(span.messages).toEqual([
			{ role: "user", content: "keep me" },
			{ role: "assistant", content: "visible answer" },
		]);
		const serialized = JSON.stringify(span.messages);
		expect(serialized).not.toContain("private reasoning");
		expect(serialized).not.toContain("command output");
		expect(serialized).not.toContain("not ours");
	});

	it("strips our own injected recall block out of assistant text", () => {
		const branch = [
			message("a1", "assistant", [{
				type: "text",
				text: "before\n<itsuki-recalled-context-v1>\nrecalled fact\n</itsuki-recalled-context-v1>\nafter",
			}]),
		];
		const span = collectCaptureSpan(branch, null, identity);
		expect(span.messages[0]!.content).toBe("before\nafter");
		expect(span.messages[0]!.content).not.toContain("recalled fact");
	});
});

describe("the watermark", () => {
	it("captures only what came after it", () => {
		const branch = [
			message("a1", "user", "already captured"),
			watermark("w1", "a1"),
			message("a2", "user", "new turn"),
		];
		const span = collectCaptureSpan(branch, "a1", identity);
		expect(span.messages).toEqual([{ role: "user", content: "new turn" }]);
		expect(span.watermarkEntryId).toBe("a2");
	});

	it("returns nothing new when the watermark is already at the tip", () => {
		const branch = [message("a1", "user", "done"), watermark("w1", "a1")];
		const span = collectCaptureSpan(branch, "a1", identity);
		expect(span.messages).toEqual([]);
		expect(span.watermarkEntryId).toBeNull();
	});

	it("advances past a span that scrubs down to nothing, so it is not rescanned forever", () => {
		const branch = [message("a1", "user", "   ")];
		const span = collectCaptureSpan(branch, null, identity);
		expect(span.messages).toEqual([]);
		// Ownership still moves: the entry was examined and is now behind us.
		expect(span.watermarkEntryId).toBe("a1");
	});

	it("reads the latest watermark when several exist", () => {
		const state = readCaptureState([
			watermark("w1", "a1", "pi:v1:first"),
			watermark("w2", "a3", "pi:v1:second"),
		]);
		expect(state?.watermarkEntryId).toBe("a3");
		expect(state?.idempotencyKey).toBe("pi:v1:second");
	});

	it("ignores a malformed watermark rather than trusting it", () => {
		expect(readCaptureState([{ type: "custom", id: "w", customType: CAPTURE_STATE_TYPE, data: { nonsense: true } }]))
			.toBeNull();
		expect(readCaptureState([])).toBeNull();
	});
});

describe("fork and resume", () => {
	it("a forked branch inherits its prefix watermark, so the prefix is not recaptured", () => {
		// /fork copies the branch up to the fork point, watermark entries included.
		const forked = [
			message("a1", "user", "shared prefix"),
			watermark("w1", "a1"),
			message("b1", "user", "only on this branch"),
		];
		const prior = readCaptureState(forked);
		const span = collectCaptureSpan(forked, prior!.watermarkEntryId, identity);
		expect(span.messages).toEqual([{ role: "user", content: "only on this branch" }]);
	});

	it("a resumed session picks up exactly where it stopped", () => {
		const branch = [
			message("a1", "user", "before restart"),
			watermark("w1", "a1"),
			message("a2", "assistant", [{ type: "text", text: "after restart" }]),
		];
		const prior = readCaptureState(branch);
		const span = collectCaptureSpan(branch, prior!.watermarkEntryId, identity);
		expect(span.messages).toEqual([{ role: "assistant", content: "after restart" }]);
	});
});

describe("the transform hook", () => {
	it("applies the caller's scrub/echo transform and drops what it empties", () => {
		const branch = [
			message("a1", "user", "secret"),
			message("a2", "user", "kept"),
		];
		const span = collectCaptureSpan(branch, null, (text) => (text === "secret" ? "" : text));
		expect(span.messages).toEqual([{ role: "user", content: "kept" }]);
		expect(span.watermarkEntryId).toBe("a2");
	});
});
