/**
 * Project lifecycle subsystem — archive/restore, project-wide memory purge,
 * permanent project deletion, and ownership transfer.
 *
 * Durable model (managed_projects):
 *   status           — the COARSE fence every deployed writer/DO/resolver
 *                      already enforces ('active' | 'archived'). Every
 *                      lifecycle operation that must stop producers flips
 *                      status to 'archived' FIRST, in a CAS, so all existing
 *                      fence_guard batches and the Durable Object's
 *                      MANAGED_PROJECT_INACTIVE assertion engage unchanged.
 *   lifecycle_state  — the fine state: NULL/'active', 'archiving',
 *                      'archived', 'restoring', 'purging_memory',
 *                      'deleting', 'deleted' (terminal).
 *   lifecycle_epoch  — monotonic generation fence. Every transition CAS-es on
 *                      the previous epoch; every run binds the epoch it
 *                      fenced under and re-checks it before each durable
 *                      side effect. Stale drivers become terminal no-ops.
 *
 * Runs (project_lifecycle_runs) are durable and checkpointed; the partial
 * unique index allows at most one non-terminal run per project. Work is
 * bounded and resumable: the HTTP execute call performs only the fence, the
 * rest is driven in bounded slices by waitUntil and the 5-minute cron.
 *
 * Nothing here ever derives a memory-space id. The inventory is the
 * project_memory_spaces registry cross-checked (fail-closed) against every
 * provenance table by discoverProjectMemorySpaces().
 */

import { newId } from "./ids.js";
import { recordSecurityEvent } from "./security_events.js";
import { writeAudit } from "./audit.js";
import { capabilityGuardStatement, can, resolveMembership } from "./organizations.js";
import { discoverProjectMemorySpaces } from "./retention.js";
import { bulkDeleteBySource } from "../pipeline/cleanup.js";
import {
	assertNoActiveProviderInvocation,
	scrubProviderReservationLifecycle,
} from "../ai/provider_budget.js";
import { ERASED_SOURCE_CONTENT_HASH } from "../pipeline/source.js";
import { PURGE_SPACE_TABLES, residualSpaceCounts, residualTotal } from "./lifecycle_census.js";
import { enqueueMail, memoryPurgedMail, projectDeletedMail } from "./mail.js";

export class LifecycleError extends Error {
	constructor(code, message, status = 400, extra = {}) {
		super(message);
		this.name = "LifecycleError";
		this.code = code;
		this.status = status;
		Object.assign(this, extra);
	}
}

export const LIFECYCLE_ACTIONS = ["memory_purge", "project_delete", "archive", "restore"];
export const ACTIVE_RUN_STATUSES = ["accepted", "running", "verifying", "failed_retryable"];
const RESUMABLE_STATUSES = ["accepted", "running", "verifying"];
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const LIFECYCLE_CONFIRMATION = { memory_purge: "PURGE MEMORY", project_delete: "DELETE PROJECT" };
const MAX_RUN_ATTEMPTS = 500;
const SWEEP_CHUNK = 400;
const VECTOR_CHUNK = 200;

const ACTION_CAPABILITY = {
	memory_purge: "project.memory.delete",
	project_delete: "project.delete",
	archive: "project.archive",
	restore: "project.archive",
};

// Which (status, lifecycle_state) pairs each action may start from. A NULL
// lifecycle_state on an 'active' row is the pre-0045 shape and means 'active';
// NULL on an 'archived' row is a legacy archive and restores like one.
const SOURCE_STATES = {
	memory_purge: [["active", null], ["active", "active"], ["archived", "archived"], ["archived", null]],
	project_delete: [["active", null], ["active", "active"], ["archived", "archived"], ["archived", null]],
	archive: [["active", null], ["active", "active"]],
	restore: [["archived", "archived"], ["archived", null]],
};

