/**
 * The Playground door.
 *
 * What matters here is that it IS a door: a turn recalls and captures through
 * the same commands every other client uses, so what it writes is what a
 * connected Claude would have written. Plus the two limits — a per-user daily
 * message cap and a thread cap — which are the difference between a demo and a
 * free LLM for anyone who signs up.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";
import { chatModel, playgroundLimits } from "../src/pipeline/playground.js";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function post(body, cookie) {
	return {
		method: "POST",
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

/** A canned proposal so the specs never depend on a model being reachable. */
function kotlinProposal() {
	return {
		llmResponse: {
			objects: [
				{ kind: "node", label: "Kotlin", category: "skill", confidence: 0.95 },
				{ kind: "event", on: "Kotlin", action: "started", text: "Started learning Kotlin", importance: "ordinary", confidence: 0.95 },
				{ kind: "slice", on: "Kotlin", text: "Learning Kotlin for Android work", kind_detail: "progress", confidence: 0.9 },
			],
		},
	};
}

async function page() {
	const { default: html } = await import("../public/index.html?raw");
	return { html, script: html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "" };
}

async function send(cookie, message, extra = {}) {
	const res = await request("/v1/playground/chat", post({ message, _test: kotlinProposal(), ...extra }, cookie));
	expect(res.status).toBe(200);
	return res.json();
}

describe("playground config", () => {
	it("uses the smallest instruct model, and never the extraction one", () => {
		// The reply is scenery; the capture is the product. Small is correct here,
		// and it must stay a different model from LLM_MODEL — swapping that one
		// would quietly change what gets captured.
		expect(chatModel({})).toBe("@cf/meta/llama-3.2-1b-instruct");
		expect(chatModel({})).not.toBe(env.LLM_MODEL);
		expect(chatModel({ CHAT_MODEL: "@cf/x/y" })).toBe("@cf/x/y");
	});

	it("reads both caps from env with safe defaults", () => {
		expect(playgroundLimits({})).toEqual({ maxThreads: 5, dailyMessages: 30 });
		expect(playgroundLimits({ PLAYGROUND_MAX_THREADS: "2", PLAYGROUND_DAILY_MESSAGES: "3" }))
			.toEqual({ maxThreads: 2, dailyMessages: 3 });
		expect(playgroundLimits({ PLAYGROUND_DAILY_MESSAGES: "nonsense" }).dailyMessages).toBe(30);
	});
});

describe("session auth only", () => {
	it("refuses an API key and an MCP token", async () => {
		const owner = await account("pg-auth");
		const key = await request("/auth/tokens", post({ type: "api", label: "k" }, owner.cookie));
		const token = (await key.json()).token;

		const bearer = await request("/v1/playground/chat", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(bearer.status).toBe(401);

		const legacy = await request("/v1/playground/chat", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
			body: JSON.stringify({ message: "hello", userId: owner.user.id }),
		});
		expect(legacy.status).toBe(401);

		const anon = await request("/v1/playground");
		expect(anon.status).toBe(401);
	});
});

