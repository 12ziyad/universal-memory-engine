/**
 * A11 / OPS-02 — the operator surface.
 *
 * The gap this closes: an integrator running sub-tenants could see per-tenant
 * detail only if they already knew which tenant to ask about, and could not see
 * their account's backlog, stuck work, cancellations, or erasures anywhere
 * aggregated. Diagnosing "is my memory system healthy?" required direct D1
 * access — which is not an operator surface.
 *
 * Two things are proven here:
 *   1. `GET /v1/ops/overview` answers the operator questions, per tenant and in
 *      aggregate, WITHOUT weakening isolation and WITHOUT returning content.
 *   2. A cancellation (`cancelled_by_delete`) is distinguishable from an
 *      ordinary failure at the API layer — as a first-class boolean and a
 *      filter, NOT as a new terminal status (A10 proved a new terminal word
 *      would hang every 0.2.1 SDK's poller).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const json = { "content-type": "application/json" };

async function call(path, init = {}) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let body = null;
	try { body = await response.json(); } catch {}
	return { status: response.status, body };
}

function cookieFrom(headers) {
	return headers.get("set-cookie")?.split(";")[0] || "";
}

/** A real account with a real Bearer token — sub-tenant scoping only exists
 *  under token auth, and A1's lesson is that door regressions must not lean on
 *  the legacy x-api-key path (that gap is how SRV-04 escaped). */
async function account(prefix) {
	const request = new Request("http://example.com/auth/signup", {
		method: "POST",
		headers: json,
		body: JSON.stringify({
			email: `${prefix}-${crypto.randomUUID()}@example.com`,
			password: "correct-horse",
			name: prefix,
			acceptTerms: true,
		}),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	const body = await response.json();
	expect(response.status).toBe(201);
	const cookie = cookieFrom(response.headers);

	const made = await call("/auth/tokens", {
		method: "POST",
		headers: { ...json, cookie },
		body: JSON.stringify({ type: "api", label: `${prefix}-ops` }),
	});
	expect(made.status).toBeLessThan(300);
	return { user: body.user, cookie, token: made.body.token };
}

const canned = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

function bearer(token) {
	return { ...json, authorization: `Bearer ${token}` };
}

async function save(token, userId, label) {
	return call("/v1/ingest", {
		method: "POST",
		headers: bearer(token),
		body: JSON.stringify({
			userId,
			flush: true,
			messages: [{ id: `m-${crypto.randomUUID()}`, role: "user", content: `I decided the ${label} service checkpoints to D1` }],
			_test: { llmResponse: canned(label) },
		}),
	});
}

describe("OPS-02 — operator overview", () => {
	it("answers the operator's questions across the account's sub-tenants", async () => {
		const acct = await account("ops-overview");
		const t1 = `tenant-alpha-${crypto.randomUUID().slice(0, 8)}`;
		const t2 = `tenant-beta-${crypto.randomUUID().slice(0, 8)}`;

		const a = await save(acct.token, t1, "Falcon");
		const b = await save(acct.token, t2, "Osprey");
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);

		const res = await call("/v1/ops/overview", { headers: bearer(acct.token) });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);

		// Account roll-up: the "is my system healthy" answer.
		const acc = res.body.account;
		expect(acc.owner_user_id).toBe(acct.user.id);
		expect(acc.tenants).toBeGreaterThanOrEqual(2);
		expect(acc.jobs).toBeTruthy();
		expect(acc.backlog).toHaveProperty("depth");
		expect(acc.backlog).toHaveProperty("oldest_age_ms");
		expect(acc.stuck).toHaveProperty("non_terminal");
		expect(acc.cancelled_by_delete).toBe(0);
		expect(acc.latency_ms).toHaveProperty("p50");

		// Per-tenant rows, addressed by the caller's OWN external ids.
		const ids = res.body.tenants.map((t) => t.external_user_id);
		expect(ids).toContain(t1);
		expect(ids).toContain(t2);
		const alpha = res.body.tenants.find((t) => t.external_user_id === t1);
		expect(alpha.memory_user_id).toMatch(/^mem_/);
		expect(alpha.is_root).toBe(false);
		expect(alpha.live_nodes).toBeGreaterThan(0);
		expect(alpha.jobs.enriched).toBeGreaterThan(0);
		expect(alpha.cancelled_by_delete).toBe(0);
		expect(alpha).toHaveProperty("barrier_at");
	});

	it("never returns memory content, labels, or project display names", async () => {
		const acct = await account("ops-noleak");
		const tenant = `tenant-secret-${crypto.randomUUID().slice(0, 8)}`;
		await save(acct.token, tenant, "Nightingale");

		const res = await call("/v1/ops/overview", { headers: bearer(acct.token) });
		expect(res.status).toBe(200);
		const serialized = JSON.stringify(res.body);
		// The node label and the slice text are the person's own words.
		expect(serialized).not.toContain("Nightingale");
		expect(serialized).not.toContain("checkpoints to D1");
		// project_name can be a working-directory basename; project_id is a hash.
		for (const t of res.body.tenants) expect(t).not.toHaveProperty("project_name");
		expect(serialized).not.toContain("project_name");
	});

	it("shows one account NOTHING about another account's tenants", async () => {
		const mine = await account("ops-mine");
		const theirs = await account("ops-theirs");
		const secretTenant = `tenant-theirs-${crypto.randomUUID().slice(0, 8)}`;
		await save(theirs.token, secretTenant, "Kestrel");
		await save(mine.token, `tenant-mine-${crypto.randomUUID().slice(0, 8)}`, "Merlin");

		const res = await call("/v1/ops/overview", { headers: bearer(mine.token) });
		expect(res.status).toBe(200);
		expect(res.body.account.owner_user_id).toBe(mine.user.id);
		const serialized = JSON.stringify(res.body);
		expect(serialized).not.toContain(secretTenant);
		expect(serialized).not.toContain(theirs.user.id);
		for (const t of res.body.tenants) expect(t.external_user_id).not.toBe(secretTenant);
	});

	it("refuses unauthenticated callers", async () => {
		const res = await call("/v1/ops/overview");
		expect(res.status).toBe(401);
	});

	it("refuses the legacy x-api-key lane, which has no sub-tenant concept", async () => {
		const res = await call("/v1/ops/overview", { headers: { "x-api-key": env.API_KEY } });
		expect(res.status).toBe(400);
		expect(String(res.body.code ?? "")).toBe("account_scope_required");
	});
});

