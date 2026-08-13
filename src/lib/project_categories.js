/**
 * Project categories.
 *
 * Itsuki already has a canonical typed category set in config.js — person,
 * family, project, health, goal and the rest. Those are not tags: the
 * extractor is told to pick one, the gates canonicalise onto it, and the graph
 * colours every node by it. They are built in, read-only, and this module does
 * not touch them.
 *
 * What a project can add is a NAMED category of its own, for filing memories
 * under a word that means something to that team. Those already exist as
 * `custom_categories_json` inside memory_rules, so this module dual-reads:
 * the table is authoritative once a project has written to it, and the old
 * JSON is migrated forward lazily the first time categories are saved. No
 * historical row is rewritten in a migration, and a project that never opens
 * this page keeps behaving exactly as it did.
 *
 * A category is classification, never permission. Nothing here decides whether
 * a memory may be stored — that is the include/exclude rules' job, and
 * conflating the two would turn a display label into a privacy control.
 */

import { newId } from "./ids.js";
import { OrgError } from "./organizations.js";

export const MAX_PROJECT_CATEGORIES = 32;
const NAME_MAX = 40;
const DESCRIPTION_MAX = 160;

export function categorySlug(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, NAME_MAX);
}

function cleanName(value) {
	if (typeof value !== "string") throw new OrgError("invalid_category", "Category name must be a string.");
	const name = value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
	if (!name) throw new OrgError("invalid_category", "Category name is required.");
	if (!categorySlug(name)) {
		throw new OrgError("invalid_category", "Category name needs at least one letter or number.");
	}
	return name;
}

function cleanDescription(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new OrgError("invalid_category", "Category description must be a string.");
	return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX) || null;
}

function publicCategory(row) {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		status: row.status,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/**
 * Move a project's legacy `custom_categories_json` into the table, once. Runs
 * inside the first write so a read never mutates, and INSERT OR IGNORE keeps
 * it safe if two writes race.
 */
async function migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy = [] }) {
	if (!legacy.length) return;
	const existing = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ?",
	).bind(projectId).first();
	if (Number(existing?.n ?? 0)) return;
	const at = Date.now();
	const statements = [];
	for (const entry of legacy.slice(0, MAX_PROJECT_CATEGORIES)) {
		const name = String(entry?.name ?? "").trim();
		const slug = categorySlug(name);
		if (!slug) continue;
		statements.push(env.DB.prepare(
			`INSERT OR IGNORE INTO project_categories
			 (id, project_id, memory_owner_user_id, slug, name, description, status, created_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
		).bind(newId("cat"), projectId, memoryOwnerUserId, slug, name, entry?.description ?? null, at, at));
	}
	if (statements.length) await env.DB.batch(statements);
}

export async function listProjectCategories(env, { projectId, memoryOwnerUserId, legacy = [] }) {
	const { results } = await env.DB.prepare(
		`SELECT id, slug, name, description, status, created_at, updated_at
		   FROM project_categories WHERE project_id = ? ORDER BY status ASC, name COLLATE NOCASE ASC`,
	).bind(projectId).all();
	const rows = results ?? [];
	// Dual read: a project that has never saved on this page still sees the
	// categories it configured through the old rules field.
	if (!rows.length && legacy.length) {
		return legacy
			.map((entry) => ({
				id: `legacy_${categorySlug(entry?.name)}`,
				slug: categorySlug(entry?.name),
				name: String(entry?.name ?? ""),
				description: entry?.description ?? null,
				status: "active",
				legacy: true,
				created_at: null,
				updated_at: null,
			}))
			.filter((entry) => entry.slug);
	}
	return rows.map(publicCategory);
}

export async function createProjectCategory(env, { projectId, memoryOwnerUserId, legacy = [], name, description, actorUserId }) {
	await migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy });
	const clean = cleanName(name);
	const slug = categorySlug(clean);
	const count = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ? AND status = 'active'",
	).bind(projectId).first();
	if (Number(count?.n ?? 0) >= MAX_PROJECT_CATEGORIES) {
		throw new OrgError("category_limit_reached", `A project can have at most ${MAX_PROJECT_CATEGORIES} categories.`, 409);
	}
	const at = Date.now();
	const result = await env.DB.prepare(
		`INSERT OR IGNORE INTO project_categories
		 (id, project_id, memory_owner_user_id, slug, name, description, status, created_by_user_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
	).bind(newId("cat"), projectId, memoryOwnerUserId, slug, clean, cleanDescription(description), actorUserId ?? null, at, at).run();
	if (!(result.meta?.changes ?? 0)) {
		throw new OrgError("category_exists", "A category with that name already exists in this project.", 409);
	}
	return { ok: true, slug };
}

export async function updateProjectCategory(env, { projectId, categoryId, name, description }) {
	const current = await env.DB.prepare(
		"SELECT id, slug, name, description FROM project_categories WHERE id = ? AND project_id = ? LIMIT 1",
	).bind(categoryId, projectId).first();
	if (!current) throw new OrgError("category_not_found", "That category does not exist.", 404);
	const nextName = name === undefined ? current.name : cleanName(name);
	const nextDescription = description === undefined ? current.description : cleanDescription(description);
	// The slug is identity: memories already carry it. Renaming changes the
	// label, never the key, or every memory filed under it would come unstuck.
	await env.DB.prepare(
		"UPDATE project_categories SET name = ?, description = ?, updated_at = ? WHERE id = ? AND project_id = ?",
	).bind(nextName, nextDescription, Date.now(), categoryId, projectId).run();
	return { ok: true };
}

/**
 * Archive rather than delete when a category is in use. An archived category
 * stops being offered to the extractor but keeps resolving for the memories
 * already filed under it, so nothing already captured becomes unlabelled.
 */
export async function setProjectCategoryStatus(env, { projectId, categoryId, status }) {
	if (!["active", "archived"].includes(status)) {
		throw new OrgError("invalid_status", "Status must be active or archived.");
	}
	const result = await env.DB.prepare(
		"UPDATE project_categories SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?",
	).bind(status, Date.now(), categoryId, projectId).run();
	if (!(result.meta?.changes ?? 0)) throw new OrgError("category_not_found", "That category does not exist.", 404);
	return { ok: true };
}

export async function deleteProjectCategory(env, { projectId, categoryId }) {
	const result = await env.DB.prepare(
		"DELETE FROM project_categories WHERE id = ? AND project_id = ?",
	).bind(categoryId, projectId).run();
	if (!(result.meta?.changes ?? 0)) throw new OrgError("category_not_found", "That category does not exist.", 404);
	return { ok: true };
}

/** The names the extractor should be offered, in the shape rules.js expects. */
export async function activeCategoryRules(env, projectId) {
	const { results } = await env.DB.prepare(
		"SELECT slug, description FROM project_categories WHERE project_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE ASC",
	).bind(projectId).all();
	return (results ?? []).map((row) => ({ name: row.slug, description: row.description ?? "" }));
}
