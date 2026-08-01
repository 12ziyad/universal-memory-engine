import { runAi } from "./ai_meter.js";
/**
 * Workers AI embedding helper. Best-effort: if the AI binding is missing or the
 * call fails (e.g. local dev without --remote, or tests with vectors disabled),
 * it returns null and the caller degrades gracefully.
 */
export async function embed(env, config, text) {
	if (!config.useVectors || !env.AI) return null;
	try {
		const res = await runAi(env, config.embedModel, { text: [text] }, undefined, { task: "embed" });
		const vec = res?.data?.[0];
		return Array.isArray(vec) ? vec : null;
	} catch (err) {
		console.warn("embed failed:", err?.message ?? err);
		return null;
	}
}
