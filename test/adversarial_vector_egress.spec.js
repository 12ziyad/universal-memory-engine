/**
 * ADVERSARIAL — cross-tenant egress through the vector/recall path and the two
 * DISCOVERY-based read paths (ops overview, graph legacy scopes).
 *
 * Every test here is written to BREAK the system, not to confirm it. Where the
 * system defends, the assertion pins the defense so a future refactor that
 * removes it fails here.
 *
 * Threat model, stated plainly:
 *   (a) The vector provider is NOT trusted. Vectorize is an external index; a
 *       namespace bug, a shared-index misconfiguration, or a compromised
 *       provider can return another tenant's ids. D1 is the only authority.
 *   (b)+(c) Stored provenance is NOT trusted. `receipts.scope_json` and
 *       `source_packets.*` were historically client-extensible, so a row can
 *       CLAIM an owner it does not belong to. Discovery reads must re-derive.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { scopedMemoryUserId } from "../src/lib/egress_ownership.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function call(path, init = {}, runtimeEnv = env) {
	const res = await request(path, init, runtimeEnv);
	let body = null;
	try { body = await res.json(); } catch {}
	return { status: res.status, body };
}

function jsonInit(body, cookie) {
	return {
		method: "POST",
		headers: { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	};
}
function cookieFrom(res) { return res.headers.get("set-cookie")?.split(";")[0] || ""; }

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

/** A real account with a real Bearer token — sub-tenant scoping only exists under token auth. */
async function account(prefix) {
	const base = await signupAccount(prefix);
	const made = await call("/auth/tokens", jsonInit({ type: "api", label: `${prefix}-probe` }, base.cookie));
	expect(made.status).toBeLessThan(300);
	return { ...base, token: made.body.token };
}

function bearer(token) { return { ...JSON_HEADERS, authorization: `Bearer ${token}` }; }

const canned = (label, text) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

/** Write real memory through the real door. `userId` names a sub-tenant (or is omitted for the root space). */
async function ingest(token, userId, label, text) {
	return call("/v1/ingest", {
		method: "POST",
		headers: bearer(token),
		body: JSON.stringify({
			...(userId ? { userId } : {}),
			flush: true,
			messages: [{ id: `m-${crypto.randomUUID()}`, role: "user", content: text }],
			_test: { llmResponse: canned(label, text) },
		}),
	});
}

async function nodesOf(userId) {
	const { results } = await env.DB.prepare(
		"SELECT id, label, revision FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
	).bind(userId).all();
	return results ?? [];
}

async function securityEvent(groupKey) {
	const { results } = await env.DB.prepare(
		"SELECT kind, severity, count, details_json FROM security_events WHERE group_key = ? ORDER BY last_at DESC",
	).bind(groupKey).all();
	return results ?? [];
}

/* ==========================================================================
 * (a) VECTORIZE NAMESPACE LEAK
 *
 * The provider is made hostile: query() returns the VICTIM's real node ids and
 * a fabricated id alongside one id the attacker legitimately owns. If the D1
 * head re-check in src/lib/vectorize.js is the only guard and it fails, the
 * victim's label and slice text land in the attacker's recall context.
 * ======================================================================== */

