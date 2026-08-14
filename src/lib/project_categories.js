/**
 * Governed project categories.
 *
 * Built-in `category` remains the graph's semantic/cluster vocabulary. A
 * project category is a separate, optional filing label stored by stable id;
 * renaming or recolouring it therefore never changes graph topology or breaks
 * historical assignments.
 */

import { sha256Hex } from "../auth.js";
import { CATEGORIES } from "../config.js";
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "./audit.js";
import { newId } from "./ids.js";
import { managedMutationGuardStatement } from "./managed_projects.js";
import { OrgError } from "./organizations.js";

export const MAX_PROJECT_CATEGORIES = 32;
export const MAX_PROJECT_CATEGORY_HISTORY = 128;
export const CATEGORY_COLOR_TOKENS = Object.freeze([
	"violet", "indigo", "blue", "cyan", "teal", "green",
	"lime", "amber", "orange", "rose", "pink", "slate",
]);

const NAME_MAX = 40;
const DESCRIPTION_MAX = 160;
const CATEGORY_REVISION_PREFIX = "crv1";
const CATEGORY_REVISION_PATTERN = /^crv1\.[0-9a-f]{64}$/;
const BUILTIN_SLUGS = new Set(CATEGORIES);

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
	const slug = categorySlug(name);
	if (!slug) throw new OrgError("invalid_category", "Category name needs at least one letter or number.");
	if (BUILTIN_SLUGS.has(slug)) {
		throw new OrgError("category_reserved", "That name is reserved by a built-in category.", 409);
	}
	return name;
}

function cleanDescription(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new OrgError("invalid_category", "Category description must be a string.");
	return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX) || null;
}

function defaultColorToken(slug) {
	let hash = 0;
	for (const char of String(slug)) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
	return CATEGORY_COLOR_TOKENS[hash % CATEGORY_COLOR_TOKENS.length];
}

function cleanColorToken(value, slug) {
	if (value === undefined || value === null || value === "") return defaultColorToken(slug);
	const token = String(value).trim().toLocaleLowerCase("en-US");
	if (!CATEGORY_COLOR_TOKENS.includes(token)) {
		throw new OrgError(
			"invalid_category_color",
			`Category colour must be one of: ${CATEGORY_COLOR_TOKENS.join(", ")}.`,
		);
	}
	return token;
}

async function categoryRevision(row) {
	return `${CATEGORY_REVISION_PREFIX}.${await sha256Hex([
		"itsuki:project-category:revision:v1",
		row.id,
		row.project_id,
		row.slug,
		row.name,
		row.description ?? "",
		row.status,
		row.color_token ?? "",
		row.updated_by_user_id ?? "",
		Number(row.updated_at),
	].join(":"))}`;
}

function normalizeExpectedRevision(value) {
	if (value === null || value === undefined || String(value).trim() === "") {
		throw new OrgError(
			"precondition_required",
			"Reload this category, then try again. This change requires its current revision.",
			428,
		);
	}
	let revision = String(value).trim();
	if (revision.startsWith("W/")) revision = revision.slice(2).trim();
	if (revision.startsWith('"') && revision.endsWith('"')) revision = revision.slice(1, -1);
	if (!CATEGORY_REVISION_PATTERN.test(revision)) return null;
	return revision;
}

function nextTimestamp(previous) {
	return Math.max(Date.now(), Number(previous ?? 0) + 1);
}

function categoryMutationResult(result, auditIntent) {
	return auditIntent ? auditedMutationResult(result, auditIntent) : result;
}

async function runCategoryBatch(env, auditIntent, statements, options = {}) {
	if (auditIntent) return commitAuditedBatch(env, auditIntent, statements, options);
	return env.DB.batch(statements);
}

