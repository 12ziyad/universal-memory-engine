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
const FIXTURE_ORIGIN = "https://itsuki.app";

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
		// A one-time secret and an unsaved Settings draft are both browser-memory
		// state that must not disappear on an accidental close.
		expect(script).toContain("if (!S.oneTimeToken && !setHasUnsavedWork() && !setMutationBusy()");
		expect(script).toContain("&& !PROJECT_CREATE.open && !ORG_CREATE.open) return;");
		expect(script).toContain("installKeyGuard();");
	});
});

describe("one config, one state, one renderer", () => {
	it("declares five doors and renders from state alone", () => {
		expect(script).toContain("appConnect: {");
		expect(script).toMatch(/\n\t\tsdk: \{/);
		expect(script).toMatch(/\n\t\tintegrations: \{/);
		expect(script).toMatch(/\n\t\tplugin: \{/);
		expect(script).toContain("const doors = installMethods();");
		expect(script).toContain("const state = {");
		// One markup template for every step, not nine near-identical blocks.
		expect((script.match(/class="step-num"/g) ?? [])).toHaveLength(1);
		expect((script.match(/class="method-card /g) ?? [])).toHaveLength(1);
	});

	it("offers both validated coding-agent plugins", () => {
		expect(script).toContain('label: "Claude Code"');
		expect(script).toContain('label: "Codex"');
		expect(script).toContain("codexMarketplace");
		expect(script).toContain("codexInstall");
	});
});

describe("SDK integration", () => {
	it("uses the shipped Python, TypeScript, and REST contracts", () => {
		const installSnippets = build(["installSnippets"], "installSnippets")();

		expect(script).toContain('label: "Python"');
		expect(script).toContain('label: "TypeScript"');
		expect(script).toContain('label: "cURL API"');
		expect(script).not.toContain('label: "Node.js"');

		expect(installSnippets.pythonInstall).toBe("pip install itsuki");
		expect(installSnippets.pythonInit).toContain("from itsuki import MemoryClient");
		expect(installSnippets.pythonAdd).toContain("memory.add_conversation(");
		expect(installSnippets.pythonSearch).toContain('memory.search(query, user_id="alex")');

		expect(installSnippets.typescriptInstall).toBe("npm install itsuki");
		expect(installSnippets.typescriptInit).toContain('import { MemoryClient } from "itsuki";');
		expect(installSnippets.typescriptAdd).toContain("memory.addConversation(messages,");
		expect(installSnippets.typescriptSearch).toContain('memory.search(query, { userId: "alex" })');

		expect(installSnippets.curlAdd).toContain(`${FIXTURE_ORIGIN}/v1/save`);
		expect(installSnippets.curlAdd).toContain('\"mode\": \"conversation\"');
		expect(installSnippets.curlSearch).toContain(`${FIXTURE_ORIGIN}/v1/recall`);
	});

	it("shows the four real integration steps instead of generic tenant filler", () => {
		for (const title of ["Install the SDK", "Initialize the client", "Add memory", "Retrieve memory"]) {
			expect(script).toContain(`title: "${title}"`);
		}
		expect(script).not.toContain('title: "Serving many users?"');
	});
});

describe("coding-agent plugins", () => {
	it("shows concise install, connect, trust, and verification actions", () => {
		const installSnippets = build(["installSnippets"], "installSnippets")();
		expect(installSnippets.claudePluginInstall).toContain("claude plugin marketplace add 12ziyad/universal-memory-engine");
		expect(installSnippets.claudePluginInstall).toContain("claude plugin install itsuki@itsuki-plugins");
		expect(installSnippets.claudeConfigure).toContain("/plugin configure itsuki@itsuki-plugins");
		expect(installSnippets.claudeVerify).toBe("/itsuki:doctor");

		expect(installSnippets.codexMarketplace).toBe("codex plugin marketplace add 12ziyad/universal-memory-engine");
		expect(installSnippets.codexInstall).toBe("codex plugin add itsuki@itsuki-plugins");
		expect(installSnippets.codexCredential).toContain("ITSUKI_API_KEY=YOUR_API_KEY");
		expect(installSnippets.codexTrust).toBe("/hooks");
		expect(installSnippets.codexVerify).toContain("codex plugin list --json");
		expect(installSnippets.codexVerify).toContain("codex mcp list --json");
	});

	it("removes the old paragraph-heavy plugin explanation", () => {
		expect(script).not.toContain("The whole setup, in order:");
		expect(script).not.toContain("That is everything");
		expect(script).not.toContain("Looking for Claude or ChatGPT?");
		expect(script).not.toContain("copyOnly:");
	});
});

describe("Claude tab", () => {
	// The setup page's job is to be short. These strings are the agreed copy;
	// if someone re-expands them into paragraphs, this goes red.
	it("uses the short step copy, one line each", () => {
		for (const [title, body] of [
			["Create your link", '"Shown once. Save it."'],
			["Add it to Claude", '"Customize → Connectors → + → Add custom connector."'],
			["Turn it on", "`Tap +, choose Connectors, enable ${name}.`"],
		]) {
			expect(script, title).toContain(`{ title: "${title}", body: ${body},`);
		}
		// The paragraph-length versions are gone.
		expect(script).not.toContain("It carries your private key, so it is shown once and never again.");
		expect(script).not.toContain("Use a computer — the phone apps cannot add connectors.");
	});

	it("states the plan requirement as one muted line, not a banner", () => {
		expect(script).toContain('hint: "Beta on all Claude plans; Free is limited to one custom connector."');
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
			"A workspace admin uses ChatGPT on the web.",
			"Settings → Apps → Advanced settings, subject to workspace policy.",
			"review its tools and write permissions",
			"Make the reviewed app available to the workspace.",
			"write actions may require confirmation",
		];
		let cursor = -1;
		for (const phrase of order) {
			const at = script.indexOf(phrase);
			expect(at, phrase).toBeGreaterThan(cursor);
			cursor = at;
		}
		expect(script).toContain('{ title: "Enable Developer mode"');
	});

	it("says the plan requirement once, muted", () => {
		expect(script).toContain('hint: "Full save + recall currently needs Business or Enterprise/Edu on the web."');
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
	it("centers a compact setup canvas instead of pinning it to the rail", () => {
		expect(fnSource("viewInstall")).toContain('wrap.className = "install-layout";');
		expect(fnSource("viewOverview")).not.toContain('wrap.className = "install-layout";');
		expect(css).toContain(".install-layout { width: min(1080px, 100%); margin: 0 auto; }");
		expect(css).toMatch(/\.step-row \{[^}]*grid-template-columns: minmax\(220px, 340px\) minmax\(0, 1fr\)/s);
	});

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
		for (const client of ["BRAND.claude", "BRAND.chatgpt", "ICON.pointer", "BRAND.python", "BRAND.typescript", "ICON.chevron", "BRAND.codex"]) {
			expect(script).toContain(`icon: ${client}`);
		}
		expect(script).toContain('<span class="mc-icon">${m.icon ?? ""}</span>');
		expect(script).toContain('">${c.icon ?? ""}${esc(c.label)}</button>');
		// Neutral glyphs stay inline and product marks stay self-hosted; no icon CDN.
		expect(script).toContain('const ICON = ((paths) =>');
		expect(script).toContain('const BRAND = Object.freeze({');
		for (const path of ["/assets/brands/claude.png", "/assets/brands/codex.png", "/assets/brands/python.png", "/assets/brands/typescript.png"]) {
			expect(script).toContain(path);
		}
	});

	it("shortens the method card subtitles", () => {
		for (const blurb of ['blurb: "Claude and ChatGPT"', 'blurb: "Your own app"', 'blurb: "Your coding agent"']) {
			expect(script).toContain(blurb);
		}
		expect(script).not.toContain("One link — Claude and ChatGPT remember you");
	});

	it("uses a compact product-accent step badge", () => {
		expect(css).toMatch(/\.step-num \{[^}]*width: 22px; height: 22px[^}]*background: var\(--accent\)[^}]*color: var\(--on-accent\)/s);
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

/** Execute the real installMethods() with inert stand-ins for page globals. */
function buildMethods() {
	const source = ["installMethods", "installSnippets", "cursorInstallLink"].map(fnSource).join("\n");
	const placeholder = script.match(/const MCP_KEY_PLACEHOLDER = "([^"]+)";/)?.[1];
	const iconProxy = new Proxy({}, { get: () => "<svg/>" });
	return new Function(
		"location", "PRODUCT", "MCP_KEY_PLACEHOLDER", "ICON", "BRAND",
		"esc", "projectCan", "projectCapabilityActionCopy",
		`${source}\nreturn installMethods;`,
	)(
		{ origin: FIXTURE_ORIGIN },
		{ name: "Itsuki", tokenPrefix: "itsuki_live_" },
		placeholder,
		iconProxy,
		iconProxy,
		(value) => String(value),
		() => true,
		() => "",
	)();
}

describe("Agents door and the variant chooser", () => {
	it("declares the agents door at the same two-tab level as the others", () => {
		expect(script).toMatch(/\n\t\tagents: \{/);
	});

	it("keeps App Connect to Claude and ChatGPT, and grows the plugin door", () => {
		const doors = buildMethods();
		expect(Object.keys(doors.appConnect.clients)).toEqual(["claude", "chatgpt"]);
		expect(Object.keys(doors.plugin.clients)).toEqual(["claude-code", "codex", "cursor", "opencode", "antigravity"]);
		expect(Object.keys(doors.agents.clients)).toEqual(["openclaw", "hermes", "pi"]);
	});

	it("the Integrations door carries frameworks and tools, grouped by ecosystem", () => {
		const doors = buildMethods();
		expect(Object.keys(doors.integrations.clients)).toEqual(["python", "typescript", "n8n", "dify", "convex"]);
		expect(Object.keys(doors.integrations.clients.python.variants)).toEqual([
			"langchain", "crewai", "autogen", "agno", "openai-agents", "google-adk", "llamaindex",
			// Native packages: the framework calls memory through its own
			// interface instead of MCP. Each is published and canary-proven
			// against production before it may appear here.
			"agno-native", "llamaindex-native", "camel-native",
		]);
		expect(Object.keys(doors.integrations.clients.typescript.variants)).toEqual([
			"mastra", "vercel-ai", "mastra-native", "vercel-ai-native",
		]);
		expect(Object.keys(doors.integrations.clients.n8n.variants)).toEqual(["native", "http", "mcp"]);
		// Unverified frameworks must not ship — the no-dead-commands rule.
		// chatdev-itsuki is HELD and unpublished, so `pip install chatdev-itsuki`
		// would be a dead command; camel-itsuki graduated when it was published
		// and proven, which is exactly what this rule is for.
		expect(script).not.toContain("chatdev");
	});

	it("the native n8n node names the published package and stays honest about Cloud", () => {
		const snippets = build(["installSnippets"], "installSnippets")("itsuki_live_n8n");
		// The package is published; this is the one place a bare install name is
		// allowed, and it must match the registry exactly.
		expect(snippets.n8nNativeInstall).toBe("n8n-nodes-itsuki");
		expect(snippets.n8nNativeCredential).toContain("itsuki_live_n8n");
		const native = buildMethods().integrations.clients.n8n.variants.native;
		const install = native.steps.find((s) => /community node/i.test(s.title));
		expect(install.body).toMatch(/self-hosted/i);
		// Never claim n8n Cloud support the verification programme has not granted.
		expect(script).not.toMatch(/n8n Cloud (compatible|verified|supported)/i);
		expect(script).not.toContain("officially verified by n8n");
	});

	it("the LlamaIndex route rides the path token, never a header it cannot send", () => {
		const snippets = build(["installSnippets"], "installSnippets")("itsuki_live_llama");
		expect(snippets.llamaindexConnect).toContain("/mcp/itsuki_live_llama");
		expect(snippets.llamaindexConnect).not.toContain("Authorization");
		// The n8n HTTP route is the deterministic-workflow path: REST, not MCP.
		expect(snippets.n8nHttpRequest).toContain("/v1/save");
		expect(snippets.n8nMcpClient).toContain("/mcp");
		// Convex is SDK-only and keyless in its snippets: always copyable.
		expect(snippets.convexHelper).toContain("ITSUKI_API_KEY");
		expect(snippets.convexHelper).not.toContain("YOUR_MCP_KEY");
	});

	it("OpenClaw leads with the published native plugin, MCP routes surviving as fallbacks", () => {
		const doors = buildMethods();
		expect(Object.keys(doors.agents.clients.openclaw.variants)).toEqual(["native", "prompt", "manual"]);
		for (const variant of Object.values(doors.agents.clients.openclaw.variants)) {
			expect(Array.isArray(variant.steps)).toBe(true);
			expect(variant.steps.length).toBeGreaterThan(1);
		}
	});

	it("the native OpenClaw plugin names the published package and its real preconditions", () => {
		const snippets = build(["installSnippets"], "installSnippets")("itsuki_live_oc");
		// The package is published; the verb is allowed and must match the
		// registry name exactly.
		expect(snippets.openclawNativeInstall).toBe("openclaw plugins install openclaw-itsuki");
		// The conversation-access gate is a real host precondition — without it
		// the plugin captures nothing. It must be a step, not a footnote.
		expect(snippets.openclawNativeConfig).toContain('"allowConversationAccess": true');
		expect(snippets.openclawNativeConfig).toContain('"allow": ["itsuki"]');
		expect(snippets.openclawNativeEnv).toContain("ITSUKI_API_KEY=itsuki_live_oc");
		expect(snippets.openclawNativeInspect).toBe("openclaw plugins inspect itsuki --runtime --json");
		const native = buildMethods().agents.clients.openclaw.variants.native;
		expect(native.steps.some((s) => /conversation access/i.test(s.title))).toBe(true);
		// Honesty: coexists with built-in memory; never claims the exclusive
		// slot, dreaming, or a marketplace listing that is not live.
		expect(buildMethods().agents.clients.openclaw.hint).toMatch(/alongside/i);
		expect(script).not.toMatch(/exclusive memory slot (support|replacement|claimed)/i);
		expect(script).not.toContain("clawhub:openclaw-itsuki");
	});

	it("OpenCode leads with the published native plugin, the MCP route surviving as a fallback", () => {
		const doors = buildMethods();
		expect(Object.keys(doors.plugin.clients.opencode.variants)).toEqual(["native", "mcp"]);
		for (const variant of Object.values(doors.plugin.clients.opencode.variants)) {
			expect(Array.isArray(variant.steps)).toBe(true);
			expect(variant.steps.length).toBeGreaterThan(1);
		}
	});

	it("the native OpenCode plugin names the published package, its floor, and the env-only key", () => {
		const snippets = build(["installSnippets"], "installSnippets")("itsuki_live_oc2");
		expect(snippets.opencodeNativeInstall).toBe("npm install opencode-itsuki");
		expect(JSON.parse(snippets.opencodeNativeConfig).plugin).toEqual(["opencode-itsuki"]);
		// The credential is environment-only by design: opencode.json expands
		// {env:VAR} before parsing, so a key placed there is resolved into the
		// options object. The config snippet must never carry one.
		expect(snippets.opencodeNativeConfig).not.toContain("ITSUKI_API_KEY");
		expect(snippets.opencodeNativeConfig).not.toContain("itsuki_live_oc2");
		expect(snippets.opencodeNativeEnv).toContain("ITSUKI_API_KEY");
		expect(snippets.opencodeNativeEnv).not.toContain("itsuki_live_oc2");
		const native = buildMethods().plugin.clients.opencode.variants.native;
		// The executed floor is a precondition, not a footnote.
		expect(native.steps.some((s) => /1\.18\.18/.test(`${s.body ?? ""}`))).toBe(true);
	});

	it("Antigravity offers the native CLI plugin while holding desktop and IDE openly", () => {
		const doors = buildMethods();
		expect(Object.keys(doors.plugin.clients.antigravity.variants)).toEqual(["native", "mcp"]);
		const client = doors.plugin.clients.antigravity;
		// The native route is CLI-only. The unsupported surfaces are named on
		// the door itself, not buried in docs.
		expect(client.hint).toMatch(/CLI/);
		expect(client.hint).toMatch(/desktop app and IDE are not supported/i);
		const native = client.variants.native;
		expect(native.label).toMatch(/CLI/);
		expect(native.steps.some((s) => /not supported/i.test(`${s.body ?? ""}`))).toBe(true);
	});

	it("the native Antigravity plugin names the published package and never prints the key", () => {
		const snippets = build(["installSnippets"], "installSnippets")("itsuki_live_ag2");
		expect(snippets.antigravityNativeInstall).toBe("npx antigravity-itsuki install");
		expect(snippets.antigravityNativeVerify).toContain("antigravity-itsuki doctor");
		expect(snippets.antigravityNativeVerify).toContain("ITSUKI_API_KEY");
		for (const snippet of [snippets.antigravityNativeInstall, snippets.antigravityNativeVerify]) {
			expect(snippet).not.toContain("itsuki_live_ag2");
		}
	});

	it("neither native route claims a capability the packages deliberately omit", () => {
		// update-memory, history and entity operations do not exist on the
		// server; native destructive tools are refused by design (F-9). No
		// Get Started copy may imply otherwise.
		expect(script).not.toMatch(/opencode-itsuki[^"'`]*\b(update|history|entit)/i);
		expect(script).not.toMatch(/antigravity-itsuki[^"'`]*\b(update|history|entit)/i);
		// Antigravity Desktop and the IDE stay HELD. Match positive claims only:
		// an earlier revision of this assertion was tripped by the honest "are
		// not supported" sentence it exists to protect.
		for (const claim of [
			/(desktop|ide)[^.]{0,30}\bis supported\b/i,
			/(desktop|ide)[^.]{0,30}\bare supported\b/i,
			/(desktop|ide)[^.]{0,30}\bfully (supported|compatible)\b/i,
			/works (on|in|with) (the )?antigravity (desktop|ide)/i,
			/antigravity (desktop|ide)[^.]{0,20}\bcompatible\b(?![^.]{0,20}\bnot\b)/i,
		]) {
			expect(script, `positive desktop/IDE claim: ${claim}`).not.toMatch(claim);
		}
		// And the honest exclusion must actually be present on the door.
		expect(buildMethods().plugin.clients.antigravity.hint).toMatch(/not supported/i);
	});

	it("the once-dormant variant renderer path is live and wired", () => {
		const view = fnSource("viewInstall");
		expect(view).toContain("const variants = client.variants ?? null;");
		expect(view).toContain("variant-tabs");
		expect(view).toContain("variants[state.variant]");
		expect(script).toContain("function setInstallVariant(");
	});

	it("every framed-stage client carries a docs link", () => {
		// The stage template interpolates client.docsHref unguarded, so a client
		// without one would render a dead 'View docs' link.
		const doors = buildMethods();
		for (const doorId of ["plugin", "agents", "integrations"]) {
			for (const [id, client] of Object.entries(doors[doorId].clients)) {
				expect(typeof client.docsHref, `${doorId}.${id}`).toBe("string");
			}
		}
		expect(fnSource("viewInstall")).toContain('["plugin", "agents", "integrations"].includes(state.method)');
	});

	it("gives the new doors and clients their inline glyphs", () => {
		for (const icon of ["ICON.bot", "ICON.spark", "ICON.terminal", "ICON.orbit", "ICON.blocks", "ICON.hexN", "ICON.layers", "ICON.database"]) {
			expect(script).toContain(`icon: ${icon}`);
		}
		for (const glyph of ["\tbot: `", "\tpi: `", "\torbit: `", "\tblocks: `", "\tlayers: `", "\tdatabase: `"]) {
			expect(script).toContain(glyph);
		}
	});
});

describe("coding agents via MCP", () => {
	it("emits valid OpenCode and Antigravity config with the key inside", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_k1");
		expect(JSON.parse(withKey.opencode).mcp.itsuki).toMatchObject({
			type: "remote",
			url: `${FIXTURE_ORIGIN}/mcp/itsuki_live_k1`,
			enabled: true,
		});
		expect(JSON.parse(withKey.antigravity).mcpServers.itsuki.serverUrl)
			.toBe(`${FIXTURE_ORIGIN}/mcp/itsuki_live_k1`);
	});
});

describe("no dead commands", () => {
	it("never shows an install verb for a package that does not exist yet", () => {
		// pi-itsuki, openclaw-itsuki, hermes-itsuki and adk-itsuki are all
		// published with provenance, so their verbs are allowed — each pinned
		// to its exact registry name below. chatdev-itsuki is still HELD and
		// must never gain an install verb here.
		expect(script).not.toContain("pip install chatdev-itsuki");
		expect(script).not.toContain("chatdev-itsuki");
	});

	it("offers the native Hermes provider under its exact published name", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const snippets = installSnippets("itsuki_live_k9");
		// PyPI name, verified live before this door shipped.
		expect(snippets.hermesNativeInstall).toContain("pip install hermes-itsuki");
		expect(snippets.hermesNativeInstall).toContain("hermes-itsuki install");
		expect(snippets.hermesNativeSetup).toBe("hermes memory setup");
		expect(snippets.hermesNativeVerify).toBe("hermes-itsuki doctor");
		// The key never appears in a command we tell someone to paste.
		expect(snippets.hermesNativeInstall).not.toContain("itsuki_live_k9");
		expect(snippets.hermesNativeSetup).not.toContain("itsuki_live_k9");
	});

	it("offers the native ADK memory service under its exact published name", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const snippets = installSnippets("itsuki_live_k10");
		expect(snippets.adkNativeInstall).toBe("pip install adk-itsuki");
		// The wiring has to name the three pieces that make it work.
		for (const needed of ["ItsukiMemoryService", "ItsukiMemoryPlugin", "preload_memory"]) {
			expect(snippets.adkNativeWire).toContain(needed);
		}
		// The key belongs in the environment, never in the wiring snippet.
		expect(snippets.adkNativeWire).not.toContain("itsuki_live_k10");
		expect(snippets.adkNativeEnv).toContain("ITSUKI_API_KEY");
	});

	it("builds the OpenClaw routes only from shipped doors", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_k2");
		expect(withKey.openclawMcpAdd)
			.toBe(`openclaw mcp add itsuki --url ${FIXTURE_ORIGIN}/mcp/itsuki_live_k2 --transport streamable-http`);
		for (const needed of ["/v1/ingest", "~/.openclaw/workspace", "SOUL.md", "30 days", "recall_memory", "whoami"]) {
			expect(withKey.openclawPrompt).toContain(needed);
		}
		expect(withKey.openclawPrompt).toContain("Never print the key");
		expect(withKey.openclawImport).toContain("/v1/ingest/limits");
	});

	it("gives Hermes its verified YAML block and interactive verb", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_k3");
		expect(withKey.hermesConfig).toContain("~/.hermes/config.yaml");
		expect(withKey.hermesConfig).toContain("mcp_servers:");
		expect(withKey.hermesConfig).toContain(`${FIXTURE_ORIGIN}/mcp/itsuki_live_k3`);
		expect(withKey.hermesMcpAdd).toBe("hermes mcp add itsuki");
	});

	it("gives Pi the published native extension first, and the honest REST fallback beside it", () => {
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_k4");
		// The package is published; this is the one place the install verb is
		// allowed, and it must match the registry name exactly.
		expect(withKey.piNativeInstall).toBe("pi install npm:pi-itsuki");
		expect(withKey.piNativeEnv).toContain("ITSUKI_API_KEY=itsuki_live_k4");
		expect(withKey.piNativeVerify).toBe("/itsuki status");
		const doors = buildMethods();
		expect(Object.keys(doors.agents.clients.pi.variants)).toEqual(["native", "rest"]);
		// The extension reads the key from the environment only; the step says so.
		const native = doors.agents.clients.pi.variants.native;
		expect(native.steps.some((s) => /environment only/i.test(s.body))).toBe(true);
		// Pi still has no MCP support — the native route must not pretend otherwise.
		expect(withKey.piNativeInstall).not.toContain("mcp");
	});

	it("keeps the Pi REST fallback honest and complete", () => {
		// Pi has no MCP support (verified) — the fallback must never pretend otherwise.
		const installSnippets = build(["installSnippets"], "installSnippets");
		const withKey = installSnippets("itsuki_live_k4");
		for (const needed of ["/v1/status", "/v1/save", "/v1/recall", "receipt"]) {
			expect(withKey.piPrompt).toContain(needed);
		}
		expect(withKey.piPrompt).not.toContain("/mcp/");
		expect(withKey.restInstructions).toContain("/v1/recall");
		expect(withKey.restInstructions).toContain("Never claim something was saved unless the response contained a receipt.");
	});
});
