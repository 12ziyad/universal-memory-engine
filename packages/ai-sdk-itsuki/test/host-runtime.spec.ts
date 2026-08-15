/**
 * Real AI SDK, real generateText/streamText, real middleware composition.
 *
 * These are the tests that would catch a spec change: nothing here inspects
 * our own source, and nothing simulates the SDK. A MockLanguageModelV4 stands
 * in for a provider so the assertions can look at exactly what a provider
 * would have received and exactly what the caller gets back.
 */

import { describe, it, expect } from "vitest";
import { generateText, streamText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { withItsuki, createItsuki, itsukiMiddleware } from "../src/index.js";
import { RECALL_OPEN_MARKER, RECALL_PREAMBLE } from "../src/kernel/inject.js";
import { config, scriptedApi, saveCalls, recallCalls, flushMicrotasks, json, fakeFetch } from "./helpers.js";

const MEMORY = "Ziyad has been learning Kotlin since March 2026.";

function textModel(text: string, capture?: (options: unknown) => void) {
	return new MockLanguageModelV4({
		doGenerate: async (options) => {
			capture?.(options);
			return {
				content: [{ type: "text", text }],
				finishReason: "stop" as const,
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				warnings: [],
			};
		},
	});
}

function streamModel(chunks: string[], capture?: (options: unknown) => void) {
	return new MockLanguageModelV4({
		doStream: async (options) => {
			capture?.(options);
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start" as const, id: "1" },
						...chunks.map((delta) => ({ type: "text-delta" as const, id: "1", delta })),
						{ type: "text-end" as const, id: "1" },
						{
							type: "finish" as const,
							finishReason: "stop" as const,
							usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
						},
					],
				}),
			};
		},
	});
}

