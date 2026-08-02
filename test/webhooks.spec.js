/**
 * Webhooks. The three properties that matter:
 *   - private/internal targets are refused, at registration and delivery
 *   - every delivery is HMAC-signed and independently verifiable
 *   - a dead endpoint burns retries in the background and never a save
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import {
	createWebhook, emitWebhookEvent, listDeliveries, signWebhookBody, webhookUrlProblem,
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

async function verifySignature(secret, header, body) {
	const t = /t=(\d+)/.exec(header)?.[1];
	const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
	const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return expected === v1;
}

describe("SSRF wall", () => {
	it("refuses every private, internal, and self-referential target", () => {
		const refused = [
			"http://127.0.0.1:8787/hook",
			"http://localhost/hook",
			"https://localhost:8443/x",
			"http://10.0.0.4/h",
			"http://172.20.1.1/h",
			"http://192.168.1.10/h",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.100.1.1/h",
			"http://[::1]/h",
			"http://[fd00::2]/h",
			"http://internal.corp.local/h",
			"http://ci.build.internal/h",
			"https://itsuki.app/v1/save",
			"https://uml.gpmai.workers.dev/v1/save",
			"ftp://example.com/h",
			"https://user:pass@example.com/h",
			"not a url",
		];
		for (const url of refused) {
			expect(webhookUrlProblem(url, env), url).toBeTruthy();
		}
		expect(webhookUrlProblem("https://hooks.example.com/itsuki", env)).toBeNull();
	});

	it("refuses them at the API too, with a friendly message", async () => {
		const { cookie } = await sessionFor("wh-ssrf");
		const req = new Request("http://example.com/v1/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ name: "probe", url: "http://127.0.0.1:8787/x", events: ["memory.added"] }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.message).toContain("Private and internal addresses");
	});

	it("re-checks at delivery time even if a private URL reached the table", async () => {
		const { userId } = await sessionFor("wh-late");
		// Simulate a row edited outside the API.
		await env.DB.prepare(
			`INSERT INTO webhooks (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
			 VALUES ('wh-evil', ?, 'evil', 'http://127.0.0.1:9999/x', 'whsec_test', '["memory.added"]', 0, 'active', 1, 1)`,
		).bind(userId).run();
		let fetched = 0;
		await emitWebhookEvent(env, (p) => p, userId, "memory.added", { counts: {} }, {
			fetchImpl: async () => { fetched++; return new Response("ok"); },
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(fetched).toBe(0);
		const log = await listDeliveries(env, userId, "wh-evil");
		expect(log[0]?.status).toBe("failed");
		expect(log[0]?.error).toContain("Private and internal");
	});
});

describe("signing and payloads", () => {
	it("delivers a signed payload a receiver can independently verify", async () => {
		const { userId } = await sessionFor("wh-sign");
		const { webhook, secret } = await createWebhook(env, userId, {
			name: "verify", url: "https://hooks.example.com/x", events: ["memory.added"],
		});
		expect(secret.startsWith("whsec_")).toBe(true);

		const seen = [];
		await emitWebhookEvent(env, (p) => p, userId, "memory.added", {
			source: "ingest", receipt_id: "r1",
			counts: { nodes: 2, edges: 1 }, new_node_labels: ["Amara", "Nova Systems"],
		}, {
			fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response("ok", { status: 200 }); },
		});
		await new Promise((r) => setTimeout(r, 50));

		expect(seen).toHaveLength(1);
		const { url, init } = seen[0];
		expect(url).toBe("https://hooks.example.com/x");
		expect(init.headers["x-itsuki-event"]).toBe("memory.added");
		expect(init.headers["x-itsuki-webhook-id"]).toBe(webhook.id);
		// The receiver-side check, done exactly as a receiver would.
		expect(await verifySignature(secret, init.headers["x-itsuki-signature"], init.body)).toBe(true);
		// Tampered body fails.
		expect(await verifySignature(secret, init.headers["x-itsuki-signature"], init.body + "x")).toBe(false);

		const payload = JSON.parse(init.body);
		expect(payload.event).toBe("memory.added");
		expect(payload.data.new_node_labels).toContain("Amara");

		const log = await listDeliveries(env, userId, webhook.id);
		expect(log[0].status).toBe("delivered");
		expect(log[0].response_code).toBe(200);
	});

	it("metadata-only mode never ships content", async () => {
		const { userId } = await sessionFor("wh-meta");
		const { webhook } = await createWebhook(env, userId, {
			name: "private", url: "https://hooks.example.com/meta", events: ["memory.added"], metadataOnly: true,
		});
		const seen = [];
		await emitWebhookEvent(env, (p) => p, userId, "memory.added", {
			source: "ingest", receipt_id: "r2",
			counts: { nodes: 1 }, new_node_labels: ["Deeply private thing"],
		}, { fetchImpl: async (url, init) => { seen.push(init.body); return new Response("ok"); } });
		await new Promise((r) => setTimeout(r, 50));

		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain("Deeply private thing");
		const payload = JSON.parse(seen[0]);
		expect(payload.metadata_only).toBe(true);
		expect(payload.data.counts.nodes).toBe(1);
		// The stored log row is equally content-free.
		const log = await listDeliveries(env, userId, webhook.id);
		const { results } = await env.DB.prepare("SELECT payload_json FROM webhook_deliveries WHERE webhook_id = ?").bind(webhook.id).all();
		expect(results[0].payload_json).not.toContain("Deeply private thing");
		expect(log[0].status).toBe("delivered");
	});

	it("only subscribed events fire", async () => {
		const { userId } = await sessionFor("wh-filter");
		await createWebhook(env, userId, { name: "adds only", url: "https://hooks.example.com/a", events: ["memory.added"] });
		let calls = 0;
		await emitWebhookEvent(env, (p) => p, userId, "memory.deleted", { counts: {} }, {
			fetchImpl: async () => { calls++; return new Response("ok"); },
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toBe(0);
	});
});

describe("a dead endpoint", () => {
	it("burns its retries in the background and the log says so", async () => {
		const { userId } = await sessionFor("wh-dead");
		const { webhook } = await createWebhook(env, userId, {
			name: "down", url: "https://hooks.example.com/down", events: ["memory.added"],
		});
		let attempts = 0;
		const tasks = [];
		// The emit call itself must return fast — that's the /v1/save guarantee.
		const started = Date.now();
		await emitWebhookEvent(env, (p) => tasks.push(p), userId, "memory.added", { counts: {} }, {
			fetchImpl: async () => { attempts++; throw new Error("ECONNREFUSED"); },
		});
		const emitMs = Date.now() - started;
		expect(emitMs).toBeLessThan(1000);

		await Promise.all(tasks); // the background work, awaited only by the test
		expect(attempts).toBe(3);
		const log = await listDeliveries(env, userId, webhook.id);
		expect(log[0].status).toBe("failed");
		expect(log[0].attempts).toBe(3);
		expect(log[0].error).toContain("ECONNREFUSED");
	}, 45000);
});
