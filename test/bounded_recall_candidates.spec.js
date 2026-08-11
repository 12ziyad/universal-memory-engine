import { env } from "cloudflare:test";
import { expect, it } from "vitest";

import { getConfig } from "../src/config.js";
import {
	V3_RECALL_EDGE_LOAD_MAX,
	V3_RECALL_EVENT_LOAD_MAX,
	V3_RECALL_LANE_MAX,
	V3_RECALL_NODE_LOAD_MAX,
	V3_RECALL_PAGE_LOAD_MAX,
	V3_RECALL_SLICE_LOAD_MAX,
} from "../src/pipeline/bounded_recall_candidates.mjs";
import { recall } from "../src/pipeline/recall.js";

function treatment(userId) {
	return {
		...env,
		USE_VECTORS: "false",
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
	};
}

it("bounds the D1-to-Worker evidence corpus before E7 fusion at long-history depth", async () => {
	const userId = `bounded-corpus-${crypto.randomUUID()}`;
	const safeUser = userId.replaceAll("'", "''");
	const size = 1_000;
	const project = "CASE WHEN i % 5 = 0 THEN 'beta' ELSE 'alpha' END";
	await env.DB.prepare(`WITH RECURSIVE seq(i) AS (
		VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<${size}
	) INSERT INTO nodes
	(id,user_id,label,category,state,summary,created_at,updated_at,heat_score,project_id)
	SELECT 'bounded_node_'||i,'${safeUser}',
	 CASE WHEN i=1 THEN 'Remote heliotrope decision'
	      WHEN i%5=0 THEN 'Beta sibling canary '||i ELSE 'Alpha memory project '||i END,
	 'project','active','bounded fixture',i,i,1,${project} FROM seq`).run();
	await env.DB.prepare(`WITH RECURSIVE seq(i) AS (
		VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<${size}
	) INSERT INTO slices
	(id,user_id,node_id,text,kind,is_current,created_at,project_id)
	SELECT 'bounded_slice_'||i,'${safeUser}','bounded_node_'||i,
	 CASE WHEN i=1 THEN 'Launch codeword is heliotrope.'
	      WHEN i%5=0 THEN 'betacanary sibling assertion '||i ELSE 'alpha memory assertion '||i END,
	 'fact',1,i,${project} FROM seq`).run();
	await env.DB.prepare(`WITH RECURSIVE seq(i) AS (
		VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<${size}
	) INSERT INTO edges
	(id,user_id,from_node,to_node,type,fact,weight,created_at,project_id)
	SELECT 'bounded_edge_'||i,'${safeUser}',
	 CASE WHEN i%5=0 THEN 'bounded_node_5' ELSE 'bounded_node_1' END,
	 'bounded_node_'||i,'RELATED_TO',
	 CASE WHEN i%5=0 THEN 'betacanary relation '||i ELSE 'alpha relation '||i END,
	 1,i,${project} FROM seq`).run();

	const localEnv = treatment(userId);
	const result = await recall(localEnv, getConfig(localEnv), userId,
		"What is the launch codeword for the remote heliotrope decision?", {
			limit: 200,
			limitMode: "depth",
			recallScope: "project_only",
			memoryScope: { projectId: "alpha" },
		});

	expect(result.context).toContain("heliotrope");
	expect(result.context).not.toContain("betacanary");
	expect(result.bounded_recall_corpus_used).toBe(true);
	expect(result.bounded_recall_failures).toBe(0);
	expect(result.items.length).toBeLessThanOrEqual(200);
	expect(result.context.length).toBeLessThanOrEqual(24_000);
	expect(result.bounded_recall_corpus_counts).toMatchObject({
		nodes: expect.any(Number),
		pages: expect.any(Number),
		slices: expect.any(Number),
		events: expect.any(Number),
		edges: expect.any(Number),
	});
	expect(result.bounded_recall_corpus_counts.nodes).toBeLessThanOrEqual(V3_RECALL_NODE_LOAD_MAX);
	expect(result.bounded_recall_corpus_counts.pages).toBeLessThanOrEqual(V3_RECALL_PAGE_LOAD_MAX);
	expect(result.bounded_recall_corpus_counts.slices).toBeLessThanOrEqual(V3_RECALL_SLICE_LOAD_MAX);
	expect(result.bounded_recall_corpus_counts.events).toBeLessThanOrEqual(V3_RECALL_EVENT_LOAD_MAX);
	expect(result.bounded_recall_corpus_counts.edges).toBeLessThanOrEqual(V3_RECALL_EDGE_LOAD_MAX);
	for (const count of Object.values(result.bounded_recall_lane_counts)) {
		expect(count).toBeLessThanOrEqual(V3_RECALL_LANE_MAX);
	}
}, 30_000);