describe("generateText", () => {
	it("puts recalled memory in front of the model, wrapped as data", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const model = withItsuki(
			textModel("You are learning Kotlin.", (options) => { seen = options; }),
			config({ fetchImpl: api.fetch }),
		);

		const result = await generateText({ model, prompt: "What am I learning?" });

		expect(result.text).toBe("You are learning Kotlin.");
		const system = seen.prompt.find((m: any) => m.role === "system");
		expect(system).toBeDefined();
		expect(system.content).toContain(MEMORY);
		expect(system.content).toContain(RECALL_OPEN_MARKER);
		expect(system.content).toContain(RECALL_PREAMBLE);
	});

	it("asks recall about the user's latest message", async () => {
		const api = scriptedApi({ context: MEMORY });
		const model = withItsuki(textModel("ok"), config({ fetchImpl: api.fetch }));

		await generateText({ model, prompt: "What am I learning?" });

		const recall = recallCalls(api.calls);
		expect(recall).toHaveLength(1);
		expect(recall[0]!.body!["query"]).toBe("What am I learning?");
		expect(recall[0]!.body!["userId"]).toBe("u_test");
	});

	it("captures the settled exchange, both sides", async () => {
		const api = scriptedApi({ context: "" });
		const model = withItsuki(textModel("Kotlin it is."), config({ fetchImpl: api.fetch }));

		await generateText({ model, prompt: "I started Kotlin" });

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1);
		const body = saves[0]!.body!;
		expect(body["mode"]).toBe("conversation");
		expect(body["messages"]).toEqual([
			{ role: "user", content: "I started Kotlin" },
			{ role: "assistant", content: "Kotlin it is." },
		]);
		expect(String(body["idempotencyKey"])).toMatch(/^idem_[0-9a-f]{64}$/);
		expect(body["source"]).toBe("ai-sdk");
	});

	it("preserves an existing system prompt instead of replacing it", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const model = withItsuki(
			textModel("ok", (options) => { seen = options; }),
			config({ fetchImpl: api.fetch }),
		);

		await generateText({ model, system: "You are terse.", prompt: "hi there" });

		const systems = seen.prompt.filter((m: any) => m.role === "system");
		expect(systems).toHaveLength(1);
		expect(systems[0].content).toContain("You are terse.");
		expect(systems[0].content).toContain(MEMORY);
	});

	it("returns a result identical to the unwrapped model's", async () => {
		// Asserting specific field values would only pin this test to one AI SDK
		// result shape. What actually matters is that wrapping changes nothing,
		// so the wrapped and unwrapped results are compared to each other.
		const api = scriptedApi({ context: MEMORY });
		const plain = await generateText({ model: textModel("ok"), prompt: "hi there" });
		const wrapped = await generateText({
			model: withItsuki(textModel("ok"), config({ fetchImpl: api.fetch })),
			prompt: "hi there",
		});

		expect(wrapped.text).toBe(plain.text);
		expect(wrapped.finishReason).toEqual(plain.finishReason);
		expect(wrapped.usage).toEqual(plain.usage);
		expect(wrapped.totalUsage).toEqual(plain.totalUsage);
		expect(wrapped.warnings).toEqual(plain.warnings);
		expect(wrapped.content).toEqual(plain.content);
		expect(wrapped.toolCalls).toEqual(plain.toolCalls);
		expect(wrapped.providerMetadata).toEqual(plain.providerMetadata);
		expect(wrapped.reasoning).toEqual(plain.reasoning);
	});

	it("streams exactly the same parts as the unwrapped model", async () => {
		const api = scriptedApi({ context: MEMORY });
		// Response ids, timestamps and timing measurements are minted per run;
		// everything else must match part for part, in order.
		const VOLATILE = /Ms$|^(avg|max|median|min|p10|p90)$/;
		const stable = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stable);
			if (value && typeof value === "object") {
				if (value instanceof Date) return "<date>";
				return Object.fromEntries(
					Object.entries(value as Record<string, unknown>).map(([key, item]) => {
						if (key === "id" && typeof item === "string" && item.startsWith("aitxt-")) {
							return [key, "<generated-id>"];
						}
						if (VOLATILE.test(key) && typeof item === "number") return [key, "<timing>"];
						return [key, stable(item)];
					}),
				);
			}
			return value;
		};
		const collect = async (model: Parameters<typeof streamText>[0]["model"]) => {
			const result = streamText({ model, prompt: "hi there" });
			const parts: unknown[] = [];
			for await (const part of result.fullStream) parts.push(stable(part));
			return parts;
		};

		const plain = await collect(streamModel(["a", "b"]));
		const wrapped = await collect(
			withItsuki(streamModel(["a", "b"]), config({ fetchImpl: api.fetch })),
		);

		expect(wrapped).toEqual(plain);
	});

	it("answers normally when memory is unreachable", async () => {
		const api = fakeFetch((call) => {
			if (call.url.endsWith("/v1/recall")) throw new Error("dns exploded");
			return json(200, { ok: true, source_packet_id: "pkt" });
		});
		const model = withItsuki(textModel("still works"), config({ fetchImpl: api.fetch, maxRetries: 0 }));

		const result = await generateText({ model, prompt: "hi there" });

		expect(result.text).toBe("still works");
	});

	it("answers normally when memory rejects the key", async () => {
		const api = fakeFetch(() => json(401, { error: "unauthorized" }));
		const events: string[] = [];
		const model = withItsuki(
			textModel("still works"),
			config({ fetchImpl: api.fetch, onEvent: (e) => events.push(e.type) }),
		);

		const result = await generateText({ model, prompt: "hi there" });

		expect(result.text).toBe("still works");
		expect(events).toContain("recall.fail");
		expect(events).toContain("capture.fail");
	});
});

