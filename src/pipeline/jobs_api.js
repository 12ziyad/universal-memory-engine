/**
 * Job visibility (fix round 1, Part 2) — the public answer to "what happened
 * to my save?". The packet id every receipt carries is the handle; these
 * helpers turn the memory_jobs ledger into API responses.
 */

import { normalizeDeliveryMetadata } from "../lib/ingest_contract.mjs";

const ACCEPT_TIME_TYPES = ["extract", "mcp_enrich"];

// SRV-08/SRV-09: work cancelled by a confirmed erasure settles as terminal
// `failed` with the cancellation named in `error`. The status STAYS `failed`
// on purpose — A10 proved that a new terminal word would hang the poller in
// every shipped 0.2.1 SDK, whose TERMINAL_JOB_STATUSES set is closed. So the
// distinction is published as its own field instead of a new state.
const CANCELLED_BY_DELETE = "cancelled_by_delete";
const cancelledByDelete = (row) => String(row?.error ?? "").startsWith(CANCELLED_BY_DELETE);

function shapeJob(row) {
	let payload = {};
	try { payload = JSON.parse(row.payload_json ?? "{}") ?? {}; } catch {}
	const saved = payload.saved ?? {};
	const counts = {
		nodes: Number(saved.nodes ?? payload.nodes ?? 0),
		edges: Number(saved.edges ?? payload.edges ?? 0),
		slices: Number(saved.slices ?? payload.slices ?? 0),
		events: Number(saved.events ?? payload.events ?? 0),
		pages: Number(saved.pages ?? (payload.pageId && !payload.page_deleted ? 1 : 0)),
	};
	return {
		job_id: row.id,
		source_packet_id: row.source_packet_id ?? null,
		status: row.status,
		type: row.type,
		lane: payload.lane ?? (row.type === "mcp_enrich" ? "mcp_save" : null),
		project_id: payload.project_id ?? null,
		project_name: payload.project_name ?? null,
		delivery: normalizeDeliveryMetadata(payload.delivery),
		attempts: Number(row.attempts ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at,
		completed_at: row.completed_at ?? null,
		receipt_id: row.receipt_id ?? null,
		counts,
		remaining_messages: Array.isArray(payload.remaining) ? payload.remaining.length : null,
		// Machine-readable reason, so "was this cancelled by my own delete?" is a
		// field lookup rather than a substring hunt over an error string.
		cancelled_by_delete: cancelledByDelete(row),
		outcome_reason: cancelledByDelete(row) ? CANCELLED_BY_DELETE : null,
		...(row.error ? { error: row.error } : {}),
	};
}

/** Status for one accepted packet. Unknown id → null (the route 404s). */
export async function packetStatus(env, userId, sourcePacketId) {
	if (!sourcePacketId) return null;
	const row = await env.DB.prepare(
		`SELECT * FROM memory_jobs
		 WHERE user_id = ? AND source_packet_id = ? AND type IN (${ACCEPT_TIME_TYPES.map(() => "?").join(",")})
		 ORDER BY created_at DESC LIMIT 1`,
	).bind(userId, sourcePacketId, ...ACCEPT_TIME_TYPES).first();
	return row ? shapeJob(row) : null;
}

/** Jobs listing for integrators: ?status=&since=&limit=&cancelled= (scoped to the caller). */
export async function listJobs(env, userId, { status, since, limit, cancelled } = {}) {
	const clauses = ["user_id = ?", `type IN (${ACCEPT_TIME_TYPES.map(() => "?").join(",")})`];
	const binds = [userId, ...ACCEPT_TIME_TYPES];
	if (status) {
		clauses.push("status = ?");
		binds.push(String(status));
	}
	// `cancelled` separates the two things that both land on `failed`: work the
	// user's own erasure cancelled, and work that actually went wrong. An
	// operator triaging failures needs to exclude the first; someone auditing an
	// erasure needs exactly the first.
	if (cancelled === true) clauses.push(`error LIKE '${CANCELLED_BY_DELETE}%'`);
	if (cancelled === false) clauses.push(`(error IS NULL OR error NOT LIKE '${CANCELLED_BY_DELETE}%')`);
	const sinceMs = Number(since);
	if (Number.isFinite(sinceMs) && sinceMs > 0) {
		clauses.push("created_at >= ?");
		binds.push(sinceMs);
	}
	const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
	const { results } = await env.DB.prepare(
		`SELECT * FROM memory_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
	).bind(...binds, cap).all();
	return (results ?? []).map(shapeJob);
}

/** Queue-health counters for the admin dashboard (Part 2.4). */
export async function queueCounters(env) {
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;
	const [active, failed24, unparseable] = await env.DB.batch([
		env.DB.prepare(
			`SELECT COUNT(*) AS n, MIN(created_at) AS oldest
			 FROM memory_jobs WHERE status IN ('queued', 'staged', 'processing')`,
		),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'failed' AND completed_at > ?",
		).bind(now - dayMs),
		// edge_pass_unparseable rate: receipts whose detail records the edge
		// pass failing to parse, over save receipts, last 24h.
		env.DB.prepare(
			`SELECT
				SUM(CASE WHEN detail LIKE '%edge_pass_unparseable%' THEN 1 ELSE 0 END) AS bad,
				COUNT(*) AS total
			 FROM receipts
			 WHERE created_at > ? AND outcome IN ('wrote', 'meaningful_no_write')`,
		).bind(now - dayMs),
	]);
	const activeRow = active.results?.[0] ?? {};
	const parseRow = unparseable.results?.[0] ?? {};
	return {
		queue_depth: Number(activeRow.n ?? 0),
		oldest_pending_age_s: activeRow.oldest ? Math.round((now - Number(activeRow.oldest)) / 1000) : 0,
		failed_24h: Number(failed24.results?.[0]?.n ?? 0),
		edge_pass_unparseable_24h: {
			unparseable: Number(parseRow.bad ?? 0),
			saves: Number(parseRow.total ?? 0),
			rate: Number(parseRow.total) > 0 ? Number(parseRow.bad ?? 0) / Number(parseRow.total) : 0,
		},
	};
}
