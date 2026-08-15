/**
 * Library entry. The CLI (`dist/cli.js`) and the hook runner (`dist/hook-entry.js`)
 * are separate executables; this module exposes the same behaviour for tests
 * and for anyone embedding the integration.
 */

export { appDataDirs, credentialsPath, detectHost, FLOORS, meetsFloor, compareVersions, pluginInstallDir, resolveConfig, readCredential, stateRoot } from "./config.js";
export { runDoctor, type DoctorReport } from "./doctor.js";
export {
	drainAfterResponse,
	handlePreInvocation,
	handleStop,
	parsePayload,
	runHook,
	VERIFIED_SUCCESS_TERMINATIONS,
	type HookPayload,
	type HookResult,
} from "./hook.js";
export {
	assertNoLinks,
	buildHookCommand,
	buildHooksJson,
	install,
	readMarker,
	uninstall,
	type InstallOutcome,
	type UninstallOutcome,
} from "./install.js";
export { captureScope, SOURCE } from "./identity.js";
export {
	classify,
	parseEntries,
	readTranscript,
	validateTranscriptPath,
	VERIFIED_SCHEMAS,
	type TranscriptResult,
	type TranscriptTurn,
} from "./transcript.js";
