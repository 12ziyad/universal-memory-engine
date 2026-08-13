/**
 * The Playground, exercised across every policy combination it can be in.
 *
 * The individual pieces are covered elsewhere; what this file asserts is the
 * MATRIX — no rules, account rules, chat rules, both at once, and the four ways
 * a chat can narrow what the account already allows. Each case sends the same
 * sentence with the same canned extraction proposal and asserts on what
 * actually reached the graph, so a change that makes any of these decorative
 * turns one of them red.
 *
 * Every case goes through the real HTTP door with a real session cookie. The
 * model is stubbed via `_test` so the specs never depend on inference being
 * reachable — the FILTERS are what is under test, and a filter that only works
 * when a model cooperates is not a filter.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { saveMemoryRules } from "../src/pipeline/rules.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function post(body, cookie, method = "POST") {
	return {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	};
}

async function account(prefix) {
	const email = `${prefix}-${crypto.randomUUID()}@example.com`;
	const res = await request("/auth/signup", post({ email, password: "correct-horse", name: prefix, acceptTerms: true }));
	expect(res.status).toBe(201);
	const body = await res.json();
	return { user: body.user, cookie: res.headers.get("set-cookie")?.split(";")[0] || "" };
}

// One sentence carrying three separable things: a skill, a salary fact, and a
// pet. Every case below sends exactly this, so the only variable is the policy.
const MESSAGE = "I started boxing on Monday, my salary review is in March, and my cat Mochi turned three.";

const PROPOSAL = {
	llmResponse: {
		objects: [
			{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
			{ kind: "slice", on: "Boxing", text: "Started boxing on Monday", kind_detail: "progress", confidence: 0.95 },
			{ kind: "node", label: "Salary review", category: "work", confidence: 0.9 },
			{ kind: "slice", on: "Salary review", text: "Salary review is in March", kind_detail: "other", confidence: 0.9 },
			{ kind: "node", label: "Mochi", category: "person", confidence: 0.9 },
			{ kind: "slice", on: "Mochi", text: "Cat Mochi turned three", kind_detail: "other", confidence: 0.9 },
		],
	},
};

async function labelsFor(userId) {
	const { results } = await env.DB.prepare(
		"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
	).bind(userId).all();
	return (results ?? []).map((r) => r.label).sort();
}

async function newThread(cookie, title) {
	const res = await (await request("/v1/playground/thread", post({ title }, cookie))).json();
	expect(res.ok).toBe(true);
	return res.thread.id;
}

async function applyPolicy(cookie, threadId, settings) {
	const res = await request("/v1/playground/settings", post({ threadId, settings }, cookie, "PUT"));
	expect(res.status).toBe(200);
	return (await res.json()).settings;
}

async function turn(cookie, threadId, message = MESSAGE) {
	const res = await request("/v1/playground/chat", post({ message, threadId, _test: PROPOSAL }, cookie));
	expect(res.status).toBe(200);
	return res.json();
}

/** One case: fresh account, optional account rules, optional chat policy. */
async function scenario(prefix, { accountRules = null, chatPolicy = null } = {}) {
	const me = await account(prefix);
	if (accountRules) await saveMemoryRules(env, me.user.id, accountRules);
	const threadId = await newThread(me.cookie, prefix);
	if (chatPolicy) await applyPolicy(me.cookie, threadId, chatPolicy);
	const body = await turn(me.cookie, threadId);
	return { me, threadId, body, labels: await labelsFor(me.user.id) };
}

describe("no rules at all", () => {
	it("keeps everything durable in the sentence", async () => {
		const { labels, body } = await scenario("mx-none");
		expect(labels).toEqual(["Boxing", "Mochi", "Salary review"]);
		expect(body.extraction.blocked).toBeNull();
		expect(body.extraction.saved_total).toBeGreaterThan(0);
	});
});

