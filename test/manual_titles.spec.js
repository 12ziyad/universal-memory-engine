import { describe, expect, it } from "vitest";

import { refineManualIdentityTitles } from "../src/pipeline/manual_titles.js";

const config = {
	llm: {
		summaryModel: "test-summary-model",
		summaryMaxTokens: 256,
		gatewayId: null,
	},
};

function integrityFor(identity) {
	return {
		facts: [{
			identity,
			memory: { kind: "slice", slice_kind: "other", text: `${identity.label} was mentioned.` },
		}],
		relationships: [],
		corrections: [],
	};
}

function node(id, label) {
	return {
		id,
		label,
		canonical_label: label.toLocaleLowerCase("en-US"),
		aliases_json: "[]",
		category: "organization",
	};
}

describe("manual identity title refinement", () => {
	it("does not override an adjudicated create-new decision from the full graph", async () => {
		const identity = {
			ref: "E0",
			label: "Man United",
			_raw_label: "Man United",
			category: "organization",
			aliases: [],
			_manual_resolution: {
				entity_ref: "E0",
				decision: "create_new",
				reason_codes: ["no_identity_evidence"],
			},
		};

		await refineManualIdentityTitles({}, config, integrityFor(identity), {
			nodes: [node("node-manchester-united", "Manchester United")],
		}, { submittedContent: "Man United was mentioned." });

		expect(identity.existing_node_id).toBeNull();
		expect(identity.label).toBe("Man United");
	});

	it("keeps the node selected by an adjudicated merge decision", async () => {
		const identity = {
			ref: "E0",
			label: "MUFC",
			_raw_label: "MUFC",
			category: "organization",
			aliases: [],
			existing_node_id: "node-manchester-united",
			_manual_resolution: {
				entity_ref: "E0",
				decision: "merge_existing",
				selected_ref: "N0",
			},
		};

		await refineManualIdentityTitles({}, config, integrityFor(identity), {
			nodes: [
				node("node-manchester-united", "Manchester United"),
				node("node-manchester-city", "Manchester City"),
			],
		}, { submittedContent: "MUFC was mentioned." });

		expect(identity.existing_node_id).toBe("node-manchester-united");
		expect(identity._manual_conflict_reason).toBeUndefined();
	});
});