describe("adversarial (a) — hostile Vectorize returns another tenant's node ids", () => {
	it("drops foreign + fabricated ids at the D1 head re-check and never renders them", async () => {
		const victim = await account("vec-victim");
		const attacker = await account("vec-attacker");

		const SECRET = "Zanzibar";
		const victimSave = await ingest(
			victim.token, null, SECRET,
			`We decided the ${SECRET} ledger settles payouts through the Frankfurt clearing bank`,
		);
		expect(victimSave.status).toBe(200);
		const attackerSave = await ingest(
			attacker.token, null, "Pelican",
			"We decided the Pelican queue drains to the local disk",
		);
		expect(attackerSave.status).toBe(200);

		const victimNodes = await nodesOf(victim.user.id);
		const attackerNodes = await nodesOf(attacker.user.id);
		expect(victimNodes.length).toBeGreaterThan(0);
		expect(attackerNodes.length).toBeGreaterThan(0);
		// The victim's memory really does hold the secret — otherwise "absent from
		// the attacker's response" would prove nothing.
		expect(victimNodes.map((n) => n.label)).toContain(SECRET);

		const fabricated = `node_${crypto.randomUUID()}`;
		const calls = [];
		const hostileEnv = {
			...env,
			USE_VECTORS: "true",
			AI: {
				// Deterministic stand-in for the embedding model. The only model touch
				// on the recall path is the query embedding.
				run: async (_model, _inputs) => ({ data: [[0.11, 0.22, 0.33, 0.44]] }),
			},
			VECTORIZE: {
				query: async (values, options) => {
					calls.push({ namespace: options?.namespace, topK: options?.topK });
					return {
						matches: [
							// Every victim node, at plausible head revision, top-scored.
							...victimNodes.map((n, i) => ({ id: `${n.id}#r${n.revision ?? 1}`, score: 0.99 - i * 0.001 })),
							// A legacy (unversioned) id for the same victim node: the legacy
							// branch in parseVectorId must not become a bypass.
							...victimNodes.map((n) => ({ id: n.id, score: 0.98 })),
							// An id that exists nowhere at all.
							{ id: `${fabricated}#r1`, score: 0.97 },
							// One id the attacker genuinely owns, so a total wipe-out
							// cannot be mistaken for a working guard.
							...attackerNodes.map((n) => ({ id: `${n.id}#r${n.revision ?? 1}`, score: 0.5 })),
						],
					};
				},
				upsert: async () => ({ mutationId: "test" }),
				deleteByIds: async () => ({}),
			},
		};

		const res = await call("/v1/recall", {
			method: "POST",
			headers: bearer(attacker.token),
			body: JSON.stringify({ query: "What did we decide about the ledger and the clearing bank?" }),
		}, hostileEnv);

		// HARNESS PROOF 1: the attack must actually have reached the provider.
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0].namespace).toBe(attacker.user.id);

		expect(res.status).toBe(200);
		// HARNESS PROOF 2: the vector lane must be LIVE, not silently disabled.
		// The query shares no word with "Pelican"/"queue"/"local disk", so the
		// attacker's own node can only be here because the injected vector match
		// carried it. If this fails the whole test is vacuous — everything would
		// have been dropped for reasons unrelated to tenancy.
		expect(JSON.stringify(res.body)).toContain(attackerNodes[0].id);
		const serialized = JSON.stringify(res.body);
		// No victim id, no victim label, no victim slice text, anywhere in the response.
		for (const node of victimNodes) {
			expect(serialized).not.toContain(node.id);
			expect(serialized).not.toContain(node.label);
		}
		expect(serialized).not.toContain(SECRET);
		expect(serialized).not.toContain("Frankfurt");
		expect(serialized).not.toContain(fabricated);
		// And nothing from the victim leaked into the attacker's node rows.
		expect(String(res.body?.context ?? "")).not.toContain(SECRET);
	});

	it("records a vector_scope_drop security event naming ONLY genuinely foreign ids", async () => {
		// Unit-level, so the drop counter is read without recall's other filters
		// masking it: this asserts vectorize.js itself classifies correctly.
		const { queryNodeVectors } = await import("../src/lib/vectorize.js");
		const victim = await account("vec-ev-victim");
		const attackerSpace = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`;

		await ingest(victim.token, null, "Kestrel", "We decided the Kestrel index rebuilds nightly");
		const victimNodes = await nodesOf(victim.user.id);
		expect(victimNodes.length).toBeGreaterThan(0);

		// The attacker's own space: one live node, one soft-deleted node (routine
		// residue), plus the victim's ids and a fabricated id (genuinely foreign).
		const live = `node_${crypto.randomUUID()}`;
		const softDeleted = `node_${crypto.randomUUID()}`;
		const fabricated = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at, revision) VALUES (?, ?, 'mine', 1, 1, NULL, 1), (?, ?, 'gone', 1, 1, 2, 1)",
		).bind(live, attackerSpace, softDeleted, attackerSpace).run();

		const hostileEnv = {
			...env,
			VECTORIZE: {
				query: async () => ({
					matches: [
						...victimNodes.map((n) => ({ id: `${n.id}#r1`, score: 0.9 })),
						{ id: `${fabricated}#r1`, score: 0.85 },
						{ id: `${softDeleted}#r1`, score: 0.8 },
						{ id: `${live}#r1`, score: 0.7 },
					],
				}),
			},
		};
		const out = await queryNodeVectors(
			hostileEnv, { useVectors: true, shortlistSize: 20 },
			{ userId: attackerSpace, values: [0.1, 0.2], topK: 20 },
		);
		expect(out.map((r) => r.id)).toEqual([live]);

		const foreignRows = await securityEvent(`vector_scope_drop:${attackerSpace}`);
		expect(foreignRows.length).toBe(1);
		expect(foreignRows[0].severity).toBe("medium");
		// victim nodes + the fabricated id — the soft-deleted one must NOT be here.
		expect(JSON.parse(foreignRows[0].details_json).dropped).toBe(victimNodes.length + 1);

		const residueRows = await securityEvent(`vector_deleted_residue:${attackerSpace}`);
		expect(residueRows.length).toBe(1);
		expect(residueRows[0].severity).toBe("low");
		expect(JSON.parse(residueRows[0].details_json).dropped).toBe(1);
	});

	it("cannot be bypassed by a stale-revision vector for a node the caller DOES own", async () => {
		// A superseded revision must not resurrect old content: same object id,
		// wrong revision. This is the other half of the head re-check.
		const { queryNodeVectors } = await import("../src/lib/vectorize.js");
		const space = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`;
		const nodeId = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at, revision) VALUES (?, ?, 'rev', 1, 1, NULL, 4)",
		).bind(nodeId, space).run();

		const stale = await queryNodeVectors(
			{ ...env, VECTORIZE: { query: async () => ({ matches: [{ id: `${nodeId}#r2`, score: 0.99 }] }) } },
			{ useVectors: true, shortlistSize: 5 }, { userId: space, values: [0.1], topK: 5 },
		);
		expect(stale).toEqual([]);

		const head = await queryNodeVectors(
			{ ...env, VECTORIZE: { query: async () => ({ matches: [{ id: `${nodeId}#r4`, score: 0.99 }] }) } },
			{ useVectors: true, shortlistSize: 5 }, { userId: space, values: [0.1], topK: 5 },
		);
		expect(head.map((r) => r.id)).toEqual([nodeId]);
	});
});