async function categoryUsageMap(env, projectId, memoryOwnerUserId) {
	const { results } = await env.DB.prepare(
		`WITH memory_spaces(user_id) AS (
			SELECT ? UNION SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		), usage_rows AS (
			SELECT n.project_category_id AS id, COUNT(*) AS nodes, 0 AS pages, 0 AS candidates, 0 AS atoms
			  FROM nodes n JOIN memory_spaces s ON s.user_id = n.user_id
			 WHERE n.project_category_id IS NOT NULL GROUP BY n.project_category_id
			UNION ALL
			SELECT p.project_category_id AS id, 0, COUNT(*), 0, 0
			  FROM memory_pages p JOIN memory_spaces s ON s.user_id = p.user_id
			 WHERE p.project_category_id IS NOT NULL GROUP BY p.project_category_id
			UNION ALL
			SELECT c.project_category_id AS id, 0, 0, COUNT(*), 0
			  FROM candidates c JOIN memory_spaces s ON s.user_id = c.user_id
			 WHERE c.project_category_id IS NOT NULL GROUP BY c.project_category_id
			UNION ALL
			SELECT a.project_category_id AS id, 0, 0, 0, COUNT(*)
			  FROM semantic_atom_candidates a JOIN memory_spaces s ON s.user_id = a.user_id
			 WHERE a.project_category_id IS NOT NULL GROUP BY a.project_category_id
		)
		SELECT id, SUM(nodes) AS nodes, SUM(pages) AS pages, SUM(candidates) AS candidates,
		       SUM(atoms) AS atoms
		  FROM usage_rows GROUP BY id`,
	).bind(memoryOwnerUserId, projectId).all();
	return new Map((results ?? []).map((row) => {
		const usage = {
			nodes: Number(row.nodes ?? 0),
			pages: Number(row.pages ?? 0),
			candidates: Number(row.candidates ?? 0),
			atoms: Number(row.atoms ?? 0),
		};
		usage.total = usage.nodes + usage.pages + usage.candidates + usage.atoms;
		return [row.id, usage];
	}));
}

async function publicCategory(row, usage = null) {
	const normalizedUsage = usage ?? { nodes: 0, pages: 0, candidates: 0, atoms: 0, total: 0 };
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description ?? null,
		color_token: row.color_token ?? defaultColorToken(row.slug),
		status: row.status,
		usage: normalizedUsage,
		revision: await categoryRevision(row),
		created_by_user_id: row.created_by_user_id ?? null,
		updated_by_user_id: row.updated_by_user_id ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

async function categoryRow(env, projectId, categoryId) {
	return env.DB.prepare(
		`SELECT id, project_id, memory_owner_user_id, slug, name, description,
		        color_token, status, created_by_user_id, updated_by_user_id, created_at, updated_at
		   FROM project_categories WHERE id = ? AND project_id = ? LIMIT 1`,
	).bind(categoryId, projectId).first();
}

async function currentPublicCategory(env, projectId, categoryId) {
	const row = await categoryRow(env, projectId, categoryId);
	if (!row) return null;
	const usage = await categoryUsageMap(env, projectId, row.memory_owner_user_id);
	return publicCategory(row, usage.get(row.id));
}

async function requireCurrentCategory(env, projectId, categoryId, expectedRevision) {
	const row = await categoryRow(env, projectId, categoryId);
	if (!row) throw new OrgError("category_not_found", "That category does not exist.", 404);
	const expected = normalizeExpectedRevision(expectedRevision);
	const actual = await categoryRevision(row);
	if (!expected || expected !== actual) {
		const error = new OrgError(
			"category_conflict",
			"This category changed in another session. Reload before trying again.",
			412,
		);
		error.currentCategory = await currentPublicCategory(env, projectId, categoryId);
		throw error;
	}
	return row;
}

async function throwCategoryConflict(env, projectId, categoryId) {
	const current = await currentPublicCategory(env, projectId, categoryId);
	if (!current) throw new OrgError("category_not_found", "That category does not exist.", 404);
	const error = new OrgError(
		"category_conflict",
		"This category changed in another session. Reload before trying again.",
		412,
	);
	error.currentCategory = current;
	throw error;
}

/** Lazily copy the legacy rules JSON into stable table rows. */
async function migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy = [] }) {
	if (!legacy.length) return;
	const project = await env.DB.prepare(
		"SELECT id, status, memory_owner_user_id FROM managed_projects WHERE id = ? LIMIT 1",
	).bind(projectId).first();
	// Compatibility fixtures and old unmanaged callers may not have a managed
	// project row. They can still read/migrate their isolated legacy categories.
	// Once a managed row exists, however, inactive/mismatched state fails closed
	// so a late GET cannot resurrect settings after archive/erasure.
	if (project && (project.status !== "active" || project.memory_owner_user_id !== memoryOwnerUserId)) {
		throw new OrgError("project_not_found", "That project is no longer active.", 404);
	}
	const existing = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ?",
	).bind(projectId).first();
	if (Number(existing?.n ?? 0)) return;
	let at = Date.now();
	const seen = new Set();
	const statements = [];
	for (const entry of legacy.slice(0, MAX_PROJECT_CATEGORIES)) {
		const name = String(entry?.name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
		const slug = categorySlug(name);
		if (!slug || BUILTIN_SLUGS.has(slug) || seen.has(slug)) continue;
		seen.add(slug);
		statements.push(env.DB.prepare(
			`INSERT OR IGNORE INTO project_categories
			 (id, project_id, memory_owner_user_id, slug, name, description, status,
			  created_by_user_id, updated_by_user_id, created_at, updated_at, color_token)
			 VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)`,
		).bind(
			newId("cat"), projectId, memoryOwnerUserId, slug, name,
			cleanDescription(entry?.description), at, at++, cleanColorToken(entry?.color_token, slug),
		));
	}
	if (statements.length) await env.DB.batch(project ? [
		managedMutationGuardStatement(env, { projectId }),
		auditInvariantStatement(env,
			"SELECT 1 FROM managed_projects WHERE id = ? AND status = 'active' AND memory_owner_user_id = ?",
			[projectId, memoryOwnerUserId]),
		...statements,
	] : statements);
}

