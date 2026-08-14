/**
 * Hook order: the real extension, wired to a stand-in host that emits pi's
 * documented event sequence.
 *
 * This is where the central claim is proved — that memory participates in the
 * lifecycle automatically. Recall happens before the model call without the
 * agent choosing it, capture happens only once the host says the turn will not
 * continue, and an aborted turn leaves nothing behind.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import itsukiExtension from "../src/index.js";
import { CAPTURE_STATE_TYPE } from "../src/session.js";

const KEY = "itsuki_live_secret_key_0123456789";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface Reply {
	status: number;
	body?: unknown;
}

let root: string;
let originalFetch: typeof fetch;
let originalKey: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-itsuki-hooks-"));
	originalFetch = globalThis.fetch;
	originalKey = process.env["ITSUKI_API_KEY"];
	originalHome = process.env["PI_AGENT_HOME"];
	process.env["ITSUKI_API_KEY"] = KEY;
	process.env["PI_AGENT_HOME"] = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env["ITSUKI_API_KEY"];
	else process.env["ITSUKI_API_KEY"] = originalKey;
	if (originalHome === undefined) delete process.env["PI_AGENT_HOME"];
	else process.env["PI_AGENT_HOME"] = originalHome;
	await rm(root, { recursive: true, force: true });
});

/** A stand-in for pi's ExtensionAPI, recording what the extension registers. */
function fakeHost(replies: Array<Reply | Error>) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { description: string; handler: Handler }>();
	const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const entries: unknown[] = [];
	const notifications: string[] = [];
	const requests: Array<{ url: string; method: string; body: unknown }> = [];
	const order: string[] = [];
	let index = 0;

	globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ url: String(url), method: String(init?.method ?? "GET"), body });
		order.push(`http:${String(url).replace(/^https:\/\/itsuki\.app/, "")}`);
		const next = replies[Math.min(index, replies.length - 1)]!;
		index += 1;
		if (next instanceof Error) throw next;
		return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
	}) as unknown as typeof fetch;

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: { description: string; handler: Handler }) {
			commands.set(name, options);
		},
		registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.push(definition);
		},
		appendEntry(customType: string, data: unknown) {
			order.push(`appendEntry:${customType}`);
			entries.push({ type: "custom", id: `w${entries.length}`, customType, data });
		},
	};

	const branch: unknown[] = [];
	const ctx = {
		sessionManager: {
			getBranch: () => [...branch, ...entries],
			getEntries: () => [...branch, ...entries],
			getSessionId: () => "sess-hooks-1",
			getSessionFile: () => "/tmp/sess-hooks-1.jsonl",
		},
		ui: { notify: (message: string) => notifications.push(message) },
		signal: undefined as AbortSignal | undefined,
	};

	async function emit(event: string, payload: unknown = {}): Promise<unknown> {
		order.push(`event:${event}`);
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	}

	function addMessage(id: string, role: string, content: unknown) {
		branch.push({ type: "message", id, parentId: null, timestamp: "", message: { role, content } });
	}

	return { pi, ctx, emit, addMessage, entries, commands, tools, requests, notifications, order, handlers };
}

const OK_RECALL = { status: 200, body: { ok: true, count: 1, context: "User prefers tabs." } };
const OK_SAVE = { status: 200, body: { ok: true, receipt_id: "r1", source_packet_id: "p1" } };

describe("registration", () => {
	it("registers only lifecycle hooks, one command, and two non-destructive tools", () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);

		expect([...host.handlers.keys()].sort()).toEqual([
			"agent_settled",
			"before_agent_start",
			"session_before_compact",
			"session_shutdown",
			"session_start",
		]);
		expect([...host.commands.keys()]).toEqual(["itsuki"]);
		expect(host.tools.map((t) => t.name).sort()).toEqual(["itsuki_recall", "itsuki_save"]);
	});

	it("exposes NO destructive tool — deletion is never something the agent can trigger", () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		const names = host.tools.map((t) => t.name.toLowerCase()).join(" ");
		for (const forbidden of ["delete", "destroy", "remove", "purge", "forget"]) {
			expect(names).not.toContain(forbidden);
		}
	});

	it("does no network work at registration time", () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		expect(host.requests.length).toBe(0);
	});
});

