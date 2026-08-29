/**
 * ADVERSARIAL — IDOR / forged object ids across accounts and sub-tenants.
 *
 * Every object id in this system is a public handle: receipts carry packet
 * ids, the dashboard carries node/candidate ids, the SDK's delete() takes an
 * id straight from a receipt. The question this file asks is the only one
 * that matters for a multi-tenant memory: does holding the id do anything?
 *
 * Data is seeded through the REAL doors (/v1/ingest with the deterministic
 * `_test.llmResponse` hook) for both victims and attackers, ids are captured
 * from real responses / real D1 rows, and every attack is then replayed with
 * the WRONG credential. Nothing here weakens a check to make a test green:
 * where the system defends, the test asserts the defense AND asserts the
 * victim's row is untouched afterwards.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { scopedMemoryUserId } from "../src/lib/egress_ownership.js";

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

/* ---------------------------------------------------------------- helpers */

async function mintToken(cookie, label) {
	const res = await request("/auth/tokens", jsonInit({ type: "api", label, scopes: ["memory:read", "memory:write"] }, cookie));
	expect(res.status).toBe(201);
	const body = await res.json();
	expect(body.token).toMatch(/^itsuki_live_/);
	return body.token;
}

/** Deterministic extraction that writes a durable node + slice. */
const durable = (label) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text: `Working on ${label}`, kind_detail: "progress", confidence: 0.9 },
	],
	notes: "",
});

/** Deterministic extraction that parks a weak "maybe" as a review candidate. */
const weakCandidate = (label) => ({
	objects: [{ kind: "candidate", label, strength: "weak", confidence: 0.35 }],
	notes: "",
});

function authHeaders({ cookie, bearer, project } = {}) {
	return {
		"content-type": "application/json",
		...(cookie ? { cookie } : {}),
		...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		...(project ? { "x-itsuki-project": project } : {}),
	};
}

/** Real write door. Returns { status, body } including source_packet_id. */
async function ingest(auth, content, llmResponse, { userId } = {}) {
	const res = await request("/v1/ingest", {
		method: "POST",
		headers: authHeaders(auth),
		body: JSON.stringify({
			...(userId ? { userId } : {}),
			flush: true,
			messages: [{ id: `m-${crypto.randomUUID()}`, role: "user", content }],
			_test: { llmResponse },
		}),
	});
	return { status: res.status, body: await res.json() };
}

async function getJson(path, auth) {
	const res = await request(path, { headers: authHeaders(auth) });
	let body = null;
	try { body = await res.json(); } catch {}
	return { status: res.status, body };
}

async function postJson(path, payload, auth) {
	const res = await request(path, { method: "POST", headers: authHeaders(auth), body: JSON.stringify(payload) });
	let body = null;
	try { body = await res.json(); } catch {}
	return { status: res.status, body };
}

async function del(path, auth) {
	const res = await request(path, { method: "DELETE", headers: authHeaders(auth) });
	let body = null;
	try { body = await res.json(); } catch {}
	return { status: res.status, body };
}

