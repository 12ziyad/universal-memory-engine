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
import { archiveObject } from "../src/pipeline/cleanup.js";

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

function writeBarrier(expected = 2) {
	let arrived = 0;
	let release;
	const ready = new Promise((resolve) => { release = resolve; });
	return async () => {
		arrived++;
		if (arrived === expected) release();
		await ready;
	};
}

function envWithReceiptFailure() {
	return {
		...env,
		DB: {
			prepare(sql) {
				if (/^\s*INSERT\s+INTO\s+receipts\b/i.test(String(sql))) {
					return {
						bind() {
							return { run: async () => { throw new Error("forced receipt failure"); } };
						},
					};
				}
				return env.DB.prepare(sql);
			},
			batch(statements) {
				return env.DB.batch(statements);
			},
		},
	};
}

function envThatRejectsPostCommitSelects() {
	let batches = 0;
	let graphCommitted = false;
	return {
		...env,
		DB: {
			prepare(sql) {
				if (graphCommitted && /^\s*SELECT\b/i.test(String(sql))) {
					throw new Error("post-commit SELECT must not run");
				}
				return env.DB.prepare(sql);
			},
			async batch(statements) {
				const result = await env.DB.batch(statements);
				batches++;
				if (batches >= 2) graphCommitted = true;
				return result;
			},
		},
	};
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

	it("extracts a building-with sentence into the project and tool relationship without overcapturing the identity", async () => {
		const id = userId("compound-building");
		const result = await direct(id, { content: "I am building Atlas with D1 for storage." });

		expect(result).toMatchObject({ status: "wrote", counts: { nodes: 2, edges: 1 } });
		expect((await rows("nodes", id)).map((node) => node.label).sort()).toEqual(["Atlas", "D1"]);
		expect((await one("edges", id))).toMatchObject({ type: "uses" });
	});

	it("corrects an existing relationship in place without creating sentence or negated nodes", async () => {
		const id = userId("relationship-correction");
		await direct(id, { content: "Blue Lantern uses Rust." });
		const project = await one("nodes", id, "AND label = 'Blue Lantern'");
		const rust = await one("nodes", id, "AND label = 'Rust'");
		const oldEdge = await one("edges", id, "AND deleted_at IS NULL");

		const corrected = await direct(id, {
			content: "Correction: My test project Blue Lantern uses Go, not Rust.",
		});

		expect(corrected).toMatchObject({
			status: "wrote",
			counts: { nodes: 1, edges: 1, supersededEdges: 1 },
			receipt: {
				actions: {
					corrections: [expect.objectContaining({
						subject_node_id: project.id,
						old_target_node_id: rust.id,
						history_text: "Technology corrected from Rust to Go.",
					})],
				},
			},
		});
		const nodes = await rows("nodes", id);
		expect(nodes.map((node) => node.label).sort()).toEqual(["Blue Lantern", "Go", "Rust"]);
		expect(nodes.some((node) => /^(?:correction|not\b)/i.test(node.label))).toBe(false);
		const activeEdge = await one("edges", id, "AND deleted_at IS NULL");
		const go = nodes.find((node) => node.label === "Go");
		expect(activeEdge).toMatchObject({ from_node: project.id, to_node: go.id, type: "uses" });
		expect(await one("edges", id, `AND id = '${oldEdge.id}'`)).toMatchObject({
			from_node: project.id,
			to_node: rust.id,
		});
		expect((await one("edges", id, `AND id = '${oldEdge.id}'`)).deleted_at).not.toBeNull();
		expect(await one("events", id, "AND action = 'changed_plan'"))
			.toMatchObject({ node_id: project.id, text: "Technology corrected from Rust to Go." });
		expect(await rows("slices", id, `AND node_id = '${project.id}' AND is_current = 1`))
			.toEqual([expect.objectContaining({ text: "Blue Lantern uses Go." })]);
		expect((await one("nodes", id, "AND label = 'Blue Lantern'")).summary)
			.toMatch(/^Blue Lantern: Blue Lantern uses Go\./);
	});

	it("reinforces a repeated correction and can later reverse it without duplicate identities", async () => {
		const id = userId("correction-idempotency");
		await direct(id, { content: "Blue Lantern uses Rust." });
		const correction = "Correction: Blue Lantern uses Go, not Rust.";
		await direct(id, { content: correction });
		const repeated = await direct(id, { content: correction });

		expect(await rows("nodes", id)).toHaveLength(3);
		expect(await rows("edges", id)).toHaveLength(2);
		expect(await rows("events", id, "AND action = 'changed_plan'")).toHaveLength(1);
		expect(repeated.counts).toMatchObject({
			nodes: 0,
			edges: 0,
			supersededEdges: 0,
			reinforcedEvents: 1,
			reinforcedEdges: 1,
		});
		expect(repeated.receipt.actions.corrections[0].replacement_edge_id).toBeTruthy();

		const reversed = await direct(id, {
			content: "Actually, Blue Lantern uses Rust instead of Go.",
		});
		expect(reversed.counts).toMatchObject({ nodes: 0, edges: 1, supersededEdges: 1 });
		expect(await rows("nodes", id)).toHaveLength(3);
		const project = await one("nodes", id, "AND label = 'Blue Lantern'");
		const rust = await one("nodes", id, "AND label = 'Rust'");
		expect(await one("edges", id, "AND deleted_at IS NULL")).toMatchObject({
			from_node: project.id,
			to_node: rust.id,
			type: "uses",
		});
	});

	it("fails closed on an ambiguous correction subject and creates no replacement identity", async () => {
		const id = userId("ambiguous-correction");
		await seedNode(id, "node-blue-one", "First Blue Project", { aliases: ["Blue Lantern"] });
		await seedNode(id, "node-blue-two", "Second Blue Project", { aliases: ["Blue Lantern"] });
		await seedNode(id, "node-rust", "Rust", { category: "tool" });

		const result = await direct(id, {
			content: "Correction: Blue Lantern uses Go, not Rust.",
		});

		expect(result).toMatchObject({ status: "identity_conflict", fired: false });
		expect(result.identity_conflicts).toEqual([
			expect.objectContaining({ label: "Blue Lantern", reason: "multiple_existing_nodes_match" }),
		]);
		expect((await rows("nodes", id)).map((node) => node.label).sort()).toEqual([
			"First Blue Project",
			"Rust",
			"Second Blue Project",
		]);
		expect(await rows("edges", id)).toHaveLength(0);
	});

	it("uses a grounded AI noun phrase for a genuinely new sentence-shaped identity", async () => {
		const id = userId("ai-manual-title");
		let modelCalls = 0;
		const titleEnv = {
			...env,
			AI: {
				async run() {
					modelCalls++;
					return { response: JSON.stringify({ title: "Solar Finch" }) };
				},
			},
		};
		const content = "Remember that my project is called Solar Finch.";
		const result = await runMcpDirectSaveCommand(titleEnv, null, id, {
			content,
			extractionResponse: proposal([
				sliceFact({
					label: "Remember that my project is called Solar Finch",
					category: "project",
					kind: "progress",
					text: content,
				}),
			]),
		});

		expect(result).toMatchObject({ status: "wrote", counts: { nodes: 1, slices: 1 } });
		expect(modelCalls).toBe(1);
		expect(await one("nodes", id)).toMatchObject({ label: "Solar Finch", canonical_label: "solar finch" });
	});

	it("combines heuristic and model extraction for mixed recognized and unrecognized facts", async () => {
		const id = userId("mixed-extraction");
		let modelCalls = 0;
		const mixedEnv = {
			...env,
			AI: {
				async run() {
					modelCalls++;
					return { response: JSON.stringify(proposal([
						sliceFact({ label: "Luna", category: "family", kind: "other", text: "My dog is named Luna." }),
					])) };
				},
			},
		};
		const result = await runMcpDirectSaveCommand(mixedEnv, null, id, {
			content: "I started boxing. My dog is named Luna.",
		});

		expect(modelCalls).toBe(1);
		expect(result.status).toBe("wrote");
		expect((await rows("nodes", id)).map((node) => node.label).sort()).toEqual(["Boxing", "Luna"]);
	});

	it("returns an identity conflict when a pronoun has multiple recent-context referents", async () => {
		const id = userId("ambiguous-pronoun");
		await seedNode(id, "node-atlas-context", "Atlas");
		await seedNode(id, "node-beacon-context", "Beacon");
		const content = "I stopped it.";
		const result = await direct(id, {
			content,
			recentContext: "Atlas is one project. Beacon is another project.",
			extractionResponse: proposal([
				eventFact({ label: "Atlas", action: "stopped", text: content, existingNodeId: "node-atlas-context" }),
			]),
		});

		expect(result).toMatchObject({ status: "identity_conflict", fired: false, counts: { savedTotal: 0 } });
		expect(result.identity_conflicts[0]).toMatchObject({ reason: "ambiguous_reference_context" });
		expect(await one("nodes", id, "AND id = 'node-atlas-context'")).toMatchObject({ state: "active" });
	});

	it("atomically dedupes concurrent identical facts on an existing node and reinforces the winner", async () => {
		const id = userId("concurrent-existing-fact");
		await seedNode(id, "node-atlas-existing", "Atlas");
		const content = "Atlas storage is encrypted.";
		const barrier = writeBarrier();
		const input = {
			content,
			testBeforeWrite: barrier,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", kind: "other", text: content, existingNodeId: "node-atlas-existing" }),
			]),
		};
		const results = await Promise.all([direct(id, input), direct(id, input)]);

		expect(results.every((result) => result.status === "wrote")).toBe(true);
		expect(results.map((result) => result.counts.slices).sort()).toEqual([0, 1]);
		expect(results.map((result) => result.counts.reinforcedSlices).sort()).toEqual([0, 1]);
		const slices = await rows("slices", id);
		expect(slices).toHaveLength(1);
		expect(slices[0].reinforcement_count).toBe(1);
		expect(await rows("manual_fact_identities", id)).toHaveLength(1);
	});

	it("keeps the concurrent winner current when identical preference corrections race", async () => {
		const id = userId("concurrent-preference");
		await seedNode(id, "node-dark-mode", "Dark Mode", { category: "preference" });
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind("slice-old-theme", id, "node-dark-mode", "I preferred light mode.", "preference", 1, now, now).run();
		const content = "I now prefer dark mode.";
		const barrier = writeBarrier();
		const input = {
			content,
			testBeforeWrite: barrier,
			extractionResponse: proposal([
				sliceFact({
					label: "Dark Mode",
					category: "preference",
					kind: "preference",
					text: content,
					existingNodeId: "node-dark-mode",
					supersedes: true,
				}),
			]),
		};
		await Promise.all([direct(id, input), direct(id, input)]);

		const current = await rows("slices", id, "AND is_current = 1");
		expect(current).toHaveLength(1);
		expect(current[0]).toMatchObject({ text: content, reinforcement_count: 1 });
	});

	it("allows exactly one concurrent caller to own an explicit idempotency key", async () => {
		const id = userId("concurrent-idempotency");
		const content = "I started rowing.";
		const input = {
			content,
			idempotencyKey: "rowing-once",
			extractionResponse: proposal([eventFact({ label: "Rowing", action: "started", text: content })]),
		};
		const results = await Promise.all([direct(id, input), direct(id, input)]);

		expect(results.map((result) => result.status).sort()).toEqual(["skipped_duplicate", "wrote"]);
		expect(await rows("events", id)).toHaveLength(1);
		expect(await one("source_packets", id)).toMatchObject({ seen_count: 2 });
	});

	it("does not perform a fallible reconciliation SELECT after a successful graph commit", async () => {
		const id = userId("no-post-commit-probe");
		const content = "I started fencing.";
		const result = await runMcpDirectSaveCommand(envThatRejectsPostCommitSelects(), null, id, {
			content,
			extractionResponse: proposal([eventFact({ label: "Fencing", action: "started", text: content })]),
		});

		expect(result).toMatchObject({ ok: true, status: "wrote", receipt_persisted: true });
		expect(await rows("events", id)).toHaveLength(1);
	});

	it("releases manual identity and fact claims when a node is archived", async () => {
		const id = userId("archive-claim-release");
		const content = "I started hiking.";
		const input = {
			content,
			extractionResponse: proposal([eventFact({ label: "Hiking", action: "started", text: content })]),
		};
		await direct(id, input);
		const first = await one("nodes", id);
		await archiveObject(env, id, { kind: "node", id: first.id });
		const second = await direct(id, input);

		expect(second.status).toBe("wrote");
		expect(await rows("nodes", id)).toHaveLength(2);
		expect(await rows("nodes", id, "AND archived_at IS NULL")).toHaveLength(1);
		expect(await rows("manual_node_identities", id)).toHaveLength(1);
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

	it("updates the existing canonical page and graph when a conversation corrects a relationship", async () => {
		const id = userId("conversation-correction");
		const original = "Blue Lantern uses Rust.";
		const first = await collect(id, {
			messages: [{ role: "user", content: original }],
			conversationId: "blue-lantern-original",
			digestResponse: original,
		});
		expect(first).toMatchObject({ status: "wrote", counts: { pages: 1, nodes: 2, edges: 1 } });
		const originalPage = await one("memory_pages", id);
		expect(originalPage.title).toBe("Blue Lantern");

		const correction = "Correction: My test project Blue Lantern uses Go, not Rust.";
		const second = await collect(id, {
			messages: [{ role: "user", content: correction }],
			conversationId: "blue-lantern-correction",
			digestResponse: correction,
		});

		expect(second).toMatchObject({
			status: "wrote",
			counts: { pages: 1, nodes: 1, edges: 1, supersededEdges: 1 },
			receipt: { page_action: "updated" },
		});
		expect(await rows("memory_pages", id)).toHaveLength(1);
		const page = await one("memory_pages", id);
		expect(page.id).toBe(originalPage.id);
		expect(page.title).toBe("Blue Lantern");
		expect(JSON.parse(page.key_points_json)).toEqual(["Blue Lantern uses Go."]);
		expect(JSON.parse(page.decisions_json)).toContain("Technology corrected from Rust to Go.");
		expect(page.short_summary).toContain("Blue Lantern uses Go");
		expect(page.short_summary).not.toContain("uses Rust");
		expect(await rows("nodes", id, "AND label LIKE 'Correction%'")).toHaveLength(0);
		expect(await rows("nodes", id, "AND label LIKE 'not %'")).toHaveLength(0);
		expect(await rows("edges", id, "AND deleted_at IS NULL")).toHaveLength(1);
	});

	it("excludes assistant-only claims and digest hallucinations from both page and graph", async () => {
		const id = userId("conversation-grounding");
		const messages = [
			{ id: "ground-user", role: "user", content: "I am building Atlas." },
			{ id: "ground-assistant", role: "assistant", content: "You use Redis for caching." },
		];
		const groundedLine = "The user is building Atlas.";
		const hallucinatedLine = "The user is building Atlas with Redis.";
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

	it("continues the graph lane for a duplicate page so missing facts and candidates can be repaired", async () => {
		const id = userId("duplicate-page-repair");
		const line = "My dog is named Luna.";
		const base = {
			messages: [{ id: "luna-user", role: "user", content: line }],
			conversationId: "duplicate-page-repair",
			digestResponse: line,
		};
		const first = await collect(id, { ...base, extractionResponse: proposal() });
		expect(first).toMatchObject({ status: "wrote", counts: { pages: 1, nodes: 0 } });
		await seedPendingCandidate(id, "candidate-luna-repair", "Luna");

		const second = await collect(id, {
			...base,
			extractionResponse: proposal([
				sliceFact({ label: "Luna", category: "family", kind: "other", text: line }),
			]),
		});

		expect(second).toMatchObject({
			status: "wrote",
			counts: { pages: 0, nodes: 1, slices: 1, resolvedCandidates: 1 },
			receipt: { page_action: "duplicate" },
		});
		expect(await rows("memory_pages", id)).toHaveLength(1);
		expect((await rows("nodes", id)).map((node) => node.label)).toEqual(["Luna"]);
		expect(await one("candidates", id)).toMatchObject({ status: "promoted" });
	});

	it("keeps graph extraction independent when the matching memory page is suppressed", async () => {
		const id = userId("suppressed-page-graph");
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO memory_suppressions
				(id, user_id, kind, canonical_key, label, reason, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind("suppress-car-page", id, "memory_page", "car", "car", "test_suppression", now).run();
		const line = "Car service cost matters for purchase research.";
		const result = await collect(id, {
			topic: "car",
			messages: [{ role: "user", content: line }],
			digestResponse: line,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: line }),
			]),
		});

		expect(result).toMatchObject({
			status: "wrote",
			counts: { pages: 0, nodes: 1, slices: 1 },
			receipt: { page_action: "suppressed" },
		});
		expect(await rows("memory_pages", id)).toHaveLength(0);
		expect((await rows("nodes", id)).map((node) => node.label)).toEqual(["Car Research"]);
	});

	it("returns a truthful non-persisted receipt and leaves no dangling page receipt id when receipt storage fails", async () => {
		const id = userId("receipt-failure");
		const line = "I am building Atlas with D1 for storage.";
		const result = await runMcpConversationCollectCommand(envWithReceiptFailure(), null, id, {
			messages: [{ role: "user", content: line }],
			conversationId: "receipt-failure",
			digestResponse: line,
			extractionResponse: proposal(
				[sliceFact({ label: "Atlas", kind: "progress", text: line })],
				[{
					from: { label: "Atlas", category: "project" },
					to: { label: "D1", category: "tool" },
					type: "uses",
					text: line,
					confidence: 0.98,
				}],
			),
		});

		expect(result).toMatchObject({
			ok: true,
			status: "wrote",
			receipt_id: null,
			receipt_persisted: false,
			warnings: ["receipt_persistence_failed"],
		});
		expect(result.summary).toContain("Receipt persistence failed");
		expect(await rows("receipts", id)).toHaveLength(0);
		expect(await one("memory_pages", id)).toMatchObject({ receipt_id: null });
	});

	it("atomically claims one page during concurrent first saves", async () => {
		const id = userId("concurrent-page-create");
		const line = "I am building Atlas.";
		const barrier = writeBarrier();
		const input = {
			messages: [{ role: "user", content: line }],
			conversationId: "concurrent-page-create",
			digestResponse: line,
			testBeforeWrite: barrier,
			extractionResponse: proposal([
				sliceFact({ label: "Atlas", kind: "progress", text: line }),
			]),
		};
		const results = await Promise.all([collect(id, input), collect(id, input)]);

		expect(results.map((result) => result.counts.pages).sort()).toEqual([0, 1]);
		expect(await rows("memory_pages", id)).toHaveLength(1);
		expect(await rows("manual_page_identities", id)).toHaveLength(1);
		expect(await rows("nodes", id)).toHaveLength(1);
		expect(results.some((result) => result.receipt.skippedReasons.concurrent_page_claim === 1)).toBe(true);
	});

	it("reports a concurrent page reinforcement conflict instead of silently overwriting stale merged content", async () => {
		const id = userId("concurrent-page-update");
		const baseLine = "Car mileage matters for purchase research.";
		await collect(id, {
			topic: "car",
			messages: [{ role: "user", content: baseLine }],
			digestResponse: baseLine,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: baseLine }),
			]),
		});

		const lines = [
			"Car service cost matters for purchase research.",
			"Car resale value matters for purchase research.",
		];
		const barrier = writeBarrier();
		const inputs = lines.map((line) => ({
			topic: "car",
			messages: [{ role: "user", content: line }],
			digestResponse: line,
			testBeforeWrite: barrier,
			extractionResponse: proposal([
				sliceFact({ label: "Car Research", category: "interest", kind: "other", text: line }),
			]),
		}));
		const results = await Promise.all(inputs.map((input) => collect(id, input)));

		expect(results.map((result) => result.counts.pages).sort()).toEqual([0, 1]);
		const losingIndex = results.findIndex((result) => result.counts.pages === 0);
		expect(results[losingIndex]).toMatchObject({
			status: "wrote_with_page_conflict",
			receipt: { skippedReasons: { concurrent_page_update: 1 } },
		});
		await collect(id, { ...inputs[losingIndex], testBeforeWrite: undefined });
		const page = await one("memory_pages", id);
		expect(page.full_markdown).toContain(lines[0]);
		expect(page.full_markdown).toContain(lines[1]);
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
