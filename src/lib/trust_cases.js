/**
 * Trust cases — the tracked queue behind the public promises (0062).
 *
 * Privacy §15 promises a response within 7 days. Until now that promise was
 * a manual email habit; a trust case gives it a clock. Every report lands as
 * a durable row with a status ladder (received → acknowledged → investigating
 * → resolved) and, for the DPDP-facing kinds (privacy_request AND
 * security_report), a response_due_at seven days out that the admin console
 * counts down and the owner email announces.
 *
 * The message is scrubbed through the same secret scrubber every save door
 * uses BEFORE it is stored, and capped at 2000 chars. There is deliberately
 * no one-open-case unique index — two security reports are two facts — the
 * abuse valve is an app-side cap of 3 cases per user per 24 hours.
 *
 * The notify_* columns are the 0059 mini-outbox: high/critical cases email
 * the owner immediately (drained inline via waitUntil and from cron);
 * medium/low cases wait 30 minutes and ride out as one digest per drain.
 */

import { renderEmail } from "./email_template.js";
import { scrubText } from "../pipeline/scrub.js";

export const TRUST_KINDS = ["privacy_request", "security_report", "abuse_report", "support"];
export const PRIVACY_CATEGORIES = ["question", "access", "export", "correction", "deletion"];
export const TRUST_RESOLUTIONS = ["fixed", "answered", "no_action", "duplicate", "spam"];

/** kind → severity, which also decides email immediacy (high goes out now). */
const KIND_SEVERITY = {
	security_report: "high",
	privacy_request: "medium",
	abuse_report: "medium",
	support: "low",
};

export const RESPONSE_DUE_MS = 7 * 24 * 60 * 60 * 1000;
const DUE_KINDS = new Set(["privacy_request", "security_report"]);
const MAX_MESSAGE_CHARS = 2000;
const MAX_NOTE_CHARS = 1000;
const MAX_CASES_PER_WINDOW = 3;
const CASE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DIGEST_DELAY_MS = 30 * 60 * 1000;
const MAX_NOTIFY_ATTEMPTS = 5;
const notifyBackoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

function senderAddress(env) {
	const configured = String(env?.INVITE_EMAIL_FROM ?? "").trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : "invites@notify.itsuki.app";
}

/** The reporter-facing shape: everything about their case EXCEPT admin_notes. */
function publicCase(row) {
	return {
		id: row.id,
		kind: row.kind,
		category: row.category,
		severity: row.severity,
		status: row.status,
		resolution: row.resolution,
		message: row.message,
		received_at: row.received_at,
		acknowledged_at: row.acknowledged_at,
		resolved_at: row.resolved_at,
		response_due_at: row.response_due_at,
	};
}

/**
 * File a report. Returns the public case on success or { error, status,
 * message } on refusal — the door translates, never throws.
 */
