import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_DEFAULT_MODELS } from "../src/ai/providers/google/models.js";
import { resetPolicyCacheForTests } from "../src/ai/policy.js";
import { resetProviderBudgetForTests } from "../src/ai/provider_budget.js";
import { resolveProvider } from "../src/ai/registry.js";

const stubFor = (userId) => env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

beforeEach(() => {
	resetPolicyCacheForTests();
	resetProviderBudgetForTests();
});

async function runTerminalProviderFailure(label, providerError) {
	const userId = `queue-provider-${label}-${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO ai_routing_policies
		 (capability, mode, primary_provider, primary_model, allowlist_json,
		  disabled, version, updated_at, updated_by)
		 VALUES ('extract', 'google_only', 'google-vertex', ?, ?, 0, 1, ?, 'queue-idempotency-test')
		 ON CONFLICT(capability) DO UPDATE SET
		  mode=excluded.mode, primary_provider=excluded.primary_provider,
		  primary_model=excluded.primary_model, allowlist_json=excluded.allowlist_json,
		  disabled=0, version=version+1, updated_at=excluded.updated_at,
		  updated_by=excluded.updated_by`,
	).bind(GOOGLE_DEFAULT_MODELS.extract, JSON.stringify([userId]), Date.now()).run();
	resetPolicyCacheForTests();

	const testEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
		AI_ROUTING: "on",
		AI: { run: async () => { throw new Error("unexpected Workers AI fallback"); } },
		GCP_SERVICE_ACCOUNT: "{}",
		GCP_PROJECT_ID: "queue-idempotency-project",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "off",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
	});
	const provider = await resolveProvider("google-vertex");
	const originalInvoke = provider.invoke;
	let invocations = 0;
	provider.invoke = async () => {
		invocations += 1;
		throw Object.assign(new Error(providerError.message), providerError);
	};

	let first;
	let second;
	const stub = stubFor(userId);
	try {
		await runInDurableObject(stub, async (instance) => {
			const originalEnv = instance.env;
			instance.env = testEnv;
			try {
				const overrides = { source: "sdk", meta: { account_user_id: userId } };
				await instance.addMessages(userId, [{
					id: `message-${crypto.randomUUID()}`,
					role: "user",
					content: "My durable preference is deterministic provider accounting.",
					ts: Date.now(),
				}], { overrides });
				first = await instance.runExtraction(userId, overrides);
				second = await instance.drain({
					userId,
					maxJobs: 10,
					ignoreBackoff: true,
					inlineOverrides: overrides,
				});
			} finally {
				await instance.resetAll();
				instance.env = originalEnv;
			}
		});
	} finally {
		provider.invoke = originalInvoke;
	}
	const reservations = await env.DB.prepare(
		`SELECT status FROM ai_provider_reservations
		  WHERE account_user_id = ? AND capability = 'generate_structured'
		  ORDER BY created_at, id`,
	).bind(userId).all();
	return { first, second, invocations, reservations: reservations.results ?? [] };
}

describe("provider outcome idempotency across the extraction queue", () => {
	it("does not replay an ambiguous 504 under a fresh extraction attempt", async () => {
		const result = await runTerminalProviderFailure("ambiguous-504", {
			message: "gateway outcome unknown",
			status: 504,
			retryable: false,
			aiErrorClass: "provider_unavailable",
		});
		expect(result.invocations).toBe(1);
		expect(result.first).toMatchObject({ outcome: "interrupted_unknown", retry: false });
		expect(result.second.results).toEqual([]);
		expect(result.reservations).toEqual([{ status: "ambiguous_charged" }]);
	}, 60_000);

	it("fails terminally instead of violating a long 503 Retry-After", async () => {
		const result = await runTerminalProviderFailure("retry-after-503", {
			message: "retry after 120 seconds",
			status: 503,
			retryable: false,
			retryAfterMs: 120_000,
			aiErrorClass: "provider_unavailable",
		});
		expect(result.invocations).toBe(1);
		expect(result.first).toMatchObject({ outcome: "provider_terminal", retry: false });
		expect(result.second.results).toEqual([]);
		expect(result.reservations).toEqual([{ status: "released" }]);
	}, 60_000);
});
