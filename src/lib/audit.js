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
 * Best-effort operational events use writeAudit(). Security and settings
 * mutations use beginAuditIntent() before changing state, then finalize the
 * same row. That two-phase contract prevents a successful mutation from
 * becoming unaudited while also avoiding an "applied, but returned 500"
 * ambiguity if finalization is temporarily unavailable.
 */

import { newId } from "./ids.js";

/**
 * The only fields that may appear in a before/after diff. Everything here is
 * configuration metadata a user chose from a bounded set — never free text
 * they wrote about themselves.
 */
export const AUDITABLE_FIELDS = new Set([
	"role", "org_role", "project_role", "status",
	"is_default", "capture_default", "capture_density", "auto_collect",
	"includes_count", "excludes_count", "categories_count", "instructions_present",
	"slug", "color_token", "email_domain", "expires_at", "access_starts_at", "access_expires_at",
	"project_id", "org_id", "member_count", "credential_count", "active_count", "archived_count",
	"retention_class", "retention_days", "policy_version", "delivery_status",
	"capture_enabled", "capture_state", "project_count", "replacement_category_id",
	"assignment_count", "memory_space_count", "run_mode", "deleted_count",
	"format", "metadata_only", "events_count",
]);

// Names and descriptions are user-authored text. The audit trail may record
// that either field changed, but never the old or new value: otherwise a
// project description can quietly become a second, append-only copy of private
// content. These marker keys are structural metadata, not configuration text.
const CHANGE_ONLY_FIELDS = new Set(["name", "description"]);
const AUDIT_METADATA_FIELDS = new Set([
	...AUDITABLE_FIELDS,
	...Array.from(CHANGE_ONLY_FIELDS, (field) => `${field}_changed`),
]);

const MAX_VALUE_LENGTH = 120;
const MAX_REQUEST_ID_LENGTH = 80;
const INTERNAL_REQUEST_ID_HEADER = "x-itsuki-audit-request-id";
const SAFE_CODE = /^[a-z0-9_.:-]{1,80}$/i;
const UUID_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID_REQUEST_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_REQUEST_ID = /^[0-9a-f]{16,64}$/i;
const CF_RAY_REQUEST_ID = /^[0-9a-f]{16,32}(?:-[A-Z]{3})?$/i;

export class AuditUnavailableError extends Error {
	constructor(message = "The security audit trail is temporarily unavailable. No changes were made.") {
		super(message);
		this.name = "AuditUnavailableError";
		this.code = "audit_unavailable";
		this.status = 503;
	}
}

export class AuditReplayError extends Error {
	constructor(eventId = null, outcome = "pending") {
		super(outcome === "pending"
			? "That request is already being processed. Reload before trying again."
			: "That request was already processed. Reload to see its result.");
		this.name = "AuditReplayError";
		this.code = "audit_request_replayed";
		this.status = 409;
		this.eventId = eventId;
		this.outcome = outcome;
	}
}

function safeCode(value, fallback = null) {
	if (value === null || value === undefined || value === "") return fallback;
	const code = String(value);
	return SAFE_CODE.test(code) ? code : fallback;
}

function validRequestId(value, kind = "request") {
	if (typeof value !== "string" || value.length > MAX_REQUEST_ID_LENGTH) return null;
	const candidate = value.trim();
	if (!candidate || candidate !== value) return null;
	if (kind === "cf-ray") return CF_RAY_REQUEST_ID.test(candidate) ? candidate : null;
	return UUID_REQUEST_ID.test(candidate) || ULID_REQUEST_ID.test(candidate) || HEX_REQUEST_ID.test(candidate)
		? candidate
		: null;
}

/**
 * Derive one privacy-safe correlation id at the Worker door. Free-form header
 * text is deliberately rejected: correlation fields must never become a side
 * channel for bearer tokens, emails, request bodies, or control characters.
 */
export function deriveRequestId(request) {
	const caller = validRequestId(request?.headers?.get?.("x-request-id"));
	if (caller) return caller;
	const ray = validRequestId(request?.headers?.get?.("cf-ray"), "cf-ray");
	return ray ?? crypto.randomUUID();
}

/** Replace, never preserve, the caller's private internal correlation header. */
export function withAuditRequestId(request, requestId) {
	const safe = validRequestId(requestId) ?? crypto.randomUUID();
	const headers = new Headers(request.headers);
	headers.set(INTERNAL_REQUEST_ID_HEADER, safe);
	return new Request(request, { headers });
}

