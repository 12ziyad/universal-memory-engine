/**
 * Scale and isolation, at the size the product is sold at.
 *
 * One thousand identities through one process is not a load test — the fake
 * transport answers instantly. It is an ISOLATION test at a size where a
 * shared-state bug actually shows up: a module-level "current call" variable,
 * a cached config, a reused idempotency key. Those defects are invisible at
 * n=2 and obvious at n=1000, and they are exactly the class of bug that turns
 * into one user reading another user's memory.
 */

import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { withItsuki } from "../src/index.js";
import { config, fakeFetch, json, saveCalls, recallCalls } from "./helpers.js";

function echoModel() {
	return new MockLanguageModelV4({
		doGenerate: async (options: any) => {
			// Answer with the user's own text so a crossed tenancy is visible in
			// the captured pair rather than having to be inferred.
			const user = options.prompt.filter((m: any) => m.role === "user").at(-1);
			const text = user?.content?.map((p: any) => p.text ?? "").join("") ?? "";
			return {
				content: [{ type: "text" as const, text: `ack ${text}` }],
				finishReason: "stop" as const,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				warnings: [],
			};
		},
	});
}

describe("one thousand identities through one process", () => {
	it("never crosses a tenant, and never reuses a key across tenants", async () => {
		const api = fakeFetch((call) =>
			call.url.endsWith("/v1/recall")
				? json(200, { ok: true, context: "", count: 0 })
				: json(200, { ok: true, source_packet_id: "pkt" }));

		// One wrapped model shared by every user, which is how a real server
		// would do it — and the arrangement that punishes shared state.
		const model = withItsuki(echoModel(), config({
			fetchImpl: api.fetch,
			capture: "blocking",
			userId: "u_default",
		}));

		const users = Array.from({ length: 1_000 }, (_, i) => `u_${i}`);
		await Promise.all(users.map((userId) =>
			generateText({
				model,
				prompt: `fact for ${userId}`,
				providerOptions: { itsuki: { userId, conversationId: `c_${userId}` } },
			})));

		const saves = saveCalls(api.calls);
		expect(saves).toHaveLength(1_000);

		const keys = new Set<string>();
		for (const save of saves) {
			const body = save.body!;
			const messages = body["messages"] as Array<{ role: string; content: string }>;
			const userId = String(body["userId"]);
			// The captured exchange must belong to the user it was written for.
			expect(messages[0]!.content).toBe(`fact for ${userId}`);
			expect(messages[1]!.content).toBe(`ack fact for ${userId}`);
			expect(body["conversationId"]).toBe(`c_${userId}`);
			keys.add(String(body["idempotencyKey"]));
		}
		// 1000 distinct tenants, 1000 distinct keys: no collision, no reuse.
		expect(keys.size).toBe(1_000);
		expect(new Set(saves.map((s) => String(s.body!["userId"]))).size).toBe(1_000);
	});

	it("asks recall about the right user every time", async () => {
		const api = fakeFetch((call) =>
			call.url.endsWith("/v1/recall")
				? json(200, { ok: true, context: "", count: 0 })
				: json(200, { ok: true, source_packet_id: "pkt" }));
		const model = withItsuki(echoModel(), config({
			fetchImpl: api.fetch,
			capture: "off",
			userId: "u_default",
		}));

		const users = Array.from({ length: 250 }, (_, i) => `u_${i}`);
		await Promise.all(users.map((userId) =>
			generateText({
				model,
				prompt: `question from ${userId}`,
				providerOptions: { itsuki: { userId } },
			})));

		const pairs = recallCalls(api.calls).map((call) =>
			[String(call.body!["query"]), String(call.body!["userId"])] as const);
		expect(pairs).toHaveLength(250);
		for (const [query, userId] of pairs) {
			expect(query).toBe(`question from ${userId}`);
		}
	});

	it("keeps working when a fraction of calls fail", async () => {
		// Every seventh write fails: the successes must still be correct and
		// the failures must not take a turn down with them.
		let writes = 0;
		const api = fakeFetch((call) => {
			if (call.url.endsWith("/v1/recall")) return json(200, { ok: true, context: "", count: 0 });
			writes += 1;
			return writes % 7 === 0
				? json(503, { error: "unavailable" })
				: json(200, { ok: true, source_packet_id: "pkt" });
		});
		const model = withItsuki(echoModel(), config({
			fetchImpl: api.fetch,
			capture: "blocking",
			maxRetries: 0,
			userId: "u_default",
		}));

		const results = await Promise.all(
			Array.from({ length: 200 }, (_, i) =>
				generateText({
					model,
					prompt: `fact ${i}`,
					providerOptions: { itsuki: { userId: `u_${i}` } },
				})));

		// Every turn succeeded even though roughly a seventh of the writes did not.
		expect(results).toHaveLength(200);
		for (const [index, result] of results.entries()) {
			expect(result.text).toBe(`ack fact ${index}`);
		}
	});
});
