/**
 * Memories workspace — the read surface behind the Memories page's three
 * views (Memories, Sources, Suggestions) and the inspector's satellites.
 *
 * Everything here is a SELECT. Mutations stay where their barriers already
 * live: pipeline/cleanup.js (archive/delete), pipeline/candidates.js
 * (keep/merge/reject), and the save doors. The module's contract:
 *
 *  - user_id is the isolation boundary, exactly as /v1/graph and the
 *    dashboard treat it: a managed project resolves to its own memory owner
 *    id before any query here runs, so no query can cross projects.
 *  - Every list is keyset-paginated behind an opaque cursor that names the
 *    sort it belongs to; a cursor replayed against a different sort or view
 *    is rejected rather than reinterpreted.
 *  - Satellites (evidence, timeline, connections, source memories, source
 *    evidence) each have their own bounded cursor. Nothing embeds an
 *    unbounded collection in a detail response.
 *  - No response contains raw_meta_json, signed URLs, or secret-bearing
 *    metadata. Evidence text comes only from columns that were scrubbed and
 *    rules-filtered before they were written (source_snippet, source_episodes
 *    .text, memory_pages.evidence_json).
 */

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
const SATELLITE_LIMIT_DEFAULT = 20;
const SATELLITE_LIMIT_MAX = 50;
const QUERY_MAX_CHARS = 200;
const AZ_KEY_MAX_CHARS = 120;
const PAGE_MARKDOWN_CAP = 20_000;
const PREVIEW_CAP = 160;
const EVIDENCE_JSON_CAP = 200;

