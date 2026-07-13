import { describe, expect, it } from "vitest";

import { canonicalIdentity } from "../src/pipeline/manual_identity.js";
import { buildManualGraphPlan } from "../src/pipeline/manual_plan.js";

function node(id, label, category = "project", aliases = []) {
	return {
		id,
		label,
		canonical_label: canonicalIdentity(label),
		aliases_json: JSON.stringify(aliases),
		category,
		state: "active",
		summary: null,
		cluster: null,
	};
}

function graphState(overrides = {}) {
	return {
		nodes: [],
		slices: [],
		events: [],
		edges: [],
		candidates: [],
		suppressions: [],
		...overrides,
	};
}

function sliceFact(label, text, extra = {}) {
	return {
		identity: { label, category: extra.category ?? "project", existing_node_id: extra.existing_node_id ?? null },
		memory: { kind: "slice", slice_kind: extra.slice_kind ?? "technical_detail", text },
		confidence: 0.98,
		supersedes: extra.supersedes ?? false,
	};
}

describe("staged manual graph planner", () => {
	it("ignores comparison mentions and leaves no supporting node for the rejected relationship", () => {
		const plan = buildManualGraphPlan("planner-comparison", {
			primary_subject_ref: "E0",
			primary_memory: { text: "Silver Comet is the user's active project.", confidence: 0.98 },
			entities: [
				{ ref: "E0", label: "Silver Comet", category: "project", mention_role: "primary_subject" },
				{ ref: "E1", label: "Sonnet", category: "tool", mention_role: "comparison" },
			],
			relationships: [
				{ from_ref: "E0", to_ref: "E1", type: "uses", text: "Silver Comet was compared with Sonnet." },
			],
		}, graphState());

		expect(plan.newNodes.map((item) => item.label)).toEqual(["Silver Comet"]);
		expect(plan.newEdges).toEqual([]);
		expect(plan.ignoredMentions).toEqual([
			expect.objectContaining({ entity_ref: "E1", label: "Sonnet", mention_role: "comparison" }),
		]);
		expect(plan.rejected).toContainEqual(expect.objectContaining({ kind: "edge", reason: "ineligible_mention_role" }));
	});

	it("allocates role-eligible supporting endpoints only after both relationships validate", () => {
		const plan = buildManualGraphPlan("planner-support", {
			primary_subject_ref: "E0",
			primary_memory: { text: "Silver Comet uses Go and Cloudflare Workers." },
			entities: [
				{ ref: "E0", label: "Silver Comet", category: "project", mention_role: "primary_subject" },
				{ ref: "E1", label: "Go", category: "tool", mention_role: "relationship_endpoint" },
				{ ref: "E2", label: "Cloudflare Workers", category: "tool", mention_role: "relationship_endpoint" },
			],
			relationships: [
				{ from_ref: "E0", to_ref: "E1", type: "uses", text: "Silver Comet uses Go." },
				{ from_ref: "E0", to_ref: "E2", type: "uses", text: "Silver Comet uses Cloudflare Workers." },
			],
		}, graphState());

		expect(plan.newNodes.map((item) => item.label).sort()).toEqual(["Cloudflare Workers", "Go", "Silver Comet"]);
		expect(plan.newEdges).toHaveLength(2);
		expect(plan.newSlices.every((slice) => plan.newNodes.some((item) => item.id === slice.node_id))).toBe(true);
	});

	it("returns an identity conflict before allocating any new endpoint", () => {
		const state = graphState({
			nodes: [
				node("node-shared-one", "First Shared Tool", "tool", ["Shared"]),
				node("node-shared-two", "Second Shared Tool", "tool", ["Shared"]),
			],
		});
		const plan = buildManualGraphPlan("planner-ambiguous-endpoint", {
			entities: [
				{ ref: "E0", label: "Silver Comet", category: "project", mention_role: "relationship_subject" },
				{ ref: "E1", label: "Shared", category: "tool", mention_role: "relationship_endpoint" },
			],
			relationships: [{ from_ref: "E0", to_ref: "E1", type: "uses", text: "Silver Comet uses Shared." }],
		}, state);

		expect(plan.conflicts).toEqual([expect.objectContaining({ label: "Shared", reason: "multiple_existing_nodes_match" })]);
		expect(plan.newNodes).toEqual([]);
		expect(plan.newSlices).toEqual([]);
		expect(plan.newEdges).toEqual([]);
		expect(plan.identityClaims).toEqual([]);
	});

	it("supersedes only the exact targeted fact and preserves unrelated same-kind facts", () => {
		const project = node("node-silver", "Silver Comet");
		const state = graphState({
			nodes: [project],
			slices: [
				{ id: "slice-go", node_id: project.id, kind: "technical_detail", text: "Silver Comet uses Go.", is_current: 1, created_at: 1 },
				{ id: "slice-workers", node_id: project.id, kind: "technical_detail", text: "Silver Comet deploys on Cloudflare Workers.", is_current: 1, created_at: 2 },
			],
		});
		const plan = buildManualGraphPlan("planner-targeted-correction", {
			entities: [{ ref: "E0", label: "Silver Comet", category: "project", mention_role: "correction_subject" }],
			facts: [{
				subject_ref: "E0",
				memory: { kind: "slice", slice_kind: "technical_detail", text: "Silver Comet stores data in D1." },
				confidence: 0.98,
			}],
			corrections: [{
				kind: "fact",
				subject_ref: "E0",
				slice_kind: "technical_detail",
				predicate: "uses_language",
				old_text: "Silver Comet uses Go.",
				new_text: "Silver Comet uses Rust.",
				confidence: 0.99,
			}],
		}, state, { submittedContent: "Actually, Silver Comet uses Rust. It also stores data in D1." });

		expect(plan.sliceSupersede).toEqual([
			expect.objectContaining({ id: "slice-go", node_id: project.id, kind: "technical_detail" }),
		]);
		expect(plan.sliceSupersede.some((item) => item.id === "slice-workers")).toBe(false);
		expect(plan.newSlices.map((slice) => slice.text).sort()).toEqual([
			"Silver Comet stores data in D1.",
			"Silver Comet uses Rust.",
		]);
	});

	it("does not let request-wide correction wording supersede an ordinary fact", () => {
		const project = node("node-atlas", "Atlas");
		const plan = buildManualGraphPlan("planner-no-request-wide-correction", {
			facts: [sliceFact("Atlas", "Atlas added a monitoring dashboard.", { existing_node_id: project.id })],
		}, graphState({
			nodes: [project],
			slices: [{
				id: "slice-hosting",
				node_id: project.id,
				kind: "technical_detail",
				text: "Atlas deploys on Workers.",
				is_current: 1,
				created_at: 1,
			}],
		}), { submittedContent: "Actually, another preference changed. Atlas added a monitoring dashboard." });

		expect(plan.newSlices).toHaveLength(1);
		expect(plan.sliceSupersede).toEqual([]);
	});

	it("uses only final verified canonical or alias keys to resolve candidates", () => {
		const united = node("node-united", "Manchester United", "organization");
		const plan = buildManualGraphPlan("planner-candidates", {
			facts: [sliceFact("MUFC", "The user follows MUFC.", {
				category: "organization",
				slice_kind: "other",
			})],
		}, graphState({
			nodes: [united],
			candidates: [
				{ id: "candidate-mufc", label: "MUFC", label_guess: "MUFC", canonical_key: "mufc", status: "pending" },
				{
					id: "candidate-university",
					label: "Manchester University",
					label_guess: "Manchester University",
					canonical_key: "manchester university",
					possible_existing_node_id: united.id,
					status: "pending",
				},
			],
		}));

		expect(plan.newNodes).toEqual([]);
		expect(plan.verifiedAliasAdditions).toEqual([
			expect.objectContaining({ node_id: united.id, alias: "MUFC", canonical_key: "mufc" }),
		]);
		expect(plan.candidateResolutions).toEqual([
			expect.objectContaining({ id: "candidate-mufc", node_id: united.id, verified_identity_key: "mufc" }),
		]);
	});

	it("consumes a validated adjudicated card decision and records a verified semantic alias", () => {
		const united = node("node-united", "Manchester United", "organization");
		const plan = buildManualGraphPlan("planner-adjudicated", {
			entities: [{ ref: "E0", label: "Red Devils", category: "organization", mention_role: "primary_subject" }],
			primary_subject_ref: "E0",
			primary_memory: { text: "The user follows the Red Devils." },
		}, graphState({ nodes: [united] }), {
			nodeContextCards: [{ ref: "N0", node_id: united.id }],
			adjudicatedDecisions: {
				identity_operations: [{
					entity_ref: "E0",
					decision: "merge_existing",
					selected_ref: "N0",
					confidence: 0.97,
					compatible_non_llm_signals: ["page_association", "graph_affinity"],
				}],
			},
		});

		expect(plan.newNodes).toEqual([]);
		expect(plan.overriddenRecommendations).toEqual([]);
		expect(plan.identityDecisions).toEqual([
			expect.objectContaining({ entity_ref: "E0", decision: "existing", node_id: united.id, adjudicated: true }),
		]);
		expect(plan.verifiedAliasAdditions).toEqual([
			expect.objectContaining({ node_id: united.id, alias: "Red Devils", verification: "adjudicated" }),
		]);
	});

	it("stores topic membership on the canonical node and marks ambiguous placement unclustered", () => {
		const plan = buildManualGraphPlan("planner-community", {
			entities: [{
				ref: "E0",
				label: "Quiet Tuesday",
				category: "other",
				mention_role: "primary_subject",
				communities: ["Work Reflections"],
			}],
			primary_subject_ref: "E0",
			primary_memory: { text: "The user reported having a quiet Tuesday at work." },
		}, graphState());

		expect(plan.newNodes).toHaveLength(1);
		expect(plan.newNodes[0].cluster).toBe("unclustered");
		expect(plan.topicCommunityMemberships).toEqual([
			expect.objectContaining({ canonical_key: "work reflections", node_id: plan.newNodes[0].id, entity_ref: "E0" }),
		]);
		expect([...plan.derivedRefreshNodeIds]).toContain(plan.newNodes[0].id);
		expect(plan.newEdges).toEqual([]);
	});

	it("preserves the legacy fact proposal shape", () => {
		const plan = buildManualGraphPlan("planner-legacy", {
			facts: [sliceFact("Atlas", "Atlas uses encrypted storage.")],
			relationships: [],
			corrections: [],
		}, graphState());

		expect(plan.newNodes).toEqual([expect.objectContaining({ label: "Atlas" })]);
		expect(plan.newSlices).toEqual([expect.objectContaining({ text: "Atlas uses encrypted storage." })]);
		expect(plan.hasGraphWrites).toBe(true);
	});
});
