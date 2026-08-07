/**
 * REC-01 — project startup recall must return the project's memory, not the
 * results of a similarity search against a boilerplate sentence.
 *
 * Both plugins open a session by asking `/v1/recall` for
 *   "project decisions, conventions, architecture, and fixes for <name>"
 * and injecting whatever comes back. That is a QUERY, but the intent is a
 * LOOKUP: "show me what this project knows." For scoped recall the engine
 * deliberately skips BM25 (search profiles carry no project column), so the
 * only signals left are exact-label and keyword overlap — and ordinary project
 * memory shares no words with that sentence. Measured live: a project decision
 * ALONE in its project returned count 0 for the boilerplate query while an
 * exact query returned it.
 *
 * Fixture rule for this file: memories must NOT contain the project name or
 * any boilerplate word ("decision", "convention", "architecture", "fix"), or
 * the test would pass for the wrong reason — lexical overlap — and hide the
 * defect it exists to catch.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const PROJECT_ID = "local_recbootstrap0000000000000001";
const PROJECT_NAME = "shared-repo";
const scope = { projectId: PROJECT_ID, projectName: PROJECT_NAME, appId: "claude-code-plugin", sourceScope: "project" };
// The exact sentence both plugins send.
const BOILERPLATE = `project decisions, conventions, architecture, and fixes for ${PROJECT_NAME}`;

async function call(path, body) {
	const request = new Request(`http://example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function seedProjectMemory(userId) {
	// Ordinary project content: no project name, no boilerplate vocabulary.
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, aliases_json, created_at, updated_at,
			last_seen_at, heat_score, project_id, project_name)
		 VALUES (?, ?, ?, 'other', 'active', ?, '[]', ?, ?, ?, ?, ?, ?)`,
	).bind(
		`node_${crypto.randomUUID()}`, userId, "Porcelain drawbridge booking service",
		"Retries failed payments exactly twice before alerting the on-call engineer.",
		now, now, now, 5, PROJECT_ID, PROJECT_NAME,
	).run();
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, aliases_json, created_at, updated_at,
			last_seen_at, heat_score, project_id, project_name)
		 VALUES (?, ?, ?, 'other', 'active', ?, '[]', ?, ?, ?, ?, ?, ?)`,
	).bind(
		`node_${crypto.randomUUID()}`, userId, "Nightly ledger export",
		"Runs at 02:00 and writes to the cold bucket.",
		now - 1000, now - 1000, now - 1000, 3, PROJECT_ID, PROJECT_NAME,
	).run();
	// A memory in ANOTHER project must never leak into this project's startup.
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, aliases_json, created_at, updated_at,
			last_seen_at, heat_score, project_id, project_name)
		 VALUES (?, ?, ?, 'other', 'active', ?, '[]', ?, ?, ?, ?, ?, ?)`,
	).bind(
		`node_${crypto.randomUUID()}`, userId, "Sandstone weather kiosk",
		"Belongs to an unrelated project.",
		now, now, now, 9, "local_recbootstrap0000000000000002", "other-repo",
	).run();
}

describe("project startup recall returns the project's memory", () => {
	it("surfaces ordinary project memory that shares no words with the startup query", async () => {
		const userId = `bootstrap-${crypto.randomUUID()}`;
		await seedProjectMemory(userId);

		const recalled = await call("/v1/recall", {
			userId,
			query: BOILERPLATE,
			memoryScope: scope,
			recallScope: "project_then_global",
			recallMode: "project_bootstrap",
		});
		expect(recalled.status).toBe(200);
		const context = String(recalled.body?.context ?? "");
		expect(context).toMatch(/porcelain drawbridge/i);
		expect(context).toMatch(/nightly ledger/i);
		expect(recalled.body.count).toBeGreaterThan(0);
	});

	it("still refuses to cross project boundaries", async () => {
		const userId = `bootstrap-scope-${crypto.randomUUID()}`;
		await seedProjectMemory(userId);

		const recalled = await call("/v1/recall", {
			userId,
			query: BOILERPLATE,
			memoryScope: scope,
			recallScope: "project_only",
			recallMode: "project_bootstrap",
		});
		const context = String(recalled.body?.context ?? "");
		expect(context).toMatch(/porcelain drawbridge/i);
		// The higher-heat node in the other project must not be borrowed.
		expect(context).not.toMatch(/sandstone weather kiosk/i);
	});

	it("leaves ordinary targeted queries alone (no unsolicited dump)", async () => {
		const userId = `bootstrap-targeted-${crypto.randomUUID()}`;
		await seedProjectMemory(userId);

		// Same scope, a REAL question that matches nothing: without the explicit
		// bootstrap intent the engine must keep answering honestly with nothing,
		// rather than injecting whatever the project happens to hold.
		const recalled = await call("/v1/recall", {
			userId,
			query: "What is the airspeed velocity of an unladen swallow?",
			memoryScope: scope,
			recallScope: "project_only",
		});
		expect(String(recalled.body?.context ?? "")).not.toMatch(/porcelain drawbridge|nightly ledger/i);
	});

	it("puts the project's own memory ahead of higher-heat global memory", async () => {
		// The plugins ask for project_then_global, so global memory competes for
		// the same bounded context. Live reproduction showed ten hotter global
		// nodes displacing the project's only node entirely — a session opened
		// in a project would show everything EXCEPT that project. Startup
		// context must lead with the project; global is supporting material.
		const userId = `bootstrap-priority-${crypto.randomUUID()}`;
		await seedProjectMemory(userId);
		const now = Date.now();
		for (let i = 0; i < 10; i++) {
			await env.DB.prepare(
				`INSERT INTO nodes (id, user_id, label, category, state, summary, aliases_json, created_at,
					updated_at, last_seen_at, heat_score, project_id, project_name)
				 VALUES (?, ?, ?, 'other', 'active', ?, '[]', ?, ?, ?, ?, NULL, NULL)`,
			).bind(
				`node_${crypto.randomUUID()}`, userId, `Global hot topic ${i}`,
				"Account-wide memory with a much higher heat score.", now, now, now, 99,
			).run();
		}

		const recalled = await call("/v1/recall", {
			userId,
			query: BOILERPLATE,
			memoryScope: scope,
			recallScope: "project_then_global",
			recallMode: "project_bootstrap",
		});
		const context = String(recalled.body?.context ?? "");
		expect(context).toMatch(/porcelain drawbridge/i);
	});

	it("returns an empty context for a project with no memory", async () => {
		const userId = `bootstrap-empty-${crypto.randomUUID()}`;
		const recalled = await call("/v1/recall", {
			userId,
			query: BOILERPLATE,
			memoryScope: scope,
			recallScope: "project_then_global",
			recallMode: "project_bootstrap",
		});
		expect(recalled.status).toBe(200);
		expect(String(recalled.body?.context ?? "")).toBe("");
	});
});
