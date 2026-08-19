import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
	const migrationsPath = path.join(configDirectory, "migrations");
	const migrations = await readD1Migrations(migrationsPath);

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.test.jsonc" },
				miniflare: {
					// Disable the external-service paths (Workers AI / Vectorize) so the
					// suite is deterministic and offline. The LLM is stubbed per-test via
					// the request `_test.llmResponse` hook; trigger/gates/write/checkpoint
					// all run as the real code under test.
					bindings: {
						TEST_MIGRATIONS: migrations,
						USE_VECTORS: "false",
						ENABLE_PASS2: "true",
						// The DO's self-arming wake alarms are structural in prod
						// (queue in storage + alarm + cron sweep) but fire across
						// test boundaries here, corrupting the pool's stacked
						// storage. Tests drive drains explicitly instead.
						DO_WAKE_ALARMS: "false",
						ENABLE_TEST_OVERRIDES: "true",
					},
				},
			}),
		],
		test: {
			// Product suites live under test/. Campaign evidence may contain
			// executable regression helpers whose names end in `.test.mjs`; letting
			// Vitest discover ignored evidence under tmp/ turns a helper that exits
			// zero into a false "no test suite" gate failure.
			include: ["test/**/*.spec.js"],
			exclude: [
				...configDefaults.exclude,
				// These exercise host filesystem/process behavior and are covered by
				// vitest.unit.config.mjs; the Workers isolate cannot import those APIs.
				"test/claude_transcript_tail.spec.js",
				"test/codex_hook_manifest.spec.js",
				"test/codex_doctor.spec.js",
				"test/codex_outbox.spec.js",
				"test/codex_outbox_recovery.spec.js",
				"test/outbox_state_machine.spec.js",
				"test/codex_session_end.spec.js",
				"test/codex_session_start.spec.js",
				"test/codex_transcript.spec.js",
				"test/cross_door_project_identity.spec.js",
				"test/doctor.spec.js",
				"test/hook_batching.spec.js",
				"test/hook_manifest.spec.js",
				"test/hook_outbox.spec.js",
				"test/kernel-parity.spec.js",
				"test/migrations_append_only.spec.js",
				// Parses migrations/*.sql from disk; unit config only.
				"test/schema_census.spec.js",
				"test/project_identity.spec.js",
				"test/sdk_js.spec.js",
				"test/temporal_holdout.spec.js",
				"test/security_corpus_plugins.spec.js",
				"test/session_end_delivery.spec.js",
				"test/session_start_delivery.spec.js",
			],
			setupFiles: ["./test/apply-migrations.js"],
		},
	};
});
