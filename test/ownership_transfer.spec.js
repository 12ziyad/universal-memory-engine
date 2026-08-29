/* Ownership transfer as a two-party act.
 *
 * It used to complete the instant the owner clicked — no acceptance, no
 * notice, no email. Someone could become responsible for a project's memory,
 * keys and deletion controls without agreeing to it. These tests pin that it
 * is now offered, accepted, and told to both people.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import {
	offerProjectOwnership,
	describeTransferOffer,
	acceptProjectOwnership,
	closeTransferOffer,
	expireStaleTransfers,
} from "../src/lib/ownership_transfer.js";

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

const cookieFrom = (res) => res.headers.get("set-cookie")?.split(";")[0] || "";

async function signupAccount(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", jsonInit({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	return { email, user: (await res.json()).user, cookie: cookieFrom(res) };
}

/** An org with a project and two active members: owner and colleague. */
async function world() {
	const owner = await signupAccount("xfer-owner");
	const other = await signupAccount("xfer-other");
	const orgId = `org_${crypto.randomUUID()}`;
	const projectId = `proj_${crypto.randomUUID()}`;
	const now = Date.now();
	const tag = crypto.randomUUID().slice(0, 8);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO organizations (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
		).bind(orgId, owner.user.id, `Xfer ${tag}`, `xfer ${tag}`, now, now),
		env.DB.prepare(
			"INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)",
		).bind(`om_${crypto.randomUUID()}`, orgId, owner.user.id, now, now),
		env.DB.prepare(
			"INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)",
		).bind(`om_${crypto.randomUUID()}`, orgId, other.user.id, now, now),
		env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'Atlas', ?, 0, 'active', ?, ?)`,
		).bind(projectId, owner.user.id, orgId, `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`, `atlas ${tag}`, now, now),
	]);
	return { owner, other, orgId, projectId };
}

const outboxFor = async (email) => {
	const { results } = await env.DB.prepare(
		"SELECT kind, subject, body_json FROM mail_outbox WHERE to_email = ? ORDER BY created_at",
	).bind(email).all();
	return results ?? [];
};

describe("making the offer", () => {
	it("creates a pending offer and emails the recipient — nothing has moved yet", async () => {
		const { owner, other, projectId } = await world();
		const result = await offerProjectOwnership(env, {
			actorUserId: owner.user.id, projectId, recipientUserId: other.user.id,
		});
		expect(result.error).toBeUndefined();
		expect(result.offer.status).toBe("pending");

		// Ownership is UNCHANGED until acceptance — the whole point.
		const project = await env.DB.prepare("SELECT owner_user_id FROM managed_projects WHERE id = ?").bind(projectId).first();
		expect(project.owner_user_id).toBe(owner.user.id);

		const mail = await outboxFor(other.email);
		expect(mail).toHaveLength(1);
		expect(mail[0].kind).toBe("ownership_transfer_offer");
		expect(mail[0].body_json).toContain("Nothing has changed yet");
	});

	it("refuses a non-member, the owner themselves, and the default project", async () => {
		const { owner, projectId } = await world();
		const stranger = await signupAccount("xfer-stranger");

		const notMember = await offerProjectOwnership(env, {
			actorUserId: owner.user.id, projectId, recipientUserId: stranger.user.id,
		});
		expect(notMember.error).toBe("recipient_not_member");
		expect(notMember.message).toMatch(/Invite them first/);

		const toSelf = await offerProjectOwnership(env, {
			actorUserId: owner.user.id, projectId, recipientUserId: owner.user.id,
		});
		expect(toSelf.error).toBe("invalid_recipient");

		await env.DB.prepare("UPDATE managed_projects SET is_default = 1 WHERE id = ?").bind(projectId).run();
		const def = await offerProjectOwnership(env, {
			actorUserId: owner.user.id, projectId, recipientUserId: owner.user.id,
		});
		expect(def.error).toBeTruthy();
	});

	it("lets only the owner offer, and only one offer at a time", async () => {
		const { owner, other, projectId } = await world();
		const notOwner = await offerProjectOwnership(env, {
			actorUserId: other.user.id, projectId, recipientUserId: owner.user.id,
		});
		expect(notOwner.error).toBe("forbidden");

		expect((await offerProjectOwnership(env, { actorUserId: owner.user.id, projectId, recipientUserId: other.user.id })).error).toBeUndefined();
		const second = await offerProjectOwnership(env, { actorUserId: owner.user.id, projectId, recipientUserId: other.user.id });
		expect(second.error).toBe("offer_exists");
	});
});

describe("accepting", () => {
	/** Offers and returns the token by reading the link out of the email. */
	async function offerWithToken(owner, other, projectId) {
		const result = await offerProjectOwnership(env, {
			actorUserId: owner.user.id, projectId, recipientUserId: other.user.id,
		});
		expect(result.error).toBeUndefined();
		const mail = (await outboxFor(other.email)).at(-1);
		const link = /#transfer=([^"\\]+)/.exec(mail.body_json)?.[1] ?? "";
		const [offerId, token] = link.split(".");
		expect(offerId).toBe(result.offer.id);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		return { offerId, token };
	}

	it("moves ownership only on accept, and tells BOTH people", async () => {
		const { owner, other, projectId } = await world();
		const { offerId, token } = await offerWithToken(owner, other, projectId);

		const preview = await describeTransferOffer(env, { offerId, token, viewerUserId: other.user.id });
		expect(preview.error).toBeUndefined();
		expect(preview.offer.project.name).toBe("Atlas");

		const accepted = await acceptProjectOwnership(env, { offerId, token, accepterUserId: other.user.id });
		expect(accepted.error).toBeUndefined();
		expect(accepted.ok).toBe(true);

		const project = await env.DB.prepare("SELECT owner_user_id FROM managed_projects WHERE id = ?").bind(projectId).first();
		expect(project.owner_user_id).toBe(other.user.id);

		// The previous owner keeps administrator access, and is told so.
		const oldOwnerMail = (await outboxFor(owner.email)).filter((m) => m.kind === "ownership_transfer_done");
		const newOwnerMail = (await outboxFor(other.email)).filter((m) => m.kind === "ownership_transfer_done");
		expect(oldOwnerMail).toHaveLength(1);
		expect(newOwnerMail).toHaveLength(1);
		expect(oldOwnerMail[0].body_json).toMatch(/administrator/i);
	});

	it("refuses the wrong account, a bad token, and a replay", async () => {
		const { owner, other, projectId } = await world();
		const intruder = await signupAccount("xfer-intruder");
		const { offerId, token } = await offerWithToken(owner, other, projectId);

		// Someone else holding the link cannot accept it.
		const wrongAccount = await acceptProjectOwnership(env, { offerId, token, accepterUserId: intruder.user.id });
		expect(wrongAccount.error).toBe("not_recipient");

		// A guessed token is not a token.
		const badToken = await acceptProjectOwnership(env, { offerId, token: "0".repeat(64), accepterUserId: other.user.id });
		expect(badToken.error).toBe("offer_not_found");

		expect((await acceptProjectOwnership(env, { offerId, token, accepterUserId: other.user.id })).ok).toBe(true);
		// Replay after success.
		const replay = await acceptProjectOwnership(env, { offerId, token, accepterUserId: other.user.id });
		expect(replay.error).toBe("offer_closed");
	});

	it("refuses an expired offer, and the sweep closes stale ones", async () => {
		const { owner, other, projectId } = await world();
		const { offerId, token } = await offerWithToken(owner, other, projectId);
		await env.DB.prepare("UPDATE project_ownership_transfers SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, offerId).run();

		const expired = await acceptProjectOwnership(env, { offerId, token, accepterUserId: other.user.id });
		expect(expired.error).toBe("offer_expired");

		const swept = await expireStaleTransfers(env);
		expect(swept.expired).toBeGreaterThanOrEqual(1);
		const row = await env.DB.prepare("SELECT status FROM project_ownership_transfers WHERE id = ?").bind(offerId).first();
		expect(row.status).toBe("expired");

		// Ownership never moved.
		const project = await env.DB.prepare("SELECT owner_user_id FROM managed_projects WHERE id = ?").bind(projectId).first();
		expect(project.owner_user_id).toBe(owner.user.id);
	});

	it("can be withdrawn by the owner and declined by the recipient", async () => {
		const first = await world();
		const a = await offerProjectOwnership(env, {
			actorUserId: first.owner.user.id, projectId: first.projectId, recipientUserId: first.other.user.id,
		});
		expect((await closeTransferOffer(env, { offerId: a.offer.id, actorUserId: first.other.user.id, outcome: "cancelled" })).error).toBe("forbidden");
		expect((await closeTransferOffer(env, { offerId: a.offer.id, actorUserId: first.owner.user.id, outcome: "cancelled" })).ok).toBe(true);

		const second = await world();
		const b = await offerProjectOwnership(env, {
			actorUserId: second.owner.user.id, projectId: second.projectId, recipientUserId: second.other.user.id,
		});
		expect((await closeTransferOffer(env, { offerId: b.offer.id, actorUserId: second.other.user.id, outcome: "declined" })).ok).toBe(true);
		const row = await env.DB.prepare("SELECT status FROM project_ownership_transfers WHERE id = ?").bind(b.offer.id).first();
		expect(row.status).toBe("declined");
	});
});

describe("the doors", () => {
	it("require a session", async () => {
		expect((await request("/v1/settings/lifecycle/transfer", jsonInit({}))).status).toBe(401);
		expect((await request("/v1/settings/lifecycle/transfer/accept", jsonInit({}))).status).toBe(401);
		expect((await request("/v1/settings/lifecycle/transfer?id=x&token=y")).status).toBe(401);
	});

	it("offers over HTTP without moving ownership", async () => {
		const { owner, other, projectId } = await world();
		const res = await request("/v1/settings/lifecycle/transfer", jsonInit({
			projectId, recipientUserId: other.user.id,
		}, owner.cookie));
		expect(res.status).toBe(200);
		expect((await res.json()).offer.status).toBe("pending");
		const project = await env.DB.prepare("SELECT owner_user_id FROM managed_projects WHERE id = ?").bind(projectId).first();
		expect(project.owner_user_id).toBe(owner.user.id);
	});
});
