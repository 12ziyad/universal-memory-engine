/**
 * Stage 2 graph-door contract: one authenticated account can inspect its
 * global and project rows together, with provenance, without crossing either
 * modern account boundaries or the old project-as-subtenant boundary.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { scopedMemoryUserId } from "../src/index.js";

const ROOT_ACCOUNT = "graph-project-root";
const OTHER_ACCOUNT = "graph-project-other-root";
const LEGACY_EXTERNAL_ID = "project:shared-basename";
const NOW = 1_786_060_800_000;

const SCOPES = [
	{ tag: "global", projectId: null, projectName: null },
	{ tag: "alpha", projectId: "local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projectName: "Project Alpha" },
	{ tag: "beta", projectId: "local_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", projectName: "Project Beta" },
];

async function seedGraphScope(userId, ownerTag, { tag, projectId, projectName }) {
	const key = `${ownerTag}-${tag}`;
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO nodes
				(id, user_id, label, category, state, summary, created_at, updated_at, project_id, project_name)
			 VALUES (?, ?, ?, 'project', 'active', ?, ?, ?, ?, ?)`,
		).bind(`${key}-node`, userId, `${key} node`, `${key} summary`, NOW, NOW, projectId, projectName),
		env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, title, canonical_title, short_summary, created_at, updated_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(`${key}-page`, userId, `${key} page`, `${key} page`, `${key} page summary`, NOW, NOW, projectId, projectName),
		env.DB.prepare(
			`INSERT INTO slices
				(id, user_id, node_id, text, kind, is_current, created_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, 'decision', 1, ?, ?, ?)`,
		).bind(`${key}-slice`, userId, `${key}-node`, `${key} slice`, NOW, projectId, projectName),
		env.DB.prepare(
			`INSERT INTO events
				(id, user_id, node_id, action, text, created_at, project_id, project_name)
			 VALUES (?, ?, ?, 'decided', ?, ?, ?, ?)`,
		).bind(`${key}-event`, userId, `${key}-node`, `${key} event`, NOW, projectId, projectName),
		env.DB.prepare(
			`INSERT INTO edges
				(id, user_id, from_node, to_node, type, fact, created_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, 'RELATED_TO', ?, ?, ?, ?)`,
		).bind(`${key}-edge`, userId, `${key}-node`, `${key}-node`, `${key} edge`, NOW, projectId, projectName),
		env.DB.prepare(
			`INSERT INTO candidates
				(id, user_id, label, strength, mentions, cluster_hint, status, created_at, project_id, project_name)
			 VALUES (?, ?, ?, 'weak', 1, 'projects_systems', 'pending', ?, ?, ?)`,
		).bind(`${key}-candidate`, userId, `${key} candidate`, NOW, projectId, projectName),
	]);
}

async function seedLegacyProject(ownerId, ownerTag) {
	const memoryUserId = await scopedMemoryUserId(ownerId, LEGACY_EXTERNAL_ID);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO source_packets
				(id, user_id, scope_user_id, memory_user_id, owner_user_id, external_user_id,
				 source_type, source_mode, idempotency_key, content_hash, message_count,
				 created_at, updated_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, ?, ?, 'message_batch', 'plugin', ?, ?, 1, ?, ?, NULL, NULL)`,
		).bind(
			`${ownerTag}-legacy-source`, memoryUserId, memoryUserId, memoryUserId, ownerId,
			LEGACY_EXTERNAL_ID, `${ownerTag}-legacy-idempotency`, `${ownerTag}-legacy-hash`, NOW, NOW,
		),
		env.DB.prepare(
			`INSERT INTO nodes
				(id, user_id, label, category, state, created_at, updated_at)
			 VALUES (?, ?, ?, 'project', 'active', ?, ?)`,
		).bind(`${ownerTag}-legacy-node`, memoryUserId, `${ownerTag} legacy-only node`, NOW, NOW),
		env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, title, canonical_title, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).bind(`${ownerTag}-legacy-page`, memoryUserId, `${ownerTag} legacy-only page`, `${ownerTag} legacy-only page`, NOW, NOW),
	]);
	return memoryUserId;
}

async function graphFor(rootUserId) {
	const request = new Request(`http://example.com/v1/graph?userId=${encodeURIComponent(rootUserId)}`, {
		headers: { "x-api-key": env.API_KEY },
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { response, body: await response.json() };
}

function expectedScope(tag) {
	return SCOPES.find((scope) => scope.tag === tag);
}

describe("GET /v1/graph project provenance", () => {
	it("returns the root account's full scoped graph and reports legacy subtenants separately", async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
				.bind(ROOT_ACCOUNT, "graph-project-root@example.com", NOW),
			env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
				.bind(OTHER_ACCOUNT, "graph-project-other@example.com", NOW),
		]);
		for (const scope of SCOPES) {
			await seedGraphScope(ROOT_ACCOUNT, "own", scope);
			await seedGraphScope(OTHER_ACCOUNT, "foreign", scope);
		}
		await env.DB.prepare(
			"UPDATE candidates SET project_name = 'Project Alpha Renamed', created_at = ? WHERE id = 'own-alpha-candidate'",
		).bind(NOW + 1).run();
		const legacyMemoryUser = await seedLegacyProject(ROOT_ACCOUNT, "own");
		const otherLegacyMemoryUser = await seedLegacyProject(OTHER_ACCOUNT, "foreign");
		await env.DB.prepare(
			`INSERT INTO source_packets
				(id, user_id, scope_user_id, memory_user_id, owner_user_id, external_user_id,
				 source_type, source_mode, idempotency_key, content_hash, message_count,
				 created_at, updated_at, project_id, project_name)
			 VALUES ('poisoned-legacy-source', 'mem_untrusted_target', 'mem_untrusted_target',
				 'mem_untrusted_target', ?, 'project:poisoned', 'message_batch', 'plugin',
				 'poisoned-legacy-idempotency', 'poisoned-legacy-hash', 1, ?, ?, NULL, NULL)`,
		).bind(ROOT_ACCOUNT, NOW, NOW).run();

		const { response, body } = await graphFor(ROOT_ACCOUNT);

		expect(response.status).toBe(200);
		expect(body.stats).toMatchObject({
			nodes: 3,
			pages: 3,
			slices: 3,
			events: 3,
			edges: 3,
			candidates: 3,
		});

		const nodesById = new Map(body.nodes.map((row) => [row.id, row]));
		const pagesById = new Map(body.pages.map((row) => [row.id, row]));
		const edgesById = new Map(body.edges.map((row) => [row.id, row]));
		const candidatesById = new Map(body.candidates.map((row) => [row.id, row]));
		for (const tag of ["global", "alpha", "beta"]) {
			const scope = expectedScope(tag);
			const provenance = { project_id: scope.projectId, project_name: scope.projectName };
			const node = nodesById.get(`own-${tag}-node`);
			expect(node).toMatchObject({ user_id: ROOT_ACCOUNT, ...provenance });
			expect(node.slices).toEqual([
				expect.objectContaining({ id: `own-${tag}-slice`, user_id: ROOT_ACCOUNT, ...provenance }),
			]);
			expect(node.events).toEqual([
				expect.objectContaining({ id: `own-${tag}-event`, user_id: ROOT_ACCOUNT, ...provenance }),
			]);
			expect(pagesById.get(`own-${tag}-page`)).toMatchObject({ user_id: ROOT_ACCOUNT, ...provenance });
			expect(edgesById.get(`own-${tag}-edge`)).toMatchObject({ user_id: ROOT_ACCOUNT, ...provenance });
			expect(candidatesById.get(`own-${tag}-candidate`)).toMatchObject({
				user_id: ROOT_ACCOUNT,
				project_id: scope.projectId,
				project_name: tag === "alpha" ? "Project Alpha Renamed" : scope.projectName,
			});
		}

		expect(body.projects).toEqual([
			{
				project_id: SCOPES[1].projectId,
				project_name: "Project Alpha Renamed",
				nodes: 1,
				pages: 1,
				slices: 1,
				events: 1,
				edges: 1,
				candidates: 1,
			},
			{
				project_id: SCOPES[2].projectId,
				project_name: SCOPES[2].projectName,
				nodes: 1,
				pages: 1,
				slices: 1,
				events: 1,
				edges: 1,
				candidates: 1,
			},
		]);
		expect(body.scope_model).toEqual({
			default_recall: "global",
			project_recall: ["project_only", "project_then_global"],
			global_rows_use_null_project_id: true,
		});

		expect(body.legacy_project_scopes).toEqual([
			{
				external_user_id: LEGACY_EXTERNAL_ID,
				project_name: "shared-basename",
				source_packets: 1,
				nodes: 1,
				pages: 1,
				last_seen_at: NOW,
				migration_status: "legacy_subtenant_read_only",
			},
		]);
		expect(body.legacy_project_scopes[0]).not.toHaveProperty("memory_user_id");

		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("foreign-");
		expect(serialized).not.toContain(OTHER_ACCOUNT);
		expect(serialized).not.toContain(legacyMemoryUser);
		expect(serialized).not.toContain(otherLegacyMemoryUser);
		expect(serialized).not.toContain("poisoned");
		expect(serialized).not.toContain("own legacy-only");
	});
});