describe("account rules alone", () => {
	it("excludes drop the fact they name and leave the rest", async () => {
		const { labels } = await scenario("mx-acc-ex", { accountRules: { excludes: ["salary"] } });
		expect(labels).toEqual(["Boxing", "Mochi"]);
	});

	it("includes keep only what matches", async () => {
		const { labels } = await scenario("mx-acc-in", { accountRules: { includes: ["boxing"] } });
		expect(labels).toEqual(["Boxing"]);
	});

	it("a never-save instruction is enforced, not merely suggested", async () => {
		const { labels } = await scenario("mx-acc-instr", {
			accountRules: { customInstructions: "Never save anything about salary." },
		});
		expect(labels).toEqual(["Boxing", "Mochi"]);
	});

	it("an only-save instruction is guidance and does NOT switch memory off", async () => {
		// The regression that shipped and had to be reverted: prose compiled into
		// an enforced allow-list refuses everything it does not literally match,
		// which silently ends memory for that account.
		const { labels } = await scenario("mx-acc-only", {
			accountRules: { customInstructions: "Only save what matters." },
		});
		expect(labels).toEqual(["Boxing", "Mochi", "Salary review"]);
	});

	it("excludes beat includes when both name the same thing", async () => {
		const { labels } = await scenario("mx-acc-both", {
			accountRules: { includes: ["salary", "boxing"], excludes: ["salary"] },
		});
		expect(labels).toEqual(["Boxing"]);
	});
});

describe("chat rules alone", () => {
	it("a chat exclude drops that fact from this chat", async () => {
		const { labels } = await scenario("mx-chat-ex", { chatPolicy: { excludeTopics: ["cat", "Mochi"] } });
		expect(labels).toEqual(["Boxing", "Salary review"]);
	});

	it("only-these-topics keeps nothing outside the list", async () => {
		const { labels } = await scenario("mx-chat-only", {
			chatPolicy: { captureMode: "only_topics", includeTopics: ["boxing"] },
		});
		expect(labels).toEqual(["Boxing"]);
	});

	it("capture off writes nothing and says so", async () => {
		const { labels, body } = await scenario("mx-chat-off", { chatPolicy: { captureMode: "off" } });
		expect(labels).toEqual([]);
		expect(body.extraction.blocked).toBe("capture_off");
		expect(body.extraction.items).toEqual([]);
		// The reply still goes out. Losing the conversation helps nobody.
		expect(body.assistant_message.content.length).toBeGreaterThan(0);
	});

	it("an empty policy is invisible — same result as no policy", async () => {
		const { labels } = await scenario("mx-chat-empty", { chatPolicy: {} });
		expect(labels).toEqual(["Boxing", "Mochi", "Salary review"]);
	});
});

describe("a chat may narrow the account, never widen it", () => {
	it("adds its own exclude on top of the account's", async () => {
		const { labels } = await scenario("mx-narrow-add", {
			accountRules: { excludes: ["salary"] },
			chatPolicy: { excludeTopics: ["Mochi", "cat"] },
		});
		expect(labels).toEqual(["Boxing"]);
	});

	it("cannot hand back what the account refused by declaring a shorter list", async () => {
		// The chat's deny list names only "cat". If chat policy REPLACED the
		// account's, "salary" would come back — which is the whole failure mode
		// this composition exists to prevent.
		const { labels } = await scenario("mx-narrow-replace", {
			accountRules: { excludes: ["salary"] },
			chatPolicy: { excludeTopics: ["cat", "Mochi"] },
		});
		expect(labels).not.toContain("Salary review");
	});

	it("cannot widen an account allow-list with its own topics", async () => {
		// Account says only boxing. The chat asks for cats as well. Cats stay out.
		const { labels } = await scenario("mx-narrow-widen", {
			accountRules: { includes: ["boxing"] },
			chatPolicy: { captureMode: "only_topics", includeTopics: ["cat", "Mochi"] },
		});
		expect(labels).not.toContain("Mochi");
		expect(labels).not.toContain("Salary review");
	});

	it("two allow-lists that agree on nothing capture nothing", async () => {
		// Not "whichever list reached the filter wins". Passing the account's
		// list alone kept a boxing fact in a chat that had said only Mochi.
		const { labels, body } = await scenario("mx-narrow-both", {
			accountRules: { includes: ["boxing"] },
			chatPolicy: { captureMode: "only_topics", includeTopics: ["Mochi"] },
		});
		expect(labels).toEqual([]);
		expect(body.extraction.blocked).toBe("outside_include_rules");
	});

	it("two allow-lists that overlap keep only what both allow", async () => {
		const { labels, body } = await scenario("mx-narrow-overlap", {
			accountRules: { includes: ["boxing", "salary"] },
			chatPolicy: { captureMode: "only_topics", includeTopics: ["boxing", "Mochi"] },
		});
		// "boxing" is on both lists. "salary" only the account's, "Mochi" only the
		// chat's — neither survives, because neither is allowed by both.
		expect(labels).toEqual(["Boxing"]);
		expect(body.extraction.blocked).toBeNull();
	});

	it("cannot re-enable capture the account instruction forbids", async () => {
		const { labels } = await scenario("mx-narrow-instr", {
			accountRules: { customInstructions: "Never save anything about salary." },
			chatPolicy: { excludeTopics: ["nothing-relevant"] },
		});
		expect(labels).not.toContain("Salary review");
	});
});

