import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";
import { recall, RecallScopeError } from "../src/pipeline/recall.js";

const NOW = Date.now();

function projectValues(projectId, projectName) {
	return [projectId ?? null, projectName ?? null];
}

async function seedScope(userId, tag, projectId, projectName) {
	const key = `${userId}-${tag}`;
	const [storedProjectId, storedProjectName] = projectValues(projectId, projectName);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO nodes
				(id, user_id, label, category, state, summary, created_at, updated_at, heat_score,
				 project_id, project_name)
			 VALUES (?, ?, 'Scopeprobe decision', 'project', 'active', ?, ?, ?, 1, ?, ?)`,
		).bind(`${key}-node`, userId, `${tag} node detail`, NOW, NOW, storedProjectId, storedProjectName),
		env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, title, canonical_title, short_summary, created_at, updated_at,
				 project_id, project_name)
			 VALUES (?, ?, 'Scopeprobe decision', 'scopeprobe decision', ?, ?, ?, ?, ?)`,
		).bind(`${key}-page`, userId, `${tag} page detail`, NOW, NOW, storedProjectId, storedProjectName),
		env.DB.prepare(
			`INSERT INTO slices
				(id, user_id, node_id, text, kind, is_current, created_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, 'decision', 1, ?, ?, ?)`,
		).bind(`${key}-slice`, userId, `${key}-node`, `${tag} slice detail`, NOW, storedProjectId, storedProjectName),
		env.DB.prepare(
			`INSERT INTO events
				(id, user_id, node_id, action, text, created_at, project_id, project_name)
			 VALUES (?, ?, ?, 'decided', ?, ?, ?, ?)`,
		).bind(`${key}-event`, userId, `${key}-node`, `${tag} event detail`, NOW, storedProjectId, storedProjectName),
		env.DB.prepare(
			`INSERT INTO edges
				(id, user_id, from_node, to_node, type, fact, created_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, 'RELATED_TO', ?, ?, ?, ?)`,
		).bind(
			`${key}-edge`,
			userId,
			`${key}-node`,
			`${key}-node`,
			`${tag} edge detail`,
			NOW,
			storedProjectId,
			storedProjectName,
		),
		env.DB.prepare(
			`INSERT INTO staged_memories
				(id, user_id, job_id, lane, text, created_at, settled_at, project_id, project_name)
			 VALUES (?, ?, ?, 'test', ?, ?, NULL, ?, ?)`,
		).bind(`${key}-staged`, userId, `${key}-job`, `scopeprobe ${tag} staged detail`, NOW, storedProjectId, storedProjectName),
	]);
}

function projectIds(rows) {
	return rows.map((row) => row.project_id).sort((a, b) => String(a ?? "").localeCompare(String(b ?? "")));
}

