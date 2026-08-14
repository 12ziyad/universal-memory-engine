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

	it("every dashboard docsHref under /docs resolves to a defined page", () => {
		const appScript = app.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		const hrefs = [...appScript.matchAll(/docsHref: "\/docs\/#(\/[a-z/-]+)"/g)].map((m) => m[1]);
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
});

describe("no dead commands in docs", () => {
	it("never shows an install verb for a package that does not exist yet", () => {
		expect(script).not.toContain("openclaw plugins install");
		expect(script).not.toContain("hermes memory setup");
		expect(script).not.toContain("pi install npm:");
	});
});
