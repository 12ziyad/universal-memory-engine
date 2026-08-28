/**
 * Upgrade requests — the "Request more" flow behind every quota wall.
 *
 * No payment processor, no checkout, no prices: a request row the owner
 * grants manually from the admin portal. The row itself is the durable
 * artifact (created in the request transaction); the owner email is a
 * best-effort notification with a cron-drained mini-outbox on the same row
 * (notify_* columns, migration 0059), so a mail blip never loses a request
 * and the admin queue stays the source of truth either way.
 */

import { renderEmail } from "./email_template.js";

const KINDS = new Set(["saves", "huba", "other"]);
const MAX_NOTE_CHARS = 500;
const MAX_NOTIFY_ATTEMPTS = 5;
const notifyBackoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

function senderAddress(env) {
	const configured = String(env?.INVITE_EMAIL_FROM ?? "").trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : "invites@notify.itsuki.app";
}

export async function createUpgradeRequest(env, { userId, kind, note, usage }) {
	const cleanKind = KINDS.has(kind) ? kind : "other";
	const cleanNote = String(note ?? "").trim().slice(0, MAX_NOTE_CHARS) || null;
	const now = Date.now();
	const id = `upreq_${crypto.randomUUID()}`;
	// One open request per (user, kind): pressing the button again refreshes
	// the note and usage snapshot instead of stacking duplicates.
	const row = await env.DB.prepare(
		`INSERT INTO upgrade_requests
			(id, user_id, kind, note, usage_json, status, notify_status, notify_after, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'open', 'pending', ?, ?, ?)
		 ON CONFLICT(user_id, kind) WHERE status = 'open'
		 DO UPDATE SET note = excluded.note, usage_json = excluded.usage_json, updated_at = excluded.updated_at
		 RETURNING id, created_at, updated_at`,
	).bind(id, userId, cleanKind, cleanNote, usage ? JSON.stringify(usage).slice(0, 4000) : null, now, now, now).first();
	return { id: row?.id ?? id, kind: cleanKind, updated: row?.id !== id };
}

/**
 * Drain pending owner notifications. Called opportunistically after a request
 * lands and from the cron tick. The attempts CAS keeps overlapping drains
 * from double-sending; unconfigured email marks rows 'skipped' rather than
 * letting them queue forever — the admin portal still shows every request.
 */
export async function processUpgradeRequestNotifications(env, { limit = 10, now = Date.now() } = {}) {
	const result = { sent: 0, failed: 0, skipped: 0 };
	const ownerEmail = String(env?.OWNER_NOTIFY_EMAIL ?? "").trim();
	const { results: rows } = await env.DB.prepare(
		`SELECT id, user_id, kind, note, usage_json, notify_attempts, created_at
		 FROM upgrade_requests
		 WHERE notify_status = 'pending' AND (notify_after IS NULL OR notify_after <= ?)
		 ORDER BY created_at LIMIT ?`,
	).bind(now, limit).all();
	if (!rows?.length) return result;

	if (!env.EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
		for (const row of rows) {
			await env.DB.prepare(
				"UPDATE upgrade_requests SET notify_status = 'skipped', updated_at = ? WHERE id = ? AND notify_status = 'pending'",
			).bind(now, row.id).run();
			result.skipped += 1;
		}
		return result;
	}

	for (const row of rows) {
		const attempts = Number(row.notify_attempts ?? 0) + 1;
		const claim = await env.DB.prepare(
			`UPDATE upgrade_requests SET notify_attempts = ?, notify_after = ?, updated_at = ?
			 WHERE id = ? AND notify_status = 'pending' AND notify_attempts = ?`,
		).bind(attempts, now + notifyBackoffMs(attempts), now, row.id, attempts - 1).run();
		if (Number(claim.meta?.changes ?? 0) !== 1) continue; // another drain owns it

		try {
			const user = await env.DB.prepare(
				"SELECT email, name, created_at FROM users WHERE id = ?",
			).bind(row.user_id).first();
			let usage = null;
			try { usage = row.usage_json ? JSON.parse(row.usage_json) : null; } catch { usage = null; }
			const kindLabel = row.kind === "saves" ? "more daily saves"
				: row.kind === "huba" ? "more Huba messages" : "an account limit change";
			const usageLine = usage
				? Object.entries(usage).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ").slice(0, 400)
				: "no usage snapshot";
			const { html, text } = renderEmail({
				kicker: "Itsuki admin",
				heading: "Upgrade request",
				intro: `${user?.name || user?.email || row.user_id} asked for ${kindLabel}.`,
				blocks: [
					{ type: "paragraph", text: `Account: ${user?.email ?? "unknown"} (${row.user_id})` },
					{ type: "paragraph", text: `Usage at request time — ${usageLine}` },
					...(row.note ? [{ type: "note", text: `Their note: ${row.note}` }] : []),
					{ type: "button", label: "Open the admin queue", url: "https://itsuki.app/app#admin" },
				],
				footnote: "Grant or dismiss from the admin portal. This email is a notification only — the request lives in the queue either way.",
			});
			await env.EMAIL.send({
				to: ownerEmail,
				from: { email: senderAddress(env), name: "Itsuki" },
				subject: `Upgrade request: ${user?.email ?? row.user_id} wants ${kindLabel}`,
				text,
				html,
			});
			await env.DB.prepare(
				"UPDATE upgrade_requests SET notify_status = 'sent', updated_at = ? WHERE id = ?",
			).bind(Date.now(), row.id).run();
			result.sent += 1;
		} catch (error) {
			console.warn("upgrade-request notification failed:", error?.message ?? error);
			if (attempts >= MAX_NOTIFY_ATTEMPTS) {
				await env.DB.prepare(
					"UPDATE upgrade_requests SET notify_status = 'failed', updated_at = ? WHERE id = ?",
				).bind(Date.now(), row.id).run();
				result.failed += 1;
			}
		}
	}
	return result;
}

