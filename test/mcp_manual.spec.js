/**
 * Focused correctness tests for the MCP-only manual memory door.
 *
 * These tests call the low-level MCP commands directly. They intentionally do
 * not exercise /v1/save or the API AutoMode lane. Model output is injected via
 * extractionResponse/digestResponse; source packets, integrity, identity,
 * planning, atomic D1 writes, summaries, candidates, pages, and receipts are
 * all real code under test.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	runMcpConversationCollectCommand,
	runMcpDirectSaveCommand,
} from "../src/pipeline/manual_mcp.js";
import { runRecallCommand } from "../src/pipeline/commands.js";

function userId(label) {
	return `mcp-manual-${label}-${crypto.randomUUID()}`;
}

function eventFact({ label, category = "skill", action = "started", text, existingNodeId = null, aliases = [] }) {
	return {
		identity: {
			label,
			category,
			existing_node_id: existingNodeId,
			aliases,
		},
		memory: {
			kind: "event",
			action,
			text,
			importance: "ordinary",
		},
		confidence: 0.97,
		supersedes: false,
	};
}

function sliceFact({ label, category = "project", kind = "progress", text, existingNodeId = null, supersedes = false }) {
	return {
		identity: {
			label,
			category,
			existing_node_id: existingNodeId,
			aliases: [],
		},
		memory: {
			kind: "slice",
			slice_kind: kind,
			text,
		},
		confidence: 0.96,
		supersedes,
	};
}

function proposal(facts = [], relationships = []) {
	return { facts, relationships, notes: "" };
}

async function direct(id, input) {
	return runMcpDirectSaveCommand(env, null, id, input);
}

async function collect(id, input) {
	return runMcpConversationCollectCommand(env, null, id, input);
}

async function rows(table, id, suffix = "") {
	const { results } = await env.DB.prepare(
		`SELECT * FROM ${table} WHERE user_id = ? ${suffix}`,
	).bind(id).all();
	return results;
}

async function one(table, id, suffix = "") {
	return env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ${suffix}`).bind(id).first();
}

async function seedNode(id, nodeId, label, {
	category = "project",
	aliases = [],
	state = "active",
	summary = null,
} = {}) {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO nodes
			(id, user_id, label, canonical_label, aliases_json, category, role, state,
			 summary, created_at, updated_at, mention_count, session_count, last_seen_at,
			 heat_score, health_state, importance_class)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		nodeId,
		id,
		label,
		label.toLocaleLowerCase("en-US"),
		JSON.stringify(aliases),
		category,
		null,
		state,
		summary,
		now,
		now,
		1,
		1,
		now,
		1,
		"active",
		"ordinary",
	).run();
}

async function seedPendingCandidate(id, candidateId, label, possibleExistingNodeId = null) {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO candidates
			(id, user_id, label, strength, mentions, cluster_hint, created_at,
			 label_guess, canonical_key, confidence, status, first_seen_at, last_seen_at,
			 session_count, mention_count, evidence_json, possible_existing_node_id, reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		candidateId,
		id,
		label,
		"medium",
		1,
		null,
		now,
		label,
		label.toLocaleLowerCase("en-US"),
		0.7,
		"pending",
		now,
		now,
		1,
		1,
		JSON.stringify([{ text: label, source: "seed" }]),
		possibleExistingNodeId,
		"seeded_for_manual_resolution",
	).run();
}

describe("MCP manual direct engine", () => {
	it("creates a complete node plus event and persists an immediate nonempty summary", async () => {
		const id = userId("new-event");
		const content = "I started boxing today.";
		const result = await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Boxing", action: "started", text: content }),
			]),
		});

		expect(result).toMatchObject({
			ok: true,
			command_mode: "direct_save",
			source: "save_memory",
			status: "wrote",
			processing: false,
			counts: { nodes: 1, events: 1, candidates: 0 },
		});
		expect(result.summary).toContain("Saved graph:");
		const node = await one("nodes", id);
		expect(node).toMatchObject({ label: "Boxing", state: "active" });
		expect(node.summary).toContain("I started boxing today");
		expect(node.summary.trim()).not.toBe("");
		expect(await rows("events", id)).toHaveLength(1);
		expect(await rows("slices", id)).toHaveLength(0);
	});

	it("merges exact labels and aliases into the same existing node without duplication", async () => {
		const id = userId("exact-alias");
		await seedNode(id, "node-uml", "Universal Memory Layer", {
			category: "project",
			aliases: ["UML"],
		});

		const exactText = "Universal Memory Layer is making steady progress.";
		const exact = await direct(id, {
			content: exactText,
			extractionResponse: proposal([
				sliceFact({
					label: "Universal Memory Layer",
					category: "project",
					kind: "progress",
					text: exactText,
				}),
			]),
		});
		expect(exact.receipt.identity_decisions).toEqual([
			expect.objectContaining({ decision: "existing", node_id: "node-uml" }),
		]);

		const aliasText = "UML completed its indexing milestone.";
		const alias = await direct(id, {
			content: aliasText,
			extractionResponse: proposal([
				eventFact({
					label: "UML",
					category: "project",
					action: "completed",
					text: aliasText,
				}),
			]),
		});

		expect(alias.receipt.identity_decisions).toEqual([
			expect.objectContaining({ decision: "existing", node_id: "node-uml", matched_by: "UML" }),
		]);
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(await rows("slices", id)).toHaveLength(1);
		expect(await rows("events", id)).toHaveLength(1);
		const node = await one("nodes", id);
		expect(node.state).toBe("completed");
		expect(node.summary).toContain("UML completed its indexing milestone");
	});

	it("fails closed on a wrong existing-node hint and writes no graph objects", async () => {
		const id = userId("wrong-hint");
		await seedNode(id, "node-alpha", "Project Alpha");
		await seedNode(id, "node-beta", "Project Beta");
		const content = "Project Alpha launched today.";

		const result = await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({
					label: "Project Alpha",
					category: "project",
					action: "launched",
					text: content,
					existingNodeId: "node-beta",
				}),
			]),
		});

		expect(result).toMatchObject({
			status: "identity_conflict",
			fired: false,
			counts: { savedTotal: 0, nodes: 0, events: 0, candidates: 0 },
		});
		expect(result.identity_conflicts).toEqual([
			expect.objectContaining({ label: "Project Alpha", reason: "existing_node_hint_mismatch" }),
		]);
		expect(await rows("nodes", id)).toHaveLength(2);
		expect(await rows("events", id)).toHaveLength(0);
		expect(await rows("slices", id)).toHaveLength(0);
		expect(await rows("edges", id)).toHaveLength(0);
	});

	it("fails closed when an identity alias is tied between existing nodes", async () => {
		const id = userId("tied-alias");
		await seedNode(id, "node-one", "First Shared Service", { aliases: ["Shared Tool"], category: "tool" });
		await seedNode(id, "node-two", "Second Shared Service", { aliases: ["Shared Tool"], category: "tool" });
		const content = "Shared Tool launched today.";

		const result = await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Shared Tool", category: "tool", action: "launched", text: content }),
			]),
		});

		expect(result.status).toBe("identity_conflict");
		expect(result.identity_conflicts[0]).toMatchObject({
			label: "Shared Tool",
			reason: "multiple_existing_nodes_match",
		});
		expect(result.identity_conflicts[0].matches.map((match) => match.id).sort()).toEqual([
			"node-one",
			"node-two",
		]);
		expect(await rows("nodes", id)).toHaveLength(2);
		expect(await rows("events", id)).toHaveLength(0);
		expect(await rows("slices", id)).toHaveLength(0);
	});

	it("rejects facts and relationships supplied only by recent context", async () => {
		const id = userId("context-only");
		const content = "Remember this: it changed yesterday.";
		const contextOnly = "Project Atlas uses D1 for its database.";
		const result = await direct(id, {
			content,
			recentContext: contextOnly,
			extractionResponse: proposal(
				[sliceFact({
					label: "Project Atlas",
					category: "project",
					kind: "technical_detail",
					text: contextOnly,
				})],
				[{
					from: { label: "Project Atlas", category: "project", existing_node_id: null },
					to: { label: "D1", category: "tool", existing_node_id: null },
					type: "uses",
					text: contextOnly,
					confidence: 0.97,
				}],
			),
		});

		expect(result).toMatchObject({
			status: "ignored",
			counts: { savedTotal: 0, nodes: 0, slices: 0, edges: 0 },
		});
		expect(result.receipt.skipped).toBe(2);
		expect(result.receipt.skippedReasons.edge_not_in_submitted_content).toBe(1);
		expect(
			(result.receipt.skippedReasons.fact_not_in_submitted_content ?? 0) +
			(result.receipt.skippedReasons.identity_not_in_submitted_content ?? 0),
		).toBe(1);
		expect(await rows("nodes", id)).toHaveLength(0);
		expect(await rows("slices", id)).toHaveLength(0);
		expect(await rows("edges", id)).toHaveLength(0);
	});

	it("never creates a candidate when the manual extractor proposes one", async () => {
		const id = userId("candidate-prevention");
		const result = await direct(id, {
			content: "Maybe I should try piano someday.",
			extractionResponse: {
				objects: [{ kind: "candidate", label: "Piano", strength: "weak", confidence: 0.55 }],
				notes: "uncertain",
			},
		});

		expect(result).toMatchObject({
			status: "ignored",
			counts: { savedTotal: 0, candidates: 0 },
		});
		expect(result.receipt.skippedReasons).toMatchObject({ manual_candidate_disallowed: 1 });
		expect(await rows("candidates", id)).toHaveLength(0);
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("atomically resolves a matching pending candidate when manual memory creates the node", async () => {
		const id = userId("candidate-resolution");
		await seedPendingCandidate(id, "candidate-fencing", "Fencing");
		const content = "I started fencing today.";

		const result = await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Fencing", action: "started", text: content }),
			]),
		});

		expect(result).toMatchObject({
			status: "wrote",
			counts: { nodes: 1, events: 1, candidates: 0, resolvedCandidates: 1 },
		});
		const node = await one("nodes", id);
		const candidate = await one("candidates", id);
		expect(candidate).toMatchObject({
			id: "candidate-fencing",
			status: "promoted",
			promoted_object_id: node.id,
			promoted_object_kind: "node",
		});
		expect(candidate.reviewed_at).not.toBeNull();
		expect(result.receipt.actions.resolvedCandidates).toEqual([
			expect.objectContaining({ id: "candidate-fencing", node_id: node.id, status: "promoted" }),
		]);
	});

	it("reinforces repeated exact slices, events, and edges instead of duplicating them", async () => {
		const id = userId("reinforcement");
		const content = [
			"I am building Atlas.",
			"I started fencing.",
			"Atlas uses D1.",
		].join("\n");
		const extractionResponse = proposal(
			[
				sliceFact({ label: "Atlas", category: "project", kind: "progress", text: "I am building Atlas." }),
				eventFact({ label: "Fencing", category: "skill", action: "started", text: "I started fencing." }),
			],
			[{
				from: { label: "Atlas", category: "project", existing_node_id: null },
				to: { label: "D1", category: "tool", existing_node_id: null },
				type: "uses",
				text: "Atlas uses D1.",
				confidence: 0.98,
			}],
		);

		const first = await direct(id, { content, extractionResponse });
		expect(first.counts).toMatchObject({ nodes: 3, slices: 2, events: 1, edges: 1 });
		const second = await direct(id, { content, extractionResponse });

		expect(await rows("nodes", id)).toHaveLength(3);
		expect(await rows("slices", id)).toHaveLength(2);
		expect(await rows("events", id)).toHaveLength(1);
		expect(await rows("edges", id)).toHaveLength(1);
		const atlas = await one("nodes", id, "AND label = 'Atlas'");
		const atlasSlice = await one("slices", id, `AND node_id = '${atlas.id}'`);
		const event = await one("events", id);
		const edge = await one("edges", id);
		expect(atlasSlice.reinforcement_count).toBe(1);
		expect(event.reinforcement_count).toBe(1);
		expect(edge.reinforcement_count).toBe(1);
		expect(edge.evidence_count).toBe(2);
		expect(edge.weight).toBe(1.25);
		expect(second.counts).toMatchObject({
			nodes: 0,
			slices: 0,
			events: 0,
			edges: 0,
			reinforcedSlices: 1,
			reinforcedEvents: 1,
			reinforcedEdges: 1,
		});
	});

	it("supersedes the prior current preference on an explicit correction", async () => {
		const id = userId("preference-correction");
		const firstText = "My response style preference is concise responses.";
		await direct(id, {
			content: firstText,
			extractionResponse: proposal([
				sliceFact({
					label: "Response Style",
					category: "preference",
					kind: "preference",
					text: firstText,
				}),
			]),
		});
		const node = await one("nodes", id);
		const correctedText = "Actually, my response style preference is detailed responses instead.";
		const corrected = await direct(id, {
			content: correctedText,
			extractionResponse: proposal([
				sliceFact({
					label: "Response Style",
					category: "preference",
					kind: "preference",
					text: correctedText,
					existingNodeId: node.id,
					supersedes: true,
				}),
			]),
		});

		const savedSlices = await rows("slices", id, "ORDER BY created_at ASC, id ASC");
		expect(savedSlices).toHaveLength(2);
		expect(savedSlices.find((slice) => slice.text === firstText)?.is_current).toBe(0);
		expect(savedSlices.find((slice) => slice.text === correctedText)?.is_current).toBe(1);
		expect(corrected.receipt.saved.supersededSlices).toBe(1);
		const refreshed = await one("nodes", id);
		expect(refreshed.summary).toContain("detailed responses");
		expect(refreshed.summary).not.toContain("concise responses");
	});

	it("stores the source packet before honoring opt-out and returns a linked no-write receipt", async () => {
		const id = userId("opt-out-order");
		const result = await direct(id, {
			content: "Do not remember this: I started fencing.",
		});

		expect(result).toMatchObject({
			status: "no_write",
			fired: false,
			counts: { savedTotal: 0 },
			receipt: { opt_out: true, reason: "user_opt_out" },
		});
		const packet = await one("source_packets", id);
		const receipt = await one("receipts", id);
		expect(packet).not.toBeNull();
		expect(receipt).toMatchObject({
			source: "save_memory",
			outcome: "no_write",
			source_packet_id: packet.id,
		});
		expect(result.source_packet_id).toBe(packet.id);
		expect(packet.created_at).toBeLessThanOrEqual(receipt.created_at);
		expect(await rows("extraction_runs", id)).toHaveLength(0);
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("does not inspect, flush, or mutate a held USER_MEMORY chunk", async () => {
		const id = userId("held-isolation");
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(id));
		const held = await stub.addMessages(id, [{
			id: "held-one",
			role: "user",
			content: "The lake looked calm under grey clouds today.",
			ts: Date.now(),
		}], { flush: false });
		expect(held).toMatchObject({ fired: false, held: 1 });
		const before = await stub.getDebugState();

		const content = "I started pottery today.";
		const result = await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Pottery", category: "skill", action: "started", text: content }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect(await stub.getDebugState()).toEqual(before);
		expect(before).toEqual({ chunkSize: 1, checkpoint: null });
		expect(await rows("nodes", id)).toHaveLength(1);
	});

	it("uses recent context only to resolve a pronoun and never stores the context", async () => {
		const id = userId("reference-context");
		await seedNode(id, "node-boxing", "Boxing", { category: "skill", summary: "Existing boxing memory" });
		const content = "I stopped it yesterday.";
		const recentContext = "We were discussing Boxing and an assistant suggested a five-day training plan.";
		const result = await direct(id, {
			content,
			recentContext,
			extractionResponse: proposal([
				eventFact({
					label: "Boxing",
					category: "skill",
					action: "stopped",
					text: content,
					existingNodeId: "node-boxing",
				}),
			]),
		});

		expect(result.status).toBe("wrote");
		const node = await one("nodes", id);
		expect(node.state).toBe("inactive");
		expect(node.summary).toContain(content.slice(0, -1));
		expect(node.summary).not.toContain("five-day training plan");
		expect((await one("events", id)).text).toBe(content);
	});

	it("dedupes a safe slice paraphrase and an old one-off life event", async () => {
		const id = userId("paraphrase-old-event");
		const firstSlice = "Atlas stores durable memories in D1.";
		await direct(id, {
			content: firstSlice,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", kind: "technical_detail", text: firstSlice }),
			]),
		});
		const secondSlice = "Atlas stores durable memory in D1.";
		const paraphrase = await direct(id, {
			content: secondSlice,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", kind: "technical_detail", text: secondSlice }),
			]),
		});
		expect(await rows("slices", id)).toHaveLength(1);
		expect(paraphrase.counts.reinforcedSlices).toBe(1);

		const deathText = "My grandmother passed away.";
		await direct(id, {
			content: deathText,
			extractionResponse: proposal([
				eventFact({ label: "Grandmother", category: "family", action: "passed_away", text: deathText }),
			]),
		});
		await env.DB.prepare("UPDATE events SET created_at = ?, happened_at = ? WHERE user_id = ? AND action = 'passed_away'")
			.bind(Date.now() - 14 * 24 * 60 * 60 * 1000, Date.now() - 14 * 24 * 60 * 60 * 1000, id)
			.run();
		const repeated = await direct(id, {
			content: "My grandmother died.",
			extractionResponse: proposal([
				eventFact({ label: "Grandmother", category: "family", action: "passed_away", text: "My grandmother died." }),
			]),
		});
		const deathEvents = await rows("events", id, "AND action = 'passed_away'");
		expect(deathEvents).toHaveLength(1);
		expect(deathEvents[0].reinforcement_count).toBe(1);
		expect(repeated.counts.reinforcedEvents).toBe(1);
	});

	it("makes an explicit idempotency retry a no-op", async () => {
		const id = userId("direct-idempotency");
		const content = "I started archery.";
		const input = {
			content,
			idempotencyKey: "manual-archery-once",
			extractionResponse: proposal([
				eventFact({ label: "Archery", action: "started", text: content }),
			]),
		};
		expect((await direct(id, input)).status).toBe("wrote");
		const retry = await direct(id, input);
		expect(retry).toMatchObject({
			status: "skipped_duplicate",
			fired: false,
			counts: { savedTotal: 0 },
		});
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(await rows("events", id)).toHaveLength(1);
		expect((await one("events", id)).reinforcement_count ?? 0).toBe(0);
	});

	it("rolls back node, fact, summary, and candidate resolution on a late batch failure", async () => {
		const id = userId("atomic-rollback");
		await seedPendingCandidate(id, "candidate-climbing", "Climbing");
		const content = "I started climbing.";
		const result = await direct(id, {
			content,
			testFailAtomicWrite: true,
			extractionResponse: proposal([
				eventFact({ label: "Climbing", action: "started", text: content }),
			]),
		});
		expect(result).toMatchObject({
			ok: false,
			status: "db_write_failed",
			counts: { savedTotal: 0, nodes: 0, events: 0, resolvedCandidates: 0 },
		});
		expect(await rows("nodes", id)).toHaveLength(0);
		expect(await rows("events", id)).toHaveLength(0);
		expect(await rows("slices", id)).toHaveLength(0);
		expect(await rows("manual_node_identities", id)).toHaveLength(0);
		expect(await one("candidates", id)).toMatchObject({ status: "pending", promoted_object_id: null });
	});

	it("serializes concurrent creation of the same canonical identity", async () => {
		const id = userId("concurrent-identity");
		const content = "I started kayaking.";
		const input = {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Kayaking", action: "started", text: content }),
			]),
		};
		const results = await Promise.all([direct(id, input), direct(id, input)]);
		expect(results.every((result) => ["wrote", "identity_conflict"].includes(result.status))).toBe(true);
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(await rows("events", id)).toHaveLength(1);
		expect(await rows("manual_node_identities", id)).toHaveLength(1);
		const node = await one("nodes", id);
		expect((await one("events", id)).node_id).toBe(node.id);
	});

	it("is immediately visible through the existing recall command contract", async () => {
		const id = userId("immediate-recall");
		const content = "I started violin practice.";
		await direct(id, {
			content,
			extractionResponse: proposal([
				eventFact({ label: "Violin", action: "started", text: content }),
			]),
		});
		const recalled = await runRecallCommand(env, id, "violin", {});
		expect(recalled).toMatchObject({
			ok: true,
			command_mode: "recall",
			source: "recall",
			status: "recalled",
			counts: { nodes: 1 },
		});
		expect(recalled.context).toContain("Violin");
		expect(recalled.context).toContain("started violin practice");
	});
});

describe("MCP manual conversation engine", () => {
	it("returns a stored no-write receipt for a conversation with no durable user facts", async () => {
		const id = userId("conversation-no-durable");
		const result = await collect(id, {
			scope: "summary",
			messages: [
				{ role: "user", content: "Thanks!" },
				{ role: "user", content: "What time is it?" },
			],
		});
		expect(result).toMatchObject({
			status: "ignored",
			fired: false,
			counts: { savedTotal: 0, pages: 0, nodes: 0 },
		});
		expect(await rows("memory_pages", id)).toHaveLength(0);
		expect(await rows("nodes", id)).toHaveLength(0);
		expect(await rows("receipts", id)).toHaveLength(1);
	});

	it("atomically creates one memory page plus grounded graph facts with one combined receipt", async () => {
		const id = userId("conversation-combined");
		const digest = "The user is building Atlas with D1 for storage.";
		const messages = [
			{ id: "c1-user", role: "user", content: "I am building Atlas with D1 for storage." },
			{ id: "c1-assistant", role: "assistant", content: "That architecture sounds sensible." },
		];
		const extractionResponse = proposal(
			[sliceFact({ label: "Atlas", category: "project", kind: "progress", text: digest })],
			[{
				from: { label: "Atlas", category: "project", existing_node_id: null },
				to: { label: "D1", category: "tool", existing_node_id: null },
				type: "uses",
				text: digest,
				confidence: 0.98,
			}],
		);

		const result = await collect(id, {
			messages,
			conversationId: "conversation-combined",
			digestResponse: digest,
			extractionResponse,
		});

		expect(result).toMatchObject({
			status: "wrote",
			command_mode: "conversation_collect",
			source: "save_conversation",
			processing: false,
			counts: { pages: 1, nodes: 2, slices: 2, edges: 1, candidates: 0 },
			receipt: { page_action: "created", saved: { pages: 1, nodes: 2, edges: 1 } },
		});
		expect(result.summary).toMatch(/Created one memory page/);
		expect(result.summary).toContain("Saved graph:");
		const pages = await rows("memory_pages", id);
		const graphNodes = await rows("nodes", id);
		const graphEdges = await rows("edges", id);
		const receipts = await rows("receipts", id);
		expect(pages).toHaveLength(1);
		expect(graphNodes.map((node) => node.label).sort()).toEqual(["Atlas", "D1"]);
		expect(graphEdges).toHaveLength(1);
		expect(receipts).toHaveLength(1);
		expect(pages[0].receipt_id).toBe(receipts[0].id);
		expect(receipts[0]).toMatchObject({
			source: "save_conversation",
			saved_pages: 1,
			saved_nodes: 2,
			saved_edges: 1,
			source_packet_id: result.source_packet_id,
		});
		const detail = JSON.parse(receipts[0].detail);
		expect(detail.actions.createdPages).toHaveLength(1);
		expect(detail.actions.createdNodes).toHaveLength(2);
		expect(detail.actions.createdEdges).toHaveLength(1);
	});

	it("excludes assistant-only claims and digest hallucinations from both page and graph", async () => {
		const id = userId("conversation-grounding");
		const messages = [
			{ id: "ground-user", role: "user", content: "I am building Atlas." },
			{ id: "ground-assistant", role: "assistant", content: "You use Redis for caching." },
		];
		const groundedLine = "The user is building Atlas.";
		const hallucinatedLine = "The user uses Redis for caching.";
		const result = await collect(id, {
			messages,
			conversationId: "conversation-grounding",
			digestResponse: `${groundedLine}\n${hallucinatedLine}`,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", category: "project", kind: "progress", text: groundedLine }),
				sliceFact({ label: "Redis", category: "tool", kind: "technical_detail", text: hallucinatedLine }),
			]),
		});

		expect(result.status).toBe("wrote");
		expect(result.receipt.skippedReasons).toMatchObject({ identity_not_in_submitted_content: 1 });
		const graphNodes = await rows("nodes", id);
		expect(graphNodes.map((node) => node.label)).toEqual(["Atlas"]);
		const page = await one("memory_pages", id);
		expect(page.full_markdown).toContain("building Atlas");
		expect(page.full_markdown).not.toContain("Redis");
		expect(page.short_summary).not.toContain("Redis");
	});

	it("treats an exact conversation resend as a duplicate without duplicating page or graph", async () => {
		const id = userId("conversation-resend");
		const digest = "The user is building Atlas with D1 for storage.";
		const input = {
			messages: [
				{ id: "resend-user", role: "user", content: "I am building Atlas with D1 for storage." },
			],
			conversationId: "conversation-resend",
			digestResponse: digest,
			extractionResponse: proposal(
				[sliceFact({ label: "Atlas", category: "project", kind: "progress", text: digest })],
				[{
					from: { label: "Atlas", category: "project", existing_node_id: null },
					to: { label: "D1", category: "tool", existing_node_id: null },
					type: "uses",
					text: digest,
					confidence: 0.98,
				}],
			),
		};

		const first = await collect(id, input);
		expect(first.status).toBe("wrote");
		const second = await collect(id, input);

		expect(second).toMatchObject({
			status: "skipped_duplicate",
			fired: false,
			counts: { savedTotal: 0, pages: 0, nodes: 0, slices: 0, edges: 0 },
			receipt: { page_action: "duplicate", reason: "duplicate_memory_page" },
		});
		expect(await rows("memory_pages", id)).toHaveLength(1);
		expect(await rows("nodes", id)).toHaveLength(2);
		expect(await rows("slices", id)).toHaveLength(2);
		expect(await rows("edges", id)).toHaveLength(1);
		expect(await rows("receipts", id)).toHaveLength(2);
		const packet = await one("source_packets", id);
		expect(packet.seen_count).toBe(2);
	});

	it("reinforces one same-topic page while merging new graph detail", async () => {
		const id = userId("conversation-reinforce");
		const firstDigest = "Car mileage matters for the user's purchase research.";
		const first = await collect(id, {
			topic: "car",
			messages: [{ role: "user", content: "Car mileage matters for my purchase research." }],
			digestResponse: firstDigest,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: firstDigest }),
			]),
		});
		expect(first.receipt.page_action).toBe("created");

		const secondDigest = "Car service cost matters for the user's purchase research.";
		const second = await collect(id, {
			topic: "car",
			messages: [{ role: "user", content: "Car service cost also matters for my purchase research." }],
			digestResponse: secondDigest,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: secondDigest }),
			]),
		});
		expect(second).toMatchObject({
			status: "wrote",
			counts: { pages: 1, nodes: 0, slices: 1 },
			receipt: { page_action: "reinforced" },
		});
		expect(await rows("memory_pages", id)).toHaveLength(1);
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(await rows("slices", id)).toHaveLength(2);
		const page = await one("memory_pages", id);
		expect(page.full_markdown).toContain("Car mileage");
		expect(page.full_markdown).toContain("Car service cost");
	});

	it("applies topic and lastN scope to both the page and graph", async () => {
		const topicId = userId("conversation-topic-scope");
		const carLine = "Car mileage matters for purchase research.";
		const bikeLine = "Bike insurance matters for purchase research.";
		await collect(topicId, {
			scope: "topic",
			topic: "car",
			messages: [
				{ role: "user", content: carLine },
				{ role: "user", content: bikeLine },
			],
			digestResponse: `${carLine}\n${bikeLine}`,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: carLine }),
				sliceFact({ label: "Bike Research", category: "interest", kind: "other", text: bikeLine }),
			]),
		});
		expect((await rows("nodes", topicId)).map((node) => node.label)).toEqual(["Car Research"]);
		const topicPage = await one("memory_pages", topicId);
		expect(topicPage.full_markdown).toContain("Car mileage");
		expect(topicPage.full_markdown).not.toContain("Bike insurance");

		const lastId = userId("conversation-lastn-scope");
		const oldLine = "I started boxing.";
		const latestLine = "I started pottery.";
		await collect(lastId, {
			scope: "lastN",
			n: 1,
			messages: [
				{ role: "user", content: oldLine },
				{ role: "user", content: latestLine },
			],
			digestResponse: `${oldLine}\n${latestLine}`,
			extractionResponse: proposal([
				eventFact({ label: "Boxing", action: "started", text: oldLine }),
				eventFact({ label: "Pottery", action: "started", text: latestLine }),
			]),
		});
		expect((await rows("nodes", lastId)).map((node) => node.label)).toEqual(["Pottery"]);
		const lastPage = await one("memory_pages", lastId);
		expect(lastPage.full_markdown).toContain("pottery");
		expect(lastPage.full_markdown).not.toContain("boxing");
	});
});
