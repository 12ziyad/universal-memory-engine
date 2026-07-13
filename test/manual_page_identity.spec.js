import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	buildManualPagePlan,
	manualPageClaimKeys,
	manualPageRankingIsAmbiguous,
} from "../src/pipeline/manual_page.js";
import { manualPageVectorNamespace } from "../src/pipeline/manual_search_profiles.js";
import { writeApproved } from "../src/pipeline/write.js";

function id(prefix) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function seedNode(userId, nodeId, label = "Atlas") {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes
		 (id, user_id, label, canonical_label, aliases_json, category, state,
		  created_at, updated_at, deleted_at, archived_at, suppressed_at)
		 VALUES (?, ?, ?, ?, '[]', 'project', 'active', ?, ?, NULL, NULL, NULL)`,
	).bind(nodeId, userId, label, label.toLowerCase(), now, now).run();
}

async function seedPage(userId, options = {}) {
	const now = options.updatedAt ?? Date.now();
	const pageId = options.id ?? id("page");
	await env.DB.prepare(
		`INSERT INTO memory_pages
		 (id, user_id, node_id, source_mode, title, canonical_title, topic_filter,
		  short_summary, full_markdown, sections_json, key_points_json,
		  source_thread_id, source_conversation_id, source_packet_id, input_hash,
		  idempotency_key, created_at, updated_at, last_seen_at, heat_score, cluster)
		 VALUES (?, ?, ?, 'manual_collect', ?, ?, ?, ?, ?, '{}', '[]', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
	).bind(
		pageId,
		userId,
		options.nodeId ?? null,
		options.title ?? "Atlas Memory",
		options.canonicalTitle ?? String(options.title ?? "Atlas Memory").toLowerCase(),
		options.topic ?? null,
		options.summary ?? "Atlas delivery remains active.",
		options.markdown ?? "# Atlas Memory\n\nAtlas delivery remains active.",
		options.threadId ?? null,
		options.conversationId ?? null,
		options.packetId ?? null,
		options.inputHash ?? null,
		options.idempotencyKey ?? null,
		now,
		now,
		now,
		options.cluster ?? "unclustered",
	).run();
	return pageId;
}

function pageInput(overrides = {}) {
	const packetId = overrides.packetId ?? id("packet");
	const digest = overrides.digest ?? "Atlas delivery remains active.";
	const messageId = id("message");
	return {
		digest,
		messages: [{ id: messageId, role: "user", content: digest }],
		claims: overrides.claims ?? [{
			claim_id: "C0",
			type: "current_state",
			text: digest,
			subject_label: "Atlas",
			attribution: "user_stated",
			polarity: "positive",
			modality: "asserted",
			current: true,
			source_message_ids: [messageId],
			evidence_spans: [{
				message_ref: "M0", source_message_id: messageId, role: "user", quote: digest,
			}],
		}],
		intent: {
			topic: overrides.topic === undefined ? "atlas" : overrides.topic,
			explicitNew: overrides.explicitNew ?? false,
			updateRequested: overrides.updateRequested ?? false,
		},
		conversationId: overrides.conversationId ?? "atlas-conversation",
		primaryNodeId: overrides.primaryNodeId ?? null,
		identityHints: overrides.identityHints ?? [],
		preferredTitle: overrides.preferredTitle ?? "Atlas Memory",
		queryText: overrides.queryText ?? digest,
		config: overrides.config ?? { useVectors: false },
		semanticSynthesis: overrides.semanticSynthesis,
		sourcePacket: {
			id: packetId,
			thread_id: overrides.threadId ?? "atlas-thread",
			content_hash: overrides.inputHash ?? `hash:${packetId}`,
			idempotency_key: overrides.idempotencyKey ?? `key:${packetId}`,
		},
		runId: id("run"),
	};
}

async function commit(userId, plan) {
	return writeApproved(env, {}, userId, {
		newPages: plan.newPages ?? [],
		pageUpdates: plan.pageUpdates ?? [],
		pageClaims: plan.pageClaims ?? [],
	});
}

