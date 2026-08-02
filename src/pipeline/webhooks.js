/**
 * Webhooks — announce memory changes to endpoints the user registered.
 *
 * The three hard rules:
 *   1. Delivery is ASYNC. A dead customer endpoint must never block /v1/save —
 *      everything here runs behind waitUntil, off the request path.
 *   2. Every delivery is HMAC-signed with the webhook's own secret
 *      (x-itsuki-signature: t=<ms>,v1=<hex>, over `${t}.${body}`), so a
 *      receiver can prove the event came from us and is not a replay.
 *   3. Private addresses are refused at registration AND re-checked at
 *      delivery time — otherwise a user enters http://localhost and turns the
 *      worker into an internal-network probe.
 */

import { newId } from "../lib/ids.js";

export const WEBHOOK_EVENTS = ["memory.added", "memory.updated", "memory.deleted", "memory.categorized"];

const MAX_WEBHOOKS_PER_USER = 10;
const ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 5000, 15000];
const DELIVERY_TIMEOUT_MS = 10000;

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

function isPrivateIpv4(host) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true; // link-local / cloud metadata
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

function isPrivateIpv6(host) {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
}

/**
 * Why a URL cannot be delivered to, or null if it is acceptable. Applied at
 * registration and again immediately before every delivery attempt.
 * WEBHOOK_ALLOW_PRIVATE="true" (local dev only) relaxes the private-address
 * rules so the delivery machinery itself can be tested against a local
 * receiver; production never sets it.
 */
export function webhookUrlProblem(rawUrl, env = {}) {
	let url;
	try {
		url = new URL(String(rawUrl ?? ""));
	} catch {
		return "That doesn't look like a valid URL.";
	}
	if (!["https:", "http:"].includes(url.protocol)) {
		return "Webhook URLs must be http(s).";
	}
	if (url.username || url.password) return "Webhook URLs must not embed credentials.";
	const host = url.hostname;
	const allowPrivate = String(env.WEBHOOK_ALLOW_PRIVATE ?? "") === "true";
	if (!allowPrivate) {
		if (PRIVATE_HOST_RE.test(host) || isPrivateIpv4(host) || isPrivateIpv6(host)) {
			return "Private and internal addresses can't receive webhooks.";
		}
	}
	// Never deliver to ourselves — a webhook that posts back into the API
	// would loop.
	if (/(^|\.)itsuki\.app$/i.test(host) || /\.workers\.dev$/i.test(host)) {
		return "Webhooks can't point back at Itsuki.";
	}
	return null;
}

async function hmacHex(secret, message) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stripe-style signature header over `${t}.${body}`. */
export async function signWebhookBody(secret, body, t = Date.now()) {
	return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

function normalizeEvents(events) {
	const list = (Array.isArray(events) ? events : []).filter((e) => WEBHOOK_EVENTS.includes(e));
	return list.length ? [...new Set(list)] : [...WEBHOOK_EVENTS];
}

function publicWebhook(row) {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		events: JSON.parse(row.events_json || "[]"),
		metadata_only: Number(row.metadata_only ?? 0) === 1,
		status: row.status,
		created_at: row.created_at,
		secret_hint: row.secret ? `${row.secret.slice(0, 10)}…${row.secret.slice(-4)}` : null,
	};
}

export async function listWebhooks(env, userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM webhooks WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC",
	).bind(userId).all();
	return (results ?? []).map(publicWebhook);
}

export async function createWebhook(env, userId, body = {}) {
	const problem = webhookUrlProblem(body.url, env);
	if (problem) return { error: problem };
	const existing = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ? AND status = 'active'",
	).bind(userId).first();
	if (Number(existing?.n ?? 0) >= MAX_WEBHOOKS_PER_USER) {
		return { error: `You can have up to ${MAX_WEBHOOKS_PER_USER} webhooks — delete one first.` };
	}
	const secretBytes = new Uint8Array(32);
	crypto.getRandomValues(secretBytes);
	const secret = `whsec_${[...secretBytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	const row = {
		id: newId("wh"),
		user_id: userId,
		name: String(body.name ?? "").trim().slice(0, 80) || "Webhook",
		url: String(body.url),
		secret,
		events_json: JSON.stringify(normalizeEvents(body.events)),
		metadata_only: body.metadataOnly === true || body.metadata_only === true ? 1 : 0,
		status: "active",
		created_at: Date.now(),
		updated_at: Date.now(),
	};
	await env.DB.prepare(
		`INSERT INTO webhooks (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(row.id, row.user_id, row.name, row.url, row.secret, row.events_json, row.metadata_only, row.status, row.created_at, row.updated_at).run();
	// The secret appears exactly once: in this response.
	return { webhook: publicWebhook(row), secret };
}

