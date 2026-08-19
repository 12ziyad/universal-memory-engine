/**
 * Safe memory updates — canonical revision tracking, immutable bounded
 * history, and rollback for the first-class memory kinds.
 *
 * D1 is the authority. Every accepted update or rollback is ONE atomic D1
 * batch: idempotency claim, fence-guarded CAS on the object row's revision,
 * history append, projection-state reset, and (for managed projects) the
 * audit commit marker with capability + lifecycle + epoch guards. A failed
 * fence aborts the entire batch via fence_guard's CHECK.
 *
 * History rows are customer content: they are erased by single-object
 * permanent deletion, retention, project purge/delete, and account erasure.
 * "Immutable" means the API never rewrites or deletes a revision in place —
 * not that history survives the object's own deletion.
 *
 * Revision semantics: object rows carry `revision`; NULL reads as 1 (the
 * pre-feature captured baseline). System writers that change semantic fields
 * bump it in their own statements (participation), without appending history
 * rows; accumulated system drift is captured lazily as one labeled `system`
 * snapshot the next time an explicit action needs the history chain. Nothing
 * ever invents historical authors or timestamps.
 */

import { CATEGORIES, IMPORTANCE, SLICE_KINDS, getConfig } from "../config.js";
import { refreshManualSearchProfiles } from "../pipeline/manual_search_profiles.js";
import { capabilityGuardStatement } from "./organizations.js";
import { embed } from "./embeddings.js";
import { isHeadVectorId, parseVectorId, upsertNodeVector, vectorIdFor } from "./vectorize.js";

// Re-exported so callers (and tests) have one import surface for the feature.
export { isHeadVectorId, parseVectorId, vectorIdFor };

export const UPDATABLE_KINDS = Object.freeze(["node", "page", "slice", "event"]);

const TABLES = Object.freeze({
	node: "nodes",
	page: "memory_pages",
	slice: "slices",
	event: "events",
});

// Bounds shared with the workspace read surface.
const LABEL_MAX = 200;
const SUMMARY_MAX = 4_000;
const TEXT_MAX = 4_000;
const REASON_MAX = 500;
const MARKDOWN_MAX = 20_000;
const IDEM_MIN = 8;
const IDEM_MAX = 120;
const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 50;
const RESULT_JSON_CAP = 4_000;
const PROJECTION_RETRY_MAX = 3;

/** Editable fields per kind — the frozen support matrix. */
export const EDITABLE_FIELDS = Object.freeze({
	node: Object.freeze(["label", "category", "summary"]),
	page: Object.freeze(["title", "short_summary", "full_markdown"]),
	slice: Object.freeze(["text", "kind"]),
	event: Object.freeze(["text", "importance", "happened_at"]),
});

