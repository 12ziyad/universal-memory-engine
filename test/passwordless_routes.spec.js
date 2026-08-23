import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const AUTH_EMAIL_SECRET = "test-only-route-secret-with-more-than-thirty-two-bytes";

async function call(path, init = {}, runtimeEnv = env) {
	const request = new Request(`https://itsuki.app${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function jsonPost(path, body, runtimeEnv, cookie = "") {
	return call(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	}, runtimeEnv);
}

function cookieNamed(response, name) {
	return response.headers.get("set-cookie")
		?.split(/,(?=\s*[^;,]+=)/)
		.map((value) => value.trim().split(";")[0])
		.find((value) => value.startsWith(`${name}=`)) ?? "";
}

describe("production passwordless auth routes", () => {
	it("delivers a browser-bound code, signs in once, and refuses replay", async () => {
		let delivered;
		const runtimeEnv = {
			...env,
			AUTH_EMAIL_SECRET,
			EMAIL: { send: async (message) => { delivered = message; } },
		};
		const email = `route-${crypto.randomUUID()}@example.com`;
		const started = await jsonPost("/auth/email/start", { email }, runtimeEnv);
		expect(started.status).toBe(202);
		expect(await started.clone().json()).toMatchObject({ ok: true });
		const challengeCookie = cookieNamed(started, "itsuki_email_challenge");
		expect(challengeCookie).toMatch(/^itsuki_email_challenge=/);
		expect(delivered.to).toBe(email);
		const code = delivered.text.match(/\b\d{6}\b/)?.[0];
		expect(code).toMatch(/^\d{6}$/);

		const verified = await jsonPost("/auth/email/verify", { code }, runtimeEnv, challengeCookie);
		expect(verified.status).toBe(201);
		const verifiedBody = await verified.clone().json();
		expect(verifiedBody).toMatchObject({ authenticated: true, created: true, user: { email } });
		const sessionCookie = cookieNamed(verified, "uml_session");
		expect(sessionCookie).toMatch(/^uml_session=/);

		const me = await call("/auth/me", { headers: { cookie: sessionCookie } }, runtimeEnv);
		expect(await me.json()).toMatchObject({ authenticated: true, user: { email } });
		const replayed = await jsonPost("/auth/email/verify", { code }, runtimeEnv, challengeCookie);
		expect(replayed.status).toBe(401);
		expect(await replayed.json()).toMatchObject({ error: "invalid_email_code" });
	});

	it("bounds and validates the public email request", async () => {
		const runtimeEnv = {
			...env,
			AUTH_EMAIL_SECRET,
			EMAIL: { send: async () => {} },
		};
		const unknown = await jsonPost("/auth/email/start", { email: "a@example.com", password: "never" }, runtimeEnv);
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({ error: "unknown_email_field" });
	});

	it("starts GitHub OAuth with PKCE and a browser-bound state cookie", async () => {
		const response = await call("/auth/github", {}, {
			...env,
			GITHUB_CLIENT_ID: "github-client-id",
			GITHUB_CLIENT_SECRET: "github-client-secret",
		});
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location"));
		expect(location.origin).toBe("https://github.com");
		expect(location.searchParams.get("client_id")).toBe("github-client-id");
		expect(location.searchParams.get("code_challenge_method")).toBe("S256");
		expect(location.searchParams.get("state")).toBeTruthy();
		expect(cookieNamed(response, "itsuki_github_oauth")).toMatch(/^itsuki_github_oauth=/);
	});
});
