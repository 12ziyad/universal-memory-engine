/**
 * The hook stdin/stdout contract, against the official schema
 * (antigravity.google/docs/hooks, fixture pinned in test/fixtures/docs/hooks.md).
 *
 * The load-bearing assertion in this file is the boring one: with no verified
 * transcript schema and no verified success terminationReason, NOTHING is ever
 * captured. That is the shipped state, and it must not silently change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handlePreInvocation, handleStop, parsePayload, runHook, VERIFIED_SUCCESS_TERMINATIONS } from "../src/hook.js";
import { Spool } from "../src/spool.js";

const LEAD = "LEAD" + String.fromCharCode(10);

let home: string;
let env: NodeJS.ProcessEnv;
let transcriptPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "itsuki-hk-"));
	const logs = join(home, ".gemini", "antigravity-cli", "brain", "c1", ".system_generated", "logs");
	mkdirSync(logs, { recursive: true });
	transcriptPath = join(logs, "transcript.jsonl");
	writeFileSync(transcriptPath, `lead\n${JSON.stringify({ role: "user", content: "hello" })}\n${JSON.stringify({ role: "assistant", content: "hi" })}\n`);
	env = {
		HOME: home,
		USERPROFILE: home,
		ITSUKI_STATE_DIR: join(home, "state"),
		ITSUKI_API_KEY: "itsuki_live_testkey123456",
	} as NodeJS.ProcessEnv;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const stopPayload = (over: Record<string, unknown> = {}) => ({
	conversationId: "c1",
	transcriptPath,
	fullyIdle: true,
	terminationReason: "model_stop",
	executionNum: 0,
	...over,
});

describe("the official hooks.md contract", () => {
	it("pins the documented event names and fields from the fixture", () => {
		const docs = readFileSync(join(__dirname, "fixtures", "docs", "hooks.md"), "utf8");
		for (const event of ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]) {
			expect(docs).toContain(event);
		}
		for (const field of ["conversationId", "transcriptPath", "fullyIdle", "injectSteps", "ephemeralMessage", "terminationReason"]) {
			expect(docs).toContain(field);
		}
	});
});

describe("Stop always answers, and never blocks the loop", () => {
	it('responds {"decision":"stop"} on the happy path shape', async () => {
		const result = await handleStop(stopPayload(), env);
		expect(result.response).toEqual({ decision: "stop" });
	});

	it('responds {"decision":"stop"} even when everything is wrong', async () => {
		for (const payload of [{}, stopPayload({ conversationId: "" }), stopPayload({ transcriptPath: "/etc/passwd" })]) {
			const result = await handleStop(payload as never, env);
			expect(result.response).toEqual({ decision: "stop" });
		}
	});

	it('NEVER responds "continue"', async () => {
		const results = await Promise.all([
			handleStop(stopPayload(), env),
			handleStop(stopPayload({ fullyIdle: false }), env),
			handleStop({} as never, env),
		]);
		for (const result of results) expect(JSON.stringify(result.response)).not.toContain("continue");
	});

	it("answers with valid JSON through runHook even for a garbage payload", async () => {
		const { stdout } = await runHook("Stop", "not json at all", env);
		expect(JSON.parse(stdout)).toEqual({ decision: "stop" });
	});
});

describe("capture gating — everything below is a refusal", () => {
	const spoolDepth = () => new Spool(env["ITSUKI_STATE_DIR"] as string).stats().depth;

	it("refuses when fullyIdle is false — background work is still running", async () => {
		const result = await handleStop(stopPayload({ fullyIdle: false }), env);
		expect(result.note).toContain("not fullyIdle");
		expect(spoolDepth()).toBe(0);
	});

	it("refuses when fullyIdle is absent entirely", async () => {
		const result = await handleStop(stopPayload({ fullyIdle: undefined }), env);
		expect(result.note).toContain("not fullyIdle");
		expect(spoolDepth()).toBe(0);
	});

	it("refuses when the payload carries an error", async () => {
		const result = await handleStop(stopPayload({ error: "model failed" }), env);
		expect(result.note).toContain("error");
		expect(spoolDepth()).toBe(0);
	});

	it.each(["max_steps_exceeded", "error", "cancelled", "aborted", "", "something_new_google_added"])(
		"refuses terminationReason %p as unverified",
		async (reason) => {
			const result = await handleStop(stopPayload({ terminationReason: reason }), env);
			expect(result.note).toContain("not a verified success reason");
			expect(spoolDepth()).toBe(0);
		},
	);

	it("CAPTURES a real settled turn: verified reason + fullyIdle + a real transcript", async () => {
		// Enabled only after a real host supplied both halves: the transcript
		// schema and the actual success terminationReason (NO_TOOL_CALL — the
		// docs' own model_stop example never appears).
		expect(VERIFIED_SUCCESS_TERMINATIONS).toEqual(["NO_TOOL_CALL"]);
		const fixture = readFileSync(
			join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"),
			"utf8",
		);
		writeFileSync(transcriptPath, LEAD + fixture);
		const result = await handleStop(stopPayload({ terminationReason: "NO_TOOL_CALL" }), env);
		expect(result.response).toEqual({ decision: "stop" });
		expect(result.note).toContain("staged");
		expect(spoolDepth()).toBe(1);
	});

	it("captures the human turn and model answer, and NOTHING system-generated", async () => {
		const fixture = readFileSync(
			join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"),
			"utf8",
		);
		writeFileSync(transcriptPath, LEAD + fixture);
		await handleStop(stopPayload({ terminationReason: "NO_TOOL_CALL" }), env);
		const staged = JSON.stringify(new Spool(env["ITSUKI_STATE_DIR"] as string).list()[0]!.envelope);
		expect(staged).toContain("REDACTED_USER_TEXT");
		expect(staged).toContain("REDACTED_MODEL_TEXT");
		// SYSTEM/CHECKPOINT carries content and must never be uploaded.
		expect(staged).not.toContain("REDACTED_SYSTEM_TEXT");
	});

	it("is exactly-once across repeated Stop for the same turn", async () => {
		const fixture = readFileSync(
			join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"),
			"utf8",
		);
		writeFileSync(transcriptPath, LEAD + fixture);
		for (let i = 0; i < 4; i += 1) await handleStop(stopPayload({ terminationReason: "NO_TOOL_CALL", executionNum: i }), env);
		expect(spoolDepth()).toBe(1);
	});

	it("still refuses when fullyIdle is false even with a verified reason", async () => {
		const fixture = readFileSync(
			join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"),
			"utf8",
		);
		writeFileSync(transcriptPath, LEAD + fixture);
		const result = await handleStop(stopPayload({ terminationReason: "NO_TOOL_CALL", fullyIdle: false }), env);
		expect(result.note).toContain("not fullyIdle");
		expect(spoolDepth()).toBe(0);
	});

	it("treats an EMPTY error string as no error (the real host always sends one)", async () => {
		const fixture = readFileSync(
			join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"),
			"utf8",
		);
		writeFileSync(transcriptPath, LEAD + fixture);
		const result = await handleStop(stopPayload({ terminationReason: "NO_TOOL_CALL", error: "" }), env);
		expect(result.note).toContain("staged");
		expect(spoolDepth()).toBe(1);
	});

	it("refuses a transcript outside the documented root", async () => {
		const outside = join(home, "evil.jsonl");
		writeFileSync(outside, "{}\n");
		const result = await handleStop(stopPayload({ transcriptPath: outside }), env);
		expect(spoolDepth()).toBe(0);
		expect(result.response).toEqual({ decision: "stop" });
	});
});

describe("PreInvocation", () => {
	it("returns {} when the transcript schema is unverified", async () => {
		const result = await handlePreInvocation({ conversationId: "c1", transcriptPath }, env);
		expect(result.response).toEqual({});
		expect(result.note).toContain("transcript");
	});

	it("returns {} rather than throwing on a missing conversationId", async () => {
		const result = await handlePreInvocation({ transcriptPath }, env);
		expect(result.response).toEqual({});
	});

	it("returns {} when unconfigured", async () => {
		const result = await handlePreInvocation({ conversationId: "c1", transcriptPath }, {
			HOME: home,
			USERPROFILE: home,
			ITSUKI_STATE_DIR: join(home, "state"),
		} as NodeJS.ProcessEnv);
		expect(result.response).toEqual({});
	});

	it("emits valid JSON through runHook", async () => {
		const { stdout } = await runHook("PreInvocation", JSON.stringify({ conversationId: "c1", transcriptPath }), env);
		expect(JSON.parse(stdout)).toEqual({});
	});
});

describe("payload parsing is defensive", () => {
	it.each(["", "null", "[]", '"str"', "{", "undefined"])("treats %p as an empty payload", (raw) => {
		expect(parsePayload(raw)).toEqual({});
	});

	it("accepts a well-formed payload", () => {
		expect(parsePayload('{"conversationId":"c1","fullyIdle":true}')).toEqual({
			conversationId: "c1",
			fullyIdle: true,
		});
	});
});

describe("unknown events", () => {
	it("answers safely for an event we do not implement", async () => {
		const { stdout } = await runHook("PostToolUse", "{}", env);
		expect(JSON.parse(stdout)).toEqual({});
	});
});
