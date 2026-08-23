/**
 * Concrete provider-model identity at durable boundaries.
 *
 * Provider defaults are convenient for an immediate call, but they are not a
 * durable identity: changing a default between attempts could make one
 * logical operation target two models.  This helper deliberately reaches a
 * provider only through the registry, then asks the adapter's own resolver for
 * the exact transport model.  Nothing outside the registry imports a provider
 * implementation.
 */

import { capabilityOf } from "./capabilities.js";
import { resolveProvider } from "./registry.js";

function identityError(code, message) {
	return Object.assign(new Error(message), { aiErrorClass: code });
}

/** Resolve one route to a non-empty model id. Workers AI retains its legacy
 * model semantics; non-default providers must expose a deterministic resolver
 * or already carry a concrete model. */
export async function concreteProviderModel(providerId, lane, model = null) {
	if (providerId === "workers-ai") {
		return typeof model === "string" && model ? model : null;
	}
	const provider = await resolveProvider(providerId).catch((error) => {
		throw identityError("provider_unavailable", `provider ${providerId} could not be loaded: ${String(error?.message ?? error)}`);
	});
	if (!provider) throw identityError("provider_unavailable", `provider ${providerId} is not registered`);

	const capability = capabilityOf({ task: lane });
	if (!capability) throw identityError("provider_model_unresolved", `lane ${lane} has no provider capability`);
	let concrete = typeof model === "string" && model ? model : null;
	if (typeof provider.resolveModel === "function") {
		concrete = provider.resolveModel({
			capability,
			model: concrete,
			meta: { task: lane },
		}, capability);
	}
	if (typeof concrete !== "string" || !concrete) {
		throw identityError("provider_model_unresolved", `provider ${providerId} did not resolve a concrete model for ${lane}`);
	}
	return concrete;
}

/** Preserve route metadata while replacing a provider default with the exact
 * model the transport would use. */
export async function concreteProviderRoute(lane, route) {
	if (!route || typeof route !== "object") return route;
	const provider = typeof route.provider === "string" && route.provider ? route.provider : null;
	if (!provider || provider === "workers-ai") return { ...route };
	return {
		...route,
		model: await concreteProviderModel(provider, lane, route.model ?? null),
	};
}
