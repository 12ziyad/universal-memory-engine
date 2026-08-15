import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.spec.ts"],
		environment: "node",
		// The spool tests touch a real temp directory; running files serially
		// keeps their fixtures from racing each other on Windows.
		fileParallelism: false,
	},
});
