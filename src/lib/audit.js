/**
 * Audit — who changed what, and whether it worked.
 *
 * The hard rule is that this log must never become a second copy of the thing
 * it protects. It records ids, action codes, an outcome, and a diff of
 * ALLOWLISTED metadata fields. It does not record memory text, extraction
 * instructions, invitation tokens, API keys, MCP URLs, or request bodies —
 * not because callers are trusted to omit them, but because `auditDiff()`
 * drops any field not on the list and `writeAudit` coerces what survives to a
 * bounded scalar.
 *
 * Writing an audit row must also never break the action it describes. A
 * failure here is logged and swallowed: a member removal that succeeded and
 * then 500ed on its own audit write would be the worst of both worlds.
 */

import { newId } from "./ids.js";

/**
 * The only fields that may appear in a before/after diff. Everything here is
 * configuration metadata a user chose from a bounded set — never free text
 * they wrote about themselves.
 */
export const AUDITABLE_FIELDS = new Set([
	"name", "description", "role", "org_role", "project_role", "status",
	"is_default", "capture_default", "capture_density", "auto_collect",
	"includes_count", "excludes_count", "categories_count", "instructions_present",
	"slug", "email_domain", "expires_at", "project_id", "org_id", "member_count",
]);

const MAX_VALUE_LENGTH = 120;

function scalar(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean" || typeof value === "number") return value;
	return String(value).slice(0, MAX_VALUE_LENGTH);
}

/**
 * Build a metadata diff containing only fields that actually changed, and only
 * from the allowlist. An unknown key is dropped silently rather than throwing,
 * because an audit write is not the place to fail a request — but it is also
 * never passed through.
 */
export function auditDiff(before = {}, after = {}) {
	const diff = {};
	for (const field of AUDITABLE_FIELDS) {
		const from = scalar(before?.[field]);
		const to = scalar(after?.[field]);
		if (from === undefined && to === undefined) continue;
		if (from === null && to === null) continue;
		if (from !== to) diff[field] = { from, to };
	}
	return diff;
}

/**
 * An email is personal data, but "which domain did we invite" is the useful
 * half for an audit trail and is far less sensitive. Store only the domain.
 */
export function emailDomain(email) {
	const at = String(email ?? "").lastIndexOf("@");
	return at === -1 ? null : String(email).slice(at + 1).toLocaleLowerCase("en-US").slice(0, 60);
}

export async function writeAudit(env, {
	orgId = null,
	projectId = null,
	actorUserId = null,
	actorType = "user",
	action,
	targetType = null,
	targetId = null,
	outcome = "ok",
	reason = null,
	metadata = null,
	requestId = null,
} = {}) {
	if (!env?.DB || !action) return null;
	try {
		const id = newId("aud");
		// Bound the blob: a metadata object is a diff of a handful of fields, and
		// anything larger is a bug worth truncating rather than storing.
		const blob = metadata && Object.keys(metadata).length
			? JSON.stringify(metadata).slice(0, 2000)
			: null;
		await env.DB.prepare(
			`INSERT INTO audit_events
			 (id, org_id, project_id, actor_user_id, actor_type, action, target_type, target_id,
			  outcome, reason, metadata_json, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id, orgId, projectId, actorUserId, actorType, String(action).slice(0, 60),
			targetType ? String(targetType).slice(0, 40) : null,
			targetId ? String(targetId).slice(0, 80) : null,
			String(outcome).slice(0, 20),
			reason ? String(reason).slice(0, 80) : null,
			blob, requestId ? String(requestId).slice(0, 80) : null, Date.now(),
		).run();
		return id;
	} catch (error) {
		// Never fail the action being audited.
		console.warn("audit write failed:", error?.message ?? error);
		return null;
	}
}

/** Paginated, scoped, newest first. Actor emails are joined for display only. */
export async function listAuditEvents(env, { orgId = null, projectId = null, action = null, limit = 50, before = null } = {}) {
	const clauses = [];
	const binds = [];
	if (projectId) { clauses.push("a.project_id = ?"); binds.push(projectId); }
	else if (orgId) { clauses.push("a.org_id = ?"); binds.push(orgId); }
	else return { events: [], next_before: null };
	if (action) { clauses.push("a.action = ?"); binds.push(String(action).slice(0, 60)); }
	// `Number(null)` is 0 and `Number.isFinite(0)` is true, so a bare finiteness
	// check turns "no cursor" into `created_at < 0` and returns an empty page
	// forever. Absent has to be tested for before the value is coerced.
	const cursor = before === null || before === undefined || before === "" ? null : Number(before);
	if (cursor !== null && Number.isFinite(cursor)) {
		clauses.push("a.created_at < ?");
		binds.push(cursor);
	}
	const capped = Math.max(1, Math.min(200, Number(limit) || 50));
	const { results } = await env.DB.prepare(
		`SELECT a.id, a.org_id, a.project_id, a.actor_user_id, a.actor_type, a.action,
		        a.target_type, a.target_id, a.outcome, a.reason, a.metadata_json, a.created_at,
		        u.email AS actor_email
		   FROM audit_events a
		   LEFT JOIN users u ON u.id = a.actor_user_id
		  WHERE ${clauses.join(" AND ")}
		  ORDER BY a.created_at DESC LIMIT ?`,
	).bind(...binds, capped + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, capped);
	return {
		events: page.map((row) => ({
			id: row.id,
			action: row.action,
			actor: row.actor_email ?? row.actor_user_id ?? "system",
			actor_type: row.actor_type,
			target_type: row.target_type,
			target_id: row.target_id,
			outcome: row.outcome,
			reason: row.reason,
			metadata: row.metadata_json ? safeParse(row.metadata_json) : null,
			created_at: row.created_at,
		})),
		next_before: rows.length > capped ? page[page.length - 1].created_at : null,
	};
}

function safeParse(value) {
	try { return JSON.parse(value); } catch { return null; }
}
