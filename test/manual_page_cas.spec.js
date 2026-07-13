import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import { archiveObject, deleteObject } from "../src/pipeline/cleanup.js";
import { buildManualPagePlan } from "../src/pipeline/manual_page.js";
import { runMcpConversationCollectCommand } from "../src/pipeline/manual_mcp.js";
import { writeApproved } from "../src/pipeline/write.js";

async function seedPage(userId, pageId) {
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, source_mode, title, canonical_title, short_summary,
				 created_at, updated_at, last_seen_at, heat_score)
			 VALUES (?, ?, 'manual_collect', ?, ?, ?, ?, ?, ?, 1)`,
		).bind(pageId, userId, "Atlas Page", "atlas page", "Original summary", now, now, now),
		env.DB.prepare(
			`INSERT INTO manual_page_versions
				(user_id, page_id, revision, write_token, updated_at)
			 VALUES (?, ?, 0, NULL, ?)`,
		).bind(userId, pageId, now),
	]);
	return env.DB.prepare("SELECT * FROM memory_pages WHERE id = ? AND user_id = ?")
		.bind(pageId, userId)
		.first();
}

function stalePlan(page, writeToken = "page_write_fixed_replay", pageClaim = null) {
	const now = Number(page.updated_at) + 1;
	return {
		pageUpdates: [{
			page: { ...page, short_summary: "Updated exactly once" },
			expected_revision: 0,
			expected_updated_at: page.updated_at,
			expected_input_hash: page.input_hash,
			write_token: writeToken,
			now,
		}],
		pageClaims: pageClaim ? [{
			identity_key: pageClaim,
			page_id: page.id,
			created_at: now,
			expected_write_epoch: 0,
		}] : [],
	};
}

function newPagePlan(userId, pageId, identityKey, expectedWriteEpoch = 0, nodeId = null) {
	const now = Date.now();
	const page = {
		id: pageId,
		user_id: userId,
		node_id: nodeId,
		identity_key: identityKey,
		source_mode: "manual_collect",
		title: "Epoch Page",
		canonical_title: identityKey,
		short_summary: `Summary for ${pageId}`,
		created_at: now,
		updated_at: now,
		last_seen_at: now,
	};
	return {
		newPages: [page],
		pageClaims: [{
			identity_key: identityKey,
			page_id: pageId,
			created_at: now,
			expected_write_epoch: expectedWriteEpoch,
		}],
	};
}

function newNodePlan(userId, nodeId, identityKey) {
	const now = Date.now();
	return {
		manualDerivedRefresh: true,
		primaryIdentityClaims: [{
			canonical_key: identityKey,
			node_id: nodeId,
			created_at: now,
		}],
		newNodes: [{
			id: nodeId,
			user_id: userId,
			label: identityKey,
			canonical_label: identityKey,
			identity_key: identityKey,
			aliases_json: "[]",
			category: "project",
			role: null,
			state: "active",
			summary: null,
			created_at: now,
			updated_at: now,
			last_seen_at: now,
		}],
	};
}

async function storedPage(userId, pageId) {
	return env.DB.prepare("SELECT * FROM memory_pages WHERE id = ? AND user_id = ?")
		.bind(pageId, userId)
		.first();
}

async function storedVersion(userId, pageId) {
	return env.DB.prepare("SELECT * FROM manual_page_versions WHERE user_id = ? AND page_id = ?")
		.bind(userId, pageId)
		.first();
}

describe("manual page write-token CAS", () => {
	it("reads pages, write epoch, and suppressions in one planning snapshot", async () => {
		const observedSql = [];
		const snapshotEnv = {
			DB: {
				prepare(sql) {
					return {
						bind(...values) {
							return { sql: String(sql), values };
						},
					};
				},
				async batch(statements) {
					observedSql.push(...statements.map((statement) => statement.sql));
					return [
						{ results: [] },
						{ results: [{ epoch: 4 }] },
						{ results: [{ kind: "memory_page", canonical_key: "atlas", suppressed_until: null }] },
						{ results: [] },
					];
				},
			},
		};

		const plan = await buildManualPagePlan(snapshotEnv, "snapshot-user", {
			digest: "Atlas planning is active.",
			messages: [{ id: "snapshot-user-message", role: "user", content: "Atlas planning is active." }],
			intent: { topic: "atlas", explicitNew: false, updateRequested: false },
			conversationId: "snapshot-conversation",
			runId: "snapshot-run",
		});

		expect(observedSql).toHaveLength(4);
		expect(observedSql[0]).toContain("FROM memory_pages");
		expect(observedSql[1]).toContain("manual_page_write_epochs");
		expect(observedSql[2]).toContain("memory_suppressions");
		expect(observedSql[3]).toContain("manual_page_identities");
		expect(plan).toMatchObject({ action: "suppressed", write: false, reason: "suppressed_blocked" });
	});

	it("preserves the /v1/save page contract and lazily versions it on a later MCP update", async () => {
		const userId = `page-cas-compatibility-${crypto.randomUUID()}`;
		const request = new Request("http://example.com/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({
				userId,
				mode: "conversation",
				topic: "atlas",
				conversationId: "atlas-compatibility",
				messages: [{ id: "compat-user", role: "user", content: "Atlas planning is active." }],
				_test: { digestResponse: "Atlas planning is active." },
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const compatibilityResult = await response.json();

		expect(response.status).toBe(200);
		expect(compatibilityResult).toMatchObject({
			fired: true,
			receipt: { page_action: "created", saved: { pages: 1 } },
		});
		expect(await env.DB.prepare(
			"SELECT * FROM manual_page_versions WHERE user_id = ?",
		).bind(userId).first()).toBeNull();

		const compatibilityPage = await env.DB.prepare(
			"SELECT * FROM memory_pages WHERE user_id = ?",
		).bind(userId).first();
		const updateLine = `Update ${compatibilityPage.title}: delivery is next.`;
		const mcpResult = await runMcpConversationCollectCommand(env, null, userId, {
			topic: "atlas",
			conversationId: "atlas-compatibility",
			messages: [{ id: "mcp-user", role: "user", content: updateLine }],
			digestResponse: updateLine,
			extractionResponse: {
				facts: [{
					identity: {
						label: compatibilityPage.title,
						category: "project",
						existing_node_id: null,
						aliases: [],
					},
					memory: { kind: "slice", slice_kind: "progress", text: updateLine },
					confidence: 0.97,
					supersedes: false,
				}],
				relationships: [],
				notes: "",
			},
		});
		expect(mcpResult).toMatchObject({ status: "wrote", receipt: { page_action: "updated" } });
		const { results: pages } = await env.DB.prepare(
			"SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).all();
		expect(pages).toHaveLength(1);
		expect(await storedVersion(userId, pages[0].id)).toMatchObject({ revision: 1, write_token: null });
	});

	it("makes an exact low-level new-page plan replay a no-op", async () => {
		const userId = `page-create-replay-${crypto.randomUUID()}`;
		const pageId = "create-replay-page";
		const plan = newPagePlan(userId, pageId, "create replay");

		const first = await writeApproved(env, {}, userId, plan);
		const second = await writeApproved(env, {}, userId, plan);

		expect(first.committed.pages).toEqual([pageId]);
		expect(second.committed.pages).toEqual([]);
		const { results: pages } = await env.DB.prepare(
			"SELECT * FROM memory_pages WHERE user_id = ?",
		).bind(userId).all();
		expect(pages).toHaveLength(1);
		expect(await storedVersion(userId, pageId)).toMatchObject({ revision: 0, write_token: null });
	});

	it("does not create a page or page claim when its provisional primary node loses canonical identity", async () => {
		const userId = `page-provisional-node-${crypto.randomUUID()}`;
		const canonicalNodeKey = "atlas provisional project";
		await writeApproved(env, {}, userId, newNodePlan(userId, "atlas-node-winner", canonicalNodeKey));

		const losingNode = newNodePlan(userId, "atlas-node-loser", canonicalNodeKey);
		const losingPage = newPagePlan(
			userId,
			"atlas-page-loser",
			"atlas losing page identity",
			0,
			"atlas-node-loser",
		);
		const result = await writeApproved(env, {}, userId, {
			...losingNode,
			...losingPage,
		});

		expect(result.committed.nodes).toEqual([]);
		expect(result.committed.pages).toEqual([]);
		expect(await storedPage(userId, "atlas-page-loser")).toBeNull();
		expect(await env.DB.prepare(
			"SELECT * FROM manual_page_identities WHERE user_id = ? AND canonical_key = ?",
		).bind(userId, "atlas losing page identity").first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT * FROM nodes WHERE user_id = ? AND id = ?",
		).bind(userId, "atlas-node-loser").first()).toBeNull();
	});

	it("does not leave secondary page claims when a new page loses its primary identity", async () => {
		const userId = `page-secondary-claim-${crypto.randomUUID()}`;
		await writeApproved(env, {}, userId, newPagePlan(
			userId,
			"primary-page-winner",
			"topic:atlas",
		));
		const losingPlan = newPagePlan(userId, "primary-page-loser", "topic:atlas");
		losingPlan.pageClaims.push({
			identity_key: "semantic:losing-atlas-title",
			page_id: "primary-page-loser",
			created_at: Date.now(),
			expected_write_epoch: 0,
		});

		const result = await writeApproved(env, {}, userId, losingPlan);

		expect(result.committed.pages).toEqual([]);
		expect(await storedPage(userId, "primary-page-loser")).toBeNull();
		expect(await env.DB.prepare(
			"SELECT * FROM manual_page_identities WHERE user_id = ? AND canonical_key = ?",
		).bind(userId, "semantic:losing-atlas-title").first()).toBeNull();
	});

	it("persists learned page claims only for the writer that wins the update token", async () => {
		const userId = `page-claim-cas-${crypto.randomUUID()}`;
		const pageId = "claim-cas-page";
		const page = await seedPage(userId, pageId);
		const winner = stalePlan(page, "page_write_claim_winner", "atlas winner claim");
		const loser = stalePlan(page, "page_write_claim_loser", "atlas losing claim");
		winner.pageUpdates[0].page.short_summary = "Winner updated the page";
		loser.pageUpdates[0].page.short_summary = "Loser must not update the page";

		const winnerResult = await writeApproved(env, {}, userId, winner);
		const loserResult = await writeApproved(env, {}, userId, loser);

		expect(winnerResult.committed.pageUpdates).toEqual([pageId]);
		expect(loserResult.committed.pageUpdates).toEqual([]);
		expect(await storedPage(userId, pageId)).toMatchObject({ short_summary: "Winner updated the page" });
		expect(await env.DB.prepare(
			"SELECT page_id FROM manual_page_identities WHERE user_id = ? AND canonical_key = ?",
		).bind(userId, "atlas winner claim").first()).toMatchObject({ page_id: pageId });
		expect(await env.DB.prepare(
			"SELECT * FROM manual_page_identities WHERE user_id = ? AND canonical_key = ?",
		).bind(userId, "atlas losing claim").first()).toBeNull();
	});

	for (const cleanup of ["archive", "delete"]) {
		it(`invalidates a stale losing creator after ${cleanup} while allowing a freshly planned creator`, async () => {
			const userId = `page-create-${cleanup}-${crypto.randomUUID()}`;
			const identityKey = `epoch ${cleanup}`;
			const winner = newPagePlan(userId, `${cleanup}-winner`, identityKey, 0);
			const staleLoser = newPagePlan(userId, `${cleanup}-stale-loser`, identityKey, 0);
			const winnerResult = await writeApproved(env, {}, userId, winner);
			expect(winnerResult.committed.pages).toEqual([`${cleanup}-winner`]);

			if (cleanup === "archive") {
				await archiveObject(env, userId, { kind: "memory_page", id: `${cleanup}-winner` });
			} else {
				await deleteObject(env, userId, { kind: "memory_page", id: `${cleanup}-winner`, suppress: false });
			}
			const staleResult = await writeApproved(env, {}, userId, staleLoser);
			expect(staleResult.committed.pages).toEqual([]);

			const epoch = await env.DB.prepare(
				"SELECT epoch FROM manual_page_write_epochs WHERE user_id = ?",
			).bind(userId).first();
			expect(epoch).toMatchObject({ epoch: 1 });
			const activeBeforeFresh = await env.DB.prepare(
				`SELECT COUNT(*) AS count FROM memory_pages
				 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL`,
			).bind(userId).first();
			expect(Number(activeBeforeFresh.count)).toBe(0);

			const freshPageId = `${cleanup}-fresh`;
			const freshResult = await writeApproved(
				env,
				{},
				userId,
				newPagePlan(userId, freshPageId, identityKey, 1),
			);
			expect(freshResult.committed.pages).toEqual([freshPageId]);
			const claim = await env.DB.prepare(
				"SELECT page_id FROM manual_page_identities WHERE user_id = ? AND canonical_key = ?",
			).bind(userId, identityKey).first();
			expect(claim).toMatchObject({ page_id: freshPageId });
		});
	}

	it("treats the write token as single-use when the same low-level plan is replayed", async () => {
		const userId = `page-cas-replay-${crypto.randomUUID()}`;
		const pageId = "replay-page";
		const page = await seedPage(userId, pageId);
		const plan = stalePlan(page);

		const first = await writeApproved(env, {}, userId, plan);
		const afterFirst = await storedPage(userId, pageId);
		const second = await writeApproved(env, {}, userId, plan);
		const afterSecond = await storedPage(userId, pageId);

		expect(first.committed.pageUpdates).toEqual([pageId]);
		expect(second.committed.pageUpdates).toEqual([]);
		expect(afterFirst).toMatchObject({ short_summary: "Updated exactly once", heat_score: 2 });
		expect(afterSecond).toMatchObject({
			short_summary: afterFirst.short_summary,
			heat_score: afterFirst.heat_score,
			updated_at: afterFirst.updated_at,
		});
		expect(await storedVersion(userId, pageId)).toMatchObject({ revision: 1, write_token: null });
	});

	it("rolls back the revision claim and page update on a late batch failure", async () => {
		const userId = `page-cas-rollback-${crypto.randomUUID()}`;
		const pageId = "rollback-page";
		const page = await seedPage(userId, pageId);
		const plan = { ...stalePlan(page, "page_write_rollback"), testFailAtomicWrite: true };

		await expect(writeApproved(env, {}, userId, plan)).rejects.toThrow();

		expect(await storedPage(userId, pageId)).toMatchObject({
			short_summary: "Original summary",
			heat_score: 1,
			updated_at: page.updated_at,
		});
		expect(await storedVersion(userId, pageId)).toMatchObject({ revision: 0, write_token: null });
	});

	it("uses NULL-safe page timestamps instead of treating a missing timestamp as a wildcard", async () => {
		const userId = `page-cas-null-time-${crypto.randomUUID()}`;
		const pageId = "null-time-page";
		await seedPage(userId, pageId);
		await env.DB.prepare("UPDATE memory_pages SET updated_at = NULL WHERE id = ? AND user_id = ?")
			.bind(pageId, userId)
			.run();
		const page = await storedPage(userId, pageId);
		const plan = stalePlan(page, "page_write_null_time");
		await env.DB.prepare(
			"UPDATE memory_pages SET short_summary = ?, updated_at = ? WHERE id = ? AND user_id = ?",
		).bind("Compatibility writer won", Date.now(), pageId, userId).run();

		const result = await writeApproved(env, {}, userId, plan);

		expect(result.committed.pageUpdates).toEqual([]);
		expect(await storedPage(userId, pageId)).toMatchObject({ short_summary: "Compatibility writer won" });
		expect(await storedVersion(userId, pageId)).toMatchObject({ revision: 0, write_token: null });
	});

	it("rejects a same-timestamp compatibility write when the input fingerprint changed", async () => {
		const userId = `page-cas-input-hash-${crypto.randomUUID()}`;
		const pageId = "input-hash-page";
		const page = await seedPage(userId, pageId);
		const plan = stalePlan(page, "page_write_input_hash");
		await env.DB.prepare(
			"UPDATE memory_pages SET short_summary = ?, input_hash = ? WHERE id = ? AND user_id = ?",
		).bind("Compatibility writer won", "compatibility-input-hash", pageId, userId).run();

		const result = await writeApproved(env, {}, userId, plan);

		expect(result.committed.pageUpdates).toEqual([]);
		expect(await storedPage(userId, pageId)).toMatchObject({
			short_summary: "Compatibility writer won",
			input_hash: "compatibility-input-hash",
			updated_at: page.updated_at,
		});
		expect(await storedVersion(userId, pageId)).toMatchObject({ revision: 0, write_token: null });
	});

	it("does not recreate a ledger or mutate a page from a stale plan after archive", async () => {
		const userId = `page-cas-archive-${crypto.randomUUID()}`;
		const pageId = "archived-page";
		const page = await seedPage(userId, pageId);
		const plan = stalePlan(page, "page_write_stale_archive");
		await archiveObject(env, userId, { kind: "memory_page", id: pageId });

		const result = await writeApproved(env, {}, userId, plan);

		expect(result.committed.pageUpdates).toEqual([]);
		expect(await storedVersion(userId, pageId)).toBeNull();
		expect(await storedPage(userId, pageId)).toMatchObject({
			short_summary: "Original summary",
			archived_at: expect.any(Number),
		});
	});

	it("does not recreate a ledger or mutate a page from a stale plan after delete", async () => {
		const userId = `page-cas-delete-${crypto.randomUUID()}`;
		const pageId = "deleted-page";
		const page = await seedPage(userId, pageId);
		const plan = stalePlan(page, "page_write_stale_delete");
		await deleteObject(env, userId, { kind: "memory_page", id: pageId, suppress: false });

		const result = await writeApproved(env, {}, userId, plan);

		expect(result.committed.pageUpdates).toEqual([]);
		expect(await storedVersion(userId, pageId)).toBeNull();
		expect(await storedPage(userId, pageId)).toMatchObject({
			short_summary: "Original summary",
			deleted_at: expect.any(Number),
		});
	});
});
