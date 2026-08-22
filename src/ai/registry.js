/**
 * Provider registry — the ONLY module that imports provider implementations.
 *
 * Cloudflare is static: it is the platform. Google is a LAZY dynamic import,
 * loaded the first time something actually routes to it — so with no Google
 * policy and no Google credentials, no Google code ever executes, and deleting
 * src/ai/providers/google/ plus the one branch below is the whole code-side
 * removal. The architecture census forbids importing providers from anywhere
 * else.
 */

import { cloudflareProvider } from "./providers/cloudflare.js";

const providers = new Map([[cloudflareProvider.id, cloudflareProvider]]);
let googleLoad = null;

/** A non-Cloudflare provider must declare a finite transport timeout: a raw
 * fetch has no platform bound, and a hung call inside a DO drain is a new
 * failure mode this layer refuses to introduce. */
function validateDeclaration(provider) {
	if (provider.id === cloudflareProvider.id) return provider;
	const timeoutMs = provider?.declaration?.limits?.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(`provider ${provider?.id ?? "unknown"} must declare a finite limits.timeoutMs`);
	}
	return provider;
}

/** Synchronous lookup of an already-loaded provider. */
export function getProvider(id) {
	return providers.get(id) ?? null;
}

/** Load (if needed) and return a provider, or null for unknown ids. */
export async function resolveProvider(id) {
	if (providers.has(id)) return providers.get(id);
	if (id === "google-vertex") {
		googleLoad ??= import("./providers/google/index.js")
			.then((mod) => {
				const provider = validateDeclaration(mod.googleProvider);
				providers.set(provider.id, provider);
				return provider;
			})
			.catch((error) => {
				googleLoad = null;
				throw error;
			});
		return googleLoad;
	}
	return null;
}

/** Ids the policy engine may legally reference. */
export const KNOWN_PROVIDER_IDS = Object.freeze(["workers-ai", "google-vertex"]);

/** Test hook: drop lazily-loaded providers so specs can assert cold behavior. */
export function resetProvidersForTests() {
	for (const id of [...providers.keys()]) {
		if (id !== cloudflareProvider.id) providers.delete(id);
	}
	googleLoad = null;
}
