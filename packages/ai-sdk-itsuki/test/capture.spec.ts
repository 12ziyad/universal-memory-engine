/**
 * Capture semantics: exactly once, scrubbed, bounded, and never a duplicate.
 *
 * The exactly-once tests here are the ones that matter at scale. A memory
 * system that stores an exchange twice does not merely waste a row — it
 * doubles the weight of whatever it duplicated, and recall starts insisting
 * on it.
 */

import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { withItsuki } from "../src/index.js";
import { ItsukiMemory } from "../src/kernel/memory.js";
import { resolveConfig } from "../src/config.js";
import { settledExchange } from "../src/messages.js";
import { config, scriptedApi, saveCalls, fakeFetch, json, flushMicrotasks, TEST_KEY, BASE_URL } from "./helpers.js";

function model(text: string) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text }],
			finishReason: "stop" as const,
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			warnings: [],
		}),
	});
}

describe("exactly-once capture", () => {
	it("derives the same key when the same exchange is captured twice", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("Noted."), config({ fetchImpl: api.fetch }));

		await generateText({ model: wrapped, prompt: "I started boxing" });
		await generateText({ model: wrapped, prompt: "I started boxing" });

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(2);
		expect(saves[0]!.body!["idempotencyKey"]).toBe(saves[1]!.body!["idempotencyKey"]);
	});

	it("gives different exchanges different keys", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("Noted."), config({ fetchImpl: api.fetch }));

		await generateText({ model: wrapped, prompt: "I started boxing" });
		await generateText({ model: wrapped, prompt: "I started swimming" });

		const saves = saveCalls(api.calls);
		expect(saves[0]!.body!["idempotencyKey"]).not.toBe(saves[1]!.body!["idempotencyKey"]);
	});

	it("keeps the same key across a transport retry storm", async () => {
		let attempts = 0;
		const api = fakeFetch((call) => {
			if (call.url.endsWith("/v1/recall")) return json(200, { ok: true, context: "" });
			attempts += 1;
			return attempts < 3
				? json(503, { error: "unavailable" })
				: json(200, { ok: true, source_packet_id: "pkt" });
		});
		const wrapped = withItsuki(model("Noted."), config({ fetchImpl: api.fetch, maxRetries: 3 }));

		await generateText({ model: wrapped, prompt: "I started boxing" });

		const keys = new Set(saveCalls(api.calls).map((call) => call.body!["idempotencyKey"]));
		expect(saveCalls(api.calls).length).toBe(3);
		expect(keys.size).toBe(1);
	});

	it("separates two users who say exactly the same thing", async () => {
		const api = scriptedApi({ context: "" });
		const a = withItsuki(model("Noted."), config({ fetchImpl: api.fetch, userId: "u_a" }));
		const b = withItsuki(model("Noted."), config({ fetchImpl: api.fetch, userId: "u_b" }));

		await generateText({ model: a, prompt: "I started boxing" });
		await generateText({ model: b, prompt: "I started boxing" });

		const saves = saveCalls(api.calls);
		expect(saves[0]!.body!["userId"]).toBe("u_a");
		expect(saves[1]!.body!["userId"]).toBe("u_b");
		expect(saves[0]!.body!["idempotencyKey"]).not.toBe(saves[1]!.body!["idempotencyKey"]);
	});
});

describe("what settles", () => {
	const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];

	it("needs both sides of the exchange", () => {
		expect(settledExchange(prompt, "answer")).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "answer" },
		]);
		expect(settledExchange(prompt, "")).toEqual([]);
		expect(settledExchange(prompt, "   ")).toEqual([]);
	});

	it("captures nothing when there is no user turn to attribute to", () => {
		const systemOnly = [{ role: "system" as const, content: "summarize" }];
		expect(settledExchange(systemOnly, "a summary")).toEqual([]);
	});

	it("never stores an injected memory block back as an answer", () => {
		const echoed = "<itsuki-recalled-context-v1>\nold memory\n</itsuki-recalled-context-v1>\nreal answer";
		expect(settledExchange(prompt, echoed)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "real answer" },
		]);
	});
});

describe("scrubbing before storage", () => {
	it("redacts a credential the user pasted", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("Got it."), config({ fetchImpl: api.fetch }));

		await generateText({ model: wrapped, prompt: `my key is ${TEST_KEY} keep it safe` });

		const body = JSON.stringify(saveCalls(api.calls)[0]!.body);
		expect(body).not.toContain(TEST_KEY);
		expect(body).toContain("REDACTED");
	});

	it("redacts a credential the assistant repeated", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(
			model(`Your key ${TEST_KEY} is stored.`),
			config({ fetchImpl: api.fetch }),
		);

		await generateText({ model: wrapped, prompt: "what is my key" });

		expect(JSON.stringify(saveCalls(api.calls)[0]!.body)).not.toContain(TEST_KEY);
	});
});

