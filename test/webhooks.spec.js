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
	createWebhook, emitWebhookEvent, listDeliveries, listWebhooks, queueAuditedWebhookTest, retryPendingWebhookDeliveries,
	signWebhookBody, webhookUrlProblem,
} from "../src/pipeline/webhooks.js";
import { runAuditedMutation } from "../src/lib/audit.js";
import { capabilityGuardStatement, ensureDefaultOrganization, setProjectRole } from "../src/lib/organizations.js";
import { newId } from "../src/lib/ids.js";

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
		expect(webhookUrlProblem(`https://hooks.example.com/${"x".repeat(2050)}`, env)).toContain("2048");
		expect(webhookUrlProblem("https://hooks.example.com/path#private-fragment", env)).toContain("fragments");
	});

	it("keeps secret-bearing target paths and queries delivery-only", async () => {
		const { cookie, userId } = await sessionFor("wh-url-privacy");
		const canary = `private-${crypto.randomUUID()}`;
		const rawUrl = `https://hooks.example.com/a/${canary}?key=${canary}`;
		const req = new Request("http://example.com/v1/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ name: "masked target", url: rawUrl, events: ["memory.added"] }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(201);
		const created = await response.json();
		expect(created.webhook).toMatchObject({ display_url: "https://hooks.example.com/\u2026" });
		expect(created.webhook).not.toHaveProperty("url");
		expect(JSON.stringify(created)).not.toContain(canary);

		const listed = await listWebhooks(env, userId);
		expect(listed[0]).toMatchObject({ id: created.webhook.id, display_url: "https://hooks.example.com/\u2026" });
		expect(JSON.stringify(listed)).not.toContain(canary);

		const tasks = [];
		const deliveredTo = [];
		await emitWebhookEvent(env, (promise) => tasks.push(promise), userId, "memory.added", { counts: {} }, {
			fetchImpl: async (url) => { deliveredTo.push(url); return new Response("ok"); },
		});
		await Promise.all(tasks);
		expect(deliveredTo).toEqual([rawUrl]);

		await env.DB.prepare("UPDATE webhook_deliveries SET error = ? WHERE webhook_id = ?")
			.bind(`connection failed at ${rawUrl}`, created.webhook.id).run();
		const deliveries = await listDeliveries(env, userId, created.webhook.id);
		expect(deliveries[0].error).toBe("delivery_failed");
		expect(JSON.stringify(deliveries)).not.toContain(canary);
		const audit = await env.DB.prepare(
			"SELECT metadata_json FROM audit_events WHERE action = 'project.webhook.created' AND target_id = ?",
		).bind(created.webhook.id).first();
		expect(JSON.stringify(audit)).not.toContain(canary);
	});

	it("refuses them at the API too, with a friendly message", async () => {
		const { cookie } = await sessionFor("wh-ssrf");
		const req = new Request("http://example.com/v1/webhooks", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ name: "probe", url: "https://127.0.0.1:8787/x", events: ["memory.added"] }),
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
			 VALUES ('wh-evil', ?, 'evil', 'https://127.0.0.1:9999/x', 'whsec_test', '["memory.added"]', 0, 'active', 1, 1)`,
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

	it("never follows redirects or forwards a signing secret to another origin", async () => {
		const { userId } = await sessionFor("wh-redirect");
		const { webhook } = await createWebhook(env, userId, {
			name: "no redirects", url: "https://hooks.example.com/redirect", events: ["memory.added"],
		});
		const seen = [];
		await emitWebhookEvent(env, (p) => p, userId, "memory.added", { counts: { nodes: 1 } }, {
			fetchImpl: async (url, init) => {
				seen.push({ url, init });
				return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/latest/meta-data" } });
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toHaveLength(1); // redirects are terminal, never retried or followed
		expect(seen.every(({ url, init }) => url === "https://hooks.example.com/redirect" && init.redirect === "manual")).toBe(true);
		expect(seen.some(({ url }) => url.includes("127.0.0.1"))).toBe(false);
		const log = await listDeliveries(env, userId, webhook.id);
		expect(log[0]).toMatchObject({ status: "failed", response_code: 302 });
	});

	it("metadata-only mode never ships content", async () => {
		const { userId } = await sessionFor("wh-meta");
		const { webhook } = await createWebhook(env, userId, {
			name: "private", url: "https://hooks.example.com/meta", events: ["memory.enriched"], metadataOnly: true,
		});
		const seen = [];
		await emitWebhookEvent(env, (p) => p, userId, "memory.enriched", {
			source: "ingest", receipt_id: "r2", job_id: "job-2", source_packet_id: "src-2",
			status: "enriched", project_id: "local_opaque", project_name: "Deeply private project name",
			counts: { nodes: 1 }, new_node_labels: ["Deeply private thing"],
		}, { fetchImpl: async (url, init) => { seen.push(init.body); return new Response("ok"); } });
		await new Promise((r) => setTimeout(r, 50));

		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toContain("Deeply private thing");
		const payload = JSON.parse(seen[0]);
		expect(payload.metadata_only).toBe(true);
		expect(payload.data.counts.nodes).toBe(1);
		expect(payload.data).toMatchObject({
			receipt_id: "r2",
			job_id: "job-2",
			source_packet_id: "src-2",
			status: "enriched",
			project_id: "local_opaque",
		});
		expect(payload.data).not.toHaveProperty("project_name");
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

describe("durable outbox", () => {
	it("does not queue or fetch a webhook test when the member loses write access after authorization", async () => {
		const owner = await sessionFor("wh-test-owner");
		const collaborator = await sessionFor("wh-test-member");
		// Signup is intentionally lightweight. Exercise the supported discovery
		// door so the owner's legacy default organization/project is bootstrapped
		// before this test inspects its immutable storage boundary.
		const projectContext = createExecutionContext();
		const projectResponse = await worker.fetch(new Request("http://example.com/auth/projects", {
			headers: { cookie: owner.cookie },
		}), env, projectContext);
		await waitOnExecutionContext(projectContext);
		expect(projectResponse.status).toBe(200);
		const project = await env.DB.prepare(
			"SELECT * FROM managed_projects WHERE owner_user_id = ? AND is_default = 1 LIMIT 1",
		).bind(owner.userId).first();
		expect(project).toBeTruthy();
		const org = await ensureDefaultOrganization(env, owner.userId);
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO organization_members
			 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
		).bind(newId("orgm"), org.id, collaborator.userId, owner.userId, at, at).run();
		await setProjectRole(env, project.id, org.id, collaborator.userId, "member", owner.userId);
		const { webhook } = await createWebhook(env, project.memory_owner_user_id, {
			name: "race fence", url: "https://hooks.example.com/race", events: ["memory.added"],
		});
		let fetches = 0;
		await expect(runAuditedMutation(env, {
			orgId: org.id,
			projectId: project.id,
			actorUserId: collaborator.userId,
			action: "project.webhook.tested",
			targetType: "webhook",
			targetId: webhook.id,
			requestId: crypto.randomUUID(),
			authorizationGuards: [capabilityGuardStatement(env, {
				actorUserId: collaborator.userId,
				orgId: org.id,
				projectId: project.id,
				capability: "project.integrations.manage",
			})],
		}, async (intent) => {
			// Deterministic pause after route authorization + intent reservation.
			await env.DB.prepare(
				"UPDATE project_members SET role = 'viewer', updated_at = ? WHERE project_id = ? AND user_id = ?",
			).bind(at + 1, project.id, collaborator.userId).run();
			return queueAuditedWebhookTest(
				env,
				null,
				project.memory_owner_user_id,
				webhook.id,
				{ source: "webhook_test", counts: { nodes: 1 } },
				intent,
				{ fetchImpl: async () => { fetches += 1; return new Response("ok"); } },
			);
		})).rejects.toMatchObject({ code: "webhook_authorization_changed", status: 403 });
		expect(fetches).toBe(0);
		expect(await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?",
		).bind(webhook.id).first()).toEqual({ n: 0 });
		expect(await env.DB.prepare(
			"SELECT outcome FROM audit_events WHERE action = 'project.webhook.tested' AND target_id = ?",
		).bind(webhook.id).first()).toEqual({ outcome: "denied" });
	});

	it("deduplicates concurrent emission of one logical event", async () => {
		const { userId } = await sessionFor("wh-once");
		const { webhook } = await createWebhook(env, userId, {
			name: "once", url: "https://hooks.example.com/once", events: ["memory.enriched"],
		});
		const tasks = [];
		let calls = 0;
		const opts = {
			eventId: `job:${crypto.randomUUID()}:enriched`,
			fetchImpl: async () => { calls++; return new Response("ok"); },
		};
		await Promise.all(Array.from({ length: 8 }, () => emitWebhookEvent(
			env,
			(promise) => tasks.push(promise),
			userId,
			"memory.enriched",
			{ job_id: "job-once", status: "enriched" },
			opts,
		)));
		await Promise.all(tasks);

		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM webhook_deliveries WHERE user_id = ? AND webhook_id = ?",
		).bind(userId, webhook.id).first();
		expect(count.n).toBe(1);
		expect(calls).toBe(1);
		expect((await listDeliveries(env, userId, webhook.id))[0].status).toBe("delivered");
	});

	it("reclaims and delivers a pending row left by an isolate interruption", async () => {
		const { userId } = await sessionFor("wh-recover");
		const { webhook } = await createWebhook(env, userId, {
			name: "recover", url: "https://hooks.example.com/recover", events: ["memory.failed"],
		});
		const deliveryId = `whd_recover_${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO webhook_deliveries
			 (id, user_id, webhook_id, event, status, attempts, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'memory.failed', 'pending', 0, ?, ?, ?)`,
		).bind(
			deliveryId,
			userId,
			webhook.id,
			JSON.stringify({ id: "evt-recover", event: "memory.failed", created_at: now, data: { job_id: "job-recover" } }),
			now,
			now,
		).run();

		const tasks = [];
		let calls = 0;
		const recovered = await retryPendingWebhookDeliveries(
			env,
			(promise) => tasks.push(promise),
			{ fetchImpl: async () => { calls++; return new Response("ok"); } },
		);
		await Promise.all(tasks);

		expect(recovered).toEqual({ dispatched: 1 });
		expect(calls).toBe(1);
		const row = await env.DB.prepare(
			"SELECT status, attempts FROM webhook_deliveries WHERE id = ?",
		).bind(deliveryId).first();
		expect(row).toMatchObject({ status: "delivered", attempts: 1 });
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
		expect(log[0].error).toBe("delivery_failed");
	}, 45000);
});
