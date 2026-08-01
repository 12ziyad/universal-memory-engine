/**
 * The domain move: uml.gpmai.workers.dev → itsuki.app.
 *
 * The rule under test is asymmetric on purpose: HTML paths 301 from the legacy
 * host to the canonical origin, while /v1/* and /mcp/* are NEVER redirected —
 * not every MCP client or HTTP library follows redirects, and a silent failure
 * there is worse than an old URL that keeps working.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { LEGACY_HOSTS, PUBLIC_ORIGIN } from "../src/config.js";

const LEGACY = `https://${LEGACY_HOSTS[0]}`;

async function fetchPath(base, path, init = {}) {
	const req = new Request(`${base}${path}`, { redirect: "manual", ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe("legacy host → itsuki.app", () => {
	it("names the canonical origin and at least one legacy host", () => {
		expect(PUBLIC_ORIGIN).toBe("https://itsuki.app");
		expect(LEGACY_HOSTS).toContain("uml.gpmai.workers.dev");
	});

	it("301s the HTML paths, preserving path and query", async () => {
		for (const path of ["/", "/docs/", "/docs", "/terms", "/privacy", "/app", "/login", "/signup"]) {
			const res = await fetchPath(LEGACY, path);
			expect(res.status, path).toBe(301);
			expect(res.headers.get("location"), path).toBe(`${PUBLIC_ORIGIN}${path}`);
		}
		const withQuery = await fetchPath(LEGACY, "/?view=login");
		expect(withQuery.status).toBe(301);
		expect(withQuery.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?view=login`);
	});

	it("301s HEAD requests too — link checkers see the move", async () => {
		const res = await fetchPath(LEGACY, "/", { method: "HEAD" });
		expect(res.status).toBe(301);
	});

	it("never redirects /mcp/* — pasted MCP links must keep working", async () => {
		const res = await fetchPath(LEGACY, "/mcp/itsuki_live_notreal");
		expect(res.status).not.toBe(301);
		expect(res.status).not.toBe(302);
		// The token is fake, so the door itself answers — proof the request was
		// served natively on the legacy host, not bounced.
		expect(res.status).toBe(401);
	});

	it("never redirects /v1/* — SDKs and scripts must keep working", async () => {
		for (const [method, path] of [["POST", "/v1/save"], ["POST", "/v1/recall"], ["GET", "/v1/usage"]]) {
			const res = await fetchPath(LEGACY, path, { method });
			expect(res.status, path).not.toBe(301);
			expect(res.status, path).not.toBe(302);
		}
	});

	it("does not redirect the canonical host to itself", async () => {
		const res = await fetchPath(PUBLIC_ORIGIN, "/");
		expect(res.status).not.toBe(301);
	});

	it("does not redirect the OAuth callback — the code exchange must land where it started", async () => {
		const res = await fetchPath(LEGACY, "/auth/google/callback?code=x&state=y");
		expect(res.status).not.toBe(301);
	});
});
