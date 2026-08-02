/**
 * Sub-tenancy under Bearer auth, and the silent-parameter class of bug.
 *
 * The reported failure: three saves with three different `user_id` values all
 * landed in the key owner's bucket behind `ok: true`. The cause was not
 * missing Bearer support — `userId` (camelCase) always worked — but that
 * `user_id` was an unrecognised key and unrecognised keys were DROPPED. An
 * integrator reading the Python SDK's own docstring writes snake_case, gets a
 * success receipt, and ships a multi-tenant app with no isolation.
 *
 * So the contract is now two-sided: the alias is honoured, and anything that
 * is neither known nor aliased is refused loudly.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { validateBody, credentialShapeHint } from "../src/lib/params.js";

async function call(path, init) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	let body = null;
	try { body = await res.json(); } catch {}
	return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? null };
}

async function bearerKey(prefix) {
	const signup = await call("/auth/signup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: `${prefix}-${crypto.randomUUID()}@example.com`, password: "correct-horse", name: prefix, acceptTerms: true }),
	});
	expect(signup.status).toBe(201);
	const cookie = signup.cookie;
	const tok = await call("/auth/tokens", {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ type: "api", label: "sdk" }),
	});
	return { key: tok.body.token, ownerId: signup.body.user.id, cookie };
}

const canned = {
	llmResponse: { objects: [{ kind: "node", label: "Scoped fact", category: "other", confidence: 0.9 },
		{ kind: "slice", on: "Scoped fact", text: "A durable detail.", kind_detail: "other", confidence: 0.9 }] },
	edgeResponse: { edges: [] },
	reflexionResponse: { entities: [], facts: [], edges: [] },
};

function scopeOf(body) {
	return JSON.parse(body?.receipt?.scope_json ?? "{}");
}

describe("one key, many tenants", () => {
	it("snake_case user_id scopes exactly like camelCase userId", async () => {
		const { key, ownerId } = await bearerKey("tenancy");
		const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };

		const alice = await call("/v1/save", { method: "POST", headers, body: JSON.stringify({ content: "Alice fact.", user_id: "alice", _test: canned }) });
		const bob = await call("/v1/save", { method: "POST", headers, body: JSON.stringify({ content: "Bob fact.", userId: "bob", _test: canned }) });
		const owner = await call("/v1/save", { method: "POST", headers, body: JSON.stringify({ content: "Owner fact.", _test: canned }) });

		const a = scopeOf(alice.body), b = scopeOf(bob.body), o = scopeOf(owner.body);
		expect(a.external_user_id).toBe("alice");
		expect(b.external_user_id).toBe("bob");
		// Three tenants, three buckets — none of them the owner's.
		expect(a.memory_user_id).not.toBe(o.memory_user_id);
		expect(b.memory_user_id).not.toBe(o.memory_user_id);
		expect(a.memory_user_id).not.toBe(b.memory_user_id);
		expect(o.memory_user_id).toBe(ownerId);
		// The owner is still recorded on every scoped save, for billing/audit.
		expect(a.owner_user_id).toBe(ownerId);
	});

	it("memory saved for one tenant is invisible to another", async () => {
		const { key } = await bearerKey("isolation");
		const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
		await call("/v1/save", {
			method: "POST", headers,
			body: JSON.stringify({ content: "Pixel is Alice's cat.", user_id: "alice", _test: {
				...canned,
				llmResponse: { objects: [{ kind: "node", label: "Pixel", category: "other", confidence: 0.95 },
					{ kind: "slice", on: "Pixel", text: "Alice's cat is called Pixel.", kind_detail: "other", confidence: 0.9 }] },
			} }),
		});

		const asAlice = await call("/v1/recall", { method: "POST", headers, body: JSON.stringify({ query: "What is the cat called?", user_id: "alice" }) });
		const asBob = await call("/v1/recall", { method: "POST", headers, body: JSON.stringify({ query: "What is the cat called?", user_id: "bob" }) });
		// Even the literal text of the other tenant's fact must not cross.
		const asBobLiteral = await call("/v1/recall", { method: "POST", headers, body: JSON.stringify({ query: "Alice's cat is called Pixel.", user_id: "bob" }) });

		expect(asAlice.body.context).toContain("Pixel");
		expect(asBob.body.context ?? "").not.toContain("Pixel");
		expect(asBobLiteral.body.context ?? "").not.toContain("Pixel");
	});

	it("a tenant id from another key's space resolves somewhere else entirely", async () => {
		const one = await bearerKey("keyone");
		const two = await bearerKey("keytwo");
		const save = (key, userId) => call("/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ content: "Same tenant name, different key.", user_id: userId, _test: canned }),
		});
		const a = scopeOf((await save(one.key, "shared-name")).body);
		const b = scopeOf((await save(two.key, "shared-name")).body);
		// Same external id, different owners → different memory spaces. The
		// hash is salted with the owner, so guessing a tenant name buys nothing.
		expect(a.external_user_id).toBe(b.external_user_id);
		expect(a.memory_user_id).not.toBe(b.memory_user_id);
	});

	it("an empty or whitespace tenant id falls back to the owner, not to a shared void", async () => {
		const { key, ownerId } = await bearerKey("empties");
		const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
		for (const value of ["", "   "]) {
			const res = await call("/v1/save", { method: "POST", headers, body: JSON.stringify({ content: "Edge case.", user_id: value, _test: canned }) });
			expect(scopeOf(res.body).memory_user_id, JSON.stringify(value)).toBe(ownerId);
		}
	});
});

describe("unknown parameters are refused, not dropped", () => {
	it("rejects a misspelled key and suggests the right one", async () => {
		const { key } = await bearerKey("unknown");
		const res = await call("/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ content: "x", usr_id: "alice" }),
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("unknown_parameter");
		expect(res.body.message).toContain("userId");
	});

	it("names the accepted set when there is no near match", () => {
		const out = validateBody("/v1/save", { content: "x", wibble: 1 });
		expect(out.error).toBe("unknown_parameter");
		expect(out.message).toContain("Accepted:");
	});

	it("refuses two spellings of the same thing rather than guessing", () => {
		const out = validateBody("/v1/save", { content: "x", userId: "a", user_id: "b" });
		expect(out.error).toBe("conflicting_parameters");
	});

	it("canonicalises every documented alias", () => {
		for (const alias of ["user_id", "external_user_id", "externalUserId", "tenant_id", "endUserId"]) {
			const out = validateBody("/v1/recall", { query: "q", [alias]: "alice" });
			expect(out.error, alias).toBeUndefined();
			expect(out.body.userId, alias).toBe("alice");
		}
	});

	it("leaves endpoints without a declared list alone", () => {
		expect(validateBody("/v1/anything-else", { whatever: true }).body).toEqual({ whatever: true });
	});
});

describe("credential mistakes say what is actually wrong", () => {
	it("names a webhook secret for what it is", async () => {
		const res = await call("/v1/recall", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer whsec_0123456789abcdef" },
			body: JSON.stringify({ query: "anything" }),
		});
		expect(res.status).toBe(401);
		expect(res.body.message).toContain("webhook signing secret");
	});

	it("recognises the other shapes people paste", () => {
		expect(credentialShapeHint("whsec_abc")).toContain("webhook signing secret");
		expect(credentialShapeHint("https://itsuki.app/mcp/itsuki_live_x")).toContain("URL");
		expect(credentialShapeHint("sk-proj-abc")).toContain("OpenAI");
		expect(credentialShapeHint("garbage")).toContain("itsuki_live_");
		expect(credentialShapeHint("itsuki_live_real")).toBeNull();
	});
});
