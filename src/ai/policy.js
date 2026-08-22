/**
 * Routing policy — vars as the master gate, D1 for dynamic per-capability
 * policy with audit, and a hard fail-safe: ANY doubt resolves cloudflare-only.
 *
 *   AI_ROUTING       off | track | on   (fail-closed parse; default off).
 *                    off  → the policy engine is never consulted: zero D1
 *                           reads, dispatch hardwired to Cloudflare.
 *                    track→ policy is read and RECORDED (what would have
 *                           routed) but execution stays Cloudflare-only.
 *                    on   → policy takes effect.
 *   AI_ROUTING_KILL  "1" → hard cloudflare-only regardless of D1 — the
 *                    deploy-time floor against a poisoned policy table.
 *
 * The D1 snapshot (ai_routing_policies + ai_provider_overrides) is one batch
 * read, cached per isolate for 30s with a 30s stale grace — the ai_budget
 * breaker-cache pattern. A failed read serves the stale snapshot inside the
 * grace window and cloudflare-only after it: a policy the engine cannot read
 * is a policy that does not exist.
 */

import { KNOWN_PROVIDER_IDS } from "./registry.js";
import { capabilityOf, SPACE_BOUND_CAPABILITIES, WRITE_CAPABILITIES } from "./capabilities.js";

export const ROUTING_MODES = Object.freeze([
	"cloudflare_only",
	"google_only",
	"cf_primary_google_fallback",
	"google_primary_cf_fallback",
	"shadow",
	"canary",
]);

const GLOBAL_ROW = "__global__";
const POLICY_TTL_MS = 30_000;
const POLICY_STALE_GRACE_MS = 30_000;

let policyCache = { at: 0, snapshot: null };

export function resetPolicyCacheForTests() {
	policyCache = { at: 0, snapshot: null };
}

export function routingMode(env) {
	if (String(env?.AI_ROUTING_KILL ?? "") === "1") return "off";
	const raw = String(env?.AI_ROUTING ?? "off").toLowerCase();
	return raw === "on" || raw === "track" ? raw : "off";
}

/**
 * Which modes a capability may legally be set to. Enforced at the admin door
 * AND re-checked at read time: an illegal stored mode resolves cloudflare-only.
 *
 *  - Write capabilities never get fallback modes: cross-provider fallback on a
 *    write risks committing a second interpretation. Rerouting writes happens
 *    only at claim time (admission_reroute), never mid-run.
 *  - Space-bound capabilities (embeddings) may only be cloudflare_only or
 *    shadow: a provider whose semantic space differs from the live index must
 *    be unreachable by any automatic decision. google_only becomes legal only
 *    with the embedding-migration campaign's own flag set (not this table).
 */
export function legalModesFor(lane) {
	// Policy rows are keyed by LANE (the task string: extract, edges, digest,
	// rerank, playground_chat, ...) so extraction and the title pass can route
	// independently; the LEGALITY of a mode comes from the lane's contract
	// capability (generate_structured, embed_documents, ...).
	const contract = capabilityOf({ task: lane }) ?? lane;
	if (SPACE_BOUND_CAPABILITIES.has(contract)) return ["cloudflare_only", "shadow"];
	if (WRITE_CAPABILITIES.has(contract)) return ["cloudflare_only", "google_only", "shadow", "canary"];
	return [...ROUTING_MODES];
}

export function validatePolicyWrite(capability, policy) {
	const problems = [];
	if (!capability || typeof capability !== "string") problems.push("capability required");
	const mode = String(policy?.mode ?? "");
	if (!ROUTING_MODES.includes(mode)) problems.push(`unknown mode ${mode}`);
	else if (!legalModesFor(capability).includes(mode)) problems.push(`mode ${mode} is not legal for ${capability}`);
	for (const key of ["primary_provider", "fallback_provider", "shadow_provider"]) {
		const value = policy?.[key];
		if (value != null && !KNOWN_PROVIDER_IDS.includes(value)) problems.push(`${key} ${value} is not a known provider`);
	}
	const pct = (name, value) => {
		if (value == null) return;
		if (!Number.isInteger(value) || value < 0 || value > 100) problems.push(`${name} must be an integer 0-100`);
	};
	pct("canary_pct", policy?.canary_pct);
	pct("shadow_sample_pct", policy?.shadow_sample_pct);
	return problems;
}

async function readSnapshot(env) {
	const [policies, overrides] = await env.DB.batch([
		env.DB.prepare("SELECT * FROM ai_routing_policies"),
		env.DB.prepare("SELECT * FROM ai_provider_overrides"),
	]);
	const byCapability = new Map();
	for (const row of policies?.results ?? []) byCapability.set(row.capability, row);
	const disabledProviders = new Set();
	for (const row of overrides?.results ?? []) {
		if (Number(row.disabled) === 1) disabledProviders.add(row.provider);
	}
	return { byCapability, disabledProviders };
}

