/**
 * Engine v2 — the three-call save, tested through the real pipeline with the
 * real gates, the real write path, and a realistic conversation: people,
 * dates, preferences, a contradiction, and irrelevant chatter mixed in.
 *
 * The model calls are stubbed per-call (function hooks); everything else —
 * entity numbering, edge validation, bi-temporal closes, provenance, the
 * write — is the production code under test.
 */

import { env, createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runExtraction } from "../src/pipeline/extract.js";
import { runObserveMessagesCommand } from "../src/pipeline/commands.js";
import { numberEntities, validateEdgeRows, normalizeRelationType } from "../src/pipeline/engine_v2.js";

const TS = Date.parse("2026-08-02T10:00:00Z");

function msgs(contents) {
	return contents.map((content, i) => ({ id: `m-${i + 1}`, role: "user", content, ts: TS + i * 60_000 }));
}

// The realistic conversation. Amara's employer CHANGES mid-conversation — the
// bi-temporal test hangs off that contradiction.
const CONVERSATION = msgs([
	"My sister Amara is visiting from Lisbon on August 14th",
	"She's been at Meridian Labs since January 2024, engineering manager now",
	"haha that meme is exactly how standups feel",
	"Actually big news — Amara left Meridian and joined Nova Systems on July 1st this year",
	"We adopted a rescue greyhound named Biscuit last Saturday",
	"I prefer code reviews before noon, after lunch my focus is gone",
]);

const CALL1 = {
	objects: [
		{ kind: "node", label: "Amara", category: "family", matches_existing: null, confidence: 0.95 },
		{ kind: "node", label: "Meridian Labs", category: "organization", matches_existing: null, confidence: 0.9 },
		{ kind: "node", label: "Nova Systems", category: "organization", matches_existing: null, confidence: 0.9 },
		{ kind: "node", label: "Biscuit", category: "possession", matches_existing: null, confidence: 0.9 },
		{ kind: "slice", on: "Amara", text: "Visiting from Lisbon on August 14th", kind_detail: "other", confidence: 0.9 },
		{ kind: "event", on: "Biscuit", action: "started", text: "Adopted rescue greyhound Biscuit", importance: "ordinary", confidence: 0.9 },
		{ kind: "slice", on: "Amara", text: "Engineering manager", kind_detail: "other", confidence: 0.85 },
	],
	notes: "extraction",
};

