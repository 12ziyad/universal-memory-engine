import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runMcpConversationCollectCommand, runMcpDirectSaveCommand } from "../src/pipeline/manual_mcp.js";
import { writeApproved } from "../src/pipeline/write.js";

function migrationQueries(name) {
	const migration = (env.TEST_MIGRATIONS ?? []).find((item) => item.name === name);
	if (!migration) throw new Error(`missing test migration: ${name}`);
	return migration.queries ?? [];
}

async function applyMigration(name) {
	const statements = migrationQueries(name).map((query) => env.DB.prepare(query));
	if (statements.length) await env.DB.batch(statements);
}

async function schemaObjects(names) {
	const placeholders = names.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT name, type FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY name`,
	).bind(...names).all();
	return results ?? [];
}

async function collect(userId, line, conversationId) {
	return runMcpConversationCollectCommand(env, null, userId, {
		topic: "atlas",
		messages: [{ id: `${conversationId}-user`, role: "user", content: line }],
		conversationId,
		digestResponse: line,
		extractionResponse: { facts: [], relationships: [], notes: "" },
	});
}

describe("manual identity forward repair migration", () => {
	it("is idempotent on expanded 0008 and repairs the original short 0008 without manual_revision", async () => {
		const migrationName = "0009_manual_identity_forward_repair.sql";
		const tableNames = [
			"manual_node_identities",
			"manual_fact_identities",
			"manual_page_identities",
			"manual_page_versions",
			"manual_page_write_epochs",
		];

		// The normal test bootstrap represents a fresh database with expanded 0008.
		// Reapplying 0009 must be a complete no-op at the schema boundary.
		await applyMigration(migrationName);
		expect(await schemaObjects(tableNames)).toEqual(tableNames
			.slice()
			.sort()
			.map((name) => ({ name, type: "table" })));

		// Reproduce the production-risk history: only the original node-identity
		// table exists and memory_pages never received manual_revision.
		await env.DB.batch([
			env.DB.prepare("DROP TABLE manual_page_write_epochs"),
			env.DB.prepare("DROP TABLE manual_page_versions"),
			env.DB.prepare("DROP TABLE manual_page_identities"),
			env.DB.prepare("DROP TABLE manual_fact_identities"),
			env.DB.prepare("ALTER TABLE memory_pages DROP COLUMN manual_revision"),
		]);
		expect((await schemaObjects(tableNames)).map((row) => row.name)).toEqual(["manual_node_identities"]);

		await applyMigration(migrationName);
		expect(await schemaObjects(tableNames)).toEqual(tableNames
			.slice()
			.sort()
			.map((name) => ({ name, type: "table" })));
		const { results: pageColumns } = await env.DB.prepare("PRAGMA table_info(memory_pages)").all();
		expect((pageColumns ?? []).map((column) => column.name)).not.toContain("manual_revision");

		// Prove both the page create and reinforcement paths use the repaired side
		// table rather than the absent legacy column.
		const userId = `migration-short-0008-${crypto.randomUUID()}`;
		const first = await collect(userId, "Atlas planning is active.", "atlas-thread");
		expect(first).toMatchObject({ status: "wrote", receipt: { page_action: "created" } });
		const page = await env.DB.prepare("SELECT * FROM memory_pages WHERE user_id = ?").bind(userId).first();
		const update = await writeApproved(env, {}, userId, {
			pageUpdates: [{
				page: { ...page, short_summary: "Atlas delivery is next." },
				expected_revision: 0,
				expected_updated_at: page.updated_at,
				expected_input_hash: page.input_hash,
				write_token: "page_write_short_0008",
				now: Number(page.updated_at) + 1,
			}],
		});
		expect(update.committed.pageUpdates).toEqual([page.id]);
		const version = await env.DB.prepare(
			"SELECT revision, write_token FROM manual_page_versions WHERE user_id = ?",
		).bind(userId).first();
		expect(version).toMatchObject({ revision: 1, write_token: null });

		// Exercise the other repaired 0008 appendage through the real manual fact
		// claim and reinforcement path, not just by checking table existence.
		const factContent = "Short Schema Project uses D1.";
		const extractionResponse = {
			facts: [{
				identity: {
					label: "Short Schema Project",
					category: "project",
					existing_node_id: null,
					aliases: [],
				},
				memory: { kind: "slice", slice_kind: "technical_detail", text: factContent },
				confidence: 0.98,
				supersedes: false,
			}],
			relationships: [],
			notes: "",
		};
		const firstFact = await runMcpDirectSaveCommand(env, null, userId, {
			content: factContent,
			idempotencyKey: "short-0008-fact-first",
			extractionResponse,
		});
		const { results: claimsAfterFirst } = await env.DB.prepare(
			"SELECT * FROM manual_fact_identities WHERE user_id = ? ORDER BY fact_key",
		).bind(userId).all();
		const { results: slicesAfterFirst } = await env.DB.prepare(
			"SELECT * FROM slices WHERE user_id = ? AND text = ? ORDER BY id",
		).bind(userId, factContent).all();
		const secondFact = await runMcpDirectSaveCommand(env, null, userId, {
			content: factContent,
			idempotencyKey: "short-0008-fact-second",
			extractionResponse,
		});
		expect(firstFact.status).toBe("wrote");
		expect(secondFact.status).toBe("wrote");
		const { results: claimsAfterSecond } = await env.DB.prepare(
			"SELECT * FROM manual_fact_identities WHERE user_id = ? ORDER BY fact_key",
		).bind(userId).all();
		const { results: slicesAfterSecond } = await env.DB.prepare(
			"SELECT * FROM slices WHERE user_id = ? AND text = ? ORDER BY id",
		).bind(userId, factContent).all();
		expect(claimsAfterFirst.length).toBeGreaterThan(0);
		expect(claimsAfterSecond.map((claim) => claim.object_id)).toEqual(
			claimsAfterFirst.map((claim) => claim.object_id),
		);
		expect(slicesAfterSecond.map((slice) => slice.id)).toEqual(slicesAfterFirst.map((slice) => slice.id));
		expect(slicesAfterSecond.some((slice) => Number(slice.reinforcement_count) >= 1)).toBe(true);
	});
});
