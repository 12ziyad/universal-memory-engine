/**
 * Launch hardening (2026-08-28): the per-user daily neuron allowance, Huba AI
 * quota + grounding corpus, entitlement overrides, the upgrade-request queue,
 * and terminal-job pruning. Every dimension fails CLOSED on an unreadable
 * quota, mirrors the ai_quota_exhausted refusal grammar, and keys on the
 * account so rotating a memory-scope userId never buys a fresh allowance.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src";
import {
	aiBudget,
	checkAiBudget,
	checkHubaBudget,
	loadEntitlements,
	neuronsSpentTodayForAccount,
	hubaMessagesToday,
	stampEarlyAccess,
	resetBreakerCacheForTests,
	startOfUtcDay,
} from "../src/lib/ai_budget.js";
import {
	createUpgradeRequest,
	processUpgradeRequestNotifications,
	grantEntitlement,
	dismissUpgradeRequest,
	listUpgradeRequests,
} from "../src/lib/upgrade_requests.js";
import { isCapacityError } from "../src/pipeline/llm.js";
import { retrieve, scrubMechanismTalk } from "../src/huba/huba.js";
import { routeFetchers } from "../src/huba/fetchers.js";
import { HUBA_CHUNKS, HUBA_PAGES, HUBA_CORPUS_DOCS_HASH } from "../src/huba/corpus.generated.js";
import { runReconciliationSweep } from "../src/pipeline/sweep.js";
import docsHtml from "../public/docs/index.html?raw";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function jsonRequest(path, body, headers = {}) {
	return request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

let userSeq = 0;
async function signedUpUser() {
	const email = `hardening-${Date.now()}-${userSeq++}@example.com`;
	const res = await jsonRequest("/auth/signup", {
		email, password: "a-strong-password-1", name: "Hardening Test", acceptTerms: true,
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	return { id: body.user.id, email, cookie: cookieFrom(res) };
}

/** Seed metered AI calls for an account today. */
async function seedCalls(accountUserId, n, { scope = "save", neurons = 100, userId = accountUserId } = {}) {
	const now = Date.now();
	const stmts = [];
	for (let i = 0; i < n; i++) {
		stmts.push(env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, input_tokens, output_tokens, neurons, ok, created_at, account_user_id)
			 VALUES (?, ?, ?, ?, 'test-model', 'extract', 10, 5, ?, 1, ?, ?)`,
		).bind(`aicall_lh_${crypto.randomUUID()}`, userId, scope, `run_${crypto.randomUUID()}`, neurons, now, accountUserId));
	}
	await env.DB.batch(stmts);
}

beforeEach(() => resetBreakerCacheForTests());
afterEach(async () => {
	resetBreakerCacheForTests();
	await env.DB.prepare("DELETE FROM ai_daily_totals").run();
});

describe("per-user daily neuron allowance", () => {
	it("refuses with the ai_quota_exhausted grammar and capped=daily_neurons once the day is spent", async () => {
		const user = await signedUpUser();
		await seedCalls(user.id, 151, { neurons: 100 }); // 15,100 > 15,000 default
		const refusal = await checkAiBudget(env, { accountUserId: user.id, userId: user.id });
		expect(refusal?.error).toBe("ai_quota_exhausted");
		expect(refusal.capped).toBe("daily_neurons");
		expect(refusal.usage).toMatchObject({ unit: "neurons", limit: aiBudget(env).dailyNeuronsPerUser });
		expect(refusal.usage.used).toBeGreaterThanOrEqual(refusal.usage.limit);
		expect(new Date(refusal.usage.resets_at).getTime()).toBeGreaterThan(Date.now());
	});

	it("never counts recall against the day", async () => {
		const user = await signedUpUser();
		await seedCalls(user.id, 200, { scope: "recall", neurons: 100 });
		expect(await neuronsSpentTodayForAccount(env, { accountUserId: user.id })).toBe(0);
		expect(await checkAiBudget(env, { accountUserId: user.id, userId: user.id })).toBeNull();
	});

	it("derives neurons from tokens for calls the binding did not price", async () => {
		const user = await signedUpUser();
		await env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, input_tokens, output_tokens, neurons, ok, created_at, account_user_id)
			 VALUES (?, ?, 'save', ?, 'test-model', 1000000, 0, NULL, 1, ?, ?)`,
		).bind(`aicall_lh_${crypto.randomUUID()}`, user.id, `run_${crypto.randomUUID()}`, Date.now(), user.id).run();
		// 1M input tokens at the published 4625/M rate.
		expect(await neuronsSpentTodayForAccount(env, { accountUserId: user.id })).toBeCloseTo(4625, 0);
	});

	it("honours an entitlement override, and ignores it after expiry (early access survives)", async () => {
		const user = await signedUpUser();
		await seedCalls(user.id, 151, { neurons: 100 });
		await grantEntitlement(env, { userId: user.id, grantedBy: "admin_test", dailyNeurons: 50_000 });
		expect(await checkAiBudget(env, { accountUserId: user.id, userId: user.id })).toBeNull();
		// Lapse the grant retroactively.
		await env.DB.prepare("UPDATE user_entitlements SET expires_at = ? WHERE user_id = ?")
			.bind(Date.now() - 1000, user.id).run();
		const refusal = await checkAiBudget(env, { accountUserId: user.id, userId: user.id });
		expect(refusal?.capped).toBe("daily_neurons");
		const entitlements = await loadEntitlements(env, user.id);
		expect(entitlements.dailyNeurons).toBeNull();
		// stampEarlyAccess ran at signup and expiry does not erase the flag.
		expect(entitlements.earlyAccess).toBe(true);
	});
});

