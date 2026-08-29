/* Generalized egress ownership assertion (Phase 3).
 *
 * Two read paths DISCOVER memory-space ids from stored provenance instead of
 * deriving them from the request: /v1/graph's legacy sub-tenant inventory and
 * /v1/ops/overview's tenant rollup. Provenance was historically
 * client-extensible, so a stored row can CLAIM an owner it does not belong
 * to. These tests forge exactly that row and prove neither route reports it.
 *
 * The forgery is written directly to D1 on purpose: the current write doors
 * derive the owner server-side and cannot produce it, but a row written
 * before that fix — or by any future bug — can. Defending only against what
 * today's writer can emit is not a defense.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import {
	scopedMemoryUserId,
	isOwnedMemorySpace,
	filterOwnedMemorySpaces,
} from "../src/lib/egress_ownership.js";
import { operatorOverview } from "../src/pipeline/ops.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function jsonInit(body, cookie) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	};
}

function cookieFrom(res) {
	return res.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

/** A receipts row whose scope_json CLAIMS this owner for a space it does not own. */
async function forgeReceipt(ownerUserId, memoryUserId, externalUserId) {
	await env.DB.prepare(
		`INSERT INTO receipts (id, user_id, outcome, created_at, scope_json)
		 VALUES (?, ?, 'accepted', ?, ?)`,
	).bind(
		`rcpt_${crypto.randomUUID()}`,
		memoryUserId,
		Date.now(),
		JSON.stringify({ owner_user_id: ownerUserId, external_user_id: externalUserId }),
	).run();
}

describe("the assertion", () => {
	it("accepts the owner's own root space", async () => {
		expect(await isOwnedMemorySpace(scopedMemoryUserId, "user_owner", "user_owner", null)).toBe(true);
	});

	it("accepts a space that re-derives from the owner and its external id", async () => {
		const derived = await scopedMemoryUserId("user_owner", "project:alpha");
		expect(await isOwnedMemorySpace(scopedMemoryUserId, "user_owner", derived, "project:alpha")).toBe(true);
	});

	it("refuses a well-shaped id that does not re-derive — shape is not ownership", async () => {
		// Derived for a DIFFERENT owner: correct `mem_` shape, wrong namespace.
		const foreign = await scopedMemoryUserId("user_victim", "project:alpha");
		expect(await isOwnedMemorySpace(scopedMemoryUserId, "user_attacker", foreign, "project:alpha")).toBe(false);
		// And the same external id under two owners never collides.
		const mine = await scopedMemoryUserId("user_attacker", "project:alpha");
		expect(mine).not.toBe(foreign);
	});

	it("refuses a space whose external id was stripped — an unprovable claim is not ours", async () => {
		const derived = await scopedMemoryUserId("user_owner", "project:alpha");
		for (const missing of [null, undefined, ""]) {
			expect(await isOwnedMemorySpace(scopedMemoryUserId, "user_owner", derived, missing)).toBe(false);
		}
	});

	it("fails closed when the derivation itself throws", async () => {
		const broken = async () => { throw new Error("hash unavailable"); };
		expect(await isOwnedMemorySpace(broken, "user_owner", "mem_whatever", "project:alpha")).toBe(false);
	});

	it("partitions rows and counts the refusals", async () => {
		const ownerId = "user_owner";
		const good = await scopedMemoryUserId(ownerId, "project:good");
		const bad = await scopedMemoryUserId("user_someone_else", "project:bad");
		const { owned, dropped } = await filterOwnedMemorySpaces(
			scopedMemoryUserId,
			ownerId,
			[
				{ id: good, ext: "project:good" },
				{ id: bad, ext: "project:bad" },
				{ id: ownerId, ext: null },
			],
			(row) => ({ memoryUserId: row.id, externalUserId: row.ext }),
		);
		expect(owned.map((row) => row.id).sort()).toEqual([good, ownerId].sort());
		expect(dropped).toBe(1);
	});
});