export async function createTrustCase(env, { userId, kind, category = null, message, now = Date.now() } = {}) {
	const cleanKind = String(kind ?? "").trim();
	if (!TRUST_KINDS.includes(cleanKind)) {
		return { error: "invalid_kind", status: 400, message: `kind must be one of: ${TRUST_KINDS.join(", ")}` };
	}
	let cleanCategory = null;
	if (cleanKind === "privacy_request") {
		cleanCategory = String(category ?? "question").trim() || "question";
		if (!PRIVACY_CATEGORIES.includes(cleanCategory)) {
			return { error: "invalid_category", status: 400, message: `category must be one of: ${PRIVACY_CATEGORIES.join(", ")}` };
		}
	}
	const rawMessage = String(message ?? "").trim();
	if (!rawMessage) {
		return { error: "message_required", status: 400, message: "Describe the issue — an empty report cannot be acted on." };
	}
	if (rawMessage.length > MAX_MESSAGE_CHARS) {
		return { error: "message_too_long", status: 400, message: `Keep the report under ${MAX_MESSAGE_CHARS} characters.` };
	}
	const recent = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM trust_cases WHERE user_id = ? AND received_at > ?",
	).bind(userId, now - CASE_WINDOW_MS).first("n");
	if (Number(recent ?? 0) >= MAX_CASES_PER_WINDOW) {
		return {
			error: "trust_case_limit", status: 429,
			message: "You have filed several reports in the last day. Add to an open case by replying to the response you receive, or try again tomorrow.",
		};
	}
	const severity = KIND_SEVERITY[cleanKind];
	const responseDueAt = DUE_KINDS.has(cleanKind) ? now + RESPONSE_DUE_MS : null;
	const id = `case_${crypto.randomUUID()}`;
	// The scrubber runs BEFORE storage: a pasted token in a support message
	// must not become a durable secret in the operator's queue.
	const scrubbed = scrubText(rawMessage).text;
	await env.DB.prepare(
		`INSERT INTO trust_cases
			(id, user_id, kind, category, severity, status, message, received_at, response_due_at,
			 updated_at, notify_status, notify_attempts, notify_after)
		 VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, 'pending', 0, ?)`,
	).bind(
		id, userId, cleanKind, cleanCategory, severity, scrubbed, now, responseDueAt, now,
		severity === "high" || severity === "critical" ? null : now + DIGEST_DELAY_MS,
	).run();
	return publicCase({
		id, kind: cleanKind, category: cleanCategory, severity, status: "received",
		resolution: null, message: scrubbed, received_at: now, acknowledged_at: null,
		resolved_at: null, response_due_at: responseDueAt,
	});
}

/** A reporter's own cases, newest first. Never includes admin_notes. */
export async function listTrustCasesForUser(env, userId, { limit = 50 } = {}) {
	const { results } = await env.DB.prepare(
		`SELECT id, kind, category, severity, status, resolution, message,
		        received_at, acknowledged_at, resolved_at, response_due_at
		 FROM trust_cases WHERE user_id = ? ORDER BY received_at DESC LIMIT ?`,
	).bind(userId, limit).all();
	return (results ?? []).map(publicCase);
}

export async function readTrustCase(env, caseId) {
	const row = await env.DB.prepare("SELECT * FROM trust_cases WHERE id = ?").bind(caseId).first();
	return row ?? null;
}

function adminCase(row) {
	let notes = [];
	try { notes = row.admin_notes ? JSON.parse(row.admin_notes) : []; } catch { notes = []; }
	return {
		id: row.id, user_id: row.user_id, email: row.email ?? null, name: row.name ?? null,
		kind: row.kind, category: row.category, severity: row.severity, status: row.status,
		resolution: row.resolution, message: row.message, admin_notes: notes,
		received_at: row.received_at, acknowledged_at: row.acknowledged_at,
		resolved_at: row.resolved_at, resolved_by: row.resolved_by,
		response_due_at: row.response_due_at, updated_at: row.updated_at,
		notify_status: row.notify_status,
	};
}

/**
 * Everything the Trust & Safety tab needs, in one trip: due-clock meta,
 * the case queue (open first, then resolved), and the security-event feed.
 */