describe("Huba AI", () => {
	it("bundled corpus is in sync with the live docs file (rebuild gate)", async () => {
		const bytes = new TextEncoder().encode(docsHtml.replace(/\r\n/g, "\n"));
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		expect(hex, "docs changed without `node scripts/build-huba-corpus.mjs`").toBe(HUBA_CORPUS_DOCS_HASH);
		expect(HUBA_PAGES.length).toBeGreaterThanOrEqual(69);
		expect(HUBA_CHUNKS.length).toBeGreaterThan(HUBA_PAGES.length); // sections, not pages
		for (const chunk of HUBA_CHUNKS) {
			expect(chunk.route.startsWith("/")).toBe(true);
			expect(chunk.text.length).toBeGreaterThan(0);
			expect(typeof chunk.heading).toBe("string");
		}
	});

	it("retrieval surfaces the obviously right pages", () => {
		const saveHits = retrieve("how do I save a memory with curl").routes;
		expect(saveHits.some((route) => ["/guides/save", "/api/save", "/quickstart"].includes(route))).toBe(true);
		expect(retrieve("what are the rate limits and quotas").routes).toContain("/api/limits");
		expect(retrieve("").chunks).toEqual([]);
	});

	/**
	 * The regression that motivated the retrieval rewrite. A user asked this
	 * verbatim — typos and all — and Huba answered "The docs don't mention a
	 * TypeScript SDK". The SDK page exists; retrieval had never seen it,
	 * because it is titled "JavaScript SDK" and "typscript" matched nothing.
	 */
	it("finds the TypeScript SDK page despite the typo and the different name", () => {
		const misspelled = retrieve("typscript sdk how to connect it and what all plugin methode itsuki providing?");
		expect(misspelled.routes, "the JS/TS SDK page must be reachable from a typo").toContain("/sdk/js");
		expect(misspelled.topics).toContain("sdk");
		// Spelled correctly it must also be there — the old scorer missed it
		// even then, because "typescript" is absent from that page's title.
		expect(retrieve("typescript sdk connect").routes).toContain("/sdk/js");
		// Asking about SDKs pulls in EVERY SDK page, not just the best match.
		const both = retrieve("which sdks do you have").routes;
		expect(both).toContain("/sdk/js");
		expect(both).toContain("/sdk/python");
	});

	it("a repaired term cannot drag in an unrelated topic", () => {
		// "typscript" repairs to "typescript", whose sibling alias is "node" —
		// which must NOT trigger the memory-graph topic.
		expect(retrieve("typscript sdk").topics).not.toContain("graph");
		// A real graph question still does.
		expect(retrieve("how do graph clusters and edges work").topics).toContain("graph");
	});

	it("routes questions to the right live-data fetchers, and gates admin", () => {
		expect(routeFetchers("how many saves do i have left today")).toContain("usage");
		expect(routeFetchers("did any of my saves fail")).toContain("jobs");
		expect(routeFetchers("who is on my team")).toContain("members");
		expect(routeFetchers("what are my api keys")).toContain("api_keys");
		// The tab in front of them is a signal when the words are ambiguous.
		expect(routeFetchers("what does this show", { view: "graph" })).toContain("graph");
		// Admin data is unreachable without an admin session, whatever is typed.
		expect(routeFetchers("show me all users and signups", { isAdmin: false })).not.toContain("admin");
		expect(routeFetchers("show me all users and signups", { isAdmin: true })).toContain("admin");
		// Never more than the bounded number of fetches per turn.
		expect(routeFetchers("usage jobs members keys graph webhooks exports rules history").length).toBeLessThanOrEqual(3);
	});

	it("never narrates its own machinery, even if the model slips", () => {
		const slips = [
			"The docs don't mention a TypeScript SDK.",
			"Based on the provided context, you have 40 saves left.",
			"No details are available in the documentation.",
			"The ACCOUNT data does not include your memory content.",
			"That is not documented in the docs.",
		];
		for (const slip of slips) {
			const cleaned = scrubMechanismTalk(slip);
			expect(cleaned, slip).not.toMatch(/\b(docs|documentation|provided context|ACCOUNT data)\b/i);
		}
		// Observed in production: a partial removal left orphaned punctuation
		// ("see the TypeScript frameworks section ."), and "section" is a place
		// the reader cannot open. Both are cleaned up.
		const sectioned = scrubMechanismTalk("For details, see the TypeScript frameworks section .");
		expect(sectioned).not.toMatch(/\bsection\b/);
		expect(sectioned).not.toMatch(/\s\./);
		expect(scrubMechanismTalk("As detailed in the JavaScript SDK section, install it with npm."))
			.not.toMatch(/as detailed in|\bsection\b/i);

		// Observed in production: emphasis marks let the machinery vocabulary
		// slip past a word-boundary match, and internal field names got quoted.
		const backticked = scrubMechanismTalk("The current `ACCOUNT` data shows only your direct memory users.");
		expect(backticked).not.toMatch(/ACCOUNT/);
		const fieldy = scrubMechanismTalk("No edges exist between them (`edges_by_type` is empty).");
		expect(fieldy).not.toMatch(/edges_by_type/);
		expect(fieldy).toMatch(/edge types/);

		// It must not mangle an ordinary answer.
		const normal = "You have about 100 saves left today. It resets at 00:00 UTC.";
		expect(scrubMechanismTalk(normal)).toBe(normal);
		const code = "Run `npm install itsuki`, then call memory.add({ text }).";
		expect(scrubMechanismTalk(code)).toBe(code);
		// Real API field names people legitimately ask about must survive.
		const apiField = "Each receipt carries `saved_total` and `outcome`.";
		expect(scrubMechanismTalk(apiField)).toBe(apiField);
		// A dead markdown link keeps its words and loses the link.
		expect(scrubMechanismTalk("Use the [JavaScript SDK](#) for direct calls."))
			.toBe("Use the JavaScript SDK for direct calls.");
		// The section rewrite must not maul ordinary prose that says "shown in".
		const prose = "No relationships are shown in this view yet.";
		expect(scrubMechanismTalk(prose)).toBe(prose);
	});

	it("chat door requires a session", async () => {
		const res = await jsonRequest("/v1/huba/chat", { message: "hello" });
		expect(res.status).toBe(401);
	});

	it("first day is generous, later days are not, entitlements override both", async () => {
		const user = await signedUpUser();
		const today = { userCreatedAt: Date.now() };
		const longAgo = { userCreatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 };
		expect((await checkHubaBudget(env, { accountUserId: user.id }, today)).limit).toBe(aiBudget(env).hubaFirstDayMessages);
		expect((await checkHubaBudget(env, { accountUserId: user.id }, longAgo)).limit).toBe(aiBudget(env).hubaDailyMessages);
		await grantEntitlement(env, { userId: user.id, grantedBy: "admin_test", hubaDailyMessages: 3 });
		expect((await checkHubaBudget(env, { accountUserId: user.id }, today)).limit).toBe(3);
	});

	it("refuses over HTTP with 429 + capped=huba_daily_messages when the day is spent", async () => {
		const user = await signedUpUser();
		await grantEntitlement(env, { userId: user.id, grantedBy: "admin_test", hubaDailyMessages: 2 });
		await seedCalls(user.id, 2, { scope: "huba_chat", neurons: 25 });
		expect(await hubaMessagesToday(env, { accountUserId: user.id })).toBe(2);
		const res = await jsonRequest("/v1/huba/chat", { message: "hello" }, { cookie: user.cookie });
		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.error).toBe("ai_quota_exhausted");
		expect(body.capped).toBe("huba_daily_messages");
		expect(body.usage).toMatchObject({ used: 2, limit: 2, unit: "messages" });
	});

	it("huba spend counts against the daily neuron dimension (no unmetered hole)", async () => {
		const user = await signedUpUser();
		await seedCalls(user.id, 4, { scope: "huba_chat", neurons: 25 });
		expect(await neuronsSpentTodayForAccount(env, { accountUserId: user.id })).toBeCloseTo(100, 5);
	});
});