export function auditRequestId(request) {
	return validRequestId(request?.headers?.get?.(INTERNAL_REQUEST_ID_HEADER));
}

export function withResponseRequestId(response, requestId) {
	const safe = validRequestId(requestId);
	if (!safe) return response;
	const headers = new Headers(response.headers);
	headers.set("x-request-id", safe);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Content-free id for cron/scheduler work that has no HTTP request. */
export function systemRequestId(kind, stableId = null) {
	const prefix = safeCode(kind, "system").slice(0, 20);
	const suffix = stableId && SAFE_CODE.test(String(stableId))
		? String(stableId).slice(0, 48)
		: crypto.randomUUID();
	return `${prefix}:${suffix}`.slice(0, MAX_REQUEST_ID_LENGTH);
}

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
	for (const field of CHANGE_ONLY_FIELDS) {
		const from = before?.[field] ?? null;
		const to = after?.[field] ?? null;
		if (from !== to) diff[`${field}_changed`] = { from: false, to: true };
	}
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
 * Enforce the allowlist again at the persistence boundary. Most callers use
 * auditDiff(), but writeAudit() is exported and must remain safe even when a
 * future caller accidentally hands it a request body or private memory text.
 */
function sanitizeAuditMetadata(metadata) {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
	const safe = {};
	for (const field of AUDIT_METADATA_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(metadata, field)) continue;
		const value = metadata[field];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const change = {};
			if (Object.prototype.hasOwnProperty.call(value, "from")) change.from = scalar(value.from);
			if (Object.prototype.hasOwnProperty.call(value, "to")) change.to = scalar(value.to);
			if (Object.keys(change).length) safe[field] = change;
			continue;
		}
		safe[field] = scalar(value);
	}
	return Object.keys(safe).length ? safe : null;
}

function metadataBlob(metadata) {
	const safeMetadata = sanitizeAuditMetadata(metadata);
	return safeMetadata ? JSON.stringify(safeMetadata).slice(0, 2000) : null;
}

function boundedId(value, max = 100) {
	if (value === null || value === undefined || value === "") return null;
	const text = String(value);
	if (/[\u0000-\u001f\u007f]/.test(text)) return null;
	return text.slice(0, max);
}

function storedRequestId(value) {
	if (value === null || value === undefined || value === "") return null;
	const text = String(value);
	return text.length <= MAX_REQUEST_ID_LENGTH && SAFE_CODE.test(text) ? text : null;
}

function auditOutcome(value, fallback = "ok") {
	return ["pending", "committed", "ok", "noop", "denied", "conflict", "failed", "failed_partial"].includes(value) ? value : fallback;
}