export async function deleteWebhook(env, userId, id) {
	const result = await env.DB.prepare(
		"DELETE FROM webhooks WHERE id = ? AND user_id = ?",
	).bind(id, userId).run();
	return { deleted: (result.meta?.changes ?? 0) > 0 };
}

export async function listDeliveries(env, userId, webhookId, limit = 50) {
	const { results } = await env.DB.prepare(
		`SELECT id, event, status, attempts, response_code, error, created_at, delivered_at
		 FROM webhook_deliveries WHERE user_id = ? AND webhook_id = ?
		 ORDER BY created_at DESC LIMIT ?`,
	).bind(userId, webhookId, Math.min(limit, 200)).all();
	return results ?? [];
}

/**
 * Build the payload for one webhook. metadata_only strips everything that
 * could carry the person's words — kind, counts and ids only.
 */
function payloadFor(hook, event, data) {
	const base = { id: newId("evt"), event, created_at: Date.now() };
	if (Number(hook.metadata_only ?? 0) === 1) {
		return {
			...base,
			metadata_only: true,
			data: {
				source: data?.source ?? null,
				counts: data?.counts ?? null,
				receipt_id: data?.receipt_id ?? null,
			},
		};
	}
	return { ...base, metadata_only: false, data: data ?? {} };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One delivery, with retries and a visible log row. Runs inside waitUntil. */
async function deliver(env, hook, deliveryId, body, { fetchImpl = fetch } = {}) {
	let lastError = null;
	let lastCode = null;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		if (RETRY_DELAYS_MS[attempt - 1]) await sleep(RETRY_DELAYS_MS[attempt - 1]);
		// Re-check the target right before connecting: registration-time checks
		// don't protect against a DB edited by other means.
		const problem = webhookUrlProblem(hook.url, env);
		if (problem) {
			lastError = problem;
			break;
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
			const res = await fetchImpl(hook.url, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					"user-agent": "itsuki-webhooks/1.0",
					"x-itsuki-event": JSON.parse(body).event,
					"x-itsuki-webhook-id": hook.id,
					"x-itsuki-signature": await signWebhookBody(hook.secret, body),
				},
				body,
			});
			clearTimeout(timer);
			lastCode = res.status;
			if (res.ok) {
				await env.DB.prepare(
					"UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, delivered_at = ? WHERE id = ?",
				).bind(attempt, res.status, Date.now(), deliveryId).run();
				return;
			}
			lastError = `endpoint answered ${res.status}`;
		} catch (err) {
			lastError = String(err?.message ?? err).slice(0, 200);
		}
		await env.DB.prepare(
			"UPDATE webhook_deliveries SET attempts = ?, response_code = ?, error = ? WHERE id = ?",
		).bind(attempt, lastCode, lastError, deliveryId).run();
	}
	await env.DB.prepare(
		"UPDATE webhook_deliveries SET status = 'failed', response_code = ?, error = ? WHERE id = ?",
	).bind(lastCode, lastError, deliveryId).run();
}

/**
 * Fire an event to every matching webhook. Fire-and-forget: the caller hands
 * us waitUntil and moves on. A failure here can never surface to a save.
 */
export async function emitWebhookEvent(env, waitUntil, userId, event, data, opts = {}) {
	try {
		const { results } = await env.DB.prepare(
			"SELECT * FROM webhooks WHERE user_id = ? AND status = 'active'",
		).bind(userId).all();
		const hooks = (results ?? []).filter((hook) => {
			try { return JSON.parse(hook.events_json || "[]").includes(event); } catch { return false; }
		});
		for (const hook of hooks) {
			const payload = payloadFor(hook, event, data);
			const body = JSON.stringify(payload);
			const deliveryId = newId("whd");
			await env.DB.prepare(
				`INSERT INTO webhook_deliveries (id, user_id, webhook_id, event, status, attempts, payload_json, created_at)
				 VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
			).bind(deliveryId, userId, hook.id, event, body, Date.now()).run();
			const task = deliver(env, hook, deliveryId, body, opts).catch((err) => {
				console.warn("webhook delivery crashed:", err?.message ?? err);
			});
			if (typeof waitUntil === "function") waitUntil(task);
		}
	} catch (err) {
		// Webhooks must never break the save that triggered them.
		console.warn("webhook emit failed:", err?.message ?? err);
	}
}

/** What a save receipt looks like as webhook data (full mode). */
export function webhookDataFromReceipt(receipt) {
	const saved = receipt?.saved ?? {};
	return {
		source: receipt?.source ?? null,
		receipt_id: receipt?.id ?? null,
		counts: {
			nodes: saved.nodes ?? 0,
			updated_nodes: saved.updatedNodes ?? 0,
			slices: saved.slices ?? 0,
			events: saved.events ?? 0,
			edges: saved.edges ?? 0,
		},
		new_node_labels: saved.newNodeLabels ?? [],
	};
}
