/**
 * Security events — storm-suppressed operational security signals (0062).
 *
 * Every emit is best-effort and NEVER throws: a broken telemetry pipe must
 * not break the request that noticed something. Rows collapse on
 * UNIQUE(group_key, bucket_at) with 10-minute buckets, so a 10k-row storm is
 * one row whose `count` carries the volume — and volume itself escalates:
 * ten of anything in a bucket is one severity step worse, a hundred is two.
 *
 * Details pass a hard allowlist, mirroring audit.js: counts, enums, opaque
 * ids, ip-hash prefixes. Structurally no memory text, no secrets, no email
 * addresses. Account user ids ride in dedicated columns (actor_user_id /
 * target_user_id), never inside details_json, so account erasure severs them
 * with one UPDATE (src/pipeline/cleanup.js).
 *
 * Email is a courtesy, not truth: only high/critical rows ever notify, one
 * email per group per hour, at most 10 per hour globally; everything else
 * waits in the admin Trust & Safety tab, which always shows every row.
 */

import { renderEmail } from "./email_template.js";

export const SEVERITIES = ["low", "medium", "high", "critical"];
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export const BUCKET_MS = 10 * 60 * 1000;
const MAX_NOTIFY_ATTEMPTS = 5;
const notifyBackoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
const GROUP_EMAIL_COOLDOWN_MS = 60 * 60 * 1000;
const GLOBAL_EMAIL_HOURLY_CAP = 10;

/**
 * The only keys details_json may carry. Everything else is silently dropped;
 * values are coerced to bounded scalars. This is a structural guarantee, not
 * a convention — an emit site cannot leak what the sink refuses to store.
 */
export const SECURITY_EVENT_FIELDS = new Set([
	"count", "total", "dropped", "users",
	"window_ms", "threshold", "attempts", "oldest_ms",
	"ip_hash_prefix", "memory_user_id", "project_id", "run_id",
	"action", "phase", "code", "outcome", "target_type", "retryable",
]);

function scalar(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "boolean") return value;
	return String(value).slice(0, 120);
}

function sanitizeDetails(details) {
	const clean = {};
	for (const [key, value] of Object.entries(details ?? {})) {
		if (!SECURITY_EVENT_FIELDS.has(key)) continue;
		const coerced = scalar(value);
		if (coerced !== null) clean[key] = coerced;
	}
	const blob = JSON.stringify(clean);
	return blob.length > 2000 ? "{}" : blob;
}

function senderAddress(env) {
	const configured = String(env?.INVITE_EMAIL_FROM ?? "").trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : "invites@notify.itsuki.app";
}

/**
 * Record one signal. Same group + same 10-minute bucket collapses into one
 * row: count increments, last_at advances, and severity escalates to the
 * strongest emitted rank plus a storm bonus (>=10 → +1, >=100 → +2, capped
 * at critical). A row that crosses into high flips its notify outbox from
 * 'skipped' to 'pending' so the escalation itself can email the owner.
 */