async function dedupeKey(action, targetType, targetId, override = null) {
	const raw = override ?? `${action}|${targetType ?? "-"}|${targetId ?? "-"}`;
	const value = String(raw);
	if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) return null;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
		`itsuki:audit-dedupe:v1\u0000${value}`,
	));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function auditErrorOutcome(error) {
	const status = Number(error?.status ?? 500);
	if (status === 401 || status === 403) return "denied";
	if ([409, 412, 428].includes(status)) return "conflict";
	return "failed";
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
		const blob = metadataBlob(metadata);
		const safeAction = safeCode(action);
		if (!safeAction) return null;
		await env.DB.prepare(
			`INSERT INTO audit_events
			 (id, org_id, project_id, actor_user_id, actor_type, action, target_type, target_id,
			  outcome, reason, metadata_json, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id, boundedId(orgId), boundedId(projectId), boundedId(actorUserId), safeCode(actorType, "user"), safeAction,
			safeCode(targetType),
			boundedId(targetId, 80),
			auditOutcome(outcome),
			safeCode(reason),
			blob, storedRequestId(requestId), Date.now(),
		).run();
		return id;
	} catch (error) {
		// Never fail the action being audited.
		console.warn("audit write failed:", error?.message ?? error);
		return null;
	}
}

/**
 * Durably reserve the one audit event a governed mutation will finalize.
 * Failure is intentionally fatal and must happen before the mutation starts.
 */
export async function beginAuditIntent(env, {
	orgId = null,
	projectId = null,
	actorUserId = null,
	actorType = "user",
	action,
	targetType = null,
	targetId = null,
	metadata = null,
	requestId = null,
	idempotencyKey = null,
	guardActorUserId = actorUserId,
	guardOrgId = orgId,
	guardProjectId = projectId,
	authorizationGuards = [],
} = {}) {
	const safeAction = safeCode(action);
	if (!env?.DB || !safeAction) throw new AuditUnavailableError();
	const intent = {
		id: newId("aud"),
		orgId: boundedId(orgId),
		projectId: boundedId(projectId),
		actorUserId: boundedId(actorUserId),
		actorType: safeCode(actorType, "user"),
		action: safeAction,
		targetType: safeCode(targetType),
		targetId: boundedId(targetId, 80),
		requestId: storedRequestId(requestId),
		guardActorUserId: boundedId(guardActorUserId),
		guardOrgId: boundedId(guardOrgId),
		guardProjectId: boundedId(guardProjectId),
		authorizationGuards: Array.isArray(authorizationGuards) ? authorizationGuards.filter(Boolean) : [],
	};
	intent.dedupeKey = intent.requestId
		? await dedupeKey(intent.action, intent.targetType, intent.targetId, idempotencyKey)
		: null;
	if (intent.requestId && !intent.dedupeKey) throw new AuditUnavailableError();
	try {
		const result = await env.DB.prepare(
			`INSERT INTO audit_events
			 (id, org_id, project_id, actor_user_id, actor_type, action, target_type, target_id,
			  outcome, reason, metadata_json, request_id, created_at, dedupe_key)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'awaiting_completion', ?, ?, ?, ?)
			 ON CONFLICT DO NOTHING`,
		).bind(
			intent.id, intent.orgId, intent.projectId, intent.actorUserId, intent.actorType,
			intent.action, intent.targetType, intent.targetId, metadataBlob(metadata),
			intent.requestId, Date.now(), intent.dedupeKey,
		).run();
		if (Number(result?.meta?.changes ?? 0) !== 1) {
			const prior = intent.requestId && intent.dedupeKey
				? await env.DB.prepare(
					`SELECT id, outcome FROM audit_events
					  WHERE COALESCE(actor_user_id, 'system') = COALESCE(?, 'system')
					    AND request_id = ? AND dedupe_key = ? LIMIT 1`,
				).bind(intent.actorUserId, intent.requestId, intent.dedupeKey).first()
				: null;
			if (prior) throw new AuditReplayError(prior.id, prior.outcome);
			throw new AuditUnavailableError();
		}
		return intent;
	} catch (error) {
		if (error instanceof AuditReplayError) throw error;
		console.error("audit intent write failed:", error?.message ?? error);
		throw new AuditUnavailableError();
	}
}

/**
 * Append this statement to the exact D1 batch that mutates governed state.
 * `committed` is terminal proof the authoritative state transition succeeded;
 * later finalization only enriches it with privacy-safe result metadata.
 */
function auditCommitGuardStatement(env, intent, expectedOutcome) {
	if (!env?.DB || !intent?.id) throw new AuditUnavailableError();
	return env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM audit_events WHERE id = ? AND outcome = ?
			 )`,
		).bind(intent.id, expectedOutcome);
}

/**
 * Transaction postcondition for a governed mutation. The predicate must be a
 * static SELECT authored in this codebase; request values belong in bindings.
 * If it is false, fence_guard's CHECK aborts the entire D1 batch, including
 * both the state write and the audit commit marker.
 */
