import {
	isValidEmail,
	issueAuthenticatedSession,
	normalizeEmail,
	parseCookies,
	randomSecret,
	timingSafeEqualString,
} from "../auth.js";
import { resolveVerifiedIdentity } from "./auth_identity.js";

export const GITHUB_OAUTH_COOKIE = "itsuki_github_oauth";
const GITHUB_API_VERSION = "2022-11-28";

function cookieBase(request) {
	const secure = new URL(request.url).protocol === "https:";
	return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function oauthCookie(request, value, maxAgeSeconds) {
	return `${GITHUB_OAUTH_COOKIE}=${encodeURIComponent(value)}; ${cookieBase(request)}; Max-Age=${maxAgeSeconds}`;
}

function toBase64Url(bytes) {
	let raw = "";
	for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier) {
	return toBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export async function githubAuthStart(env, request) {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
		return { redirect: "/login?error=github_not_configured", cookie: null };
	}
	const state = randomSecret(24);
	const verifier = randomSecret(32);
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/auth/github/callback", request.url).toString());
	url.searchParams.set("scope", "read:user user:email");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", await pkceChallenge(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("prompt", "select_account");
	return { redirect: url.toString(), cookie: oauthCookie(request, `${state}.${verifier}`, 600) };
}

export async function resolveGithubUser(env, profile, emails) {
	const subject = String(profile?.id ?? "").trim();
	const primary = Array.isArray(emails)
		? emails.find((candidate) => candidate?.primary === true && candidate?.verified === true)
		: null;
	const email = normalizeEmail(primary?.email);
	if (!subject || !isValidEmail(email)) return { error: "github_verified_primary_email_required" };
	return resolveVerifiedIdentity(env, {
		provider: "github",
		subject,
		email,
		name: profile?.name || profile?.login,
		verifiedAt: Date.now(),
	});
}

export async function githubAuthCallback(env, request, { fetchImpl = fetch } = {}) {
	const url = new URL(request.url);
	const clearState = oauthCookie(request, "", 0);
	if (url.searchParams.get("error")) {
		return { redirect: "/login?error=github_denied", cookies: [clearState] };
	}
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const envelope = parseCookies(request).get(GITHUB_OAUTH_COOKIE) || "";
	const separator = envelope.indexOf(".");
	const expectedState = separator > 0 ? envelope.slice(0, separator) : "";
	const verifier = separator > 0 ? envelope.slice(separator + 1) : "";
	if (!code || !state || !expectedState || !verifier || !(await timingSafeEqualString(state, expectedState))) {
		return { redirect: "/login?error=github_state", cookies: [clearState] };
	}

	try {
		const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				code_verifier: verifier,
				redirect_uri: new URL("/auth/github/callback", request.url).toString(),
			}),
		});
		const token = await tokenResponse.json().catch(() => ({}));
		if (!tokenResponse.ok || !token.access_token) throw new Error("github_token_exchange_failed");

		const githubHeaders = {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token.access_token}`,
			"x-github-api-version": GITHUB_API_VERSION,
			"user-agent": "Itsuki",
		};
		const [profileResponse, emailsResponse] = await Promise.all([
			fetchImpl("https://api.github.com/user", { headers: githubHeaders }),
			fetchImpl("https://api.github.com/user/emails", { headers: githubHeaders }),
		]);
		if (!profileResponse.ok || !emailsResponse.ok) throw new Error("github_profile_failed");
		const profile = await profileResponse.json();
		const emails = await emailsResponse.json();
		const resolved = await resolveGithubUser(env, profile, emails);
		if (resolved.error) {
			const reason = resolved.error === "account_disabled"
				? "account_disabled"
				: "github_verified_email_required";
			return { redirect: `/login?error=${reason}`, cookies: [clearState] };
		}
		const authenticated = await issueAuthenticatedSession(
			env,
			request,
			resolved.user.id,
			resolved.created ? "github_signup" : "github_login",
		);
		if (authenticated.error) {
			return { redirect: `/login?error=${authenticated.error}`, cookies: [clearState] };
		}
		return { redirect: "/?app=1", cookies: [clearState, authenticated.session.cookie] };
	} catch (error) {
		console.warn("github oauth failed:", error?.message ?? error);
		return { redirect: "/login?error=github_failed", cookies: [clearState] };
	}
}