export class VersionError extends Error {
	constructor(code, message, status = 400, extra = {}) {
		super(message);
		this.name = "VersionError";
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
}

export function versionErrorResponse(error) {
	if (!(error instanceof VersionError) && error?.name !== "VersionError") return null;
	return {
		status: error.status ?? 400,
		body: { error: error.code, code: error.code, message: error.message, ...(error.extra ?? {}) },
	};
}

export function kindFromMemoryId(id) {
	const value = String(id ?? "");
	if (value.startsWith("node_")) return "node";
	if (value.startsWith("page_")) return "page";
	if (value.startsWith("slice_")) return "slice";
	if (value.startsWith("event_")) return "event";
	if (value.startsWith("cand")) return "candidate";
	if (value.startsWith("edge_")) return "edge";
	return null;
}

function assertUpdatableKind(kind) {
	if (kind === null) {
		throw new VersionError("unrecognized_id", "Unrecognized memory id — expected a node_, page_, slice_, or event_ id.", 400);
	}
	if (!UPDATABLE_KINDS.includes(kind)) {
		throw new VersionError("unsupported_kind", `${kind} memories do not support explicit updates.`, 422, { kind });
	}
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                     */

const HEAD_COLUMNS = Object.freeze({
	node: "id, user_id, project_id, project_name, label, category, summary, state, revision, created_at, updated_at, deleted_at, archived_at, suppressed_at",
	page: "id, user_id, project_id, project_name, title, canonical_title, short_summary, full_markdown, revision, created_at, updated_at, deleted_at, archived_at, suppressed_at",
	slice: "id, user_id, project_id, project_name, node_id, text, kind, is_current, revision, created_at, deleted_at",
	event: "id, user_id, project_id, project_name, node_id, text, action, importance, happened_at, happened_at_source, revision, created_at, deleted_at",
});

/**
 * Load one updatable object's head row. Returns null when no live row exists
 * (deleted and never-existed are indistinguishable on purpose). Throws
 * VersionError for unsupported kinds and unsupported states.
 */
export async function readMemoryHead(env, userId, id, { forUpdate = false } = {}) {
	const kind = kindFromMemoryId(id);
	assertUpdatableKind(kind);
	const row = await env.DB.prepare(
		`SELECT ${HEAD_COLUMNS[kind]} FROM ${TABLES[kind]} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
	).bind(id, userId).first();
	if (!row) return null;
	if (forUpdate) assertWritableHead(kind, row);
	return { kind, row, revision: headRevision(row) };
}

export function headRevision(row) {
	const value = Number(row?.revision);
	return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** Refuse a NEW mutation against a non-writable object state. */
export function assertWritableHead(kind, row) {
	if (row.archived_at != null) {
		throw new VersionError("object_archived", "This memory is archived. Restore it before editing.", 409, { kind });
	}
	if (row.suppressed_at != null) {
		throw new VersionError("unsupported_state", "This memory is suppressed and cannot be edited.", 409, { kind });
	}
	if (kind === "slice" && Number(row.is_current ?? 1) !== 1) {
		throw new VersionError("unsupported_state", "This detail has been superseded. Edit the current detail instead.", 409, { kind });
	}
}

/**
 * Deterministic serialization: keys sorted at every depth so a reordered
 * request body cannot produce a different operation identity.
 */
function canonicalize(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const out = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] === undefined) continue;
		out[key] = canonicalize(value[key]);
	}
	return out;
}

/**
 * The idempotency identity of one update/rollback. Computed only from the
 * NORMALIZED operation, so semantically identical requests (key order,
 * padding, Unicode form) share a fingerprint while any behavior-changing
 * difference — including the reason recorded in history — does not.
 */
export async function operationFingerprint({ userId, kind, id, mode, expectedRevision, fields = null, toRevision = null, reason = null }) {
	return requestHash(canonicalize({
		v: 2,
		userId, kind, id, mode,
		expectedRevision,
		fields: fields ?? null,
		toRevision: toRevision ?? null,
		reason: reason ?? null,
	}));
}

/** The editable-field snapshot for one row, canonical key order. */
export function snapshotFor(kind, row) {
	switch (kind) {
		case "node":
			return { category: row.category ?? null, label: row.label ?? null, summary: row.summary ?? null };
		case "page":
			return { full_markdown: row.full_markdown ?? null, short_summary: row.short_summary ?? null, title: row.title ?? null };
		case "slice":
			return { kind: row.kind ?? null, text: row.text ?? null };
		case "event":
			return { happened_at: row.happened_at ?? null, importance: row.importance ?? null, text: row.text ?? null };
		default:
			throw new VersionError("unsupported_kind", `${kind} memories do not support explicit updates.`, 422);
	}
}

export async function contentHash(snapshot) {
	const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */

function cleanText(value, { field, max, allowEmpty = false, allowNull = false } = {}) {
	if (value === null) {
		if (allowNull) return null;
		throw new VersionError("invalid_content", `${field} must not be null.`, 400, { field });
	}
	if (typeof value !== "string") {
		throw new VersionError("invalid_content", `${field} must be a string.`, 400, { field });
	}
	// Normalize to NFC so visually identical edits compare equal; strip
	// control characters except newline/tab which page markdown may carry.
	const normalized = value.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
	const trimmed = normalized.trim();
	if (!trimmed && !allowEmpty) {
		throw new VersionError("invalid_content", `${field} must not be empty.`, 400, { field });
	}
	if (trimmed.length > max) {
		throw new VersionError("invalid_content", `${field} must be at most ${max} characters.`, 400, { field, max });
	}
	return trimmed;
}

/**
 * Validate and normalize a patch for one kind. Unknown fields are refused by
 * name; an empty patch is refused. Returns { fields } with normalized values.
 */
export function validatePatch(kind, patch = {}) {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		throw new VersionError("invalid_content", "The update body must be an object of editable fields.", 400);
	}
	const allowed = EDITABLE_FIELDS[kind] ?? [];
	const keys = Object.keys(patch);
	const unknown = keys.find((key) => !allowed.includes(key));
	if (unknown !== undefined) {
		throw new VersionError("invalid_field", `${unknown} is not an editable field for a ${kind}. Editable: ${allowed.join(", ")}.`, 400, { field: unknown, kind });
	}
	const provided = keys.filter((key) => patch[key] !== undefined);
	if (!provided.length) {
		throw new VersionError("invalid_content", "Provide at least one editable field.", 400);
	}
	const fields = {};
	for (const key of provided) {
		const value = patch[key];
		if (kind === "node") {
			if (key === "label") fields.label = cleanText(value, { field: "label", max: LABEL_MAX });
			else if (key === "summary") fields.summary = cleanText(value, { field: "summary", max: SUMMARY_MAX, allowNull: true });
			else if (key === "category") {
				const category = cleanText(value, { field: "category", max: 40 }).toLowerCase();
				if (!CATEGORIES.includes(category)) {
					throw new VersionError("invalid_content", `category must be one of: ${CATEGORIES.join(", ")}.`, 400, { field: "category" });
				}
				fields.category = category;
			}
		} else if (kind === "page") {
			if (key === "title") fields.title = cleanText(value, { field: "title", max: LABEL_MAX });
			else if (key === "short_summary") fields.short_summary = cleanText(value, { field: "short_summary", max: SUMMARY_MAX, allowNull: true });
			else if (key === "full_markdown") fields.full_markdown = cleanText(value, { field: "full_markdown", max: MARKDOWN_MAX, allowNull: true });
		} else if (kind === "slice") {
			if (key === "text") fields.text = cleanText(value, { field: "text", max: TEXT_MAX });
			else if (key === "kind") {
				const sliceKind = cleanText(value, { field: "kind", max: 40 }).toLowerCase();
				if (!SLICE_KINDS.includes(sliceKind)) {
					throw new VersionError("invalid_content", `kind must be one of: ${SLICE_KINDS.join(", ")}.`, 400, { field: "kind" });
				}
				fields.kind = sliceKind;
			}
		} else if (kind === "event") {
			if (key === "text") fields.text = cleanText(value, { field: "text", max: TEXT_MAX });
			else if (key === "importance") {
				const importance = cleanText(value, { field: "importance", max: 40 }).toLowerCase();
				if (!IMPORTANCE.includes(importance)) {
					throw new VersionError("invalid_content", `importance must be one of: ${IMPORTANCE.join(", ")}.`, 400, { field: "importance" });
				}
				fields.importance = importance;
			} else if (key === "happened_at") {
				const at = Number(value);
				// 1900-01-01 .. now + 100y: wide but sane; a NaN or absurd value is
				// an integration bug, not a legitimate date.
				if (!Number.isSafeInteger(at) || at < -2208988800000 || at > Date.now() + 3_153_600_000_000) {
					throw new VersionError("invalid_content", "happened_at must be a unix-milliseconds timestamp.", 400, { field: "happened_at" });
				}
				fields.happened_at = at;
			}
		}
	}
	return { fields };
}

export function validateReason(reason) {
	if (reason === undefined || reason === null || reason === "") return null;
	return cleanText(reason, { field: "reason", max: REASON_MAX });
}

export function validateIdempotencyKey(key) {
	if (typeof key !== "string" || key.trim().length < IDEM_MIN || key.length > IDEM_MAX) {
		throw new VersionError("invalid_idempotency_key", `An idempotencyKey of ${IDEM_MIN}-${IDEM_MAX} characters is required.`, 400);
	}
	return key.trim();
}

/* ------------------------------------------------------------------------- */
/* Fences                                                                    */

function fence(env, predicateSql, bindings) {
	return env.DB.prepare(
		`INSERT INTO fence_guard (violation) SELECT 1 WHERE NOT EXISTS (${predicateSql})`,
	).bind(...bindings);
}

function revisionFence(env, kind, id, userId, expectedRevision) {
	const table = TABLES[kind];
	const stateClause = kind === "node" || kind === "page"
		? "AND archived_at IS NULL AND suppressed_at IS NULL"
		: kind === "slice" ? "AND is_current = 1" : "";
	return fence(env,
		`SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL ${stateClause} AND COALESCE(revision, 1) = ?`,
		[id, userId, expectedRevision]);
}

function deletionBarrierFence(env, userId, sinceMs) {
	// A barrier newer than our read means a converge-erase is in flight for
	// this space; no new content may land behind it.
	return fence(env,
		"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ?)",
		[userId, sinceMs]);
}

function projectEpochFence(env, projectId, expectedEpoch) {
	return fence(env,
		"SELECT 1 FROM managed_projects WHERE id = ? AND status = 'active' AND COALESCE(lifecycle_epoch, 0) = ?",
		[projectId, expectedEpoch]);
}

/* ------------------------------------------------------------------------- */
/* History plumbing                                                          */

function newRevisionId() {
	return `mrev_${crypto.randomUUID()}`;
}

function historyInsert(env, {
	userId, projectId, kind, id, revision, parentRevision, action, snapshotJson,
	hash, actorClass, actorRef, idempotencyHash, rollbackOf, reason, lifecycleEpoch, createdAt,
}) {
	return env.DB.prepare(
		`INSERT INTO memory_revisions
			(id, user_id, project_id, object_kind, object_id, revision, parent_revision, action,
			 snapshot_json, content_hash, actor_class, actor_ref, idempotency_hash, rollback_of,
			 reason, lifecycle_epoch, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		newRevisionId(), userId, projectId ?? null, kind, id, revision, parentRevision ?? null, action,
		snapshotJson, hash, actorClass, actorRef ?? null, idempotencyHash ?? null, rollbackOf ?? null,
		reason ?? null, lifecycleEpoch ?? null, createdAt,
	);
}

async function lastRecordedRevision(env, userId, kind, id) {
	const row = await env.DB.prepare(
		"SELECT MAX(revision) AS max_revision FROM memory_revisions WHERE user_id = ? AND object_kind = ? AND object_id = ?",
	).bind(userId, kind, id).first();
	const value = Number(row?.max_revision);
	return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function requestHash(payload) {
	const canonical = JSON.stringify(payload);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read a stored idempotency claim after a batch aborted on its PK. */
async function readClaim(env, userId, idemKey) {
	return env.DB.prepare(
		"SELECT request_hash, object_id, action, result_revision, result_json FROM memory_update_idempotency WHERE user_id = ? AND idem_key = ?",
	).bind(userId, idemKey).first();
}

function claimReplayResult(claim, expectedHash) {
	if (!claim) return null;
	if (claim.request_hash !== expectedHash) {
		throw new VersionError("idempotency_conflict",
			"That idempotency key is already bound to a different operation.", 409, { idempotency_key_reused: true });
	}
	try {
		return { replayed: true, ...(claim.result_json ? JSON.parse(claim.result_json) : { revision: claim.result_revision }) };
	} catch {
		return { replayed: true, revision: claim.result_revision };
	}
}

function classifyBatchError(error) {
	const message = String(error?.message ?? error ?? "");
	if (/fence_guard/i.test(message) || /constraint failed: fence_guard/i.test(message)) return "fence";
	if (/memory_update_idempotency/i.test(message)) return "idempotency";
	if (/idx_memory_revisions_object_rev|memory_revisions/i.test(message)) return "revision_race";
	return "unknown";
}

/* ------------------------------------------------------------------------- */
/* Update / rollback                                                         */

/**
 * Apply one explicit update or rollback as a single atomic batch. `mode` is
 * "update" (patch fields) or "rollback" (restore snapshot of `toRevision`).
 *
 * The caller resolves auth/scope/capability freshly; this function re-fences
 * project lifecycle state + epoch, deletion barriers, and the exact expected
 * revision INSIDE the committing batch, so nothing between read and commit
 * can be lost silently.
 */
export async function applyMemoryChange(env, ctx, {
	userId,
	project = null,               // { id } of the managed project, or null
	actor = null,                 // { userId, type, capability, orgId } — commit-time authz identity
	actorClass,                   // "user" | "token"
	actorRef = null,              // session user id / token id — never a secret
	id,
	mode,                         // "update" | "rollback"
	patch = null,
	toRevision = null,
	reason = null,
	idempotencyKey,
	expectedRevision,             // integer, required
	auditIntent = null,
}) {
	const idemKey = validateIdempotencyKey(idempotencyKey);
	const cleanReason = validateReason(reason);
	// Non-mutating outcomes (replay) still need the audit intent resolved with
	// a committed marker, or runAuditedMutation refuses them.
	const settle = async (result) => {
		if (!auditIntent) return result;
		const { commitAuditedNoop } = await import("./audit.js");
		return commitAuditedNoop(env, auditIntent, result);
	};

	// 1. Load the head WITHOUT asserting writability yet: a genuine replay of a
	//    prior success must still answer even if the object has since been
	//    archived. A missing object is 404 — claims are erased with their
	//    object, so no replay can resurrect erased content.
	const head = await readMemoryHead(env, userId, id);
	if (!head) throw new VersionError("not_found", "No memory with that id.", 404);
	const { kind, row } = head;
	const currentRevision = head.revision;

	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
		throw new VersionError("precondition_required",
			"Updates require the current revision (If-Match: \"r<revision>\" or expectedRevision).", 428);
	}

	// 2. Normalize BEFORE fingerprinting so semantically identical requests
	//    (reordered keys, padding, Unicode forms) share one operation identity.
	let normalizedFields = null;
	let normalizedToRevision = null;
	if (mode === "rollback") {
		if (!Number.isSafeInteger(toRevision) || toRevision < 1) {
			throw new VersionError("invalid_content", "toRevision must be a positive integer.", 400);
		}
		normalizedToRevision = toRevision;
	} else {
		normalizedFields = validatePatch(kind, patch).fields;
	}

	// 3. The fingerprint covers the COMPLETE normalized operation: tenant,
	//    object identity and kind, action, precondition, payload, and reason.
	const opHash = await operationFingerprint({
		userId, kind, id, mode,
		expectedRevision,
		fields: normalizedFields,
		toRevision: normalizedToRevision,
		reason: cleanReason,
	});

	// 4. Replay/conflict decision comes before every mutable gate.
	const priorClaim = await readClaim(env, userId, idemKey);
	if (priorClaim) {
		const replay = claimReplayResult(priorClaim, opHash);
		if (replay) return settle(replay);
	}

	// 5. Only now enforce writability — a NEW operation against an archived or
	//    superseded object is refused rather than silently claimed.
	assertWritableHead(kind, row);

	if (expectedRevision !== currentRevision) {
		throw new VersionError("stale_revision",
			"The memory changed since you read it. Reload, review, and retry with the new revision.",
			412, { current_revision: currentRevision, expected_revision: expectedRevision });
	}

	const currentSnapshot = snapshotFor(kind, row);
	let nextSnapshot;
	let rollbackOf = null;
	if (mode === "rollback") {
		if (normalizedToRevision === currentRevision) {
			throw new VersionError("invalid_content", "That is already the current revision.", 400, { current_revision: currentRevision });
		}
		const source = await env.DB.prepare(
			"SELECT snapshot_json FROM memory_revisions WHERE user_id = ? AND object_kind = ? AND object_id = ? AND revision = ?",
		).bind(userId, kind, id, normalizedToRevision).first();
		if (!source) {
			throw new VersionError("revision_unavailable",
				"That revision is not available to restore (never recorded, or removed by deletion/retention).",
				404, { revision: normalizedToRevision });
		}
		nextSnapshot = { ...currentSnapshot, ...JSON.parse(source.snapshot_json) };
		rollbackOf = normalizedToRevision;
	} else {
		nextSnapshot = { ...currentSnapshot, ...normalizedFields };
	}

	const changed = Object.keys(nextSnapshot).some((key) => nextSnapshot[key] !== currentSnapshot[key]);
	const now = Date.now();

	// Capture the project's lifecycle epoch at acceptance; the commit batch
	// re-fences on this exact value so an archive→restore between read and
	// commit (a fresh epoch) refuses the write instead of landing behind it.
	let lifecycleEpoch = null;
	let orgId = actor?.orgId ?? null;
	if (project?.id) {
		const projectRow = await env.DB.prepare(
			`SELECT status, COALESCE(lifecycle_epoch, 0) AS lifecycle_epoch,
				COALESCE(organization_id,
					(SELECT id FROM organizations WHERE owner_user_id = managed_projects.owner_user_id AND status = 'active' LIMIT 1)
				) AS org_id
			 FROM managed_projects WHERE id = ?`,
		).bind(project.id).first();
		if (!projectRow || projectRow.status !== "active") {
			throw new VersionError("project_archived",
				"This project is not active. Restore it before editing memories.", 409);
		}
		lifecycleEpoch = Number(projectRow.lifecycle_epoch ?? 0);
		orgId = orgId ?? projectRow.org_id ?? null;
	}

	const newRevision = currentRevision + 1;
	const result = changed
		? {
			ok: true, id, kind, action: mode,
			revision: newRevision, previous_revision: currentRevision,
			...(rollbackOf ? { rolled_back_to: rollbackOf } : {}),
			projections: { search: "pending", ...(kind === "node" ? { vector: "pending" } : {}) },
		}
		: { ok: true, noop: true, id, kind, revision: currentRevision, action: mode };

	// 6. ONE guarded transaction: claim, every fence, and (when the operation
	//    changes anything) the head write, history, and projection reset. The
	//    no-op path takes the same fences — it may not silently claim a key
	//    against a stale revision, a revoked role, or a purging project.
	const statements = [];
	statements.push(env.DB.prepare(
		`INSERT INTO memory_update_idempotency (user_id, idem_key, request_hash, object_id, action, result_revision, result_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(userId, idemKey, opHash, id, mode,
		changed ? newRevision : currentRevision,
		JSON.stringify(result).slice(0, RESULT_JSON_CAP), now));
	statements.push(revisionFence(env, kind, id, userId, currentRevision));
	statements.push(deletionBarrierFence(env, userId, now));
	if (project?.id) statements.push(projectEpochFence(env, project.id, lifecycleEpoch));
	// Commit-time authorization: a downgrade, revocation, ownership change, or
	// account erasure between preflight and commit aborts the whole batch. This
	// runs on EVERY door (REST and MCP), not only audited ones.
	const capabilityGuard = buildCapabilityGuard(env, { actor, orgId, projectId: project?.id ?? null, now });
	if (capabilityGuard) statements.push(capabilityGuard);

	if (changed) {
		const historyRows = [];
		const lastRecorded = await lastRecordedRevision(env, userId, kind, id);
		if (lastRecorded == null) {
			historyRows.push({
				revision: currentRevision, parentRevision: null, action: "baseline",
				snapshot: currentSnapshot, actorClass: "system", actorRef: null,
			});
		} else if (lastRecorded < currentRevision) {
			historyRows.push({
				revision: currentRevision, parentRevision: lastRecorded, action: "system",
				snapshot: currentSnapshot, actorClass: "system", actorRef: null,
			});
		} else if (lastRecorded > currentRevision) {
			throw new VersionError("stale_revision",
				"The memory changed since you read it. Reload, review, and retry with the new revision.",
				412, { current_revision: lastRecorded });
		}
		historyRows.push({
			revision: newRevision, parentRevision: currentRevision, action: mode === "rollback" ? "rollback" : "update",
			snapshot: nextSnapshot, actorClass, actorRef, rollbackOf, reason: cleanReason,
		});

		statements.push(buildHeadUpdate(env, kind, id, userId, currentRevision, newRevision, nextSnapshot, now));
		const idemHashShort = opHash.slice(0, 32);
		for (const entry of historyRows) {
			statements.push(historyInsert(env, {
				userId, projectId: row.project_id ?? null, kind, id,
				revision: entry.revision, parentRevision: entry.parentRevision, action: entry.action,
				snapshotJson: JSON.stringify(entry.snapshot), hash: await contentHash(entry.snapshot),
				actorClass: entry.actorClass, actorRef: entry.actorRef,
				idempotencyHash: entry.action === "update" || entry.action === "rollback" ? idemHashShort : null,
				rollbackOf: entry.rollbackOf ?? null, reason: entry.reason ?? null,
				lifecycleEpoch, createdAt: now,
			}));
		}
		for (const projection of ["search", ...(kind === "node" ? ["vector"] : [])]) {
			statements.push(env.DB.prepare(
				`INSERT INTO memory_projection_state (user_id, object_id, projection, applied_revision, status, attempts, updated_at)
				 VALUES (?, ?, ?, NULL, 'pending', 0, ?)
				 ON CONFLICT(user_id, object_id, projection) DO UPDATE SET
				   status = 'pending', applied_revision = NULL, attempts = 0, updated_at = excluded.updated_at`,
			).bind(userId, id, projection, now));
		}
	}

	try {
		if (auditIntent) {
			const { commitAuditedBatch, auditedMutationResult } = await import("./audit.js");
			await commitAuditedBatch(env, auditIntent, statements);
			auditedMutationResult(result, auditIntent);
		} else {
			await env.DB.batch(statements);
		}
	} catch (error) {
		const cause = classifyBatchError(error);
		if (cause === "idempotency") {
			const claim = await readClaim(env, userId, idemKey);
			const replay = claimReplayResult(claim, opHash);
			if (replay) return settle(replay);
		}
		if (cause === "fence" || cause === "revision_race") {
			// Distinguish an authorization loss from a concurrency loss so the
			// caller gets a truthful code rather than a generic conflict.
			if (capabilityGuard && !(await actorStillAuthorized(env, { actor, orgId, projectId: project?.id ?? null }))) {
				throw new VersionError("forbidden",
					"Your permission for this project changed before the update committed.", 403,
					{ capability: actor?.capability ?? null });
			}
			const fresh = await readMemoryHead(env, userId, id).catch(() => null);
			if (!fresh) throw new VersionError("not_found", "No memory with that id.", 404);
			if (fresh.revision !== currentRevision) {
				throw new VersionError("stale_revision",
					"The memory changed while your update was committing. Reload and retry.",
					412, { current_revision: fresh.revision });
			}
			throw new VersionError("project_state_changed",
				"The project or memory space state changed while your update was committing. Reload and retry.", 409);
		}
		throw error;
	}

	if (changed) {
		const run = runProjections(env, userId, kind, id);
		if (ctx?.waitUntil) ctx.waitUntil(run); else await run.catch(() => {});
	}
	return result;
}

/**
 * Commit-time authorization fence. Returns null only for the legacy operator
 * door (no managed project, no actor identity), which keeps its historical
 * owner-scoped boundary.
 */
function buildCapabilityGuard(env, { actor, orgId, projectId, now }) {
	if (!actor?.userId || !actor?.capability || !orgId) return null;
	return capabilityGuardStatement(env, {
		actorUserId: actor.userId,
		orgId,
		projectId,
		capability: actor.capability,
		now,
	});
}

/** Re-evaluate the same predicate as a read, to explain a fence abort. */
async function actorStillAuthorized(env, { actor, orgId, projectId }) {
	if (!actor?.userId || !orgId) return true;
	try {
		const { can } = await import("./organizations.js");
		const row = await env.DB.prepare(
			`SELECT
				(SELECT om.role FROM organization_members om WHERE om.org_id = ? AND om.user_id = ? LIMIT 1) AS org_role,
				(SELECT pm.role FROM project_members pm WHERE pm.project_id = ? AND pm.user_id = ? LIMIT 1) AS project_role`,
		).bind(orgId, actor.userId, projectId ?? "", actor.userId).first();
		return can(actor.capability, { orgRole: row?.org_role ?? null, projectRole: row?.project_role ?? null });
	} catch {
		return true;
	}
}

function buildHeadUpdate(env, kind, id, userId, expectedRevision, newRevision, snapshot, now) {
	const table = TABLES[kind];
	if (kind === "node") {
		return env.DB.prepare(
			`UPDATE ${table} SET label = ?, category = ?, summary = ?, revision = ?, updated_at = ?
			 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND COALESCE(revision, 1) = ?`,
		).bind(snapshot.label, snapshot.category, snapshot.summary, newRevision, now, id, userId, expectedRevision);
	}
	if (kind === "page") {
		return env.DB.prepare(
			`UPDATE ${table} SET title = ?, short_summary = ?, full_markdown = ?, revision = ?, updated_at = ?
			 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND COALESCE(revision, 1) = ?`,
		).bind(snapshot.title, snapshot.short_summary, snapshot.full_markdown, newRevision, now, id, userId, expectedRevision);
	}
	if (kind === "slice") {
		return env.DB.prepare(
			`UPDATE ${table} SET text = ?, kind = ?, revision = ?, last_seen_at = ?
			 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_current = 1 AND COALESCE(revision, 1) = ?`,
		).bind(snapshot.text, snapshot.kind, newRevision, now, id, userId, expectedRevision);
	}
	// event — an edited date is the user's assertion; record its provenance.
	return env.DB.prepare(
		`UPDATE ${table} SET text = ?, importance = ?, happened_at = ?, happened_at_source = 'user', revision = ?, last_seen_at = ?
		 WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND COALESCE(revision, 1) = ?`,
	).bind(snapshot.text, snapshot.importance, snapshot.happened_at, newRevision, now, id, userId, expectedRevision);
}

/* ------------------------------------------------------------------------- */
/* Projections                                                               */

/* ---------------------------------------------------------------------------
 * Projections.
 *
 * Vectorize writes are ASYNCHRONOUS: `upsert` returns a mutation id and an
 * internal job later makes the vector queryable (Cloudflare's own docs say
 * changes hit a write-ahead log first). An accepted upsert is therefore NOT
 * proof that recall can see the vector, so this layer never marks a vector
 * ready on enqueue.
 *
 * Ordering safety comes from revision-qualified vector ids: revision N of a
 * node is stored as `<nodeId>#r<N>`. A delayed writer can only ever create or
 * overwrite ITS OWN revision's id, so a late r2 write cannot clobber r3, and
 * cleanup deletes only strictly-older revision ids. Recall maps a hit back to
 * its node and drops any hit whose revision is not the current head, so a
 * stale vector can never outrank or resurrect stale content. Legacy unversioned
 * ids (written before this change) are accepted as head, since that is exactly
 * what they were under the previous scheme.
 */

/**
 * Record a projection outcome, but only if it is still the truth: the object's
 * canonical head must still be the revision this worker applied, and we never
 * move applied_revision backwards. A stale worker therefore cannot mark a newer
 * head ready.
 */
export async function markProjectionApplied(env, userId, objectId, projection, { appliedRevision, status }) {
	const kind = kindFromMemoryId(objectId);
	if (!UPDATABLE_KINDS.includes(kind)) return { applied: false };
	const table = TABLES[kind];
	const result = await env.DB.prepare(
		`UPDATE memory_projection_state
		 SET status = ?, applied_revision = ?, attempts = attempts + 1, updated_at = ?
		 WHERE user_id = ? AND object_id = ? AND projection = ?
		   AND COALESCE(applied_revision, 0) <= ?
		   AND EXISTS (
		     SELECT 1 FROM ${table}
		      WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND COALESCE(revision, 1) = ?
		   )`,
	).bind(
		status, appliedRevision, Date.now(),
		userId, objectId, projection,
		appliedRevision,
		objectId, userId, appliedRevision,
	).run();
	return { applied: (result.meta?.changes ?? 0) > 0 };
}

/** Record a terminal failure without claiming any applied revision. */
async function markProjectionFailed(env, userId, objectId, projection) {
	await env.DB.prepare(
		`UPDATE memory_projection_state
		 SET status = 'failed', attempts = attempts + 1, updated_at = ?
		 WHERE user_id = ? AND object_id = ? AND projection = ?`,
	).bind(Date.now(), userId, objectId, projection).run().catch(() => {});
}

/**
 * Recompute derived projections from the CURRENT canonical row.
 *
 * search: D1-local, so success is provable in-request → ready (CAS-guarded).
 * vector: enqueued to an asynchronous provider → `submitted`, promoted to
 * `ready` only after a readback proves the current revision's vector exists.
 * Any provider or FTS failure is recorded as `failed`; neither ever reports
 * ready on an unverified write.
 */
export async function runProjections(env, userId, kind, id, { attempts = PROJECTION_RETRY_MAX } = {}) {
	const config = getConfig(env);
	for (let attempt = 0; attempt < attempts; attempt++) {
		const head = await env.DB.prepare(
			`SELECT ${HEAD_COLUMNS[kind]} FROM ${TABLES[kind]} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!head) {
			// The object was deleted mid-flight. Its projection rows die with it
			// in the deletion batch; drop any stale vectors we may have written.
			await purgeObjectVectors(env, config, userId, id).catch(() => {});
			return;
		}
		const revision = headRevision(head);

		// ---- search (FTS profile) -------------------------------------------
		const nodeIds = kind === "node" ? [id] : (kind === "slice" || kind === "event") && head.node_id ? [head.node_id] : [];
		const pageIds = kind === "page" ? [id] : [];
		try {
			const refreshed = await refreshManualSearchProfiles(env, config, userId, { nodeIds, pageIds });
			if (refreshed?.warnings?.length) throw new Error(refreshed.warnings[0]);
			await markProjectionApplied(env, userId, id, "search", { appliedRevision: revision, status: "ready" });
		} catch (error) {
			console.warn("memory search projection failed:", error?.message ?? error);
			await markProjectionFailed(env, userId, id, "search");
		}

		// ---- vector (asynchronous provider) ---------------------------------
		if (kind === "node") {
			try {
				const embedText = [head.label, head.summary].filter(Boolean).join(" — ").slice(0, 2_000);
				const values = await embed(env, config, embedText);
				const vectorId = vectorIdFor(id, revision);
				const submitted = await upsertNodeVector(env, config, {
					userId, vectorId, nodeId: id, revision, values,
					label: head.label, category: head.category,
				});
				if (!submitted.ok) {
					if (submitted.reason === "vectors_disabled") {
						// Vectors are switched off for this deployment: there is nothing
						// to converge, so the projection is trivially satisfied.
						await markProjectionApplied(env, userId, id, "vector", { appliedRevision: revision, status: "ready" });
					} else {
						// No embedding, or the provider refused: either way this revision
						// is NOT searchable by vector and must never be reported ready.
						await markProjectionFailed(env, userId, id, "vector");
					}
				} else {
					await markProjectionApplied(env, userId, id, "vector", { appliedRevision: revision, status: "submitted" });
					// Readback: only a provider-visible vector earns `ready`.
					const visible = await vectorVisible(env, config, vectorId);
					if (visible) {
						await markProjectionApplied(env, userId, id, "vector", { appliedRevision: revision, status: "ready" });
						await purgeObjectVectors(env, config, userId, id, { keepRevision: revision }).catch(() => {});
					}
					// Not yet visible: stays `submitted` for the sweep. Never ready.
				}
			} catch (error) {
				console.warn("memory vector projection failed:", error?.message ?? error);
				await markProjectionFailed(env, userId, id, "vector");
			}
		}

		// If the head advanced while we worked, recompute from the new truth.
		const after = await env.DB.prepare(
			`SELECT COALESCE(revision, 1) AS revision FROM ${TABLES[kind]} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!after || Number(after.revision) === revision) return;
	}
}

/** Provider readback. A throw or an empty result is "not visible", never ready. */
async function vectorVisible(env, config, vectorId) {
	if (!config.useVectors || !env.VECTORIZE || typeof env.VECTORIZE.getByIds !== "function") return false;
	try {
		const found = await env.VECTORIZE.getByIds([vectorId]);
		return Array.isArray(found) ? found.some((entry) => entry?.id === vectorId) : Boolean(found);
	} catch (error) {
		console.warn("vectorize readback failed:", error?.message ?? error);
		return false;
	}
}

/**
 * Remove this object's vectors, optionally keeping one revision. Only ids that
 * belong to the object are ever named, so a delayed write for another object
 * (or the current head) can never be deleted by mistake.
 */
async function purgeObjectVectors(env, config, userId, objectId, { keepRevision = null } = {}) {
	if (!config.useVectors || !env.VECTORIZE) return;
	const { results } = await env.DB.prepare(
		"SELECT applied_revision FROM memory_projection_state WHERE user_id = ? AND object_id = ? AND projection = 'vector'",
	).bind(userId, objectId).all().catch(() => ({ results: [] }));
	const known = new Set();
	for (const row of results ?? []) {
		const revision = Number(row.applied_revision);
		if (Number.isSafeInteger(revision) && revision >= 1) known.add(revision);
	}
	const highest = keepRevision ?? Math.max(0, ...known);
	const ids = [];
	// Bounded sweep of prior revisions plus the legacy unversioned id.
	for (let revision = Math.max(1, highest - 20); revision < highest; revision++) ids.push(vectorIdFor(objectId, revision));
	if (keepRevision == null) ids.push(vectorIdFor(objectId, highest));
	ids.push(objectId);
	if (!ids.length) return;
	try {
		await env.VECTORIZE.deleteByIds(ids);
	} catch (error) {
		console.warn("vectorize stale cleanup failed:", error?.message ?? error);
	}
}

/**
 * Cron sweep: retry pending/failed projections and finish `submitted` vectors
 * whose provider write has since become visible.
 */
export async function sweepPendingProjections(env, { limit = 25 } = {}) {
	const { results } = await env.DB.prepare(
		`SELECT user_id, object_id, projection, applied_revision, status FROM memory_projection_state
		 WHERE status IN ('pending', 'failed', 'submitted') ORDER BY updated_at ASC LIMIT ?`,
	).bind(limit).all();
	const config = getConfig(env);
	const seen = new Set();
	let promoted = 0;
	for (const row of results ?? []) {
		const kind = kindFromMemoryId(row.object_id);
		if (!UPDATABLE_KINDS.includes(kind)) {
			await env.DB.prepare(
				"DELETE FROM memory_projection_state WHERE user_id = ? AND object_id = ?",
			).bind(row.user_id, row.object_id).run();
			continue;
		}
		// A submitted vector only needs a readback, not a re-embed.
		if (row.projection === "vector" && row.status === "submitted" && row.applied_revision) {
			const vectorId = vectorIdFor(row.object_id, row.applied_revision);
			if (await vectorVisible(env, config, vectorId)) {
				const marked = await markProjectionApplied(env, row.user_id, row.object_id, "vector", {
					appliedRevision: row.applied_revision, status: "ready",
				});
				if (marked.applied) {
					promoted += 1;
					await purgeObjectVectors(env, config, row.user_id, row.object_id, { keepRevision: row.applied_revision }).catch(() => {});
					continue;
				}
			}
		}
		const key = `${row.user_id}:${row.object_id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		await runProjections(env, row.user_id, kind, row.object_id, { attempts: 1 });
	}
	return { swept: seen.size, promoted };
}

/* ------------------------------------------------------------------------- */
/* History reads                                                             */

export async function listMemoryHistory(env, userId, id, { cursor = null, limit = HISTORY_LIMIT_DEFAULT } = {}) {
	const kind = kindFromMemoryId(id);
	assertUpdatableKind(kind);
	const head = await readMemoryHead(env, userId, id);
	if (!head) throw new VersionError("not_found", "No memory with that id.", 404);
	const boundedLimit = Math.min(Math.max(Number(limit) || HISTORY_LIMIT_DEFAULT, 1), HISTORY_LIMIT_MAX);
	let beforeRevision = null;
	if (cursor != null && cursor !== "") {
		beforeRevision = Number(cursor);
		if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1) {
			throw new VersionError("invalid_cursor", "cursor is not a valid history cursor.", 400);
		}
	}
	const { results } = await env.DB.prepare(
		`SELECT revision, parent_revision, action, snapshot_json, content_hash, actor_class,
			rollback_of, reason, created_at
		 FROM memory_revisions
		 WHERE user_id = ? AND object_kind = ? AND object_id = ? ${beforeRevision ? "AND revision < ?" : ""}
		 ORDER BY revision DESC LIMIT ?`,
	).bind(...(beforeRevision
		? [userId, head.kind, id, beforeRevision, boundedLimit + 1]
		: [userId, head.kind, id, boundedLimit + 1])).all();
	const rows = results ?? [];
	const pageRows = rows.slice(0, boundedLimit);
	const [projections, totals] = await env.DB.batch([
		env.DB.prepare(
			"SELECT projection, applied_revision, status FROM memory_projection_state WHERE user_id = ? AND object_id = ?",
		).bind(userId, id),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_revisions WHERE user_id = ? AND object_kind = ? AND object_id = ?",
		).bind(userId, head.kind, id),
	]);
	return {
		id, kind: head.kind, current_revision: head.revision,
		// RETENTION TRUTH: page size is bounded, stored history is NOT pruned.
		// Every recorded revision is retained until the object itself is
		// deleted, purged, retention-expired, or the account is erased — so a
		// revision offered as rollbackable stays rollbackable. This count makes
		// the resulting storage growth visible rather than implied.
		total_revisions: Number(totals.results?.[0]?.n ?? 0),
		retention: "retained_until_object_deleted",
		revisions: pageRows.map((row) => ({
			revision: row.revision,
			parent_revision: row.parent_revision ?? null,
			action: row.action,
			snapshot: JSON.parse(row.snapshot_json),
			content_hash: row.content_hash,
			actor: row.actor_class,
			...(row.rollback_of ? { rollback_of: row.rollback_of } : {}),
			...(row.reason ? { reason: row.reason } : {}),
			created_at: row.created_at,
			...(row.action === "baseline" || row.action === "system" ? { captured: true } : {}),
		})),
		projections: Object.fromEntries((projections.results ?? []).map((p) => [p.projection, { status: p.status, applied_revision: p.applied_revision }])),
		next_cursor: rows.length > boundedLimit ? String(pageRows.at(-1).revision) : null,
	};
}

/* ------------------------------------------------------------------------- */
/* Erasure integration                                                       */

/** Statements removing all update-feature rows for specific objects. */
export function versionResidueStatements(env, userId, objectIds) {
	const ids = objectIds.filter(Boolean);
	if (!ids.length) return [];
	const marks = ids.map(() => "?").join(", ");
	return [
		env.DB.prepare(`DELETE FROM memory_revisions WHERE user_id = ? AND object_id IN (${marks})`).bind(userId, ...ids),
		env.DB.prepare(`DELETE FROM memory_update_idempotency WHERE user_id = ? AND object_id IN (${marks})`).bind(userId, ...ids),
		env.DB.prepare(`DELETE FROM memory_projection_state WHERE user_id = ? AND object_id IN (${marks})`).bind(userId, ...ids),
	];
}

/**
 * Every table this feature writes that carries customer content or references
 * a memory object. Deletion paths and the residual scan both read this list so
 * a future table cannot silently escape erasure.
 */
export const VERSION_RESIDUE_TABLES = Object.freeze([
	"memory_revisions",
	"memory_update_idempotency",
	"memory_projection_state",
]);

/** Bounded revision history for one object, oldest-first, for exports. */
export async function exportRevisionsFor(env, userId, kind, objectId, { limit = 200 } = {}) {
	const { results } = await env.DB.prepare(
		`SELECT revision, parent_revision, action, snapshot_json, content_hash, actor_class,
			rollback_of, reason, created_at
		 FROM memory_revisions
		 WHERE user_id = ? AND object_kind = ? AND object_id = ?
		 ORDER BY revision ASC LIMIT ?`,
	).bind(userId, kind, objectId, limit).all();
	return (results ?? []).map((row) => ({
		revision: row.revision,
		parent_revision: row.parent_revision ?? null,
		action: row.action,
		snapshot: JSON.parse(row.snapshot_json),
		content_hash: row.content_hash,
		actor: row.actor_class,
		...(row.rollback_of ? { rollback_of: row.rollback_of } : {}),
		...(row.reason ? { reason: row.reason } : {}),
		created_at: row.created_at,
	}));
}

/** Whether the public update doors are enabled ("on") vs track-only. */
export function safeUpdatesEnabled(env) {
	return String(env?.SAFE_MEMORY_UPDATES ?? "").toLowerCase() === "on";
}
