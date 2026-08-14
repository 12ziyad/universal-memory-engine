/**
 * Read-only memory inventory — GET /v1/memories and GET /v1/memories/:id.
 *
 * The management half of the public surface: API keys could write and delete
 * but never see what they had. List is nodes + pages newest-first behind a
 * keyset cursor; get-one uses the same id-prefix dispatch as delete. All of
 * it is SELECTs — these tests also pin that nothing here mutates.
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import { decodeInventoryCursor, encodeInventoryCursor } from "../src/lib/memory_inventory.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function seedNode(userId, id, label, { summary = null, ts = Date.now(), project = null } = {}) {
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, project_id, project_name, created_at, updated_at)
		 VALUES (?, ?, ?, 'skill', 'active', ?, ?, ?, ?, ?)`,
	).bind(id, userId, label, summary, project, project ? `Project ${project}` : null, ts, ts).run();
}

async function seedPage(userId, id, title, { ts = Date.now() } = {}) {
	await env.DB.prepare(
		`INSERT INTO memory_pages (id, user_id, title, canonical_title, topic_filter, short_summary, full_markdown, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'projects', 'A page summary', '# Notes', ?, ?)`,
	).bind(id, userId, title, title.toLowerCase(), ts, ts).run();
}

describe("inventory cursor", () => {
	it("round-trips and rejects garbage", () => {
		const cursor = encodeInventoryCursor(1734000000000, "node_abc");
		expect(cursor).not.toMatch(/[+/=]/);
		expect(decodeInventoryCursor(cursor)).toEqual({ ts: 1734000000000, id: "node_abc" });
		expect(decodeInventoryCursor("garbage-!!")).toBeNull();
		expect(decodeInventoryCursor("")).toBeNull();
	});
});

describe("GET /v1/memories", () => {
	it("requires authentication", async () => {
		const res = await request(`/v1/memories`, { headers: {} });
		expect(res.status).toBe(401);
	});

	it("lists nodes and pages together, newest first", async () => {
		const userId = `inv-list-${crypto.randomUUID()}`;
		const base = Date.now();
		await seedNode(userId, "node_inv_a", "Older fact", { ts: base - 2000 });
		await seedPage(userId, "page_inv_b", "Newer page", { ts: base - 1000 });
		const res = await request(`/v1/memories?userId=${userId}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.count).toBe(2);
		expect(body.items.map((item) => item.id)).toEqual(["page_inv_b", "node_inv_a"]);
		expect(body.items[0]).toMatchObject({ kind: "page", label: "Newer page", category: "projects" });
		expect(body.items[1]).toMatchObject({ kind: "node", label: "Older fact" });
		expect(body.next_cursor).toBeNull();
	});

	it("filters by kind and by substring, and never leaks other users' rows", async () => {
		const userId = `inv-filter-${crypto.randomUUID()}`;
		const otherId = `inv-other-${crypto.randomUUID()}`;
		await seedNode(userId, "node_inv_f1", "Rust preference", { summary: "prefers rust for CLI tools" });
		await seedPage(userId, "page_inv_f2", "Deploy notes");
		await seedNode(otherId, "node_inv_f3", "Rust also");
		const nodesOnly = await (await request(`/v1/memories?userId=${userId}&kind=node`)).json();
		expect(nodesOnly.items.map((item) => item.id)).toEqual(["node_inv_f1"]);
		const q = await (await request(`/v1/memories?userId=${userId}&q=rust`)).json();
		expect(q.items.map((item) => item.id)).toEqual(["node_inv_f1"]);
		const all = await (await request(`/v1/memories?userId=${userId}`)).json();
		expect(all.items.some((item) => item.id === "node_inv_f3")).toBe(false);
	});

	it("paginates with a keyset cursor and no overlap", async () => {
		const userId = `inv-page-${crypto.randomUUID()}`;
		const base = Date.now();
		for (let i = 0; i < 5; i++) await seedNode(userId, `node_inv_p${i}`, `Fact ${i}`, { ts: base - i * 1000 });
		const first = await (await request(`/v1/memories?userId=${userId}&limit=2`)).json();
		expect(first.count).toBe(2);
		expect(first.next_cursor).toBeTruthy();
		const second = await (await request(`/v1/memories?userId=${userId}&limit=2&cursor=${first.next_cursor}`)).json();
		const third = await (await request(`/v1/memories?userId=${userId}&limit=2&cursor=${second.next_cursor}`)).json();
		expect(third.count).toBe(1);
		expect(third.next_cursor).toBeNull();
		const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
		expect(new Set(ids).size).toBe(5);
	});

	it("excludes deleted, archived, and suppressed rows", async () => {
		const userId = `inv-dead-${crypto.randomUUID()}`;
		const now = Date.now();
		await seedNode(userId, "node_inv_live", "Alive");
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, state, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
		).bind("node_inv_deleted", userId, "Deleted", now, now, now).run();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, state, created_at, updated_at, suppressed_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
		).bind("node_inv_supp", userId, "Suppressed", now, now, now).run();
		const body = await (await request(`/v1/memories?userId=${userId}`)).json();
		expect(body.items.map((item) => item.id)).toEqual(["node_inv_live"]);
	});

	it("refuses bad parameters by name", async () => {
		const userId = `inv-bad-${crypto.randomUUID()}`;
		const badKind = await request(`/v1/memories?userId=${userId}&kind=banana`);
		expect(badKind.status).toBe(400);
		expect((await badKind.json()).error).toBe("invalid_kind");
		const badLimit = await request(`/v1/memories?userId=${userId}&limit=0`);
		expect(badLimit.status).toBe(400);
		expect((await badLimit.json()).error).toBe("invalid_limit");
		const badCursor = await request(`/v1/memories?userId=${userId}&cursor=!!nope`);
		expect(badCursor.status).toBe(400);
		expect((await badCursor.json()).error).toBe("invalid_cursor");
	});
});

describe("GET /v1/memories/:id", () => {
	it("returns a node with its slices and events", async () => {
		const userId = `inv-get-${crypto.randomUUID()}`;
		const now = Date.now();
		await seedNode(userId, "node_inv_g1", "Climbing", { summary: "Started climbing" });
		await env.DB.prepare(
			"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, 'progress', 1, ?)",
		).bind("slice_inv_g1", userId, "node_inv_g1", "climbs V4 now", now).run();
		await env.DB.prepare(
			"INSERT INTO events (id, user_id, node_id, action, text, happened_at, created_at) VALUES (?, ?, ?, 'started', 'First session', ?, ?)",
		).bind("event_inv_g1", userId, "node_inv_g1", now, now).run();
		const res = await request(`/v1/memories/node_inv_g1?userId=${userId}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ ok: true, kind: "node", memory: { id: "node_inv_g1", label: "Climbing" } });
		expect(body.memory.slices).toHaveLength(1);
		expect(body.memory.slices[0].text).toBe("climbs V4 now");
		expect(body.memory.events).toHaveLength(1);
	});

	it("returns a page with its markdown", async () => {
		const userId = `inv-getp-${crypto.randomUUID()}`;
		await seedPage(userId, "page_inv_g2", "Design notes");
		const body = await (await request(`/v1/memories/page_inv_g2?userId=${userId}`)).json();
		expect(body).toMatchObject({ ok: true, kind: "page", memory: { id: "page_inv_g2", title: "Design notes", full_markdown: "# Notes" } });
	});

	it("404s on a missing row and 400s on an unrecognized prefix", async () => {
		const userId = `inv-miss-${crypto.randomUUID()}`;
		const missing = await request(`/v1/memories/node_never?userId=${userId}`);
		expect(missing.status).toBe(404);
		const bad = await request(`/v1/memories/banana_7?userId=${userId}`);
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toBe("bad_request");
	});

	it("does not serve another user's memory", async () => {
		const owner = `inv-own-${crypto.randomUUID()}`;
		const outsider = `inv-out-${crypto.randomUUID()}`;
		await seedNode(owner, "node_inv_priv", "Private fact");
		const res = await request(`/v1/memories/node_inv_priv?userId=${outsider}`);
		expect(res.status).toBe(404);
	});
});
