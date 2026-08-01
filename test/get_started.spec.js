/**
 * Get started — the App Connect door.
 *
 * The page used to ship a code block containing the literal string
 * YOUR_MCP_KEY behind a Copy button, so the copy button handed people a URL
 * that could not work. These specs pin the fix: one key variable, code blocks
 * that are functions of it, and no copy affordance before a key exists.
 *
 * Where a rule is behavioural (the Cursor deep link, key substitution) the
 * spec pulls the real function out of the shipped page and runs it, rather
 * than matching on source text.
 */

import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

/** Pull one top-level function's source out of the single-file app. */
function fnSource(name) {
	const start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	let depth = 0;
	let seenBody = false;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "{") { depth++; seenBody = true; }
		else if (script[i] === "}") {
			depth--;
			if (seenBody && depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

/** Build the named functions with stand-ins for the browser globals they use. */
function build(names, returnName) {
	const source = names.map(fnSource).join("\n");
	const placeholder = script.match(/const MCP_KEY_PLACEHOLDER = "([^"]+)";/)?.[1];
	return new Function(
		"location",
		"PRODUCT",
		"MCP_KEY_PLACEHOLDER",
		`${source}\nreturn ${returnName};`,
	)(
		{ origin: "https://uml.gpmai.workers.dev" },
		{ name: "Itsuki", tokenPrefix: "itsuki_live_" },
		placeholder,
	);
}

describe("the key rule", () => {
	it("mentions YOUR_MCP_KEY exactly once, as the fallback constant", () => {
		const hits = script.match(/YOUR_MCP_KEY/g) ?? [];
		expect(hits).toHaveLength(1);
		expect(script).toContain('const MCP_KEY_PLACEHOLDER = "YOUR_MCP_KEY";');
	});

	it("reads the key from one place", () => {
		expect(script).toContain("function installKey() {");
		expect(script).toContain('S.oneTimeToken?.tokenRecord?.type === "mcp"');
		// Every code() takes the key as its argument; nothing reaches around it.
		expect(script).toContain("code: (key) => installSnippets(key).mcpUrl");
		expect(script).toContain("const code = step.code ? step.code(state.key ?? MCP_KEY_PLACEHOLDER) : null;");
	});

	it("substitutes the real key into every snippet that carries one", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_abc123");
		expect(withKey.mcpUrl).toBe("https://uml.gpmai.workers.dev/mcp/itsuki_live_abc123");
		expect(withKey.claudeCode).toContain("itsuki_live_abc123");
		expect(withKey.cursor).toContain("itsuki_live_abc123");
		for (const value of Object.values(withKey)) {
			expect(String(value)).not.toContain("YOUR_MCP_KEY");
		}
		// No key yet → the placeholder, which is what makes the block un-copyable.
		expect(installSnippets().mcpUrl).toContain("YOUR_MCP_KEY");
	});

	it("turns the copy button into the create-link button until a key exists", () => {
		expect(script).toContain("const locked = text.includes(MCP_KEY_PLACEHOLDER);");
		expect(script).toContain(`<button class="copy-btn mini" onclick="createInstallKey()">Create link</button>`);
		expect(script).toContain("function createInstallKey() {");
	});

	it("warns before the tab closes while a one-time key is in memory", () => {
		expect(script).toContain("function installKeyGuard() {");
		expect(script).toContain('window.addEventListener("beforeunload"');
		expect(script).toContain("if (!S.oneTimeToken) return;");
		expect(script).toContain("installKeyGuard();");
	});
});

describe("one config, one state, one renderer", () => {
	it("declares three doors and renders from state alone", () => {
		expect(script).toContain("appConnect: {");
		expect(script).toMatch(/\n\t\tsdk: \{/);
		expect(script).toMatch(/\n\t\tplugin: \{/);
		expect(script).toContain("const doors = installMethods();");
		expect(script).toContain("const state = {");
		// One markup template for every step, not nine near-identical blocks.
		expect((script.match(/class="step-num"/g) ?? [])).toHaveLength(1);
		expect((script.match(/class="method-card /g) ?? [])).toHaveLength(1);
	});
});

describe("Claude tab", () => {
	it("says up front that custom connectors need a paid plan", () => {
		expect(script).toContain("Custom connectors need a paid Claude plan.");
		expect(script).toContain('class="install-callout"');
	});

	it("keeps the add-custom-connector deep link", () => {
		expect(script).toContain("https://claude.ai/settings/connectors?modal=add-custom-connector");
	});

	it("names the tool in the example phrase instead of overpromising", () => {
		expect(script).toContain("save this to ${name}");
		expect(script).not.toContain('Then simply say <i>"remember this"</i>');
	});
});

describe("ChatGPT tab", () => {
	it("warns that it is longer than Claude", () => {
		expect(script).toContain("ChatGPT takes more steps than Claude");
		expect(script).toContain("Requires ChatGPT on the web (not the phone app) and a paid plan.");
	});

	it("follows the real click path, in order", () => {
		const order = [
			"Settings → Apps & connectors. The menu may read Apps, Connectors, or Apps & connectors",
			"Open Advanced settings at the bottom of the panel, and turn Developer mode on.",
			"A Create button now appears next to your enabled apps and connectors.",
			"set authentication to None",
			"The tools menu only refreshes on a new one.",
			"Click + → More → Developer tools",
		];
		let cursor = -1;
		for (const phrase of order) {
			const at = script.indexOf(phrase);
			expect(at, phrase).toBeGreaterThan(cursor);
			cursor = at;
		}
		expect(script).toContain("Developer mode has to stay on. Turn it off and the connector can't be selected.");
	});

	it("never invents a ChatGPT settings deep link", () => {
		expect(script).not.toMatch(/chatgpt\.com\/[#?]?settings|chat\.openai\.com\/[#?]?settings/i);
	});
});

describe("Cursor tab", () => {
	it("builds a real one-click install deep link", () => {
		const cursorInstallLink = build(["cursorInstallLink"], "cursorInstallLink");
		const link = cursorInstallLink("itsuki_live_xyz");
		expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=Itsuki&config=")).toBe(true);
		const config = decodeURIComponent(link.split("config=")[1]);
		expect(JSON.parse(atob(config))).toEqual({
			type: "http",
			url: "https://uml.gpmai.workers.dev/mcp/itsuki_live_xyz",
		});
	});

	it("keeps the mcp.json config underneath as the fallback", () => {
		expect(script).toContain("Add to Cursor");
		expect(script).toContain("code: (key) => installSnippets(key).cursor");
		expect(script).toContain("Paste the config above into <b>.cursor/mcp.json</b> instead");
	});
});
