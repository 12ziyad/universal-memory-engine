/**
 * Upgrade contract for the 0054 -> 0055 -> 0056 provider hardening path.
 *
 * The pool applies every migration in sequence, so this catches migration
 * syntax/order failures. The legacy-shape inserts below additionally prove
 * that rows written with the pre-0055/pre-0056 column sets receive safe
 * defaults, and that 0056's primary-run uniqueness invariant is real.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Google provider hardening migrations", () => {
	it("upgrades legacy-shaped rows and enforces one shadow job per primary run", async () => {
		const suffix = crypto.randomUUID();
		const now = Date.now();
		const reservationId = `upgrade_res_${suffix}`;
		await env.DB.prepare(
			`INSERT INTO ai_provider_reservations
			 (id, provider, unit_class, day, month, estimated_units,
			  estimated_cost_micros, rate_card_version, attempt_token, status,
			  expires_at, created_at, updated_at)
			 VALUES (?, 'google-vertex', 'gen_tokens', '2026-08-22', '2026-08',
			         10, 20, 'legacy-card', 'legacy-attempt', 'reserved', ?, ?, ?)`,
		).bind(reservationId, now + 60_000, now, now).run();

		const upgradedReservation = await env.DB.prepare(
			`SELECT model, capability, input_rate_per_million_micros,
			        output_rate_per_million_micros, rank_rate_per_100_micros,
			        base_estimated_units, base_estimated_cost_micros,
			        max_attempts, invoked_at, ambiguous_reason, terminal_at
			   FROM ai_provider_reservations WHERE id = ?`,
		).bind(reservationId).first();
		expect(upgradedReservation).toEqual({
			model: null,
			capability: null,
			input_rate_per_million_micros: 0,
			output_rate_per_million_micros: 0,
			rank_rate_per_100_micros: 0,
			base_estimated_units: 0,
			base_estimated_cost_micros: 0,
			max_attempts: 1,
			invoked_at: null,
			ambiguous_reason: null,
			terminal_at: null,
		});

		const primaryRunId = `upgrade_run_${suffix}`;
		const insertLegacyShadow = (id) => env.DB.prepare(
			`INSERT INTO ai_shadow_jobs
			 (id, user_id, account_user_id, primary_run_id, provider, model,
			  prompt_version, status, attempts, lease_until, comparison_json,
			  input_tokens, output_tokens, duration_ms, error_class, created_at,
			  updated_at)
			 VALUES (?, ?, ?, ?, 'google-vertex', 'gemini-2.5-flash', 'v1',
			         'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
		).bind(id, `upgrade_space_${suffix}`, `upgrade_account_${suffix}`, primaryRunId, now, now);

		await insertLegacyShadow(`upgrade_shadow_${suffix}`).run();
		const upgradedShadow = await env.DB.prepare(
			"SELECT claim_token, terminal_at FROM ai_shadow_jobs WHERE primary_run_id = ?",
		).bind(primaryRunId).first();
		expect(upgradedShadow).toEqual({ claim_token: null, terminal_at: null });

		await expect(insertLegacyShadow(`upgrade_shadow_duplicate_${suffix}`).run()).rejects.toThrow();

		const indexes = await env.DB.prepare("PRAGMA index_list('ai_shadow_jobs')").all();
		expect(indexes.results.some((row) => row.name === "uq_ai_shadow_jobs_primary_run" && Number(row.unique) === 1)).toBe(true);
	});
});