export async function adminTrustOverview(env, { now = Date.now(), caseLimit = 100, eventLimit = 100 } = {}) {
	const [open, overdue, dueSoon, events24, cases, events] = await env.DB.batch([
		env.DB.prepare("SELECT COUNT(*) AS n FROM trust_cases WHERE status != 'resolved'"),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM trust_cases WHERE status != 'resolved' AND response_due_at IS NOT NULL AND response_due_at < ?",
		).bind(now),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM trust_cases WHERE status != 'resolved' AND response_due_at IS NOT NULL AND response_due_at >= ? AND response_due_at <= ?",
		).bind(now, now + 48 * 60 * 60 * 1000),
		env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM security_events WHERE last_at > ?").bind(now - 24 * 60 * 60 * 1000),
		env.DB.prepare(
			`SELECT tc.*, u.email, u.name
			 FROM trust_cases tc LEFT JOIN users u ON u.id = tc.user_id
			 ORDER BY (tc.status = 'resolved') ASC,
			          COALESCE(tc.response_due_at, tc.received_at + ${RESPONSE_DUE_MS * 52}) ASC,
			          tc.received_at DESC
			 LIMIT ?`,
		).bind(caseLimit),
		env.DB.prepare(
			`SELECT id, group_key, bucket_at, kind, severity, severity_rank, count, details_json,
			        actor_user_id, target_user_id, first_at, last_at, notify_status
			 FROM security_events ORDER BY last_at DESC LIMIT ?`,
		).bind(eventLimit),
	]);
	return {
		meta: {
			open: Number(open?.results?.[0]?.n ?? 0),
			overdue: Number(overdue?.results?.[0]?.n ?? 0),
			due_48h: Number(dueSoon?.results?.[0]?.n ?? 0),
			events_24h: Number(events24?.results?.[0]?.n ?? 0),
		},
		cases: (cases?.results ?? []).map(adminCase),
		events: (events?.results ?? []).map((row) => {
			let details = null;
			try { details = row.details_json ? JSON.parse(row.details_json) : null; } catch { details = null; }
			return { ...row, details_json: undefined, details };
		}),
		now,
	};
}

/** kind → default severity, exported so reclassify keeps the same mapping. */
export function defaultSeverityForKind(kind) {
	return KIND_SEVERITY[kind] ?? "low";
}

/**
 * Build the audited state statements for one admin action against a case.
 * Returns { error, status, message } for an invalid request, or
 * { statements, after } where `after` is the expected post-state used both
 * for the audit diff and the postcondition.
 *
 * The caller (the door) wraps these in runAuditedMutation with a
 * precondition pinning (status, updated_at) — the optimistic-concurrency
 * pattern every admin mutation here uses.
 */
