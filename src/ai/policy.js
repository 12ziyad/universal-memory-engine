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
import { concreteProviderModel } from "./model_identity.js";
import { googleModelCard } from "./rate_cards.js";

export const ROUTING_MODES = Object.freeze([
	"cloudflare_only",
	"google_only",
	"shadow",
	"canary",
]);

const GLOBAL_ROW = "__global__";
const POLICY_TTL_MS = 30_000;
const POLICY_STALE_GRACE_MS = 30_000;

// Interactive/ad-hoc calls below do not own a client-stable logical-operation
// record (playground_chat creates a new message id for every HTTP attempt).
// Until they gain one, admitting a billable non-default provider would make a
// client retry capable of spending twice. Keep the normal task names for
// observability, but make non-default routing unrepresentable at both the
// policy write door and policy read path.
export const CLOUDFLARE_ONLY_LANES = Object.freeze(new Set([
	"manual_router",
	"mcp_title",
	"rules_category_preview",
	"playground_preview",
	"playground_chat",
]));

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
 *  - Cross-provider fallback is not a supported runtime mode. It is absent
 *    from ROUTING_MODES for every lane, and a historical row carrying one of
 *    the retired mode strings fails closed at the read boundary. Rerouting
 *    writes happens only at claim time (admission_reroute), never mid-run.
 *  - Space-bound capabilities (embeddings) are cloudflare_only here. The
 *    current shadow outbox exists only for extraction, so advertising an
 *    embedding shadow would be an operator-visible no-op. A future embedding
 *    migration/experiment needs its own non-committing comparison pipeline
 *    and flag before any Google embedding route becomes representable.
 */
export function legalModesFor(lane) {
	// Policy rows are keyed by LANE (the task string: extract, edges, digest,
	// rerank, playground_chat, ...) so extraction and the title pass can route
	// independently; the LEGALITY of a mode comes from the lane's contract
	// capability (generate_structured, embed_documents, ...).
	if (CLOUDFLARE_ONLY_LANES.has(lane)) return ["cloudflare_only"];
	const contract = capabilityOf({ task: lane }) ?? lane;
	if (SPACE_BOUND_CAPABILITIES.has(contract)) return ["cloudflare_only"];
	if (WRITE_CAPABILITIES.has(contract)) return ["cloudflare_only", "google_only", "shadow", "canary"];
	return [...ROUTING_MODES];
}

/** Model columns that are active Google routes for this policy mode. Keep this
 * in the policy module so the write door and read-side defense use exactly the
 * same topology. Retired fallback modes are deliberately absent: they are not
 * canonicalized into something that could later look executable. */
export function googleModelFieldsForPolicy(policy) {
	const fields = new Set();
	switch (String(policy?.mode ?? "")) {
		case "google_only":
		case "canary":
			fields.add("primary_model");
			break;
		case "shadow":
			if (policy?.shadow_provider === "google-vertex") fields.add("shadow_model");
			break;
		default:
			break;
	}
	return [...fields];
}

const GOOGLE_ALLOWLIST_PROBLEM = "Google routes require an explicit non-empty account allowlist";

/** Parse the persisted rollout boundary. Missing, empty, malformed, and
 * non-string members all fail closed: a Google route is never an implicit
 * all-account policy. Runtime identity still comes from server-owned meter
 * lifecycle state, never request metadata. */
function explicitAccountAllowlist(value) {
	if (typeof value !== "string" || value === "") return null;
	try {
		const list = JSON.parse(value);
		if (!Array.isArray(list) || list.length === 0) return null;
		if (list.some((member) => typeof member !== "string" || member.trim() === "")) return null;
		return list;
	} catch {
		return null;
	}
}

/** Canonicalize every active Google route through the adapter's own model
 * resolver before a policy is persisted. This is async because Google remains
 * a lazy registry entry and is still never imported directly here. */
export async function canonicalizePolicyModels(lane, policy) {
	const canonical = { ...policy };
	for (const field of googleModelFieldsForPolicy(canonical)) {
		canonical[field] = await concreteProviderModel("google-vertex", lane, canonical[field] ?? null);
	}
	return canonical;
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
	const googleModelFields = googleModelFieldsForPolicy(policy);
	if (googleModelFields.length > 0 && !explicitAccountAllowlist(policy?.allowlist_json)) {
		problems.push(GOOGLE_ALLOWLIST_PROBLEM);
	}
	for (const field of googleModelFields) {
		if (typeof policy?.[field] !== "string" || !policy[field]) {
			problems.push(`${field} must be a concrete Google model`);
			continue;
		}
		const contract = capabilityOf({ task: capability }) ?? capability;
		const expectedUnitClass = SPACE_BOUND_CAPABILITIES.has(contract)
			? "embed_tokens"
			: contract === "rerank" ? "rank_units" : "gen_tokens";
		const card = googleModelCard(policy[field]);
		if (!card) problems.push(`${field} must name an exact immutable rate-carded Google model`);
		else if (card.unitClass !== expectedUnitClass) problems.push(`${field} is not valid for ${capability}`);
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
	const list = explicitAccountAllowlist(row?.allowlist_json);
	// Exact, whole-string, case-sensitive account-id match — the repo rule.
	return list != null && accountUserId != null && list.includes(accountUserId);
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
	const policyProblems = validatePolicyWrite(capability, row);
	if (policyProblems.length) return { ...CLOUDFLARE_ROUTE, source: "invalid_policy" };
	try {
		const canonical = await canonicalizePolicyModels(capability, row);
		if (googleModelFieldsForPolicy(row).some((field) => canonical[field] !== row[field])) {
			return { ...CLOUDFLARE_ROUTE, source: "invalid_policy" };
		}
	} catch {
		return { ...CLOUDFLARE_ROUTE, source: "invalid_policy" };
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
		default:
			return CLOUDFLARE_ROUTE;
	}
}