describe("a turn", () => {
	it("captures through the real pipeline and reports what it wrote", async () => {
		const me = await account("pg-turn");
		const body = await send(me.cookie, "I started learning Kotlin this week for Android work.");

		expect(body.ok).toBe(true);
		expect(body.thread_id).toBeTruthy();
		expect(body.assistant_message.role).toBe("assistant");
		expect(body.assistant_message.content.length).toBeGreaterThan(0);

		// The memory itself landed in the graph, not in a playground-only table.
		const { results: nodes } = await env.DB.prepare(
			"SELECT label FROM nodes WHERE user_id = ?",
		).bind(me.user.id).all();
		expect(nodes.map((n) => n.label)).toContain("Kotlin");

		// And the panel gets the sentences that were actually written.
		const texts = body.extraction.items.map((i) => i.text);
		expect(texts).toContain("Learning Kotlin for Android work");
		expect(body.extraction.saved_total).toBeGreaterThan(0);
		expect(body.extraction.receipt_id).toBeTruthy();
	});

	it("leaves a receipt like every other door", async () => {
		const me = await account("pg-receipt");
		await send(me.cookie, "I started learning Kotlin this week for Android work.");
		const { results } = await env.DB.prepare(
			"SELECT source, saved_total FROM receipts WHERE user_id = ?",
		).bind(me.user.id).all();
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results.some((r) => Number(r.saved_total) > 0)).toBe(true);
	});

	it("keeps the conversation and its captures on reload", async () => {
		const me = await account("pg-reload");
		const turn = await send(me.cookie, "I started learning Kotlin this week for Android work.");
		const res = await request("/v1/playground", { headers: { cookie: me.cookie } });
		const body = await res.json();
		expect(body.thread.id).toBe(turn.thread_id);
		expect(body.thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(body.thread.messages[0].extraction.items.length).toBeGreaterThan(0);
		expect(body.limits.usedToday).toBe(1);
		expect(body.limits.maxThreads).toBeGreaterThan(0);
	});

	// Found by running against the live model instead of a stub: real
	// extraction took 30s+, blew the turn's 9s wait budget, and the panel sat
	// on "Capturing..." forever because nothing ever went back for the receipt.
	it("folds a late receipt into the message it came from", async () => {
		const me = await account("pg-late");
		const turn = await send(me.cookie, "I started learning Kotlin this week for Android work.");
		const packetId = turn.user_message.extraction.source_packet_id;
		expect(packetId).toBeTruthy();

		// Rewind this message to the state a turn that timed out would leave.
		await env.DB.prepare("UPDATE playground_messages SET extraction_json = ? WHERE id = ?")
			.bind(JSON.stringify({ items: [], processing: true, source_packet_id: packetId, saved_total: 0 }), turn.user_message.id)
			.run();

		const body = await (await request("/v1/playground", { headers: { cookie: me.cookie } })).json();
		const message = body.thread.messages.find((m) => m.id === turn.user_message.id);
		expect(message.extraction.processing).toBe(false);
		expect(message.extraction.items.map((i) => i.text)).toContain("Learning Kotlin for Android work");
		expect(message.extraction.receipt_id).toBeTruthy();

		// And it stays folded — the reconcile is written back, not recomputed.
		const stored = await env.DB.prepare("SELECT extraction_json FROM playground_messages WHERE id = ?")
			.bind(turn.user_message.id).first();
		expect(JSON.parse(stored.extraction_json).processing).toBe(false);
	});

	it("refuses an empty message without an error page", async () => {
		const me = await account("pg-empty");
		const res = await request("/v1/playground/chat", post({ message: "   " }, me.cookie));
		expect(res.status).toBe(200);
		expect((await res.json()).message).toBe("Type something to send.");
	});
});

