import {
	env,
	createExecutionContext,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { createConnectionToken } from "../src/auth.js";
import { queryNodeVectors } from "../src/lib/vectorize.js";
import { managedProjectMemoryOwnerId } from "../src/lib/managed_projects.js";
import { newId } from "../src/lib/ids.js";
import { ensureDefaultOrganization } from "../src/lib/organizations.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";
import { findSourceEpisodes, writeSourceEpisodes } from "../src/pipeline/episodes.js";
import { normalizeSourcePacket, storeSourcePacket } from "../src/pipeline/source.js";
import { writeApproved } from "../src/pipeline/write.js";
import { getConfig } from "../src/config.js";
import { createExtractionRun, createMemoryJob, storeReceipt } from "../src/lib/db.js";
import { flushAiMeter } from "../src/lib/ai_meter.js";
import { saveConversation } from "../src/pipeline/manual_collect.js";
import { playgroundTurn } from "../src/pipeline/playground.js";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function cookieFrom(response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function signup(label) {
	const response = await request("/auth/signup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: `${label}-${crypto.randomUUID()}@example.com`,
			password: "correct-horse",
			name: label,
			acceptTerms: true,
		}),
	});
	expect(response.status).toBe(201);
	return { cookie: cookieFrom(response), body: await response.json() };
}

async function createProject(cookie, name = "Atlas") {
	const response = await request("/auth/projects", {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name, description: `${name} memory workspace` }),
	});
	return { response, body: await response.json() };
}