describe("capture modes", () => {
	it("blocking mode has staged before the call returns", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("ok"), config({ fetchImpl: api.fetch, capture: "blocking" }));

		await generateText({ model: wrapped, prompt: "remember this" });

		expect(saveCalls(api.calls)).toHaveLength(1);
	});

	it("off mode never writes", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("ok"), config({ fetchImpl: api.fetch, capture: "off" }));

		await generateText({ model: wrapped, prompt: "do not remember" });
		await flushMicrotasks();

		expect(saveCalls(api.calls)).toHaveLength(0);
	});

	it("hands a background capture to waitUntil when the platform provides one", async () => {
		const api = scriptedApi({ context: "" });
		const handed: Promise<unknown>[] = [];
		const wrapped = withItsuki(model("ok"), config({
			fetchImpl: api.fetch,
			capture: "background",
			waitUntil: (promise) => handed.push(promise),
		}));

		await generateText({ model: wrapped, prompt: "remember this" });
		expect(handed).toHaveLength(1);
		await Promise.all(handed);
		expect(saveCalls(api.calls)).toHaveLength(1);
	});

	it("still captures when waitUntil throws outside a request scope", async () => {
		const api = scriptedApi({ context: "" });
		const wrapped = withItsuki(model("ok"), config({
			fetchImpl: api.fetch,
			capture: "background",
			waitUntil: () => { throw new Error("no request scope"); },
		}));

		await generateText({ model: wrapped, prompt: "remember this" });
		await flushMicrotasks();

		expect(saveCalls(api.calls)).toHaveLength(1);
	});
});

describe("oversized input", () => {
	it("splits rather than dropping, and keys each batch distinctly", async () => {
		const api = scriptedApi({ context: "" });
		const resolved = resolveConfig(config({ fetchImpl: api.fetch }));
		const memory = new ItsukiMemory(resolved);

		const many = Array.from({ length: 70 }, (_, i) => ({
			role: "user" as const,
			content: `fact number ${i}`,
		}));
		const outcome = await memory.capture(many, resolved);

		expect(outcome.staged).toBe(true);
		const saves = saveCalls(api.calls);
		expect(saves.length).toBeGreaterThan(1);
		const keys = new Set(saves.map((call) => call.body!["idempotencyKey"]));
		expect(keys.size).toBe(saves.length);
		expect(saves.flatMap((call) => call.body!["messages"] as unknown[])).toHaveLength(70);
	});

	it("clamps a single enormous message instead of failing the write", async () => {
		const api = scriptedApi({ context: "" });
		const resolved = resolveConfig(config({ fetchImpl: api.fetch }));
		const memory = new ItsukiMemory(resolved);

		await memory.capture([{ role: "user", content: "x".repeat(50_000) }], resolved);

		const sent = (saveCalls(api.calls)[0]!.body!["messages"] as Array<{ content: string }>)[0]!;
		expect(sent.content.length).toBeLessThanOrEqual(4_000);
		expect(sent.content).toContain("truncated");
	});
});

describe("failure handling", () => {
	it("reports a capture failure through the event hook and returns cleanly", async () => {
		const events: Array<{ type: string }> = [];
		const api = fakeFetch((call) =>
			call.url.endsWith("/v1/recall")
				? json(200, { ok: true, context: "" })
				: json(500, { error: "boom" }));
		const resolved = resolveConfig(config({
			fetchImpl: api.fetch,
			maxRetries: 0,
			onEvent: (event) => events.push(event),
		}));
		const memory = new ItsukiMemory(resolved);

		const outcome = await memory.capture([{ role: "user", content: "hello" }], resolved);

		expect(outcome.staged).toBe(false);
		expect(outcome.failed).toBe(true);
		expect(events.map((e) => e.type)).toContain("capture.fail");
	});

	it("emits only content-free telemetry", async () => {
		const events: Array<Record<string, unknown>> = [];
		const api = scriptedApi({ context: "Ziyad prefers dark mode." });
		const wrapped = withItsuki(model("secret answer text"), config({
			fetchImpl: api.fetch,
			onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
		}));

		await generateText({ model: wrapped, prompt: "a private question about money" });

		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("private question");
		expect(serialized).not.toContain("secret answer text");
		expect(serialized).not.toContain("dark mode");
		expect(serialized).not.toContain(TEST_KEY);
		expect(serialized).not.toContain(BASE_URL);
	});
});
