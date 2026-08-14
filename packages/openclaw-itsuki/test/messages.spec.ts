/**
 * Reading OpenClaw's `messages: unknown[]` correctly is what makes capture
 * exactly-once. The hook contract gives no shape guarantee, so every extractor
 * here is attacked with shapes a real host (or a hostile channel) might send.
 */

import { describe, expect, it } from "vitest";

import { isSettledExchange, normalizeMessages, planCaptureSpan, textFromContent } from "../src/messages.js";

const identity = (text: string) => text;
const NO_WATERMARK = { count: 0, digest: "" };

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });

describe("extraction", () => {
	it("takes plain string content", () => {
		expect(textFromContent("hello")).toBe("hello");
	});

	it("takes text parts and ignores machinery", () => {
		expect(textFromContent([
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "tool_use", name: "bash", input: { cmd: "ls" } },
			{ type: "text", text: "visible answer" },
			{ type: "tool_result", content: "command output" },
		])).toBe("visible answer");
	});

	it("survives shapes it has never seen", () => {
		expect(textFromContent(null)).toBe("");
		expect(textFromContent(undefined)).toBe("");
		expect(textFromContent(42)).toBe("");
		expect(textFromContent({})).toBe("");
		expect(textFromContent([null, undefined, 7, {}])).toBe("");
	});

	it("captures only user and assistant roles", () => {
		const messages = normalizeMessages([
			user("keep me"),
			assistant([{ type: "text", text: "and me" }]),
			{ role: "system", content: "not me" },
			{ role: "tool", content: "nor me" },
			{ role: "toolResult", content: "nor me either" },
			{ content: "no role at all" },
			"a bare string",
			null,
		]);
		expect(messages).toEqual([
			{ role: "user", content: "keep me" },
			{ role: "assistant", content: "and me" },
		]);
	});

	it("drops messages that are only whitespace", () => {
		expect(normalizeMessages([user("   "), user("real")])).toEqual([{ role: "user", content: "real" }]);
	});
});

describe("span planning", () => {
	it("captures everything when there is no watermark", () => {
		const span = planCaptureSpan([user("one"), assistant("two")], NO_WATERMARK, identity);
		expect(span.messages).toEqual([
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
		]);
		expect(span.watermarkCount).toBe(2);
		expect(span.historyRewritten).toBe(false);
	});

	it("captures only what came after the watermark", () => {
		const first = planCaptureSpan([user("one"), assistant("two")], NO_WATERMARK, identity);
		const span = planCaptureSpan(
			[user("one"), assistant("two"), user("three"), assistant("four")],
			{ count: first.watermarkCount, digest: first.watermarkDigest },
			identity,
		);
		expect(span.messages).toEqual([
			{ role: "user", content: "three" },
			{ role: "assistant", content: "four" },
		]);
	});

	it("returns nothing new when the watermark is at the tip", () => {
		const first = planCaptureSpan([user("one"), assistant("two")], NO_WATERMARK, identity);
		const span = planCaptureSpan(
			[user("one"), assistant("two")],
			{ count: first.watermarkCount, digest: first.watermarkDigest },
			identity,
		);
		expect(span.messages).toEqual([]);
	});

	it("advances past an all-noise span so it is not rescanned forever", () => {
		const span = planCaptureSpan([user("   "), { role: "system", content: "x" }], NO_WATERMARK, identity);
		expect(span.messages).toEqual([]);
		expect(span.watermarkCount).toBe(0);
		// Nothing capturable existed, so the digest is the empty-prefix digest
		// and the next turn re-examines from the same place — correct, because
		// no content was owned.
		expect(span.historyRewritten).toBe(false);
	});

	it("detects a rewritten history and captures only the final exchange", () => {
		// Compaction replaces the transcript with a summary plus recent turns.
		const before = planCaptureSpan(
			[user("old one"), assistant("old two"), user("old three"), assistant("old four")],
			NO_WATERMARK,
			identity,
		);
		const compacted = [
			user("summary of earlier conversation"),
			user("the newest question"),
			assistant("the newest answer"),
		];
		const span = planCaptureSpan(
			compacted,
			{ count: before.watermarkCount, digest: before.watermarkDigest },
			identity,
		);
		expect(span.historyRewritten).toBe(true);
		// Only the trailing exchange, not the whole rewritten transcript.
		expect(span.messages).toEqual([
			{ role: "user", content: "the newest question" },
			{ role: "assistant", content: "the newest answer" },
		]);
	});

	it("strips an injected recall block before capture", () => {
		const span = planCaptureSpan(
			[assistant("before\n<itsuki-recalled-context-v1>\nrecalled fact\n</itsuki-recalled-context-v1>\nafter")],
			NO_WATERMARK,
			identity,
		);
		expect(span.messages[0]!.content).toBe("before\nafter");
		expect(JSON.stringify(span.messages)).not.toContain("recalled fact");
	});

	it("applies the caller's transform and drops what it empties", () => {
		const span = planCaptureSpan(
			[user("secret"), user("kept")],
			NO_WATERMARK,
			(text) => (text === "secret" ? "" : text),
		);
		expect(span.messages).toEqual([{ role: "user", content: "kept" }]);
	});
});

describe("settled-exchange gate", () => {
	const span = planCaptureSpan([user("q"), assistant("a")], NO_WATERMARK, identity);

	it("accepts a successful run with content", () => {
		expect(isSettledExchange({ success: true }, span)).toBe(true);
	});

	it("REFUSES a failed run — a partial thought is not a memory", () => {
		expect(isSettledExchange({ success: false }, span)).toBe(false);
	});

	it("refuses a run that reported an error even when flagged successful", () => {
		expect(isSettledExchange({ success: true, error: "aborted by user" }, span)).toBe(false);
	});

	it("refuses a run with nothing capturable in it", () => {
		const empty = planCaptureSpan([{ role: "system", content: "tick" }], NO_WATERMARK, identity);
		expect(isSettledExchange({ success: true }, empty)).toBe(false);
	});

	it("refuses when success is missing entirely", () => {
		expect(isSettledExchange({}, span)).toBe(false);
	});
});
