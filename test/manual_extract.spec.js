import { describe, expect, it } from "vitest";

import {
	buildGroundedManualFallback,
	buildManualSourceEnvelope,
	extractManualFacts,
	normalizeManualStructure,
} from "../src/pipeline/manual_extract.js";

const config = {
	llm: {
		model: "test-extraction-model",
		maxTokens: 1200,
		gatewayId: null,
	},
};

describe("manual source-only extraction", () => {
	it("builds a model envelope from source, reference context, and scope only", () => {
		const envelope = buildManualSourceEnvelope({
			sourceMessages: [{ id: "external-message", role: "user", content: "Atlas launched today." }],
			recentContext: "Atlas was the project under discussion.",
			resolvedScope: { topic: "Atlas", speaker_scope: "user_only" },
			nodes: [{ id: "node-secret", summary: "secret stored summary" }],
			graphState: { edges: [{ id: "edge-secret" }] },
			pages: [{ id: "page-secret" }],
			candidates: [{ id: "candidate-secret" }],
		});

		expect(Object.keys(envelope)).toEqual(["source_messages", "reference_context", "resolved_scope"]);
		expect(envelope).toEqual({
			source_messages: [{ ref: "M0", role: "user", content: "Atlas launched today." }],
			reference_context: [{ ref: "R0", content: "Atlas was the project under discussion." }],
			resolved_scope: { topic: "Atlas", speaker_scope: "user_only" },
		});
		expect(JSON.stringify(envelope)).not.toMatch(/node-secret|edge-secret|page-secret|candidate-secret|stored summary/);
	});

	it("normalizes local entity refs, evidence, semantic metadata, and typed corrections", () => {
		const content = "Silver Comet uses Go instead of Rust.";
		const envelope = buildManualSourceEnvelope({ submittedContent: content });
		const result = normalizeManualStructure({
			primary_subject_ref: "source-project",
			primary_memory: {
				text: content,
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
				polarity: "positive",
				modality: "asserted",
				attribution: "user_stated",
				temporal_status: "current",
			},
			entities: [
				{
					ref: "source-project",
					label: "Silver Comet",
					category: "project",
					mention_role: "primary_subject",
					evidence_ids: ["M0"],
					evidence_spans: [{ message_ref: "M0", quote: "Silver Comet" }],
					existing_node_id: "must-be-discarded",
				},
				{ ref: "old", label: "Rust", category: "tool", mention_role: "correction_old_target", evidence_ids: ["M0"] },
				{ ref: "next", label: "Go", category: "tool", mention_role: "correction_new_target", evidence_ids: ["M0"] },
			],
			facts: [],
			relationships: [],
			corrections: [{
				kind: "relationship",
				subject_ref: "source-project",
				old_target_ref: "old",
				new_target_ref: "next",
				predicate: "uses",
				text: content,
				evidence_ids: ["M0"],
				evidence_spans: [{ message_ref: "M0", quote: content }],
			}],
		}, envelope);

		expect(result.primary_subject_ref).toBe("E0");
		expect(result.entities.map(({ ref, label, mention_role }) => ({ ref, label, mention_role }))).toEqual([
			{ ref: "E0", label: "Silver Comet", mention_role: "primary_subject" },
			{ ref: "E1", label: "Rust", mention_role: "correction_old_target" },
			{ ref: "E2", label: "Go", mention_role: "correction_new_target" },
		]);
		expect(result.primary_memory).toMatchObject({
			text: content,
			evidence_ids: ["M0"],
			attribution: "user_stated",
			polarity: "positive",
			modality: "asserted",
			temporal_status: "current",
		});
		expect(result.corrections[0]).toMatchObject({
			kind: "relationship",
			subject_ref: "E0",
			old_target_ref: "E1",
			new_target_ref: "E2",
			predicate: "uses",
			evidence_ids: ["M0"],
		});
		expect(JSON.stringify(result)).not.toContain("must-be-discarded");
	});

	it("keeps legacy fact and relationship overrides but discards database identity hints", () => {
		const content = "Atlas uses D1.";
		const result = normalizeManualStructure({
			facts: [{
				identity: { label: "Atlas", category: "project", existing_node_id: "node-atlas" },
				memory: { kind: "slice", slice_kind: "technical_detail", text: content },
				confidence: 0.96,
			}],
			relationships: [{
				from: { label: "Atlas", category: "project", existingNodeId: "node-atlas" },
				to: { label: "D1", category: "tool", matches_existing: "node-d1" },
				type: "uses",
				text: content,
				confidence: 0.96,
			}],
		}, buildManualSourceEnvelope({ submittedContent: content }));

		expect(result.facts).toHaveLength(1);
		expect(result.relationships).toHaveLength(1);
		expect(result.facts[0]).toMatchObject({
			subject_ref: "E0",
			evidence_ids: ["M0"],
			polarity: "positive",
			modality: "asserted",
			attribution: "user_stated",
			temporal_status: "current",
		});
		expect(JSON.stringify(result)).not.toMatch(/node-atlas|node-d1|existing_node_id|existingNodeId|matches_existing/);
	});

	it("never accepts reference context as factual evidence", () => {
		const envelope = buildManualSourceEnvelope({
			submittedContent: "I stopped it yesterday.",
			recentContext: "Boxing was the subject.",
		});
		const result = normalizeManualStructure({
			primary_subject_ref: "boxing",
			primary_memory: {
				text: "I stopped it yesterday.",
				evidence_ids: ["R0"],
				evidence_spans: [{ message_ref: "R0", quote: "Boxing" }],
			},
			entities: [{ ref: "boxing", label: "Boxing", category: "skill", mention_role: "primary_subject" }],
		}, envelope);

		expect(result.primary_memory.evidence_ids).toEqual(["M0"]);
		expect(result.primary_memory.evidence_spans).toEqual([
			expect.objectContaining({ message_ref: "M0", quote: "I stopped it yesterday." }),
		]);
	});

	it("builds a grounded 2-6 word fallback topic for explicit casual memory", () => {
		const source = "Remember that I had a strange day at work.";
		const result = buildGroundedManualFallback(buildManualSourceEnvelope({ submittedContent: source }));
		const primary = result.entities.find((entity) => entity.ref === result.primary_subject_ref);
		const labelWords = primary.label.split(/\s+/).filter(Boolean);

		expect(labelWords.length).toBeGreaterThanOrEqual(2);
		expect(labelWords.length).toBeLessThanOrEqual(6);
		expect(result.primary_memory).toMatchObject({
			text: "I had a strange day at work.",
			evidence_ids: ["M0"],
			attribution: "user_stated",
			polarity: "positive",
			modality: "asserted",
			temporal_status: "historical",
		});
		expect(result.primary_memory.text).not.toMatch(/manager|criticized|because/i);
	});

	it("does not apply a worth gate to explicit questions or short acknowledgements", () => {
		for (const content of ["What time is it?", "Thanks!"]) {
			const result = buildGroundedManualFallback(buildManualSourceEnvelope({ submittedContent: content }));
			const primary = result.entities.find((entity) => entity.ref === result.primary_subject_ref);
			expect(primary.label.split(/\s+/)).toHaveLength(2);
			expect(result.primary_memory.text).toBe(content);
		}
	});

	it("sends only the source envelope to AI and materializes primary memory for the legacy lane", async () => {
		let modelEnvelope;
		const aiEnv = {
			AI: {
				async run(_model, options) {
					modelEnvelope = JSON.parse(options.messages[1].content);
					return { response: JSON.stringify({
						primary_subject_ref: "dog",
						primary_memory: {
							text: "My dog is named Luna.",
							evidence_ids: ["M0"],
							evidence_spans: [{ message_ref: "M0", quote: "My dog is named Luna." }],
						},
						entities: [{
							ref: "dog",
							label: "Luna",
							category: "family",
							mention_role: "primary_subject",
							evidence_ids: ["M0"],
						}],
						facts: [],
						relationships: [],
						corrections: [],
					}) };
				},
			},
		};
		const result = await extractManualFacts(aiEnv, config, {
			submittedContent: "My dog is named Luna.",
			recentContext: "We were talking about pets.",
			nodes: [{ id: "node-secret", summary: "stored secret" }],
			graphState: { edges: [{ id: "edge-secret" }] },
		});

		expect(Object.keys(modelEnvelope)).toEqual(["source_messages", "reference_context", "resolved_scope"]);
		expect(JSON.stringify(modelEnvelope)).not.toMatch(/node-secret|edge-secret|stored secret/);
		expect(result).toMatchObject({
			primary_subject_ref: "E0",
			extractor: "ai",
			facts: [expect.objectContaining({
				subject_ref: "E0",
				identity: expect.objectContaining({ label: "Luna" }),
				evidence_ids: ["M0"],
			})],
		});
	});

	it("uses the grounded fallback when neither a heuristic nor AI handles an explicit save", async () => {
		const result = await extractManualFacts({}, config, {
			submittedContent: "Remember that I had a strange day at work.",
			explicitManualSave: true,
		});

		expect(result.extractor).toBe("grounded_fallback");
		expect(result.entities).toHaveLength(1);
		expect(result.facts).toEqual([
			expect.objectContaining({
				subject_ref: "E0",
				memory: expect.objectContaining({ text: "I had a strange day at work." }),
				evidence_ids: ["M0"],
			}),
		]);
	});

	it("keeps the model primary subject stable when heuristic and model refs overlap", async () => {
		const result = await extractManualFacts({}, config, {
			submittedContent: "I started boxing. My dog is named Luna.",
			extractionResponse: {
				primary_subject_ref: "E0",
				primary_memory: { text: "My dog is named Luna.", evidence_ids: ["M0"] },
				entities: [{
					ref: "E0",
					label: "Luna",
					category: "family",
					mention_role: "primary_subject",
					evidence_ids: ["M0"],
				}],
				facts: [{
					subject_ref: "E0",
					memory: { kind: "slice", slice_kind: "other", text: "My dog is named Luna." },
					evidence_ids: ["M0"],
				}],
				relationships: [],
				corrections: [],
			},
		});
		const primary = result.entities.find((entity) => entity.ref === result.primary_subject_ref);

		expect(primary).toMatchObject({ label: "Luna", mention_role: "primary_subject" });
		expect(result.facts.map((item) => item.identity.label).sort()).toEqual(["Boxing", "Luna"]);
	});
});
