/**
 * Real Mastra Agent, real processors, real tools.
 *
 * Nothing here simulates the host: an Agent is constructed with the processors
 * attached the way an application would attach them, and the assertions look
 * at what the model actually received and what actually went over the wire.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "@mastra/core/agent";

import { createItsuki } from "../src/index.js";
import { RECALL_OPEN_MARKER, RECALL_PREAMBLE } from "../src/kernel/inject.js";
import {
	config,
	mockModel,
	scriptedApi,
	saveCalls,
	recallCalls,
	flushMicrotasks,
	fakeFetch,
	json,
} from "./helpers.js";

const MEMORY = "Ziyad has been learning Kotlin since March 2026.";

function agentWith(
	itsuki: ReturnType<typeof createItsuki>,
	text: string,
	capture?: (options: any) => void,
) {
	return new Agent({
		id: "support",
		name: "support",
		instructions: "You help customers.",
		model: mockModel(text, capture) as never,
		inputProcessors: [itsuki.recall],
		outputProcessors: [itsuki.capture],
	});
}

function systemTextOf(options: any): string {
	return (options?.prompt ?? [])
		.filter((message: any) => message.role === "system")
		.map((message: any) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((part: any) => part.text ?? "").join("\n"))
		.join("\n");
}

describe("agent lifecycle", () => {
	it("injects recalled memory before the model is called", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "You are learning Kotlin.", (options) => { seen = options; });

		const result = await agent.generate("What am I learning?");

		expect(result.text).toBe("You are learning Kotlin.");
		const system = systemTextOf(seen);
		expect(system).toContain(MEMORY);
		expect(system).toContain(RECALL_OPEN_MARKER);
		expect(system).toContain(RECALL_PREAMBLE);
	});

	it("keeps the agent's own instructions alongside the memory block", async () => {
		const api = scriptedApi({ context: MEMORY });
		let seen: any;
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "ok", (options) => { seen = options; });

		await agent.generate("hello there");

		const system = systemTextOf(seen);
		expect(system).toContain("You help customers.");
		expect(system).toContain(MEMORY);
	});

	it("asks recall about the user's latest message", async () => {
		const api = scriptedApi({ context: MEMORY });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));

		await agentWith(itsuki, "ok").generate("What am I learning?");

		const recalls = recallCalls(api.calls);
		expect(recalls).toHaveLength(1);
		expect(recalls[0]!.body!["query"]).toBe("What am I learning?");
		expect(recalls[0]!.body!["userId"]).toBe("u_test");
	});

	it("captures the settled exchange after the answer", async () => {
		const api = scriptedApi({ context: "" });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));

		await agentWith(itsuki, "Kotlin it is.").generate("I started Kotlin");
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1);
		expect(saves[0]!.body!["mode"]).toBe("conversation");
		expect(saves[0]!.body!["messages"]).toEqual([
			{ role: "user", content: "I started Kotlin" },
			{ role: "assistant", content: "Kotlin it is." },
		]);
		expect(saves[0]!.body!["source"]).toBe("mastra");
		expect(String(saves[0]!.body!["idempotencyKey"])).toMatch(/^idem_[0-9a-f]{64}$/);
	});

	it("answers normally when memory is unreachable", async () => {
		const api = fakeFetch(() => { throw new Error("dns exploded"); });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch, maxRetries: 0 }));

		const result = await agentWith(itsuki, "still works").generate("hi there");

		expect(result.text).toBe("still works");
	});

	it("answers normally when memory rejects the key", async () => {
		const api = fakeFetch(() => json(401, { error: "unauthorized" }));
		const events: string[] = [];
		const itsuki = createItsuki(config({
			fetchImpl: api.fetch,
			onEvent: (event) => events.push(event.type),
		}));

		const result = await agentWith(itsuki, "still works").generate("hi there");

		expect(result.text).toBe("still works");
		expect(events).toContain("recall.fail");
	});

	it("produces the same answer with and without memory attached", async () => {
		const api = scriptedApi({ context: MEMORY });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));

		const plain = await new Agent({
			id: "plain",
			name: "plain",
			instructions: "You help customers.",
			model: mockModel("identical") as never,
		}).generate("hi there");
		const wrapped = await agentWith(itsuki, "identical").generate("hi there");

		expect(wrapped.text).toBe(plain.text);
		expect(wrapped.finishReason).toEqual(plain.finishReason);
	});
});

describe("tenancy", () => {
	it("writes to the resource the run belongs to, not the default", async () => {
		const api = scriptedApi({ context: "" });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "noted");

		await agent.generate("remember this", {
			memory: { resource: "u_real", thread: "thread_7" },
		} as never);
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1);
		expect(saves[0]!.body!["userId"]).toBe("u_real");
		expect(saves[0]!.body!["conversationId"]).toBe("thread_7");
	});

	it("keeps two users' runs apart", async () => {
		const api = scriptedApi({ context: "" });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "noted");

		await agent.generate("first speaking", { memory: { resource: "u_one", thread: "t1" } } as never);
		await agent.generate("second speaking", { memory: { resource: "u_two", thread: "t2" } } as never);
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(2);
		const byUser = Object.fromEntries(saves.map((call) => [
			call.body!["userId"],
			(call.body!["messages"] as Array<{ content: string }>)[0]!.content,
		]));
		expect(byUser["u_one"]).toBe("first speaking");
		expect(byUser["u_two"]).toBe("second speaking");
	});

	it("skips rather than guessing when no identity exists at all", async () => {
		const api = scriptedApi({ context: MEMORY });
		const events: string[] = [];
		const itsuki = createItsuki(config({
			fetchImpl: api.fetch,
			defaultUserId: undefined,
			onEvent: (event) => events.push(`${event.type}:${(event as { reason?: string }).reason ?? ""}`),
		}));

		const result = await agentWith(itsuki, "answered anyway").generate("hi there");

		expect(result.text).toBe("answered anyway");
		expect(recallCalls(api.calls)).toHaveLength(0);
		expect(saveCalls(api.calls)).toHaveLength(0);
		expect(events).toContain("recall.skipped:no_identity");
	});
});

describe("exactly-once", () => {
	it("derives one key for one exchange, however often it is retried", async () => {
		const api = scriptedApi({ context: "" });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "noted");

		await agent.generate("I started boxing", { memory: { resource: "u", thread: "t" } } as never);
		await agent.generate("I started boxing", { memory: { resource: "u", thread: "t" } } as never);
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(2);
		expect(saves[0]!.body!["idempotencyKey"]).toBe(saves[1]!.body!["idempotencyKey"]);
	});

	it("separates the same sentence in two threads", async () => {
		const api = scriptedApi({ context: "" });
		const itsuki = createItsuki(config({ fetchImpl: api.fetch }));
		const agent = agentWith(itsuki, "noted");

		await agent.generate("I started boxing", { memory: { resource: "u", thread: "t1" } } as never);
		await agent.generate("I started boxing", { memory: { resource: "u", thread: "t2" } } as never);
		await flushMicrotasks();

		const saves = saveCalls(api.calls);
		expect(saves[0]!.body!["idempotencyKey"]).not.toBe(saves[1]!.body!["idempotencyKey"]);
	});
});
