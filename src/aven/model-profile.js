// Server-owned profile, persisted with the job so background retries keep the same model.
export const AVEN_MODEL_PROFILE = "aven-glm-5.3-flash-v1";
export const AVEN_MEMORY_MODEL = "@cf/zai-org/glm-5.3-flash";
export function avenModelEnvironment(env, profile) {
  if (profile !== AVEN_MODEL_PROFILE) return env;
  return {
    ...env,
    AI_ROUTING: "off",
    AI_GATEWAY_ID: "",
    LLM_PROVIDER: "workers-ai",
    LLM_MODEL: AVEN_MEMORY_MODEL,
    LLM_MAX_TOKENS: "8192",
    LLM_PASS_MAX_TOKENS: "4096",
    LLM_SUMMARY_MODEL: AVEN_MEMORY_MODEL,
    LLM_SUMMARY_MAX_TOKENS: "2048",
    LLM_DIGEST_MODEL: AVEN_MEMORY_MODEL,
    LLM_DIGEST_MAX_TOKENS: "4096",
  };
}
