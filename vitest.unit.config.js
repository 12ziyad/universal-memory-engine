import { defineConfig } from "vitest/config";

// Pure pipeline modules can run without starting the Workers pool. This also
// gives local contributors a fast target for source-only policy tests.
export default defineConfig({
	test: {
		environment: "node",
		include: [
			"test/dashboard.spec.js",
			"test/hulls.spec.js",
			"test/layout.spec.js",
			"test/manual_action_router.spec.js",
			"test/manual_adjudicate.spec.js",
			"test/manual_conversation_scope.spec.js",
			"test/manual_extract.spec.js",
			"test/manual_identity.spec.js",
			"test/manual_integrity.spec.js",
			"test/manual_language.spec.js",
			"test/manual_page_synthesis.spec.js",
			"test/manual_plan.spec.js",
			"test/manual_search_profiles.spec.js",
			"test/manual_titles.spec.js",
			"test/title.spec.js",
		],
	},
});
