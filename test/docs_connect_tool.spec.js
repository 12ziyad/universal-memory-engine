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

describe("navigation", () => {
	it("lists the coding-agent pages under Connect a tool", () => {
		for (const entry of [
			'["/install/cursor", "Cursor & other editors"]',
			'["/install/opencode", "OpenCode"]',
			'["/install/antigravity", "Antigravity"]',
		]) {
			expect(script).toContain(entry);
		}
	});

	it("gives agent harnesses their own section", () => {
		expect(script).toContain('{ sec: "Agent harnesses", items: [');
		expect(script).toContain('["/install/openclaw", "OpenClaw"]');
		expect(script).toContain('["/install/hermes", "Hermes Agent"]');
		expect(script).toContain('["/install/pi", "Pi Agent"]');
	});

	it("lists the Frameworks & tools section", () => {
		expect(script).toContain('{ sec: "Frameworks & tools", items: [');
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

	it("the MCP reference documents all eight tools", () => {
		for (const tool of [
			"save_memory", "save_conversation", "recall_memory",
			"list_memories", "get_memory", "delete_memory", "delete_all_memories", "whoami",
		]) {
			expect(script).toContain(`<h3>${tool}</h3>`);
		}
		expect(script).not.toContain("The three tools");
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
		// No Update operation exists; the page must not imply one.
		expect(n8n).toContain("There is no Update operation");
		expect(script).not.toContain("officially verified by n8n");
	});

	it("the n8n page documents both built-in routes, Dify stays review-free, Convex is SDK-only", () => {
		expect(script).toContain("HTTP Request node");
		expect(script).toContain("MCP Client Tool");
		expect(script).toContain('PAGES["/integrations/dify"]');
		const dify = script.split('PAGES["/integrations/dify"]')[1]?.split("PAGES[")[0] ?? "";
		expect(dify).toContain("no plugin, no marketplace, no review");
		const convex = script.split('PAGES["/integrations/convex"]')[1]?.split("PAGES[")[0] ?? "";
		expect(convex).toContain("npm install itsuki convex");
		expect(convex).toContain("ITSUKI_API_KEY");
	});
});

describe("no dead commands in docs", () => {
	it("never shows an install verb for a package that does not exist yet", () => {
		expect(script).not.toContain("openclaw plugins install");
		expect(script).not.toContain("hermes memory setup");
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
