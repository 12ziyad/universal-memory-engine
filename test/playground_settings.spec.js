/**
 * Playground Settings — the tab that would be theatre if these specs failed.
 *
 * The whole point of "custom instructions" is that they change what gets
 * extracted. So each spec here feeds the SAME message with the SAME canned
 * model proposal and asserts the output differs. If a change makes the
 * instruction decorative, one of these goes red.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { instructionDenyTerms, normalizeMemoryRules, rulesAllowText, saveMemoryRules } from "../src/pipeline/rules.js";
import { normalizeThreadSettings, threadRulesFrom, threadSettingsAreEmpty } from "../src/pipeline/playground_settings.js";

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
	const body = await res.json();
	return { user: body.user, cookie: res.headers.get("set-cookie")?.split(";")[0] || "" };
}

// One input, one canned proposal: two durable things, one of them political.
const MESSAGE = "I started boxing training and I follow politics podcasts every night.";
const PROPOSAL = {
	llmResponse: {
		objects: [
			{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
			{ kind: "slice", on: "Boxing", text: "Started boxing training", kind_detail: "progress", confidence: 0.95 },
			{ kind: "node", label: "Politics Podcasts", category: "interest", confidence: 0.9 },
			{ kind: "slice", on: "Politics Podcasts", text: "Follows politics podcasts every night", kind_detail: "other", confidence: 0.9 },
		],
	},
};

async function labelsFor(userId) {
	const { results } = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL")
		.bind(userId).all();
	return (results ?? []).map((r) => r.label);
}

describe("instructions compile to enforcement, not just guidance", () => {
	it("pulls deny terms out of the phrasings people actually write", () => {
		expect(instructionDenyTerms("Never save anything about politics.")).toEqual(["politics"]);
		expect(instructionDenyTerms("Don't store my salary or my address")).toEqual(["salary", "address"]);
		expect(instructionDenyTerms("Do not capture health information")).toEqual(["health information"]);
		// Guidance that is not a deny directive stays guidance.
		expect(instructionDenyTerms("Always keep my thesis progress.")).toEqual([]);
		expect(instructionDenyTerms("")).toEqual([]);
	});

	it("refuses terms so broad they would switch memory off", () => {
		expect(instructionDenyTerms("Never save anything")).toEqual([]);
		expect(instructionDenyTerms("Do not store it")).toEqual([]);
	});

	it("blocks matching text through the same filter as excludes", () => {
		const rules = normalizeMemoryRules({ customInstructions: "Never save anything about politics." });
		expect(rulesAllowText(rules, "Follows politics podcasts every night")).toBe(false);
		expect(rulesAllowText(rules, "Started boxing training")).toBe(true);
	});
});

describe("the same input, extracted differently", () => {
	it("drops what the account's instruction forbids", async () => {
		const plain = await account("cfg-plain");
		const strict = await account("cfg-strict");
		await saveMemoryRules(env, strict.user.id, { customInstructions: "Never save anything about politics." });

		for (const who of [plain, strict]) {
			const res = await request("/v1/playground/chat", post({ message: MESSAGE, _test: PROPOSAL }, who.cookie));
			expect(res.status).toBe(200);
		}

		expect(await labelsFor(plain.user.id)).toEqual(expect.arrayContaining(["Boxing", "Politics Podcasts"]));
		const strictLabels = await labelsFor(strict.user.id);
		expect(strictLabels).toContain("Boxing");
		expect(strictLabels).not.toContain("Politics Podcasts");
	});

	it("applies an instruction scoped to one chat", async () => {
		const me = await account("cfg-thread");

		// Chat A carries the instruction; chat B does not. Same account, same
		// sentence, same proposal — only the thread settings differ.
		const a = await (await request("/v1/playground/thread", post({ title: "guarded" }, me.cookie))).json();
		const applied = await request("/v1/playground/settings", post({
			threadId: a.thread.id,
			settings: { excludeTopics: ["politics"] },
		}, me.cookie, "PUT"));
		expect(applied.status).toBe(200);

		const guarded = await (await request("/v1/playground/chat", post({ message: MESSAGE, threadId: a.thread.id, _test: PROPOSAL }, me.cookie))).json();
		expect(guarded.extraction.items.map((i) => i.text).join(" ")).not.toMatch(/politics/i);
		expect(await labelsFor(me.user.id)).not.toContain("Politics Podcasts");

		const b = await (await request("/v1/playground/thread", post({ title: "open" }, me.cookie))).json();
		await request("/v1/playground/chat", post({ message: MESSAGE, threadId: b.thread.id, _test: PROPOSAL }, me.cookie));
		expect(await labelsFor(me.user.id)).toContain("Politics Podcasts");
	});

	it("says in the receipt why it was dropped", async () => {
		const me = await account("cfg-receipt");
		await saveMemoryRules(env, me.user.id, { customInstructions: "Never save anything about politics." });
		await request("/v1/playground/chat", post({ message: MESSAGE, _test: PROPOSAL }, me.cookie));
		const { results } = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE user_id = ? AND saved_total > 0",
		).bind(me.user.id).all();
		const reasons = (results ?? []).flatMap((r) => Object.keys(JSON.parse(r.detail || "{}").skippedReasons ?? {}));
		expect(reasons).toContain("excluded_by_rule");
	});
});

describe("thread settings are the account's rules, scoped", () => {
	it("normalizes topics with the same rules normalizer", () => {
		const settings = normalizeThreadSettings({
			captureMode: "only_topics",
			includeTopics: ["  thesis decisions  ", "thesis decisions"],
			excludeTopics: ["Politics"],
			customCategories: [{ name: "Study Progress!", description: "units done" }],
		});
		// Same trimming, same de-duplication, same bounds as an account rule.
		expect(settings.includeTopics).toEqual(["thesis decisions"]);
		expect(settings.excludeTopics).toEqual(["Politics"]);
		expect(settings.captureMode).toBe("only_topics");
		expect(settings.customCategories).toEqual([{ name: "study_progress", description: "units done" }]);
	});

	it("refuses an allow-list mode with no topics in it", () => {
		// "Only these topics" with none listed reads as "capture nothing", which
		// nobody means while they are still filling the field in.
		expect(normalizeThreadSettings({ captureMode: "only_topics" }).captureMode).toBe("standard");
		expect(normalizeThreadSettings({ captureMode: "nonsense" }).captureMode).toBe("standard");
	});

	it("narrows the account rather than replacing it", () => {
		const accountRules = normalizeMemoryRules({
			excludes: ["passwords"],
			customCategories: [{ name: "work", description: "job things" }],
		});
		const merged = threadRulesFrom(accountRules, normalizeThreadSettings({
			excludeTopics: ["cats"],
			customCategories: [{ name: "thesis", description: "chapters and deadlines" }],
		}));
		// The chat's own deny list is what it declared...
		expect(merged.excludes).toEqual(["cats"]);
		// ...but the account is its parent, so the account's denies still bite.
		// A chat may only ever narrow; replacing "passwords" would hand back
		// exactly what the account refused.
		expect(merged.parent).toBe(accountRules);
		expect(rulesAllowText(merged, "my passwords are in 1password")).toBe(false);
		expect(rulesAllowText(merged, "I love cats")).toBe(false);
		expect(rulesAllowText(merged, "the thesis uses Postgres")).toBe(true);
		// Categories are classification, not permission, so they union.
		expect(merged.customCategories.map((c) => c.name)).toEqual(["work", "thesis"]);
	});

	it("stays invisible when the thread adds nothing", () => {
		const accountRules = normalizeMemoryRules({ excludes: ["politics"] });
		expect(threadSettingsAreEmpty(normalizeThreadSettings({}))).toBe(true);
		expect(threadRulesFrom(accountRules, normalizeThreadSettings({}))).toBe(null);
		expect(threadRulesFrom(accountRules, null)).toBe(null);
	});

	it("refuses to attach settings to a chat that is not yours", async () => {
		const mine = await account("cfg-mine");
		const theirs = await account("cfg-theirs");
		const thread = await (await request("/v1/playground/thread", post({ title: "mine" }, mine.cookie))).json();
		const res = await request("/v1/playground/settings", post({
			threadId: thread.thread.id,
			settings: { excludeTopics: ["boxing"] },
		}, theirs.cookie, "PUT"));
		expect(res.status).toBe(404);
	});
});

describe("the settings tab", () => {
	it("ships the four controls the tab promises", async () => {
		const { default: html } = await import("../public/index.html?raw");
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function renderPlaygroundSettings(");
		// The free-text box is gone. It stopped being read when policy became
		// structured, so it accepted what people typed and silently dropped it —
		// exactly the kind of control this stage exists to remove.
		const panel = script.slice(
			script.indexOf("function renderPlaygroundSettings("),
			script.indexOf("function pgPolicyMode("),
		);
		expect(panel).not.toContain("Custom instructions");
		expect(panel).not.toContain("pgInstructions");
		// The account-wide rules page keeps its own instructions field; only the
		// per-chat panel drops it, because only the per-chat path stopped reading it.
		expect(script).toContain(">Custom instructions<");
		// What replaced it is the shape the engine actually enforces.
		expect(script).toContain(">Remember only<");
		expect(script).toContain(">Never remember<");
		// The three modes are templated from one list rather than hand-written.
		expect(panel).toContain('["only_topics", "Only these topics"');
		expect(panel).toContain('["off", "Off"');
		expect(panel).toContain("pgPolicyMode('${value}')");
		expect(script).toContain("pgPolicyAdd('includeTopics'");
		expect(script).toContain("pgPolicyAdd('excludeTopics'");
		expect(script).toContain("includeTopics: [...(saved.includeTopics ?? [])]");
		expect(script).toContain(">Custom categories<");
		expect(script).toContain(">Apply to this chat<");
		expect(script).toContain("function playgroundCategoryAdd(");
		expect(script).toContain('api("/v1/playground/settings"');
		// The panel moved out of a column and behind the header's Memory button
		// when the Playground became graph + conversation. It is still reachable,
		// and only reachable on a real chat — a preview has no settings to save.
		expect(script).toContain(`pgTogglePanel('memory')`);
		expect(script).toContain(`id="pgMemoryPanel"`);
		// Reachable in both modes now: in a preview it explains that a policy
		// attaches to a real chat, rather than being a button that does nothing.
		expect(script).toContain('aria-pressed="${PG.panel === "memory"}"');
	});
});

describe("preview extraction writes nothing", () => {
	/**
	 * The preview answers "what would you remember from this?" by running the
	 * model for real. The whole claim rests on it persisting nothing, so this
	 * counts rows rather than trusting the handler to be careful.
	 */
	it("leaves no memory, packet, episode or receipt behind", async () => {
		const me = await account("pg-preview");
		const tables = ["nodes", "slices", "events", "source_packets", "receipts", "playground_messages", "playground_threads"];
		const countAll = async () => {
			const out = {};
			for (const table of tables) {
				const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
					.bind(me.user.id).first();
				out[table] = Number(row?.n ?? 0);
			}
			return out;
		};

		const before = await countAll();
		const res = await request("/v1/playground/preview", post({
			message: "I just moved to Lisbon and started running with a club there.",
		}, me.cookie));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		// Never claims to have stored anything.
		expect(body.persisted ?? false).toBe(false);

		expect(await countAll()).toEqual(before);
	});

	it("refuses what the account's own rules refuse, before the model sees it", async () => {
		const me = await account("pg-preview-rules");
		await saveMemoryRules(env, me.user.id, { excludes: ["politics"] });
		const res = await request("/v1/playground/preview", post({
			message: "I follow politics podcasts every night.",
		}, me.cookie));
		const body = await res.json();
		expect(body.blocked).toBe("excluded_by_rule");
		expect(body.entities).toEqual([]);
		expect(body.facts).toEqual([]);
		expect(body.reply).toBeNull();
	});

	it("needs a session — a bearer key must not spend a model call", async () => {
		const res = await request("/v1/playground/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(res.status).toBe(401);
	});
});
