const DOCTOR_ARGS = [
	"${CLAUDE_PLUGIN_ROOT}/hooks/doctor-hook.mjs",
	"--plugin-data",
	"${CLAUDE_PLUGIN_DATA}",
];
const START_ARGS = [
	"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs",
	"--plugin-data",
	"${CLAUDE_PLUGIN_DATA}",
];
const END_ARGS = [
	"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs",
	"--plugin-data",
	"${CLAUDE_PLUGIN_DATA}",
];

function hasExactKeys(value, expected) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length
		&& actual.every((key, index) => key === wanted[index]);
}

function hasExactArgs(actual, expected) {
	return Array.isArray(actual)
		&& actual.length === expected.length
		&& actual.every((value, index) => value === expected[index]);
}

function exactCommandHook(value, args, timeout) {
	const expectedKeys = timeout == null
		? ["args", "command", "type"]
		: ["args", "command", "timeout", "type"];
	return hasExactKeys(value, expectedKeys)
		&& value.type === "command"
		&& value.command === "${user_config.node_executable}"
		&& hasExactArgs(value.args, args)
		&& (timeout == null || value.timeout === timeout);
}

/** Security-critical, install-time contract used by the trusted doctor hook. */
export function validatePluginContract({ manifest, registered, legacyMcpPresent = false } = {}) {
	const userConfig = manifest?.userConfig;
	const nodeConfig = userConfig?.node_executable;
	const keyConfig = userConfig?.itsuki_api_key;
	const servers = manifest?.mcpServers;
	const mcp = servers?.itsuki;
	const registrations = registered?.hooks;

	if (legacyMcpPresent || manifest?.name !== "itsuki" || manifest?.version !== "0.6.0") return false;
	if (!hasExactKeys(userConfig, ["itsuki_api_key", "node_executable"])) return false;
	if (!hasExactKeys(nodeConfig, ["description", "required", "title", "type"])
		|| nodeConfig.type !== "file" || nodeConfig.required !== true) return false;
	if (!hasExactKeys(keyConfig, ["description", "required", "sensitive", "title", "type"])
		|| keyConfig.type !== "string" || keyConfig.sensitive !== true || keyConfig.required !== true) return false;
	if (!hasExactKeys(servers, ["itsuki"]) || !hasExactKeys(mcp, ["headers", "type", "url"])) return false;
	if (mcp.type !== "http" || mcp.url !== "https://itsuki.app/mcp") return false;
	if (!hasExactKeys(mcp.headers, ["Authorization"])
		|| mcp.headers.Authorization !== "Bearer ${user_config.itsuki_api_key}") return false;

	if (!hasExactKeys(registrations, ["SessionEnd", "SessionStart", "UserPromptExpansion"])) return false;
	const doctorEntries = registrations.UserPromptExpansion;
	const startEntries = registrations.SessionStart;
	const endEntries = registrations.SessionEnd;
	if (!Array.isArray(doctorEntries) || doctorEntries.length !== 1
		|| !Array.isArray(startEntries) || startEntries.length !== 1
		|| !Array.isArray(endEntries) || endEntries.length !== 1) return false;

	const doctorEntry = doctorEntries[0];
	const startEntry = startEntries[0];
	const endEntry = endEntries[0];
	if (!hasExactKeys(doctorEntry, ["hooks", "matcher"])
		|| doctorEntry.matcher !== "^(?:doctor|itsuki:doctor)$"
		|| !Array.isArray(doctorEntry.hooks) || doctorEntry.hooks.length !== 1
		|| !exactCommandHook(doctorEntry.hooks[0], DOCTOR_ARGS, 30)) return false;
	if (!hasExactKeys(startEntry, ["hooks"])
		|| !Array.isArray(startEntry.hooks) || startEntry.hooks.length !== 1
		|| !exactCommandHook(startEntry.hooks[0], START_ARGS, 15)) return false;
	return hasExactKeys(endEntry, ["hooks"])
		&& Array.isArray(endEntry.hooks) && endEntry.hooks.length === 1
		&& exactCommandHook(endEntry.hooks[0], END_ARGS, null);
}
