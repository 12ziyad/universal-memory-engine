/**
 * The plugin driven end to end against a host double whose shapes come from
 * the Phase-0 capture (run 31911313462): the same hook names, the same event
 * payloads, the same message/part fields.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECALL_OPEN_MARKER } from "../src/kernel/inject.js";

let root: string;

/** A host double: only the surface the plugin actually touches. */
function makeHost(options: { messages?: any[]; parentID?: string | null } = {}) {
	const logs: any[] = [];
	return {
		logs,
		client: {
			app: { log: async (b: any) => void logs.push(b) },
			session: {
				get: async () => ({ data: { id: "ses_1", parentID: options.parentID ?? undefined } }),
				messages: async () => ({ data: options.messages ?? [] }),
			},
		},
		directory: "/proj",
		worktree: "/proj",
		serverUrl: new URL("http://localhost:4096/"),
	};
}

const userMessage = (id: string, text: string, created = 1000) => ({
	info: { id, role: "user", sessionID: "ses_1", time: { created } },
	parts: [{ id: `prt_${id}`, sessionID: "ses_1", messageID: id, type: "text", text }],
});

const assistantMessage = (id: string, text: string, over: any = {}) => ({
	info: {
		id,
		role: "assistant",
		sessionID: "ses_1",
		finish: over.finish === undefined ? "stop" : over.finish,
		...(over.error ? { error: over.error } : {}),
		time: { created: 1001, ...(over.unfinished ? {} : { completed: 1002 }) },
	},
	parts: [{ id: `prt_${id}`, sessionID: "ses_1", messageID: id, type: "text", text }],
});

async function loadPlugin(host: any, options: Record<string, unknown> = {}) {
	vi.resetModules();
	process.env["ITSUKI_STATE_DIR"] = root;
	process.env["ITSUKI_API_KEY"] = "itsuki_live_testkey123456";
	const mod = await import("../src/index.js");
	return { hooks: await mod.ItsukiPlugin(host, options), mod };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "itsuki-hooks-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env["ITSUKI_STATE_DIR"];
	delete process.env["ITSUKI_API_KEY"];
});

describe("plugin module shape", () => {
	it("default-exports exactly { id, server } and nothing else", async () => {
		vi.resetModules();
		const mod: any = await import("../src/index.js");
		expect(Object.keys(mod.default).sort()).toEqual(["id", "server"]);
		expect(mod.default.id).toBe("itsuki");
		expect(typeof mod.default.server).toBe("function");
		// A stray non-function named export silently disables a whole plugin
		// on this host (opencode#41234), so the surface stays minimal.
		const extra = Object.keys(mod).filter((k) => k !== "default" && k !== "ItsukiPlugin");
		expect(extra).toEqual([]);
	});

	it("registers only the hooks it intends to", async () => {
		const { hooks } = await loadPlugin(makeHost());
		expect(Object.keys(hooks).sort()).toEqual(
			["chat.message", "dispose", "event", "experimental.chat.messages.transform", "experimental.session.compacting", "tool"].sort(),
		);
	});

	it("exposes read/write tools and NO destructive or update tool", async () => {
		const { hooks } = await loadPlugin(makeHost());
		const names = Object.keys((hooks as any)["tool"]).sort();
		expect(names).toEqual(["itsuki_memories", "itsuki_memory", "itsuki_recall", "itsuki_save", "itsuki_status"]);
		for (const forbidden of ["delete", "forget", "update", "clear", "purge", "entities"]) {
			expect(names.join(" ")).not.toContain(forbidden);
		}
	});
});

describe("chat.message — the per-turn trigger", () => {
	it("seeds the watermark for a real human turn", async () => {
		const host = makeHost();
		const { hooks } = await loadPlugin(host);
		const output = { message: { id: "m1", sessionID: "ses_1", time: { created: 1000 } }, parts: [{ type: "text", text: "hi" }] };
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, output);
		const { SessionStore } = await import("../src/sessionstate.js");
		expect(new SessionStore(root).load("ses_1").seedMessageID).toBe("m1");
	});

	it("does NOT persist anything into output.parts — that is what leaks into titles", async () => {
		const host = makeHost();
		const { hooks } = await loadPlugin(host);
		const parts = [{ type: "text", text: "hi" }];
		const output = { message: { id: "m1", sessionID: "ses_1", time: { created: 1000 } }, parts };
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, output);
		// Phase 0 proved a pushed part reaches the model AND the title call.
		// We inject transiently instead, so the persisted message is untouched.
		expect(parts).toHaveLength(1);
		expect(JSON.stringify(parts)).not.toContain(RECALL_OPEN_MARKER);
	});

	it("ignores the host's internal agents", async () => {
		const { hooks } = await loadPlugin(makeHost());
		const output = { message: { id: "m1", sessionID: "ses_1", time: { created: 1 } }, parts: [{ type: "text", text: "x" }] };
		for (const agent of ["title", "summary", "compaction"]) {
			await (hooks as any)["chat.message"]({ sessionID: `ses_${agent}`, messageID: "m1", agent }, output);
			const { SessionStore } = await import("../src/sessionstate.js");
			expect(new SessionStore(root).load(`ses_${agent}`).seedMessageID).toBeNull();
		}
	});

	it("ignores the compaction auto-continue turn (every part synthetic)", async () => {
		const { hooks } = await loadPlugin(makeHost());
		const output = {
			message: { id: "m1", sessionID: "ses_auto", time: { created: 1 } },
			parts: [{ type: "text", text: "continue", synthetic: true }],
		};
		await (hooks as any)["chat.message"]({ sessionID: "ses_auto", messageID: "m1" }, output);
		const { SessionStore } = await import("../src/sessionstate.js");
		expect(new SessionStore(root).load("ses_auto").seedMessageID).toBeNull();
	});

	it("never throws, even on a malformed payload", async () => {
		const { hooks } = await loadPlugin(makeHost());
		await expect((hooks as any)["chat.message"](undefined, undefined)).resolves.toBeUndefined();
		await expect((hooks as any)["chat.message"]({}, { message: null, parts: "not-an-array" })).resolves.toBeUndefined();
	});
});

