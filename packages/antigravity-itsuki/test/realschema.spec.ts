/**
 * The transcript schema and Stop contract, verified against a real host
 * (Antigravity CLI 1.1.13, Windows, 2026-08-16) and pinned to a redacted
 * fixture captured from that host.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VERIFIED_SUCCESS_TERMINATIONS } from "../src/hook.js";
import { classify, extractUserRequest, parseEntries, VERIFIED_SCHEMAS } from "../src/transcript.js";

const fixture = readFileSync(join(__dirname, "fixtures", "transcripts", "cli-1.1.13-windows.jsonl"), "utf8");
// parseEntries drops the first line (a tail read starts mid-line), so a whole
// file is fed with a sacrificial lead line, exactly as a real tail behaves.
const entries = parseEntries("LEAD\n" + fixture);

describe("real transcript schema", () => {
	it("registers exactly the schema captured from a real host", () => {
		expect(VERIFIED_SCHEMAS.map((s) => s.id)).toEqual(["antigravity-cli/step_index-v1"]);
		expect(VERIFIED_SCHEMAS[0]!.hosts).toContain("antigravity-cli 1.1.13");
	});

	it("recognises the real fixture", () => {
		const result = classify(entries);
		expect(result.status).toBe("ok");
	});

	it("extracts the human turn and the model answer, and nothing else", () => {
		const result = classify(entries);
		if (result.status !== "ok") throw new Error("expected a match");
		expect(result.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
		expect(result.turns[0]!.text).toContain("REDACTED_USER_TEXT");
		expect(result.turns[1]!.text).toContain("REDACTED_MODEL_TEXT");
	});

	it("EXCLUDES SYSTEM/CHECKPOINT, which carries content but is host state", () => {
		const result = classify(entries);
		if (result.status !== "ok") throw new Error("expected a match");
		const all = JSON.stringify(result.turns);
		expect(all).not.toContain("REDACTED_SYSTEM_TEXT");
	});

	it("EXCLUDES SYSTEM/CONVERSATION_HISTORY", () => {
		const result = classify(entries);
		if (result.status !== "ok") throw new Error("expected a match");
		expect(result.turns).toHaveLength(2);
	});

	it("gives every turn a stable anchor and a parsed timestamp", () => {
		const result = classify(entries);
		if (result.status !== "ok") throw new Error("expected a match");
		for (const turn of result.turns) {
			expect(typeof turn.id).toBe("string");
			expect(turn.id!.length).toBeGreaterThan(0);
			expect(typeof turn.createdAt).toBe("number");
		}
		// Anchors must be distinct, or dedup would collapse real turns.
		expect(new Set(result.turns.map((t) => t.id)).size).toBe(result.turns.length);
	});

	it("still refuses a shape it has not seen", () => {
		expect(classify([{ role: "user", content: "hi" }]).status).toBe("unverified");
		expect(classify([{ step_index: 0, source: "MODEL" }]).status).toBe("unverified");
	});

	it("refuses entries missing the structural fields, even if some match", () => {
		const partial = [
			{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "x", content: "a" },
			{ source: "MODEL" },
		];
		expect(classify(partial).status).toBe("unverified");
	});
});

describe("real Stop contract", () => {
	it("allowlists exactly the observed success reason", () => {
		// The docs' own example is `model_stop`; the host never sends it.
		expect(VERIFIED_SUCCESS_TERMINATIONS).toEqual(["NO_TOOL_CALL"]);
		expect(VERIFIED_SUCCESS_TERMINATIONS).not.toContain("model_stop");
	});
});

describe("AG-01 — a complete first line must not be discarded", () => {
	it("keeps the first entry when the whole file fits in the tail buffer", () => {
		// A short conversation's first line IS the user's turn. Dropping it
		// unconditionally made every small real transcript unclassifiable.
		const whole = parseEntries(fixture);
		expect(whole.length).toBe(4);
		expect(whole[0]!["source"]).toBe("USER_EXPLICIT");
		expect(classify(whole).status).toBe("ok");
	});

	it("still drops a genuine mid-line fragment from a truncated tail", () => {
		const truncated = 'index":7,"source":"MODEL"}\n' + fixture;
		const parsed = parseEntries(truncated);
		expect(parsed.length).toBe(4);
		expect(parsed[0]!["source"]).toBe("USER_EXPLICIT");
	});
})

describe("AG-02 — only the human's words leave the machine", () => {
	const scaffold = [
		"<USER_REQUEST>",
		"deploy from main",
		"</USER_REQUEST>",
		"<ADDITIONAL_METADATA>",
		"cwd=/secret/path model=internal-x",
		"</ADDITIONAL_METADATA>",
		"<USER_SETTINGS_CHANGE>",
		"apiKeyRef=abc telemetry=on homeDir=/Users/someone",
		"</USER_SETTINGS_CHANGE>",
	].join("\n");

	it("takes the USER_REQUEST body and nothing else", () => {
		expect(extractUserRequest(scaffold)).toBe("deploy from main");
	});

	it("never leaks metadata or settings into a captured turn", () => {
		const entries = [
			{ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-16T01:00:00Z", content: scaffold },
			{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-16T01:00:01Z", content: "ok" },
		];
		const result = classify(entries);
		if (result.status !== "ok") throw new Error("expected a match");
		const all = JSON.stringify(result.turns);
		expect(all).toContain("deploy from main");
		for (const secret of ["ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE", "/secret/path", "apiKeyRef", "telemetry", "homeDir", "internal-x"]) {
			expect(all).not.toContain(secret);
		}
	});

	it("fails closed on scaffolding it does not recognise", () => {
		expect(extractUserRequest("<SOME_NEW_WRAPPER>hi</SOME_NEW_WRAPPER>")).toBeNull();
	});

	it("passes through an unwrapped message unchanged", () => {
		expect(extractUserRequest("just a plain message")).toBe("just a plain message");
	});
})

describe("AUD-01(ag) — repeated Stop across a growing conversation", () => {
	const entry = (i: number, source: string, type: string, content: string, t: string) =>
		JSON.stringify({ step_index: i, source, type, status: "DONE", created_at: t, content });
	const ex1 = [
		entry(0, "USER_EXPLICIT", "USER_INPUT", "<USER_REQUEST>EXCHANGE_ONE_Q</USER_REQUEST>", "2026-08-16T01:00:00Z"),
		entry(1, "MODEL", "PLANNER_RESPONSE", "EXCHANGE_ONE_A", "2026-08-16T01:00:01Z"),
	].join("\n");
	const ex2 = [
		entry(2, "USER_EXPLICIT", "USER_INPUT", "<USER_REQUEST>EXCHANGE_TWO_Q</USER_REQUEST>", "2026-08-16T01:05:00Z"),
		entry(3, "MODEL", "PLANNER_RESPONSE", "EXCHANGE_TWO_A", "2026-08-16T01:05:01Z"),
	].join("\n");

	it("the second Stop stages ONLY the new exchange", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { handleStop } = await import("../src/hook.js");
		const { Spool } = await import("../src/spool.js");
		const home = mkdtempSync(join(tmpdir(), "itsuki-grow-"));
		try {
			const logs = join(home, ".gemini", "antigravity-cli", "brain", "cg", ".system_generated", "logs");
			mkdirSync(logs, { recursive: true });
			const tp = join(logs, "transcript.jsonl");
			const env = { HOME: home, USERPROFILE: home, ITSUKI_STATE_DIR: join(home, "st"), ITSUKI_API_KEY: "itsuki_live_testkey123456" } as NodeJS.ProcessEnv;
			const stop = (over: Record<string, unknown> = {}) =>
				handleStop({ conversationId: "cg", transcriptPath: tp, fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "", ...over } as never, env);

			writeFileSync(tp, ex1 + "\n");
			await stop();
			writeFileSync(tp, ex1 + "\n" + ex2 + "\n");
			await stop({ executionNum: 1 });

			const envelopes = new Spool(join(home, "st")).list();
			expect(envelopes).toHaveLength(2);
			const second = envelopes.map((e) => JSON.stringify(e.envelope.messages)).find((t) => t.includes("EXCHANGE_TWO_Q"));
			expect(second).toBeTruthy();
			expect(second).not.toContain("EXCHANGE_ONE_Q");
			expect(second).not.toContain("EXCHANGE_ONE_A");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("M2 — a model echoing a recalled line must not re-save it", () => {
	it("suppresses the echoed line but keeps the rest of the answer", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { handleStop } = await import("../src/hook.js");
		const { SessionStore } = await import("../src/sessionstate.js");
		const { Spool } = await import("../src/spool.js");
		const { echoFingerprints, echoSessionKey } = await import("../src/kernel/inject.js");

		const home = mkdtempSync(join(tmpdir(), "itsuki-echo-"));
		try {
			const logs = join(home, ".gemini", "antigravity-cli", "brain", "ce", ".system_generated", "logs");
			mkdirSync(logs, { recursive: true });
			const tp = join(logs, "transcript.jsonl");
			const state = join(home, "st");
			const env = { HOME: home, USERPROFILE: home, ITSUKI_STATE_DIR: state, ITSUKI_API_KEY: "itsuki_live_testkey123456" } as NodeJS.ProcessEnv;

			const recalled = "ECHOED_MEMORY_LINE: the deploy branch is main.";
			const fresh = "GENUINELY_NEW_FACT: the fallback branch is release.";
			const e = (i: number, s: string, t: string, c: string, ts: string) =>
				JSON.stringify({ step_index: i, source: s, type: t, status: "DONE", created_at: ts, content: c });
			writeFileSync(tp, [
				e(0, "USER_EXPLICIT", "USER_INPUT", "<USER_REQUEST>what do you know</USER_REQUEST>", "2026-08-16T01:00:00Z"),
				e(1, "MODEL", "PLANNER_RESPONSE", recalled + "\n" + fresh, "2026-08-16T01:00:01Z"),
			].join("\n") + "\n");

			// Persist the fingerprints exactly as PreInvocation would have.
			const store = new SessionStore(state);
			const s0 = store.load("ce");
			const key = echoSessionKey("ce")!;
			s0.echoFingerprints = [...echoFingerprints(recalled, key)];
			store.save(s0);

			await handleStop({ conversationId: "ce", transcriptPath: tp, fullyIdle: true, terminationReason: "NO_TOOL_CALL", error: "" } as never, env);

			const staged = JSON.stringify(new Spool(state).list()[0]?.envelope ?? {});
			expect(staged).toContain("GENUINELY_NEW_FACT");
			// Re-saving our own recalled line would compound memory on every turn.
			expect(staged).not.toContain("ECHOED_MEMORY_LINE");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
