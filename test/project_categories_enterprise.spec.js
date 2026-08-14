import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/ids.js";
import { getConfig } from "../src/config.js";
import { buildAtomicProjection } from "../src/pipeline/atomic_projection.mjs";
import { writeApproved } from "../src/pipeline/write.js";
import {
	activeCategoryRules,
	CATEGORY_COLOR_TOKENS,
	createProjectCategory,
	deleteProjectCategory,
	listProjectCategories,
	projectCategoryMetadata,
	reassignProjectCategory,
	setProjectCategoryStatus,
	updateProjectCategory,
	MAX_PROJECT_CATEGORY_HISTORY,
} from "../src/lib/project_categories.js";

function fixture() {
	return {
		projectId: newId("proj"),
		memoryOwnerUserId: newId("mem"),
		actorUserId: newId("usr"),
	};
}

async function createCategory(base, name = "Customer success", extra = {}) {
	return createProjectCategory(env, {
		...base,
		name,
		description: "Renewals and account health",
		colorToken: "teal",
		...extra,
	});
}

describe("enterprise project categories", () => {
	it("uses stable ids, bounded palette tokens, revisions and optimistic CAS", async () => {
		const base = fixture();
		const created = await createCategory(base);
		expect(created.category).toMatchObject({
			slug: "customer_success",
			color_token: "teal",
			status: "active",
			usage: { nodes: 0, pages: 0, candidates: 0, total: 0 },
			created_by_user_id: base.actorUserId,
			updated_by_user_id: base.actorUserId,
		});
		expect(created.category.id).toMatch(/^cat_/);
		expect(created.category.revision).toMatch(/^crv1\.[0-9a-f]{64}$/);

		await expect(updateProjectCategory(env, {
			projectId: base.projectId,
			categoryId: created.category.id,
			name: "Accounts",
		})).rejects.toMatchObject({ code: "precondition_required", status: 428 });

		const updated = await updateProjectCategory(env, {
			projectId: base.projectId,
			categoryId: created.category.id,
			name: "Accounts",
			colorToken: "indigo",
			expectedRevision: created.category.revision,
			actorUserId: `${base.actorUserId}-editor`,
		});
		expect(updated.category).toMatchObject({
			id: created.category.id,
			slug: "customer_success",
			name: "Accounts",
			color_token: "indigo",
			created_by_user_id: base.actorUserId,
			updated_by_user_id: `${base.actorUserId}-editor`,
		});
		expect(updated.category.revision).not.toBe(created.category.revision);
		const noOp = await updateProjectCategory(env, {
			projectId: base.projectId,
			categoryId: created.category.id,
			name: "Accounts",
			colorToken: "indigo",
			expectedRevision: updated.category.revision,
			actorUserId: `${base.actorUserId}-noop`,
		});
		expect(noOp.changed).toBe(false);
		expect(noOp.category).toMatchObject({
			revision: updated.category.revision,
			updated_by_user_id: `${base.actorUserId}-editor`,
			updated_at: updated.category.updated_at,
		});
		await expect(updateProjectCategory(env, {
			projectId: newId("proj"),
			categoryId: created.category.id,
			name: "Cross-project overwrite",
			expectedRevision: updated.category.revision,
			actorUserId: newId("user"),
		})).rejects.toMatchObject({ code: "category_not_found", status: 404 });

		await expect(updateProjectCategory(env, {
			projectId: base.projectId,
			categoryId: created.category.id,
			name: "Stale overwrite",
			expectedRevision: created.category.revision,
		})).rejects.toMatchObject({
			code: "category_conflict",
			status: 412,
			currentCategory: { name: "Accounts", revision: updated.category.revision },
		});

		await expect(createCategory(base, "Invalid colour", { colorToken: "#ff00ff" }))
			.rejects.toMatchObject({ code: "invalid_category_color" });
		expect(CATEGORY_COLOR_TOKENS).not.toContain("#ff00ff");
	});

	it("counts only project memory spaces, archives in-use rows and requires explicit reassignment before deletion", async () => {
		const base = fixture();
		const subtenant = newId("mem");
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			).bind(base.projectId, base.memoryOwnerUserId, base.memoryOwnerUserId, now, now),
			env.DB.prepare(
				`INSERT INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			).bind(base.projectId, base.memoryOwnerUserId, subtenant, now, now),
		]);
		const created = await createCategory(base);
		const id = created.category.id;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, created_at, updated_at, project_category_id) VALUES (?, ?, 'Acme', 'organization', ?, ?, ?)",
			).bind(newId("node"), base.memoryOwnerUserId, now, now, id),
			env.DB.prepare(
				"INSERT INTO memory_pages (id, user_id, title, canonical_title, created_at, updated_at, project_category_id) VALUES (?, ?, 'Plan', 'plan', ?, ?, ?)",
			).bind(newId("page"), subtenant, now, now, id),
			env.DB.prepare(
				"INSERT INTO candidates (id, user_id, label, created_at, project_category_id) VALUES (?, ?, 'Renewal', ?, ?)",
			).bind(newId("candidate"), subtenant, now, id),
			// A forged/cross-project tenant must never contribute to usage or be
			// rewritten by category governance for this project.
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, created_at, updated_at, project_category_id) VALUES (?, ?, 'Foreign', 'other', ?, ?, ?)",
			).bind(newId("node"), newId("mem"), now, now, id),
		]);

		let [row] = await listProjectCategories(env, base);
		expect(row.usage).toEqual({ nodes: 1, pages: 1, candidates: 1, atoms: 0, total: 3 });
		await expect(deleteProjectCategory(env, {
			projectId: base.projectId,
			categoryId: id,
			expectedRevision: row.revision,
		})).rejects.toMatchObject({ code: "category_in_use", status: 409 });

		await expect(setProjectCategoryStatus(env, {
			projectId: base.projectId,
			categoryId: id,
			status: "archived",
			expectedRevision: row.revision,
		})).rejects.toMatchObject({ code: "category_in_use", status: 409 });

		const reassigned = await reassignProjectCategory(env, {
			projectId: base.projectId,
			categoryId: id,
			targetCategoryId: null,
			expectedRevision: row.revision,
			actorUserId: `${base.actorUserId}-reassign`,
		});
		expect(reassigned.reassigned).toEqual({ nodes: 1, pages: 1, candidates: 1, atoms: 0, target_category_id: null });
		expect(reassigned.category.usage.total).toBe(0);
		expect(reassigned.category.updated_by_user_id).toBe(`${base.actorUserId}-reassign`);
		const archived = await setProjectCategoryStatus(env, {
			projectId: base.projectId,
			categoryId: id,
			status: "archived",
			expectedRevision: reassigned.category.revision,
			actorUserId: `${base.actorUserId}-archive`,
		});
		expect(archived.category.updated_by_user_id).toBe(`${base.actorUserId}-archive`);
		expect(await activeCategoryRules(env, base)).toEqual([]);
		expect((await projectCategoryMetadata(env, base.projectId)).get(id)).toMatchObject({
			id,
			name: "Customer success",
			status: "archived",
			color_token: "teal",
		});
		await expect(deleteProjectCategory(env, {
			projectId: base.projectId,
			categoryId: id,
			expectedRevision: archived.category.revision,
		})).resolves.toMatchObject({ deleted: true });

		const foreign = await env.DB.prepare("SELECT project_category_id FROM nodes WHERE label = 'Foreign'").first();
		expect(foreign.project_category_id).toBe(id);
	});

	it("makes the active table authoritative and enforces the 32-row cap inside the insert", async () => {
		const base = fixture();
		const migrated = await activeCategoryRules(env, {
			...base,
			legacy: [{ name: "Legacy queue", description: "Migrated once" }],
		});
		expect(migrated).toHaveLength(1);
		expect(migrated[0]).toMatchObject({ slug: "legacy_queue", name: "legacy_queue" });
		expect(migrated[0].id).toMatch(/^cat_/);

		for (let index = 1; index < 31; index += 1) {
			await createCategory(base, `Queue ${index}`, { colorToken: "blue" });
		}
		const results = await Promise.allSettled([
			createCategory(base, "Boundary A"),
			createCategory(base, "Boundary B"),
		]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((item) => item.status === "rejected")[0].reason)
			.toMatchObject({ code: "category_limit_reached", status: 409 });
		expect((await listProjectCategories(env, base)).filter((row) => row.status === "active")).toHaveLength(32);
	});

	it("bounds archived category history atomically at 128 rows", async () => {
		const base = fixture();
		const at = Date.now();
		const statements = Array.from({ length: MAX_PROJECT_CATEGORY_HISTORY - 1 }, (_, index) => env.DB.prepare(
			`INSERT INTO project_categories
			 (id, project_id, memory_owner_user_id, slug, name, status, created_at, updated_at, color_token)
			 VALUES (?, ?, ?, ?, ?, 'archived', ?, ?, 'slate')`,
		).bind(
			newId("cat"), base.projectId, base.memoryOwnerUserId,
			`archived_${index}`, `Archived ${index}`, at + index, at + index,
		));
		for (let offset = 0; offset < statements.length; offset += 50) {
			await env.DB.batch(statements.slice(offset, offset + 50));
		}
		const boundary = await Promise.allSettled([
			createCategory(base, "History boundary A"),
			createCategory(base, "History boundary B"),
		]);
		expect(boundary.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(boundary.filter((item) => item.status === "rejected")[0].reason).toMatchObject({
			code: "category_history_limit_reached",
			status: 409,
		});
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_categories WHERE project_id = ?",
		).bind(base.projectId).first()).n)).toBe(MAX_PROJECT_CATEGORY_HISTORY);
	});

	it("canonicalizes a legacy late commit to Uncategorized when archive wins", async () => {
		const base = fixture();
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'Late category', 'late category', 0, 'active', ?, ?)`,
		).bind(base.projectId, base.actorUserId, base.memoryOwnerUserId, at, at).run();
		const created = await createCategory(base, "Late category");
		const archived = await setProjectCategoryStatus(env, {
			projectId: base.projectId,
			categoryId: created.category.id,
			status: "archived",
			expectedRevision: created.category.revision,
			actorUserId: base.actorUserId,
		});
		expect(archived.category.status).toBe("archived");
		const nodeId = newId("node");
		await writeApproved(env, getConfig(env), base.memoryOwnerUserId, {
			newNodes: [{
				id: nodeId,
				user_id: base.memoryOwnerUserId,
				label: "Late filing",
				category: "project",
				role: null,
				state: "active",
				summary: null,
				created_at: at,
				updated_at: at,
				project_category_id: created.category.id,
			}],
		}, {
			managedProjectId: base.projectId,
			memoryOwnerUserId: base.memoryOwnerUserId,
		});
		expect(await env.DB.prepare("SELECT project_category_id FROM nodes WHERE id = ?")
			.bind(nodeId).first()).toEqual({ project_category_id: null });
		expect((await listProjectCategories(env, base))[0].usage.total).toBe(0);
	});

	it("governs V3 atom-only usage and removes old ids before later projection", async () => {
		const base = fixture();
		const at = Date.now();
		const created = await createCategory(base, "Atomic queue");
		const categoryId = created.category.id;
		const atomId = newId("atom");
		await env.DB.prepare(
			`INSERT INTO semantic_atom_candidates
			 (id, user_id, project_id, capture_run_id, source_episode_id, source_packet_id, chunk_key,
			  source_message_id, start_code_point, end_code_point, evidence_quote, evidence_hash, dedupe_key,
			  atom_type, entity, entity_type, attribute, value, assertion, cardinality, confidence,
			  extraction_model, schema_version, status, created_at, project_category_id)
			 VALUES (?, ?, 'scope', ?, ?, ?, 'chunk', 'message', 0, 4, 'Acme', ?, ?,
			  'fact', 'Acme', 'organization', 'status', 'active', 'Acme is active', 'single', 0.9,
			  'test', 'test/v1', 'candidate', ?, ?)`,
		).bind(
			atomId, base.memoryOwnerUserId, newId("capture"), newId("episode"), newId("packet"),
			`evidence_${crypto.randomUUID()}`, `dedupe_${crypto.randomUUID()}`, at, categoryId,
		).run();
		let [row] = await listProjectCategories(env, base);
		expect(row.usage).toEqual({ nodes: 0, pages: 0, candidates: 0, atoms: 1, total: 1 });
		await expect(setProjectCategoryStatus(env, {
			projectId: base.projectId, categoryId, status: "archived", expectedRevision: row.revision,
		})).rejects.toMatchObject({ code: "category_in_use", status: 409 });
		await expect(deleteProjectCategory(env, {
			projectId: base.projectId, categoryId, expectedRevision: row.revision,
		})).rejects.toMatchObject({ code: "category_in_use", status: 409 });
		const reassigned = await reassignProjectCategory(env, {
			projectId: base.projectId,
			categoryId,
			targetCategoryId: null,
			expectedRevision: row.revision,
			actorUserId: base.actorUserId,
		});
		expect(reassigned.reassigned.atoms).toBe(1);
		const atom = await env.DB.prepare("SELECT * FROM semantic_atom_candidates WHERE id = ?")
			.bind(atomId).first();
		expect(atom.project_category_id).toBeNull();
		const projected = buildAtomicProjection([atom]);
		expect(projected.objects.every((object) => object.project_category_id == null)).toBe(true);
	});
});
