import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const migrationsPath = path.join(__dirname, "migrations");
	const migrations = await readD1Migrations(migrationsPath);

	return {
		test: {
			setupFiles: ["./test/apply-migrations.js"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
					miniflare: {
						// Disable the external-service paths (Workers AI / Vectorize) so the
						// suite is deterministic and offline. The LLM is stubbed per-test via
						// the request `_test.llmResponse` hook; trigger/gates/write/checkpoint
						// all run as the real code under test.
						bindings: {
							TEST_MIGRATIONS: migrations,
							USE_VECTORS: "false",
							ENABLE_PASS2: "true",
						},
					},
				},
			},
		},
	};
});