export const WORKSPACE_KINDS = Object.freeze(["node", "page", "slice", "event"]);
const KIND_SET = new Set(WORKSPACE_KINDS);
const LIFECYCLES = new Set(["active", "superseded", "archived"]);
const SORTS = new Set(["updated_desc", "updated_asc", "az"]);
const WINDOWS = Object.freeze({ "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 });
const SOURCE_STATES = new Set(["processing", "processed", "failed", "recorded"]);
const SUGGESTION_STATUSES = new Set(["pending", "reviewed", "all"]);

/** Human labels for slice kinds — the DETAIL row's semantic type. */
const SLICE_KIND_LABELS = Object.freeze({
	feature_detail: "Detail",
	technical_detail: "Technical detail",
	progress: "Progress",
	blocker: "Blocker",
	fix: "Fix",
	decision: "Decision",
	preference: "Preference",
	other: "Detail",
});

/** Human labels for packet source modes — the SOURCE row's KIND column. */
const SOURCE_MODE_LABELS = Object.freeze({
	manual_direct: "Manual note",
	manual_collect: "Conversation",
	conversation_collect: "Conversation",
	conversation: "Conversation",
	mcp_save: "Tool save",
	ingest: "Ingest",
	auto_ingest: "Ingest",
	bounded_recall: "Recall",
	plugin: "Plugin capture",
});

function escapeLike(text) {
	return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clampText(value, cap) {
	const text = value == null ? null : String(value);
	if (!text) return null;
	return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/* ---------------------------------------------------------------------------
 * Opaque cursors. `v2:<scope>:<sort>:<key>:<id>` base64url-encoded. The scope
 * and sort are validated on decode so a cursor cannot be replayed against a
 * different list or ordering; the key is a timestamp for time sorts and a
 * capped text prefix for the A–Z sort.
 * ------------------------------------------------------------------------- */

export function encodeWorkspaceCursor(scope, sort, key, id) {
	const keyText = sort === "az"
		? encodeURIComponent(String(key).slice(0, AZ_KEY_MAX_CHARS))
		: String(Number(key) || 0);
	const raw = `v2:${scope}:${sort}:${keyText}:${id}`;
	return btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeWorkspaceCursor(cursor, scope, sort) {
	try {
		const b64 = String(cursor).replace(/-/g, "+").replace(/_/g, "/");
		const raw = decodeURIComponent(escape(atob(b64)));
		const match = /^v2:([a-z_]+):([a-z_]+):([^:]*):(.+)$/.exec(raw);
		if (!match) return null;
		if (match[1] !== scope || match[2] !== sort) return null;
		if (sort === "az") return { key: decodeURIComponent(match[3]), id: match[4] };
		const ts = Number(match[3]);
		if (!Number.isSafeInteger(ts)) return null;
		return { key: ts, id: match[4] };
	} catch {
		return null;
	}
}

function normalizeLimit(limit, fallback, max) {
	if (limit == null || limit === "") return fallback;
	const value = Number(limit);
	if (!Number.isSafeInteger(value) || value < 1 || value > max) return null;
	return value;
}

/**
 * Validate the inventory query surface once. Returns { error, message } or
 * normalized options.
 */
export function parseWorkspaceListOptions(params = {}) {
	const kinds = [];
	if (params.kind != null && params.kind !== "" && params.kind !== "all") {
		for (const piece of String(params.kind).split(",")) {
			const kind = piece.trim();
			if (!kind) continue;
			if (!KIND_SET.has(kind)) return { error: "invalid_kind", message: "kind must be a comma list of: node, page, slice, event." };
			if (!kinds.includes(kind)) kinds.push(kind);
		}
	}
	let lifecycle = null;
	if (params.lifecycle != null && params.lifecycle !== "" && params.lifecycle !== "all") {
		lifecycle = String(params.lifecycle);
		if (!LIFECYCLES.has(lifecycle)) return { error: "invalid_lifecycle", message: "lifecycle must be one of: active, superseded, archived." };
	}
	const sort = params.sort == null || params.sort === "" ? "updated_desc" : String(params.sort);
	if (!SORTS.has(sort)) return { error: "invalid_sort", message: "sort must be one of: updated_desc, updated_asc, az." };
	let windowMs = null;
	if (params.updatedWithin != null && params.updatedWithin !== "" && params.updatedWithin !== "any") {
		windowMs = WINDOWS[String(params.updatedWithin)];
		if (!windowMs) return { error: "invalid_window", message: "updatedWithin must be one of: 24h, 7d, 30d." };
	}
	const limit = normalizeLimit(params.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
	if (limit === null) return { error: "invalid_limit", message: `limit must be an integer between 1 and ${LIST_LIMIT_MAX}.` };
	let cursor = null;
	if (params.cursor != null && params.cursor !== "") {
		cursor = decodeWorkspaceCursor(params.cursor, "inv", sort);
		if (!cursor) return { error: "invalid_cursor", message: "cursor is not valid for this list and sort." };
	}
	const q = params.q == null ? null : String(params.q).trim().slice(0, QUERY_MAX_CHARS) || null;
	const categoryId = params.categoryId == null ? null : String(params.categoryId).trim() || null;
	const sourceId = params.sourceId == null ? null : String(params.sourceId).trim() || null;
	if (categoryId && !/^[A-Za-z0-9_-]{1,80}$/.test(categoryId)) {
		return { error: "invalid_category", message: "categoryId is not a valid category id." };
	}
	if (sourceId && !/^[A-Za-z0-9:_-]{1,120}$/.test(sourceId)) {
		return { error: "invalid_source", message: "sourceId is not a valid source id." };
	}
	return { kinds: kinds.length ? kinds : [...WORKSPACE_KINDS], lifecycle, sort, windowMs, limit, cursor, q, categoryId, sourceId };
}

/* ---------------------------------------------------------------------------
 * Inventory: nodes + pages + slices + events as one keyset-merged list.
 * ------------------------------------------------------------------------- */

const NODE_SORT = "COALESCE(t.updated_at, t.created_at, 0)";
const PAGE_SORT = "COALESCE(t.updated_at, t.created_at, 0)";
const SLICE_SORT = "COALESCE(t.last_seen_at, t.created_at, 0)";
const EVENT_SORT = "COALESCE(t.happened_at, t.created_at, 0)";

/** One correlated lookup: the packet that produced a linked object. */
const LINK_PACKET = (kind) => `(
	SELECT l.source_packet_id FROM memory_source_links l
	 WHERE l.user_id = t.user_id AND l.object_kind = '${kind}' AND l.object_id = t.id
	 ORDER BY l.created_at DESC LIMIT 1)`;

function branchSql({ kind, sort, lifecycle, windowMs, q, categoryId, sourceId, cursor, now }) {
	const azKey = {
		node: "t.label",
		page: "t.title",
		slice: "t.text",
		event: "t.text",
	}[kind];
	const sortExpr = { node: NODE_SORT, page: PAGE_SORT, slice: SLICE_SORT, event: EVENT_SORT }[kind];
	// The A–Z key is truncated IN SQL to the same cap the cursor stores, so the
	// keyset comparison and the stored cursor always speak about identical
	// values; ties beyond the cap break deterministically on id. Comparing the
	// full text against a truncated cursor key would re-match the same row
	// forever on texts longer than the cap.
	const key = sort === "az" ? `substr(COALESCE(${azKey}, ''), 1, ${AZ_KEY_MAX_CHARS})` : sortExpr;
	const direction = sort === "updated_asc" || sort === "az" ? "ASC" : "DESC";
	const cmp = direction === "ASC" ? ">" : "<";

	const clauses = ["t.user_id = ?", "t.deleted_at IS NULL"];
	const binds = [];
	if (kind === "node" || kind === "page") {
		clauses.push("t.suppressed_at IS NULL");
		if (lifecycle === "archived") clauses.push("t.archived_at IS NOT NULL");
		else if (lifecycle === "active") clauses.push("t.archived_at IS NULL");
		else if (lifecycle === "superseded") clauses.push("1 = 0");
	}
	if (kind === "slice") {
		if (lifecycle === "archived") clauses.push("1 = 0");
		else if (lifecycle === "active") clauses.push("t.is_current = 1");
		else if (lifecycle === "superseded") clauses.push("t.is_current = 0");
	}
	if (kind === "event") {
		if (lifecycle === "archived") clauses.push("1 = 0");
		else if (lifecycle === "active") clauses.push("t.invalid_at IS NULL");
		else if (lifecycle === "superseded") clauses.push("t.invalid_at IS NOT NULL");
	}
	if (windowMs) {
		clauses.push(`${sortExpr} >= ?`);
		binds.push(now - windowMs);
	}
	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		const columns = {
			node: ["t.label", "t.summary"],
			page: ["t.title", "t.short_summary"],
			slice: ["t.text"],
			event: ["t.text"],
		}[kind];
		clauses.push(`(${columns.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")} OR t.id = ?)`);
		for (let i = 0; i < columns.length; i++) binds.push(pattern);
		binds.push(q);
	}
	if (categoryId) {
		if (kind === "node" || kind === "page") {
			clauses.push("t.project_category_id = ?");
			binds.push(categoryId);
		} else {
			// Details and events inherit their parent node's category.
			clauses.push(`EXISTS (SELECT 1 FROM nodes n
				WHERE n.id = t.node_id AND n.user_id = t.user_id AND n.project_category_id = ?)`);
			binds.push(categoryId);
		}
	}
	if (sourceId) {
		if (kind === "page") {
			clauses.push("t.source_packet_id = ?");
			binds.push(sourceId);
		} else {
			clauses.push(`EXISTS (SELECT 1 FROM memory_source_links l
				WHERE l.user_id = t.user_id AND l.object_kind = '${kind}' AND l.object_id = t.id
				  AND l.source_packet_id = ?)`);
			binds.push(sourceId);
		}
	}
	if (cursor) {
		clauses.push(`(${key} ${cmp} ? OR (${key} = ? AND t.id ${cmp} ?))`);
		binds.push(cursor.key, cursor.key, cursor.id);
	}

	const select = {
		node: `SELECT t.id, 'node' AS kind, t.label AS text, t.summary AS secondary, t.category AS category,
			t.project_category_id, t.state AS object_state, t.archived_at, NULL AS is_current, NULL AS invalid_at,
			NULL AS slice_kind, NULL AS event_action, NULL AS node_id, t.project_id,
			${LINK_PACKET("node")} AS source_packet_id, ${NODE_SORT} AS sort_ts, ${key} AS sort_key`,
		page: `SELECT t.id, 'page' AS kind, t.title AS text, t.short_summary AS secondary, t.topic_filter AS category,
			t.project_category_id, NULL AS object_state, t.archived_at, NULL AS is_current, NULL AS invalid_at,
			NULL AS slice_kind, NULL AS event_action, NULL AS node_id, t.project_id,
			t.source_packet_id, ${PAGE_SORT} AS sort_ts, ${key} AS sort_key`,
		slice: `SELECT t.id, 'slice' AS kind, t.text AS text, NULL AS secondary, NULL AS category,
			NULL AS project_category_id, NULL AS object_state, NULL AS archived_at, t.is_current, NULL AS invalid_at,
			t.kind AS slice_kind, NULL AS event_action, t.node_id, t.project_id,
			${LINK_PACKET("slice")} AS source_packet_id, ${SLICE_SORT} AS sort_ts, ${key} AS sort_key`,
		event: `SELECT t.id, 'event' AS kind, t.text AS text, NULL AS secondary, NULL AS category,
			NULL AS project_category_id, NULL AS object_state, NULL AS archived_at, NULL AS is_current, t.invalid_at,
			NULL AS slice_kind, t.action AS event_action, t.node_id, t.project_id,
			${LINK_PACKET("event")} AS source_packet_id, ${EVENT_SORT} AS sort_ts, ${key} AS sort_key`,
	}[kind];
	const table = { node: "nodes", page: "memory_pages", slice: "slices", event: "events" }[kind];
	const fromWhere = `FROM ${table} t WHERE ${clauses.join(" AND ")}`;
	return {
		sql: `${select} ${fromWhere} ORDER BY sort_key ${direction}, t.id ${direction} LIMIT ?`,
		// The count variant is assembled here, not by slicing the list SQL —
		// the select columns contain correlated subqueries with their own FROMs.
		countSql: `SELECT COUNT(*) AS count ${fromWhere}`,
		binds,
	};
}

function lifecycleOf(row) {
	if (row.kind === "node" || row.kind === "page") return row.archived_at ? "archived" : "active";
	if (row.kind === "slice") return Number(row.is_current) === 1 ? "active" : "superseded";
	return row.invalid_at ? "superseded" : "active";
}

function semanticTypeOf(row) {
	if (row.kind === "node") return "Entity";
	if (row.kind === "page") return "Page";
	if (row.kind === "event") return "Event";
	return SLICE_KIND_LABELS[row.slice_kind] ?? "Detail";
}

function sourceTitleOf(packet) {
	if (!packet) return null;
	return clampText(packet.topic, PREVIEW_CAP)
		?? clampText(packet.conversation_id ? `Conversation ${packet.conversation_id}` : null, PREVIEW_CAP)
		?? clampText(packet.content_preview, PREVIEW_CAP)
		?? packet.id;
}

function sourceKindOf(packet) {
	if (!packet) return null;
	return SOURCE_MODE_LABELS[packet.source_mode] ?? SOURCE_MODE_LABELS[packet.source_type] ?? "Save";
}

/** Batch-load packets by id (page-bounded, so the IN list is bounded). */
async function packetsById(env, userId, ids) {
	const distinct = [...new Set(ids.filter(Boolean))];
	if (!distinct.length) return new Map();
	const marks = distinct.map(() => "?").join(",");
	const { results } = await env.DB.prepare(
		`SELECT id, topic, conversation_id, content_preview, source_type, source_mode
		 FROM source_packets WHERE user_id = ? AND id IN (${marks})`,
	).bind(userId, ...distinct).all();
	return new Map((results ?? []).map((row) => [row.id, row]));
}

/** Batch-load node labels (parent context for slices/events). */
async function nodeLabelsById(env, userId, ids) {
	const distinct = [...new Set(ids.filter(Boolean))];
	if (!distinct.length) return new Map();
	const marks = distinct.map(() => "?").join(",");
	const { results } = await env.DB.prepare(
		`SELECT id, label FROM nodes WHERE user_id = ? AND id IN (${marks})`,
	).bind(userId, ...distinct).all();
	return new Map((results ?? []).map((row) => [row.id, row.label]));
}

async function categoryNamesById(env, userId, ids) {
	const distinct = [...new Set(ids.filter(Boolean))];
	if (!distinct.length) return new Map();
	const marks = distinct.map(() => "?").join(",");
	const { results } = await env.DB.prepare(
		`SELECT id, name FROM project_categories WHERE memory_owner_user_id = ? AND id IN (${marks})`,
	).bind(userId, ...distinct).all();
	return new Map((results ?? []).map((row) => [row.id, row.name]));
}

async function decorateInventoryRows(env, userId, rows) {
	const [packets, labels, categories] = await Promise.all([
		packetsById(env, userId, rows.map((row) => row.source_packet_id)),
		nodeLabelsById(env, userId, rows.map((row) => row.node_id)),
		categoryNamesById(env, userId, rows.map((row) => row.project_category_id)),
	]);
	return rows.map((row) => {
		const packet = row.source_packet_id ? packets.get(row.source_packet_id) ?? null : null;
		const contextBits = [];
		if (row.node_id && labels.get(row.node_id)) contextBits.push(labels.get(row.node_id));
		if (row.kind === "node" && row.category) contextBits.push(row.category);
		if (row.project_category_id && categories.get(row.project_category_id)) {
			contextBits.push(categories.get(row.project_category_id));
		}
		return {
			id: row.id,
			kind: row.kind,
			semantic_type: semanticTypeOf(row),
			text: row.text ?? "",
			secondary: clampText(row.secondary, PREVIEW_CAP),
			context: contextBits.length ? contextBits.join(" · ") : null,
			lifecycle: lifecycleOf(row),
			source: packet ? { id: packet.id, title: sourceTitleOf(packet), kind: sourceKindOf(packet) } : null,
			node_id: row.node_id ?? null,
			project_id: row.project_id ?? null,
			updated_at: row.sort_ts || null,
		};
	});
}

export async function listWorkspaceMemories(env, userId, options) {
	const { kinds, lifecycle, sort, windowMs, limit, cursor, q, categoryId, sourceId } = options;
	const now = Date.now();
	const statements = kinds.map((kind) => {
		const branch = branchSql({ kind, sort, lifecycle, windowMs, q, categoryId, sourceId, cursor, now });
		return env.DB.prepare(branch.sql).bind(userId, ...branch.binds, limit + 1);
	});
	const batched = await env.DB.batch(statements);
	const merged = [];
	for (const result of batched) for (const row of result.results ?? []) merged.push(row);

	const ascending = sort === "updated_asc" || sort === "az";
	merged.sort((a, b) => {
		let cmp;
		if (sort === "az") {
			// Plain ordinal comparison, to match SQLite's BINARY collation — the
			// per-branch keysets and this merge must agree on one ordering or a
			// page boundary could duplicate or skip a row.
			const ak = String(a.sort_key);
			const bk = String(b.sort_key);
			cmp = ak < bk ? -1 : ak > bk ? 1 : 0;
		} else cmp = Number(a.sort_key) - Number(b.sort_key);
		if (cmp === 0) cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		return ascending ? cmp : -cmp;
	});

	const hasMore = merged.length > limit;
	const rows = merged.slice(0, limit);
	const items = await decorateInventoryRows(env, userId, rows);
	const last = rows.at(-1);
	return {
		items,
		count: items.length,
		next_cursor: hasMore && last
			? encodeWorkspaceCursor("inv", sort, sort === "az" ? String(last.sort_key) : Number(last.sort_key), last.id)
			: null,
	};
}

/**
 * Exact totals for the current filter set (bounded per-table COUNTs), so the
 * result line can say "n results" without shipping every row.
 */
export async function countWorkspaceMemories(env, userId, options) {
	const { kinds, lifecycle, windowMs, q, categoryId, sourceId } = options;
	const now = Date.now();
	const statements = kinds.map((kind) => {
		const branch = branchSql({
			kind, sort: "updated_desc", lifecycle, windowMs, q, categoryId, sourceId, cursor: null, now,
		});
		return env.DB.prepare(branch.countSql).bind(userId, ...branch.binds);
	});
	const batched = await env.DB.batch(statements);
	let total = 0;
	const byKind = {};
	kinds.forEach((kind, index) => {
		const count = Number(batched[index]?.results?.[0]?.count ?? 0);
		byKind[kind] = count;
		total += count;
	});
	return { total, by_kind: byKind };
}

/** The three view tab counts, from real rows. */
export async function workspaceCounts(env, userId) {
	const [memories, sources, suggestions] = await env.DB.batch([
		env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL)
				+ (SELECT COUNT(*) FROM memory_pages WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL)
				+ (SELECT COUNT(*) FROM slices WHERE user_id = ?1 AND deleted_at IS NULL)
				+ (SELECT COUNT(*) FROM events WHERE user_id = ?1 AND deleted_at IS NULL) AS count`,
		).bind(userId),
		env.DB.prepare(
			"SELECT COUNT(*) AS count FROM source_packets WHERE user_id = ? AND source_type != 'query'",
		).bind(userId),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM candidates
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
			   AND COALESCE(status, 'pending') = 'pending'`,
		).bind(userId),
	]);
	return {
		memories: Number(memories.results[0]?.count ?? 0),
		sources: Number(sources.results[0]?.count ?? 0),
		suggestions: Number(suggestions.results[0]?.count ?? 0),
	};
}

/**
 * Filter facets with real counts: semantic kinds, project categories, the 25
 * most recently used sources, and lifecycle. Bounded GROUP BYs on indexed
 * predicates only.
 */
export async function workspaceFacets(env, userId) {
	const [kinds, categories, sources, lifecycle] = await env.DB.batch([
		env.DB.prepare(
			`SELECT 'node' AS kind, COUNT(*) AS count FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL
			 UNION ALL SELECT 'page', COUNT(*) FROM memory_pages WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL
			 UNION ALL SELECT 'slice', COUNT(*) FROM slices WHERE user_id = ?1 AND deleted_at IS NULL
			 UNION ALL SELECT 'event', COUNT(*) FROM events WHERE user_id = ?1 AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT c.id, c.name,
				(SELECT COUNT(*) FROM nodes n WHERE n.user_id = ?1 AND n.project_category_id = c.id AND n.deleted_at IS NULL AND n.suppressed_at IS NULL)
				+ (SELECT COUNT(*) FROM memory_pages p WHERE p.user_id = ?1 AND p.project_category_id = c.id AND p.deleted_at IS NULL AND p.suppressed_at IS NULL) AS count
			 FROM project_categories c
			 WHERE c.memory_owner_user_id = ?1 AND c.status = 'active'
			 ORDER BY c.name LIMIT 32`,
		).bind(userId),
		env.DB.prepare(
			`SELECT p.id, p.topic, p.conversation_id, p.content_preview, p.source_type, p.source_mode,
				(SELECT COUNT(*) FROM memory_source_links l WHERE l.user_id = p.user_id AND l.source_packet_id = p.id)
				+ (SELECT COUNT(*) FROM memory_pages mp WHERE mp.user_id = p.user_id AND mp.source_packet_id = p.id AND mp.deleted_at IS NULL) AS count
			 FROM source_packets p
			 WHERE p.user_id = ?1 AND p.source_type != 'query'
			 ORDER BY COALESCE(p.updated_at, p.created_at, 0) DESC LIMIT 25`,
		).bind(userId),
		env.DB.prepare(
			`SELECT 'archived' AS state, COUNT(*) AS count FROM (
				SELECT id FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL AND archived_at IS NOT NULL
				UNION ALL SELECT id FROM memory_pages WHERE user_id = ?1 AND deleted_at IS NULL AND suppressed_at IS NULL AND archived_at IS NOT NULL)
			 UNION ALL SELECT 'superseded', COUNT(*) FROM (
				SELECT id FROM slices WHERE user_id = ?1 AND deleted_at IS NULL AND is_current = 0
				UNION ALL SELECT id FROM events WHERE user_id = ?1 AND deleted_at IS NULL AND invalid_at IS NOT NULL)`,
		).bind(userId),
	]);
	const kindCounts = {};
	for (const row of kinds.results ?? []) kindCounts[row.kind] = Number(row.count ?? 0);
	const lifecycleCounts = { superseded: 0, archived: 0 };
	for (const row of lifecycle.results ?? []) lifecycleCounts[row.state] = Number(row.count ?? 0);
	const total = Object.values(kindCounts).reduce((sum, n) => sum + n, 0);
	lifecycleCounts.active = total - lifecycleCounts.superseded - lifecycleCounts.archived;
	return {
		kinds: kindCounts,
		categories: (categories.results ?? []).map((row) => ({ id: row.id, name: row.name, count: Number(row.count ?? 0) })),
		sources: (sources.results ?? []).map((row) => ({
			id: row.id,
			title: sourceTitleOf(row),
			kind: sourceKindOf(row),
			count: Number(row.count ?? 0),
		})),
		lifecycle: lifecycleCounts,
	};
}

/* ---------------------------------------------------------------------------
 * Memory detail + satellites.
 * ------------------------------------------------------------------------- */

function workspaceKindOfId(id) {
	if (id.startsWith("node_")) return "node";
	if (id.startsWith("page_")) return "page";
	if (id.startsWith("slice_")) return "slice";
	if (id.startsWith("event_")) return "event";
	return null;
}

async function packetSummaryFor(env, userId, packetId) {
	if (!packetId) return null;
	const packet = await env.DB.prepare(
		`SELECT id, topic, conversation_id, content_preview, source_type, source_mode
		 FROM source_packets WHERE user_id = ? AND id = ?`,
	).bind(userId, packetId).first();
	return packet ? { id: packet.id, title: sourceTitleOf(packet), kind: sourceKindOf(packet) } : null;
}

async function linkedPacketId(env, userId, kind, id) {
	const row = await env.DB.prepare(
		`SELECT source_packet_id FROM memory_source_links
		 WHERE user_id = ? AND object_kind = ? AND object_id = ?
		 ORDER BY created_at DESC LIMIT 1`,
	).bind(userId, kind, id).first();
	return row?.source_packet_id ?? null;
}

export async function getWorkspaceMemory(env, userId, id) {
	const kind = workspaceKindOfId(id);
	if (!kind) return { error: "unrecognized_id" };

	if (kind === "node") {
		const row = await env.DB.prepare(
			`SELECT id, label, category, state, summary, cluster, project_id, project_category_id,
				archived_at, created_at, updated_at, COALESCE(revision, 1) AS revision
			 FROM nodes WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		const [counts, packetId, categories] = await Promise.all([
			env.DB.batch([
				env.DB.prepare(
					`SELECT COUNT(*) AS count FROM (
						SELECT id FROM slices WHERE user_id = ?1 AND node_id = ?2 AND deleted_at IS NULL AND source_snippet IS NOT NULL
						UNION ALL SELECT id FROM events WHERE user_id = ?1 AND node_id = ?2 AND deleted_at IS NULL AND source_snippet IS NOT NULL)`,
				).bind(userId, id),
				env.DB.prepare(
					"SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL",
				).bind(userId, id),
				env.DB.prepare(
					"SELECT COUNT(*) AS count FROM edges WHERE user_id = ? AND deleted_at IS NULL AND (from_node = ?2 OR to_node = ?2)",
				).bind(userId, id),
			]),
			linkedPacketId(env, userId, "node", id),
			categoryNamesById(env, userId, [row.project_category_id]),
		]);
		return {
			kind,
			memory: {
				id: row.id,
				kind: "node",
				semantic_type: "Entity",
				revision: Number(row.revision ?? 1),
				editable: row.archived_at ? false : true,
				text: row.label ?? "",
				summary: row.summary ?? null,
				category: row.category ?? null,
				cluster: row.cluster ?? null,
				project_category: row.project_category_id
					? { id: row.project_category_id, name: categories.get(row.project_category_id) ?? null }
					: null,
				lifecycle: row.archived_at ? "archived" : "active",
				project_id: row.project_id ?? null,
				source: await packetSummaryFor(env, userId, packetId),
				created_at: row.created_at ?? null,
				updated_at: row.updated_at ?? row.created_at ?? null,
				evidence_count: Number(counts[0].results[0]?.count ?? 0),
				timeline_count: Number(counts[1].results[0]?.count ?? 0),
				connections_count: Number(counts[2].results[0]?.count ?? 0),
			},
		};
	}

	if (kind === "page") {
		const row = await env.DB.prepare(
			`SELECT id, title, topic_filter, short_summary, evidence_json, source_packet_id,
				source_conversation_id, project_id, project_category_id, archived_at,
				created_at, updated_at, full_markdown IS NOT NULL AS has_markdown,
				COALESCE(revision, 1) AS revision
			 FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		let evidenceCount = 0;
		try { evidenceCount = Math.min(JSON.parse(row.evidence_json ?? "[]").length, EVIDENCE_JSON_CAP); } catch {}
		const categories = await categoryNamesById(env, userId, [row.project_category_id]);
		return {
			kind,
			memory: {
				id: row.id,
				kind: "page",
				semantic_type: "Page",
				revision: Number(row.revision ?? 1),
				editable: row.archived_at ? false : true,
				text: row.title ?? "",
				summary: row.short_summary ?? null,
				category: row.topic_filter ?? null,
				project_category: row.project_category_id
					? { id: row.project_category_id, name: categories.get(row.project_category_id) ?? null }
					: null,
				lifecycle: row.archived_at ? "archived" : "active",
				project_id: row.project_id ?? null,
				source: await packetSummaryFor(env, userId, row.source_packet_id),
				source_conversation_id: row.source_conversation_id ?? null,
				created_at: row.created_at ?? null,
				updated_at: row.updated_at ?? row.created_at ?? null,
				evidence_count: evidenceCount,
				timeline_count: 0,
				connections_count: 0,
				has_content: Boolean(row.has_markdown),
			},
		};
	}

	if (kind === "slice") {
		const row = await env.DB.prepare(
			`SELECT id, node_id, text, kind, is_current, source_snippet IS NOT NULL AS has_snippet,
				valid_from, valid_to, project_id, created_at, last_seen_at, COALESCE(revision, 1) AS revision
			 FROM slices WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		const [labels, packetId] = await Promise.all([
			nodeLabelsById(env, userId, [row.node_id]),
			linkedPacketId(env, userId, "slice", id),
		]);
		return {
			kind,
			memory: {
				id: row.id,
				kind: "slice",
				semantic_type: SLICE_KIND_LABELS[row.kind] ?? "Detail",
				revision: Number(row.revision ?? 1),
				editable: Number(row.is_current) === 1,
				slice_kind: row.kind ?? null,
				text: row.text ?? "",
				node: row.node_id ? { id: row.node_id, label: labels.get(row.node_id) ?? null } : null,
				lifecycle: Number(row.is_current) === 1 ? "active" : "superseded",
				valid_from: row.valid_from ?? null,
				valid_to: row.valid_to ?? null,
				project_id: row.project_id ?? null,
				source: await packetSummaryFor(env, userId, packetId),
				created_at: row.created_at ?? null,
				updated_at: row.last_seen_at ?? row.created_at ?? null,
				evidence_count: row.has_snippet ? 1 : 0,
				timeline_count: 0,
				connections_count: 0,
			},
		};
	}

	const row = await env.DB.prepare(
		`SELECT id, node_id, action, text, importance, happened_at, happened_at_source, valid_at, invalid_at,
			event_time_precision, source_snippet IS NOT NULL AS has_snippet, project_id, created_at,
			COALESCE(revision, 1) AS revision
		 FROM events WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
	).bind(id, userId).first();
	if (!row) return null;
	const [labels, packetId] = await Promise.all([
		nodeLabelsById(env, userId, [row.node_id]),
		linkedPacketId(env, userId, "event", id),
	]);
	return {
		kind,
		memory: {
			id: row.id,
			kind: "event",
			semantic_type: "Event",
			revision: Number(row.revision ?? 1),
			editable: true,
			event_action: row.action ?? null,
			text: row.text ?? "",
			node: row.node_id ? { id: row.node_id, label: labels.get(row.node_id) ?? null } : null,
			lifecycle: row.invalid_at ? "superseded" : "active",
			importance: row.importance ?? null,
			happened_at: row.happened_at ?? null,
			happened_at_source: row.happened_at_source ?? null,
			event_time_precision: row.event_time_precision ?? null,
			project_id: row.project_id ?? null,
			source: await packetSummaryFor(env, userId, packetId),
			created_at: row.created_at ?? null,
			updated_at: row.happened_at ?? row.created_at ?? null,
			evidence_count: row.has_snippet ? 1 : 0,
			timeline_count: 0,
			connections_count: 0,
		},
	};
}

function parseSatelliteParams(params, scope) {
	const limit = normalizeLimit(params.limit, SATELLITE_LIMIT_DEFAULT, SATELLITE_LIMIT_MAX);
	if (limit === null) return { error: "invalid_limit", message: `limit must be an integer between 1 and ${SATELLITE_LIMIT_MAX}.` };
	let cursor = null;
	if (params.cursor != null && params.cursor !== "") {
		cursor = decodeWorkspaceCursor(params.cursor, scope, "updated_desc");
		if (!cursor) return { error: "invalid_cursor", message: "cursor is not valid for this list." };
	}
	return { limit, cursor };
}

/**
 * Evidence for one memory. Node evidence is the scrubbed source_snippet
 * excerpts its details and events carry; slice/event evidence is the object's
 * own snippet; page evidence is the page's stored evidence_json. Nothing here
 * reads raw packet metadata.
 */
export async function listWorkspaceEvidence(env, userId, id, params = {}) {
	const kind = workspaceKindOfId(id);
	if (!kind) return { error: "unrecognized_id" };
	const parsed = parseSatelliteParams(params, "ev");
	if (parsed.error) return parsed;
	const { limit, cursor } = parsed;

	if (kind === "node") {
		const clauses = cursor ? "AND (created_at < ?3 OR (created_at = ?3 AND id < ?4))" : "";
		const binds = cursor ? [userId, id, cursor.key, cursor.id] : [userId, id];
		const { results } = await env.DB.prepare(
			`SELECT * FROM (
				SELECT id, 'slice' AS from_kind, kind AS head, source_snippet AS text, created_at
				  FROM slices WHERE user_id = ?1 AND node_id = ?2 AND deleted_at IS NULL AND source_snippet IS NOT NULL
				UNION ALL
				SELECT id, 'event' AS from_kind, action AS head, source_snippet AS text, created_at
				  FROM events WHERE user_id = ?1 AND node_id = ?2 AND deleted_at IS NULL AND source_snippet IS NOT NULL
			) WHERE 1 = 1 ${clauses}
			ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
		).bind(...binds).all();
		const rows = results ?? [];
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return {
			items: page.map((row) => ({
				id: row.id,
				head: String(row.head ?? "").replace(/_/g, " "),
				text: row.text,
				at: row.created_at ?? null,
			})),
			next_cursor: rows.length > limit && last
				? encodeWorkspaceCursor("ev", "updated_desc", Number(last.created_at ?? 0), last.id)
				: null,
		};
	}

	if (kind === "slice" || kind === "event") {
		const table = kind === "slice" ? "slices" : "events";
		const row = await env.DB.prepare(
			`SELECT id, source_snippet, created_at FROM ${table}
			 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		return {
			items: row.source_snippet
				? [{ id: row.id, head: null, text: row.source_snippet, at: row.created_at ?? null }]
				: [],
			next_cursor: null,
		};
	}

	// Page: stored, already-scrubbed evidence segments. The JSON is bounded at
	// write time; the offset cursor keeps each response page small anyway.
	const row = await env.DB.prepare(
		"SELECT evidence_json FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL",
	).bind(id, userId).first();
	if (!row) return null;
	let all = [];
	try { all = JSON.parse(row.evidence_json ?? "[]"); } catch {}
	if (!Array.isArray(all)) all = [];
	all = all.slice(0, EVIDENCE_JSON_CAP);
	const offset = cursor ? Math.max(0, Number(cursor.key) || 0) : 0;
	const page = all.slice(offset, offset + limit);
	return {
		items: page.map((entry, index) => ({
			id: `${id}:ev:${offset + index}`,
			head: entry?.source_type ? String(entry.source_type) : null,
			text: clampText(entry?.snippet ?? "", 600),
			at: Number(entry?.timestamp) || null,
		})),
		next_cursor: offset + limit < all.length
			? encodeWorkspaceCursor("ev", "updated_desc", offset + limit, id)
			: null,
	};
}

/**
 * Timeline for a node: its temporal events, newest first, with real event
 * time semantics (happened_at / source-stated time), never a changelog
 * manufactured from created_at alone. Non-node kinds have no timeline.
 */
export async function listWorkspaceTimeline(env, userId, id, params = {}) {
	const kind = workspaceKindOfId(id);
	if (!kind) return { error: "unrecognized_id" };
	if (kind !== "node") return { items: [], next_cursor: null };
	const parsed = parseSatelliteParams(params, "tl");
	if (parsed.error) return parsed;
	const { limit, cursor } = parsed;
	const sortExpr = "COALESCE(happened_at, created_at, 0)";
	const clauses = ["user_id = ?", "node_id = ?", "deleted_at IS NULL"];
	const binds = [userId, id];
	if (cursor) {
		clauses.push(`(${sortExpr} < ? OR (${sortExpr} = ? AND id < ?))`);
		binds.push(cursor.key, cursor.key, cursor.id);
	}
	const { results } = await env.DB.prepare(
		`SELECT id, action, text, importance, happened_at, happened_at_source, valid_at, invalid_at,
			event_time_precision, created_at, ${sortExpr} AS sort_ts
		 FROM events WHERE ${clauses.join(" AND ")}
		 ORDER BY sort_ts DESC, id DESC LIMIT ?`,
	).bind(...binds, limit + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			action: String(row.action ?? "").replace(/_/g, " ") || null,
			text: row.text ?? "",
			importance: row.importance && row.importance !== "ordinary" ? row.importance : null,
			happened_at: row.happened_at ?? null,
			happened_at_source: row.happened_at_source ?? null,
			time_precision: row.event_time_precision ?? null,
			recorded_at: row.created_at ?? null,
			superseded: Boolean(row.invalid_at),
		})),
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("tl", "updated_desc", Number(last.sort_ts ?? 0), last.id)
			: null,
	};
}

/** Verified relationships touching one node, bounded, with the peer's label. */
export async function listWorkspaceConnections(env, userId, id, params = {}) {
	const kind = workspaceKindOfId(id);
	if (!kind) return { error: "unrecognized_id" };
	if (kind !== "node") return { items: [], next_cursor: null };
	const parsed = parseSatelliteParams(params, "cx");
	if (parsed.error) return parsed;
	const { limit, cursor } = parsed;
	const sortExpr = "COALESCE(e.created_at, 0)";
	const clauses = ["e.user_id = ?1", "e.deleted_at IS NULL", "(e.from_node = ?2 OR e.to_node = ?2)"];
	const binds = [userId, id];
	if (cursor) {
		clauses.push(`(${sortExpr} < ?3 OR (${sortExpr} = ?3 AND e.id < ?4))`);
		binds.push(cursor.key, cursor.id);
	}
	const { results } = await env.DB.prepare(
		`SELECT e.id, e.from_node, e.to_node, e.type, e.fact, e.confidence, e.invalid_at,
			${sortExpr} AS sort_ts,
			(SELECT n.label FROM nodes n WHERE n.id = CASE WHEN e.from_node = ?2 THEN e.to_node ELSE e.from_node END
				AND n.user_id = e.user_id AND n.deleted_at IS NULL) AS other_label
		 FROM edges e WHERE ${clauses.join(" AND ")}
		 ORDER BY sort_ts DESC, e.id DESC LIMIT ${limit + 1}`,
	).bind(...binds).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => {
			const outgoing = row.from_node === id;
			return {
				id: row.id,
				direction: outgoing ? "out" : "in",
				type: String(row.type ?? "").replace(/_/g, " ") || null,
				fact: row.fact ?? null,
				other: { id: outgoing ? row.to_node : row.from_node, label: row.other_label ?? null },
				confidence: typeof row.confidence === "number" ? row.confidence : null,
				state: row.invalid_at ? "superseded" : "active",
			};
		}).filter((item) => item.other.label !== null),
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("cx", "updated_desc", Number(last.sort_ts ?? 0), last.id)
			: null,
	};
}

/* ---------------------------------------------------------------------------
 * Sources.
 * ------------------------------------------------------------------------- */

const PACKET_SORT = "COALESCE(p.updated_at, p.created_at, 0)";
const PACKET_JOB = `(
	SELECT j.status FROM memory_jobs j
	 WHERE j.user_id = p.user_id AND j.source_packet_id = p.id AND j.type IN ('extract', 'mcp_enrich')
	 ORDER BY j.created_at DESC LIMIT 1)`;
const PACKET_STATE = `CASE
	WHEN ${PACKET_JOB} IN ('awaiting_source', 'queued', 'staged', 'processing') THEN 'processing'
	WHEN ${PACKET_JOB} = 'failed' THEN 'failed'
	WHEN ${PACKET_JOB} IN ('enriched', 'completed') THEN 'processed'
	WHEN EXISTS (SELECT 1 FROM memory_source_links l WHERE l.user_id = p.user_id AND l.source_packet_id = p.id)
		OR EXISTS (SELECT 1 FROM memory_pages mp WHERE mp.user_id = p.user_id AND mp.source_packet_id = p.id AND mp.deleted_at IS NULL)
		THEN 'processed'
	ELSE 'recorded' END`;

export function parseWorkspaceSourceOptions(params = {}) {
	let state = null;
	if (params.state != null && params.state !== "" && params.state !== "all") {
		state = String(params.state);
		if (!SOURCE_STATES.has(state)) return { error: "invalid_state", message: "state must be one of: processing, processed, failed, recorded." };
	}
	const sort = params.sort == null || params.sort === "" ? "updated_desc" : String(params.sort);
	if (!["updated_desc", "updated_asc"].includes(sort)) {
		return { error: "invalid_sort", message: "sort must be updated_desc or updated_asc." };
	}
	let windowMs = null;
	if (params.updatedWithin != null && params.updatedWithin !== "" && params.updatedWithin !== "any") {
		windowMs = WINDOWS[String(params.updatedWithin)];
		if (!windowMs) return { error: "invalid_window", message: "updatedWithin must be one of: 24h, 7d, 30d." };
	}
	const limit = normalizeLimit(params.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
	if (limit === null) return { error: "invalid_limit", message: `limit must be an integer between 1 and ${LIST_LIMIT_MAX}.` };
	let cursor = null;
	if (params.cursor != null && params.cursor !== "") {
		cursor = decodeWorkspaceCursor(params.cursor, "src", sort);
		if (!cursor) return { error: "invalid_cursor", message: "cursor is not valid for this list and sort." };
	}
	const q = params.q == null ? null : String(params.q).trim().slice(0, QUERY_MAX_CHARS) || null;
	const mode = params.mode == null ? null : String(params.mode).trim() || null;
	if (mode && !/^[a-z_]{1,40}$/.test(mode)) return { error: "invalid_mode", message: "mode is not a valid source mode." };
	return { state, sort, windowMs, limit, cursor, q, mode };
}

function shapeSourceRow(row) {
	return {
		id: row.id,
		title: sourceTitleOf(row),
		kind: sourceKindOf(row),
		source_mode: row.source_mode ?? null,
		source_type: row.source_type ?? null,
		state: row.state,
		memories: Number(row.memory_count ?? 0),
		evidence: Number(row.evidence_count ?? 0),
		message_count: Number(row.message_count ?? 0),
		conversation_id: row.conversation_id ?? null,
		project_id: row.project_id ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.sort_ts || row.updated_at || row.created_at || null,
	};
}

export async function listWorkspaceSources(env, userId, options) {
	const { state, sort, windowMs, limit, cursor, q, mode } = options;
	const direction = sort === "updated_asc" ? "ASC" : "DESC";
	const cmp = direction === "ASC" ? ">" : "<";
	const clauses = ["p.user_id = ?", "p.source_type != 'query'"];
	const binds = [userId];
	if (windowMs) {
		clauses.push(`${PACKET_SORT} >= ?`);
		binds.push(Date.now() - windowMs);
	}
	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		clauses.push("(p.topic LIKE ? ESCAPE '\\' OR p.content_preview LIKE ? ESCAPE '\\' OR p.conversation_id LIKE ? ESCAPE '\\' OR p.id = ?)");
		binds.push(pattern, pattern, pattern, q);
	}
	if (mode) {
		clauses.push("(p.source_mode = ? OR p.source_type = ?)");
		binds.push(mode, mode);
	}
	if (state) {
		clauses.push(`${PACKET_STATE} = ?`);
		binds.push(state);
	}
	if (cursor) {
		clauses.push(`(${PACKET_SORT} ${cmp} ? OR (${PACKET_SORT} = ? AND p.id ${cmp} ?))`);
		binds.push(cursor.key, cursor.key, cursor.id);
	}
	const { results } = await env.DB.prepare(
		`SELECT p.id, p.topic, p.conversation_id, p.content_preview, p.source_type, p.source_mode,
			p.message_count, p.project_id, p.created_at, p.updated_at,
			${PACKET_SORT} AS sort_ts, ${PACKET_STATE} AS state,
			(SELECT COUNT(*) FROM memory_source_links l WHERE l.user_id = p.user_id AND l.source_packet_id = p.id)
			+ (SELECT COUNT(*) FROM memory_pages mp WHERE mp.user_id = p.user_id AND mp.source_packet_id = p.id AND mp.deleted_at IS NULL) AS memory_count,
			(SELECT COUNT(*) FROM source_episodes se WHERE se.user_id = p.user_id AND se.source_packet_id = p.id) AS evidence_count
		 FROM source_packets p WHERE ${clauses.join(" AND ")}
		 ORDER BY sort_ts ${direction}, p.id ${direction} LIMIT ?`,
	).bind(...binds, limit + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map(shapeSourceRow),
		count: page.length,
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("src", sort, Number(last.sort_ts ?? 0), last.id)
			: null,
	};
}

export async function countWorkspaceSources(env, userId, options) {
	const { state, windowMs, q, mode } = options;
	const clauses = ["p.user_id = ?", "p.source_type != 'query'"];
	const binds = [userId];
	if (windowMs) {
		clauses.push(`${PACKET_SORT} >= ?`);
		binds.push(Date.now() - windowMs);
	}
	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		clauses.push("(p.topic LIKE ? ESCAPE '\\' OR p.content_preview LIKE ? ESCAPE '\\' OR p.conversation_id LIKE ? ESCAPE '\\' OR p.id = ?)");
		binds.push(pattern, pattern, pattern, q);
	}
	if (mode) {
		clauses.push("(p.source_mode = ? OR p.source_type = ?)");
		binds.push(mode, mode);
	}
	if (state) {
		clauses.push(`${PACKET_STATE} = ?`);
		binds.push(state);
	}
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM source_packets p WHERE ${clauses.join(" AND ")}`,
	).bind(...binds).first();
	return { total: Number(row?.count ?? 0) };
}

export async function getWorkspaceSource(env, userId, id) {
	const row = await env.DB.prepare(
		`SELECT p.id, p.topic, p.conversation_id, p.content_preview, p.source_type, p.source_mode,
			p.message_count, p.project_id, p.project_name, p.created_at, p.updated_at,
			${PACKET_SORT} AS sort_ts, ${PACKET_STATE} AS state,
			(SELECT COUNT(*) FROM memory_source_links l WHERE l.user_id = p.user_id AND l.source_packet_id = p.id)
			+ (SELECT COUNT(*) FROM memory_pages mp WHERE mp.user_id = p.user_id AND mp.source_packet_id = p.id AND mp.deleted_at IS NULL) AS memory_count,
			(SELECT COUNT(*) FROM source_episodes se WHERE se.user_id = p.user_id AND se.source_packet_id = p.id) AS evidence_count,
			(SELECT j.error FROM memory_jobs j
				WHERE j.user_id = p.user_id AND j.source_packet_id = p.id AND j.type IN ('extract', 'mcp_enrich')
				ORDER BY j.created_at DESC LIMIT 1) AS job_error,
			(SELECT j.updated_at FROM memory_jobs j
				WHERE j.user_id = p.user_id AND j.source_packet_id = p.id AND j.type IN ('extract', 'mcp_enrich')
				ORDER BY j.created_at DESC LIMIT 1) AS job_updated_at,
			EXISTS (SELECT 1 FROM memory_pages mp WHERE mp.user_id = p.user_id AND mp.source_packet_id = p.id
				AND mp.deleted_at IS NULL AND mp.full_markdown IS NOT NULL) AS has_content
		 FROM source_packets p WHERE p.user_id = ? AND p.id = ? AND p.source_type != 'query'`,
	).bind(userId, id).first();
	if (!row) return null;
	return {
		source: {
			...shapeSourceRow(row),
			project_name: row.project_name ?? null,
			// Only surfaced for failed sources; the job ledger already exposes it.
			failure: row.state === "failed" && row.job_error ? clampText(row.job_error, 300) : null,
			processed_at: row.job_updated_at ?? null,
			has_content: Boolean(row.has_content),
		},
	};
}

/** Memories extracted from one exact source, cursor-paginated. */
export async function listWorkspaceSourceMemories(env, userId, id, params = {}) {
	const parsed = parseSatelliteParams(params, "srcmem");
	if (parsed.error) return parsed;
	const { limit, cursor } = parsed;
	const clause = cursor ? "AND (sort_ts < ?3 OR (sort_ts = ?3 AND id < ?4))" : "";
	const binds = cursor ? [userId, id, cursor.key, cursor.id] : [userId, id];
	const { results } = await env.DB.prepare(
		`SELECT * FROM (
			SELECT n.id, 'node' AS kind, NULL AS slice_kind, n.label AS text,
				COALESCE(n.updated_at, n.created_at, 0) AS sort_ts
			  FROM memory_source_links l JOIN nodes n ON n.id = l.object_id AND n.user_id = l.user_id
			 WHERE l.user_id = ?1 AND l.source_packet_id = ?2 AND l.object_kind = 'node'
			   AND n.deleted_at IS NULL AND n.suppressed_at IS NULL
			UNION ALL
			SELECT s.id, 'slice' AS kind, s.kind AS slice_kind, s.text,
				COALESCE(s.last_seen_at, s.created_at, 0) AS sort_ts
			  FROM memory_source_links l JOIN slices s ON s.id = l.object_id AND s.user_id = l.user_id
			 WHERE l.user_id = ?1 AND l.source_packet_id = ?2 AND l.object_kind = 'slice' AND s.deleted_at IS NULL
			UNION ALL
			SELECT e.id, 'event' AS kind, NULL AS slice_kind, e.text,
				COALESCE(e.happened_at, e.created_at, 0) AS sort_ts
			  FROM memory_source_links l JOIN events e ON e.id = l.object_id AND e.user_id = l.user_id
			 WHERE l.user_id = ?1 AND l.source_packet_id = ?2 AND l.object_kind = 'event' AND e.deleted_at IS NULL
			UNION ALL
			SELECT mp.id, 'page' AS kind, NULL AS slice_kind, mp.title AS text,
				COALESCE(mp.updated_at, mp.created_at, 0) AS sort_ts
			  FROM memory_pages mp
			 WHERE mp.user_id = ?1 AND mp.source_packet_id = ?2 AND mp.deleted_at IS NULL AND mp.suppressed_at IS NULL
		) WHERE 1 = 1 ${clause}
		ORDER BY sort_ts DESC, id DESC LIMIT ${limit + 1}`,
	).bind(...binds).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			kind: row.kind,
			semantic_type: row.kind === "slice" ? (SLICE_KIND_LABELS[row.slice_kind] ?? "Detail")
				: row.kind === "node" ? "Entity" : row.kind === "page" ? "Page" : "Event",
			text: row.text ?? "",
			updated_at: row.sort_ts || null,
		})),
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("srcmem", "updated_desc", Number(last.sort_ts ?? 0), last.id)
			: null,
	};
}

/**
 * Evidence segments for one source: its scrubbed, rules-filtered episodes in
 * original message order. Ascending keyset on (message_index, id).
 */
export async function listWorkspaceSourceEvidence(env, userId, id, params = {}) {
	const parsed = parseSatelliteParams(params, "srcev");
	if (parsed.error) return parsed;
	const { limit, cursor } = parsed;
	const clauses = ["user_id = ?", "source_packet_id = ?"];
	const binds = [userId, id];
	if (cursor) {
		clauses.push("(message_index > ? OR (message_index = ? AND id > ?))");
		binds.push(cursor.key, cursor.key, cursor.id);
	}
	const { results } = await env.DB.prepare(
		`SELECT id, role, text, message_index, source_time, observed_at, created_at
		 FROM source_episodes WHERE ${clauses.join(" AND ")}
		 ORDER BY message_index ASC, id ASC LIMIT ?`,
	).bind(...binds, limit + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			role: row.role ?? "user",
			text: row.text ?? "",
			position: Number(row.message_index ?? 0),
			source_time: row.source_time ?? null,
			observed_at: row.observed_at ?? row.created_at ?? null,
		})),
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("srcev", "updated_desc", Number(last.message_index ?? 0), last.id)
			: null,
	};
}

/**
 * Rendered content for one source: the memory page the source produced, as
 * bounded markdown with an explicit truncation flag. A source with no page
 * has no Content tab; the raw packet transcript is deliberately not a
 * rendering surface (episodes are, and they live behind /evidence).
 */
export async function getWorkspaceSourceContent(env, userId, id) {
	const row = await env.DB.prepare(
		`SELECT id, title, full_markdown FROM memory_pages
		 WHERE user_id = ? AND source_packet_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
		 ORDER BY COALESCE(updated_at, created_at, 0) DESC LIMIT 1`,
	).bind(userId, id).first();
	if (!row || row.full_markdown == null) return { content: null };
	const markdown = String(row.full_markdown);
	const truncated = markdown.length > PAGE_MARKDOWN_CAP;
	return {
		content: {
			page_id: row.id,
			title: row.title ?? null,
			markdown: truncated ? markdown.slice(0, PAGE_MARKDOWN_CAP) : markdown,
			truncated,
		},
	};
}

/* ---------------------------------------------------------------------------
 * Suggestions: pending candidates, cursor-paginated, with their evidence and
 * merge target when one is recorded.
 * ------------------------------------------------------------------------- */

export function parseWorkspaceSuggestionOptions(params = {}) {
	const status = params.status == null || params.status === "" ? "pending" : String(params.status);
	if (!SUGGESTION_STATUSES.has(status)) {
		return { error: "invalid_status", message: "status must be one of: pending, reviewed, all." };
	}
	const limit = normalizeLimit(params.limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
	if (limit === null) return { error: "invalid_limit", message: `limit must be an integer between 1 and ${LIST_LIMIT_MAX}.` };
	let cursor = null;
	if (params.cursor != null && params.cursor !== "") {
		cursor = decodeWorkspaceCursor(params.cursor, "sug", "updated_desc");
		if (!cursor) return { error: "invalid_cursor", message: "cursor is not valid for this list." };
	}
	const q = params.q == null ? null : String(params.q).trim().slice(0, QUERY_MAX_CHARS) || null;
	return { status, limit, cursor, q };
}

function suggestionEvidence(evidenceJson) {
	let parsed = [];
	try { parsed = JSON.parse(evidenceJson ?? "[]"); } catch {}
	if (!Array.isArray(parsed)) return [];
	return parsed.slice(0, 3).map((entry) => {
		if (typeof entry === "string") return { text: clampText(entry, 400) };
		return {
			text: clampText(entry?.snippet ?? entry?.text ?? "", 400),
			at: Number(entry?.ts ?? entry?.timestamp) || null,
		};
	}).filter((entry) => entry.text);
}

export async function listWorkspaceSuggestions(env, userId, options) {
	const { status, limit, cursor, q } = options;
	const sortExpr = "COALESCE(c.last_seen_at, c.created_at, 0)";
	const clauses = ["c.user_id = ?", "c.deleted_at IS NULL", "c.suppressed_at IS NULL"];
	const binds = [userId];
	if (status === "pending") clauses.push("COALESCE(c.status, 'pending') = 'pending'");
	else if (status === "reviewed") clauses.push("COALESCE(c.status, 'pending') != 'pending'");
	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		clauses.push("(c.label LIKE ? ESCAPE '\\' OR c.label_guess LIKE ? ESCAPE '\\' OR c.id = ?)");
		binds.push(pattern, pattern, q);
	}
	if (cursor) {
		clauses.push(`(${sortExpr} < ? OR (${sortExpr} = ? AND c.id < ?))`);
		binds.push(cursor.key, cursor.key, cursor.id);
	}
	const { results } = await env.DB.prepare(
		`SELECT c.id, c.label, c.label_guess, c.status, c.reason, c.confidence, c.strength,
			c.cluster_guess, c.cluster_hint, c.mention_count, c.mentions, c.session_count,
			c.evidence_json, c.possible_existing_node_id, c.promoted_object_id, c.promoted_object_kind,
			c.reviewed_at, c.first_seen_at, c.last_seen_at, c.created_at, c.project_id,
			${sortExpr} AS sort_ts,
			(SELECT n.label FROM nodes n WHERE n.id = c.possible_existing_node_id AND n.user_id = c.user_id
				AND n.deleted_at IS NULL) AS merge_target_label
		 FROM candidates c WHERE ${clauses.join(" AND ")}
		 ORDER BY sort_ts DESC, c.id DESC LIMIT ?`,
	).bind(...binds, limit + 1).all();
	const rows = results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => ({
			id: row.id,
			text: row.label_guess ?? row.label ?? "",
			status: row.status ?? "pending",
			reason: row.reason ?? null,
			confidence: typeof row.confidence === "number" ? row.confidence : null,
			strength: row.strength ?? null,
			cluster: row.cluster_guess ?? row.cluster_hint ?? null,
			mentions: Number(row.mention_count ?? row.mentions ?? 1),
			sessions: Number(row.session_count ?? 1),
			evidence: suggestionEvidence(row.evidence_json),
			merge_target: row.possible_existing_node_id
				? { id: row.possible_existing_node_id, label: row.merge_target_label ?? null }
				: null,
			promoted: row.promoted_object_id
				? { id: row.promoted_object_id, kind: row.promoted_object_kind ?? null }
				: null,
			reviewed_at: row.reviewed_at ?? null,
			first_seen_at: row.first_seen_at ?? row.created_at ?? null,
			last_seen_at: row.last_seen_at ?? row.created_at ?? null,
			project_id: row.project_id ?? null,
		})),
		count: page.length,
		next_cursor: rows.length > limit && last
			? encodeWorkspaceCursor("sug", "updated_desc", Number(last.sort_ts ?? 0), last.id)
			: null,
	};
}

export async function countWorkspaceSuggestions(env, userId, options) {
	const { status, q } = options;
	const clauses = ["c.user_id = ?", "c.deleted_at IS NULL", "c.suppressed_at IS NULL"];
	const binds = [userId];
	if (status === "pending") clauses.push("COALESCE(c.status, 'pending') = 'pending'");
	else if (status === "reviewed") clauses.push("COALESCE(c.status, 'pending') != 'pending'");
	if (q) {
		const pattern = `%${escapeLike(q)}%`;
		clauses.push("(c.label LIKE ? ESCAPE '\\' OR c.label_guess LIKE ? ESCAPE '\\' OR c.id = ?)");
		binds.push(pattern, pattern, q);
	}
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS count FROM candidates c WHERE ${clauses.join(" AND ")}`,
	).bind(...binds).first();
	return { total: Number(row?.count ?? 0) };
}
