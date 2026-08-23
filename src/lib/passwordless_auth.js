import { newId } from "./ids.js";
import { resolveVerifiedIdentity } from "./auth_identity.js";
import {
	isValidEmail,
	issueAuthenticatedSession,
	normalizeEmail,
	parseCookies,
	randomSecret,
	sha256Hex,
	timingSafeEqualString,
} from "../auth.js";

export const EMAIL_CHALLENGE_COOKIE = "itsuki_email_challenge";
export const EMAIL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;
export const EMAIL_CHALLENGE_MAX_ATTEMPTS = 5;
export const EMAIL_CHALLENGE_CLEANUP_LIMIT = 250;
const DEFAULT_SENDER = "invites@notify.itsuki.app";
const ENCODER = new TextEncoder();

function secureCookie(request) {
	return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

function challengeCookie(request, value, maxAgeSeconds) {
	return `${EMAIL_CHALLENGE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${secureCookie(request)}; Max-Age=${maxAgeSeconds}`;
}

export function clearEmailChallengeCookie(request) {
	return challengeCookie(request, "", 0);
}

function secret(env) {
	const value = String(env.AUTH_EMAIL_SECRET || "");
	return value.length >= 32 ? value : null;
}

function toBase64Url(bytes) {
	let raw = "";
	for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secretValue, value) {
	const key = await crypto.subtle.importKey(
		"raw",
		ENCODER.encode(secretValue),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toBase64Url(await crypto.subtle.sign("HMAC", key, ENCODER.encode(String(value))));
}

async function emailHmac(env, email) {
	const secretValue = secret(env);
	const normalized = normalizeEmail(email);
	if (!secretValue || !normalized) return null;
	return hmac(secretValue, `email:v1:${normalized}`);
}

/**
 * Prepared erasure statement for the account-deletion transaction. Terminal
 * challenges have their plaintext address scrubbed immediately, so the stable
 * keyed digest is the authoritative lookup once a code has been consumed.
 */
export async function emailChallengeErasureStatement(env, email) {
	const normalized = normalizeEmail(email);
	const digest = await emailHmac(env, normalized);
	// A terminal challenge no longer retains plaintext email. Without the same
	// keyed digest used at creation time, account erasure cannot prove that those
	// rows are gone. Fail closed and leave the disabled account retryable instead
	// of claiming erasure while stable mailbox metadata survives.
	if (normalized && !digest) {
		throw new Error("account erasure requires AUTH_EMAIL_SECRET to remove email challenge residue");
	}
	return env.DB.prepare(
		`DELETE FROM auth_email_challenges
		  WHERE email_normalized = ?
		     OR (? IS NOT NULL AND email_hmac = ?)`,
	).bind(normalized, digest, digest);
}

/** Delete a bounded slice once each challenge reaches its original TTL. */
export async function purgeExpiredEmailChallenges(env, {
	now = Date.now(),
	limit = EMAIL_CHALLENGE_CLEANUP_LIMIT,
} = {}) {
	const stamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
	const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || EMAIL_CHALLENGE_CLEANUP_LIMIT)));
	const deleted = await env.DB.prepare(
		`DELETE FROM auth_email_challenges
		  WHERE id IN (
		    SELECT id FROM auth_email_challenges
		     WHERE expires_at <= ?
		     ORDER BY expires_at ASC, id ASC
		     LIMIT ?
		  )`,
	).bind(stamp, boundedLimit).run();
	return { deleted: Number(deleted?.meta?.changes ?? 0), limit: boundedLimit };
}

function randomSixDigitCode() {
	// Rejection sampling avoids modulo bias across the full uint32 range.
	const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
	const bytes = new Uint8Array(4);
	let value;
	do {
		crypto.getRandomValues(bytes);
		value = new DataView(bytes.buffer).getUint32(0, false);
	} while (value >= ceiling);
	return String(value % 1_000_000).padStart(6, "0");
}

function senderAddress(env) {
	return String(env.INVITE_EMAIL_FROM || DEFAULT_SENDER).trim().toLowerCase();
}

