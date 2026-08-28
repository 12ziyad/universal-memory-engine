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
import {
	auditedMutationResult,
	auditInvariantStatement,
	commitAuditedBatch,
	commitAuditedNoop,
} from "../lib/audit.js";

export const WEBHOOK_EVENTS = [
	"memory.added",
	"memory.updated",
	"memory.deleted",
	"memory.categorized",
	// Job lifecycle (fix round 1, Part 2.3): one terminal event per accepted
	// write — enriched or failed, never neither.
	"memory.enriched",
	"memory.failed",
];

const MAX_WEBHOOKS_PER_USER = 10;
const ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 5000, 15000];
const DELIVERY_TIMEOUT_MS = 10000;
// The outer bound on how long an undelivered event may keep costing sweeps.
// A day of five-minute retries is a generous window for an endpoint to come
// back; past it the delivery is a dead letter, not a pending one.
const DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

async function deterministicDeliveryId(eventId, webhookId) {
	const bytes = new TextEncoder().encode(`${eventId}\u0000${webhookId}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `whd_${hex}`;
}

// Legacy API-key memory spaces predate account/project governance. The final
// arm keeps only identifiers that are neither accounts nor known managed roots;
// known inactive roots therefore cannot fall through the compatibility path.
function activeWebhookLifecycleSql(hookAlias = "w") {
	return `(
		EXISTS (
		 SELECT 1 FROM users u
		  WHERE u.id = ${hookAlias}.user_id AND u.status = 'active'
		    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id)
		)
		OR EXISTS (
		 SELECT 1 FROM managed_projects p
		 JOIN users owner ON owner.id = p.owner_user_id AND owner.status = 'active'
		  WHERE p.memory_owner_user_id = ${hookAlias}.user_id AND p.status = 'active'
		    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = owner.id)
		    AND (
		      COALESCE(p.organization_id, (
		        SELECT od.id FROM organizations od
		         WHERE od.owner_user_id = p.owner_user_id AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		      )) IS NULL
		      OR EXISTS (
		        SELECT 1 FROM organizations o
		         WHERE o.id = COALESCE(p.organization_id, (
		           SELECT od.id FROM organizations od
		            WHERE od.owner_user_id = p.owner_user_id AND od.is_default = 1 AND od.status = 'active' LIMIT 1
		         )) AND o.status = 'active'
		      )
		    )
		)
		OR (
		  NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ${hookAlias}.user_id)
		  AND NOT EXISTS (
		    SELECT 1 FROM managed_projects p
		     WHERE p.memory_owner_user_id = ${hookAlias}.user_id
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM account_erasure_tombstones t
		     WHERE t.user_id = ${hookAlias}.user_id
		  )
		)
	)`;
}

async function webhookStillDeliverable(env, webhookId, userId) {
	return env.DB.prepare(
		`SELECT 1 FROM webhooks w
		  WHERE w.id = ? AND w.user_id = ? AND w.status = 'active'
		    AND ${activeWebhookLifecycleSql("w")}
		  LIMIT 1`,
	).bind(webhookId, userId).first();
}

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

/** The eight 16-bit groups of an IPv6 literal, or null if it does not parse. */
function ipv6Groups(raw) {
	const h = raw.replace(/^\[|\]$/g, "").toLowerCase();
	if (!h.includes(":") || !/^[0-9a-f:.]+$/.test(h)) return null;
	const halves = h.split("::");
	if (halves.length > 2) return null;
	// A trailing dotted quad occupies the last two groups.
	const expand = (part) => {
		const list = part ? part.split(":") : [];
		const last = list[list.length - 1];
		const quad = last ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last) : null;
		if (!quad) return list;
		const n = quad.slice(1).map(Number);
		if (n.some((v) => v > 255)) return list;
		return [...list.slice(0, -1), (((n[0] << 8) | n[1]) >>> 0).toString(16), (((n[2] << 8) | n[3]) >>> 0).toString(16)];
	};
	const left = expand(halves[0]);
	const right = halves.length === 2 ? expand(halves[1]) : [];
	const groups = halves.length === 2
		? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
		: left;
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return groups.map((g) => parseInt(g, 16));
}

function isPrivateIpv6(host) {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
	const groups = ipv6Groups(h);
	if (!groups) return false;
	if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) return true; // ::1, however spelled
	if (groups.every((g) => g === 0)) return true;
	if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
	if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	// IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64
	// (64:ff9b::/96) all carry a v4 address in the low 32 bits, and the URL
	// parser serializes them back as hex — `::ffff:127.0.0.1` becomes
	// `::ffff:7f00:1`, which no dotted-quad check would ever recognise. Judge
	// the embedded address exactly as if it had been written as v4.
	const [g0, g1, g2, g3, g4, g5] = groups;
	const zeroTop = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	const carriesIpv4 = (zeroTop && (g5 === 0xffff || g5 === 0))
		|| (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0);
	if (!carriesIpv4) return false;
	return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join("."));
}

/**
 * Why a URL cannot be delivered to, or null if it is acceptable. Applied at
 * registration and again immediately before every delivery attempt.
 * WEBHOOK_ALLOW_PRIVATE="true" (local dev only) relaxes the private-address
 * rules so the delivery machinery itself can be tested against a local
 * receiver; production never sets it.
 */
export function webhookUrlProblem(rawUrl, env = {}) {
	const raw = String(rawUrl ?? "");
	if (!raw || raw.length > 2048) return "Webhook URLs must be between 1 and 2048 characters.";
	let url;
	try {
		url = new URL(raw);
	} catch {
		return "That doesn't look like a valid URL.";
	}
	if (!["https:", "http:"].includes(url.protocol)) {
		return "Webhook URLs must be http(s).";
	}
	if (url.username || url.password) return "Webhook URLs must not embed credentials.";
	if (url.hash) return "Webhook URLs must not contain fragments.";
	const host = url.hostname;
	const allowPrivate = String(env.WEBHOOK_ALLOW_PRIVATE ?? "") === "true";
	if (url.protocol !== "https:" && !allowPrivate) {
		return "Webhook URLs must use HTTPS.";
	}
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

function displayWebhookUrl(rawUrl) {
	try {
		const url = new URL(String(rawUrl ?? ""));
		const hasPrivateSuffix = url.pathname !== "/" || Boolean(url.search);
		return `${url.protocol}//${url.host}${hasPrivateSuffix ? "/\u2026" : "/"}`;
	} catch {
		return null;
	}
}

