/**
 * Multi-provider accounting extension (migration 0052, Phase 0A).
 *
 * Three things this proves:
 *
 *   1. The meter records provider/capability/call_role metadata when a caller
 *      supplies it, and records NULLs — never guesses — when it doesn't. A
 *      NULL provider reads as "workers-ai", a NULL call_role as "primary".
 *   2. Failures carry a coarse, content-free error class. An adapter may
 *      pre-classify via error.aiErrorClass; nothing from the message content
 *      beyond known marker words is ever inspected.
 *   3. The playground_chat quota scope — published in GET /v1/limits since
 *      migration 0021 but never actually recorded before this change — now
 *      produces countable rows: one DISTINCT scope_id per turn.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	flushAiMeter,
	runAi,
	tagAiMeter,
	withAiMeter,
	withFlushedAiMeter,
} from "../src/lib/ai_meter.js";
import { countWritesThisMonth } from "../src/lib/ai_budget.js";

function fakeAi(response) {
	return { AI: { run: async () => {
		if (response instanceof Error) throw response;
		return response;
	} } };
}

const okResponse = { response: "ok", usage: { prompt_tokens: 5, completion_tokens: 7 } };

async function lastCallRow(userId) {
	return env.DB.prepare(
		`SELECT * FROM ai_calls WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
	).bind(userId).first();
}

describe("provider metadata on the meter record", () => {
	it("records what the caller declares, and nulls when it declares nothing", async () => {
		const meter = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, {
				task: "extract",
				capability: "generate_structured",
				provider: "workers-ai",
				callRole: "primary",
				retryCount: 0,
			});
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, { task: "legacy" });
			return m;
		});
		expect(meter.calls[0]).toMatchObject({
			provider: "workers-ai",
			capability: "generate_structured",
			call_role: "primary",
			retry_count: 0,
			error_class: null,
		});
		expect(meter.calls[1]).toMatchObject({
			provider: null,
			capability: null,
			call_role: null,
			retry_count: null,
			model_version: null,
		});
	});

	it("classifies failures coarsely and lets an adapter pre-classify", async () => {
		const abortish = new Error("The operation timed out");
		const preclassified = Object.assign(new Error("x"), { aiErrorClass: "rate_limited" });
		const meter = await withAiMeter("save", async (m) => {
			await expect(runAi(fakeAi(abortish), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			await expect(runAi(fakeAi(preclassified), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			await expect(runAi(fakeAi(new Error("boom")), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			return m;
		});
		expect(meter.calls.map((c) => c.error_class)).toEqual(["timeout", "rate_limited", "error"]);
		expect(meter.calls.every((c) => c.ok === 0)).toBe(true);
	});
});

describe("flush writes the 0052 columns", () => {
	it("persists provider metadata and reads NULL for legacy calls", async () => {
		const userId = `extmeter-${crypto.randomUUID()}`;
		const meter = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, {
				task: "extract", capability: "generate_structured", provider: "workers-ai", callRole: "primary",
			});
			return m;
		});
		await flushAiMeter(env, userId, meter, {});
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({
			provider: "workers-ai",
			capability: "generate_structured",
			call_role: "primary",
			error_class: null,
		});

		const legacy = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, { task: "extract" });
			return m;
		});
		await flushAiMeter(env, userId, legacy, {});
		const legacyRow = await lastCallRow(userId);
		expect(legacyRow.provider).toBe(null);
		expect(legacyRow.call_role).toBe(null);
	});
});

describe("withFlushedAiMeter", () => {
	it("flushes on success with the given scope and scope id", async () => {
		const userId = `extflush-${crypto.randomUUID()}`;
		const out = await withFlushedAiMeter(env, "digest", { userId, scopeId: "packet-1" }, async () => {
			await runAi(fakeAi(okResponse), "@cf/d/igest", { messages: [] }, undefined, { task: "digest" });
			return "done";
		});
		expect(out).toBe("done");
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({ scope: "digest", scope_id: "packet-1", task: "digest" });
	});

	it("flushes even when the wrapped work throws, and an empty meter writes nothing", async () => {
		const userId = `extthrow-${crypto.randomUUID()}`;
		await expect(withFlushedAiMeter(env, "title", { userId }, async () => {
			await runAi(fakeAi(new Error("boom")), "@cf/t/itle", {}, undefined, { task: "mcp_title" }).catch(() => {});
			throw new Error("caller failed after the model call");
		})).rejects.toThrow("caller failed");
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({ scope: "title", ok: 0 });

		const emptyUser = `extempty-${crypto.randomUUID()}`;
		await withFlushedAiMeter(env, "digest", { userId: emptyUser }, async () => "no model call");
		expect(await lastCallRow(emptyUser)).toBe(null);
	});
});

describe("playground_chat finally counts against the published quota", () => {
	it("a flushed playground_chat scope with a scope_id is one monthly write", async () => {
		const userId = `extquota-${crypto.randomUUID()}`;
		const accountUserId = `extacct-${crypto.randomUUID()}`;
		const before = await countWritesThisMonth(env, { accountUserId });
		await withFlushedAiMeter(env, "playground_chat", {
			userId,
			lifecycle: { accountUserId },
		}, async () => {
			tagAiMeter("turn-message-1");
			await runAi(fakeAi(okResponse), "@cf/c/hat", { messages: [] }, undefined, { task: "playground_chat", capability: "chat" });
		});
		const after = await countWritesThisMonth(env, { accountUserId });
		expect(after).toBe(before + 1);

		// Same turn re-flushed (same scope_id) must not count twice.
		await withFlushedAiMeter(env, "playground_chat", { userId, lifecycle: { accountUserId } }, async () => {
			tagAiMeter("turn-message-1");
			await runAi(fakeAi(okResponse), "@cf/c/hat", { messages: [] }, undefined, { task: "playground_chat" });
		});
		expect(await countWritesThisMonth(env, { accountUserId })).toBe(before + 1);
	});
});
