/**
 * Safe memory updates — corrective campaign regressions.
 *
 * Every test here reproduced a real blocker BEFORE its fix. They pin the
 * corrections that the first release's green suite did not cover:
 *
 *  C1 stale automatic writers must not overwrite a newer explicit edit
 *  C2 authorization is rechecked inside the committing transaction
 *  C3 events are readable (GET + ETag + MCP) as well as editable
 *  C4 every deletion path erases revision/idempotency/projection residue
 *  C5 the idempotency fingerprint is normalization-stable and complete
 *  C6 projection state is truthful and ordering-safe
 *  C7 history uniqueness is tenant- and kind-scoped
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";

const legacyHeaders = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers: legacyHeaders, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const idem = () => `idem-${crypto.randomUUID()}`;
let seed = 0;
function uid() {
	seed += 1;
	return `corr-${seed}-${crypto.randomUUID().slice(0, 8)}`;
}

async function patchMemory(userId, id, body, ifMatch) {
	return request(`/v1/memories/${id}?userId=${encodeURIComponent(userId)}`, {
		method: "PATCH",
		headers: { ...legacyHeaders, ...(ifMatch ? { "if-match": ifMatch } : {}) },
		body: JSON.stringify(body),
	});
}

async function seedNode(userId, { label = "Corrective node", summary = "Original summary.", category = "tool" } = {}) {
	const id = `node_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
	).bind(id, userId, label, category, summary, Date.now(), Date.now()).run();
	return id;
}

async function seedEvent(userId, nodeId, { text = "Attended the workshop.", importance = "ordinary" } = {}) {
	const id = `event_${crypto.randomUUID()}`;
	await env.DB.prepare(
		"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, 'other', ?, ?, ?, ?)",
	).bind(id, userId, nodeId, text, importance, Date.now(), Date.now()).run();
	return id;
}

/* ------------------------------------------------------------------ C1 */

