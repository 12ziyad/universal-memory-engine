import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validatePluginContract } from "../hooks/plugin-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function json(path) {
	return JSON.parse(await readFile(join(ROOT, path), "utf8"));
}

async function text(path) {
	return readFile(join(ROOT, path), "utf8");
}

describe("Claude hook installation contract", () => {
	it("uses exec-form hooks and Claude's persistent plugin-data directory", async () => {
		const registered = await json("hooks/hooks.json");
		const doctor = registered.hooks.UserPromptExpansion[0];
		const start = registered.hooks.SessionStart[0].hooks[0];
		const end = registered.hooks.SessionEnd[0].hooks[0];

		expect(doctor).toMatchObject({
			matcher: "^(?:doctor|itsuki:doctor)$",
			hooks: [{
				type: "command",
				command: "${user_config.node_executable}",
				args: [
					"${CLAUDE_PLUGIN_ROOT}/hooks/doctor-hook.mjs",
					"--plugin-data",
					"${CLAUDE_PLUGIN_DATA}",
				],
				timeout: 30,
			}],
		});

		expect(start).toMatchObject({
			type: "command",
			command: "${user_config.node_executable}",
			args: [
				"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs",
				"--plugin-data",
				"${CLAUDE_PLUGIN_DATA}",
			],
		});
		expect(start.timeout).toBeGreaterThanOrEqual(12);
		expect(end).toEqual({
			type: "command",
			command: "${user_config.node_executable}",
			args: [
				"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs",
				"--plugin-data",
				"${CLAUDE_PLUGIN_DATA}",
			],
		});
		expect(end).not.toHaveProperty("timeout");
		expect(end).not.toHaveProperty("async");
	});

	it("ships the outbox change as a new plugin version without ignored setup metadata", async () => {
		const manifest = await json(".claude-plugin/plugin.json");

		expect(manifest).toMatchObject({ name: "itsuki", version: "0.6.0" });
		expect(manifest.userConfig).toMatchObject({
			node_executable: { type: "file", required: true },
			itsuki_api_key: { type: "string", sensitive: true, required: true },
	});
		expect(manifest.mcpServers.itsuki.headers.Authorization)
			.toBe("Bearer ${user_config.itsuki_api_key}");
		expect(manifest).not.toHaveProperty("metadata");
		await expect(readFile(join(ROOT, ".mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects every security-critical manifest or lifecycle-hook contract mutation", async () => {
		const manifest = await json(".claude-plugin/plugin.json");
		const registered = await json("hooks/hooks.json");
		expect(validatePluginContract({ manifest, registered })).toBe(true);

		const mutations = [
			["legacy root MCP config", (value) => { value.legacyMcpPresent = true; }],
			["plugin version", ({ manifest: value }) => { value.version = "0.6.1"; }],
			["key type", ({ manifest: value }) => { value.userConfig.itsuki_api_key.type = "file"; }],
			["key sensitivity", ({ manifest: value }) => { value.userConfig.itsuki_api_key.sensitive = false; }],
			["node type", ({ manifest: value }) => { value.userConfig.node_executable.type = "string"; }],
			["extra user option", ({ manifest: value }) => { value.userConfig.service_url = { type: "string" }; }],
			["MCP transport", ({ manifest: value }) => { value.mcpServers.itsuki.type = "sse"; }],
			["MCP origin", ({ manifest: value }) => { value.mcpServers.itsuki.url = "https://example.invalid/mcp"; }],
			["MCP credential header", ({ manifest: value }) => { value.mcpServers.itsuki.headers.Authorization = "Bearer inherited"; }],
			["doctor matcher", ({ registered: value }) => { value.hooks.UserPromptExpansion[0].matcher = ".*"; }],
			["doctor duplicate", ({ registered: value }) => { value.hooks.UserPromptExpansion.push(value.hooks.UserPromptExpansion[0]); }],
			["doctor async", ({ registered: value }) => { value.hooks.UserPromptExpansion[0].hooks[0].async = true; }],
			["missing SessionStart", ({ registered: value }) => { delete value.hooks.SessionStart; }],
			["SessionStart command", ({ registered: value }) => { value.hooks.SessionStart[0].hooks[0].command = "node"; }],
			["SessionStart timeout", ({ registered: value }) => { value.hooks.SessionStart[0].hooks[0].timeout = 14; }],
			["SessionStart async", ({ registered: value }) => { value.hooks.SessionStart[0].hooks[0].async = true; }],
			["missing SessionEnd", ({ registered: value }) => { delete value.hooks.SessionEnd; }],
			["SessionEnd timeout", ({ registered: value }) => { value.hooks.SessionEnd[0].hooks[0].timeout = 5; }],
			["SessionEnd async", ({ registered: value }) => { value.hooks.SessionEnd[0].hooks[0].async = true; }],
		];
		for (const [label, mutate] of mutations) {
			const changed = structuredClone({ manifest, registered });
			mutate(changed);
			expect(validatePluginContract(changed), label).toBe(false);
		}
	});

	it("keeps the doctor and public plugin setup on trusted runtime and userConfig paths", async () => {
		const [command, landing, docs, securityHelper] = await Promise.all([
			text("commands/doctor.md"),
			text("public/index.html"),
			text("public/docs/index.html"),
			text("hooks/outbox-security.ps1"),
		]);
		const pluginPanelStart = landing.indexOf('"claude-code": {');
		const pluginPanelEnd = landing.indexOf("\n\t\t\t\t},", pluginPanelStart);
		expect(pluginPanelStart).toBeGreaterThan(-1);
		expect(pluginPanelEnd).toBeGreaterThan(pluginPanelStart);
		const pluginPanel = landing.slice(pluginPanelStart, pluginPanelEnd);

		expect(command).toContain("disable-model-invocation: true");
		expect(command).toContain("must intercept every user-typed");
		expect(command).toContain("only the user may confirm it by typing");
		expect(command).not.toContain("scripts/doctor.mjs");
		expect(command).not.toMatch(/```(?:bash|sh|shell)?[\s\S]*?```/i);
		expect(command).not.toMatch(/(^|\n)node\s+"\$\{CLAUDE_PLUGIN_ROOT\}/);
		expect(pluginPanel).toContain("absolute Node executable");
		expect(pluginPanel).toContain("masked key prompt");
		expect(pluginPanel).toContain("/plugin configure itsuki@itsuki-plugins");
		expect(pluginPanel).not.toContain("ITSUKI_API_KEY");
		expect(pluginPanel).not.toContain("setx ");
		expect(docs).toContain("/plugin configure ${PRODUCT.pkg}@itsuki-plugins");
		expect(docs).toContain("workspace-controlled <code>PATH</code>");
		expect(securityHelper).not.toMatch(/Get-ChildItem[^\r\n]*-Recurse/i);
	});
});
