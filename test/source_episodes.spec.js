import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import {
	EPISODE_TEXT_CAP,
	countSourceEpisodes,
	deleteSourceEpisodes,
	episodesForPacket,
	findSourceEpisodes,
	writeSourceEpisodes,
} from "../src/pipeline/episodes.js";
import { bulkDeleteBySource, deleteAllMemories } from "../src/pipeline/cleanup.js";
import { saveMemoryRules } from "../src/pipeline/rules.js";

/**
 * P0-D — source episodes.
 *
 * The layer exists because a conservative extraction pass could make allowed
 * evidence permanently unrecoverable: 64.6% of judge-scored misses are facts
 * that were never stored at all. It is also the most dangerous thing V3 adds,
 * because it is durable searchable user text — so the privacy and erasure
 * assertions here are deliberately heavier than the recall ones.
 */

const V3 = (userId) => ({ ...env, ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: userId });

let counter = 0;
const nextUser = (tag) => `ep_${tag}_${Date.now().toString(36)}_${counter++}`;

function messages(texts, { role = "user", packet = "pkt" } = {}) {
	return texts.map((content, index) => ({
		id: `${packet}_m${index}`,
		role,
		content,
		ts: Date.parse("2026-02-01T10:00:00Z") + index * 1000,
	}));
}

async function write(userId, texts, options = {}) {
	return writeSourceEpisodes(env, userId, {
		sourcePacketId: options.packet ?? "pkt_1",
		conversationId: options.conversationId ?? "conv_1",
		messages: options.messages ?? messages(texts, { packet: options.packet ?? "pkt_1" }),
		projectId: options.projectId ?? null,
		projectName: options.projectName ?? null,
		rules: options.rules,
	});
}

describe("episodes preserve what extraction might decline", () => {
	it("writes one row per permitted message, in order, with its provenance", async () => {
		const userId = nextUser("write");
		const result = await write(userId, ["I moved to Malmo", "The lease runs two years"]);
		expect(result.written).toBe(2);

		const rows = await episodesForPacket(env, userId, "pkt_1");
		expect(rows.map((r) => r.text)).toEqual(["I moved to Malmo", "The lease runs two years"]);
		expect(rows.map((r) => r.message_index)).toEqual([0, 1]);
		expect(rows[0].message_id).toBe("pkt_1_m0");
		expect(rows[0].source_packet_id).toBe("pkt_1");
	});

	it("is searchable by the words the user actually used", async () => {
		const userId = nextUser("search");
		await write(userId, [
			"On January 19 Alice said she had left her banking job",
			"We ate at the Portuguese place on Wexford Street",
		]);
		const hits = await findSourceEpisodes(env, userId, ["banking", "alice"]);
		expect(hits).toHaveLength(1);
		expect(hits[0].text).toMatch(/left her banking job/);
	});

	it("preserves assistant turns as context but ignores tool and system machinery", async () => {
		const userId = nextUser("roles");
		await writeSourceEpisodes(env, userId, {
			sourcePacketId: "pkt_roles",
			messages: [
				{ id: "a", role: "user", content: "user said something durable" },
				{ id: "b", role: "assistant", content: "assistant replied about it" },
				{ id: "c", role: "tool", content: "tool call output blob" },
				{ id: "d", role: "system", content: "system prompt text" },
			],
		});
		const rows = await episodesForPacket(env, userId, "pkt_roles");
		expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
	});

	it("is idempotent: replaying the same accepted write does not duplicate it", async () => {
		const userId = nextUser("replay");
		await write(userId, ["the same words twice"]);
		await write(userId, ["the same words twice"]);
		expect(await countSourceEpisodes(env, userId)).toBe(1);
	});

	it("caps a single episode rather than storing an unbounded row", async () => {
		const userId = nextUser("cap");
		await write(userId, ["x".repeat(EPISODE_TEXT_CAP + 5000)]);
		const rows = await episodesForPacket(env, userId, "pkt_1");
		expect(rows[0].text).toHaveLength(EPISODE_TEXT_CAP);
	});

	it("bounds how many rows one accepted write can create", async () => {
		const userId = nextUser("bound");
		const many = Array.from({ length: 120 }, (_, i) => `durable fact number ${i}`);
		const result = await write(userId, many);
		expect(result.written).toBeLessThanOrEqual(40);
		expect(await countSourceEpisodes(env, userId)).toBeLessThanOrEqual(40);
	});
});