export async function recordSecurityEvent(env, {
	kind, severity = "medium", groupKey = null, details = null,
	actorUserId = null, targetUserId = null, now = Date.now(),
} = {}) {
	try {
		const cleanKind = String(kind ?? "").trim().slice(0, 80);
		if (!cleanKind) return null;
		const cleanSeverity = SEVERITIES.includes(severity) ? severity : "medium";
		const rank = SEVERITY_RANK[cleanSeverity];
		const group = String(groupKey ?? cleanKind).trim().slice(0, 160) || cleanKind;
		const bucketAt = now - (now % BUCKET_MS);
		await env.DB.prepare(
			`INSERT INTO security_events
				(id, group_key, bucket_at, kind, severity, severity_rank, base_severity_rank, count,
				 details_json, actor_user_id, target_user_id, first_at, last_at,
				 notify_status, notify_attempts, notify_after)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, NULL)
			 ON CONFLICT(group_key, bucket_at) DO UPDATE SET
				count = security_events.count + 1,
				last_at = excluded.last_at,
				details_json = excluded.details_json,
				actor_user_id = COALESCE(excluded.actor_user_id, security_events.actor_user_id),
				target_user_id = COALESCE(excluded.target_user_id, security_events.target_user_id),
				base_severity_rank = MAX(security_events.base_severity_rank, excluded.base_severity_rank),
				severity_rank = MIN(3, MAX(security_events.base_severity_rank, excluded.base_severity_rank)
					+ CASE WHEN security_events.count + 1 >= 100 THEN 2
					       WHEN security_events.count + 1 >= 10 THEN 1 ELSE 0 END),
				severity = CASE MIN(3, MAX(security_events.base_severity_rank, excluded.base_severity_rank)
					+ CASE WHEN security_events.count + 1 >= 100 THEN 2
					       WHEN security_events.count + 1 >= 10 THEN 1 ELSE 0 END)
					WHEN 0 THEN 'low' WHEN 1 THEN 'medium' WHEN 2 THEN 'high' ELSE 'critical' END,
				notify_status = CASE
					WHEN security_events.notify_status = 'skipped'
					 AND MIN(3, MAX(security_events.base_severity_rank, excluded.base_severity_rank)
						+ CASE WHEN security_events.count + 1 >= 100 THEN 2
						       WHEN security_events.count + 1 >= 10 THEN 1 ELSE 0 END) >= 2
					THEN 'pending' ELSE security_events.notify_status END`,
		).bind(
			`sev_${crypto.randomUUID()}`, group, bucketAt, cleanKind, cleanSeverity, rank, rank,
			sanitizeDetails(details), actorUserId, targetUserId, now, now,
			rank >= 2 ? "pending" : "skipped",
		).run();
		return { groupKey: group, bucketAt };
	} catch (error) {
		console.warn("security event record failed:", error?.message ?? error);
		return null;
	}
}

/** The admin feed, newest activity first. */
export async function listSecurityEvents(env, { limit = 100, before = null } = {}) {
	const where = before ? "WHERE last_at < ?" : "";
	const bind = before ? [before, limit] : [limit];
	const { results } = await env.DB.prepare(
		`SELECT id, group_key, bucket_at, kind, severity, severity_rank, count,
		        details_json, actor_user_id, target_user_id, first_at, last_at, notify_status
		 FROM security_events ${where}
		 ORDER BY last_at DESC LIMIT ?`,
	).bind(...bind).all();
	return (results ?? []).map((row) => {
		let details = null;
		try { details = row.details_json ? JSON.parse(row.details_json) : null; } catch { details = null; }
		return { ...row, details_json: undefined, details };
	});
}

/**
 * Drain pending owner alerts (high/critical only — lower severities never
 * enter this outbox). Two suppression valves, both DEFER rather than drop:
 * one email per group per hour, and at most 10 event emails per hour overall.
 * A deferred row stays pending and fully visible in the admin tab — email is
 * never the source of truth.
 */
