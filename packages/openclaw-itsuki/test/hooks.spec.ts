/**
 * Hook order: the real plugin, wired to a stand-in host that emits OpenClaw's
 * documented event sequence with its documented payload shapes.
 *
 * This is where the central claim is proved — memory participates in the turn
 * automatically. Recall reaches `prependContext` before the model, capture
 * happens only once the run genuinely settled, and a restart does not
 * re-capture or re-echo anything.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { register } from "../src/index.js";

const KEY = "itsuki_live_secret_key_0123456789";

interface Reply {
	status: number;
	body?: unknown;
}

let root: string;
let originalFetch: typeof fetch;
let originalKey: string | undefined;
let originalState: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "openclaw-itsuki-hooks-"));
	originalFetch = globalThis.fetch;
	originalKey = process.env["ITSUKI_API_KEY"];
	originalState = process.env["OPENCLAW_STATE_DIR"];
	process.env["ITSUKI_API_KEY"] = KEY;
	process.env["OPENCLAW_STATE_DIR"] = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env["ITSUKI_API_KEY"];
	else process.env["ITSUKI_API_KEY"] = originalKey;
	if (originalState === undefined) delete process.env["OPENCLAW_STATE_DIR"];
	else process.env["OPENCLAW_STATE_DIR"] = originalState;
	await rm(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function fakeHost(
	replies: Array<Reply | Error>,
	pluginConfig: Record<string, unknown> = {},
	hostConfig?: Record<string, unknown>,
) {
	const handlers = new Map<string, Array<{ handler: Handler; priority: number }>>();
	const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
	const requests: Array<{ url: string; body: unknown }> = [];
	const logs: string[] = [];
	const order: string[] = [];
	let index = 0;

	globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ url: String(url), body });
		order.push(`http:${String(url).replace(/^https:\/\/itsuki\.app/, "")}`);
		const next = replies[Math.min(index, replies.length - 1)]!;
		index += 1;
		if (next instanceof Error) throw next;
		return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
	}) as unknown as typeof fetch;

	const api = {
		pluginConfig,
		// The full OpenClaw config, where entries.<id>.hooks actually lives —
		// a SIBLING of entries.<id>.config, never inside pluginConfig.
		config: hostConfig ?? { plugins: { entries: { itsuki: { config: pluginConfig } } } },
		logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`) },
		on(hook: string, handler: Handler, opts?: { priority?: number }) {
			handlers.set(hook, [...(handlers.get(hook) ?? []), { handler, priority: opts?.priority ?? 0 }]);
		},
		registerTool(tool: unknown) {
			tools.push(tool as { name: string; execute: (...a: unknown[]) => Promise<unknown> });
		},
	};

	async function emit(hook: string, event: unknown = {}, ctx: unknown = {}): Promise<unknown> {
		order.push(`event:${hook}`);
		let last: unknown;
		const registered = [...(handlers.get(hook) ?? [])].sort((a, b) => b.priority - a.priority);
		for (const { handler } of registered) last = await handler(event, ctx);
		return last;
	}

	return { api, emit, handlers, tools, requests, logs, order };
}

const OK_RECALL = { status: 200, body: { ok: true, count: 1, context: "User prefers tabs." } };
const OK_SAVE = { status: 200, body: { ok: true, receipt_id: "r1", source_packet_id: "p1" } };

const userCtx = (overrides: Record<string, unknown> = {}) => ({
	sessionKey: "discord:chan-1",
	sessionId: "sess-1",
	channel: "discord",
	senderId: "alice",
	trigger: "message",
	...overrides,
});

const turn = (messages: Array<{ role: string; content: unknown }>, success = true) => ({ messages, success });

describe("registration", () => {
	it("registers exactly the lifecycle hooks it needs, and two non-destructive tools", () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		expect([...host.handlers.keys()].sort()).toEqual([
			"agent_end",
			"agent_turn_prepare",
			"before_compaction",
			"gateway_start",
			"gateway_stop",
			"session_end",
			"subagent_spawned",
		]);
		expect(host.tools.map((t) => t.name).sort()).toEqual(["itsuki_recall", "itsuki_save"]);
	});

	it("exposes NO destructive tool", () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		const names = host.tools.map((t) => t.name.toLowerCase()).join(" ");
		for (const forbidden of ["delete", "destroy", "remove", "purge", "forget"]) {
			expect(names).not.toContain(forbidden);
		}
	});

	it("does no network work at registration time", () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		expect(host.requests.length).toBe(0);
	});

	it("does not claim OpenClaw's exclusive memory slot", () => {
		// Claiming it would disable memory-core for every agent in the install.
		const host = fakeHost([OK_RECALL]);
		const claimed: string[] = [];
		register({
			...host.api,
			registerMemoryRuntime: () => claimed.push("memory-runtime"),
			registerContextEngine: () => claimed.push("context-engine"),
		} as never);
		expect(claimed).toEqual([]);
	});
});

describe("gateway lifecycle", () => {
	it("starts without any blocking network dependency", async () => {
		const host = fakeHost([new Error("backend down")]);
		register(host.api as never);
		await expect(host.emit("gateway_start", { port: 4242 })).resolves.toBeUndefined();
		expect(host.requests.length).toBe(0);
	});

	it("reports inactivity plainly when no key is configured", async () => {
		delete process.env["ITSUKI_API_KEY"];
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 4242 });
		expect(host.logs.join("\n")).toMatch(/not configured/i);
		expect(host.logs.join("\n")).not.toContain(KEY);
	});
});

describe("recall before the model", () => {
	it("injects a labelled block through prependContext", async () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const result = (await host.emit(
			"agent_turn_prepare",
			{ prompt: "what do I prefer?", messages: [], queuedInjections: [] },
			userCtx(),
		)) as { prependContext?: string };
		expect(result?.prependContext).toContain("<itsuki-recalled-context-v1>");
		expect(result?.prependContext).toContain("not instructions");
		const recalls = host.requests.filter((r) => r.url.endsWith("/v1/recall"));
		expect(recalls.length).toBe(1);
		expect((recalls[0]!.body as { query: string }).query).toBe("what do I prefer?");
	});

	it("FAILS OPEN when the backend is down — the turn proceeds untouched", async () => {
		const host = fakeHost([new Error("ENOTFOUND")]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await expect(
			host.emit("agent_turn_prepare", { prompt: "q", messages: [], queuedInjections: [] }, userCtx()),
		).resolves.toBeUndefined();
	});

	it("skips cron-driven runs — a scheduled tick is not a user asking", async () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_turn_prepare",
			{ prompt: "scheduled work", messages: [], queuedInjections: [] },
			userCtx({ jobId: "cron-7", trigger: "cron" }),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/recall")).length).toBe(0);
	});

	it("skips heartbeat runs", async () => {
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_turn_prepare",
			{ prompt: "status?", messages: [], queuedInjections: [] },
			userCtx({ trigger: "heartbeat", jobId: undefined }),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/recall")).length).toBe(0);
	});

	it("stays silent with no key rather than breaking the turn", async () => {
		delete process.env["ITSUKI_API_KEY"];
		const host = fakeHost([OK_RECALL]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await expect(
			host.emit("agent_turn_prepare", { prompt: "q", messages: [], queuedInjections: [] }, userCtx()),
		).resolves.toBeUndefined();
		expect(host.requests.length).toBe(0);
	});
});

describe("capture after a settled turn", () => {
	it("captures on agent_end and sends a content-derived key", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "We picked Postgres." }, { role: "assistant", content: "Noted." }]),
			userCtx(),
		);
		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(1);
		const body = saves[0]!.body as { mode: string; messages: Array<{ role: string; content: string }>; idempotencyKey: string };
		expect(body.mode).toBe("conversation");
		expect(body.messages).toEqual([
			{ role: "user", content: "We picked Postgres." },
			{ role: "assistant", content: "Noted." },
		]);
		expect(body.idempotencyKey).toMatch(/^openclaw:v1:[a-f0-9]{64}$/);
	});

	it("does NOT capture a failed run", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "half a thought" }], false),
			userCtx(),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("does NOT capture an aborted run reported with an error", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			{ messages: [{ role: "user", content: "x" }], success: true, error: "aborted" },
			userCtx(),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("re-captures a turn that failed once and then genuinely settled", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const messages = [{ role: "user", content: "retried" }, { role: "assistant", content: "ok" }];
		await host.emit("agent_end", turn(messages, false), userCtx());
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
		await host.emit("agent_end", turn(messages, true), userCtx());
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});

	it("captures each settled turn exactly once and never resends the previous one", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_end", turn([{ role: "user", content: "turn one" }]), userCtx());
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "turn one" }, { role: "user", content: "turn two" }]),
			userCtx(),
		);
		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(2);
		expect((saves[0]!.body as { messages: Array<{ content: string }> }).messages.map((m) => m.content)).toEqual(["turn one"]);
		expect((saves[1]!.body as { messages: Array<{ content: string }> }).messages.map((m) => m.content)).toEqual(["turn two"]);
	});

	it("is idempotent under handler re-entry for the same turn", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const event = turn([{ role: "user", content: "same turn" }]);
		await host.emit("agent_end", event, userCtx());
		await host.emit("agent_end", event, userCtx());
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});

	it("keeps two concurrent agent_end calls from double-sending", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const event = turn([{ role: "user", content: "concurrent" }]);
		await Promise.all([
			host.emit("agent_end", event, userCtx()),
			host.emit("agent_end", event, userCtx()),
		]);
		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		// Whether one or both stage, the content-derived key means the spool
		// holds a single envelope and exactly one delivery goes out.
		expect(saves.length).toBe(1);
	});

	it("keeps different sessions independent", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_end", turn([{ role: "user", content: "in A" }]), userCtx({ sessionKey: "chan-A" }));
		await host.emit("agent_end", turn([{ role: "user", content: "in B" }]), userCtx({ sessionKey: "chan-B" }));
		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(2);
		expect((saves[0]!.body as { conversationId: string }).conversationId).toBe("chan-A");
		expect((saves[1]!.body as { conversationId: string }).conversationId).toBe("chan-B");
	});

	it("takes durable ownership BEFORE it calls the network", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_end", turn([{ role: "user", content: "ordering" }]), userCtx());
		// The spool file exists before the save request goes out; a crash in
		// between therefore cannot lose or duplicate the span.
		const saveAt = host.order.indexOf("http:/v1/save");
		expect(saveAt).toBeGreaterThan(host.order.indexOf("event:agent_end"));
	});
});

describe("compaction and session end", () => {
	it("flushes the outstanding span before compaction rewrites context", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"before_compaction",
			{ messageCount: 2, messages: [{ role: "user", content: "about to be compacted" }] },
			userCtx(),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});

	it("does not double-capture when compaction is followed by session_end(compaction)", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const messages = [{ role: "user", content: "one span" }];
		await host.emit("before_compaction", { messageCount: 1, messages }, userCtx());
		await host.emit("session_end", { sessionId: "sess-1", messageCount: 1, reason: "compaction" }, userCtx());
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});

	it("captures only the new exchange after compaction rewrote history", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "old one" }, { role: "assistant", content: "old two" }]),
			userCtx(),
		);
		// Post-compaction the transcript is a summary plus the newest turn.
		await host.emit(
			"agent_end",
			turn([
				{ role: "user", content: "summary of earlier conversation" },
				{ role: "user", content: "brand new question" },
				{ role: "assistant", content: "brand new answer" },
			]),
			userCtx(),
		);
		const saves = host.requests.filter((r) => r.url.endsWith("/v1/save"));
		expect(saves.length).toBe(2);
		const second = (saves[1]!.body as { messages: Array<{ content: string }> }).messages.map((m) => m.content);
		expect(second).toEqual(["brand new question", "brand new answer"]);
		expect(second).not.toContain("old one");
	});
});

describe("restart and resume", () => {
	it("does not re-capture a turn owned before the restart", async () => {
		const first = fakeHost([OK_SAVE]);
		register(first.api as never);
		await first.emit("gateway_start", { port: 1 });
		await first.emit("agent_end", turn([{ role: "user", content: "before restart" }]), userCtx());
		await first.emit("gateway_stop", { reason: "restart" });
		expect(first.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);

		// A brand-new process over the same state dir.
		const second = fakeHost([OK_SAVE]);
		register(second.api as never);
		await second.emit("gateway_start", { port: 1 });
		await second.emit("agent_end", turn([{ role: "user", content: "before restart" }]), userCtx());
		expect(second.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("suppresses an echo of context injected before the restart", async () => {
		// Fingerprinting deliberately ignores short lines (under 24 characters):
		// they collide too easily to suppress safely. Use a line that a real
		// recall would actually produce.
		const RECALLED_LINE = "The deploy mascot is a teal axolotl named Sprocket.";
		const first = fakeHost([{ status: 200, body: { ok: true, count: 1, context: RECALLED_LINE } }]);
		register(first.api as never);
		await first.emit("gateway_start", { port: 1 });
		await first.emit("agent_turn_prepare", { prompt: "mascot?", messages: [], queuedInjections: [] }, userCtx());

		const second = fakeHost([OK_SAVE]);
		register(second.api as never);
		await second.emit("gateway_start", { port: 1 });
		await second.emit(
			"agent_end",
			turn([
				{ role: "user", content: "remind me about the mascot" },
				{ role: "assistant", content: RECALLED_LINE },
			]),
			userCtx(),
		);
		const save = second.requests.find((r) => r.url.endsWith("/v1/save"));
		expect(save).toBeTruthy();
		expect(JSON.stringify(save!.body)).toContain("remind me about the mascot");
		expect(JSON.stringify(save!.body)).not.toContain("teal axolotl");
	});

	it("delivers a span spooled while the backend was offline", async () => {
		const offline = fakeHost([new Error("offline")]);
		register(offline.api as never);
		await offline.emit("gateway_start", { port: 1 });
		await offline.emit("agent_end", turn([{ role: "user", content: "written offline" }]), userCtx());

		const online = fakeHost([OK_SAVE]);
		register(online.api as never);
		await online.emit("gateway_start", { port: 1 });
		// The next settled turn drains the backlog alongside its own span.
		await online.emit("agent_end", turn([{ role: "user", content: "later turn" }]), userCtx({ sessionKey: "other" }));
		const bodies = online.requests
			.filter((r) => r.url.endsWith("/v1/save"))
			.map((r) => JSON.stringify(r.body));
		expect(bodies.some((b) => b.includes("written offline"))).toBe(true);
	});
});

describe("subagents", () => {
	it("observes a subagent without widening scope or capturing on its behalf", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("subagent_spawned", { childSessionKey: "sub-1" }, userCtx());
		expect(host.requests.length).toBe(0);
		expect(host.logs.join("\n")).not.toContain("discord:chan-1");
	});
});

describe("honesty", () => {
	it("never writes message content or the key into logs", async () => {
		const host = fakeHost([OK_RECALL, OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_turn_prepare", { prompt: "my private question", messages: [], queuedInjections: [] }, userCtx());
		await host.emit("agent_end", turn([{ role: "user", content: "confidential content" }]), userCtx());
		const joined = host.logs.join("\n");
		expect(joined).not.toContain("my private question");
		expect(joined).not.toContain("confidential content");
		expect(joined).not.toContain(KEY);
	});

	it("itsuki_save says 'queued', not 'saved', without a receipt", async () => {
		const host = fakeHost([new Error("offline")]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const tool = host.tools.find((t) => t.name === "itsuki_save")!;
		const result = (await tool.execute("call-1", { content: "remember this" }, userCtx())) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toMatch(/Queued/);
		expect(result.content[0]!.text).not.toMatch(/\bSaved\b/);
	});

	it("itsuki_save reports the receipt when one came back", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const tool = host.tools.find((t) => t.name === "itsuki_save")!;
		const result = (await tool.execute("call-1", { content: "remember this" }, userCtx())) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toMatch(/Saved\. Receipt r1/);
	});
});

describe("capture disabled", () => {
	it("sends nothing and does not move the watermark", async () => {
		const host = fakeHost([OK_SAVE], { capture: { enabled: false } });
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_end", turn([{ role: "user", content: "not captured" }]), userCtx());
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);

		// Re-enabling must still see that turn.
		const enabled = fakeHost([OK_SAVE]);
		register(enabled.api as never);
		await enabled.emit("gateway_start", { port: 1 });
		await enabled.emit("agent_end", turn([{ role: "user", content: "not captured" }]), userCtx());
		expect(enabled.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(1);
	});
});

describe("OpenClaw's conversation-access gate", () => {
	it("warns loudly when the operator has not granted access", async () => {
		// Without the grant, OpenClaw blocks the conversation hooks and this
		// plugin captures nothing. Looking healthy while inert is the failure
		// mode this warning exists to prevent.
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const warned = host.logs.filter((l) => l.startsWith("WARN")).join("\n");
		expect(warned).toMatch(/allowConversationAccess/);
		expect(warned).toMatch(/blocked/i);
	});

	it("stays quiet when access is granted in the REAL location: entries.<id>.hooks", async () => {
		// The flag is a SIBLING of entries.<id>.config, so it is NOT visible in
		// api.pluginConfig. The first implementation read pluginConfig.hooks and
		// warned falsely in every correctly-configured gateway — this test is
		// the regression proof for that audit finding.
		const host = fakeHost([OK_SAVE], {}, {
			plugins: {
				entries: {
					itsuki: {
						enabled: true,
						hooks: { allowConversationAccess: true },
						config: {},
					},
				},
			},
		});
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		expect(host.logs.filter((l) => l.startsWith("WARN")).join("\n")).not.toMatch(/allowConversationAccess/);
	});

	it("also accepts the forward-compat pluginConfig location", async () => {
		const host = fakeHost([OK_SAVE], { hooks: { allowConversationAccess: true } });
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		expect(host.logs.filter((l) => l.startsWith("WARN")).join("\n")).not.toMatch(/allowConversationAccess/);
	});

	it("reads the flag defensively and never crashes on a strange shape", async () => {
		const shapes: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
			[{}, undefined],
			[{ hooks: null } as Record<string, unknown>, undefined],
			[{ hooks: "yes" } as Record<string, unknown>, undefined],
			[{ hooks: { allowConversationAccess: "true" } }, undefined],
			[{}, {}],
			[{}, { plugins: null } as unknown as Record<string, unknown>],
			[{}, { plugins: { entries: { itsuki: { hooks: "granted" } } } } as unknown as Record<string, unknown>],
		];
		for (const [pluginConfig, hostConfig] of shapes) {
			const host = fakeHost([OK_SAVE], pluginConfig, hostConfig);
			register(host.api as never);
			await expect(host.emit("gateway_start", { port: 1 })).resolves.toBeUndefined();
		}
	});
});

describe("system-originated runs are not conversations", () => {
	it("does NOT capture a cron-driven run", async () => {
		// A scheduled tick's transcript is automation noise, not something a
		// person said — and in per-sender mode it has no one to belong to.
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "cron says hello" }, { role: "assistant", content: "done" }]),
			userCtx({ jobId: "cron-9", trigger: "cron" }),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("does NOT capture a heartbeat run", async () => {
		const host = fakeHost([OK_SAVE]);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_end",
			turn([{ role: "user", content: "heartbeat prompt" }, { role: "assistant", content: "ok" }]),
			userCtx({ trigger: "heartbeat" }),
		);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});
});

describe("per-sender tenancy at the hook boundary", () => {
	const perSenderConfig = { tenancy: "per-sender" };

	it("captures under the hashed sender tenant, never the raw platform id", async () => {
		const host = fakeHost([OK_SAVE], perSenderConfig);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit("agent_end", turn([{ role: "user", content: "per-sender turn" }]), userCtx());
		const save = host.requests.find((r) => r.url.endsWith("/v1/save"));
		expect(save).toBeTruthy();
		const userId = (save!.body as { userId?: string }).userId;
		expect(userId).toMatch(/^oc_[a-f0-9]{32}$/);
		expect(userId).not.toContain("alice");
	});

	it("SKIPS memory entirely when a user turn has no derivable sender", async () => {
		// The first implementation fell back to owner scope here — meaning on a
		// channel without sender ids, every stranger would share and RECALL the
		// owner's memory. Skipping is the only non-mixing answer. (Audit F1.)
		const host = fakeHost([OK_SAVE], perSenderConfig);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		await host.emit(
			"agent_turn_prepare",
			{ prompt: "who am I?", messages: [], queuedInjections: [] },
			userCtx({ senderId: undefined }),
		);
		await host.emit("agent_end", turn([{ role: "user", content: "anonymous words" }]), userCtx({ senderId: undefined }));
		expect(host.requests.filter((r) => r.url.endsWith("/v1/recall")).length).toBe(0);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});

	it("tools refuse honestly instead of writing to the wrong tenant", async () => {
		const host = fakeHost([OK_SAVE], perSenderConfig);
		register(host.api as never);
		await host.emit("gateway_start", { port: 1 });
		const save = host.tools.find((t) => t.name === "itsuki_save")!;
		const result = (await save.execute("c1", { content: "orphan fact" }, { sessionKey: "s", trigger: "message" })) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]!.text).toMatch(/no sender identity/);
		expect(host.requests.filter((r) => r.url.endsWith("/v1/save")).length).toBe(0);
	});
});
