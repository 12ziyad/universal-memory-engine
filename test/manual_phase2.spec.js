import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runMcpDirectSaveCommand } from "../src/pipeline/manual_mcp.js";
import { refreshManualSearchProfiles } from "../src/pipeline/manual_search_profiles.js";

function userId(label) {
	return `manual-phase2-${label}-${crypto.randomUUID()}`;
}

function fact(label, category, text, kind = "other") {
	return {
		identity: { label, category },
		memory: { kind: "slice", slice_kind: kind, text },
		confidence: 0.98,
	};
}

async function direct(userId, input, runtime = env) {
	return runMcpDirectSaveCommand(runtime, null, userId, input);
}

async function rows(table, userId) {
	const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId).all();
	return result.results ?? [];
}

async function seedNode(userId, id, label, category = "organization") {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes
		 (id, user_id, label, canonical_label, aliases_json, category, state, summary,
		  created_at, updated_at, last_seen_at, health_state, importance_class)
		 VALUES (?, ?, ?, ?, '[]', ?, 'active', ?, ?, ?, ?, 'active', 'ordinary')`,
	).bind(id, userId, label, label.toLocaleLowerCase("en-US"), category, `${label} memory.`, now, now, now).run();
	const identityText = label === "Manchester United" ? `${label} mu mufc` : label;
	await env.DB.prepare(
		`INSERT INTO manual_search_profiles
		 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
		  profile_hash, source_updated_at, created_at, updated_at)
		 VALUES (?, 'node', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		userId,
		id,
		identityText,
		`${label} memory.`,
		category,
		`test:${id}`,
		now,
		now,
		now,
	).run();
}