export async function processSecurityEventNotifications(env, { limit = 10, now = Date.now() } = {}) {
	const result = { sent: 0, failed: 0, skipped: 0, deferred: 0 };
	const ownerEmail = String(env?.OWNER_NOTIFY_EMAIL ?? "").trim();
	const { results: rows } = await env.DB.prepare(
		`SELECT id, group_key, kind, severity, severity_rank, count, details_json,
		        first_at, last_at, notify_attempts
		 FROM security_events
		 WHERE notify_status = 'pending' AND (notify_after IS NULL OR notify_after <= ?)
		 ORDER BY severity_rank DESC, last_at ASC LIMIT ?`,
	).bind(now, limit).all();
	if (!rows?.length) return result;

	if (!env.EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
		for (const row of rows) {
			await env.DB.prepare(
				"UPDATE security_events SET notify_status = 'skipped' WHERE id = ? AND notify_status = 'pending'",
			).bind(row.id).run();
			result.skipped += 1;
		}
		return result;
	}

	for (const row of rows) {
		// Global valve first: past 10 emails in the trailing hour, everything
		// waits its turn rather than flooding the owner's inbox.
		const sentLastHour = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM security_events WHERE notified_at IS NOT NULL AND notified_at > ?",
		).bind(now - GROUP_EMAIL_COOLDOWN_MS).first("n");
		if (Number(sentLastHour ?? 0) >= GLOBAL_EMAIL_HOURLY_CAP) {
			await env.DB.prepare(
				"UPDATE security_events SET notify_after = ? WHERE id = ? AND notify_status = 'pending'",
			).bind(now + 15 * 60 * 1000, row.id).run();
			result.deferred += 1;
			continue;
		}
		// Per-group valve: one email per group per hour.
		const lastGroupEmail = await env.DB.prepare(
			"SELECT MAX(notified_at) AS t FROM security_events WHERE group_key = ? AND notified_at IS NOT NULL",
		).bind(row.group_key).first("t");
		if (lastGroupEmail && Number(lastGroupEmail) > now - GROUP_EMAIL_COOLDOWN_MS) {
			await env.DB.prepare(
				"UPDATE security_events SET notify_after = ? WHERE id = ? AND notify_status = 'pending'",
			).bind(Number(lastGroupEmail) + GROUP_EMAIL_COOLDOWN_MS, row.id).run();
			result.deferred += 1;
			continue;
		}

		const attempts = Number(row.notify_attempts ?? 0) + 1;
		const claim = await env.DB.prepare(
			`UPDATE security_events SET notify_attempts = ?, notify_after = ?
			 WHERE id = ? AND notify_status = 'pending' AND notify_attempts = ?`,
		).bind(attempts, now + notifyBackoffMs(attempts), row.id, attempts - 1).run();
		if (Number(claim.meta?.changes ?? 0) !== 1) continue; // another drain owns it

		try {
			let details = null;
			try { details = row.details_json ? JSON.parse(row.details_json) : null; } catch { details = null; }
			const detailLine = details
				? Object.entries(details).map(([key, value]) => `${key}: ${value}`).join(" · ").slice(0, 400)
				: "no details";
			const { html, text } = renderEmail({
				kicker: "Itsuki security",
				heading: `${row.severity} · ${row.kind}`,
				intro: `A ${row.severity}-severity security signal fired${row.count > 1 ? ` ${row.count} times in a ten-minute window` : ""}.`,
				blocks: [
					{ type: "paragraph", text: `Group: ${row.group_key}` },
					{ type: "paragraph", text: `Details — ${detailLine}` },
					{ type: "button", label: "Open Trust & Safety", url: "https://itsuki.app/app#admin" },
				],
				footnote: "Suppressed repeats stay visible in the admin tab — this email is a notification, never the record.",
			});
			await env.EMAIL.send({
				to: ownerEmail,
				from: { email: senderAddress(env), name: "Itsuki" },
				subject: `[Itsuki security] ${row.severity}: ${row.kind}${row.count > 1 ? ` ×${row.count}` : ""}`,
				text,
				html,
			});
			// Stamped with the drain's own clock so the cooldown valves compare
			// like with like (tests inject `now`; cron passes real time).
			await env.DB.prepare(
				"UPDATE security_events SET notify_status = 'sent', notified_at = ? WHERE id = ?",
			).bind(now, row.id).run();
			result.sent += 1;
		} catch (error) {
			console.warn("security event notification failed:", error?.message ?? error);
			if (attempts >= MAX_NOTIFY_ATTEMPTS) {
				await env.DB.prepare(
					"UPDATE security_events SET notify_status = 'failed' WHERE id = ?",
				).bind(row.id).run();
				result.failed += 1;
			}
		}
	}
	return result;
}