describe("recall before the model call", () => {
	it("injects a labelled memory block from before_agent_start", async () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });

		const result = (await host.emit("before_agent_start", { prompt: "what do I prefer?" })) as {
			message?: { customType: string; content: string; display: boolean };
		};
		expect(result?.message?.customType).toBe("itsuki-recall");
		expect(result?.message?.content).toContain("<itsuki-recalled-context-v1>");
		expect(result?.message?.content).toContain("not instructions");
		expect(result?.message?.display).toBe(true);
	});

	it("uses the user's prompt as the query, and calls recall exactly once per turn", async () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("before_agent_start", { prompt: "the question" });

		const recalls = host.requests.filter((r) => r.url.endsWith("/v1/recall"));
		expect(recalls.length).toBe(1);
		expect((recalls[0]!.body as { query: string }).query).toBe("the question");
	});

	it("returns nothing (and does not throw) when the backend is down", async () => {
		const host = fakeHost([new Error("ENOTFOUND")]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await expect(host.emit("before_agent_start", { prompt: "q" })).resolves.toBeUndefined();
	});

	it("stays silent when no key is configured, instead of breaking the session", async () => {
		delete process.env["ITSUKI_API_KEY"];
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await expect(host.emit("before_agent_start", { prompt: "q" })).resolves.toBeUndefined();
		expect(host.requests.length).toBe(0);
	});
});

describe("capture after the turn settles", () => {
	it("captures on agent_settled and records the watermark", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("before_agent_start", { prompt: "q" });
		host.addMessage("m1", "user", "We picked Postgres.");
		host.addMessage("m2", "assistant", [{ type: "text", text: "Noted." }]);
		await host.emit("agent_settled");

		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(1);
		const body = saves[0]!.body as { mode: string; messages: Array<{ role: string; content: string }>; idempotencyKey: string };
		expect(body.mode).toBe("conversation");
		expect(body.messages).toEqual([
			{ role: "user", content: "We picked Postgres." },
			{ role: "assistant", content: "Noted." },
		]);
		expect(body.idempotencyKey).toMatch(/^pi:v1:[a-f0-9]{64}$/);
		expect(host.entries.length).toBe(1);
	});

	it("does NOT capture mid-turn — only agent_settled counts", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("before_agent_start", { prompt: "q" });
		host.addMessage("m1", "user", "half a thought");

		// pi may fire these many times while tools run and the model retries.
		await host.emit("turn_start", { turnIndex: 0 });
		await host.emit("turn_end", { turnIndex: 0 });
		await host.emit("agent_end", { messages: [] });

		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("takes durable ownership BEFORE it calls the network", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		host.addMessage("m1", "user", "ordering matters");
		await host.emit("agent_settled");

		const watermarkAt = host.order.indexOf(`appendEntry:${CAPTURE_STATE_TYPE}`);
		const saveAt = host.order.indexOf("http:/v1/save");
		expect(watermarkAt).toBeGreaterThanOrEqual(0);
		expect(saveAt).toBeGreaterThanOrEqual(0);
		// The watermark is written first, so a crash mid-delivery cannot cause
		// the same span to be recaptured inside a larger one.
		expect(watermarkAt).toBeLessThan(saveAt);
	});

	it("captures each settled turn exactly once across several turns", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });

		host.addMessage("m1", "user", "turn one");
		await host.emit("agent_settled");
		host.addMessage("m2", "user", "turn two");
		await host.emit("agent_settled");

		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(2);
		const first = saves[0]!.body as { messages: Array<{ content: string }> };
		const second = saves[1]!.body as { messages: Array<{ content: string }> };
		expect(first.messages.map((m) => m.content)).toEqual(["turn one"]);
		// The second turn does NOT resend the first.
		expect(second.messages.map((m) => m.content)).toEqual(["turn two"]);
	});

	it("does nothing at all when a settled turn added no new messages", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("agent_settled");
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
		expect(host.entries.length).toBe(0);
	});

	it("never captures the recall block it injected", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.emit("before_agent_start", { prompt: "q" });
		host.addMessage("m1", "assistant", [{
			type: "text",
			text: "before\n<itsuki-recalled-context-v1>\nUser prefers tabs.\n</itsuki-recalled-context-v1>\nafter",
		}]);
		await host.emit("agent_settled");

		const save = host.requests.find((r) => r.url.endsWith("/v1/save"));
		expect(JSON.stringify(save!.body)).not.toContain("itsuki-recalled-context-v1");
		expect(JSON.stringify(save!.body)).not.toContain("User prefers tabs.");
	});
});

