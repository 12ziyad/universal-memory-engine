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
	it("is two columns: the graph and the conversation", async () => {
		const { script, html } = await page();
		expect(script).toContain("function viewPlayground(");
		expect(script).toContain('class="pg-col pg-graph"');
		expect(script).toContain('class="pg-col pg-chat"');
		expect(html).toContain(".pg-shell { display: grid; grid-template-columns: minmax(0, 1fr) 468px;");
		// Below 1180px the graph stops being readable beside a fixed chat column.
		expect(html).toContain("@media (max-width: 1180px)");
		expect(html).toContain(".pg-shell { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 0; }");
	});

	/**
	 * The load-bearing promise of the examples: they are a read-only world. If
	 * either preview send path ever reaches the network, a "preview" would be
	 * writing to somebody's real memory.
	 */
	it("never writes to memory from a preview", async () => {
		const { script } = await page();
		expect(script).toContain('mode: "preview"');
		for (const fn of ["pgSendScripted", "pgPickExample", "pgRestart"]) {
			const body = script.slice(script.indexOf(`function ${fn}(`));
			const source = body.slice(0, body.indexOf("\n}\n") + 2);
			expect(source, `${fn} must not call the API`).not.toContain("api(");
		}
		// A typed sentence DOES reach the server — it asks the engine what it
		// would remember. That endpoint persists nothing; what a preview must
		// never touch is the door that writes.
		const typed = script.slice(script.indexOf("async function pgSendTyped("));
		const typedBody = typed.slice(0, typed.indexOf("\n}\n") + 2);
		expect(typedBody).toContain('api("/v1/playground/preview"');
		for (const writeDoor of ["/v1/playground/chat", "/v1/save", "/v1/ingest", "/v1/playground/thread"]) {
			expect(typedBody, `a preview must never call ${writeDoor}`).not.toContain(writeDoor);
		}
		// And the person is told, in the panel, before they type anything.
		expect(script).toContain("Nothing here is saved to your account.");
	});

	it("offers five examples, each with its own graph and prompts", async () => {
		const { script } = await page();
		expect(script).toContain("const PG_SCENARIOS = [");
		const block = script.slice(script.indexOf("const PG_SCENARIOS = ["), script.indexOf("\nfunction viewPlayground("));
		const ids = [...block.matchAll(/\n\t\tid: "([a-z]+)", name: "/g)].map((m) => m[1]);
		expect(ids).toEqual(["thesis", "platform", "training", "travel", "support"]);
		// Every scenario needs a hub, follow-up prompts, and facts to show.
		expect(block.match(/hub: true/g)?.length).toBe(5);
		expect(block.match(/\n\t\t\t\tp: "/g)?.length).toBe(15);
		// Nodes are tagged with real cluster ids, so a preview is drawn in the
		// same vocabulary as the Graph view rather than a palette of its own.
		const fallback = script.slice(script.indexOf("const CLUSTER_FALLBACK = {"), script.indexOf("\nfunction clusterInfo("));
		const known = [...fallback.matchAll(/\n\t([a-z_]+): \{ label:/g)].map((m) => m[1]);
		expect(known.length).toBeGreaterThan(8);
		const clusters = new Set([...block.matchAll(/c: "([a-z_]+)"/g)].map((m) => m[1]));
		for (const id of clusters) expect(known, `unknown cluster ${id}`).toContain(id);
		expect(clusters.size).toBeGreaterThanOrEqual(8);
		expect(script).toContain("function renderPgSuggest(");
		expect(script).toContain("onclick=\"pgSendScripted(");
	});

	/**
	 * The scenarios carry ~150 hand-written relations naming nodes by string. A
	 * typo in one silently drops an edge and nothing else complains, so the data
	 * is parsed and checked rather than pattern-matched.
	 */
	it("wires every relation to a node that exists", async () => {
		const { script } = await page();
		const start = script.indexOf("const PG_SCENARIOS = [");
		const literal = script.slice(script.indexOf("[", start), script.indexOf("\n];", start) + 2);
		const scenarios = new Function(`return ${literal}`)();
		expect(scenarios).toHaveLength(5);
		for (const sc of scenarios) {
			const names = new Set([...sc.seed, ...sc.turns.flatMap((t) => t.add ?? [])].map((n) => n.n));
			expect(names.size, `${sc.id} has duplicate node names`)
				.toBe([...sc.seed, ...sc.turns.flatMap((t) => t.add ?? [])].length);
			const links = [...(sc.links ?? []), ...sc.turns.flatMap((t) => t.links ?? [])];
			for (const [from, to] of links) {
				expect(names, `${sc.id}: link from unknown node "${from}"`).toContain(from);
				expect(names, `${sc.id}: link to unknown node "${to}"`).toContain(to);
				expect(from, `${sc.id}: link points at itself`).not.toBe(to);
			}
			// Containment parents must exist too, or the node silently reparents
			// onto its cluster anchor and the tree it belonged to disappears.
			for (const n of [...sc.seed, ...sc.turns.flatMap((t) => t.add ?? [])]) {
				if (n.of) expect(names, `${sc.id}: "${n.n}" has unknown parent "${n.of}"`).toContain(n.of);
				expect(typeof n.c, `${sc.id}: "${n.n}" has no cluster`).toBe("string");
			}
			expect(sc.seed.filter((n) => n.hub)).toHaveLength(1);
			expect(links.length, `${sc.id} is too sparse to read as a graph`).toBeGreaterThanOrEqual(20);
		}
	});

	it("builds clusters of uneven density, the way a real memory is", async () => {
		const { script } = await page();
		const start = script.indexOf("const PG_SCENARIOS = [");
		const literal = script.slice(script.indexOf("[", start), script.indexOf("\n];", start) + 2);
		for (const sc of new Function(`return ${literal}`)()) {
			const nodes = [...sc.seed, ...sc.turns.flatMap((t) => t.add ?? [])];
			expect(nodes.length, `${sc.id} node count`).toBeGreaterThanOrEqual(30);
			const sizes = [...nodes.reduce((m, n) => m.set(n.c, (m.get(n.c) ?? 0) + 1), new Map()).values()];
			expect(sizes.length, `${sc.id} cluster count`).toBeGreaterThanOrEqual(5);
			// A graph of equal-sized clusters looks generated. A real memory has a
			// subject that fills a cluster and a corner that holds three things.
			expect(Math.max(...sizes), `${sc.id} needs one dense cluster`).toBeGreaterThanOrEqual(10);
			expect(Math.min(...sizes), `${sc.id} needs one sparse cluster`).toBeLessThanOrEqual(5);
			expect(Math.max(...sizes) / Math.min(...sizes), `${sc.id} density spread`).toBeGreaterThanOrEqual(2.5);
		}
	});

	it("can be zoomed by wheel and by pinch, anchored where the gesture is", async () => {
		const { script } = await page();
		expect(script).toContain("function pgZoomAt(");
		expect(script).toContain("function pgWheel(");
		expect(script).toContain("const PG_ZOOM_MIN = 0.5, PG_ZOOM_MAX = 6;");
		// Two pointers pinch, one pans.
		expect(script).toContain("if (PG.pointers.size === 2) {");
		expect(script).toContain("PG.pinch.k * (dist / PG.pinch.dist)");
		// preserveAspectRatio letterboxes the viewBox; zoom-to-cursor has to undo
		// that offset or it drifts away from the pointer.
		expect(script).toContain("function pgToUser(");
		expect(script).toContain("(rect.width - PG_VIEW_W * scale) / 2");
		// Capture throws for a pointer the element does not own, and must never
		// abort the handler that clears drag state.
		expect(script).toContain("function pgCapture(");
		expect(script).toMatch(/try \{ release \? svg\.releasePointerCapture[\s\S]{0,80}catch \{\}/);
	});

	it("shows the capture status and the context that produced the reply", async () => {
		const { script } = await page();
		expect(script).toContain("${PG.threads.length} of ${PG.limits.maxThreads ?? 5} used");
		expect(script).toContain("messages left today");
		expect(script).toContain('class="pg-capture"');
		expect(script).toContain("<b>Written to memory</b>");
		// Acceptance is durable before enrichment finishes: say both, not neither.
		expect(script).toContain("Captured · extracting");
		expect(script).toContain("Assistant turns are not captured");
		expect(script).toContain("function pgContextBlock(");
		// A fact that stopped being true keeps its end date instead of vanishing.
		expect(script).toContain('<span class="live">present</span>');
	});

	/**
	 * The context block did not collapse itself — the stream scrolled it out of
	 * view. Every render jumped to the bottom, so a block somebody had opened
	 * and was reading vanished the moment the next turn landed, which is
	 * indistinguishable from it having closed.
	 */
	it("does not scroll a reader away from an open context block", async () => {
		const { script, html } = await page();
		expect(script).toContain("const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;");
		expect(script).toContain("box.scrollTop = wasAtBottom ? box.scrollHeight : keptTop;");
		// And it must not be a scrollable panel inside a scrollable stream.
		expect(html).not.toMatch(/\.pg-ctx-body \{[^}]*overflow-y: auto/);
		// Opening one brings it into view rather than fighting the scroll.
		expect(script).toContain('blocks[index]?.scrollIntoView({ block: "nearest"');
	});

	it("can be zoomed by pointer and by keyboard alone", async () => {
		const { script, html } = await page();
		// The transform has to be APPLIED, not only written as a variable — it
		// was not, so every zoom moved the number and nothing on screen.
		expect(html).toContain(".pg-world { transform: var(--vt, none);");
		expect(script).toContain("function pgZoomInAt(");
		expect(script).toContain("function pgGraphKeys(");
		expect(script).toContain('ArrowLeft: () => { PG.view.x += step; pgApplyView(); }');
		expect(script).toContain('ondblclick="pgZoomInAt(event)"');
		// Relation labels ride the edges and appear once there is room to read them.
		expect(html).toContain(".pg-canvas.is-close .pgn-rel { opacity: .9; }");
		expect(script).toContain('classList.toggle("is-close", PG.view.k >= 1.6)');
	});

	it("animates arrival without moving what was already there", async () => {
		const { script, html } = await page();
		// Positions are computed for every node the scenario will ever show, so a
		// new memory lands in reserved space rather than re-shuffling the graph.
		expect(script).toContain("function pgLayoutFor(");
		expect(script).toContain("PG_LAYOUT.set(sc.id, pos)");
		expect(html).toContain("@keyframes pgNodePop");
		expect(html).toContain("@keyframes pgHalo");
		expect(html).toContain("@keyframes pgWorldSettle");
		expect(html).toContain("@media (prefers-reduced-motion: reduce)");
	});

	it("runs the tour on the first three visits and on request after that", async () => {
		const { script } = await page();
		expect(script).toContain("const PG_TOUR = [");
		const tour = script.slice(script.indexOf("const PG_TOUR = ["), script.indexOf("\nfunction pgTourVisits("));
		expect(tour.match(/\n\t\ttitle: "/g)?.length).toBe(5);
		expect(script).toContain("if (pgTourVisits() >= 3 || PG.mode !== \"preview\") return;");
		expect(script).toContain('onclick="pgTourStart(true)"');
		// rAF never fires in a background tab, so the spotlight is placed inline.
		expect(script).toContain("pgTourPosition();\n\troot.querySelector");
		expect(script).toContain("function pgTourKeys(");
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
