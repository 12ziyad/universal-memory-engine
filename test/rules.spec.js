/**
 * Per-user memory rules: storage, matching semantics, the /v1/rules and
 * /v1/turn routes, and deterministic enforcement in both save lanes (MCP
 * manual engine + auto ingest gates). Model output is injected everywhere,
 * so filters — not prompts — are what these specs prove.
 */

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { runMcpConversationCollectCommand, runMcpDirectSaveCommand } from "../src/pipeline/manual_mcp.js";
import {
	getMemoryRules,
	normalizeMemoryRules,
	rulesAllowText,
	saveMemoryRules,
} from "../src/pipeline/rules.js";

function userId(label) {
	return `rules-${label}-${crypto.randomUUID()}`;
}

async function httpFetch(path, init) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function authedJson(body) {
	return {
		method: "POST",
		headers: { "x-api-key": env.API_KEY, "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function sliceFact({ label, category = "interest", kind = "progress", text }) {
	return {
		identity: { label, category, existing_node_id: null, aliases: [] },
		memory: { kind: "slice", slice_kind: kind, text },
		confidence: 0.96,
		supersedes: false,
	};
}

function proposal(facts = []) {
	return { facts, relationships: [], notes: "" };
}

async function rows(table, id) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(id).all();
	return results;
}

describe("memory rules module", () => {
	it("normalizes, saves, and reloads rules", async () => {
		const id = userId("roundtrip");
		const saved = await saveMemoryRules(env, id, {
			customInstructions: "  Always save study progress.  ",
			includes: ["Exams", "exams", "", "UML project"],
			excludes: ["passwords"],
			customCategories: [{ name: "Study Progress!", description: "exam and unit completion" }],
			captureDefault: "graph_only",
			autoCollect: false,
		});
		expect(saved.customInstructions).toBe("Always save study progress.");
		expect(saved.includes).toEqual(["Exams", "UML project"]);
		expect(saved.excludes).toEqual(["passwords"]);
		expect(saved.customCategories).toEqual([{ name: "study_progress", description: "exam and unit completion" }]);
		expect(saved.captureDefault).toBe("graph_only");
		expect(saved.autoCollect).toBe(false);

		const reloaded = await getMemoryRules(env, id);
		expect(reloaded).toEqual(saved);
	});

	it("returns defaults for a user with no rules row", async () => {
		const rules = await getMemoryRules(env, userId("defaults"));
		expect(rules.includes).toEqual([]);
		expect(rules.excludes).toEqual([]);
		expect(rules.captureDefault).toBe("auto");
		expect(rules.autoCollect).toBe(true);
	});

	it("matches on word boundaries, excludes beating includes", () => {
		const rules = normalizeMemoryRules({ includes: ["boxing"], excludes: ["politics"] });
		expect(rulesAllowText(rules, "I started boxing today")).toBe(true);
		expect(rulesAllowText(rules, "I love guitar")).toBe(false); // outside includes
		expect(rulesAllowText(rules, "boxing and politics debate")).toBe(false); // exclude wins
		// "art" must not match inside "started".
		const partial = normalizeMemoryRules({ excludes: ["art"] });
		expect(rulesAllowText(partial, "I started boxing")).toBe(true);
		expect(rulesAllowText(partial, "I love art class")).toBe(false);
	});
});

describe("/v1/rules routes", () => {
	it("saves and returns rules through the API", async () => {
		const id = userId("api");
		const put = await httpFetch("/v1/rules", {
			...authedJson({ userId: id, rules: { excludes: ["politics"], customInstructions: "Never save politics." } }),
			method: "PUT",
		});
		expect(put.status).toBe(200);
		expect((await put.json()).rules.excludes).toEqual(["politics"]);

		const get = await httpFetch(`/v1/rules?userId=${id}`, { headers: { "x-api-key": env.API_KEY } });
		expect(get.status).toBe(200);
		const body = await get.json();
		expect(body.rules.excludes).toEqual(["politics"]);
		expect(body.rules.customInstructions).toBe("Never save politics.");
	});

	it("requires auth", async () => {
		const res = await httpFetch(`/v1/rules?userId=x`);
		expect(res.status).toBe(401);
	});
});

describe("rules enforcement in the MCP manual lanes", () => {
	it("refuses an excluded fact on direct save", async () => {
		const id = userId("mcp-exclude");
		await saveMemoryRules(env, id, { excludes: ["politics"] });
		const result = await runMcpDirectSaveCommand(env, null, id, {
			content: "I follow politics debates every night.",
			extractionResponse: proposal([
				sliceFact({ label: "Politics", text: "I follow politics debates every night." }),
			]),
		});
		expect(result.counts.savedTotal).toBe(0);
		expect(result.receipt.skippedReasons.excluded_by_rule).toBeGreaterThanOrEqual(1);
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("keeps only include-matching facts on collect", async () => {
		const id = userId("mcp-include");
		await saveMemoryRules(env, id, { includes: ["boxing"] });
		const result = await runMcpConversationCollectCommand(env, null, id, {
			conversationId: "include-scope",
			messages: [
				{ id: "m0", role: "user", content: "I started boxing on Monday." },
				{ id: "m1", role: "user", content: "I bought a new guitar." },
			],
			digestResponse: "I started boxing on Monday.\nI bought a new guitar.",
			extractionResponse: proposal([
				sliceFact({ label: "Boxing", category: "skill", text: "I started boxing on Monday." }),
				sliceFact({ label: "Guitar", category: "interest", text: "I bought a new guitar." }),
			]),
		});
		const labels = (await rows("nodes", id)).map((node) => node.label);
		expect(labels).toContain("Boxing");
		expect(labels).not.toContain("Guitar");
		expect(result.receipt.skippedReasons.outside_include_rules).toBeGreaterThanOrEqual(1);
	});

	it("captureDefault graph_only suppresses whole-chat capture pages", async () => {
		const id = userId("capture-off");
		await saveMemoryRules(env, id, { captureDefault: "graph_only" });
		const result = await runMcpConversationCollectCommand(env, null, id, {
			conversationId: "capture-off",
			messages: [
				{ id: "m0", role: "user", content: "Explain Unit 3 for my exam" },
				{ id: "m1", role: "assistant", content: "Unit 3 covers photosynthesis and cellular respiration in detail." },
				{ id: "m2", role: "assistant", content: "Photosynthesis converts sunlight into glucose inside chloroplasts." },
				{ id: "m3", role: "user", content: "hey save everything from this chat to uml" },
			],
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse:
				"Unit 3 covers photosynthesis and cellular respiration.\n" +
				"Photosynthesis converts sunlight into glucose inside chloroplasts.",
		});
		expect(result.counts.pages).toBe(0);
		expect(await rows("memory_pages", id)).toHaveLength(0);
	});

	it("excluded topics never reach capture notes", async () => {
		const id = userId("capture-exclude");
		await saveMemoryRules(env, id, { excludes: ["respiration"] });
		await runMcpConversationCollectCommand(env, null, id, {
			conversationId: "capture-exclude",
			messages: [
				{ id: "m0", role: "user", content: "Explain Unit 3 for my exam" },
				{ id: "m1", role: "assistant", content: "Unit 3 covers photosynthesis and cellular respiration in detail." },
				{ id: "m2", role: "assistant", content: "Photosynthesis converts sunlight into glucose inside chloroplasts." },
				{ id: "m3", role: "assistant", content: "Chlorophyll absorbs light energy to power the process." },
				{ id: "m4", role: "user", content: "hey save everything from this chat to uml" },
			],
			digestResponse: "",
			extractionResponse: proposal([]),
			notesResponse:
				"Unit 3 covers photosynthesis and cellular respiration.\n" +
				"Photosynthesis converts sunlight into glucose inside chloroplasts.\n" +
				"Chlorophyll absorbs light energy to power the process.",
		});
		const pages = await rows("memory_pages", id);
		expect(pages).toHaveLength(1);
		expect(pages[0].full_markdown).not.toMatch(/respiration/i);
		expect(pages[0].full_markdown).toMatch(/photosynthesis/i);
	});
});

describe("rules enforcement in the auto ingest lane", () => {
	it("drops excluded objects proposed by the model", async () => {
		const id = userId("ingest-exclude");
		await saveMemoryRules(env, id, { excludes: ["politics"] });
		const response = await httpFetch("/v1/ingest", authedJson({
			userId: id,
			flush: true,
			messages: [{ id: "m1", role: "user", content: "I started following politics podcasts and boxing training." }],
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
						{ kind: "event", on: "Boxing", action: "started", text: "Started boxing training", importance: "ordinary", confidence: 0.95 },
						{ kind: "node", label: "Politics Podcasts", category: "interest", confidence: 0.9 },
						{ kind: "slice", on: "Politics Podcasts", text: "Follows politics podcasts", kind_detail: "other", confidence: 0.9 },
					],
				},
			},
		}));
		expect(response.status).toBe(200);
		const labels = (await rows("nodes", id)).map((node) => node.label);
		expect(labels).toContain("Boxing");
		expect(labels).not.toContain("Politics Podcasts");
	});
});

