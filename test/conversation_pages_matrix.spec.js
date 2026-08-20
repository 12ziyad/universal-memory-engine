/**
 * Conversation Pages — the behavior matrix around the explicit-door identity
 * contract (Campaign A). Deterministic canned responses everywhere.
 *
 *   1. AUTOMATIC capture (/v1/turn, /v1/ingest, /v1/save mode:"memory") never
 *      creates a Conversation Page — pages belong to the explicit doors only.
 *   2. A concurrent same-conversation storm converges to ONE page: no forks,
 *      one source link per accepted batch, replays answer duplicate against
 *      the same page.
 *   3. The same conversationId in personal scope and a project scope makes
 *      TWO pages that advance independently — no cross-scope advance.
 *   4. A page at CONVERSATION_ADVANCE_LIMIT linked batches stops advancing:
 *      memories still save, the receipt names the skip, the page is untouched.
 *   5. A deleted Conversation Page never silently re-materializes: identity
 *      suppression keeps the re-save pageless, and the receipt says so.
 *   6. appendAdvanceSection is bounded and truthful: newest section survives,
 *      oldest trim first behind an exact marker, headless overflow clamps.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { stageMcpConversation } from "../src/pipeline/mcp_engine.js";
import {
	appendAdvanceSection,
	advanceHeading,
	CONVERSATION_ADVANCE_LIMIT,
} from "../src/pipeline/conversation_pages.js";
import { deleteObject } from "../src/pipeline/cleanup.js";
import worker from "../src/index.js";

const T0 = Date.parse("2026-08-02T09:00:00Z");

/** A full canned engine response set for one entity + one fact. */
function cannedFor(label, category, sliceText, title) {
	return {
		llmResponse: {
			objects: [
				{ kind: "node", label, category, confidence: 0.9 },
				{ kind: "slice", on: label, text: sliceText, kind_detail: "other", confidence: 0.9 },
			],
			notes: "",
		},
		edgeResponse: { edges: [] },
		reflexionResponse: { entities: [], facts: [], edges: [] },
		titleResponse: { title },
	};
}

async function stage(userId, messages, input = {}, canned = {}) {
	const ctx = createExecutionContext();
	const res = await stageMcpConversation(env, ctx, userId, {
		...input,
		messages,
		testOverrides: { ...canned },
	});
	await waitOnExecutionContext(ctx);
	return res;
}

