/**
 * Does an explicit user edit survive AUTOMATIC summary regeneration?
 *
 * The closure canary's C7 failed: after a user corrected a node's summary, a
 * later save about the same subject replaced it with machine-derived text.
 * These tests separate the two possible causes, because they need different
 * answers:
 *
 *   stale  — the writer computed from an OLD revision and landed after the
 *            edit. It must lose. (Already fenced; asserted here again.)
 *   fresh  — the writer recomputed from NEWLY committed facts. It is not
 *            stale, so the CAS cannot catch it — yet silently replacing a
 *            correction the user typed is exactly what "safe memory updates"
 *            promises not to do.
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";

const legacyHeaders = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const idem = () => `idem-${crypto.randomUUID()}`;
let seed = 0;
const uid = () => `authored-${++seed}-${crypto.randomUUID().slice(0, 8)}`;

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers: legacyHeaders, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function seedNode(userId, { summary = "Machine summary.", revision = null } = {}) {
	const id = `node_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, revision)
		 VALUES (?, ?, 'Subject', 'tool', 'active', ?, ?, ?, ?)`,
	).bind(id, userId, summary, Date.now(), Date.now(), revision).run();
	return id;
}

async function addSlice(userId, nodeId, text) {
	await env.DB.prepare(
		"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, 'technical_detail', 1, ?)",
	).bind(`slice_${crypto.randomUUID()}`, userId, nodeId, text, Date.now()).run();
}

describe("user-authored summaries versus automatic regeneration", () => {
	it("a STALE regeneration loses to the user's edit (the CAS case)", async () => {
		const { regenerateNodeSummaryFenced } = await import("../src/pipeline/cleanup.js");
		const userId = uid();
		const nodeId = await seedNode(userId);
		const observed = 1;
		const edit = await request(`/v1/memories/${nodeId}?userId=${userId}`, {
			method: "PATCH",
			headers: { ...legacyHeaders, "if-match": '"r1"' },
			body: JSON.stringify({ summary: "The user's own words.", idempotencyKey: idem() }),
		});
		expect(edit.status).toBe(200);
		const applied = await regenerateNodeSummaryFenced(env, userId, nodeId, {
			summary: "Machine text from a stale read.", sourcesJson: "[]", observedRevision: observed,
		});
		expect(applied.stale).toBe(true);
		const row = await env.DB.prepare("SELECT summary FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("The user's own words.");
	});

	it("a FRESH pass2 regeneration must not silently replace a user-authored summary", async () => {
		const { runPass2 } = await import("../src/pipeline/pass2.js");
		const { getConfig } = await import("../src/config.js");
		const userId = uid();
		const nodeId = await seedNode(userId);

		// The user corrects the summary through the safe-update door.
		const edit = await request(`/v1/memories/${nodeId}?userId=${userId}`, {
			method: "PATCH",
			headers: { ...legacyHeaders, "if-match": '"r1"' },
			body: JSON.stringify({ summary: "USER-AUTHORED: exactly how I want it phrased.", idempotencyKey: idem() }),
		});
		expect(edit.status).toBe(200);

		// New evidence arrives and pass2 runs against the CURRENT head — not
		// stale, so the revision CAS cannot help here.
		await addSlice(userId, nodeId, "A newly extracted technical detail.");
		await runPass2(env, getConfig(env), userId, [nodeId]);

		const row = await env.DB.prepare("SELECT summary FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary,
			"an explicit correction must not be overwritten by automatic regeneration").toBe(
			"USER-AUTHORED: exactly how I want it phrased.");
	});

	it("automatic regeneration resumes once the user's authorship is withdrawn", async () => {
		const { runPass2 } = await import("../src/pipeline/pass2.js");
		const { getConfig } = await import("../src/config.js");
		const userId = uid();
		const nodeId = await seedNode(userId);
		await request(`/v1/memories/${nodeId}?userId=${userId}`, {
			method: "PATCH",
			headers: { ...legacyHeaders, "if-match": '"r1"' },
			body: JSON.stringify({ summary: "USER-AUTHORED: pinned.", idempotencyKey: idem() }),
		});
		// Rolling back to the machine-written baseline releases the pin: the
		// current head is no longer a user-authored summary.
		const rollback = await request(`/v1/memories/${nodeId}/rollback?userId=${userId}`, {
			method: "POST",
			headers: { ...legacyHeaders, "if-match": '"r2"' },
			body: JSON.stringify({ toRevision: 1, idempotencyKey: idem() }),
		});
		expect(rollback.status).toBe(200);

		await addSlice(userId, nodeId, "Fresh detail after the rollback.");
		await runPass2(env, getConfig(env), userId, [nodeId]);
		const row = await env.DB.prepare("SELECT summary FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary, "regeneration must resume when no user summary is current").not.toBe("USER-AUTHORED: pinned.");
	});
});