describe("episodes are not a privacy bypass", () => {
	it("never stores content the account's exclude rules refuse", async () => {
		const userId = nextUser("rules");
		await saveMemoryRules(env, userId, { excludes: ["salary"], includes: [], customInstructions: "" });
		const result = await write(userId, [
			"my salary is 74000 a year",
			"I moved to Malmo",
		]);
		expect(result.written).toBe(1);
		expect(result.ruleFiltered).toBe(1);

		const rows = await episodesForPacket(env, userId, "pkt_1");
		expect(rows.map((r) => r.text)).toEqual(["I moved to Malmo"]);
		// And the excluded text is not reachable through the search index either.
		expect(await findSourceEpisodes(env, userId, ["salary"])).toEqual([]);
	});

	it("writes NOTHING when the rules cannot be loaded, rather than writing everything", async () => {
		const userId = nextUser("failclosed");
		const brokenEnv = {
			...env,
			DB: {
				prepare() { throw new Error("rules store unavailable"); },
				batch() { throw new Error("rules store unavailable"); },
			},
		};
		const result = await writeSourceEpisodes(brokenEnv, userId, {
			sourcePacketId: "pkt_fail",
			messages: messages(["something durable"], { packet: "pkt_fail" }),
		});
		expect(result.written).toBe(0);
		expect(result.rulesUnavailable).toBe(true);
		expect(await countSourceEpisodes(env, userId)).toBe(0);
	});

	it("stores the SCRUBBED text, because scrubbing happens before ingest persists anything", async () => {
		// End-to-end through the real door: the secret must not exist in the row.
		const userId = nextUser("secret");
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://itsuki.app/v1/ingest", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify({
					userId,
					messages: [{ role: "user", content: "deploy key is AKIAIOSFODNN7EXAMPLE and I moved to Malmo" }],
					_test: { llmResponse: { objects: [], notes: "none" } },
				}),
			}),
			V3(userId),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBeLessThan(400);

		const { results } = await env.DB.prepare(
			"SELECT text FROM source_episodes WHERE user_id = ?",
		).bind(userId).all();
		const stored = (results ?? []).map((r) => r.text).join("\n");
		expect(stored).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(await findSourceEpisodes(env, userId, ["AKIAIOSFODNN7EXAMPLE"])).toEqual([]);
	});
});

describe("episodes cannot cross a scope boundary", () => {
	it("one account never sees another's episodes, through search or by packet", async () => {
		const a = nextUser("tenant_a");
		const b = nextUser("tenant_b");
		await write(a, ["Alice left her banking job"], { packet: "pkt_a" });
		await write(b, ["Bob left his banking job"], { packet: "pkt_b" });

		const forA = await findSourceEpisodes(env, a, ["banking"]);
		expect(forA).toHaveLength(1);
		expect(forA[0].text).toMatch(/Alice/);
		// Asking for the other account's packet by id returns nothing, not theirs.
		expect(await episodesForPacket(env, a, "pkt_b")).toEqual([]);
	});

	it("project_only never returns a global or other-project episode", async () => {
		const userId = nextUser("project");
		await write(userId, ["global banking fact"], { packet: "pkt_g" });
		await write(userId, ["alpha banking fact"], { packet: "pkt_a", projectId: "proj_alpha", projectName: "Alpha" });
		await write(userId, ["beta banking fact"], { packet: "pkt_b", projectId: "proj_beta", projectName: "Beta" });

		const alpha = await findSourceEpisodes(env, userId, ["banking"], {
			recallScope: "project_only",
			projectId: "proj_alpha",
		});
		expect(alpha.map((r) => r.text)).toEqual(["alpha banking fact"]);
	});

	it("project_then_global returns the project and the account's global, never a sibling project", async () => {
		const userId = nextUser("then_global");
		await write(userId, ["global banking fact"], { packet: "pkt_g" });
		await write(userId, ["alpha banking fact"], { packet: "pkt_a", projectId: "proj_alpha", projectName: "Alpha" });
		await write(userId, ["beta banking fact"], { packet: "pkt_b", projectId: "proj_beta", projectName: "Beta" });

		const texts = (await findSourceEpisodes(env, userId, ["banking"], {
			recallScope: "project_then_global",
			projectId: "proj_alpha",
		})).map((r) => r.text).sort();
		expect(texts).toEqual(["alpha banking fact", "global banking fact"]);
	});

	it("project_only with no project returns nothing rather than everything", async () => {
		const userId = nextUser("noproject");
		await write(userId, ["global banking fact"], { packet: "pkt_g" });
		expect(await findSourceEpisodes(env, userId, ["banking"], { recallScope: "project_only" })).toEqual([]);
	});
});

