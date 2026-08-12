import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { createConnectionToken } from "../src/auth.js";
import { queryNodeVectors } from "../src/lib/vectorize.js";
import { managedProjectMemoryOwnerId } from "../src/lib/managed_projects.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";
import { findSourceEpisodes } from "../src/pipeline/episodes.js";

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

		const saved = await request("/v1/rules", {
			method: "PUT",
			headers: atlasHeaders,
			body: JSON.stringify({ rules: { customInstructions: "Keep only Atlas architecture decisions." } }),
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
		const at = Date.now();
		await env.DB.batch([
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
		]);

		const result = await deleteAccountCompletely(env, account.body.user.id);
		expect(result.deleted).toBe(true);
		expect(result.memory_spaces).toBeGreaterThanOrEqual(2);
		for (const [table, column, value] of [
			["users", "id", account.body.user.id],
			["managed_projects", "owner_user_id", account.body.user.id],
			["nodes", "user_id", account.body.user.id],
			["nodes", "user_id", atlasOwner],
			["memory_rules", "user_id", atlasOwner],
			["playground_threads", "user_id", atlasOwner],
		]) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first();
			expect(row.n, `${table}.${column}`).toBe(0);
		}
	});
});
