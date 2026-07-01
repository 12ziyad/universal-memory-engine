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
	return { archived: false, reason: "unsupported kind" };
}

export async function deleteAllMemories(env, userId, confirm) {
	if (confirm !== "DELETE") return { deleted: false, reason: "confirmation text required" };
	const now = Date.now();
	const { results: nodes } = await env.DB.prepare("SELECT id, label FROM nodes WHERE user_id = ? AND deleted_at IS NULL")
		.bind(userId)
		.all();
	const { results: pages } = await env.DB.prepare("SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL")
		.bind(userId)
		.all();
	for (const n of nodes ?? []) await suppressNode(env, userId, n.id, "delete_all");
	for (const p of pages ?? []) await suppressPageKey(env, userId, p, "delete_all");
	await env.DB.batch([
		env.DB.prepare("UPDATE nodes SET deleted_at = ?, suppressed_at = ? WHERE user_id = ?").bind(now, now, userId),
		env.DB.prepare("UPDATE memory_pages SET deleted_at = ?, suppressed_at = ? WHERE user_id = ?").bind(now, now, userId),
		env.DB.prepare("UPDATE slices SET deleted_at = ? WHERE user_id = ?").bind(now, userId),
		env.DB.prepare("UPDATE events SET deleted_at = ? WHERE user_id = ?").bind(now, userId),
		env.DB.prepare("UPDATE edges SET deleted_at = ? WHERE user_id = ?").bind(now, userId),
		env.DB.prepare("UPDATE candidates SET deleted_at = ?, suppressed_at = ? WHERE user_id = ?").bind(now, now, userId),
	]);
	await deleteNodeVectors(env, getConfig(env), (nodes ?? []).map((n) => n.id));
	return { deleted: true, nodes: (nodes ?? []).length, pages: (pages ?? []).length };
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
