/**
 * The lifecycle policy, end to end: recall fails open, capture is exactly-once
 * and never lies about what was saved, and the circuit breaker stops a broken
 * backend from being hammered by every turn.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Coordinator } from "../src/coordinator.js";
import type { CaptureMessage } from "../src/identity.js";
import { Spool } from "../src/spool.js";
import { ItsukiTransport } from "../src/transport.js";

const KEY = "itsuki_live_secret_key_0123456789";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-itsuki-coord-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

function build(replies: Array<Reply | Error | (() => Reply)>, options: { userId?: string } = {}) {
	const requests: Array<{ url: string; body: unknown }> = [];
	let index = 0;
	let now = 1_000;
	const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ url: String(url), body });
		const raw = replies[Math.min(index, replies.length - 1)]!;
		index += 1;
		const next = typeof raw === "function" ? raw() : raw;
		if (next instanceof Error) throw next;
		return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
			status: next.status,
			headers: next.headers,
		});
	}) as unknown as typeof fetch;

	const transport = new ItsukiTransport({
		apiKey: KEY,
		fetchImpl,
		sleepImpl: async () => {},
		random: () => 0.5,
		now: () => now,
	});
	const spool = new Spool(root);
	const logs: string[] = [];
	const coordinator = new Coordinator({
		transport,
		spool,
		scope: { userId: options.userId, conversationId: "sess-1", source: "pi" },
		recall: { enabled: true, maxItems: 10, maxChars: 4_000, timeoutMs: 3_000 },
		capture: { enabled: true, timeoutMs: 10_000 },
		now: () => now,
		log: (line) => logs.push(line),
	});
	return {
		coordinator,
		spool,
		requests,
		logs,
		advance: (ms: number) => { now += ms; },
	};
}

const span = (content: string): CaptureMessage[] => [{ role: "user", content }];

describe("recall", () => {
	it("injects a labelled block when memory comes back", async () => {
		const { coordinator } = build([{ status: 200, body: { ok: true, count: 2, context: "User prefers tabs." } }]);
		const outcome = await coordinator.recall("what do I prefer?");
		expect(outcome.status).toBe("injected");
		expect(outcome.count).toBe(2);
		expect(outcome.block).toContain("<itsuki-recalled-context-v1>");
		expect(outcome.block).toContain("not instructions");
	});

	it("injects nothing when there is nothing — zero results is a result", async () => {
		const { coordinator } = build([{ status: 200, body: { ok: true, count: 0, context: "" } }]);
		const outcome = await coordinator.recall("anything?");
		expect(outcome.status).toBe("empty");
		expect(outcome.block).toBeNull();
	});

	it("FAILS OPEN: a backend error never blocks the turn", async () => {
		const { coordinator } = build([{ status: 500, body: { error: "boom" } }]);
		const outcome = await coordinator.recall("q");
		expect(outcome.status).toBe("failed");
		expect(outcome.block).toBeNull();
		expect(outcome.code).toBe("unavailable");
	});

	it("FAILS OPEN: an unreachable backend never blocks the turn", async () => {
		const { coordinator } = build([new Error("ENOTFOUND")]);
		const outcome = await coordinator.recall("q");
		expect(outcome.status).toBe("failed");
		expect(outcome.block).toBeNull();
	});

	it("bounds the query it sends", async () => {
		const { coordinator, requests } = build([{ status: 200, body: { count: 0, context: "" } }]);
		await coordinator.recall("x".repeat(9_000));
		expect(String((requests[0]!.body as { query: string }).query).length).toBeLessThanOrEqual(2_000);
	});

	it("truncates the query on code-point boundaries, never splitting a surrogate pair", async () => {
		const { coordinator, requests } = build([{ status: 200, body: { count: 0, context: "" } }]);
		// 2,500 astral characters: a UTF-16 slice at 2,000 units would cut one in half.
		await coordinator.recall("👍".repeat(2_500));
		const sent = String((requests[0]!.body as { query: string }).query);
		expect(Array.from(sent).length).toBe(2_000);
		// Well-formed: encoding round-trips without a replacement character.
		expect(sent.includes("�")).toBe(false);
		expect(Buffer.from(sent, "utf8").toString("utf8")).toBe(sent);
	});

	it("carries the sub-tenant and never widens it", async () => {
		const { coordinator, requests } = build([{ status: 200, body: { count: 0, context: "" } }], { userId: "alice" });
		await coordinator.recall("q");
		expect((requests[0]!.body as { userId?: string }).userId).toBe("alice");
	});

	it("skips entirely when disabled", async () => {
		const { coordinator, requests } = build([{ status: 200, body: {} }]);
		const disabled = new Coordinator({
			transport: (coordinator as unknown as { transport: ItsukiTransport }).transport,
			spool: new Spool(root),
			scope: { source: "pi" },
			recall: { enabled: false, maxItems: 10, maxChars: 4_000, timeoutMs: 3_000 },
			capture: { enabled: true, timeoutMs: 10_000 },
		});
		expect((await disabled.recall("q")).status).toBe("disabled");
		expect(requests.length).toBe(0);
	});
});

describe("circuit breaker", () => {
	it("opens after repeated failures and stops calling the backend", async () => {
		const { coordinator, requests } = build([{ status: 500, body: {} }]);
		for (let i = 0; i < 3; i += 1) await coordinator.recall("q");
		const before = requests.length;
		const outcome = await coordinator.recall("q");
		expect(outcome.status).toBe("breaker_open");
		expect(requests.length).toBe(before);
	});

	it("opens immediately on an auth failure — a bad key will not fix itself", async () => {
		const { coordinator } = build([{ status: 401, body: { error: "unauthorized" } }]);
		await coordinator.recall("q");
		const health = await coordinator.health();
		expect(health.breaker.open).toBe(true);
		expect(health.breaker.reason).toBe("auth");
	});

	it("closes again once the backend recovers", async () => {
		let failing = true;
		const { coordinator, advance } = build([() => (failing ? { status: 500, body: {} } : { status: 200, body: { count: 0, context: "" } })]);
		for (let i = 0; i < 3; i += 1) await coordinator.recall("q");
		expect((await coordinator.health()).breaker.open).toBe(true);
		advance(61_000);
		failing = false;
		expect((await coordinator.recall("q")).status).toBe("empty");
		expect((await coordinator.health()).breaker.open).toBe(false);
	});
});

describe("capture: exactly-once", () => {
	it("stages then delivers, and reports the receipt", async () => {
		const { coordinator, spool } = build([{ status: 200, body: { ok: true, receipt_id: "r1", source_packet_id: "p1" } }]);
		await coordinator.stage(span("We picked Postgres."));
		expect((await spool.stats()).depth).toBe(1);
		const drained = await coordinator.drain();
		expect(drained.delivered).toBe(1);
		expect((await spool.stats()).depth).toBe(0);
		expect((await coordinator.health()).lastReceiptId).toBe("r1");
	});

	it("stages the same span twice as ONE envelope", async () => {
		const { coordinator, spool } = build([{ status: 200, body: { ok: true, receipt_id: "r1" } }]);
		await coordinator.stage(span("identical"));
		await coordinator.stage(span("identical"));
		expect((await spool.stats()).depth).toBe(1);
	});

	it("sends one request for a replayed span, under a stable key", async () => {
		const { coordinator, requests } = build([{ status: 200, body: { ok: true, receipt_id: "r1" } }]);
		await coordinator.stage(span("identical"));
		await coordinator.stage(span("identical"));
		await coordinator.drain();
		await coordinator.drain();
		expect(requests.length).toBe(1);
		const key = (requests[0]!.body as { idempotencyKey: string }).idempotencyKey;
		expect(key).toMatch(/^pi:v1:[a-f0-9]{64}$/);
	});

	it("survives a crash between staging and delivery", async () => {
		const first = build([{ status: 200, body: { ok: true, receipt_id: "r1" } }]);
		await first.coordinator.stage(span("survives"));
		// Process dies here. A brand-new coordinator over the same directory
		// finds the envelope and delivers it with the identical key.
		const second = build([{ status: 200, body: { ok: true, receipt_id: "r1" } }]);
		const drained = await second.coordinator.drain();
		expect(drained.delivered).toBe(1);
		expect((await second.spool.stats()).depth).toBe(0);
	});

	it("does not double-send when two drains overlap", async () => {
		const { coordinator, requests } = build([{ status: 200, body: { ok: true, receipt_id: "r1" } }]);
		await coordinator.stage(span("concurrent"));
		await Promise.all([coordinator.drain(), coordinator.drain(), coordinator.drain()]);
		expect(requests.length).toBe(1);
	});

	it("splits an oversized span into batches with distinct stable keys", async () => {
		const { coordinator, spool } = build([{ status: 200, body: { ok: true } }]);
		const many: CaptureMessage[] = Array.from({ length: 45 }, (_, i) => ({ role: "user", content: `m${i}` }));
		const staged = await coordinator.stage(many);
		expect(staged.batches).toBe(2);
		expect(new Set(staged.idempotencyKeys).size).toBe(2);
		expect((await spool.stats()).depth).toBe(2);
	});
});

describe("capture: failure handling", () => {
	it("holds the payload when rate limited, then delivers it", async () => {
		let limited = true;
		const { coordinator, spool } = build([() => (limited
			? { status: 429, body: { error: "too_many_requests" }, headers: { "retry-after": "0" } }
			: { status: 200, body: { ok: true, receipt_id: "r1" } })]);
		await coordinator.stage(span("held"));
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(1);
		limited = false;
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(0);
	});

	it("holds — never drops — when the monthly plan is exhausted", async () => {
		const { coordinator, spool } = build([{ status: 429, body: { error: "ai_quota_exhausted" } }]);
		await coordinator.stage(span("valuable"));
		await coordinator.drain();
		const stats = await spool.stats();
		expect(stats.depth).toBe(1);
		expect(stats.dropped).toBe(0);
	});

	it("holds when the key is revoked, so nothing is lost while it is fixed", async () => {
		const { coordinator, spool } = build([{ status: 401, body: { error: "unauthorized" } }]);
		await coordinator.stage(span("valuable"));
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(1);
		expect((await coordinator.health()).breaker.reason).toBe("auth");
	});

	it("drops a payload the server will never accept, and counts it as a real failure", async () => {
		const { coordinator, spool } = build([{ status: 422, body: { message: "invalid" } }]);
		await coordinator.stage(span("malformed"));
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(0);
		expect((await coordinator.health()).terminalFailures).toBe(1);
	});

	it("keeps working offline and delivers everything on recovery", async () => {
		let offline = true;
		const { coordinator, spool } = build([() => {
			if (offline) throw new Error("ENOTFOUND");
			return { status: 200, body: { ok: true, receipt_id: "r1" } };
		}]);
		await coordinator.stage(span("first"));
		await coordinator.stage(span("second"));
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(2);
		offline = false;
		await coordinator.drain();
		expect((await spool.stats()).depth).toBe(0);
	});
});

describe("honesty", () => {
	it("reports no receipt at all when nothing was delivered", async () => {
		const { coordinator } = build([new Error("offline")]);
		await coordinator.stage(span("x"));
		await coordinator.drain();
		expect((await coordinator.health()).lastReceiptId).toBeNull();
	});

	it("never records a receipt the server did not send", async () => {
		const { coordinator } = build([{ status: 200, body: { ok: true } }]);
		await coordinator.stage(span("x"));
		await coordinator.drain();
		expect((await coordinator.health()).lastReceiptId).toBeNull();
	});

	it("logs without ever writing message content or the key", async () => {
		const { coordinator, logs } = build([{ status: 200, body: { ok: true, count: 1, context: "secret memory" } }]);
		await coordinator.recall("my private question");
		await coordinator.stage(span("confidential content"));
		await coordinator.drain();
		const joined = logs.join("\n");
		expect(joined).not.toContain("my private question");
		expect(joined).not.toContain("confidential content");
		expect(joined).not.toContain("secret memory");
		expect(joined).not.toContain(KEY);
	});

	it("surfaces the spool depth and drop count for the doctor", async () => {
		const { coordinator } = build([new Error("offline")]);
		await coordinator.stage(span("x"));
		await coordinator.drain();
		const health = await coordinator.health();
		expect(health.spool.depth).toBe(1);
		expect(health.lastError?.code).toBe("transport");
	});
});

describe("scrub and echo suppression on the capture path", () => {
	it("removes a credential before it can leave the machine", () => {
		const { coordinator } = build([{ status: 200, body: {} }]);
		const out = coordinator.transformCaptured("my key is itsuki_live_abcdefghijklmnop ok", "user");
		expect(out).not.toContain("itsuki_live_abcdefghijklmnop");
	});

	it("drops lines echoed back from what we injected", async () => {
		const { coordinator } = build([{ status: 200, body: { count: 1, context: "The deploy mascot is a teal axolotl." } }]);
		coordinator.setEchoKey("sha256:" + "0".repeat(64));
		await coordinator.recall("mascot?");
		const out = coordinator.transformCaptured("The deploy mascot is a teal axolotl.", "assistant");
		expect(out).toBe("");
	});
});