async function snapshot(env, now = Date.now()) {
	if (policyCache.snapshot && now - policyCache.at < POLICY_TTL_MS) return policyCache.snapshot;
	try {
		const fresh = await readSnapshot(env);
		policyCache = { at: now, snapshot: fresh };
		return fresh;
	} catch (error) {
		console.warn(JSON.stringify({ event: "ai_policy_unreadable", error: String(error?.message ?? error).slice(0, 200) }));
		if (policyCache.snapshot && now - policyCache.at < POLICY_TTL_MS + POLICY_STALE_GRACE_MS) {
			return policyCache.snapshot;
		}
		return null; // resolves cloudflare-only below
	}
}

const CLOUDFLARE_ROUTE = Object.freeze({ provider: "workers-ai", model: null, mode: "cloudflare_only", source: "default", shadow: null, fallback: null });

async function stickyBucket(capability, accountUserId) {
	const data = new TextEncoder().encode(`${capability}\0${accountUserId}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return ((digest[0] << 8) | digest[1]) % 100;
}

function allowlisted(row, accountUserId) {
	if (row.allowlist_json == null || row.allowlist_json === "") return true;
	try {
		const list = JSON.parse(row.allowlist_json);
		if (!Array.isArray(list)) return false;
		// Exact, whole-string, case-sensitive account-id match — the repo rule.
		return accountUserId != null && list.includes(accountUserId);
	} catch {
		return false;
	}
}

/**
 * Resolve where NEW work for a capability should run. Never throws; every
 * failure path is cloudflare-only. `accountUserId` must come from server-built
 * provenance only — nothing from a request body may reach this.
 */
export async function resolveRoute(env, capability, { accountUserId = null } = {}, now = Date.now()) {
	const mode = routingMode(env);
	if (mode === "off" || !env?.DB || !capability) return CLOUDFLARE_ROUTE;

	const snap = await snapshot(env, now);
	if (!snap) return { ...CLOUDFLARE_ROUTE, source: "policy_unreadable" };
	if (snap.byCapability.get(GLOBAL_ROW)?.disabled) return { ...CLOUDFLARE_ROUTE, source: "global_disabled" };

	const row = snap.byCapability.get(capability);
	if (!row || Number(row.disabled) === 1) return CLOUDFLARE_ROUTE;
	if (!ROUTING_MODES.includes(row.mode) || !legalModesFor(capability).includes(row.mode)) {
		return { ...CLOUDFLARE_ROUTE, source: "illegal_mode" };
	}

	const provider = (id) => (id && KNOWN_PROVIDER_IDS.includes(id) && !snap.disabledProviders.has(id) ? id : null);
	const shadowRoute = row.mode === "shadow" && provider(row.shadow_provider)
		? {
			provider: row.shadow_provider,
			model: row.shadow_model ?? null,
			samplePct: Number.isInteger(row.shadow_sample_pct) ? row.shadow_sample_pct : 100,
		}
		: null;

	const route = (primary, extra = {}) => ({
		provider: primary,
		model: primary === row.primary_provider ? row.primary_model ?? null : null,
		mode: row.mode,
		source: "policy",
		version: row.version ?? null,
		shadow: null,
		fallback: null,
		...extra,
	});

	switch (row.mode) {
		case "cloudflare_only":
			return route("workers-ai");
		case "google_only": {
			if (!allowlisted(row, accountUserId)) return route("workers-ai", { source: "not_allowlisted" });
			const target = provider("google-vertex");
			return target
				? { provider: target, model: row.primary_provider === target ? row.primary_model ?? null : row.primary_model ?? null, mode: row.mode, source: "policy", version: row.version ?? null, shadow: null, fallback: null }
				: route("workers-ai", { source: "provider_disabled" });
		}
		case "shadow":
			// Primary result is the only one that commits; the shadow config is
			// carried for the pin to capture at claim time.
			return route("workers-ai", { shadow: allowlisted(row, accountUserId) ? shadowRoute : null });
		case "canary": {
			if (!allowlisted(row, accountUserId) || accountUserId == null) return route("workers-ai", { source: "not_allowlisted" });
			const pct = Number.isInteger(row.canary_pct) ? row.canary_pct : 0;
			const bucket = await stickyBucket(capability, accountUserId);
			const target = bucket < pct ? provider(row.primary_provider === "workers-ai" ? "google-vertex" : row.primary_provider) : null;
			return target
				? { provider: target, model: row.primary_model ?? null, mode: row.mode, source: "policy", version: row.version ?? null, shadow: null, fallback: null }
				: route("workers-ai");
		}
		case "cf_primary_google_fallback":
			return route("workers-ai", { fallback: provider("google-vertex") ? { provider: "google-vertex", model: row.fallback_model ?? null } : null });
		case "google_primary_cf_fallback": {
			if (!allowlisted(row, accountUserId)) return route("workers-ai", { source: "not_allowlisted" });
			const target = provider("google-vertex");
			return target
				? { provider: target, model: row.primary_model ?? null, mode: row.mode, source: "policy", version: row.version ?? null, shadow: null, fallback: { provider: "workers-ai", model: row.fallback_model ?? null } }
				: route("workers-ai", { source: "provider_disabled" });
		}
		default:
			return CLOUDFLARE_ROUTE;
	}
}