async function drainUntilSettled(userId, maxRounds = 30, { reset = true } = {}) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < maxRounds; i++) {
		const res = await stub.drainMcpJobs(userId);
		if (res.remaining === 0 && !res.busySkip) {
			if (reset) await stub.resetAll();
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("conversation jobs did not settle");
}

async function livePages(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

async function allPages(userId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM memory_pages WHERE user_id = ? ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

async function pageSources(userId, pageId) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM conversation_page_sources WHERE user_id = ? AND page_id = ? ORDER BY seq, created_at",
	).bind(userId, pageId).all();
	return results ?? [];
}

async function countRows(sql, ...bindings) {
	const row = await env.DB.prepare(sql).bind(...bindings).first();
	return Number(row?.n ?? 0);
}

async function nodeCount(userId, label) {
	return countRows(
		"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND label = ? AND deleted_at IS NULL",
		userId,
		label,
	);
}

async function post(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------

describe("matrix 1 — automatic capture creates zero Conversation Pages", () => {
	const TURN_FACTS = [
		"I moved my pottery studio to Rua do Sol in March.",
		"My daughter Ines started at Colegio Verde this term.",
		"I switched my phone plan over to MEO Fibra.",
		"My physiotherapist is Joana Brito at Clinica Foz.",
		"I planted a fig tree in the back garden last weekend.",
		"My car is now serviced at Oficina Central in Benfica.",
		"I joined the Tuesday evening padel league at Padel Rio.",
		"My mother moved into the apartment on Rua das Amoreiras.",
		"I take Portuguese classes with Professor Camara now.",
		"My favourite bakery these days is Pao do Bairro.",
		"I finally sold the old scooter to my neighbour Duarte.",
		"My new standing desk arrived from Loja Norte yesterday.",
	];
	const TURN_CANNED = cannedFor(
		"Rua do Sol",
		"place",
		"Moved the pottery studio to Rua do Sol",
		"Pottery Studio On Rua Do Sol",
	);

	it("12 /v1/turn calls + /v1/ingest + /v1/save mode:memory build memories, never pages", async () => {
		const userId = `auto-nopage-${crypto.randomUUID()}`;

		for (let i = 0; i < TURN_FACTS.length; i++) {
			const res = await post("/v1/turn", {
				userId,
				conversationId: "auto-conv-1",
				messages: [
					{ id: `t${i}a`, role: "user", content: TURN_FACTS[i], ts: T0 + i * 60_000 },
					{ id: `t${i}b`, role: "assistant", content: "Noted!", ts: T0 + i * 60_000 + 1000 },
				],
				_test: TURN_CANNED,
			});
			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
		}

		const ingested = await post("/v1/ingest", {
			userId,
			flush: true,
			conversationId: "auto-conv-2",
			messages: [
				{ id: "g1", role: "user", content: "My dentist is Dr. Alma Ferreira at Sorriso Clinic.", ts: T0 },
			],
			_test: cannedFor(
				"Sorriso Clinic",
				"organization",
				"Dentist Dr. Alma Ferreira works at Sorriso Clinic",
				"Dentist At Sorriso Clinic",
			),
		});
		expect(ingested.status).toBe(200);

		const saved = await post("/v1/save", {
			userId,
			mode: "memory",
			conversationId: "auto-conv-3",
			content: "I keep my sailboat at the Doca de Alcantara marina.",
			_test: {
				waitBudgetMs: 1,
				...cannedFor(
					"Doca de Alcantara",
					"place",
					"Keeps the sailboat at Doca de Alcantara",
					"Sailboat At Doca De Alcantara",
				),
			},
		});
		expect(saved.status).toBe(200);

		await drainUntilSettled(userId);

		// The whole point: not one memory_pages row exists — live OR dead.
		expect(await countRows("SELECT COUNT(*) AS n FROM memory_pages WHERE user_id = ?", userId)).toBe(0);
		expect(await countRows(
			"SELECT COUNT(*) AS n FROM conversation_page_sources WHERE user_id = ?", userId,
		)).toBe(0);

		// While the memories themselves are real: graph nodes and/or staged text.
		const nodes = await countRows(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL", userId,
		);
		const staged = await countRows(
			"SELECT COUNT(*) AS n FROM staged_memories WHERE user_id = ?", userId,
		);
		expect(nodes + staged).toBeGreaterThan(0);
		expect(nodes).toBeGreaterThan(0);
	}, 120_000);
});

// ---------------------------------------------------------------------------

describe("matrix 2 — concurrent same-conversation storm", () => {
	const KEY = "conv-storm-1";
	const BATCHES = [
		{
			messages: [
				{ id: "a1", role: "user", content: "I bought a touring bike from Vela Cycles in Braga.", ts: T0 },
				{ id: "a2", role: "assistant", content: "Nice ride!", ts: T0 + 60_000 },
			],
			canned: cannedFor("Vela Cycles", "organization", "Bought a touring bike from Vela Cycles", "Touring Bike From Vela Cycles"),
			label: "Vela Cycles",
		},
		{
			messages: [
				{ id: "b1", role: "user", content: "My poetry chapbook was accepted by Mirador Press.", ts: T0 + 120_000 },
				{ id: "b2", role: "assistant", content: "Congratulations!", ts: T0 + 180_000 },
			],
			canned: cannedFor("Mirador Press", "organization", "Poetry chapbook accepted by Mirador Press", "Chapbook Accepted By Mirador Press"),
			label: "Mirador Press",
		},
		{
			messages: [
				{ id: "c1", role: "user", content: "My brother Tomas started working at Okonomi Bar.", ts: T0 + 240_000 },
				{ id: "c2", role: "assistant", content: "Sounds fun.", ts: T0 + 300_000 },
			],
			canned: cannedFor("Okonomi Bar", "organization", "Brother Tomas works at Okonomi Bar", "Tomas Works At Okonomi Bar"),
			label: "Okonomi Bar",
		},
	];

	it("three concurrent batches converge to ONE page with one link per accepted batch, and a replay stays a duplicate", async () => {
		const userId = `conv-storm-${crypto.randomUUID()}`;

		const results = await Promise.all(
			BATCHES.map((batch) => stage(userId, batch.messages, { conversationId: KEY }, batch.canned)),
		);
		for (const res of results) {
			expect(res.ok).toBe(true);
			expect(res.fired).toBe(true);
		}
		// Every accepted batch already references the SAME page — convergence
		// happened at staging time, not as a cleanup afterthought.
		expect(new Set(results.map((r) => r.page_id)).size).toBe(1);

		await drainUntilSettled(userId, 30, { reset: false });

		// Exactly one live page — and no forked rows hiding behind deleted_at.
		const pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		expect(await allPages(userId)).toHaveLength(1);
		const page = pages[0];
		expect(page.id).toBe(results[0].page_id);
		expect(page.conversation_key).toBe(KEY);
		expect(page.enrich_status).toBe("enriched");

		// One conversation_page_sources row per ACCEPTED batch, distinct packets.
		const links = await pageSources(userId, page.id);
		expect(links).toHaveLength(BATCHES.length);
		expect(new Set(links.map((l) => l.source_packet_id)).size).toBe(BATCHES.length);

		// Every accepted batch's memories exist in the graph.
		for (const batch of BATCHES) {
			expect(await nodeCount(userId, batch.label)).toBeGreaterThan(0);
		}

		// Exact replay of one batch → duplicate, same page, nothing grows.
		const replay = await stage(userId, BATCHES[0].messages, { conversationId: KEY }, BATCHES[0].canned);
		expect(replay.duplicate).toBe(true);
		expect(replay.fired).toBe(false);
		expect(replay.page_id).toBe(page.id);

		await drainUntilSettled(userId);
		expect(await livePages(userId)).toHaveLength(1);
		expect(await pageSources(userId, page.id)).toHaveLength(BATCHES.length);
	}, 120_000);
});

// ---------------------------------------------------------------------------

describe("matrix 3 — project isolation", () => {
	const KEY = "conv-iso-1";
	const PROJECT = "proj-iso";

	const personalBatch = () => [
		{ id: "p1", role: "user", content: "I volunteer at the Casa do Rio shelter on Saturdays.", ts: T0 },
		{ id: "p2", role: "assistant", content: "That is generous of you.", ts: T0 + 60_000 },
	];
	const projectBatch = () => [
		{ id: "q1", role: "user", content: "I lead the Atlas Redesign project at work.", ts: T0 },
		{ id: "q2", role: "assistant", content: "Good luck with it!", ts: T0 + 60_000 },
	];
	const projectGrown = () => [
		...projectBatch(),
		{ id: "q3", role: "user", content: "We hired Marta Costa as the Atlas Redesign designer.", ts: T0 + 120_000 },
	];

	const CANNED_PERSONAL = cannedFor("Casa do Rio", "organization", "Volunteers at Casa do Rio on Saturdays", "Volunteering At Casa Do Rio");
	const CANNED_PROJECT = cannedFor("Atlas Redesign", "organization", "Leads the Atlas Redesign project", "Leading The Atlas Redesign");
	const CANNED_PROJECT_GROWN = cannedFor("Marta Costa", "person", "Marta Costa hired as Atlas Redesign designer", "Marta Costa Joins Atlas Redesign");

	it("the same conversationId makes two pages — one per scope — that advance independently", async () => {
		const userId = `conv-iso-${crypto.randomUUID()}`;

		await stage(userId, personalBatch(), { conversationId: KEY }, CANNED_PERSONAL);
		await drainUntilSettled(userId, 30, { reset: false });
		await stage(userId, projectBatch(), { conversationId: KEY, memoryScope: { projectId: PROJECT } }, CANNED_PROJECT);
		await drainUntilSettled(userId, 30, { reset: false });

		let pages = await livePages(userId);
		expect(pages).toHaveLength(2);
		const personal = pages.find((p) => p.project_id === null);
		const project = pages.find((p) => p.project_id === PROJECT);
		expect(personal).toBeTruthy();
		expect(project).toBeTruthy();
		expect(personal.id).not.toBe(project.id);
		// Each scope carries its OWN conversation_key row for the same key.
		expect(personal.conversation_key).toBe(KEY);
		expect(project.conversation_key).toBe(KEY);
		expect(await pageSources(userId, personal.id)).toHaveLength(1);
		expect(await pageSources(userId, project.id)).toHaveLength(1);
		const personalBefore = { markdown: personal.full_markdown, revision: Number(personal.revision) };

		// Advance ONLY the project scope: the personal page must not move.
		await stage(userId, projectGrown(), { conversationId: KEY, memoryScope: { projectId: PROJECT } }, CANNED_PROJECT_GROWN);
		await drainUntilSettled(userId);

		pages = await livePages(userId);
		expect(pages).toHaveLength(2);
		const personalAfter = pages.find((p) => p.project_id === null);
		const projectAfter = pages.find((p) => p.project_id === PROJECT);
		expect(projectAfter.id).toBe(project.id);
		expect(await pageSources(userId, projectAfter.id)).toHaveLength(2);
		// No cross-scope advance: the personal page kept its single source,
		// its exact markdown, and its exact revision.
		expect(await pageSources(userId, personalAfter.id)).toHaveLength(1);
		expect(personalAfter.full_markdown).toBe(personalBefore.markdown);
		expect(Number(personalAfter.revision)).toBe(personalBefore.revision);
	}, 120_000);
});

// ---------------------------------------------------------------------------

describe("matrix 4 — advance limit", () => {
	const KEY = "conv-limit-1";

	const firstBatch = () => [
		{ id: "l1", role: "user", content: "I enrolled in a ceramics course at Forno Azul.", ts: T0 },
		{ id: "l2", role: "assistant", content: "Enjoy the wheel!", ts: T0 + 60_000 },
	];
	const overLimitBatch = () => [
		{ id: "l3", role: "user", content: "My cousin Rui opened a bakery in Aveiro.", ts: T0 + 120_000 },
		{ id: "l4", role: "assistant", content: "Fresh bread every day!", ts: T0 + 180_000 },
	];

	const CANNED_FIRST = cannedFor("Forno Azul", "organization", "Enrolled in a ceramics course at Forno Azul", "Ceramics Course At Forno Azul");
	const CANNED_OVER = cannedFor("Rui", "person", "Cousin Rui opened a bakery in Aveiro", "Cousin Rui Opens Aveiro Bakery");

	it("a page at the limit skips the page half; memories still save and the page never moves", async () => {
		const userId = `conv-limit-${crypto.randomUUID()}`;

		const first = await stage(userId, firstBatch(), { conversationId: KEY }, CANNED_FIRST);
		expect(first.page_id).toMatch(/^page_/);
		await drainUntilSettled(userId, 30, { reset: false });

		let pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		const pageId = pages[0].id;

		// Pad the page's linked sources to the bounded-advance ceiling.
		const statements = [];
		for (let i = 0; i < CONVERSATION_ADVANCE_LIMIT; i++) {
			statements.push(env.DB.prepare(
				"INSERT INTO conversation_page_sources (user_id, page_id, source_packet_id, seq, created_at) VALUES (?, ?, ?, ?, ?)",
			).bind(userId, pageId, `sp_fake_limit_${i}`, i + 2, Date.now()));
		}
		await env.DB.batch(statements);
		expect(await pageSources(userId, pageId)).toHaveLength(CONVERSATION_ADVANCE_LIMIT + 1);

		const before = (await livePages(userId))[0];
		const beforeMarkdown = before.full_markdown;
		const beforeRevision = Number(before.revision);

		// The next save for this conversation still succeeds — pagelessly.
		const second = await stage(userId, overLimitBatch(), { conversationId: KEY }, CANNED_OVER);
		expect(second.ok).toBe(true);
		expect(second.fired).toBe(true);
		expect(second.page_id).toBeNull();
		expect(second.receipt.page_skipped).toBe("conversation_page_advance_limit");

		await drainUntilSettled(userId);

		// Memories from the over-limit batch landed…
		expect(await nodeCount(userId, "Rui")).toBeGreaterThan(0);
		// …while the page did not advance: same single live page, unchanged
		// markdown, unchanged revision, no new source link.
		pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		expect(pages[0].id).toBe(pageId);
		expect(pages[0].full_markdown).toBe(beforeMarkdown);
		expect(Number(pages[0].revision)).toBe(beforeRevision);
		expect(await pageSources(userId, pageId)).toHaveLength(CONVERSATION_ADVANCE_LIMIT + 1);
	}, 120_000);
});

// ---------------------------------------------------------------------------

describe("matrix 5 — deleted page suppression", () => {
	const KEY = "conv-del-1";

	const firstBatch = () => [
		{ id: "d1", role: "user", content: "I joined the Alvalade Chess Club on Tuesdays.", ts: T0 },
		{ id: "d2", role: "assistant", content: "Good luck at the board!", ts: T0 + 60_000 },
	];
	const secondBatch = () => [
		{ id: "d3", role: "user", content: "My landlord raised the rent on Rua das Gaivotas.", ts: T0 + 120_000 },
		{ id: "d4", role: "assistant", content: "That is rough.", ts: T0 + 180_000 },
	];

	const CANNED_FIRST = cannedFor("Alvalade Chess Club", "organization", "Joined the Alvalade Chess Club on Tuesdays", "Joined Alvalade Chess Club");
	const CANNED_SECOND = cannedFor("Rua das Gaivotas", "place", "Rent raised on Rua das Gaivotas", "Rent Raised On Gaivotas");

	it("a deleted page never re-materializes: the re-save stays pageless and says why", async () => {
		const userId = `conv-del-${crypto.randomUUID()}`;

		await stage(userId, firstBatch(), { conversationId: KEY }, CANNED_FIRST);
		await drainUntilSettled(userId, 30, { reset: false });
		const pages = await livePages(userId);
		expect(pages).toHaveLength(1);
		const pageId = pages[0].id;

		await deleteObject(env, userId, { kind: "page", id: pageId });

		// Deletion recorded the conversation identity suppression…
		expect(await countRows(
			"SELECT COUNT(*) AS n FROM memory_suppressions WHERE user_id = ? AND kind = 'conversation_page' AND canonical_key = ?",
			userId, KEY,
		)).toBeGreaterThan(0);
		// …and the page's source links died with it.
		expect(await countRows(
			"SELECT COUNT(*) AS n FROM conversation_page_sources WHERE user_id = ?", userId,
		)).toBe(0);

		// Re-save the same conversation with new content: memories may save,
		// but NO page comes back.
		const second = await stage(userId, secondBatch(), { conversationId: KEY }, CANNED_SECOND);
		expect(second.ok).toBe(true);
		expect(second.fired).toBe(true);
		expect(second.page_id).toBeNull();
		expect(second.receipt.page_skipped).toBe("conversation_page_suppressed");

		await drainUntilSettled(userId);

		expect(await livePages(userId)).toHaveLength(0);
		// The only row that ever existed is the deleted original — no new page.
		const rows = await allPages(userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(pageId);
		expect(rows[0].deleted_at).toBeTruthy();
		expect(await countRows(
			"SELECT COUNT(*) AS n FROM conversation_page_sources WHERE user_id = ?", userId,
		)).toBe(0);
		// The re-save's memories landed regardless.
		expect(await nodeCount(userId, "Rua das Gaivotas")).toBeGreaterThan(0);
	}, 120_000);
});

// ---------------------------------------------------------------------------

describe("matrix 6 — appendAdvanceSection bounds", () => {
	const HEAD = "# Conversation\n\nIntro paragraph.";

	function section(i) {
		return `${advanceHeading(`Day ${i}`)}\n\n- fact ${i} about topic`;
	}

	it("appends untouched under the cap", () => {
		const result = appendAdvanceSection(HEAD, section(1), { cap: 10_000 });
		expect(result.markdown).toBe(`${HEAD}\n\n${section(1)}`);
		expect(result.trimmed).toBe(0);
		expect(result.clamped).toBeUndefined();
	});

	it("keeps the newest section, trims the oldest first, and records a truthful marker", () => {
		const cap = 700;
		const sections = [];
		for (let i = 1; i <= 30; i++) sections.push(section(i));
		const existing = [HEAD, ...sections].join("\n\n");
		const newest = section(31);
		expect(existing.length + newest.length).toBeGreaterThan(cap);

		const result = appendAdvanceSection(existing, newest, { cap });
		expect(result.markdown.length).toBeLessThanOrEqual(cap);
		expect(result.clamped).toBeUndefined();
		// Some but not all earlier sections were trimmed.
		expect(result.trimmed).toBeGreaterThanOrEqual(5);
		expect(result.trimmed).toBeLessThanOrEqual(29);

		// The head survives, immediately followed by the truthful trim marker.
		const marker = `_(${result.trimmed} earlier update${result.trimmed === 1 ? "" : "s"} trimmed for size — the full history remains in this page's linked sources.)_`;
		expect(result.markdown.startsWith(`${HEAD}\n\n${marker}`)).toBe(true);

		// The newest section ALWAYS survives; the oldest are gone, in order.
		expect(result.markdown).toContain(`${advanceHeading("Day 31")}\n`);
		expect(result.markdown).toContain("- fact 31 about topic");
		for (let i = 1; i <= 31; i++) {
			const heading = `${advanceHeading(`Day ${i}`)}\n`;
			if (i <= result.trimmed) expect(result.markdown).not.toContain(heading);
			else expect(result.markdown).toContain(heading);
		}
	});

	it("clamps hard when there are no advance sections to trim", () => {
		const cap = 200;
		const existing = `# Head\n\n${"x".repeat(400)}`;
		const result = appendAdvanceSection(existing, "- plain fact line without any heading", { cap });
		expect(result.clamped).toBe(true);
		expect(result.trimmed).toBe(0);
		expect(result.markdown.length).toBeLessThanOrEqual(cap);
		expect(result.markdown.startsWith("# Head\n\nxxxx")).toBe(true);
		expect(result.markdown.endsWith("…")).toBe(true);
	});
});
