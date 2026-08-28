/**
 * The delivery contract itself, as a receiver and an auditor would state it:
 *
 *   - a delivered event is delivered ONCE, and the outbox never re-sends it
 *   - a refusing endpoint is retried on a widening backoff and then dead-lettered,
 *     and the dead letter is terminal
 *   - NO delivery row is left non-terminal with nothing left to sweep it —
 *     including when the webhook it belonged to is deleted underneath it
 *   - two accounts share nothing: not an endpoint, not a log, not a delete
 *   - the signing secret is handed over once, at creation, and by no read route
 *   - a hanging endpoint holds up the delivery, never the write that caused it
 *
 * test/webhooks.spec.js owns the SSRF wall, signature verification,
 * metadata-only redaction, event filtering and the audit fence. Nothing here
 * restates those.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import {
	createWebhook, deleteWebhook, emitWebhookEvent, listDeliveries, listWebhooks,
	retryPendingWebhookDeliveries, webhookUrlProblem,
} from "../src/pipeline/webhooks.js";

async function sessionFor(prefix) {
	const req = new Request("http://example.com/auth/signup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: prefix, acceptTerms: true }),
	});
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	const body = await res.json();
	return { cookie: res.headers.get("set-cookie").split(";")[0], userId: body.user.id };
}

async function call(method, path, cookie, body) {
	const req = new Request(`http://example.com${path}`, {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	const text = await res.text();
	return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** The stored row, read raw — the outbox's own view, not the redacted log. */
function deliveryRow(id) {
	return env.DB.prepare(
		"SELECT id, user_id, webhook_id, status, attempts, response_code, error, delivered_at FROM webhook_deliveries WHERE id = ?",
	).bind(id).first();
}

function rowsFor(webhookId) {
	return env.DB.prepare(
		"SELECT id, status, attempts, response_code, delivered_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at ASC",
	).bind(webhookId).all();
}

/**
 * Sweep as the cron does. Deliberately URL-scoped rather than count-scoped:
 * the pool stacks storage across tests in a file, so a global "nothing was
 * fetched" claim would be a claim about other tests' rows too.
 */
async function sweep({ expectNoFetchTo = [] } = {}) {
	const fetched = [];
	const tasks = [];
	const result = await retryPendingWebhookDeliveries(env, (promise) => tasks.push(promise), {
		fetchImpl: async (url) => { fetched.push(url); return new Response("ok"); },
	});
	await Promise.all(tasks);
	for (const url of expectNoFetchTo) expect(fetched, `swept a terminal delivery to ${url}`).not.toContain(url);
	return { ...result, fetched };
}

describe("a delivered event is delivered once", () => {
	it("marks the row sent, once, and no later sweep re-sends it", async () => {
		const { userId } = await sessionFor("whc-once");
		const url = `https://hooks.example.com/once-${crypto.randomUUID()}`;
		const { webhook } = await createWebhook(env, userId, {
			name: "once", url, events: ["memory.enriched"],
		});

		const tasks = [];
		let calls = 0;
		await emitWebhookEvent(env, (promise) => tasks.push(promise), userId, "memory.enriched", {
			job_id: "job-once", status: "enriched", counts: { nodes: 1 },
		}, { fetchImpl: async () => { calls++; return new Response("ok", { status: 200 }); } });
		await Promise.all(tasks);

		expect(calls).toBe(1);
		const { results } = await rowsFor(webhook.id);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ status: "delivered", attempts: 1, response_code: 200 });
		expect(results[0].delivered_at).toBeGreaterThan(0);
		const settled = results[0];

		// Two full cron sweeps. A delivered row is terminal: not re-claimed, not
		// re-sent, not re-stamped.
		await sweep({ expectNoFetchTo: [url] });
		await sweep({ expectNoFetchTo: [url] });

		const after = await rowsFor(webhook.id);
		expect(after.results).toHaveLength(1);
		expect(after.results[0]).toEqual(settled);
		expect(calls).toBe(1);
	});
});

