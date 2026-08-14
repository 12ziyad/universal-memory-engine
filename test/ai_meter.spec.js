/**
 * Workers AI accounting.
 *
 * Two things must stay true or the numbers this produces are worthless:
 *
 *   1. Metering cannot change behaviour. runAi forwards its arguments
 *      untouched, returns the binding's response as-is, and a failure inside
 *      the accounting must never surface to the caller.
 *   2. `neurons` is only ever a number Workers AI actually returned. Deriving
 *      one from tokens is a reasonable thing to do in a report and an
 *      unacceptable thing to do in a column named after the billed unit.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import {
	currentMeter,
	flushAiMeter,
	meterTotals,
	readUsage,
	runAi,
	tagAiMeter,
	withAiMeter,
} from "../src/lib/ai_meter.js";

/** A binding stand-in that echoes whatever usage shape we want to test. */
function fakeAi(response, spy = {}) {
	return {
		AI: {
			run: async (model, inputs, options) => {
				spy.calls = spy.calls ?? [];
				spy.calls.push({ model, inputs, options, argc: arguments.length });
				if (response instanceof Error) throw response;
				return typeof response === "function" ? response(model, inputs, options) : response;
			},
		},
	};
}

describe("reading usage off a response", () => {
	it("understands the OpenAI-shaped fields Workers AI actually returns", () => {
		// This is the real shape, copied from a live @cf/qwen/qwen3-30b-a3b-fp8 call.
		const usage = readUsage({
			usage: {
				prompt_tokens: 1580,
				completion_tokens: 1727,
				total_tokens: 3307,
				prompt_tokens_details: { cached_tokens: 0 },
				neurons: 59.936767578125,
			},
		});
		expect(usage).toMatchObject({ input: 1580, output: 1727, total: 3307, neurons: 59.936767578125 });
		expect(usage.raw.prompt_tokens).toBe(1580);
	});

	it("handles the embedding shape, which reports tokens but no neurons", () => {
		const usage = readUsage({ usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } });
		expect(usage).toMatchObject({ input: 3, output: 0, total: 3, neurons: null });
	});

	it("returns nulls, never zeros, when a model reports nothing", () => {
		for (const res of [null, undefined, "text", {}, { usage: null }]) {
			expect(readUsage(res)).toMatchObject({ input: null, output: null, total: null, neurons: null });
		}
	});

	it("accepts the alternative token spellings without inventing a total", () => {
		expect(readUsage({ usage: { input_tokens: 10, output_tokens: 4 } }))
			.toMatchObject({ input: 10, output: 4, total: 14 });
		expect(readUsage({ usage: { inputTokens: 7 } }))
			.toMatchObject({ input: 7, output: null, total: null });
	});
});

describe("runAi is transparent", () => {
	it("forwards arguments and returns the response untouched", async () => {
		const spy = {};
		const response = { response: "hi", usage: { prompt_tokens: 1, completion_tokens: 2 } };
		const result = await runAi(fakeAi(response, spy), "@cf/x/y", { messages: [] }, { gateway: { id: "g" } }, { task: "t" });
		expect(result).toBe(response);
		expect(spy.calls[0].model).toBe("@cf/x/y");
		expect(spy.calls[0].options).toEqual({ gateway: { id: "g" } });
	});

	it("omits the third argument when there are no options", async () => {
		let seen = "unset";
		const fake = { AI: { run: async (...args) => { seen = args.length; return {}; } } };
		await runAi(fake, "@cf/x/y", { text: ["a"] }, undefined, { task: "embed" });
		expect(seen).toBe(2);
	});

	it("lets the caller's error through unchanged, and still records the attempt", async () => {
		const boom = new Error("model exploded");
		const meter = await withAiMeter("save", async (m) => {
			await expect(runAi(fakeAi(boom), "@cf/x/y", {}, undefined, { task: "extract" })).rejects.toThrow("model exploded");
			return m;
		});
		expect(meter.calls).toHaveLength(1);
		expect(meter.calls[0]).toMatchObject({ ok: 0, task: "extract", input_tokens: null });
	});

	it("works outside a meter, recording nothing", async () => {
		expect(currentMeter()).toBe(null);
		await expect(runAi(fakeAi({ ok: true }), "@cf/x/y", {})).resolves.toEqual({ ok: true });
	});
});

