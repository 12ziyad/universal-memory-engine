import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { getConfig } from "../src/config.js";
import {
	ATOMIC_PROJECTION_SCHEMA,
	buildAtomicProjection,
	deriveAtomicProjectionDecisions,
	loadAtomicProjectionCandidates,
} from "../src/pipeline/atomic_projection.mjs";
import { runExtraction } from "../src/pipeline/extract.js";
import { deleteAllMemories } from "../src/pipeline/cleanup.js";
import {
	countSemanticAtomProjections,
	deleteSourceEpisodes,
	writeSourceEpisodes,
} from "../src/pipeline/episodes.js";

const RULES = { customInstructions: "", includes: [], excludes: [] };
const EMPTY_GRAPH = { objects: [], notes: "projection isolation control" };

function row(id, overrides = {}) {
	return {
		id,
		user_id: "projection-user",
		project_id: "projection-project",
		project_name: "Projection Project",
		capture_run_id: "atomrun-1",
		extraction_run_id: "extract-1",
		source_episode_id: "episode-1",
		source_packet_id: "packet-1",
		source_message_id: "m1",
		evidence_quote: "Northwind uses sqlc; no ORM",
		atom_type: "decision",
		entity: "Northwind",
		entity_type: "project",
		attribute: "database policy",
		value: "sqlc without an ORM",
		assertion: "Northwind uses sqlc and does not use an ORM.",
		raw_temporal_phrase: null,
		cardinality: "single",
		confidence: 0.97,
		event_time: null,
		event_time_precision: null,
		status: "candidate",
		...overrides,
	};
}

function treatmentEnv(userId) {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "allowlist",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: userId,
		USE_VECTORS: "false",
		ENABLE_PASS2: "false",
	};
}

function coalescingEnv(userId) {
	return {
		...treatmentEnv(userId),
		ITSUKI_MEMORY_V3_ATOMIC_COALESCING: "allowlist",
		ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS: userId,
	};
}

async function liveFixture(label, {
	userId = `projection-${label}-${crypto.randomUUID()}`,
	projectId = "projection-project",
	content = "Northwind uses sqlc; no ORM.",
	sourceTime = 1_762_250_400_000,
} = {}) {
	const sourcePacketId = `packet-${crypto.randomUUID()}`;
	const message = {
		id: "m1",
		role: "user",
		content,
		ts: sourceTime,
		source_time: { epoch_ms: sourceTime, offset_minutes: 0, precision: "second" },
	};
	const testEnv = treatmentEnv(userId);
	const episode = await writeSourceEpisodes(testEnv, userId, {
		sourcePacketId,
		messages: [message],
		projectId,
		projectName: "Projection Project",
		rules: RULES,
		acceptedAt: message.ts,
		required: true,
	});
	expect(episode).toMatchObject({ ok: true, written: 1 });
	return { userId, sourcePacketId, projectId, message, testEnv };
}

async function extract(f, extra = {}) {
	return runExtraction(f.testEnv, f.userId, [f.message], [], {
		llmResponse: EMPTY_GRAPH,
		atomicLlmResponse: {
			atoms: [{
				type: "decision",
				entity: "Northwind",
				entity_type: "project",
				attribute: "database policy",
				value: "sqlc without an ORM",
				assertion: "Northwind uses sqlc and does not use an ORM.",
				source_message_id: "m1",
				evidence_quote: "uses sqlc; no ORM",
				cardinality: "single",
				confidence: 0.97,
			}],
		},
		meta: {
			source_packet_id: f.sourcePacketId,
			accepted_at: f.message.ts,
			project_id: f.projectId,
			project_name: "Projection Project",
		},
		...extra,
	});
}

