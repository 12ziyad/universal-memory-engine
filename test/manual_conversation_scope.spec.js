import { describe, expect, it } from "vitest";

import {
	buildManualConversationClaims,
	claimMatchesManualConversationSubject,
	inferManualConversationScope,
	manualConversationClaimEnvelope,
	normalizeManualConversationScope,
	resolveManualConversationScope,
} from "../src/pipeline/manual_conversation_scope.js";

describe("manual conversation scope", () => {
	it("locks the initial safety contract while normalizing camel and snake input", () => {
		expect(normalizeManualConversationScope({
			subject: "  Ziyad  ",
			speaker_scope: "all",
			include_assistant_facts: true,
			exclude_other_people: false,
			include_context_for_reference_resolution: false,
		})).toEqual({
			subject: "Ziyad",
			speakerScope: "user_only",
			includeAssistantFacts: false,
			excludeOtherPeople: true,
			includeContextForReferenceResolution: true,
		});
	});

	it("infers an explicit subject directive and never turns the directive into a claim", () => {
		const messages = [
			{ id: "u1", role: "user", content: "Ziyad is building UML." },
			{ id: "u2", role: "user", content: "Omar is learning Rust." },
			{ id: "u3", role: "user", content: "Save only what this chat says about Ziyad." },
		];
		const inferred = inferManualConversationScope(messages);
		const result = buildManualConversationClaims(messages);

		expect(inferred.scope.subject).toBe("Ziyad");
		expect(inferred.directives).toHaveLength(1);
		expect(result.resolved_scope).toMatchObject({ subject: "Ziyad", speakerScope: "user_only" });
		expect(result.claims).toEqual([
			expect.objectContaining({
				claim_id: "C0",
				subject_ref: "E0",
				text: "Ziyad is building UML.",
				attribution: "user_stated",
				source_message_ids: ["u1"],
			}),
		]);
		expect(result.source_messages).toEqual([
			expect.objectContaining({ id: "u1", role: "user", content: "Ziyad is building UML." }),
		]);
		expect(result.ignored).toEqual(expect.arrayContaining([
			expect.objectContaining({ source_message_id: "u2", reason: "outside_subject_scope" }),
			expect.objectContaining({ source_message_id: "u3", reason: "content_scope_directive" }),
		]));
		expect(JSON.stringify(result.claims)).not.toMatch(/save only|this chat/i);
	});

	it("preserves a fact after a colon-delimited scope directive", () => {
		const result = buildManualConversationClaims([
			{ id: "u1", role: "user", content: "Save only about Atlas: Atlas uses D1." },
		]);

		expect(result.resolved_scope.subject).toBe("Atlas");
		expect(result.claims).toEqual([
			expect.objectContaining({ text: "Atlas uses D1.", source_message_ids: ["u1"] }),
		]);
		expect(result.claims[0].evidence_spans[0]).toMatchObject({
			message_ref: "M0",
			source_message_id: "u1",
			quote: "Atlas uses D1.",
		});
	});

	it("fails closed when the authenticated input scope and chat directive disagree", () => {
		const messages = [{ role: "user", content: "Save only what this chat says about Atlas." }];
		const resolution = resolveManualConversationScope(messages, { subject: "Beacon" });
		const result = buildManualConversationClaims(messages, { subject: "Beacon" });

		expect(resolution.valid).toBe(false);
		expect(resolution.conflicts).toEqual([
			expect.objectContaining({ code: "subject_scope_conflict", subjects: ["Beacon", "Atlas"] }),
		]);
		expect(result).toMatchObject({ ok: false, claims: [], source_messages: [] });
	});

	it("uses a conservative primary-subject test instead of substring inclusion", () => {
		expect(claimMatchesManualConversationSubject("Ziyad works on UML.", "Ziyad")).toBe(true);
		expect(claimMatchesManualConversationSubject("Today Ziyad works on UML.", "Ziyad")).toBe(true);
		expect(claimMatchesManualConversationSubject("Omar spoke with Ziyad.", "Ziyad")).toBe(false);
		expect(claimMatchesManualConversationSubject("Omar met Ziyad.", "Ziyad")).toBe(false);
		expect(claimMatchesManualConversationSubject("I think Ziyad prefers D1.", "Ziyad")).toBe(true);
		expect(claimMatchesManualConversationSubject("He now uses D1.", "Ziyad", { allowPronounContext: true })).toBe(true);
		expect(claimMatchesManualConversationSubject("I now use D1.", "Ziyad", { userIsSubject: true })).toBe(true);
	});

	it("builds grounded claim IDs, source IDs, spans, polarity, modality, and current/history", () => {
		const result = buildManualConversationClaims([
			{ id: "u1", role: "user", content: "Ziyad currently uses D1. Ziyad did not use Redis last year." },
			{ id: "u2", role: "user", content: "Ziyad might adopt Go next month. Should Ziyad ship this week?" },
		], { subject: "Ziyad" });

		expect(result.claims).toHaveLength(4);
		expect(result.claims[0]).toMatchObject({
			claim_id: "C0",
			type: "current_state",
			polarity: "positive",
			modality: "asserted",
			current: true,
			temporal_status: "current",
			source_message_ids: ["u1"],
		});
		expect(result.claims[1]).toMatchObject({
			claim_id: "C1",
			type: "historical_state",
			polarity: "negative",
			modality: "asserted",
			current: false,
			temporal_status: "historical",
		});
		expect(result.claims[2]).toMatchObject({
			claim_id: "C2",
			type: "plan",
			modality: "possible",
			current: true,
		});
		expect(result.claims[3]).toMatchObject({
			claim_id: "C3",
			type: "open_question",
			modality: "possible",
		});
		for (const claim of result.claims) {
			expect(claim.evidence_spans).toEqual([
				expect.objectContaining({
					role: "user",
					start: expect.any(Number),
					end: expect.any(Number),
					quote: claim.text,
				}),
			]);
		}
	});

	it("keeps generic assistant assertions and unaccepted proposals out of claims", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "Atlas already uses Redis. I suggest Atlas use D1 instead." },
			{ id: "u1", role: "user", content: "Thanks." },
		], { subject: "Atlas", includeAssistantFacts: true });

		expect(result.claims).toEqual([]);
		expect(result.assistant_proposals).toEqual([
			expect.objectContaining({
				id: "P0",
				text: "Atlas use D1 instead.",
				context_only: true,
				adopted: false,
			}),
		]);
		expect(result.reference_context).toEqual([
			expect.objectContaining({ source_message_id: "a1", role: "assistant", context_only: true }),
		]);
		expect(result.warnings).toContain("assistant_facts_not_supported");
		expect(JSON.stringify(result.claims)).not.toMatch(/Redis|D1/);
	});

	it("keeps a PDF task page-only, links its assistant completion, and treats the save command as control", () => {
		const result = buildManualConversationClaims([
			{ id: "pdf-request", role: "user", content: "Please correct the spelling and formatting in the attached PDF." },
			{ id: "pdf-complete", role: "assistant", content: "I corrected the spelling and formatting in the PDF and prepared the revised file." },
			{ id: "pdf-save", role: "user", content: "Save this conversation to memory." },
		]);

		expect(result.claims).toEqual([
			expect.objectContaining({
				claim_id: "C0",
				claim_kind: "user_task_request",
				page_only: true,
				attribution: "user_stated",
			}),
		]);
		expect(result.source_messages).toEqual([]);
		expect(result.page_claims).toEqual([
			expect.objectContaining({ claim_id: "C0", type: "historical_state", current: false }),
			expect.objectContaining({
				claim_id: "C1",
				claim_kind: "assistant_completed_action",
				attribution: "assistant_completed",
				responds_to_claim_id: "C0",
				responds_to_source_message_id: "pdf-request",
				source_message_ids: ["pdf-request", "pdf-complete"],
			}),
		]);
		expect(result.page_claims[1].evidence_spans).toEqual([
			expect.objectContaining({ role: "user", source_message_id: "pdf-request" }),
			expect.objectContaining({ role: "assistant", source_message_id: "pdf-complete" }),
		]);
		expect(result.page_source_messages).toEqual([
			expect.objectContaining({ role: "user", source_message_id: "pdf-request" }),
			expect.objectContaining({ role: "assistant", source_message_id: "pdf-complete" }),
		]);
		expect(result.ignored).toContainEqual(expect.objectContaining({
			source_message_id: "pdf-save",
			reason: "save_control_message",
		}));
		expect(JSON.stringify(result.page_claims)).not.toContain("Save this conversation to memory");
	});

	it("emits a linked user_adopted claim only for a specific later confirmation", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use D1 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's use D1 for Atlas." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				claim_id: "C0",
				text: "Use D1 for Atlas.",
				type: "decision",
				attribution: "user_adopted",
				proposal_id: "P0",
				proposal_source_message_id: "a1",
				confirmation_source_message_id: "u1",
				source_message_ids: ["a1", "u1"],
				adoption: {
					proposal_id: "P0",
					proposal_message_ref: "M0",
					proposal_source_message_id: "a1",
					confirmation_message_ref: "M1",
					confirmation_source_message_id: "u1",
				},
			}),
		]);
		expect(result.claims[0].evidence_spans).toEqual([
			expect.objectContaining({ role: "assistant", source_message_id: "a1", quote: "We could use D1 for Atlas." }),
			expect.objectContaining({ role: "user", source_message_id: "u1", quote: "Yes, let's use D1 for Atlas." }),
		]);
		expect(result.assistant_proposals[0]).toMatchObject({
			adopted: true,
			context_only: true,
			adopted_claim_id: "C0",
		});
	});

	it("does not adopt a proposal from a generic yes or an ambiguous referential confirmation", () => {
		const generic = buildManualConversationClaims([
			{ role: "assistant", content: "We could use D1 for Atlas." },
			{ role: "user", content: "Yes." },
		], { subject: "Atlas" });
		const ambiguous = buildManualConversationClaims([
			{ role: "assistant", content: "We could use D1 for Atlas. We could use Postgres for Atlas." },
			{ role: "user", content: "Let's do that." },
		], { subject: "Atlas" });

		expect(generic.claims).toEqual([]);
		expect(generic.assistant_proposals[0].adopted).toBe(false);
		expect(ambiguous.claims).toEqual([]);
		expect(ambiguous.assistant_proposals.every((proposal) => !proposal.adopted)).toBe(true);
		expect(ambiguous.ignored).toEqual(expect.arrayContaining([
			expect.objectContaining({ reason: "ambiguous_proposal_confirmation" }),
		]));
	});

	it("never inverts a negated confirmation into a positive adopted proposal", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use D1 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's not use D1 for Atlas." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				text: "Yes, let's not use D1 for Atlas.",
				attribution: "user_stated",
				polarity: "negative",
			}),
		]);
		expect(result.claims[0]).not.toHaveProperty("proposal_id");
		expect(result.assistant_proposals[0]).toMatchObject({
			adopted: false,
			context_only: true,
			adopted_claim_id: null,
		});
		expect(result.source_messages).toEqual([
			expect.objectContaining({
				id: "u1",
				role: "user",
				content: "Yes, let's not use D1 for Atlas.",
			}),
		]);
	});

	it("does not adopt a proposal through an explicit referential rejection", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use D1 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's reject that option for Atlas." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				text: "Yes, let's reject that option for Atlas.",
				attribution: "user_stated",
				polarity: "negative",
			}),
		]);
		expect(result.claims[0]).not.toHaveProperty("proposal_id");
		expect(result.assistant_proposals[0].adopted).toBe(false);
	});

	it("does not mistake a subject token or a different user choice for proposal adoption", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use D1 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's use Postgres for Atlas." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				text: "Yes, let's use Postgres for Atlas.",
				attribution: "user_stated",
			}),
		]);
		expect(result.claims[0]).not.toHaveProperty("proposal_id");
		expect(result.assistant_proposals[0]).toMatchObject({
			adopted: false,
			context_only: true,
			adopted_claim_id: null,
		});
	});

	it("does not adopt a proposal that the user rejects in a contrastive choice", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use R2 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's use D1 for Atlas, not R2." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				text: "Yes, let's use D1 for Atlas, not R2.",
				attribution: "user_stated",
			}),
		]);
		expect(result.claims[0]).not.toHaveProperty("proposal_id");
		expect(result.assistant_proposals[0]).toMatchObject({
			adopted: false,
			context_only: true,
			adopted_claim_id: null,
		});
	});

	it("can adopt the selected proposal while rejecting a contrasting proposal", () => {
		const result = buildManualConversationClaims([
			{ id: "a1", role: "assistant", content: "We could use R2 for Atlas. We could use D1 for Atlas." },
			{ id: "u1", role: "user", content: "Yes, let's use D1 for Atlas, not R2." },
		], { subject: "Atlas" });

		expect(result.claims).toEqual([
			expect.objectContaining({
				text: "Use D1 for Atlas.",
				attribution: "user_adopted",
				proposal_id: "P1",
				proposal_source_message_id: "a1",
				confirmation_source_message_id: "u1",
			}),
		]);
		expect(result.assistant_proposals).toEqual([
			expect.objectContaining({ id: "P0", text: "Use R2 for Atlas.", adopted: false }),
			expect.objectContaining({ id: "P1", text: "Use D1 for Atlas.", adopted: true }),
		]);
	});

	it("applies a named-user identity anchor only from the point where it is stated", () => {
		const result = buildManualConversationClaims([
			{ id: "u1", role: "user", content: "I prefer Redis." },
			{ id: "u2", role: "user", content: "I am Ziyad. I prefer D1." },
		], { subject: "Ziyad" });

		expect(result.claims.map((claim) => claim.text)).toEqual(["I am Ziyad.", "I prefer D1."]);
		expect(result.ignored).toEqual(expect.arrayContaining([
			expect.objectContaining({ source_message_id: "u1", reason: "outside_subject_scope" }),
		]));
	});

	it("projects only bounded structured claim fields into the model envelope", () => {
		const result = buildManualConversationClaims([
			{ id: "u1", role: "user", content: "I am Ziyad. I plan to ship UML next week." },
		], { subject: "Ziyad" });
		const envelope = manualConversationClaimEnvelope(result);

		expect(result.claims).toHaveLength(2);
		expect(envelope.primary_subject).toEqual({ ref: "E0", label: "Ziyad" });
		expect(envelope.claims[1]).toMatchObject({
			claim_id: "C1",
			subject_ref: "E0",
			text: "I plan to ship UML next week.",
			attribution: "user_stated",
			modality: "planned",
		});
		expect(Object.keys(envelope)).toEqual(["resolved_scope", "primary_subject", "claims"]);
	});
});