describe("an endpoint that refuses", () => {
	it("retries on a widening backoff, dead-letters, and stays dead", async () => {
		const { userId } = await sessionFor("whc-500");
		const url = `https://hooks.example.com/five-hundred-${crypto.randomUUID()}`;
		const { webhook } = await createWebhook(env, userId, {
			name: "always 500", url, events: ["memory.added"],
		});

		const at = [];
		const tasks = [];
		const started = Date.now();
		await emitWebhookEvent(env, (promise) => tasks.push(promise), userId, "memory.added", { counts: { nodes: 1 } }, {
			fetchImpl: async () => { at.push(Date.now()); return new Response("no thanks", { status: 500 }); },
		});
		// The write that caused this is already done; only the test waits.
		expect(Date.now() - started).toBeLessThan(1000);
		await Promise.all(tasks);

		// Three attempts, and the gaps widen — a fixed or absent backoff fails here.
		expect(at).toHaveLength(3);
		const first = at[1] - at[0];
		const second = at[2] - at[1];
		expect(first).toBeGreaterThanOrEqual(4500);
		expect(second).toBeGreaterThanOrEqual(14500);
		expect(second).toBeGreaterThan(first);

		const { results } = await rowsFor(webhook.id);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ status: "failed", attempts: 3, response_code: 500 });
		expect(results[0].delivered_at).toBeNull();
		// The user-visible log names the endpoint's own verdict.
		const log = await listDeliveries(env, userId, webhook.id);
		expect(log[0]).toMatchObject({ status: "failed", attempts: 3, error: "endpoint answered 500" });

		// Dead-lettered is terminal: the sweep leaves it alone forever.
		await sweep({ expectNoFetchTo: [url] });
		await sweep({ expectNoFetchTo: [url] });
		const after = await rowsFor(webhook.id);
		expect(after.results[0]).toMatchObject({ status: "failed", attempts: 3 });
	}, 45000);

	it("dead-letters a delivery whose webhook was deleted underneath it", async () => {
		// The dispatch query is an INNER JOIN on webhooks and deleting a webhook
		// is a hard DELETE. A row still 'pending' at that moment would otherwise
		// be stranded: never sent, never failed, and invisible to every later
		// sweep — a delivery lost in silence.
		const { userId } = await sessionFor("whc-orphan");
		const url = `https://hooks.example.com/orphan-${crypto.randomUUID()}`;
		const { webhook } = await createWebhook(env, userId, { name: "doomed", url, events: ["memory.added"] });

		const deliveryId = `whd_orphan_${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, attempts, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.added', 'pending', 0, ?, ?, ?)`,
		).bind(
			deliveryId, userId, webhook.id,
			JSON.stringify({ id: "evt-orphan", event: "memory.added", created_at: now, data: { counts: {} } }),
			now, now,
		).run();

		expect(await deleteWebhook(env, userId, webhook.id)).toEqual({ deleted: true });
		expect(await deliveryRow(deliveryId)).toMatchObject({ status: "pending" });

		await sweep({ expectNoFetchTo: [url] });

		const settled = await deliveryRow(deliveryId);
		expect(settled.status).toBe("failed");
		expect(settled.delivered_at).toBeNull();
		// Terminal, and it stays terminal.
		await sweep({ expectNoFetchTo: [url] });
		expect(await deliveryRow(deliveryId)).toMatchObject({ status: "failed" });
		// Terminal in the outbox is still redacted in the log.
		const log = await listDeliveries(env, userId, webhook.id);
		expect(log[0].error).toBe("delivery_failed");
	});

	it("strands nothing: after a sweep no delivery sits pending without a live webhook", async () => {
		// The invariant the previous test protects, stated over the whole table.
		await sweep();
		const stranded = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM webhook_deliveries d
			  WHERE d.status = 'pending'
			    AND NOT EXISTS (
			      SELECT 1 FROM webhooks w
			       WHERE w.id = d.webhook_id AND w.user_id = d.user_id AND w.status = 'active'
			    )`,
		).first();
		expect(stranded).toEqual({ n: 0 });
	});
});

describe("two accounts share nothing", () => {
	it("keeps endpoints, logs and deletes on their own side of the wall", async () => {
		const a = await sessionFor("whc-tenant-a");
		const b = await sessionFor("whc-tenant-b");
		const aUrl = `https://hooks.example.com/tenant-a-${crypto.randomUUID()}`;
		const bUrl = `https://hooks.example.com/tenant-b-${crypto.randomUUID()}`;
		const { webhook: aHook } = await createWebhook(env, a.userId, { name: "A", url: aUrl, events: ["memory.added"] });
		const { webhook: bHook } = await createWebhook(env, b.userId, { name: "B", url: bUrl, events: ["memory.added"] });

		// A's event reaches A's endpoint and only A's endpoint.
		const fetched = [];
		const tasks = [];
		await emitWebhookEvent(env, (promise) => tasks.push(promise), a.userId, "memory.added", { counts: { nodes: 1 } }, {
			fetchImpl: async (url) => { fetched.push(url); return new Response("ok"); },
		});
		await Promise.all(tasks);
		expect(fetched).toEqual([aUrl]);

		// The delivery row is stamped with A, and B has none.
		const { results: aRows } = await rowsFor(aHook.id);
		expect(aRows).toHaveLength(1);
		expect(await deliveryRow(aRows[0].id)).toMatchObject({ user_id: a.userId, webhook_id: aHook.id });
		expect((await rowsFor(bHook.id)).results).toHaveLength(0);

		// B cannot see A's endpoint or A's log, through the module or the API.
		expect((await listWebhooks(env, b.userId)).map((w) => w.id)).toEqual([bHook.id]);
		expect(await listDeliveries(env, b.userId, aHook.id)).toEqual([]);

		const listedByB = await call("GET", "/v1/webhooks", b.cookie);
		expect(listedByB.status).toBe(200);
		expect(listedByB.json.webhooks.map((w) => w.id)).toEqual([bHook.id]);
		expect(listedByB.text).not.toContain(aHook.id);

		const logByB = await call("GET", `/v1/webhooks/${aHook.id}/deliveries`, b.cookie);
		expect(logByB.status).toBe(200);
		expect(logByB.json.deliveries).toEqual([]);

		// And B cannot delete it out from under A.
		await call("DELETE", `/v1/webhooks/${aHook.id}`, b.cookie);
		expect((await listWebhooks(env, a.userId)).map((w) => w.id)).toContain(aHook.id);
		expect((await rowsFor(aHook.id)).results).toHaveLength(1);
	});
});

