/**
 * Switching a half off must be honest in both directions: nothing is sent, and
 * nothing is skipped either. Turning capture back on has to resume from where
 * it stopped, which means the watermark must not move while it is off.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import itsukiExtension from "../src/index.js";

const KEY = "itsuki_live_secret_key_0123456789";

let root: string;
let originalFetch: typeof fetch;
let originalKey: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-itsuki-disabled-"));
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

async function writeConfig(value: unknown) {
	const dir = join(root, "itsuki");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "itsuki.json"), JSON.stringify(value), "utf8");
}

function host() {
	const handlers = new Map<string, Array<(e: unknown, c: unknown) => Promise<unknown> | unknown>>();
	const entries: unknown[] = [];
	const branch: unknown[] = [];
	const requests: string[] = [];

	globalThis.fetch = (async (url: URL | RequestInfo) => {
		requests.push(String(url));
		return new Response(JSON.stringify({ ok: true, count: 0, context: "", receipt_id: "r1" }), { status: 200 });
	}) as unknown as typeof fetch;

	const pi = {
		on(event: string, handler: (e: unknown, c: unknown) => Promise<unknown> | unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerTool() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", id: `w${entries.length}`, customType, data });
		},
	};
	const ctx = {
		sessionManager: {
			getBranch: () => [...branch, ...entries],
			getEntries: () => [...branch, ...entries],
			getSessionId: () => "sess-disabled",
			getSessionFile: () => "/tmp/sess-disabled.jsonl",
		},
		ui: { notify: () => {} },
		signal: undefined,
	};
	return {
		pi,
		ctx,
		entries,
		requests,
		addMessage(id: string, role: string, content: unknown) {
			branch.push({ type: "message", id, parentId: null, timestamp: "", message: { role, content } });
		},
		async emit(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

describe("capture disabled", () => {
	it("sends nothing and does not move the watermark", async () => {
		await writeConfig({ capture: { enabled: false } });
		const h = host();
		itsukiExtension(h.pi as never);
		await h.emit("session_start", { reason: "startup" });
		h.addMessage("m1", "user", "not captured");
		await h.emit("agent_settled");

		expect(h.requests.filter((u) => u.includes("/v1/save"))).toEqual([]);
		// Nothing skipped: re-enabling capture must still see this turn.
		expect(h.entries.length).toBe(0);
	});
});

describe("recall disabled", () => {
	it("injects nothing and makes no recall request", async () => {
		await writeConfig({ recall: { enabled: false } });
		const h = host();
		itsukiExtension(h.pi as never);
		await h.emit("session_start", { reason: "startup" });
		await h.emit("before_agent_start", { prompt: "anything" });

		expect(h.requests.filter((u) => u.includes("/v1/recall"))).toEqual([]);
	});

	it("still captures — the two halves are independent", async () => {
		await writeConfig({ recall: { enabled: false } });
		const h = host();
		itsukiExtension(h.pi as never);
		await h.emit("session_start", { reason: "startup" });
		h.addMessage("m1", "user", "still captured");
		await h.emit("agent_settled");

		expect(h.requests.filter((u) => u.includes("/v1/save")).length).toBe(1);
	});
});