async function sha256Hex(value) {
	const bytes = new TextEncoder().encode(String(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The open ownership offer for a project, if there is one. */
async function pendingTransfer(env, projectId) {
	const row = await env.DB.prepare(
		`SELECT t.id, t.to_user_id, t.created_at, t.expires_at, u.email, u.name
		   FROM project_ownership_transfers t LEFT JOIN users u ON u.id = t.to_user_id
		  WHERE t.project_id = ? AND t.status = 'pending'`,
	).bind(projectId).first();
	return row ? {
		id: row.id,
		to: { id: row.to_user_id, email: row.email, name: row.name },
		created_at: Number(row.created_at),
		expires_at: Number(row.expires_at),
	} : null;
}

export async function projectRevision(row) {
	return `prv1.${await sha256Hex(`itsuki:project:revision:v1:${row.id}:${row.created_at}:${row.updated_at}`)}`;
}

function parseJson(value, fallback = {}) {
	try {
		const parsed = JSON.parse(value ?? "null");
		return parsed && typeof parsed === "object" ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function effectiveLifecycleState(row) {
	if (!row) return null;
	if (row.lifecycle_state) return row.lifecycle_state;
	return row.status === "active" ? "active" : "archived";
}

/**
 * Resolve a project for LIFECYCLE surfaces without the status='active'
 * filter every ordinary resolver applies — restore and status must be able
 * to see an archived shell. Access is deliberately administrative: the
 * storage owner, an org owner/admin of the effective organization, or a
 * project admin member. Ordinary members/viewers never see lifecycle state
 * beyond what the normal (active-only) surfaces already show them.
 */
export async function lifecycleProjectForActor(env, actorUserId, projectId) {
	if (typeof projectId !== "string" || !/^proj_[A-Za-z0-9_-]{8,80}$/.test(projectId)) {
		throw new LifecycleError("invalid_project_id", "That project id is not valid.", 400);
	}
	const now = Date.now();
	const row = await env.DB.prepare(
		`SELECT p.*,
		        COALESCE(p.organization_id, (
		          SELECT o.id FROM organizations o
		           WHERE o.owner_user_id = p.owner_user_id
		             AND o.is_default = 1 AND o.status = 'active' LIMIT 1
		        )) AS effective_organization_id
		   FROM managed_projects p
		  WHERE p.id = ? LIMIT 1`,
	).bind(projectId).first();
	if (!row) throw new LifecycleError("project_not_found", "That project does not exist.", 404);
	const orgId = row.effective_organization_id ?? null;
	const [orgMember, projectMember] = await Promise.all([
		orgId
			? env.DB.prepare(
				`SELECT role FROM organization_members
				  WHERE org_id = ? AND user_id = ?
				    AND (role = 'owner' OR access_starts_at IS NULL OR access_starts_at <= ?)
				    AND (role = 'owner' OR access_expires_at IS NULL OR access_expires_at > ?)
				  LIMIT 1`,
			).bind(orgId, actorUserId, now, now).first()
			: null,
		env.DB.prepare(
			`SELECT role FROM project_members
			  WHERE project_id = ? AND user_id = ?
			    AND (access_starts_at IS NULL OR access_starts_at <= ?)
			    AND (access_expires_at IS NULL OR access_expires_at > ?)
			  LIMIT 1`,
		).bind(projectId, actorUserId, now, now).first(),
	]);
	const membership = {
		orgId,
		orgRole: orgMember?.role ?? (row.owner_user_id === actorUserId && !orgId ? "owner" : null),
		projectRole: projectMember?.role ?? null,
	};
	const administrative = row.owner_user_id === actorUserId
		|| ["owner", "admin"].includes(membership.orgRole ?? "")
		|| membership.projectRole === "admin";
	if (!administrative) {
		// Indistinguishable from absent, so lifecycle state is not an oracle.
		throw new LifecycleError("project_not_found", "That project does not exist.", 404);
	}
	return { row, membership, orgId };
}

function assertActionAllowed(action, row, membership) {
	const capability = ACTION_CAPABILITY[action];
	if (!capability || !can(capability, membership)) {
		throw new LifecycleError("forbidden", "You do not have permission for that lifecycle action.", 403, { capability });
	}
	if (Number(row.is_default) === 1 && action !== "memory_purge") {
		throw new LifecycleError(
			"default_project_protected",
			"The default project carries the account's root memory identity and cannot be archived, transferred, or deleted. You can still purge its memory.",
			409,
		);
	}
	const state = effectiveLifecycleState(row);
	if (state === "deleted") {
		throw new LifecycleError("project_deleted", "This project was permanently deleted.", 410);
	}
	const allowed = (SOURCE_STATES[action] ?? []).some(([status, lifecycle]) =>
		row.status === status && ((row.lifecycle_state ?? null) === lifecycle || (lifecycle === null && !row.lifecycle_state)));
	if (!allowed) {
		throw new LifecycleError(
			"lifecycle_conflict",
			`This project is ${state.replace("_", " ")} and cannot start ${action.replace("_", " ")} right now.`,
			409,
			{ state },
		);
	}
}

async function activeRun(env, projectId) {
	return env.DB.prepare(
		`SELECT * FROM project_lifecycle_runs
		  WHERE project_id = ? AND status IN ('accepted','running','verifying','failed_retryable')
		  LIMIT 1`,
	).bind(projectId).first();
}

export function publicLifecycleRun(run) {
	if (!run) return null;
	const inventory = parseJson(run.inventory_json);
	const checkpoint = parseJson(run.checkpoint_json);
	return {
		id: run.id,
		project_id: run.project_id,
		action: run.action,
		status: run.status,
		phase: run.phase,
		lifecycle_epoch: run.lifecycle_epoch,
		attempts: run.attempts,
		error_code: run.error_code ?? null,
		counts: {
			memory_spaces: inventory.spaces ?? checkpoint.spaces?.length ?? null,
			spaces_completed: checkpoint.space_index ?? null,
			...(inventory.counts ?? {}),
			...(checkpoint.deleted ? { deleted: checkpoint.deleted } : {}),
			...(checkpoint.vectors_deleted != null ? { vectors_deleted: checkpoint.vectors_deleted } : {}),
			...(checkpoint.jobs_cancelled != null ? { jobs_cancelled: checkpoint.jobs_cancelled } : {}),
		},
		inventory_hash: run.inventory_hash ?? null,
		created_at: run.created_at,
		updated_at: run.updated_at,
		completed_at: run.completed_at ?? null,
	};
}

// ————————————————————————————————————————————————————————————— preview ————

async function boundedInventoryCounts(env, spaces) {
	const encoded = JSON.stringify(spaces);
	const count = (table) => env.DB.prepare(
		`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?))`,
	).bind(encoded);
	const [nodes, pages, episodes, packets, jobs, exportsRows, hooks] = await env.DB.batch([
		count("nodes"), count("memory_pages"), count("source_episodes"), count("source_packets"),
		env.DB.prepare(
			`SELECT COUNT(*) AS n FROM memory_jobs
			  WHERE user_id IN (SELECT value FROM json_each(?))
			    AND status IN ('awaiting_source','queued','staged','processing')`,
		).bind(encoded),
		count("memory_exports"), count("webhooks"),
	]);
	const n = (result) => Number(result?.results?.[0]?.n ?? 0);
	return {
		nodes: n(nodes),
		pages: n(pages),
		source_episodes: n(episodes),
		source_packets: n(packets),
		pending_jobs: n(jobs),
		exports: n(exportsRows),
		webhooks: n(hooks),
	};
}

/**
 * Preview: revalidate authorization, compute bounded inventory counts, and —
 * for the two destructive actions — mint an expiring opaque confirmation
 * token bound to actor, session, project, action, epoch, revision, and the
 * inventory hash. Never returns memory content.
 */
export async function previewLifecycleAction(env, {
	actorUserId,
	sessionRef = null,
	projectId,
	action,
}) {
	if (!LIFECYCLE_ACTIONS.includes(action)) {
		throw new LifecycleError("invalid_lifecycle_action", "Unknown lifecycle action.", 400);
	}
	const { row, membership } = await lifecycleProjectForActor(env, actorUserId, projectId);
	assertActionAllowed(action, row, membership);
	const existing = await activeRun(env, projectId);
	if (existing) {
		throw new LifecycleError("lifecycle_run_active", "Another lifecycle operation is already in progress for this project.", 409, {
			run: publicLifecycleRun(existing),
		});
	}
	const revision = await projectRevision(row);
	let spaces = [row.memory_owner_user_id];
	let counts = {};
	if (action === "memory_purge" || action === "project_delete") {
		const discovered = await discoverProjectMemorySpaces(env, {
			projectId,
			memoryOwnerUserId: row.memory_owner_user_id,
		});
		spaces = discovered.memorySpaces;
		counts = await boundedInventoryCounts(env, spaces);
	} else {
		counts = await boundedInventoryCounts(env, spaces);
	}
	const inventoryHash = await sha256Hex(JSON.stringify({
		v: 1, projectId, action, epoch: Number(row.lifecycle_epoch ?? 0), revision, spaces, counts,
	}));

	let confirmation = null;
	if (LIFECYCLE_CONFIRMATION[action]) {
		const id = newId("lcf");
		const secret = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO project_lifecycle_confirmations
			 (id, token_hash, project_id, action, actor_user_id, session_ref, lifecycle_epoch,
			  expected_revision, inventory_hash, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id, await sha256Hex(secret), projectId, action, actorUserId,
			sessionRef ? await sha256Hex(sessionRef) : null,
			Number(row.lifecycle_epoch ?? 0), revision, inventoryHash, now, now + CONFIRMATION_TTL_MS,
		).run();
		confirmation = { token: `${id}.${secret}`, expires_at: now + CONFIRMATION_TTL_MS };
	}
	return {
		action,
		project: { id: row.id, name: row.name, revision, lifecycle_state: effectiveLifecycleState(row), lifecycle_epoch: Number(row.lifecycle_epoch ?? 0) },
		memory_spaces: spaces.length,
		counts,
		inventory_hash: inventoryHash,
		...(confirmation ? { confirmation, confirmation_text: LIFECYCLE_CONFIRMATION[action] } : {}),
	};
}

async function consumeConfirmation(env, {
	token, projectId, action, actorUserId, sessionRef, row,
}) {
	const parts = String(token ?? "").split(".");
	if (parts.length !== 2 || !parts[0].startsWith("lcf_")) {
		throw new LifecycleError("invalid_confirmation", "The confirmation token is not valid. Run preview again.", 403);
	}
	const stored = await env.DB.prepare(
		"SELECT * FROM project_lifecycle_confirmations WHERE id = ? LIMIT 1",
	).bind(parts[0]).first();
	const now = Date.now();
	if (
		!stored
		|| stored.token_hash !== await sha256Hex(parts[1])
		|| stored.project_id !== projectId
		|| stored.action !== action
		|| stored.actor_user_id !== actorUserId
		|| (stored.session_ref && sessionRef && stored.session_ref !== await sha256Hex(sessionRef))
		|| (stored.session_ref && !sessionRef)
	) {
		throw new LifecycleError("invalid_confirmation", "The confirmation token is not valid for this request. Run preview again.", 403);
	}
	if (Number(stored.expires_at) <= now) {
		throw new LifecycleError("confirmation_expired", "The confirmation expired. Run preview again.", 409);
	}
	if (stored.used_at) {
		throw new LifecycleError("confirmation_replayed", "That confirmation was already used. Run preview again.", 409);
	}
	if (Number(stored.lifecycle_epoch) !== Number(row.lifecycle_epoch ?? 0)
		|| stored.expected_revision !== await projectRevision(row)) {
		throw new LifecycleError("stale_confirmation", "The project changed after the preview. Run preview again.", 409);
	}
	const used = await env.DB.prepare(
		"UPDATE project_lifecycle_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL",
	).bind(now, parts[0]).run();
	if (Number(used?.meta?.changes ?? 0) !== 1) {
		throw new LifecycleError("confirmation_replayed", "That confirmation was already used. Run preview again.", 409);
	}
	return stored;
}

// ————————————————————————————————————————————————————————————— execute ————

/**
 * Accept a lifecycle operation: verify confirmation (destructive actions),
 * create the durable run, apply the FENCE transition synchronously, and hand
 * the rest to the bounded driver. Replaying the same idempotency key returns
 * the same run; a different key while one is active is a stable 409.
 */
export async function executeLifecycleAction(env, ctx, {
	actorUserId,
	sessionRef = null,
	projectId,
	action,
	token = null,
	idempotencyKey,
	confirmName = null,
	requestId = null,
}) {
	if (!LIFECYCLE_ACTIONS.includes(action)) {
		throw new LifecycleError("invalid_lifecycle_action", "Unknown lifecycle action.", 400);
	}
	if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 120) {
		throw new LifecycleError("invalid_idempotency_key", "An idempotency key of 8-120 characters is required.", 400);
	}
	const { row, membership } = await lifecycleProjectForActor(env, actorUserId, projectId);

	// Same-key replay first: the answer must be stable even after completion.
	const replay = await env.DB.prepare(
		"SELECT * FROM project_lifecycle_runs WHERE project_id = ? AND idempotency_key = ? LIMIT 1",
	).bind(projectId, idempotencyKey.trim()).first();
	if (replay) {
		if (replay.action !== action) {
			throw new LifecycleError("idempotency_conflict", "That idempotency key already belongs to a different lifecycle action.", 409);
		}
		return { run: publicLifecycleRun(replay), replayed: true };
	}

	assertActionAllowed(action, row, membership);
	if (LIFECYCLE_CONFIRMATION[action]) {
		if (confirmName !== row.name) {
			throw new LifecycleError("confirmation_name_mismatch", "Type the project's exact name to confirm.", 400);
		}
		await consumeConfirmation(env, { token, projectId, action, actorUserId, sessionRef, row });
	}

	const now = Date.now();
	const runId = newId("lrun");
	const epochBefore = Number(row.lifecycle_epoch ?? 0);
	const insert = await env.DB.prepare(
		`INSERT INTO project_lifecycle_runs
		 (id, project_id, org_id, memory_owner_user_id, action, status, phase, lifecycle_epoch,
		  actor_user_id, idempotency_key, expected_revision, inventory_json, checkpoint_json,
		  attempts, created_at, updated_at)
		 SELECT ?, ?, ?, ?, ?, 'accepted', 'pending', ?, ?, ?, ?, '{}', ?, 0, ?, ?
		  WHERE NOT EXISTS (
		    SELECT 1 FROM project_lifecycle_runs
		     WHERE project_id = ? AND status IN ('accepted','running','verifying','failed_retryable')
		  )
		 ON CONFLICT(project_id, idempotency_key) DO NOTHING`,
	).bind(
		runId, projectId, membership.orgId, row.memory_owner_user_id, action,
		epochBefore + 1, actorUserId, idempotencyKey.trim(), await projectRevision(row),
		JSON.stringify({ fence_expect: { created_at: row.created_at, updated_at: row.updated_at, epoch: epochBefore } }),
		now, now, projectId,
	).run();
	if (Number(insert?.meta?.changes ?? 0) !== 1) {
		const conflicting = await activeRun(env, projectId);
		if (conflicting?.idempotency_key === idempotencyKey.trim() && conflicting.action === action) {
			return { run: publicLifecycleRun(conflicting), replayed: true };
		}
		throw new LifecycleError("lifecycle_run_active", "Another lifecycle operation is already in progress for this project.", 409, {
			run: publicLifecycleRun(conflicting),
		});
	}

	await writeAudit(env, {
		orgId: membership.orgId,
		projectId,
		actorUserId,
		action: `project.lifecycle.${action}.accepted`,
		targetType: "project",
		targetId: projectId,
		outcome: "ok",
		metadata: { run_id: runId, epoch: epochBefore + 1 },
		requestId,
	});

	// Apply EXACTLY the fence before answering: deterministic door latency,
	// and after the 202 the project is already safely fenced even if nothing
	// ever drives the run again (the cron will). All convergence work happens
	// in the background driver.
	await stepLifecycleRun(env, runId);
	const driven = await env.DB.prepare(
		"SELECT * FROM project_lifecycle_runs WHERE id = ? LIMIT 1",
	).bind(runId).first();
	const waiter = ctx?.waitUntil?.bind(ctx);
	if (waiter && !["completed", "failed_terminal", "cancelled"].includes(driven?.status)) {
		waiter(driveLifecycleRun(env, { runId, projectId, budgetMs: 22000 }).catch((error) => {
			console.warn("lifecycle drive failed:", error?.message ?? error);
		}));
	}
	return { run: publicLifecycleRun(driven), replayed: false };
}

// ———————————————————————————————————————————————————————————— the driver ———

async function saveRun(env, run, patch) {
	const next = {
		status: patch.status ?? run.status,
		phase: patch.phase ?? run.phase,
		checkpoint_json: patch.checkpoint ? JSON.stringify(patch.checkpoint) : run.checkpoint_json,
		inventory_json: patch.inventory ? JSON.stringify(patch.inventory) : run.inventory_json,
		inventory_hash: patch.inventoryHash ?? run.inventory_hash,
		error_code: patch.errorCode === undefined ? run.error_code : patch.errorCode,
		attempts: patch.attempts ?? run.attempts,
		completed_at: patch.completedAt ?? run.completed_at ?? null,
	};
	const result = await env.DB.prepare(
		`UPDATE project_lifecycle_runs
		 SET status = ?, phase = ?, checkpoint_json = ?, inventory_json = ?, inventory_hash = ?,
		     error_code = ?, attempts = ?, completed_at = ?, updated_at = ?
		 WHERE id = ? AND status = ? AND phase = ? AND checkpoint_json = ?`,
	).bind(
		next.status, next.phase, next.checkpoint_json, next.inventory_json, next.inventory_hash,
		next.error_code, next.attempts, next.completed_at, Date.now(),
		run.id, run.status, run.phase, run.checkpoint_json,
	).run();
	if (Number(result?.meta?.changes ?? 0) !== 1) return null;
	return {
		...run,
		...next,
		updated_at: Date.now(),
	};
}

async function loadRun(env, runId) {
	return env.DB.prepare("SELECT * FROM project_lifecycle_runs WHERE id = ? LIMIT 1").bind(runId).first();
}

async function loadProject(env, projectId) {
	return env.DB.prepare("SELECT * FROM managed_projects WHERE id = ? LIMIT 1").bind(projectId).first();
}

function isTerminal(run) {
	return ["completed", "failed_terminal", "cancelled"].includes(run?.status);
}

/** Cancel every non-terminal job/run for one space, terminally and honestly. */
async function cancelSpaceWork(env, memoryUserId, reason) {
	const now = Date.now();
	const label = `${reason}: a project lifecycle operation fenced this work`;
	const shadowStatus = reason === "cancelled_by_archive" ? "cancelled_lifecycle" : "cancelled_erased";
	const jobs = await env.DB.prepare(
		`UPDATE memory_jobs
		 SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
		 WHERE user_id = ? AND status IN ('awaiting_source','queued','staged','processing')`,
	).bind(label, now, now, memoryUserId).run();
	await env.DB.prepare(
		`UPDATE extraction_runs SET status = ?, error = ?, updated_at = ?
		 WHERE user_id = ? AND status IN ('running','committing')`,
	).bind(reason, label, now, memoryUserId).run();
	await env.DB.prepare(
		`UPDATE semantic_atom_capture_runs SET status = ?, error_code = ?, updated_at = ?, completed_at = ?
		 WHERE user_id = ? AND status = 'running'`,
	).bind(reason, reason, now, now, memoryUserId).run();
	await env.DB.prepare(
		"UPDATE staged_memories SET settled_at = ? WHERE user_id = ? AND settled_at IS NULL",
	).bind(now, memoryUserId).run();
	// Work that has not entered an external call is revoked immediately. An
	// `invoking` owner is the durable admission fence: leave a live lease intact
	// so the destructive erase step must wait/fail instead of confirming while
	// an already-admitted disclosure is active. Expired invocation leases are
	// bounded crash residue and can be retired safely.
	const shadow = await env.DB.prepare(
		`UPDATE ai_shadow_jobs
		 SET status = ?, claim_token = NULL, lease_until = NULL,
		     error_class = ?, terminal_at = COALESCE(terminal_at, ?), updated_at = ?
		 WHERE user_id = ? AND (
		   status IN ('pending', 'running')
		   OR (status = 'invoking' AND lease_until IS NOT NULL AND lease_until <= ?)
		 )`,
	).bind(shadowStatus, reason, now, now, memoryUserId, now).run();
	return Number(jobs?.meta?.changes ?? 0) + Number(shadow?.meta?.changes ?? 0);
}

async function resetSpaceCoordinator(env, memoryUserId) {
	if (!env.USER_MEMORY) throw new LifecycleError("coordinator_unavailable", "The memory coordinator binding is required.", 503, { retryable: true });
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(memoryUserId));
	if (!stub || typeof stub.resetAll !== "function") {
		throw new LifecycleError("coordinator_unavailable", "The memory coordinator could not be reached.", 503, { retryable: true });
	}
	await stub.resetAll();
	if (typeof stub.getDebugState === "function") {
		const state = await stub.getDebugState();
		const remaining = Number(state?.queue ?? state?.entries ?? 0);
		if (remaining > 0) {
			throw new LifecycleError("coordinator_not_quiet", "Held coordinator work survived a reset.", 503, { retryable: true });
		}
	}
}

function vectorsEnabled(env) {
	return String(env.USE_VECTORS ?? "true").toLocaleLowerCase("en-US") !== "false" && Boolean(env.VECTORIZE);
}

/**
 * One space's vector teardown, chunked and durable-ledger-first: record the
 * exact ids in the run checkpoint, delete them, then verify absence with
 * getByIds. Vectorize deletion is asynchronous — presence after deletion is
 * a retryable wait, never silently ignored.
 */
async function spaceVectorStep(env, run, checkpoint, memoryUserId) {
	if (!vectorsEnabled(env)) {
		return { done: true, deleted: checkpoint.vectors_deleted ?? 0, skipped: true };
	}
	const cursor = checkpoint.vector_cursor ?? { table: "nodes", after: "", pending: null, verify_attempts: 0 };
	if (cursor.pending?.length) {
		// Vectorize mutations are asynchronous on a minutes timescale. A
		// pending verification therefore WAITS on the wall clock instead of
		// burning attempts hot: the driver yields, and the next poll/cron
		// drive re-checks after the backoff window.
		const waitMs = Math.max(1, Number(env.LIFECYCLE_VECTOR_WAIT_MS ?? 20000));
		if (Number(cursor.wait_until ?? 0) > Date.now()) {
			return { done: false, cursor, yield: true };
		}
		// Ledgered ids: delete (idempotent) then verify absence.
		await env.VECTORIZE.deleteByIds(cursor.pending);
		const present = await env.VECTORIZE.getByIds(cursor.pending);
		if ((present ?? []).length > 0) {
			cursor.verify_attempts = Number(cursor.verify_attempts ?? 0) + 1;
			if (cursor.verify_attempts > 90) {
				throw new LifecycleError("vector_deletion_unverified", "Vector deletion did not converge.", 503, { retryable: true });
			}
			cursor.wait_until = Date.now() + waitMs;
			return { done: false, cursor, yield: true };
		}
		checkpoint.vectors_deleted = Number(checkpoint.vectors_deleted ?? 0) + cursor.pending.length;
		cursor.pending = null;
		cursor.verify_attempts = 0;
		cursor.wait_until = 0;
		return { done: false, cursor };
	}
	const table = cursor.table;
	const { results } = await env.DB.prepare(
		`SELECT id FROM ${table === "nodes" ? "nodes" : "memory_pages"}
		  WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`,
	).bind(memoryUserId, cursor.after, VECTOR_CHUNK).all();
	const rows = results ?? [];
	if (!rows.length) {
		if (table === "nodes") {
			return { done: false, cursor: { table: "pages", after: "", pending: null, verify_attempts: 0 } };
		}
		return { done: true, deleted: checkpoint.vectors_deleted ?? 0 };
	}
	cursor.after = rows[rows.length - 1].id;
	// Page vectors live under the hashed page namespace as `page:<id>`; node
	// vectors under the space namespace as the bare node id. deleteByIds and
	// getByIds are id-exact regardless of namespace.
	cursor.pending = table === "nodes"
		? rows.map((r) => String(r.id))
		: rows.map((r) => `page:${r.id}`);
	return { done: false, cursor };
}

/** Bounded tenant-scoped table sweep for one space; returns rows deleted. */
async function sweepSpaceChunk(env, memoryUserId, checkpoint) {
	const tables = PURGE_SPACE_TABLES;
	let tableIndex = Number(checkpoint.sweep_table ?? 0);
	let deleted = 0;
	while (tableIndex < tables.length) {
		const table = tables[tableIndex];
		const result = await env.DB.prepare(
			`DELETE FROM ${table} WHERE rowid IN (
			   SELECT rowid FROM ${table} WHERE user_id = ? LIMIT ${SWEEP_CHUNK}
			 )`,
		).bind(memoryUserId).run();
		const changes = Number(result?.meta?.changes ?? 0);
		deleted += changes;
		if (changes < SWEEP_CHUNK) {
			tableIndex += 1;
			checkpoint.sweep_table = tableIndex;
			if (deleted >= SWEEP_CHUNK) return { done: false, deleted };
			continue;
		}
		checkpoint.sweep_table = tableIndex;
		return { done: false, deleted };
	}
	return { done: true, deleted };
}

/**
 * At most one driver may advance a run at a time. Stacked drivers (poll
 * nudges + cron + execute) during a long per-space erase would otherwise
 * repeat heavy idempotent D1 work concurrently and contend the database.
 * The lease is CAS-claimed and expiry-recovered, so a crashed driver never
 * wedges the run.
 */
async function claimDriverLease(env, runId, ms) {
	const now = Date.now();
	const until = now + ms;
	const result = await env.DB.prepare(
		`UPDATE project_lifecycle_runs SET driver_lease_until = ?
		 WHERE id = ? AND (driver_lease_until IS NULL OR driver_lease_until < ?)`,
	).bind(until, runId, now).run();
	return Number(result?.meta?.changes ?? 0) === 1 ? until : null;
}

async function releaseDriverLease(env, runId, until) {
	if (!until) return;
	await env.DB.prepare(
		"UPDATE project_lifecycle_runs SET driver_lease_until = NULL WHERE id = ? AND driver_lease_until = ?",
	).bind(runId, until).run();
}

/** Advance one run by exactly one phase step (used by the execute door to
 * apply the fence synchronously; errors classify exactly like the driver). */
export async function stepLifecycleRun(env, runId) {
	const lease = await claimDriverLease(env, runId, 8000);
	if (!lease) return publicLifecycleRun(await loadRun(env, runId));
	try {
		const run = await loadRun(env, runId);
		if (!run || isTerminal(run) || run.status === "failed_retryable") return publicLifecycleRun(run);
		const project = await loadProject(env, run.project_id);
		if (!project) return publicLifecycleRun(run);
		try {
			const advanced = await advancePhase(env, run, project);
			return publicLifecycleRun(advanced ?? await loadRun(env, runId));
		} catch (error) {
			const retryable = error?.retryable !== false && !(error?.name === "RetentionError") && error?.terminal !== true;
			await saveRun(env, run, {
				status: retryable ? "failed_retryable" : "failed_terminal",
				errorCode: error?.code ?? "lifecycle_step_failed",
				attempts: Number(run.attempts) + 1,
				...(retryable ? {} : { completedAt: Date.now() }),
			});
			await emitLifecycleRunFailed(env, run, error, retryable);
			return publicLifecycleRun(await loadRun(env, runId));
		}
	} finally {
		await releaseDriverLease(env, runId, lease);
	}
}

/**
 * Advance one run by at most `budgetMs` of bounded work. Re-entrant and
 * crash-safe: every step CAS-es the checkpoint, so a lost isolate or a
 * concurrent driver can only repeat idempotent work, never corrupt state.
 */
export async function driveLifecycleRun(env, { runId, projectId = null, budgetMs = 20000 } = {}) {
	const startedAt = Date.now();
	// Lease slightly outlives the budget so a live driver is never preempted,
	// and a dead one is recovered within seconds of expiry.
	const lease = await claimDriverLease(env, runId, budgetMs + 8000);
	if (!lease) return publicLifecycleRun(await loadRun(env, runId));
	try {
		return await driveLifecycleRunLeased(env, { runId, startedAt, budgetMs });
	} finally {
		await releaseDriverLease(env, runId, lease);
	}
}

async function driveLifecycleRunLeased(env, { runId, startedAt, budgetMs }) {
	let run = await loadRun(env, runId);
	while (run && !isTerminal(run) && Date.now() - startedAt < budgetMs) {
		if (run.status === "failed_retryable") return publicLifecycleRun(run);
		if (Number(run.attempts) >= MAX_RUN_ATTEMPTS) {
			run = await saveRun(env, run, { status: "failed_retryable", errorCode: "attempt_budget_exhausted" }) ?? await loadRun(env, runId);
			continue;
		}
		const project = await loadProject(env, run.project_id);
		if (!project) {
			run = await saveRun(env, run, { status: "failed_terminal", errorCode: "project_missing", completedAt: Date.now() }) ?? await loadRun(env, runId);
			continue;
		}
		try {
			const advanced = await advancePhase(env, run, project);
			if (advanced?._yield) return publicLifecycleRun(advanced);
			run = advanced ?? await loadRun(env, runId);
		} catch (error) {
			const retryable = error?.retryable !== false && !(error?.name === "RetentionError") && error?.terminal !== true;
			const code = error?.code ?? "lifecycle_step_failed";
			console.warn(JSON.stringify({
				event: "lifecycle_step_failed", run: run.id, action: run.action, phase: run.phase,
				code, retryable, message: String(error?.message ?? error).slice(0, 200),
			}));
			run = await saveRun(env, run, {
				status: retryable ? "failed_retryable" : "failed_terminal",
				errorCode: code,
				attempts: Number(run.attempts) + 1,
				...(retryable ? {} : { completedAt: Date.now() }),
			}) ?? await loadRun(env, runId);
			await emitLifecycleRunFailed(env, run, error, retryable);
		}
	}
	return publicLifecycleRun(run ?? await loadRun(env, runId));
}

/**
 * A lifecycle run failing is a deletion/archive promise not being kept on
 * schedule — high severity, deduped per run by group key so a retry loop is
 * one escalating row, not a feed of identical ones. Never throws.
 */
/**
 * Tell the person who asked that it is done — and only ever from a call site
 * that has already VERIFIED it is done.
 *
 * Deliberately best-effort and never throwing: a purge that genuinely
 * completed must not be recorded as failed because the email about it could
 * not be queued. The run is the truth; the email is the courtesy.
 *
 * Dedupe is keyed on the run id, so the retries and resumptions this driver
 * is built around cannot mail somebody twice about one deletion.
 */
async function notifyLifecycleComplete(env, run, project, kind, facts) {
	try {
		const actor = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(run.actor_user_id).first();
		if (!actor?.email) return;
		const projectName = project?.name ?? "your project";
		const content = kind === "project_memory_purged"
			? memoryPurgedMail(env, { projectName, verified: facts })
			: projectDeletedMail(env, { projectName });
		await enqueueMail(env, {
			kind,
			to: actor.email,
			toUserId: run.actor_user_id,
			dedupeKey: `${kind}:${run.id}`,
			...content,
		});
	} catch (error) {
		console.warn("lifecycle completion mail failed:", error?.message ?? error);
	}
}

async function emitLifecycleRunFailed(env, run, error, retryable) {
	await recordSecurityEvent(env, {
		kind: "lifecycle_run_failed",
		severity: "high",
		groupKey: `lifecycle_run_failed:${run?.id ?? "unknown"}`,
		details: {
			run_id: run?.id,
			action: run?.action,
			phase: run?.phase,
			code: error?.code ?? "lifecycle_step_failed",
			retryable,
		},
	});
}

async function transitionProject(env, run, project, { fromStatus, fromStates, toStatus, toState, expectEpoch, bumpEpoch = true, extraSet = "" }) {
	const now = Date.now();
	const stateList = fromStates.map(() => "?").join(",");
	const nullAllowed = fromStates.includes(null);
	const boundStates = fromStates.filter((state) => state !== null);
	const result = await env.DB.prepare(
		`UPDATE managed_projects
		 SET status = ?, lifecycle_state = ?,
		     lifecycle_epoch = lifecycle_epoch + ${bumpEpoch ? 1 : 0},
		     lifecycle_updated_at = ?, updated_at = ?,
		     archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE archived_at END
		     ${extraSet}
		 WHERE id = ? AND status IN (${fromStatus.map(() => "?").join(",")})
		   AND lifecycle_epoch = ?
		   AND (${nullAllowed ? "lifecycle_state IS NULL OR " : ""}lifecycle_state IN (${stateList.length ? boundStates.map(() => "?").join(",") : "NULL"}))`,
	).bind(
		toStatus, toState, now, now, toStatus, now,
		run.project_id, ...fromStatus, expectEpoch, ...boundStates,
	).run();
	return Number(result?.meta?.changes ?? 0) === 1;
}

async function advancePhase(env, run, project) {
	const checkpoint = parseJson(run.checkpoint_json);
	const inventory = parseJson(run.inventory_json);
	const runEpoch = Number(run.lifecycle_epoch);

	// —— fence: the one transition that starts every action ————————————
	if (run.phase === "pending") {
		const targetState = { memory_purge: "purging_memory", project_delete: "deleting", archive: "archiving", restore: "restoring" }[run.action];
		const expect = checkpoint.fence_expect ?? {};
		const fromStatus = run.action === "restore" ? ["archived"] : run.action === "archive" ? ["active"] : ["active", "archived"];
		const ok = await transitionProject(env, run, project, {
			fromStatus,
			fromStates: run.action === "restore" ? [null, "archived"] : [null, "active", "archived"],
			toStatus: "archived",
			toState: targetState,
			expectEpoch: Number(expect.epoch ?? runEpoch - 1),
		});
		if (!ok) {
			const fresh = await loadProject(env, run.project_id);
			if (Number(fresh?.lifecycle_epoch) === runEpoch && fresh?.lifecycle_state === targetState) {
				// A crashed prior driver already fenced under our epoch; continue.
			} else {
				throw new LifecycleError("stale_project", "The project changed before the operation could start. Run preview again.", 409, { retryable: false, terminal: true });
			}
		}
		checkpoint.barrier_floor = Date.now();
		return saveRun(env, run, { status: "running", phase: "inventory", checkpoint, attempts: Number(run.attempts) + 1 });
	}

	// Every later phase re-checks the epoch fence before durable effects.
	if (Number(project.lifecycle_epoch) !== runEpoch) {
		throw new LifecycleError("stale_epoch", "A newer lifecycle operation superseded this run.", 409, { retryable: false, terminal: true });
	}

	if (run.action === "archive") return advanceArchive(env, run, project, checkpoint);
	if (run.action === "restore") return advanceRestore(env, run, project, checkpoint);
	return advanceDestructive(env, run, project, checkpoint, inventory);
}

async function advanceArchive(env, run, project, checkpoint) {
	if (run.phase === "inventory") {
		const discovered = await discoverProjectMemorySpaces(env, {
			projectId: run.project_id,
			memoryOwnerUserId: run.memory_owner_user_id,
		});
		checkpoint.spaces = discovered.memorySpaces;
		checkpoint.space_index = 0;
		checkpoint.jobs_cancelled = 0;
		return saveRun(env, run, {
			phase: "cancel_work", checkpoint,
			inventory: { spaces: discovered.memorySpaces.length },
			attempts: Number(run.attempts) + 1,
		});
	}
	if (run.phase === "cancel_work") {
		// The project fence is already durable. Do not cancel jobs, reset a
		// coordinator, or otherwise mutate content while a provider call that
		// was admitted before that fence may still start or be in flight.
		await assertNoActiveProviderInvocation(env, {
			managedProjectId: run.project_id,
		});
		const index = Number(checkpoint.space_index ?? 0);
		if (index >= checkpoint.spaces.length) {
			return saveRun(env, run, { status: "verifying", phase: "verify", checkpoint, attempts: Number(run.attempts) + 1 });
		}
		const space = checkpoint.spaces[index];
		checkpoint.jobs_cancelled = Number(checkpoint.jobs_cancelled ?? 0) + await cancelSpaceWork(env, space, "cancelled_by_archive");
		await resetSpaceCoordinator(env, space);
		checkpoint.space_index = index + 1;
		return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
	}
	if (run.phase === "verify") {
		const encoded = JSON.stringify(checkpoint.spaces ?? []);
		const pending = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM memory_jobs
			  WHERE user_id IN (SELECT value FROM json_each(?))
			    AND status IN ('awaiting_source','queued','staged','processing')`,
		).bind(encoded).first();
		if (Number(pending?.n ?? 0) > 0) {
			checkpoint.space_index = 0;
			return saveRun(env, run, { phase: "cancel_work", checkpoint, attempts: Number(run.attempts) + 1 });
		}
		const ok = await transitionProject(env, run, project, {
			fromStatus: ["archived"], fromStates: ["archiving"],
			toStatus: "archived", toState: "archived",
			expectEpoch: Number(run.lifecycle_epoch), bumpEpoch: false,
		});
		if (!ok) throw new LifecycleError("stale_epoch", "Archive completion lost its fence.", 409, { terminal: true });
		await writeAudit(env, {
			orgId: run.org_id, projectId: run.project_id, actorUserId: run.actor_user_id,
			action: "project.lifecycle.archive.completed", targetType: "project", targetId: run.project_id,
			outcome: "ok", metadata: { run_id: run.id, jobs_cancelled: checkpoint.jobs_cancelled ?? 0 },
		});
		return saveRun(env, run, { status: "completed", phase: "done", checkpoint, completedAt: Date.now(), attempts: Number(run.attempts) + 1 });
	}
	throw new LifecycleError("unknown_phase", `Unknown archive phase ${run.phase}.`, 500, { terminal: true });
}

async function advanceRestore(env, run, project, checkpoint) {
	if (run.phase === "inventory") {
		const discovered = await discoverProjectMemorySpaces(env, {
			projectId: run.project_id,
			memoryOwnerUserId: run.memory_owner_user_id,
		});
		checkpoint.spaces = discovered.memorySpaces;
		checkpoint.space_index = 0;
		return saveRun(env, run, {
			phase: "quiesce_stale", checkpoint,
			inventory: { spaces: discovered.memorySpaces.length },
			attempts: Number(run.attempts) + 1,
		});
	}
	if (run.phase === "quiesce_stale") {
		// A legacy archived project (archived outside this subsystem) may hold
		// stragglers; make every pre-archive job terminal before reactivating.
		const index = Number(checkpoint.space_index ?? 0);
		if (index >= checkpoint.spaces.length) {
			return saveRun(env, run, { status: "verifying", phase: "reactivate", checkpoint, attempts: Number(run.attempts) + 1 });
		}
		const space = checkpoint.spaces[index];
		checkpoint.jobs_cancelled = Number(checkpoint.jobs_cancelled ?? 0) + await cancelSpaceWork(env, space, "cancelled_by_archive");
		await resetSpaceCoordinator(env, space);
		checkpoint.space_index = index + 1;
		return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
	}
	if (run.phase === "reactivate") {
		const ok = await transitionProject(env, run, project, {
			fromStatus: ["archived"], fromStates: ["restoring"],
			toStatus: "active", toState: "active",
			expectEpoch: Number(run.lifecycle_epoch), bumpEpoch: true,
		});
		if (!ok) throw new LifecycleError("stale_epoch", "Restore lost its fence.", 409, { terminal: true });
		await writeAudit(env, {
			orgId: run.org_id, projectId: run.project_id, actorUserId: run.actor_user_id,
			action: "project.lifecycle.restore.completed", targetType: "project", targetId: run.project_id,
			outcome: "ok", metadata: { run_id: run.id, epoch: Number(run.lifecycle_epoch) + 1 },
		});
		return saveRun(env, run, { status: "completed", phase: "done", checkpoint, completedAt: Date.now(), attempts: Number(run.attempts) + 1 });
	}
	throw new LifecycleError("unknown_phase", `Unknown restore phase ${run.phase}.`, 500, { terminal: true });
}

async function advanceDestructive(env, run, project, checkpoint, inventory) {
	if (run.phase === "inventory") {
		// The registry is frozen: registration requires status='active' and the
		// fence already archived the project, so this snapshot is complete.
		const discovered = await discoverProjectMemorySpaces(env, {
			projectId: run.project_id,
			memoryOwnerUserId: run.memory_owner_user_id,
		});
		checkpoint.spaces = discovered.memorySpaces;
		checkpoint.space_index = 0;
		checkpoint.space_state = "cancel";
		checkpoint.deleted = 0;
		checkpoint.vectors_deleted = 0;
		checkpoint.jobs_cancelled = 0;
		return saveRun(env, run, {
			phase: "spaces", checkpoint,
			inventory: { spaces: discovered.memorySpaces.length },
			inventoryHash: run.inventory_hash,
			attempts: Number(run.attempts) + 1,
		});
	}

	if (run.phase === "spaces") {
		// Check project-wide, including reservations admitted for a project that
		// currently has no registered memory space.  An empty inventory must not
		// turn into an invocation-fence bypass.
		await assertNoActiveProviderInvocation(env, {
			managedProjectId: run.project_id,
		});
		await scrubProviderReservationLifecycle(env, {
			managedProjectId: run.project_id,
		});
		const index = Number(checkpoint.space_index ?? 0);
		if (index >= checkpoint.spaces.length) {
			return saveRun(env, run, { status: "verifying", phase: "verify", checkpoint, attempts: Number(run.attempts) + 1 });
		}
		const space = checkpoint.spaces[index];
		const state = checkpoint.space_state ?? "cancel";
		if (state === "cancel") {
			checkpoint.jobs_cancelled = Number(checkpoint.jobs_cancelled ?? 0) + await cancelSpaceWork(env, space, "cancelled_by_delete");
			checkpoint.space_state = "vectors";
			return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
		}
		if (state === "vectors") {
			const step = await spaceVectorStep(env, run, checkpoint, space);
			if (!step.done) {
				checkpoint.vector_cursor = step.cursor;
				const saved = await saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
				// A waiting verification must not hot-loop inside one driver
				// invocation; surface the yield so the drive loop parks the run
				// until the next poll or cron pass.
				return step.yield && saved ? { ...saved, _yield: true } : saved;
			}
			delete checkpoint.vector_cursor;
			checkpoint.space_state = "erase";
			return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
		}
		if (state === "erase") {
			// Converge-erase: barrier first, packet minimization, episode hard
			// delete, DO resetAll, graph sweep — the production-proven per-space
			// erasure engine.
			await bulkDeleteBySource(env, space, {
				dryRun: false,
				confirm: true,
				by: `project_lifecycle:${run.action}`,
				barrierFloor: Number(checkpoint.barrier_floor ?? run.created_at) + 1,
			});
			checkpoint.space_state = "sweep";
			checkpoint.sweep_table = 0;
			return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
		}
		if (state === "sweep") {
			const swept = await sweepSpaceChunk(env, space, checkpoint);
			checkpoint.deleted = Number(checkpoint.deleted ?? 0) + swept.deleted;
			if (!swept.done) return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
			checkpoint.space_state = "residual";
			return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
		}
		if (state === "residual") {
			const counts = await residualSpaceCounts(env, space, { erasedContentHash: ERASED_SOURCE_CONTENT_HASH });
			if (residualTotal(counts) > 0) {
				// Fixed point not reached (late settlement raced the sweep): loop
				// this space again from the erase step.
				checkpoint.space_state = "erase";
				checkpoint.residual_retries = Number(checkpoint.residual_retries ?? 0) + 1;
				if (checkpoint.residual_retries > 25) {
					throw new LifecycleError("residual_not_converging", "A memory space did not converge to empty.", 503, { retryable: true });
				}
				return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
			}
			await resetSpaceCoordinator(env, space);
			checkpoint.space_index = index + 1;
			checkpoint.space_state = "cancel";
			checkpoint.residual_retries = 0;
			return saveRun(env, run, { checkpoint, attempts: Number(run.attempts) + 1 });
		}
		throw new LifecycleError("unknown_phase", `Unknown space state ${state}.`, 500, { terminal: true });
	}

	if (run.phase === "verify") {
		// The full-project fixed-point residual scan, across every space.
		for (const space of checkpoint.spaces ?? []) {
			const counts = await residualSpaceCounts(env, space, { erasedContentHash: ERASED_SOURCE_CONTENT_HASH });
			if (residualTotal(counts) > 0) {
				checkpoint.space_index = (checkpoint.spaces ?? []).indexOf(space);
				checkpoint.space_state = "erase";
				return saveRun(env, run, { status: "running", phase: "spaces", checkpoint, attempts: Number(run.attempts) + 1 });
			}
		}
		const nextPhase = run.action === "memory_purge" ? "reopen" : "control_plane";
		return saveRun(env, run, { phase: nextPhase, checkpoint, attempts: Number(run.attempts) + 1 });
	}

	if (run.phase === "reopen") {
		const ok = await transitionProject(env, run, project, {
			fromStatus: ["archived"], fromStates: ["purging_memory"],
			toStatus: "active", toState: "active",
			expectEpoch: Number(run.lifecycle_epoch), bumpEpoch: true,
		});
		if (!ok) throw new LifecycleError("stale_epoch", "Purge completion lost its fence.", 409, { terminal: true });
		await writeAudit(env, {
			orgId: run.org_id, projectId: run.project_id, actorUserId: run.actor_user_id,
			action: "project.lifecycle.memory_purge.completed", targetType: "project", targetId: run.project_id,
			outcome: "ok",
			metadata: {
				run_id: run.id, spaces: (checkpoint.spaces ?? []).length,
				deleted: checkpoint.deleted ?? 0, vectors_deleted: checkpoint.vectors_deleted ?? 0,
				epoch: Number(run.lifecycle_epoch) + 1,
			},
		});
		// Only here. The verify phase above re-scanned every space for residue
		// and refused to advance while any remained, so by this line "your
		// memory is deleted" is a fact, not an intention. That ordering is the
		// whole reason this call sits where it does and nowhere earlier.
		await notifyLifecycleComplete(env, run, project, "project_memory_purged", {
			spaces: (checkpoint.spaces ?? []).length,
			residual: 0,
		});
		return saveRun(env, run, { status: "completed", phase: "done", checkpoint, completedAt: Date.now(), attempts: Number(run.attempts) + 1 });
	}

	if (run.phase === "control_plane") {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE connection_tokens SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
				  WHERE project_id = ?`,
			).bind(now, run.project_id),
			env.DB.prepare("DELETE FROM connection_tokens WHERE project_id = ?").bind(run.project_id),
			// OAuth authorizations for this project: revoked then removed, in the
			// same batch and for the same reason as connection tokens — the
			// revoke is the observable state for anything reading mid-batch.
			env.DB.prepare(
				"UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'project_deleted') WHERE project_id = ?",
			).bind(now, run.project_id),
			env.DB.prepare(
				"UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id IN (SELECT id FROM oauth_grants WHERE project_id = ?)",
			).bind(now, run.project_id),
			env.DB.prepare("DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE project_id = ?)").bind(run.project_id),
			env.DB.prepare("DELETE FROM oauth_authorization_codes WHERE grant_id IN (SELECT id FROM oauth_grants WHERE project_id = ?)").bind(run.project_id),
			env.DB.prepare("DELETE FROM oauth_consent_requests WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare("DELETE FROM oauth_grants WHERE project_id = ?").bind(run.project_id),
			// Managed projects are retained as permanent tombstones rather than
			// hard-deleted, so foreign-key ON DELETE actions never run here. Clear
			// every durable account selector in the same control-plane transaction
			// before the project becomes logically deleted.
			env.DB.prepare(
				`UPDATE account_onboarding
				    SET project_id = NULL, updated_at = ?, revision = revision + 1
				  WHERE project_id = ?`,
			).bind(now, run.project_id),
			env.DB.prepare(
				`UPDATE user_scope_preferences
				    SET selected_project_id = NULL, updated_at = ?, revision = revision + 1
				  WHERE selected_project_id = ?`,
			).bind(now, run.project_id),
			env.DB.prepare("DELETE FROM user_org_project_preferences WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare(
				`UPDATE organization_invitations SET project_id = NULL, project_role = NULL
				  WHERE project_id = ? AND status = 'pending'`,
			).bind(run.project_id),
			env.DB.prepare("DELETE FROM project_categories WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare("DELETE FROM retention_policies WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare("DELETE FROM retention_runs WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare(
				"DELETE FROM project_lifecycle_confirmations WHERE project_id = ?",
			).bind(run.project_id),
		]);
		return saveRun(env, run, { phase: "tombstone", checkpoint, attempts: Number(run.attempts) + 1 });
	}

	if (run.phase === "tombstone") {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO project_tombstones
				 (project_id, org_id, memory_owner_user_id, action, lifecycle_epoch, run_id, by_user_id, created_at)
				 VALUES (?, ?, ?, 'project_delete', ?, ?, ?, ?)
				 ON CONFLICT(project_id) DO NOTHING`,
			).bind(run.project_id, run.org_id, run.memory_owner_user_id, Number(run.lifecycle_epoch), run.id, run.actor_user_id, now),
			// The registry goes only now, after every space was proven empty.
			env.DB.prepare("DELETE FROM project_memory_spaces WHERE project_id = ?").bind(run.project_id),
			env.DB.prepare(
				`UPDATE managed_projects
				 SET lifecycle_state = 'deleted', description = NULL,
				     lifecycle_epoch = lifecycle_epoch + 1, lifecycle_updated_at = ?, updated_at = ?
				 WHERE id = ? AND status = 'archived' AND lifecycle_state = 'deleting' AND lifecycle_epoch = ?`,
			).bind(now, now, run.project_id, Number(run.lifecycle_epoch)),
		]);
		const final = await loadProject(env, run.project_id);
		if (final?.lifecycle_state !== "deleted") {
			throw new LifecycleError("stale_epoch", "Delete completion lost its fence.", 409, { terminal: true });
		}
		await writeAudit(env, {
			orgId: run.org_id, projectId: run.project_id, actorUserId: run.actor_user_id,
			action: "project.lifecycle.project_delete.completed", targetType: "project", targetId: run.project_id,
			outcome: "ok",
			metadata: {
				run_id: run.id, spaces: (checkpoint.spaces ?? []).length,
				deleted: checkpoint.deleted ?? 0, vectors_deleted: checkpoint.vectors_deleted ?? 0,
			},
		});
		// Same rule as the purge: the deleted state was re-read and proved
		// a few lines above, so the confirmation is true when it is sent.
		await notifyLifecycleComplete(env, run, project, "project_deleted", {});
		return saveRun(env, run, { status: "completed", phase: "done", checkpoint, completedAt: Date.now(), attempts: Number(run.attempts) + 1 });
	}

	throw new LifecycleError("unknown_phase", `Unknown lifecycle phase ${run.phase}.`, 500, { terminal: true });
}

// ————————————————————————————————————————————————— status / retry / cancel —

export async function lifecycleStatus(env, { actorUserId, projectId }) {
	const { row, membership } = await lifecycleProjectForActor(env, actorUserId, projectId);
	const runs = await env.DB.prepare(
		"SELECT * FROM project_lifecycle_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 10",
	).bind(projectId).all();
	const state = effectiveLifecycleState(row);
	const active = (runs.results ?? []).find((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;
	return {
		project: {
			id: row.id,
			name: row.name,
			is_default: Boolean(row.is_default),
			status: row.status,
			lifecycle_state: state,
			lifecycle_epoch: Number(row.lifecycle_epoch ?? 0),
			revision: await projectRevision(row),
			deleted: state === "deleted",
		},
		membership: { org_role: membership.orgRole, project_role: membership.projectRole },
		capabilities: Object.fromEntries(LIFECYCLE_ACTIONS.map((action) => {
			try {
				assertActionAllowed(action, row, membership);
				return [action, true];
			} catch {
				return [action, false];
			}
		})),
		transfer_allowed: can("project.transfer", membership) && Number(row.is_default) !== 1
			&& row.status === "active" && ["active"].includes(state),
		// A transfer now waits on the recipient, so the settings page has to be
		// able to say "offered, not yet accepted" instead of showing a control
		// that would silently create a second offer. Queried inline rather than
		// imported: ownership_transfer.js already imports THIS module, and a
		// cycle between the two would be a needless fragility.
		pending_transfer: await pendingTransfer(env, row.id),
		active_run: publicLifecycleRun(active),
		recent_runs: (runs.results ?? []).map(publicLifecycleRun),
	};
}

/**
 * Archived (not deleted) project shells this actor may restore. Ordinary
 * resolvers and the selector hide archived projects, so restore needs its own
 * bounded, access-checked listing.
 */
export async function listRestorableProjects(env, actorUserId, { limit = 20 } = {}) {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT p.id, p.name, p.is_default, p.status, p.lifecycle_state, p.lifecycle_epoch, p.archived_at
		   FROM managed_projects p
		  WHERE p.status = 'archived'
		    AND (p.lifecycle_state IS NULL OR p.lifecycle_state IN ('archived', 'archiving', 'restoring'))
		    AND (
		      p.owner_user_id = ?
		      OR EXISTS (
		        SELECT 1 FROM organization_members om
		         WHERE om.org_id = COALESCE(p.organization_id, (
		           SELECT o.id FROM organizations o
		            WHERE o.owner_user_id = p.owner_user_id AND o.is_default = 1 AND o.status = 'active' LIMIT 1
		         ))
		           AND om.user_id = ? AND om.role IN ('owner', 'admin')
		           AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		           AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		      )
		      OR EXISTS (
		        SELECT 1 FROM project_members pm
		         WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.role = 'admin'
		           AND (pm.access_starts_at IS NULL OR pm.access_starts_at <= ?)
		           AND (pm.access_expires_at IS NULL OR pm.access_expires_at > ?)
		      )
		    )
		  ORDER BY p.archived_at DESC, p.updated_at DESC
		  LIMIT ?`,
	).bind(actorUserId, actorUserId, now, now, actorUserId, now, now, limit).all();
	return (results ?? []).map((row) => ({
		id: row.id,
		name: row.name,
		is_default: Boolean(row.is_default),
		lifecycle_state: row.lifecycle_state ?? "archived",
		archived_at: row.archived_at ?? null,
	}));
}

export async function retryLifecycleRun(env, ctx, { actorUserId, projectId, runId }) {
	const { membership } = await lifecycleProjectForActor(env, actorUserId, projectId);
	const run = await loadRun(env, runId);
	if (!run || run.project_id !== projectId) {
		throw new LifecycleError("run_not_found", "That lifecycle run does not exist.", 404);
	}
	if (!can(ACTION_CAPABILITY[run.action], membership)) {
		throw new LifecycleError("forbidden", "You do not have permission for that lifecycle action.", 403);
	}
	if (isTerminal(run)) return { run: publicLifecycleRun(run), retried: false };
	if (run.status === "failed_retryable") {
		await env.DB.prepare(
			"UPDATE project_lifecycle_runs SET status = CASE WHEN phase = 'verify' THEN 'verifying' ELSE 'running' END, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'failed_retryable'",
		).bind(Date.now(), runId).run();
	}
	const waiter = ctx?.waitUntil?.bind(ctx);
	const drive = driveLifecycleRun(env, { runId, budgetMs: 22000 }).catch((error) => {
		console.warn("lifecycle retry drive failed:", error?.message ?? error);
	});
	if (waiter) waiter(drive); else await drive;
	return { run: publicLifecycleRun(await loadRun(env, runId)), retried: true };
}

export async function cancelLifecycleRun(env, { actorUserId, projectId, runId }) {
	const { membership } = await lifecycleProjectForActor(env, actorUserId, projectId);
	const run = await loadRun(env, runId);
	if (!run || run.project_id !== projectId) {
		throw new LifecycleError("run_not_found", "That lifecycle run does not exist.", 404);
	}
	if (!can(ACTION_CAPABILITY[run.action], membership)) {
		throw new LifecycleError("forbidden", "You do not have permission for that lifecycle action.", 403);
	}
	// Cancellation is only proven safe before the fence: once the project is
	// fenced and space work has begun, the operation must converge or be
	// retried — a half-purged project must never be silently reopened.
	const result = await env.DB.prepare(
		`UPDATE project_lifecycle_runs
		 SET status = 'cancelled', completed_at = ?, updated_at = ?
		 WHERE id = ? AND status = 'accepted' AND phase = 'pending'`,
	).bind(Date.now(), Date.now(), runId).run();
	if (Number(result?.meta?.changes ?? 0) !== 1) {
		throw new LifecycleError("cancel_unsafe", "This operation has already started and cannot be cancelled; let it converge or retry it.", 409);
	}
	return { run: publicLifecycleRun(await loadRun(env, runId)), cancelled: true };
}

/** Cron entry: resume interrupted or transiently failed runs. */
export async function resumeLifecycleRuns(env, { limit = 3, budgetMs = 20000, now = Date.now() } = {}) {
	const { results } = await env.DB.prepare(
		`SELECT id, project_id FROM project_lifecycle_runs
		  WHERE (status IN ('accepted','running','verifying') AND updated_at < ?)
		     OR (status = 'failed_retryable' AND updated_at < ?)
		  ORDER BY updated_at ASC LIMIT ?`,
	).bind(now - 60 * 1000, now - 5 * 60 * 1000, limit).all();
	const resumed = [];
	for (const row of results ?? []) {
		await env.DB.prepare(
			"UPDATE project_lifecycle_runs SET status = CASE WHEN phase = 'verify' THEN 'verifying' ELSE 'running' END, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'failed_retryable'",
		).bind(Date.now(), row.id).run();
		resumed.push(row.id);
		await driveLifecycleRun(env, { runId: row.id, budgetMs });
	}
	return { resumed };
}

// —————————————————————————————————————————————————————— ownership transfer —

/**
 * Ownership transfer: governance only. One atomic audited batch swaps
 * owner_user_id, pins the effective organization explicitly, grants the old
 * owner the project-admin role, and bumps the epoch — with commit-time
 * fences proving the actor still holds project.transfer, the recipient is
 * still an active member of the SAME organization, and the project row is
 * byte-identical to the one previewed. memory_owner_user_id, every
 * registered memory-space id, and every stored object/vector id are
 * untouched, and a postcondition proves it.
 */
export async function transferProjectOwnership(env, {
	actorUserId,
	projectId,
	recipientUserId,
	expectedRevision,
	requestId = null,
}) {
	const { row, membership, orgId } = await lifecycleProjectForActor(env, actorUserId, projectId);
	if (!can("project.transfer", membership)) {
		throw new LifecycleError("forbidden", "Only the organization owner can transfer a project.", 403);
	}
	if (Number(row.is_default) === 1) {
		throw new LifecycleError("default_project_protected", "The default project cannot be transferred.", 409);
	}
	if (row.status !== "active" || !["active"].includes(effectiveLifecycleState(row))) {
		throw new LifecycleError("lifecycle_conflict", "Restore the project before transferring it.", 409);
	}
	if (!orgId) {
		throw new LifecycleError("organization_required", "This project has no active organization to transfer within.", 409);
	}
	if (typeof recipientUserId !== "string" || !recipientUserId.trim() || recipientUserId === row.owner_user_id) {
		throw new LifecycleError("invalid_recipient", "Choose a different eligible member as the new owner.", 400);
	}
	if (expectedRevision !== await projectRevision(row)) {
		throw new LifecycleError("project_conflict", "This project changed in another session. Reload before transferring.", 412);
	}
	const now = Date.now();
	const recipient = await env.DB.prepare(
		`SELECT u.id FROM users u
		  JOIN organization_members om ON om.org_id = ? AND om.user_id = u.id
		 WHERE u.id = ? AND u.status = 'active'
		   AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		   AND (om.role = 'owner' OR om.access_starts_at IS NULL OR om.access_starts_at <= ?)
		   AND (om.role = 'owner' OR om.access_expires_at IS NULL OR om.access_expires_at > ?)
		 LIMIT 1`,
	).bind(orgId, recipientUserId, now, now).first();
	if (!recipient) {
		throw new LifecycleError("invalid_recipient", "The recipient must be an active member of this project's organization.", 409);
	}
	const nameCollision = await env.DB.prepare(
		`SELECT 1 AS hit FROM managed_projects
		  WHERE owner_user_id = ? AND status = 'active' AND name_normalized = ? AND id != ? LIMIT 1`,
	).bind(recipientUserId, row.name_normalized, projectId).first();
	if (nameCollision) {
		throw new LifecycleError("project_name_exists_for_recipient", "The new owner already has an active project with this name. Rename one first.", 409);
	}

	const statements = [
		capabilityGuardStatement(env, {
			actorUserId, orgId, projectId, capability: "project.transfer", now,
		}),
		// The recipient must STILL be an active member of this organization at
		// commit time — a concurrent removal makes the whole batch fail.
		env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
			   SELECT 1 FROM users u
			    JOIN organization_members om ON om.org_id = ? AND om.user_id = u.id
			   WHERE u.id = ? AND u.status = 'active'
			     AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
			 )`,
		).bind(orgId, recipientUserId),
		env.DB.prepare(
			`UPDATE managed_projects
			 SET owner_user_id = ?, organization_id = ?,
			     lifecycle_epoch = lifecycle_epoch + 1, lifecycle_updated_at = ?, updated_at = ?
			 WHERE id = ? AND owner_user_id = ? AND status = 'active'
			   AND created_at = ? AND updated_at = ? AND memory_owner_user_id = ?`,
		).bind(
			recipientUserId, orgId, now, Math.max(now, Number(row.updated_at) + 1),
			projectId, row.owner_user_id, row.created_at, row.updated_at, row.memory_owner_user_id,
		),
		// Exactly-one-owner with no zero-owner interval: owner_user_id is a
		// single NOT NULL column swapped in one statement. The old owner keeps
		// admin access by policy.
		env.DB.prepare(
			`INSERT INTO project_members (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'admin', NULL, ?, ?)
			 ON CONFLICT(project_id, user_id) DO UPDATE SET role = 'admin', org_id = excluded.org_id, updated_at = excluded.updated_at`,
		).bind(newId("pmem"), projectId, orgId, row.owner_user_id, now, now),
		// Postcondition: the swap happened and storage identity is untouched.
		env.DB.prepare(
			`INSERT INTO fence_guard (violation)
			 SELECT 1 WHERE NOT EXISTS (
			   SELECT 1 FROM managed_projects
			    WHERE id = ? AND owner_user_id = ? AND memory_owner_user_id = ? AND status = 'active'
			 )`,
		).bind(projectId, recipientUserId, row.memory_owner_user_id),
	];
	try {
		await env.DB.batch(statements);
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			throw new LifecycleError("transfer_conflict", "The project, your role, or the recipient changed while transferring. Reload and try again.", 409);
		}
		throw error;
	}
	await writeAudit(env, {
		orgId, projectId, actorUserId,
		action: "project.lifecycle.transfer.completed",
		targetType: "project", targetId: projectId,
		outcome: "ok",
		metadata: { previous_owner: row.owner_user_id, new_owner: recipientUserId },
		requestId,
	});
	const fresh = await loadProject(env, projectId);
	return {
		project: {
			id: fresh.id,
			name: fresh.name,
			owner_user_id: fresh.owner_user_id,
			organization_id: fresh.organization_id,
			memory_owner_user_id: fresh.memory_owner_user_id,
			lifecycle_epoch: Number(fresh.lifecycle_epoch ?? 0),
			revision: await projectRevision(fresh),
		},
		previous_owner_role: "admin",
	};
}
