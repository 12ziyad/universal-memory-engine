import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function graph(userId) {
	const request = new Request(`http://example.com/v1/graph?userId=${userId}`, { headers });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response.json();
}

describe("junk cleanup", () => {
	it("previews first, then archives/suppresses only with confirmation", async () => {
		const userId = "cleanup-junk";
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("junk-node", userId, "want to see a detailed and interactive prototype", "project", "active", now, now),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("good-node", userId, "UML Graph Repair", "project", "active", now, now),
			env.DB.prepare(
				"INSERT INTO candidates (id, user_id, label, strength, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind("junk-candidate", userId, "assistant said the user asked for this chat", "weak", 1, now),
		]);

		const preview = await call("/v1/actions/clean-junk", { userId });
		expect(preview.status).toBe(200);
		expect(preview.body).toMatchObject({ dryRun: true, junkPreviewed: 2, confirmationRequired: "CLEAN JUNK" });
		expect((await graph(userId)).nodes.map((n) => n.id).sort()).toEqual(["good-node", "junk-node"]);

		const confirmed = await call("/v1/actions/clean-junk", { userId, confirm: "CLEAN JUNK" });
		expect(confirmed.status).toBe(200);
		expect(confirmed.body).toMatchObject({ dryRun: false, junkArchived: 1, junkSuppressed: 2 });
		const after = await graph(userId);
		expect(after.nodes.map((n) => n.id)).toEqual(["good-node"]);
		expect(after.candidates).toHaveLength(0);
	});
});

