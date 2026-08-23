/**
 * SRV-08 — bulk delete vs in-flight extraction (deletion barrier + authoritative
 * enumeration).
 *
 * Production proof (SRV-08-delete-orphan-evidence.json): a bulk delete that ran
 * while an extraction was between claim and commit swept nothing of that run,
 * marked the run status='deleted' anyway, and the commit landed seconds later —
 * leaving a live, recallable node that every subsequent bulk delete reported as
 * zero. These regressions pin the repaired contract:
 *
 *   INV-2  work ACCEPTED before a confirmed unscoped delete (an erasure) must
 *          not produce durable rows after its barrier — queued, mid-flight,
 *          retried, or replayed;
 *   INV-3  repeated delete converges from live table state even when run
 *          manifests are missing or already status='deleted';
 *   INV-4  the preview never reports zero while matching live rows exist;
 *   D19    scoped deletes stay curation (no barrier); previews keep the
 *          "still processing" disclosure; genuinely new post-delete writes land.
 *
 * The race is driven deterministically: `overrides.llmResponse` may be an async
 * function invoked exactly at model-call time — while the run is 'running' with
 * empty manifests, the same window the production race hit — and the bulk
 * delete executes inside it as a plain function call, outside the DO, matching
 * the real topology (the delete route is a Worker handler, not a DO method).
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { bulkDeleteBySource } from "../src/pipeline/cleanup.js";
import { runExtraction } from "../src/pipeline/extract.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(method, path, body) {
	const request = new Request(`http://example.com${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let parsed = null;
	try { parsed = await response.json(); } catch {}
	return { status: response.status, body: parsed };
}

const stubFor = (userId) => env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

const drainWith = (userId, inlineOverrides) => runInDurableObject(
	stubFor(userId),
	(instance) => instance.drain({ userId, ignoreBackoff: true, inlineOverrides }),
);

async function settleJobs(userId, { rounds = 24 } = {}) {
	for (let i = 0; i < rounds; i++) {
		const pending = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched','failed','completed')",
		).bind(userId).first();
		if (Number(pending?.n ?? 0) === 0) return true;
		await runInDurableObject(stubFor(userId), (instance) => instance.alarm());
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

const LIVE_TABLES = ["nodes", "slices", "edges", "events", "memory_pages", "candidates"];
async function liveCounts(userId) {
	const out = {};
	for (const table of LIVE_TABLES) {
		const row = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId).first();
		out[table] = Number(row?.n ?? 0);
	}
	out.total = LIVE_TABLES.reduce((n, t) => n + out[t], 0);
	return out;
}

const previewTotal = (body) => Object.values(body?.would_delete ?? {})
	.reduce((n, v) => n + Number(v || 0), 0);

const extractionFor = (tag) => ({
	objects: [
		{ kind: "node", label: `${tag} beacon service`, category: "other", confidence: 0.9 },
		{ kind: "node", label: "Consul", category: "other", confidence: 0.9 },
		{ kind: "slice", on: `${tag} beacon service`, text: `${tag} beacon service uses Consul`, kind_detail: "technical_detail", confidence: 0.9 },
		{ kind: "edge", _v2: true, from: `${tag} beacon service`, to: "Consul", type: "USES", fact: `${tag} beacon service uses Consul`, confidence: 0.9 },
	],
	notes: "",
});

async function acceptSave(userId, tag, { key } = {}) {
	const res = await call("POST", "/v1/ingest", {
		userId, flush: true,
		conversationId: `srv08-${tag}`,
		idempotencyKey: key ?? `srv08-${tag}-${crypto.randomUUID()}`,
		messages: [{ id: `m-${tag}`, role: "user", content: `I decided the ${tag} beacon service uses Consul.` }],
	});
	expect(res.status).toBe(200);
	return res;
}

describe("SRV-08: erasure vs in-flight extraction", () => {
	it("fences an equal-millisecond erasure before primary inference", async () => {
		const userId = `srv08-equal-preflight-${crypto.randomUUID()}`;
		const acceptedAt = Date.now() - 10_000;
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv08-equal-preflight')",
		).bind(userId, acceptedAt, acceptedAt).run();
		let invocations = 0;

		const result = await runExtraction(env, userId, [
			{ id: "m-equal-preflight", role: "user", content: "The equal-time beacon uses Consul." },
		], [], {
			meta: { accepted_at: acceptedAt },
			llmResponse: async () => {
				invocations += 1;
				return extractionFor("equal-time");
			},
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});

		expect(invocations, "covered work reached primary inference").toBe(0);
		expect(result.outcome).toBe("cancelled_by_delete");
		expect((await liveCounts(userId)).total).toBe(0);
	});

	it("fences an equal-millisecond erasure after primary inference on the no-write path", async () => {
		const userId = `srv08-equal-postmodel-${crypto.randomUUID()}`;
		const acceptedAt = Date.now() - 10_000;
		let invocations = 0;

		const result = await runExtraction(env, userId, [
			{ id: "m-equal-postmodel", role: "user", content: "A deliberately non-durable equal-time note." },
		], [], {
			meta: { accepted_at: acceptedAt },
			llmResponse: async () => {
				invocations += 1;
				await env.DB.prepare(
					"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv08-equal-postmodel')",
				).bind(userId, acceptedAt, acceptedAt).run();
				return { objects: [], notes: "" };
			},
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});

		expect(invocations).toBe(1);
		expect(result.outcome).toBe("cancelled_by_delete");
		expect((await liveCounts(userId)).total).toBe(0);
	});

	it("A/B/D/E/F/G: a delete during the model call leaves nothing live, and the preview never lies", async () => {
		const userId = `srv08-race-${crypto.randomUUID()}`;
		const tag = "raceway";
		await acceptSave(userId, tag);

		// The delete fires exactly in the production window: run claimed
		// ('running', manifests '[]'), model call in flight.
		let deleteDuring = null;
		const drained = await drainWith(userId, {
			llmResponse: async () => {
				deleteDuring = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
				return extractionFor(tag);
			},
		});
		expect(deleteDuring?.ok).toBe(true);
		await settleJobs(userId);

		const live = await liveCounts(userId);
		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}`);
		const previewZero = previewTotal(preview.body) === 0;

		// INV-4 — the exact SRV-08 lie: live rows invisible to the preview.
		expect(previewZero && live.total > 0, "live rows invisible to the delete preview").toBe(false);
		// INV-2 — the barrier: work accepted before the erasure must not land after it.
		expect(live.total, "pre-barrier extraction landed after the erasure").toBe(0);
		// D — recall returns none of it.
		const recall = await call("POST", "/v1/recall", { userId, query: `What does the ${tag} beacon service use?` });
		expect(/consul|beacon/i.test(String(recall.body?.context ?? "")), "erased content recallable").toBe(false);
		// E — export exposes no live rows.
		const exportRes = await call("GET", `/v1/export?userId=${encodeURIComponent(userId)}`);
		const exported = LIVE_TABLES.reduce((n, t) => n + ((exportRes.body?.[t] ?? []).length), 0);
		expect(exported, "erased content exported").toBe(0);
		// The cancelled work is a VISIBLE terminal state, not silence (I23).
		const job = await env.DB.prepare(
			"SELECT status, error FROM memory_jobs WHERE user_id = ? AND type = 'extract' LIMIT 1",
		).bind(userId).first();
		if (job) {
			expect(["enriched", "failed", "completed"]).toContain(job.status);
			expect(String(job.error ?? "")).toMatch(/cancel/i);
		}
		// G — repeating the delete converges and stays honestly zero.
		const again = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(again.ok).toBe(true);
		expect((await liveCounts(userId)).total).toBe(0);
		expect(previewTotal((await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}`)).body)).toBe(0);

		expect(drained).toBeTruthy();
		await stubFor(userId).resetAll();
	});

	it("C/INV-3: rows referenced only by a status='deleted' run are discovered and removed (the specimen shape)", async () => {
		const userId = `srv08-orphan-${crypto.randomUUID()}`;
		const now = Date.now();
		const nodeId = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Webpack specimen', 'other', 'active', ?, ?)",
		).bind(nodeId, userId, now, now).run();
		await env.DB.prepare(
			`INSERT INTO extraction_runs (id, user_id, status, created_nodes_json, created_pages_json,
				created_slices_json, created_events_json, created_edges_json, created_candidates_json, created_at, updated_at)
			 VALUES (?, ?, 'deleted', ?, '[]', '[]', '[]', '[]', '[]', ?, ?)`,
		).bind(`run_extract_${crypto.randomUUID().replaceAll("-", "")}`, userId,
			JSON.stringify([{ id: nodeId, label: "Webpack specimen" }]), now, now).run();

		// INV-4: the preview must SEE it.
		const preview = await bulkDeleteBySource(env, userId, {});
		expect(preview.would_delete?.nodes ?? 0, "orphaned live node invisible to preview").toBeGreaterThan(0);
		// INV-1/INV-3: the confirm must REMOVE it.
		const confirmed = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(confirmed.ok).toBe(true);
		const after = await env.DB.prepare(
			"SELECT deleted_at FROM nodes WHERE id = ?",
		).bind(nodeId).first();
		expect(after?.deleted_at, "orphaned node survived the erasure").not.toBeNull();
		expect((await liveCounts(userId)).total).toBe(0);
	});

	it("INV-3: a live row with NO extraction run at all is removed by an unscoped delete", async () => {
		const userId = `srv08-norun-${crypto.randomUUID()}`;
		const now = Date.now();
		const nodeId = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Manifestless row', 'other', 'active', ?, ?)",
		).bind(nodeId, userId, now, now).run();

		const preview = await bulkDeleteBySource(env, userId, {});
		expect(preview.would_delete?.nodes ?? 0).toBeGreaterThan(0);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect((await liveCounts(userId)).total).toBe(0);
	});

	it("scoped curation: a source-scoped delete discovers rows through manifests of already-deleted runs", async () => {
		const userId = `srv08-scoped-${crypto.randomUUID()}`;
		const now = Date.now();
		const nodeId = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Scoped survivor', 'other', 'active', ?, ?)",
		).bind(nodeId, userId, now, now).run();
		await env.DB.prepare(
			`INSERT INTO extraction_runs (id, user_id, status, source_mode, created_nodes_json, created_pages_json,
				created_slices_json, created_events_json, created_edges_json, created_candidates_json, created_at, updated_at)
			 VALUES (?, ?, 'deleted', 'auto_ingest', ?, '[]', '[]', '[]', '[]', '[]', ?, ?)`,
		).bind(`run_extract_${crypto.randomUUID().replaceAll("-", "")}`, userId,
			JSON.stringify([{ id: nodeId, label: "Scoped survivor" }]), now, now).run();

		const preview = await bulkDeleteBySource(env, userId, { source: "auto_ingest" });
		expect(preview.would_delete?.nodes ?? 0, "scoped preview blind to deleted-run manifests").toBeGreaterThan(0);
		await bulkDeleteBySource(env, userId, { source: "auto_ingest", dryRun: false, confirm: true });
		const after = await env.DB.prepare("SELECT deleted_at FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(after?.deleted_at).not.toBeNull();
	});

	it("H: replaying a pre-erasure packet cannot resurrect erased content", async () => {
		const userId = `srv08-replay-${crypto.randomUUID()}`;
		const tag = "replays";
		const key = `srv08-replay-${crypto.randomUUID()}`;
		await acceptSave(userId, tag, { key });
		await drainWith(userId, {
			llmResponse: async () => {
				await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
				return extractionFor(tag);
			},
		});
		await settleJobs(userId);
		expect((await liveCounts(userId)).total).toBe(0);

		// The client replays the SAME accepted packet (same idempotency key and
		// message id). Whatever the gate answers, the invariant is: nothing
		// accepted before the barrier becomes live after it.
		const replay = await call("POST", "/v1/ingest", {
			userId, flush: true, conversationId: `srv08-${tag}`, idempotencyKey: key,
			messages: [{ id: `m-${tag}`, role: "user", content: `I decided the ${tag} beacon service uses Consul.` }],
		});
		expect(replay.status).toBeLessThan(500);
		await drainWith(userId, { llmResponse: extractionFor(tag) });
		await settleJobs(userId);
		expect((await liveCounts(userId)).total, "replayed pre-barrier packet resurrected content").toBe(0);
		await stubFor(userId).resetAll();
	});

	it("J/K: erasure with a backlog cancels queued pre-barrier work; nothing lands when the queue drains", async () => {
		const userId = `srv08-backlog-${crypto.randomUUID()}`;
		// Freeze the queue so all three saves are accepted-but-unprocessed.
		await runInDurableObject(stubFor(userId), async (_i, state) => {
			await state.storage.put("lease", { until: Date.now() + 120_000, token: "srv08-hold" });
		});
		await acceptSave(userId, "backlog-a");
		await acceptSave(userId, "backlog-b");
		await acceptSave(userId, "backlog-c");

		// SRV-06 continuity: the PREVIEW still names accepted work honestly.
		const preview = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}`);
		expect(preview.body?.pending_jobs).toBeGreaterThan(0);
		expect(String(preview.body?.note ?? "")).toMatch(/still processing/i);

		const confirmed = await call("DELETE", `/v1/memories?userId=${encodeURIComponent(userId)}&confirm=true`);
		expect(confirmed.status).toBe(200);

		// Release the queue and drain everything to terminal.
		await runInDurableObject(stubFor(userId), async (_i, state) => { await state.storage.delete("lease"); });
		await drainWith(userId, { llmResponse: extractionFor("backlog-a") });
		const settled = await settleJobs(userId);
		expect(settled, "backlog jobs never reached a terminal state").toBe(true);

		expect((await liveCounts(userId)).total, "queued pre-barrier work landed after the erasure").toBe(0);
		const jobs = await env.DB.prepare(
			"SELECT status, error FROM memory_jobs WHERE user_id = ? AND type = 'extract'",
		).bind(userId).all();
		for (const job of jobs.results ?? []) {
			expect(["enriched", "failed", "completed"]).toContain(job.status);
		}
		await stubFor(userId).resetAll();
	});

	it("L: a genuinely NEW post-erasure write lands normally", async () => {
		const userId = `srv08-fresh-${crypto.randomUUID()}`;
		await acceptSave(userId, "old-era");
		await drainWith(userId, { llmResponse: extractionFor("old-era") });
		await settleJobs(userId);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect((await liveCounts(userId)).total).toBe(0);

		await acceptSave(userId, "new-era");
		await drainWith(userId, { llmResponse: extractionFor("new-era") });
		await settleJobs(userId);
		const live = await liveCounts(userId);
		expect(live.total, "post-erasure write was wrongly fenced").toBeGreaterThan(0);
		const recall = await call("POST", "/v1/recall", { userId, query: "What does the new-era beacon service use?" });
		expect(/consul/i.test(String(recall.body?.context ?? ""))).toBe(true);
		await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		await stubFor(userId).resetAll();
	});

	it("M: a crash between barrier and sweep still converges on the next delete", async () => {
		const userId = `srv08-crash-${crypto.randomUUID()}`;
		const now = Date.now();
		// Phase 1 happened (barrier durable), then the process died: live rows remain.
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv08-test') " +
			"ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at",
		).bind(userId, now, now).run();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, 'Crash survivor', 'other', 'active', ?, ?)",
		).bind(`node_${crypto.randomUUID()}`, userId, now - 1000, now - 1000).run();

		const confirmed = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(confirmed.ok).toBe(true);
		expect((await liveCounts(userId)).total, "post-crash delete did not converge").toBe(0);
		expect(previewTotal(await bulkDeleteBySource(env, userId, {}))).toBe(0);
	});

	it("SRV-09 mechanism: an interactive write whose acceptedAt predates the barrier is refused atomically", async () => {
		// A9 finding: the barrier guard was nested under `if (extractionRunId)`,
		// so interactive writers could not opt into the fence at all — a
		// candidate promotion that READ its stored content before an erasure
		// could commit it back afterwards (a resurrection of erased content
		// through /v1/candidates/:id/promote, bounded to the ms-wide read→write
		// window but real). The fence must arm on acceptedAt alone.
		const { writeApproved } = await import("../src/pipeline/write.js");
		const { getConfig } = await import("../src/config.js");
		const userId = `srv09-fence-${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv09-test')",
		).bind(userId, now, now).run();

		const nodeId = `node_${crypto.randomUUID()}`;
		const plan = {
			newNodes: [{
				id: nodeId, user_id: userId, label: "Resurrected candidate", canonical_label: "resurrected candidate",
				category: "other", role: null, state: "active", summary: null,
				created_at: now, updated_at: now, last_seen_at: now,
				mention_count: 1, session_count: 1, heat_score: 1, cluster: null,
			}],
			affectedNodeIds: new Set([nodeId]),
		};
		await expect(
			writeApproved(env, getConfig(env), userId, plan, { acceptedAt: now - 5_000 }),
		).rejects.toThrow(/fence_guard|violation IS NULL/i);
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(userId).first();
		expect(Number(row?.n ?? -1), "the fenced interactive write must leave no rows").toBe(0);
	});

	it("SRV-09 mechanism: an interactive write accepted in the deletion millisecond is refused atomically", async () => {
		const { writeApproved } = await import("../src/pipeline/write.js");
		const { getConfig } = await import("../src/config.js");
		const userId = `srv09-equal-fence-${crypto.randomUUID()}`;
		const acceptedAt = Date.now();
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv09-equal-test')",
		).bind(userId, acceptedAt, acceptedAt).run();

		const nodeId = `node_${crypto.randomUUID()}`;
		const plan = {
			newNodes: [{
				id: nodeId, user_id: userId, label: "Equal-time candidate", canonical_label: "equal-time candidate",
				category: "other", role: null, state: "active", summary: null,
				created_at: acceptedAt, updated_at: acceptedAt, last_seen_at: acceptedAt,
				mention_count: 1, session_count: 1, heat_score: 1, cluster: null,
			}],
			affectedNodeIds: new Set([nodeId]),
		};
		await expect(
			writeApproved(env, getConfig(env), userId, plan, { acceptedAt }),
		).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare("SELECT id FROM nodes WHERE id = ?").bind(nodeId).first()).toBeNull();
	});

	it("SRV-09: a promotion that read its candidate before the erasure cannot resurrect it", async () => {
		const { promoteCandidate } = await import("../src/pipeline/candidates.js");
		const userId = `srv09-promo-${crypto.randomUUID()}`;
		const now = Date.now();
		// The candidate is LIVE (as the handler's guarded read found it)…
		await env.DB.prepare(
			"INSERT INTO candidates (id, user_id, label, strength, mentions, created_at) VALUES (?, ?, 'harbor sensor array', 'strong', 3, ?)",
		).bind(`cand_${crypto.randomUUID().slice(0, 8)}`, userId, now - 60_000).run();
		const cand = await env.DB.prepare("SELECT id FROM candidates WHERE user_id = ?").bind(userId).first();
		// …and the erasure's barrier lands between that read and the write.
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv09-test')",
		).bind(userId, now, now).run();

		const res = await promoteCandidate(env, userId, cand.id, {}, { acceptedAt: now - 2_000 });
		expect(res.ok, "pre-barrier promotion must be refused").toBe(false);
		expect(Number(res.status)).toBe(409);
		expect(String(res.error)).toMatch(/erase|delete/i);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(Number(nodes?.n ?? -1), "no resurrected node may exist").toBe(0);
	});

	it("SRV-09 contract: promotion AFTER an old erasure still works — the fence never blocks new actions", async () => {
		const { promoteCandidate } = await import("../src/pipeline/candidates.js");
		const userId = `srv09-fresh-${crypto.randomUUID()}`;
		const past = Date.now() - 60_000;
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by) VALUES (?, ?, ?, 'srv09-test')",
		).bind(userId, past, past).run();
		// A candidate that appeared AFTER the erasure (new capture), promoted by
		// a live user action: acceptedAt > barrier_at, must succeed.
		await env.DB.prepare(
			"INSERT INTO candidates (id, user_id, label, strength, mentions, created_at) VALUES (?, ?, 'fresh lighthouse feed', 'strong', 2, ?)",
		).bind(`cand_${crypto.randomUUID().slice(0, 8)}`, userId, Date.now()).run();
		const cand = await env.DB.prepare("SELECT id FROM candidates WHERE user_id = ?").bind(userId).first();
		const res = await promoteCandidate(env, userId, cand.id, {});
		expect(res.ok, "post-erasure promotion of new content must land").toBe(true);
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
		).bind(userId).first();
		expect(Number(nodes?.n ?? 0)).toBeGreaterThan(0);
	});

	it("SRV-09 first line of defense: an erased candidate is not promotable at all", async () => {
		const { promoteCandidate } = await import("../src/pipeline/candidates.js");
		const userId = `srv09-gone-${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO candidates (id, user_id, label, strength, mentions, created_at, deleted_at) VALUES (?, ?, 'erased relic', 'weak', 1, ?, ?)",
		).bind(`cand_${crypto.randomUUID().slice(0, 8)}`, userId, now - 60_000, now).run();
		const cand = await env.DB.prepare("SELECT id FROM candidates WHERE user_id = ?").bind(userId).first();
		const res = await promoteCandidate(env, userId, cand.id, {});
		expect(res.ok).toBe(false);
		expect(Number(res.status)).toBe(404);
	});

	it("N: erasing tenant A leaves tenant B untouched, including B's in-flight work", async () => {
		const a = `srv08-tenant-a-${crypto.randomUUID()}`;
		const b = `srv08-tenant-b-${crypto.randomUUID()}`;
		await acceptSave(b, "bystander");
		await drainWith(b, { llmResponse: extractionFor("bystander") });
		await settleJobs(b);
		const bBefore = await liveCounts(b);
		expect(bBefore.total).toBeGreaterThan(0);

		await acceptSave(a, "target");
		// A's erasure fires during A's in-flight extraction; B has a save in
		// flight at the same time and must land normally.
		await acceptSave(b, "bystander-late");
		await drainWith(a, {
			llmResponse: async () => {
				await bulkDeleteBySource(env, a, { dryRun: false, confirm: true });
				return extractionFor("target");
			},
		});
		await drainWith(b, { llmResponse: extractionFor("bystander-late") });
		await settleJobs(a);
		await settleJobs(b);

		expect((await liveCounts(a)).total, "tenant A residue").toBe(0);
		const bAfter = await liveCounts(b);
		expect(bAfter.total, "tenant B lost rows to A's erasure").toBeGreaterThanOrEqual(bBefore.total);
		const recallB = await call("POST", "/v1/recall", { userId: b, query: "What does the bystander-late beacon service use?" });
		expect(/consul/i.test(String(recallB.body?.context ?? "")), "tenant B's in-flight save was fenced by A's barrier").toBe(true);
		await bulkDeleteBySource(env, b, { dryRun: false, confirm: true });
		await stubFor(a).resetAll();
		await stubFor(b).resetAll();
	});
});
