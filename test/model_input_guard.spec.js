import { describe, expect, it, vi } from "vitest";
import { runAi, withAiMeter } from "../src/lib/ai_meter.js";
import {
	guardModelInput,
	MODEL_CONTEXT_TOKENS_BY_ID,
	MODEL_INPUT_MAX_UTF8_BYTES,
	ModelInputBoundaryError,
	serializedInputBytes,
} from "../src/lib/model_input.js";

const QWEN_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const LLAMA_SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const guard = (input, options = {}) => guardModelInput(input, { model: QWEN_MODEL, ...options });

function chatInput(content, extra = {}) {
	return {
		messages: [
			{ role: "system", content: "Extract only durable facts and return JSON." },
			{ role: "user", content },
		],
		temperature: 0,
		max_tokens: 4_096,
		...extra,
	};
}

describe("Workers AI model-input boundary", () => {
	it("leaves an in-budget input byte-for-byte and reference-identical", () => {
		const input = chatInput("I moved to Pune last week.");
		const guarded = guard(input);

		expect(guarded.inputs).toBe(input);
		expect(guarded.boundary).toMatchObject({
			bounded: false,
			limit_bytes: MODEL_INPUT_MAX_UTF8_BYTES,
			original_bytes: serializedInputBytes(input),
			final_bytes: serializedInputBytes(input),
		});
	});

	it.each([-1, 0, 1])("enforces the full serialized Qwen boundary at limit %+i byte", (delta) => {
		const input = chatInput("");
		const overhead = serializedInputBytes(input);
		input.messages[1].content = "x".repeat(MODEL_INPUT_MAX_UTF8_BYTES + delta - overhead);
		expect(serializedInputBytes(input)).toBe(MODEL_INPUT_MAX_UTF8_BYTES + delta);

		const guarded = guard(input);
		if (delta <= 0) {
			expect(guarded.inputs).toBe(input);
			expect(guarded.boundary).toMatchObject({
				bounded: false,
				final_bytes: MODEL_INPUT_MAX_UTF8_BYTES + delta,
			});
		} else {
			expect(guarded.inputs).not.toBe(input);
			expect(guarded.boundary.bounded).toBe(true);
			expect(serializedInputBytes(guarded.inputs)).toBeLessThanOrEqual(MODEL_INPUT_MAX_UTF8_BYTES);
			expect(guarded.inputs.messages[1].content.endsWith("x")).toBe(true);
		}
	});

	it("uses the configured model's documented context profile", () => {
		expect(MODEL_CONTEXT_TOKENS_BY_ID[QWEN_MODEL]).toBe(32_768);
		expect(MODEL_CONTEXT_TOKENS_BY_ID[LLAMA_SUMMARY_MODEL]).toBe(32_000);
		const input = chatInput("x".repeat(24_000));

		const qwen = guard(input);
		expect(qwen.boundary).toMatchObject({ context_tokens: 32_768, limit_bytes: 24_576 });
		const llama = guardModelInput(input, { model: LLAMA_SUMMARY_MODEL });
		expect(llama.boundary).toMatchObject({
			context_tokens: 32_000,
			limit_bytes: 23_808,
			bounded: true,
		});
		expect(serializedInputBytes(llama.inputs)).toBeLessThanOrEqual(23_808);
	});

	it("bounds the actual serialized bytes for multibyte and control-heavy input", () => {
		const tail = "NEWEST_SOURCE_TAIL::👩🏽‍💻::e\u0301::決定は維持する";
		const content = `SOURCE-BEGIN\n${"控制🙂\u0000\u0008\n".repeat(12_000)}\n${tail}`;
		const input = chatInput(content, {
			response_format: {
				type: "json_schema",
				json_schema: { type: "object", properties: { facts: { type: "array" } } },
			},
		});

		const first = guard(input);
		const second = guard(input);

		expect(serializedInputBytes(first.inputs)).toBeLessThanOrEqual(MODEL_INPUT_MAX_UTF8_BYTES);
		expect(first.boundary.final_bytes).toBe(serializedInputBytes(first.inputs));
		expect(first.boundary.bounded).toBe(true);
		expect(first.inputs.messages[1].content).toContain("Itsuki model-input boundary");
		expect(first.inputs.messages[1].content.endsWith(tail)).toBe(true);
		expect(first.inputs.messages[1].content).not.toContain("�");
		expect(second).toEqual(first);
	});

	it("sacrifices older context before changing the complete newest source turn", () => {
		const newest = "LATEST_SOURCE_COMPLETE::The production decision is keep the durable queue.::🏁";
		const input = {
			messages: [
				{ role: "system", content: "Use the newest source turn as authoritative." },
				{ role: "user", content: `OLD-CONTEXT-BEGIN\n${"old context detail. ".repeat(5_000)}\nOLD-CONTEXT-TAIL` },
				{ role: "assistant", content: "A short bridge response." },
				{ role: "user", content: newest },
			],
			max_tokens: 4_096,
		};

		const guarded = guard(input);

		expect(serializedInputBytes(guarded.inputs)).toBeLessThanOrEqual(MODEL_INPUT_MAX_UTF8_BYTES);
		expect(guarded.inputs.messages[3].content).toBe(newest);
		expect(guarded.inputs.messages[1].content).toContain("Itsuki model-input boundary");
		expect(guarded.boundary.bounded_messages[0].index).toBe(1);
	});

	it("trims trailing assistant context before the authoritative newest user source", () => {
		const sourceTail = "AUTHORITATIVE_SOURCE_TAIL::keep this conclusion";
		const input = {
			messages: [
				{ role: "system", content: "s".repeat(19_000) },
				{ role: "user", content: `${"source fact. ".repeat(750)}${sourceTail}` },
				{ role: "assistant", content: "non-authoritative assistant context. ".repeat(300) },
			],
			max_tokens: 4_096,
		};

		const guarded = guard(input);
		expect(serializedInputBytes(guarded.inputs)).toBeLessThanOrEqual(MODEL_INPUT_MAX_UTF8_BYTES);
		expect(guarded.inputs.messages[1].content.endsWith(sourceTail)).toBe(true);
		expect(guarded.inputs.messages[2].content).toContain("Itsuki model-input boundary");
		const order = guarded.boundary.bounded_messages.map((message) => message.index);
		expect(order[0]).toBe(2);
		expect(order).toContain(1);
	});

	it("returns only count metadata and never copies omitted content into it", () => {
		const privateMiddle = "PRIVATE_MIDDLE_SENTINEL_9f4c";
		const input = chatInput(`begin\n${privateMiddle.repeat(4_000)}\nlatest source tail`);
		const guarded = guard(input);
		const metadata = JSON.stringify(guarded.boundary);

		expect(guarded.boundary.bounded).toBe(true);
		expect(metadata).not.toContain(privateMiddle);
		expect(guarded.boundary.bounded_messages[0]).toEqual(expect.objectContaining({
			index: 1,
			role: "user",
			omitted_content_bytes: expect.any(Number),
			omitted_unicode_units: expect.any(Number),
		}));
	});

	it("fails before inference when fixed system/schema input cannot fit", async () => {
		const input = {
			messages: [{ role: "system", content: "fixed-rule ".repeat(5_000) }],
			max_tokens: 4_096,
		};
		expect(() => guard(input)).toThrow(ModelInputBoundaryError);

		let calls = 0;
		const fakeEnv = { AI: { run: async () => { calls++; return {}; } } };
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(runAi(fakeEnv, "@cf/qwen/qwen3-30b-a3b-fp8", input))
				.rejects.toMatchObject({ code: "model_input_boundary" });
			expect(calls).toBe(0);
			expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"ai_input_blocked"'));
		} finally {
			warning.mockRestore();
		}
	});

	it("blocks instead of sending a marker-only newest source", () => {
		const input = {
			messages: [
				{ role: "system", content: "s".repeat(24_050) },
				{ role: "user", content: "latest-source ".repeat(1_000) },
			],
			max_tokens: 4_096,
		};
		expect(() => guard(input)).toThrow(expect.objectContaining({
			code: "model_input_boundary",
			metadata: expect.objectContaining({
				blocked: true,
				error: "newest_source_tail_cannot_fit",
			}),
		}));
	});

	it("guards every chat inference at the shared runAi choke point and meters the event", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		let sent = null;
		const fakeEnv = {
			AI: {
				run: async (_model, inputs) => {
					sent = inputs;
					return { response: "ok", usage: { prompt_tokens: 10, completion_tokens: 1 } };
				},
			},
		};
		try {
			const meter = await withAiMeter("boundary-test", async (active) => {
				await runAi(
					fakeEnv,
					"@cf/qwen/qwen3-30b-a3b-fp8",
					chatInput(`${"source🙂\u0000".repeat(8_000)}FINAL-SOURCE-TAIL`),
					undefined,
					{ task: "extract" },
				);
				return active;
			});

			expect(serializedInputBytes(sent)).toBeLessThanOrEqual(MODEL_INPUT_MAX_UTF8_BYTES);
			expect(sent.messages[1].content.endsWith("FINAL-SOURCE-TAIL")).toBe(true);
			expect(meter.calls[0].input_boundary).toMatchObject({ bounded: true });
			expect(warning).toHaveBeenCalledWith(expect.stringContaining('"event":"ai_input_bounded"'));
		} finally {
			warning.mockRestore();
		}
	});

	it("does not apply chat context assumptions to embedding input schemas", () => {
		const embeddingInput = { text: ["🙂".repeat(100_000)] };
		const guarded = guard(embeddingInput);
		expect(guarded).toEqual({ inputs: embeddingInput, boundary: null });
		expect(guarded.inputs).toBe(embeddingInput);
	});
});