export function auditInvariantStatement(env, predicateSql, bindings = []) {
	const predicate = String(predicateSql ?? "").trim();
	if (!env?.DB || !/^select\b/i.test(predicate)
		|| /;|--|\/\*/.test(predicate)
		|| !Array.isArray(bindings)) {
		throw new AuditUnavailableError();
	}
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation)
		 SELECT 1 WHERE NOT EXISTS (${predicate})`,
	).bind(...bindings);
}

function auditLifecycleGuardStatements(env, intent) {
	const statements = [];
	if (intent.guardActorUserId && intent.actorType !== "system") {
		statements.push(env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM users u
				 WHERE u.id = ? AND u.status = 'active'
				   AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			 )`,
		).bind(intent.guardActorUserId));
	}
	if (intent.guardOrgId) {
		statements.push(env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM organizations WHERE id = ? AND status = 'active'
			 )`,
		).bind(intent.guardOrgId));
	}
	if (intent.guardProjectId) {
		statements.push(env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM managed_projects WHERE id = ? AND status = 'active'
			 )`,
		).bind(intent.guardProjectId));
	}
	if (intent.guardOrgId && intent.guardProjectId) {
		statements.push(env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
				SELECT 1 FROM managed_projects p
				 WHERE p.id = ? AND p.status = 'active'
				   AND COALESCE(
				     p.organization_id,
				     (SELECT o.id FROM organizations o
				       WHERE o.owner_user_id = p.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1)
				   ) = ?
			 )`,
		).bind(intent.guardProjectId, intent.guardOrgId));
	}
	return statements;
}

function auditCommitMarkerStatement(env, intent, details = {}) {
	return env.DB.prepare(
		`UPDATE audit_events
		    SET org_id = COALESCE(?, org_id),
		        project_id = COALESCE(?, project_id),
		        target_type = COALESCE(?, target_type),
		        target_id = COALESCE(?, target_id),
		        outcome = 'committed', reason = 'awaiting_details'
		  WHERE id = ? AND outcome = 'pending'`,
	).bind(
		details.orgId === undefined ? null : boundedId(details.orgId),
		details.projectId === undefined ? null : boundedId(details.projectId),
		details.targetType === undefined ? null : safeCode(details.targetType),
		details.targetId === undefined ? null : boundedId(details.targetId, 80),
		intent.id,
	);
}

/**
 * The only supported way for a governed mutation to assert success. Both
 * guards and the marker share the transaction with the state statements: a
 * missing/replayed intent or zero-row marker aborts the whole batch.
 */
export async function commitAuditedBatch(env, intent, stateStatements = [], {
	commitDetails = null,
	preconditions = [],
	postconditions = [],
} = {}) {
	if (!Array.isArray(stateStatements) || !Array.isArray(preconditions) || !Array.isArray(postconditions)) {
		throw new AuditUnavailableError();
	}
	const intents = (Array.isArray(intent) ? intent : [intent]).filter(Boolean);
	if (!intents.length) throw new AuditUnavailableError();
	const lifecycleGuards = intents.flatMap((item) => auditLifecycleGuardStatements(env, item));
	const authorizationGuards = intents.flatMap((item) => item.authorizationGuards ?? []);
	const results = await env.DB.batch([
		...intents.map((item) => auditCommitGuardStatement(env, item, "pending")),
		...lifecycleGuards,
		...authorizationGuards,
		...preconditions,
		...stateStatements,
		...postconditions,
		...intents.map((item, index) => auditCommitMarkerStatement(
			env,
			item,
			Array.isArray(commitDetails) ? (commitDetails[index] ?? {}) : (commitDetails ?? {}),
		)),
		...intents.map((item) => auditCommitGuardStatement(env, item, "committed")),
	]);
	// The exact intent object is request-local. Remembering that its atomic
	// marker committed lets the outer runner distinguish an ordinary rejected
	// mutation from a later failure in a multi-step operation (account erasure
	// is the important case). The latter is never reported as a total failure:
	// durable state already changed and must be surfaced as failed_partial.
	for (const item of intents) item.committed = true;
	const stateStart = intents.length + lifecycleGuards.length + authorizationGuards.length + preconditions.length;
	return results.slice(stateStart, stateStart + stateStatements.length);
}

const AUDIT_COMMIT_PROOF = Symbol("itsuki.audit.commit");

export function auditedMutationResult(result, intent) {
	if (!result || typeof result !== "object" || !intent?.id) throw new AuditUnavailableError();
	Object.defineProperty(result, AUDIT_COMMIT_PROOF, {
		value: intent.id,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return result;
}

export async function commitAuditedNoop(env, intent, result = {}) {
	await commitAuditedBatch(env, intent, []);
	return auditedMutationResult(result, intent);
}

/**
 * Governed read/disclosure: no product row is mutated, but a fresh
 * authorization guard and the durable access marker must commit before any
 * sensitive payload is returned. The result is branded for runAuditedMutation.
 */
export async function commitAuditedAccess(env, intent, result = {}) {
	return commitAuditedNoop(env, intent, result);
}

/* Kept internal so application code cannot accidentally treat a DB read as proof. */
function hasAuditCommitProof(result, intent) {
	return Boolean(result && typeof result === "object" && result[AUDIT_COMMIT_PROOF] === intent?.id);
}

/**
 * Apply queued completions in one D1 transaction. A failed event update rolls
 * back the outbox delete, so cron or the request's waitUntil can retry without
 * inventing a second audit event.
 */
export async function drainAuditCompletions(env, { eventId = null, limit = 25 } = {}) {
	if (!env?.DB) return { processed: 0, pending: 0 };
	const capped = Math.max(1, Math.min(100, Number(limit) || 25));
	const query = eventId
		? env.DB.prepare(
			`SELECT event_id FROM audit_event_completions
			  WHERE event_id = ? ORDER BY created_at ASC LIMIT 1`,
		).bind(boundedId(eventId))
		: env.DB.prepare(
			`SELECT event_id FROM audit_event_completions
			  ORDER BY created_at ASC, event_id ASC LIMIT ?`,
		).bind(capped);
	const { results } = await query.all();
	let processed = 0;
	let pending = 0;
	for (const row of results ?? []) {
		try {
			await env.DB.batch([
				env.DB.prepare(
					`UPDATE audit_events
					    SET org_id = COALESCE((SELECT org_id FROM audit_event_completions WHERE event_id = ?), org_id),
					        project_id = COALESCE((SELECT project_id FROM audit_event_completions WHERE event_id = ?), project_id),
					        target_type = COALESCE((SELECT target_type FROM audit_event_completions WHERE event_id = ?), target_type),
					        target_id = COALESCE((SELECT target_id FROM audit_event_completions WHERE event_id = ?), target_id),
					        outcome = (SELECT outcome FROM audit_event_completions WHERE event_id = ?),
					        reason = (SELECT reason FROM audit_event_completions WHERE event_id = ?),
					        metadata_json = COALESCE((SELECT metadata_json FROM audit_event_completions WHERE event_id = ?), metadata_json)
					  WHERE id = ?
					    AND ((outcome = 'pending' AND (SELECT outcome FROM audit_event_completions WHERE event_id = ?) IN ('noop', 'denied', 'conflict', 'failed'))
					      OR (outcome = 'committed' AND (SELECT outcome FROM audit_event_completions WHERE event_id = ?) IN ('ok', 'noop', 'failed', 'failed_partial')))`,
				).bind(
					row.event_id, row.event_id, row.event_id, row.event_id, row.event_id,
					row.event_id, row.event_id, row.event_id, row.event_id, row.event_id,
				),
				env.DB.prepare(
					`DELETE FROM audit_event_completions
					  WHERE event_id = ?
					    AND EXISTS (
					      SELECT 1 FROM audit_events a
					       WHERE a.id = audit_event_completions.event_id
					         AND a.outcome = audit_event_completions.outcome
					    )`,
				).bind(row.event_id),
			]);
			const remains = await env.DB.prepare(
				"SELECT 1 FROM audit_event_completions WHERE event_id = ? LIMIT 1",
			).bind(row.event_id).first();
			if (remains) pending += 1;
			else processed += 1;
		} catch (error) {
			pending += 1;
			console.error("audit completion apply failed:", error?.message ?? error);
		}
	}
	return { processed, pending };
}

/**
 * A request that never reached its atomic state+commit batch is safe to mark
 * abandoned after a conservative lease. This keeps a transient failure while
 * recording a denied/conflicted outcome from wedging transport dedupe forever.
 * Committed rows are never guessed about: they already prove success.
 */
export async function reconcileStaleAuditIntents(env, { now = Date.now(), staleAfterMs = 10 * 60 * 1000, limit = 100 } = {}) {
	if (!env?.DB) return { recovered: 0 };
	const cutoff = Number(now) - Math.max(60_000, Number(staleAfterMs) || 10 * 60 * 1000);
	const capped = Math.max(1, Math.min(500, Number(limit) || 100));
	const result = await env.DB.prepare(
		`UPDATE audit_events
		    SET outcome = 'failed', reason = 'request_abandoned'
		  WHERE id IN (
			SELECT a.id FROM audit_events a
			 WHERE a.outcome = 'pending' AND a.created_at <= ?
			   AND NOT EXISTS (SELECT 1 FROM audit_event_completions c WHERE c.event_id = a.id)
			 ORDER BY a.created_at ASC, a.id ASC LIMIT ?
		  )`,
	).bind(cutoff, capped).run();
	return { recovered: Number(result?.meta?.changes ?? 0) };
}

async function enqueueAuditCompletion(env, intent, final) {
	const normalizedOutcome = auditOutcome(final.outcome);
	let lastError;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await env.DB.prepare(
				`INSERT INTO audit_event_completions
				 (event_id, org_id, project_id, target_type, target_id, outcome, reason, metadata_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(event_id) DO UPDATE SET
				   updated_at = audit_event_completions.updated_at`,
			).bind(
				intent.id,
				final.orgId === undefined ? null : boundedId(final.orgId),
				final.projectId === undefined ? null : boundedId(final.projectId),
				final.targetType === undefined ? null : safeCode(final.targetType),
				final.targetId === undefined ? null : boundedId(final.targetId, 80),
				normalizedOutcome,
				safeCode(final.reason),
				metadataBlob(final.metadata),
				Date.now(),
				Date.now(),
			).run();
			return true;
		} catch (error) {
			lastError = error;
		}
	}
	console.error("audit completion enqueue failed:", lastError?.message ?? lastError);
	return false;
}

/**
 * Finalize exactly the reserved event through a durable content-free outbox.
 * If applying the completion is unavailable, the pending event and exact
 * completion remain visible and scheduled reconciliation can finish it.
 */
export async function finalizeAuditIntent(env, intent, {
	orgId = undefined,
	projectId = undefined,
	targetType = undefined,
	targetId = undefined,
	outcome = "ok",
	reason = null,
	metadata = null,
	waitUntil = null,
} = {}) {
	if (!env?.DB || !intent?.id) return { id: intent?.id ?? null, pending: true };
	const final = { orgId, projectId, targetType, targetId, outcome, reason, metadata };
	const queued = await enqueueAuditCompletion(env, intent, final);
	if (queued) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const drained = await drainAuditCompletions(env, { eventId: intent.id, limit: 1 });
			if (drained.pending === 0) return { id: intent.id, pending: false };
		}
	}
	if (typeof waitUntil === "function") {
		waitUntil((async () => {
			if (!queued && !await enqueueAuditCompletion(env, intent, final)) return;
			await drainAuditCompletions(env, { eventId: intent.id, limit: 1 });
		})());
	}
	return { id: intent.id, pending: true };
}

/** Execute a mutation only after its content-free intent is durable. */
export async function runAuditedMutation(env, details, mutate, finish = null) {
	const intent = await beginAuditIntent(env, details);
	let result;
	try {
		result = await mutate(intent);
		if (!hasAuditCommitProof(result, intent)) throw new AuditUnavailableError();
	} catch (error) {
		await finalizeAuditIntent(env, intent, {
			// A multi-step operation may fail after its authoritative first batch
			// committed. Retrying that as though nothing happened is ambiguous and
			// can double-apply work, so retain the exact partial-success truth.
			outcome: intent.committed ? "failed_partial" : auditErrorOutcome(error),
			reason: safeCode(error?.code, "operation_failed"),
			waitUntil: details?.waitUntil,
		});
		throw error;
	}
	// From this point the same D1 transaction has committed both state and the
	// terminal `committed` truth. Detail enrichment must never turn that success
	// into an applied-but-500 response.
	let final = {};
	try {
		final = typeof finish === "function" ? (finish(result) ?? {}) : {};
		await finalizeAuditIntent(env, intent, {
			outcome: "ok",
			...final,
			waitUntil: details?.waitUntil ?? final.waitUntil,
		});
	} catch (error) {
		console.error("audit success enrichment failed:", error?.message ?? error);
	}
	return result;
}

function encodeCursor(row) {
	if (!row?.id || !Number.isFinite(Number(row.created_at))) return null;
	const raw = JSON.stringify([Number(row.created_at), String(row.id)]);
	let binary = "";
	for (const byte of new TextEncoder().encode(raw)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeAuditCursor(value) {
	if (value === null || value === undefined || value === "") return null;
	// Compatibility with 0039's timestamp-only cursor. New callers always use
	// the stable tuple below; accepting the old form avoids breaking a tab that
	// was open during deployment.
	if (/^\d+$/.test(String(value))) {
		const createdAt = Number(value);
		return Number.isFinite(createdAt) ? { createdAt, id: null } : null;
	}
	try {
		const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
		const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
		const [createdAt, id] = JSON.parse(new TextDecoder().decode(bytes));
		if (!Number.isFinite(Number(createdAt)) || !id) return null;
		return { createdAt: Number(createdAt), id: String(id).slice(0, 100) };
	} catch {
		return null;
	}
}

/** Paginated, scoped, newest first. Actor emails are joined for display only. */
export async function listAuditEvents(env, {
	orgId = null,
	projectId = null,
	action = null,
	limit = 50,
	before = null,
	cursor = null,
	from = null,
	to = null,
} = {}) {
	const clauses = [];
	const binds = [];
	if (projectId) { clauses.push("a.project_id = ?"); binds.push(projectId); }
	else if (orgId) { clauses.push("a.org_id = ?"); binds.push(orgId); }
	else return { events: [], next_cursor: null, next_before: null };
	if (action) { clauses.push("a.action = ?"); binds.push(String(action).slice(0, 60)); }
	const fromAt = from === null || from === undefined || from === "" ? null : Number(from);
	const toAt = to === null || to === undefined || to === "" ? null : Number(to);
	if (fromAt !== null && Number.isFinite(fromAt)) { clauses.push("a.created_at >= ?"); binds.push(fromAt); }
	if (toAt !== null && Number.isFinite(toAt)) { clauses.push("a.created_at <= ?"); binds.push(toAt); }

	const parsedCursor = decodeAuditCursor(cursor ?? before);
	if (parsedCursor?.id) {
		clauses.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
		binds.push(parsedCursor.createdAt, parsedCursor.createdAt, parsedCursor.id);
	} else if (parsedCursor) {
		clauses.push("a.created_at < ?");
		binds.push(parsedCursor.createdAt);
	}
	const capped = Math.max(1, Math.min(200, Number(limit) || 50));
	const { results } = await env.DB.prepare(
		`SELECT a.id, a.org_id, a.project_id, a.actor_user_id, a.actor_type, a.action,
		        a.target_type, a.target_id, a.outcome, a.reason, a.metadata_json, a.request_id, a.created_at,
		        u.email AS actor_email
		   FROM audit_events a
		   LEFT JOIN users u ON u.id = a.actor_user_id
		  WHERE ${clauses.join(" AND ")}
		  ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
	).bind(...binds, capped + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, capped);
	const nextCursor = rows.length > capped ? encodeCursor(page[page.length - 1]) : null;
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
			request_id: row.request_id ?? null,
			created_at: row.created_at,
		})),
		next_cursor: nextCursor,
		// Retained for one deployment as a compatibility hint; tuple-aware clients
		// must use next_cursor so same-millisecond rows cannot be skipped.
		next_before: nextCursor ? page[page.length - 1].created_at : null,
	};
}

