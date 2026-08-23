/**
 * AI-call architecture census — the gate that keeps "detachable" true.
 *
 * Source-level on purpose, like mutation_census.js: it fails in CI the moment
 * someone adds a call path the provider architecture forbids. Three invariants:
 *
 *   1. BINDING: only the Cloudflare provider invokes `env.AI.run`. Presence
 *      guards (`if (!env.AI)`) are legitimate everywhere; the INVOCATION is not.
 *   2. GOOGLE WIRE: Google AI endpoints (aiplatform / generativelanguage /
 *      discoveryengine) appear only under src/ai/providers/google/. The
 *      sign-in OAuth hosts (accounts.google.com, oauth2.googleapis.com) are
 *      deliberately NOT in the pattern — src/auth.js's login flow predates and
 *      outlives any AI provider.
 *   3. ENCAPSULATION: provider modules are imported only by the registry (and
 *      within the providers subtree). Deleting src/ai/providers/google/ plus
 *      one registry branch must be the whole code-side removal.
 *
 * Plus a RESIDUE TRACKER: the set of files that import runAi directly is
 * pinned. The long tail migrates to typed capability entry points deliberately;
 * a NEW direct caller fails the build instead of slipping in.
 */

const SELF = "ai_call_census.js";

export const BINDING_INVOCATION_ALLOWED = Object.freeze(["src/ai/providers/cloudflare.js"]);

export const GOOGLE_ENDPOINT_PREFIX = "src/ai/providers/google/";

export const PROVIDER_IMPORT_ALLOWED_PREFIXES = Object.freeze([
	"src/ai/registry.js",
	"src/ai/providers/",
]);

/** Files allowed to import runAi directly. Shrinks as call sites migrate to
 * typed capability entry points; every entry names the lane it serves. */
export const RUN_AI_IMPORTERS = Object.freeze([
	"src/ai/health.js", // explicit admin probe, pinned + metered like production
	"src/index.js", // EVAL_MODE /eval/llm pass-through
	"src/pipeline/llm.js",
	"src/pipeline/engine_v2.js",
	"src/pipeline/digest.js",
	"src/pipeline/pass2.js",
	"src/pipeline/playground.js",
	"src/pipeline/mcp_engine.js",
	"src/pipeline/manual_action_router.js",
	"src/pipeline/manual_search_profiles.js",
	"src/pipeline/rerank.js",
	"src/pipeline/atomic_candidates.mjs",
	"src/lib/embeddings.js",
	"src/lib/rules_preview.js",
]);

const BINDING_INVOCATION = /env\.AI\.run\s*\(|env\[\s*["']AI["']\s*\]/;
const GOOGLE_AI_ENDPOINT = /aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|discoveryengine\.googleapis\.com/;
const PROVIDER_IMPORT = /from\s+["'][^"']*\/providers\/(cloudflare|google)/;
const RUN_AI_IMPORT = /import\s*\{[^}]*\brunAi\b[^}]*\}\s*from/;

/**
 * Audit a map of { "src/...": sourceText }. Returns findings; every array must
 * be empty (and importers must equal the pinned set) for the gate to pass.
 */
export function auditAiCalls(sources) {
	const findings = { bindingEscapes: [], googleEscapes: [], providerImportEscapes: [], runAiImporters: [] };
	for (const [file, text] of Object.entries(sources)) {
		if (file.endsWith(SELF)) continue;
		if (BINDING_INVOCATION.test(text) && !BINDING_INVOCATION_ALLOWED.includes(file)) {
			findings.bindingEscapes.push(file);
		}
		if (GOOGLE_AI_ENDPOINT.test(text) && !file.startsWith(GOOGLE_ENDPOINT_PREFIX)) {
			findings.googleEscapes.push(file);
		}
		if (PROVIDER_IMPORT.test(text) && !PROVIDER_IMPORT_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
			findings.providerImportEscapes.push(file);
		}
		if (RUN_AI_IMPORT.test(text)) findings.runAiImporters.push(file);
	}
	findings.runAiImporters.sort();
	return findings;
}

/** Load every src/ source as raw text — bundled inside the Workers pool,
 * node:fs under plain Node. Same dual-reader shape as mutation_census.js. */
export async function loadAiCensusSources() {
	try {
		const modules = import.meta.glob?.(["../**/*.js", "../**/*.mjs"], { query: "?raw", import: "default", eager: true });
		if (modules && Object.keys(modules).length) {
			const out = {};
			for (const [key, text] of Object.entries(modules)) {
				out[key.replace(/^\.\.\//, "src/")] = text;
			}
			return out;
		}
	} catch {
		// fall through to node:fs
	}
	const { readdir, readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const out = {};
	async function walk(dir) {
		for (const entry of await readdir(`${root}${dir}`, { withFileTypes: true })) {
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) await walk(rel);
			else if (/\.(js|mjs)$/.test(entry.name)) out[rel] = await readFile(`${root}${rel}`, "utf8");
		}
	}
	await walk("src");
	return out;
}