describe("POST /v1/turn", () => {
	it("recalls relevant memory and auto-collects the turn", async () => {
		const id = userId("turn");
		const seeded = await httpFetch("/v1/save", authedJson({
			userId: id,
			content: "I started boxing training this month.",
			_test: {
				llmResponse: {
					objects: [
						{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
						{ kind: "event", on: "Boxing", action: "started", text: "Started boxing training", importance: "ordinary", confidence: 0.95 },
					],
				},
			},
		}));
		expect(seeded.status).toBe(200);

		const response = await httpFetch("/v1/turn", authedJson({
			userId: id,
			conversationId: "turn-1",
			messages: [{ id: "t1", role: "user", content: "What do you know about my boxing?" }],
		}));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.recall.count).toBeGreaterThanOrEqual(1);
		expect(body.collect.enabled).toBe(true);
	});

	it("skips collection when autoCollect is off", async () => {
		const id = userId("turn-manual");
		await saveMemoryRules(env, id, { autoCollect: false });
		const response = await httpFetch("/v1/turn", authedJson({
			userId: id,
			messages: [{ id: "t1", role: "user", content: "I moved to Dubai last week." }],
		}));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.collect.enabled).toBe(false);
		expect(body.rules.autoCollect).toBe(false);
	});

	it("requires messages or a query", async () => {
		const response = await httpFetch("/v1/turn", authedJson({ userId: userId("turn-empty") }));
		expect(response.status).toBe(400);
	});
});
