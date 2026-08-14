import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	RETENTION_CLASSES,
	RETENTION_CONFIRMATION,
	RetentionError,
	activateRetentionPolicy,
	discoverProjectMemorySpaces,
	listRetentionPolicies,
	MAX_RETENTION_MEMORY_SPACES,
	previewRetentionChange,
	processRetentionRun,
	retentionFenceAllows,
	retentionFenceGuardStatement,
	scheduleRetentionRuns,
} from "../src/lib/retention.js";
import { manualPageVectorNamespace } from "../src/pipeline/manual_search_profiles.js";
import { writeSourceEpisodes } from "../src/pipeline/episodes.js";
import { writeApproved } from "../src/pipeline/write.js";
import { getConfig } from "../src/config.js";
import {
	ERASED_SOURCE_CONTENT_HASH,
	normalizeSourcePacket,
	storeSourcePacket,
} from "../src/pipeline/source.js";

const DAY = 24 * 60 * 60 * 1000;
const ALLOW_ALL_RULES = { customInstructions: "", includes: [], excludes: [] };

async function makeProject(label = "retention") {
	const suffix = crypto.randomUUID().replaceAll("-", "");
	const ownerUserId = `user_${label}_${suffix}`;
	const projectId = `proj_${suffix}`;
	const memoryOwnerUserId = `mem_${suffix}`;
	const subtenantUserId = `mem_sub_${suffix}`;
	const now = Date.now();
	await env.DB.prepare(
		"INSERT INTO users (id, email, email_normalized, status, created_at) VALUES (?, ?, ?, 'active', ?)",
	).bind(ownerUserId, `${suffix}@example.com`, `${suffix}@example.com`, now).run();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
		).bind(projectId, ownerUserId, memoryOwnerUserId, label, label, now, now),
		env.DB.prepare(
			`INSERT INTO project_memory_spaces
			 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
		).bind(projectId, memoryOwnerUserId, subtenantUserId, now, now),
	]);
	return { projectId, ownerUserId, memoryOwnerUserId, subtenantUserId };
}

function scope(project, extra = {}) {
	return {
		projectId: project.projectId,
		memoryOwnerUserId: project.memoryOwnerUserId,
		actorUserId: project.ownerUserId,
		...extra,
	};
}

async function insertEpisode(userId, { id = `episode_${crypto.randomUUID()}`, createdAt, sourceTime = createdAt, text = "private retention specimen" } = {}) {
	await env.DB.prepare(
		`INSERT INTO source_episodes
		 (id, user_id, memory_user_id, owner_user_id, message_id, message_index, role,
		  text, text_hash, source_time, observed_at, created_at)
		 VALUES (?, ?, ?, ?, ?, 0, 'user', ?, ?, ?, ?, ?)`,
	).bind(
		id,
		userId,
		userId,
		userId,
		`message_${crypto.randomUUID()}`,
		text,
		`hash_${crypto.randomUUID()}`,
		sourceTime,
		createdAt,
		createdAt,
	).run();
	return id;
}

async function activate(project, retentionClass, days, now, expectedVersion = 0) {
	const preview = await previewRetentionChange(env, scope(project, {
		retentionClass,
		days,
		expectedVersion,
		now,
	}));
	return activateRetentionPolicy(env, scope(project, {
		retentionClass,
		days,
		expectedVersion,
		previewCutoffAt: preview.cutoff_at,
		previewInventoryHash: preview.inventory_hash,
		confirmation: RETENTION_CONFIRMATION,
		now,
	}));
}

async function processToCompletion(runId, now, options = {}) {
	let result = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		result = await processRetentionRun(options.env ?? env, {
			runId,
			now: now + attempt + 1,
			batchSize: options.batchSize ?? 50,
		});
		if (result.status === "completed") return result;
		expect(result.status).toBe("retry");
	}
	throw new Error(`retention run ${runId} did not complete: ${JSON.stringify(result)}`);
}

function retentionAuditUnavailableEnv() {
	const database = env.DB;
	return {
		...env,
		DB: new Proxy(database, {
			get(target, property) {
				if (property === "prepare") return (sql) => {
					if (/^\s*INSERT\s+INTO\s+audit_events/i.test(String(sql))) {
						throw new Error("injected retention audit outage");
					}
					return target.prepare(sql);
				};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	};
}

describe("enterprise retention", () => {
	it("rejects an oversized single-lane memory-space inventory before materializing it", async () => {
		const project = await makeProject("scope-cap");
		await env.DB.prepare(
			`WITH RECURSIVE seq(n) AS (
			   SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
			 )
			 INSERT INTO project_memory_spaces
			   (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 SELECT ?, ?, printf('scope_cap_%04d', n), 'active', ?, ? FROM seq`,
		).bind(
			MAX_RETENTION_MEMORY_SPACES + 1,
			project.projectId,
			project.memoryOwnerUserId,
			Date.now(),
			Date.now(),
		).run();
		await expect(discoverProjectMemorySpaces(env, scope(project))).rejects.toMatchObject({
			name: "RetentionError",
			code: "retention_scope_too_large",
			status: 409,
		});
	});

	it("defaults all seven classes to keep forever and locks security audit", async () => {
		const project = await makeProject("defaults");
		const policies = await listRetentionPolicies(env, scope(project));
		expect(policies.map((policy) => policy.class)).toEqual(RETENTION_CLASSES);
		expect(policies).toHaveLength(7);
		expect(policies.every((policy) => policy.days === null && policy.version === 0)).toBe(true);
		expect(policies.find((policy) => policy.class === "security_audit")).toMatchObject({
			locked: true,
			days: null,
		});
	});

	it("previews an exact bounded, content-free inventory without mutating state and uses storage age", async () => {
		const now = Date.now();
		const project = await makeProject("preview");
		const foreign = await makeProject("preview-foreign");
		const oldId = await insertEpisode(project.subtenantUserId, {
			createdAt: now - 60 * DAY,
			sourceTime: now,
			text: "SECRET-PREVIEW-CONTENT",
		});
		await insertEpisode(project.memoryOwnerUserId, {
			createdAt: now,
			sourceTime: now - 365 * DAY,
			text: "new storage row with an old event time",
		});
		await insertEpisode(foreign.memoryOwnerUserId, {
			createdAt: now - 60 * DAY,
			text: "foreign content",
		});

		const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM retention_runs").first();
		const preview = await previewRetentionChange(env, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			now,
		}));
		const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM retention_runs").first();

		expect(preview).toMatchObject({
			class: "source_episodes",
			days: 30,
			policy_version: 0,
			mutation_free: true,
			inventory: { total: 1 },
		});
		expect(preview.inventory.lanes.source_episodes).toBe(1);
		expect(preview.inventory_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(JSON.stringify(preview)).not.toContain("SECRET-PREVIEW-CONTENT");
		expect(JSON.stringify(preview)).not.toContain(oldId);
		expect(after.n).toBe(before.n);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM retention_policies WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });
	});

	it("removes expired source text from both canonical storage and FTS", async () => {
		const now = Date.now();
		const project = await makeProject("source-fts");
		const token = `retentionfts${crypto.randomUUID().replaceAll("-", "")}`;
		const episodeId = await insertEpisode(project.memoryOwnerUserId, {
			createdAt: now - 60 * DAY,
			text: token,
		});
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_episodes_fts WHERE source_episodes_fts MATCH ?",
		).bind(token).first()).toMatchObject({ n: 1 });

		const activated = await activate(project, "source_episodes", 30, now);
		await processToCompletion(activated.run.id, now);

		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?")
			.bind(episodeId).first()).toBeNull();
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_episodes_fts WHERE source_episodes_fts MATCH ?",
		).bind(token).first()).toMatchObject({ n: 0 });
	});

	it("keeps a shared capture run while it still owns a newer candidate", async () => {
		const now = Date.now();
		const project = await makeProject("capture-run-boundary");
		const userId = project.memoryOwnerUserId;
		const oldAt = now - 60 * DAY;
		const newAt = now - DAY;
		const oldEpisode = await insertEpisode(userId, { createdAt: oldAt, text: "old grounded evidence" });
		const newEpisode = await insertEpisode(userId, { createdAt: newAt, text: "new grounded evidence" });
		const captureRunId = `atomrun_${crypto.randomUUID()}`;
		const packetId = `packet_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO semantic_atom_capture_runs
			 (id, user_id, project_id, source_packet_id, chunk_key, status, model,
			  schema_version, accepted_at, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, 'shared', 'completed', 'test-model', 'test-v1', ?, ?, ?, ?)`,
		).bind(captureRunId, userId, project.projectId, packetId, oldAt, oldAt, oldAt, oldAt).run();
		const candidateIds = [];
		for (const [index, episodeId, createdAt] of [
			[0, oldEpisode, oldAt],
			[1, newEpisode, newAt],
		]) {
			const candidateId = `atom_${crypto.randomUUID()}`;
			candidateIds.push(candidateId);
			await env.DB.prepare(
				`INSERT INTO semantic_atom_candidates
				 (id, user_id, memory_user_id, owner_user_id, project_id, capture_run_id,
				  source_episode_id, source_packet_id, chunk_key, source_message_id,
				  start_code_point, end_code_point, evidence_quote, evidence_hash, dedupe_key,
				  atom_type, entity, entity_type, attribute, value, assertion, cardinality,
				  confidence, extraction_model, schema_version, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?, 0, 3, 'use', ?, ?,
				  'fact', 'Project', 'project', 'database', 'D1', 'Project uses D1',
				  'single', 0.9, 'test-model', 'test-v1', 'promoted', ?)`,
			).bind(
				candidateId,
				userId,
				userId,
				project.memoryOwnerUserId,
				project.projectId,
				captureRunId,
				episodeId,
				packetId,
				`message-${index}`,
				`evidence-${index}`,
				`dedupe-${crypto.randomUUID()}`,
				createdAt,
			).run();
			await env.DB.prepare(
				`INSERT INTO semantic_atom_projections
				 (candidate_id, user_id, project_id, source_episode_id, source_packet_id,
				  extraction_run_id, outcome, object_kind, object_id, schema_version, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'promoted', 'slice', ?, 'test-v1', ?)`,
			).bind(
				candidateId,
				userId,
				project.projectId,
				episodeId,
				packetId,
				`extract-${index}`,
				`slice-${index}`,
				createdAt,
			).run();
		}

		const activated = await activate(project, "source_episodes", 30, now);
		await processToCompletion(activated.run.id, now);

		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?").bind(oldEpisode).first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM semantic_atom_candidates WHERE id = ?").bind(candidateIds[0]).first()).toBeNull();
		expect(await env.DB.prepare("SELECT candidate_id FROM semantic_atom_projections WHERE candidate_id = ?")
			.bind(candidateIds[0]).first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?").bind(newEpisode).first()).toBeTruthy();
		expect(await env.DB.prepare("SELECT id FROM semantic_atom_candidates WHERE id = ?")
			.bind(candidateIds[1]).first()).toBeTruthy();
		expect(await env.DB.prepare("SELECT candidate_id FROM semantic_atom_projections WHERE candidate_id = ?")
			.bind(candidateIds[1]).first()).toBeTruthy();
		expect(await env.DB.prepare("SELECT id FROM semantic_atom_capture_runs WHERE id = ?")
			.bind(captureRunId).first()).toBeTruthy();
	});

	it("clears deleted facts from node summaries, manual FTS, and memory profiles", async () => {
		const now = Date.now();
		const project = await makeProject("derived-cleanup");
		const userId = project.memoryOwnerUserId;
		const nodeId = `node_${crypto.randomUUID()}`;
		const oldSliceId = `slice_${crypto.randomUUID()}`;
		const newSliceId = `slice_${crypto.randomUUID()}`;
		const secret = `retentionsecret${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO nodes
				 (id, user_id, label, category, state, summary, summary_sources_json, created_at, updated_at)
				 VALUES (?, ?, 'Retention account', 'project', 'active', ?, ?, ?, ?)`,
			).bind(nodeId, userId, `Retention account stores ${secret}`, JSON.stringify([oldSliceId]), now - 60 * DAY, now - 60 * DAY),
			env.DB.prepare(
				`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at)
				 VALUES (?, ?, ?, ?, 'fact', 1, ?)`,
			).bind(oldSliceId, userId, nodeId, `Retention account stores ${secret}`, now - 60 * DAY),
			env.DB.prepare(
				`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at)
				 VALUES (?, ?, ?, 'Retention account uses current public settings', 'fact', 1, ?)`,
			).bind(newSliceId, userId, nodeId, now - DAY),
			env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 VALUES (?, 'node', ?, 'Retention account', ?, 'project', ?, ?, ?, ?)`,
			).bind(userId, nodeId, secret, `hash-${crypto.randomUUID()}`, now, now, now),
			env.DB.prepare(
				`INSERT INTO memory_profiles
				 (user_id, profile_json, cluster_hints_json, family_summaries_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(
				userId,
				JSON.stringify({ top_labels: [secret] }),
				JSON.stringify([{ id: nodeId, summary: secret }]),
				JSON.stringify([{ summary: secret }]),
				now,
				now,
			),
		]);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH ?",
		).bind(secret).first()).toMatchObject({ n: 1 });

		const activated = await activate(project, "semantic_memory", 30, now);
		await processToCompletion(activated.run.id, now);

		expect(await env.DB.prepare("SELECT id FROM slices WHERE id = ?").bind(oldSliceId).first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM slices WHERE id = ?").bind(newSliceId).first()).toBeTruthy();
		const node = await env.DB.prepare(
			"SELECT summary, summary_sources_json FROM nodes WHERE id = ? AND user_id = ?",
		).bind(nodeId, userId).first();
		expect(node.summary).not.toContain(secret);
		expect(JSON.parse(node.summary_sources_json)).toEqual([newSliceId]);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH ?",
		).bind(secret).first()).toMatchObject({ n: 0 });
		const profile = await env.DB.prepare(
			"SELECT profile_json, cluster_hints_json, family_summaries_json FROM memory_profiles WHERE user_id = ?",
		).bind(userId).first();
		expect(JSON.stringify(profile)).not.toContain(secret);
	});

	it("deletes page vectors by verified namespace and converges every manual page ledger", async () => {
		const now = Date.now();
		const oldAt = now - 60 * DAY;
		const project = await makeProject("page-convergence");
		const pages = [
			{ id: `page_${crypto.randomUUID()}`, userId: project.memoryOwnerUserId },
			{ id: `page_${crypto.randomUUID()}`, userId: project.subtenantUserId },
		];
		const tokens = [];
		const statements = [];
		for (const [index, page] of pages.entries()) {
			const token = `pagefts${crypto.randomUUID().replaceAll("-", "")}`;
			tokens.push(token);
			statements.push(
				env.DB.prepare(
					`INSERT INTO memory_pages
					 (id, user_id, title, canonical_title, short_summary, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).bind(page.id, page.userId, `Page ${index}`, `page-${index}`, token, oldAt, oldAt),
				env.DB.prepare(
					`INSERT INTO manual_page_identities
					 (user_id, canonical_key, page_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				).bind(page.userId, `page-key-${index}`, page.id, oldAt, oldAt),
				env.DB.prepare(
					`INSERT INTO manual_page_versions (user_id, page_id, revision, write_token, updated_at)
					 VALUES (?, ?, 7, NULL, ?)`,
				).bind(page.userId, page.id, oldAt),
				env.DB.prepare(
					`INSERT INTO manual_search_profiles
					 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
					  profile_hash, source_updated_at, created_at, updated_at)
					 VALUES (?, 'page', ?, ?, ?, '', ?, ?, ?, ?)`,
				).bind(page.userId, page.id, `Page ${index}`, token, `hash-${index}-${crypto.randomUUID()}`, oldAt, oldAt, oldAt),
			);
		}
		statements.push(env.DB.prepare(
			"INSERT INTO manual_page_write_epochs (user_id, epoch, updated_at) VALUES (?, 4, ?)",
		).bind(project.memoryOwnerUserId, oldAt));
		await env.DB.batch(statements);
		for (const token of tokens) {
			expect(await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH ?",
			).bind(token).first()).toMatchObject({ n: 1 });
		}

		const namespaces = new Map();
		for (const page of pages) namespaces.set(`page:${page.id}`, await manualPageVectorNamespace(page.userId));
		const deletes = [];
		const vectorEnv = {
			...env,
			USE_VECTORS: "true",
			VECTORIZE: {
				async getByIds(ids) {
					return ids.map((id) => ({
						id,
						namespace: namespaces.get(id),
						metadata: { user_id: pages.find((page) => `page:${page.id}` === id).userId },
					}));
				},
				async deleteByIds(ids) { deletes.push([...ids]); },
			},
		};
		const activated = await activate(project, "semantic_memory", 30, now);
		await processToCompletion(activated.run.id, now, { env: vectorEnv });

		expect(deletes).toHaveLength(2);
		expect(deletes.flat().sort()).toEqual(pages.map((page) => `page:${page.id}`).sort());
		expect(deletes.every((ids) => ids.length === 1)).toBe(true);
		for (const page of pages) {
			expect(await env.DB.prepare("SELECT id FROM memory_pages WHERE id = ?").bind(page.id).first()).toBeNull();
			expect(await env.DB.prepare("SELECT page_id FROM manual_page_identities WHERE page_id = ?")
				.bind(page.id).first()).toBeNull();
			expect(await env.DB.prepare("SELECT page_id FROM manual_page_versions WHERE page_id = ?")
				.bind(page.id).first()).toBeNull();
			expect(await env.DB.prepare("SELECT object_id FROM manual_search_profiles WHERE object_id = ?")
				.bind(page.id).first()).toBeNull();
		}
		expect(await env.DB.prepare("SELECT epoch FROM manual_page_write_epochs WHERE user_id = ?")
			.bind(project.memoryOwnerUserId).first()).toEqual({ epoch: 5 });
		expect(await env.DB.prepare("SELECT epoch FROM manual_page_write_epochs WHERE user_id = ?")
			.bind(project.subtenantUserId).first()).toEqual({ epoch: 1 });
		for (const token of tokens) {
			expect(await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH ?",
			).bind(token).first()).toMatchObject({ n: 0 });
		}
	});

	it("leaves canonical rows retryable when Vectorize fails or reports another namespace", async () => {
		const now = Date.now();
		const project = await makeProject("vector-retry");
		const pageId = `page_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO memory_pages
			 (id, user_id, title, canonical_title, created_at, updated_at)
			 VALUES (?, ?, 'Vector retry', 'vector-retry', ?, ?)`,
		).bind(pageId, project.memoryOwnerUserId, now - 60 * DAY, now - 60 * DAY).run();
		const activated = await activate(project, "semantic_memory", 30, now);
		let deletes = 0;
		const mismatch = await processRetentionRun({
			...env,
			USE_VECTORS: "true",
			VECTORIZE: {
				async getByIds() { return [{ id: `page:${pageId}`, namespace: "another-tenant" }]; },
				async deleteByIds() { deletes += 1; },
			},
		}, { runId: activated.run.id, now: now + 1, batchSize: 50 });
		expect(mismatch).toMatchObject({ status: "retry", error_code: "retention_batch_failed" });
		expect(deletes).toBe(0);
		expect(await env.DB.prepare("SELECT id FROM memory_pages WHERE id = ?").bind(pageId).first()).toBeTruthy();

		const namespace = await manualPageVectorNamespace(project.memoryOwnerUserId);
		const providerFailure = await processRetentionRun({
			...env,
			USE_VECTORS: "true",
			VECTORIZE: {
				async getByIds() { return [{ id: `page:${pageId}`, namespace }]; },
				async deleteByIds() { throw new Error("provider unavailable"); },
			},
		}, { runId: activated.run.id, now: now + 2, batchSize: 50 });
		expect(providerFailure).toMatchObject({ status: "retry", error_code: "retention_batch_failed" });
		expect(await env.DB.prepare("SELECT id FROM memory_pages WHERE id = ?").bind(pageId).first()).toBeTruthy();
	});

	it("removes node manual identities, FTS profiles, memberships, and orphan topic communities", async () => {
		const now = Date.now();
		const oldAt = now - 60 * DAY;
		const project = await makeProject("node-convergence");
		const userId = project.memoryOwnerUserId;
		const nodeId = `node_${crypto.randomUUID()}`;
		const topicId = `topic_${crypto.randomUUID()}`;
		const factId = `fact_${crypto.randomUUID()}`;
		const token = `nodefts${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at)
				 VALUES (?, ?, 'Expired node', 'project', 'active', ?, ?, ?)`,
			).bind(nodeId, userId, token, oldAt, oldAt),
			env.DB.prepare(
				`INSERT INTO manual_node_identities
				 (user_id, canonical_key, node_id, created_at, updated_at) VALUES (?, 'expired-node', ?, ?, ?)`,
			).bind(userId, nodeId, oldAt, oldAt),
			env.DB.prepare(
				`INSERT INTO manual_fact_identities
				 (user_id, fact_key, object_kind, object_id, owner_node_id, created_at, updated_at)
				 VALUES (?, 'expired-fact', 'slice', ?, ?, ?, ?)`,
			).bind(userId, factId, nodeId, oldAt, oldAt),
			env.DB.prepare(
				`INSERT INTO topic_communities
				 (id, user_id, canonical_key, label, summary, created_at, updated_at)
				 VALUES (?, ?, 'expired-topic', 'Expired topic', ?, ?, ?)`,
			).bind(topicId, userId, token, oldAt, oldAt),
			env.DB.prepare(
				`INSERT INTO node_topic_communities
				 (user_id, community_id, node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			).bind(userId, topicId, nodeId, oldAt, oldAt),
			env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 VALUES (?, 'node', ?, 'Expired node', ?, '', 'expired-profile', ?, ?, ?)`,
			).bind(userId, nodeId, token, oldAt, oldAt, oldAt),
		]);

		const activated = await activate(project, "semantic_memory", 30, now);
		await processToCompletion(activated.run.id, now, { env: { ...env, USE_VECTORS: "false" } });

		for (const [table, column, id] of [
			["nodes", "id", nodeId],
			["manual_node_identities", "node_id", nodeId],
			["manual_fact_identities", "object_id", factId],
			["node_topic_communities", "node_id", nodeId],
			["topic_communities", "id", topicId],
			["manual_search_profiles", "object_id", nodeId],
		]) {
			expect(await env.DB.prepare(`SELECT ${column} FROM ${table} WHERE ${column} = ?`)
				.bind(id).first(), table).toBeNull();
		}
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH ?",
		).bind(token).first()).toMatchObject({ n: 0 });
	});

	it("scrubs operational content but preserves immutable replay tombstones", async () => {
		const now = Date.now();
		const oldAt = now - 60 * DAY;
		const project = await makeProject("operational-tombstone");
		const userId = project.subtenantUserId;
		const normalized = await normalizeSourcePacket(userId, {
			type: "message_batch",
			sourceMode: "ingest",
			idempotencyKey: `retention-replay-${crypto.randomUUID()}`,
			conversationId: `retention-conversation-${crypto.randomUUID()}`,
			messages: [{ id: "retention-message", role: "user", content: "private replay payload" }],
			scope: {
				memoryUserId: userId,
				ownerUserId: project.memoryOwnerUserId,
				accountUserId: project.ownerUserId,
				managedProjectId: project.projectId,
				externalUserId: "external-user",
			},
		});
		const stored = await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
		const receiptId = `receipt_${crypto.randomUUID()}`;
		const extractionId = `extract_${crypto.randomUUID()}`;
		const jobId = `job_${crypto.randomUUID()}`;
		const scopeJson = JSON.stringify({
			managed_project_id: project.projectId,
			owner_user_id: project.memoryOwnerUserId,
		});
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE source_packets SET received_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
			).bind(oldAt, oldAt, oldAt, stored.id),
			env.DB.prepare(
				`INSERT INTO receipts
				 (id, user_id, source, outcome, summary, detail, created_at,
				  source_packet_id, idempotency_key, scope_json)
				 VALUES (?, ?, 'ingest', 'wrote', 'private receipt summary', ?, ?, ?, ?, ?)`,
			).bind(
				receiptId,
				userId,
				JSON.stringify({ private: "receipt detail" }),
				oldAt,
				stored.id,
				normalized.packet.idempotency_key,
				scopeJson,
			),
			env.DB.prepare(
				`INSERT INTO extraction_runs
				 (id, user_id, tool_name, source_mode, topic_filter, receipt_id, status,
				  created_nodes_json, error, created_at, updated_at, source_packet_id,
				  idempotency_key, scope_json, job_id)
				 VALUES (?, ?, 'ingest', 'auto', 'private topic', ?, 'completed', ?,
				  'private extraction error', ?, ?, ?, ?, ?, ?)`,
			).bind(
				extractionId,
				userId,
				receiptId,
				JSON.stringify(["private-node"]),
				oldAt,
				oldAt,
				stored.id,
				normalized.packet.idempotency_key,
				scopeJson,
				jobId,
			),
			env.DB.prepare(
				`INSERT INTO memory_jobs
				 (id, user_id, type, status, idempotency_key, source_packet_id,
				  extraction_run_id, receipt_id, payload_json, error, created_at, updated_at, completed_at)
				 VALUES (?, ?, 'extract', 'completed', ?, ?, ?, ?, ?, 'private job error', ?, ?, ?)`,
			).bind(
				jobId,
				userId,
				normalized.packet.idempotency_key,
				stored.id,
				extractionId,
				receiptId,
				JSON.stringify({ private: "job payload" }),
				oldAt,
				oldAt,
				oldAt,
			),
		]);

		const activated = await activate(project, "operational_records", 30, now);
		await processToCompletion(activated.run.id, now);

		const packet = await env.DB.prepare(
			`SELECT id, content_hash, content_preview, message_count, raw_meta_json,
			        managed_project_id, owner_user_id, idempotency_key
			   FROM source_packets WHERE id = ?`,
		).bind(stored.id).first();
		expect(packet).toMatchObject({
			content_hash: ERASED_SOURCE_CONTENT_HASH,
			content_preview: null,
			message_count: 0,
			raw_meta_json: "{}",
			managed_project_id: project.projectId,
			owner_user_id: project.memoryOwnerUserId,
			idempotency_key: normalized.packet.idempotency_key,
		});
		expect(await env.DB.prepare("SELECT payload_json, error FROM memory_jobs WHERE id = ?")
			.bind(jobId).first()).toEqual({ payload_json: "{}", error: null });
		expect(await env.DB.prepare(
			"SELECT topic_filter, error, scope_json, created_nodes_json FROM extraction_runs WHERE id = ?",
		).bind(extractionId).first()).toEqual({
			topic_filter: null,
			error: null,
			scope_json: "{}",
			created_nodes_json: "[]",
		});
		expect(await env.DB.prepare("SELECT summary, detail, scope_json FROM receipts WHERE id = ?")
			.bind(receiptId).first()).toEqual({ summary: null, detail: "{}", scope_json: "{}" });

		const replay = await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
		expect(replay).toMatchObject({ id: stored.id, idempotency_conflict: true });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ? AND idempotency_key = ?",
		).bind(userId, normalized.packet.idempotency_key).first()).toMatchObject({ n: 1 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM source_episodes WHERE source_packet_id = ?")
			.bind(stored.id).first()).toMatchObject({ n: 0 });
	});

	it("discovers an empty-rollout historical subtenant read-only, then registers it atomically on activation", async () => {
		const now = Date.now();
		const project = await makeProject("historical-scope");
		await env.DB.prepare(
			"DELETE FROM project_memory_spaces WHERE project_id = ?",
		).bind(project.projectId).run();
		await env.DB.prepare(
			`INSERT INTO source_packets
			 (id, user_id, memory_user_id, owner_user_id, scope_user_id, source_type,
			  idempotency_key, content_hash, raw_meta_json, received_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?)`,
		).bind(
			`src_${crypto.randomUUID()}`,
			project.subtenantUserId,
			project.subtenantUserId,
			project.memoryOwnerUserId,
			project.subtenantUserId,
			`idem_${crypto.randomUUID()}`,
			`hash_${crypto.randomUUID()}`,
			JSON.stringify({ managed_project_id: project.projectId, account_user_id: project.ownerUserId }),
			now - 90 * DAY,
			now - 90 * DAY,
			now - 90 * DAY,
		).run();
		await insertEpisode(project.subtenantUserId, { createdAt: now - 90 * DAY });

		const preview = await previewRetentionChange(env, scope(project, {
			retentionClass: "source_episodes", days: 30, expectedVersion: 0, now,
		}));
		expect(preview).toMatchObject({ memory_spaces: 2, inventory: { total: 1 } });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_memory_spaces WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });

		await activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			previewCutoffAt: preview.cutoff_at,
			previewInventoryHash: preview.inventory_hash,
			confirmation: RETENTION_CONFIRMATION,
			now,
		}));
		const registered = await env.DB.prepare(
			`SELECT memory_user_id FROM project_memory_spaces
			 WHERE project_id = ? ORDER BY memory_user_id`,
		).bind(project.projectId).all();
		expect(registered.results.map((row) => row.memory_user_id)).toEqual(
			[project.memoryOwnerUserId, project.subtenantUserId].sort(),
		);
	});

	it("fails closed when historical provenance conflicts across managed projects", async () => {
		const now = Date.now();
		const project = await makeProject("ambiguous-scope");
		const other = await makeProject("ambiguous-other");
		await env.DB.prepare(
			`INSERT INTO source_packets
			 (id, user_id, memory_user_id, owner_user_id, scope_user_id, source_type,
			  idempotency_key, content_hash, raw_meta_json, received_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?)`,
		).bind(
			`src_${crypto.randomUUID()}`,
			project.subtenantUserId,
			project.subtenantUserId,
			project.memoryOwnerUserId,
			project.subtenantUserId,
			`idem_${crypto.randomUUID()}`,
			`hash_${crypto.randomUUID()}`,
			JSON.stringify({ managed_project_id: other.projectId }),
			now - DAY,
			now - DAY,
			now - DAY,
		).run();

		await expect(previewRetentionChange(env, scope(project, {
			retentionClass: "source_episodes", days: 30, expectedVersion: 0, now,
		}))).rejects.toMatchObject({ code: "retention_scope_incomplete", status: 409 });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM retention_policies WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });
	});

	it("requires optimistic version, an unchanged preview, and exact confirmation before shortening", async () => {
		const now = Date.now();
		const project = await makeProject("activate");
		await insertEpisode(project.memoryOwnerUserId, { createdAt: now - 90 * DAY });
		const preview = await previewRetentionChange(env, scope(project, {
			retentionClass: "source_episodes", days: 30, expectedVersion: 0, now,
		}));

		await expect(activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			previewCutoffAt: preview.cutoff_at,
			previewInventoryHash: preview.inventory_hash,
			confirmation: "apply retention",
			now,
		}))).rejects.toMatchObject({ code: "retention_confirmation_required", status: 400 });

		await expect(activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			previewCutoffAt: preview.cutoff_at,
			previewInventoryHash: "sha256:" + "0".repeat(64),
			confirmation: RETENTION_CONFIRMATION,
			now,
		}))).rejects.toMatchObject({ code: "retention_preview_changed", status: 409 });

		const activated = await activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			previewCutoffAt: preview.cutoff_at,
			previewInventoryHash: preview.inventory_hash,
			confirmation: RETENTION_CONFIRMATION,
			now,
		}));
		expect(activated.policy).toMatchObject({ class: "source_episodes", days: 30, version: 1 });
		expect(activated.run).toMatchObject({ mode: "execute", status: "queued", cutoff_at: preview.cutoff_at });

		await expect(activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes", days: null, expectedVersion: 0, now: now + 1,
		}))).rejects.toMatchObject({ code: "retention_conflict", status: 412 });

		const lengthened = await activateRetentionPolicy(env, scope(project, {
			retentionClass: "source_episodes", days: null, expectedVersion: 1, now: now + 2,
		}));
		expect(lengthened).toMatchObject({ policy: { days: null, version: 2 }, run: null });
		const fence = await env.DB.prepare(
			"SELECT cutoff_at, policy_version FROM retention_fences WHERE project_id = ? AND class = 'source_episodes'",
		).bind(project.projectId).first();
		expect(fence).toMatchObject({ cutoff_at: preview.cutoff_at, policy_version: 1 });
	});

	it("atomically rejects an inventory change between the final hash check and fence installation", async () => {
		const now = Date.now();
		const project = await makeProject("activation-race");
		await insertEpisode(project.memoryOwnerUserId, { createdAt: now - 90 * DAY });
		const preview = await previewRetentionChange(env, scope(project, {
			retentionClass: "source_episodes", days: 30, expectedVersion: 0, now,
		}));

		const database = env.DB;
		let batchCalls = 0;
		const raceEnv = {
			...env,
			DB: {
				prepare: (...args) => database.prepare(...args),
				batch: async (statements) => {
					batchCalls += 1;
					if (batchCalls === 2) {
						await insertEpisode(project.memoryOwnerUserId, { createdAt: now - 89 * DAY });
					}
					return database.batch(statements);
				},
			},
		};
		await expect(activateRetentionPolicy(raceEnv, scope(project, {
			retentionClass: "source_episodes",
			days: 30,
			expectedVersion: 0,
			previewCutoffAt: preview.cutoff_at,
			previewInventoryHash: preview.inventory_hash,
			confirmation: RETENTION_CONFIRMATION,
			now,
		}))).rejects.toMatchObject({ code: "retention_preview_changed", status: 409 });

		expect(await database.prepare(
			"SELECT COUNT(*) AS n FROM retention_policies WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });
		expect(await database.prepare(
			"SELECT COUNT(*) AS n FROM retention_fences WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });
		expect(await database.prepare(
			"SELECT COUNT(*) AS n FROM retention_runs WHERE project_id = ?",
		).bind(project.projectId).first()).toMatchObject({ n: 0 });
	});

	it("never permits security audit shortening", async () => {
		const project = await makeProject("audit-lock");
		await expect(previewRetentionChange(env, scope(project, {
			retentionClass: "security_audit", days: 365, expectedVersion: 0,
		}))).rejects.toBeInstanceOf(RetentionError);
		await expect(previewRetentionChange(env, scope(project, {
			retentionClass: "security_audit", days: 365, expectedVersion: 0,
		}))).rejects.toMatchObject({ code: "retention_class_locked", status: 409 });
	});

	it("executes bounded idempotent batches without crossing project or age boundaries", async () => {
		const now = Date.now();
		const project = await makeProject("execute");
		const foreign = await makeProject("execute-foreign");
		const oldIds = [];
		for (let index = 0; index < 3; index += 1) {
			const id = `delivery_${crypto.randomUUID()}`;
			oldIds.push(id);
			await env.DB.prepare(
				`INSERT INTO webhook_deliveries
				 (id, user_id, webhook_id, event, status, payload_json, created_at, updated_at)
				 VALUES (?, ?, ?, 'memory.added', 'delivered', ?, ?, ?)`,
			).bind(id, project.memoryOwnerUserId, `hook_${crypto.randomUUID()}`, `{"private":${index}}`, now - 60 * DAY, now - 60 * DAY).run();
		}
		const newId = `delivery_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.added', 'delivered', '{}', ?, ?)`,
		).bind(newId, project.memoryOwnerUserId, `hook_${crypto.randomUUID()}`, now, now).run();
		const foreignId = `delivery_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.added', 'delivered', '{}', ?, ?)`,
		).bind(foreignId, foreign.memoryOwnerUserId, `hook_${crypto.randomUUID()}`, now - 60 * DAY, now - 60 * DAY).run();

		const activated = await activate(project, "webhook_deliveries", 30, now);
		const first = await processRetentionRun(env, { runId: activated.run.id, now: now + 1, batchSize: 2 });
		expect(first).toMatchObject({ status: "retry", deleted_this_batch: 2 });
		const second = await processRetentionRun(env, { runId: activated.run.id, now: now + 2, batchSize: 2 });
		expect(second).toMatchObject({ status: "completed", deleted_this_batch: 1 });
		const repeat = await processRetentionRun(env, { runId: activated.run.id, now: now + 3, batchSize: 2 });
		expect(repeat).toMatchObject({ status: "completed", deleted_this_batch: 0 });

		const remainingOld = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM webhook_deliveries
			 WHERE id IN (?, ?, ?)`,
		).bind(...oldIds).first();
		expect(remainingOld.n).toBe(0);
		expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = ?").bind(newId).first()).toBeTruthy();
		expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = ?").bind(foreignId).first()).toBeTruthy();
	});

	it("marks a failed batch retryable and never falsely complete", async () => {
		const now = Date.now();
		const project = await makeProject("retry");
		const deliveryId = `delivery_${crypto.randomUUID()}`;
		const triggerName = `retention_fail_${crypto.randomUUID().replaceAll("-", "")}`;
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.added', 'delivered', '{}', ?, ?)`,
		).bind(deliveryId, project.memoryOwnerUserId, `hook_${crypto.randomUUID()}`, now - 60 * DAY, now - 60 * DAY).run();
		const activated = await activate(project, "webhook_deliveries", 30, now);
		await env.DB.prepare(
			`CREATE TRIGGER ${triggerName} BEFORE DELETE ON webhook_deliveries
			 WHEN old.id = '${deliveryId}' BEGIN SELECT RAISE(ABORT, 'forced retention failure'); END`,
		).run();

		const failed = await processRetentionRun(env, { runId: activated.run.id, now: now + 1, batchSize: 10 });
		expect(failed).toMatchObject({ status: "retry", deleted_this_batch: 0, error_code: "retention_batch_failed" });
		expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = ?").bind(deliveryId).first()).toBeTruthy();
		const runAfterFailure = await env.DB.prepare("SELECT status, completed_at FROM retention_runs WHERE id = ?")
			.bind(activated.run.id).first();
		expect(runAfterFailure).toMatchObject({ status: "retry", completed_at: null });
		expect(await env.DB.prepare(
			`SELECT outcome FROM audit_events
			  WHERE target_id = ? AND action = 'retention.run.batch_applied'
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(activated.run.id).first()).toEqual({ outcome: "failed" });
		expect(await env.DB.prepare(
			`SELECT outcome, reason FROM audit_events
			  WHERE target_id = ? AND action = 'retention.run.retry'
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(activated.run.id).first()).toEqual({ outcome: "failed", reason: "retention_batch_failed" });

		await env.DB.prepare(`DROP TRIGGER ${triggerName}`).run();
		const recovered = await processRetentionRun(env, { runId: activated.run.id, now: now + 2, batchSize: 10 });
		expect(recovered).toMatchObject({ status: "completed", deleted_this_batch: 1 });
	});

	it("fails closed when queue or terminal audit reservation is unavailable and retries without losing a run event", async () => {
		const now = Date.now();
		const project = await makeProject("audit-outage");
		const activated = await activate(project, "export_blobs", 30, now);
		const failing = retentionAuditUnavailableEnv();

		await expect(processRetentionRun(failing, {
			runId: activated.run.id,
			now: now + 1,
		})).rejects.toMatchObject({ code: "audit_unavailable", status: 503 });
		expect(await env.DB.prepare("SELECT status FROM retention_runs WHERE id = ?")
			.bind(activated.run.id).first()).toEqual({ status: "running" });
		const recovered = await processRetentionRun(env, {
			runId: activated.run.id,
			now: now + 10 * 60 * 1000,
		});
		expect(recovered.status).toBe("completed");
		const terminalEvents = await env.DB.prepare(
			`SELECT action, outcome FROM audit_events
			  WHERE project_id = ? AND target_id = ? AND action LIKE 'retention.run.%'
			  ORDER BY created_at ASC`,
		).bind(project.projectId, activated.run.id).all();
		expect(terminalEvents.results).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: "retention.run.retry", outcome: "failed" }),
			expect.objectContaining({ action: "retention.run.completed", outcome: "ok" }),
		]));

		const nextDay = Math.floor((now + DAY) / DAY) * DAY + 60_000;
		const beforeRuns = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM retention_runs WHERE project_id = ? AND mode = 'scheduled'",
		).bind(project.projectId).first();
		const beforeFence = await env.DB.prepare(
			"SELECT cutoff_at, policy_version FROM retention_fences WHERE project_id = ? AND class = 'export_blobs'",
		).bind(project.projectId).first();
		await expect(scheduleRetentionRuns(failing, { now: nextDay, limit: 20 }))
			.rejects.toMatchObject({ code: "audit_unavailable", status: 503 });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM retention_runs WHERE project_id = ? AND mode = 'scheduled'",
		).bind(project.projectId).first()).toEqual(beforeRuns);
		expect(await env.DB.prepare(
			"SELECT cutoff_at, policy_version FROM retention_fences WHERE project_id = ? AND class = 'export_blobs'",
		).bind(project.projectId).first()).toEqual(beforeFence);

		const queued = await scheduleRetentionRuns(env, { now: nextDay, limit: 20 });
		expect(queued.created).toBeGreaterThanOrEqual(1);
		const projectQueued = await env.DB.prepare(
			`SELECT id FROM retention_runs
			  WHERE project_id = ? AND class = 'export_blobs' AND mode = 'scheduled'
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(project.projectId).first();
		expect(projectQueued).toBeTruthy();
		expect(await env.DB.prepare(
			`SELECT outcome, request_id FROM audit_events
			  WHERE project_id = ? AND target_id = ? AND action = 'retention.run.queued'`,
		).bind(project.projectId, projectQueued.id).first()).toMatchObject({
			outcome: "ok",
			request_id: expect.any(String),
		});
	});

	it("keeps fences monotonic and atomically rejects pre-cutoff late writes", async () => {
		const now = Date.now();
		const project = await makeProject("fence");
		const activated = await activate(project, "source_episodes", 30, now);
		const cutoff = activated.run.cutoff_at;
		expect(await retentionFenceAllows(env, {
			projectId: project.projectId, retentionClass: "source_episodes", acceptedAt: cutoff,
		})).toBe(false);
		expect(await retentionFenceAllows(env, {
			projectId: project.projectId, retentionClass: "source_episodes", acceptedAt: cutoff + 1,
		})).toBe(true);

		const lateEpisodeId = `episode_${crypto.randomUUID()}`;
		await expect(env.DB.batch([
			retentionFenceGuardStatement(env, {
				projectId: project.projectId,
				retentionClass: "source_episodes",
				acceptedAt: cutoff,
			}),
			env.DB.prepare(
				`INSERT INTO source_episodes
				 (id, user_id, memory_user_id, owner_user_id, message_id, message_index, role,
				  text, text_hash, observed_at, created_at)
				 VALUES (?, ?, ?, ?, ?, 0, 'user', 'late text', ?, ?, ?)`,
			).bind(
				lateEpisodeId,
				project.memoryOwnerUserId,
				project.memoryOwnerUserId,
				project.memoryOwnerUserId,
				`message_${crypto.randomUUID()}`,
				`hash_${crypto.randomUUID()}`,
				cutoff,
				now + 1,
			),
		])).rejects.toThrow();
		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?").bind(lateEpisodeId).first()).toBeNull();
	});

	it("enforces retention fences inside the real source and semantic write batches", async () => {
		const now = Date.now();
		const project = await makeProject("write-lane-fences");
		const sourcePolicy = await activate(project, "source_episodes", 30, now);
		const semanticPolicy = await activate(project, "semantic_memory", 30, now + 1);
		const sourceToken = `latereplay${crypto.randomUUID().replaceAll("-", "")}`;
		const episode = await writeSourceEpisodes(env, project.memoryOwnerUserId, {
			sourcePacketId: `packet_${crypto.randomUUID()}`,
			memoryUserId: project.memoryOwnerUserId,
			ownerUserId: project.memoryOwnerUserId,
			managedProjectId: project.projectId,
			messages: [{ id: "late-message", role: "user", content: sourceToken }],
			rules: ALLOW_ALL_RULES,
			acceptedAt: sourcePolicy.run.cutoff_at,
			required: true,
		});
		expect(episode).toMatchObject({ ok: false, outcome: "blocked_by_retention", written: 0 });
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_episodes_fts WHERE source_episodes_fts MATCH ?",
		).bind(sourceToken).first()).toMatchObject({ n: 0 });

		const nodeId = `node_${crypto.randomUUID()}`;
		const acceptedAt = semanticPolicy.run.cutoff_at;
		await expect(writeApproved(
			{ ...env, USE_VECTORS: "false" },
			getConfig({ ...env, USE_VECTORS: "false" }),
			project.memoryOwnerUserId,
			{
				newNodes: [{
					id: nodeId,
					user_id: project.memoryOwnerUserId,
					label: "Late semantic replay",
					category: "project",
					role: null,
					state: "active",
					summary: "must not survive retention",
					created_at: now + 2,
					updated_at: now + 2,
				}],
			},
			{
				acceptedAt,
				managedProjectId: project.projectId,
				memoryOwnerUserId: project.memoryOwnerUserId,
			},
		)).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare("SELECT id FROM nodes WHERE id = ?").bind(nodeId).first()).toBeNull();
	});

	it("schedules finite policies once per UTC day, never stacks active runs, and ignores keep-forever", async () => {
		const now = Date.now();
		const finite = await makeProject("scheduled-finite");
		const forever = await makeProject("scheduled-forever");
		const initial = await activate(finite, "export_blobs", 30, now);
		await activateRetentionPolicy(env, scope(forever, {
			retentionClass: "export_blobs", days: null, expectedVersion: 0, now,
		}));
		await processToCompletion(initial.run.id, now);

		const firstAt = Math.floor((now + DAY) / DAY) * DAY + 60_000;
		const first = await scheduleRetentionRuns(env, { now: firstAt, limit: 20 });
		const second = await scheduleRetentionRuns(env, { now: firstAt + 5 * 60_000, limit: 20 });
		expect(first.created).toBeGreaterThanOrEqual(1);
		expect(second.created).toBe(0);
		const firstScheduled = await env.DB.prepare(
			`SELECT id FROM retention_runs
			  WHERE project_id = ? AND class = 'export_blobs' AND mode = 'scheduled'
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(finite.projectId).first();
		expect(firstScheduled).toBeTruthy();
		await processToCompletion(firstScheduled.id, firstAt);
		const nextDay = await scheduleRetentionRuns(env, { now: firstAt + DAY, limit: 20 });
		expect(nextDay.created).toBeGreaterThanOrEqual(1);
		const finiteRuns = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM retention_runs
			 WHERE project_id = ? AND class = 'export_blobs' AND mode = 'scheduled'`,
		).bind(finite.projectId).first();
		const foreverRuns = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM retention_runs
			 WHERE project_id = ? AND class = 'export_blobs' AND mode = 'scheduled'`,
		).bind(forever.projectId).first();
		expect(finiteRuns.n).toBe(2);
		expect(foreverRuns.n).toBe(0);
	});
});