/* ==========================================================================
 * (b) OPS EGRESS — forged receipts provenance
 * ======================================================================== */

describe("adversarial (b) — forged receipts provenance against /v1/ops/overview", () => {
	it("drops a forged owner claim, keeps the legitimate sub-tenant, and excludes forged rows from account totals", async () => {
		const victim = await account("ops-victim");
		const attacker = await account("ops-attacker");

		// The victim's own legitimate sub-tenant, written through the real door.
		const legitExternal = `legit-${crypto.randomUUID().slice(0, 8)}`;
		expect((await ingest(victim.token, legitExternal, "Heron", "We decided Heron ships on Friday")).status).toBe(200);
		const legitSpace = await scopedMemoryUserId(victim.user.id, legitExternal);

		// The attacker's own real sub-tenant space, holding real nodes.
		const attackerExternal = `attacker-${crypto.randomUUID().slice(0, 8)}`;
		expect((await ingest(attacker.token, attackerExternal, "Marlin", "We decided Marlin uses the private key vault")).status).toBe(200);
		const attackerSpace = await scopedMemoryUserId(attacker.user.id, attackerExternal);
		const attackerNodeCount = (await nodesOf(attackerSpace)).length;
		expect(attackerNodeCount).toBeGreaterThan(0);

		// A memory-space id that derives from nobody.
		const ghostSpace = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at) VALUES (?, ?, 'ghost', 1, 1, NULL)",
		).bind(`node_${crypto.randomUUID()}`, ghostSpace).run();

		// FORGERY: two receipts rows naming the VICTIM as owner for spaces the
		// victim does not own. `mem_` shape is deliberately correct — shape is
		// exactly what must not be sufficient.
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, created_at, latency_ms, scope_json) VALUES (?, ?, 'ingest', 'wrote', ?, 4242, ?)",
			).bind(`rcpt_${crypto.randomUUID()}`, attackerSpace, now, JSON.stringify({
				owner_user_id: victim.user.id, external_user_id: attackerExternal, project_id: "stolen-project",
			})),
			env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, created_at, latency_ms, scope_json) VALUES (?, ?, 'ingest', 'wrote', ?, 9999, ?)",
			).bind(`rcpt_${crypto.randomUUID()}`, ghostSpace, now, JSON.stringify({
				owner_user_id: victim.user.id, external_user_id: "ghost-tenant",
			})),
			// A third shape: owner claim with NO external id at all, so nothing can
			// be re-derived. Must also fail closed.
			env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, created_at, latency_ms, scope_json) VALUES (?, ?, 'ingest', 'wrote', ?, 7777, ?)",
			).bind(`rcpt_${crypto.randomUUID()}`, `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`, now, JSON.stringify({
				owner_user_id: victim.user.id,
			})),
		]);

		const res = await call("/v1/ops/overview", { headers: bearer(victim.token) });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);

		const ids = res.body.tenants.map((t) => t.memory_user_id);
		// The legitimate sub-tenant is still reported (a guard that drops
		// everything is not a guard, it is an outage).
		expect(ids).toContain(victim.user.id);
		expect(ids).toContain(legitSpace);
		// The forged ones are not.
		expect(ids).not.toContain(attackerSpace);
		expect(ids).not.toContain(ghostSpace);
		// No forged project id, no forged latency sample, no foreign node count.
		const serialized = JSON.stringify(res.body);
		expect(serialized).not.toContain("stolen-project");
		expect(serialized).not.toContain("ghost-tenant");
		expect(serialized).not.toContain(attackerSpace);
		expect(res.body.account.latency_ms.samples).toBeGreaterThanOrEqual(0);
		const reportedNodes = res.body.tenants.reduce((sum, t) => sum + t.live_nodes, 0);
		expect(res.body.account.live_nodes).toBe(reportedNodes);
		// The attacker's nodes are nowhere in the victim's roll-up.
		const victimOwnNodes = (await nodesOf(victim.user.id)).length + (await nodesOf(legitSpace)).length;
		expect(res.body.account.live_nodes).toBe(victimOwnNodes);

		const events = await securityEvent(`ops_foreign_scope_claim:${victim.user.id}`);
		expect(events.length).toBe(1);
		expect(events[0].severity).toBe("medium");
		expect(JSON.parse(events[0].details_json).dropped).toBe(3);
	});

	it("forged rows cannot cross into ANOTHER account's overview either (reverse direction)", async () => {
		// Same forgery, aimed the other way: the attacker names THEMSELVES owner of
		// the victim's real space, hoping to pull the victim's counts into their
		// own console.
		const victim = await account("ops-rev-victim");
		const attacker = await account("ops-rev-attacker");
		expect((await ingest(victim.token, null, "Osprey", "We decided Osprey holds the signing keys")).status).toBe(200);
		const victimNodeCount = (await nodesOf(victim.user.id)).length;
		expect(victimNodeCount).toBeGreaterThan(0);

		await env.DB.prepare(
			"INSERT INTO receipts (id, user_id, source, outcome, created_at, latency_ms, scope_json) VALUES (?, ?, 'ingest', 'wrote', ?, 111, ?)",
		).bind(`rcpt_${crypto.randomUUID()}`, victim.user.id, Date.now(), JSON.stringify({
			owner_user_id: attacker.user.id, external_user_id: "pull-victim",
		})).run();

		const res = await call("/v1/ops/overview", { headers: bearer(attacker.token) });
		expect(res.status).toBe(200);
		const ids = res.body.tenants.map((t) => t.memory_user_id);
		expect(ids).not.toContain(victim.user.id);
		expect(res.body.account.live_nodes).toBe(0);
		expect(JSON.stringify(res.body)).not.toContain("Osprey");
	});

	it("FIXED: forged rows can no longer consume the discovery LIMIT and evict real sub-tenants", async () => {
		// The ownership filter runs AFTER `ORDER BY last_activity_at DESC LIMIT ?`.
		// So forged rows are dropped from the OUTPUT but still spend the input
		// budget. Enough recent forged rows and a genuine tenant falls off the end
		// of the window before the filter ever sees it — the operator console
		// answers "you have no sub-tenants" while the data is still there.
		const victim = await account("ops-evict");
		const legitExternal = `real-${crypto.randomUUID().slice(0, 8)}`;
		expect((await ingest(victim.token, legitExternal, "Falcon", "We decided Falcon checkpoints to D1")).status).toBe(200);
		const legitSpace = await scopedMemoryUserId(victim.user.id, legitExternal);

		// Baseline: with no forged rows the tenant is visible.
		const before = await call("/v1/ops/overview", { headers: bearer(victim.token) });
		expect(before.body.tenants.map((t) => t.memory_user_id)).toContain(legitSpace);

		// MAX_TENANTS is 200; flood the window with newer forged claims.
		const now = Date.now();
		const stmts = [];
		for (let i = 0; i < 205; i++) {
			stmts.push(env.DB.prepare(
				"INSERT INTO receipts (id, user_id, source, outcome, created_at, scope_json) VALUES (?, ?, 'ingest', 'wrote', ?, ?)",
			).bind(
				`rcpt_${crypto.randomUUID()}`,
				`mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
				now + 60_000 + i,
				JSON.stringify({ owner_user_id: victim.user.id, external_user_id: `flood-${i}` }),
			));
		}
		for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));

		const after = await call("/v1/ops/overview", { headers: bearer(victim.token) });
		expect(after.status).toBe(200);
		const ids = after.body.tenants.map((t) => t.memory_user_id);
		// No forged space is ever reported — the ownership filter holds.
		expect(ids.filter((id) => id !== victim.user.id && id !== legitSpace)).toEqual([]);
		// FIXED: discovery now over-fetches, filters ownership, and only THEN
		// applies the cap — and the root space is never a candidate for
		// eviction. A flood of forged claims can no longer spend the victim's
		// reporting budget, so their real sub-tenant survives in their own view.
		expect(ids).toContain(legitSpace);
		expect(after.body.account.tenants).toBeGreaterThan(1);
		// Truncation now describes the caller's OWN spaces, not forged claims.
		expect(after.body.account.truncated).toBe(false);
		// And the underlying data was never in question.
		expect((await nodesOf(legitSpace)).length).toBeGreaterThan(0);
	});
});

/* ==========================================================================
 * (d) PROBE — can the forgery in (b)/(c) be written REMOTELY, today?
 *
 * (b) and (c) assume a forged provenance row already exists. That assumption
 * is only interesting if a live door can still create one. `resolveScopedMemory`
 * builds `memoryScope` as `{ ...clientInput, ownerUserId, externalUserId, ... }`
 * — server fields overwrite the CAMEL-case keys only. `resolveScope` in
 * src/pipeline/source.js then reads the SNAKE-case key FIRST.
 * ======================================================================== */

describe("adversarial (d) — remote provenance forgery through memoryScope", () => {
	/** One ordinary authenticated ingest that names someone else as the owner. */
	async function forgedIngest(attackerToken, victimId, externalUserId, label) {
		return call("/v1/ingest", {
			method: "POST",
			headers: bearer(attackerToken),
			body: JSON.stringify({
				flush: true,
				// snake_case: `resolveScopedMemory` only overwrites the camelCase keys,
				// and `resolveScope` reads snake_case FIRST.
				memoryScope: { owner_user_id: victimId, external_user_id: externalUserId },
				messages: [{ id: `m-${crypto.randomUUID()}`, role: "user", content: `We decided ${label} runs nightly` }],
				_test: { llmResponse: canned(label, `We decided ${label} runs nightly`) },
			}),
		});
	}

	it("FIXED: an ingest can no longer stamp ANOTHER account as owner", async () => {
		const victim = await account("fx-victim");
		const attacker = await account("fx-attacker");

		// The write still succeeds — under the attacker's OWN identity, which is
		// the point: the forged ownership keys are stripped, not the request.
		const res = await forgedIngest(attacker.token, victim.user.id, "hijacked-tenant", "Anchovy");
		expect(res.status).toBe(200);

		const { results: receipts } = await env.DB.prepare(
			"SELECT id, user_id, scope_json FROM receipts WHERE json_extract(scope_json, '$.owner_user_id') = ?",
		).bind(victim.user.id).all();
		const { results: packets } = await env.DB.prepare(
			"SELECT id, user_id, owner_user_id, memory_user_id, external_user_id FROM source_packets WHERE owner_user_id = ?",
		).bind(victim.user.id).all();

		// Not one row anywhere names the victim as owner.
		expect(receipts).toHaveLength(0);
		expect(packets).toHaveLength(0);

		// The attacker's own rows exist and are attributed to the attacker.
		const mine = await env.DB.prepare(
			"SELECT scope_json FROM receipts WHERE user_id = ?",
		).bind(attacker.user.id).all();
		expect((mine.results ?? []).length).toBeGreaterThan(0);
		for (const row of mine.results) {
			const scope = JSON.parse(row.scope_json);
			expect(scope.owner_user_id).toBe(attacker.user.id);
		}

		// And the attempt itself was recorded as a security signal.
		const forgery = await securityEvent(`scope_ownership_forgery:${attacker.user.id}`);
		expect(forgery.length).toBeGreaterThan(0);
		expect(forgery[0].severity).toBe("high");
	});

	it("FIXED: a forged owner claim cannot fan the attacker's write out to the VICTIM's webhooks", async () => {
		const victim = await account("wh-victim");
		const attacker = await account("wh-attacker");

		// The victim's own webhook, exactly as the product configures one. The URL
		// refuses instantly; the DELIVERY ROW is the proof, not the HTTP result.
		const hookId = `wh_${crypto.randomUUID()}`;
		await env.DB.prepare(
			`INSERT INTO webhooks (id, user_id, name, url, secret, events_json, metadata_only, status, created_at, updated_at)
			 VALUES (?, ?, 'victim hook', 'http://127.0.0.1:1/hook', 'shh', ?, 1, 'active', ?, ?)`,
		).bind(hookId, victim.user.id, JSON.stringify(["memory.added", "memory.updated"]), Date.now(), Date.now()).run();

		const res = await forgedIngest(attacker.token, victim.user.id, "hijacked-tenant", "Basilisk");
		expect(res.status).toBe(200);

		const { results: deliveries } = await env.DB.prepare(
			"SELECT id, user_id, webhook_id, event, payload_json FROM webhook_deliveries WHERE user_id = ?",
		).bind(victim.user.id).all();

		// Nothing is queued against the victim's account or endpoint. The
		// fan-out now re-derives the owner claim instead of trusting it, so an
		// attacker cannot push their own memory events — labels included —
		// into someone else's endpoint and delivery log.
		expect(deliveries).toHaveLength(0);
		// The victim's webhook configuration is untouched.
		const hook = await env.DB.prepare("SELECT status, secret FROM webhooks WHERE id = ?").bind(hookId).first();
		expect(hook.status).toBe("active");
		expect(hook.secret).toBe("shh");
	});

	it("DEFENDED: the forged claim still cannot put attacker memory in the victim's graph or ops view", async () => {
		// The egress-ownership assertion is the backstop, and it holds even when
		// the forged row is written through the live door rather than into D1.
		const victim = await account("fx2-victim");
		const attacker = await account("fx2-attacker");
		expect((await forgedIngest(attacker.token, victim.user.id, "project:pwned", "Coelacanth")).status).toBe(200);

		const graph = await call("/v1/graph", { headers: bearer(victim.token) });
		expect(graph.status).toBe(200);
		expect((graph.body.legacy_project_scopes ?? []).map((s) => s.external_user_id)).not.toContain("project:pwned");
		expect(JSON.stringify(graph.body)).not.toContain("Coelacanth");
		expect(JSON.stringify(graph.body)).not.toContain(attacker.user.id);

		const ops = await call("/v1/ops/overview", { headers: bearer(victim.token) });
		expect(ops.status).toBe(200);
		expect(ops.body.tenants.map((t) => t.memory_user_id)).not.toContain(attacker.user.id);
		expect(ops.body.account.live_nodes).toBe(0);

		// And now the forged row never reaches the victim's discovery window at
		// all: the ownership keys are stripped at the write boundary, so there
		// is nothing for the egress filter to drop later. Defence in depth —
		// the filter still stands (see test/egress_ownership.spec.js), it just
		// has nothing to catch on this path any more.
		const events = await securityEvent(`ops_foreign_scope_claim:${victim.user.id}`);
		expect(events).toHaveLength(0);
	});
});

/* ==========================================================================
 * (c) GRAPH EGRESS — forged source_packets provenance
 * ======================================================================== */

describe("adversarial (c) — forged source_packets provenance against /v1/graph", () => {
	it("drops a forged legacy_project_scope while keeping a derivable one", async () => {
		const victim = await account("graph-victim");
		const attacker = await account("graph-attacker");

		// The attacker's real scoped space, holding real nodes and pages.
		const attackerExternal = `project:${crypto.randomUUID().slice(0, 8)}`;
		expect((await ingest(attacker.token, attackerExternal, "Barracuda", "We decided Barracuda stores the customer PII")).status).toBe(200);
		const attackerSpace = await scopedMemoryUserId(attacker.user.id, attackerExternal);
		const attackerNodes = await nodesOf(attackerSpace);
		expect(attackerNodes.length).toBeGreaterThan(0);

		// A legitimate legacy sub-tenant space for the VICTIM: derivable, so it
		// must survive the filter.
		const legitExternal = `project:legacy-${crypto.randomUUID().slice(0, 8)}`;
		const legitSpace = await scopedMemoryUserId(victim.user.id, legitExternal);
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at) VALUES (?, ?, 'LegacyThing', 1, 1, NULL)",
		).bind(`node_${crypto.randomUUID()}`, legitSpace).run();

		const packet = (memoryUserId, externalUserId, projectName) => env.DB.prepare(
			`INSERT INTO source_packets
			  (id, user_id, scope_user_id, source_type, idempotency_key, content_hash,
			   memory_user_id, owner_user_id, external_user_id, project_name, created_at, updated_at)
			 VALUES (?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			`sp_${crypto.randomUUID()}`, memoryUserId, memoryUserId,
			`idem_${crypto.randomUUID()}`, `hash_${crypto.randomUUID()}`,
			memoryUserId, victim.user.id, externalUserId, projectName, Date.now(), Date.now(),
		);

		await env.DB.batch([
			// FORGED: owner = victim, memory space = the attacker's real space.
			packet(attackerSpace, attackerExternal, "Barracuda Project"),
			// FORGED: owner = victim, memory space derives from nobody.
			packet(`mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`, "project:ghost", "Ghost Project"),
			// LEGITIMATE: derives from the victim + its own external id.
			packet(legitSpace, legitExternal, "Legacy Project"),
		]);

		const res = await call("/v1/graph", { headers: bearer(victim.token) });
		expect(res.status).toBe(200);
		const scopes = res.body.legacy_project_scopes ?? [];
		const externals = scopes.map((s) => s.external_user_id);

		expect(externals).toContain(legitExternal);
		expect(externals).not.toContain(attackerExternal);
		expect(externals).not.toContain("project:ghost");
		const serialized = JSON.stringify(res.body);
		expect(serialized).not.toContain(attackerSpace);
		expect(serialized).not.toContain("Barracuda");
		expect(serialized).not.toContain("Ghost Project");
		// The aggregate counts on the surviving row are the victim's own.
		expect(scopes.find((s) => s.external_user_id === legitExternal).nodes).toBe(1);

		const events = await securityEvent(`graph_foreign_scope_claim:${victim.user.id}`);
		expect(events.length).toBe(1);
		expect(events[0].severity).toBe("medium");
		expect(JSON.parse(events[0].details_json).dropped).toBe(2);

		// And the victim's own graph body never contained the attacker's memory.
		expect(res.body.nodes.map((n) => n.label)).not.toContain("Barracuda");
	});

	it("a forged packet cannot pull the VICTIM's legacy inventory into the attacker's graph", async () => {
		const victim = await account("graph-rev-victim");
		const attacker = await account("graph-rev-attacker");
		const victimExternal = `project:private-${crypto.randomUUID().slice(0, 8)}`;
		const victimSpace = await scopedMemoryUserId(victim.user.id, victimExternal);
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at) VALUES (?, ?, 'SecretLedger', 1, 1, NULL)",
		).bind(`node_${crypto.randomUUID()}`, victimSpace).run();

		await env.DB.prepare(
			`INSERT INTO source_packets
			  (id, user_id, scope_user_id, source_type, idempotency_key, content_hash,
			   memory_user_id, owner_user_id, external_user_id, project_name, created_at, updated_at)
			 VALUES (?, ?, ?, 'conversation', ?, ?, ?, ?, ?, 'Stolen', ?, ?)`,
		).bind(
			`sp_${crypto.randomUUID()}`, victimSpace, victimSpace,
			`idem_${crypto.randomUUID()}`, `hash_${crypto.randomUUID()}`,
			victimSpace, attacker.user.id, victimExternal, Date.now(), Date.now(),
		).run();

		const res = await call("/v1/graph", { headers: bearer(attacker.token) });
		expect(res.status).toBe(200);
		expect(res.body.legacy_project_scopes ?? []).toEqual([]);
		expect(JSON.stringify(res.body)).not.toContain("SecretLedger");
		expect(JSON.stringify(res.body)).not.toContain(victimSpace);
	});
});
