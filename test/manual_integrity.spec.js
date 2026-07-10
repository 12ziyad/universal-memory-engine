import { describe, expect, it } from "vitest";

import { applyManualIntegrity } from "../src/pipeline/manual_integrity.js";

function fact(label, memory) {
	return {
		identity: { label, category: "project", existing_node_id: null, aliases: [] },
		memory,
		confidence: 0.95,
		supersedes: false,
	};
}

describe("MCP manual integrity gate", () => {
	it("rejects a hallucinated predicate/value that shares only the identity token", () => {
		const result = applyManualIntegrity({
			facts: [fact("Atlas", { kind: "slice", slice_kind: "other", text: "Atlas is profitable." })],
			relationships: [],
		}, {
			submittedContent: "I started Atlas today.",
			recentContext: "",
		});

		expect(result.facts).toHaveLength(0);
		expect(result.rejected).toEqual([
			expect.objectContaining({ label: "Atlas", reason: "fact_not_in_submitted_content" }),
		]);
	});

	it("accepts conservative predicate paraphrases only when their value is grounded", () => {
		const result = applyManualIntegrity({
			facts: [fact("Boxing", { kind: "event", action: "started", text: "The user began boxing.", importance: "ordinary" })],
			relationships: [],
		}, {
			submittedContent: "I started boxing.",
			recentContext: "",
		});

		expect(result.facts).toHaveLength(1);
	});

	it("requires a grounded relationship predicate, not merely two mentioned endpoints", () => {
		const relationship = {
			from: { label: "Atlas", category: "project" },
			to: { label: "D1", category: "tool" },
			type: "uses",
			text: "Atlas uses D1.",
			confidence: 0.95,
		};
		const rejected = applyManualIntegrity({ facts: [], relationships: [relationship] }, {
			submittedContent: "Atlas and D1 were discussed separately.",
			recentContext: "",
		});
		const accepted = applyManualIntegrity({ facts: [], relationships: [relationship] }, {
			submittedContent: "Atlas uses D1.",
			recentContext: "",
		});

		expect(rejected.relationships).toHaveLength(0);
		expect(rejected.rejected[0]).toMatchObject({ reason: "edge_not_in_submitted_content" });
		expect(accepted.relationships).toHaveLength(1);
	});
});
