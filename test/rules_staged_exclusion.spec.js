/**
 * Rules enforcement in the read-your-writes staging index (campaign 2026-08-07,
 * defect SRV-03).
 *
 * Staging exists so a recall seconds after an accepted write answers with the
 * content instead of "still processing" — but it stored the accepted user text
 * verbatim, with only secret scrubbing applied. User exclude rules are enforced
 * in the extraction gates, which run later, so excluded content was recallable
 * through the staging bridge for up to 30 minutes.
 *
 * Contract under test (campaign invariant I9, spec §14.3 deep exclusion):
 * excluded content must be absent from EVERY representation recall can reach,
 * including the pre-enrichment staging index.
 */

import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker, { scopedMemoryUserId } from "../src";
import { saveMemoryRules } from "../src/pipeline/rules.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function post(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

/** Hold the DO lease so nothing enriches: the pre-enrichment window on demand. */
async function holdLease(userId) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put("lease", { until: Date.now() + 120_000, token: "rules-staged-hold" });
	});
	return stub;
}

async function stagedRowsFor(userId) {
	const { results } = await env.DB.prepare(
		"SELECT text FROM staged_memories WHERE user_id = ? AND settled_at IS NULL",
	).bind(userId).all();
	return (results ?? []).map((row) => String(row.text));
}

describe("user rules gate the read-your-writes staging index", () => {
	it("keeps excluded content out of staged rows and out of pre-enrichment recall", async () => {
		const userId = `rules-staged-exclude-${crypto.randomUUID()}`;
		await saveMemoryRules(env, userId, { excludes: ["salary"] });
		const stub = await holdLease(userId);

		const save = await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [
				{ id: "m1", role: "user", content: "My salary at Meridian is ninety-two thousand euros a year." },
				{ id: "m2", role: "user", content: "I decided our deploy pipeline always runs the smoke suite first." },
			],
		});
		expect(save.status).toBe(200);

		const staged = await stagedRowsFor(userId);
		expect(staged.some((text) => /salary/i.test(text))).toBe(false);
		// The allowed line must still be staged — this is not a blanket shutdown.
		expect(staged.some((text) => /smoke suite/i.test(text))).toBe(true);

		const recalled = await post("/v1/recall", { userId, query: "What is my salary at Meridian?" });
		expect(recalled.status).toBe(200);
		expect(String(recalled.body.context ?? "")).not.toMatch(/salary|ninety-two thousand/i);

		await stub.resetAll();
	});

	it("honors a plain-language 'never save' instruction in staging too", async () => {
		const userId = `rules-staged-instruction-${crypto.randomUUID()}`;
		await saveMemoryRules(env, userId, { customInstructions: "Never save anything about my medication." });
		const stub = await holdLease(userId);

		const save = await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "I take my medication every morning before standup." }],
		});
		expect(save.status).toBe(200);

		expect(await stagedRowsFor(userId)).toHaveLength(0);
		const recalled = await post("/v1/recall", { userId, query: "When do I take my medication?" });
		expect(String(recalled.body.context ?? "")).not.toMatch(/medication/i);

		await stub.resetAll();
	});

	it("stages only include-listed content when an allow-list is set", async () => {
		const userId = `rules-staged-include-${crypto.randomUUID()}`;
		await saveMemoryRules(env, userId, { includes: ["deploy"] });
		const stub = await holdLease(userId);

		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [
				{ id: "m1", role: "user", content: "I decided the deploy pipeline needs a staging gate." },
				{ id: "m2", role: "user", content: "My favourite lunch spot is the ramen place on the corner." },
			],
		});

		const staged = await stagedRowsFor(userId);
		expect(staged.some((text) => /deploy pipeline/i.test(text))).toBe(true);
		expect(staged.some((text) => /ramen/i.test(text))).toBe(false);

		await stub.resetAll();
	});

	it("still stages everything when the user has no rules (unchanged contract)", async () => {
		const userId = `rules-staged-default-${crypto.randomUUID()}`;
		const stub = await holdLease(userId);

		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "My salary at Meridian is ninety-two thousand euros a year." }],
		});

		expect(await stagedRowsFor(userId)).toHaveLength(1);
		await stub.resetAll();
	});
});

async function call(path, init) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	let body = null;
	try { body = await response.json(); } catch {}
	return { status: response.status, body, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? null };
}

async function bearerAccount(prefix) {
	const signup = await call("/auth/signup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: prefix, acceptTerms: true }),
	});
	expect(signup.status).toBe(201);
	const tok = await call("/auth/tokens", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: signup.cookie },
		body: JSON.stringify({ type: "api", label: "sdk" }),
	});
	return { key: tok.body.token, ownerId: signup.body.user.id };
}

describe("account rules govern sub-tenant staging (Bearer door, defect SRV-04)", () => {
	// Rules belong to the ACCOUNT (doorOverrides): a derived mem_ sub-tenant id
	// owns no configuration, so the door loads the account rules once and hands
	// them to the pipeline as an override — the gates already enforce that
	// object. Staging must enforce the SAME object instead of re-resolving by
	// the scoped id, which silently returns defaults.
	it("keeps account-excluded content out of a sub-tenant's staged rows and pre-enrichment recall", async () => {
		const { key, ownerId } = await bearerAccount("srv04");
		const bearer = { "content-type": "application/json", authorization: `Bearer ${key}` };
		const tenant = `tenant-${crypto.randomUUID()}`;

		const put = await call("/v1/rules", {
			method: "PUT",
			headers: bearer,
			body: JSON.stringify({ userId: tenant, rules: { excludes: ["salary"] } }),
		});
		expect(put.status).toBe(200);
		expect(put.body?.rules?.excludes).toContain("salary");

		const memId = await scopedMemoryUserId(ownerId, tenant);
		expect(memId).not.toBe(ownerId);
		const stub = await holdLease(memId);

		const save = await call("/v1/ingest", {
			method: "POST",
			headers: bearer,
			body: JSON.stringify({
				userId: tenant,
				flush: true,
				messages: [
					{ id: "m1", role: "user", content: "My salary at Meridian is ninety-two thousand euros a year." },
					{ id: "m2", role: "user", content: "I decided our deploy pipeline always runs the smoke suite first." },
				],
			}),
		});
		expect(save.status).toBe(200);

		const staged = await stagedRowsFor(memId);
		expect(staged.some((text) => /salary/i.test(text))).toBe(false);
		// The allowed line must still stage — account rules are not a shutdown.
		expect(staged.some((text) => /smoke suite/i.test(text))).toBe(true);

		const recalled = await call("/v1/recall", {
			method: "POST",
			headers: bearer,
			body: JSON.stringify({ userId: tenant, query: "What is my salary at Meridian?" }),
		});
		expect(String(recalled.body?.context ?? "")).not.toMatch(/salary|ninety-two thousand/i);

		await stub.resetAll();
	});

	it("still stages everything for a sub-tenant when the account has no rules", async () => {
		const { key, ownerId } = await bearerAccount("srv04-default");
		const bearer = { "content-type": "application/json", authorization: `Bearer ${key}` };
		const tenant = `tenant-${crypto.randomUUID()}`;
		const memId = await scopedMemoryUserId(ownerId, tenant);
		const stub = await holdLease(memId);

		const save = await call("/v1/ingest", {
			method: "POST",
			headers: bearer,
			body: JSON.stringify({
				userId: tenant,
				flush: true,
				messages: [{ id: "m1", role: "user", content: "My office is above the bakery on Keizersgracht." }],
			}),
		});
		expect(save.status).toBe(200);

		expect(await stagedRowsFor(memId)).toHaveLength(1);
		await stub.resetAll();
	});
});