describe("MCP manual intelligence Phase 2", () => {
	it("persists an explicit casual memory through a grounded topic identity", async () => {
		const id = userId("casual-fallback");
		const result = await direct(id, { content: "Remember that I had a strange day at work." });

		expect(result).toMatchObject({ status: "wrote", counts: { nodes: 1, slices: 1, candidates: 0 } });
		expect(result.receipt.primary_subject).toEqual(expect.objectContaining({ mention_role: "primary_subject" }));
		expect(await rows("nodes", id)).toHaveLength(1);
		expect((await rows("slices", id))[0].text).toBe("I had a strange day at work.");
	});

	it("returns clarification without writing an unresolved save-this reference", async () => {
		const id = userId("unresolved-reference");
		const result = await direct(id, { content: "Remember this: it changed yesterday." });

		expect(result).toMatchObject({ status: "clarification_required", fired: false, counts: { savedTotal: 0 } });
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("creates Silver Comet plus two complete supporting nodes and two edges", async () => {
		const id = userId("silver-comet");
		const result = await direct(id, { content: "Silver Comet uses Go and Cloudflare Workers." });

		expect(result).toMatchObject({ status: "wrote", counts: { nodes: 3, edges: 2 } });
		expect((await rows("nodes", id)).map((node) => node.label).sort()).toEqual([
			"Cloudflare Workers",
			"Go",
			"Silver Comet",
		]);
		expect(await rows("slices", id)).toHaveLength(3);
		expect(await rows("edges", id)).toHaveLength(2);
	});

	it("converges concurrent Man United and MUFC aliases without losing either claim", async () => {
		const id = userId("manchester-aliases");
		await seedNode(id, "node-manchester-united", "Manchester United");

		const results = await Promise.all([
			direct(id, {
				content: "Man United is the club I follow.",
				extractionResponse: { facts: [fact("Man United", "organization", "Man United is the club I follow.")] },
			}),
			direct(id, {
				content: "MUFC is the club I follow.",
				extractionResponse: { facts: [fact("MUFC", "organization", "MUFC is the club I follow.")] },
			}),
		]);
		expect(results.map((result) => result.receipt.identity_decisions)).toEqual([
			[expect.objectContaining({ decision: "existing", node_id: "node-manchester-united" })],
			[expect.objectContaining({ decision: "existing", node_id: "node-manchester-united" })],
		]);

		const nodes = await rows("nodes", id);
		expect(nodes).toHaveLength(1);
		expect(JSON.parse(nodes[0].aliases_json).sort()).toEqual(["MUFC", "Man United"]);
		const claims = await rows("manual_node_identities", id);
		expect(claims.map((claim) => claim.canonical_key)).toEqual(expect.arrayContaining([
			"man united",
			"mufc",
		]));
	});

	it("keeps comparison and example entities as ignored evidence", async () => {
		const id = userId("comparison-roles");
		const content = "Bedrock is selected; Sonnet and Opus are comparisons only.";
		const result = await direct(id, {
			content,
			extractionResponse: {
				primary_subject_ref: "bedrock",
				primary_memory: { text: content, kind: "slice", slice_kind: "decision" },
				entities: [
					{ ref: "bedrock", label: "Bedrock", category: "tool", mention_role: "primary_subject" },
					{ ref: "sonnet", label: "Sonnet", category: "tool", mention_role: "comparison" },
					{ ref: "opus", label: "Opus", category: "tool", mention_role: "example" },
				],
				facts: [
					{ subject_ref: "bedrock", memory: { kind: "slice", slice_kind: "decision", text: content }, confidence: 0.98 },
					{ subject_ref: "sonnet", memory: { kind: "slice", slice_kind: "other", text: content }, confidence: 0.9 },
					{ subject_ref: "opus", memory: { kind: "slice", slice_kind: "other", text: content }, confidence: 0.9 },
				],
			},
		});

		expect(result.status).toBe("wrote");
		expect((await rows("nodes", id)).map((node) => node.label)).toEqual(["Bedrock"]);
		expect(result.receipt.graph.ignored_mentions.map((item) => item.label)).toEqual(expect.arrayContaining(["Sonnet", "Opus"]));
	});

	it("accepts a semantic alias only through a validated N-card recommendation", async () => {
		const id = userId("semantic-alias");
		await seedNode(id, "node-manchester-united", "Manchester United");
		const grounding = "Manchester United is also known to me as the Red Devils.";
		await direct(id, {
			content: grounding,
			extractionResponse: { facts: [fact("Manchester United", "organization", grounding)] },
		});

		const aliasText = "Red Devils won today.";
		const result = await direct(id, {
			content: aliasText,
			extractionResponse: { facts: [fact("Red Devils", "organization", aliasText)] },
			adjudicationResponse: {
				identity_operations: [{
					entity_ref: "E0",
					decision: "merge_existing",
					selected_ref: "N0",
					confidence: 0.97,
				}],
			},
		});

		expect(result).toMatchObject({ status: "wrote", counts: { nodes: 0 } });
		expect(result.receipt.identity_decisions).toEqual([
			expect.objectContaining({ decision: "existing", node_id: "node-manchester-united", adjudicated: true }),
		]);
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(JSON.parse((await rows("nodes", id))[0].aliases_json)).toContain("Red Devils");
	});

	it("writes topic-community membership with canonical node ids and no synthetic edge", async () => {
		const id = userId("community");
		const content = "Quiet Tuesday captures my work reflection.";
		const result = await direct(id, {
			content,
			extractionResponse: { facts: [fact("Quiet Tuesday", "other", content)] },
			topicCommunities: [{ label: "Work Reflections", member_refs: ["E0"], confidence: 0.9 }],
		});

		expect(result.status).toBe("wrote");
		const nodes = await rows("nodes", id);
		const communities = await rows("topic_communities", id);
		const memberships = await rows("node_topic_communities", id);
		expect(communities).toHaveLength(1);
		expect(memberships).toEqual([expect.objectContaining({ node_id: nodes[0].id, community_id: communities[0].id })]);
		expect(await rows("edges", id)).toHaveLength(0);
	});

	it("keeps canonical memory durable when derived profile persistence fails", async () => {
		const id = userId("derived-failure");
		const runtime = {
			...env,
			DB: {
				prepare(sql) {
					if (/^\s*INSERT\s+INTO\s+manual_search_profiles\b/i.test(String(sql))) {
						throw new Error("forced derived profile failure");
					}
					return env.DB.prepare(sql);
				},
				batch(statements) {
					return env.DB.batch(statements);
				},
			},
		};
		const content = "Atlas uses encrypted storage.";
		const result = await direct(id, {
			content,
			extractionResponse: { facts: [fact("Atlas", "project", content, "technical_detail")] },
		}, runtime);

		expect(result.status).toBe("wrote");
		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Atlas");
		expect(result.receipt.persistence_failures).toEqual([
			expect.objectContaining({ code: "search_profile_failed" }),
		]);
		expect(result.warnings).toContain("search_profile_failed");
	});

	it("does not resurrect a profile when an archive wins after the source snapshot", async () => {
		const id = userId("stale-profile-archive");
		await seedNode(id, "node-stale-profile", "Stale Profile", "project");
		await env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(id, "node-stale-profile").run();
		let releaseSnapshot;
		let snapshotLoaded;
		const loaded = new Promise((resolve) => { snapshotLoaded = resolve; });
		const release = new Promise((resolve) => { releaseSnapshot = resolve; });
		let firstBatch = true;
		const runtime = {
			...env,
			DB: {
				prepare(sql) { return env.DB.prepare(sql); },
				async batch(statements) {
					const result = await env.DB.batch(statements);
					if (firstBatch) {
						firstBatch = false;
						snapshotLoaded();
						await release;
					}
					return result;
				},
			},
		};
		const refreshing = refreshManualSearchProfiles(runtime, { useVectors: false }, id, {
			nodeIds: ["node-stale-profile"],
		});
		await loaded;
		await env.DB.prepare(
			"UPDATE nodes SET archived_at = ? WHERE user_id = ? AND id = ?",
		).bind(Date.now(), id, "node-stale-profile").run();
		releaseSnapshot();
		const result = await refreshing;

		expect(result).toMatchObject({ refreshed: [], vector_refreshed: [], warnings: [] });
		expect(await rows("manual_search_profiles", id)).toHaveLength(0);
	});

	it("compensates a vector upsert when cleanup wins during embedding", async () => {
		const id = userId("stale-vector-archive");
		await seedNode(id, "node-stale-vector", "Stale Vector", "project");
		const vectors = new Set();
		const runtime = {
			...env,
			AI: {
				async run() { return { data: [[0.1, 0.2, 0.3]] }; },
			},
			VECTORIZE: {
				async upsert(items) {
					await env.DB.batch([
						env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE user_id = ? AND id = ?")
							.bind(Date.now(), id, "node-stale-vector"),
						env.DB.prepare(
							"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
						).bind(id, "node-stale-vector"),
					]);
					for (const item of items) vectors.add(item.id);
				},
				async deleteByIds(ids) {
					for (const vectorId of ids) vectors.delete(vectorId);
				},
			},
		};
		const result = await refreshManualSearchProfiles(runtime, {
			useVectors: true,
			embedModel: "test-embedding-model",
		}, id, { nodeIds: ["node-stale-vector"] });

		expect(result.vector_refreshed).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(vectors.size).toBe(0);
		expect(await rows("manual_search_profiles", id)).toHaveLength(0);
	});
});
