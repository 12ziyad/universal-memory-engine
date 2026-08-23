/**
 * Explicit, admin-triggered provider health probes.
 *
 * A probe is a real billable inference. It therefore runs through runAi so it
 * receives the same input boundary, provider reservation, breaker, settlement,
 * and ai_calls accounting as production traffic. The temporary pin is what
 * makes this explicit diagnostic independent of the live routing switch; no
 * user lane or routing policy is changed.
 */

import { buildPin, withAiPin } from "./pin.js";
import { resolveProvider } from "./registry.js";
import { runAi, withFlushedAiMeter } from "../lib/ai_meter.js";

function errorClassOf(error) {
	if (typeof error?.aiErrorClass === "string" && error.aiErrorClass) return error.aiErrorClass;
	return "error";
}

export async function runProviderHealthCheck(env, providerId, {
	reservationId,
	userId = null,
} = {}) {
	const provider = await resolveProvider(providerId).catch(() => null);
	if (!provider || typeof provider.healthCall !== "function") {
		return { ok: false, error_class: "provider_unavailable", status: null };
	}
	const descriptor = provider.healthCall();
	const task = String(descriptor?.meta?.task ?? "provider_health");
	const pin = buildPin({
		routes: {
			[task]: { provider: providerId, model: descriptor?.model ?? null },
		},
	});
	try {
		const result = await withAiPin(pin, () => withFlushedAiMeter(
			env,
			"provider_health",
			{
				userId,
				scopeId: reservationId,
				// Fixed synthetic input only. Provider admission recognizes no
				// other lifecycle exemption and persists this fact for audit.
				lifecycle: { providerHealthSynthetic: true },
			},
			() => runAi(
				env,
				descriptor?.model ?? null,
				descriptor?.inputs,
				descriptor?.options,
				{ ...(descriptor?.meta ?? {}), reservationId },
			),
		));
		return {
			ok: Boolean(result?.choices?.[0]?.message?.content),
			model_version: result?.model_version ?? null,
		};
	} catch (error) {
		return {
			ok: false,
			error_class: errorClassOf(error),
			status: Number.isFinite(error?.status) ? error.status : null,
		};
	}
}