function publicDeliveryError(value) {
	const text = String(value ?? "");
	if (!text) return null;
	if (/^endpoint answered \d{3}$/.test(text)) return text;
	if (/^(Webhook URLs|Webhooks can't|Private and internal|That doesn't look)/.test(text)) return text.slice(0, 200);
	if (text === "delivery_timeout") return text;
	return "delivery_failed";
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
		display_url: displayWebhookUrl(row.url),
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

export async function createWebhook(env, userId, body = {}, options = {}) {
	const auditIntent = options?.auditIntent ?? null;
	const problem = webhookUrlProblem(body.url, env);
	if (problem) {
		const invalid = { error: problem };
		return auditIntent ? commitAuditedNoop(env, auditIntent, invalid) : invalid;
	}
	const canonicalUrl = new URL(String(body.url)).toString();
	const existing = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ? AND status = 'active'",
	).bind(userId).first();
	if (Number(existing?.n ?? 0) >= MAX_WEBHOOKS_PER_USER) {
		const limited = { error: `You can have up to ${MAX_WEBHOOKS_PER_USER} webhooks — delete one first.` };
		return auditIntent ? commitAuditedNoop(env, auditIntent, limited) : limited;
	}
	const secretBytes = new Uint8Array(32);
	crypto.getRandomValues(secretBytes);
	const secret = `whsec_${[...secretBytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	const row = {
		id: newId("wh"),
		user_id: userId,
		name: String(body.name ?? "").trim().slice(0, 80) || "Webhook",
		url: canonicalUrl,
		secret,
		events_json: JSON.stringify(normalizeEvents(body.events)),
		metadata_only: body.metadataOnly === true || body.metadata_only === true ? 1 : 0,
		status: "active",
		created_at: Date.now(),
		updated_at: Date.now(),
	};
	const statement = env.DB.prepare(
		`INSERT INTO webhooks (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		  WHERE (SELECT COUNT(*) FROM webhooks WHERE user_id = ? AND status = 'active') < ?`,
	).bind(
		row.id, row.user_id, row.name, row.url, row.secret, row.events_json, row.metadata_only,
		row.status, row.created_at, row.updated_at, userId, MAX_WEBHOOKS_PER_USER,
	);
	let result;
	if (auditIntent) {
		try {
			[result] = await commitAuditedBatch(env, auditIntent, [statement], {
				preconditions: [auditInvariantStatement(
					env,
					"SELECT 1 WHERE (SELECT COUNT(*) FROM webhooks WHERE user_id = ? AND status = 'active') < ?",
					[userId, MAX_WEBHOOKS_PER_USER],
				)],
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM webhooks WHERE id = ? AND user_id = ? AND status = 'active'",
					[row.id, userId],
				)],
				commitDetails: { targetId: row.id },
			});
		} catch (error) {
			if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
				const count = await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ? AND status = 'active'",
				).bind(userId).first();
				if (Number(count?.n ?? 0) >= MAX_WEBHOOKS_PER_USER) {
					return commitAuditedNoop(env, auditIntent, {
						error: `You can have up to ${MAX_WEBHOOKS_PER_USER} webhooks — delete one first.`,
					});
				}
			}
			throw error;
		}
	} else result = await statement.run();
	if (Number(result?.meta?.changes ?? 0) !== 1) {
		const limited = { error: `You can have up to ${MAX_WEBHOOKS_PER_USER} webhooks — delete one first.` };
		return auditIntent ? commitAuditedNoop(env, auditIntent, limited) : limited;
	}
	// The secret appears exactly once: in this response.
	const created = { webhook: publicWebhook(row), secret };
	return auditIntent ? auditedMutationResult(created, auditIntent) : created;
}

export async function deleteWebhook(env, userId, id, options = {}) {
	const auditIntent = options?.auditIntent ?? null;
	const visible = await env.DB.prepare(
		"SELECT 1 FROM webhooks WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(id, userId).first();
	if (!visible) {
		const unchanged = { deleted: false };
		return auditIntent ? commitAuditedNoop(env, auditIntent, unchanged) : unchanged;
	}
	const statement = env.DB.prepare(
		"DELETE FROM webhooks WHERE id = ? AND user_id = ?",
	).bind(id, userId);
	let result;
	if (auditIntent) {
		[result] = await commitAuditedBatch(env, auditIntent, [statement], {
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM webhooks WHERE id = ? AND user_id = ?)",
				[id, userId],
			)],
		});
	} else result = await statement.run();
	const deleted = { deleted: Number(result.meta?.changes ?? 0) > 0 };
	return auditIntent ? auditedMutationResult(deleted, auditIntent) : deleted;
}

export async function listDeliveries(env, userId, webhookId, limit = 50) {
	const { results } = await env.DB.prepare(
		`SELECT id, event, status, attempts, response_code, error, created_at, delivered_at
		 FROM webhook_deliveries WHERE user_id = ? AND webhook_id = ?
		 ORDER BY created_at DESC LIMIT ?`,
	).bind(userId, webhookId, Math.min(limit, 200)).all();
	return (results ?? []).map((row) => ({ ...row, error: publicDeliveryError(row.error) }));
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
				job_id: data?.job_id ?? null,
				source_packet_id: data?.source_packet_id ?? null,
				status: data?.status ?? null,
				project_id: data?.project_id ?? null,
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
		if (!await webhookStillDeliverable(env, hook.id, hook.user_id)) {
			lastError = "webhook_inactive";
			break;
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
			const res = await fetchImpl(hook.url, {
				method: "POST",
				// Worker-created fetches follow redirects by default and forward our
				// signature headers to the new host. A webhook endpoint must be the
				// exact registered origin, so redirects are terminal delivery errors.
				redirect: "manual",
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
					"UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, delivered_at = ?, updated_at = ? WHERE id = ?",
				).bind(attempt, res.status, Date.now(), Date.now(), deliveryId).run();
				return;
			}
			if (res.status >= 300 && res.status < 400) {
				lastError = `endpoint redirected with ${res.status}`;
				break;
			}
			lastError = `endpoint answered ${res.status}`;
		} catch (err) {
			lastError = err?.name === "AbortError" ? "delivery_timeout" : "delivery_failed";
		}
		await env.DB.prepare(
			"UPDATE webhook_deliveries SET attempts = ?, response_code = ?, error = ?, updated_at = ? WHERE id = ?",
		).bind(attempt, lastCode, lastError, Date.now(), deliveryId).run();
	}
	await env.DB.prepare(
		"UPDATE webhook_deliveries SET status = 'failed', response_code = ?, error = ?, updated_at = ? WHERE id = ?",
	).bind(lastCode, lastError, Date.now(), deliveryId).run();
}

async function dispatchPendingDelivery(env, hook, deliveryId, body, waitUntil, opts = {}) {
	const claimed = await env.DB.prepare(
		`UPDATE webhook_deliveries SET status = 'dispatching', updated_at = ?
		 WHERE id = ? AND status = 'pending'
		 RETURNING id`,
	).bind(Date.now(), deliveryId).first();
	if (!claimed?.id) return false;
	const task = deliver(env, hook, deliveryId, body, opts).catch((error) => {
		console.warn("webhook delivery crashed:", error?.message ?? error);
	});
	if (typeof waitUntil === "function") waitUntil(task);
	else await task;
	return true;
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
			if (opts.webhookId && hook.id !== opts.webhookId) return false;
			try { return JSON.parse(hook.events_json || "[]").includes(event); } catch { return false; }
		});
		for (const hook of hooks) {
			const payload = payloadFor(hook, event, data);
			const body = JSON.stringify(payload);
			const deliveryId = opts.eventId
				? await deterministicDeliveryId(opts.eventId, hook.id)
				: newId("whd");
			const now = Date.now();
			const inserted = await env.DB.prepare(
				`INSERT INTO webhook_deliveries
				 (id, user_id, webhook_id, event, status, attempts, payload_json, created_at, updated_at)
				 SELECT ?, ?, ?, ?, 'pending', 0, ?, ?, ?
				  WHERE EXISTS (
				    SELECT 1 FROM webhooks w
				     WHERE w.id = ? AND w.user_id = ? AND w.status = 'active'
				       AND ${activeWebhookLifecycleSql("w")}
				  )
				 ON CONFLICT(id) DO NOTHING`,
			).bind(deliveryId, userId, hook.id, event, body, now, now, hook.id, userId).run();
			if (Number(inserted.meta?.changes ?? 0) > 0) {
				await dispatchPendingDelivery(env, hook, deliveryId, body, waitUntil, opts);
			}
		}
	} catch (err) {
		if (opts.strict) throw err;
		// Webhooks must never break the save that triggered them.
		console.warn("webhook emit failed:", err?.message ?? err);
	}
}

/**
 * Queue one synthetic test delivery as the authoritative governed mutation.
 * The outbox INSERT, fresh lifecycle/capability guards carried by auditIntent,
 * and committed audit marker share one D1 batch. Only after that commit may a
 * waitUntil task claim the row and connect to the remote endpoint.
 */
export async function queueAuditedWebhookTest(env, waitUntil, userId, webhookId, data, auditIntent, opts = {}) {
	const hook = await env.DB.prepare(
		"SELECT * FROM webhooks WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1",
	).bind(webhookId, userId).first();
	if (!hook) return commitAuditedNoop(env, auditIntent, { ok: false, notFound: true, queued: false });
	let supportsEvent = false;
	try { supportsEvent = JSON.parse(hook.events_json || "[]").includes("memory.added"); } catch { /* fail closed */ }
	if (!supportsEvent) return commitAuditedNoop(env, auditIntent, { ok: false, notFound: true, queued: false });

	const payload = payloadFor(hook, "memory.added", data);
	const body = JSON.stringify(payload);
	const deliveryId = newId("whd");
	const now = Date.now();
	const statement = env.DB.prepare(
		`INSERT INTO webhook_deliveries
		 (id, user_id, webhook_id, event, status, attempts, payload_json, created_at, updated_at)
		 SELECT ?, ?, ?, 'memory.added', 'pending', 0, ?, ?, ?
		  WHERE EXISTS (
		    SELECT 1 FROM webhooks w
		     WHERE w.id = ? AND w.user_id = ? AND w.status = 'active'
		       AND ${activeWebhookLifecycleSql("w")}
		  )`,
	).bind(deliveryId, userId, webhookId, body, now, now, webhookId, userId);
	let inserted;
	try {
		[inserted] = await commitAuditedBatch(env, auditIntent, [statement], {
			preconditions: [auditInvariantStatement(
				env,
				`SELECT 1 FROM webhooks w WHERE w.id = ? AND w.user_id = ? AND w.status = 'active'
				   AND ${activeWebhookLifecycleSql("w")}`,
				[webhookId, userId],
			)],
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM webhook_deliveries WHERE id = ? AND user_id = ? AND webhook_id = ? AND status = 'pending'",
				[deliveryId, userId, webhookId],
			)],
		});
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
			const changed = new Error("Webhook access changed before the test could be queued.");
			changed.code = "webhook_authorization_changed";
			changed.status = 403;
			throw changed;
		}
		throw error;
	}
	if (Number(inserted?.meta?.changes ?? 0) !== 1) throw new Error("webhook test delivery was not queued");
	const result = auditedMutationResult({ ok: true, queued: true, deliveryId }, auditIntent);
	const task = dispatchPendingDelivery(env, hook, deliveryId, body, waitUntil, opts).catch((error) => {
		console.warn("webhook test delivery crashed:", error?.message ?? error);
	});
	if (typeof waitUntil === "function") waitUntil(task);
	else await task;
	return result;
}

/** Recover an outbox row if an isolate died after its durable insert/claim. */
export async function retryPendingWebhookDeliveries(env, waitUntil, { limit = 50, ...deliveryOpts } = {}) {
	const now = Date.now();
	await env.DB.prepare(
		`UPDATE webhook_deliveries
		 SET status = 'pending', updated_at = ?
		 WHERE status = 'dispatching' AND updated_at < ?`,
	).bind(now, now - 2 * 60 * 1000).run();
	// An absolute age ceiling on undelivered work. `attempts` records the
	// attempt index WITHIN one dispatch run, so a delivery that dies mid-flight
	// every time is reclaimed and retried by each sweep indefinitely — slow,
	// but unbounded. Wall-clock age is the ceiling that cannot be reset by a
	// reclaim, and it leaves the per-run attempt semantics (which the recovery
	// spec pins) exactly as they are.
	await env.DB.prepare(
		`UPDATE webhook_deliveries
		 SET status = 'failed', error = COALESCE(error, 'delivery_expired'), updated_at = ?
		 WHERE status IN ('pending', 'dispatching') AND created_at < ?`,
	).bind(now, now - DELIVERY_MAX_AGE_MS).run();
	// Dead-letter what nothing can ever deliver. The dispatch query below is an
	// INNER JOIN on webhooks, and deleting a webhook is a hard DELETE, so a row
	// still pending when its webhook goes away would otherwise sit non-terminal
	// forever: never sent, never failed, never swept again. Every delivery must
	// reach a terminal state.
	await env.DB.prepare(
		`UPDATE webhook_deliveries
		 SET status = 'failed', error = 'webhook_deleted', updated_at = ?
		 WHERE id IN (
		   SELECT d.id FROM webhook_deliveries d
		    WHERE d.status = 'pending'
		      AND NOT EXISTS (
		        SELECT 1 FROM webhooks w
		         WHERE w.id = d.webhook_id AND w.user_id = d.user_id AND w.status = 'active'
		      )
		    ORDER BY d.created_at ASC LIMIT ?
		 )`,
	).bind(now, Math.max(1, Math.min(200, Number(limit) || 50))).run();
	const { results } = await env.DB.prepare(
		`SELECT d.id AS delivery_id, d.payload_json, w.*
		 FROM webhook_deliveries d
		 JOIN webhooks w ON w.id = d.webhook_id AND w.user_id = d.user_id
		 WHERE d.status = 'pending' AND w.status = 'active'
		 ORDER BY d.created_at ASC LIMIT ?`,
	).bind(Math.max(1, Math.min(200, Number(limit) || 50))).all();
	let dispatched = 0;
	for (const row of results ?? []) {
		if (await dispatchPendingDelivery(
			env,
			row,
			row.delivery_id,
			row.payload_json,
			waitUntil,
			deliveryOpts,
		)) dispatched++;
	}
	return { dispatched };
}

/** What a save receipt looks like as webhook data (full mode). */
export function webhookDataFromReceipt(receipt) {
	const saved = receipt?.saved ?? {};
	return {
		source: receipt?.source ?? null,
		receipt_id: receipt?.id ?? null,
		project_id: receipt?.project_id ?? null,
		project_name: receipt?.project_name ?? null,
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
