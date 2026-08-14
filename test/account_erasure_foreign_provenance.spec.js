import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createExtractionRun, storeReceipt } from "../src/lib/db.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";
import { normalizeSourcePacket, storeSourcePacket } from "../src/pipeline/source.js";

function id(prefix) {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function user(label) {
	const userId = id("usr");
	const email = `${label}-${crypto.randomUUID()}@example.com`.toLowerCase();
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', 'user')`,
	).bind(userId, email, email, label, now, now).run();
	return { id: userId, email };
}

describe("foreign-project account erasure provenance", () => {
	it("preserves the organization's memory while removing every departing account link and transcript", async () => {
		const owner = await user("foreign-owner");
		const target = await user("departing-member");
		const now = Date.now();
		const orgId = id("org");
		const projectId = id("proj");
		const memoryOwner = id("mem");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organizations
				 (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, 'Foreign org', ?, 1, 'active', ?, ?)`,
			).bind(orgId, owner.id, `foreign-${orgId}`, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, created_at, updated_at)
				 VALUES (?, ?, ?, 'owner', ?, ?)`,
			).bind(id("orgm"), orgId, owner.id, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(id("orgm"), orgId, target.id, owner.id, now, now),
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default,
				  status, organization_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'Shared project', ?, 0, 'active', ?, ?, ?)`,
			).bind(projectId, owner.id, memoryOwner, `shared-${projectId}`, orgId, now, now),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'member', ?, ?, ?)`,
			).bind(id("prjm"), projectId, orgId, target.id, owner.id, now, now),
		]);

		const normalized = await normalizeSourcePacket(memoryOwner, {
			type: "message",
			sourceMode: "foreign_erasure_test",
			content: "The shared project preserves this permitted fact.",
			messageId: id("msg"),
			scope: {
				memoryUserId: memoryOwner,
				ownerUserId: memoryOwner,
				accountUserId: target.id,
				managedProjectId: projectId,
				externalUserId: target.id,
			},
		});
		const packet = await storeSourcePacket(env, normalized.packet);
		const scopeJson = JSON.stringify({
			account_user_id: target.id,
			managed_project_id: projectId,
			owner_user_id: memoryOwner,
		});
		const runId = await createExtractionRun(env, memoryOwner, {
			toolName: "foreign-erasure-test",
			sourceMode: "test",
			sourcePacketId: packet.id,
			scopeJson,
		});
		const receiptId = id("receipt");
		await storeReceipt(env, memoryOwner, "test", {
			id: receiptId,
			outcome: "wrote",
			extraction_run_id: runId,
			source_packet_id: packet.id,
			scope_json: scopeJson,
		}, "Shared content saved.", { strict: true });

		const episodeId = id("episode");
		const atomId = id("atom");
		const threadId = id("pgthread");
		const messageId = id("pgmsg");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO source_episodes
				 (id, user_id, memory_user_id, owner_user_id, external_user_id, project_id,
				  source_packet_id, message_id, message_index, role, text, text_hash, observed_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'user', 'Shared permitted episode', ?, ?, ?)`,
			).bind(
				episodeId, memoryOwner, memoryOwner, memoryOwner, target.id, projectId,
				packet.id, id("msg"), "a".repeat(64), now, now,
			),
			env.DB.prepare(
				`INSERT INTO semantic_atom_candidates
				 (id, user_id, memory_user_id, owner_user_id, external_user_id, project_id,
				  capture_run_id, extraction_run_id, source_episode_id, source_packet_id, chunk_key,
				  source_message_id, start_code_point, end_code_point, evidence_quote, evidence_hash,
				  dedupe_key, atom_type, entity, entity_type, attribute, value, assertion, cardinality,
				  confidence, observed_at, extraction_model, schema_version, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chunk', ?, 0, 10,
				  'Shared evidence', ?, ?, 'fact', 'Project', 'project', 'state', 'active',
				  'The shared project is active', 'single', 0.9, ?, 'test-model', 'v1', 'candidate', ?)`,
			).bind(
				atomId, memoryOwner, memoryOwner, memoryOwner, target.id, projectId,
				id("capture"), runId, episodeId, packet.id, id("msg"), "b".repeat(64), id("dedupe"), now, now,
			),
			env.DB.prepare(
				`INSERT INTO playground_threads
				 (id, user_id, account_user_id, managed_project_id, title, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'Private member transcript', ?, ?)`,
			).bind(threadId, memoryOwner, target.id, projectId, now, now),
			env.DB.prepare(
				`INSERT INTO playground_messages
				 (id, thread_id, user_id, account_user_id, managed_project_id, role, content, created_at)
				 VALUES (?, ?, ?, ?, ?, 'user', 'Member-only transcript canary', ?)`,
			).bind(messageId, threadId, memoryOwner, target.id, projectId, now),
		]);

		expect((await deleteAccountCompletely(env, target.id)).deleted).toBe(true);

		const survivingPacket = await env.DB.prepare(
			"SELECT external_user_id, raw_meta_json, content_preview FROM source_packets WHERE id = ?",
		).bind(packet.id).first();
		expect(survivingPacket).not.toBeNull();
		expect(survivingPacket.external_user_id).toBeNull();
		expect(JSON.stringify(JSON.parse(survivingPacket.raw_meta_json))).not.toContain(target.id);
		expect(survivingPacket.content_preview).toContain("shared project");
		expect(await env.DB.prepare(
			"SELECT text, external_user_id FROM source_episodes WHERE id = ?",
		).bind(episodeId).first()).toEqual({ text: "Shared permitted episode", external_user_id: null });
		expect(await env.DB.prepare(
			"SELECT assertion, external_user_id FROM semantic_atom_candidates WHERE id = ?",
		).bind(atomId).first()).toEqual({ assertion: "The shared project is active", external_user_id: null });
		for (const [table, rowId] of [["receipts", receiptId], ["extraction_runs", runId]]) {
			const row = await env.DB.prepare(`SELECT scope_json FROM ${table} WHERE id = ?`).bind(rowId).first();
			expect(row).not.toBeNull();
			expect(JSON.stringify(JSON.parse(row.scope_json))).not.toContain(target.id);
		}
		for (const [table, rowId] of [["playground_threads", threadId], ["playground_messages", messageId]]) {
			expect(await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first()).toBeNull();
		}
		expect(await env.DB.prepare("SELECT id FROM managed_projects WHERE id = ?").bind(projectId).first())
			.toEqual({ id: projectId });
		expect(await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first())
			.toEqual({ id: orgId });
		const canary = await env.DB.prepare(
			`SELECT
			 (SELECT COUNT(*) FROM source_packets WHERE external_user_id = ? OR raw_meta_json LIKE ?) +
			 (SELECT COUNT(*) FROM source_episodes WHERE external_user_id = ?) +
			 (SELECT COUNT(*) FROM semantic_atom_candidates WHERE external_user_id = ?) +
			 (SELECT COUNT(*) FROM receipts WHERE scope_json LIKE ?) +
			 (SELECT COUNT(*) FROM extraction_runs WHERE scope_json LIKE ?) AS n`,
		).bind(target.id, `%${target.id}%`, target.id, target.id, `%${target.id}%`, `%${target.id}%`).first();
		expect(Number(canary.n)).toBe(0);
	});
});