describe("C1 — stale automatic writers cannot overwrite a user edit", () => {
	it("a summary regeneration that read revision N is refused after the user commits N+1", async () => {
		const { regenerateNodeSummaryFenced } = await import("../src/pipeline/cleanup.js");
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Machine-written summary." });

		// The background worker reads the node at revision 1.
		const observed = await env.DB.prepare("SELECT COALESCE(revision, 1) AS revision FROM nodes WHERE id = ?")
			.bind(nodeId).first();
		expect(observed.revision).toBe(1);

		// The user corrects it first; the head becomes revision 2.
		const edit = await patchMemory(userId, nodeId, { summary: "The user's corrected summary.", idempotencyKey: idem() }, '"r1"');
		expect(edit.status).toBe(200);

		// The stale worker now tries to write what it computed from revision 1.
		const applied = await regenerateNodeSummaryFenced(env, userId, nodeId, {
			summary: "Stale machine summary from revision 1.",
			sourcesJson: "[]",
			observedRevision: observed.revision,
		});
		expect(applied.stale).toBe(true);
		expect(applied.applied).toBe(false);

		const row = await env.DB.prepare("SELECT summary, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("The user's corrected summary.");
		expect(row.revision).toBe(2);
	});

	it("the same writer applies cleanly when no newer revision exists", async () => {
		const { regenerateNodeSummaryFenced } = await import("../src/pipeline/cleanup.js");
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Before." });
		const applied = await regenerateNodeSummaryFenced(env, userId, nodeId, {
			summary: "After — regenerated.",
			sourcesJson: "[]",
			observedRevision: 1,
		});
		expect(applied.applied).toBe(true);
		expect(applied.stale).toBe(false);
		const row = await env.DB.prepare("SELECT summary, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("After — regenerated.");
		expect(row.revision).toBe(2);
	});

	it("static census: no semantic writer mutates an editable column without a revision fence", async () => {
		const { auditSemanticWriters } = await import("../src/lib/mutation_census.js");
		const findings = await auditSemanticWriters();
		expect(findings.unfenced, JSON.stringify(findings.unfenced, null, 2)).toEqual([]);
	});
});

/* ------------------------------------------------------------------ C2 */

describe("C2 — authorization is rechecked inside the committing transaction", () => {
	it("applyMemoryChange refuses when the actor's capability is revoked between preflight and commit", async () => {
		const { applyMemoryChange, VersionError } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId);

		// A managed project owned by someone else. The actor is a collaborator
		// whose membership has been removed — exactly the downgrade/revocation
		// race. (An OWNER would legitimately still hold the capability, so the
		// actor must not be the owner for this test to mean anything.)
		const projectId = `proj_${crypto.randomUUID()}`;
		const orgId = `org_${crypto.randomUUID()}`;
		const ownerId = `user_${crypto.randomUUID()}`;
		const actorId = `user_${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (id, email, email_normalized, created_at, updated_at, status, role) VALUES (?, ?, ?, ?, ?, 'active', 'user')")
				.bind(ownerId, `${ownerId}@example.com`, `${ownerId}@example.com`, now, now),
			env.DB.prepare("INSERT INTO users (id, email, email_normalized, created_at, updated_at, status, role) VALUES (?, ?, ?, ?, ?, 'active', 'user')")
				.bind(actorId, `${actorId}@example.com`, `${actorId}@example.com`, now, now),
			env.DB.prepare("INSERT INTO organizations (id, owner_user_id, name, name_normalized, status, created_at, updated_at) VALUES (?, ?, 'Corr org', 'corr org', 'active', ?, ?)")
				.bind(orgId, ownerId, now, now),
			env.DB.prepare("INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")
				.bind(`om_${crypto.randomUUID()}`, orgId, ownerId, now, now),
			env.DB.prepare(`INSERT INTO managed_projects (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'Corr project', 'corr project', 0, 'active', ?, ?)`)
				.bind(projectId, ownerId, orgId, userId, now, now),
		]);

		// No membership row exists for the actor in this project → the commit-time
		// capability guard must abort the batch even though the caller reached
		// applyMemoryChange (the MCP path passes no auditIntent).
		await expect(applyMemoryChange(env, null, {
			userId,
			project: { id: projectId },
			actor: { userId: actorId, type: "token", capability: "project.memory.write", orgId },
			actorClass: "token",
			actorRef: "tok_revoked",
			id: nodeId,
			mode: "update",
			patch: { summary: "Written by a revoked actor." },
			idempotencyKey: idem(),
			expectedRevision: 1,
		})).rejects.toMatchObject({ name: "VersionError" });

		const row = await env.DB.prepare("SELECT summary, COALESCE(revision,1) AS revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("Original summary.");
		expect(row.revision).toBe(1);
	});
});

/* ------------------------------------------------------------------ C3 */

describe("C3 — events have full read parity with their advertised editability", () => {
	it("GET /v1/memories/event_* returns the event with a revision and ETag", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const eventId = await seedEvent(userId, nodeId, { text: "Signed the lease." });

		const res = await request(`/v1/memories/${eventId}?userId=${userId}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.kind).toBe("event");
		expect(body.memory.id).toBe(eventId);
		expect(body.memory.text).toBe("Signed the lease.");
		expect(body.memory.revision).toBe(1);
		expect(res.headers.get("etag")).toMatch(/^(W\/)?"r1"$/);
	});

	it("read → edit → history → rollback works end to end for an event", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const eventId = await seedEvent(userId, nodeId, { text: "Original event text." });

		const read = await request(`/v1/memories/${eventId}?userId=${userId}`);
		const revision = (await read.json()).memory.revision;

		const edit = await patchMemory(userId, eventId, { text: "Corrected event text.", idempotencyKey: idem() }, `"r${revision}"`);
		expect(edit.status).toBe(200);
		expect((await edit.json()).revision).toBe(2);

		const history = await request(`/v1/memories/${eventId}/history?userId=${userId}`);
		expect(history.status).toBe(200);
		const historyBody = await history.json();
		expect(historyBody.current_revision).toBe(2);
		expect(historyBody.revisions.map((entry) => entry.action)).toEqual(["update", "baseline"]);

		const rollback = await request(`/v1/memories/${eventId}/rollback?userId=${userId}`, {
			method: "POST",
			headers: { ...legacyHeaders, "if-match": '"r2"' },
			body: JSON.stringify({ toRevision: 1, idempotencyKey: idem() }),
		});
		expect(rollback.status).toBe(200);
		const row = await env.DB.prepare("SELECT text, revision FROM events WHERE id = ?").bind(eventId).first();
		expect(row.text).toBe("Original event text.");
		expect(row.revision).toBe(3);
	});

	it("another tenant cannot read the event", async () => {
		const owner = uid();
		const stranger = uid();
		const nodeId = await seedNode(owner);
		const eventId = await seedEvent(owner, nodeId);
		const res = await request(`/v1/memories/${eventId}?userId=${stranger}`);
		expect(res.status).toBe(404);
	});
});