describe("MCP manual deterministic page identity", () => {
	it("requires a fuzzy winner to lead every runner-up by at least the locked margin", () => {
		expect(manualPageRankingIsAmbiguous([
			{ score: 0.75 },
			{ score: 0.70 },
		])).toBe(true);
		expect(manualPageRankingIsAmbiguous([
			{ score: 0.75 },
			{ score: 0.67 },
		])).toBe(false);
		expect(manualPageRankingIsAmbiguous([
			{ score: 0.71 },
			{ score: 0.68 },
		])).toBe(false);
	});

	it("uses stable claim keys in canonical authority order", () => {
		const keys = manualPageClaimKeys({
			id: "draft",
			node_id: "node-atlas",
			topic_filter: "Atlas Delivery",
			title: "Atlas Delivery Notes",
			canonical_title: "atlas delivery notes",
		}, { intent: { explicitNew: false } });

		expect(keys).toEqual([
			"node:node-atlas:topic:atlas delivery",
			"node:node-atlas",
			"topic:atlas delivery",
			"semantic:atlas delivery notes",
		]);
		expect(manualPageClaimKeys({
			id: "draft",
			node_id: "provisional-node",
			topic_filter: "Atlas Delivery",
			title: "Atlas Delivery Notes",
			canonical_title: "atlas delivery notes",
		}, { intent: { explicitNew: false }, primaryNodeIsNew: true })).toEqual([
			"topic:atlas delivery",
			"semantic:atlas delivery notes",
		]);
	});

	it("treats an exact retry as duplicate before explicit-separate intent", async () => {
		const userId = id("page-retry-user");
		await seedPage(userId, {
			id: "retry-page",
			packetId: "same-packet",
			inputHash: "same-hash",
			idempotencyKey: "same-key",
		});

		const plan = await buildManualPagePlan(env, userId, pageInput({
			packetId: "same-packet",
			inputHash: "same-hash",
			idempotencyKey: "same-key",
			explicitNew: true,
		}));

		expect(plan).toMatchObject({ action: "duplicate", write: false, page: { id: "retry-page" } });
	});

	it("recovers an invalid semantic page from grounded claims instead of suppressing the save", async () => {
		const userId = id("page-invalid-synthesis-user");
		const plan = await buildManualPagePlan(env, userId, pageInput({
			semanticSynthesis: {
				valid: false,
				quality_score: 0.4,
				retry_count: 1,
				synthesis_mode: "deterministic_fallback",
				quality_reason_codes: ["current_state_contradiction"],
				synthesis: { selected_title: "Unsafe Raw Digest" },
			},
		}));

		expect(plan).toMatchObject({
			action: "created",
			write: true,
			synthesis_mode: "deterministic_fallback",
			quality_reason_codes: [],
			pageUpdates: [],
		});
		expect(plan.newPages).toHaveLength(1);
		expect(plan.page.full_markdown).toContain("Atlas delivery remains active.");
		expect(plan.page.full_markdown).not.toContain("Unsafe Raw Digest");
		expect(plan.page.full_markdown).not.toMatch(/## Evidence/i);
	});

	it("still suppresses when the authoritative claim set itself is empty", async () => {
		const userId = id("page-empty-claims-user");
		const plan = await buildManualPagePlan(env, userId, pageInput({
			claims: [],
			semanticSynthesis: {
				valid: false,
				writable: false,
				quality_reason_codes: ["claim_set_empty"],
				synthesis: { selected_title: "Unsafe Raw Digest" },
			},
		}));

		expect(plan).toMatchObject({
			action: "suppressed",
			write: false,
			reason: "page_synthesis_invalid",
			quality_reason_codes: expect.arrayContaining(["claim_set_empty"]),
		});
		expect(plan.newPages).toEqual([]);
	});

	it("creates a distinct node-associated page for explicit separate-page intent", async () => {
		const userId = id("page-separate-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, { id: "existing-page", nodeId, topic: "atlas" });

		const plan = await buildManualPagePlan(env, userId, pageInput({
			primaryNodeId: nodeId,
			explicitNew: true,
			packetId: "separate-packet",
		}));
		expect(plan).toMatchObject({
			action: "created",
			write: true,
			page: { node_id: nodeId },
		});
		expect(plan.page.identity_key).toContain(":separate:separate-packet");

		await commit(userId, plan);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(Number(count.count)).toBe(2);
	});

	it("uses an existing manual page claim before fuzzy signals and keeps the title stable", async () => {
		const userId = id("page-claim-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, {
			id: "claimed-page",
			title: "Original Ledger Title",
			canonicalTitle: "original ledger title",
			topic: null,
			summary: "Unrelated legacy wording.",
		});
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO manual_page_identities
			 (user_id, canonical_key, page_id, created_at, updated_at)
			 VALUES (?, ?, 'claimed-page', ?, ?)`,
		).bind(userId, `node:${nodeId}:topic:atlas`, now, now).run();

		const plan = await buildManualPagePlan(env, userId, pageInput({
			primaryNodeId: nodeId,
			digest: "Completely new Atlas information.",
			preferredTitle: "A Replacement Title",
		}));

		expect(plan).toMatchObject({
			action: "reinforced",
			identity_score: 1,
			page: { id: "claimed-page", title: "Original Ledger Title", node_id: nodeId },
		});
		expect(plan.identity_reason_codes).toContain("manual_page_identity_claim");
		expect(plan.pageClaims.map((claim) => claim.identity_key)).toEqual(expect.arrayContaining([
			`node:${nodeId}:topic:atlas`,
			`node:${nodeId}`,
			"topic:atlas",
		]));
		await commit(userId, plan);
		expect(await env.DB.prepare(
			"SELECT node_id, title FROM memory_pages WHERE user_id = ? AND id = 'claimed-page'",
		).bind(userId).first()).toEqual(expect.objectContaining({
			node_id: nodeId,
			title: "Original Ledger Title",
		}));
	});

	it("fails closed when a stored node claim points at a page associated with another node", async () => {
		const userId = id("page-corrupt-claim-user");
		const requestedNodeId = id("requested-node");
		const storedNodeId = id("stored-node");
		await seedNode(userId, requestedNodeId, "Atlas");
		await seedNode(userId, storedNodeId, "Other Atlas");
		await seedPage(userId, { id: "wrong-node-page", nodeId: storedNodeId, topic: "atlas" });
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO manual_page_identities
			 (user_id, canonical_key, page_id, created_at, updated_at)
			 VALUES (?, ?, 'wrong-node-page', ?, ?)`,
		).bind(userId, `node:${requestedNodeId}:topic:atlas`, now, now).run();

		const plan = await buildManualPagePlan(env, userId, pageInput({ primaryNodeId: requestedNodeId }));
		expect(plan).toMatchObject({
			action: "ambiguous",
			write: false,
			reason: "page_identity_claim_node_conflict",
		});
	});

	it("treats one compatible primary-node page as authoritative", async () => {
		const userId = id("page-node-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, {
			id: "node-page",
			nodeId,
			title: "A Legacy Container",
			canonicalTitle: "legacy container",
			topic: null,
			summary: "Old material with no lexical overlap.",
		});

		const plan = await buildManualPagePlan(env, userId, pageInput({
			primaryNodeId: nodeId,
			topic: null,
			digest: "Completely unrelated current language.",
			preferredTitle: "Different Words",
		}));

		expect(plan).toMatchObject({
			action: "reinforced",
			page: { id: "node-page", title: "A Legacy Container" },
		});
		expect(plan.identity_reason_codes).toContain("primary_node_exact");
	});

	it("returns an order- and recency-independent conflict for close strong pages", async () => {
		const userId = id("page-conflict-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, { id: "page-b", nodeId, topic: "atlas", updatedAt: 100 });
		await seedPage(userId, { id: "page-a", nodeId, topic: "atlas", updatedAt: 200 });
		const input = pageInput({ primaryNodeId: nodeId });

		const first = await buildManualPagePlan(env, userId, input);
		await env.DB.batch([
			env.DB.prepare("UPDATE memory_pages SET updated_at = 300 WHERE id = 'page-b' AND user_id = ?").bind(userId),
			env.DB.prepare("UPDATE memory_pages SET updated_at = 50 WHERE id = 'page-a' AND user_id = ?").bind(userId),
		]);
		const second = await buildManualPagePlan(env, userId, input);

		expect(first).toMatchObject({ action: "ambiguous", write: false, reason: "multiple_existing_pages_match" });
		expect(second).toMatchObject({ action: "ambiguous", write: false, reason: "multiple_existing_pages_match" });
		expect(first.page_conflicts.map((item) => item.id)).toEqual(["page-a", "page-b"]);
		expect(second.page_conflicts.map((item) => item.id)).toEqual(["page-a", "page-b"]);
	});

	it("uses BM25 to disambiguate two otherwise-equal primary-node pages", async () => {
		const userId = id("page-bm25-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, { id: "lexical-page", nodeId, topic: null, title: "Legacy Page", summary: "Legacy summary." });
		await seedPage(userId, { id: "other-page", nodeId, topic: null, title: "Legacy Page", summary: "Legacy summary." });
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 VALUES (?, 'page', 'lexical-page', '', 'orchid launch telemetry', '', 'lexical', ?, ?, ?)`,
			).bind(userId, now, now, now),
			env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 VALUES (?, 'page', 'other-page', '', 'cooking recipes', '', 'other', ?, ?, ?)`,
			).bind(userId, now, now, now),
		]);

		const plan = await buildManualPagePlan(env, userId, pageInput({
			primaryNodeId: nodeId,
			topic: null,
			digest: "Orchid launch telemetry is ready.",
			queryText: "orchid launch telemetry",
			preferredTitle: "Unrelated Draft",
		}));

		expect(plan).toMatchObject({ action: "reinforced", page: { id: "lexical-page" } });
		expect(plan.identity_reason_codes).toContain("bm25");
	});

	it("uses an available namespaced page vector signal without treating recency as a tie-break", async () => {
		const userId = id("page-vector-user");
		const nodeId = id("node");
		await seedNode(userId, nodeId);
		await seedPage(userId, { id: "vector-a", nodeId, topic: null, title: "Legacy Page", summary: "Legacy summary." });
		await seedPage(userId, { id: "vector-b", nodeId, topic: null, title: "Legacy Page", summary: "Legacy summary." });
		let queryOptions = null;
		const vectorEnv = {
			DB: env.DB,
			AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
			VECTORIZE: {
				query: async (_values, options) => {
					queryOptions = options;
					return { matches: [
						{ id: "page:vector-b", score: 0.99 },
						{ id: "page:vector-a", score: 0.1 },
					] };
				},
			},
		};

		const plan = await buildManualPagePlan(vectorEnv, userId, pageInput({
			primaryNodeId: nodeId,
			topic: null,
			digest: "A new semantic update.",
			preferredTitle: "Unrelated Draft",
			config: { useVectors: true, embedModel: "test-embedding" },
		}));

		expect(plan).toMatchObject({ action: "reinforced", page: { id: "vector-b" } });
		expect(plan.identity_reason_codes).toContain("vector");
		expect(queryOptions).toMatchObject({
			namespace: await manualPageVectorNamespace(userId),
			topK: 20,
			returnMetadata: "none",
		});
		expect(queryOptions.namespace).not.toBe(userId);
	});

	it("creates a new page when no compatible candidate reaches the threshold", async () => {
		const userId = id("page-new-user");
		const atlasNode = id("atlas-node");
		const cometNode = id("comet-node");
		await seedNode(userId, atlasNode, "Atlas");
		await seedNode(userId, cometNode, "Silver Comet");
		await seedPage(userId, {
			id: "comet-page",
			nodeId: cometNode,
			topic: "silver comet",
			title: "Silver Comet Runtime",
			summary: "Go runtime details.",
		});

		const plan = await buildManualPagePlan(env, userId, pageInput({
			primaryNodeId: atlasNode,
			topic: "atlas",
			digest: "Atlas hiring decisions are finalized.",
		}));

		expect(plan).toMatchObject({ action: "created", write: true, page: { node_id: atlasNode } });
	});
});
