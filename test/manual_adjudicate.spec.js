import { describe, expect, it } from "vitest";
import {
	adjudicateManualIdentities,
	buildManualAdjudicationPayload,
	decideManualIdentity,
} from "../src/pipeline/manual_adjudicate.js";

function entity(overrides = {}) {
	return { ref: "E0", label: "Atlas", category: "project", mention_role: "primary_subject", ...overrides };
}

function card(ref, identityScore, contextScore, reasons = [], overrides = {}) {
	return {
		ref,
		_node_id: `node-secret-${ref}`,
		label: `Atlas ${ref}`,
		category: "project",
		retrieval: { identity_score: identityScore, context_score: contextScore, reason_codes: reasons },
		...overrides,
	};
}

describe("manual identity adjudication", () => {
	it("serializes only bounded temporary card references and never UUIDs", () => {
		const payload = buildManualAdjudicationPayload({ entities: [entity()] }, [card("N0", 1, 1, ["exact_label"])]);
		const json = JSON.stringify(payload);
		expect(json).toContain('"ref":"N0"');
		expect(json).not.toContain("node-secret");
	});

	it("allows one authoritative exact identity and conflicts on duplicate exact claims", () => {
		expect(decideManualIdentity(entity(), [card("N0", 1, 0, ["exact_alias"])])).toMatchObject({
			decision: "merge_existing",
			selected_ref: "N0",
		});
		expect(decideManualIdentity(entity(), [
			card("N0", 1, 0, ["exact_claim"]),
			card("N1", 1, 0, ["exact_alias"]),
		])).toMatchObject({ decision: "identity_conflict" });
	});

	it("requires the deterministic identity threshold and margin", () => {
		expect(decideManualIdentity(entity(), [card("N0", 0.94, 0.1, ["name_variant"])]))
			.toMatchObject({ decision: "merge_existing", selected_ref: "N0" });
		expect(decideManualIdentity(entity(), [
			card("N0", 0.96, 0.1, ["name_variant"]),
			card("N1", 0.9, 0.1, ["name_variant"]),
		])).toMatchObject({ decision: "identity_conflict" });
	});

	it("never treats BM25, vectors, graph, or topic context as identity", () => {
		for (const reason of ["bm25", "vector", "graph", "topic"]) {
			expect(decideManualIdentity(entity(), [card("N0", 0, 0.99, [reason])]))
				.toMatchObject({ decision: "create_new" });
		}
	});

	it("rejects unknown and under-supported model recommendations", () => {
		const candidate = card("N0", 0.7, 0.9, ["bm25", "vector"]);
		expect(decideManualIdentity(entity(), [candidate], {
			decision: "merge_existing", selected_ref: "N9", confidence: 1,
		})).toMatchObject({ decision: "create_new", reason_codes: ["unknown_or_out_of_shortlist_recommendation"] });
		expect(decideManualIdentity(entity(), [candidate], {
			decision: "merge_existing", selected_ref: "N0", confidence: 0.94,
		})).toMatchObject({ decision: "create_new", reason_codes: ["semantic_recommendation_failed_policy"] });
	});

	it("rejects a high-confidence semantic alias supported only by contextual signals", () => {
		const contextualReasons = [
			"bm25", "vector", "fact_overlap", "graph_neighbor", "linked_page",
			"topic", "topic_community", "community", "cluster_context",
		];
		const result = decideManualIdentity(entity(), [card("N0", 0, 1, contextualReasons)], {
			decision: "merge_existing", selected_ref: "N0", confidence: 1,
		});
		expect(result).toMatchObject({
			decision: "create_new",
			reason_codes: ["semantic_recommendation_failed_policy"],
		});
	});

	it("accepts Red Devils as Manchester United only with a stored alias assertion and corroboration", () => {
		const result = decideManualIdentity(
			entity({ label: "Red Devils", category: "organization" }),
			[card("N0", 0.9, 0.8, ["stored_alias_assertion", "bm25", "fact_overlap"], {
				label: "Manchester United",
				category: "organization",
			})], {
			decision: "merge_existing", selected_ref: "N0", confidence: 0.97,
		});
		expect(result).toMatchObject({ decision: "merge_existing", selected_ref: "N0" });
	});

	it("does not confuse Manchester City or Manchester Airport context with Manchester United identity", () => {
		const submitted = entity({ label: "Manchester United", category: "organization" });
		const city = card("N0", 0.84, 0.99, ["shared_distinctive_core", "bm25", "graph_neighbor"], {
			label: "Manchester City",
			category: "organization",
		});
		const airport = card("N1", 0, 0.99, ["bm25", "linked_page"], {
			label: "Manchester Airport",
			category: "place",
		});
		expect(decideManualIdentity(submitted, [city, airport], {
			decision: "merge_existing", selected_ref: "N0", confidence: 0.99,
		})).toMatchObject({ decision: "create_new" });
		expect(decideManualIdentity(submitted, [city, airport], {
			decision: "merge_existing", selected_ref: "N1", confidence: 0.99,
		})).toMatchObject({ decision: "create_new" });
	});

	it("ignores comparison mentions before any identity write decision", async () => {
		const result = await adjudicateManualIdentities({}, { llm: {} }, {
			structure: { entities: [entity({ mention_role: "comparison" })] },
			cards: [card("N0", 1, 0, ["exact_label"])],
			adjudicationResponse: { identity_operations: [] },
		});
		expect(result.decisions).toEqual([]);
		expect(result.ignored_mentions).toHaveLength(1);
	});
});
