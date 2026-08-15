import { defineConfig } from "vitest/config";

// Pure pipeline modules can run without starting the Workers pool. This also
// gives local contributors a fast target for source-only policy tests.
export default defineConfig({
	test: {
		environment: "node",
		env: process.platform === "win32" ? {
			ITSUKI_SYSTEM_POWERSHELL: `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
		} : {},
		// Windows integration specs launch the real ACL verifier. Bounding file
		// concurrency keeps those host-budget tests representative instead of
		// turning PowerShell process-start contention into suite-only flakes.
		maxWorkers: process.platform === "win32" ? 1 : 4,
		include: [
			"test/codex_doctor.spec.js",
			"test/codex_hook_manifest.spec.js",
			"test/codex_outbox.spec.js",
			"test/codex_outbox_recovery.spec.js",
			"test/outbox_state_machine.spec.js",
			"test/codex_session_end.spec.js",
			"test/codex_session_start.spec.js",
			"test/codex_transcript.spec.js",
			"test/ingest_contract.spec.js",
			"test/hook_batching.spec.js",
			"test/claude_capture.spec.js",
			"test/claude_transcript.spec.js",
			"test/claude_transcript_tail.spec.js",
			"test/cross_door_project_identity.spec.js",
			"test/doctor.spec.js",
			"test/hook_manifest.spec.js",
			"test/hook_outbox.spec.js",
			"test/mcp_diagnostic.spec.js",
			"test/project_identity.spec.js",
			"test/session_end_delivery.spec.js",
			"test/session_start_delivery.spec.js",
			"test/dashboard.spec.js",
			"test/eval_extraction.spec.js",
			"test/hulls.spec.js",
			"test/temporal_holdout.spec.js",
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
			// Source-policy guard: reads the migrations directory from disk, so
			// it belongs here rather than in the Workers pool.
			"test/migrations_append_only.spec.js",
			// Same reason: compares each adapter package's vendored kernel copy
			// against packages/_kernel on disk.
			"test/kernel-parity.spec.js",
			"test/recall_gate.spec.js",
			"test/sdk_js.spec.js",
			"test/security_corpus_plugins.spec.js",
			"test/title.spec.js",
		],
	},
});
