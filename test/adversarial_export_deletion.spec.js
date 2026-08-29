/**
 * ADVERSARIAL PROBE — export isolation and deletion / no-resurrection.
 *
 * Every test here is an ATTACK. A passing test therefore means one of two
 * things, and each assertion says which:
 *   - the attack ran and the system refused it (DEFENDED), or
 *   - the attack ran and something crossed a boundary (breach, asserted
 *     precisely so the failure names the leak).
 *
 * Nothing is weakened to make a test pass. Where the system defends, the
 * defence is asserted positively (zero foreign rows, zero live rows) AND the
 * probe proves it was not vacuous: the same call, pointed at the caller's own
 * space, returns the real data.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

async function request(path, init = {}, runtimeEnv = env) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, runtimeEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function jsonInit(body, cookie) {
	return { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) };
}
function cookieFrom(res) { return res.headers.get("set-cookie")?.split(";")[0] || ""; }
async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { email, user: body.user, cookie: cookieFrom(res) };
}

/** Mint a Bearer API token for an account holding a session. */
async function mintToken(cookie) {
	const res = await request("/auth/tokens", jsonInit({ label: "probe", type: "api", scopes: ["memory:read", "memory:write"] }, cookie));
	expect(res.status).toBe(201);
	const body = await res.json();
	expect(typeof body.token).toBe("string");
	return body.token;
}

/**
 * Write one real memory through the product door. The LLM is stubbed so the
 * object graph is deterministic; everything after the extractor (gates, write,
 * receipts, suppression) is the real code under test.
 */
async function save(auth, { label, text, userId = null, source = null, idempotencyKey = null }) {
	const body = {
		content: text,
		...(userId ? { userId } : {}),
		...(source ? { source } : {}),
		...(idempotencyKey ? { idempotencyKey } : {}),
		_test: {
			llmResponse: {
				objects: [
					{ kind: "node", label, category: "skill", confidence: 0.95 },
					{ kind: "slice", on: label, text, kind_detail: "fact", confidence: 0.95 },
				],
			},
		},
	};
	const headers = { "content-type": "application/json" };
	if (auth.cookie) headers.cookie = auth.cookie;
	if (auth.token) headers.authorization = `Bearer ${auth.token}`;
	const res = await request("/v1/save", { method: "POST", headers, body: JSON.stringify(body) });
	return { status: res.status, body: await res.json() };
}

/** The memory-space id a node actually landed in (discovered, never assumed). */
async function spaceOfNode(label) {
	const row = await env.DB.prepare("SELECT user_id, id FROM nodes WHERE label = ? LIMIT 1").bind(label).first();
	return row ? { spaceId: row.user_id, nodeId: row.id } : null;
}

/**
 * Count LIVE rows in each memory table whose ANY column still carries `marker`.
 * Whole rows are read and matched as JSON rather than naming columns, so a
 * residue hiding in a column this probe did not think of is still counted.
 */
const LIVE_TABLES = {
	nodes: true, slices: true, events: true, edges: true,
	memory_pages: true, candidates: true, memory_revisions: false,
};
async function liveCounts(spaceId, marker) {
	const out = {};
	for (const [table, softDeletable] of Object.entries(LIVE_TABLES)) {
		const where = softDeletable ? "user_id = ? AND deleted_at IS NULL" : "user_id = ?";
		const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(spaceId).all();
		out[table] = (results ?? []).filter((row) => JSON.stringify(row).includes(marker)).length;
	}
	return out;
}
const NO_RESIDUE = {
	nodes: 0, slices: 0, events: 0, edges: 0,
	memory_pages: 0, candidates: 0, memory_revisions: 0,
};

const MEMORY_TABLES = ["nodes", "slices", "events", "edges", "memory_pages", "candidates", "memory_revisions"];