describe("scope: a policy belongs to one chat", () => {
	it("does not leak to another chat on the same account", async () => {
		const me = await account("mx-scope");
		const guarded = await newThread(me.cookie, "guarded");
		const open = await newThread(me.cookie, "open");
		await applyPolicy(me.cookie, guarded, { excludeTopics: ["cat", "Mochi"] });

		await turn(me.cookie, guarded);
		expect(await labelsFor(me.user.id)).not.toContain("Mochi");

		await turn(me.cookie, open, "My cat Mochi turned three.");
		expect(await labelsFor(me.user.id)).toContain("Mochi");
	});

	it("applies to future turns only, and says so rather than rewriting history", async () => {
		const me = await account("mx-future");
		const threadId = await newThread(me.cookie, "later");
		await turn(me.cookie, threadId);
		expect(await labelsFor(me.user.id)).toContain("Salary review");

		await applyPolicy(me.cookie, threadId, { excludeTopics: ["salary"] });
		// The rule governs what comes next; it does not retroactively erase.
		expect(await labelsFor(me.user.id)).toContain("Salary review");

		const second = await turn(me.cookie, threadId, "My salary review moved to April.");
		expect(second.extraction.items.map((i) => i.text).join(" ")).not.toMatch(/salary/i);
	});

	it("cannot be attached to somebody else's chat", async () => {
		const mine = await account("mx-mine");
		const theirs = await account("mx-theirs");
		const threadId = await newThread(mine.cookie, "mine");
		const res = await request("/v1/playground/settings", post({
			threadId, settings: { captureMode: "off" },
		}, theirs.cookie, "PUT"));
		expect(res.status).toBe(404);

		// And it really did not take effect.
		const body = await turn(mine.cookie, threadId);
		expect(body.extraction.blocked).toBeNull();
	});
});

describe("what the panel reports back", () => {
	it("returns the normalized policy, not the raw input", async () => {
		const me = await account("mx-normal");
		const threadId = await newThread(me.cookie, "normalize");
		const settings = await applyPolicy(me.cookie, threadId, {
			captureMode: "only_topics",
			includeTopics: ["  Thesis Decisions  ", "thesis decisions", ""],
			excludeTopics: ["Politics"],
			customCategories: [{ name: "Study Progress!", description: "units done" }],
		});
		expect(settings.includeTopics).toEqual(["Thesis Decisions"]);
		expect(settings.excludeTopics).toEqual(["Politics"]);
		expect(settings.customCategories).toEqual([{ name: "study_progress", description: "units done" }]);
	});

	it("refuses an allow-list with nothing in it instead of capturing nothing", async () => {
		const me = await account("mx-empty-allow");
		const threadId = await newThread(me.cookie, "empty allow");
		const settings = await applyPolicy(me.cookie, threadId, { captureMode: "only_topics", includeTopics: [] });
		expect(settings.captureMode).toBe("standard");

		const body = await turn(me.cookie, threadId);
		expect(body.extraction.blocked).toBeNull();
		expect(await labelsFor(me.user.id)).toEqual(["Boxing", "Mochi", "Salary review"]);
	});

	it("survives a reload — the policy is stored, not held in the page", async () => {
		const me = await account("mx-reload");
		const threadId = await newThread(me.cookie, "reload");
		await applyPolicy(me.cookie, threadId, { captureMode: "only_topics", includeTopics: ["boxing"] });

		const reloaded = await (await request(`/v1/playground?thread=${threadId}`, { headers: { cookie: me.cookie } })).json();
		expect(reloaded.thread.settings.captureMode).toBe("only_topics");
		expect(reloaded.thread.settings.includeTopics).toEqual(["boxing"]);
	});
});

describe("deleting a chat", () => {
	it("removes the conversation and leaves the memories it captured", async () => {
		// Exactly what the confirm dialog claims. If this ever changes, the copy
		// has to change with it.
		const me = await account("mx-del");
		const threadId = await newThread(me.cookie, "throwaway");
		await turn(me.cookie, threadId);
		expect(await labelsFor(me.user.id)).toContain("Boxing");

		await request("/v1/playground/thread", post({ threadId, delete: true }, me.cookie));

		const after = await (await request("/v1/playground", { headers: { cookie: me.cookie } })).json();
		expect(after.threads.map((t) => t.id)).not.toContain(threadId);
		expect(await labelsFor(me.user.id)).toContain("Boxing");
	});
});
