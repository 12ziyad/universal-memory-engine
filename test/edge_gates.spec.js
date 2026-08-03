/**
 * Part 6 — deterministic edge-quality gates on pass-2/3 output.
 * 6.1 evidence quote verified · 6.2 type-pair whitelist with direction ·
 * 6.5 valid_at sanity. All post-processing; no model calls anywhere here.
 */

import { describe, it, expect } from "vitest";
import { validateEdgeRows, verifyEdgeEvidence } from "../src/pipeline/engine_v2.js";

const ENTITIES = [
	{ n: 1, label: "Priya Nair", category: "person" },
	{ n: 2, label: "Meridian Labs", category: "organization" },
	{ n: 3, label: "Lisbon", category: "place" },
	{ n: 4, label: "Cabo Verde Shipping", category: "organization" },
];

const CORPUS = "Priya Nair started at Meridian Labs last month. The office is lovely.";

function run(rows, opts = {}) {
	return validateEdgeRows(rows, ENTITIES, { requireEvidence: true, sourceCorpus: CORPUS, ...opts });
}

describe("6.1 — the evidence gate", () => {
	it("accepts an edge whose evidence is verbatim and names both endpoints", () => {
		const { edges, rejected } = run([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT",
			fact: "Priya works at Meridian Labs",
			evidence: "Priya Nair started at Meridian Labs",
		}]);
		expect(edges).toHaveLength(1);
		expect(rejected).toHaveLength(0);
	});

	it("rejects a missing evidence quote", () => {
		const { edges, rejected } = run([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT", fact: "x",
		}]);
		expect(edges).toHaveLength(0);
		expect(rejected[0].reason).toBe("edge_no_evidence");
	});

	it("rejects an invented quote that is not in the messages", () => {
		const { rejected } = run([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT", fact: "x",
			evidence: "Priya Nair leads Meridian Labs analytics",
		}]);
		expect(rejected[0].reason).toBe("edge_evidence_not_verbatim");
	});

	it("rejects a co-mention quote that never names the second endpoint", () => {
		const { rejected } = run([{
			source_entity_id: 1, target_entity_id: 3, relation_type: "LIVES_IN", fact: "x",
			evidence: "The office is lovely",
		}]);
		expect(rejected[0].reason).toBe("edge_evidence_missing_endpoint");
	});

	it("canned test responses are exempt (requireEvidence off)", () => {
		const { edges } = validateEdgeRows(
			[{ source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT", fact: "x" }],
			ENTITIES,
		);
		expect(edges).toHaveLength(1);
	});
});

describe("6.2 — the type-pair whitelist", () => {
	const noEvidence = { requireEvidence: false };
	it("an organization cannot WORK_AT a place (the Cabo Verde bug)", () => {
		const { edges, rejected } = validateEdgeRows([{
			source_entity_id: 4, target_entity_id: 3, relation_type: "WORKS_AT", fact: "x",
		}], ENTITIES, noEvidence);
		expect(edges).toHaveLength(0);
		expect(rejected[0].reason).toBe("edge_type_pair_mismatch");
	});

	it("LOCATED_IN carries the same statement legally", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 4, target_entity_id: 3, relation_type: "LOCATED_IN", fact: "x",
		}], ENTITIES, noEvidence);
		expect(edges).toHaveLength(1);
	});

	it("MARRIED_TO must join two people", () => {
		const { rejected } = validateEdgeRows([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "MARRIED_TO", fact: "x",
		}], ENTITIES, noEvidence);
		expect(rejected[0].reason).toBe("edge_type_pair_mismatch");
	});

	it("novel relation types stay unconstrained (open vocabulary)", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 4, target_entity_id: 3, relation_type: "SHIPS_THROUGH", fact: "x",
		}], ENTITIES, noEvidence);
		expect(edges).toHaveLength(1);
	});
});

describe("6.5 — valid_at sanity", () => {
	const noEvidence = { requireEvidence: false, now: Date.parse("2026-08-03T00:00:00Z") };
	it("keeps a stated past date", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT", fact: "x",
			valid_at: "2026-07-01",
		}], ENTITIES, noEvidence);
		expect(edges[0].valid_at).toBe(Date.parse("2026-07-01T00:00:00Z"));
	});

	it("nulls a future date with no future-tense wording (hallucinated)", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT",
			fact: "Priya works at Meridian Labs", valid_at: "2026-11-15",
		}], ENTITIES, noEvidence);
		expect(edges[0].valid_at).toBeNull();
	});

	it("keeps a future date the words actually promise", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT",
			fact: "Priya will start at Meridian Labs in November", valid_at: "2026-11-15",
		}], ENTITIES, noEvidence);
		expect(edges[0].valid_at).toBe(Date.parse("2026-11-15T00:00:00Z"));
	});

	it("nulls an absurd far-future year regardless of wording", () => {
		const { edges } = validateEdgeRows([{
			source_entity_id: 1, target_entity_id: 2, relation_type: "WORKS_AT",
			fact: "will start", valid_at: "2094-01-01",
		}], ENTITIES, noEvidence);
		expect(edges[0].valid_at).toBeNull();
	});
});

describe("verifyEdgeEvidence unit seams", () => {
	it("is whitespace- and case-insensitive on the verbatim check", () => {
		expect(verifyEdgeEvidence("priya  nair STARTED at meridian labs", CORPUS, "Priya Nair", "Meridian Labs")).toBeNull();
	});
});