describe("/v1/ops/overview", () => {
	it("does not report a forged tenant, and still reports a legitimate one", async () => {
		const victim = await signupAccount("egress-victim");
		const attacker = await signupAccount("egress-attacker");

		// A real sub-tenant of the victim: this MUST survive the filter.
		const legitimate = await scopedMemoryUserId(victim.user.id, "project:legit");
		await forgeReceipt(victim.user.id, legitimate, "project:legit");

		// Three forgeries, all claiming the victim as owner:
		//  1. the attacker's own space id
		//  2. a space derived for the attacker under the same external name
		//  3. an invented mem_ id of the right shape
		const attackerSpace = await scopedMemoryUserId(attacker.user.id, "project:evil");
		await forgeReceipt(victim.user.id, attackerSpace, "project:evil");
		await forgeReceipt(victim.user.id, attacker.user.id, null);
		await forgeReceipt(victim.user.id, `mem_${"a".repeat(32)}`, "project:invented");

		const overview = await operatorOverview(env, victim.user.id, { range: "7d" });
		const reported = overview.tenants.map((tenant) => tenant.memory_user_id);

		expect(reported).toContain(legitimate);
		expect(reported).not.toContain(attackerSpace);
		expect(reported).not.toContain(attacker.user.id);
		expect(reported).not.toContain(`mem_${"a".repeat(32)}`);
		// The victim's own root space is always theirs.
		expect(reported).toContain(victim.user.id);
	});

	it("records a security event when a foreign claim is refused", async () => {
		const victim = await signupAccount("egress-signal");
		const foreign = await scopedMemoryUserId("user_nobody", "project:foreign");
		await forgeReceipt(victim.user.id, foreign, "project:foreign");

		await operatorOverview(env, victim.user.id, { range: "7d" });

		const event = await env.DB.prepare(
			"SELECT kind, severity, count FROM security_events WHERE group_key = ?",
		).bind(`ops_foreign_scope_claim:${victim.user.id}`).first();
		expect(event).toBeTruthy();
		expect(event.kind).toBe("ops_foreign_scope_claim");
		expect(event.severity).toBe("medium");
	});

	it("stays quiet when every discovered space is genuinely the owner's", async () => {
		const clean = await signupAccount("egress-clean");
		const legitimate = await scopedMemoryUserId(clean.user.id, "project:only-mine");
		await forgeReceipt(clean.user.id, legitimate, "project:only-mine");

		await operatorOverview(env, clean.user.id, { range: "7d" });

		const event = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM security_events WHERE group_key = ?",
		).bind(`ops_foreign_scope_claim:${clean.user.id}`).first("n");
		expect(Number(event)).toBe(0);
	});
});

describe("/v1/graph", () => {
	it("does not expose a forged sub-tenant scope in the legacy inventory", async () => {
		const victim = await signupAccount("graph-victim");
		const attackerSpace = await scopedMemoryUserId("user_attacker", "project:evil");
		const legitimate = await scopedMemoryUserId(victim.user.id, "project:legit");

		// source_packets is the graph route's discovery table.
		const packet = async (memoryUserId, externalUserId) => {
			await env.DB.prepare(
				`INSERT INTO source_packets
				   (id, user_id, scope_user_id, owner_user_id, memory_user_id, external_user_id, project_name,
				    source_type, idempotency_key, content_hash, message_count, created_at, updated_at, raw_meta_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', ?, ?, 0, ?, ?, '{}')`,
			).bind(
				`sp_${crypto.randomUUID()}`, memoryUserId, memoryUserId, victim.user.id, memoryUserId,
				externalUserId, externalUserId.replace(/^project:/, ""),
				`idem_${crypto.randomUUID()}`, `hash_${crypto.randomUUID()}`, Date.now(), Date.now(),
			).run();
		};
		await packet(legitimate, "project:legit");
		await packet(attackerSpace, "project:evil");

		const res = await request("/v1/graph", { headers: { cookie: victim.cookie } });
		expect(res.status).toBe(200);
		const body = await res.json();
		const scopes = (body.legacy_project_scopes ?? []).map((row) => row.external_user_id);

		expect(scopes).toContain("project:legit");
		expect(scopes).not.toContain("project:evil");
	});
});
