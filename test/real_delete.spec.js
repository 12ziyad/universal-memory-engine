/**
 * Part 3 — delete that actually deletes.
 *
 * The acceptance shape: write tagged memories on top of a baseline, bulk
 * delete by time window, and the account must match its before-state in ONE
 * pass — graph rows, summaries, FTS. A distinctive string from the deleted
 * content must be findable NOWHERE afterwards, summaries included.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const TAG = "ZGTAGXRAY"; // distinctive, canonicalization-proof token

async function call(method, path, body) {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

const canned = (label, sliceText) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: sliceText ?? `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

async function ingest(userId, id, content, llmResponse, memoryScope = undefined) {
	return call("POST", "/v1/ingest", {
		userId,
		flush: true,
		...(memoryScope ? { memoryScope } : {}),
		messages: [{ id, role: "user", content }],
		_test: { llmResponse },
	});
}

async function snapshot(userId) {
	const q = async (sql) => (await env.DB.prepare(sql).bind(userId).all()).results ?? [];
	return {
		nodes: await q("SELECT id, label, summary FROM nodes WHERE user_id = ? AND deleted_at IS NULL ORDER BY id"),
		slices: await q("SELECT id, text FROM slices WHERE user_id = ? AND deleted_at IS NULL ORDER BY id"),
		events: await q("SELECT id, text FROM events WHERE user_id = ? AND deleted_at IS NULL ORDER BY id"),
		edges: await q("SELECT id FROM edges WHERE user_id = ? AND deleted_at IS NULL ORDER BY id"),
		pages: await q("SELECT id FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL ORDER BY id"),
	};
}

async function grepAccount(userId, needle) {
	const hits = [];
	const scans = [
		["nodes", "label LIKE ? OR summary LIKE ?", 2],
		["slices", "text LIKE ?", 1],
		["events", "text LIKE ?", 1],
		["edges", "fact LIKE ?", 1],
		["memory_pages", "title LIKE ? OR short_summary LIKE ? OR full_markdown LIKE ?", 3],
	];
	for (const [table, where, n] of scans) {
		const binds = Array(n).fill(`%${needle}%`);
		const { results } = await env.DB.prepare(
			`SELECT id FROM ${table} WHERE user_id = ? AND deleted_at IS NULL AND (${where})`,
		).bind(userId, ...binds).all();
		for (const row of results ?? []) hits.push(`${table}:${row.id}`);
	}
	return hits;
}

describe("bulk delete by source restores the before-state in ONE pass", () => {
	it("30 tagged memories in, bulk delete out, baseline intact, zero residue", async () => {
		const userId = `del-bulk-${crypto.randomUUID()}`;

		// Baseline: two durable saves that must SURVIVE the bulk delete.
		await ingest(userId, "base1", "I am building project Kingfisher this month", canned("Kingfisher"));
		await ingest(userId, "base2", "I am building project Marigold this month", canned("Marigold"));
		const before = await snapshot(userId);
		expect(before.nodes.length).toBe(2);

		await new Promise((r) => setTimeout(r, 10));
		const t0 = Date.now();

		// 30 tagged writes: 28 new nodes + 2 that CONTAMINATE a baseline node's
		// summary (a tagged slice added to Kingfisher — pass 2 bakes it in).
		// Distinct WORD labels — canonicalization strips digits, and 28 labels
		// that collapse into one node would test nothing.
		const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
			"India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec",
			"Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xerox", "Yankee",
			"Zulu", "Aurora", "Boreal"];
		for (let i = 1; i <= 28; i++) {
			const label = NATO[i - 1];
			await ingest(userId, `tag${i}`, `${TAG} fact number ${i} about project ${label}`,
				canned(label, `${TAG} detail ${i}`));
		}
		for (let i = 29; i <= 30; i++) {
			await ingest(userId, `tag${i}`, `${TAG} extra detail for Kingfisher`, {
				objects: [
					{ kind: "node", label: "Kingfisher", category: "project", matches_existing: null, confidence: 0.95 },
					{ kind: "slice", on: "Kingfisher", text: `${TAG} contaminating detail ${i}`, kind_detail: "progress", confidence: 0.9 },
				],
				notes: "",
			});
		}

		// The contamination is real before we delete (summary or slices carry it).
		expect((await grepAccount(userId, TAG)).length).toBeGreaterThan(0);

		// Dry run first — counts, no destruction.
		const dry = await call("DELETE", `/v1/memories?after=${t0}&userId=${encodeURIComponent(userId)}`);
		expect(dry.status).toBe(200);
		expect(dry.body.dry_run).toBe(true);
		expect(dry.body.would_delete.nodes).toBe(28);
		expect((await grepAccount(userId, TAG)).length).toBeGreaterThan(0); // untouched

		// The destructive pass — exactly one.
		const del = await call("DELETE", `/v1/memories?after=${t0}&confirm=true&dry_run=false&userId=${encodeURIComponent(userId)}`);
		expect(del.status).toBe(200);
		expect(del.body.dry_run).toBe(false);
		expect(del.body.deleted.nodes).toBe(28);

		// ONE pass: the tag is findable NOWHERE — summaries included.
		const residue = await grepAccount(userId, TAG);
		expect(residue).toEqual([]);

		// And the baseline is exactly what it was: same live rows.
		const after = await snapshot(userId);
		expect(after.nodes.map((n) => n.label).sort()).toEqual(before.nodes.map((n) => n.label).sort());
		expect(after.slices.map((s) => s.id).sort()).toEqual(before.slices.map((s) => s.id).sort());
		expect(after.events.map((e) => e.id).sort()).toEqual(before.events.map((e) => e.id).sort());
		expect(after.edges.length).toBe(before.edges.length);
		expect(after.pages.length).toBe(before.pages.length);

		// Tombstone receipt for audit.
		const tomb = await env.DB.prepare(
			"SELECT * FROM receipts WHERE user_id = ? AND outcome = 'deleted'",
		).bind(userId).first();
		expect(tomb).toBeTruthy();
	}, 60000);
});

describe("candidates are covered by delete-by-source (Part 9 finding)", () => {
	it("a run's weak candidates die with it, evidence text included", async () => {
		const userId = `del-cand-${crypto.randomUUID()}`;
		await new Promise((r) => setTimeout(r, 5));
		const t0 = Date.now();
		// A node-only proposal at low confidence parks a CANDIDATE carrying the
		// message as evidence — the shape that survived a "complete" delete.
		await ingest(userId, "c1", `${TAG} I might take up freediving in Sesimbra someday`, {
			objects: [
				{ kind: "node", label: "Freediving", category: "skill", matches_existing: null, confidence: 0.3 },
			],
			notes: "",
		});
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM candidates WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(before.n).toBeGreaterThan(0);

		const dry = await call("DELETE", `/v1/memories?after=${t0}&userId=${encodeURIComponent(userId)}`);
		expect(dry.body.would_delete.candidates).toBeGreaterThan(0);

		const del = await call("DELETE", `/v1/memories?after=${t0}&confirm=true&dry_run=false&userId=${encodeURIComponent(userId)}`);
		expect(del.body.deleted.candidates).toBeGreaterThan(0);

		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM candidates WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(after.n).toBe(0);
		expect(await grepAccount(userId, TAG)).toEqual([]);
	}, 30000);
});

describe("single-object delete for API callers (3.1)", () => {
	it("DELETE /v1/memories/:id cascades and tombstones; unknown id 404s", async () => {
		const userId = `del-one-${crypto.randomUUID()}`;
		await ingest(
			userId,
			"s1",
			"I am building project Nightjar this month",
			canned("Nightjar"),
			{ projectId: "nightjar-project", projectName: "Nightjar" },
		);
		const node = await env.DB.prepare(
			"SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(node).toBeTruthy();

		const del = await call("DELETE", `/v1/memories/${node.id}?userId=${encodeURIComponent(userId)}`);
		expect(del.status).toBe(200);
		expect(del.body.deleted).toBe(true);

		const gone = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(gone.n).toBe(0);
		const slices = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(slices.n).toBe(0);
		const tombstoneRow = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE user_id = ? AND source = 'delete_memory' ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
		const tombstone = JSON.parse(tombstoneRow.detail);
		expect(tombstone).toMatchObject({
			project_scope: "project",
			project_id: "nightjar-project",
			project_name: "Nightjar",
			project_scopes: [{ project_id: "nightjar-project", project_name: "Nightjar" }],
		});

		const missing = await call("DELETE", `/v1/memories/node_does_not_exist?userId=${encodeURIComponent(userId)}`);
		expect(missing.status).toBe(404);

		const badId = await call("DELETE", `/v1/memories/what_is_this?userId=${encodeURIComponent(userId)}`);
		expect(badId.status).toBe(400);
	}, 30000);
});

/**
 * Slice-scoped delete. The smallest deletable unit used to be a whole node, so
 * one wrong fact could only be removed by destroying every true fact beside it.
 */