function maskedEmail(email) {
	const [local, domain] = String(email).split("@");
	const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
	return `${visible}${"*".repeat(Math.max(2, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function mailContent(code) {
	const subject = "Your Itsuki sign-in code";
	const text = [
		"Sign in to Itsuki",
		"",
		`Your verification code is: ${code}`,
		"",
		"It expires in 10 minutes and can be used once. If you did not request it, you can ignore this email.",
	].join("\n");
	const html = `<!doctype html><html><body style="margin:0;background:#f5efe3;color:#17130f;font-family:Arial,sans-serif">
		<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px">
		<table role="presentation" width="100%" style="max-width:520px;background:#fffaf1;border:1px solid #d6c8b6"><tr><td style="padding:36px">
		<div style="font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#c94f2c">Itsuki · secure access</div>
		<h1 style="margin:20px 0 8px;font:normal 32px Georgia,serif">Your sign-in code</h1>
		<p style="margin:0 0 24px;color:#62584d">Enter this code in the browser where you started signing in.</p>
		<div style="padding:18px;border:1px solid #c94f2c;background:#fff;font:700 34px ui-monospace,monospace;letter-spacing:.22em;text-align:center">${code}</div>
		<p style="margin:24px 0 0;color:#756a5e;font-size:13px;line-height:1.5">Expires in 10 minutes and works once. If you did not request this, no action is needed.</p>
		</td></tr></table></td></tr></table></body></html>`;
	return { subject, text, html };
}

async function requestFingerprint(env, request) {
	const secretValue = secret(env);
	const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
	const userAgent = request.headers.get("user-agent")?.slice(0, 500) || "";
	return {
		ipHash: ip ? await hmac(secretValue, `ip:v1:${ip}`) : null,
		userAgentHash: userAgent ? await hmac(secretValue, `ua:v1:${userAgent}`) : null,
	};
}

/** Create and synchronously deliver one browser-bound email challenge. */
export async function startEmailChallenge(env, request, body = {}) {
	const email = normalizeEmail(body.email);
	if (!isValidEmail(email)) return { error: "A valid email is required", status: 400 };
	const secretValue = secret(env);
	if (!secretValue || !env.EMAIL?.send) return { error: "email_signin_unavailable", status: 503 };

	const stamp = Date.now();
	const id = newId("emc");
	const code = randomSixDigitCode();
	const browserToken = randomSecret(32);
	const emailHmac = await hmac(secretValue, `email:v1:${email}`);
	const browserTokenHash = await sha256Hex(browserToken);
	const codeMac = await hmac(secretValue, `code:v1:${id}:${browserToken}:${code}`);
	const expiresAt = stamp + EMAIL_CHALLENGE_TTL_MS;
	const cooldownBefore = stamp - EMAIL_RESEND_COOLDOWN_MS;
	const fingerprint = await requestFingerprint(env, request);

	const [, inserted] = await env.DB.batch([
		env.DB.prepare(
			`UPDATE auth_email_challenges
			    SET invalidated_at = ?, email_normalized = ''
			  WHERE email_hmac = ? AND purpose = 'signin'
			    AND consumed_at IS NULL AND invalidated_at IS NULL
			    AND (expires_at <= ? OR last_sent_at <= ?)`,
		).bind(stamp, emailHmac, stamp, cooldownBefore),
		env.DB.prepare(
			`INSERT INTO auth_email_challenges
			 (id, email_normalized, email_hmac, code_mac, browser_token_hash, purpose,
			  attempts, max_attempts, expires_at, consumed_at, invalidated_at,
			  created_at, last_sent_at, ip_hash, user_agent_hash)
			 SELECT ?, ?, ?, ?, ?, 'signin', 0, ?, ?, NULL, NULL, ?, ?, ?, ?
			  WHERE NOT EXISTS (
			    SELECT 1 FROM auth_email_challenges
			     WHERE email_hmac = ? AND purpose = 'signin'
			       AND consumed_at IS NULL AND invalidated_at IS NULL
			       AND expires_at > ? AND last_sent_at > ?
			  )`,
		).bind(
			id, email, emailHmac, codeMac, browserTokenHash,
			EMAIL_CHALLENGE_MAX_ATTEMPTS, expiresAt, stamp, stamp,
			fingerprint.ipHash, fingerprint.userAgentHash,
			emailHmac, stamp, cooldownBefore,
		),
	]);
	if (Number(inserted?.meta?.changes ?? 0) !== 1) {
		return {
			error: "email_code_recently_sent",
			status: 429,
			retryAfter: Math.ceil(EMAIL_RESEND_COOLDOWN_MS / 1000),
		};
	}

	const cookie = challengeCookie(
		request,
		`${id}.${browserToken}`,
		Math.ceil(EMAIL_CHALLENGE_TTL_MS / 1000),
	);
	try {
		const content = mailContent(code);
		await env.EMAIL.send({
			to: email,
			from: { email: senderAddress(env), name: "Itsuki" },
			subject: content.subject,
			text: content.text,
			html: content.html,
		});
	} catch (error) {
		await env.DB.prepare(
			"UPDATE auth_email_challenges SET invalidated_at = ?, email_normalized = '' WHERE id = ? AND consumed_at IS NULL",
		).bind(Date.now(), id).run();
		console.warn("email challenge delivery failed:", error?.message ?? error);
		return { error: "email_delivery_failed", status: 503, cookie: clearEmailChallengeCookie(request) };
	}

	return {
		status: 202,
		cookie,
		body: {
			ok: true,
			email: maskedEmail(email),
			expires_at: expiresAt,
			resend_at: stamp + EMAIL_RESEND_COOLDOWN_MS,
		},
	};
}

function challengeEnvelope(request) {
	const value = parseCookies(request).get(EMAIL_CHALLENGE_COOKIE) || "";
	const separator = value.indexOf(".");
	if (separator <= 0) return null;
	return { id: value.slice(0, separator), browserToken: value.slice(separator + 1) };
}

/** Verify one code, resolve/create the verified account, and mint a session. */
export async function verifyEmailChallenge(env, request, body = {}) {
	const code = String(body.code ?? "").trim();
	if (!/^\d{6}$/.test(code)) return { error: "invalid_email_code", status: 401 };
	const secretValue = secret(env);
	const envelope = challengeEnvelope(request);
	if (!secretValue || !envelope) return { error: "invalid_email_code", status: 401 };

	let row = await env.DB.prepare("SELECT * FROM auth_email_challenges WHERE id = ? LIMIT 1")
		.bind(envelope.id).first();
	if (!row || row.consumed_at != null || row.invalidated_at != null) {
		return { error: "invalid_email_code", status: 401, cookie: clearEmailChallengeCookie(request) };
	}
	const stamp = Date.now();
	if (Number(row.expires_at) <= stamp) {
		await env.DB.prepare(
			"UPDATE auth_email_challenges SET invalidated_at = ?, email_normalized = '' WHERE id = ? AND invalidated_at IS NULL",
		).bind(stamp, row.id).run();
		return { error: "email_code_expired", status: 401, cookie: clearEmailChallengeCookie(request) };
	}
	const browserHash = await sha256Hex(envelope.browserToken);
	if (!(await timingSafeEqualString(browserHash, row.browser_token_hash))) {
		return { error: "invalid_email_code", status: 401 };
	}

	const submittedMac = await hmac(secretValue, `code:v1:${row.id}:${envelope.browserToken}:${code}`);
	const codeMatches = await timingSafeEqualString(submittedMac, row.code_mac);
	const verifiedEmail = row.email_normalized;
	const attempt = await env.DB.prepare(
		`UPDATE auth_email_challenges
		    SET attempts = attempts + 1,
		        consumed_at = CASE WHEN code_mac = ? THEN ? ELSE consumed_at END,
		        invalidated_at = CASE
		          WHEN code_mac <> ? AND attempts + 1 >= max_attempts THEN ?
		          ELSE invalidated_at END,
		        email_normalized = CASE
		          WHEN code_mac = ? OR attempts + 1 >= max_attempts THEN ''
		          ELSE email_normalized END
		  WHERE id = ? AND browser_token_hash = ?
		    AND consumed_at IS NULL AND invalidated_at IS NULL
		    AND expires_at > ? AND attempts < max_attempts`,
	).bind(submittedMac, stamp, submittedMac, stamp, submittedMac, row.id, browserHash, stamp).run();
	if (Number(attempt?.meta?.changes ?? 0) !== 1) {
		return { error: "invalid_email_code", status: 401, cookie: clearEmailChallengeCookie(request) };
	}
	row = await env.DB.prepare("SELECT * FROM auth_email_challenges WHERE id = ? LIMIT 1")
		.bind(row.id).first();
	if (!codeMatches || row.consumed_at == null) {
		return {
			error: "invalid_email_code",
			status: 401,
			...(row.invalidated_at != null ? { cookie: clearEmailChallengeCookie(request) } : {}),
		};
	}

	const resolved = await resolveVerifiedIdentity(env, {
		provider: "email",
		subject: verifiedEmail,
		email: verifiedEmail,
		verifiedAt: stamp,
	});
	if (resolved.error) {
		const status = resolved.error === "account_disabled" ? 403 : 503;
		return { error: resolved.error, status, cookie: clearEmailChallengeCookie(request) };
	}
	const authenticated = await issueAuthenticatedSession(
		env,
		request,
		resolved.user.id,
		resolved.created ? "email_signup" : "email_login",
		verifiedEmail,
	);
	if (authenticated.error) {
		return { ...authenticated, cookie: clearEmailChallengeCookie(request) };
	}
	return {
		status: resolved.created ? 201 : 200,
		user: authenticated.user,
		session: authenticated.session,
		cookie: clearEmailChallengeCookie(request),
		created: resolved.created,
	};
}