describe("project-scoped recall", () => {
	it("keeps default/global account-wide and never dedupes identical labels across projects", async () => {
		const userId = `recall-global-${crypto.randomUUID()}`;
		await seedScope(userId, "global", null, null);
		await seedScope(userId, "alpha", "alpha", "Alpha Project");
		await seedScope(userId, "beta", "beta", "Beta Project");

		// A project identity does not implicitly narrow recall. Only recallScope
		// does that; the default remains the complete account memory.
		const result = await recall(env, getConfig(env), userId, "What is the scopeprobe decision?", {
			memoryScope: { projectId: "alpha" },
		});

		expect(result.nodes).toHaveLength(3);
		expect(result.pages).toHaveLength(3);
		expect(projectIds(result.nodes)).toEqual([null, "alpha", "beta"]);
		expect(projectIds(result.pages)).toEqual([null, "alpha", "beta"]);
		expect(projectIds(result.items)).toEqual([null, null, "alpha", "alpha", "beta", "beta"]);
		expect(result.staged_count).toBe(3);
		expect(result.context).toContain("global staged detail");
		expect(result.context).toContain("alpha staged detail");
		expect(result.context).toContain("beta staged detail");
	});

	it("project_only returns exact-project rows and provenance for every canonical object", async () => {
		const userId = `recall-only-${crypto.randomUUID()}`;
		await seedScope(userId, "global", null, null);
		await seedScope(userId, "alpha", "alpha", "Alpha Project");
		await seedScope(userId, "beta", "beta", "Beta Project");

		const result = await recall(env, getConfig(env), userId, "What is the scopeprobe decision?", {
			recallScope: "project_only",
			memoryScope: { projectId: "alpha", projectName: "Alpha Project" },
		});

		expect(result.nodes).toHaveLength(1);
		expect(result.pages).toHaveLength(1);
		expect(result.items).toHaveLength(2);
		expect(result.nodes[0]).toMatchObject({ project_id: "alpha", project_name: "Alpha Project" });
		expect(result.pages[0]).toMatchObject({ project_id: "alpha", project_name: "Alpha Project" });
		expect(result.nodes[0].slices).toEqual([
			expect.objectContaining({ text: "alpha slice detail", project_id: "alpha", project_name: "Alpha Project" }),
		]);
		expect(result.nodes[0].events).toEqual([
			expect.objectContaining({ text: "alpha event detail", project_id: "alpha", project_name: "Alpha Project" }),
		]);
		expect(result.nodes[0].relations).toEqual(["alpha edge detail"]);
		expect(result.items.every((item) => item.project_id === "alpha")).toBe(true);
		expect(result.staged_count).toBe(1);
		expect(result.context).toContain("alpha staged detail");
		expect(result.context).not.toContain("global staged detail");
		expect(result.context).not.toContain("beta staged detail");
		expect(result.vector_used).toBe(false);
	});

	it("project_then_global includes the exact project and NULL, never another project", async () => {
		const userId = `recall-fallback-${crypto.randomUUID()}`;
		await seedScope(userId, "global", null, null);
		await seedScope(userId, "alpha", "alpha", "Alpha Project");
		await seedScope(userId, "beta", "beta", "Beta Project");

		const result = await recall(env, getConfig(env), userId, "What is the scopeprobe decision?", {
			recallScope: "project_then_global",
			memoryScope: { projectId: "alpha", projectName: "Alpha Project" },
		});

		expect(projectIds(result.nodes)).toEqual([null, "alpha"]);
		expect(projectIds(result.pages)).toEqual([null, "alpha"]);
		expect(new Set(result.items.map((item) => item.project_id))).toEqual(new Set([null, "alpha"]));
		expect(result.nodes.flatMap((node) => node.relations).sort()).toEqual([
			"alpha edge detail",
			"global edge detail",
		]);
		expect(result.staged_count).toBe(2);
		expect(result.context).toContain("global staged detail");
		expect(result.context).toContain("alpha staged detail");
		expect(result.context).not.toContain("beta staged detail");
	});

	it.each(["project_only", "project_then_global"])("requires memoryScope.projectId for %s", async (recallScope) => {
		await expect(recall(env, getConfig(env), "missing-project", "What is the scopeprobe decision?", {
			recallScope,
			memoryScope: { projectName: "Name alone is not identity" },
		})).rejects.toMatchObject({
			name: "RecallScopeError",
			code: "project_id_required",
			status: 400,
		});
	});

	it("rejects unknown recall scopes before touching storage", async () => {
		await expect(recall(env, getConfig(env), "invalid-scope", "scopeprobe", {
			recallScope: "nearby_projects",
		})).rejects.toEqual(expect.objectContaining({
			name: "RecallScopeError",
			code: "invalid_recall_scope",
			status: 400,
		}));
		expect(RecallScopeError.prototype).toBeInstanceOf(Error);
	});

	it("filters events before the bounded event scan LIMIT", async () => {
		const userId = `recall-event-limit-${crypto.randomUUID()}`;
		const nodeId = `${userId}-node`;
		await env.DB.prepare(
			`INSERT INTO nodes
				(id, user_id, label, category, state, created_at, updated_at, project_id, project_name)
			 VALUES (?, ?, 'Scopeprobe needle', 'project', 'active', ?, ?, 'alpha', 'Alpha Project')`,
		).bind(nodeId, userId, NOW, NOW).run();
		await env.DB.prepare(
			`INSERT INTO events
				(id, user_id, node_id, action, text, created_at, project_id, project_name)
			 VALUES (?, ?, ?, 'decided', 'alpha target event', ?, 'alpha', 'Alpha Project')`,
		).bind(`${userId}-target`, userId, nodeId, NOW - 10_000).run();
		await env.DB.prepare(
			`WITH RECURSIVE seq(x) AS (
				VALUES (1) UNION ALL SELECT x + 1 FROM seq WHERE x < 550
			)
			INSERT INTO events
				(id, user_id, node_id, action, text, created_at, project_id, project_name)
			SELECT ? || x, ?, 'other-project-node', 'other', 'beta noise', ? + x, 'beta', 'Beta Project'
			FROM seq`,
		).bind(`${userId}-noise-`, userId, NOW).run();

		const result = await recall(env, getConfig(env), userId, "What is the scopeprobe needle?", {
			recallScope: "project_only",
			memoryScope: { projectId: "alpha" },
		});

		expect(result.nodes).toHaveLength(1);
		expect(result.nodes[0].events.map((event) => event.text)).toEqual(["alpha target event"]);
	});

	it("does not query unscopable BM25 or vector indexes in project modes", async () => {
		const userId = `recall-indexes-${crypto.randomUUID()}`;
		await seedScope(userId, "alpha", "alpha", "Alpha Project");
		let bm25Calls = 0;
		let vectorCalls = 0;
		const scopedEnv = {
			DB: {
				prepare(sql) {
					if (String(sql).includes("manual_search_fts")) bm25Calls++;
					return env.DB.prepare(sql);
				},
				batch: env.DB.batch.bind(env.DB),
			},
			AI: {
				async run() {
					vectorCalls++;
					return { data: [[0.1, 0.2]] };
				},
			},
			VECTORIZE: {
				async query() {
					vectorCalls++;
					return { matches: [] };
				},
			},
		};

		const result = await recall(scopedEnv, { ...getConfig(env), useVectors: true }, userId, "scopeprobe", {
			recallScope: "project_only",
			memoryScope: { projectId: "alpha" },
		});

		expect(result.count).toBeGreaterThan(0);
		expect(bm25Calls).toBe(0);
		expect(vectorCalls).toBe(0);
		expect(result.vector_used).toBe(false);
	});
});
