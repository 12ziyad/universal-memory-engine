/**
 * The settled-turn contract, pinned to what Phase 0 actually measured
 * (run 31911313462). Every fixture shape here was observed, not invented.
 */

import { describe, expect, it } from "vitest";

import {
	assistantText,
	isInternalAgent,
	isSyntheticUserTurn,
	planCaptureSpan,
	settleVerdict,
	userText,
	type HostMessage,
} from "../src/messages.js";

const user = (id: string, text: string, created = 1000): HostMessage => ({
	info: { id, role: "user", sessionID: "ses_1", time: { created } },
	parts: [{ id: `prt_${id}`, type: "text", text }],
});

const assistant = (
	id: string,
	text: string,
	over: Partial<{ finish: string; error: unknown; created: number; unfinished: boolean }> = {},
): HostMessage => ({
	info: {
		id,
		role: "assistant",
		sessionID: "ses_1",
		finish: over.finish === undefined ? "stop" : over.finish,
		...(over.error !== undefined ? { error: over.error } : {}),
		time: { created: over.created ?? 1001, ...(over.unfinished ? {} : { completed: 1002 }) },
	},
	parts: [{ id: `prt_${id}`, type: "text", text }],
});

describe("settleVerdict — the success allowlist", () => {
	it("accepts the exact success shape Phase 0 observed", () => {
		const verdict = settleVerdict([user("m1", "hi"), assistant("m2", "hello")]);
		expect(verdict.ok).toBe(true);
	});

	it("REFUSES an errored turn even though it also carries time.completed", () => {
		// This is the whole reason the allowlist exists. Phase 0 turn 2 ended
		// with completed set AND an APIError: judging on `completed` alone
		// would have captured a failure as a success.
		const verdict = settleVerdict([
			user("m1", "hi"),
			assistant("m2", "", { finish: undefined, error: { name: "APIError" } }),
		]);
		expect(verdict).toEqual({ ok: false, reason: "errored" });
	});

	it.each([
		["tool-calls", "bad_finish"],
		["length", "bad_finish"],
		["content-filter", "bad_finish"],
		["aborted", "bad_finish"],
		["", "bad_finish"],
	])("refuses finish=%s", (finish, reason) => {
		const verdict = settleVerdict([user("m1", "hi"), assistant("m2", "x", { finish })]);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toBe(reason);
	});

	it("refuses an unfinished turn (no time.completed)", () => {
		const verdict = settleVerdict([user("m1", "hi"), assistant("m2", "x", { unfinished: true })]);
		expect(verdict).toEqual({ ok: false, reason: "not_finished" });
	});

	it("refuses when a tool part is still running", () => {
		const msg = assistant("m2", "x");
		msg.parts!.push({ id: "prt_t", type: "tool", state: { status: "running" } });
		const verdict = settleVerdict([user("m1", "hi"), msg]);
		expect(verdict).toEqual({ ok: false, reason: "tool_incomplete" });
	});

	it("refuses a turn with no assistant message at all", () => {
		expect(settleVerdict([user("m1", "hi")])).toEqual({ ok: false, reason: "no_assistant" });
	});

	it("refuses an assistant message with no text (tool-only turn)", () => {
		const msg = assistant("m2", "");
		msg.parts = [{ id: "p", type: "tool", state: { status: "completed" } }];
		expect(settleVerdict([user("m1", "hi"), msg])).toEqual({ ok: false, reason: "empty" });
	});
});

describe("text extraction excludes machinery and our own echo", () => {
	it("drops synthetic parts (our injection) from user text", () => {
		const msg: HostMessage = {
			info: { id: "m1", role: "user" },
			parts: [
				{ id: "a", type: "text", text: "real question" },
				{ id: "b", type: "text", text: "<itsuki-recalled-context-v1>secret</itsuki-recalled-context-v1>", synthetic: true },
			],
		};
		expect(userText(msg)).toBe("real question");
	});

	it("strips a recall block even if the synthetic flag is missing", () => {
		const msg: HostMessage = {
			info: { id: "m1", role: "user" },
			parts: [
				{ id: "a", type: "text", text: "keep me" },
				{ id: "b", type: "text", text: "<itsuki-recalled-context-v1>\nleak\n</itsuki-recalled-context-v1>" },
			],
		};
		expect(userText(msg)).not.toContain("leak");
		expect(userText(msg)).toContain("keep me");
	});

	it("excludes reasoning, tool and step parts from assistant text", () => {
		const msg: HostMessage = {
			info: { id: "m2", role: "assistant" },
			parts: [
				{ id: "a", type: "reasoning", text: "internal thinking" },
				{ id: "b", type: "tool", text: "tool payload" },
				{ id: "c", type: "step-start", text: "step" },
				{ id: "d", type: "text", text: "the answer" },
			],
		};
		expect(assistantText(msg)).toBe("the answer");
	});

	it("drops ignored parts", () => {
		const msg: HostMessage = {
			info: { id: "m1", role: "user" },
			parts: [{ id: "a", type: "text", text: "hidden", ignored: true }],
		};
		expect(userText(msg)).toBe("");
	});
});

describe("planCaptureSpan", () => {
	const owned = () => true;

	it("pairs the user turn with the assistant answer", () => {
		const span = planCaptureSpan([user("m1", "q"), assistant("m2", "a")], owned);
		expect(span.messages).toEqual([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
		]);
		expect(span.assistantMessageID).toBe("m2");
	});

	it("returns nothing when the span has no assistant answer", () => {
		expect(planCaptureSpan([user("m1", "q")], owned).messages).toEqual([]);
	});

	it("returns nothing when the span has no user turn", () => {
		expect(planCaptureSpan([assistant("m2", "a")], owned).messages).toEqual([]);
	});

	it("excludes messages the ownership gate rejects (inherited history)", () => {
		const span = planCaptureSpan(
			[user("old", "ancient"), user("m1", "q"), assistant("m2", "a")],
			(info) => info.id !== "old",
		);
		expect(span.messages.map((m) => m.content)).toEqual(["q", "a"]);
	});

	it("never includes an errored assistant message's text", () => {
		const span = planCaptureSpan(
			[user("m1", "q"), assistant("m2", "good"), assistant("m3", "bad", { error: { name: "E" } })],
			owned,
		);
		expect(span.messages.map((m) => m.content)).toEqual(["q", "good"]);
	});
});

describe("non-conversational turns", () => {
	it("names the host's internal agents", () => {
		expect(isInternalAgent("title")).toBe(true);
		expect(isInternalAgent("summary")).toBe(true);
		expect(isInternalAgent("compaction")).toBe(true);
		expect(isInternalAgent("build")).toBe(false);
		expect(isInternalAgent(undefined)).toBe(false);
	});

	it("detects the compaction auto-continue turn (all parts synthetic)", () => {
		expect(isSyntheticUserTurn([{ id: "a", type: "text", text: "continue", synthetic: true }])).toBe(true);
		expect(
			isSyntheticUserTurn([
				{ id: "a", type: "text", text: "real", synthetic: false },
				{ id: "b", type: "text", text: "ours", synthetic: true },
			]),
		).toBe(false);
		expect(isSyntheticUserTurn([])).toBe(false);
		expect(isSyntheticUserTurn(undefined)).toBe(false);
	});
});