describe("OPS-04 — the account's own root memory is never crowded out", () => {
	it("keeps the root row even when busier sub-tenants fill the cap", async () => {
		// Found by using the surface: the campaign account's 200 most recently
		// active sub-tenants (all erased, 0 nodes) filled the list and pushed the
		// ROOT row out, so an operator asking "how much memory do I have?" was
		// told 0 while the root held hundreds of nodes.
		const acct = await account("ops-root");
		await save(acct.token, null, "RootFalcon");              // account root
		await save(acct.token, `sub-a-${crypto.randomUUID().slice(0, 8)}`, "SubA");
		await save(acct.token, `sub-b-${crypto.randomUUID().slice(0, 8)}`, "SubB");

		// A cap smaller than the tenant count is exactly the production shape.
		const res = await call("/v1/ops/overview?limit=1", { headers: bearer(acct.token) });
		expect(res.status).toBe(200);

		const root = res.body.tenants.find((t) => t.is_root);
		expect(root, "root tenant row must survive truncation").toBeTruthy();
		expect(root.memory_user_id).toBe(acct.user.id);
		expect(root.live_nodes).toBeGreaterThan(0);

		// And the account total must include what the root holds.
		expect(res.body.account.live_nodes).toBeGreaterThanOrEqual(root.live_nodes);
		expect(res.body.account.truncated).toBe(true);
	});
});

describe("OPS-03 — tenant fan-out is chunked under D1's bound-parameter limit", () => {
	it("aggregates identically however the tenant list is split", async () => {
		// The production failure this pins: `user_id IN (...)` built from an
		// account's tenants is a query that works until the account grows. The
		// campaign account had 360 sub-tenants and D1 answered "too many SQL
		// variables"; a two-tenant test account could never have shown it.
		const acct = await account("ops-chunk");
		const names = [];
		for (let i = 0; i < 3; i += 1) {
			const t = `tenant-chunk-${i}-${crypto.randomUUID().slice(0, 8)}`;
			names.push(t);
			await save(acct.token, t, `Chunky${i}`);
		}

		const whole = await call("/v1/ops/overview", { headers: bearer(acct.token) });
		expect(whole.status).toBe(200);
		expect(whole.body.account.tenants).toBeGreaterThanOrEqual(3);

		// Force multi-chunk fan-out over the SAME data; the roll-up must not move.
		const { operatorOverview } = await import("../src/pipeline/ops.js");
		for (const chunkSize of [1, 2, 3]) {
			const split = await operatorOverview(env, acct.user.id, { chunkSize });
			expect(split.account.tenants).toBe(whole.body.account.tenants);
			expect(split.account.live_nodes).toBe(whole.body.account.live_nodes);
			expect(split.account.jobs.enriched).toBe(whole.body.account.jobs.enriched);
			expect(split.account.latency_ms.samples).toBe(whole.body.account.latency_ms.samples);
			for (const name of names) {
				const row = split.tenants.find((t) => t.external_user_id === name);
				expect(row, `tenant ${name} missing at chunkSize ${chunkSize}`).toBeTruthy();
				expect(row.live_nodes).toBeGreaterThan(0);
			}
		}
	});
});

