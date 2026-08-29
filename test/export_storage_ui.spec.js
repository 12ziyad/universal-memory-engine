/* The export that could not export, and the UI around it.
 *
 * "Create export" failed on a real 2.7MB memory space while "Download
 * directly" worked, because the job stored the whole file in a D1 TEXT column
 * with a ~2MB row ceiling. The person was told their memory was too large;
 * the truth was that we had chosen a place to put it that could not hold it.
 * And a direct download left no record at all, so the history page showed
 * only the failures.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";
import { runExport, createExport, readExportBody, recordDirectExport, r2KeyFor, invalidateStoredExports } from "../src/pipeline/exports.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function seed(userId, label = "Zanzibar") {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', NULL, 'active', 'export specimen', ?, ?)`,
	).bind(`node_${crypto.randomUUID().slice(0, 12)}`, userId, label, now, now).run();
}

describe("the job path", () => {
	it("puts the file in R2 and the row keeps only the pointer", async () => {
		const userId = `r2-${crypto.randomUUID()}`;
		await seed(userId);
		const job = await createExport(env, userId, {});
		const result = await runExport(env, userId, job.id);

		expect(result.ok).toBe(true);
		expect(result.storage).toBe("r2");
		const row = await env.DB.prepare("SELECT status, r2_key, data, size_bytes FROM memory_exports WHERE id = ?").bind(job.id).first();
		expect(row.status).toBe("complete");
		expect(row.r2_key).toBe(r2KeyFor(userId, job.id));
		// The bytes are NOT in the row any more — that column was the ceiling.
		expect(row.data).toBeNull();
		expect(row.size_bytes).toBeGreaterThan(0);

		const body = await readExportBody(env, row);
		expect(JSON.parse(body).nodes.some((n) => n.label === "Zanzibar")).toBe(true);
	});

	it("is not limited by the old D1 row ceiling", async () => {
		// A ceiling that would once have failed the job outright.
		const userId = `big-${crypto.randomUUID()}`;
		await seed(userId);
		const job = await createExport(env, userId, {});
		const result = await runExport({ ...env, EXPORT_MAX_BYTES: "1" }, userId, job.id);
		expect(result.ok).toBe(true);
		expect(result.storage).toBe("r2");
	});

	it("exports a space genuinely larger than a D1 row can hold", async () => {
		// The reported case, reproduced by size rather than by configuration:
		// ~3MB of real rows, which is what a 2.7MB memory space looks like and
		// what used to fail with "larger than an export job can hold here".
		const userId = `huge-${crypto.randomUUID()}`;
		const now = Date.now();
		const filler = "x".repeat(3000);
		for (let batch = 0; batch < 10; batch++) {
			await env.DB.batch(Array.from({ length: 100 }, (_, i) =>
				env.DB.prepare(
					`INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', NULL, 'active', ?, ?, ?)`,
				).bind(`node_${batch}_${i}_${crypto.randomUUID().slice(0, 8)}`, userId, `Node ${batch}-${i}`, filler, now, now)));
		}
		const job = await createExport(env, userId, {});
		const result = await runExport(env, userId, job.id);

		expect(result.ok).toBe(true);
		// Comfortably past the ~2MB D1 row ceiling that used to be the barrier.
		expect(result.bytes).toBeGreaterThan(2_000_000);
		const row = await env.DB.prepare("SELECT * FROM memory_exports WHERE id = ?").bind(job.id).first();
		expect(row.status).toBe("complete");
		expect(row.error).toBeNull();
		expect(row.size_bytes).toBeGreaterThan(2_000_000);
		// And it is really downloadable, not merely marked complete.
		const body = await readExportBody(env, row);
		expect(body.length).toBeGreaterThan(2_000_000);
		expect(JSON.parse(body).nodes.length).toBe(1000);
	});

	it("answers honestly when a complete row has no bytes behind it", async () => {
		const userId = `gone-${crypto.randomUUID()}`;
		await seed(userId);
		const job = await createExport(env, userId, {});
		await runExport(env, userId, job.id);
		// Retention scrubs the object but leaves the row complete.
		await env.EXPORTS.delete(r2KeyFor(userId, job.id));
		const row = await env.DB.prepare("SELECT * FROM memory_exports WHERE id = ?").bind(job.id).first();
		expect(await readExportBody(env, row)).toBeNull();
	});

	it("still reads a legacy inline export written before the bucket existed", async () => {
		const userId = `legacy-${crypto.randomUUID()}`;
		const id = `export_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO memory_exports (id, user_id, status, format, entity, data, created_at) VALUES (?, ?, 'complete', 'json', 'All memories', ?, ?)",
		).bind(id, userId, JSON.stringify({ format: "itsuki-export", nodes: [] }), Date.now()).run();
		const row = await env.DB.prepare("SELECT * FROM memory_exports WHERE id = ?").bind(id).first();
		expect(JSON.parse(await readExportBody(env, row)).format).toBe("itsuki-export");
	});
});

describe("deletion reaches the stored file", () => {
	it("removes the R2 object, not just the row", async () => {
		const userId = `del-${crypto.randomUUID()}`;
		await seed(userId, "Erasable");
		const job = await createExport(env, userId, {});
		await runExport(env, userId, job.id);
		const key = r2KeyFor(userId, job.id);
		expect(await env.EXPORTS.get(key)).toBeTruthy();

		await invalidateStoredExports(env, userId, "memory_deleted");

		// An erased memory must not survive as a prepared file in a bucket.
		expect(await env.EXPORTS.get(key)).toBeNull();
		const row = await env.DB.prepare("SELECT status, r2_key, data FROM memory_exports WHERE id = ?").bind(job.id).first();
		expect(row.status).toBe("expired");
		expect(row.r2_key).toBeNull();
		expect(row.data).toBeNull();
	});
});

describe("direct downloads are history too", () => {
	it("records a row so the page can answer 'did it work?'", async () => {
		const userId = `direct-${crypto.randomUUID()}`;
		await recordDirectExport(env, userId, { objectCount: 7, bytes: 4242 });
		const row = await env.DB.prepare("SELECT kind, status, object_count, delivered_bytes FROM memory_exports WHERE user_id = ?").bind(userId).first();
		expect(row.kind).toBe("direct");
		expect(row.status).toBe("complete");
		expect(row.object_count).toBe(7);
		expect(row.delivered_bytes).toBe(4242);
	});

	it("never fails the download because the receipt could not be filed", async () => {
		const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } };
		await expect(recordDirectExport(broken, "u", {})).resolves.toBeNull();
	});
});

describe("the console surfaces this pass changed", () => {
	it("rebuilt the admin Overview into labelled sections", () => {
		// It was ten equal-weight cards with two different signup funnels.
		expect(html).toContain("Everything that means something is wrong, in one place.");
		for (const heading of ["Traffic", "Accounts", "Memory", "Health"]) {
			expect(html).toContain(`${heading}"`);
		}
		expect(html).not.toContain("<h3>Signed up → activated → errored</h3>");
	});

	it("stopped Huba re-greeting itself on every open", () => {
		// hubaAppend writes to the DOM and never touches HUBA.history, so the
		// old history-length guard added a greeting every single time.
		expect(html).toContain('!$("#hubaLog")?.children.length');
	});

	it("explains the empty transfer picker instead of showing a dead control", () => {
		expect(html).toContain("There is nobody to transfer to yet");
		expect(html).toContain("Offer transfer");
		expect(html).toContain("only once they accept");
	});
});
