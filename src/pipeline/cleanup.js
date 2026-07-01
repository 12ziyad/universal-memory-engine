import { getConfig } from "../config.js";
import { addSuppression } from "../lib/db.js";
import { deleteNodeVectors } from "../lib/vectorize.js";
import { normalizeLabel } from "../lib/text.js";
import { suppressPageKey } from "./pages.js";

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function softDeleteByIds(env, userId, table, ids, now) {
	if (!ids.length) return 0;
	let count = 0;
	for (const id of ids) {
		await env.DB.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND user_id = ?`)
			.bind(now, id, userId)
			.run();
		count++;
	}
	return count;
}

async function countTable(env, userId, table) {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(userId).first();
	return row?.count ?? 0;
}

async function deleteFromTable(env, userId, table) {
	const before = await countTable(env, userId, table);
	await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
	return before;
}

async function bestEffortDeleteFromTable(env, userId, table) {
	try {
		return await deleteFromTable(env, userId, table);
	} catch (err) {
		return { table, skipped: true, reason: err?.message ?? String(err) };
	}
}

async function suppressNode(env, userId, nodeId, reason) {
	const node = await env.DB.prepare("SELECT id, label FROM nodes WHERE id = ? AND user_id = ?")
		.bind(nodeId, userId)
		.first();
	if (!node) return;
	await addSuppression(env, userId, {
		kind: "node",
		label: node.label,
		canonical_key: normalizeLabel(node.label),
		reason,
		source_object_id: node.id,
	});
}

async function suppressPage(env, userId, pageId, reason) {
	const page = await env.DB.prepare("SELECT * FROM memory_pages WHERE id = ? AND user_id = ?")
		.bind(pageId, userId)
		.first();
	if (!page) return;
	await suppressPageKey(env, userId, page, reason);
}

export function junkNodeReason(node) {
	const raw = String(node?.label ?? "").trim();
	const label = normalizeLabel(raw);
	if (!label) return "empty title";
	const words = label.split(/\s+/).filter(Boolean);
	const starts = [
		"want", "want to", "see", "discuss", "explore", "asked", "ask", "try", "trying", "need to", "would like",
		"lets", "let us", "make", "create", "build different", "prototype", "impressive", "world facing",
	];
	if (starts.some((start) => label === start || label.startsWith(`${start} `))) return "starts like a chat instruction or sentence fragment";
	if (/\b(i can|i will|you asked|you want|here is|here are|we can|we should|let me)\b/.test(label)) return "assistant/chat wording";
	if (/\b(detailed|interactive prototype|different build|world facing|looks good|nice idea|cool|thanks|whats up)\b/.test(label) && words.length > 3) {
		return "vague non-durable phrase";
	}
	if (/[?.!]$/.test(raw) || /\b(can you|could you|how do i|what if|why does)\b/.test(label)) return "question or request, not durable memory";
	if (words.length >= 8 && !node?.summary && Number(node?.mention_count ?? 1) <= 1) return "too long and weak to be a durable concept";
	if (words.length >= 6 && raw[0] === raw[0]?.toLowerCase() && !/[A-Z]{2,}|\b[A-Z][a-z]+/.test(raw)) return "lowercase sentence fragment";
	return null;
}

export async function deleteLastExtraction(env, userId) {
	const run = await env.DB.prepare(
		"SELECT * FROM extraction_runs WHERE user_id = ? AND (status IS NULL OR status != 'deleted') ORDER BY created_at DESC LIMIT 1",
	)
		.bind(userId)
		.first();
	if (!run) return { deleted: false, reason: "no extraction run found" };

	const now = Date.now();
	const pages = parseJsonArray(run.created_pages_json);
	const nodes = parseJsonArray(run.created_nodes_json);
	const slices = parseJsonArray(run.created_slices_json);
	const events = parseJsonArray(run.created_events_json);
	const edges = parseJsonArray(run.created_edges_json);

	for (const p of pages) await suppressPage(env, userId, p.id, "delete_last_extraction");
	for (const n of nodes) await suppressNode(env, userId, n.id, "delete_last_extraction");

	const counts = {
		pages: await softDeleteByIds(env, userId, "memory_pages", pages.map((p) => p.id), now),
		nodes: await softDeleteByIds(env, userId, "nodes", nodes.map((n) => n.id), now),
		slices: await softDeleteByIds(env, userId, "slices", slices.map((s) => s.id), now),
		events: await softDeleteByIds(env, userId, "events", events.map((e) => e.id), now),
		edges: await softDeleteByIds(env, userId, "edges", edges.map((e) => e.id), now),
	};
	await deleteNodeVectors(env, getConfig(env), nodes.map((n) => n.id));
	await env.DB.prepare("UPDATE extraction_runs SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
		.bind("deleted", now, run.id, userId)
		.run();
	return { deleted: true, extraction_run_id: run.id, counts };
}

export async function deleteObject(env, userId, { kind, id, suppress = true }) {
	const now = Date.now();
	if (kind === "page" || kind === "memory_page") {
		if (suppress) await suppressPage(env, userId, id, "delete_selected");
		await env.DB.prepare("UPDATE memory_pages SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, suppress ? now : null, id, userId)
			.run();
		return { deleted: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		if (suppress) await suppressNode(env, userId, id, "delete_selected");
		await env.DB.batch([
			env.DB.prepare("UPDATE nodes SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?").bind(
				now,
				suppress ? now : null,
				id,
				userId,
			),
			env.DB.prepare("UPDATE slices SET deleted_at = ? WHERE node_id = ? AND user_id = ?").bind(now, id, userId),
			env.DB.prepare("UPDATE events SET deleted_at = ? WHERE node_id = ? AND user_id = ?").bind(now, id, userId),
			env.DB.prepare("UPDATE edges SET deleted_at = ? WHERE user_id = ? AND (from_node = ? OR to_node = ?)").bind(
				now,
				userId,
				id,
				id,
			),
		]);
		await deleteNodeVectors(env, getConfig(env), [id]);
		return { deleted: true, kind: "node", id };
	}
	if (kind === "candidate") {
		await env.DB.prepare("UPDATE candidates SET deleted_at = ?, suppressed_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, suppress ? now : null, id, userId)
			.run();
		return { deleted: true, kind: "candidate", id };
	}
	return { deleted: false, reason: "unsupported kind" };
}

export async function archiveObject(env, userId, { kind, id }) {
	const now = Date.now();
	if (kind === "page" || kind === "memory_page") {
		await env.DB.prepare("UPDATE memory_pages SET archived_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
		return { archived: true, kind: "memory_page", id };
	}
	if (kind === "node") {
		await env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
		return { archived: true, kind: "node", id };
	}
	if (kind === "candidate") {
		await env.DB.prepare("UPDATE candidates SET deleted_at = ? WHERE id = ? AND user_id = ?")
			.bind(now, id, userId)
			.run();
		return { archived: true, kind: "candidate", id };
	}
	return { archived: false, reason: "unsupported kind" };
}

export async function deleteAllMemories(env, userId, confirm) {
	if (confirm !== "DELETE ALL") return { deleted: false, reason: "exact confirmation text DELETE ALL required" };

	const { results: nodeRows } = await env.DB.prepare("SELECT id FROM nodes WHERE user_id = ?").bind(userId).all();
	const nodeIds = (nodeRows ?? []).map((row) => row.id);
	await deleteNodeVectors(env, getConfig(env), nodeIds);

	const counts = {
		memory_pages: await deleteFromTable(env, userId, "memory_pages"),
		nodes: await deleteFromTable(env, userId, "nodes"),
		slices: await deleteFromTable(env, userId, "slices"),
		events: await deleteFromTable(env, userId, "events"),
		edges: await deleteFromTable(env, userId, "edges"),
		candidates: await deleteFromTable(env, userId, "candidates"),
		receipts: await deleteFromTable(env, userId, "receipts"),
		extraction_runs: await deleteFromTable(env, userId, "extraction_runs"),
		memory_suppressions: await deleteFromTable(env, userId, "memory_suppressions"),
		checkpoints: await deleteFromTable(env, userId, "checkpoints"),
	};

	const optional = {};
	for (const table of ["memory_page_related", "related_index", "index_records", "vector_index_records"]) {
		optional[table] = await bestEffortDeleteFromTable(env, userId, table);
	}

	return {
		deleted: true,
		counts,
		optional,
		pages: counts.memory_pages,
		nodes: counts.nodes,
		vectorize: { attempted: nodeIds.length },
	};
}

export async function cleanupJunkNodes(env, userId, { dryRun = false, confirm } = {}) {
	const { results } = await env.DB.prepare(
		`SELECT id, label, category, summary, mention_count, health_state, archived_at, suppressed_at
		 FROM nodes
		 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
		 ORDER BY updated_at DESC, created_at DESC`,
	)
		.bind(userId)
		.all();

	const candidates = [];
	for (const node of results ?? []) {
		const reason = junkNodeReason(node);
		if (reason) candidates.push({ id: node.id, label: node.label, category: node.category, reason });
	}

	if (dryRun) return { dryRun: true, count: candidates.length, candidates };
	if (confirm !== "CLEAN JUNK") return { cleaned: false, reason: "exact confirmation text CLEAN JUNK required", count: candidates.length, candidates };

	const now = Date.now();
	for (const node of candidates) {
		await suppressNode(env, userId, node.id, `cleanup_junk_nodes: ${node.reason}`);
		await env.DB.prepare(
			"UPDATE nodes SET archived_at = ?, suppressed_at = ?, health_state = ?, updated_at = ? WHERE id = ? AND user_id = ?",
		)
			.bind(now, now, "junk", now, node.id, userId)
			.run();
	}
	await deleteNodeVectors(env, getConfig(env), candidates.map((node) => node.id));
	return { cleaned: true, archived: candidates.length, suppressed: candidates.length, candidates };
}

export async function clearFailedReceipts(env, userId) {
	const res = await env.DB.prepare(
		`DELETE FROM receipts
		 WHERE user_id = ? AND (saved_total = 0 OR outcome IN ('llm_failed', 'db_write_failed', 'meaningful_no_write'))`,
	)
		.bind(userId)
		.run();
	return { cleared: true, changes: res.meta?.changes ?? 0 };
}