function csvCell(value) {
	let text = value === null || value === undefined
		? ""
		: (typeof value === "string" ? value : JSON.stringify(value));
	// Spreadsheet formula injection is an export concern even for an internal
	// audit log because actor emails and ids are not application constants.
	if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return `"${text.replace(/"/g, '""')}"`;
}

/** Bounded, content-free CSV export using the same stable cursor as the UI. */
export async function exportAuditCsv(env, options = {}) {
	const cap = Math.max(1, Math.min(20_000, Number(options.maxEvents) || 5_000));
	let cursor = null;
	const events = [];
	do {
		const page = await listAuditEvents(env, { ...options, limit: Math.min(200, cap - events.length), cursor });
		events.push(...page.events);
		cursor = page.next_cursor;
	} while (cursor && events.length < cap);
	const header = ["time", "request_id", "action", "actor", "actor_type", "target_type", "target_id", "outcome", "reason", "metadata"];
	const rows = events.map((event) => [
		new Date(Number(event.created_at)).toISOString(),
		event.request_id,
		event.action,
		event.actor,
		event.actor_type,
		event.target_type,
		event.target_id,
		event.outcome,
		event.reason,
		event.metadata,
	].map(csvCell).join(","));
	return {
		csv: `${header.map(csvCell).join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`,
		count: events.length,
		truncated: Boolean(cursor),
	};
}

function safeParse(value) {
	try { return JSON.parse(value); } catch { return null; }
}
