import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	MANUAL_BROAD_POOL_LIMIT,
	MANUAL_CARD_LIMIT,
	buildFtsQuery,
	retrieveManualContext,
	scoreManualCandidate,
} from "../src/pipeline/manual_retrieval.js";

const noVectors = { useVectors: false, shortlistSize: 10 };

function now() {
	return Date.now();
}

async function insertNode(userId, {
	id,
	label,
	canonical = label.toLocaleLowerCase("en-US"),
	aliases = [],
	category = "project",
	summary = null,
	cluster = null,
} = {}) {
	const timestamp = now();
	await env.DB.prepare(
		`INSERT INTO nodes
			(id, user_id, label, canonical_label, aliases_json, category, state, summary,
			 created_at, updated_at, cluster)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
	)
		.bind(id, userId, label, canonical, JSON.stringify(aliases), category, summary, timestamp, timestamp, cluster)
		.run();
}

async function insertProfile(userId, {
	kind = "node",
	id,
	identity = "",
	semantic = "",
	context = "",
} = {}) {
	const timestamp = now();
	await env.DB.prepare(
		`INSERT INTO manual_search_profiles
			(user_id, object_kind, object_id, identity_text, semantic_text, context_text,
			 profile_hash, source_updated_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(userId, kind, id, identity, semantic, context, `test:${id}:${timestamp}`, timestamp, timestamp, timestamp)
		.run();
}

async function ftsRows(userId, query) {
	const { results } = await env.DB.prepare(
		`SELECT profile.object_kind, profile.object_id,
			bm25(manual_search_fts, 6.0, 2.5, 1.0) AS lexical_rank
		 FROM manual_search_fts
		 JOIN manual_search_profiles AS profile ON profile.rowid = manual_search_fts.rowid
		 WHERE manual_search_fts MATCH ? AND profile.user_id = ?
		 ORDER BY lexical_rank ASC, profile.object_kind, profile.object_id`,
	)
		.bind(query, userId)
		.all();
	return results ?? [];
}

describe("manual search migration", () => {
	it("creates the profile, FTS, trigger, and community schema", async () => {
		const { results } = await env.DB.prepare(
			`SELECT name, type FROM sqlite_schema
			 WHERE name IN (
				'manual_search_profiles', 'manual_search_fts',
				'manual_search_profiles_ai', 'manual_search_profiles_ad', 'manual_search_profiles_au',
				'topic_communities', 'node_topic_communities'
			 )
			 ORDER BY name`,
		).all();
		expect(results).toHaveLength(7);
		expect(results.find((row) => row.name === "manual_search_fts")?.type).toBe("table");
		expect(results.filter((row) => row.type === "trigger")).toHaveLength(3);
	});

	it("keeps the external-content FTS index synchronized on insert, update, and delete", async () => {
		const userId = `fts-sync-${crypto.randomUUID()}`;
		await insertProfile(userId, {
			id: "profile-sync",
			identity: "Silver Comet",
			semantic: "A service running on Cloudflare Workers",
		});
		expect((await ftsRows(userId, buildFtsQuery("Silver Comet"))).map((row) => row.object_id))
			.toEqual(["profile-sync"]);

		await env.DB.prepare(
			`UPDATE manual_search_profiles
			 SET identity_text = ?, profile_hash = ?, updated_at = ?
			 WHERE user_id = ? AND object_kind = 'node' AND object_id = ?`,
		)
			.bind("Golden Meteor", "test:updated", now(), userId, "profile-sync")
			.run();
		expect(await ftsRows(userId, buildFtsQuery("Silver Comet"))).toEqual([]);
		expect((await ftsRows(userId, buildFtsQuery("Golden Meteor"))).map((row) => row.object_id))
			.toEqual(["profile-sync"]);

		await env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(userId, "profile-sync").run();
		expect(await ftsRows(userId, buildFtsQuery("Golden Meteor"))).toEqual([]);
	});

	it("weights identity hits above otherwise equivalent semantic hits", async () => {
		const userId = `fts-rank-${crypto.randomUUID()}`;
		await insertProfile(userId, { id: "identity-hit", identity: "Silver Comet" });
		await insertProfile(userId, { id: "semantic-hit", semantic: "Silver Comet" });
		const rows = await ftsRows(userId, buildFtsQuery("Silver Comet"));
		expect(rows.map((row) => row.object_id)).toEqual(["identity-hit", "semantic-hit"]);
		expect(Number(rows[0].lexical_rank)).toBeLessThan(Number(rows[1].lexical_rank));
	});
});

describe("manual bounded retrieval", () => {
	it("builds a quoted FTS query from hostile punctuation without executable SQL", () => {
		const query = buildFtsQuery(`\"; DROP TABLE nodes; -- C++ / Manchester`);
		expect(query).toContain('identity_text:"cpp"');
		expect(query).toContain('identity_text:"manchester"');
		expect(query).not.toContain(";");
		expect(query).not.toContain("--");
		expect(buildFtsQuery("...!!!")).toBeNull();
	});

	it("keeps identity and context scores separate", () => {
		const vectorOnly = scoreManualCandidate(
			{ label: "Unrelated Subject", category: "project", context: "Unrelated Subject" },
			{ label: "Silver Comet", category: "project", summary: "Cloudflare service", aliases_json: "[]" },
			{ vector: 0.98 },
		);
		expect(vectorOnly.identity_score).toBe(0);
		expect(vectorOnly.context_score).toBeGreaterThan(0);

		const exact = scoreManualCandidate(
			{ label: "Silver Comet", category: "project", context: "" },
			{ label: "Silver Comet", category: "project", summary: "", aliases_json: "[]" },
			{ exact_label: true },
		);
		expect(exact.identity_score).toBe(1);
		expect(exact.context_score).toBe(0);
	});

	it("recognizes an explicit stored alias assertion without promoting ordinary co-occurrence", () => {
		const asserted = scoreManualCandidate(
			{ label: "Red Devils", category: "organization", context: "Red Devils won today" },
			{
				label: "Manchester United",
				category: "organization",
				aliases_json: "[]",
				profile_semantic_text: "Manchester United is also known to me as the Red Devils.",
			},
			{ bm25: 1 },
		);
		expect(asserted).toMatchObject({ identity_score: 0.9 });
		expect(asserted.reason_codes).toContain("stored_alias_assertion");

		const coOccurrence = scoreManualCandidate(
			{ label: "Manchester United", category: "organization", context: "Manchester football travel" },
			{
				label: "Manchester City",
				category: "organization",
				aliases_json: "[]",
				profile_semantic_text: "Manchester City played Manchester United near Manchester Airport.",
			},
			{ bm25: 1, vector: 0.99, graph: 1, page: 1, community: 1, cluster: 1 },
		);
		expect(coOccurrence.reason_codes).not.toContain("stored_alias_assertion");
	});

	it("retrieves exact aliases and identity claims into temporary UUID-free cards", async () => {
		const userId = `retrieval-exact-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		await insertNode(userId, {
			id: nodeId,
			label: "Manchester United",
			canonical: "manchester united",
			aliases: ["Man United"],
			category: "organization",
			summary: "The user's football club memory.",
			cluster: "preferences_research",
		});
		await insertProfile(userId, {
			id: nodeId,
			identity: "Manchester United Man United MUFC",
			semantic: "football club",
		});
		await env.DB.prepare(
			`INSERT INTO manual_node_identities (user_id, canonical_key, node_id, created_at, updated_at)
			 VALUES (?, 'mufc', ?, ?, ?)`,
		).bind(userId, nodeId, now(), now()).run();

		const aliasResult = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "Man United", category: "organization", mention_role: "primary_subject" }],
		});
		expect(aliasResult.receipt.broad_pool_count).toBe(1);
		expect(aliasResult.cards).toHaveLength(1);
		expect(aliasResult.cards[0].ref).toBe("N0");
		expect(aliasResult.cards[0].retrieval.identity_score).toBe(0.99);
		expect(aliasResult.cards[0].retrieval.reason_codes).toContain("exact_alias");
		expect(aliasResult.refMap.get("N0")).toBe(nodeId);
		expect(JSON.stringify(aliasResult.cards)).not.toContain(nodeId);

		const claimResult = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "MUFC", category: "organization", mention_role: "primary_subject" }],
		});
		expect(claimResult.cards[0].retrieval.identity_score).toBe(1);
		expect(claimResult.cards[0].retrieval.reason_codes).toContain("exact_identity_claim");
	});

	it("uses page/BM25 context to retrieve a node without treating it as identity", async () => {
		const userId = `retrieval-page-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		const pageId = `page-${crypto.randomUUID()}`;
		await insertNode(userId, {
			id: nodeId,
			label: "Silver Comet",
			canonical: "silver comet",
			category: "project",
			summary: "A durable project node.",
		});
		const timestamp = now();
		await env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, node_id, title, canonical_title, short_summary, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(pageId, userId, nodeId, "Nebula Architecture Notes", "nebula architecture notes",
				"Quasar routing design", timestamp, timestamp)
			.run();
		await insertProfile(userId, {
			kind: "page",
			id: pageId,
			identity: "Nebula Architecture Notes",
			semantic: "Quasar routing design",
		});

		const result = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "Quasar Routing", category: "project", mention_role: "primary_subject" }],
		});
		expect(result.cards).toHaveLength(1);
		expect(result.cards[0].label).toBe("Silver Comet");
		expect(result.cards[0].retrieval.identity_score).toBe(0);
		expect(result.cards[0].retrieval.context_score).toBeGreaterThan(0);
		expect(result.cards[0].retrieval.reason_codes).toContain("linked_page");
	});

	it("uses a namespaced Vectorize match as context without granting identity", async () => {
		const userId = `retrieval-vector-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		await insertNode(userId, {
			id: nodeId,
			label: "Silver Comet",
			category: "project",
			summary: "Cloudflare Workers service",
		});
		let observedQuery = null;
		const vectorEnv = {
			DB: env.DB,
			AI: {
				async run() {
					return { data: [[0.1, 0.2, 0.3]] };
				},
			},
			VECTORIZE: {
				async query(values, options) {
					observedQuery = { values, options };
					return { matches: [{ id: nodeId, score: 0.97 }] };
				},
			},
		};
		const result = await retrieveManualContext(vectorEnv, {
			useVectors: true,
			embedModel: "test-embedding-model",
			shortlistSize: 10,
		}, userId, {
			entities: [{ ref: "E0", label: "Unrelated Nebula", category: "project", mention_role: "primary_subject" }],
		});
		expect(observedQuery.options).toMatchObject({ namespace: userId, returnMetadata: "none" });
		expect(result.cards).toHaveLength(1);
		expect(result.cards[0].retrieval.identity_score).toBe(0);
		expect(result.cards[0].retrieval.context_score).toBeGreaterThan(0);
		expect(result.cards[0].retrieval.reason_codes).toContain("vector");
	});

	it("expands topic-community context with canonical node IDs and creates no graph edge", async () => {
		const userId = `retrieval-community-${crypto.randomUUID()}`;
		const atlasId = `node-${crypto.randomUUID()}`;
		const d1Id = `node-${crypto.randomUUID()}`;
		const communityId = `community-${crypto.randomUUID()}`;
		await insertNode(userId, { id: atlasId, label: "Atlas", canonical: "atlas", category: "project" });
		await insertNode(userId, { id: d1Id, label: "D1", canonical: "d1", category: "tool" });
		const timestamp = now();
		await env.DB.prepare(
			`INSERT INTO topic_communities
				(id, user_id, canonical_key, label, summary, confidence, created_at, updated_at)
			 VALUES (?, ?, 'atlas-stack', 'Atlas Stack', 'Canonical project membership', 0.95, ?, ?)`,
		).bind(communityId, userId, timestamp, timestamp).run();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO node_topic_communities
					(user_id, community_id, node_id, confidence, created_at, updated_at)
				 VALUES (?, ?, ?, 0.95, ?, ?)`,
			).bind(userId, communityId, atlasId, timestamp, timestamp),
			env.DB.prepare(
				`INSERT INTO node_topic_communities
					(user_id, community_id, node_id, confidence, created_at, updated_at)
				 VALUES (?, ?, ?, 0.95, ?, ?)`,
			).bind(userId, communityId, d1Id, timestamp, timestamp),
		]);

		const result = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "Atlas", category: "project", mention_role: "primary_subject" }],
		});
		expect(result.cards.map((card) => card.label)).toEqual(["Atlas", "D1"]);
		expect(result.cards[1].retrieval.identity_score).toBe(0);
		expect(result.cards[1].retrieval.reason_codes).toContain("topic_community");
		expect(result.cards[0].communities[0].label).toBe("Atlas Stack");
		const edgeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM edges WHERE user_id = ?")
			.bind(userId).first();
		expect(edgeCount.count).toBe(0);
	});

	it("caps the broad pool at 30 and cards globally at 10 without padding or UUID leakage", async () => {
		const userId = `retrieval-cap-${crypto.randomUUID()}`;
		const nodeIds = [];
		for (let index = 0; index < 35; index++) {
			const id = `node-${crypto.randomUUID()}`;
			nodeIds.push(id);
			await insertNode(userId, {
				id,
				label: `Legacy Shared ${String(index).padStart(2, "0")}`,
				aliases: ["Shared Alias"],
				category: "project",
				summary: `Legacy memory ${index}`,
			});
		}

		const result = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "Shared Alias", category: "project", mention_role: "primary_subject" }],
		});
		expect(result.broadPool).toHaveLength(MANUAL_BROAD_POOL_LIMIT);
		expect(result.cards).toHaveLength(MANUAL_CARD_LIMIT);
		expect(result.receipt.warnings).toContain("exact_candidate_overflow");
		expect(result.cards.map((card) => card.ref)).toEqual(
			Array.from({ length: MANUAL_CARD_LIMIT }, (_, index) => `N${index}`),
		);
		const serialized = JSON.stringify(result.cards);
		for (const id of nodeIds) expect(serialized).not.toContain(id);
	});

	it("never pads a shortlist when fewer cards exist", async () => {
		const userId = `retrieval-no-pad-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		await insertNode(userId, { id: nodeId, label: "Only Memory", aliases: ["Only Alias"] });
		const result = await retrieveManualContext(env, noVectors, userId, {
			entities: [{ ref: "E0", label: "Only Alias", mention_role: "primary_subject" }],
		});
		expect(result.cards.map((card) => card.ref)).toEqual(["N0"]);
	});
});
