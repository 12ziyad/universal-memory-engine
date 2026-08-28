/**
 * Memory exports.
 *
 * The job runs in the Durable Object rather than inline, so the specs check
 * the whole loop: create → the DO builds it → the row completes → the file
 * downloads and parses. Plus the two refusals that matter: another account's
 * export, and a graph too large to hold (which must fail loudly rather than
 * hand back a truncated copy of someone's memory).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { EXPORT_TABLES, exportMaxBytes, runExport } from "../src/pipeline/exports.js";

async function request(path, init = {}, overrideEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, overrideEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function authed(body) {
	return {
		method: "POST",
		headers: { "x-api-key": env.API_KEY, "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

const KEY = { headers: { "x-api-key": env.API_KEY } };

async function seed(userId) {
	await request("/v1/save", authed({
		userId,
		content: "I started boxing training this month.",
		_test: {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
					{ kind: "slice", on: "Boxing", text: "Trains three days a week", kind_detail: "progress", confidence: 0.95 },
				],
			},
		},
	}));
}

async function createFor(userId) {
	const res = await request("/v1/exports", authed({ userId }));
	expect(res.status).toBe(201);
	return (await res.json()).export;
}

async function seedSoftDeletedExportRows(userId, memoryMarker, auditMarker) {
	const now = Date.now();
	const suffix = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
		).bind(`node-export-${suffix}`, userId, memoryMarker, now, now, now),
		env.DB.prepare(
			"INSERT INTO slices (id, user_id, text, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
		).bind(`slice-export-${suffix}`, userId, memoryMarker, now, now),
		env.DB.prepare(
			"INSERT INTO events (id, user_id, text, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
		).bind(`event-export-${suffix}`, userId, memoryMarker, now, now),
		env.DB.prepare(
			"INSERT INTO edges (id, user_id, type, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
		).bind(`edge-export-${suffix}`, userId, memoryMarker, now, now),
		env.DB.prepare(
			`INSERT INTO memory_pages
			 (id, user_id, title, canonical_title, created_at, updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(`page-export-${suffix}`, userId, memoryMarker, memoryMarker.toLowerCase(), now, now, now),
		env.DB.prepare(
			"INSERT INTO candidates (id, user_id, label, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)",
		).bind(`candidate-export-${suffix}`, userId, memoryMarker, now, now),
		env.DB.prepare(
			`INSERT INTO receipts (id, user_id, source, outcome, summary, created_at)
			 VALUES (?, ?, 'save_memory', 'wrote', ?, ?)`,
		).bind(`receipt-export-${suffix}`, userId, auditMarker, now),
		env.DB.prepare(
			`INSERT INTO memory_rules (user_id, custom_instructions, created_at, updated_at)
			 VALUES (?, ?, ?, ?)`,
		).bind(userId, auditMarker, now, now),
	]);
}

function expectSoftDeletedMemoryAbsent(payload, memoryMarker, auditMarker) {
	for (const table of ["nodes", "slices", "events", "edges", "memory_pages", "candidates"]) {
		expect(payload[table]).toEqual([]);
		expect(JSON.stringify(payload[table])).not.toContain(memoryMarker);
	}
	expect(payload.receipts.some((row) => row.summary === auditMarker)).toBe(true);
	expect(payload.memory_rules.some((row) => row.custom_instructions === auditMarker)).toBe(true);
}

async function listFor(userId) {
	return (await (await request(`/v1/exports?userId=${userId}`, KEY)).json()).exports;
}

describe("export jobs", () => {
	it("omits soft-deleted memory objects from synchronous and job exports", async () => {
		const userId = `ex-deleted-${crypto.randomUUID()}`;
		const memoryMarker = `SOFT_DELETED_MEMORY_${crypto.randomUUID()}`;
		const auditMarker = `AUDIT_ROW_${crypto.randomUUID()}`;
		await seedSoftDeletedExportRows(userId, memoryMarker, auditMarker);

		const synchronous = await request(`/v1/export?userId=${encodeURIComponent(userId)}`, KEY);
		expect(synchronous.status).toBe(200);
		expectSoftDeletedMemoryAbsent(await synchronous.json(), memoryMarker, auditMarker);

		const job = await createFor(userId);
		const download = await request(
			`/v1/exports/download?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(job.id)}`,
			KEY,
		);
		expect(download.status).toBe(200);
		expectSoftDeletedMemoryAbsent(await download.json(), memoryMarker, auditMarker);
	});

	it("creates, builds in the Durable Object, and downloads", async () => {
		const userId = `ex-run-${crypto.randomUUID()}`;
		await seed(userId);

		const job = await createFor(userId);
		expect(job.status).toBe("queued");
		expect(job.format).toBe("json");

		const rows = await listFor(userId);
		const row = rows.find((r) => r.id === job.id);
		expect(row.status).toBe("complete");
		expect(row.object_count).toBeGreaterThan(0);
		expect(row.size_bytes).toBeGreaterThan(0);
		expect(row.completed_at).toBeTruthy();
		// The list is metadata: the file itself is not shipped with every poll.
		expect(row.data).toBeUndefined();

		const file = await request(`/v1/exports/download?userId=${userId}&id=${job.id}`, KEY);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-disposition")).toContain("itsuki-export-");
		const payload = await file.json();
		expect(payload.format).toBe("itsuki-export");
		for (const table of EXPORT_TABLES) expect(Array.isArray(payload[table])).toBe(true);
		expect(payload.nodes.some((n) => n.label === "Boxing")).toBe(true);
	});

	it("says it is not ready instead of serving half a file", async () => {
		const userId = `ex-pending-${crypto.randomUUID()}`;
		const id = "export_pending_probe";
		await env.DB.prepare(
			"INSERT INTO memory_exports (id, user_id, status, format, entity, created_at) VALUES (?, ?, 'running', 'json', 'All memories', ?)",
		).bind(id, userId, Date.now()).run();
		const res = await request(`/v1/exports/download?userId=${userId}&id=${id}`, KEY);
		expect(res.status).toBe(409);
		expect((await res.json()).message).toContain("still being built");
	});

	it("fails loudly rather than truncating a graph it cannot hold", async () => {
		const userId = `ex-big-${crypto.randomUUID()}`;
		await seed(userId);
		const job = await createFor(userId);
		// Re-run the same job under a ceiling nothing can fit under.
		const result = await runExport({ ...env, EXPORT_MAX_BYTES: "10" }, userId, job.id);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("too_large");
		const row = (await listFor(userId)).find((r) => r.id === job.id);
		expect(row.status).toBe("failed");
		// The pointer names the real control by its real label.
		expect(row.error).toContain("Export current memory space");
		expect(row.error).not.toContain("Export everything");
		const download = await request(`/v1/exports/download?userId=${userId}&id=${job.id}`, KEY);
		expect(download.status).toBe(409);
	});

	it("reads a sane ceiling from env", () => {
		expect(exportMaxBytes({})).toBe(1_500_000);
		expect(exportMaxBytes({ EXPORT_MAX_BYTES: "2000" })).toBe(2000);
		expect(exportMaxBytes({ EXPORT_MAX_BYTES: "nope" })).toBe(1_500_000);
	});

	it("never hands an export to another account", async () => {
		const mine = `ex-mine-${crypto.randomUUID()}`;
		const theirs = `ex-theirs-${crypto.randomUUID()}`;
		await seed(mine);
		const job = await createFor(mine);

		expect(await listFor(theirs)).toEqual([]);
		const stolen = await request(`/v1/exports/download?userId=${theirs}&id=${job.id}`, KEY);
		expect(stolen.status).toBe(404);
		const anon = await request(`/v1/exports?userId=${mine}`);
		expect(anon.status).toBe(401);
	});
});

describe("the exports screen", () => {
	async function page() {
		const { default: html } = await import("../public/index.html?raw");
		return { html, script: html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "" };
	}

	it("is a rail item under Activity with the six columns", async () => {
		const { html, script } = await page();
		expect(html).toContain('data-view="exports"');
		expect(script).toContain('exports: "Memory exports"');
		expect(script).toContain("<th>ID</th><th>Status</th><th>Entity</th><th>Started</th><th>Completed</th>");
		expect(script).toContain("function viewExports(");
	});

	it("has a create button, a refresh, and a download that only appears when ready", async () => {
		const { script } = await page();
		expect(script).toContain("function createExportJob(");
		expect(script).toContain('onclick="loadExports()"');
		expect(script).toContain('row.status === "complete"');
		expect(script).toContain("/v1/exports/download?id=");
	});

	it("polls only while a job is in flight", async () => {
		const { script } = await page();
		expect(script).toContain("function scheduleExportPoll(");
		expect(script).toContain('row.status === "queued" || row.status === "running"');
		expect(script).toContain("if (!pending || S.view !== \"exports\") return;");
	});

	it("tells a first-time visitor what an export is for", async () => {
		const { script } = await page();
		expect(script).toContain("An export is a JSON copy of the currently resolved memory space");
		expect(script).toContain("No exports yet.");
	});
});