describe("limits", () => {
	it("caps daily messages with a friendly sentence, not an error", async () => {
		const me = await account("pg-daily");
		const capped = { ...env, PLAYGROUND_DAILY_MESSAGES: "1" };
		const first = await (async () => {
			const req = new Request("http://example.com/v1/playground/chat", post({ message: "I started learning Kotlin this week.", _test: kotlinProposal() }, me.cookie));
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, capped, ctx);
			await waitOnExecutionContext(ctx);
			return res.json();
		})();
		expect(first.ok).toBe(true);

		const req = new Request("http://example.com/v1/playground/chat", post({ message: "And I moved to Dubai." }, me.cookie));
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, capped, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.capped).toBe("daily");
		expect(body.message).toContain("reset at midnight UTC");
		// Nothing was spent: the second message never reached the model or the DB.
		const { results } = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM playground_messages WHERE user_id = ? AND role = 'user'",
		).bind(me.user.id).all();
		expect(Number(results[0].n)).toBe(1);
	});

	it("caps how many chats one account keeps", async () => {
		const me = await account("pg-threads");
		const capped = { ...env, PLAYGROUND_MAX_THREADS: "1" };
		const make = async () => {
			const req = new Request("http://example.com/v1/playground/thread", post({ title: "New chat" }, me.cookie));
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, capped, ctx);
			await waitOnExecutionContext(ctx);
			return res.json();
		};
		expect((await make()).ok).toBe(true);
		const second = await make();
		expect(second.ok).toBe(false);
		expect(second.capped).toBe("threads");
		expect(second.message).toContain("Delete one to start another.");
	});

	it("deletes a chat and its messages together", async () => {
		const me = await account("pg-delete");
		const turn = await send(me.cookie, "I started learning Kotlin this week for Android work.");
		await request("/v1/playground/thread", post({ threadId: turn.thread_id, delete: true }, me.cookie));
		const { results } = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM playground_messages WHERE thread_id = ?",
		).bind(turn.thread_id).all();
		expect(Number(results[0].n)).toBe(0);
	});

	it("keeps one account's chats invisible to another", async () => {
		const mine = await account("pg-mine");
		const theirs = await account("pg-theirs");
		const turn = await send(mine.cookie, "I started learning Kotlin this week for Android work.");
		const res = await request(`/v1/playground?thread=${turn.thread_id}`, { headers: { cookie: theirs.cookie } });
		const body = await res.json();
		expect(body.threads).toEqual([]);
		expect(body.thread).toBe(null);
	});
});

describe("the playground screen", () => {
	// The shipped page is one file with no build step, so the shell is asserted
	// here rather than in a component test that does not exist.
	it("is three columns: chats, conversation, memories", async () => {
		const { script, html } = await page();
		expect(script).toContain("function viewPlayground(");
		expect(script).toContain('class="pg-col pg-chats"');
		expect(script).toContain('class="pg-col pg-conversation"');
		expect(script).toContain('class="pg-col pg-memories"');
		expect(html).toContain(".pg-shell { display: grid; grid-template-columns: 236px minmax(0, 1fr) 320px;");
	});

	it("has two states, and they switch on whether the thread has messages", async () => {
		const { script, html } = await page();
		expect(script).toContain("const empty = !PG.messages.length;");
		expect(script).toContain("const bare = empty && !PG.threads.length");
		expect(script).toContain('${empty ? " is-empty" : ""}${bare ? " is-bare" : ""}');
		// Empty: a greeting and the composer, centred, and nothing else.
		expect(script).toContain('class="pg-greeting"');
		expect(html).toContain(".pg-shell.is-empty .pg-conversation { justify-content: center; }");
		expect(html).toContain(".pg-shell.is-bare .pg-chats, .pg-shell.is-bare .pg-memories { display: none; }");
		// No header block on this view at all, and no example prompts.
		expect(script).not.toMatch(/viewPlayground[\s\S]{0,400}class="page-head"/);
		expect(script).not.toContain("Say something you'd want an AI to remember next week");
		expect(script).toContain("// Empty means empty: the greeting and the composer are the whole screen.");
	});

	it("shows the chat cap on the New chat button and the extraction inline", async () => {
		const { script } = await page();
		expect(script).toContain("${PG.threads.length} of ${PG.limits.maxThreads ?? 5} chats");
		expect(script).toContain("messages left today");
		expect(script).toContain('class="pg-capture"');
		expect(script).toContain("<b>Added to memory</b>");
		expect(script).toContain('class="pg-added">Added<');
	});

	it("talks to the playground routes and nothing else", async () => {
		const { script } = await page();
		expect(script).toContain('api("/v1/playground/chat"');
		expect(script).toContain('api("/v1/playground/thread"');
		expect(script).toContain("`/v1/playground${threadId ? `?thread=");
		// The old two-button test harness is gone.
		expect(script).not.toContain("function playgroundAdd(");
		expect(script).not.toContain("function playgroundSearch(");
	});
});
