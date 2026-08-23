/**
 * Real 0054 -> 0055 -> 0056 SQLite upgrade fixture.
 *
 * Unlike the Workers-pool schema smoke test, this file creates the exact
 * relevant pre-hardening tables, inserts rows before the new migrations, and
 * only then executes the shipped migration SQL.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "migrations");
const migration = (name) => readFileSync(join(migrationsDir, name), "utf8").replace(/\r\n/g, "\n");

const M0055 = migration("0055_ai_provider_reservation_hardening.sql");
const M0056 = migration("0056_ai_shadow_hardening.sql");

function legacyDatabase({ duplicateShadow = false } = {}) {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE ai_provider_health (
			provider TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT,
			consecutive_failures INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
		);
		CREATE TABLE ai_provider_reservations (
			id TEXT PRIMARY KEY, provider TEXT NOT NULL, unit_class TEXT NOT NULL,
			day TEXT NOT NULL, month TEXT NOT NULL, estimated_units INTEGER NOT NULL,
			estimated_cost_micros INTEGER NOT NULL, rate_card_version TEXT NOT NULL,
			attempt_token TEXT NOT NULL, settle_token TEXT, status TEXT NOT NULL,
			actual_units INTEGER, actual_cost_micros INTEGER, expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		CREATE TABLE ai_routing_policies (
			capability TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'cloudflare_only',
			primary_provider TEXT NOT NULL DEFAULT 'workers-ai', primary_model TEXT,
			fallback_provider TEXT, fallback_model TEXT, shadow_provider TEXT, shadow_model TEXT,
			shadow_sample_pct INTEGER NOT NULL DEFAULT 100, canary_pct INTEGER NOT NULL DEFAULT 0,
			allowlist_json TEXT, disabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
			updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
		);
		CREATE TABLE extraction_runs (
			id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL,
			pin_json TEXT
		);
		CREATE TABLE ai_shadow_jobs (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_user_id TEXT,
			primary_run_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT,
			prompt_version TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
			lease_until INTEGER, comparison_json TEXT, input_tokens INTEGER,
			output_tokens INTEGER, duration_ms INTEGER, error_class TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
		);
		INSERT INTO ai_provider_health
			(provider, state, reason, consecutive_failures, updated_at)
		VALUES ('google-vertex', 'open', 'quota', 2, 1000);
		INSERT INTO ai_provider_reservations
			(id, provider, unit_class, day, month, estimated_units,
			 estimated_cost_micros, rate_card_version, attempt_token, status,
			 expires_at, created_at, updated_at)
		VALUES ('legacy-res', 'google-vertex', 'gen_tokens', '2026-08-22', '2026-08',
			10, 20, 'legacy-card', 'legacy-attempt', 'reserved', 2000, 900, 900);
		INSERT INTO ai_provider_reservations
			(id, provider, unit_class, day, month, estimated_units,
			 estimated_cost_micros, rate_card_version, attempt_token, status,
			 expires_at, created_at, updated_at)
		VALUES ('legacy-terminal', 'google-vertex', 'gen_tokens', '2026-08-22', '2026-08',
			10, 20, 'legacy-card', 'legacy-terminal-attempt', 'settled', 2000, 901, 1201);
		INSERT INTO extraction_runs (id, status, created_at, pin_json)
		VALUES ('legacy-run', 'wrote', 800, '{"shadow":{"sampled":true}}');
		INSERT INTO ai_shadow_jobs
			(id, user_id, primary_run_id, provider, status, created_at, updated_at)
		VALUES ('legacy-shadow', 'space-1', 'legacy-run', 'google-vertex', 'done', 800, 1200);
	`);
	if (duplicateShadow) {
		db.exec(`INSERT INTO ai_shadow_jobs
			(id, user_id, primary_run_id, provider, status, created_at, updated_at)
			VALUES ('legacy-shadow-duplicate', 'space-1', 'legacy-run', 'google-vertex', 'failed', 801, 1201)`);
	}
	return db;
}

describe("0054 provider schema upgrade", () => {
	it("backfills pre-existing rows and installs the hardening indexes", () => {
		const db = legacyDatabase();
		try {
			db.exec(M0055);
			db.exec(M0056);

			const health = db.prepare(
				"SELECT opened_at, cooldown_ms, cooldown_until FROM ai_provider_health WHERE provider='google-vertex'",
			).get();
			expect(health).toEqual({ opened_at: 1000, cooldown_ms: 120000, cooldown_until: 121000 });

			const reservation = db.prepare(
				`SELECT input_rate_per_million_micros, output_rate_per_million_micros,
				        base_estimated_units, base_estimated_cost_micros, max_attempts
				   FROM ai_provider_reservations WHERE id='legacy-res'`,
			).get();
			expect(reservation).toEqual({
				input_rate_per_million_micros: 0,
				output_rate_per_million_micros: 0,
				base_estimated_units: 0,
				base_estimated_cost_micros: 0,
				max_attempts: 1,
			});
			expect(db.prepare(
				"SELECT terminal_at FROM ai_provider_reservations WHERE id='legacy-res'",
			).get()).toEqual({ terminal_at: null });
			expect(db.prepare(
				"SELECT terminal_at FROM ai_provider_reservations WHERE id='legacy-terminal'",
			).get()).toEqual({ terminal_at: 1201 });
			const policyColumns = db.prepare("SELECT name FROM pragma_table_info('ai_routing_policies')").all();
			expect(policyColumns.map((column) => column.name)).toContain("mutation_id");

			const shadow = db.prepare(
				"SELECT claim_token, terminal_at FROM ai_shadow_jobs WHERE id='legacy-shadow'",
			).get();
			expect(shadow).toEqual({ claim_token: null, terminal_at: 1200 });
			const uniqueIndex = db.prepare(
				"SELECT `unique` AS is_unique FROM pragma_index_list('ai_shadow_jobs') WHERE name='uq_ai_shadow_jobs_primary_run'",
			).get();
			expect(uniqueIndex).toEqual({ is_unique: 1 });
		} finally {
			db.close();
		}
	});

	it("fails closed when production preflight would find duplicate primary runs", () => {
		const db = legacyDatabase({ duplicateShadow: true });
		try {
			db.exec(M0055);
			expect(() => db.exec(M0056)).toThrow();
		} finally {
			db.close();
		}
	});
});