describe("A10-F2 — cancellations are first-class in the jobs ledger", () => {
	it("marks a cancelled job as cancelled_by_delete without inventing a new terminal status", async () => {
		const acct = await account("ops-cancel");
		const tenant = `tenant-cancel-${crypto.randomUUID().slice(0, 8)}`;
		const written = await save(acct.token, tenant, "Harrier");
		expect(written.status).toBe(200);
		const packet = written.body.source_packet_id;

		// Settle the job the way the DO settles a cancellation: terminal `failed`
		// with the cancellation named in `error` (SRV-08/SRV-09 contract).
		await env.DB.prepare(
			`UPDATE memory_jobs SET status = 'failed',
			   error = 'cancelled_by_delete: a confirmed delete erased this scope while the save was processing'
			 WHERE source_packet_id = ?`,
		).bind(packet).run();

		const status = await call(
			`/v1/packets/${encodeURIComponent(packet)}/status?userId=${encodeURIComponent(tenant)}`,
			{ headers: bearer(acct.token) },
		);
		expect(status.status).toBe(200);
		// The status stays in the vocabulary every shipped SDK already knows.
		expect(status.body.status).toBe("failed");
		// ...and the reason is machine-readable, not a substring hunt.
		expect(status.body.cancelled_by_delete).toBe(true);
		expect(status.body.outcome_reason).toBe("cancelled_by_delete");

		const all = await call(`/v1/jobs?userId=${encodeURIComponent(tenant)}`, { headers: bearer(acct.token) });
		expect(all.status).toBe(200);
		expect(all.body.jobs.some((j) => j.cancelled_by_delete === true)).toBe(true);

		// Filter: cancellations only.
		const only = await call(`/v1/jobs?userId=${encodeURIComponent(tenant)}&cancelled=true`, { headers: bearer(acct.token) });
		expect(only.status).toBe(200);
		expect(only.body.jobs.length).toBeGreaterThan(0);
		expect(only.body.jobs.every((j) => j.cancelled_by_delete === true)).toBe(true);

		// Filter: genuine failures only — a cancellation must NOT be counted here.
		const excluded = await call(`/v1/jobs?userId=${encodeURIComponent(tenant)}&cancelled=false`, { headers: bearer(acct.token) });
		expect(excluded.status).toBe(200);
		expect(excluded.body.jobs.every((j) => j.cancelled_by_delete !== true)).toBe(true);
	});

	it("reports an ordinary failure as NOT a cancellation", async () => {
		const acct = await account("ops-plainfail");
		const tenant = `tenant-plainfail-${crypto.randomUUID().slice(0, 8)}`;
		const written = await save(acct.token, tenant, "Kite");
		const packet = written.body.source_packet_id;

		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'failed', error = 'db_write_failed: a storage error interrupted the save' WHERE source_packet_id = ?",
		).bind(packet).run();

		const status = await call(
			`/v1/packets/${encodeURIComponent(packet)}/status?userId=${encodeURIComponent(tenant)}`,
			{ headers: bearer(acct.token) },
		);
		expect(status.body.status).toBe("failed");
		expect(status.body.cancelled_by_delete).toBe(false);
		expect(status.body.outcome_reason).toBe(null);

		const only = await call(`/v1/jobs?userId=${encodeURIComponent(tenant)}&cancelled=true`, { headers: bearer(acct.token) });
		expect(only.body.jobs.length).toBe(0);
	});

	it("counts cancellations separately from other failures in the overview", async () => {
		const acct = await account("ops-cancelroll");
		const tenant = `tenant-roll-${crypto.randomUUID().slice(0, 8)}`;
		const one = await save(acct.token, tenant, "Merlin");
		const two = await save(acct.token, tenant, "Saker");

		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'failed', error = 'cancelled_by_delete: erased' WHERE source_packet_id = ?",
		).bind(one.body.source_packet_id).run();
		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'failed', error = 'llm_failed: nothing readable' WHERE source_packet_id = ?",
		).bind(two.body.source_packet_id).run();

		const res = await call("/v1/ops/overview", { headers: bearer(acct.token) });
		expect(res.status).toBe(200);
		expect(res.body.account.cancelled_by_delete).toBe(1);
		expect(res.body.account.failures.cancelled_by_delete).toBe(1);
		expect(res.body.account.failures.other).toBe(1);
		const row = res.body.tenants.find((t) => t.external_user_id === tenant);
		expect(row.cancelled_by_delete).toBe(1);
	});
});
