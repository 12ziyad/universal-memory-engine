/**
 * Dispatch — where a call meets a provider.
 *
 * Order of authority, highest first:
 *   1. The PIN. Inside a pinned scope (a claimed extraction run) the stored
 *      route is absolute; live policy is never read. A retry therefore cannot
 *      switch providers mid-run — the invariant the whole design hangs on.
 *   2. The master gate. AI_ROUTING off/track → hardwired Workers AI with zero
 *      I/O: the exact pre-refactor behavior, provably (golden forwarding).
 *   3. Policy. Only with AI_ROUTING="on", and only for NEW unpinned work.
 *
 * Non-default providers additionally pass admission (budget reserve, breaker,
 * credentials); a refused admission falls back to Workers AI here ONLY for
 * unpinned work — which by (1) is definitionally not mid-run. There is no
 * cross-provider retry inside dispatch: read-lane degradation stays at the
 * call sites (fused order, REPLY_FALLBACK, entity–date title), which is the
 * "fallback to identity first" floor the plan mandates.
 */

import { getProvider, resolveProvider } from "./registry.js";
import { capabilityOf } from "./capabilities.js";
import { currentPin, pinnedRoute } from "./pin.js";
import { resolveRoute, routingMode } from "./policy.js";
import { finishProviderCall, providerAdmission, unitClassOf } from "./provider_budget.js";
import { estimateGoogleCostMicros } from "./rate_cards.js";

const DEFAULT_ID = "workers-ai";

export async function dispatchAi(env, call) {
	// Routing is keyed by LANE (the task string) so extraction and the title
	// pass can route independently; the CONTRACT capability governs legality,
	// unit class and admission.
	const lane = call.meta?.task ?? null;
	const capability = capabilityOf(call.meta ?? {});

	const pin = currentPin();
	const pinned = pin ? pinnedRoute(pin, lane) : null;
	if (pinned) return invokeOn(env, pinned.provider, pinned.model, call, capability, { pinned: true });

	if (routingMode(env) !== "on") return invokeOn(env, DEFAULT_ID, null, call, capability, {});

	const route = await resolveRoute(env, lane, { accountUserId: call.meta?.accountUserId ?? null });
	return invokeOn(env, route.provider, route.provider === DEFAULT_ID ? null : route.model, call, capability, { routed: route.source === "policy" });
}

async function invokeOn(env, providerId, model, call, capability, { pinned = false, routed = false }) {
	let provider = getProvider(providerId);
	if (!provider && providerId !== DEFAULT_ID) {
		provider = await resolveProvider(providerId).catch((error) => {
			console.warn(JSON.stringify({
				event: "ai_provider_unloadable",
				provider: providerId,
				error: String(error?.message ?? error).slice(0, 200),
			}));
			return null;
		});
	}
	if (!provider) {
		if (pinned) {
			// A pinned provider that cannot load is a transport failure for THIS
			// attempt — the run stays pinned and rides its normal retry ladder.
			// It must never silently re-resolve to another provider.
			throw Object.assign(new Error(`pinned provider ${providerId} is not available`), {
				aiErrorClass: "provider_unavailable",
			});
		}
		provider = getProvider(DEFAULT_ID);
		model = null;
	}

	let admission = null;
	if (provider.id !== DEFAULT_ID) {
		admission = await providerAdmission(env, provider.id, capability, { model, inputs: call.inputs, meta: call.meta });
		if (!admission.allowed) {
			if (pinned) {
				throw Object.assign(new Error(`pinned provider ${provider.id} refused admission: ${admission.reason}`), {
					aiErrorClass: admission.reason === "billing" ? "billing" : "provider_refused",
				});
			}
			// New, unpinned work reroutes to the default — this is
			// admission_reroute, never inference_fallback.
			if (call.meta) call.meta.admissionReroute = admission.reason;
			provider = getProvider(DEFAULT_ID);
			model = null;
			admission = null;
		}
	}

	if (call.meta && (pinned || routed || provider.id !== DEFAULT_ID)) {
		// Stamp provenance for the meter only when the routing engine actually
		// made a decision. The hardwired default path records NULLs, keeping
		// pre-refactor accounting rows byte-identical.
		call.meta.provider = provider.id;
		if (capability && !call.meta.capability) call.meta.capability = capability;
	}

	const providerCall = {
		capability,
		model: model ?? call.model,
		requestedModel: call.model,
		inputs: call.inputs,
		options: call.options,
		meta: call.meta,
	};
	if (provider.id === DEFAULT_ID) return provider.invoke(env, providerCall);

	// Non-default provider: settle the reservation to actuals on success,
	// release it and feed the breaker on failure. Bookkeeping failures never
	// mask the call's own outcome.
	try {
		const res = await provider.invoke(env, providerCall);
		const usage = res && typeof res === "object" ? res.usage ?? null : null;
		const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
		const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
		const unitClass = unitClassOf(capability);
		const actualUnits = unitClass === "rank_units"
			? (Array.isArray(call.inputs?.contexts) ? call.inputs.contexts.length : 1)
			: inputTokens + outputTokens;
		await finishProviderCall(env, provider.id, admission, {
			ok: true,
			actualUnits,
			actualCostMicros: estimateGoogleCostMicros({
				model: providerCall.model,
				unitClass,
				inputTokens,
				outputTokens,
				records: unitClass === "rank_units" ? actualUnits : 0,
			}),
		}).catch(() => {});
		return res;
	} catch (error) {
		await finishProviderCall(env, provider.id, admission, {
			ok: false,
			errorClass: typeof error?.aiErrorClass === "string" ? error.aiErrorClass : "error",
		}).catch(() => {});
		throw error;
	}
}