describe("tool calls and structured output", () => {
	it("passes tool calls through and does not capture a tool-only step", async () => {
		const api = scriptedApi({ context: "" });
		let step = 0;
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				step += 1;
				if (step === 1) {
					return {
						content: [{
							type: "tool-call" as const,
							toolCallId: "call-1",
							toolName: "weather",
							input: JSON.stringify({ city: "Oslo" }),
						}],
						finishReason: "tool-calls" as const,
						usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
						warnings: [],
					};
				}
				return {
					content: [{ type: "text" as const, text: "It is cold in Oslo." }],
					finishReason: "stop" as const,
					usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
					warnings: [],
				};
			},
		});

		const result = await generateText({
			model: withItsuki(model, config({ fetchImpl: api.fetch })),
			prompt: "What is the weather in Oslo?",
			tools: {
				weather: tool({
					description: "Get weather",
					inputSchema: z.object({ city: z.string() }),
					execute: async ({ city }) => `cold in ${city}`,
				}),
			},
			stopWhen: stepCountIs(3),
		});

		expect(result.text).toBe("It is cold in Oslo.");
		expect(result.steps.length).toBe(2);
		// Two model calls, but only the step that produced prose is a settled
		// exchange worth remembering.
		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1);
		expect((saves[0]!.body!["messages"] as any[])[1].content).toBe("It is cold in Oslo.");
	});

	it("leaves the tool definitions the provider receives alone", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const model = withItsuki(
			textModel("ok", (options) => { seen = options; }),
			config({ fetchImpl: api.fetch }),
		);

		await generateText({
			model,
			prompt: "hello there",
			tools: {
				weather: tool({
					description: "Get weather",
					inputSchema: z.object({ city: z.string() }),
					execute: async () => "cold",
				}),
			},
		});

		expect(seen.tools).toHaveLength(1);
		expect(seen.tools[0].name).toBe("weather");
	});
});

describe("streamText", () => {
	it("streams every chunk through untouched", async () => {
		const api = scriptedApi({ context: MEMORY });
		const model = withItsuki(
			streamModel(["Kot", "lin ", "is ", "fun."]),
			config({ fetchImpl: api.fetch }),
		);

		const result = streamText({ model, prompt: "tell me about kotlin" });
		const chunks: string[] = [];
		for await (const delta of result.textStream) chunks.push(delta);

		expect(chunks.join("")).toBe("Kotlin is fun.");
		expect(await result.text).toBe("Kotlin is fun.");
	});

	it("captures once, after the stream settles", async () => {
		const api = scriptedApi({ context: "" });
		const model = withItsuki(
			streamModel(["All ", "done."]),
			config({ fetchImpl: api.fetch, capture: "background" }),
		);

		const result = streamText({ model, prompt: "are we done" });
		for await (const _ of result.textStream) { /* drain */ }
		await result.text;
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1);
		expect(saves[0]!.body!["messages"]).toEqual([
			{ role: "user", content: "are we done" },
			{ role: "assistant", content: "All done." },
		]);
	});

	it("injects memory into a streamed call too", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const model = withItsuki(
			streamModel(["ok"], (options) => { seen = options; }),
			config({ fetchImpl: api.fetch }),
		);

		const result = streamText({ model, prompt: "what am I learning" });
		for await (const _ of result.textStream) { /* drain */ }

		expect(seen.prompt.find((m: any) => m.role === "system").content).toContain(MEMORY);
	});

	it("captures nothing when the caller aborts the run", async () => {
		const api = scriptedApi({ context: "" });
		const controller = new AbortController();
		const model = withItsuki(
			streamModel(["one ", "two ", "three ", "four"]),
			config({ fetchImpl: api.fetch, capture: "background" }),
		);

		const result = streamText({
			model,
			prompt: "count for me",
			abortSignal: controller.signal,
		});
		const reader = result.textStream.getReader();
		await reader.read();
		controller.abort();
		try {
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch {
			// An aborted run surfaces to the caller; that is the host's business.
		}
		await flushMicrotasks();

		expect(saveCalls(api.calls)).toHaveLength(0);
	});

	it("still captures when the consumer stops reading but the model finishes", async () => {
		// Dropping the textStream does not abort the model call — streamText
		// keeps consuming so result.text still resolves. The exchange really did
		// settle, so remembering it is correct, and this pins that distinction
		// against the abort case above.
		const api = scriptedApi({ context: "" });
		const model = withItsuki(
			streamModel(["all ", "done"]),
			config({ fetchImpl: api.fetch, capture: "background" }),
		);

		const result = streamText({ model, prompt: "count for me" });
		const reader = result.textStream.getReader();
		await reader.read();
		await reader.cancel();
		await result.text;
		await flushMicrotasks();

		expect(saveCalls(api.calls)).toHaveLength(1);
	});

	it("captures nothing when the model streams an error", async () => {
		const api = scriptedApi({ context: "" });
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start" as const, id: "1" },
						{ type: "text-delta" as const, id: "1", delta: "partial" },
						{ type: "error" as const, error: new Error("provider blew up") },
					],
				}),
			}),
		});
		const events: string[] = [];
		const wrapped = withItsuki(model, config({
			fetchImpl: api.fetch,
			capture: "background",
			onEvent: (e) => events.push(e.type),
		}));

		const result = streamText({ model: wrapped, prompt: "please fail" });
		try {
			for await (const _ of result.textStream) { /* drain */ }
		} catch {
			// streamText surfaces the provider error; that is the host's business.
		}
		await flushMicrotasks();

		expect(saveCalls(api.calls)).toHaveLength(0);
		expect(events).toContain("capture.skipped");
	});
});