describe("attribution", () => {
	it("collects every call in a scope and totals them", async () => {
		const meter = await withAiMeter("save", async (m) => {
			tagAiMeter("run_1");
			const ai = fakeAi((model) => model.includes("bge")
				? { data: [[0.1]], usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }
				: { response: "x", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, neurons: 2.5 } });
			await runAi(ai, "@cf/qwen/qwen3-30b-a3b-fp8", {}, undefined, { task: "extract" });
			await runAi(ai, "@cf/baai/bge-base-en-v1.5", {}, undefined, { task: "embed" });
			return m;
		});
		expect(meter.scopeId).toBe("run_1");
		expect(meterTotals(meter)).toEqual({
			calls: 2,
			input_tokens: 103,
			output_tokens: 50,
			total_tokens: 153,
			// Only the model that reported neurons contributes. The embedding's
			// missing count is not silently treated as zero cost elsewhere.
			neurons: 2.5,
		});
	});

	it("keeps two concurrent saves apart", async () => {
		const ai = fakeAi({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
		const [a, b] = await Promise.all([
			withAiMeter("save", async (m) => { await runAi(ai, "m1", {}); await runAi(ai, "m1", {}); return m; }),
			withAiMeter("save", async (m) => { await runAi(ai, "m2", {}); return m; }),
		]);
		expect(a.calls.map((c) => c.model)).toEqual(["m1", "m1"]);
		expect(b.calls.map((c) => c.model)).toEqual(["m2"]);
	});

	it("reports null rather than zero when nothing was measured", () => {
		expect(meterTotals({ calls: [{ model: "m", input_tokens: null, output_tokens: null }] }))
			.toMatchObject({ calls: 1, input_tokens: null, output_tokens: null, neurons: null });
	});
});

describe("persistence", () => {
	async function request(path, init) {
		const req = new Request(`http://example.com${path}`, init);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it("writes one ai_calls row per call and rolls the totals onto the receipt", async () => {
		const userId = `meter-${crypto.randomUUID()}`;
		const meter = await withAiMeter("save", async (m) => {
			tagAiMeter("run_persist");
			await runAi(fakeAi({ usage: { prompt_tokens: 12, completion_tokens: 8, neurons: 1.25 } }),
				"@cf/qwen/qwen3-30b-a3b-fp8", {}, undefined, { task: "extract" });
			return m;
		});
		await flushAiMeter(env, userId, meter);

		const row = await env.DB.prepare("SELECT * FROM ai_calls WHERE user_id = ?").bind(userId).first();
		expect(row).toMatchObject({
			scope: "save",
			scope_id: "run_persist",
			model: "@cf/qwen/qwen3-30b-a3b-fp8",
			task: "extract",
			input_tokens: 12,
			output_tokens: 8,
			neurons: 1.25,
			ok: 1,
		});
		expect(JSON.parse(row.raw_usage_json).neurons).toBe(1.25);
	});

	it("persists account attribution and feeds the daily rollup", async () => {
		const userId = `meter-attr-${crypto.randomUUID()}`;
		const account = `acct-${crypto.randomUUID()}`;
		const before = await env.DB.prepare(
			"SELECT calls, input_tokens, measured_neurons, measured_neuron_calls FROM ai_daily_totals WHERE day = date('now')",
		).first();

		const meter = await withAiMeter("save", async (m) => {
			tagAiMeter("run_attr");
			await runAi(fakeAi({ usage: { prompt_tokens: 10, completion_tokens: 5, neurons: 2 } }),
				"@cf/qwen/qwen3-30b-a3b-fp8", {}, undefined, { task: "extract" });
			// A second call with NO reported neurons: counts in calls/tokens,
			// never in measured_neurons.
			await runAi(fakeAi({ usage: { prompt_tokens: 4, completion_tokens: 2 } }),
				"@cf/baai/bge-base-en-v1.5", {}, undefined, { task: "embed" });
			return m;
		});
		await flushAiMeter(env, userId, meter, { accountUserId: account });
		await flushAiMeter(env, userId, meter, { accountUserId: account }); // same-day accumulation

		const row = await env.DB.prepare(
			"SELECT account_user_id, managed_project_id FROM ai_calls WHERE user_id = ? LIMIT 1",
		).bind(userId).first();
		expect(row.account_user_id).toBe(account);
		expect(row.managed_project_id).toBeNull();

		const after = await env.DB.prepare(
			"SELECT calls, input_tokens, measured_neurons, measured_neuron_calls FROM ai_daily_totals WHERE day = date('now')",
		).first();
		// The rollup must accumulate exactly what the meter recorded, twice.
		// (Per-call field mapping is pinned by the row test above.)
		const totals = meterTotals(meter);
		const measuredCalls = meter.calls.filter((c) => Number.isFinite(c.neurons)).length;
		expect(meter.calls.length).toBe(2);
		expect(measuredCalls).toBe(1); // the embed call reported no neurons
		expect(after.calls - (before?.calls ?? 0)).toBe(meter.calls.length * 2);
		expect(after.input_tokens - (before?.input_tokens ?? 0)).toBe((totals.input_tokens ?? 0) * 2);
		expect(after.measured_neurons - (before?.measured_neurons ?? 0)).toBeCloseTo((totals.neurons ?? 0) * 2);
		expect(after.measured_neuron_calls - (before?.measured_neuron_calls ?? 0)).toBe(measuredCalls * 2);
	});

	it("survives a flush against a missing table without throwing", async () => {
		const meter = { scope: "save", calls: [{ model: "m", input_tokens: 1 }] };
		const brokenEnv = { DB: { batch: async () => { throw new Error("no such table"); }, prepare: () => ({ bind: () => ({}) }) } };
		await expect(flushAiMeter(brokenEnv, "u", meter)).resolves.toMatchObject({ calls: 1 });
	});

	it("records a real save end to end, without changing what it saved", async () => {
		const userId = `meter-save-${crypto.randomUUID()}`;
		const res = await request("/v1/save", {
			method: "POST",
			headers: { "x-api-key": env.API_KEY, "content-type": "application/json" },
			body: JSON.stringify({
				userId,
				content: "I started boxing training this month.",
				_test: {
					llmResponse: {
						objects: [
							{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
							{ kind: "slice", on: "Boxing", text: "Trains three days a week", kind_detail: "progress", confidence: 0.95 },
						],
					},
				},
			}),
		});
		expect(res.status).toBe(200);

		// The save still did exactly what it did before metering existed.
		const nodes = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ?").bind(userId).all();
		expect(nodes.results.map((n) => n.label)).toContain("Boxing");

		// Tests stub the model, so there is no AI call to meter and the rollup is
		// absent rather than a fabricated zero.
		const receipt = await env.DB.prepare(
			"SELECT ai_calls, ai_input_tokens, ai_neurons FROM receipts WHERE user_id = ? AND saved_total > 0",
		).bind(userId).first();
		expect(receipt).toBeTruthy();
		expect(receipt.ai_neurons).toBeNull();
	});
});