describe("episodes are erased, not tombstoned", () => {
	it("a confirmed unscoped delete removes the rows and their search tokens", async () => {
		const userId = nextUser("erase");
		await write(userId, ["Alice left her banking job", "and moved to Malmo"]);
		expect(await countSourceEpisodes(env, userId)).toBe(2);

		const result = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(result.ok).toBe(true);
		expect(result.source_episodes_deleted).toBe(2);

		expect(await countSourceEpisodes(env, userId)).toBe(0);
		expect(await findSourceEpisodes(env, userId, ["banking", "malmo"])).toEqual([]);
		// The row is gone, not flagged: nothing is left to un-delete.
		const remaining = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ?",
		).bind(userId).first();
		expect(remaining.n).toBe(0);
	});

	it("leaves the FTS index with nothing to find after erasure", async () => {
		const userId = nextUser("fts");
		await write(userId, ["a very distinctive phrase about kayaking"]);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		// Query the index directly — a stale token here is a leak the API would hide.
		const { results } = await env.DB.prepare(
			`SELECT e.id FROM source_episodes_fts f
			 JOIN source_episodes e ON e.rowid = f.rowid
			 WHERE source_episodes_fts MATCH ?`,
		).bind('"kayaking"').all();
		expect(results ?? []).toEqual([]);
	});

	it("deleteAllMemories takes the episodes with it", async () => {
		const userId = nextUser("deleteall");
		await write(userId, ["something worth erasing"]);
		await deleteAllMemories(env, userId, "DELETE ALL");
		expect(await countSourceEpisodes(env, userId)).toBe(0);
	});

	it("a delete for one account never touches another's episodes", async () => {
		const a = nextUser("keep_a");
		const b = nextUser("keep_b");
		await write(a, ["account a text"], { packet: "pkt_a" });
		await write(b, ["account b text"], { packet: "pkt_b" });
		await bulkDeleteBySource(env, a, { dryRun: false, confirm: true });
		expect(await countSourceEpisodes(env, a)).toBe(0);
		expect(await countSourceEpisodes(env, b)).toBe(1);
	});

	it("a dry-run delete removes nothing", async () => {
		const userId = nextUser("dry");
		await write(userId, ["still here afterwards"]);
		const preview = await bulkDeleteBySource(env, userId, { dryRun: true });
		expect(preview.dry_run).toBe(true);
		expect(await countSourceEpisodes(env, userId)).toBe(1);
	});

	it("erasure converges even when an episode lands after the first sweep", async () => {
		const userId = nextUser("converge");
		await write(userId, ["first"], { packet: "pkt_1" });
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		// A late accept writes another one; the next delete still converges to zero.
		await write(userId, ["late arrival"], { packet: "pkt_2" });
		expect(await countSourceEpisodes(env, userId)).toBe(1);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(await countSourceEpisodes(env, userId)).toBe(0);
	});

	it("a scoped delete removes only the matched writes' episodes", async () => {
		const userId = nextUser("scoped");
		await deleteSourceEpisodes(env, userId);
		await write(userId, ["from the plugin lane"], { packet: "pkt_plugin" });
		await write(userId, ["from the sdk lane"], { packet: "pkt_sdk" });
		// No extraction runs exist for these packets, so a source-scoped delete
		// matches nothing and must remove nothing — a scoped delete that erased
		// everything would be an erasure wearing a curation's clothes.
		const result = await bulkDeleteBySource(env, userId, { source: "plugin", dryRun: false, confirm: true });
		expect(result.source_episodes_deleted).toBe(0);
		expect(await countSourceEpisodes(env, userId)).toBe(2);
	});
});

describe("episodes are written only for accounts selected for V3", () => {
	async function ingest(userId, environment) {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://itsuki.app/v1/ingest", {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify({
					userId,
					messages: [{ role: "user", content: "I moved to Malmo in October" }],
					_test: { llmResponse: { objects: [], notes: "none" } },
				}),
			}),
			environment,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it("writes nothing for a legacy account", async () => {
		const userId = nextUser("legacy");
		expect((await ingest(userId, env)).status).toBeLessThan(400);
		expect(await countSourceEpisodes(env, userId)).toBe(0);
	});

	it("writes for a selected account", async () => {
		const userId = nextUser("selected");
		expect((await ingest(userId, V3(userId))).status).toBeLessThan(400);
		expect(await countSourceEpisodes(env, userId)).toBe(1);
	});

	it("does not bleed across accounts when only one is selected", async () => {
		const selected = nextUser("bleed_on");
		const other = nextUser("bleed_off");
		const environment = V3(selected);
		await ingest(selected, environment);
		await ingest(other, environment);
		expect(await countSourceEpisodes(env, selected)).toBe(1);
		expect(await countSourceEpisodes(env, other)).toBe(0);
	});
});