/** The admin queue, newest first, with requester identity joined in. */
export async function listUpgradeRequests(env, { status = "open", limit = 50 } = {}) {
	const cleanStatus = ["open", "granted", "dismissed", "all"].includes(status) ? status : "open";
	const where = cleanStatus === "all" ? "" : "WHERE ur.status = ?";
	const bind = cleanStatus === "all" ? [limit] : [cleanStatus, limit];
	const { results } = await env.DB.prepare(
		`SELECT ur.id, ur.user_id, ur.kind, ur.note, ur.usage_json, ur.status, ur.notify_status,
		        ur.created_at, ur.updated_at, ur.resolved_at, ur.resolved_by, ur.grant_json,
		        u.email, u.name
		 FROM upgrade_requests ur LEFT JOIN users u ON u.id = ur.user_id
		 ${where}
		 ORDER BY ur.created_at DESC LIMIT ?`,
	).bind(...bind).all();
	return (results ?? []).map((row) => {
		let usage = null;
		try { usage = row.usage_json ? JSON.parse(row.usage_json) : null; } catch { usage = null; }
		let grant = null;
		try { grant = row.grant_json ? JSON.parse(row.grant_json) : null; } catch { grant = null; }
		return { ...row, usage_json: undefined, grant_json: undefined, usage, grant };
	});
}

/**
 * The one-click grant: writes user_entitlements (N days × amounts) and marks
 * the request granted, in one batch. NULL amounts leave that dimension on the
 * env default. Also usable without a request id for a direct admin grant.
 */
export function grantEntitlementStatements(env, {
	userId, grantedBy, days = null,
	dailyNeurons = null, monthlyWrites = null, hubaDailyMessages = null,
	note = null, requestId = null,
}) {
	const now = Date.now();
	const positive = (value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
	};
	const cleanDays = positive(days);
	const expiresAt = cleanDays ? now + cleanDays * 24 * 60 * 60 * 1000 : null;
	const grant = {
		daily_neurons: positive(dailyNeurons),
		monthly_writes: positive(monthlyWrites),
		huba_daily_messages: positive(hubaDailyMessages),
		expires_at: expiresAt,
	};
	const statements = [
		env.DB.prepare(
			`INSERT INTO user_entitlements
				(user_id, daily_neurons, monthly_writes, huba_daily_messages, early_access, expires_at, note, granted_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
				daily_neurons = excluded.daily_neurons,
				monthly_writes = excluded.monthly_writes,
				huba_daily_messages = excluded.huba_daily_messages,
				expires_at = excluded.expires_at,
				note = excluded.note,
				granted_by = excluded.granted_by,
				updated_at = excluded.updated_at`,
		).bind(
			userId, grant.daily_neurons, grant.monthly_writes, grant.huba_daily_messages,
			expiresAt, note ? String(note).slice(0, 400) : null, grantedBy ?? null, now, now,
		),
	];
	if (requestId) {
		statements.push(env.DB.prepare(
			`UPDATE upgrade_requests
			 SET status = 'granted', resolved_at = ?, resolved_by = ?, grant_json = ?, updated_at = ?
			 WHERE id = ? AND user_id = ? AND status = 'open'`,
		).bind(now, grantedBy ?? null, JSON.stringify(grant), now, requestId, userId));
	}
	return { statements, grant, expiresAt };
}

export async function grantEntitlement(env, opts) {
	const { statements, grant, expiresAt } = grantEntitlementStatements(env, opts);
	await env.DB.batch(statements);
	return { granted: grant, expiresAt };
}

export async function dismissUpgradeRequest(env, { requestId, resolvedBy }) {
	const now = Date.now();
	const done = await env.DB.prepare(
		`UPDATE upgrade_requests SET status = 'dismissed', resolved_at = ?, resolved_by = ?, updated_at = ?
		 WHERE id = ? AND status = 'open'`,
	).bind(now, resolvedBy ?? null, now, requestId).run();
	return { dismissed: Number(done.meta?.changes ?? 0) === 1 };
}
