import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";
import { hashText, normalizeSourcePacket, storeSourcePacket } from "../src/pipeline/source.js";
import { applyGates } from "../src/pipeline/gates.js";
import { writeApproved } from "../src/pipeline/write.js";
import { saveConversation } from "../src/pipeline/manual_collect.js";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import { listCandidates, promoteCandidate, rejectCandidate } from "../src/pipeline/candidates.js";
import { ingestMessages } from "../src/pipeline/ingest.js";
import { runExtraction } from "../src/pipeline/extract.js";
import { normalizeProjectScope, ProjectScopeError } from "../src/lib/project_scope.js";

const scope = (projectId, projectName) => ({ projectId, projectName });

async function writeScopedFact(userId, projectScope, suffix) {
	const text = `Scoped Atlas uses ${suffix} configuration`;
	const plan = await applyGates(
		env,
		getConfig(env),
		userId,
		{
			objects: [
				{ kind: "node", label: "Scoped Atlas", category: "project", confidence: 0.99 },
				{ kind: "slice", on: "Scoped Atlas", text, kind_detail: "decision", confidence: 0.99 },
			],
			notes: "",
		},
		[],
		undefined,
		{
			projectScope,
			sourceText: text,
			sourceMessages: [{ id: `msg-${suffix}`, role: "user", content: text }],
		},
	);
	await writeApproved(env, getConfig(env), userId, plan);
	return plan;
}