describe("middleware composition", () => {
	it("works alongside other middleware in one chain", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const observed: string[] = [];

		const model = wrapLanguageModel({
			model: textModel("composed", (options) => { seen = options; }),
			middleware: [
				itsukiMiddleware(config({ fetchImpl: api.fetch })),
				{
					specificationVersion: "v4" as const,
					transformParams: async ({ params }: any) => {
						observed.push("other-middleware-ran");
						return params;
					},
				},
			],
		});

		const result = await generateText({ model, prompt: "hello there" });

		expect(result.text).toBe("composed");
		expect(observed).toEqual(["other-middleware-ran"]);
		expect(seen.prompt.find((m: any) => m.role === "system").content).toContain(MEMORY);
	});

	it("exposes the same behaviour through createItsuki().wrap", async () => {
		const api = scriptedApi({ context: MEMORY });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const model = itsuki.wrap(textModel("ok"));

		await generateText({ model, prompt: "what am I learning" });

		expect(recallCalls(api.calls)).toHaveLength(1);
	});
});

describe("per-call overrides", () => {
	it("routes a call to a different end user without a new model", async () => {
		const api = scriptedApi({ context: MEMORY });
		const model = withItsuki(textModel("ok"), config({ fetchImpl: api.fetch }));

		await generateText({
			model,
			prompt: "what am I learning",
			providerOptions: { itsuki: { userId: "u_other", conversationId: "conv_other" } },
		});

		expect(recallCalls(api.calls)[0]!.body!["userId"]).toBe("u_other");
		expect(saveCalls(api.calls)[0]!.body!["userId"]).toBe("u_other");
		expect(saveCalls(api.calls)[0]!.body!["conversationId"]).toBe("conv_other");
	});

	it("does not leak the itsuki namespace to the provider", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const model = withItsuki(
			textModel("ok", (options) => { seen = options; }),
			config({ fetchImpl: api.fetch }),
		);

		await generateText({
			model,
			prompt: "hello there",
			providerOptions: { itsuki: { userId: "u_other" }, openai: { store: true } },
		});

		expect(seen.providerOptions?.itsuki).toBeUndefined();
		expect(seen.providerOptions?.openai).toEqual({ store: true });
	});

	it("can disable capture for one call", async () => {
		const api = scriptedApi({ context: "" });
		const model = withItsuki(textModel("ok"), config({ fetchImpl: api.fetch }));

		await generateText({
			model,
			prompt: "do not remember this",
			providerOptions: { itsuki: { capture: "off" } },
		});

		expect(saveCalls(api.calls)).toHaveLength(0);
	});

	it("can disable recall for one call", async () => {
		const api = scriptedApi({ context: MEMORY });
		const model = withItsuki(textModel("ok"), config({ fetchImpl: api.fetch }));

		await generateText({
			model,
			prompt: "answer cold",
			providerOptions: { itsuki: { recall: false } },
		});

		expect(recallCalls(api.calls)).toHaveLength(0);
	});
});
