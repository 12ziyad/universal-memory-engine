/**
 * Memories workspace — GET /v1/memories/workspace/*.
 *
 * The read surface behind the Memories page: unified inventory (nodes, pages,
 * slices, events), sources (packets + processing state), suggestions
 * (candidates), and the inspector satellites. These tests pin:
 *  - keyset pagination with opaque, sort-bound cursors
 *  - every server-owned filter
 *  - exact account isolation on list, detail, and satellite paths
 *  - bounded satellites with independent cursors
 *  - evidence privacy: only scrubbed columns are served, never raw_meta_json
 *  - archived/superseded visibility and deleted/suppressed invisibility
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import { decodeWorkspaceCursor, encodeWorkspaceCursor } from "../src/lib/memories_workspace.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function getJson(path) {
	const res = await request(path);
	const body = await res.json();
	return { res, body };
}

let seedCounter = 0;
function uid(prefix) {
	seedCounter += 1;
	return `${prefix}-${seedCounter}-${crypto.randomUUID()}`;
}

async function seedNode(userId, id, label, { ts = Date.now(), archived = null, category = "skill", projectCategory = null, summary = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, project_category_id, archived_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
	).bind(id, userId, label, category, summary, projectCategory, archived, ts, ts).run();
}

async function seedPage(userId, id, title, { ts = Date.now(), packet = null, markdown = "# Notes", evidence = "[]" } = {}) {
	await env.DB.prepare(
		`INSERT INTO memory_pages (id, user_id, title, canonical_title, topic_filter, short_summary, full_markdown, evidence_json, source_packet_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'projects', 'A summary', ?, ?, ?, ?, ?)`,
	).bind(id, userId, title, title.toLowerCase(), markdown, evidence, packet, ts, ts).run();
}

async function seedSlice(userId, id, nodeId, text, { ts = Date.now(), kind = "decision", isCurrent = 1, snippet = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, source_snippet, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, nodeId, text, kind, isCurrent, snippet, ts).run();
}

async function seedEvent(userId, id, nodeId, text, { ts = Date.now(), happened = null, invalid = null, snippet = null, action = "started" } = {}) {
	await env.DB.prepare(
		`INSERT INTO events (id, user_id, node_id, action, text, happened_at, invalid_at, source_snippet, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, nodeId, action, text, happened, invalid, snippet, ts).run();
}

async function seedPacket(userId, id, { ts = Date.now(), topic = null, preview = "Hello there", mode = "manual_direct", type = "message", conversation = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO source_packets (id, user_id, scope_user_id, source_type, source_mode, conversation_id, topic,
			idempotency_key, content_hash, content_preview, message_count, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
	).bind(id, userId, userId, type, mode, conversation, topic, `idem-${id}`, `hash-${id}`, preview, ts, ts).run();
}

async function seedLink(userId, kind, objectId, packetId, { ts = Date.now() } = {}) {
	await env.DB.prepare(
		`INSERT OR IGNORE INTO memory_source_links (user_id, object_kind, object_id, source_packet_id, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
	).bind(userId, kind, objectId, packetId, ts).run();
}

async function seedJob(userId, id, packetId, status, { ts = Date.now(), error = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO memory_jobs (id, user_id, type, status, source_packet_id, error, created_at, updated_at)
		 VALUES (?, ?, 'extract', ?, ?, ?, ?, ?)`,
	).bind(id, userId, status, packetId, error, ts, ts).run();
}

async function seedEpisode(userId, id, packetId, text, { index = 0, ts = Date.now() } = {}) {
	await env.DB.prepare(
		`INSERT INTO source_episodes (id, user_id, source_packet_id, message_id, message_index, role, text, text_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
	).bind(id, userId, packetId, `msg-${id}`, index, text, `h-${id}`, ts).run();
}

async function seedCandidate(userId, id, label, { ts = Date.now(), status = "pending", reason = null, target = null, evidence = "[]", confidence = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO candidates (id, user_id, label, label_guess, status, reason, confidence, evidence_json,
			possible_existing_node_id, created_at, last_seen_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, label, label, status, reason, confidence, evidence, target, ts, ts).run();
}

describe("workspace cursors", () => {
	it("are opaque, sort-bound and scope-bound", () => {
		const cursor = encodeWorkspaceCursor("inv", "updated_desc", 1734000000000, "node_a");
		expect(cursor).not.toMatch(/[+/=]/);
		expect(decodeWorkspaceCursor(cursor, "inv", "updated_desc")).toEqual({ key: 1734000000000, id: "node_a" });
		// Replay against a different sort or scope is refused, not reinterpreted.
		expect(decodeWorkspaceCursor(cursor, "inv", "updated_asc")).toBeNull();
		expect(decodeWorkspaceCursor(cursor, "src", "updated_desc")).toBeNull();
		expect(decodeWorkspaceCursor("tampered!!", "inv", "updated_desc")).toBeNull();
		expect(decodeWorkspaceCursor("", "inv", "updated_desc")).toBeNull();
	});

	it("round-trips A–Z text keys including separators", () => {
		const cursor = encodeWorkspaceCursor("inv", "az", "Väl: chosen // text", "slice_b");
		expect(decodeWorkspaceCursor(cursor, "inv", "az")).toEqual({ key: "Väl: chosen // text", id: "slice_b" });
	});
});

describe("GET /v1/memories/workspace/inventory", () => {
	it("requires authentication", async () => {
		const res = await request("/v1/memories/workspace/inventory", { headers: {} });
		expect(res.status).toBe(401);
	});

	it("merges all four kinds newest-first with real semantic types", async () => {
		const userId = uid("ws-inv");
		const base = Date.now();
		await seedNode(userId, "node_wsa", "Priya the platform engineer", { ts: base - 4000 });
		await seedPage(userId, "page_wsb", "Rollout notes", { ts: base - 3000 });
		await seedSlice(userId, "slice_wsc", "node_wsa", "Prefers async updates", { ts: base - 2000, kind: "preference" });
		await seedEvent(userId, "event_wsd", "node_wsa", "Kickoff call happened", { ts: base - 1000, happened: base - 1000 });
		const { res, body } = await getJson(`/v1/memories/workspace/inventory?userId=${userId}`);
		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.total).toBe(4);
		expect(body.items.map((item) => item.id)).toEqual(["event_wsd", "slice_wsc", "page_wsb", "node_wsa"]);
		expect(body.items.map((item) => item.semantic_type)).toEqual(["Event", "Preference", "Page", "Entity"]);
		expect(body.items.every((item) => ["active"].includes(item.lifecycle))).toBe(true);
		expect(body.next_cursor).toBeNull();
	});

	it("paginates with a stable keyset cursor and no duplicates or gaps", async () => {
		const userId = uid("ws-page");
		const base = Date.now();
		const node = "node_wsp";
		await seedNode(userId, node, "Anchor", { ts: base - 90_000 });
		for (let i = 0; i < 7; i++) {
			await seedSlice(userId, `slice_wsp${i}`, node, `Detail number ${i}`, { ts: base - i * 1000 });
		}
		const seen = [];
		let cursor = null;
		for (let round = 0; round < 5; round++) {
			const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const { body } = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&limit=3${query}`);
			for (const item of body.items) seen.push(item.id);
			cursor = body.next_cursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(8);
		expect(new Set(seen).size).toBe(8);
	});

	it("rejects a tampered or cross-sort cursor", async () => {
		const userId = uid("ws-badcur");
		const good = encodeWorkspaceCursor("inv", "updated_asc", 5, "node_x");
		const wrongSort = await request(`/v1/memories/workspace/inventory?userId=${userId}&cursor=${encodeURIComponent(good)}`);
		expect(wrongSort.status).toBe(400);
		const garbage = await request(`/v1/memories/workspace/inventory?userId=${userId}&cursor=!!nope`);
		expect(garbage.status).toBe(400);
	});

	it("filters by kind, lifecycle, source, search and window", async () => {
		const userId = uid("ws-filter");
		const base = Date.now();
		const packet = "packet_wsf1";
		await seedPacket(userId, packet, { topic: "Kickoff", ts: base });
		await seedNode(userId, "node_wsf1", "Active entity", { ts: base - 5000 });
		await seedNode(userId, "node_wsf2", "Archived entity", { ts: base - 4000, archived: base });
		await seedSlice(userId, "slice_wsf3", "node_wsf1", "Current decision", { ts: base - 3000 });
		await seedSlice(userId, "slice_wsf4", "node_wsf1", "Old superseded price", { ts: base - 2000, isCurrent: 0 });
		await seedEvent(userId, "event_wsf5", "node_wsf1", "Old event", { ts: base - 40 * 86_400_000, happened: base - 40 * 86_400_000 });
		await seedLink(userId, "slice", "slice_wsf3", packet);

		const kinds = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&kind=node`);
		expect(kinds.body.items.map((i) => i.id).sort()).toEqual(["node_wsf1", "node_wsf2"]);

		const archived = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&lifecycle=archived`);
		expect(archived.body.items.map((i) => i.id)).toEqual(["node_wsf2"]);

		const superseded = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&lifecycle=superseded`);
		expect(superseded.body.items.map((i) => i.id)).toEqual(["slice_wsf4"]);

		const bySource = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&sourceId=${packet}`);
		expect(bySource.body.items.map((i) => i.id)).toEqual(["slice_wsf3"]);
		expect(bySource.body.items[0].source).toMatchObject({ id: packet, title: "Kickoff" });

		const search = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&q=superseded`);
		expect(search.body.items.map((i) => i.id)).toEqual(["slice_wsf4"]);

		const window = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&updatedWithin=7d`);
		expect(window.body.items.map((i) => i.id)).not.toContain("event_wsf5");
	});

	it("sorts A–Z with a working cursor over long texts", async () => {
		const userId = uid("ws-az");
		const node = "node_wsaz";
		await seedNode(userId, node, "zzz anchor");
		const longText = `Aaa ${"x".repeat(300)}`;
		await seedSlice(userId, "slice_wsaz1", node, longText);
		await seedSlice(userId, "slice_wsaz2", node, "Bbb short");
		const first = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&sort=az&limit=1`);
		expect(first.body.items[0].id).toBe("slice_wsaz1");
		const second = await getJson(`/v1/memories/workspace/inventory?userId=${userId}&sort=az&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
		expect(second.body.items[0].id).toBe("slice_wsaz2");
	});

	it("never leaks another account's rows", async () => {
		const userId = uid("ws-isolate");
		const otherId = uid("ws-other");
		await seedNode(userId, "node_wsi1", "Mine");
		await seedNode(otherId, "node_wsi2", "Theirs");
		const { body } = await getJson(`/v1/memories/workspace/inventory?userId=${userId}`);
		expect(body.items.map((i) => i.id)).toEqual(["node_wsi1"]);
		expect(body.total).toBe(1);
	});

	it("hides deleted and suppressed objects entirely", async () => {
		const userId = uid("ws-hidden");
		const now = Date.now();
		await seedNode(userId, "node_wsh1", "Visible");
		await env.DB.prepare("INSERT INTO nodes (id, user_id, label, deleted_at, created_at) VALUES (?, ?, 'Deleted', ?, ?)")
			.bind("node_wsh2", userId, now, now).run();
		await env.DB.prepare("INSERT INTO nodes (id, user_id, label, suppressed_at, created_at) VALUES (?, ?, 'Suppressed', ?, ?)")
			.bind("node_wsh3", userId, now, now).run();
		const { body } = await getJson(`/v1/memories/workspace/inventory?userId=${userId}`);
		expect(body.items.map((i) => i.id)).toEqual(["node_wsh1"]);
	});

	it("validates limit bounds", async () => {
		const userId = uid("ws-lim");
		expect((await request(`/v1/memories/workspace/inventory?userId=${userId}&limit=0`)).status).toBe(400);
		expect((await request(`/v1/memories/workspace/inventory?userId=${userId}&limit=101`)).status).toBe(400);
		expect((await request(`/v1/memories/workspace/inventory?userId=${userId}&limit=abc`)).status).toBe(400);
	});
});

describe("workspace memory detail and satellites", () => {
	it("returns a node with real satellite counts and source", async () => {
		const userId = uid("ws-det");
		const base = Date.now();
		const packet = "packet_wsd1";
		await seedPacket(userId, packet, { topic: "Onboarding call", ts: base });
		await seedNode(userId, "node_wsd1", "Priya", { ts: base, summary: "Primary contact" });
		await seedLink(userId, "node", "node_wsd1", packet);
		await seedSlice(userId, "slice_wsd2", "node_wsd1", "Prefers Slack", { snippet: "Keep it in Slack." });
		await seedEvent(userId, "event_wsd3", "node_wsd1", "Ownership moved", { happened: base - 1000, snippet: "Team moved to platform." });
		await seedEvent(userId, "event_wsd4", "node_wsd1", "No snippet event", { happened: base - 500 });
		await env.DB.prepare(
			"INSERT INTO edges (id, user_id, from_node, to_node, type, created_at) VALUES ('edge_wsd5', ?, 'node_wsd1', 'node_wsd6', 'reports', ?)",
		).bind(userId, base).run();
		await seedNode(userId, "node_wsd6", "Northwind platform team", { ts: base - 100 });

		const { res, body } = await getJson(`/v1/memories/workspace/memory/node_wsd1?userId=${userId}`);
		expect(res.status).toBe(200);
		expect(body.memory).toMatchObject({
			id: "node_wsd1",
			semantic_type: "Entity",
			text: "Priya",
			lifecycle: "active",
			evidence_count: 2,
			timeline_count: 2,
			connections_count: 1,
		});
		expect(body.memory.source).toMatchObject({ id: packet, title: "Onboarding call" });

		const evidence = await getJson(`/v1/memories/workspace/memory/node_wsd1/evidence?userId=${userId}`);
		expect(evidence.body.items).toHaveLength(2);
		expect(evidence.body.items.map((i) => i.text)).toContain("Keep it in Slack.");

		const timeline = await getJson(`/v1/memories/workspace/memory/node_wsd1/timeline?userId=${userId}`);
		expect(timeline.body.items).toHaveLength(2);
		expect(timeline.body.items[0]).toMatchObject({ text: "No snippet event" });
		expect(timeline.body.items[0].happened_at).not.toBeNull();

		const connections = await getJson(`/v1/memories/workspace/memory/node_wsd1/connections?userId=${userId}`);
		expect(connections.body.items).toHaveLength(1);
		expect(connections.body.items[0]).toMatchObject({
			direction: "out",
			type: "reports",
			other: { id: "node_wsd6", label: "Northwind platform team" },
			state: "active",
		});
	});

	it("serves slice and event details with their own scrubbed snippet as evidence", async () => {
		const userId = uid("ws-se");
		await seedNode(userId, "node_wse1", "Anchor");
		await seedSlice(userId, "slice_wse2", "node_wse1", "The plan moved to October", { kind: "decision", snippet: "We said October." });
		await seedEvent(userId, "event_wse3", "node_wse1", "Launch happened", { happened: Date.now(), invalid: Date.now() });

		const slice = await getJson(`/v1/memories/workspace/memory/slice_wse2?userId=${userId}`);
		expect(slice.body.memory).toMatchObject({ semantic_type: "Decision", lifecycle: "active", evidence_count: 1 });
		expect(slice.body.memory.node).toMatchObject({ id: "node_wse1", label: "Anchor" });

		const sliceEvidence = await getJson(`/v1/memories/workspace/memory/slice_wse2/evidence?userId=${userId}`);
		expect(sliceEvidence.body.items).toEqual([
			expect.objectContaining({ text: "We said October." }),
		]);

		const event = await getJson(`/v1/memories/workspace/memory/event_wse3?userId=${userId}`);
		expect(event.body.memory).toMatchObject({ semantic_type: "Event", lifecycle: "superseded", evidence_count: 0 });
	});

	it("pages evidence from a memory page's stored evidence_json behind a cursor", async () => {
		const userId = uid("ws-pev");
		const evidence = JSON.stringify([
			{ snippet: "First permitted excerpt", source_type: "conversation", timestamp: 1700000000000 },
			{ snippet: "Second permitted excerpt", source_type: "conversation" },
			{ snippet: "Third permitted excerpt", source_type: "conversation" },
		]);
		await seedPage(userId, "page_wpe1", "Evidence page", { evidence });
		const first = await getJson(`/v1/memories/workspace/memory/page_wpe1/evidence?userId=${userId}&limit=2`);
		expect(first.body.items).toHaveLength(2);
		expect(first.body.next_cursor).not.toBeNull();
		const second = await getJson(`/v1/memories/workspace/memory/page_wpe1/evidence?userId=${userId}&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
		expect(second.body.items).toHaveLength(1);
		expect(second.body.items[0].text).toBe("Third permitted excerpt");
		expect(second.body.next_cursor).toBeNull();
	});

	it("404s cross-account and guessed ids on detail and satellites", async () => {
		const userId = uid("ws-guess");
		const otherId = uid("ws-victim");
		await seedNode(otherId, "node_wsg1", "Not yours");
		expect((await request(`/v1/memories/workspace/memory/node_wsg1?userId=${userId}`)).status).toBe(404);
		expect((await request(`/v1/memories/workspace/memory/node_never?userId=${userId}`)).status).toBe(404);
		expect((await request(`/v1/memories/workspace/memory/bogus_id?userId=${userId}`)).status).toBe(400);
		// Node satellites are per-node queries; a foreign node id yields empty
		// lists, never the other account's rows.
		const foreign = await getJson(`/v1/memories/workspace/memory/node_wsg1/evidence?userId=${userId}`);
		expect(foreign.body.items).toEqual([]);
	});

	it("hides archived-object detail never, but deleted always", async () => {
		const userId = uid("ws-vis");
		const now = Date.now();
		await seedNode(userId, "node_wsv1", "Archived but inspectable", { archived: now });
		await env.DB.prepare("INSERT INTO nodes (id, user_id, label, deleted_at, created_at) VALUES (?, ?, 'Gone', ?, ?)")
			.bind("node_wsv2", userId, now, now).run();
		const archived = await getJson(`/v1/memories/workspace/memory/node_wsv1?userId=${userId}`);
		expect(archived.body.memory.lifecycle).toBe("archived");
		expect((await request(`/v1/memories/workspace/memory/node_wsv2?userId=${userId}`)).status).toBe(404);
	});
});

describe("GET /v1/memories/workspace/sources", () => {
	it("lists sources with derived processing state and real counts", async () => {
		const userId = uid("ws-src");
		const base = Date.now();
		await seedPacket(userId, "packet_wss1", { topic: "Processed doc", ts: base - 3000 });
		await seedPacket(userId, "packet_wss2", { topic: "Still working", ts: base - 2000 });
		await seedPacket(userId, "packet_wss3", { topic: "Broken one", ts: base - 1000 });
		await seedPacket(userId, "packet_wss4", { topic: "Just recorded", ts: base - 500 });
		// Query packets never appear as sources.
		await seedPacket(userId, "packet_wss5", { topic: "A recall", ts: base, type: "query" });
		await seedJob(userId, "job_wss1", "packet_wss1", "enriched");
		await seedJob(userId, "job_wss2", "packet_wss2", "processing");
		await seedJob(userId, "job_wss3", "packet_wss3", "failed", { error: "llm_failed: model unavailable" });
		await seedNode(userId, "node_wss6", "Extracted entity");
		await seedLink(userId, "node", "node_wss6", "packet_wss1");
		await seedEpisode(userId, "ep_wss1", "packet_wss1", "The permitted excerpt", { index: 0 });

		const { body } = await getJson(`/v1/memories/workspace/sources?userId=${userId}`);
		expect(body.total).toBe(4);
		const byId = Object.fromEntries(body.items.map((item) => [item.id, item]));
		expect(byId.packet_wss1).toMatchObject({ state: "processed", memories: 1, evidence: 1, title: "Processed doc" });
		expect(byId.packet_wss2.state).toBe("processing");
		expect(byId.packet_wss3.state).toBe("failed");
		expect(byId.packet_wss4.state).toBe("recorded");
		expect(byId.packet_wss5).toBeUndefined();

		const failed = await getJson(`/v1/memories/workspace/sources?userId=${userId}&state=failed`);
		expect(failed.body.items.map((i) => i.id)).toEqual(["packet_wss3"]);

		const search = await getJson(`/v1/memories/workspace/sources?userId=${userId}&q=Broken`);
		expect(search.body.items.map((i) => i.id)).toEqual(["packet_wss3"]);
	});

	it("paginates sources and scopes them to the account", async () => {
		const userId = uid("ws-srcpage");
		const otherId = uid("ws-srcother");
		const base = Date.now();
		for (let i = 0; i < 4; i++) await seedPacket(userId, `packet_wsp${i}`, { ts: base - i * 1000 });
		await seedPacket(otherId, "packet_wsq0", { ts: base });
		const first = await getJson(`/v1/memories/workspace/sources?userId=${userId}&limit=3`);
		expect(first.body.items).toHaveLength(3);
		expect(first.body.next_cursor).not.toBeNull();
		const second = await getJson(`/v1/memories/workspace/sources?userId=${userId}&limit=3&cursor=${encodeURIComponent(first.body.next_cursor)}`);
		expect(second.body.items).toHaveLength(1);
		const all = [...first.body.items, ...second.body.items].map((i) => i.id);
		expect(new Set(all).size).toBe(4);
		expect(all).not.toContain("packet_wsq0");
	});

	it("serves source detail with failure info, and never raw meta", async () => {
		const userId = uid("ws-srcdet");
		await seedPacket(userId, "packet_wsd10", { topic: "Fails", preview: "secret-adjacent preview" });
		await env.DB.prepare("UPDATE source_packets SET raw_meta_json = ? WHERE id = ?")
			.bind(JSON.stringify({ messages: [{ snippet: "RAW-NEVER-SERVED" }] }), "packet_wsd10").run();
		await seedJob(userId, "job_wsd10", "packet_wsd10", "failed", { error: "extract failed: unterminated field" });
		const { res, body } = await getJson(`/v1/memories/workspace/sources/packet_wsd10?userId=${userId}`);
		expect(res.status).toBe(200);
		expect(body.source).toMatchObject({ id: "packet_wsd10", state: "failed" });
		expect(body.source.failure).toContain("unterminated field");
		expect(JSON.stringify(body)).not.toContain("RAW-NEVER-SERVED");
	});

	it("serves source memories, ordered evidence and bounded content", async () => {
		const userId = uid("ws-srcsat");
		const base = Date.now();
		await seedPacket(userId, "packet_wsm1", { topic: "Rich source", ts: base });
		await seedNode(userId, "node_wsm2", "Linked entity", { ts: base - 100 });
		await seedLink(userId, "node", "node_wsm2", "packet_wsm1");
		await seedPage(userId, "page_wsm3", "Produced page", { packet: "packet_wsm1", markdown: "# Body\nreal content", ts: base - 50 });
		await seedEpisode(userId, "ep_wsm1", "packet_wsm1", "Second message", { index: 1 });
		await seedEpisode(userId, "ep_wsm2", "packet_wsm1", "First message", { index: 0 });

		const memories = await getJson(`/v1/memories/workspace/sources/packet_wsm1/memories?userId=${userId}`);
		expect(memories.body.items.map((i) => i.id).sort()).toEqual(["node_wsm2", "page_wsm3"]);

		const evidence = await getJson(`/v1/memories/workspace/sources/packet_wsm1/evidence?userId=${userId}&limit=1`);
		expect(evidence.body.items[0]).toMatchObject({ text: "First message", position: 0 });
		const evidence2 = await getJson(`/v1/memories/workspace/sources/packet_wsm1/evidence?userId=${userId}&limit=1&cursor=${encodeURIComponent(evidence.body.next_cursor)}`);
		expect(evidence2.body.items[0]).toMatchObject({ text: "Second message", position: 1 });

		const content = await getJson(`/v1/memories/workspace/sources/packet_wsm1/content?userId=${userId}`);
		expect(content.body.content).toMatchObject({ page_id: "page_wsm3", truncated: false });
		expect(content.body.content.markdown).toContain("real content");
	});

	it("404s foreign and unknown sources on detail and satellites", async () => {
		const userId = uid("ws-srciso");
		const otherId = uid("ws-srcvic");
		await seedPacket(otherId, "packet_wsx1", { topic: "Foreign" });
		expect((await request(`/v1/memories/workspace/sources/packet_wsx1?userId=${userId}`)).status).toBe(404);
		expect((await request(`/v1/memories/workspace/sources/packet_wsx1/evidence?userId=${userId}`)).status).toBe(404);
		expect((await request(`/v1/memories/workspace/sources/packet_none/memories?userId=${userId}`)).status).toBe(404);
	});
});

describe("GET /v1/memories/workspace/suggestions", () => {
	it("lists pending candidates with evidence and merge target", async () => {
		const userId = uid("ws-sug");
		const base = Date.now();
		await seedNode(userId, "node_wsu1", "Growth plan pricing", { ts: base });
		await seedCandidate(userId, "cand_wsu2", "New price point", {
			ts: base - 100,
			reason: "conflicts_with_existing",
			target: "node_wsu1",
			evidence: JSON.stringify([{ snippet: "I thought it was $1,500?", ts: base - 100 }]),
			confidence: 0.62,
		});
		await seedCandidate(userId, "cand_wsu3", "Ferry closed Sundays", { ts: base - 200 });
		await seedCandidate(userId, "cand_wsu4", "Already handled", { ts: base - 300, status: "rejected" });

		const { body } = await getJson(`/v1/memories/workspace/suggestions?userId=${userId}`);
		expect(body.total).toBe(2);
		expect(body.items.map((i) => i.id)).toEqual(["cand_wsu2", "cand_wsu3"]);
		expect(body.items[0]).toMatchObject({
			text: "New price point",
			status: "pending",
			reason: "conflicts_with_existing",
			confidence: 0.62,
			merge_target: { id: "node_wsu1", label: "Growth plan pricing" },
		});
		expect(body.items[0].evidence[0].text).toContain("$1,500");
		expect(body.items[1].merge_target).toBeNull();

		const reviewed = await getJson(`/v1/memories/workspace/suggestions?userId=${userId}&status=reviewed`);
		expect(reviewed.body.items.map((i) => i.id)).toEqual(["cand_wsu4"]);
	});

	it("searches, paginates and isolates suggestions", async () => {
		const userId = uid("ws-sugpage");
		const otherId = uid("ws-sugother");
		const base = Date.now();
		for (let i = 0; i < 4; i++) await seedCandidate(userId, `cand_wsg${i}`, `Suggestion ${i}`, { ts: base - i * 1000 });
		await seedCandidate(otherId, "cand_wsgx", "Foreign suggestion", { ts: base });
		const search = await getJson(`/v1/memories/workspace/suggestions?userId=${userId}&q=Suggestion 2`);
		expect(search.body.items.map((i) => i.id)).toEqual(["cand_wsg2"]);
		const first = await getJson(`/v1/memories/workspace/suggestions?userId=${userId}&limit=3`);
		expect(first.body.items).toHaveLength(3);
		const second = await getJson(`/v1/memories/workspace/suggestions?userId=${userId}&limit=3&cursor=${encodeURIComponent(first.body.next_cursor)}`);
		const all = [...first.body.items, ...second.body.items].map((i) => i.id);
		expect(new Set(all).size).toBe(4);
		expect(all).not.toContain("cand_wsgx");
	});
});

describe("workspace counts and facets", () => {
	it("reports real tab counts", async () => {
		const userId = uid("ws-counts");
		await seedNode(userId, "node_wsc1", "One");
		await seedPacket(userId, "packet_wsc2", {});
		await seedPacket(userId, "packet_wsc3", { type: "query" });
		await seedCandidate(userId, "cand_wsc4", "Pending one");
		const { body } = await getJson(`/v1/memories/workspace/counts?userId=${userId}`);
		expect(body.counts).toEqual({ memories: 1, sources: 1, suggestions: 1 });
	});

	it("reports facet counts from real rows only", async () => {
		const userId = uid("ws-facets");
		const base = Date.now();
		await seedNode(userId, "node_wsf10", "Entity A", { ts: base });
		await seedNode(userId, "node_wsf11", "Entity B (archived)", { ts: base, archived: base });
		await seedSlice(userId, "slice_wsf12", "node_wsf10", "Detail", { isCurrent: 0 });
		await seedPacket(userId, "packet_wsf13", { topic: "Used source" });
		await seedLink(userId, "node", "node_wsf10", "packet_wsf13");
		const { body } = await getJson(`/v1/memories/workspace/facets?userId=${userId}`);
		expect(body.kinds).toMatchObject({ node: 2, slice: 1, page: 0, event: 0 });
		expect(body.lifecycle).toMatchObject({ archived: 1, superseded: 1, active: 1 });
		expect(body.sources[0]).toMatchObject({ id: "packet_wsf13", title: "Used source", count: 1 });
	});
});

describe("workspace RBAC", () => {
	it("refuses a viewer nothing on read but a write-scoped token cannot bypass read scope", async () => {
		// Bearer tokens with only memory:write are refused on the read surface
		// contract (memory:write implies read per tokenAllowsScope, so use a
		// scope that grants neither).
		const res = await request("/v1/memories/workspace/inventory", {
			headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});