/* ------------------------------------------------------------------ C4 */

describe("C4 — every deletion path erases revision residue", () => {
	async function residueFor(objectIds) {
		const marks = objectIds.map(() => "?").join(",");
		const [revisions, claims, projections] = await env.DB.batch([
			env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id IN (${marks})`).bind(...objectIds),
			env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_update_idempotency WHERE object_id IN (${marks})`).bind(...objectIds),
			env.DB.prepare(`SELECT COUNT(*) AS n FROM memory_projection_state WHERE object_id IN (${marks})`).bind(...objectIds),
		]);
		return {
			revisions: revisions.results[0].n,
			claims: claims.results[0].n,
			projections: projections.results[0].n,
		};
	}

	it("delete-last-extraction removes revisions, claims, and projection rows for every created object", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const eventId = await seedEvent(userId, nodeId);
		// Give both objects real revision history.
		await patchMemory(userId, nodeId, { summary: "Edited before the extraction rollback.", idempotencyKey: idem() }, '"r1"');
		await patchMemory(userId, eventId, { text: "Edited event.", idempotencyKey: idem() }, '"r1"');
		expect((await residueFor([nodeId, eventId])).revisions).toBeGreaterThan(0);

		const runId = `run_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO extraction_runs (id, user_id, created_at, status, created_nodes_json, created_events_json)
			 VALUES (?, ?, ?, 'ok', ?, ?)`,
		).bind(runId, userId, Date.now(), JSON.stringify([{ id: nodeId }]), JSON.stringify([{ id: eventId }])).run();

		const res = await request("/v1/actions/delete-last-extraction", {
			method: "POST",
			body: JSON.stringify({ userId }),
		});
		expect(res.status).toBe(200);

		const residue = await residueFor([nodeId, eventId]);
		expect(residue).toEqual({ revisions: 0, claims: 0, projections: 0 });
	});

	it("the portability export carries revision history for the caller's own memories", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Export baseline." });
		await patchMemory(userId, nodeId, { summary: "Export corrected.", reason: "export check", idempotencyKey: idem() }, '"r1"');

		const res = await request(`/v1/export?userId=${userId}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		const exported = JSON.stringify(body);
		expect(exported).toContain("revisions");
		expect(exported).toContain("Export baseline.");
		expect(exported).toContain("Export corrected.");
	});

	it("the export omits history of objects that were deleted", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Doomed baseline." });
		await patchMemory(userId, nodeId, { summary: "Doomed corrected.", idempotencyKey: idem() }, '"r1"');
		await request("/v1/actions/delete-object", {
			method: "POST",
			body: JSON.stringify({ userId, kind: "node", id: nodeId }),
		});
		const res = await request(`/v1/export?userId=${userId}`);
		const exported = JSON.stringify(await res.json());
		expect(exported).not.toContain("Doomed baseline.");
		expect(exported).not.toContain("Doomed corrected.");
	});
});

/* ------------------------------------------------------------------ C5 */

describe("C5 — the idempotency fingerprint is normalization-stable and complete", () => {
	it("reordered keys, whitespace, and Unicode forms replay instead of conflicting", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const key = idem();

		const first = await patchMemory(userId, nodeId, {
			label: "Café Ferro",
			summary: "Espresso bar.",
			idempotencyKey: key,
		}, '"r1"');
		expect(first.status).toBe(200);
		const firstBody = await first.json();
		expect(firstBody.revision).toBe(2);

		// Same operation: keys reordered, decomposed Unicode, padded whitespace.
		const replay = await patchMemory(userId, nodeId, {
			idempotencyKey: key,
			summary: "  Espresso bar.  ",
			label: "Café Ferro",
		}, '"r1"');
		expect(replay.status).toBe(200);
		const replayBody = await replay.json();
		expect(replayBody.replayed).toBe(true);
		expect(replayBody.revision).toBe(2);
	});

	it("the same fields with a different reason is a different operation", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const key = idem();
		const first = await patchMemory(userId, nodeId, { summary: "One.", reason: "first reason", idempotencyKey: key }, '"r1"');
		expect(first.status).toBe(200);
		const second = await patchMemory(userId, nodeId, { summary: "One.", reason: "different reason", idempotencyKey: key }, '"r1"');
		expect(second.status).toBe(409);
		expect((await second.json()).error).toBe("idempotency_conflict");
	});

	it("a no-op storm under one key claims exactly once and stays fenced", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Unchanged label" });
		const key = idem();
		const make = () => patchMemory(userId, nodeId, { label: "Unchanged label", idempotencyKey: key }, '"r1"');
		const results = await Promise.all([make(), make(), make()]);
		for (const res of results) expect(res.status).toBe(200);
		const claims = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_update_idempotency WHERE user_id = ? AND idem_key = ?",
		).bind(userId, key).first();
		expect(claims.n).toBe(1);
		// A no-op claim must still be a real claim: a different operation on the
		// same key conflicts rather than silently applying.
		const different = await patchMemory(userId, nodeId, { label: "Changed now", idempotencyKey: key }, '"r1"');
		expect(different.status).toBe(409);
	});

	it("a no-op on an archived object is refused, not silently claimed", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId, { label: "Archived subject" });
		await env.DB.prepare("UPDATE nodes SET archived_at = ? WHERE id = ?").bind(Date.now(), nodeId).run();
		const res = await patchMemory(userId, nodeId, { label: "Archived subject", idempotencyKey: idem() }, '"r1"');
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe("object_archived");
	});
});

/* ------------------------------------------------------------------ C6 */

describe("C6 — projection state is truthful and ordering-safe", () => {
	it("a provider failure marks the projection failed, never ready", async () => {
		const { runProjections } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId);
		await patchMemory(userId, nodeId, { label: "Projection subject", idempotencyKey: idem() }, '"r1"');

		const failing = {
			...env,
			VECTORIZE: {
				async upsert() { throw new Error("vectorize unavailable"); },
				async getByIds() { return []; },
				async deleteByIds() { },
			},
			USE_VECTORS: "true",
		};
		await runProjections(failing, userId, "node", nodeId);
		const state = await env.DB.prepare(
			"SELECT status FROM memory_projection_state WHERE user_id = ? AND object_id = ? AND projection = 'vector'",
		).bind(userId, nodeId).first();
		expect(state.status).not.toBe("ready");
		expect(["failed", "pending", "submitted"]).toContain(state.status);
	});

	it("a stale revision-2 worker cannot mark a revision-3 head ready", async () => {
		const { markProjectionApplied } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId);
		await patchMemory(userId, nodeId, { label: "Second revision", idempotencyKey: idem() }, '"r1"');
		await patchMemory(userId, nodeId, { label: "Third revision", idempotencyKey: idem() }, '"r2"');

		// The head is now r3. A worker that computed against r2 tries to finish.
		const claimed = await markProjectionApplied(env, userId, nodeId, "search", {
			appliedRevision: 2,
			status: "ready",
		});
		expect(claimed.applied).toBe(false);
		const state = await env.DB.prepare(
			"SELECT status, applied_revision FROM memory_projection_state WHERE user_id = ? AND object_id = ? AND projection = 'search'",
		).bind(userId, nodeId).first();
		expect(state.applied_revision === null || state.applied_revision >= 3).toBe(true);
	});

	it("an FTS refresh failure prevents a ready search projection", async () => {
		const { runProjections } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId);
		await patchMemory(userId, nodeId, { label: "FTS subject", idempotencyKey: idem() }, '"r1"');
		await env.DB.prepare(
			"UPDATE memory_projection_state SET status = 'pending', applied_revision = NULL WHERE user_id = ? AND object_id = ?",
		).bind(userId, nodeId).run();

		const brokenDb = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch") {
					return async () => { throw new Error("fts write failed"); };
				}
				const value = target[prop];
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await runProjections({ ...env, DB: brokenDb }, userId, "node", nodeId).catch(() => {});
		const state = await env.DB.prepare(
			"SELECT status FROM memory_projection_state WHERE user_id = ? AND object_id = ? AND projection = 'search'",
		).bind(userId, nodeId).first();
		expect(state.status).not.toBe("ready");
	});

	it("recall only accepts head-revision vector ids", async () => {
		const { isHeadVectorId, vectorIdFor } = await import("../src/lib/memory_versions.js");
		expect(vectorIdFor("node_abc", 3)).toContain("node_abc");
		expect(isHeadVectorId(vectorIdFor("node_abc", 3), "node_abc", 3)).toBe(true);
		expect(isHeadVectorId(vectorIdFor("node_abc", 2), "node_abc", 3)).toBe(false);
	});
});

/* ------------------------------------------------------------------ C7 */

describe("C7 — history uniqueness is tenant- and kind-scoped", () => {
	it("two tenants may each hold their own revision 1 for colliding object ids", async () => {
		const userA = uid();
		const userB = uid();
		const sharedId = `node_${crypto.randomUUID()}`;
		const now = Date.now();
		// Same object id in two memory spaces (possible across restores/imports).
		await env.DB.batch([
			env.DB.prepare("INSERT INTO memory_revisions (id, user_id, object_kind, object_id, revision, action, snapshot_json, content_hash, actor_class, created_at) VALUES (?, ?, 'node', ?, 1, 'baseline', '{}', 'h1', 'system', ?)")
				.bind(`mrev_${crypto.randomUUID()}`, userA, sharedId, now),
			env.DB.prepare("INSERT INTO memory_revisions (id, user_id, object_kind, object_id, revision, action, snapshot_json, content_hash, actor_class, created_at) VALUES (?, ?, 'node', ?, 1, 'baseline', '{}', 'h2', 'system', ?)")
				.bind(`mrev_${crypto.randomUUID()}`, userB, sharedId, now),
		]);
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ? AND revision = 1",
		).bind(sharedId).first();
		expect(rows.n).toBe(2);
	});

	it("one tenant still cannot record the same revision twice for one object", async () => {
		const userId = uid();
		const objectId = `node_${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare("INSERT INTO memory_revisions (id, user_id, object_kind, object_id, revision, action, snapshot_json, content_hash, actor_class, created_at) VALUES (?, ?, 'node', ?, 1, 'baseline', '{}', 'h', 'system', ?)")
			.bind(`mrev_${crypto.randomUUID()}`, userId, objectId, now).run();
		await expect(
			env.DB.prepare("INSERT INTO memory_revisions (id, user_id, object_kind, object_id, revision, action, snapshot_json, content_hash, actor_class, created_at) VALUES (?, ?, 'node', ?, 1, 'update', '{}', 'h', 'user', ?)")
				.bind(`mrev_${crypto.randomUUID()}`, userId, objectId, now).run(),
		).rejects.toThrow();
	});
});