describe("the three-call save", () => {
	it("edges, contradiction close, reflexion additions, provenance — end to end", async () => {
		const userId = `v2-e2e-${crypto.randomUUID()}`;
		let edgeEntitiesSeen = null;
		let reflexionSummarySeen = null;

		const result = await runExtraction(env, userId, CONVERSATION, [], {
			llmResponse: CALL1,
			edgeResponse: ({ entities }) => {
				edgeEntitiesSeen = entities;
				const byLabel = Object.fromEntries(entities.map((e) => [e.label, e.n]));
				return {
					edges: [
						// The contradiction, as the model would see it: two employers,
						// the new one starting July 1st.
						{ source_entity_id: byLabel["Amara"], target_entity_id: byLabel["Meridian Labs"], relation_type: "WORKS_AT", fact: "Amara worked at Meridian Labs", valid_at: "2024-01-01", invalid_at: null },
						{ source_entity_id: byLabel["Amara"], target_entity_id: byLabel["Nova Systems"], relation_type: "works at", fact: "Amara works at Nova Systems", valid_at: "2026-07-01", invalid_at: null },
						// An edge citing an id that is NOT on the list: rejected, never repaired.
						{ source_entity_id: 99, target_entity_id: byLabel["Amara"], relation_type: "MANAGES", fact: "ghost claim", valid_at: null, invalid_at: null },
					],
				};
			},
			reflexionResponse: ({ entities, foundSummary }) => {
				reflexionSummarySeen = foundSummary;
				const n = entities.length;
				const amara = entities.find((e) => e.label === "Amara").n;
				return {
					entities: [{ n: n + 1, label: "Code review timing", category: "preference" }],
					facts: [{ entity_id: n + 1, text: "Prefers code reviews before noon", kind: "preference" }],
					edges: [
						{ source_entity_id: amara, target_entity_id: n + 1, relation_type: "IRRELEVANT_LINK", fact: "not real", valid_at: null, invalid_at: null },
					],
				};
			},
		});

		expect(result.outcome).toBe("wrote");

		// Code, not the model, numbered the entities 1..n.
		expect(edgeEntitiesSeen.map((e) => e.n)).toEqual([1, 2, 3, 4]);
		// The reflexion pass was told what was already found (entities + facts;
		// the edge pass runs concurrently, so relations are deduped later, not
		// pre-announced).
		expect(reflexionSummarySeen).toContain("entity 1:");
		expect(reflexionSummarySeen).toContain("fact:");

		// The unknown-id edge was refused, with the gate named on the receipt.
		expect(result.receipt.skippedReasons.edge_unknown_entity_id).toBe(1);

		const { results: edges } = await env.DB.prepare(
			"SELECT e.type, e.fact, e.valid_at, e.invalid_at, nf.label AS from_label, nt.label AS to_label FROM edges e JOIN nodes nf ON nf.id = e.from_node JOIN nodes nt ON nt.id = e.to_node WHERE e.user_id = ? ORDER BY e.created_at, e.valid_at",
		).bind(userId).all();

		// SCREAMING_SNAKE normalization: "works at" became WORKS_AT.
		const works = edges.filter((e) => e.type === "WORKS_AT");
		expect(works).toHaveLength(2);
		const meridian = works.find((e) => e.to_label === "Meridian Labs");
		const nova = works.find((e) => e.to_label === "Nova Systems");
		// Bi-temporal contradiction handling: the old employer's validity window
		// CLOSED at the new one's start — the row still exists as history.
		expect(meridian.valid_at).toBe(Date.parse("2024-01-01T00:00:00Z"));
		expect(meridian.invalid_at).toBe(Date.parse("2026-07-01T00:00:00Z"));
		expect(nova.invalid_at).toBeNull();
		expect(nova.fact).toBe("Amara works at Nova Systems");

		// Reflexion's entity and fact landed as a real node + slice.
		const { results: nodes } = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ?").bind(userId).all();
		expect(nodes.map((n) => n.label)).toContain("Code review timing");
		const { results: slices } = await env.DB.prepare(
			"SELECT text, source_snippet FROM slices WHERE user_id = ?",
		).bind(userId).all();
		const pref = slices.find((s) => s.text.includes("reviews before noon"));
		expect(pref).toBeTruthy();
		// Provenance: the capped snippet points back at the message that said it.
		expect(pref.source_snippet).toContain("I prefer code reviews before noon");

		// Reflexion's edge to its own new entity survived the id gate.
		expect(edges.some((e) => e.type === "IRRELEVANT_LINK" && e.to_label === "Code review timing")).toBe(true);
	});

	it("a later save closes an earlier functional edge (cross-batch contradiction)", async () => {
		const userId = `v2-close-${crypto.randomUUID()}`;
		const first = await runExtraction(env, userId, msgs(["Ziyad here — I live in Porto these days"]), [], {
			llmResponse: { objects: [
				{ kind: "node", label: "Ziyad", category: "identity", confidence: 0.9 },
				{ kind: "node", label: "Porto", category: "place", confidence: 0.9 },
				{ kind: "slice", on: "Porto", text: "Lives in Porto", kind_detail: "other", confidence: 0.9 },
			] },
			edgeResponse: { edges: [{ source_entity_id: 1, target_entity_id: 2, relation_type: "LIVES_IN", fact: "Lives in Porto", valid_at: null, invalid_at: null }] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(first.outcome).toBe("wrote");

		const second = await runExtraction(env, userId, msgs(["We moved to Braga in June"]), [], {
			llmResponse: { objects: [
				// The extractor re-mentions the person; the gates resolve the label
				// onto the existing node instead of duplicating it.
				{ kind: "node", label: "Ziyad", category: "identity", confidence: 0.9 },
				{ kind: "node", label: "Braga", category: "place", confidence: 0.9 },
				{ kind: "slice", on: "Braga", text: "Moved to Braga in June", kind_detail: "other", confidence: 0.9 },
			] },
			edgeResponse: ({ entities }) => {
				const person = entities.find((e) => e.label === "Ziyad");
				const braga = entities.find((e) => e.label === "Braga");
				return { edges: [{ source_entity_id: person.n, target_entity_id: braga.n, relation_type: "LIVES_IN", fact: "Lives in Braga", valid_at: "2026-06-01", invalid_at: null }] };
			},
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(second.outcome).toBe("wrote");

		const { results: lives } = await env.DB.prepare(
			"SELECT e.invalid_at, nt.label AS to_label FROM edges e JOIN nodes nt ON nt.id = e.to_node WHERE e.user_id = ? AND e.type = 'LIVES_IN'",
		).bind(userId).all();
		expect(lives).toHaveLength(2);
		expect(lives.find((e) => e.to_label === "Porto").invalid_at).toBe(Date.parse("2026-06-01T00:00:00Z"));
		expect(lives.find((e) => e.to_label === "Braga").invalid_at).toBeNull();
	});

	it("malformed edge output: the save lands on call 1 alone, refusal named", async () => {
		const userId = `v2-malformed-${crypto.randomUUID()}`;
		const result = await runExtraction(env, userId, CONVERSATION, [], {
			llmResponse: CALL1,
			edgeResponse: "<think>the model rambles { \"edges\": [ and never finishes",
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.saved.nodes).toBeGreaterThan(0);
		expect(result.receipt.saved.edges).toBe(0);
		expect(result.receipt.skippedReasons.edge_pass_unparseable).toBe(1);
	});

	it("plugin lens: paths and traces are not memory; the error→fix pair is", async () => {
		const userId = `v2-plugin-${crypto.randomUUID()}`;
		const result = await runExtraction(env, userId, msgs([
			"We decided to keep the retry logic in the worker, not the client, so failures stay observable",
			"TypeError: Cannot read properties of undefined (reading 'limit')\n    at allowRate (src/index.js:78:29)\n    at handleRequest (src/index.js:1412:9)\n    at async fetch (src/index.js:1384:11)",
			"fixed it — the RECALL_LIMITER binding was missing from wrangler.test.jsonc, adding it resolved the crash",
		]), [], {
			profile: "plugin",
			llmResponse: { objects: [
				{ kind: "node", label: "Retry logic", category: "project", confidence: 0.9 },
				{ kind: "slice", on: "Retry logic", text: "Decided to keep retry logic in the worker so failures stay observable", kind_detail: "decision", confidence: 0.9 },
				// The three shapes the plugin lens must refuse:
				{ kind: "node", label: "src/index.js", category: "tool", confidence: 0.9 },
				{ kind: "slice", on: "Retry logic", text: "TypeError: Cannot read properties of undefined (reading 'limit')\n    at allowRate (src/index.js:78:29)\n    at handleRequest (src/index.js:1412:9)\n    at async fetch (src/index.js:1384:11)\n    at async run (src/index.js:20:3)", kind_detail: "other", confidence: 0.8 },
				// The error→fix pair, which IS memory:
				{ kind: "slice", on: "Retry logic", text: "allowRate crashed with 'cannot read limit' — missing RECALL_LIMITER binding in wrangler.test.jsonc; adding the binding fixed it", kind_detail: "fix", confidence: 0.9 },
			] },
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.skippedReasons.file_path_node).toBe(1);
		expect(result.receipt.skippedReasons.stack_trace_discarded).toBe(1);

		const { results: nodes } = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ?").bind(userId).all();
		expect(nodes.map((n) => n.label)).not.toContain("src/index.js");
		const { results: slices } = await env.DB.prepare("SELECT text, kind FROM slices WHERE user_id = ?").bind(userId).all();
		expect(slices.some((s) => s.kind === "fix" && s.text.includes("RECALL_LIMITER"))).toBe(true);
		expect(slices.some((s) => s.text.includes("at handleRequest"))).toBe(false);
	});

	it("SDK caller rules: an excluded category cannot be written", async () => {
		const userId = `v2-sdkrules-${crypto.randomUUID()}`;
		const result = await runExtraction(env, userId, msgs([
			"Our user mentioned they were diagnosed with asthma last spring",
			"They also said they are switching their stack to Rust",
		]), [], {
			profile: "sdk",
			rules: {
				customInstructions: "", includes: [], excludes: ["asthma", "diagnosis", "health"],
				customCategories: [], captureDefault: "auto", captureDensity: "standard", autoCollect: true, retentionDays: null,
			},
			llmResponse: { objects: [
				{ kind: "node", label: "Asthma", category: "health", confidence: 0.9 },
				{ kind: "event", on: "Asthma", action: "diagnosed", text: "Diagnosed with asthma last spring", importance: "life_significant", confidence: 0.9 },
				{ kind: "node", label: "Rust migration", category: "project", confidence: 0.9 },
				{ kind: "slice", on: "Rust migration", text: "Switching their stack to Rust", kind_detail: "decision", confidence: 0.9 },
			] },
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(result.outcome).toBe("wrote");
		const { results: nodes } = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ?").bind(userId).all();
		const labels = nodes.map((n) => n.label);
		expect(labels).toContain("Rust migration");
		expect(labels).not.toContain("Asthma");
		expect(Object.keys(result.receipt.skippedReasons)).toContain("excluded_by_rule");
	});

	it("the scrubber runs before any model sees the text (through the real door)", async () => {
		const userId = `v2-scrub-${crypto.randomUUID()}`;
		let modelSaw = null;
		const ctx = createExecutionContext();
		await runObserveMessagesCommand(env, ctx, userId, [
			{ id: "s-1", role: "user", content: "prod db is neo4j+s://neo4j:kX9mP2vLqR8wN4jT7hB3cF6d@a1b2c3d4.databases.neo4j.io — we're on AuraDB now", ts: TS },
		], {
			flush: true,
			waitBudgetMs: 5000,
			overrides: {
				llmResponse: ({ packet }) => {
					modelSaw = JSON.stringify(packet);
					return { objects: [{ kind: "node", label: "AuraDB", category: "tool", confidence: 0.9 }] };
				},
				edgeResponse: { edges: [] },
				reflexionResponse: { entities: [], facts: [], edges: [] },
			},
		});
		await waitOnExecutionContext(ctx);
		expect(modelSaw).not.toBeNull();
		expect(modelSaw).not.toContain("kX9mP2vLqR8wN4jT7hB3cF6d");
		expect(modelSaw).toContain("[REDACTED:password]");
	});
});

describe("the backlog cannot strand", () => {
	it("messages that arrive during a fire are drained by a re-armed alarm", async () => {
		const userId = `v2-drain-${crypto.randomUUID()}`;
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

		const nodeHooks = {
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		};
		const respond = ({ packet }) => ({
			objects: packet.new_slice.map((m) => ({ kind: "node", label: `Fact ${m.id}`, category: "other", confidence: 0.9 })),
		});

		await stub.addMessages(userId, msgs(["I started training for the Porto half marathon this week"]), { flush: true });

		// A slow model: the fire blocks on `gate` while a late message arrives —
		// the real production interleaving, just deterministic.
		await runInDurableObject(stub, async (instance) => {
			let release;
			const gate = new Promise((resolve) => { release = resolve; });
			const fire = instance.runExtraction(userId, {
				...nodeHooks,
				llmResponse: async (args) => { await gate; return respond(args); },
			});
			await instance.addMessages(userId, [
				{ id: "late-1", role: "user", content: "Also we finally hired a designer, her name is Ines", ts: TS + 999_000 },
			], {});
			release();
			const first = await fire;
			if (first.outcome !== "wrote") throw new Error(`first fire: ${first.outcome}`);
		});

		// The old bug: the late message sat until the NEXT ingest — forever, if
		// the conversation had ended. The queue rewrite makes the guarantee
		// structural: the late message went into a durable queue entry the
		// moment it fired, and the SAME drain that ran the first fire picks it
		// up before returning. If anything were somehow still held, this
		// explicit drain (standing in for the alarm/sweep, which are disabled
		// in the test pool) must finish it.
		await runDurableObjectAlarm(stub);
		const second = await stub.runExtraction(userId, { ...nodeHooks, llmResponse: respond });
		expect(["wrote", "empty"]).toContain(second.outcome);
		// The invariant: the late arrival was PROCESSED (checkpoint reached it)
		// and nothing is held or queued anywhere.
		const debug = await stub.getDebugState();
		expect(debug.chunkSize).toBe(0);
		expect(debug.checkpoint).toBe("late-1");
	});
});

describe("engine v2 unit seams", () => {
	it("normalizeRelationType shapes and refuses", () => {
		expect(normalizeRelationType("works at")).toBe("WORKS_AT");
		expect(normalizeRelationType("built-with")).toBe("BUILT_WITH");
		expect(normalizeRelationType("USES")).toBe("USES");
		expect(normalizeRelationType("")).toBeNull();
		expect(normalizeRelationType("!!!")).toBeNull();
	});

	it("numberEntities de-duplicates across shortlist and proposals", () => {
		const entities = numberEntities(
			[{ kind: "node", label: "Amara" }, { kind: "node", label: "amara" }, { kind: "node", label: "Biscuit" }],
			[{ id: "node_1", label: "Amara", category: "family" }],
		);
		expect(entities.map((e) => e.label)).toEqual(["Amara", "Biscuit"]);
		expect(entities[0].existingId).toBe("node_1");
	});

	it("validateEdgeRows rejects out-of-range ids and self-loops by name", () => {
		const entities = [{ n: 1, label: "A", category: "person" }, { n: 2, label: "B", category: "person" }];
		const { edges, rejected } = validateEdgeRows([
			{ source_entity_id: 1, target_entity_id: 2, relation_type: "KNOWS", fact: "ok" },
			{ source_entity_id: 1, target_entity_id: 7, relation_type: "KNOWS", fact: "ghost" },
			{ source_entity_id: 2, target_entity_id: 2, relation_type: "KNOWS", fact: "loop" },
		], entities);
		expect(edges).toHaveLength(1);
		expect(rejected.map((r) => r.reason)).toEqual(["edge_unknown_entity_id", "edge_self_loop"]);
	});
});

describe("provenance obeys the caller's rules", () => {
	it("an excluded sentence never survives as evidence on an allowed node", async () => {
		// Found on production: excludes:["salary"] correctly refused the salary
		// node, then stored the WHOLE sentence - salary included - as the
		// source_snippet of the allowed neighbour, and /v1/graph returned it.
		const userId = `v2-prov-rules-${crypto.randomUUID()}`;
		const result = await runExtraction(env, userId, msgs([
			"My salary is 91000 EUR and my blood pressure medication is lisinopril. Also I moved to Aveiro.",
		]), [], {
			rules: {
				customInstructions: "", includes: [], excludes: ["salary", "medication"],
				customCategories: [], captureDefault: "auto", captureDensity: "standard",
				autoCollect: true, retentionDays: null,
			},
			llmResponse: { objects: [
				{ kind: "node", label: "Aveiro", category: "place", confidence: 0.9 },
				{ kind: "slice", on: "Aveiro", text: "Moved to Aveiro", kind_detail: "other", confidence: 0.9 },
			] },
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		});
		expect(result.outcome).toBe("wrote");

		const { results } = await env.DB.prepare(
			"SELECT text, source_snippet FROM slices WHERE user_id = ?",
		).bind(userId).all();
		expect(results.length).toBeGreaterThan(0);
		for (const row of results) {
			expect(JSON.stringify(row)).not.toContain("91000");
			expect(JSON.stringify(row).toLowerCase()).not.toContain("lisinopril");
		}
	});
});
