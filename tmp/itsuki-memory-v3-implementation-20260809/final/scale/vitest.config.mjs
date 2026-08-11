import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..", "..");
const migrations = await readD1Migrations(path.join(repo, "migrations"));
const scale = String(process.env.ITSUKI_FINAL_SCALE_SIZE ?? "1000");

export default defineConfig({
	root: repo,
	plugins: [
		cloudflareTest({
			wrangler: { configPath: path.join(repo, "wrangler.test.jsonc") },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					USE_VECTORS: "false",
					ENABLE_PASS2: "true",
					DO_WAKE_ALARMS: "false",
					ENABLE_TEST_OVERRIDES: "true",
					FINAL_SCALE_SIZE: scale,
				},
			},
		}),
	],
	test: {
		include: ["tmp/itsuki-memory-v3-implementation-20260809/final/scale/scale.spec.js"],
		setupFiles: [path.join(repo, "test", "apply-migrations.js")],
		disableConsoleIntercept: true,
		testTimeout: 900_000,
		hookTimeout: 900_000,
	},
});