/** Rows in the export that belong to the MEMORY surface (not the audit surface). */
function memoryRowsText(payload) {
	return JSON.stringify(MEMORY_TABLES.map((t) => payload[t] ?? []));
}
/** Every row of every table in the export, audit surface included. */
function allRowsText(payload) {
	return JSON.stringify(payload);
}
function foreignRowCount(payload, foreignSpaceId) {
	let n = 0;
	for (const table of Object.keys(payload)) {
		if (!Array.isArray(payload[table])) continue;
		for (const row of payload[table]) if (row?.user_id === foreignSpaceId) n += 1;
	}
	return n;
}

async function exportAs(cookieOrToken, userIdParam) {
	const headers = cookieOrToken.startsWith("cookie:")
		? { cookie: cookieOrToken.slice(7) }
		: { authorization: `Bearer ${cookieOrToken}` };
	const q = userIdParam == null ? "" : `?userId=${encodeURIComponent(userIdParam)}`;
	const res = await request(`/v1/export${q}`, { headers });
	return { status: res.status, payload: res.status === 200 ? await res.json() : await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// (a) EXPORT ISOLATION
// ---------------------------------------------------------------------------

describe("adversarial: export isolation", () => {
	const B_ROOT = `BSECRET_ROOT_${crypto.randomUUID().replace(/-/g, "")}`;
	const B_SUB = `BSECRET_SUB_${crypto.randomUUID().replace(/-/g, "")}`;
	const A_ROOT = `ASECRET_ROOT_${crypto.randomUUID().replace(/-/g, "")}`;
	const A_SUB = `ASECRET_SUB_${crypto.randomUUID().replace(/-/g, "")}`;
	let A, B, bRootSpace, bSubSpace, aRootSpace, aToken;

	beforeAll(async () => {
		A = await signupAccount("adv-a");
		B = await signupAccount("adv-b");

		expect((await save({ cookie: B.cookie }, { label: `node-${B_ROOT}`, text: `victim root memory ${B_ROOT}` })).status).toBe(200);
		expect((await save({ cookie: B.cookie }, { label: `node-${B_SUB}`, text: `victim subtenant memory ${B_SUB}`, userId: "b-customer-1" })).status).toBe(200);
		expect((await save({ cookie: A.cookie }, { label: `node-${A_ROOT}`, text: `attacker own memory ${A_ROOT}` })).status).toBe(200);

		bRootSpace = (await spaceOfNode(`node-${B_ROOT}`))?.spaceId;
		bSubSpace = (await spaceOfNode(`node-${B_SUB}`))?.spaceId;
		aRootSpace = (await spaceOfNode(`node-${A_ROOT}`))?.spaceId;

		// The setup must be real, or every "no leak" below is vacuous.
		expect(bRootSpace).toBe(B.user.id);
		expect(bSubSpace).toMatch(/^mem_[0-9a-f]{32}$/);
		expect(bSubSpace).not.toBe(B.user.id);
		expect(aRootSpace).toBe(A.user.id);

		aToken = await mintToken(A.cookie);
		expect((await save({ token: aToken }, { label: `node-${A_SUB}`, text: `attacker subtenant memory ${A_SUB}`, userId: "a-customer-1" })).status).toBe(200);
	});

	it("control: the probe is not vacuous — B's own export DOES contain B's memory", async () => {
		const { status, payload } = await exportAs(`cookie:${B.cookie}`, null);
		expect(status).toBe(200);
		expect(payload.user_id).toBe(B.user.id);
		expect(memoryRowsText(payload)).toContain(B_ROOT);
	});

	it("ATTACK 1: A exports with ?userId=<B's account id> — zero B rows", async () => {
		const { status, payload } = await exportAs(`cookie:${A.cookie}`, B.user.id);
		expect(status).toBe(200);
		// The space served is DERIVED under A, never B's own account space.
		expect(payload.user_id).not.toBe(B.user.id);
		expect(payload.user_id).toMatch(/^mem_[0-9a-f]{32}$/);
		expect(foreignRowCount(payload, B.user.id)).toBe(0);
		expect(foreignRowCount(payload, bSubSpace)).toBe(0);
		expect(allRowsText(payload)).not.toContain(B_ROOT);
		expect(allRowsText(payload)).not.toContain(B_SUB);
	});

	it("ATTACK 2: A exports with ?userId=<B's mem_ sub-tenant space id> — zero B rows", async () => {
		const { status, payload } = await exportAs(`cookie:${A.cookie}`, bSubSpace);
		expect(status).toBe(200);
		expect(payload.user_id).not.toBe(bSubSpace);
		expect(foreignRowCount(payload, bSubSpace)).toBe(0);
		expect(foreignRowCount(payload, B.user.id)).toBe(0);
		expect(allRowsText(payload)).not.toContain(B_SUB);
		expect(allRowsText(payload)).not.toContain(B_ROOT);
	});

	it("ATTACK 3: A exports with a forged mem_ id — zero rows, no cross-space read", async () => {
		const forged = `mem_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
		const { status, payload } = await exportAs(`cookie:${A.cookie}`, forged);
		expect(status).toBe(200);
		expect(payload.user_id).not.toBe(forged);
		for (const table of MEMORY_TABLES) expect(payload[table] ?? []).toEqual([]);
		expect(allRowsText(payload)).not.toContain(B_ROOT);
		expect(allRowsText(payload)).not.toContain(B_SUB);
		expect(allRowsText(payload)).not.toContain(A_ROOT);
	});

	it("ATTACK 4: Bearer sub-tenant export must not contain the OWNER's other memory", async () => {
		const { status, payload } = await exportAs(aToken, "a-customer-1");
		expect(status).toBe(200);
		// Non-vacuous: the sub-tenant's own memory IS there.
		expect(memoryRowsText(payload)).toContain(A_SUB);
		// ...and the owner's root memory is NOT.
		expect(allRowsText(payload)).not.toContain(A_ROOT);
		expect(foreignRowCount(payload, A.user.id)).toBe(0);
		expect(allRowsText(payload)).not.toContain(B_ROOT);
		expect(allRowsText(payload)).not.toContain(B_SUB);
	});

	it("ATTACK 5: job export (POST /v1/exports + download) with ?userId=<B's id> — zero B rows", async () => {
		const created = await request("/v1/exports", jsonInit({ userId: B.user.id }, A.cookie));
		expect(created.status).toBe(201);
		const job = (await created.json()).export;
		// The job row must be filed in A's DERIVED space, not B's.
		const row = await env.DB.prepare("SELECT user_id FROM memory_exports WHERE id = ?").bind(job.id).first();
		expect(row.user_id).not.toBe(B.user.id);
		expect(row.user_id).toMatch(/^mem_[0-9a-f]{32}$/);

		const dl = await request(`/v1/exports/download?userId=${encodeURIComponent(B.user.id)}&id=${encodeURIComponent(job.id)}`, { headers: { cookie: A.cookie } });
		// The job builds in the derived space, so it completes and downloads —
		// it just contains nothing of B's.
		expect(dl.status).toBe(200);
		const payload = await dl.json();
		expect(payload.user_id).toBe(row.user_id);
		expect(foreignRowCount(payload, B.user.id)).toBe(0);
		expect(allRowsText(payload)).not.toContain(B_ROOT);
		expect(allRowsText(payload)).not.toContain(B_SUB);
		for (const table of MEMORY_TABLES) expect(payload[table] ?? []).toEqual([]);
	});

	it("ATTACK 6: A downloads B's real export job id — refused, no bytes", async () => {
		const created = await request("/v1/exports", jsonInit({}, B.cookie));
		expect(created.status).toBe(201);
		const bJob = (await created.json()).export;
		// Sanity: B can download their own.
		const own = await request(`/v1/exports/download?id=${encodeURIComponent(bJob.id)}`, { headers: { cookie: B.cookie } });
		expect(own.status).toBe(200);
		expect(await own.text()).toContain(B_ROOT);

		const stolen = await request(`/v1/exports/download?id=${encodeURIComponent(bJob.id)}`, { headers: { cookie: A.cookie } });
		expect(stolen.status).toBe(404);
		expect(await stolen.text()).not.toContain(B_ROOT);

		// And with the userId parameter pointed at B as well.
		const stolen2 = await request(`/v1/exports/download?userId=${encodeURIComponent(B.user.id)}&id=${encodeURIComponent(bJob.id)}`, { headers: { cookie: A.cookie } });
		expect(stolen2.status).toBe(404);
		expect(await stolen2.text()).not.toContain(B_ROOT);
	});

	it("ATTACK 6b: cross-site export exfiltration with the victim's cookie", async () => {
		// CORS off (production default): the response carries no
		// access-control-allow-origin, so a foreign page cannot read the bytes
		// even though the cookie authenticated the request.
		const sameOriginRules = await request("/v1/export", { headers: { cookie: B.cookie, origin: "https://evil.example" } });
		expect(sameOriginRules.headers.get("access-control-allow-origin")).toBe(null);

		// CORS on: allow-origin IS echoed, so the session must not authenticate
		// at all cross-origin — otherwise evil.example reads the whole export.
		const corsEnv = { ...env, ENABLE_CORS: "true" };
		const res = await request("/v1/export", { headers: { cookie: B.cookie, origin: "https://evil.example" } }, corsEnv);
		expect(res.headers.get("access-control-allow-origin")).toBe("https://evil.example");
		expect(res.headers.get("access-control-allow-credentials")).toBe(null);
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain(B_ROOT);
	});

	it("ATTACK 6c: the legacy operator key reads ANY account's space by id", async () => {
		// Not a bug — this is the documented operator credential — but the blast
		// radius is asserted here so it can never be mistaken for tenant-scoped.
		const res = await request(`/v1/export?userId=${encodeURIComponent(B.user.id)}`, { headers: { "x-api-key": env.API_KEY } });
		expect(res.status).toBe(200);
		const payload = await res.json();
		expect(payload.user_id).toBe(B.user.id);
		expect(memoryRowsText(payload)).toContain(B_ROOT);

		// And a normal account cannot reach that credential's power: no account
		// route hands back the key, and a wrong key is refused outright.
		const forged = await request(`/v1/export?userId=${encodeURIComponent(B.user.id)}`, { headers: { "x-api-key": "not-the-operator-key" } });
		expect(forged.status).toBe(401);
		expect(await forged.text()).not.toContain(B_ROOT);
	});

	it("ATTACK 7: GET /v1/exports listing with ?userId=<B's id> lists none of B's jobs", async () => {
		const bList = await request("/v1/exports", { headers: { cookie: B.cookie } });
		const bIds = (await bList.json()).exports.map((e) => e.id);
		expect(bIds.length).toBeGreaterThan(0);

		const aList = await request(`/v1/exports?userId=${encodeURIComponent(B.user.id)}`, { headers: { cookie: A.cookie } });
		expect(aList.status).toBe(200);
		const aIds = (await aList.json()).exports.map((e) => e.id);
		for (const id of aIds) expect(bIds).not.toContain(id);
	});
});

// ---------------------------------------------------------------------------
// (b)+(c) NO-RESURRECTION and DELETION COMPLETENESS
// ---------------------------------------------------------------------------

describe("adversarial: deletion, resurrection and completeness", () => {
	async function scheduledSweep() {
		const ctx = createExecutionContext();
		await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
		await waitOnExecutionContext(ctx);
	}
	async function drainDurableObject(spaceId) {
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(spaceId));
		await stub.kick(spaceId).catch(() => null);
		return stub.drain({ userId: spaceId, forceFire: true }).catch((e) => ({ error: String(e?.message ?? e) }));
	}
	async function recallText(cookie, query) {
		const res = await request("/v1/recall", jsonInit({ query }, cookie));
		return { status: res.status, text: await res.text() };
	}

	it("ATTACK 8: identical replay with the same idempotency key does not resurrect a deleted memory", async () => {
		const C = await signupAccount("adv-c");
		const marker = `CSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `node-${marker}`;
		const key = `idem-${crypto.randomUUID()}`;
		const payload = { label, text: `deletable memory ${marker}`, source: "advprobe", idempotencyKey: key };

		expect((await save({ cookie: C.cookie }, payload)).status).toBe(200);
		const found = await spaceOfNode(label);
		expect(found?.spaceId).toBe(C.user.id);
		expect(await liveCounts(C.user.id, marker)).toMatchObject({ nodes: 1, slices: 1 });

		const del = await request(`/v1/memories/${encodeURIComponent(found.nodeId)}`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(del.status).toBe(200);
		expect((await del.json()).deleted).toBe(true);

		// (c) DELETION COMPLETENESS: no live row anywhere carries the content.
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		// The replay attack.
		const replay = await save({ cookie: C.cookie }, payload);
		expect([200, 409]).toContain(replay.status);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		// A DIFFERENT idempotency key with identical content — the harder replay.
		const replay2 = await save({ cookie: C.cookie }, { ...payload, idempotencyKey: `idem-${crypto.randomUUID()}` });
		expect([200, 409]).toContain(replay2.status);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		// Not recallable. The 200 matters: a refused recall would prove nothing.
		const recall = await recallText(C.cookie, marker);
		expect(recall.status).toBe(200);
		expect(recall.text).not.toContain(marker);
		const { payload: exported } = await exportAs(`cookie:${C.cookie}`, null);
		expect(memoryRowsText(exported)).not.toContain(marker);
	});

	it("ATTACK 9: the cron sweep does not resurrect a deleted memory", async () => {
		const C = await signupAccount("adv-cron");
		const marker = `CRONSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `node-${marker}`;
		expect((await save({ cookie: C.cookie }, { label, text: `cron target ${marker}`, source: "advcron" })).status).toBe(200);
		const found = await spaceOfNode(label);
		expect(found?.nodeId).toBeTruthy();

		const del = await request(`/v1/memories/${encodeURIComponent(found.nodeId)}`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(del.status).toBe(200);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		await scheduledSweep();
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		await drainDurableObject(C.user.id);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		await scheduledSweep();
		const { payload: exported } = await exportAs(`cookie:${C.cookie}`, null);
		expect(memoryRowsText(exported)).not.toContain(marker);
	});

	it("ATTACK 10: source-scoped bulk delete then replay + cron + DO drain", async () => {
		const C = await signupAccount("adv-bulk");
		const marker = `BULKSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `node-${marker}`;
		const source = "advbulk";
		const key = `idem-${crypto.randomUUID()}`;
		const payload = { label, text: `bulk target ${marker}`, source, idempotencyKey: key };
		expect((await save({ cookie: C.cookie }, payload)).status).toBe(200);
		expect((await liveCounts(C.user.id, marker)).nodes).toBe(1);

		// dry_run is the default: a delete without confirm must destroy nothing.
		const dry = await request(`/v1/memories?source=${source}`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(dry.status).toBe(200);
		expect((await liveCounts(C.user.id, marker)).nodes).toBe(1);

		const destroy = await request(`/v1/memories?source=${source}&confirm=true&dry_run=false`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(destroy.status).toBe(200);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		const replay = await save({ cookie: C.cookie }, payload);
		expect([200, 409]).toContain(replay.status);
		await scheduledSweep();
		await drainDurableObject(C.user.id);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);

		const { payload: exported } = await exportAs(`cookie:${C.cookie}`, null);
		expect(memoryRowsText(exported)).not.toContain(marker);
	});

	it("ATTACK 11: deleted content must not egress through ANY export table (audit surface included)", async () => {
		const C = await signupAccount("adv-egress");
		const marker = `EGRESSSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `nodelabel-plain-${crypto.randomUUID().slice(0, 8)}`;
		// The marker lives ONLY in the user's content, never in the node label,
		// so this measures content egress and not audit metadata about names.
		expect((await save({ cookie: C.cookie }, { label, text: `private content ${marker}` })).status).toBe(200);
		const found = await spaceOfNode(label);
		const del = await request(`/v1/memories/${encodeURIComponent(found.nodeId)}`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(del.status).toBe(200);

		const { status, payload } = await exportAs(`cookie:${C.cookie}`, null);
		expect(status).toBe(200);
		expect(memoryRowsText(payload)).not.toContain(marker);
		// Non-vacuous: the audit surface IS populated for this account, so
		// "no marker in receipts" is a measurement and not an empty array.
		expect((payload.receipts ?? []).length).toBeGreaterThan(0);
		expect(JSON.stringify(payload.receipts)).toContain(label);

		// The whole download, every table. If the deleted words are still here,
		// "deleted" is not what the export says it is.
		const leakingTables = Object.keys(payload).filter(
			(t) => Array.isArray(payload[t]) && JSON.stringify(payload[t]).includes(marker),
		);
		expect(leakingTables).toEqual([]);
	});

	it("ATTACK 13: a completed export job must not keep serving deleted content", async () => {
		const C = await signupAccount("adv-stale");
		const marker = `STALESECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `nodelabel-stale-${crypto.randomUUID().slice(0, 8)}`;
		expect((await save({ cookie: C.cookie }, { label, text: `private content ${marker}` })).status).toBe(200);

		// A perfectly ordinary thing to do: build an export, then change your mind
		// and delete the memory.
		const created = await request("/v1/exports", jsonInit({}, C.cookie));
		expect(created.status).toBe(201);
		const job = (await created.json()).export;
		const before = await request(`/v1/exports/download?id=${encodeURIComponent(job.id)}`, { headers: { cookie: C.cookie } });
		expect(before.status).toBe(200);
		expect(await before.text()).toContain(marker);

		const found = await spaceOfNode(label);
		const del = await request(`/v1/memories/${encodeURIComponent(found.nodeId)}`, { method: "DELETE", headers: { cookie: C.cookie } });
		expect(del.status).toBe(200);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);
		// The live export door already agrees the memory is gone.
		const fresh = await exportAs(`cookie:${C.cookie}`, null);
		expect(allRowsText(fresh.payload)).not.toContain(marker);

		await scheduledSweep();

		// The stored blob is server-side state under this account, reachable by a
		// live product door. After deletion it must not still hand the words back.
		const stored = await env.DB.prepare("SELECT data FROM memory_exports WHERE id = ?").bind(job.id).first();
		const after = await request(`/v1/exports/download?id=${encodeURIComponent(job.id)}`, { headers: { cookie: C.cookie } });
		const servedBytes = after.status === 200 ? await after.text() : "";
		expect({
			stored_blob_contains_deleted_content: String(stored?.data ?? "").includes(marker),
			download_status: after.status,
			download_contains_deleted_content: servedBytes.includes(marker),
		}).toEqual({
			stored_blob_contains_deleted_content: false,
			// 410 Gone, not 404: the export DID exist and was discarded because
			// the memory it copied was deleted. Saying "never heard of it"
			// would be the less honest answer to someone holding its id.
			download_status: 410,
			download_contains_deleted_content: false,
		});
	});

	it("ATTACK 14: full erasure must not leave deleted content downloadable from an old export", async () => {
		const C = await signupAccount("adv-erasure");
		const marker = `ERASESECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const label = `nodelabel-erase-${crypto.randomUUID().slice(0, 8)}`;
		expect((await save({ cookie: C.cookie }, { label, text: `private content ${marker}` })).status).toBe(200);

		const created = await request("/v1/exports", jsonInit({}, C.cookie));
		expect(created.status).toBe(201);
		const job = (await created.json()).export;
		expect(await (await request(`/v1/exports/download?id=${encodeURIComponent(job.id)}`, { headers: { cookie: C.cookie } })).text()).toContain(marker);

		// "Delete everything" — the strongest erasure a memory door offers.
		const wipe = await request("/v1/memories?confirm=true&dry_run=false", { method: "DELETE", headers: { cookie: C.cookie } });
		expect(wipe.status).toBe(200);
		expect(await liveCounts(C.user.id, marker)).toEqual(NO_RESIDUE);
		await scheduledSweep();

		// Reached with a credential minted AFTER the erasure, so this is not
		// "a copy the user already downloaded" — it is live server-side state a
		// brand-new key can still pull the erased words out of.
		const freshToken = await mintToken(C.cookie);
		const listed = await request("/v1/exports", { headers: { authorization: `Bearer ${freshToken}` } });
		const listedIds = (await listed.json()).exports.map((e) => e.id);
		const after = await request(`/v1/exports/download?id=${encodeURIComponent(job.id)}`, { headers: { authorization: `Bearer ${freshToken}` } });
		const servedBytes = after.status === 200 ? await after.text() : "";
		expect({
			job_still_listed_after_erasure: listedIds.includes(job.id),
			download_status: after.status,
			still_serves_erased_content: servedBytes.includes(marker),
		}).toEqual({
			// A full erasure removes the job rows outright (memory_exports is a
			// memory-space table the census marks purge: "delete"), so the
			// listing is empty and the id is genuinely unknown afterwards.
			job_still_listed_after_erasure: false,
			download_status: 404,
			still_serves_erased_content: false,
		});
	});

	it("ATTACK 12: a sub-tenant delete must not destroy or expose the owner's memory", async () => {
		const C = await signupAccount("adv-cross");
		const ownerMarker = `OWNSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		const subMarker = `SUBSECRET_${crypto.randomUUID().replace(/-/g, "")}`;
		expect((await save({ cookie: C.cookie }, { label: `node-${ownerMarker}`, text: `owner memory ${ownerMarker}` })).status).toBe(200);
		expect((await save({ cookie: C.cookie }, { label: `node-${subMarker}`, text: `sub memory ${subMarker}`, userId: "c-customer-1" })).status).toBe(200);
		const owner = await spaceOfNode(`node-${ownerMarker}`);
		const sub = await spaceOfNode(`node-${subMarker}`);
		expect(sub.spaceId).not.toBe(owner.spaceId);

		// The sub-tenant scope tries to delete the OWNER's node id.
		const cross = await request(
			`/v1/memories/${encodeURIComponent(owner.nodeId)}?userId=${encodeURIComponent("c-customer-1")}`,
			{ method: "DELETE", headers: { cookie: C.cookie } },
		);
		expect(cross.status).toBe(404);
		expect((await liveCounts(owner.spaceId, ownerMarker)).nodes).toBe(1);

		// Erasure inside the sub-tenant space must not touch the owner's space.
		const wipe = await request(
			`/v1/memories?userId=${encodeURIComponent("c-customer-1")}&confirm=true&dry_run=false`,
			{ method: "DELETE", headers: { cookie: C.cookie } },
		);
		expect(wipe.status).toBe(200);
		expect(await liveCounts(sub.spaceId, subMarker)).toEqual(NO_RESIDUE);
		expect((await liveCounts(owner.spaceId, ownerMarker)).nodes).toBe(1);

		const { payload: ownerExport } = await exportAs(`cookie:${C.cookie}`, null);
		expect(memoryRowsText(ownerExport)).toContain(ownerMarker);
		expect(memoryRowsText(ownerExport)).not.toContain(subMarker);
	});
});