describe("E6 deterministic atomic projection", () => {
	it("maps candidates to governed node/assertion proposals and preserves exact provenance out of band", () => {
		const decision = row("atom-decision");
		const dayEvent = row("atom-day", {
			atom_type: "event",
			attribute: "moved",
			value: "Berlin",
			assertion: "Northwind moved to Berlin.",
			evidence_quote: "moved to Berlin yesterday",
			event_time: Date.UTC(2025, 10, 3, 12),
			event_time_precision: "day",
		});
		const yearEvent = row("atom-year", {
			atom_type: "event",
			attribute: "launched",
			value: "beta",
			assertion: "Northwind launched its beta in 2024.",
			evidence_quote: "launched its beta in 2024",
			event_time: Date.UTC(2024, 0, 1, 12),
			event_time_precision: "year",
		});

		const projected = buildAtomicProjection([decision, dayEvent, yearEvent]);
		expect(projected.schema).toBe(ATOMIC_PROJECTION_SCHEMA);
		expect(projected.objects.filter((object) => object.kind === "node")).toHaveLength(1);
		expect(projected.objects.filter((object) => object.kind === "slice")).toHaveLength(1);
		const events = projected.objects.filter((object) => object.kind === "event");
		expect(events).toHaveLength(2);
		expect(events.find((event) => projected.metadata.get(event).candidateIds.includes("atom-day"))).toMatchObject({
			action: "moved",
			date: "2025-11-03",
		});
		expect(events.find((event) => projected.metadata.get(event).candidateIds.includes("atom-year"))).not.toHaveProperty("date");
		expect(projected.metadata.get(projected.objects.find((object) => object.kind === "slice"))).toMatchObject({
			candidateIds: ["atom-decision"],
			evidenceQuote: decision.evidence_quote,
			sourceMessageIds: ["m1"],
		});
	});

	it("derives exactly one durable decision for every candidate from gate effects", () => {
		const candidates = [row("atom-new"), row("atom-touch"), row("atom-reject")];
		const plan = {
			newSlices: [{ id: "slice-new", _atomic_candidate_ids: ["atom-new"] }],
			sliceTouches: [{ id: "slice-existing", _atomic_candidate_ids: ["atom-touch"] }],
			rejected: [{ reason: "low_confidence", atomic_candidate_ids: ["atom-reject"] }],
		};
		const decisions = deriveAtomicProjectionDecisions(plan, candidates);
		expect(decisions).toEqual([
			expect.objectContaining({ candidateId: "atom-new", outcome: "promoted", objectKind: "slice", objectId: "slice-new" }),
			expect.objectContaining({ candidateId: "atom-touch", outcome: "reinforced", objectKind: "slice", objectId: "slice-existing" }),
			expect.objectContaining({ candidateId: "atom-reject", outcome: "ignored", reason: "low_confidence" }),
		]);
	});
});

