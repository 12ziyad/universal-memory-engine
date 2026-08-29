/* Promise → Implementation → Evidence (Phase 3).
 *
 * The Phase 3 truthfulness re-read checked 130 public claims against the code
 * and found claims the code contradicted. Wording was corrected, and in one
 * case the CODE was corrected instead (receipts kept memory labels after an
 * erasure that promised to leave none).
 *
 * These tests pin the corrected pairs. Each one exists because the claim was
 * once false: the point is not to re-state the wording, it is to make the
 * behaviour and the sentence fail together if either drifts.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";
import docs from "../public/docs/index.html?raw";
import securityMd from "../SECURITY.md?raw";
import { bulkDeleteBySource } from "../src/pipeline/cleanup.js";

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

describe("the visit beacon says what it actually stores", () => {
	it("no longer claims to store no identifier, because it stores a day-scoped one", () => {
		// The beacon keeps a truncated, daily-salted hash of IP+UA in
		// visit_uniques.sketch so a repeat visit is counted once. That is a
		// pseudonymous identifier, however short-lived — "stores no identifier"
		// was false, and the sentence now describes the real mechanism.
		expect(html).not.toContain("sets no cookie and stores no identifier");
		expect(html).toContain("never stores your IP address or user agent");
		expect(html).toContain("salted with a key that changes daily");
		// The dimensions it keeps are disclosed rather than implied away.
		expect(html).toContain("referring domain, country, and device class");
	});

	it("still stores nothing personal in the visit counter row itself", async () => {
		const day = new Date().toISOString().slice(0, 10);
		const res = await request("/v1/beacon", jsonInit({ kind: "landing" }));
		expect(res.status).toBe(200);
		const row = await env.DB.prepare(
			"SELECT * FROM site_visits WHERE day = ? AND kind = 'landing'",
		).bind(day).first();
		expect(Object.keys(row).sort()).toEqual(["count", "day", "kind"]);
	});
});

describe("erasure leaves no memory content in the write ledger", () => {
	it("clears receipt summaries and details that named the erased memories", async () => {
		const who = await signupAccount("ledger-truth");
		const userId = who.user.id;

		// A receipt shaped exactly like the write ledger's own: its summary and
		// detail name the memory that was written.
		await env.DB.prepare(
			`INSERT INTO receipts (id, user_id, outcome, created_at, summary, detail, scope_json)
			 VALUES (?, ?, 'accepted', ?, ?, ?, '{}')`,
		).bind(
			`rcpt_${crypto.randomUUID()}`, userId, Date.now(),
			"1 node (Aveiro salary negotiation)",
			JSON.stringify({ newNodeLabels: ["Aveiro salary negotiation"] }),
		).run();

		const before = await env.DB.prepare(
			"SELECT summary, detail FROM receipts WHERE user_id = ?",
		).bind(userId).first();
		expect(before.summary).toContain("Aveiro");

		// The unscoped erasure — the door behind "delete everything".
		const result = await bulkDeleteBySource(env, userId, { dryRun: false, confirm: true });
		expect(result.ok).toBe(true);

		const after = await env.DB.prepare(
			"SELECT summary, detail FROM receipts WHERE user_id = ?",
		).bind(userId).first();
		// The row survives as evidence that a write happened...
		expect(after).toBeTruthy();
		// ...but nothing in it names what was written.
		expect(after.summary).toBeNull();
		expect(after.detail).toBe("{}");
		expect(JSON.stringify(after)).not.toContain("Aveiro");
		expect(result.receipts_scrubbed).toBeGreaterThan(0);
	});

	it("says so in the documentation, in the same terms", () => {
		expect(docs).toContain("After an unscoped erasure the receipt rows are scrubbed");
		expect(docs).toContain("their summaries and details");
		// The old wording claimed the whole trail carried no memory content.
		// The extraction ledger is deliberately retained and still names the
		// objects each run created, so the docs must say that rather than
		// generalise from receipts to the entire trail.
		expect(docs).not.toContain("that trail carries no memory content");
		expect(docs).toContain("The extraction ledger is retained for audit");
	});
});

describe("deletion copy matches the deletion mechanism", () => {
	it("no longer promises 'no soft-delete residue'", () => {
		// Rows are tombstoned and swept by the space/retention purge, which is
		// a real and defensible design — but it is not "no residue", and the
		// landing page claimed exactly that.
		expect(html).not.toContain("No soft-delete residue");
		expect(html).toContain("Rows are tombstoned first and purged by the space or retention sweep");
		expect(html).toContain("nothing deleted is ever served again");
	});
});

describe("the disclosure policy does not send researchers to stale code", () => {
	it("states that production can be ahead of the published repository", () => {
		expect(securityMd).not.toMatch(/always runs the latest/i);
		expect(securityMd).toMatch(/ahead of what is published/i);
		expect(securityMd).toContain("founder@itsuki.app");
	});

	it("the security page makes the same caveat rather than promising checkability", () => {
		// The security modules the tenant-isolation claims rest on are not yet
		// in the public tree, so "every claim here can be checked against the
		// code" was a promise the repository could not keep.
		expect(html).not.toContain("every claim here can be checked against the code that enforces it");
		expect(html).toContain("runs ahead of what has been published to GitHub");
	});
});