export async function listProjectCategories(env, { projectId, memoryOwnerUserId, legacy = [] }) {
	await migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy });
	const [{ results }, usage] = await Promise.all([
		env.DB.prepare(
			`SELECT id, project_id, memory_owner_user_id, slug, name, description,
			        color_token, status, created_by_user_id, updated_by_user_id, created_at, updated_at
			   FROM project_categories WHERE project_id = ?
			  ORDER BY status ASC, name COLLATE NOCASE ASC`,
		).bind(projectId).all(),
		categoryUsageMap(env, projectId, memoryOwnerUserId),
	]);
	return Promise.all((results ?? []).map((row) => publicCategory(row, usage.get(row.id))));
}

export async function createProjectCategory(env, {
	projectId, memoryOwnerUserId, legacy = [], name, description, colorToken, actorUserId, auditIntent = null,
}) {
	await migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy });
	const clean = cleanName(name);
	const slug = categorySlug(clean);
	const id = newId("cat");
	const at = Date.now();
	const statement = env.DB.prepare(
		`INSERT OR IGNORE INTO project_categories
		 (id, project_id, memory_owner_user_id, slug, name, description, status,
		  created_by_user_id, updated_by_user_id, created_at, updated_at, color_token)
		 SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?
		  WHERE (SELECT COUNT(*) FROM project_categories WHERE project_id = ? AND status = 'active') < ?
		    AND (SELECT COUNT(*) FROM project_categories WHERE project_id = ?) < ?`,
	).bind(
		id, projectId, memoryOwnerUserId, slug, clean, cleanDescription(description),
		actorUserId ?? null, actorUserId ?? null, at, at, cleanColorToken(colorToken, slug),
		projectId, MAX_PROJECT_CATEGORIES, projectId, MAX_PROJECT_CATEGORY_HISTORY,
	);
	let result;
	try {
		[result] = await runCategoryBatch(env, auditIntent, [statement], auditIntent ? {
			preconditions: [auditInvariantStatement(
				env,
				`SELECT 1 WHERE
				 (SELECT COUNT(*) FROM project_categories WHERE project_id = ? AND status = 'active') < ?
				 AND (SELECT COUNT(*) FROM project_categories WHERE project_id = ?) < ?
				 AND NOT EXISTS (SELECT 1 FROM project_categories WHERE project_id = ? AND slug = ?)`,
				[projectId, MAX_PROJECT_CATEGORIES, projectId, MAX_PROJECT_CATEGORY_HISTORY, projectId, slug],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND status = 'active' AND updated_at = ?",
				[id, projectId, at],
			)],
			commitDetails: { targetId: id },
		} : {});
	} catch (error) {
		if (!/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) throw error;
		const collision = await env.DB.prepare(
			"SELECT id FROM project_categories WHERE project_id = ? AND slug = ? LIMIT 1",
		).bind(projectId, slug).first();
		if (collision) throw new OrgError("category_exists", "A category with that name already exists in this project.", 409);
		const counts = await env.DB.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
			   FROM project_categories WHERE project_id = ?`,
		).bind(projectId).first();
		if (Number(counts?.total ?? 0) >= MAX_PROJECT_CATEGORY_HISTORY) {
			throw new OrgError(
				"category_history_limit_reached",
				`A project can retain at most ${MAX_PROJECT_CATEGORY_HISTORY} category records. Delete an unused archived category first.`,
				409,
			);
		}
		if (Number(counts?.active ?? 0) >= MAX_PROJECT_CATEGORIES) {
			throw new OrgError("category_limit_reached", `A project can have at most ${MAX_PROJECT_CATEGORIES} active categories.`, 409);
		}
		throw error;
	}
	if (Number(result.meta?.changes ?? 0) !== 1) {
		const collision = await env.DB.prepare(
			"SELECT id FROM project_categories WHERE project_id = ? AND slug = ? LIMIT 1",
		).bind(projectId, slug).first();
		if (collision) throw new OrgError("category_exists", "A category with that name already exists in this project.", 409);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ?",
		).bind(projectId).first();
		if (Number(count?.n ?? 0) >= MAX_PROJECT_CATEGORY_HISTORY) {
			throw new OrgError(
				"category_history_limit_reached",
				`A project can retain at most ${MAX_PROJECT_CATEGORY_HISTORY} category records. Delete an unused archived category first.`,
				409,
			);
		}
		throw new OrgError("category_limit_reached", `A project can have at most ${MAX_PROJECT_CATEGORIES} active categories.`, 409);
	}
	return categoryMutationResult({ category: await currentPublicCategory(env, projectId, id) }, auditIntent);
}

export async function updateProjectCategory(env, {
	projectId, categoryId, name, description, colorToken, expectedRevision, actorUserId = null, auditIntent = null,
}) {
	const current = await requireCurrentCategory(env, projectId, categoryId, expectedRevision);
	const nextName = name === undefined ? current.name : cleanName(name);
	const nextDescription = description === undefined ? current.description : cleanDescription(description);
	const nextColor = colorToken === undefined
		? (current.color_token ?? defaultColorToken(current.slug))
		: cleanColorToken(colorToken, current.slug);
	if (nextName === current.name && nextDescription === current.description && nextColor === (current.color_token ?? defaultColorToken(current.slug))) {
		const unchanged = { category: await currentPublicCategory(env, projectId, categoryId), previousCategory: await publicCategory(current), changed: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	const at = nextTimestamp(current.updated_at);
	const statement = env.DB.prepare(
		`UPDATE project_categories SET name = ?, description = ?, color_token = ?, updated_by_user_id = ?, updated_at = ?
		  WHERE id = ? AND project_id = ? AND updated_at = ?`,
	).bind(nextName, nextDescription, nextColor, actorUserId, at, categoryId, projectId, current.updated_at);
	let result;
	try {
		[result] = await runCategoryBatch(env, auditIntent, [statement], auditIntent ? {
			preconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ?",
				[categoryId, projectId, current.updated_at],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ? AND name = ? AND description IS ? AND color_token = ?",
				[categoryId, projectId, at, nextName, nextDescription, nextColor],
			)],
		} : {});
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await categoryRow(env, projectId, categoryId);
			if (!latest || Number(latest.updated_at) !== Number(current.updated_at)) {
				return throwCategoryConflict(env, projectId, categoryId);
			}
		}
		throw error;
	}
	if (Number(result.meta?.changes ?? 0) !== 1) return throwCategoryConflict(env, projectId, categoryId);
	return categoryMutationResult({
		category: await currentPublicCategory(env, projectId, categoryId),
		previousCategory: await publicCategory(current),
		changed: true,
	}, auditIntent);
}

export async function setProjectCategoryStatus(env, {
	projectId, categoryId, status, expectedRevision, actorUserId = null, auditIntent = null,
}) {
	if (!["active", "archived"].includes(status)) {
		throw new OrgError("invalid_status", "Status must be active or archived.");
	}
	const current = await requireCurrentCategory(env, projectId, categoryId, expectedRevision);
	if (current.status === status) {
		const unchanged = { category: await currentPublicCategory(env, projectId, categoryId), previousCategory: await publicCategory(current), changed: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	if (current.status === "active" && status === "archived") {
		const usage = (await categoryUsageMap(env, projectId, current.memory_owner_user_id)).get(categoryId)
			?? { nodes: 0, pages: 0, candidates: 0, atoms: 0, total: 0 };
		if (usage.total > 0) {
			const error = new OrgError(
				"category_in_use",
				"Reassign this category's memories, or move them to Uncategorized, before archiving it.",
				409,
			);
			error.currentCategory = { ...(await publicCategory(current, usage)), usage };
			throw error;
		}
	}
	if (status === "active") {
		const active = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ? AND status = 'active'",
		).bind(projectId).first();
		if (Number(active?.n ?? 0) >= MAX_PROJECT_CATEGORIES) {
			throw new OrgError("category_limit_reached", `A project can have at most ${MAX_PROJECT_CATEGORIES} active categories.`, 409);
		}
	}
	const at = nextTimestamp(current.updated_at);
	const statement = env.DB.prepare(
		`WITH memory_spaces(user_id) AS (
			SELECT ? UNION SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		)
		UPDATE project_categories SET status = ?, updated_by_user_id = ?, updated_at = ?
		  WHERE id = ? AND project_id = ? AND updated_at = ?
		    AND (? <> 'active' OR (SELECT COUNT(*) FROM project_categories WHERE project_id = ? AND status = 'active') < ?)
		    AND (? <> 'archived' OR NOT EXISTS (
			SELECT 1 FROM nodes n JOIN memory_spaces s ON s.user_id = n.user_id WHERE n.project_category_id = ?
			UNION ALL
			SELECT 1 FROM memory_pages p JOIN memory_spaces s ON s.user_id = p.user_id WHERE p.project_category_id = ?
			UNION ALL
			SELECT 1 FROM candidates c JOIN memory_spaces s ON s.user_id = c.user_id WHERE c.project_category_id = ?
			UNION ALL
			SELECT 1 FROM semantic_atom_candidates a JOIN memory_spaces s ON s.user_id = a.user_id WHERE a.project_category_id = ?
		    ))`,
	).bind(
		current.memory_owner_user_id, projectId,
		status, actorUserId, at, categoryId, projectId, current.updated_at,
		status, projectId, MAX_PROJECT_CATEGORIES,
		status, categoryId, categoryId, categoryId, categoryId,
	);
	let result;
	try {
		[result] = await runCategoryBatch(env, auditIntent, [statement], auditIntent ? {
			preconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ?",
				[categoryId, projectId, current.updated_at],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ? AND status = ?",
				[categoryId, projectId, at, status],
			)],
		} : {});
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await categoryRow(env, projectId, categoryId);
			if (!latest || Number(latest.updated_at) !== Number(current.updated_at)) {
				return throwCategoryConflict(env, projectId, categoryId);
			}
		}
		throw error;
	}
	if (Number(result.meta?.changes ?? 0) !== 1) {
		const latest = await categoryRow(env, projectId, categoryId);
		if (latest && Number(latest.updated_at) === Number(current.updated_at) && status === "active") {
			throw new OrgError("category_limit_reached", `A project can have at most ${MAX_PROJECT_CATEGORIES} active categories.`, 409);
		}
		if (latest && Number(latest.updated_at) === Number(current.updated_at)
			&& current.status === "active" && status === "archived") {
			const usage = (await categoryUsageMap(env, projectId, current.memory_owner_user_id)).get(categoryId)
				?? { nodes: 0, pages: 0, candidates: 0, atoms: 0, total: 0 };
			if (usage.total > 0) {
				const error = new OrgError(
					"category_in_use",
					"Reassign this category's memories, or move them to Uncategorized, before archiving it.",
					409,
				);
				error.currentCategory = { ...(await publicCategory(latest, usage)), usage };
				throw error;
			}
		}
		return throwCategoryConflict(env, projectId, categoryId);
	}
	return categoryMutationResult({
		category: await currentPublicCategory(env, projectId, categoryId),
		previousCategory: await publicCategory(current),
		changed: true,
	}, auditIntent);
}

export async function reassignProjectCategory(env, {
	projectId, categoryId, targetCategoryId = null, expectedRevision, actorUserId = null, auditIntent = null,
}) {
	const current = await requireCurrentCategory(env, projectId, categoryId, expectedRevision);
	if (targetCategoryId === categoryId) {
		throw new OrgError("invalid_category_reassignment", "Choose a different replacement category.");
	}
	if (targetCategoryId !== null) {
		const target = await categoryRow(env, projectId, targetCategoryId);
		if (!target || target.status !== "active") {
			throw new OrgError("replacement_category_not_found", "The replacement must be an active category in this project.", 404);
		}
	}
	const at = nextTimestamp(current.updated_at);
	const statements = ["nodes", "memory_pages", "candidates", "semantic_atom_candidates"].map((table) => env.DB.prepare(
		`WITH memory_spaces(user_id) AS (
			SELECT ? UNION SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		)
		UPDATE ${table} SET project_category_id = ?
		 WHERE project_category_id = ? AND user_id IN (SELECT user_id FROM memory_spaces)
		   AND EXISTS (SELECT 1 FROM project_categories src
		                WHERE src.id = ? AND src.project_id = ? AND src.updated_at = ?)
		   AND (? IS NULL OR EXISTS (SELECT 1 FROM project_categories dst
		                WHERE dst.id = ? AND dst.project_id = ? AND dst.status = 'active'))`,
	).bind(
		current.memory_owner_user_id, projectId, targetCategoryId, categoryId,
		categoryId, projectId, current.updated_at,
		targetCategoryId, targetCategoryId, projectId,
	));
	statements.push(env.DB.prepare(
		`UPDATE project_categories SET updated_by_user_id = ?, updated_at = ?
		  WHERE id = ? AND project_id = ? AND updated_at = ?
		    AND (? IS NULL OR EXISTS (SELECT 1 FROM project_categories dst
		         WHERE dst.id = ? AND dst.project_id = ? AND dst.status = 'active'))`,
	).bind(actorUserId, at, categoryId, projectId, current.updated_at, targetCategoryId, targetCategoryId, projectId));
	let results;
	try {
		results = await runCategoryBatch(env, auditIntent, statements, auditIntent ? {
			preconditions: [
				auditInvariantStatement(
					env,
					"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ?",
					[categoryId, projectId, current.updated_at],
				),
				...(targetCategoryId === null ? [] : [auditInvariantStatement(
					env,
					"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND status = 'active'",
					[targetCategoryId, projectId],
				)]),
			],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ?",
				[categoryId, projectId, at],
			)],
		} : {});
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await categoryRow(env, projectId, categoryId);
			if (!latest || Number(latest.updated_at) !== Number(current.updated_at)) {
				return throwCategoryConflict(env, projectId, categoryId);
			}
		}
		throw error;
	}
	if (Number(results.at(-1)?.meta?.changes ?? 0) !== 1) return throwCategoryConflict(env, projectId, categoryId);
	return categoryMutationResult({
		category: await currentPublicCategory(env, projectId, categoryId),
			reassigned: {
				nodes: Number(results[0]?.meta?.changes ?? 0),
				pages: Number(results[1]?.meta?.changes ?? 0),
				candidates: Number(results[2]?.meta?.changes ?? 0),
				atoms: Number(results[3]?.meta?.changes ?? 0),
				target_category_id: targetCategoryId,
			},
	}, auditIntent);
}

export async function deleteProjectCategory(env, { projectId, categoryId, expectedRevision, auditIntent = null }) {
	const current = await requireCurrentCategory(env, projectId, categoryId, expectedRevision);
	const statement = env.DB.prepare(
		`WITH memory_spaces(user_id) AS (
			SELECT ? UNION SELECT memory_user_id FROM project_memory_spaces WHERE project_id = ?
		)
		DELETE FROM project_categories
		 WHERE id = ? AND project_id = ? AND updated_at = ?
		   AND NOT EXISTS (
			SELECT 1 FROM nodes n JOIN memory_spaces s ON s.user_id = n.user_id WHERE n.project_category_id = ?
			UNION ALL
			SELECT 1 FROM memory_pages p JOIN memory_spaces s ON s.user_id = p.user_id WHERE p.project_category_id = ?
			UNION ALL
			SELECT 1 FROM candidates c JOIN memory_spaces s ON s.user_id = c.user_id WHERE c.project_category_id = ?
			UNION ALL
			SELECT 1 FROM semantic_atom_candidates a JOIN memory_spaces s ON s.user_id = a.user_id WHERE a.project_category_id = ?
		   )`,
	).bind(
		current.memory_owner_user_id, projectId,
		categoryId, projectId, current.updated_at,
		categoryId, categoryId, categoryId, categoryId,
	);
	let result;
	try {
		[result] = await runCategoryBatch(env, auditIntent, [statement], auditIntent ? {
			preconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM project_categories WHERE id = ? AND project_id = ? AND updated_at = ?",
				[categoryId, projectId, current.updated_at],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM project_categories WHERE id = ? AND project_id = ?)",
				[categoryId, projectId],
			)],
		} : {});
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const latest = await categoryRow(env, projectId, categoryId);
			if (!latest || Number(latest.updated_at) !== Number(current.updated_at)) {
				return throwCategoryConflict(env, projectId, categoryId);
			}
		}
		throw error;
	}
	if (Number(result.meta?.changes ?? 0) !== 1) {
		const latest = await categoryRow(env, projectId, categoryId);
		if (!latest || Number(latest.updated_at) !== Number(current.updated_at)) {
			return throwCategoryConflict(env, projectId, categoryId);
		}
		const usage = (await categoryUsageMap(env, projectId, current.memory_owner_user_id)).get(categoryId)
			?? { nodes: 0, pages: 0, candidates: 0, atoms: 0, total: 0 };
		const error = new OrgError(
			"category_in_use",
			"This category is assigned to memories. Archive it or explicitly reassign those memories before deleting it.",
			409,
		);
		error.currentCategory = { ...(await publicCategory(latest, usage)), usage };
		throw error;
	}
	return categoryMutationResult({ ok: true, deleted: true, category: await publicCategory(current) }, auditIntent);
}

/** Active rows are the sole managed-project extraction allowlist. */
export async function activeCategoryRules(env, { projectId, memoryOwnerUserId, legacy = [] }) {
	await migrateLegacyCategories(env, { projectId, memoryOwnerUserId, legacy });
	const { results } = await env.DB.prepare(
		`SELECT id, slug, name, description, color_token
		   FROM project_categories
		  WHERE project_id = ? AND status = 'active'
		  ORDER BY name COLLATE NOCASE ASC`,
	).bind(projectId).all();
	return (results ?? []).map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.slug,
		displayName: row.name,
		description: row.description ?? "",
		colorToken: row.color_token ?? defaultColorToken(row.slug),
	}));
}

/** Read-only variant for previews: never materializes legacy JSON rows. */
export async function activeCategoryRulesReadOnly(env, { projectId, legacy = [] }) {
	const { results } = await env.DB.prepare(
		`SELECT id, slug, name, description, color_token
		   FROM project_categories
		  WHERE project_id = ? AND status = 'active'
		  ORDER BY name COLLATE NOCASE ASC`,
	).bind(projectId).all();
	if ((results ?? []).length) return (results ?? []).map((row) => ({
		id: row.id,
		slug: row.slug,
		name: row.slug,
		displayName: row.name,
		description: row.description ?? "",
		colorToken: row.color_token ?? defaultColorToken(row.slug),
	}));
	const seen = new Set();
	return (Array.isArray(legacy) ? legacy : []).slice(0, MAX_PROJECT_CATEGORIES).flatMap((entry) => {
		const name = String(entry?.name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
		const slug = categorySlug(name);
		if (!slug || BUILTIN_SLUGS.has(slug) || seen.has(slug)) return [];
		seen.add(slug);
		return [{
			id: `legacy:${slug}`,
			slug,
			name: slug,
			displayName: name,
			description: cleanDescription(entry?.description) ?? "",
			colorToken: cleanColorToken(entry?.color_token, slug),
		}];
	});
}

/** Resolve archived as well as active ids for graph/history display. */
export async function projectCategoryMetadata(env, projectId) {
	const { results } = await env.DB.prepare(
		`SELECT id, slug, name, color_token, status FROM project_categories
		  WHERE project_id = ? ORDER BY name COLLATE NOCASE ASC`,
	).bind(projectId).all();
	return new Map((results ?? []).map((row) => [row.id, {
		id: row.id,
		slug: row.slug,
		name: row.name,
		color_token: row.color_token ?? defaultColorToken(row.slug),
		status: row.status,
	}]));
}
