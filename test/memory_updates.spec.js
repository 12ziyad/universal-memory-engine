/**
 * Safe memory updates — the PATCH/history/rollback contract and its races.
 *
 * Layer 1 (legacy door, direct seeds): exact update/CAS/history/rollback
 * semantics on real D1 without the extraction pipeline in the way.
 * Layer 2 (sessions + Bearer): RBAC, scopes, project fences, audit.
 *
 * Every test creates its own isolated user ids; nothing here touches another
 * spec's rows.
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import {
	EDITABLE_FIELDS, UPDATABLE_KINDS, kindFromMemoryId, snapshotFor,
} from "../src/lib/memory_versions.js";

const legacyHeaders = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers: legacyHeaders, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function patchMemory(userId, id, body, { ifMatch, headers = {} } = {}) {
	return request(`/v1/memories/${id}?userId=${encodeURIComponent(userId)}`, {
		method: "PATCH",
		headers: { ...legacyHeaders, ...(ifMatch !== undefined ? { "if-match": ifMatch } : {}), ...headers },
		body: JSON.stringify(body),
	});
}

async function rollbackMemory(userId, id, body, { ifMatch } = {}) {
	return request(`/v1/memories/${id}/rollback?userId=${encodeURIComponent(userId)}`, {
		method: "POST",
		headers: { ...legacyHeaders, ...(ifMatch !== undefined ? { "if-match": ifMatch } : {}) },
		body: JSON.stringify(body),
	});
}

async function history(userId, id, params = "") {
	const res = await request(`/v1/memories/${id}/history?userId=${encodeURIComponent(userId)}${params}`);
	return { res, body: await res.json() };
}

let seed = 0;
function uid() {
	seed += 1;
	return `upduser-${seed}-${crypto.randomUUID().slice(0, 8)}`;
}
function idem() {
	return `idem-${crypto.randomUUID()}`;
}

async function seedNode(userId, { label = "Espresso machine", category = "tool", summary = "Espresso machine — needs descaling.", revision = null } = {}) {
	const id = `node_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, revision)
		 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
	).bind(id, userId, label, category, summary, Date.now(), Date.now(), revision).run();
	return id;
}

async function seedSlice(userId, nodeId, { text = "Prefers a double shot.", kind = "preference", isCurrent = 1 } = {}) {
	const id = `slice_${crypto.randomUUID()}`;
	await env.DB.prepare(
		"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).bind(id, userId, nodeId, text, kind, isCurrent, Date.now()).run();
	return id;
}

async function seedEvent(userId, nodeId, { text = "Descaled the machine.", action = "practiced", importance = "ordinary", happenedAt = Date.now() } = {}) {
	const id = `event_${crypto.randomUUID()}`;
	await env.DB.prepare(
		"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).bind(id, userId, nodeId, action, text, importance, happenedAt, Date.now()).run();
	return id;
}

async function seedPage(userId, { title = "Kitchen setup", markdown = "# Kitchen\nEspresso corner." } = {}) {
	const id = `page_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO memory_pages (id, user_id, title, canonical_title, topic_filter, short_summary, full_markdown, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'interest', ?, ?, ?, ?)`,
	).bind(id, userId, title, title.toLowerCase(), "Espresso corner notes.", markdown, Date.now(), Date.now()).run();
	return id;
}

describe("the frozen support matrix", () => {
	it("exports exactly the four updatable kinds and their editable fields", () => {
		expect(UPDATABLE_KINDS).toEqual(["node", "page", "slice", "event"]);
		expect(EDITABLE_FIELDS.node).toEqual(["label", "category", "summary"]);
		expect(EDITABLE_FIELDS.page).toEqual(["title", "short_summary", "full_markdown"]);
		expect(EDITABLE_FIELDS.slice).toEqual(["text", "kind"]);
		expect(EDITABLE_FIELDS.event).toEqual(["text", "importance", "happened_at"]);
	});

	it("dispatches ids by prefix and refuses foreign kinds", () => {
		expect(kindFromMemoryId("node_x")).toBe("node");
		expect(kindFromMemoryId("edge_x")).toBe("edge");
		expect(kindFromMemoryId("cand_x")).toBe("candidate");
		expect(kindFromMemoryId("mystery")).toBe(null);
	});
});

describe("update contract (legacy door)", () => {
	it("PATCH without any precondition is 428, wildcard is refused, bad ETag is 428", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const none = await patchMemory(userId, nodeId, { label: "New", idempotencyKey: idem() });
		expect(none.status).toBe(428);
		const wild = await patchMemory(userId, nodeId, { label: "New", idempotencyKey: idem() }, { ifMatch: "*" });
		expect(wild.status).toBe(400);
		expect((await wild.json()).error).toBe("wildcard_rejected");
		const junk = await patchMemory(userId, nodeId, { label: "New", idempotencyKey: idem() }, { ifMatch: '"v7"' });
		expect(junk.status).toBe(428);
	});

	it("updates a node, advances the revision, captures a baseline, serves ETag on reads", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Espresso machine — needs descaling." });

		const read = await request(`/v1/memories/${nodeId}?userId=${userId}`);
		expect(read.headers.get("etag")).toBe('"r1"');

		const res = await patchMemory(userId, nodeId,
			{ summary: "Espresso machine — descaled and calibrated.", reason: "corrected after service", idempotencyKey: idem() },
			{ ifMatch: '"r1"' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.revision).toBe(2);
		expect(body.previous_revision).toBe(1);
		expect(res.headers.get("etag")).toBe('"r2"');

		const row = await env.DB.prepare("SELECT summary, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("Espresso machine — descaled and calibrated.");
		expect(row.revision).toBe(2);

		const { body: hist } = await history(userId, nodeId);
		expect(hist.current_revision).toBe(2);
		expect(hist.revisions.map((r) => [r.revision, r.action])).toEqual([[2, "update"], [1, "baseline"]]);
		expect(hist.revisions[0].reason).toBe("corrected after service");
		expect(hist.revisions[0].snapshot.summary).toContain("calibrated");
		expect(hist.revisions[1].captured).toBe(true);
		expect(hist.revisions[1].snapshot.summary).toContain("needs descaling");
	});

	it("stale revision is 412 with the current revision; nothing is written", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const first = await patchMemory(userId, nodeId, { label: "Rocket R58", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(first.status).toBe(200);
		const stale = await patchMemory(userId, nodeId, { label: "Old name", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(stale.status).toBe(412);
		const staleBody = await stale.json();
		expect(staleBody.error).toBe("stale_revision");
		expect(staleBody.current_revision).toBe(2);
		const row = await env.DB.prepare("SELECT label, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.label).toBe("Rocket R58");
		expect(row.revision).toBe(2);
	});

	it("body expectedRevision works; If-Match and body disagreement is 400", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const ok = await patchMemory(userId, nodeId, { label: "Via body", expectedRevision: 1, idempotencyKey: idem() });
		expect(ok.status).toBe(200);
		const disagree = await patchMemory(userId, nodeId,
			{ label: "X", expectedRevision: 1, idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(disagree.status).toBe(400);
		expect((await disagree.json()).error).toBe("precondition_mismatch");
	});

	it("same-key replay returns the original result even after the head advances; different payload conflicts", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const key = idem();
		const first = await patchMemory(userId, nodeId, { label: "Gaggia Classic", idempotencyKey: key }, { ifMatch: '"r1"' });
		expect(first.status).toBe(200);
		expect((await first.json()).revision).toBe(2);

		// Advance the head with a different key.
		await patchMemory(userId, nodeId, { label: "Gaggia Classic Pro", idempotencyKey: idem() }, { ifMatch: '"r2"' });

		// Replay of the original request: original result, replayed marker.
		const replay = await patchMemory(userId, nodeId, { label: "Gaggia Classic", idempotencyKey: key }, { ifMatch: '"r1"' });
		expect(replay.status).toBe(200);
		const replayBody = await replay.json();
		expect(replayBody.revision).toBe(2);
		expect(replayBody.replayed).toBe(true);

		// Same key, different payload: conflict.
		const conflict = await patchMemory(userId, nodeId, { label: "Different entirely", idempotencyKey: key }, { ifMatch: '"r1"' });
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error).toBe("idempotency_conflict");
	});

	it("a concurrent same-base two-editor race commits exactly one winner", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const [a, b] = await Promise.all([
			patchMemory(userId, nodeId, { label: "Editor A", idempotencyKey: idem() }, { ifMatch: '"r1"' }),
			patchMemory(userId, nodeId, { label: "Editor B", idempotencyKey: idem() }, { ifMatch: '"r1"' }),
		]);
		const statuses = [a.status, b.status].sort();
		expect(statuses).toEqual([200, 412]);
		const row = await env.DB.prepare("SELECT label, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(["Editor A", "Editor B"]).toContain(row.label);
		expect(row.revision).toBe(2);
		const revisions = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ? AND revision = 2",
		).bind(nodeId).first();
		expect(revisions.n).toBe(1);
	});

	it("a concurrent same-key storm mutates exactly once", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const key = idem();
		const make = () => patchMemory(userId, nodeId, { label: "Storm label", idempotencyKey: key }, { ifMatch: '"r1"' });
		const results = await Promise.all([make(), make(), make()]);
		for (const res of results) expect(res.status).toBe(200);
		const row = await env.DB.prepare("SELECT revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.revision).toBe(2);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ? AND action = 'update'").bind(nodeId).first();
		expect(count.n).toBe(1);
	});

	it("no-op updates claim the key but write no revision", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Same label" });
		const res = await patchMemory(userId, nodeId, { label: "Same label", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.noop).toBe(true);
		expect(body.revision).toBe(1);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ?").bind(nodeId).first();
		expect(count.n).toBe(0);
	});

	it("system writer participation: a bumped revision between read and write is a 412; pre-history drift becomes the captured baseline, never an invented r1", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		// Simulate an automatic semantic writer (summary rewrite) between the
		// editor's read (r1) and commit.
		await env.DB.prepare(
			"UPDATE nodes SET summary = 'Espresso machine — auto-enriched.', revision = COALESCE(revision, 1) + 1 WHERE id = ?",
		).bind(nodeId).run();
		const stale = await patchMemory(userId, nodeId, { summary: "User text", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(stale.status).toBe(412);

		// Retrying with the fresh revision records the captured baseline at the
		// drifted revision (r1's content was never recorded and is not invented)
		// plus the explicit update.
		const retry = await patchMemory(userId, nodeId, { summary: "User text", idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(retry.status).toBe(200);
		const { body: hist } = await history(userId, nodeId);
		expect(hist.revisions.map((r) => [r.revision, r.action])).toEqual([
			[3, "update"], [2, "baseline"],
		]);
		expect(hist.revisions[1].snapshot.summary).toBe("Espresso machine — auto-enriched.");
		expect(hist.revisions[1].captured).toBe(true);
	});

	it("system drift AFTER history exists is captured as one labeled system revision", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		// First explicit edit records baseline(1) + update(2).
		await patchMemory(userId, nodeId, { summary: "First user edit.", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		// Automatic writer bumps to r3 without a history row.
		await env.DB.prepare(
			"UPDATE nodes SET summary = 'Auto-refreshed summary.', revision = COALESCE(revision, 1) + 1 WHERE id = ?",
		).bind(nodeId).run();
		// Next explicit edit captures the drift as a system revision.
		const res = await patchMemory(userId, nodeId, { summary: "Second user edit.", idempotencyKey: idem() }, { ifMatch: '"r3"' });
		expect(res.status).toBe(200);
		const { body: hist } = await history(userId, nodeId);
		expect(hist.revisions.map((r) => [r.revision, r.action])).toEqual([
			[4, "update"], [3, "system"], [2, "update"], [1, "baseline"],
		]);
		expect(hist.revisions[1].snapshot.summary).toBe("Auto-refreshed summary.");
		expect(hist.revisions[1].actor).toBe("system");
	});

	it("unknown fields, invalid enums, empty patches, and oversized content are refused by name", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const unknown = await patchMemory(userId, nodeId, { nickname: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(unknown.status).toBe(400);
		expect((await unknown.json()).error).toBe("invalid_field");
		const badCat = await patchMemory(userId, nodeId, { category: "starship", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(badCat.status).toBe(400);
		const empty = await patchMemory(userId, nodeId, { idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(empty.status).toBe(400);
		const huge = await patchMemory(userId, nodeId, { label: "x".repeat(500), idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(huge.status).toBe(400);
		const noKey = await patchMemory(userId, nodeId, { label: "y" }, { ifMatch: '"r1"' });
		expect(noKey.status).toBe(400);
		expect((await noKey.json()).error).toBe("invalid_idempotency_key");
	});

	it("unsupported kinds and states answer stable errors, never silent patches", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		// Edges are not updatable.
		const edge = await patchMemory(userId, "edge_zzz", { text: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(edge.status).toBe(422);
		expect((await edge.json()).error).toBe("unsupported_kind");
		// Candidates route to the suggestions door.
		const cand = await patchMemory(userId, "cand_zzz", { label: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(cand.status).toBe(422);
		// Superseded slice.
		const sliceId = await seedSlice(userId, nodeId, { isCurrent: 0 });
		const superseded = await patchMemory(userId, sliceId, { text: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(superseded.status).toBe(409);
		expect((await superseded.json()).error).toBe("unsupported_state");
		// Archived node.
		await env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE id = ?").bind(Date.now(), nodeId).run();
		const archived = await patchMemory(userId, nodeId, { label: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(archived.status).toBe(409);
		expect((await archived.json()).error).toBe("object_archived");
		// Deleted object: 404 with no tenant leakage.
		await env.DB.prepare("UPDATE nodes SET archived_at = NULL, deleted_at = ? WHERE id = ?").bind(Date.now(), nodeId).run();
		const deleted = await patchMemory(userId, nodeId, { label: "x", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(deleted.status).toBe(404);
	});

	it("slices, events, and pages update through the same contract", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const sliceId = await seedSlice(userId, nodeId, { text: "Prefers a single shot." });
		const sliceRes = await patchMemory(userId, sliceId, { text: "Prefers a double shot.", kind: "preference", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(sliceRes.status).toBe(200);

		const eventId = await seedEvent(userId, nodeId, { happenedAt: 1_700_000_000_000 });
		const eventRes = await patchMemory(userId, eventId, { happened_at: 1_710_000_000_000, importance: "important", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(eventRes.status).toBe(200);
		const eventRow = await env.DB.prepare("SELECT happened_at, happened_at_source, importance FROM events WHERE id = ?").bind(eventId).first();
		expect(eventRow.happened_at).toBe(1_710_000_000_000);
		expect(eventRow.happened_at_source).toBe("user");
		expect(eventRow.importance).toBe("important");

		const pageId = await seedPage(userId);
		const pageRes = await patchMemory(userId, pageId, { title: "Kitchen — espresso corner", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(pageRes.status).toBe(200);
		const pageRow = await env.DB.prepare("SELECT title, canonical_title, revision FROM memory_pages WHERE id = ?").bind(pageId).first();
		expect(pageRow.title).toBe("Kitchen — espresso corner");
		// Identity stays stable: canonical_title is never rewritten by an edit.
		expect(pageRow.canonical_title).toBe("kitchen setup");
		expect(pageRow.revision).toBe(2);
	});
});

describe("rollback", () => {
	it("rolls back as a NEW forward revision, keeps the full chain, and refuses unavailable revisions", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Original label" });
		await patchMemory(userId, nodeId, { label: "Second label", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		await patchMemory(userId, nodeId, { label: "Third label", idempotencyKey: idem() }, { ifMatch: '"r2"' });

		const rb = await rollbackMemory(userId, nodeId, { toRevision: 1, idempotencyKey: idem() }, { ifMatch: '"r3"' });
		expect(rb.status).toBe(200);
		const rbBody = await rb.json();
		expect(rbBody.revision).toBe(4);
		expect(rbBody.rolled_back_to).toBe(1);

		const row = await env.DB.prepare("SELECT label, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.label).toBe("Original label");
		expect(row.revision).toBe(4);

		const { body: hist } = await history(userId, nodeId);
		expect(hist.revisions.map((r) => [r.revision, r.action])).toEqual([
			[4, "rollback"], [3, "update"], [2, "update"], [1, "baseline"],
		]);
		expect(hist.revisions[0].rollback_of).toBe(1);

		// Rolling back to a revision that was never recorded refuses.
		const missing = await rollbackMemory(userId, nodeId, { toRevision: 99, idempotencyKey: idem() }, { ifMatch: '"r4"' });
		expect(missing.status).toBe(404);
		expect((await missing.json()).error).toBe("revision_unavailable");

		// Rolling back "to the current revision" is meaningless.
		const same = await rollbackMemory(userId, nodeId, { toRevision: 4, idempotencyKey: idem() }, { ifMatch: '"r4"' });
		expect(same.status).toBe(400);

		// Rollback requires the CURRENT head: stale precondition refuses.
		const stale = await rollbackMemory(userId, nodeId, { toRevision: 2, idempotencyKey: idem() }, { ifMatch: '"r3"' });
		expect(stale.status).toBe(412);
	});

	it("update versus rollback race: exactly one wins", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Base" });
		await patchMemory(userId, nodeId, { label: "Changed", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		const [u, r] = await Promise.all([
			patchMemory(userId, nodeId, { label: "Update wins?", idempotencyKey: idem() }, { ifMatch: '"r2"' }),
			rollbackMemory(userId, nodeId, { toRevision: 1, idempotencyKey: idem() }, { ifMatch: '"r2"' }),
		]);
		expect([u.status, r.status].sort()).toEqual([200, 412]);
		const row = await env.DB.prepare("SELECT revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.revision).toBe(3);
	});
});

describe("history reads", () => {
	it("pages with a bounded keyset cursor and refuses invalid cursors", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Rev target" });
		let revision = 1;
		for (let i = 0; i < 6; i++) {
			const res = await patchMemory(userId, nodeId, { label: `Label ${i}`, idempotencyKey: idem() }, { ifMatch: `"r${revision}"` });
			expect(res.status).toBe(200);
			revision += 1;
		}
		const { body: page1 } = await history(userId, nodeId, "&limit=3");
		expect(page1.revisions).toHaveLength(3);
		expect(page1.revisions[0].revision).toBe(7);
		expect(page1.next_cursor).toBe("5");
		const { body: page2 } = await history(userId, nodeId, `&limit=3&cursor=${page1.next_cursor}`);
		expect(page2.revisions[0].revision).toBe(4);
		const { res: bad } = await history(userId, nodeId, "&cursor=zebra");
		expect(bad.status).toBe(400);
		const { res: over } = await history(userId, nodeId, "&limit=5000");
		expect(over.status).toBe(200);
	});

	it("another user's history and objects are invisible (404, no leakage)", async () => {
		const owner = uid();
		const stranger = uid();
		const nodeId = await seedNode(owner);
		await patchMemory(owner, nodeId, { label: "Owner edit", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		const { res } = await history(stranger, nodeId);
		expect(res.status).toBe(404);
		const strangerPatch = await patchMemory(stranger, nodeId, { label: "Steal", idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(strangerPatch.status).toBe(404);
	});
});

describe("deletion, purge, and erasure of history", () => {
	it("single-object delete removes revisions, idempotency claims, and projection rows", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		await patchMemory(userId, nodeId, { label: "Edited", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ?").bind(nodeId).first();
		expect(before.n).toBeGreaterThan(0);

		const del = await request(`/v1/actions/delete-object`, {
			method: "POST",
			body: JSON.stringify({ userId, kind: "node", id: nodeId }),
		});
		expect(del.status).toBe(200);

		for (const table of ["memory_revisions", "memory_update_idempotency", "memory_projection_state"]) {
			const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE object_id = ?`).bind(nodeId).first();
			expect(left.n, table).toBe(0);
		}

		// Replay after deletion must not resurrect: the claim is gone with the
		// object, so the same key on the dead id is a plain 404.
		const replay = await patchMemory(userId, nodeId, { label: "Edited", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(replay.status).toBe(404);
	});

	it("cascading node delete erases the history of its slices and events too", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const sliceId = await seedSlice(userId, nodeId);
		await patchMemory(userId, sliceId, { text: "Edited slice fact.", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		await request(`/v1/actions/delete-object`, {
			method: "POST",
			body: JSON.stringify({ userId, kind: "node", id: nodeId }),
		});
		const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id IN (?, ?)").bind(nodeId, sliceId).first();
		expect(left.n).toBe(0);
	});

	it("delete-all removes every version row for the space", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		await patchMemory(userId, nodeId, { label: "Edited", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		const res = await request(`/v1/actions/delete-all`, {
			method: "POST",
			body: JSON.stringify({ userId, confirm: "DELETE ALL" }),
		});
		expect(res.status).toBe(200);
		for (const table of ["memory_revisions", "memory_update_idempotency", "memory_projection_state"]) {
			const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first();
			expect(left.n, table).toBe(0);
		}
	});
});

describe("projections", () => {
	it("an accepted update marks search projection pending then converges to ready with the applied revision", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Search target", summary: "Before edit." });
		const res = await patchMemory(userId, nodeId, { label: "Renamed search target", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.projections.search).toBe("pending");
		// waitOnExecutionContext already drained ctx.waitUntil — the projection
		// ran; verify convergence truth and the FTS profile content.
		const state = await env.DB.prepare(
			"SELECT status, applied_revision FROM memory_projection_state WHERE object_id = ? AND projection = 'search'",
		).bind(nodeId).first();
		expect(state.status).toBe("ready");
		expect(state.applied_revision).toBe(2);
		const profile = await env.DB.prepare(
			"SELECT identity_text FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(userId, nodeId).first();
		expect(profile?.identity_text ?? "").toContain("Renamed search target");
	});

	it("the cron sweep repairs a projection that was left pending", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Sweep target" });
		await patchMemory(userId, nodeId, { label: "Sweep renamed", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		// Force the state back to pending as if the post-commit projection died.
		await env.DB.prepare(
			"UPDATE memory_projection_state SET status = 'pending', applied_revision = NULL WHERE object_id = ?",
		).bind(nodeId).run();
		const { sweepPendingProjections } = await import("../src/lib/memory_versions.js");
		await sweepPendingProjections(env, { limit: 10 });
		const state = await env.DB.prepare(
			"SELECT status, applied_revision FROM memory_projection_state WHERE object_id = ? AND projection = 'search'",
		).bind(nodeId).first();
		expect(state.status).toBe("ready");
		expect(state.applied_revision).toBe(2);
	});

	it("snapshotFor round-trips through history reconstruction", async () => {
		const row = { label: "L", category: "tool", summary: "S", revision: 3 };
		expect(snapshotFor("node", row)).toEqual({ category: "tool", label: "L", summary: "S" });
	});
});

describe("adversarial edges", () => {
	it("Unicode content normalizes to NFC; a visually identical resubmission is a no-op", async () => {
		const userId = uid();
		const decomposed = "Café corner"; // e + combining acute
		const precomposed = "Café corner";
		const nodeId = await seedNode(userId, { label: decomposed });
		const res = await patchMemory(userId, nodeId, { label: precomposed, idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(res.status).toBe(200);
		const body = await res.json();
		const again = await patchMemory(userId, nodeId, { label: decomposed, idempotencyKey: idem() }, { ifMatch: `"r${body.revision}"` });
		expect(again.status).toBe(200);
		expect((await again.json()).noop).toBe(true);
		const row = await env.DB.prepare("SELECT label FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.label).toBe(precomposed);
	});

	it("control characters are stripped and blank content is refused", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const ctrl = await patchMemory(userId, nodeId, { label: "bad\u0007label", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(ctrl.status).toBe(200);
		const row = await env.DB.prepare("SELECT label FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.label).toBe("badlabel");
		const blank = await patchMemory(userId, nodeId, { label: "   ", idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(blank.status).toBe(400);
	});

	it("a foreign object's history revision can never be restored onto another object", async () => {
		const userId = uid();
		const nodeA = await seedNode(userId, { label: "Object A" });
		const nodeB = await seedNode(userId, { label: "Object B" });
		await patchMemory(userId, nodeB, { label: "Object B v2", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		await patchMemory(userId, nodeA, { label: "Object A v2", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		// A has no recorded revision 5 — B's rows must never satisfy A's rollback.
		const rb = await rollbackMemory(userId, nodeA, { toRevision: 5, idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(rb.status).toBe(404);
		// A same-numbered revision restores A's OWN snapshot, never B's.
		const rbOwn = await rollbackMemory(userId, nodeA, { toRevision: 1, idempotencyKey: idem() }, { ifMatch: '"r2"' });
		expect(rbOwn.status).toBe(200);
		const row = await env.DB.prepare("SELECT label FROM nodes WHERE id = ?").bind(nodeA).first();
		expect(row.label).toBe("Object A");
	});

	it("list, get, and the search profile serve the corrected value immediately after the update settles", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Old project name", summary: "Old project name — legacy summary." });
		const res = await patchMemory(userId, nodeId, { label: "Phoenix initiative", summary: "Phoenix initiative — renamed this week.", idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(res.status).toBe(200);
		const list = await request(`/v1/memories?userId=${userId}&q=Phoenix`);
		const listBody = await list.json();
		expect(JSON.stringify(listBody)).toContain("Phoenix initiative");
		expect(JSON.stringify(listBody)).not.toContain("Old project name");
		const one = await request(`/v1/memories/${nodeId}?userId=${userId}`);
		const oneBody = await one.json();
		expect(oneBody.memory.label).toBe("Phoenix initiative");
		expect(oneBody.memory.revision).toBe(2);
		// The FTS profile (recall's sparse leg) carries the new label and has
		// dropped the old one, so search cannot resurrect the stale name.
		const profile = await env.DB.prepare(
			"SELECT identity_text, semantic_text FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(userId, nodeId).first();
		expect(profile.identity_text).toContain("Phoenix initiative");
		expect(`${profile.identity_text} ${profile.semantic_text}`).not.toContain("Old project name");
	});

	it("an oversized page body is refused at the door", async () => {
		const userId = uid();
		const pageId = await seedPage(userId);
		const res = await patchMemory(userId, pageId, { full_markdown: "x".repeat(30_000), idempotencyKey: idem() }, { ifMatch: '"r1"' });
		expect(res.status).toBe(400);
	});
});
