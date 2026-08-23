import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { githubAuthCallback, githubAuthStart, resolveGithubUser } from "../src/lib/github_auth.js";

function githubEnv() {
	return { DB: env.DB, GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret" };
}

function cookieHeader(cookie) {
	return cookie.split(";", 1)[0];
}

describe("GitHub OAuth", () => {
	it("starts a state-bound PKCE authorization request", async () => {
		const result = await githubAuthStart(githubEnv(), new Request("https://itsuki.app/auth/github"));
		const url = new URL(result.redirect);
		expect(url.origin).toBe("https://github.com");
		expect(url.searchParams.get("scope")).toContain("user:email");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(30);
		expect(result.cookie).toContain("HttpOnly");
		expect(result.cookie).toContain("Secure");
	});

	it("requires a verified primary email", async () => {
		const result = await resolveGithubUser(githubEnv(), { id: 123, login: "octo" }, [
			{ email: "octo@example.com", primary: true, verified: false },
		]);
		expect(result.error).toBe("github_verified_primary_email_required");
	});

	it("exchanges the code with PKCE, resolves identity, and issues a session", async () => {
		const testEnv = githubEnv();
		const started = await githubAuthStart(testEnv, new Request("https://itsuki.app/auth/github"));
		const state = new URL(started.redirect).searchParams.get("state");
		const fetchImpl = vi.fn(async (url, init = {}) => {
			if (String(url).includes("access_token")) return Response.json({ access_token: "token" });
			if (String(url).endsWith("/user")) return Response.json({ id: 987654, login: "verified-octo", name: "Octo Cat" });
			if (String(url).endsWith("/user/emails")) {
				return Response.json([{ email: `github-${crypto.randomUUID()}@example.com`, primary: true, verified: true }]);
			}
			return new Response(null, { status: 404 });
		});
		const request = new Request(`https://itsuki.app/auth/github/callback?code=one-time&state=${encodeURIComponent(state)}`, {
			headers: { cookie: cookieHeader(started.cookie) },
		});
		const result = await githubAuthCallback(testEnv, request, { fetchImpl });

		expect(result.redirect).toBe("/?app=1");
		expect(result.cookies.some((cookie) => cookie.startsWith("uml_session="))).toBe(true);
		const tokenCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("access_token"));
		const tokenBody = JSON.parse(tokenCall[1].body);
		expect(tokenBody.code_verifier.length).toBeGreaterThan(30);
		const identity = await env.DB.prepare(
			"SELECT provider, provider_subject FROM auth_identities WHERE provider = 'github' AND provider_subject = '987654'",
		).first();
		expect(identity).toEqual(expect.objectContaining({ provider: "github", provider_subject: "987654" }));
	});

	it("links an existing verified email and keeps the stable GitHub subject", async () => {
		const stamp = crypto.randomUUID();
		const email = `gh-link-${stamp}@example.com`;
		const userId = `user_${stamp}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
			 VALUES (?, ?, ?, 'Existing', ?, ?, 'active', 'user')`,
		).bind(userId, email, email, now, now).run();
		const first = await resolveGithubUser(githubEnv(), { id: 456, login: "octo" }, [
			{ email, primary: true, verified: true },
		]);
		const changed = await resolveGithubUser(githubEnv(), { id: 456, login: "octo" }, [
			{ email: `changed-${email}`, primary: true, verified: true },
		]);
		expect(first.user.id).toBe(userId);
		expect(changed.user.id).toBe(userId);
	});
});