describe("upgrade requests", () => {
	it("one open request per user per kind — a second press refreshes, not duplicates", async () => {
		const user = await signedUpUser();
		const first = await createUpgradeRequest(env, { userId: user.id, kind: "saves", note: "first note", usage: { a: 1 } });
		const second = await createUpgradeRequest(env, { userId: user.id, kind: "saves", note: "updated note", usage: { a: 2 } });
		expect(second.id).toBe(first.id);
		expect(second.updated).toBe(true);
		const open = await listUpgradeRequests(env, { status: "open" });
		const mine = open.filter((row) => row.user_id === user.id && row.kind === "saves");
		expect(mine).toHaveLength(1);
		expect(mine[0].note).toBe("updated note");
	});

	it("notifies the owner over the EMAIL binding and retries never double-send", async () => {
		const user = await signedUpUser();
		await createUpgradeRequest(env, { userId: user.id, kind: "huba", note: "need more", usage: { huba_today: 20 } });
		const send = vi.fn(async () => ({ messageId: "msg_up_1" }));
		const mailEnv = { ...env, EMAIL: { send }, OWNER_NOTIFY_EMAIL: "owner@example.com" };
		// The drain may also deliver pending rows left by earlier tests in
		// this file — assert on OUR request's delivery, not the global count.
		const result = await processUpgradeRequestNotifications(mailEnv, { limit: 10 });
		expect(result.sent).toBeGreaterThanOrEqual(1);
		const mine = send.mock.calls.filter((call) => call[0].subject.includes(user.email));
		expect(mine).toHaveLength(1);
		expect(mine[0][0].to).toBe("owner@example.com");
		expect(mine[0][0].text).toContain("need more");
		// A second drain finds nothing pending — exactly-once delivery.
		expect((await processUpgradeRequestNotifications(mailEnv, { limit: 10 })).sent).toBe(0);
	});

	it("marks rows skipped rather than queueing forever when email is unconfigured", async () => {
		const user = await signedUpUser();
		await createUpgradeRequest(env, { userId: user.id, kind: "other", note: null, usage: null });
		const bare = { ...env };
		delete bare.EMAIL;
		delete bare.OWNER_NOTIFY_EMAIL;
		const result = await processUpgradeRequestNotifications(bare, { limit: 10 });
		expect(result.skipped).toBeGreaterThanOrEqual(1);
	});

	it("grant writes the entitlement and settles the request in one step; dismiss closes it", async () => {
		const user = await signedUpUser();
		const req1 = await createUpgradeRequest(env, { userId: user.id, kind: "saves", note: "", usage: null });
		await grantEntitlement(env, {
			userId: user.id, grantedBy: "admin_test", days: 30, dailyNeurons: 30_000, requestId: req1.id,
		});
		const entitlements = await loadEntitlements(env, user.id);
		expect(entitlements.dailyNeurons).toBe(30_000);
		expect(entitlements.expiresAt).toBeGreaterThan(Date.now());
		const granted = await listUpgradeRequests(env, { status: "granted" });
		expect(granted.some((row) => row.id === req1.id)).toBe(true);
		const req2 = await createUpgradeRequest(env, { userId: user.id, kind: "huba", note: "", usage: null });
		expect((await dismissUpgradeRequest(env, { requestId: req2.id, resolvedBy: "admin_test" })).dismissed).toBe(true);
		expect((await dismissUpgradeRequest(env, { requestId: req2.id, resolvedBy: "admin_test" })).dismissed).toBe(false);
	});

	it("the self-service door requires a session and records a usage snapshot", async () => {
		expect((await jsonRequest("/v1/upgrade-requests", { kind: "saves" })).status).toBe(401);
		const user = await signedUpUser();
		await seedCalls(user.id, 3, { neurons: 100 });
		const res = await jsonRequest("/v1/upgrade-requests", { kind: "saves", note: "hi" }, { cookie: user.cookie });
		expect(res.status).toBe(200);
		const listed = await request("/v1/upgrade-requests", { headers: { cookie: user.cookie } });
		const body = await listed.json();
		expect(body.requests[0].kind).toBe("saves");
		const [row] = await listUpgradeRequests(env, { status: "open" }).then((rows) => rows.filter((r) => r.user_id === user.id));
		expect(row.usage.neurons_today).toBeGreaterThanOrEqual(300);
	});
});