describe("managed projects", () => {
	it("bootstraps one default project and creates a second owned project", async () => {
		const account = await signup("project-bootstrap");
		const listed = await request("/auth/projects", { headers: { cookie: account.cookie } });
		expect(listed.status).toBe(200);
		const before = await listed.json();
		expect(before.projects).toHaveLength(1);
		expect(before.projects[0]).toMatchObject({ name: "Default project", is_default: true, status: "active" });

		const created = await createProject(account.cookie);
		expect(created.response.status).toBe(201);
		expect(created.body.project).toMatchObject({ name: "Atlas", description: "Atlas memory workspace", is_default: false });
		expect(created.body.project.id).toMatch(/^proj_/);

		const after = await (await request("/auth/projects", { headers: { cookie: account.cookie } })).json();
		expect(after.projects.map((project) => project.name)).toEqual(["Default project", "Atlas"]);
	});

	it("binds every new key to the selected project and filters the key inventory", async () => {
		const account = await signup("project-key");
		const { body: created } = await createProject(account.cookie, "Private Atlas");
		const projectId = created.project.id;
		const keyResponse = await request("/auth/tokens", {
			method: "POST",
			headers: {
				cookie: account.cookie,
				"content-type": "application/json",
				"x-itsuki-project": projectId,
			},
			body: JSON.stringify({ type: "api", label: "Atlas SDK" }),
		});
		expect(keyResponse.status).toBe(201);
		const key = await keyResponse.json();
		expect(key.tokenRecord.project_id).toBe(projectId);

		const projectKeys = await (await request("/auth/tokens", {
			headers: { cookie: account.cookie, "x-itsuki-project": projectId },
		})).json();
		expect(projectKeys.tokens.map((token) => token.id)).toContain(key.tokenRecord.id);

		const defaultKeys = await (await request("/auth/tokens", { headers: { cookie: account.cookie } })).json();
		expect(defaultKeys.tokens.map((token) => token.id)).not.toContain(key.tokenRecord.id);
	});

	it("never lets a project-bound token switch projects through a request header", async () => {
		const account = await signup("project-token-guard");
		const atlas = (await createProject(account.cookie, "Atlas")).body.project;
		const beta = (await createProject(account.cookie, "Beta")).body.project;
		const createdKey = await request("/auth/tokens", {
			method: "POST",
			headers: { cookie: account.cookie, "content-type": "application/json", "x-itsuki-project": atlas.id },
			body: JSON.stringify({ type: "api", label: "Atlas only" }),
		});
		const { token } = await createdKey.json();

		const denied = await request("/v1/status", {
			headers: { authorization: `Bearer ${token}`, "x-itsuki-project": beta.id },
		});
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "project_scope_mismatch" });
	});

	it("rejects project ids owned by another account", async () => {
		const mine = await signup("project-owner-a");
		const theirs = await signup("project-owner-b");
		const foreign = (await createProject(theirs.cookie, "Foreign")).body.project;
		const response = await request("/v1/status", {
			headers: { cookie: mine.cookie, "x-itsuki-project": foreign.id },
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ code: "project_not_found" });
	});

	it("partitions graph data while preserving all historical default-project rows", async () => {
		const account = await signup("project-memory-boundary");
		const atlas = (await createProject(account.cookie, "Atlas memory")).body.project;
		const atlasOwner = await managedProjectMemoryOwnerId(account.body.user.id, atlas);
		expect(atlasOwner).not.toBe(account.body.user.id);

		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, 'project', 'active', ?, ?)",
			).bind(`node_${crypto.randomUUID()}`, account.body.user.id, "Historical default memory", Date.now(), Date.now()),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, 'project', 'active', ?, ?)",
			).bind(`node_${crypto.randomUUID()}`, atlasOwner, "Atlas private memory", Date.now(), Date.now()),
		]);

		const defaultGraph = await (await request("/v1/graph", { headers: { cookie: account.cookie } })).json();
		expect(defaultGraph.nodes.map((node) => node.label)).toContain("Historical default memory");
		expect(defaultGraph.nodes.map((node) => node.label)).not.toContain("Atlas private memory");

		const atlasGraph = await (await request("/v1/graph", {
			headers: { cookie: account.cookie, "x-itsuki-project": atlas.id },
		})).json();
		expect(atlasGraph.nodes.map((node) => node.label)).toContain("Atlas private memory");
		expect(atlasGraph.nodes.map((node) => node.label)).not.toContain("Historical default memory");
	});

	it("partitions project rules and playground threads", async () => {
		const account = await signup("project-settings-boundary");
		const atlas = (await createProject(account.cookie, "Atlas settings")).body.project;
		const atlasHeaders = {
			cookie: account.cookie,
			"content-type": "application/json",
			"x-itsuki-project": atlas.id,
		};

		const initialRules = await (await request("/v1/rules", { headers: atlasHeaders })).json();
		const saved = await request("/v1/rules", {
			method: "PUT",
			headers: atlasHeaders,
			body: JSON.stringify({
				expected_version: initialRules.rules_version,
				rules: { customInstructions: "Keep only Atlas architecture decisions." },
			}),
		});
		expect(saved.status).toBe(200);
		const atlasRules = await (await request("/v1/rules", { headers: atlasHeaders })).json();
		const defaultRules = await (await request("/v1/rules", { headers: { cookie: account.cookie } })).json();
		expect(atlasRules.rules.customInstructions).toContain("Atlas architecture");
		expect(defaultRules.rules.customInstructions).toBe("");

		const thread = await request("/v1/playground/thread", {
			method: "POST",
			headers: atlasHeaders,
			body: JSON.stringify({ title: "Atlas-only chat" }),
		});
		expect(thread.status).toBe(200);
		const atlasPlayground = await (await request("/v1/playground", { headers: atlasHeaders })).json();
		const defaultPlayground = await (await request("/v1/playground", { headers: { cookie: account.cookie } })).json();
		expect(atlasPlayground.threads.map((item) => item.title)).toContain("Atlas-only chat");
		expect(defaultPlayground.threads.map((item) => item.title)).not.toContain("Atlas-only chat");
	});

	it("treats pre-migration NULL-project keys as default-only credentials", async () => {
		const account = await signup("project-legacy-key");
		const atlas = (await createProject(account.cookie, "Atlas new")).body.project;
		const legacy = await createConnectionToken(env, account.body.user.id, { type: "api", label: "Historical key" });

		const defaultStatus = await request("/v1/status", {
			headers: { authorization: `Bearer ${legacy.token}` },
		});
		expect(defaultStatus.status).toBe(200);

		const denied = await request("/v1/status", {
			headers: { authorization: `Bearer ${legacy.token}`, "x-itsuki-project": atlas.id },
		});
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "project_scope_mismatch" });
	});

	it("carries the authenticated managed-project boundary through MCP", async () => {
		const account = await signup("project-mcp-boundary");
		const atlas = (await createProject(account.cookie, "Atlas MCP")).body.project;
		const atlasOwner = await managedProjectMemoryOwnerId(account.body.user.id, atlas);
		const createdKey = await request("/auth/tokens", {
			method: "POST",
			headers: {
				cookie: account.cookie,
				"content-type": "application/json",
				"x-itsuki-project": atlas.id,
			},
			body: JSON.stringify({ type: "mcp", label: "Atlas MCP" }),
		});
		const { token } = await createdKey.json();

		const response = await request("/mcp", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "recall_memory", arguments: { query: "Atlas project status" } },
			}),
		});
		expect(response.status).toBe(200);
		const responseText = await response.text();
		expect(responseText).toContain('"structuredContent"');
		const packet = await env.DB.prepare(
			"SELECT user_id, owner_user_id, raw_meta_json FROM source_packets WHERE user_id = ? AND source_mode = 'recall' ORDER BY created_at DESC LIMIT 1",
		).bind(atlasOwner).first();
		expect(packet, responseText).toMatchObject({ user_id: atlasOwner, owner_user_id: atlasOwner });
		expect(JSON.parse(packet.raw_meta_json)).toMatchObject({
			account_user_id: account.body.user.id,
			managed_project_id: atlas.id,
		});
	});

	it("rolls project activity up to the owning account for operators", async () => {
		const account = await signup("project-operator-rollup");
		const atlas = (await createProject(account.cookie, "Atlas operator")).body.project;
		const atlasOwner = await managedProjectMemoryOwnerId(account.body.user.id, atlas);
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(account.body.user.id),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Project rollup node', 'project', 'active', ?, ?)",
			).bind(`node_${crypto.randomUUID()}`, atlasOwner, at, at),
			env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, created_at) VALUES (?, ?, 'save_memory', 'wrote', ?)",
			).bind(`receipt_${crypto.randomUUID()}`, atlasOwner, at),
		]);

		const response = await request("/v1/admin/users?query=project-operator-rollup", {
			headers: { cookie: account.cookie },
		});
		expect(response.status).toBe(200);
		const row = (await response.json()).users.find((user) => user.id === account.body.user.id);
		expect(row).toMatchObject({ nodes: 1, receipts: 1 });
	});

	it("partitions secondary ledgers, source FTS, downloads, and vector namespaces", async () => {
		const account = await signup("project-secondary-boundary");
		const atlas = (await createProject(account.cookie, "Atlas secondary")).body.project;
		const beta = (await createProject(account.cookie, "Beta secondary")).body.project;
		const atlasOwner = await managedProjectMemoryOwnerId(account.body.user.id, atlas);
		const betaOwner = await managedProjectMemoryOwnerId(account.body.user.id, beta);
		const at = Date.now();
		const suffix = crypto.randomUUID();
		const ids = {
			atlas: {
				receipt: `receipt_atlas_${suffix}`,
				job: `job_atlas_${suffix}`,
				export: `export_atlas_${suffix}`,
				hook: `wh_atlas_${suffix}`,
				delivery: `whd_atlas_${suffix}`,
				candidate: `cand_atlas_${suffix}`,
				episode: `episode_atlas_${suffix}`,
			},
			beta: {
				receipt: `receipt_beta_${suffix}`,
				job: `job_beta_${suffix}`,
				export: `export_beta_${suffix}`,
				hook: `wh_beta_${suffix}`,
				delivery: `whd_beta_${suffix}`,
				candidate: `cand_beta_${suffix}`,
				episode: `episode_beta_${suffix}`,
			},
		};
		const inserts = [];
		for (const [label, owner] of [["atlas", atlasOwner], ["beta", betaOwner]]) {
			const row = ids[label];
			inserts.push(
				env.DB.prepare(
					"INSERT INTO receipts (id, user_id, source, outcome, summary, created_at) VALUES (?, ?, 'save_memory', 'wrote', ?, ?)",
				).bind(row.receipt, owner, `${label} receipt`, at),
				env.DB.prepare(
					`INSERT INTO memory_jobs (id, user_id, type, status, receipt_id, payload_json, created_at, updated_at, completed_at)
					 VALUES (?, ?, 'extract', 'completed', ?, '{}', ?, ?, ?)`,
				).bind(row.job, owner, row.receipt, at, at, at),
				env.DB.prepare(
					`INSERT INTO memory_exports (id, user_id, status, format, entity, object_count, size_bytes, data, created_at, completed_at)
					 VALUES (?, ?, 'complete', 'json', 'All memories', 1, 20, ?, ?, ?)`,
				).bind(row.export, owner, JSON.stringify({ project: label }), at, at),
				env.DB.prepare(
					`INSERT INTO webhooks (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
					 VALUES (?, ?, ?, 'https://hooks.example.com/project', 'whsec_test', '["memory.added"]', 1, 'active', ?, ?)`,
				).bind(row.hook, owner, `${label} hook`, at, at),
				env.DB.prepare(
					`INSERT INTO webhook_deliveries (id, user_id, webhook_id, event, status, attempts, payload_json, created_at, updated_at)
					 VALUES (?, ?, ?, 'memory.added', 'delivered', 1, '{}', ?, ?)`,
				).bind(row.delivery, owner, row.hook, at, at),
				env.DB.prepare(
					`INSERT INTO candidates (id, user_id, label, strength, mentions, status, created_at, last_seen_at)
					 VALUES (?, ?, ?, 'strong', 2, 'pending', ?, ?)`,
				).bind(row.candidate, owner, `${label} candidate`, at, at),
				env.DB.prepare(
					`INSERT INTO source_episodes
					 (id, user_id, memory_user_id, owner_user_id, message_id, message_index, role, text, text_hash, observed_at, created_at)
					 VALUES (?, ?, ?, ?, ?, 0, 'user', ?, ?, ?, ?)`,
				).bind(
					row.episode,
					owner,
					owner,
					owner,
					`message_${label}_${suffix}`,
					`isolationcanary ${label}`,
					`hash_${label}_${suffix}`,
					at,
					at,
				),
			);
		}
		await env.DB.batch(inserts);

		const atlasHeaders = { cookie: account.cookie, "x-itsuki-project": atlas.id };
		const own = async (path) => (await request(path, { headers: atlasHeaders })).json();
		const requests = await own("/v1/requests?range=90d");
		const jobs = await own("/v1/jobs");
		const receipts = await own("/v1/receipts");
		const exports = await own("/v1/exports");
		const hooks = await own("/v1/webhooks");
		const deliveries = await own(`/v1/webhooks/${ids.atlas.hook}/deliveries`);
		const foreignDeliveries = await own(`/v1/webhooks/${ids.beta.hook}/deliveries`);
		const candidates = await own("/v1/candidates?status=all");
		expect(requests.requests.map((row) => row.id)).toContain(ids.atlas.receipt);
		expect(requests.requests.map((row) => row.id)).not.toContain(ids.beta.receipt);
		expect(jobs.jobs.map((row) => row.job_id)).toContain(ids.atlas.job);
		expect(jobs.jobs.map((row) => row.job_id)).not.toContain(ids.beta.job);
		expect(receipts.receipts.map((row) => row.id)).toContain(ids.atlas.receipt);
		expect(receipts.receipts.map((row) => row.id)).not.toContain(ids.beta.receipt);
		expect(exports.exports.map((row) => row.id)).toContain(ids.atlas.export);
		expect(exports.exports.map((row) => row.id)).not.toContain(ids.beta.export);
		expect(hooks.webhooks.map((row) => row.id)).toContain(ids.atlas.hook);
		expect(hooks.webhooks.map((row) => row.id)).not.toContain(ids.beta.hook);
		expect(deliveries.deliveries.map((row) => row.id)).toContain(ids.atlas.delivery);
		expect(foreignDeliveries.deliveries).toEqual([]);
		expect(candidates.candidates.map((row) => row.id)).toContain(ids.atlas.candidate);
		expect(candidates.candidates.map((row) => row.id)).not.toContain(ids.beta.candidate);

		const ownDownload = await request(`/v1/exports/download?id=${ids.atlas.export}`, { headers: atlasHeaders });
		expect(ownDownload.status).toBe(200);
		expect(await ownDownload.json()).toEqual({ project: "atlas" });
		const foreignDownload = await request(`/v1/exports/download?id=${ids.beta.export}`, { headers: atlasHeaders });
		expect(foreignDownload.status).toBe(404);

		const atlasEpisodes = await findSourceEpisodes(env, atlasOwner, ["isolationcanary"]);
		const betaEpisodes = await findSourceEpisodes(env, betaOwner, ["isolationcanary"]);
		expect(atlasEpisodes.map((row) => row.id)).toEqual([ids.atlas.episode]);
		expect(betaEpisodes.map((row) => row.id)).toEqual([ids.beta.episode]);

		// A hostile explicit userId is interpreted below the selected project;
		// it can never name another project's internal memory root directly.
		const hostile = await own(`/v1/receipts?userId=${encodeURIComponent(betaOwner)}`);
		expect(hostile.receipts.map((row) => row.id)).not.toContain(ids.beta.receipt);

		const queriedNamespaces = [];
		await queryNodeVectors({
			VECTORIZE: {
				query: async (_values, options) => {
					queriedNamespaces.push(options.namespace);
					return { matches: [] };
				},
			},
		}, { useVectors: true, shortlistSize: 8 }, { userId: atlasOwner, values: [0.1], topK: 4 });
		expect(queriedNamespaces).toEqual([atlasOwner]);

		const keyResponse = await request("/auth/tokens", {
			method: "POST",
			headers: { ...atlasHeaders, "content-type": "application/json" },
			body: JSON.stringify({ type: "api", label: "Atlas secondary key" }),
		});
		const { token } = await keyResponse.json();
		const keyReceipts = await (await request("/v1/receipts", {
			headers: { authorization: `Bearer ${token}` },
		})).json();
		expect(keyReceipts.receipts.map((row) => row.id)).toContain(ids.atlas.receipt);
		expect(keyReceipts.receipts.map((row) => row.id)).not.toContain(ids.beta.receipt);
	});

	it("erases every managed-project memory and configuration space with the account", async () => {
		const account = await signup("project-account-erasure");
		const atlas = (await createProject(account.cookie, "Atlas erasure")).body.project;
		const atlasOwner = await managedProjectMemoryOwnerId(account.body.user.id, atlas);
		const registryOnlyTenant = `mem_${crypto.randomUUID().replaceAll("-", "")}`;
		const registryOnlyNode = `node_${crypto.randomUUID()}`;
		const deletedVectorIds = [];
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			).bind(atlas.id, atlasOwner, registryOnlyTenant, at, at),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Default secret', 'project', 'active', ?, ?)",
			).bind(`node_${crypto.randomUUID()}`, account.body.user.id, at, at),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Atlas secret', 'project', 'active', ?, ?)",
			).bind(`node_${crypto.randomUUID()}`, atlasOwner, at, at),
			env.DB.prepare(
				"INSERT INTO memory_rules (user_id, custom_instructions, created_at, updated_at) VALUES (?, 'Atlas-only rules', ?, ?)",
			).bind(atlasOwner, at, at),
			env.DB.prepare(
				"INSERT INTO playground_threads (id, user_id, title, settings_json, created_at, updated_at) VALUES (?, ?, 'Atlas thread', '{}', ?, ?)",
			).bind(`thread_${crypto.randomUUID()}`, atlasOwner, at, at),
			env.DB.prepare(
				"INSERT INTO error_reports (id, user_id, side, scope, message, created_at) VALUES (?, ?, 'server', 'atlas', 'test', ?)",
			).bind(`err_${crypto.randomUUID()}`, atlasOwner, at),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Registry-only secret', 'project', 'active', ?, ?)",
			).bind(registryOnlyNode, registryOnlyTenant, at, at),
			env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 VALUES (?, 'node', ?, 'registryonlycanary', 'registryonlycanary', '', ?, ?, ?, ?)`,
			).bind(registryOnlyTenant, registryOnlyNode, `hash_${crypto.randomUUID()}`, at, at, at),
			env.DB.prepare(
				"INSERT INTO error_reports (id, user_id, side, scope, message, created_at) VALUES (?, ?, 'server', 'registry', 'test', ?)",
			).bind(`err_${crypto.randomUUID()}`, registryOnlyTenant, at),
		]);

		const result = await deleteAccountCompletely({
			...env,
			USE_VECTORS: "true",
			VECTORIZE: { deleteByIds: async (ids) => { deletedVectorIds.push(...ids); } },
		}, account.body.user.id);
		expect(result.deleted).toBe(true);
		expect(result.memory_spaces).toBeGreaterThanOrEqual(3);
		for (const [table, column, value] of [
			["users", "id", account.body.user.id],
			["managed_projects", "owner_user_id", account.body.user.id],
			["nodes", "user_id", account.body.user.id],
			["nodes", "user_id", atlasOwner],
			["memory_rules", "user_id", atlasOwner],
			["playground_threads", "user_id", atlasOwner],
			["error_reports", "user_id", atlasOwner],
			["nodes", "user_id", registryOnlyTenant],
			["manual_search_profiles", "user_id", registryOnlyTenant],
			["error_reports", "user_id", registryOnlyTenant],
		]) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first();
			expect(row.n, `${table}.${column}`).toBe(0);
		}
		expect(deletedVectorIds).toContain(registryOnlyNode);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH 'registryonlycanary'",
		).first()).n)).toBe(0);
		for (const memoryId of [account.body.user.id, atlasOwner, registryOnlyTenant]) {
			expect(await env.DB.prepare("SELECT user_id, by FROM deletion_barriers WHERE user_id = ?")
				.bind(memoryId).first()).toEqual({ user_id: memoryId, by: "account_delete" });
		}
		expect(await deleteAccountCompletely(env, account.body.user.id)).toMatchObject({
			deleted: false,
			already_deleted: true,
		});
	});

	it("fail-closed resets every root and registered subtenant coordinator, including alarms", async () => {
		const account = await signup("project-account-do-erasure");
		const project = (await createProject(account.cookie, "DO erasure")).body.project;
		const defaultProject = await env.DB.prepare(
			"SELECT id FROM managed_projects WHERE owner_user_id = ? AND is_default = 1 LIMIT 1",
		).bind(account.body.user.id).first();
		const projectOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		const registeredTenant = `mem_${crypto.randomUUID().replaceAll("-", "")}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO project_memory_spaces
			 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
			 VALUES (?, ?, ?, 'active', ?, ?)`,
		).bind(project.id, projectOwner, registeredTenant, now, now).run();

		const coordinators = [
			{ memoryId: account.body.user.id, projectId: defaultProject.id, suffix: "root" },
			{ memoryId: registeredTenant, projectId: project.id, suffix: "tenant" },
		];
		for (const target of coordinators) {
			const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(target.memoryId));
			const accepted = await stub.acceptMessagesOnce(target.memoryId, [{
				id: `message-${target.suffix}`,
				role: "user",
				content: `Private ${target.suffix} coordinator state must be erased permanently.`,
				ts: now,
			}], {
				handoffId: `handoff-do-erasure-${target.suffix}`,
				requestHash: (target.suffix === "root" ? "a" : "b").repeat(64),
				scopeKey: `project:${target.projectId}`,
				overrides: { meta: {
					account_user_id: account.body.user.id,
					managed_project_id: target.projectId,
				} },
			});
			expect(accepted.held).toBeGreaterThan(0);
			await runInDurableObject(stub, async (_instance, state) => {
				await state.storage.setAlarm(now + 60_000);
				expect(await state.storage.getAlarm()).not.toBeNull();
			});
		}

		const erased = await deleteAccountCompletely(env, account.body.user.id);
		expect(erased).toMatchObject({ deleted: true });
		expect(erased.memory_spaces).toBeGreaterThanOrEqual(3);
		expect(await env.DB.prepare(
			"SELECT user_id FROM account_erasure_tombstones WHERE user_id = ?",
		).bind(account.body.user.id).first()).toEqual({ user_id: account.body.user.id });

		for (const target of coordinators) {
			const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(target.memoryId));
			expect(await stub.getDebugState()).toMatchObject({
				heldSize: 0,
				queuedEntries: 0,
				queuedMessages: 0,
			});
			await runInDurableObject(stub, async (_instance, state) => {
				expect(await state.storage.getAlarm()).toBeNull();
				expect((await state.storage.list()).size).toBe(0);
			});
			expect(await runDurableObjectAlarm(stub)).toBe(false);
			await expect(runInDurableObject(stub, (instance) => instance.enqueueMcpJobOnce(target.memoryId, {
				jobId: `job-after-erasure-${target.suffix}`,
				sourceMeta: {
					account_user_id: account.body.user.id,
					managed_project_id: target.projectId,
					source_content_hash: "c".repeat(64),
				},
			}, {
				handoffId: `job-after-erasure-${target.suffix}`,
				contentHash: "c".repeat(64),
			}))).rejects.toThrow(/no longer writable/i);
			expect(await stub.getDebugState()).toMatchObject({ heldSize: 0, queuedEntries: 0 });
		}
	});

	it("purges an MCP handoff when account quiescence wins after the local enqueue", async () => {
		const account = await signup("project-account-do-enqueue-race");
		const project = (await createProject(account.cookie, "DO enqueue race")).body.project;
		const memoryOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(memoryOwner));
		const now = Date.now();

		await expect(runInDurableObject(stub, (instance) => instance.enqueueMcpJobOnce(memoryOwner, {
			jobId: "job-do-quiescence-race",
			sourceMeta: {
				account_user_id: account.body.user.id,
				managed_project_id: project.id,
				source_content_hash: "d".repeat(64),
			},
		}, {
			handoffId: "job-do-quiescence-race",
			contentHash: "d".repeat(64),
			_testAfterLocalEnqueue: async () => {
				await env.DB.batch([
					env.DB.prepare(
						"INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)",
					).bind(account.body.user.id, now),
					env.DB.prepare(
						"UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?",
					).bind(now, now, project.id),
				]);
			},
		}))).rejects.toThrow(/no longer writable/i);

		expect(await stub.getDebugState()).toMatchObject({
			heldSize: 0,
			queuedEntries: 0,
			queuedMessages: 0,
		});
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeNull();
			expect((await state.storage.list()).size).toBe(0);
		});
	});

	it("makes project quiescence a commit guard for a request that already passed authorization", async () => {
		const account = await signup("project-quiescence-race");
		const project = (await createProject(account.cookie, "Quiescence race")).body.project;
		const memoryOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		const lateTenant = `mem_${crypto.randomUUID().replaceAll("-", "")}`;
		const acceptedAt = Date.now();
		const normalized = await normalizeSourcePacket(lateTenant, {
			type: "message",
			sourceMode: "quiescence_test",
			content: "late commit canary",
			messageId: "late-message",
			scope: {
				memoryUserId: lateTenant,
				ownerUserId: memoryOwner,
				accountUserId: account.body.user.id,
				managedProjectId: project.id,
			},
		});
		// This is the deterministic pause: project resolution and packet shaping
		// have completed, but no durable acceptance has happened yet.
		await env.DB.prepare(
			"UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?",
		).bind(acceptedAt + 1, acceptedAt + 1, project.id).run();

		await expect(storeSourcePacket(env, normalized.packet, { immutableIdempotency: true }))
			.rejects.toThrow(/fence_guard|violation IS NULL/i);
		const episode = await writeSourceEpisodes(env, lateTenant, {
			sourcePacketId: `late-packet-${crypto.randomUUID()}`,
			messages: normalized.messages,
			rules: { customInstructions: "", includes: [], excludes: [] },
			managedProjectId: project.id,
			memoryUserId: lateTenant,
			ownerUserId: memoryOwner,
			acceptedAt,
			required: true,
		});
		expect(episode).toMatchObject({ ok: false, outcome: "write_failed", written: 0 });
		const nodeId = newId("node");
		await expect(writeApproved(env, getConfig(env), lateTenant, {
			newNodes: [{
				id: nodeId,
				user_id: lateTenant,
				label: "Late node",
				category: "project",
				role: null,
				state: "active",
				summary: null,
				created_at: acceptedAt,
				updated_at: acceptedAt,
			}],
		}, {
			managedProjectId: project.id,
			memoryOwnerUserId: memoryOwner,
			acceptedAt,
		})).rejects.toThrow(/fence_guard|violation IS NULL/i);

		for (const [table, column] of [
			["source_packets", "user_id"],
			["source_episodes", "user_id"],
			["nodes", "user_id"],
			["project_memory_spaces", "memory_user_id"],
		]) {
			expect(Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
				.bind(lateTenant).first()).n), table).toBe(0);
		}
	});

	it("makes a fresh write capability a commit guard after member downgrade or removal", async () => {
		const owner = await signup("project-write-race-owner");
		const member = await signup("project-write-race-member");
		const project = (await createProject(owner.cookie, "Write capability race")).body.project;
		const organization = await ensureDefaultOrganization(env, owner.body.user.id);
		const memoryOwner = await managedProjectMemoryOwnerId(owner.body.user.id, project);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), organization.id, member.body.user.id, owner.body.user.id, now, now),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("prjm"), project.id, organization.id, member.body.user.id, owner.body.user.id, now, now),
		]);

		const acceptedPacket = async (suffix) => (await normalizeSourcePacket(memoryOwner, {
			type: "message",
			sourceMode: "sdk",
			content: `Already-authorized managed write ${suffix}.`,
			messageId: `write-race-${suffix}`,
			scope: {
				memoryUserId: memoryOwner,
				ownerUserId: memoryOwner,
				accountUserId: member.body.user.id,
				managedProjectId: project.id,
				externalUserId: member.body.user.id,
			},
		})).packet;

		// The packet is shaped after request authorization. A different session
		// downgrades the actor before its durable source acceptance.
		const beforeDowngrade = await acceptedPacket("downgrade");
		await env.DB.prepare(
			"UPDATE project_members SET role = 'viewer', updated_at = ? WHERE project_id = ? AND user_id = ?",
		).bind(now + 1, project.id, member.body.user.id).run();
		await expect(storeSourcePacket(env, beforeDowngrade, { immutableIdempotency: true }))
			.rejects.toThrow(/fence_guard|violation IS NULL/i);

		await env.DB.prepare(
			"UPDATE project_members SET role = 'member', updated_at = ? WHERE project_id = ? AND user_id = ?",
		).bind(now + 2, project.id, member.body.user.id).run();
		const beforeRemoval = await acceptedPacket("removal");
		await env.DB.prepare(
			"DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
		).bind(project.id, member.body.user.id).run();
		await expect(storeSourcePacket(env, beforeRemoval, { immutableIdempotency: true }))
			.rejects.toThrow(/fence_guard|violation IS NULL/i);

		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ? AND managed_project_id = ?",
		).bind(memoryOwner, project.id).first()).n)).toBe(0);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_memory_spaces WHERE project_id = ?",
		).bind(project.id).first()).n)).toBe(0);
	});

	it("lets a viewer persist only content-free recall bookkeeping under the read fence", async () => {
		const owner = await signup("project-recall-owner");
		const viewer = await signup("project-recall-viewer");
		const project = (await createProject(owner.cookie, "Viewer recall")).body.project;
		const organization = await ensureDefaultOrganization(env, owner.body.user.id);
		const memoryOwner = await managedProjectMemoryOwnerId(owner.body.user.id, project);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(newId("orgm"), organization.id, viewer.body.user.id, owner.body.user.id, now, now),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
			).bind(newId("prjm"), project.id, organization.id, viewer.body.user.id, owner.body.user.id, now, now),
		]);

		const response = await request("/v1/recall", {
			method: "POST",
			headers: {
				cookie: viewer.cookie,
				"content-type": "application/json",
				"x-itsuki-project": project.id,
			},
			body: JSON.stringify({ query: "What is already known about this project?" }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ ok: true, source: "recall" });
		const packet = await env.DB.prepare(
			`SELECT content_preview, message_count, raw_meta_json
			   FROM source_packets WHERE id = ? AND user_id = ?`,
		).bind(body.source_packet_id, memoryOwner).first();
		expect(packet).toMatchObject({ content_preview: null, message_count: 0 });
		expect(JSON.parse(packet.raw_meta_json)).toMatchObject({ query_content_free: true });
		expect(await env.DB.prepare(
			"SELECT id FROM receipts WHERE id = ? AND user_id = ?",
		).bind(body.receipt_id, memoryOwner).first()).toEqual({ id: body.receipt_id });
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?",
		).bind(memoryOwner).first()).n)).toBe(0);
	});

	it("blocks late receipts, metering and pass-two jobs after project quiescence", async () => {
		const account = await signup("project-late-operational-writes");
		const project = (await createProject(account.cookie, "Late operational writes")).body.project;
		const now = Date.now();
		const scopeJson = JSON.stringify({
			account_user_id: account.body.user.id,
			managed_project_id: project.id,
		});

		// Deterministic pause: the semantic/content work may already have finished,
		// then erasure quiesces the project before late operational bookkeeping.
		await env.DB.batch([
			env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
				.bind(account.body.user.id, now),
			env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(account.body.user.id),
			env.DB.prepare("UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
				.bind(now, now, project.id),
		]);

		const receiptId = `receipt_late_${crypto.randomUUID()}`;
		await expect(createExtractionRun(env, account.body.user.id, {
			id: `run_late_${crypto.randomUUID()}`,
			toolName: "late-test",
			scopeJson,
		})).rejects.toThrow(/fence_guard|violation IS NULL/i);
		await expect(storeReceipt(env, account.body.user.id, "race", {
			id: receiptId,
			outcome: "wrote",
			scope_json: scopeJson,
		}, "must not resurrect", { strict: true })).rejects.toThrow(/fence_guard|violation IS NULL/i);
		const jobId = await createMemoryJob(env, account.body.user.id, {
			id: `job_late_${crypto.randomUUID()}`,
			type: "pass2_rollup",
			idempotencyKey: `pass2-late-${crypto.randomUUID()}`,
			accountUserId: account.body.user.id,
			managedProjectId: project.id,
		});
		expect(jobId).toBeNull();
		await flushAiMeter(env, account.body.user.id, {
			scope: "recall",
			scopeId: `late_${crypto.randomUUID()}`,
			calls: [{
				model: "test-model", task: "recall", input_tokens: 1, output_tokens: 1,
				total_tokens: 2, neurons: null, duration_ms: 1, ok: true, raw_usage: null,
			}],
		}, { accountUserId: account.body.user.id, managedProjectId: project.id });

		for (const [table, column, value] of [
			["extraction_runs", "user_id", account.body.user.id],
			["receipts", "id", receiptId],
			["memory_jobs", "user_id", account.body.user.id],
			["ai_calls", "user_id", account.body.user.id],
		]) {
			expect(Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
				.bind(value).first()).n), table).toBe(0);
		}
	});

	it("does not persist an early MCP refusal after the managed account is quiesced", async () => {
		const account = await signup("project-mcp-early-receipt-race");
		const project = (await createProject(account.cookie, "MCP early receipt race")).body.project;
		const memoryOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
				.bind(account.body.user.id, now),
			env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(account.body.user.id),
			env.DB.prepare("UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
				.bind(now, now, project.id),
		]);

		const result = await stageMcpConversation(env, null, memoryOwner, {
			messages: Array.from({ length: 201 }, (_, index) => ({
				id: `oversized-${index}`,
				role: "user",
				content: `Durable oversized message ${index}.`,
			})),
			memoryScope: {
				memoryUserId: memoryOwner,
				ownerUserId: memoryOwner,
				accountUserId: account.body.user.id,
				managedProjectId: project.id,
			},
		});
		expect(result).toMatchObject({ ok: false, error: "too_large", receipt_id: null });
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM receipts WHERE user_id = ?",
		).bind(memoryOwner).first()).n)).toBe(0);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ?",
		).bind(memoryOwner).first()).n)).toBe(0);
	});

	it("keeps managed projects out of the deprecated unguarded digest-page lane", async () => {
		const account = await signup("project-manual-collect-closed");
		const project = (await createProject(account.cookie, "Guarded conversations")).body.project;
		const memoryOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		await expect(saveConversation(env, null, memoryOwner, [{
			id: "managed-manual-message",
			role: "user",
			content: "This must use the guarded conversation engine.",
			ts: Date.now(),
		}], {
			digestResponse: "This deprecated digest must never persist.",
			memoryScope: {
				memoryUserId: memoryOwner,
				ownerUserId: memoryOwner,
				accountUserId: account.body.user.id,
				managedProjectId: project.id,
			},
		})).rejects.toMatchObject({ code: "managed_manual_collect_disabled", status: 409 });
		for (const table of ["source_packets", "memory_pages", "memory_jobs", "receipts"]) {
			expect(Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
				.bind(memoryOwner).first()).n), table).toBe(0);
		}
	});

	it("cannot resurrect a Playground transcript after account erasure wins mid-turn", async () => {
		const account = await signup("project-playground-race");
		const project = (await createProject(account.cookie, "Playground erasure race")).body.project;
		const memoryOwner = await managedProjectMemoryOwnerId(account.body.user.id, project);
		const now = Date.now();
		await expect(playgroundTurn(env, null, memoryOwner, {
			message: "A private message that must not return after deletion.",
			accountUserId: account.body.user.id,
			managedProjectId: project.id,
			_testAfterUserMessage: async () => {
				await env.DB.batch([
					env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
						.bind(account.body.user.id, now),
					env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(account.body.user.id),
					env.DB.prepare("UPDATE managed_projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
						.bind(now, now, project.id),
					env.DB.prepare("DELETE FROM playground_messages WHERE user_id = ?").bind(memoryOwner),
					env.DB.prepare("DELETE FROM playground_threads WHERE user_id = ?").bind(memoryOwner),
				]);
			},
		})).rejects.toThrow(/fence_guard|violation IS NULL/i);
		for (const table of ["playground_threads", "playground_messages", "source_packets", "receipts"]) {
			expect(Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
				.bind(memoryOwner).first()).n), table).toBe(0);
		}
	});

	it("requires explicit organization transfer before any shared-owner erasure mutation", async () => {
		const owner = await signup("shared-owner-erasure");
		const collaborator = await signup("shared-owner-collaborator");
		const project = (await createProject(owner.cookie, "Shared erasure guard")).body.project;
		const org = await ensureDefaultOrganization(env, owner.body.user.id);
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(`orgm_${crypto.randomUUID()}`, org.id, collaborator.body.user.id, owner.body.user.id, at, at).run();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Transfer guard secret', 'project', 'active', ?, ?)",
		).bind(`node_${crypto.randomUUID()}`, owner.body.user.id, at, at).run();

		await expect(deleteAccountCompletely(env, owner.body.user.id)).rejects.toMatchObject({
			code: "organization_transfer_required",
			status: 409,
		});
		expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner.body.user.id).first())
			.toMatchObject({ id: owner.body.user.id });
		expect(await env.DB.prepare("SELECT id FROM nodes WHERE user_id = ?").bind(owner.body.user.id).first())
			.not.toBeNull();
		expect(await env.DB.prepare("SELECT id FROM managed_projects WHERE id = ?").bind(project.id).first())
			.not.toBeNull();
	});

	it("erases invitation email outbox copies addressed to an account in another organization", async () => {
		const owner = await signup("foreign-invite-owner");
		const target = await signup("foreign-invite-target");
		const org = await ensureDefaultOrganization(env, owner.body.user.id);
		const at = Date.now();
		const invitationId = `inv_${crypto.randomUUID()}`;
		const outboxId = `invmail_${crypto.randomUUID()}`;
		const targetEmail = target.body.user.email.toLowerCase();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_invitations
				 (id, org_id, email_normalized, org_role, token_hash, status, invited_by_user_id,
				  expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, 'pending', ?, ?, ?, ?)`,
			).bind(invitationId, org.id, targetEmail, `hash_${crypto.randomUUID()}`, owner.body.user.id, at + 60_000, at, at),
			env.DB.prepare(
				`INSERT INTO invitation_email_outbox
				 (id, invitation_id, org_id, recipient_email, payload_ciphertext, payload_iv,
				  status, attempts, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'ciphertext', 'iv', 'queued', 0, ?, ?)`,
			).bind(outboxId, invitationId, org.id, targetEmail, at, at),
		]);

		expect((await deleteAccountCompletely(env, target.body.user.id)).deleted).toBe(true);
		expect(await env.DB.prepare("SELECT id FROM organization_invitations WHERE id = ?")
			.bind(invitationId).first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM invitation_email_outbox WHERE id = ?")
			.bind(outboxId).first()).toBeNull();
		expect(await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(org.id).first())
			.toMatchObject({ id: org.id });
	});

	it("anonymizes every deleted-user actor reference while preserving foreign tenant resources", async () => {
		const owner = await signup("foreign-provenance-owner");
		const target = await signup("foreign-provenance-target");
		const colleague = await signup("foreign-provenance-colleague");
		const project = (await createProject(owner.cookie, "Foreign provenance")).body.project;
		const org = await ensureDefaultOrganization(env, owner.body.user.id);
		const storedProject = await env.DB.prepare(
			"SELECT memory_owner_user_id FROM managed_projects WHERE id = ?",
		).bind(project.id).first();
		const at = Date.now();
		const ids = {
			orgMember: `orgm_${crypto.randomUUID()}`,
			projectMember: `prjm_${crypto.randomUUID()}`,
			category: `cat_${crypto.randomUUID()}`,
			invitation: `inv_${crypto.randomUUID()}`,
			retentionRun: `retrun_${crypto.randomUUID()}`,
		};
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(ids.orgMember, org.id, colleague.body.user.id, target.body.user.id, at, at),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'viewer', ?, ?, ?)`,
			).bind(ids.projectMember, project.id, org.id, colleague.body.user.id, target.body.user.id, at, at),
			env.DB.prepare(
				`INSERT INTO project_categories
				 (id, project_id, memory_owner_user_id, slug, name, description, status,
				  created_by_user_id, updated_by_user_id, created_at, updated_at, color_token)
				 VALUES (?, ?, ?, 'foreign_provenance', 'Foreign provenance', NULL, 'active', ?, ?, ?, ?, 'teal')`,
			).bind(
				ids.category, project.id, storedProject.memory_owner_user_id,
				target.body.user.id, target.body.user.id, at, at,
			),
			env.DB.prepare(
				`INSERT INTO organization_invitations
				 (id, org_id, project_id, email_normalized, org_role, project_role, token_hash,
				  status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'member', 'viewer', ?, 'accepted', ?, ?, ?, ?, ?, ?)`,
			).bind(
				ids.invitation, org.id, project.id, colleague.body.user.email.toLowerCase(),
				`hash_${crypto.randomUUID()}`, target.body.user.id, target.body.user.id,
				at + 60_000, at, at, at,
			),
			env.DB.prepare(
				`INSERT INTO retention_policies
				 (project_id, memory_owner_user_id, class, days, version, effective_at,
				  updated_by_user_id, created_at, updated_at)
				 VALUES (?, ?, 'export_blobs', 30, 1, ?, ?, ?, ?)`,
			).bind(project.id, storedProject.memory_owner_user_id, at, target.body.user.id, at, at),
			env.DB.prepare(
				`INSERT INTO retention_runs
				 (id, project_id, memory_owner_user_id, class, policy_version, mode, status,
				  inventory_json, checkpoint_json, deleted_json, attempts, actor_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'export_blobs', 1, 'preview', 'completed', '{}', '{}', '{}', 0, ?, ?, ?)`,
			).bind(ids.retentionRun, project.id, storedProject.memory_owner_user_id, target.body.user.id, at, at),
		]);

		expect((await deleteAccountCompletely(env, target.body.user.id)).deleted).toBe(true);
		expect(await env.DB.prepare(
			"SELECT invited_by_user_id FROM organization_members WHERE id = ?",
		).bind(ids.orgMember).first()).toEqual({ invited_by_user_id: null });
		expect(await env.DB.prepare(
			"SELECT invited_by_user_id FROM project_members WHERE id = ?",
		).bind(ids.projectMember).first()).toEqual({ invited_by_user_id: null });
		expect(await env.DB.prepare(
			"SELECT created_by_user_id, updated_by_user_id FROM project_categories WHERE id = ?",
		).bind(ids.category).first()).toEqual({ created_by_user_id: null, updated_by_user_id: null });
		expect(await env.DB.prepare(
			"SELECT invited_by_user_id, accepted_by_user_id FROM organization_invitations WHERE id = ?",
		).bind(ids.invitation).first()).toEqual({ invited_by_user_id: "deleted_user", accepted_by_user_id: null });
		expect(await env.DB.prepare(
			"SELECT updated_by_user_id FROM retention_policies WHERE project_id = ? AND class = 'export_blobs'",
		).bind(project.id).first()).toEqual({ updated_by_user_id: null });
		expect(await env.DB.prepare(
			"SELECT actor_user_id FROM retention_runs WHERE id = ?",
		).bind(ids.retentionRun).first()).toEqual({ actor_user_id: null });

		for (const [table, column] of [
			["organization_members", "invited_by_user_id"],
			["project_members", "invited_by_user_id"],
			["project_categories", "created_by_user_id"],
			["project_categories", "updated_by_user_id"],
			["organization_invitations", "invited_by_user_id"],
			["organization_invitations", "accepted_by_user_id"],
			["retention_policies", "updated_by_user_id"],
			["retention_runs", "actor_user_id"],
		]) {
			const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
				.bind(target.body.user.id).first();
			expect(Number(count.n), `${table}.${column}`).toBe(0);
		}
		expect(await env.DB.prepare("SELECT id FROM managed_projects WHERE id = ?").bind(project.id).first())
			.toEqual({ id: project.id });
		expect(await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(org.id).first())
			.toEqual({ id: org.id });
	});

	it("fails closed when required security-row erasure fails, then remains retryable", async () => {
		const account = await signup("required-security-erasure");
		const quiescedProject = (await createProject(account.cookie, "Cleanup guard")).body.project;
		const userId = account.body.user.id;
		const email = account.body.user.email.toLowerCase();
		const at = Date.now();
		const ids = {
			session: `sess_${crypto.randomUUID()}`,
			token: `tok_${crypto.randomUUID()}`,
			loginByUser: `login_${crypto.randomUUID()}`,
			loginByEmail: `login_${crypto.randomUUID()}`,
			error: `err_${crypto.randomUUID()}`,
		};
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO sessions (id, user_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
			).bind(ids.session, userId, `hash_${crypto.randomUUID()}`, at, at + 60_000),
			env.DB.prepare(
				`INSERT INTO connection_tokens
				 (id, user_id, label, token_hash, created_at, scopes_json, status)
				 VALUES (?, ?, 'cleanup-test', ?, ?, '[]', 'active')`,
			).bind(ids.token, userId, `hash_${crypto.randomUUID()}`, at),
			env.DB.prepare(
				"INSERT INTO login_events (id, user_id, email_normalized, outcome, created_at) VALUES (?, ?, ?, 'success', ?)",
			).bind(ids.loginByUser, userId, email, at),
			env.DB.prepare(
				"INSERT INTO login_events (id, user_id, email_normalized, outcome, created_at) VALUES (?, NULL, ?, 'failed', ?)",
			).bind(ids.loginByEmail, email, at),
			env.DB.prepare(
				"INSERT INTO error_reports (id, user_id, side, scope, message, created_at) VALUES (?, ?, 'server', 'cleanup-test', 'test', ?)",
			).bind(ids.error, userId, at),
		]);
		await env.DB.prepare(
			`CREATE TRIGGER fail_required_security_erasure
			 BEFORE DELETE ON error_reports
			 WHEN OLD.user_id = '${userId.replaceAll("'", "''")}'
			 BEGIN SELECT RAISE(ABORT, 'forced security erasure failure'); END`,
		).run();

		await expect(deleteAccountCompletely(env, userId)).rejects.toThrow(/forced security erasure failure/i);
		expect(await env.DB.prepare("SELECT id, status FROM users WHERE id = ?").bind(userId).first())
			.toMatchObject({ id: userId, status: "disabled" });
		expect(await env.DB.prepare("SELECT status FROM managed_projects WHERE id = ?")
			.bind(quiescedProject.id).first()).toEqual({ status: "archived" });
		expect(await env.DB.prepare("SELECT user_id, by FROM deletion_barriers WHERE user_id = ?")
			.bind(userId).first()).toEqual({ user_id: userId, by: "account_delete" });
		for (const [table, id] of [
			["sessions", ids.session],
			["connection_tokens", ids.token],
			["login_events", ids.loginByUser],
			["login_events", ids.loginByEmail],
			["error_reports", ids.error],
		]) {
			expect(await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(), `${table}:${id}`)
				.not.toBeNull();
		}

		await env.DB.prepare("DROP TRIGGER fail_required_security_erasure").run();
		expect((await deleteAccountCompletely(env, userId)).deleted).toBe(true);
		expect(await env.DB.prepare("SELECT user_id, by FROM deletion_barriers WHERE user_id = ?")
			.bind(userId).first()).toEqual({ user_id: userId, by: "account_delete" });
		for (const [table, id] of [
			["sessions", ids.session],
			["connection_tokens", ids.token],
			["login_events", ids.loginByUser],
			["login_events", ids.loginByEmail],
			["error_reports", ids.error],
		]) {
			expect(await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(), `${table}:${id}`)
				.toBeNull();
		}
	});
});
