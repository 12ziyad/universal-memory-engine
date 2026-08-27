/**
 * Docs SPA — the Connect-a-tool and Agent-harness pages.
 *
 * The Get started dashboard and these docs describe the same integrations, so
 * they must move together: every dashboard tab's docsHref resolves to a page
 * here, the pages never show an install verb for an unshipped package, and
 * the credential warnings travel with every config block that embeds the key.
 */

import { describe, it, expect } from "vitest";
import docs from "../public/docs/index.html?raw";
import app from "../public/index.html?raw";

const script = docs.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

/**
 * Source of one PAGES[...] entry, so a page-scoped assertion cannot be
 * satisfied by matching text that happens to live on a different page.
 */
function docPage(route) {
	const start = script.indexOf(`PAGES["${route}"]`);
	if (start === -1) throw new Error(`no docs page ${route}`);
	const next = script.indexOf('PAGES["', start + 8);
	return script.slice(start, next === -1 ? script.length : next);
}

describe("navigation", () => {
	it("lists the coding-agent pages under Connect your tools", () => {
		for (const entry of [
			'["/install/cursor", "Cursor & other editors"]',
			'["/install/opencode", "OpenCode"]',
			'["/install/antigravity", "Antigravity"]',
		]) {
			expect(script).toContain(entry);
		}
	});

	// Agent harnesses used to be a section of their own, which split five
	// agentic CLIs across two headings on a line no reader could predict:
	// OpenCode and Antigravity sat under "Connect a tool" while OpenClaw,
	// Hermes and Pi sat under "Agent harnesses". They are one section now.
	it("keeps every client in one Connect your tools section", () => {
		expect(script).toContain('{ sec: "Connect your tools", items: [');
		expect(script).not.toContain('sec: "Agent harnesses"');
		expect(script).not.toContain('sec: "Connect a tool"');
		for (const entry of [
			'["/install/openclaw", "OpenClaw"]',
			'["/install/hermes", "Hermes Agent"]',
			'["/install/pi", "Pi Agent"]',
		]) {
			expect(script).toContain(entry);
		}
	});

	// The rail used to render only the sections belonging to a hidden "area",
	// so from Get started the API reference and Concepts were not merely
	// collapsed - they were absent. The whole tree is one rail now.
	it("renders the whole nav tree rather than one area of it", () => {
		expect(script).not.toContain("const AREAS = [");
		expect(script).not.toContain('id="areaBar"');
		expect(script).toContain("function renderNav(");
		// Every section must be reachable from every page.
		const secs = [...script.matchAll(/\{ sec: "([^"]+)", items: \[/g)].map((m) => m[1]);
		expect(secs.length).toBeGreaterThanOrEqual(7);
	});

	it("documents the native packages, and only the ones that shipped", () => {
		expect(script).toContain('["/integrations/native", "Native packages"]');
		expect(script).toContain('PAGES["/integrations/native"]');
		// Each install command names a package that is published and was proven
		// against production from its registry bytes.
		for (const command of [
			"pip install agno-itsuki",
			"pip install llama-index-memory-itsuki",
			"pip install camel-itsuki",
			"npm install ai-sdk-itsuki",
			"npm install mastra-itsuki",
		]) {
			expect(script, command).toContain(command);
		}
		// chatdev-itsuki is HELD and unpublished: documenting it would ship a
		// command that cannot work.
		expect(script).not.toContain("chatdev");
	});

	it("lists the Frameworks & integrations section", () => {
		expect(script).toContain('{ sec: "Frameworks & integrations", items: [');
		expect(script).toContain('["/integrations/python", "Python frameworks"]');
		expect(script).toContain('["/integrations/typescript", "TypeScript frameworks"]');
		expect(script).toContain('["/integrations/n8n", "n8n"]');
		expect(script).toContain('["/integrations/dify", "Dify"]');
		expect(script).toContain('["/integrations/convex", "Convex"]');
	});

	it("every dashboard docsHref under /docs resolves to a defined page", () => {
		const appScript = app.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		// Digits belong in the class: /integrations/n8n would otherwise truncate
		// at the 8 and assert PAGES["/integrations/n"], failing forever.
		const hrefs = [...appScript.matchAll(/docsHref: "\/docs\/#(\/[a-z0-9/-]+)"/g)].map((m) => m[1]);
		expect(hrefs.length).toBeGreaterThan(0);
		for (const href of hrefs) {
			expect(script, href).toContain(`PAGES["${href}"]`);
		}
	});
});

describe("page contracts", () => {
	it("OpenCode documents the remote MCP block and the whoami verify", () => {
		expect(script).toContain('PAGES["/install/opencode"]');
		expect(script).toContain('"type": "remote"');
		expect(script).toContain("/mcp/YOUR_MCP_KEY");
		expect(script).toMatch(/opencode\.json/);
	});

	it("Antigravity documents the serverUrl block and the plaintext-credential caveat", () => {
		expect(script).toContain('PAGES["/install/antigravity"]');
		expect(script).toContain('"serverUrl"');
		expect(script).toContain("does not interpolate environment variables");
	});

	it("the OpenCode page leads with the native plugin and states what it omits", () => {
		const page = docPage("/install/opencode");
		expect(page).toContain("npm install opencode-itsuki");
		// The executed floor, not a guess: nothing below it was ever run.
		expect(page).toContain("1.18.18");
		// Environment-only credential, and the reason it is not negotiable.
		expect(page).toContain("ITSUKI_API_KEY");
		expect(page).toMatch(/\{env:VAR\}|\{env:/);
		expect(page).toMatch(/Deliberately absent/i);
		// The MCP route survives as the documented fallback for deletion.
		expect(page).toMatch(/mcp/i);
	});

	it("the Antigravity page ships the CLI plugin and holds desktop and IDE openly", () => {
		const page = docPage("/install/antigravity");
		expect(page).toContain("npx antigravity-itsuki install");
		expect(page).toContain("antigravity-itsuki doctor");
		// The two verified floors.
		expect(page).toContain("1.1.13");
		expect(page).toMatch(/Node 22/);
		// Desktop and IDE are HELD; the page must say so, not stay silent.
		expect(page).toMatch(/desktop app and the Antigravity IDE are not supported/i);
		expect(page).toMatch(/Automatic capture is currently held/i);
		expect(page).toMatch(/Save explicitly through the MCP tools/i);
		expect(page).not.toMatch(/Capture runs at <code>Stop<\/code>/i);
		expect(page).toMatch(/Deliberately absent/i);
		// And it must not claim the held surfaces work.
		expect(page).not.toMatch(/(desktop|ide)[^.]{0,30}\b(is|are) supported\b/i);
	});

	it("OpenClaw documents both routes from shipped doors only", () => {
		expect(script).toContain('PAGES["/install/openclaw"]');
		expect(script).toContain("openclaw mcp add");
		expect(script).toContain("/v1/ingest/limits");
		for (const file of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]) {
			expect(script).toContain(file);
		}
	});

	it("Hermes documents the YAML config route; Pi documents the REST-only truth", () => {
		expect(script).toContain('PAGES["/install/hermes"]');
		expect(script).toContain("mcp_servers:");
		expect(script).toContain("hermes mcp add");
		expect(script).toContain('PAGES["/install/pi"]');
		expect(script).toContain("Pi has no MCP support");
	});

	it("the MCP reference documents all eleven tools", () => {
		for (const tool of [
			"save_memory", "save_conversation", "recall_memory",
			"list_memories", "get_memory", "delete_memory", "delete_all_memories", "whoami",
			"update_memory", "memory_history", "rollback_memory",
		]) {
			expect(script).toContain(`<h3>${tool}</h3>`);
		}
		expect(script).not.toContain("The three tools");
		// The update tools document the precondition contract, not blind writes.
		expect(script).toContain("expectedRevision");
		expect(script).toContain("new forward revision");
	});

	it("the REST reference lists the read-only inventory routes", () => {
		expect(script).toContain("GET /v1/memories</code>");
		expect(script).toContain("GET /v1/memories/&lt;id&gt;");
	});

	it("the Python page carries every verified framework and the path-token line", () => {
		for (const anchor of ["langchain", "crewai", "autogen", "agno", "openai-agents", "google-adk", "llamaindex"]) {
			expect(script).toContain(`<h2 id="${anchor}">`);
		}
		expect(script).toContain("MultiServerMCPClient");
		// The competitive line: LlamaIndex cannot send custom headers, the
		// path-token door works anyway — and BasicMCPClient carries no header.
		expect(script).toContain("no custom headers");
		expect(script).toContain('BasicMCPClient("${ORIGIN}/mcp/YOUR_MCP_KEY")');
	});

	it("the n8n page documents the native node without overclaiming Cloud support", () => {
		const n8n = script.split('PAGES["/integrations/n8n"]')[1]?.split("PAGES[")[0] ?? "";
		expect(n8n).toContain("n8n-nodes-itsuki");
		expect(n8n).toMatch(/self-hosted/i);
		expect(n8n).toContain("N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE");
		// Delete All must be described as preview-first wherever it appears.
		expect(n8n).toMatch(/previews by default/i);
		// The node ships twelve operations, including the three safe-update ones
		// (Itsuki.node.ts:43,45,48). The page used to deny Update existed and told
		// readers to delete-and-re-save instead, which destroys revision history.
		expect(n8n).toContain("twelve operations");
		for (const op of ["Update Memory", "Memory History", "Rollback Memory"]) {
			expect(n8n, op).toContain(op);
		}
		expect(n8n).not.toContain("There is no Update operation");
		expect(n8n).not.toMatch(/no safe versioned-correction contract/i);
		expect(script).not.toContain("officially verified by n8n");
	});

	it("the n8n page documents both built-in routes, Dify stays review-free, Convex is SDK-only", () => {
		expect(script).toContain("HTTP Request node");
		expect(script).toContain("MCP Client Tool");
		expect(script).toContain('PAGES["/integrations/dify"]');
		const dify = script.split('PAGES["/integrations/dify"]')[1]?.split("PAGES[")[0] ?? "";
		// The Dify route needs no plugin, no marketplace listing and no review.
		// Matched on intent so the page can phrase it naturally.
		expect(dify).toMatch(/no marketplace/i);
		expect(dify).toMatch(/no review/i);
		const convex = script.split('PAGES["/integrations/convex"]')[1]?.split("PAGES[")[0] ?? "";
		expect(convex).toContain("npm install itsuki convex");
		expect(convex).toContain("ITSUKI_API_KEY");
	});
});

describe("no dead commands in docs", () => {
	it("never shows an install verb for a package that does not exist yet", () => {
		// hermes-itsuki and adk-itsuki are published with provenance and are
		// pinned by name below. chatdev-itsuki is still HELD.
		expect(script).not.toContain("chatdev-itsuki");
	});

	it("documents the native Hermes provider under its exact published name", () => {
		const page = script.split('PAGES["/install/hermes"]')[1]?.split("PAGES[")[0] ?? "";
		expect(page).toContain("pip install hermes-itsuki");
		expect(page).toContain("hermes-itsuki install");
		expect(page).toContain("hermes memory setup");
		expect(page).toContain("hermes-itsuki doctor");
		// The floor is a real constraint, not decoration.
		expect(page).toContain("0.19.0");
		// The bounds we promise must be stated where a person will read them.
		expect(page).toMatch(/512 entries|30 minutes/);
	});

	it("documents the native ADK memory service under its exact published name", () => {
		expect(script).toContain("pip install adk-itsuki");
		for (const needed of ["ItsukiMemoryService", "ItsukiMemoryPlugin", "preload_memory"]) {
			expect(script).toContain(needed);
		}
		// The supported host range, stated.
		expect(script).toMatch(/2\.5/);
	});

	it("shows the published OpenClaw plugin under its exact registry name", () => {
		const ocPage = script.split('PAGES["/install/openclaw"]')[1]?.split("PAGES[")[0] ?? "";
		expect(ocPage).toContain("openclaw plugins install openclaw-itsuki");
		// The host's conversation-access gate is a required install step.
		expect(ocPage).toContain("allowConversationAccess");
		expect(ocPage).toContain("plugins inspect itsuki --runtime --json");
		// Coexistence honesty: alongside built-in memory, and the MCP routes
		// survive as fallbacks.
		expect(ocPage).toMatch(/alongside/i);
		expect(ocPage).toContain("openclaw mcp add");
		expect(ocPage).toMatch(/Deliberately absent/i);
		// Never claim the exclusive slot or a marketplace listing that is not live.
		expect(ocPage).toContain("never claims OpenClaw's exclusive memory slot");
		expect(ocPage).not.toContain("clawhub:");
	});

	it("shows the published Pi extension under its exact registry name", () => {
		// pi-itsuki shipped (npm, provenance), so the verb is allowed — but only
		// the real one, on the Pi page, alongside the surviving REST fallback.
		const piPage = script.split('PAGES["/install/pi"]')[1]?.split("PAGES[")[0] ?? "";
		expect(piPage).toContain("pi install npm:pi-itsuki");
		expect(piPage).toContain("ITSUKI_API_KEY");
		expect(piPage).toContain("/itsuki status");
		expect(piPage).toMatch(/REST fallback/);
		// Honesty survives the upgrade: no update/multimodal/consolidation claims.
		expect(piPage).toMatch(/Deliberately absent/i);
	});
});
