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

	it("never materializes a negated relationship as a positive edge", () => {
		const relationship = {
			from: { label: "Atlas", category: "project" },
			to: { label: "D1", category: "tool" },
			type: "uses",
			text: "Atlas uses D1.",
			confidence: 0.99,
		};
		const rejected = applyManualIntegrity({ facts: [], relationships: [{
			...relationship,
			text: "Atlas does not use D1.",
		}] }, {
			submittedContent: "Atlas does not use D1.",
			recentContext: "",
		});
		const replacement = applyManualIntegrity({ facts: [], relationships: [{
			...relationship,
			to: { label: "Go", category: "tool" },
			text: "Atlas uses Go.",
		}] }, {
			submittedContent: "Atlas no longer uses Rust; Atlas uses Go.",
			recentContext: "",
		});

		expect(rejected.relationships).toHaveLength(0);
		expect(rejected.rejected[0]).toMatchObject({ reason: "negative_edge_requires_correction" });
		expect(replacement.relationships).toHaveLength(1);
	});

	it("rejects a positive fact extracted from a negated source without rejecting a contrastive positive target", () => {
		const inverted = applyManualIntegrity({
			facts: [fact("Atlas", {
				kind: "slice",
				slice_kind: "technical_detail",
				text: "Atlas uses D1.",
			})],
			relationships: [],
		}, { submittedContent: "Atlas never uses D1." });
		const contrastive = applyManualIntegrity({
			facts: [fact("Atlas", {
				kind: "slice",
				slice_kind: "technical_detail",
				text: "Atlas uses Go.",
			})],
			relationships: [],
		}, { submittedContent: "Atlas uses Go, not Rust." });

		expect(inverted.facts).toHaveLength(0);
		expect(inverted.rejected[0]).toMatchObject({ reason: "fact_polarity_mismatch" });
		expect(contrastive.facts).toHaveLength(1);
	});

	it("preserves the source structure and possible modality for an explicit grounded save", () => {
		const content = "Maybe Atlas will use D1.";
		const entity = {
			ref: "E0",
			label: "Atlas",
			category: "project",
			mention_role: "primary_subject",
		};
		const memory = {
			kind: "slice",
			slice_kind: "technical_detail",
			text: content,
			evidence_ids: ["M0"],
			evidence_spans: [{ message_ref: "M0", quote: content }],
			modality: "possible",
		};
		const result = applyManualIntegrity({
			primary_subject_ref: "E0",
			primary_memory: memory,
			entities: [entity],
			facts: [{
				subject_ref: "E0",
				identity: entity,
				memory,
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
				confidence: 0.95,
			}],
			relationships: [],
			corrections: [],
		}, {
			submittedContent: content,
			sourceMessages: [{ role: "user", content }],
			explicitManualSave: true,
		});

		expect(result.primary_subject_ref).toBe("E0");
		expect(result.entities).toEqual([entity]);
		expect(result.primary_memory).toMatchObject({ text: content, modality: "possible" });
		expect(result.facts).toEqual([expect.objectContaining({ modality: "possible" })]);
		expect(result.hasDurableFacts).toBe(true);
	});

	it("rejects an operation whose cited user message does not support its claim", () => {
		const result = applyManualIntegrity({
			facts: [{
				identity: { label: "Atlas", category: "project" },
				memory: { kind: "slice", slice_kind: "technical_detail", text: "Atlas uses D1." },
				evidence_ids: ["M1"],
				evidence_spans: [{ message_ref: "M1", quote: "My lunch was soup." }],
				confidence: 0.95,
			}],
			relationships: [],
		}, {
			submittedContent: "Atlas uses D1.\nMy lunch was soup.",
			sourceMessages: [
				{ role: "user", content: "Atlas uses D1." },
				{ role: "user", content: "My lunch was soup." },
			],
		});

		expect(result.facts).toHaveLength(0);
		expect(result.rejected).toEqual([
			expect.objectContaining({ label: "Atlas", reason: "identity_not_in_submitted_content" }),
		]);
	});

	it("requires every evidence span to belong to the declared evidence IDs", () => {
		const result = applyManualIntegrity({
			facts: [{
				identity: { label: "Atlas", category: "project" },
				memory: { kind: "slice", slice_kind: "technical_detail", text: "Atlas uses D1." },
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M1", quote: "Atlas uses D1." }],
				confidence: 0.95,
			}],
		}, {
			submittedContent: "Atlas uses D1.",
			sourceMessages: [
				{ role: "user", content: "Atlas uses D1." },
				{ role: "user", content: "Atlas uses D1." },
			],
		});

		expect(result.facts).toHaveLength(0);
		expect(result.rejected[0]).toMatchObject({ reason: "evidence_span_reference_mismatch" });
	});

	it("does not attach another sentence's grounded claim to the wrong subject", () => {
		const content = "Atlas uses D1. Beacon uses Redis.";
		const result = applyManualIntegrity({
			facts: [{
				identity: { label: "Atlas", category: "project" },
				memory: { kind: "slice", slice_kind: "technical_detail", text: "Beacon uses Redis." },
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: "Beacon uses Redis." }],
				confidence: 0.95,
			}],
		}, { submittedContent: content, sourceMessages: [{ role: "user", content }] });

		expect(result.facts).toHaveLength(0);
		expect(result.rejected[0]).toMatchObject({ reason: "identity_not_in_submitted_content" });
	});

	it("does not attach another sentence's relationship to unrelated endpoints", () => {
		const content = "Atlas and D1 were discussed. Beacon uses Redis.";
		const result = applyManualIntegrity({
			facts: [],
			relationships: [{
				from: { label: "Atlas", category: "project" },
				to: { label: "D1", category: "tool" },
				type: "uses",
				text: "Beacon uses Redis.",
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: "Beacon uses Redis." }],
				confidence: 0.95,
			}],
		}, { submittedContent: content, sourceMessages: [{ role: "user", content }] });

		expect(result.relationships).toHaveLength(0);
		expect(result.rejected[0]).toMatchObject({ reason: "edge_not_in_submitted_content" });
	});

	it("accepts a grounded typed fact correction without treating it as an edge", () => {
		const content = "Actually, Atlas runtime is Rust instead of Go.";
		const entity = { ref: "E0", label: "Atlas", category: "project", mention_role: "primary_subject" };
		const result = applyManualIntegrity({
			primary_subject_ref: "E0",
			entities: [entity],
			facts: [],
			relationships: [],
			corrections: [{
				kind: "fact",
				subject_ref: "E0",
				subject: entity,
				predicate: "runtime",
				old_value: "Go",
				new_value: "Rust",
				text: content,
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
				confidence: 0.95,
			}],
		}, { submittedContent: content, sourceMessages: [{ role: "user", content }] });

		expect(result.corrections).toEqual([
			expect.objectContaining({
				kind: "fact",
				old_text: "Go",
				new_text: "Rust",
				evidence_ids: ["M0"],
			}),
		]);
	});

	it("accepts a grounded typed correction whose old and new values span adjacent sentences", () => {
		const content = "Correction: Editor Theme was light mode. Editor Theme is now dark mode.";
		const entity = { ref: "E0", label: "Editor Theme", category: "preference", mention_role: "primary_subject" };
		const result = applyManualIntegrity({
			primary_subject_ref: "E0",
			entities: [entity],
			facts: [],
			relationships: [],
			corrections: [{
				kind: "fact",
				subject_ref: "E0",
				subject: entity,
				predicate: "preference",
				slice_kind: "preference",
				old_value: "Editor Theme was light mode.",
				new_value: "Editor Theme is now dark mode.",
				current_text: "Editor Theme is now dark mode.",
				text: content,
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
				confidence: 0.98,
			}],
		}, { submittedContent: content, sourceMessages: [{ role: "user", content }] });

		expect(result.corrections).toEqual([
			expect.objectContaining({
				kind: "fact",
				slice_kind: "preference",
				old_text: "Editor Theme was light mode.",
				new_text: "Editor Theme is now dark mode.",
			}),
		]);
	});

	it("keeps a declared comparison role authoritative over an emitted fact", () => {
		const content = "I use Bedrock rather than Sonnet.";
		const comparison = { ref: "E1", label: "Sonnet", category: "tool", mention_role: "comparison" };
		const result = applyManualIntegrity({
			entities: [comparison],
			facts: [{
				subject_ref: "E1",
				identity: { ...comparison, mention_role: "independent_fact_subject" },
				memory: { kind: "slice", slice_kind: "technical_detail", text: content },
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
				confidence: 0.95,
			}],
		}, { submittedContent: content, sourceMessages: [{ role: "user", content }] });

		expect(result.facts).toHaveLength(0);
		expect(result.rejected[0]).toMatchObject({ label: "Sonnet", reason: "ineligible_mention_role" });
	});
});