describe("GET /v1/usage carries the daily and Huba blocks", () => {
	it("reports quota_daily in neurons with the reset instant", async () => {
		const user = await signedUpUser();
		await seedCalls(user.id, 2, { neurons: 150 });
		const res = await request("/v1/usage", { headers: { cookie: user.cookie } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.quota_daily).toMatchObject({ unit: "neurons", period: "utc_day", capped: false });
		expect(body.quota_daily.used).toBeGreaterThanOrEqual(300);
		expect(body.quota_daily.early_access).toBe(true);
		expect(new Date(body.quota_daily.resets_at).getTime()).toBeGreaterThan(Date.now());
		expect(body.huba).toMatchObject({ unit: "messages", used: 0 });
	});
});

describe("admin surfaces", () => {
	async function adminUser() {
		const user = await signedUpUser();
		await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(user.id).run();
		return user;
	}

	it("errors, ai-spend, and upgrade-request routes are admin-gated", async () => {
		const user = await signedUpUser();
		for (const path of ["/v1/admin/errors", "/v1/admin/ai-spend", "/v1/admin/upgrade-requests"]) {
			expect((await request(path)).status, path).toBe(401);
			expect((await request(path, { headers: { cookie: user.cookie } })).status, path).toBe(403);
		}
	});

	it("the error log filters and joins the reporter's email", async () => {
		const admin = await adminUser();
		await env.DB.prepare(
			"INSERT INTO error_reports (id, user_id, side, scope, message, created_at) VALUES (?, ?, 'server', 'huba_quota', 'a very specific failure', ?)",
		).bind(`err_${crypto.randomUUID()}`, admin.id, Date.now()).run();
		const res = await request("/v1/admin/errors?q=very+specific", { headers: { cookie: admin.cookie } });
		const body = await res.json();
		expect(body.errors.some((row) => row.message.includes("a very specific failure") && row.email === admin.email)).toBe(true);
	});

	it("grant_entitlement rides the audited admin action door", async () => {
		const admin = await adminUser();
		const target = await signedUpUser();
		const res = await jsonRequest("/v1/admin/users/action", {
			userId: target.id, action: "grant_entitlement", days: 7, daily_neurons: 20_000,
		}, { cookie: admin.cookie });
		expect(res.status).toBe(200);
		const entitlements = await loadEntitlements(env, target.id);
		expect(entitlements.dailyNeurons).toBe(20_000);
	});

	it("user-journey stitches the ledgers into one timeline", async () => {
		const admin = await adminUser();
		const res = await request(`/v1/admin/user-journey?id=${admin.id}`, { headers: { cookie: admin.cookie } });
		const body = await res.json();
		expect(Array.isArray(body.timeline)).toBe(true);
		expect(body).toHaveProperty("entitlement");
		expect(body).toHaveProperty("ai_spend_by_day");
		expect(body.timeline.some((event) => event.kind === "login")).toBe(true);
	});
});

describe("terminal-job pruning", () => {
	it("the sweep deletes terminal rows past the window and keeps fresh + non-terminal ones", async () => {
		const user = await signedUpUser();
		const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
		const insert = (id, status, completedAt, updatedAt) => env.DB.prepare(
			`INSERT INTO memory_jobs (id, user_id, type, status, idempotency_key, attempts, payload_json, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'extract', ?, ?, 0, '{}', ?, ?, ?)`,
		).bind(id, user.id, status, `idem_${id}`, old, updatedAt, completedAt);
		await env.DB.batch([
			insert("job_prune_old_done", "enriched", old, old),
			insert("job_prune_old_failed", "failed", old, old),
			insert("job_prune_old_unstamped", "completed", null, old),
			insert("job_prune_fresh", "enriched", Date.now(), Date.now()),
		]);
		const result = await runReconciliationSweep(env);
		expect(result.pruned).toBeGreaterThanOrEqual(3);
		const { results } = await env.DB.prepare(
			"SELECT id FROM memory_jobs WHERE user_id = ? ORDER BY id",
		).bind(user.id).all();
		expect(results.map((row) => row.id)).toEqual(["job_prune_fresh"]);
	});
});

describe("the Huba panel collapses rather than blinking out", () => {
	it("animates to a collapsed state and only then leaves the accessibility tree", async () => {
		const shell = (await import("../public/index.html?raw")).default;
		// The two visual states, and the transition between them.
		expect(shell).toContain('#hubaPanel[data-collapsed="true"]');
		expect(shell).toMatch(/#hubaPanel\s*\{[^}]*transform-origin:\s*top right/);
		expect(shell).toMatch(/#hubaPanel\s*\{[^}]*transition:[^;]*opacity[^;]*transform/);
		// Reduced motion must still be honoured.
		expect(shell).toMatch(/prefers-reduced-motion[\s\S]{0,200}#hubaPanel[^}]*transition: none/);

		const toggle = shell.slice(shell.indexOf("function toggleHuba(force)"), shell.indexOf("function hubaAppend"));
		// Expansion must NOT depend on requestAnimationFrame: rAF is throttled
		// to nothing in a backgrounded tab, which would open the panel
		// permanently invisible. A forced reflow always flushes.
		// (the comment in that function names rAF to explain the choice, so
		// assert on an actual CALL, not a mention)
		expect(toggle).not.toMatch(/requestAnimationFrame\s*\(/);
		expect(toggle).toContain("void panel.offsetHeight");
		// `hidden` is applied after the collapse, not instead of it.
		expect(toggle).toContain("HUBA.collapseTimer");
		expect(toggle).toMatch(/if \(!HUBA\.open\) panel\.hidden = true/);
		// A hidden element must never keep focus.
		expect(toggle).toContain("document.activeElement.blur?.()");
	});
});

describe("query plans (the 0058/0060 indexes actually serve the hot queries)", () => {
	async function plan(sql) {
		const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
		return (results ?? []).map((row) => row.detail).join(" | ");
	}

	it("both sweep queries SEARCH the status indexes instead of scanning", async () => {
		const rescue = await plan(
			"SELECT user_id, COUNT(*) AS n, MIN(updated_at) AS oldest FROM memory_jobs WHERE status IN ('queued','staged','processing') AND updated_at < 0 GROUP BY user_id ORDER BY oldest LIMIT 50",
		);
		expect(rescue).toContain("idx_memory_jobs_status_updated");
		expect(rescue).not.toContain("SCAN memory_jobs");
		const failed = await plan(
			"SELECT user_id, COUNT(*) AS n FROM memory_jobs WHERE status='failed' AND completed_at > 0 GROUP BY user_id LIMIT 50",
		);
		expect(failed).toContain("idx_memory_jobs_status_completed");
		expect(failed).not.toContain("SCAN memory_jobs");
	});

	it("the prune slices are index-served", async () => {
		const completed = await plan(
			"SELECT id FROM memory_jobs WHERE status IN ('enriched','completed','skipped','failed') AND completed_at IS NOT NULL AND completed_at < 0 LIMIT 400",
		);
		expect(completed).toContain("idx_memory_jobs_status_completed");
		expect(completed).not.toContain("SCAN memory_jobs");
	});

	it("retention's source_packets discovery runs as two index probes, no full scan", async () => {
		const discovery = await plan(
			"SELECT COALESCE(sp.memory_user_id, sp.user_id) FROM source_packets sp WHERE sp.owner_user_id = 'x' UNION SELECT COALESCE(sp.memory_user_id, sp.user_id) FROM source_packets sp WHERE sp.managed_project_id = 'y' LIMIT 10",
		);
		expect(discovery).toContain("idx_source_packets_owner");
		expect(discovery).toContain("idx_source_packets_managed_project");
		expect(discovery).not.toContain("SCAN source_packets");
	});

	it("the scope_json expression indexes serve the extraction_runs/receipts arms", async () => {
		const runs = await plan(
			"SELECT r.user_id FROM extraction_runs r WHERE json_valid(r.scope_json) AND json_extract(r.scope_json, '$.managed_project_id') = 'x'",
		);
		expect(runs).toContain("idx_extraction_runs_scope_project");
		const receipts = await plan(
			"SELECT r.user_id FROM receipts r WHERE json_valid(r.scope_json) AND json_extract(r.scope_json, '$.owner_user_id') = 'x'",
		);
		expect(receipts).toContain("idx_receipts_scope_owner");
	});
});

describe("capacity classification", () => {
	it("recognizes the Workers AI capacity shapes and nothing else", () => {
		expect(isCapacityError(new Error("3040: Out of capacity"))).toBe(true);
		expect(isCapacityError(new Error("Capacity temporarily exceeded, please try again"))).toBe(true);
		expect(isCapacityError(new Error("429 Too Many Requests"))).toBe(true);
		expect(isCapacityError(Object.assign(new Error("upstream"), { code: "3040" }))).toBe(true);
		expect(isCapacityError(new Error("model returned malformed JSON"))).toBe(false);
		expect(isCapacityError(new Error("network timeout"))).toBe(false);
		expect(isCapacityError(null)).toBe(false);
	});
});
