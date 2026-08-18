import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { managedProjectMemoryOwnerId } from "../src/lib/managed_projects.js";
import { ensureDefaultOrganization, setProjectRole } from "../src/lib/organizations.js";
import { projectDashboard } from "../src/pipeline/dashboard.js";

const JSON_HEADERS = { "content-type": "application/json" };
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

async function call(path, init = {}) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let body = null;
	try { body = await response.json(); } catch {}
	return { response, status: response.status, body };
}

function cookieFrom(response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function signup(label) {
	const result = await call("/auth/signup", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({
			email: `${label}-${crypto.randomUUID()}@example.com`,
			password: "correct-horse",
			name: label,
			acceptTerms: true,
		}),
	});
	expect(result.status).toBe(201);
	return { cookie: cookieFrom(result.response), user: result.body.user };
}

async function createProject(account, name = "Dashboard Atlas") {
	const result = await call("/auth/projects", {
		method: "POST",
		headers: { ...JSON_HEADERS, cookie: account.cookie },
		body: JSON.stringify({ name }),
	});
	expect(result.status).toBe(201);
	return result.body.project;
}

async function insertReceipt({ id, userId, at, source = "save_memory", mode = "manual_direct", outcome = "wrote", saved = 1, skipped = 0, matched = null, latency = null }) {
	await env.DB.prepare(
		`INSERT INTO receipts
		 (id, user_id, source, source_mode, outcome, saved_total, skipped, matched, latency_ms, summary, detail, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, source, mode, outcome, saved, skipped, matched, latency, `PRIVATE-${id}`, `{"private":"${id}"}`, at).run();
}

async function insertJob({ id, userId, status, createdAt, completedAt = null, attempts = 0, error = null, receiptId = null }) {
	await env.DB.prepare(
		`INSERT INTO memory_jobs
		 (id, user_id, type, status, attempts, payload_json, error, receipt_id, created_at, updated_at, completed_at)
		 VALUES (?, ?, 'extract', ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(id, userId, status, attempts, `{"private":"${id}"}`, error, receiptId, createdAt, completedAt ?? createdAt, completedAt).run();
}

describe("GET /v1/dashboard authorization and contract", () => {
	it("requires project-scoped modern auth and rejects hidden query filters", async () => {
		const account = await signup("dashboard-auth");
		const unauthenticated = await call("/v1/dashboard");
		expect(unauthenticated.status).toBe(401);

		const legacy = await call("/v1/dashboard", { headers: { "x-api-key": env.API_KEY } });
		expect(legacy.status).toBe(400);
		expect(legacy.body.code).toBe("account_scope_required");

		const invalidRange = await call("/v1/dashboard?range=calendar", { headers: { cookie: account.cookie } });
		expect(invalidRange.status).toBe(400);
		expect(invalidRange.body.code).toBe("invalid_dashboard_range");

		const hiddenTenantFilter = await call("/v1/dashboard?userId=someone", { headers: { cookie: account.cookie } });
		expect(hiddenTenantFilter.status).toBe(400);
		expect(hiddenTenantFilter.body).toMatchObject({ code: "unsupported_query_parameter", field: "userId" });
		const unsupportedSourceFilter = await call("/v1/dashboard?source=claude", { headers: { cookie: account.cookie } });
		expect(unsupportedSourceFilter.status).toBe(400);
		expect(unsupportedSourceFilter.body).toMatchObject({ code: "unsupported_query_parameter", field: "source" });
		const duplicateRange = await call("/v1/dashboard?range=1d&range=7d", { headers: { cookie: account.cookie } });
		expect(duplicateRange.status).toBe(400);
		expect(duplicateRange.body).toMatchObject({ code: "duplicate_query_parameter", field: "range" });

		const valid = await call("/v1/dashboard?range=1d", { headers: { cookie: account.cookie } });
		expect(valid.status).toBe(200);
		expect(valid.response.headers.get("cache-control")).toBe("private, no-store");
		expect(valid.body.schema).toBe("itsuki.dashboard/v1");
		expect(valid.body.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("honors fresh viewer RBAC and refuses project outsiders", async () => {
		const owner = await signup("dashboard-owner");
		const viewer = await signup("dashboard-viewer");
		const outsider = await signup("dashboard-outsider");
		const project = await createProject(owner, "Shared dashboard");
		const org = await ensureDefaultOrganization(env, owner.user.id);
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(`orgm_${crypto.randomUUID()}`, org.id, viewer.user.id, owner.user.id, at, at).run();
		await setProjectRole(env, project.id, org.id, viewer.user.id, "viewer", owner.user.id);

		const allowed = await call("/v1/dashboard", {
			headers: { cookie: viewer.cookie, "x-itsuki-project": project.id },
		});
		expect(allowed.status).toBe(200);
		expect(allowed.body.scope.project_id).toBe(project.id);

		const denied = await call("/v1/dashboard", {
			headers: { cookie: outsider.cookie, "x-itsuki-project": project.id },
		});
		expect(denied.status).toBe(404);
		expect(denied.body.code).toBe("project_not_found");
	});

	it("does not let a project-bound token switch projects", async () => {
		const account = await signup("dashboard-token");
		const first = await createProject(account, "First dashboard");
		const second = await createProject(account, "Second dashboard");
		const key = await call("/auth/tokens", {
			method: "POST",
			headers: { ...JSON_HEADERS, cookie: account.cookie, "x-itsuki-project": first.id },
			body: JSON.stringify({ type: "api", label: "dashboard read" }),
		});
		expect(key.status).toBe(201);
		const switched = await call("/v1/dashboard", {
			headers: { authorization: `Bearer ${key.body.token}`, "x-itsuki-project": second.id },
		});
		expect(switched.status).toBe(403);
		expect(switched.body.code).toBe("project_scope_mismatch");
	});
});

describe("project dashboard aggregate", () => {
	it("aggregates only root plus active registered spaces with exact adjacent periods", async () => {
		const account = await signup("dashboard-scope");
		const project = await createProject(account, "Scoped analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const active = `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
		const archived = `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
		const foreign = `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
		await env.DB.batch([
			env.DB.prepare(
				`INSERT OR REPLACE INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'active', ?, ?)`,
			).bind(project.id, root, active, NOW, NOW),
			env.DB.prepare(
				`INSERT OR REPLACE INTO project_memory_spaces
				 (project_id, memory_owner_user_id, memory_user_id, state, created_at, last_seen_at)
				 VALUES (?, ?, ?, 'archived', ?, ?)`,
			).bind(project.id, root, archived, NOW, NOW),
		]);

		for (const [index, userId] of [root, active, archived, foreign].entries()) {
			await env.DB.batch([
				env.DB.prepare("INSERT INTO nodes (id, user_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
					.bind(`node_${crypto.randomUUID()}`, userId, `PRIVATE-NODE-${index}`, NOW, NOW),
				env.DB.prepare("INSERT INTO memory_pages (id, user_id, title, canonical_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
					.bind(`page_${crypto.randomUUID()}`, userId, `PRIVATE-PAGE-${index}`, `private-page-${index}`, NOW, NOW),
				env.DB.prepare("INSERT INTO slices (id, user_id, text, created_at) VALUES (?, ?, ?, ?)")
					.bind(`slice_${crypto.randomUUID()}`, userId, `PRIVATE-SLICE-${index}`, NOW),
				env.DB.prepare("INSERT INTO events (id, user_id, text, created_at) VALUES (?, ?, ?, ?)")
					.bind(`event_${crypto.randomUUID()}`, userId, `PRIVATE-EVENT-${index}`, NOW),
				env.DB.prepare("INSERT INTO edges (id, user_id, type, created_at) VALUES (?, ?, 'related', ?)")
					.bind(`edge_${crypto.randomUUID()}`, userId, NOW),
			]);
		}

		const currentFrom = NOW - DAY;
		const previousFrom = NOW - 2 * DAY;
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: root, at: currentFrom, latency: 10, outcome: "wrote" });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: active, at: currentFrom + 1, latency: 20, outcome: "meaningful_no_write", saved: 0, skipped: 1 });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: active, at: NOW - 2, source: "recall", mode: "bounded_recall", outcome: "recalled", saved: 0, matched: 3, latency: 30 });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: root, at: NOW - 1, source: "recall", mode: "bounded_recall", outcome: "no_recall", saved: 0, matched: 0, latency: 40 });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: root, at: previousFrom, latency: 100, outcome: "wrote" });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: active, at: currentFrom - 1, latency: 200, outcome: "llm_failed", saved: 0 });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: root, at: NOW, latency: 999, outcome: "outside_now" });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: root, at: previousFrom - 1, latency: 999, outcome: "outside_previous" });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: archived, at: NOW - 10, latency: 999, outcome: "archived_secret" });
		await insertReceipt({ id: `r_${crypto.randomUUID()}`, userId: foreign, at: NOW - 10, latency: 999, outcome: "foreign_secret" });

		const dashboard = await projectDashboard(env, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});

		expect(dashboard.scope).toEqual({ kind: "managed_project", project_id: project.id, memory_spaces: 2 });
		expect(dashboard.inventory).toMatchObject({ nodes: 2, pages: 2, slices: 2, events: 2, edges: 2, total_objects: 10 });
		expect(dashboard.range.current).toEqual({ from_ms: currentFrom, to_ms: NOW });
		expect(dashboard.range.previous).toEqual({ from_ms: previousFrom, to_ms: currentFrom });
		expect(dashboard.periods.current.operations).toMatchObject({
			total: 4,
			saves: 2,
			recalls: 2,
			matched: 3,
			matched_operations: 1,
			matched_samples: 2,
		});
		expect(dashboard.periods.previous.operations.total).toBe(2);
		expect(dashboard.periods.current.daily).toHaveLength(1);
		expect(dashboard.periods.current.daily[0].total).toBe(4);
		expect(dashboard.periods.current.daily[0]).toMatchObject({ matched: 3, matched_operations: 1, matched_samples: 2 });
		expect(dashboard.periods.current.daily[0].reliability).toEqual({
			successful: 3,
			meaningful_no_write: 1,
			policy_skipped: 0,
			cancelled: 0,
			genuine_failure: 0,
			other: 0,
			classified: 4,
			eligible: 4,
			coverage: 1,
			retry_scheduled: null,
		});
		expect(dashboard.periods.current.daily[0].latency_ms).toEqual({
			p50: 20,
			p95: 40,
			p99: 40,
			samples: 4,
			eligible: 4,
			coverage: 1,
			bands: [
				{ min_ms: 0, max_ms_exclusive: 50, count: 4 },
				{ min_ms: 50, max_ms_exclusive: 100, count: 0 },
				{ min_ms: 100, max_ms_exclusive: 200, count: 0 },
				{ min_ms: 200, max_ms_exclusive: 400, count: 0 },
				{ min_ms: 400, max_ms_exclusive: 800, count: 0 },
				{ min_ms: 800, max_ms_exclusive: null, count: 0 },
			],
		});
		expect(dashboard.periods.current.latency_ms).toEqual({ p50: 20, p95: 40, p99: 40, samples: 4, eligible: 4, coverage: 1 });
		expect(dashboard.periods.current.operations.outcomes.map((row) => row.outcome)).not.toContain("archived_secret");
		expect(dashboard.periods.current.operations.outcomes.map((row) => row.outcome)).not.toContain("foreign_secret");
		const serialized = JSON.stringify(dashboard);
		expect(serialized).not.toContain("PRIVATE-");
		expect(serialized).not.toContain(active);
		expect(serialized).not.toContain(archived);
	});

	it("classifies every known receipt outcome honestly and builds exact latency buckets", async () => {
		const account = await signup("dashboard-reliability");
		const project = await createProject(account, "Reliability analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const outcomes = [
			"wrote", "recalled", "no_recall", "completed", "promoted_from_candidate", "deleted",
			"meaningful_no_write", "no_write", "ignored", "duplicate", "skipped_duplicate",
			"excluded_by_rule", "suppressed",
			"cancelled_by_delete", "cancelled_by_retention",
			"llm_failed", "db_write_failed", "internal_error", "extraction_failed_terminal", "enrich_failed",
			"accepted", "accumulating", "staged", "queue_full", "too_large",
		];
		const latencySamples = [49, 50, 100, 200, 400, 800];
		for (const [index, outcome] of outcomes.entries()) {
			await insertReceipt({
				id: `r_${crypto.randomUUID()}`,
				userId: root,
				at: NOW - 10_000 + index,
				outcome,
				latency: latencySamples[index] ?? null,
			});
		}

		const dashboard = await projectDashboard(env, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});
		const bucket = dashboard.periods.current.daily[0];
		expect(bucket.total).toBe(outcomes.length);
		expect(bucket.reliability).toEqual({
			successful: 6,
			meaningful_no_write: 5,
			policy_skipped: 2,
			cancelled: 2,
			genuine_failure: 5,
			other: 5,
			classified: 20,
			eligible: 25,
			coverage: 0.8,
			retry_scheduled: null,
		});
		expect(bucket.latency_ms).toMatchObject({
			p50: 100,
			p95: 800,
			p99: 800,
			samples: 6,
			eligible: 25,
			coverage: 0.24,
		});
		expect(bucket.latency_ms.bands.map((band) => band.count)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(bucket.outcomes).toHaveLength(outcomes.length);
		expect(bucket.lanes).toEqual([{ source: "save_memory", source_mode: "manual_direct", count: 25 }]);
	});

	it("bounds adversarial receipt dimensions without losing operation totals", async () => {
		const account = await signup("dashboard-cardinality");
		const project = await createProject(account, "Bounded analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const inserts = Array.from({ length: 64 }, (_, index) => env.DB.prepare(
			`INSERT INTO receipts
			 (id, user_id, source, source_mode, outcome, saved_total, skipped, matched, latency_ms, summary, detail, created_at)
			 VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, ?)`,
		).bind(
			`r_${crypto.randomUUID()}`,
			root,
			`attacker-source-${index}`,
			`attacker-mode-${index}`,
			`attacker-outcome-${index}`,
			NOW - 1_000 + index,
		));
		await env.DB.batch(inserts);

		const dashboard = await projectDashboard(env, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});
		const period = dashboard.periods.current;
		expect(period.operations.total).toBe(64);
		expect(period.operations.saves).toBe(64);
		expect(period.operations.outcomes).toEqual([{ outcome: "other", count: 64 }]);
		expect(period.operations.lanes).toEqual([{ source: "other", source_mode: "other", count: 64 }]);
		expect(period.daily[0].total).toBe(64);
		expect(period.daily[0].outcomes).toEqual([{ outcome: "other", count: 64 }]);
		expect(period.daily[0].lanes).toEqual([{ source: "other", source_mode: "other", count: 64 }]);
		expect(period.daily[0].reliability).toMatchObject({
			other: 64,
			classified: 0,
			eligible: 64,
			coverage: 0,
		});
	});

	it("separates live backlog, all-history outcomes, cancellations, retries, and bounded recent jobs", async () => {
		const account = await signup("dashboard-jobs");
		const project = await createProject(account, "Job analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const currentFrom = NOW - DAY;
		const previousFrom = NOW - 2 * DAY;
		const receiptId = `r_${crypto.randomUUID()}`;
		await insertReceipt({ id: receiptId, userId: root, at: NOW - 1000, source: "save_memory" });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "queued", createdAt: NOW - 20 * 60 * 1000, attempts: 2, receiptId });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "processing", createdAt: NOW - 5 * 60 * 1000 });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "enriched", createdAt: currentFrom + 100, completedAt: NOW - 100 });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "failed", createdAt: currentFrom + 200, completedAt: NOW - 90, error: "cancelled_by_delete: private erasure detail" });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "failed", createdAt: previousFrom + 100, completedAt: currentFrom - 100, attempts: 1, error: "db_write_failed: PRIVATE STORAGE DETAIL" });
		await insertJob({ id: `job_${crypto.randomUUID()}`, userId: root, status: "failed", createdAt: previousFrom + 200, completedAt: currentFrom - 90, error: "cancelled_by_retention: private policy detail" });

		const dashboard = await projectDashboard(env, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});
		expect(dashboard.jobs.current).toMatchObject({ backlog_depth: 2, stuck_over_15m: 1 });
		expect(dashboard.jobs.current.statuses).toMatchObject({ queued: 1, processing: 1 });
		expect(dashboard.jobs.all_time.terminal).toEqual({
			enriched: 1,
			completed: 0,
			genuine_failures: 1,
			cancelled_by_delete: 1,
			cancelled_by_retention: 1,
		});
		expect(dashboard.jobs.all_time.jobs_with_retries).toBe(2);
		expect(dashboard.jobs.all_time.status_counts.every((row) => row.status !== "retrying")).toBe(true);
		expect(dashboard.jobs.periods.current).toMatchObject({ accepted: 4, settled: 2, enriched: 1, cancelled_by_delete: 1, genuine_failures: 0 });
		expect(dashboard.jobs.periods.previous).toMatchObject({ accepted: 2, settled: 2, genuine_failures: 1, cancelled_by_retention: 1 });
		expect(dashboard.jobs.recent.length).toBe(6);
		expect(dashboard.jobs.recent[0]).toHaveProperty("source");
		expect(JSON.stringify(dashboard.jobs.recent)).not.toContain("PRIVATE");
		expect(dashboard.signals.map((signal) => signal.type)).toEqual(["jobs_stuck", "jobs_backlog"]);
		expect(dashboard.signals.every((signal) => signal.code === signal.type)).toBe(true);
	});

	it("returns exact account AI usage and degrades only AI accounting on failure", async () => {
		const account = await signup("dashboard-ai");
		const project = await createProject(account, "AI analytics");
		const siblingProject = await createProject(account, "Sibling AI analytics");
		const outsider = await signup("dashboard-ai-outsider");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, ?, 'save', ?, 'model-a', 10, 5, 15, 7, 1, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, root, account.user.id, project.id, `scope_${crypto.randomUUID()}`, NOW - 100),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, ?, 'save', ?, 'model-b', 20, 10, 30, NULL, 0, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, root, account.user.id, project.id, `scope_${crypto.randomUUID()}`, NOW - 90),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, ?, 'recall', ?, 'model-c', 5, 2, 7, NULL, 1, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, root, account.user.id, project.id, `scope_${crypto.randomUUID()}`, NOW - DAY - 100),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, ?, 'recall', ?, 'sibling-model', 99, 9, 108, 12, 1, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, root, account.user.id, siblingProject.id, `scope_${crypto.randomUUID()}`, NOW - 80),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, NULL, 'recall', ?, 'unattributed-model', 88, 8, 96, 11, 1, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, root, account.user.id, `scope_${crypto.randomUUID()}`, NOW - 70),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, account_user_id, managed_project_id, scope, scope_id, model, input_tokens, output_tokens, total_tokens, neurons, ok, created_at)
				 VALUES (?, ?, ?, ?, 'recall', ?, 'foreign-model', 77, 7, 84, 10, 1, ?)`,
			).bind(`aicall_${crypto.randomUUID()}`, outsider.user.id, outsider.user.id, project.id, `scope_${crypto.randomUUID()}`, NOW - 60),
		]);

		const dashboard = await projectDashboard(env, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});
		expect(dashboard.ai.available).toBe(true);
		expect(dashboard.ai.current).toMatchObject({ calls: 4, successful_calls: 3, failed_calls: 1, measured_neurons: 30, measured_neuron_calls: 3 });
		expect(dashboard.ai.current.derived_neuron_top_up).toBeGreaterThan(0);
		expect(dashboard.ai.quota).toMatchObject({ unit: "ai_writes", scope: "account", period: "calendar_month_utc", used: 2, capped: false });
		expect(dashboard.ai.project).toMatchObject({
			scope: "managed_project",
			project_id: project.id,
			attribution: "managed_project_id",
			legacy_unattributed_excluded: true,
		});
		expect(dashboard.ai.project.periods.current).toMatchObject({ calls: 2, successful_calls: 1, failed_calls: 1 });
		expect(dashboard.ai.project.periods.previous).toMatchObject({ calls: 1, successful_calls: 1, failed_calls: 0 });
		expect(dashboard.ai.project.periods.current.daily).toHaveLength(1);
		expect(dashboard.ai.project.periods.current.daily[0]).toMatchObject({
			from_ms: NOW - DAY,
			to_ms: NOW,
			calls: 2,
			input_tokens: 30,
			output_tokens: 15,
			total_tokens: 45,
		});

		const aiFailingDb = {
			prepare(sql) {
				if (String(sql).includes("ai_calls")) {
					return { bind() { return { aiLedgerUnavailable: true }; } };
				}
				return env.DB.prepare(sql);
			},
			batch(statements) {
				if (statements.some((statement) => statement?.aiLedgerUnavailable)) throw new Error("AI ledger unavailable");
				return env.DB.batch(statements);
			},
		};
		const degraded = await projectDashboard({ ...env, DB: aiFailingDb }, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		});
		expect(degraded.inventory).toEqual(dashboard.inventory);
		expect(degraded.ai).toEqual({ scope: "account", available: false, current: null, previous: null, quota: null, project: null });
	});

	it("returns honest zero and null values for an empty project", async () => {
		const account = await signup("dashboard-empty");
		const project = await createProject(account, "Empty analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const dashboards = new Map();
		for (const [range, days] of [["1d", 1], ["7d", 7], ["30d", 30], ["90d", 90]]) {
			const result = await projectDashboard(env, {
				projectId: project.id,
				memoryOwnerUserId: root,
				accountUserId: account.user.id,
				range,
				now: NOW,
			});
			expect(result.range).toMatchObject({ key: range, days });
			expect(result.periods.current.daily).toHaveLength(days);
			expect(result.periods.previous.daily).toHaveLength(days);
			dashboards.set(range, result);
		}
		const dashboard = dashboards.get("7d");
		expect(dashboard.inventory.total_objects).toBe(0);
		expect(dashboard.periods.current.operations).toMatchObject({ total: 0, matched: null, matched_operations: 0, matched_samples: 0 });
		expect(dashboard.periods.current.daily).toHaveLength(7);
		expect(dashboard.periods.current.daily.every((bucket) => bucket.total === 0 && bucket.matched === null && bucket.matched_operations === 0)).toBe(true);
		expect(dashboard.periods.current.daily.every((bucket) => bucket.reliability.eligible === 0 && bucket.reliability.coverage === null)).toBe(true);
		expect(dashboard.periods.current.daily.every((bucket) => bucket.latency_ms.samples === 0 && bucket.latency_ms.bands.every((band) => band.count === 0))).toBe(true);
		expect(dashboard.periods.current.latency_ms).toEqual({ p50: null, p95: null, p99: null, samples: 0, eligible: 0, coverage: null });
		expect(dashboard.jobs.current.oldest_pending_age_ms).toBeNull();
		expect(dashboard.jobs.recent).toEqual([]);
		expect(dashboard.signals).toEqual([]);
	});

	it("fails closed when a required project metadata query fails", async () => {
		const account = await signup("dashboard-core-failure");
		const project = await createProject(account, "Core failure analytics");
		const root = await managedProjectMemoryOwnerId(account.user.id, project);
		const coreFailingDb = {
			prepare(sql) { return env.DB.prepare(sql); },
			async batch() { throw new Error("required dashboard ledger unavailable"); },
		};
		await expect(projectDashboard({ ...env, DB: coreFailingDb }, {
			projectId: project.id,
			memoryOwnerUserId: root,
			accountUserId: account.user.id,
			range: "1d",
			now: NOW,
		})).rejects.toThrow("required dashboard ledger unavailable");
	});
});
