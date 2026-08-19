/**
 * Read-only memory inventory — list, fetch-one, and counts.
 *
 * Shared by the REST reads (GET /v1/memories, GET /v1/memories/:id) and the
 * MCP management tools (list_memories, get_memory, whoami). Everything here
 * is a SELECT: nothing touches the extraction pipeline, and nothing mutates.
 * Deletion stays in pipeline/cleanup.js where its barriers live.
 */

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const QUERY_MAX_CHARS = 200;
const PAGE_MARKDOWN_CAP = 20_000;
const LIST_KINDS = new Set(["all", "node", "page"]);

/** Escape %, _ and \ for a LIKE pattern bound with ESCAPE '\'. */
function escapeLike(text) {
	return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Opaque keyset cursor: base64url of `v1:<sortTs>:<id>`. */
export function encodeInventoryCursor(ts, id) {
	const raw = `v1:${ts}:${id}`;
	return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeInventoryCursor(cursor) {
	try {
		const b64 = String(cursor).replace(/-/g, "+").replace(/_/g, "/");
		const raw = atob(b64);
		const match = /^v1:(-?\d+):(.+)$/.exec(raw);
		if (!match) return null;
		const ts = Number(match[1]);
		if (!Number.isSafeInteger(ts)) return null;
		return { ts, id: match[2] };
	} catch {
		return null;
	}
}

/**
 * Validate the list query surface once, for both the REST route and the MCP
 * tool. Returns { error, message } or the normalized options.
 */
export function parseInventoryListOptions({ kind, limit, cursor, projectId, q } = {}) {
	const normalizedKind = kind == null || kind === "" ? "all" : String(kind);
	if (!LIST_KINDS.has(normalizedKind)) {
		return { error: "invalid_kind", message: "kind must be one of: all, node, page." };
	}
	let normalizedLimit = LIST_LIMIT_DEFAULT;
	if (limit != null && limit !== "") {
		normalizedLimit = Number(limit);
		if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > LIST_LIMIT_MAX) {
			return { error: "invalid_limit", message: `limit must be an integer between 1 and ${LIST_LIMIT_MAX}.` };
		}
	}
	let normalizedCursor = null;
	if (cursor != null && cursor !== "") {
		normalizedCursor = decodeInventoryCursor(cursor);
		if (!normalizedCursor) return { error: "invalid_cursor", message: "cursor is not a valid inventory cursor." };
	}
	const normalizedQuery = q == null ? null : String(q).trim().slice(0, QUERY_MAX_CHARS) || null;
	const normalizedProject = projectId == null ? null : String(projectId).trim() || null;
	return { kind: normalizedKind, limit: normalizedLimit, cursor: normalizedCursor, projectId: normalizedProject, q: normalizedQuery };
}

function publicNode(row) {
	return {
		id: row.id,
		kind: "node",
		revision: Number(row.revision ?? 1),
		label: row.label ?? null,
		category: row.category ?? null,
		state: row.state ?? null,
		summary: row.summary ?? null,
		cluster: row.cluster ?? null,
		project_id: row.project_id ?? null,
		project_name: row.project_name ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
	};
}

function publicPage(row) {
	return {
		id: row.id,
		kind: "page",
		revision: Number(row.revision ?? 1),
		label: row.title ?? null,
		title: row.title ?? null,
		category: row.topic_filter ?? "interest",
		summary: row.short_summary ?? null,
		project_id: row.project_id ?? null,
		project_name: row.project_name ?? null,
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
	};
}

/**
 * List a user's live memories (nodes + pages) newest-first with keyset
 * pagination. Options must come from parseInventoryListOptions.
 */
export async function listMemories(env, userId, { kind = "all", limit = LIST_LIMIT_DEFAULT, cursor = null, projectId = null, q = null } = {}) {
	const sortKey = "COALESCE(updated_at, created_at, 0)";
	const buildQuery = (table, columns, likeColumns) => {
		const clauses = ["user_id = ?", "deleted_at IS NULL", "archived_at IS NULL", "suppressed_at IS NULL"];
		const binds = [userId];
		if (cursor) {
			clauses.push(`(${sortKey} < ? OR (${sortKey} = ? AND id < ?))`);
			binds.push(cursor.ts, cursor.ts, cursor.id);
		}
		if (projectId) {
			clauses.push("project_id = ?");
			binds.push(projectId);
		}
		if (q) {
			const pattern = `%${escapeLike(q)}%`;
			clauses.push(`(${likeColumns.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
			for (let i = 0; i < likeColumns.length; i++) binds.push(pattern);
		}
		return env.DB.prepare(
			`SELECT ${columns}, ${sortKey} AS sort_ts FROM ${table}
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY sort_ts DESC, id DESC
			 LIMIT ?`,
		).bind(...binds, limit + 1);
	};

	const statements = [];
	if (kind === "all" || kind === "node") {
		statements.push(buildQuery(
			"nodes",
			"id, label, category, state, summary, cluster, project_id, project_name, created_at, updated_at, COALESCE(revision, 1) AS revision",
			["label", "summary"],
		));
	}
	if (kind === "all" || kind === "page") {
		statements.push(buildQuery(
			"memory_pages",
			"id, title, topic_filter, short_summary, project_id, project_name, created_at, updated_at, COALESCE(revision, 1) AS revision",
			["title", "short_summary"],
		));
	}
	const batched = await env.DB.batch(statements);

	const merged = [];
	let cursorIndex = 0;
	if (kind === "all" || kind === "node") {
		for (const row of batched[cursorIndex].results ?? []) merged.push({ sortTs: row.sort_ts ?? 0, item: publicNode(row) });
		cursorIndex += 1;
	}
	if (kind === "all" || kind === "page") {
		for (const row of batched[cursorIndex].results ?? []) merged.push({ sortTs: row.sort_ts ?? 0, item: publicPage(row) });
	}
	merged.sort((a, b) => (b.sortTs - a.sortTs) || (a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0));

	const hasMore = merged.length > limit;
	const pageItems = merged.slice(0, limit);
	const last = pageItems.at(-1);
	return {
		items: pageItems.map((entry) => entry.item),
		count: pageItems.length,
		next_cursor: hasMore && last ? encodeInventoryCursor(last.sortTs, last.item.id) : null,
	};
}

/**
 * Fetch one memory object by its prefixed id — the same prefix dispatch the
 * delete route uses (node_, page_, slice_, cand…). Returns:
 *   { error: "unrecognized_id" }  — the prefix names no known kind
 *   null                          — no live row with that id for this user
 *   { kind, memory }              — the object, with bounded satellites
 */
export async function getMemory(env, userId, id) {
	const kind = id.startsWith("node_") ? "node"
		: id.startsWith("page_") ? "page"
			: id.startsWith("slice_") ? "slice"
				: id.startsWith("cand") ? "candidate"
					: null;
	if (!kind) return { error: "unrecognized_id" };

	if (kind === "node") {
		const row = await env.DB.prepare(
			`SELECT id, label, category, state, summary, cluster, project_id, project_name,
				created_at, updated_at, archived_at, suppressed_at, COALESCE(revision, 1) AS revision
			 FROM nodes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		const [slices, events] = await env.DB.batch([
			env.DB.prepare(
				`SELECT id, text, kind, is_current, created_at FROM slices
				 WHERE node_id = ? AND user_id = ? AND deleted_at IS NULL
				 ORDER BY is_current DESC, created_at DESC LIMIT 10`,
			).bind(id, userId),
			env.DB.prepare(
				`SELECT id, action, text, importance, happened_at, created_at FROM events
				 WHERE node_id = ? AND user_id = ? AND deleted_at IS NULL
				 ORDER BY created_at DESC LIMIT 20`,
			).bind(id, userId),
		]);
		return {
			kind,
			memory: {
				...publicNode(row),
				archived_at: row.archived_at ?? null,
				suppressed_at: row.suppressed_at ?? null,
				slices: slices.results ?? [],
				events: events.results ?? [],
			},
		};
	}

	if (kind === "page") {
		const row = await env.DB.prepare(
			`SELECT id, title, canonical_title, topic_filter, short_summary, full_markdown,
				source_conversation_id, project_id, project_name,
				created_at, updated_at, archived_at, suppressed_at, COALESCE(revision, 1) AS revision
			 FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, userId).first();
		if (!row) return null;
		const markdown = row.full_markdown ?? null;
		const truncated = typeof markdown === "string" && markdown.length > PAGE_MARKDOWN_CAP;
		return {
			kind,
			memory: {
				...publicPage(row),
				canonical_title: row.canonical_title ?? null,
				source_conversation_id: row.source_conversation_id ?? null,
				archived_at: row.archived_at ?? null,
				suppressed_at: row.suppressed_at ?? null,
				full_markdown: truncated ? markdown.slice(0, PAGE_MARKDOWN_CAP) : markdown,
				...(truncated ? { full_markdown_truncated: true } : {}),
			},
		};
	}

	if (kind === "slice") {
		const row = await env.DB.prepare(
			"SELECT id, node_id, text, kind, is_current, created_at, COALESCE(revision, 1) AS revision FROM slices WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
		).bind(id, userId).first();
		return row ? { kind, memory: { ...row, kind: "slice", slice_kind: row.kind } } : null;
	}

	const row = await env.DB.prepare(
		`SELECT id, label_guess, label, status, cluster_guess, cluster_hint, created_at, last_seen_at
		 FROM candidates WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL`,
	).bind(id, userId).first();
	if (!row) return null;
	return {
		kind,
		memory: {
			id: row.id,
			kind: "candidate",
			label: row.label_guess ?? row.label ?? null,
			status: row.status ?? "pending",
			cluster: row.cluster_guess ?? row.cluster_hint ?? null,
			created_at: row.created_at ?? null,
			last_seen_at: row.last_seen_at ?? null,
		},
	};
}

/** The five live-object counts the status endpoint reports, as one object. */
export async function memoryCounts(env, userId) {
	const [nodes, pages, slices, events, candidates] = await env.DB.batch([
		env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
		env.DB.prepare("SELECT COUNT(*) AS count FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
		env.DB.prepare("SELECT COUNT(*) AS count FROM slices WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
		env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
		env.DB.prepare(
			`SELECT COUNT(*) AS count FROM candidates
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
			   AND COALESCE(status, 'pending') = 'pending'`,
		).bind(userId),
	]);
	const nodeCount = nodes.results[0].count;
	const pageCount = pages.results[0].count;
	return {
		memories: nodeCount + pageCount,
		nodes: nodeCount,
		pages: pageCount,
		slices: slices.results[0].count,
		events: events.results[0].count,
		candidates: candidates.results[0].count,
	};
}
