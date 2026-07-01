import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, init = {}) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let body = null;
	try { body = await response.json(); } catch {}
	return { status: response.status, body };
}

async function post(path, body) {
	return call(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function count(table, userId) {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).bind(userId).first();
	return row?.count ?? 0;
}

async function seedNode(userId, id, label, category = "project", extra = {}) {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes
			(id, user_id, label, category, role, state, summary, mention_count, health_state, created_at, updated_at, archived_at, suppressed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			userId,
			label,
			category,
			extra.role ?? null,
			extra.state ?? "active",
			extra.summary ?? null,
			extra.mention_count ?? 1,
			extra.health_state ?? "active",
			now,
			now,
			extra.archived_at ?? null,
			extra.suppressed_at ?? null,
		)
		.run();
}

async function seedPage(userId, id, title, summary = "") {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO memory_pages
			(id, user_id, source_mode, title, canonical_title, short_summary, full_markdown, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, userId, "manual_collect", title, title.toLowerCase(), summary, summary, now, now)
		.run();
}

describe("Run 3.4 full reset", () => {
	it("delete-all-memory requires exact confirmation", async () => {
		const userId = "r34-confirm";
		await seedNode(userId, "r34-confirm-node", "Boxing", "habit");
		const res = await post("/v1/actions/delete-all-memory", { userId, confirm: "DELETE" });
		expect(res.status).toBe(400);
		expect(res.body.deleted).toBe(false);
		expect(await count("nodes", userId)).toBe(1);
	});

	it("delete-all-memory deletes pages, nodes, slices, events, edges, candidates, receipts, runs, suppressions and checkpoints", async () => {
		const userId = "r34-delete-all";
		const now = Date.now();
		await seedNode(userId, "n-all-a", "UML", "project");
		await seedNode(userId, "n-all-b", "D1", "tool");
		await seedPage(userId, "p-all", "UML Architecture", "UML uses D1.");
		await env.DB.batch([
			env.DB.prepare("INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("s-all", userId, "n-all-a", "uses D1", "fact", 1, now),
			env.DB.prepare("INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("e-all", userId, "n-all-a", "built", "Built UML", "ordinary", now, now),
			env.DB.prepare("INSERT INTO edges (id, user_id, from_node, to_node, type, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind("edge-all", userId, "n-all-a", "n-all-b", "uses", now),
			env.DB.prepare("INSERT INTO candidates (id, user_id, label, strength, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind("cand-all", userId, "Rust", "weak", 1, now),
			env.DB.prepare("INSERT INTO receipts (id, user_id, source, outcome, summary, saved_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("receipt-all", userId, "save_memory", "wrote", "Saved", 1, now),
			env.DB.prepare("INSERT INTO extraction_runs (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind("run-all", userId, "completed", now, now),
			env.DB.prepare("INSERT INTO memory_suppressions (id, user_id, kind, canonical_key, label, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("sup-all", userId, "node", "old", "Old", "test", now),
			env.DB.prepare("INSERT INTO checkpoints (user_id, last_processed_msg_id, updated_at) VALUES (?, ?, ?)").bind(userId, "msg-1", now),
		]);

		const res = await post("/v1/actions/delete-all-memory", { userId, confirm: "DELETE ALL" });
		expect(res.status).toBe(200);
		expect(res.body.deleted).toBe(true);
		expect(res.body.counts).toMatchObject({
			memory_pages: 1,
			nodes: 2,
			slices: 1,
			events: 1,
			edges: 1,
			candidates: 1,
			receipts: 1,
			extraction_runs: 1,
			memory_suppressions: 1,
			checkpoints: 1,
		});
		for (const table of ["memory_pages", "nodes", "slices", "events", "edges", "candidates", "receipts", "extraction_runs", "memory_suppressions", "checkpoints"]) {
			expect(await count(table, userId)).toBe(0);
		}
	});
});

describe("Run 3.4 junk cleanup", () => {
	it("cleanup-junk-nodes dry run detects bad sentence-fragment nodes", async () => {
		const userId = "r34-junk-dry";
		await seedNode(userId, "junk-a", "want to see a detailed and interactive prototype", "project");
		await seedNode(userId, "junk-b", "Explore different build paths", "project");
		await seedNode(userId, "good-a", "Universal Memory Engine", "project", { summary: "Durable project" });
		const res = await post("/v1/actions/cleanup-junk-nodes", { userId, dryRun: true });
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.candidates.map((n) => n.id).sort()).toEqual(["junk-a", "junk-b"]);
	});

	it("cleanup-junk-nodes archives and suppresses bad nodes after confirmation", async () => {
		const userId = "r34-junk-clean";
		await seedNode(userId, "junk-clean", "see prototype before launch", "project");
		const res = await post("/v1/actions/cleanup-junk-nodes", { userId, confirm: "CLEAN JUNK" });
		expect(res.status).toBe(200);
		expect(res.body.cleaned).toBe(true);
		expect(res.body.archived).toBe(1);
		const node = await env.DB.prepare("SELECT archived_at, suppressed_at, health_state FROM nodes WHERE id = ? AND user_id = ?").bind("junk-clean", userId).first();
		expect(node.archived_at).toBeTruthy();
		expect(node.suppressed_at).toBeTruthy();
		expect(node.health_state).toBe("junk");
		expect(await count("memory_suppressions", userId)).toBe(1);
	});
});

describe("Run 3.4 cluster graph metadata", () => {
	it("organize-clusters assigns clusters to old nodes and pages and returns counts", async () => {
		const userId = "r34-organize";
		await seedNode(userId, "old-skill-r34", "Machine Learning", "skill");
		await seedPage(userId, "old-page-r34", "UML Architecture Decisions", "UML uses D1 and Vectorize.");
		const res = await post("/v1/actions/organize-clusters", { userId });
		expect(res.status).toBe(200);
		expect(res.body.updated).toBe(2);
		expect(res.body.cluster_counts.skills_tech).toBe(1);
		expect(res.body.cluster_counts.projects_systems).toBe(1);
	});

	it("/v1/graph includes cluster metadata and cluster counts", async () => {
		const userId = "r34-graph-meta";
		await seedNode(userId, "n-graph-meta", "Boxing", "habit");
		await seedPage(userId, "p-graph-meta", "UML Architecture Decisions", "UML uses D1.");
		const res = await call(`/v1/graph?userId=${userId}`, { headers });
		expect(res.status).toBe(200);
		expect(res.body.clusters.length).toBeGreaterThan(0);
		expect(res.body.clusters[0].layout).toHaveProperty("radiusX");
		expect(res.body.cluster_counts.fitness_habits).toBe(1);
		expect(res.body.cluster_counts.projects_systems).toBe(1);
		expect(res.body.stats.cluster_counts).toEqual(res.body.cluster_counts);
	});

	it("clean graph mode hides archived and junk nodes while all mode shows them", async () => {
		const userId = "r34-clean-mode";
		const now = Date.now();
		await seedNode(userId, "clean-active", "Boxing", "habit");
		await seedNode(userId, "clean-archived", "Old Skill", "skill", { archived_at: now });
		await seedNode(userId, "clean-junk", "want to see a detailed prototype", "project", { health_state: "junk" });

		const clean = await call(`/v1/graph?userId=${userId}&mode=clean`, { headers });
		expect(clean.body.nodes.map((n) => n.id)).toEqual(["clean-active"]);
		const all = await call(`/v1/graph?userId=${userId}&mode=all`, { headers });
		expect(all.body.nodes.map((n) => n.id).sort()).toEqual(["clean-active", "clean-archived", "clean-junk"]);
	});
});

describe("Dashboard", () => {
	it("public/index.html inline script parses", () => {
		const html = fs.readFileSync("public/index.html", "utf8");
		const script = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)?.[1];
		expect(script).toBeTruthy();
		expect(() => new Function(script)).not.toThrow();
	});
});