describe("slice delete removes one fact and leaves the rest of the node", () => {
	it("kills the named slice, keeps its sibling, and rebuilds the summary", async () => {
		const userId = `del-slice-${crypto.randomUUID()}`;

		// One node carrying TWO co-current facts: one to remove, one that must
		// survive. Different kinds, so the second does not supersede the first —
		// the same shape as a node that accumulated facts over several sessions.
		const twoFacts = {
			objects: [
				{ kind: "node", label: "Vermilion", category: "project", matches_existing: null, confidence: 0.95 },
				{ kind: "slice", on: "Vermilion", text: "Vermilion ships on Fridays", kind_detail: "progress", confidence: 0.9 },
				{ kind: "slice", on: "Vermilion", text: `Vermilion uses ${TAG} internally`, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		};
		await ingest(userId, "s1", "Vermilion ships on Fridays and uses a specific internal tool", twoFacts);

		const node = await env.DB.prepare(
			"SELECT id, summary FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(node).toBeTruthy();

		const slices = (await env.DB.prepare(
			"SELECT id, text, is_current FROM slices WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL ORDER BY created_at",
		).bind(userId, node.id).all()).results ?? [];
		expect(slices.length).toBe(2);
		// Both facts are current here — the second save adds to the node, it does
		// not supersede the first. So the survivor is eligible for the rebuild.
		expect(slices.map((s) => s.is_current)).toEqual([1, 1]);

		const doomed = slices.find((s) => s.text.includes(TAG));
		const keeper = slices.find((s) => !s.text.includes(TAG));
		expect(doomed).toBeTruthy();
		expect(keeper).toBeTruthy();

		// The tagged text is in the node summary before the delete — that is the
		// residue a slice delete has to clear, not just the row.
		const summaryBefore = (await env.DB.prepare(
			"SELECT summary FROM nodes WHERE id = ? AND user_id = ?",
		).bind(node.id, userId).first())?.summary ?? "";
		expect(summaryBefore).toContain(TAG);

		const del = await call("DELETE", `/v1/memories/${doomed.id}?userId=${encodeURIComponent(userId)}`);
		expect(del.status).toBe(200);
		expect(del.body).toMatchObject({ deleted: true, kind: "slice", id: doomed.id, node_id: node.id });

		// The node itself is untouched.
		const nodeAfter = await env.DB.prepare(
			"SELECT id, summary FROM nodes WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
		).bind(node.id, userId).first();
		expect(nodeAfter).toBeTruthy();

		// The sibling fact survives; the deleted one is gone from every surface.
		const after = (await env.DB.prepare(
			"SELECT id, text FROM slices WHERE user_id = ? AND node_id = ? AND deleted_at IS NULL",
		).bind(userId, node.id).all()).results ?? [];
		expect(after.map((s) => s.id)).toEqual([keeper.id]);
		expect(await grepAccount(userId, TAG)).toEqual([]);
		expect(nodeAfter.summary ?? "").not.toContain(TAG);
		expect(nodeAfter.summary ?? "").toContain("Fridays");
	}, 30000);

	it("is scoped to the caller's own account", async () => {
		const mine = `del-slice-mine-${crypto.randomUUID()}`;
		const theirs = `del-slice-theirs-${crypto.randomUUID()}`;
		await ingest(theirs, "t1", "I am building project Cobalt this month", canned("Cobalt", "Cobalt is private"));
		const theirSlice = await env.DB.prepare(
			"SELECT id FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(theirs).first();
		expect(theirSlice).toBeTruthy();

		// Same key, different sub-tenant: the row must be invisible, not deletable.
		const res = await call("DELETE", `/v1/memories/${theirSlice.id}?userId=${encodeURIComponent(mine)}`);
		expect(res.status).toBe(404);
		const still = await env.DB.prepare(
			"SELECT id FROM slices WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
		).bind(theirSlice.id, theirs).first();
		expect(still).toBeTruthy();
	}, 30000);

	it("404s an unknown slice id and still rejects unknown id shapes", async () => {
		const userId = `del-slice-404-${crypto.randomUUID()}`;
		const missing = await call("DELETE", `/v1/memories/slice_nope?userId=${encodeURIComponent(userId)}`);
		expect(missing.status).toBe(404);
		const bad = await call("DELETE", `/v1/memories/frag_whatever?userId=${encodeURIComponent(userId)}`);
		expect(bad.status).toBe(400);
		expect(bad.body.message).toContain("slice_");
	}, 30000);
});
