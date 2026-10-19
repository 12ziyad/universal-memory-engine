import { describe, it, expect, vi } from "vitest";
import { AVEN_MODEL_PROFILE, AVEN_MEMORY_MODEL, avenModelEnvironment } from "../src/aven/model-profile.js";
import { cloudflareProvider } from "../src/ai/providers/cloudflare.js";

describe("Aven memory model profile", () => {
  it("keeps ordinary Itsuki jobs unchanged and isolates Aven configuration", () => {
    const original = { LLM_MODEL: "original-extractor", LLM_SUMMARY_MODEL: "original-summary", AI_ROUTING: "on" };
    expect(avenModelEnvironment(original, null)).toBe(original);
    expect(avenModelEnvironment(original, "unknown")).toBe(original);
    const scoped = avenModelEnvironment(original, AVEN_MODEL_PROFILE);
    expect(scoped.LLM_MODEL).toBe(AVEN_MEMORY_MODEL);
    expect(scoped.LLM_SUMMARY_MODEL).toBe(AVEN_MEMORY_MODEL);
    expect(scoped.LLM_DIGEST_MODEL).toBe(AVEN_MEMORY_MODEL);
    expect(scoped.AI_ROUTING).toBe("off");
    expect(original.LLM_MODEL).toBe("original-extractor");
  });
  it("gives Flash explicit low reasoning and an answer budget without mutating the caller", async () => {
    const run = vi.fn().mockResolvedValue({ choices: [] });
    const inputs = { messages: [{ role: "user", content: "fixture" }], max_tokens: 256 };
    await cloudflareProvider.invoke({ AI: { run } }, { model: AVEN_MEMORY_MODEL, inputs });
    expect(run).toHaveBeenCalledWith(AVEN_MEMORY_MODEL, {
      messages: inputs.messages, reasoning_effort: "low", max_completion_tokens: 2048,
      chat_template_kwargs: { clear_thinking: true },
    });
    expect(inputs.max_tokens).toBe(256);
  });
});
