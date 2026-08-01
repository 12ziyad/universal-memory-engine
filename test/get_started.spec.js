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
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";

// The origin the specs simulate the page running on. One constant so a domain
// move is a one-line change here; the page itself only ever sees location.origin.
const FIXTURE_ORIGIN = "https://uml.gpmai.workers.dev";

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
		{ origin: FIXTURE_ORIGIN },
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
		expect(withKey.mcpUrl).toBe(`${FIXTURE_ORIGIN}/mcp/itsuki_live_abc123`);
		expect(withKey.claudeCode).toContain("itsuki_live_abc123");
		expect(withKey.cursor).toContain("itsuki_live_abc123");
		for (const value of Object.values(withKey)) {
			expect(String(value)).not.toContain("YOUR_MCP_KEY");
		}
		// No key yet → the placeholder, which is what makes the block un-copyable.
		expect(installSnippets().mcpUrl).toContain("YOUR_MCP_KEY");
	});

	it("turns the copy affordance into the create-link button until a key exists", () => {
		expect(script).toContain("const locked = text.includes(MCP_KEY_PLACEHOLDER);");
		expect(script).toContain(`<button class="code-create" onclick="createInstallKey()">Create link</button>`);
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
	// The setup page's job is to be short. These strings are the agreed copy;
	// if someone re-expands them into paragraphs, this goes red.
	it("uses the short step copy, one line each", () => {
		for (const [title, body] of [
			["Create your link", '"Shown once. Save it."'],
			["Add it to Claude", '"Desktop only. Syncs to your phone after."'],
			["Turn it on", "`Tap +, choose Connectors, enable ${name}.`"],
		]) {
			expect(script, title).toContain(`{ title: "${title}", body: ${body},`);
		}
		// The paragraph-length versions are gone.
		expect(script).not.toContain("It carries your private key, so it is shown once and never again.");
		expect(script).not.toContain("Use a computer — the phone apps cannot add connectors.");
	});

	it("states the plan requirement as one muted line, not a banner", () => {
		expect(script).toContain('hint: "Needs a paid Claude plan."');
		expect(script).toContain('class="install-hint"');
		// The amber callout is gone entirely.
		expect(script).not.toContain('class="install-callout"');
		expect(css).not.toContain(".install-callout {");
	});

	it("keeps the add-custom-connector deep link, on the step title", () => {
		expect(script).toContain("https://claude.ai/settings/connectors?modal=add-custom-connector");
		expect(script).toContain("titleHref:");
		expect(script).toContain('class="step-title-link"');
	});

	it("names the tool in the phrase to say", () => {
		expect(script).toContain('codeLabel: "say this", code: () => `save this to ${name}`');
		expect(script).not.toContain('Then simply say <i>"remember this"</i>');
	});
});

describe("ChatGPT tab", () => {
	it("keeps the full click path in order, with Developer mode as its own step", () => {
		const order = [
			"Settings → Apps & connectors.",
			"Advanced settings, at the bottom. Leave it on.",
			"A Create button appears.",
			"authentication None",
			"The tools menu only refreshes on a new one.",
			"Click + → More → Developer tools",
		];
		let cursor = -1;
		for (const phrase of order) {
			const at = script.indexOf(phrase);
			expect(at, phrase).toBeGreaterThan(cursor);
			cursor = at;
		}
		expect(script).toContain('{ title: "Turn on Developer mode"');
	});

	it("says the plan requirement once, muted", () => {
		expect(script).toContain('hint: "Needs a paid ChatGPT plan, on the web."');
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
			url: `${FIXTURE_ORIGIN}/mcp/itsuki_live_xyz`,
		});
	});

	it("keeps the mcp.json config as its own step", () => {
		expect(script).toContain("Add to Cursor");
		expect(script).toContain('codeLabel: "mcp.json", code: (key) => installSnippets(key).cursor');
		expect(script).toContain('{ title: "Or paste the config", body: "Works in any other MCP editor."');
	});
});

describe("the visual redesign", () => {
	it("drops the panel that wrapped the steps", () => {
		expect(script).toContain('<div class="steps">');
		expect(script).not.toContain('class="steps-panel"');
		expect(css).not.toContain(".steps-panel {");
		// The horizontal dividers are replaced by one vertical hairline.
		expect(css).not.toMatch(/\.step-row \{[^}]*border-bottom/);
		expect(css).toContain(".step-row:not(:last-child) .step-left::before");
	});

	it("gives every method card and client tab an icon", () => {
		for (const door of ["ICON.link", "ICON.code", "ICON.plug"]) expect(script).toContain(`icon: ${door}`);
		for (const client of ["ICON.spark", "ICON.hex", "ICON.pointer", "ICON.terminal", "ICON.hexN", "ICON.chevron"]) {
			expect(script).toContain(`icon: ${client}`);
		}
		expect(script).toContain('<span class="mc-icon">${m.icon ?? ""}</span>');
		expect(script).toContain('">${c.icon ?? ""}${esc(c.label)}</button>');
		// Inline SVG only — an icon CDN would undo the no-third-party promise.
		expect(script).toContain('const ICON = ((paths) =>');
	});

	it("shortens the method card subtitles", () => {
		for (const blurb of ['blurb: "Claude and ChatGPT"', 'blurb: "Your own app"', 'blurb: "Your coding agent"']) {
			expect(script).toContain(blurb);
		}
		expect(script).not.toContain("One link — Claude and ChatGPT remember you");
	});

	it("uses a small dark step badge, not a large accent one", () => {
		expect(css).toMatch(/\.step-num \{[^}]*width: 22px; height: 22px[^}]*background: var\(--text\)/s);
	});

	it("restyles code blocks: light surface, labelled header, copy icon", () => {
		expect(script).toContain("function installCodeBlock(");
		expect(script).toContain('<div class="code-head"><span class="code-label">');
		expect(script).toContain('<button class="code-copy"');
		expect(script).toContain("function copyCode(");
		// No black background and no large filled Copy button left.
		expect(css).not.toContain("background: #0d1117; color: #dbe7ee");
		expect(script).not.toContain('class="copy-btn mini"');
		expect(css).toMatch(/\.install-code \{[^}]*border-radius: 8px/s);
	});

	it("labels every code block", () => {
		const codeSteps = script.match(/\bcode: \((?:key|)\) =>/g) ?? [];
		const labels = script.match(/\bcodeLabel: "/g) ?? [];
		expect(labels.length).toBe(codeSteps.length);
	});
});
