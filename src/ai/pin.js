/**
 * The provider pin — deterministic-retry identity for write-producing runs.
 *
 * Policy is resolved ONCE per run, at claim time, and stored on the run row
 * (extraction_runs.pin_json / provider / model — migration 0053). Execution
 * then happens inside withAiPin(pin, ...), and dispatch consults currentPin()
 * BEFORE live policy: inside a pinned scope, live policy is never read. That
 * makes "a policy change affects only new operations" a structural property,
 * and it makes the core invariant hold: A RUN ID NEVER CHANGES PROVIDER. If
 * recovery requires a different provider, the old run must first be settled
 * terminally and a NEW run id resolves a fresh pin at its own claim.
 *
 * The same AsyncLocalStorage pattern as the meter, for the same reason:
 * digest, edges, reflexion and embeddings made during a save all execute under
 * the pin automatically, with nothing threaded through eleven call sites.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { concreteProviderRoute } from "./model_identity.js";
import { resolveRoute, routingMode } from "./policy.js";

// The store holds a mutable BOX rather than the pin itself: a save enters the
// scope before its claim exists (runExtraction wraps the whole metered body),
// and the claim sets the authoritative pin into the box once the run row is
// durable. Everything downstream — digest, edges, reflexion, embeddings —
// reads through currentPin() automatically.
const pinStore = new AsyncLocalStorage();

export const PIN_VERSION = 1;

/** The pin for the work currently running, or null outside a pinned scope. */
export function currentPin() {
	return pinStore.getStore()?.pin ?? null;
}

export function withAiPin(initialPin, fn) {
	return pinStore.run({ pin: initialPin ?? null }, fn);
}

/** Set the authoritative pin for the current scope (no-op outside one). */
export function setCurrentPin(pin) {
	const box = pinStore.getStore();
	if (box) box.pin = pin ?? null;
}

/** The lanes a save's pin covers — every model call an extraction can make. */
export const WRITE_PIN_LANES = Object.freeze(["extract", "edges", "reflexion", "digest", "extract_atomic"]);

async function sampledForShadow(runKey, samplePct) {
	const pct = Number.isInteger(samplePct) ? samplePct : 100;
	if (pct >= 100) return true;
	if (pct <= 0) return false;
	const data = new TextEncoder().encode(`shadow\0${runKey ?? ""}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return ((digest[0] << 8) | digest[1]) % 100 < pct;
}

/**
 * Resolve a fresh write pin at claim time. Returns NULL when routing is off or
 * when every lane resolves to the pure-legacy default — a NULL pin IS the
 * legacy behavior, so pin_json noise never appears while nothing is routed.
 * Shadow sampling is decided HERE, once per run, deterministically by run key:
 * a multi-call run is all-shadow or not-shadow, never mixed.
 */
export async function resolveWritePin(env, { accountUserId = null, runKey = null } = {}) {
	if (routingMode(env) !== "on") return null;
	const routes = {};
	let shadow = null;
	let admission = null;
	let interesting = false;
	for (const lane of WRITE_PIN_LANES) {
		const resolved = await resolveRoute(env, lane, { accountUserId });
		const route = await concreteProviderRoute(lane, resolved);
		routes[lane] = { provider: route.provider, model: route.model ?? null };
		if (route.provider !== "workers-ai" || route.model != null) interesting = true;
		if (route.source === "not_allowlisted" || route.source === "provider_disabled") {
			admission = { ...(admission ?? {}), [lane]: route.source };
		}
		if (lane === "extract" && route.shadow) {
			const sampled = await sampledForShadow(runKey, route.shadow.samplePct);
			shadow = { ...(await concreteProviderRoute(lane, route.shadow)), sampled };
			interesting = true;
		}
	}
	if (!interesting) return null;
	return buildPin({ routes, admission, shadow });
}

/**
 * Build a pin envelope. `routes` maps capability → { provider, model|null }.
 * Non-default routes crossing a durable boundary are canonicalized by
 * resolveWritePin before this envelope is built; a NULL non-default model is
 * therefore a malformed legacy pin and dispatch refuses it rather than
 * consulting a newer provider default.
 */
export function buildPin({ routes = {}, promptVersion = null, schemaVersion = null, tuningRef = null, policyVersion = null, admission = null, shadow = null, pinnedAt = Date.now() } = {}) {
	return {
		v: PIN_VERSION,
		routes,
		prompt_version: promptVersion,
		schema_version: schemaVersion,
		tuning_ref: tuningRef,
		policy_version: policyVersion,
		// How this run was admitted (e.g. { rerouted: "breaker_open" }) — the
		// admission_reroute audit trail lives on the run, not in a log line.
		admission,
		// Shadow sampling is decided once per run, here — a multi-call run is
		// all-shadow or not-shadow, never mixed.
		shadow,
		pinned_at: pinnedAt,
	};
}

/** Canonical serialized form stored on the run row and compared on re-claim. */
export function serializePin(pin) {
	return pin == null ? null : JSON.stringify(pin);
}

export function parsePin(pinJson) {
	if (pinJson == null || pinJson === "") return null;
	try {
		const parsed = JSON.parse(pinJson);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** The pinned route for a capability, or null (null = legacy behavior). */
export function pinnedRoute(pin, capability) {
	const route = pin?.routes?.[capability];
	if (!route || typeof route !== "object") return null;
	const provider = typeof route.provider === "string" && route.provider ? route.provider : null;
	if (!provider) return null;
	return { provider, model: typeof route.model === "string" && route.model ? route.model : null };
}