describe("the signing secret", () => {
	it("is handed over once, at creation, and by no read route after that", async () => {
		const { cookie, userId } = await sessionFor("whc-secret");
		const url = `https://hooks.example.com/secret-${crypto.randomUUID()}`;
		const created = await call("POST", "/v1/webhooks", cookie, {
			name: "secretive", url, events: ["memory.added"],
		});
		expect(created.status).toBe(201);
		const secret = created.json.secret;
		expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
		const webhookId = created.json.webhook.id;

		// A hint, not the key: strictly shorter than what it stands for.
		const hint = created.json.webhook.secret_hint;
		expect(hint).toBeTruthy();
		expect(hint.length).toBeLessThan(secret.length);
		expect(secret).not.toContain(hint);

		const listed = await call("GET", "/v1/webhooks", cookie);
		expect(listed.status).toBe(200);
		expect(listed.text).not.toContain(secret);
		expect(listed.json.webhooks.find((w) => w.id === webhookId).secret_hint).toBe(hint);
		expect(JSON.stringify(await listWebhooks(env, userId))).not.toContain(secret);

		// Deliver, so there is a log row and a stored payload to check too.
		const tasks = [];
		let sentHeaders = null;
		let sentBody = null;
		await emitWebhookEvent(env, (promise) => tasks.push(promise), userId, "memory.added", { counts: { nodes: 1 } }, {
			fetchImpl: async (target, init) => { sentHeaders = init.headers; sentBody = init.body; return new Response("ok"); },
		});
		await Promise.all(tasks);

		// The wire carries a signature derived from the secret, never the secret.
		expect(JSON.stringify(sentHeaders)).not.toContain(secret);
		expect(sentHeaders["x-itsuki-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(sentBody).not.toContain(secret);

		const log = await call("GET", `/v1/webhooks/${webhookId}/deliveries`, cookie);
		expect(log.status).toBe(200);
		expect(log.json.deliveries).toHaveLength(1);
		expect(log.text).not.toContain(secret);
		expect(JSON.stringify(await listDeliveries(env, userId, webhookId))).not.toContain(secret);

		const stored = await env.DB.prepare(
			"SELECT payload_json FROM webhook_deliveries WHERE webhook_id = ?",
		).bind(webhookId).first();
		expect(stored.payload_json).not.toContain(secret);
	});
});

describe("an endpoint that hangs", () => {
	it("holds up its own delivery and nothing else", async () => {
		const { userId } = await sessionFor("whc-hang");
		const url = `https://hooks.example.com/hang-${crypto.randomUUID()}`;
		const { webhook } = await createWebhook(env, userId, { name: "hang", url, events: ["memory.added"] });

		let release;
		let announceConnected;
		const hang = new Promise((resolve) => { release = resolve; });
		const connected = new Promise((resolve) => { announceConnected = resolve; });

		const tasks = [];
		const started = Date.now();
		await emitWebhookEvent(env, (promise) => tasks.push(promise), userId, "memory.added", { counts: { nodes: 1 } }, {
			fetchImpl: async () => { announceConnected(); await hang; return new Response("ok"); },
		});
		const emitMs = Date.now() - started;

		// emit returned without waiting on the fetch it was about to start: the
		// save path is free before the endpoint has even been dialled.
		expect(emitMs).toBeLessThan(1000);
		await connected; // now the socket is open and stays open
		const inFlight = await rowsFor(webhook.id);
		expect(inFlight.results).toHaveLength(1);
		expect(inFlight.results[0]).toMatchObject({ status: "dispatching", attempts: 0 });
		expect(inFlight.results[0].delivered_at).toBeNull();

		release();
		await Promise.all(tasks);
		const settled = await rowsFor(webhook.id);
		expect(settled.results).toHaveLength(1);
		expect(settled.results[0]).toMatchObject({ status: "delivered", attempts: 1, response_code: 200 });
	});
});

describe("the private-address wall reads addresses, not spellings", () => {
	it("refuses a loopback or RFC1918 address written as an IPv6 literal", () => {
		// `new URL("https://[::ffff:127.0.0.1]/")` serializes the host back as
		// `[::ffff:7f00:1]`, so a dotted-quad check never sees the loopback it
		// contains. The compatibility flag global_fetch_strictly_public would
		// refuse the connection anyway — this asserts the wall the module
		// documents, which is supposed to hold on its own.
		for (const url of [
			"https://[::ffff:127.0.0.1]/h",
			"https://[::ffff:10.0.0.1]/h",
			"https://[::ffff:192.168.1.10]/h",
			"https://[::ffff:169.254.169.254]/latest/meta-data/",
			"https://[::ffff:7f00:1]/h",
			"https://[0:0:0:0:0:ffff:7f00:1]/h",
			"https://[64:ff9b::169.254.169.254]/h",
			"https://[::127.0.0.1]/h",
			"https://[0:0:0:0:0:0:0:1]/h",
		]) {
			expect(webhookUrlProblem(url, env), url).toContain("Private and internal");
		}
		// A public address, however spelled, still gets through.
		expect(webhookUrlProblem("https://hooks.example.com/itsuki", env)).toBeNull();
		expect(webhookUrlProblem("https://[2606:4700:4700::1111]/h", env)).toBeNull();
		expect(webhookUrlProblem("https://[::ffff:93.184.216.34]/h", env)).toBeNull();
	});
});
