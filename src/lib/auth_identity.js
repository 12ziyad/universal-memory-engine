import { newId } from "./ids.js";
import { stampEarlyAccess } from "./ai_budget.js";

const PROVIDERS = new Set(["google", "github", "email"]);

function cleanName(value) {
	return String(value ?? "").trim().slice(0, 120) || null;
}

async function identityUser(env, provider, subject) {
	return env.DB.prepare(
		`SELECT u.*
		   FROM auth_identities i
		   JOIN users u ON u.id = i.user_id
		  WHERE i.provider = ? AND i.provider_subject = ?
		  LIMIT 1`,
	).bind(provider, subject).first();
}

async function linkExistingUser(env, { provider, subject, email, name, verifiedAt, userId }) {
	const stamp = Date.now();
	const statements = [
		env.DB.prepare(
			`INSERT OR IGNORE INTO auth_identities
			 (id, user_id, provider, provider_subject, provider_email, email_verified_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(newId("aid"), userId, provider, subject, email, verifiedAt, stamp, stamp),
		env.DB.prepare(
			`UPDATE users
			    SET updated_at = ?,
			        email_verified_at = COALESCE(email_verified_at, ?),
			        name = CASE WHEN COALESCE(name, '') = '' THEN ? ELSE name END,
			        google_sub = CASE WHEN ? = 'google' THEN ? ELSE google_sub END
			  WHERE id = (
			    SELECT user_id FROM auth_identities
			     WHERE provider = ? AND provider_subject = ?
			  )`,
		).bind(stamp, verifiedAt, cleanName(name), provider, provider === "google" ? subject : null, provider, subject),
	];
	await env.DB.batch(statements);
	return identityUser(env, provider, subject);
}

/**
 * Resolve a provider identity only after the provider has proved both the
 * subject and the email address.  The unique provider/subject row is the
 * stable identity; email is used only for the first safe link to an existing
 * account.  INSERT OR IGNORE plus a post-read makes concurrent first logins
 * converge on one user instead of manufacturing duplicate accounts.
 */
export async function resolveVerifiedIdentity(env, {
	provider,
	subject,
	email,
	name = null,
	verifiedAt = Date.now(),
}) {
	provider = String(provider ?? "").trim().toLowerCase();
	subject = String(subject ?? "").trim();
	email = String(email ?? "").trim().toLowerCase();
	if (!PROVIDERS.has(provider) || !subject || !email || !verifiedAt) {
		return { error: "identity_invalid" };
	}

	let user = await identityUser(env, provider, subject);
	if (user) {
		if (user.status === "disabled") return { error: "account_disabled" };
		return { user, created: false };
	}

	// Compatibility for accounts linked before auth_identities existed.
	if (provider === "google") {
		const legacy = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ? LIMIT 1")
			.bind(subject).first();
		if (legacy) {
			if (legacy.status === "disabled") return { error: "account_disabled" };
			user = await linkExistingUser(env, {
				provider, subject, email, name, verifiedAt, userId: legacy.id,
			});
			if (!user) return { error: "identity_link_failed" };
			if (user.status === "disabled") return { error: "account_disabled" };
			return { user, created: false };
		}
	}

	const byEmail = await env.DB.prepare("SELECT * FROM users WHERE email_normalized = ? LIMIT 1")
		.bind(email).first();
	if (byEmail) {
		if (byEmail.status === "disabled") return { error: "account_disabled" };
		user = await linkExistingUser(env, {
			provider, subject, email, name, verifiedAt, userId: byEmail.id,
		});
		if (!user) return { error: "identity_link_failed" };
		if (user.status === "disabled") return { error: "account_disabled" };
		return { user, created: false };
	}

	const id = newId("user");
	const stamp = Date.now();
	const normalizedName = cleanName(name);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO users
			 (id, email, email_normalized, password_hash, password_salt, name, created_at, updated_at,
			  status, role, terms_accepted_at, email_verified_at, google_sub)
			 VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'active', 'user', ?, ?, ?)`,
		).bind(
			id, email, email, normalizedName, stamp, stamp, stamp, verifiedAt,
			provider === "google" ? subject : null,
		),
		env.DB.prepare(
			`INSERT OR IGNORE INTO auth_identities
			 (id, user_id, provider, provider_subject, provider_email, email_verified_at, created_at, updated_at)
			 SELECT ?, id, ?, ?, ?, ?, ?, ?
			   FROM users WHERE email_normalized = ? LIMIT 1`,
		).bind(newId("aid"), provider, subject, email, verifiedAt, stamp, stamp, email),
		env.DB.prepare(
			`UPDATE users
			    SET google_sub = CASE WHEN ? = 'google' THEN ? ELSE google_sub END,
			        email_verified_at = COALESCE(email_verified_at, ?),
			        updated_at = ?
			  WHERE id = (
			    SELECT user_id FROM auth_identities
			     WHERE provider = ? AND provider_subject = ?
			  )`,
		).bind(provider, provider === "google" ? subject : null, verifiedAt, stamp, provider, subject),
	]);

	user = await identityUser(env, provider, subject);
	if (!user) return { error: "identity_create_failed" };
	if (user.status === "disabled") return { error: "account_disabled" };
	if (user.id === id) await stampEarlyAccess(env, user.id, stamp);
	return { user, created: user.id === id };
}

