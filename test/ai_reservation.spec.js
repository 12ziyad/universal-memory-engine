/**
 * Reserve/settle spend accounting (migration 0053, rev-3 corrections).
 *
 * The properties that make the monetary ceiling REAL:
 *   - reserve is one fenced batch: refused ⇒ no row AND no increment;
 *   - a retried reserve (same operation id) can never double-count;
 *   - settle/release are idempotent CAS transitions;
 *   - totals can never move without a matching reapable reservation row;
 *   - unit classes are independent; the monthly cost ceiling spans them.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	providerAdmission,
	reapExpiredReservations,
	releaseReservation,
	reserveSpend,
	resetProviderBudgetForTests,
	settleReservation,
} from "../src/ai/provider_budget.js";

const GEN_INPUTS = { messages: [{ role: "user", content: "hello there" }], max_tokens: 100 };

function budgetEnv(overrides = {}) {
	return Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
		GOOGLE_DAILY_GEN_TOKENS: "50000",
		GOOGLE_DAILY_EMBED_TOKENS: "50000",
		GOOGLE_DAILY_RANK_UNITS: "500",
		GOOGLE_MONTHLY_COST_MICROS: "50000000",
		...overrides,
	});
}

async function totals(unitClass) {
	return env.DB.prepare(
		"SELECT used_units, reserved_units FROM ai_provider_daily_totals WHERE provider='google-vertex' AND unit_class=? AND day=date('now')",
	).bind(unitClass).first();
}

beforeEach(() => resetProviderBudgetForTests());

describe("fenced reserve", () => {
	it("admits under the ceiling and counts exactly once, even when retried", async () => {
		const rid = crypto.randomUUID();
		const first = await reserveSpend(budgetEnv(), { capability: "generate_structured", inputs: GEN_INPUTS, reservationId: rid });
		expect(first).not.toBe(null);
		const after = await totals("gen_tokens");
		expect(Number(after.reserved_units)).toBeGreaterThan(0);

		// Retry of the SAME operation: row exists, fresh attempt token loses,
		// totals must not move again.
		const retry = await reserveSpend(budgetEnv(), { capability: "generate_structured", inputs: GEN_INPUTS, reservationId: rid });
		expect(retry).not.toBe(null);
		const again = await totals("gen_tokens");
		expect(Number(again.reserved_units)).toBe(Number(after.reserved_units));
	});

	it("a ceiling refusal rolls the whole batch back: no row, no increment", async () => {
		const before = await totals("gen_tokens");
		const rid = crypto.randomUUID();
		const refused = await reserveSpend(budgetEnv({ GOOGLE_DAILY_GEN_TOKENS: "10" }), {
			capability: "generate_structured", inputs: GEN_INPUTS, reservationId: rid,
		});
		expect(refused).toBe(null);
		const row = await env.DB.prepare("SELECT id FROM ai_provider_reservations WHERE id = ?").bind(rid).first();
		expect(row).toBe(null);
		const after = await totals("gen_tokens");
		expect(Number(after?.reserved_units ?? 0)).toBe(Number(before?.reserved_units ?? 0));
	});

	it("unit classes are independent: an exhausted gen ceiling does not block embeds", async () => {
		const blocked = await reserveSpend(budgetEnv({ GOOGLE_DAILY_GEN_TOKENS: "10" }), {
			capability: "generate_structured", inputs: GEN_INPUTS, reservationId: crypto.randomUUID(),
		});
		expect(blocked).toBe(null);
		const embed = await reserveSpend(budgetEnv({ GOOGLE_DAILY_GEN_TOKENS: "10" }), {
			capability: "embed_documents", inputs: { text: ["hello"] }, reservationId: crypto.randomUUID(),
		});
		expect(embed).not.toBe(null);
	});

	it("the monthly cost ceiling refuses across classes", async () => {
		const refused = await reserveSpend(budgetEnv({ GOOGLE_MONTHLY_COST_MICROS: "1" }), {
			capability: "embed_documents", inputs: { text: ["hello"] }, reservationId: crypto.randomUUID(),
		});
		expect(refused).toBe(null);
	});
});

describe("settle / release / reap", () => {
	it("settle moves estimate→actuals exactly once", async () => {
		const reservation = await reserveSpend(budgetEnv(), {
			capability: "generate_structured", inputs: GEN_INPUTS, reservationId: crypto.randomUUID(),
		});
		const reservedBefore = Number((await totals("gen_tokens")).reserved_units);
		await settleReservation(env, reservation, { actualUnits: 42, actualCostMicros: 10 });
		const after = await totals("gen_tokens");
		expect(Number(after.reserved_units)).toBe(reservedBefore - reservation.estimatedUnits);
		expect(Number(after.used_units)).toBeGreaterThanOrEqual(42);

		// Idempotent: a second settle no-ops on the CAS.
		await settleReservation(env, reservation, { actualUnits: 42, actualCostMicros: 10 });
		const again = await totals("gen_tokens");
		expect(Number(again.used_units)).toBe(Number(after.used_units));
		expect(Number(again.reserved_units)).toBe(Number(after.reserved_units));
	});

	it("release returns the estimate; reap releases expired reservations", async () => {
		const reservation = await reserveSpend(budgetEnv(), {
			capability: "generate_structured", inputs: GEN_INPUTS, reservationId: crypto.randomUUID(),
		});
		await releaseReservation(env, reservation);
		const row = await env.DB.prepare("SELECT status FROM ai_provider_reservations WHERE id = ?").bind(reservation.id).first();
		expect(row.status).toBe("released");

		const stale = await reserveSpend(budgetEnv(), {
			capability: "generate_structured", inputs: GEN_INPUTS, reservationId: crypto.randomUUID(),
		});
		await env.DB.prepare("UPDATE ai_provider_reservations SET expires_at = 1 WHERE id = ?").bind(stale.id).run();
		const reaped = await reapExpiredReservations(env, { limit: 10 });
		expect(reaped).toBeGreaterThanOrEqual(1);
		const staleRow = await env.DB.prepare("SELECT status FROM ai_provider_reservations WHERE id = ?").bind(stale.id).first();
		expect(staleRow.status).toBe("released");
	});
});

describe("admission", () => {
	it("refuses without credentials, with the kill var, and under an override", async () => {
		expect((await providerAdmission(budgetEnv(), "google-vertex", "generate_structured", { inputs: GEN_INPUTS })).reason).toBe("no_credentials");
		expect((await providerAdmission(budgetEnv({ GCP_SERVICE_ACCOUNT: "{}", AI_ROUTING_KILL: "1" }), "google-vertex", "generate_structured", { inputs: GEN_INPUTS })).reason).toBe("kill");
		await env.DB.prepare(
			"INSERT INTO ai_provider_overrides (provider, disabled, updated_at) VALUES ('google-vertex', 1, ?) ON CONFLICT(provider) DO UPDATE SET disabled=1",
		).bind(Date.now()).run();
		resetProviderBudgetForTests();
		const refused = await providerAdmission(budgetEnv({ GCP_SERVICE_ACCOUNT: "{}" }), "google-vertex", "generate_structured", { inputs: GEN_INPUTS });
		expect(refused.allowed).toBe(false);
		expect(refused.reason).toBe("disabled");
		await env.DB.prepare("DELETE FROM ai_provider_overrides WHERE provider='google-vertex'").run();
	});

	it("the default provider is always admitted", async () => {
		expect(await providerAdmission(env, "workers-ai", "generate_structured", {})).toEqual({ allowed: true });
	});
});