describe("event — capture gating", () => {
	it("does not capture a turn that ended in error", async () => {
		const messages: any[] = [userMessage("m1", "q"), assistantMessage("m2", "", { finish: undefined, error: { name: "APIError" } })];
		const host = makeHost({ messages });
		const { hooks } = await loadPlugin(host);
		await (hooks as any)["chat.message"](
			{ sessionID: "ses_1", messageID: "m1" },
			{ message: messages[0].info, parts: messages[0].parts },
		);
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });
		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(0);
	});

	it("does not capture an unfinished turn", async () => {
		const messages: any[] = [userMessage("m1", "q"), assistantMessage("m2", "partial", { unfinished: true })];
		const host = makeHost({ messages });
		const { hooks } = await loadPlugin(host);
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, { message: messages[0].info, parts: messages[0].parts });
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });
		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(0);
	});

	it("ignores a non-idle status", async () => {
		const { hooks } = await loadPlugin(makeHost({ messages: [userMessage("m1", "q"), assistantMessage("m2", "a")] }));
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } });
		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(0);
	});

	it("never captures a subagent session", async () => {
		const messages: any[] = [userMessage("m1", "q"), assistantMessage("m2", "a")];
		const host = makeHost({ messages, parentID: "ses_parent" });
		const { hooks } = await loadPlugin(host);
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, { message: messages[0].info, parts: messages[0].parts });
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });
		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(0);
	});

	it("never lets an exception escape (the host does not await this hook)", async () => {
		const { hooks } = await loadPlugin(makeHost());
		await expect((hooks as any).event({ event: null })).resolves.toBeUndefined();
		await expect((hooks as any).event(undefined)).resolves.toBeUndefined();
	});
});

describe("dispose", () => {
	it("resolves quickly and never throws", async () => {
		const { hooks } = await loadPlugin(makeHost());
		await expect((hooks as any).dispose()).resolves.toBeUndefined();
	});
});

describe("REL-03 — a failed capture must not poison the session", () => {
	it("still captures the NEXT turn after an earlier turn failed to stage", async () => {
		// Turn 1 errors, so nothing is captured and lastCapturedMessageID stays
		// null. Turn 2 succeeds. If the idle-dedup key is derived from
		// lastCapturedMessageID, turn 2's key equals turn 1's, and turn 2 is
		// silently dropped forever.
		const turn1: any[] = [userMessage("m1", "q1"), assistantMessage("m2", "", { finish: undefined, error: { name: "E" } })];
		const turn2: any[] = [userMessage("m1", "q1"), assistantMessage("m2", "", { finish: undefined, error: { name: "E" } }), userMessage("m3", "q2", 2000), assistantMessage("m4", "answer two")];

		let current = turn1;
		const host = {
			client: {
				app: { log: async () => undefined },
				session: {
					get: async () => ({ data: { id: "ses_1" } }),
					messages: async () => ({ data: current }),
				},
			},
		};
		const { hooks } = await loadPlugin(host);

		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, { message: turn1[0].info, parts: turn1[0].parts });
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });

		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(0); // turn 1 correctly refused

		current = turn2;
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m3" }, { message: turn2[2].info, parts: turn2[2].parts });
		await (hooks as any).event({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } });

		// Turn 2 settled successfully and MUST be captured.
		expect(new Spool(root).list()).toHaveLength(1);
	});

	it("still collapses the double idle Phase 0 measured on the error path", async () => {
		const messages: any[] = [userMessage("m1", "q"), assistantMessage("m2", "a")];
		const host = makeHost({ messages });
		const { hooks } = await loadPlugin(host);
		await (hooks as any)["chat.message"]({ sessionID: "ses_1", messageID: "m1" }, { message: messages[0].info, parts: messages[0].parts });
		const idle = { event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } };
		await Promise.all([(hooks as any).event(idle), (hooks as any).event(idle)]);
		await (hooks as any).event(idle);
		const { Spool } = await import("../src/spool.js");
		expect(new Spool(root).list()).toHaveLength(1);
	});
});