async function rows(sql, ...binds) {
	const { results } = await env.DB.prepare(sql).bind(...binds).all();
	return results ?? [];
}
async function one(sql, ...binds) {
	return env.DB.prepare(sql).bind(...binds).first();
}
async function countNodes(userId) {
	const row = await one("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL", userId);
	return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------ (a) packets */

describe("IDOR — GET /v1/packets/:id/status", () => {
	it("refuses another ACCOUNT's packet id for both a session and a Bearer key", async () => {
		const victim = await signupAccount("pkt-victim");
		const attacker = await signupAccount("pkt-attacker");

		const saved = await ingest({ cookie: victim.cookie }, "I am building project Falcon this month", durable("Falcon"));
		expect(saved.status).toBe(200);
		const packetId = saved.body.source_packet_id;
		expect(packetId).toBeTruthy();

		// Control: the owner really can read it, so the attack below is aimed at
		// live data and not at a 404 that would happen anyway.
		const owner = await getJson(`/v1/packets/${encodeURIComponent(packetId)}/status`, { cookie: victim.cookie });
		expect(owner.status).toBe(200);
		expect(owner.body.source_packet_id).toBe(packetId);

		const bySession = await getJson(`/v1/packets/${encodeURIComponent(packetId)}/status`, { cookie: attacker.cookie });
		expect(bySession.status).toBe(404);
		expect(bySession.body).toMatchObject({ error: "not_found" });

		const attackerToken = await mintToken(attacker.cookie, "attacker key");
		const byBearer = await getJson(`/v1/packets/${encodeURIComponent(packetId)}/status`, { bearer: attackerToken });
		expect(byBearer.status).toBe(404);

		// And forging the victim's own account id as the sub-tenant name does not
		// walk into their space: the scope id is derived from the ATTACKER's owner.
		const forged = await getJson(
			`/v1/packets/${encodeURIComponent(packetId)}/status?userId=${encodeURIComponent(victim.user.id)}`,
			{ bearer: attackerToken },
		);
		expect(forged.status).toBe(404);
	});

	it("refuses a sibling sub-tenant's packet id, and the same sub-tenant NAME under another account", async () => {
		const acct = await signupAccount("pkt-subtenant");
		const other = await signupAccount("pkt-otheracct");
		const token = await mintToken(acct.cookie, "multi-tenant key");
		const otherToken = await mintToken(other.cookie, "other key");

		const bobSave = await ingest({ bearer: token }, "I am building project Osprey this month", durable("Osprey"), { userId: "bob" });
		expect(bobSave.status).toBe(200);
		const bobPacket = bobSave.body.source_packet_id;
		expect(bobPacket).toBeTruthy();

		// Control: bob can read bob's packet.
		const asBob = await getJson(`/v1/packets/${encodeURIComponent(bobPacket)}/status?userId=bob`, { bearer: token });
		expect(asBob.status).toBe(200);
		expect(asBob.body.source_packet_id).toBe(bobPacket);

		// Attack 1: same key, sibling sub-tenant alice.
		const asAlice = await getJson(`/v1/packets/${encodeURIComponent(bobPacket)}/status?userId=alice`, { bearer: token });
		expect(asAlice.status).toBe(404);

		// Attack 2: a DIFFERENT account naming the same sub-tenant string "bob".
		const asForeignBob = await getJson(`/v1/packets/${encodeURIComponent(bobPacket)}/status?userId=bob`, { bearer: otherToken });
		expect(asForeignBob.status).toBe(404);

		// The two "bob" spaces are provably different memory spaces.
		const mine = await scopedMemoryUserId(acct.user.id, "bob");
		const theirs = await scopedMemoryUserId(other.user.id, "bob");
		expect(mine).not.toBe(theirs);
		const jobRow = await one("SELECT user_id FROM memory_jobs WHERE source_packet_id = ? LIMIT 1", bobPacket);
		expect(jobRow.user_id).toBe(mine);
	});
});

/* --------------------------------------------------------- (b) candidates */

describe("IDOR — POST /v1/candidates/:id/{promote,reject}", () => {
	it("refuses to promote another account's candidate, creates nothing, and leaves it pending", async () => {
		const victim = await signupAccount("cand-victim");
		const attacker = await signupAccount("cand-attacker");

		const seeded = await ingest({ cookie: victim.cookie }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"));
		expect(seeded.status).toBe(200);
		const victimCandidates = await rows(
			"SELECT id, status FROM candidates WHERE user_id = ? AND deleted_at IS NULL", victim.user.id,
		);
		expect(victimCandidates).toHaveLength(1);
		const candidateId = victimCandidates[0].id;
		expect(victimCandidates[0].status).toBe("pending");

		const attackerNodesBefore = await countNodes(attacker.user.id);

		// Attack 1: plain forged id on the attacker's own session.
		const bare = await postJson(`/v1/candidates/${encodeURIComponent(candidateId)}/promote`,
			{ action: "promote_to_node" }, { cookie: attacker.cookie });
		expect(bare.status).toBe(404);
		expect(String(bare.body?.error ?? "")).toContain("not found");

		// Attack 2: forged id PLUS the victim's account id as the memory user —
		// the "act as them" move. Must not resolve into the victim's space.
		const impersonating = await postJson(`/v1/candidates/${encodeURIComponent(candidateId)}/promote`,
			{ action: "promote_to_node", userId: victim.user.id }, { cookie: attacker.cookie });
		expect(impersonating.status).toBe(404);

		// Attack 3: merge_with_existing pointed at a node id the attacker forged
		// from the victim's graph would be the worst case — prove it also 404s
		// at the candidate lookup, before any write plan is built.
		const merge = await postJson(`/v1/candidates/${encodeURIComponent(candidateId)}/merge`,
			{ userId: victim.user.id, nodeId: "node_forged_by_attacker" }, { cookie: attacker.cookie });
		expect(merge.status).toBe(404);

		// The victim's candidate is untouched: still pending, never reviewed.
		const after = await one("SELECT status, reviewed_at, promoted_object_id FROM candidates WHERE id = ?", candidateId);
		expect(after.status).toBe("pending");
		expect(after.reviewed_at ?? null).toBeNull();
		expect(after.promoted_object_id ?? null).toBeNull();

		// No node appeared anywhere the attacker controls: not in their root
		// space, and not in the derived space the forged userId would have made.
		expect(await countNodes(attacker.user.id)).toBe(attackerNodesBefore);
		const derived = await scopedMemoryUserId(attacker.user.id, victim.user.id);
		expect(await countNodes(derived)).toBe(0);
		// And none in the victim's space either.
		expect(await countNodes(victim.user.id)).toBe(0);
	});

	it("refuses to reject/suppress another account's candidate", async () => {
		const victim = await signupAccount("rej-victim");
		const attacker = await signupAccount("rej-attacker");

		await ingest({ cookie: victim.cookie }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"));
		const candidate = await one("SELECT id FROM candidates WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(candidate?.id).toBeTruthy();

		const rejected = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/reject`,
			{ action: "suppress_similar" }, { cookie: attacker.cookie });
		expect(rejected.status).toBe(404);

		const impersonating = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/reject`,
			{ userId: victim.user.id, action: "suppress_similar" }, { cookie: attacker.cookie });
		expect(impersonating.status).toBe(404);

		const after = await one("SELECT status, suppressed_at FROM candidates WHERE id = ?", candidate.id);
		expect(after.status).toBe("pending");
		expect(after.suppressed_at ?? null).toBeNull();

		// A denied "suppress_similar" must not have written a suppression that
		// would silently poison the victim's future captures.
		const suppressions = await rows("SELECT id FROM memory_suppressions WHERE user_id = ?", victim.user.id);
		expect(suppressions).toHaveLength(0);

		// Positive control: the reject door is live and this id was a real
		// target — the owner's identical call succeeds.
		const owner = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/reject`,
			{ action: "suppress_similar" }, { cookie: victim.cookie });
		expect(owner.status).toBe(200);
		expect((await one("SELECT status FROM candidates WHERE id = ?", candidate.id)).status).toBe("suppressed");
	});

	it("refuses a sibling sub-tenant's candidate id under the SAME account key", async () => {
		const acct = await signupAccount("cand-subtenant");
		const token = await mintToken(acct.cookie, "sub-tenant key");

		await ingest({ bearer: token }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"), { userId: "bob" });
		const bobSpace = await scopedMemoryUserId(acct.user.id, "bob");
		const candidate = await one("SELECT id, status FROM candidates WHERE user_id = ? LIMIT 1", bobSpace);
		expect(candidate?.id).toBeTruthy();

		// The review door refuses Bearer auth outright (session-only), so the
		// only way in is the account session naming a sub-tenant.
		const viaKey = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/promote`,
			{ userId: "bob", action: "promote_to_node" }, { bearer: token });
		expect(viaKey.status).toBe(403);

		// Session + the WRONG sub-tenant name must not reach bob's candidate.
		const asAlice = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/promote`,
			{ userId: "alice", action: "promote_to_node" }, { cookie: acct.cookie });
		expect(asAlice.status).toBe(404);
		expect(await countNodes(await scopedMemoryUserId(acct.user.id, "alice"))).toBe(0);

		// Control: the right sub-tenant name does work, proving the id was live.
		const asBob = await postJson(`/v1/candidates/${encodeURIComponent(candidate.id)}/promote`,
			{ userId: "bob", action: "promote_to_node" }, { cookie: acct.cookie });
		expect(asBob.status).toBe(200);
		expect(await countNodes(bobSpace)).toBe(1);
	});
});

describe("IDOR — forged nodeId inside a candidate the attacker legitimately owns", () => {
	// The sharpest write-side variant: the attacker passes the CANDIDATE
	// ownership check with their own row, then aims the promotion's merge
	// target at the victim's node id. If ensureNode trusted body.nodeId, the
	// attacker would graft a slice of their own text onto the victim's graph.
	it("cannot graft a slice onto another account's node via body.nodeId", async () => {
		const victim = await signupAccount("graft-victim");
		const attacker = await signupAccount("graft-attacker");

		await ingest({ cookie: victim.cookie }, "I am building project Sparrow this month", durable("Sparrow"));
		const victimNode = await one("SELECT id, label FROM nodes WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(victimNode?.id).toBeTruthy();
		const victimSlicesBefore = (await rows("SELECT id FROM slices WHERE node_id = ?", victimNode.id)).length;

		await ingest({ cookie: attacker.cookie }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"));
		const mine = await one("SELECT id FROM candidates WHERE user_id = ? LIMIT 1", attacker.user.id);
		expect(mine?.id).toBeTruthy();

		// merge_with_existing must not resolve a foreign node id.
		const merge = await postJson(`/v1/candidates/${encodeURIComponent(mine.id)}/merge`,
			{ nodeId: victimNode.id }, { cookie: attacker.cookie });
		expect(merge.status).toBe(400);
		expect(String(merge.body?.error ?? "")).toContain("nodeId is required for merge");

		// promote_to_slice with the same forged target must land in the
		// ATTACKER's own space, never on the victim's node.
		const promote = await postJson(`/v1/candidates/${encodeURIComponent(mine.id)}/promote`,
			{ action: "promote_to_slice", nodeId: victimNode.id, text: "grafted by the attacker" },
			{ cookie: attacker.cookie });
		expect(promote.status).toBe(200);

		const victimSlicesAfter = await rows("SELECT id, user_id, text FROM slices WHERE node_id = ?", victimNode.id);
		expect(victimSlicesAfter).toHaveLength(victimSlicesBefore);
		expect(JSON.stringify(victimSlicesAfter)).not.toContain("grafted by the attacker");

		const grafted = await rows(
			"SELECT user_id, node_id FROM slices WHERE text = ?", "grafted by the attacker",
		);
		expect(grafted).toHaveLength(1);
		expect(grafted[0].user_id).toBe(attacker.user.id);
		expect(grafted[0].node_id).not.toBe(victimNode.id);
	});
});

/* ------------------------------------------------- (c) DELETE /v1/memories */

describe("IDOR — DELETE /v1/memories/:id", () => {
	it("will not delete another account's node by forged id (session, Bearer, or forged userId)", async () => {
		const victim = await signupAccount("del-victim");
		const attacker = await signupAccount("del-attacker");

		const saved = await ingest({ cookie: victim.cookie }, "I am building project Falcon this month", durable("Falcon"));
		expect(saved.status).toBe(200);
		const node = await one("SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NULL LIMIT 1", victim.user.id);
		expect(node?.id).toBeTruthy();

		const attackerToken = await mintToken(attacker.cookie, "delete key");

		const bySession = await del(`/v1/memories/${encodeURIComponent(node.id)}`, { cookie: attacker.cookie });
		expect(bySession.status).toBe(404);

		const byBearer = await del(`/v1/memories/${encodeURIComponent(node.id)}`, { bearer: attackerToken });
		expect(byBearer.status).toBe(404);

		const forged = await del(
			`/v1/memories/${encodeURIComponent(node.id)}?userId=${encodeURIComponent(victim.user.id)}`,
			{ bearer: attackerToken },
		);
		expect(forged.status).toBe(404);

		// The victim's node is still live and un-suppressed after three attempts.
		const still = await one("SELECT id, deleted_at, suppressed_at FROM nodes WHERE id = ?", node.id);
		expect(still).toBeTruthy();
		expect(still.deleted_at ?? null).toBeNull();
		expect(still.suppressed_at ?? null).toBeNull();

		// No deletion tombstone receipt was written in the victim's name.
		const tombstones = await rows(
			"SELECT id FROM receipts WHERE user_id = ? AND outcome = 'deleted'", victim.user.id,
		);
		expect(tombstones).toHaveLength(0);

		// Control: the owner CAN delete it, proving the id was a live target.
		const owner = await del(`/v1/memories/${encodeURIComponent(node.id)}`, { cookie: victim.cookie });
		expect(owner.status).toBe(200);
		const gone = await one("SELECT deleted_at FROM nodes WHERE id = ?", node.id);
		expect(gone.deleted_at ?? null).not.toBeNull();
	});

	it("bulk delete-by-source cannot reach across accounts even with an identical source label", async () => {
		const victim = await signupAccount("bulk-victim");
		const attacker = await signupAccount("bulk-attacker");

		await ingest({ cookie: victim.cookie }, "I am building project Kestrel this month", durable("Kestrel"));
		await ingest({ cookie: attacker.cookie }, "I am building project Kestrel this month", durable("Kestrel"));
		const before = await countNodes(victim.user.id);
		expect(before).toBeGreaterThan(0);
		expect(await countNodes(attacker.user.id)).toBeGreaterThan(0);

		const res = await del("/v1/memories?confirm=true&dry_run=false", { cookie: attacker.cookie });
		expect(res.status).toBe(200);

		// Positive control: the sweep really did destroy everything it could
		// reach — it simply could never reach the victim's identically-labelled
		// graph.
		expect(await countNodes(attacker.user.id)).toBe(0);
		expect(await countNodes(victim.user.id)).toBe(before);
	});

	// Found in passing, on target (c): the id-prefix dispatch has no `event_`
	// arm, so the owner's OWN event id is refused by the very error message
	// that names event_ as accepted. Not a boundary breach — a delete-contract
	// hole (the SDK documents delete(id) for event_ ids).
	it("cannot delete an event by id at all — the owner's own event_ id is rejected as unrecognized", async () => {
		const owner = await signupAccount("del-event");
		await ingest({ cookie: owner.cookie }, "I launched Project Atlas today.", {
			objects: [
				{ kind: "node", label: "Project Atlas", category: "project", confidence: 0.95 },
				{ kind: "event", on: "Project Atlas", action: "launched", text: "Launched Project Atlas", importance: "ordinary", confidence: 0.95 },
			],
			notes: "",
		});
		const event = await one("SELECT id FROM events WHERE user_id = ? LIMIT 1", owner.user.id);
		expect(event?.id).toMatch(/^event_/);

		const res = await del(`/v1/memories/${encodeURIComponent(event.id)}`, { cookie: owner.cookie });
		expect(res.status).toBe(400);
		// The refusal no longer lists event_ among the accepted prefixes — it
		// used to, which meant the message named a control that does not exist
		// to the one person who had just discovered that. It now says what to
		// do instead. The BEHAVIOUR is unchanged: events are deleted with their
		// node, and the row below still survives.
		expect(res.body.message).not.toContain("event_,");
		expect(res.body.message).toContain("cannot be deleted on its own");
		expect(res.body.message).toContain("Delete its node");
		// Still there: the row the owner asked to erase survives.
		expect((await one("SELECT deleted_at FROM events WHERE id = ?", event.id)).deleted_at ?? null).toBeNull();
	});
});

/* ------------------------------------ (d) GET /v1/memories/workspace/* */

describe("IDOR — GET /v1/memories/workspace/*", () => {
	it("404s another account's memory id and never leaks it through the satellites", async () => {
		const victim = await signupAccount("ws-victim");
		const attacker = await signupAccount("ws-attacker");

		const saved = await ingest({ cookie: victim.cookie }, "I am building project Merlin this month", durable("Merlin"));
		expect(saved.status).toBe(200);
		const node = await one("SELECT id, label FROM nodes WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(node?.id).toBeTruthy();

		// Control: the owner's inspector really does render this node.
		const owner = await getJson(`/v1/memories/workspace/memory/${encodeURIComponent(node.id)}`, { cookie: victim.cookie });
		expect(owner.status).toBe(200);
		expect(owner.body.memory.text).toBe(node.label);

		for (const path of [
			`/v1/memories/workspace/memory/${encodeURIComponent(node.id)}`,
		]) {
			const res = await getJson(path, { cookie: attacker.cookie });
			expect(res.status).toBe(404);
			expect(JSON.stringify(res.body)).not.toContain(node.label);
		}

		// Satellites are bounded lists whose queries bind the caller's own
		// user_id, so a foreign node id 200s with an EMPTY page rather than
		// 404ing. That is a softer contract than the detail route (an existence
		// oracle it is not — an id the caller does not own is indistinguishable
		// from an id with no rows) but it must never carry a victim row.
		for (const satellite of ["evidence", "timeline", "connections"]) {
			const res = await getJson(
				`/v1/memories/workspace/memory/${encodeURIComponent(node.id)}/${satellite}`,
				{ cookie: attacker.cookie },
			);
			expect(res.status).toBe(200);
			expect(res.body.items).toEqual([]);
			expect(res.body.next_cursor ?? null).toBeNull();
			expect(JSON.stringify(res.body ?? {})).not.toContain(node.label);
		}

		// The owner's identical satellite call is NOT empty — proof the node
		// really had evidence for the attacker's call to have leaked.
		const ownerEvidence = await getJson(
			`/v1/memories/workspace/memory/${encodeURIComponent(node.id)}/evidence`,
			{ cookie: victim.cookie },
		);
		expect(ownerEvidence.status).toBe(200);
		expect((ownerEvidence.body.items ?? []).length).toBeGreaterThan(0);

		// Same again with a Bearer key and a forged userId naming the victim.
		const attackerToken = await mintToken(attacker.cookie, "ws key");
		const forged = await getJson(
			`/v1/memories/workspace/memory/${encodeURIComponent(node.id)}?userId=${encodeURIComponent(victim.user.id)}`,
			{ bearer: attackerToken },
		);
		expect(forged.status).toBe(404);
	});

	it("404s another account's source id, its content and its raw evidence", async () => {
		const victim = await signupAccount("wsrc-victim");
		const attacker = await signupAccount("wsrc-attacker");

		const secret = "My social security number is 000-00-1234 and I am building project Harrier";
		const saved = await ingest({ cookie: victim.cookie }, secret, durable("Harrier"));
		expect(saved.status).toBe(200);
		const packetId = saved.body.source_packet_id;
		expect(packetId).toBeTruthy();

		const owner = await getJson(`/v1/memories/workspace/sources/${encodeURIComponent(packetId)}`, { cookie: victim.cookie });
		expect(owner.status).toBe(200);
		expect(owner.body.source.id).toBe(packetId);

		for (const suffix of ["", "/memories", "/evidence", "/content"]) {
			const res = await getJson(
				`/v1/memories/workspace/sources/${encodeURIComponent(packetId)}${suffix}`,
				{ cookie: attacker.cookie },
			);
			expect(res.status).toBe(404);
			expect(JSON.stringify(res.body ?? {})).not.toContain("000-00-1234");
			expect(JSON.stringify(res.body ?? {})).not.toContain("Harrier");
		}

		// The attacker's own inventory/sources lists stay empty — no id from the
		// forged reads leaked into their workspace.
		const inventory = await getJson("/v1/memories/workspace/inventory", { cookie: attacker.cookie });
		expect(inventory.status).toBe(200);
		expect(inventory.body.items ?? []).toHaveLength(0);
		const sources = await getJson("/v1/memories/workspace/sources", { cookie: attacker.cookie });
		expect(sources.status).toBe(200);
		expect(sources.body.items ?? []).toHaveLength(0);
	});

	it("a forged x-itsuki-project header cannot move a caller into another account's memory space", async () => {
		const victim = await signupAccount("proj-victim");
		const attacker = await signupAccount("proj-attacker");

		const saved = await ingest({ cookie: victim.cookie }, "I am building project Condor this month", durable("Condor"));
		expect(saved.status).toBe(200);
		const packetId = saved.body.source_packet_id;

		const project = await one(
			"SELECT id FROM managed_projects WHERE owner_user_id = ? ORDER BY created_at ASC LIMIT 1",
			victim.user.id,
		);
		expect(project?.id).toMatch(/^proj_/);

		// Positive control: the header path is LIVE — the victim's own session
		// carrying that exact header reads their memory space.
		const legitimate = await getJson("/v1/memories/workspace/inventory",
			{ cookie: victim.cookie, project: project.id });
		expect(legitimate.status).toBe(200);
		expect((legitimate.body.items ?? []).length).toBeGreaterThan(0);

		// The project header is the one input that legitimately RE-HOMES a caller
		// into another user's memory space (shared projects). Membership is the
		// only thing standing between that and total cross-account read.
		const inventory = await getJson("/v1/memories/workspace/inventory",
			{ cookie: attacker.cookie, project: project.id });
		expect(inventory.status).toBe(404);
		expect(inventory.body).toMatchObject({ error: "project_not_found" });

		const status = await getJson(`/v1/packets/${encodeURIComponent(packetId)}/status`,
			{ cookie: attacker.cookie, project: project.id });
		expect(status.status).toBe(404);
		expect(JSON.stringify(status.body ?? {})).not.toContain("Condor");

		// A Bearer key is bound to the project it was minted for, so the forged
		// header is refused one step earlier still — the credential cannot even
		// change projects, membership question never asked.
		const attackerToken = await mintToken(attacker.cookie, "proj key");
		const viaKey = await getJson("/v1/memories/workspace/inventory",
			{ bearer: attackerToken, project: project.id });
		expect(viaKey.status).toBe(403);
		expect(viaKey.body).toMatchObject({ code: "project_scope_mismatch" });
		expect(JSON.stringify(viaKey.body ?? {})).not.toContain("Condor");
	});
});

/* ------------------------------------------- read door, for completeness */

describe("IDOR — GET /v1/memories/:id", () => {
	it("404s another account's node id and returns no ETag revision oracle", async () => {
		const victim = await signupAccount("read-victim");
		const attacker = await signupAccount("read-attacker");

		await ingest({ cookie: victim.cookie }, "I am building project Peregrine this month", durable("Peregrine"));
		const node = await one("SELECT id, label FROM nodes WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(node?.id).toBeTruthy();

		// Positive control: the owner's read returns the object and a revision
		// ETag, so the attacker's 404 below is a refusal, not an empty database.
		const owner = await request(`/v1/memories/${encodeURIComponent(node.id)}`, {
			headers: { cookie: victim.cookie },
		});
		expect(owner.status).toBe(200);
		expect(owner.headers.get("etag")).toMatch(/^"r\d+"$/);

		const res = await request(`/v1/memories/${encodeURIComponent(node.id)}`, {
			headers: { cookie: attacker.cookie },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("etag")).toBeNull();
		expect(await res.text()).not.toContain("Peregrine");
	});
});

/* ------------------------------- safe-update doors (same forged-id class) */

describe("IDOR — PATCH /v1/memories/:id, history and rollback", () => {
	it("cannot edit, read the history of, or roll back another account's node", async () => {
		const victim = await signupAccount("upd-victim");
		const attacker = await signupAccount("upd-attacker");

		await ingest({ cookie: victim.cookie }, "I am building project Swift this month", durable("Swift"));
		const node = await one("SELECT id, label, COALESCE(revision, 1) AS revision FROM nodes WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(node?.id).toBeTruthy();

		// The idempotency key is validated BEFORE the object is looked up
		// (src/lib/memory_versions.js:451), so an attack without one dies on
		// validation and proves nothing. Send a well-formed request so the
		// ownership check is genuinely what refuses it.
		const attack = (cookie, label) => request(`/v1/memories/${encodeURIComponent(node.id)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", cookie, "if-match": `"r${node.revision}"` },
			body: JSON.stringify({
				label,
				expectedRevision: Number(node.revision),
				idempotencyKey: `idem-${crypto.randomUUID()}`,
			}),
		});

		const patch = await attack(attacker.cookie, "owned by the attacker");
		expect(patch.status).toBe(404);
		expect(await patch.json()).toMatchObject({ error: "not_found" });

		const history = await getJson(`/v1/memories/${encodeURIComponent(node.id)}/history`, { cookie: attacker.cookie });
		expect(history.status).toBe(404);
		expect(JSON.stringify(history.body ?? {})).not.toContain("Swift");

		const rollback = await postJson(`/v1/memories/${encodeURIComponent(node.id)}/rollback`,
			{ toRevision: 1, expectedRevision: Number(node.revision), idempotencyKey: `idem-${crypto.randomUUID()}` },
			{ cookie: attacker.cookie });
		expect(rollback.status).toBe(404);

		const after = await one("SELECT label, COALESCE(revision, 1) AS revision FROM nodes WHERE id = ?", node.id);
		expect(after.label).toBe(node.label);
		expect(Number(after.revision)).toBe(Number(node.revision));

		// Positive control: the byte-identical request from the OWNER lands, so
		// the three 404s above are refusals, not malformed requests.
		const owner = await attack(victim.cookie, "renamed by the owner");
		expect(owner.status).toBe(200);
		const renamed = await one("SELECT label, COALESCE(revision, 1) AS revision FROM nodes WHERE id = ?", node.id);
		expect(renamed.label).toBe("renamed by the owner");
		expect(Number(renamed.revision)).toBe(Number(node.revision) + 1);
	});
});

/* ------------------------------------------------ legacy operator key */

describe("blast radius of the legacy x-api-key (documented admin key)", () => {
	// README: "Legacy admin key for x-api-key + userId flows." This test does
	// not claim a breach — it PINS how much that one secret can do, so nobody
	// widens the surface by accident and nobody mistakes it for a tenant key.
	it("x-api-key + userId writes directly into a real account's memory space", async () => {
		const victim = await signupAccount("legacy-victim");
		await ingest({ cookie: victim.cookie }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"));
		const candidate = await one("SELECT id FROM candidates WHERE user_id = ? LIMIT 1", victim.user.id);
		expect(candidate?.id).toBeTruthy();

		const res = await request(`/v1/candidates/${encodeURIComponent(candidate.id)}/promote`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({ userId: victim.user.id, action: "promote_to_node" }),
		});
		const body = await res.json();

		// The legacy key resolves to the RAW userId it is handed — no scope
		// derivation — so it reaches any account by id. That is the documented
		// operator contract; it is also why this key must never be issued to a
		// tenant, and why every tenant-facing door (Bearer) is refused above.
		expect(res.status).toBe(200);
		expect(body.receipt.outcome).toBe("promoted_from_candidate");
		expect(await countNodes(victim.user.id)).toBe(1);

		// A WRONG-but-well-formed userId under the same master key still cannot
		// touch the victim: the id is the whole boundary, so it is a namespace,
		// not an escalation.
		const other = await signupAccount("legacy-other");
		await ingest({ cookie: other.cookie }, "Maybe I will learn guitar someday.", weakCandidate("Guitar"));
		const otherCandidate = await one("SELECT id, status FROM candidates WHERE user_id = ? LIMIT 1", other.user.id);
		const mismatched = await request(`/v1/candidates/${encodeURIComponent(otherCandidate.id)}/promote`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({ userId: victim.user.id, action: "promote_to_node" }),
		});
		expect(mismatched.status).toBe(404);
		expect((await one("SELECT status FROM candidates WHERE id = ?", otherCandidate.id)).status).toBe("pending");
	});
});