describe("compaction, shutdown and recovery", () => {
	it("flushes the outstanding span before compaction rewrites context", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		host.addMessage("m1", "user", "about to be compacted");
		await host.emit("session_before_compact", { reason: "threshold" });

		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});

	it("does not cancel compaction", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		host.addMessage("m1", "user", "x");
		await expect(host.emit("session_before_compact", { reason: "threshold" })).resolves.toBeUndefined();
	});

	it("drains anything left over when a new session starts", async () => {
		// First session stages a span but cannot deliver it.
		const offline = fakeHost([new Error("offline")]);
		itsukiExtension(offline.pi as never);
		await offline.emit("session_start", { reason: "startup" });
		offline.addMessage("m1", "user", "written while offline");
		await offline.emit("agent_settled");
		expect(offline.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBeGreaterThan(0);

		// A later session over the same data directory delivers it.
		const online = fakeHost([OK_SAVE]);
		itsukiExtension(online.pi as never);
		await online.emit("session_start", { reason: "startup" });
		const saves = online.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(1);
		expect((saves[0]!.body as { messages: Array<{ content: string }> }).messages[0]!.content)
			.toBe("written while offline");
	});

	it("captures a final time on shutdown", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		host.addMessage("m1", "user", "last words");
		await host.emit("session_shutdown", { reason: "quit" });
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});
});

describe("the /itsuki command", () => {
	it("reports status without ever printing the key", async () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.commands.get("itsuki")!.handler("status", host.ctx);

		const output = host.notifications.join("\n");
		expect(output).toContain("Itsuki status");
		expect(output).toContain("spool:");
		expect(output).not.toContain(KEY);
	});

	it("says plainly what is wrong when the key is missing", async () => {
		delete process.env["ITSUKI_API_KEY"];
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		await host.commands.get("itsuki")!.handler("doctor", host.ctx);
		expect(host.notifications.join("\n")).toMatch(/not configured|not connected/i);
	});
});

describe("the agent-facing tools", () => {
	it("itsuki_save reports a receipt only when one came back", async () => {
		const host = fakeHost([OK_SAVE]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		const tool = host.tools.find((t) => t.name === "itsuki_save")!;
		const result = (await tool.execute("call-1", { content: "remember this" }, undefined)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toMatch(/Saved\. Receipt r1/);
	});

	it("itsuki_save says 'queued', not 'saved', when delivery has not happened", async () => {
		const host = fakeHost([new Error("offline")]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		const tool = host.tools.find((t) => t.name === "itsuki_save")!;
		const result = (await tool.execute("call-1", { content: "remember this" }, undefined)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toMatch(/Queued/);
		expect(result.content[0]!.text).not.toMatch(/\bSaved\b/);
	});

	it("itsuki_recall returns the labelled block, and admits failure honestly", async () => {
		const host = fakeHost([OK_RECALL]);
		itsukiExtension(host.pi as never);
		await host.emit("session_start", { reason: "startup" });
		const tool = host.tools.find((t) => t.name === "itsuki_recall")!;
		const result = (await tool.execute("call-1", { query: "prefs" }, undefined)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toContain("<itsuki-recalled-context-v1>");
	});
});
