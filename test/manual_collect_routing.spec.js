/**
 * save_conversation representation routing (the "junk memory page" fix).
 *
 * Every case drives the real runMcpConversationCollectCommand with injected
 * model output (extractionResponse / digestResponse), so directive stripping,
 * the content gate, the router, page synthesis and the atomic write all run as
 * production code. No live model.
 *
 * Routing contract:
 *   - 0 grounded semantic claims                -> no write, no page
 *   - exactly 1 atomic claim                     -> graph only, no page
 *   - >= 2 claims OR multi-turn substance        -> page + graph
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runMcpConversationCollectCommand } from "../src/pipeline/manual_mcp.js";

function userId(label) {
	return `collect-routing-${label}-${crypto.randomUUID()}`;
}

function proposal(facts = [], relationships = []) {
	return { facts, relationships, notes: "" };
}

function sliceFact({ label, category = "project", kind = "progress", text }) {
	return {
		identity: { label, category, existing_node_id: null, aliases: [] },
		memory: { kind: "slice", slice_kind: kind, text },
		confidence: 0.96,
		supersedes: false,
	};
}

function eventFact({ label, category = "skill", action = "started", text }) {
	return {
		identity: { label, category, existing_node_id: null, aliases: [] },
		memory: { kind: "event", action, text, importance: "ordinary" },
		confidence: 0.97,
		supersedes: false,
	};
}

async function collect(id, input) {
	return runMcpConversationCollectCommand(env, null, id, input);
}

async function rows(table, id) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(id).all();
	return results;
}

const NO_CONTENT_REASON = "No semantic content remained after removing save instructions and filler";

describe("save_conversation representation routing", () => {
	it("writes nothing for the reported control-only conversation", async () => {
		const id = userId("control-only");
		const result = await collect(id, {
			conversationId: "control-only",
			messages: [
				{ id: "m0", role: "user", content: "bro save everithing from this chst to uml" },
				{ id: "m1", role: "user", content: "hey there memory update" },
			],
			extractionResponse: proposal([]),
		});

		expect(result).toMatchObject({ status: "ignored", counts: { savedTotal: 0, pages: 0, nodes: 0 } });
		expect(result.summary).toContain(NO_CONTENT_REASON);
		expect(await rows("memory_pages", id)).toHaveLength(0);
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it.each([
		["please save this conversation to memory", "please save this conversation to memory"],
		["save everything here", "save everything here"],
		["bro, save all of this to uml please", "typo/vocative/destination variant"],
	])("writes nothing for a bare save instruction (%s)", async (content) => {
		const id = userId("bare-save");
		const result = await collect(id, {
			messages: [{ id: "m0", role: "user", content }],
			extractionResponse: proposal([]),
		});
		expect(result.counts).toMatchObject({ savedTotal: 0, pages: 0, nodes: 0 });
		expect(await rows("memory_pages", id)).toHaveLength(0);
	});

	it("still creates a page for a rich conversation that ends with a save command", async () => {
		const id = userId("rich-then-save");
		const line1 = "I am building Atlas on Cloudflare Workers.";
		const line2 = "Atlas stores its data in D1.";
		const result = await collect(id, {
			conversationId: "rich-then-save",
			messages: [
				{ id: "m0", role: "user", content: line1 },
				{ id: "m1", role: "user", content: line2 },
				{ id: "m2", role: "user", content: "save everything" },
			],
			digestResponse: `${line1}\n${line2}`,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", kind: "progress", text: line1 }),
				sliceFact({ label: "Atlas", kind: "technical_detail", text: line2 }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect(result.counts.pages).toBe(1);
		const pages = await rows("memory_pages", id);
		expect(pages).toHaveLength(1);
		expect(pages[0].full_markdown).not.toMatch(/save everything/i);
	});

	it("keeps the trailing fact when a save command shares the message", async () => {
		const id = userId("save-plus-fact");
		const result = await collect(id, {
			conversationId: "save-plus-fact",
			messages: [
				{ id: "m0", role: "user", content: "save this chat; Rahul joined my team yesterday. Rahul prefers Go." },
			],
			digestResponse: "Rahul joined my team yesterday.\nRahul prefers Go.",
			extractionResponse: proposal([
				eventFact({ label: "Rahul", category: "person", action: "joined", text: "Rahul joined my team yesterday." }),
				sliceFact({ label: "Rahul", category: "person", kind: "preference", text: "Rahul prefers Go." }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Rahul");
		const pages = await rows("memory_pages", id);
		expect(JSON.stringify(pages)).not.toMatch(/save this chat/i);
	});

	it("keeps a single 'remember that I started boxing' as a graph fact", async () => {
		const id = userId("remember-boxing");
		const result = await collect(id, {
			conversationId: "remember-boxing",
			messages: [{ id: "m0", role: "user", content: "Remember that I started boxing" }],
			digestResponse: "I started boxing.",
			extractionResponse: proposal([eventFact({ label: "Boxing", action: "started", text: "I started boxing." })]),
		});

		expect(result.status).toBe("wrote");
		expect((await rows("nodes", id)).map((node) => node.label)).toEqual(["Boxing"]);
	});

	it("routes a single standalone fact to graph-only with no page", async () => {
		const id = userId("single-fact");
		const result = await collect(id, {
			conversationId: "single-fact",
			messages: [{ id: "m0", role: "user", content: "I started boxing." }],
			digestResponse: "I started boxing.",
			extractionResponse: proposal([eventFact({ label: "Boxing", action: "started", text: "I started boxing." })]),
		});

		expect(result.status).toBe("wrote");
		expect(result.counts).toMatchObject({ pages: 0, nodes: 1 });
		expect(await rows("memory_pages", id)).toHaveLength(0);
		expect((await rows("nodes", id)).map((node) => node.label)).toEqual(["Boxing"]);
	});

	it("creates a page for multiple connected facts about one subject", async () => {
		const id = userId("connected-facts");
		const lines = [
			"I started boxing in March.",
			"I train three days a week.",
			"I paused boxing in June.",
			"I plan to resume next month.",
		];
		const result = await collect(id, {
			conversationId: "connected-facts",
			messages: lines.map((content, index) => ({ id: `m${index}`, role: "user", content })),
			digestResponse: lines.join("\n"),
			extractionResponse: proposal([
				eventFact({ label: "Boxing", action: "started", text: lines[0] }),
				sliceFact({ label: "Boxing", category: "skill", kind: "progress", text: lines[1] }),
				eventFact({ label: "Boxing", action: "paused", text: lines[2] }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect(result.counts.pages).toBe(1);
		expect(await rows("memory_pages", id)).toHaveLength(1);
	});

	it("persists a temporary plan rather than rejecting it", async () => {
		const id = userId("temporary-plan");
		const result = await collect(id, {
			conversationId: "temporary-plan",
			messages: [
				{ id: "m0", role: "user", content: "I paused the retrieval work for now." },
				{ id: "m1", role: "user", content: "I plan to resume it next month." },
			],
			digestResponse: "I paused the retrieval work.\nI plan to resume it next month.",
			extractionResponse: proposal([
				eventFact({ label: "Retrieval Work", category: "project", action: "paused", text: "I paused the retrieval work for now." }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect(result.counts.savedTotal).toBeGreaterThan(0);
		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Retrieval Work");
	});
});

describe("save_conversation whole-chat capture", () => {
	const lessonMessages = [
		{ id: "m0", role: "user", content: "Explain Unit 3 for my exam" },
		{ id: "m1", role: "assistant", content: "Unit 3 covers photosynthesis and cellular respiration in detail." },
		{ id: "m2", role: "assistant", content: "Photosynthesis converts sunlight into glucose inside chloroplasts." },
		{ id: "m3", role: "user", content: "hey save everything from this chat to uml" },
	];
	const lessonNotes =
		"Unit 3 covers photosynthesis and cellular respiration.\n" +
		"Photosynthesis converts sunlight into glucose inside chloroplasts.";

	it("captures a lesson chat into a notes page on 'save everything'", async () => {
		const id = userId("capture-notes");
		const result = await collect(id, {
			conversationId: "capture-notes",
			messages: lessonMessages,
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse: lessonNotes,
		});

		expect(result.status).toBe("wrote");
		expect(result.counts.pages).toBe(1);
		const pages = await rows("memory_pages", id);
		expect(pages).toHaveLength(1);
		expect(pages[0].full_markdown).toMatch(/photosynthesis/i);
		expect(pages[0].full_markdown).not.toMatch(/save everything/i);
		// Notes are page-only: assistant lesson content never becomes graph facts.
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("drops fabricated note lines that no conversation turn supports", async () => {
		const id = userId("capture-grounding");
		const result = await collect(id, {
			conversationId: "capture-grounding",
			messages: lessonMessages,
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse:
				`${lessonNotes}\n` +
				"The mitochondria synthesize dopamine using quantum tunneling in Redis.",
		});

		expect(result.counts.pages).toBe(1);
		const pages = await rows("memory_pages", id);
		expect(pages[0].full_markdown).not.toMatch(/quantum tunneling|Redis/i);
	});

	it("still writes nothing when a capture directive has no real content", async () => {
		const id = userId("capture-thin");
		const result = await collect(id, {
			conversationId: "capture-thin",
			messages: [
				{ id: "m0", role: "user", content: "hey save everything from this chat to uml" },
			],
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse: "",
		});

		expect(result.counts).toMatchObject({ savedTotal: 0, pages: 0, nodes: 0 });
		expect(await rows("memory_pages", id)).toHaveLength(0);
	});

	it("routes a repeat capture of the same topic into the same page", async () => {
		const id = userId("capture-repeat");
		const first = await collect(id, {
			conversationId: "capture-repeat",
			messages: lessonMessages,
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse: lessonNotes,
		});
		expect(first.counts.pages).toBe(1);

		const second = await collect(id, {
			conversationId: "capture-repeat",
			messages: [
				...lessonMessages,
				{ id: "m4", role: "assistant", content: "Cellular respiration breaks glucose down to release ATP energy." },
				{ id: "m5", role: "user", content: "save more about this chat please" },
			],
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse:
				`${lessonNotes}\n` +
				"Cellular respiration breaks glucose down to release ATP energy.",
		});

		expect(second.status).toBe("wrote");
		expect(await rows("memory_pages", id)).toHaveLength(1);
		const page = (await rows("memory_pages", id))[0];
		expect(page.full_markdown).toMatch(/ATP energy/i);
	});
});