export function trustCaseActionPlan(env, row, {
	action, actorUserId, resolution = null, note = null,
	kind = null, category = null, severity = null, now = Date.now(),
} = {}) {
	const set = (fields, binds) => env.DB.prepare(
		`UPDATE trust_cases SET ${fields}, updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?`,
	).bind(...binds, now, row.id, row.status, row.updated_at);

	switch (action) {
		case "acknowledge": {
			if (row.status !== "received") return { error: "invalid_transition", status: 409, message: "Only a received case can be acknowledged." };
			return {
				statements: [set("status = 'acknowledged', acknowledged_at = ?", [now])],
				after: { status: "acknowledged" },
			};
		}
		case "investigate": {
			if (!["received", "acknowledged"].includes(row.status)) {
				return { error: "invalid_transition", status: 409, message: "Only a received or acknowledged case can move to investigating." };
			}
			return {
				statements: [set("status = 'investigating', acknowledged_at = COALESCE(acknowledged_at, ?)", [now])],
				after: { status: "investigating" },
			};
		}
		case "resolve": {
			if (row.status === "resolved") return { error: "invalid_transition", status: 409, message: "The case is already resolved." };
			if (!TRUST_RESOLUTIONS.includes(String(resolution ?? ""))) {
				return { error: "invalid_resolution", status: 400, message: `resolution must be one of: ${TRUST_RESOLUTIONS.join(", ")}` };
			}
			return {
				statements: [set(
					"status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, acknowledged_at = COALESCE(acknowledged_at, ?)",
					[resolution, now, actorUserId, now],
				)],
				after: { status: "resolved", resolution },
			};
		}
		case "reopen": {
			if (row.status !== "resolved") return { error: "invalid_transition", status: 409, message: "Only a resolved case can be reopened." };
			return {
				statements: [set("status = 'investigating', resolution = NULL, resolved_at = NULL, resolved_by = NULL", [])],
				after: { status: "investigating", resolution: null },
			};
		}
		case "reclassify": {
			if (row.status === "resolved") return { error: "invalid_transition", status: 409, message: "Reopen the case before reclassifying it." };
			const nextKind = kind === null ? row.kind : String(kind).trim();
			if (!TRUST_KINDS.includes(nextKind)) {
				return { error: "invalid_kind", status: 400, message: `kind must be one of: ${TRUST_KINDS.join(", ")}` };
			}
			let nextCategory = null;
			if (nextKind === "privacy_request") {
				nextCategory = String(category ?? row.category ?? "question").trim() || "question";
				if (!PRIVACY_CATEGORIES.includes(nextCategory)) {
					return { error: "invalid_category", status: 400, message: `category must be one of: ${PRIVACY_CATEGORIES.join(", ")}` };
				}
			}
			const nextSeverity = severity === null ? defaultSeverityForKind(nextKind) : String(severity).trim();
			if (!["low", "medium", "high", "critical"].includes(nextSeverity)) {
				return { error: "invalid_severity", status: 400, message: "severity must be low, medium, high, or critical" };
			}
			// The clock follows the classification: a case reclassified INTO a
			// due-bearing kind owes its answer 7 days from RECEIPT, not from the
			// reclassification — the promise attaches to when they asked.
			const nextDue = DUE_KINDS.has(nextKind) ? Number(row.received_at) + RESPONSE_DUE_MS : null;
			return {
				statements: [set(
					"kind = ?, category = ?, severity = ?, response_due_at = ?",
					[nextKind, nextCategory, nextSeverity, nextDue],
				)],
				after: { kind: nextKind, category: nextCategory, severity: nextSeverity },
			};
		}
		case "note": {
			const cleanNote = String(note ?? "").trim().slice(0, MAX_NOTE_CHARS);
			if (!cleanNote) return { error: "note_required", status: 400, message: "An empty note records nothing." };
			let notes = [];
			try { notes = row.admin_notes ? JSON.parse(row.admin_notes) : []; } catch { notes = []; }
			notes.push({ at: now, by: actorUserId, text: cleanNote });
			return {
				statements: [set("admin_notes = ?", [JSON.stringify(notes.slice(-50))])],
				after: {},
			};
		}
		default:
			return { error: "unknown_action", status: 400, message: "unknown action" };
	}
}

/**
 * Drain pending owner notifications. High/critical cases email one-by-one,
 * immediately; medium/low cases (whose notify_after carries the 30-minute
 * delay) collapse into one digest per drain. The attempts CAS keeps
 * overlapping drains from double-sending; unconfigured email marks rows
 * 'skipped' rather than queueing forever — the admin tab shows every case
 * either way.
 */
