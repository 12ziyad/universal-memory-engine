import { describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { verifyGoogleIdToken } from "../src/auth.js";

async function token(overrides = {}, protectedOverrides = {}) {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: "https://accounts.google.com",
		aud: "google-client",
		sub: "google-subject",
		email: "verified@example.com",
		email_verified: true,
		nonce: "browser-nonce",
		iat: now,
		exp: now + 300,
		...overrides,
	};
	const jwt = await new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "test", ...protectedOverrides })
		.sign(privateKey);
	return { jwt, publicKey };
}

describe("Google ID-token verification", () => {
	it("verifies signature, issuer, audience, expiry, nonce, and verified email", async () => {
		const { jwt, publicKey } = await token();
		const payload = await verifyGoogleIdToken(
			{ GOOGLE_CLIENT_ID: "google-client" }, jwt, { nonce: "browser-nonce", keyResolver: publicKey },
		);
		expect(payload.sub).toBe("google-subject");
	});

	it.each([
		["wrong audience", { aud: "other-client" }, "browser-nonce"],
		["wrong nonce", {}, "different-nonce"],
		["expired", { exp: Math.floor(Date.now() / 1000) - 60 }, "browser-nonce"],
		["unverified email", { email_verified: false }, "browser-nonce"],
	])("rejects %s", async (_label, overrides, nonce) => {
		const { jwt, publicKey } = await token(overrides);
		await expect(verifyGoogleIdToken(
			{ GOOGLE_CLIENT_ID: "google-client" }, jwt, { nonce, keyResolver: publicKey },
		)).rejects.toThrow();
	});

	it("rejects a token whose signature was made by another key", async () => {
		const signed = await token();
		const other = await generateKeyPair("RS256");
		await expect(verifyGoogleIdToken(
			{ GOOGLE_CLIENT_ID: "google-client" }, signed.jwt,
			{ nonce: "browser-nonce", keyResolver: other.publicKey },
		)).rejects.toThrow();
	});
});
