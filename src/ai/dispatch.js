/**
 * Dispatch — where a call meets a provider.
 *
 * Order of authority, highest first:
 *   1. The PIN. Inside a pinned scope (a claimed extraction run) the stored
 *      route is absolute; live policy is never read. A retry therefore cannot
 *      switch providers mid-run — the invariant the whole design hangs on.
 *   2. The master gate. For UNPINNED work, AI_ROUTING off/track → hardwired
 *      Workers AI: the exact pre-refactor behavior (golden forwarding).
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
import { finishProviderCall, isOperationRefusal, providerAdmission, unitClassOf } from "./provider_budget.js";

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

	const mode = routingMode(env);
	if (mode === "off") return invokeOn(env, DEFAULT_ID, null, call, capability, {});

	// Account-scoped rollout identity must come only from the server-owned meter
	// lifecycle installed by withAiMeter/runAi. Request metadata is caller-owned
	// and must neither grant nor deny access to an allowlisted provider route.
	const route = await resolveRoute(env, lane, { accountUserId: call.lifecycle?.accountUserId ?? null });
	if (mode === "track") {
		// Track mode evaluates the exact live policy but cannot execute it. Keep
		// the observation content-free: no account id, prompt, inputs, or output.
		// Cloudflare Workers logs are the Stage-A evidence surface; ai_calls keeps
		// recording the provider that actually ran (the legacy default).
		console.log(JSON.stringify({
			event: "ai_routing_track",
			lane,
			capability,
			provider: route.provider,
			model: route.model ?? null,
			mode: route.mode,
			source: route.source,
			version: route.version ?? null,
			shadow_provider: route.shadow?.provider ?? null,
			fallback_provider: route.fallback?.provider ?? null,
		}));
		return invokeOn(env, DEFAULT_ID, null, call, capability, {});
	}
	return invokeOn(env, route.provider, route.provider === DEFAULT_ID ? null : route.model, call, capability, { routed: route.source === "policy" });
}

async function invokeOn(env, providerId, model, call, capability, { pinned = false, routed = false }) {
	// These fields are dispatch-owned evidence. Clear any caller values before
	// resolution so request metadata can never spoof which transport/model ran.
	if (call.meta) {
		delete call.meta.invokedProvider;
		delete call.meta.invokedModel;
	}
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

	let providerCall = {
		capability,
		model: model ?? call.model,
		requestedModel: Object.prototype.hasOwnProperty.call(call, "requestedModel") ? call.requestedModel : call.model,
		inputs: call.inputs,
		options: call.options,
		meta: call.meta,
	};
	if (pinned && provider.id !== DEFAULT_ID && (typeof model !== "string" || !model)) {
		throw Object.assign(new Error(`pinned provider ${provider.id} has no concrete model`), {
			aiErrorClass: "pinned_model_missing",
		});
	}
	if (provider.id !== DEFAULT_ID && typeof provider.resolveModel === "function") {
		// The exact transport resolver is shared with the adapter. Admission and
		// invocation therefore pin the same concrete model, never two defaults.
		const resolvedModel = provider.resolveModel(providerCall, capability);
		if (pinned && resolvedModel !== model) {
			throw Object.assign(new Error(`pinned model ${model} no longer resolves identically for ${provider.id}`), {
				aiErrorClass: "pinned_model_mismatch",
			});
		}
		providerCall.model = resolvedModel;
	}

	let admission = null;
	if (provider.id !== DEFAULT_ID) {
		// Stamp the attempted provider before admission. Pinned and operation-state
		// refusals never reach invocation, but their meter row must still identify
		// which provider/capability refused them. An ordinary admission reroute
		// overwrites this below with the provider that actually executes.
		if (call.meta) {
			call.meta.provider = provider.id;
			if (capability && !call.meta.capability) call.meta.capability = capability;
		}
		const retries = Number(provider?.declaration?.limits?.retries ?? 0);
		admission = await providerAdmission(env, provider.id, capability, {
			model: providerCall.model,
			inputs: call.inputs,
			meta: call.meta,
			lifecycle: call.lifecycle,
			maxAttempts: 1 + (Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0),
		});
		if (!admission.allowed) {
			// An operation-state refusal cannot reroute: that would invoke a
			// second provider for a logical call which may already be in flight.
			if (pinned || isOperationRefusal(admission.reason)) {
				throw Object.assign(new Error(`provider ${provider.id} refused admission: ${admission.reason}`), {
					aiErrorClass: admission.reason === "billing" ? "billing"
						: isOperationRefusal(admission.reason) ? "operation_refused" : "provider_refused",
					aiMeterErrorClass: `admission_${admission.reason}`,
					admissionReason: admission.reason,
				});
			}
			// New, unpinned work reroutes to the default — this is
			// admission_reroute, never inference_fallback.
			if (call.meta) call.meta.admissionReroute = admission.reason;
			provider = getProvider(DEFAULT_ID);
			model = null;
			admission = null;
			providerCall = {
				capability,
				model: call.model,
				requestedModel: call.model,
				inputs: call.inputs,
				options: call.options,
				meta: call.meta,
			};
		}
	}

	if (call.meta && (pinned || routed || provider.id !== DEFAULT_ID)) {
		// Stamp provenance for the meter only when the routing engine actually
		// made a decision. The hardwired default path records NULLs, keeping
		// pre-refactor accounting rows byte-identical.
		call.meta.provider = provider.id;
		if (capability && !call.meta.capability) call.meta.capability = capability;
	}
	if (call.meta) {
		call.meta.invokedProvider = provider.id;
		call.meta.invokedModel = providerCall.model;
	}

	if (provider.id === DEFAULT_ID) return provider.invoke(env, providerCall);

	// The provider invocation and accounting are deliberately separate try
	// regions: an accounting outage leaves the row invoking for the conservative
	// reaper, but never turns a successful provider response into a second
	// provider invocation or masks the provider's own outcome.
	let res;
	try {
		res = await provider.invoke(env, providerCall);
	} catch (error) {
		const errorClass = typeof error?.aiErrorClass === "string" ? error.aiErrorClass : "error";
		const definitelyNotCharged = providerFailureIsDefinitelyUnbilled(error, errorClass);
		// Preserve the settlement classification across the LLM/pipeline boundary.
		// A transport failure after invocation may already have incurred provider
		// spend; collapsing it to a generic retryable error would let the queue mint
		// a fresh operation id and invoke the provider a second time.
		error.providerOutcome = definitelyNotCharged ? "definitely_unbilled" : "ambiguous_charged";
		try {
			await finishProviderCall(env, provider.id, admission, {
				ok: false,
				errorClass,
				definitelyNotCharged,
				ambiguousReason: definitelyNotCharged ? null : ambiguityReason(error, errorClass),
			});
		} catch (accountingError) {
			logAccountingDeferred(provider.id, admission, accountingError);
		}
		throw error;
	}

	const accounting = providerUsageForAccounting(capability, call.inputs, res);
	try {
		await finishProviderCall(env, provider.id, admission, {
			ok: true,
			usageKnown: accounting.usageKnown,
			ambiguousOutcome: Number(call.meta?.ambiguousRetryCount ?? 0) > 0,
			inputTokens: accounting.inputTokens,
			outputTokens: accounting.outputTokens,
			records: accounting.records,
			actualUnits: accounting.actualUnits,
			ambiguousReason: Number(call.meta?.ambiguousRetryCount ?? 0) > 0
				? "retry_outcome_unknown"
				: accounting.usageKnown ? null : "usage_missing",
		});
	} catch (accountingError) {
		logAccountingDeferred(provider.id, admission, accountingError);
	}
	return res;
}

function finiteUsage(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Normalize provider usage into the exact values used for settlement. */
export function providerUsageForAccounting(capability, inputs, response) {
	const usage = response && typeof response === "object" ? response.usage ?? null : null;
	const inputTokens = finiteUsage(usage?.prompt_tokens ?? usage?.input_tokens);
	const completionTokens = finiteUsage(usage?.completion_tokens ?? usage?.output_tokens);
	const thoughtTokens = finiteUsage(usage?.thoughts_tokens);
	const totalTokens = finiteUsage(usage?.total_tokens);
	// Total usage may include thoughts/tool-use not present in candidatesTokenCount.
	// Taking the maximum avoids both omitting billed thought tokens and counting
	// them twice when Google already includes them in totalTokenCount.
	const outputTokens = Math.max(completionTokens + thoughtTokens, totalTokens - inputTokens, 0);
	const unitClass = unitClassOf(capability);
	const records = unitClass === "rank_units"
		? Math.max(1, Array.isArray(inputs?.contexts) ? inputs.contexts.length : 1)
		: null;
	const usageKnown = unitClass === "rank_units" || inputTokens > 0 || outputTokens > 0 || totalTokens > 0;
	return {
		inputTokens,
		outputTokens,
		records,
		actualUnits: unitClass === "rank_units" ? records : inputTokens + outputTokens,
		usageKnown,
	};
}