export async function processTrustCaseNotifications(env, { limit = 10, now = Date.now() } = {}) {
	const result = { sent: 0, failed: 0, skipped: 0 };
	const ownerEmail = String(env?.OWNER_NOTIFY_EMAIL ?? "").trim();
	const { results: rows } = await env.DB.prepare(
		`SELECT tc.id, tc.user_id, tc.kind, tc.category, tc.severity, tc.message,
		        tc.received_at, tc.response_due_at, tc.notify_attempts, u.email
		 FROM trust_cases tc LEFT JOIN users u ON u.id = tc.user_id
		 WHERE tc.notify_status = 'pending' AND (tc.notify_after IS NULL OR tc.notify_after <= ?)
		 ORDER BY tc.received_at LIMIT ?`,
	).bind(now, limit).all();
	if (!rows?.length) return result;

	if (!env.EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
		for (const row of rows) {
			await env.DB.prepare(
				"UPDATE trust_cases SET notify_status = 'skipped', updated_at = ? WHERE id = ? AND notify_status = 'pending'",
			).bind(now, row.id).run();
			result.skipped += 1;
		}
		return result;
	}

	const from = { email: senderAddress(env), name: "Itsuki" };
	const dueLine = (row) => row.response_due_at
		? `Response due ${new Date(Number(row.response_due_at)).toISOString().slice(0, 10)} (7-day clock).`
		: "No response deadline on this kind.";

	const claim = async (row) => {
		const attempts = Number(row.notify_attempts ?? 0) + 1;
		const claimed = await env.DB.prepare(
			`UPDATE trust_cases SET notify_attempts = ?, notify_after = ?, updated_at = ?
			 WHERE id = ? AND notify_status = 'pending' AND notify_attempts = ?`,
		).bind(attempts, now + notifyBackoffMs(attempts), now, row.id, attempts - 1).run();
		return Number(claimed.meta?.changes ?? 0) === 1 ? attempts : null;
	};
	const settle = async (row, ok, attempts) => {
		if (ok) {
			await env.DB.prepare(
				"UPDATE trust_cases SET notify_status = 'sent', updated_at = ? WHERE id = ?",
			).bind(Date.now(), row.id).run();
			result.sent += 1;
		} else if (attempts >= MAX_NOTIFY_ATTEMPTS) {
			await env.DB.prepare(
				"UPDATE trust_cases SET notify_status = 'failed', updated_at = ? WHERE id = ?",
			).bind(Date.now(), row.id).run();
			result.failed += 1;
		}
	};

	const urgent = rows.filter((row) => row.severity === "high" || row.severity === "critical");
	const digest = rows.filter((row) => row.severity !== "high" && row.severity !== "critical");

	for (const row of urgent) {
		const attempts = await claim(row);
		if (attempts === null) continue;
		try {
			const { html, text } = renderEmail({
				kicker: "Itsuki trust & safety",
				heading: `${row.kind.replace(/_/g, " ")} — case ${row.id.slice(0, 13)}`,
				intro: `${row.email ?? "an account"} filed a ${row.severity}-severity ${row.kind.replace(/_/g, " ")}.`,
				blocks: [
					{ type: "paragraph", text: dueLine(row) },
					{ type: "note", text: `Their message: ${row.message}` },
					{ type: "button", label: "Open Trust & Safety", url: "https://itsuki.app/app#admin" },
				],
				footnote: "The case lives in the admin queue with its due clock either way — this email is a notification only.",
			});
			await env.EMAIL.send({
				to: ownerEmail, from,
				subject: `[Itsuki trust] ${row.kind}: ${row.email ?? row.user_id ?? "unknown"}`,
				text, html,
			});
			await settle(row, true, attempts);
		} catch (error) {
			console.warn("trust case notification failed:", error?.message ?? error);
			await settle(row, false, attempts);
		}
	}

	if (digest.length) {
		const claimed = [];
		for (const row of digest) {
			const attempts = await claim(row);
			if (attempts !== null) claimed.push({ row, attempts });
		}
		if (claimed.length) {
			try {
				const { html, text } = renderEmail({
					kicker: "Itsuki trust & safety",
					heading: `${claimed.length} new report${claimed.length === 1 ? "" : "s"}`,
					intro: "The 30-minute digest of new non-urgent reports.",
					blocks: [
						...claimed.map(({ row }) => ({
							type: "paragraph",
							text: `${row.kind.replace(/_/g, " ")}${row.category ? ` (${row.category})` : ""} from ${row.email ?? "an account"} — ${dueLine(row)} "${String(row.message).slice(0, 140)}"`,
						})),
						{ type: "button", label: "Open Trust & Safety", url: "https://itsuki.app/app#admin" },
					],
					footnote: "Every case is in the admin queue with its clock — digests only batch the notification.",
				});
				await env.EMAIL.send({
					to: ownerEmail, from,
					subject: `[Itsuki trust] ${claimed.length} new report${claimed.length === 1 ? "" : "s"}`,
					text, html,
				});
				for (const { row, attempts } of claimed) await settle(row, true, attempts);
			} catch (error) {
				console.warn("trust digest notification failed:", error?.message ?? error);
				for (const { row, attempts } of claimed) await settle(row, false, attempts);
			}
		}
	}
	return result;
}