describe("delete all reset", () => {
	it("requires DELETE ALL and removes this user's memory rows", async () => {
		const userId = "cleanup-reset";
		const otherUserId = "cleanup-reset-other";
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("other-reset-node", otherUserId, "Other UML", "project", "active", now, now),
			env.DB.prepare(
				`INSERT INTO memory_pages
				 (id, user_id, source_mode, title, canonical_title, short_summary, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind("other-reset-page", otherUserId, "manual_collect", "Other Page", "other page", "summary", now, now),
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("reset-node", userId, "UML", "project", "active", now, now),
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("reset-slice", userId, "reset-node", "Uses D1", "technical_detail", 1, now),
			env.DB.prepare(
				"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind("reset-event", userId, "reset-node", "started", "Started UML", "ordinary", now, now),
			env.DB.prepare(
				"INSERT INTO edges (id, user_id, from_node, to_node, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind("reset-edge", userId, "reset-node", "reset-node", "related_to", now),
			env.DB.prepare(
				"INSERT INTO candidates (id, user_id, label, strength, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).bind("reset-candidate", userId, "Maybe Thing", "weak", 1, now),
			env.DB.prepare(
				`INSERT INTO memory_pages
				 (id, user_id, source_mode, title, canonical_title, short_summary, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind("reset-page", userId, "manual_collect", "UML Page", "uml page", "summary", now, now),
			env.DB.prepare("INSERT INTO receipts (id, user_id, source, created_at) VALUES (?, ?, ?, ?)").bind(
				"reset-receipt",
				userId,
				"save_memory",
				now,
			),
			env.DB.prepare("INSERT INTO extraction_runs (id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(
				"reset-run",
				userId,
				"wrote",
				now,
				now,
			),
			env.DB.prepare(
				"INSERT INTO memory_suppressions (id, user_id, kind, canonical_key, label, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("reset-suppression", userId, "node", "uml", "UML", "test", now),
			env.DB.prepare("INSERT INTO checkpoints (user_id, last_processed_msg_id, updated_at) VALUES (?, ?, ?)").bind(
				userId,
				"m1",
				now,
			),
		]);

		const rejected = await call("/v1/actions/delete-all", { userId, confirm: "DELETE" });
		expect(rejected.status).toBe(400);
		expect(rejected.body.confirmationRequired).toBe("DELETE ALL");
		expect((await graph(userId)).stats.nodes).toBe(1);

		const deleted = await call("/v1/actions/delete-all", { userId, confirm: "DELETE ALL" });
		expect(deleted.status).toBe(200);
		expect(deleted.body.deleted).toBe(true);
		expect(deleted.body.counts).toMatchObject({ nodes: 1, memory_pages: 1, receipts: 1, extraction_runs: 1 });
		const after = await graph(userId);
		expect(after.stats).toMatchObject({ pages: 0, nodes: 0, slices: 0, events: 0, edges: 0, candidates: 0 });
		const other = await graph(otherUserId);
		expect(other.stats).toMatchObject({ pages: 1, nodes: 1 });
	});
});

describe("graph repair", () => {
	it("repairs hijacked page titles without creating fake edges", async () => {
		const userId = "cleanup-repair";
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO memory_pages
			 (id, user_id, source_mode, title, canonical_title, topic_filter, short_summary, full_markdown,
			  key_points_json, related_concepts_json, created_at, updated_at, cluster)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"repair-page",
				userId,
				"manual_collect",
				"Car Research",
				"car",
				"car examples",
				"UML memory pages and graph UX work.",
				"UML Run 3.2 added memory pages. UML Run 3.3 improved graph UX, Cloudflare, D1, Vectorize and MCP. Car/bike were examples only.",
				JSON.stringify(["UML Run 3.2 memory pages", "Graph UX"]),
				JSON.stringify(["UML", "D1"]),
				now,
				now,
				"preferences_research",
			)
			.run();

		const repaired = await call("/v1/actions/repair-graph", { userId });
		expect(repaired.status).toBe(200);
		expect(repaired.body.titlesRepaired).toBe(1);
		expect(repaired.body.relationBackfillPreview.candidateEdges).toBe(0);
		const row = await env.DB.prepare("SELECT title, cluster FROM memory_pages WHERE id = ? AND user_id = ?")
			.bind("repair-page", userId)
			.first();
		expect(row.title).toBe("UML Run 3.2/3.3 Memory Pages and Graph UX");
		expect(row.cluster).toBe("projects_systems");
	});

	it("repairs high-confidence Microsoft page title/cluster and dedupes evidence", async () => {
		const userId = "cleanup-repair-microsoft";
		const now = Date.now();
		const repeated = {
			source_type: "user_message",
			source_role: "user",
			snippet:
				"Microsoft Recruiting acknowledged my SWE application for Bangalore. My resume has strong projects, but DSA and interview prep are a risk.",
		};
		await env.DB.prepare(
			`INSERT INTO memory_pages
			 (id, user_id, source_mode, title, canonical_title, short_summary, full_markdown,
			  key_points_json, related_concepts_json, evidence_json, created_at, updated_at, cluster)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"repair-ms-page",
				userId,
				"manual_collect",
				"UML Architecture Decisions",
				"uml architecture decisions",
				"Microsoft Recruiting acknowledged the SWE application for Bangalore.",
				"# UML Architecture Decisions\nMicrosoft Recruiting acknowledged the SWE application for Bangalore.\nThe resume has strong projects, but DSA/interview prep is a risk.\n\n## Evidence\n- repeated\n- repeated",
				JSON.stringify([
					"Microsoft Recruiting acknowledged the SWE application for Bangalore.",
					"Resume projects are strong.",
					"DSA and interview prep are the main risk.",
				]),
				JSON.stringify(["Microsoft", "Resume", "DSA"]),
				JSON.stringify([repeated, repeated, { ...repeated, source_type: "assistant_message" }]),
				now,
				now,
				"projects_systems",
			)
			.run();

		const repaired = await call("/v1/actions/repair-graph", { userId });
		expect(repaired.status).toBe(200);
		expect(repaired.body).toMatchObject({
			pagesChecked: 1,
			titlesRepaired: 1,
			clustersRepaired: 1,
			evidenceDeduped: 1,
		});
		const row = await env.DB.prepare("SELECT title, cluster, evidence_json FROM memory_pages WHERE id = ? AND user_id = ?")
			.bind("repair-ms-page", userId)
			.first();
		expect(row.title).toBe("Microsoft SWE Application and Resume Review");
		expect(row.cluster).toBe("career_applications");
		const evidence = JSON.parse(row.evidence_json);
		expect(evidence).toHaveLength(1);
	});
});