export function providerFailureIsDefinitelyUnbilled(error, errorClass) {
	// These local validation failures happen before fetch. Do not infer the
	// same thing merely from an HTTP response carrying a similar error class.
	if ((error?.status == null || Number(error.status) === 0)
		&& ["schema_untranslatable", "model_input_boundary", "provider_misconfigured"].includes(errorClass)) return true;
	const status = Number(error?.status);
	if (!Number.isInteger(status)) return false;

	// Only explicit rejection/unbilled responses release the reservation.
	// Cancellation, timeout, and unrecognized 4xx responses do not prove that
	// upstream inference never began, so they retain the conservative charge.
	return [400, 401, 403, 404, 429, 500, 503].includes(status);
}

function ambiguityReason(error, errorClass) {
	if (Number(error?.status) === 200 || errorClass === "provider_bad_response") return "charged_response_unreadable";
	if (errorClass === "timeout") return "timeout_outcome_unknown";
	if (errorClass === "provider_unavailable") return "network_outcome_unknown";
	return "provider_outcome_unknown";
}

function logAccountingDeferred(providerId, admission, error) {
	console.warn(JSON.stringify({
		event: "ai_provider_accounting_deferred",
		provider: providerId,
		reservation_id: admission?.reservation?.id ?? null,
		error: String(error?.message ?? error).slice(0, 160),
	}));
}