describe("E6 projection persistence", () => {
	it("projects through the established gates and commits candidate provenance atomically", async () => {
		const f = await liveFixture("commit");
		const result = await extract(f);
		expect(result.outcome).toBe("wrote");
		expect(result.receipt).toMatchObject({
			atomic_projection_enabled: true,
			atomic_projection_outcome: "completed",
			atomic_projection_candidates: 1,
			atomic_projection_promoted: 1,
		});

		const candidate = await env.DB.prepare(
			"SELECT id, status FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(candidate.status).toBe("promoted");
		const projection = await env.DB.prepare(
			`SELECT candidate_id, outcome, object_kind, object_id, schema_version
			 FROM semantic_atom_projections WHERE user_id = ?`,
		).bind(f.userId).first();
		expect(projection).toMatchObject({
			candidate_id: candidate.id,
			outcome: "promoted",
			object_kind: "slice",
			schema_version: ATOMIC_PROJECTION_SCHEMA,
		});
		const slice = await env.DB.prepare(
			"SELECT text, source_snippet, project_id FROM slices WHERE id = ? AND user_id = ?",
		).bind(projection.object_id, f.userId).first();
		expect(slice).toEqual({
			text: "Northwind uses sqlc and does not use an ORM.",
			source_snippet: "uses sqlc; no ORM",
			project_id: f.projectId,
		});
	});

	it("coalesces a legacy and atomic copy inside one batch instead of doubling the fact", async () => {
		const f = await liveFixture("same-batch-dedupe");
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{
						kind: "slice", on: "Northwind", kind_detail: "decision",
						text: "Northwind uses sqlc and does not use an ORM.", confidence: 0.97,
					},
				],
				notes: "same fact from legacy lane",
			},
		});
		expect(result.outcome).toBe("wrote");
		const slices = await env.DB.prepare(
			"SELECT id, source_snippet FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(f.userId).all();
		expect(slices.results).toHaveLength(1);
		expect(slices.results[0].source_snippet).toBe("uses sqlc; no ORM");
		const projection = await env.DB.prepare(
			"SELECT object_id, outcome FROM semantic_atom_projections WHERE user_id = ?",
		).bind(f.userId).first();
		expect(projection).toEqual({ object_id: slices.results[0].id, outcome: "promoted" });
	});

	it("coalesces a conservative same-source legacy/atomic paraphrase and keeps projection provenance", async () => {
		const f = await liveFixture("same-source-paraphrase", {
			content: "Northwind's migration convention is additive: never use DROP COLUMN.",
		});
		f.testEnv = coalescingEnv(f.userId);
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{
						kind: "slice", on: "Northwind", kind_detail: "decision",
						text: "Migrations must be additive, with no DROP COLUMN.", confidence: 0.97,
					},
				],
				notes: "legacy paraphrase",
			},
			atomicLlmResponse: {
				atoms: [{
					type: "decision", entity: "Northwind", entity_type: "project",
					attribute: "migration convention", value: "additive, no DROP COLUMN",
					assertion: "Northwind's migration convention is additive with no DROP COLUMN.",
					source_message_id: "m1",
					evidence_quote: "migration convention is additive: never use DROP COLUMN",
					cardinality: "single", confidence: 0.97,
				}],
			},
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.atomic_projection_coalesced).toBe(1);
		const { results: slices } = await env.DB.prepare(
			"SELECT id, text, source_snippet, semantic_attribute FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(f.userId).all();
		expect(slices).toHaveLength(1);
		expect(slices[0]).toMatchObject({
			text: "Migrations must be additive, with no DROP COLUMN.",
			source_snippet: "migration convention is additive: never use DROP COLUMN",
			semantic_attribute: "migration convention",
		});
		const projection = await env.DB.prepare(
			"SELECT object_id, outcome FROM semantic_atom_projections WHERE user_id = ?",
		).bind(f.userId).first();
		expect(projection).toEqual({ object_id: slices[0].id, outcome: "promoted" });
	});

	it("keeps the established exact-only behavior when the E6M flag is off", async () => {
		const f = await liveFixture("same-source-control", {
			content: "Northwind's migration convention is additive: never use DROP COLUMN.",
		});
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{ kind: "slice", on: "Northwind", kind_detail: "decision", text: "Migrations must be additive, with no DROP COLUMN.", confidence: 0.97 },
				],
				notes: "E6 exact-only control",
			},
			atomicLlmResponse: {
				atoms: [{
					type: "decision", entity: "Northwind", entity_type: "project",
					attribute: "migration convention", value: "additive, no DROP COLUMN",
					assertion: "Northwind's migration convention is additive with no DROP COLUMN.",
					source_message_id: "m1", evidence_quote: "migration convention is additive: never use DROP COLUMN",
					cardinality: "single", confidence: 0.97,
				}],
			},
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.atomic_projection_coalescing_enabled).toBe(false);
		expect(result.receipt.atomic_projection_coalesced).toBe(0);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(f.userId).first();
		expect(Number(count.n)).toBe(2);
	});

	it("never coalesces distinct facts merely because they share one source message", async () => {
		const f = await liveFixture("same-source-distinct", {
			content: "Northwind stores data in D1 and deploys releases with Wrangler.",
		});
		f.testEnv = coalescingEnv(f.userId);
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{ kind: "slice", on: "Northwind", kind_detail: "technical_detail", text: "Northwind stores data in D1.", confidence: 0.97 },
				],
				notes: "one of two source facts",
			},
			atomicLlmResponse: {
				atoms: [{
					type: "procedure", entity: "Northwind", entity_type: "project",
					attribute: "deployment", value: "Wrangler",
					assertion: "Northwind deploys releases with Wrangler.",
					source_message_id: "m1", evidence_quote: "deploys releases with Wrangler",
					cardinality: "single", confidence: 0.97,
				}],
			},
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.atomic_projection_coalesced).toBe(0);
		const { results: slices } = await env.DB.prepare(
			"SELECT text FROM slices WHERE user_id = ? AND deleted_at IS NULL ORDER BY text",
		).bind(f.userId).all();
		expect(slices.map((item) => item.text)).toEqual([
			"Northwind deploys releases with Wrangler.",
			"Northwind stores data in D1.",
		]);
	});

	it("does not merge opposite-polarity assertions with high lexical overlap", async () => {
		const f = await liveFixture("polarity-split", {
			content: "Northwind does not use an ORM.",
		});
		f.testEnv = coalescingEnv(f.userId);
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{ kind: "slice", on: "Northwind", kind_detail: "decision", text: "Northwind uses an ORM.", confidence: 0.97 },
				],
				notes: "polarity protection",
			},
			atomicLlmResponse: {
				atoms: [{
					type: "decision", entity: "Northwind", entity_type: "project",
					attribute: "ORM policy", value: "no ORM",
					assertion: "Northwind does not use an ORM.", source_message_id: "m1",
					evidence_quote: "does not use an ORM", cardinality: "single", confidence: 0.97,
				}],
			},
		});
		expect(result.receipt.atomic_projection_coalesced).toBe(0);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM slices WHERE user_id = ? AND deleted_at IS NULL",
		).bind(f.userId).first();
		expect(Number(count.n)).toBe(2);
	});

	it("coalesces an event paraphrase only on matching source and action and preserves deterministic time", async () => {
		const sourceTime = Date.UTC(2025, 10, 4, 12);
		const f = await liveFixture("event-paraphrase", {
			content: "Northwind moved its headquarters to Berlin yesterday.",
			sourceTime,
		});
		f.testEnv = coalescingEnv(f.userId);
		const result = await extract(f, {
			llmResponse: {
				objects: [
					{ kind: "node", label: "Northwind", category: "project", confidence: 0.97 },
					{ kind: "event", on: "Northwind", action: "moved", text: "Northwind headquarters moved to Berlin.", importance: "ordinary", confidence: 0.97 },
				],
				notes: "legacy event paraphrase",
			},
			atomicLlmResponse: {
				atoms: [{
					type: "event", entity: "Northwind", entity_type: "project",
					attribute: "moved", value: "headquarters to Berlin",
					assertion: "Northwind moved its headquarters to Berlin.",
					source_message_id: "m1", evidence_quote: "moved its headquarters to Berlin yesterday",
					raw_temporal_phrase: "yesterday", cardinality: "single", confidence: 0.97,
				}],
			},
		});
		expect(result.outcome).toBe("wrote");
		expect(result.receipt.atomic_projection_coalesced).toBe(1);
		const { results: events } = await env.DB.prepare(
			`SELECT id, happened_at, happened_at_source, event_time_precision, event_time_relation
			 FROM events WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(f.userId).all();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			happened_at_source: "phrase",
			event_time_precision: "day",
			event_time_relation: "at",
		});
		expect(new Date(events[0].happened_at).toISOString().slice(0, 10)).toBe("2025-11-03");
		const projection = await env.DB.prepare(
			"SELECT object_id, object_kind, outcome FROM semantic_atom_projections WHERE user_id = ?",
		).bind(f.userId).first();
		expect(projection).toEqual({ object_id: events[0].id, object_kind: "event", outcome: "promoted" });
	});

	it("preserves deterministic year precision and records it as phrase-derived", async () => {
		const f = await liveFixture("year-precision", {
			content: "Northwind launched its beta in 2024.",
			sourceTime: Date.UTC(2025, 0, 20, 12),
		});
		const result = await extract(f, {
			atomicLlmResponse: {
				atoms: [{
					type: "event",
					entity: "Northwind",
					entity_type: "project",
					attribute: "launched",
					value: "beta",
					assertion: "Northwind launched its beta.",
					source_message_id: "m1",
					evidence_quote: "launched its beta in 2024",
					raw_temporal_phrase: "in 2024",
					cardinality: "single",
					confidence: 0.97,
				}],
			},
		});
		expect(result.outcome).toBe("wrote");
		const event = await env.DB.prepare(
			`SELECT happened_at, happened_at_source, event_time_precision, event_time_relation
			 FROM events WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(f.userId).first();
		expect(event).toMatchObject({
			happened_at_source: "phrase",
			event_time_precision: "year",
			event_time_relation: "at",
		});
		expect(new Date(event.happened_at).getUTCFullYear()).toBe(2024);
	});

	it("replays without duplicating either semantic state or its projection ledger", async () => {
		const f = await liveFixture("replay");
		expect((await extract(f)).outcome).toBe("wrote");
		await extract(f);
		const [slices, projections, candidates] = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS n FROM slices WHERE user_id = ? AND deleted_at IS NULL").bind(f.userId),
			env.DB.prepare("SELECT COUNT(*) AS n FROM semantic_atom_projections WHERE user_id = ?").bind(f.userId),
			env.DB.prepare("SELECT COUNT(*) AS n FROM semantic_atom_candidates WHERE user_id = ?").bind(f.userId),
		]);
		expect(Number(slices.results[0].n)).toBe(1);
		expect(Number(projections.results[0].n)).toBe(1);
		expect(Number(candidates.results[0].n)).toBe(1);
	});

	it("keeps multi-valued preferences current instead of blanket-retiring the same kind", async () => {
		const userId = `projection-multi-${crypto.randomUUID()}`;
		const savePreference = async (label, value) => {
			const f = await liveFixture(label, {
				userId,
				content: `Ziyad likes ${value}.`,
				sourceTime: Date.now(),
			});
			return extract(f, {
				atomicLlmResponse: {
					atoms: [{
						type: "preference", entity: "Ziyad", entity_type: "person",
						attribute: "hobby", value,
						assertion: `Ziyad likes ${value}.`, source_message_id: "m1",
						evidence_quote: `likes ${value}`, cardinality: "multi", confidence: 0.97,
					}],
				},
			});
		};
		expect((await savePreference("chess", "chess")).outcome).toBe("wrote");
		expect((await savePreference("hiking", "hiking")).outcome).toBe("wrote");
		const { results } = await env.DB.prepare(
			`SELECT text, semantic_attribute, semantic_cardinality, is_current
			 FROM slices WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at`,
		).bind(userId).all();
		expect(results).toHaveLength(2);
		expect(results.map((item) => item.text).sort()).toEqual(["Ziyad likes chess.", "Ziyad likes hiking."]);
		expect(results.every((item) => item.semantic_attribute === "hobby"
			&& item.semantic_cardinality === "multi" && item.is_current === 1)).toBe(true);
	});

	it("retires only the matching single-valued attribute and preserves unrelated state", async () => {
		const userId = `projection-single-${crypto.randomUUID()}`;
		const first = await liveFixture("single-first", {
			userId,
			content: "Northwind uses Postgres for its database and Redis for its cache.",
			sourceTime: Date.now() - 1_000,
		});
		expect((await extract(first, {
			atomicLlmResponse: {
				atoms: [
					{
						type: "fact", entity: "Northwind", entity_type: "project",
						attribute: "Database", value: "Postgres",
						assertion: "Northwind uses Postgres for its database.", source_message_id: "m1",
						evidence_quote: "uses Postgres for its database", cardinality: "single", confidence: 0.97,
					},
					{
						type: "fact", entity: "Northwind", entity_type: "project",
						attribute: "cache", value: "Redis",
						assertion: "Northwind uses Redis for its cache.", source_message_id: "m1",
						evidence_quote: "Redis for its cache", cardinality: "single", confidence: 0.97,
					},
				],
			},
		})).outcome).toBe("wrote");

		const second = await liveFixture("single-update", {
			userId,
			content: "Northwind now uses MySQL for its database.",
			sourceTime: Date.now(),
		});
		expect((await extract(second, {
			atomicLlmResponse: {
				atoms: [{
					type: "fact", entity: "Northwind", entity_type: "project",
					attribute: "database", value: "MySQL",
					assertion: "Northwind uses MySQL for its database.", source_message_id: "m1",
					evidence_quote: "now uses MySQL for its database", cardinality: "single", confidence: 0.97,
				}],
			},
		})).outcome).toBe("wrote");

		const { results } = await env.DB.prepare(
			`SELECT text, semantic_attribute, is_current FROM slices
			 WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at`,
		).bind(userId).all();
		expect(results).toHaveLength(3);
		expect(results.find((item) => item.text.includes("Postgres"))?.is_current).toBe(0);
		expect(results.find((item) => item.text.includes("MySQL"))?.is_current).toBe(1);
		expect(results.find((item) => item.text.includes("Redis"))?.is_current).toBe(1);
	});

	it("leaves the candidate write-only when the nested projection flag is off", async () => {
		const f = await liveFixture("control");
		f.testEnv = {
			...f.testEnv,
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "",
		};
		const result = await extract(f);
		expect(result.outcome).toBe("meaningful_no_write");
		expect(result.receipt.atomic_projection_enabled).toBe(false);
		const candidate = await env.DB.prepare(
			"SELECT status FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(candidate.status).toBe("candidate");
	});

	it("cannot load a candidate through another tenant or project scope", async () => {
		const f = await liveFixture("scope-load");
		f.testEnv = {
			...f.testEnv,
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "",
		};
		await extract(f);
		const run = await env.DB.prepare(
			"SELECT capture_run_id FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(await loadAtomicProjectionCandidates(env, {
			userId: f.userId,
			projectId: "another-project",
			captureRunIds: [run.capture_run_id],
		})).toEqual([]);
		expect(await loadAtomicProjectionCandidates(env, {
			userId: `${f.userId}-other-tenant`,
			projectId: f.projectId,
			captureRunIds: [run.capture_run_id],
		})).toEqual([]);
		expect(await loadAtomicProjectionCandidates(env, {
			userId: f.userId,
			projectId: f.projectId,
			captureRunIds: [run.capture_run_id],
		})).toHaveLength(1);
	});

	it("erases projection records with candidates and source episodes", async () => {
		const f = await liveFixture("erase");
		await extract(f);
		const deletion = await deleteSourceEpisodes(env, f.userId);
		expect(deletion).toMatchObject({
			deleted: 1,
			atomicCandidatesDeleted: 1,
			atomicProjectionsDeleted: 1,
		});
		const projection = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_projections WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(projection.n)).toBe(0);
	});

	it("converges the projection ledger to zero during complete account erasure", async () => {
		const f = await liveFixture("erase-all");
		await extract(f);
		const deletion = await deleteAllMemories(env, f.userId, "DELETE ALL");
		expect(deletion.deleted).toBe(true);
		for (const table of [
			"semantic_atom_projections",
			"semantic_atom_candidates",
			"semantic_atom_capture_runs",
			"source_episodes",
			"slices",
		]) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
				.bind(f.userId).first();
			expect(Number(row.n), table).toBe(0);
		}
	});

	it("never treats an unreadable projection ledger as zero during erasure", async () => {
		const broken = {
			...env,
			DB: {
				prepare(sql) {
					if (String(sql).includes("COUNT(*) AS n FROM semantic_atom_projections")) {
						return { bind: () => ({ first: async () => { throw new Error("D1 projection read unavailable"); } }) };
					}
					return env.DB.prepare(sql);
				},
			},
		};
		await expect(countSemanticAtomProjections(broken, "projection-erasure-fail-closed"))
			.rejects.toThrow("D1 projection read unavailable");
	});
});