describe("project-scoped writes", () => {
	it("rejects malformed project identities instead of truncating or widening to global", () => {
		expect(normalizeProjectScope({ projectId: null })).toMatchObject({ projectId: null, projectName: null });
		for (const projectId of ["", " alpha", "alpha ", false, 42, Number.MAX_SAFE_INTEGER + 1, {}, [], Number.NaN, "x".repeat(161)]) {
			expect(() => normalizeProjectScope({ projectId })).toThrow(ProjectScopeError);
		}
		expect(() => normalizeProjectScope({ projectId: "x".repeat(161) })).toThrowError(
			expect.objectContaining({ code: "project_id_too_long" }),
		);
	});

	it("keeps legacy global hashes stable and treats project names as display-only", async () => {
		const userId = "scope-hash-user";
		const conversationId = "scope-hash-conversation";
		const content = "The cache uses bounded retries.";
		const input = {
			type: "message",
			sourceMode: "scope_hash",
			content,
			messageId: "scope-hash-message",
			conversationId,
		};
		const globalPacket = await normalizeSourcePacket(userId, input);
		const legacyScope = {
			user_id: userId,
			memory_user_id: userId,
			owner_user_id: userId,
			external_user_id: userId,
			scope_user_id: userId,
			workspace_id: "default",
			app_id: "uml",
			agent_id: null,
			session_id: null,
			thread_id: null,
			topic: null,
			source_scope: null,
		};
		const legacyHash = await hashText(JSON.stringify({
			sourceType: "message",
			sourceMode: "scope_hash",
			conversationId,
			threadId: null,
			topic: null,
			scope: legacyScope,
			messages: [{
				id: "scope-hash-message",
				role: "user",
				content_hash: await hashText(content),
			}],
		}));
		expect(globalPacket.packet.content_hash).toBe(legacyHash);
		expect(globalPacket.packet.idempotency_key).toBe(
			`message:scope_hash:default:uml:${conversationId}:${legacyHash}`,
		);

		const alphaOldName = await normalizeSourcePacket(userId, {
			...input,
			scope: { projectId: "alpha", projectName: "Old Alpha" },
		});
		const alphaNewName = await normalizeSourcePacket(userId, {
			...input,
			scope: { projectId: "alpha", projectName: "Renamed Alpha" },
		});
		expect(alphaNewName.packet.content_hash).toBe(alphaOldName.packet.content_hash);
		expect(alphaNewName.packet.idempotency_key).toBe(alphaOldName.packet.idempotency_key);
		expect(alphaNewName.packet.project_name).toBe("Renamed Alpha");
	});

	it("returns persisted attribution on an immutable exact replay", async () => {
		const userId = `canonical-source-${crypto.randomUUID()}`;
		const idempotencyKey = `canonical-source-key-${crypto.randomUUID()}`;
		const message = { id: "canonical-message", role: "user", content: "I use D1 for project Atlas." };
		const original = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "ingest",
			messages: [message],
			idempotencyKey,
			receivedAt: 1_800_000_000_000,
			scope: scope("atlas", "Original Atlas"),
		});
		const first = await storeSourcePacket(env, original.packet, { immutableIdempotency: true });

		const renamed = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "ingest",
			messages: [message],
			idempotencyKey,
			receivedAt: 1_900_000_000_000,
			scope: scope("atlas", "Renamed Atlas"),
		});
		expect(renamed.packet.content_hash).toBe(original.packet.content_hash);
		const replay = await storeSourcePacket(env, renamed.packet, { immutableIdempotency: true });

		expect(replay).toMatchObject({
			id: first.id,
			project_id: "atlas",
			project_name: "Original Atlas",
			received_at: 1_800_000_000_000,
		});
		expect(replay.messages).toEqual(renamed.packet.messages);
		const row = await env.DB.prepare(
			"SELECT project_name, received_at, seen_count FROM source_packets WHERE id = ? AND user_id = ?",
		).bind(first.id, userId).first();
		expect(row).toMatchObject({ project_name: "Original Atlas", received_at: 1_800_000_000_000, seen_count: 2 });
	});

	it("matches and reinforces only inside the exact project, with NULL reserved for global", async () => {
		const userId = `scope-write-${crypto.randomUUID()}`;
		await writeScopedFact(userId, scope(null, null), "global");
		await writeScopedFact(userId, scope("alpha", "Alpha"), "alpha");
		await writeScopedFact(userId, scope("beta", "Beta"), "beta");
		await writeScopedFact(userId, scope("alpha", "Alpha"), "alpha");

		const { results: nodes } = await env.DB.prepare(
			"SELECT id, project_id, project_name, mention_count FROM nodes WHERE user_id = ? ORDER BY COALESCE(project_id, '')",
		).bind(userId).all();
		expect(nodes).toHaveLength(3);
		expect(nodes.map((row) => [row.project_id, row.project_name, row.mention_count])).toEqual([
			[null, null, 1],
			["alpha", "Alpha", 2],
			["beta", "Beta", 1],
		]);

		const { results: slices } = await env.DB.prepare(
			`SELECT project_id, project_name, reinforcement_count
			 FROM slices WHERE user_id = ? ORDER BY COALESCE(project_id, '')`,
		).bind(userId).all();
		expect(slices.map((row) => [row.project_id, row.project_name, row.reinforcement_count])).toEqual([
			[null, null, 0],
			["alpha", "Alpha", 1],
			["beta", "Beta", 0],
		]);

		// Even a stale/malformed plan cannot touch a row from another scope: the
		// project predicate is part of the same UPDATE statement.
		await writeApproved(env, getConfig(env), userId, {
			projectScope: scope("beta", "Beta"),
			nodeTouches: new Set([nodes.find((row) => row.project_id === "alpha").id]),
		});
		const alpha = await env.DB.prepare(
			"SELECT mention_count FROM nodes WHERE user_id = ? AND project_id = 'alpha'",
		).bind(userId).first();
		expect(alpha.mention_count).toBe(2);
	});

	it("namespaces project idempotency and stamps manual-collect plus MCP staging rows", async () => {
		const userId = `scope-doors-${crypto.randomUUID()}`;
		const explicitKey = `same-key-${crypto.randomUUID()}`;
		const packetInput = (projectScope) => ({
			type: "message",
			sourceMode: "scope_test",
			content: "The cache key is project-qualified.",
			messageId: "same-message",
			idempotencyKey: explicitKey,
			scope: projectScope,
		});
		const globalPacket = await normalizeSourcePacket(userId, packetInput(scope(null, null)));
		const alphaPacket = await normalizeSourcePacket(userId, packetInput(scope("alpha", "Alpha")));
		const betaPacket = await normalizeSourcePacket(userId, packetInput(scope("beta", "Beta")));
		expect(globalPacket.packet.idempotency_key).toBe(explicitKey);
		expect(new Set([
			globalPacket.packet.idempotency_key,
			alphaPacket.packet.idempotency_key,
			betaPacket.packet.idempotency_key,
		]).size).toBe(3);
		const escapedGlobal = await normalizeSourcePacket(userId, {
			...packetInput(scope(null, null)),
			idempotencyKey: alphaPacket.packet.idempotency_key,
		});
		expect(escapedGlobal.packet.idempotency_key).not.toBe(alphaPacket.packet.idempotency_key);
		expect(escapedGlobal.packet.idempotency_key).toContain("itsuki-scope:v1:g:");
		await storeSourcePacket(env, globalPacket.packet);
		await storeSourcePacket(env, alphaPacket.packet);
		await storeSourcePacket(env, betaPacket.packet);

		for (const projectScope of [scope("alpha", "Alpha"), scope("beta", "Beta")]) {
			await saveConversation(env, null, userId, [{
				id: `manual-${projectScope.projectId}`,
				role: "user",
				content: "We decided the Scoped Atlas cache key is project-qualified.",
				ts: Date.now(),
			}], {
				conversationId: `manual-${projectScope.projectId}`,
				idempotencyKey: `manual-${explicitKey}`,
				memoryScope: projectScope,
				digestResponse: "Scoped Atlas uses a project-qualified cache key.",
			});
		}

		const stagedInput = {
			messages: [{
				id: "mcp-alpha",
				role: "user",
				content: "We decided Scoped Atlas uses D1, and its integration tests pass.",
				ts: Date.now(),
			}],
			conversationId: "mcp-alpha",
			idempotencyKey: `mcp-${explicitKey}`,
			memoryScope: scope("alpha", "Alpha"),
		};
		const staged = await stageMcpConversation(env, null, userId, stagedInput);
		expect(staged.fired).toBe(true);
		const duplicate = await stageMcpConversation(env, null, userId, stagedInput);
		expect(duplicate).toMatchObject({
			ok: true,
			duplicate: true,
			memory_scope: { project_id: "alpha", project_name: "Alpha" },
			receipt: { outcome: "staged", project_id: "alpha", project_name: "Alpha" },
		});
		expect(duplicate.receipt.id).toBe(staged.receipt.id);

		const { results: pages } = await env.DB.prepare(
			"SELECT source_mode, project_id, project_name FROM memory_pages WHERE user_id = ? ORDER BY source_mode, project_id",
		).bind(userId).all();
		expect(pages.filter((row) => row.source_mode === "manual_collect")).toEqual([
			expect.objectContaining({ project_id: "alpha", project_name: "Alpha" }),
			expect.objectContaining({ project_id: "beta", project_name: "Beta" }),
		]);
		expect(pages).toContainEqual(expect.objectContaining({
			source_mode: "mcp_save",
			project_id: "alpha",
			project_name: "Alpha",
		}));

		const stagedRow = await env.DB.prepare(
			"SELECT project_id, project_name FROM staged_memories WHERE user_id = ? AND lane = 'mcp_save' LIMIT 1",
		).bind(userId).first();
		expect(stagedRow).toMatchObject({ project_id: "alpha", project_name: "Alpha" });
		const job = await env.DB.prepare(
			"SELECT payload_json FROM memory_jobs WHERE user_id = ? AND type = 'mcp_enrich' LIMIT 1",
		).bind(userId).first();
		expect(JSON.parse(job.payload_json)).toMatchObject({ project_id: "alpha", project_name: "Alpha" });
		const { results: rollups } = await env.DB.prepare(
			"SELECT payload_json FROM memory_jobs WHERE user_id = ? AND type = 'pass2_rollup'",
		).bind(userId).all();
		expect(rollups.map((row) => JSON.parse(row.payload_json))).toEqual(expect.arrayContaining([
			expect.objectContaining({ project_id: "alpha", project_name: "Alpha" }),
			expect.objectContaining({ project_id: "beta", project_name: "Beta" }),
		]));
	});

	it("preserves non-project provenance and attributes content-free opt-out receipts", async () => {
		const userId = `scope-provenance-${crypto.randomUUID()}`;
		const memoryScope = {
			projectId: "alpha",
			projectName: "Alpha",
			workspaceId: "workspace-7",
			appId: "app-7",
			agentId: "agent-7",
			sourceScope: "repository",
		};
		const ctx = createExecutionContext();
		await ingestMessages(env, ctx, userId, [{
			id: "observe-scope",
			role: "user",
			content: "Could you explain the cache documentation?",
			ts: Date.now(),
		}], {
			conversationId: "observe-scope",
			idempotencyKey: `observe-${crypto.randomUUID()}`,
			memoryScope,
			sourceMode: "scope_observe",
		});
		await waitOnExecutionContext(ctx);

		await saveConversation(env, null, userId, [{
			id: "manual-scope",
			role: "user",
			content: "We decided to use a project-qualified cache key.",
			ts: Date.now(),
		}], {
			conversationId: "manual-scope",
			idempotencyKey: `manual-${crypto.randomUUID()}`,
			memoryScope,
			digestResponse: "The project uses a project-qualified cache key.",
		});

		await stageMcpConversation(env, null, userId, {
			messages: [{
				id: "mcp-scope",
				role: "user",
				content: "We decided the project uses D1 for durable storage.",
				ts: Date.now(),
			}],
			conversationId: "mcp-scope",
			idempotencyKey: `mcp-${crypto.randomUUID()}`,
			memoryScope,
		});

		const { results: packets } = await env.DB.prepare(
			`SELECT source_mode, project_id, project_name, workspace_id, app_id, agent_id, source_scope
			 FROM source_packets WHERE user_id = ? AND source_mode IN ('scope_observe', 'manual_collect', 'mcp_save')`,
		).bind(userId).all();
		expect(packets).toHaveLength(3);
		for (const packet of packets) {
			expect(packet).toMatchObject({
				project_id: "alpha",
				project_name: "Alpha",
				workspace_id: "workspace-7",
				app_id: "app-7",
				agent_id: "agent-7",
				source_scope: "repository",
			});
		}

		const privateMessage = [{
			id: "private",
			role: "user",
			content: "This is private; do not remember this.",
			ts: Date.now(),
		}];
		const optedIngest = await ingestMessages(env, null, userId, privateMessage, { memoryScope, sourceMode: "scope_opt_out" });
		const optedManual = await saveConversation(env, null, userId, privateMessage, { memoryScope });
		const optedMcp = await stageMcpConversation(env, null, userId, { messages: privateMessage, memoryScope });
		for (const result of [optedIngest, optedManual, optedMcp]) {
			expect(result.receipt).toMatchObject({
				outcome: "no_write",
				project_id: "alpha",
				project_name: "Alpha",
				opt_out: true,
			});
		}

		await runExtraction(env, userId, [{
			id: "extract-scope",
			role: "user",
			content: "Scoped Extractor uses bounded retries.",
			ts: Date.now(),
		}], [], {
			meta: { project_id: "alpha", project_name: "Alpha" },
			llmResponse: { objects: [
				{ kind: "node", label: "Scoped Extractor", category: "project", confidence: 0.99 },
				{ kind: "slice", on: "Scoped Extractor", text: "Uses bounded retries", kind_detail: "decision", confidence: 0.99 },
			] },
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		const extractRollup = await env.DB.prepare(
			"SELECT payload_json FROM memory_jobs WHERE user_id = ? AND type = 'pass2_rollup' AND extraction_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		expect(JSON.parse(extractRollup.payload_json)).toMatchObject({ project_id: "alpha", project_name: "Alpha" });
	});

	it("returns a machine-readable scoped error when the MCP queue is full", async () => {
		const userId = `scope-full-${crypto.randomUUID()}`;
		const now = Date.now();
		const statements = Array.from({ length: 200 }, (_, i) => env.DB.prepare(
			`INSERT INTO memory_jobs
				(id, user_id, type, status, idempotency_key, payload_json, created_at, updated_at)
			 VALUES (?, ?, 'extract', 'queued', ?, '{}', ?, ?)`,
		).bind(`full-job-${i}-${userId}`, userId, `full-key-${i}`, now, now));
		for (let i = 0; i < statements.length; i += 50) {
			await env.DB.batch(statements.slice(i, i + 50));
		}
		const result = await stageMcpConversation(env, null, userId, {
			messages: [{ id: "full-message", role: "user", content: "The queue uses bounded backpressure." }],
			conversationId: "full-conversation",
			memoryScope: { projectId: "full-project", projectName: "Full Project" },
		});
		expect(result).toMatchObject({
			ok: false,
			code: "queue_full",
			http_status: 429,
			memory_scope: { project_id: "full-project", project_name: "Full Project" },
			receipt: { outcome: "queue_full", project_id: "full-project", project_name: "Full Project" },
		});
	});

	it("promotes a candidate only into the candidate row's project", async () => {
		const userId = `scope-candidate-${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO nodes
				(id, user_id, label, category, state, created_at, updated_at, project_id, project_name)
			 VALUES ('beta-node', ?, 'Scoped Candidate', 'project', 'active', ?, ?, 'beta', 'Beta')`,
		).bind(userId, now, now).run();
		await env.DB.prepare(
			`INSERT INTO candidates
				(id, user_id, label, strength, mentions, created_at, status, role_guess,
				 project_id, project_name)
			 VALUES ('alpha-candidate', ?, 'Scoped Candidate', 'strong', 1, ?, 'pending', 'project', 'alpha', 'Alpha')`,
		).bind(userId, now).run();
		await env.DB.prepare(
			`INSERT INTO candidates
				(id, user_id, label, strength, mentions, created_at, status, role_guess,
				 project_id, project_name)
			 VALUES ('beta-candidate', ?, 'Scoped Candidate', 'strong', 1, ?, 'pending', 'project', 'beta', 'Beta')`,
		).bind(userId, now).run();
		await env.DB.prepare(
			`INSERT INTO candidates
				(id, user_id, label, strength, mentions, created_at, status,
				 project_id, project_name)
			 VALUES ('alpha-reject', ?, 'Rejected Scoped Candidate', 'weak', 1, ?, 'pending', 'alpha', 'Alpha')`,
		).bind(userId, now).run();
		const pending = await listCandidates(env, userId, { status: "pending" });
		expect(pending).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "alpha-candidate", projectId: "alpha", projectName: "Alpha" }),
			expect.objectContaining({ id: "beta-candidate", projectId: "beta", projectName: "Beta" }),
			expect.objectContaining({ id: "alpha-reject", projectId: "alpha", projectName: "Alpha" }),
		]));

		const result = await promoteCandidate(env, userId, "alpha-candidate", {
			action: "promote_to_slice",
			text: "Scoped Candidate uses the alpha release workflow.",
		});
		expect(result.ok).toBe(true);
		const { results: nodes } = await env.DB.prepare(
			"SELECT project_id, project_name FROM nodes WHERE user_id = ? AND label = 'Scoped Candidate' ORDER BY project_id",
		).bind(userId).all();
		expect(nodes).toEqual([
			expect.objectContaining({ project_id: "alpha", project_name: "Alpha" }),
			expect.objectContaining({ project_id: "beta", project_name: "Beta" }),
		]);
		const slice = await env.DB.prepare(
			"SELECT project_id, project_name FROM slices WHERE user_id = ? LIMIT 1",
		).bind(userId).first();
		expect(slice).toMatchObject({ project_id: "alpha", project_name: "Alpha" });

		await rejectCandidate(env, userId, "alpha-reject", { action: "suppress_similar" });
		const suppression = await env.DB.prepare(
			"SELECT project_id, project_name FROM memory_suppressions WHERE user_id = ? AND source_object_id = 'alpha-reject'",
		).bind(userId).first();
		expect(suppression).toMatchObject({ project_id: "alpha", project_name: "Alpha" });
	});
});
