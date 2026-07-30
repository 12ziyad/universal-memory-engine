/**
 * save_memory first-person grounding.
 *
 * An explicit manual save is the owner talking about themselves, so "my X is Y"
 * must persist even with no recentContext — the model is free to make the user
 * the subject, and that subject resolves to the account owner. Junk and
 * directive-only input must still be refused, save_conversation keeps its
 * stricter gating, and a refusal must name the gate that fired.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	runMcpConversationCollectCommand,
	runMcpDirectSaveCommand,
} from "../src/pipeline/manual_mcp.js";

function userId(label) {
	return `first-person-${label}-${crypto.randomUUID()}`;
}

async function seedUser(id, { name = null, email = null } = {}) {
	await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
		.bind(id, email, name, Date.now())
		.run();
}

async function rows(table, id) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(id).all();
	return results;
}

/** The model shape that used to fail: the USER is the proposed subject. */
function selfSubjectProposal(text, { label = "I", sliceKind = "preference" } = {}) {
	return {
		primary_subject_ref: "E0",
		entities: [{
			ref: "E0",
			label,
			category: "identity",
			mention_role: "primary_subject",
			evidence_ids: ["M0"],
			evidence_spans: [{ message_ref: "M0", quote: label }],
		}],
		facts: [{
			subject_ref: "E0",
			identity: { label, category: "identity" },
			memory: { kind: "slice", slice_kind: sliceKind, text },
			evidence_ids: ["M0"],
			evidence_spans: [{ message_ref: "M0", quote: text }],
			confidence: 0.95,
			attribution: "user_stated",
			polarity: "positive",
			modality: "asserted",
			temporal_status: "current",
		}],
		relationships: [],
		corrections: [],
	};
}

describe("save_memory first-person subjects", () => {
	it("saves 'my X is Y' with no recentContext", async () => {
		const id = userId("bare");
		const content = "My favorite programming language is Kotlin";
		const result = await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: selfSubjectProposal(content),
		});

		expect(result.status).toBe("wrote");
		expect(result.counts.savedTotal).toBeGreaterThan(0);
		const slices = await rows("slices", id);
		expect(slices.some((slice) => /kotlin/i.test(slice.text))).toBe(true);
	});

	it("resolves the first-person subject to the account owner's name", async () => {
		const id = userId("owner-name");
		await seedUser(id, { name: "Ziyad", email: "ziyad@example.com" });
		const content = "My favorite programming language is Kotlin";
		await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: selfSubjectProposal(content),
		});

		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Ziyad");
	});

	it("falls back to the email local part when the account has no name", async () => {
		const id = userId("owner-email");
		await seedUser(id, { email: "ziyad.dev@example.com" });
		const content = "I prefer dark mode in every editor";
		await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: selfSubjectProposal(content, { label: "Me" }),
		});

		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Ziyad Dev");
	});

	it.each([["I"], ["Me"], ["My"], ["User"], ["myself"]])(
		"accepts '%s' as the proposed subject on an explicit save",
		async (label) => {
			const id = userId(`label-${label}`);
			const content = "My preferred deployment target is Cloudflare Workers";
			const result = await runMcpDirectSaveCommand(env, null, id, {
				content,
				extractionResponse: selfSubjectProposal(content, { label }),
			});
			expect(result.counts.savedTotal).toBeGreaterThan(0);
		},
	);

	it("still refuses directive-only input", async () => {
		// Owner resolution must not turn a bare instruction into a memory: there is
		// no claim to attach to the owner.
		for (const content of ["save this", "remember that", "save this to memory", "please remember"]) {
			const id = userId("directive");
			const result = await runMcpDirectSaveCommand(env, null, id, { content });
			expect(result.counts.savedTotal).toBe(0);
			expect(await rows("nodes", id)).toHaveLength(0);
		}
	});

	it("still refuses a first-person directive with no claim", async () => {
		for (const content of ["remember this about me", "save my info"]) {
			const id = userId("first-person-directive");
			const result = await runMcpDirectSaveCommand(env, null, id, {
				content,
				// Even if the model insists on a self-subject, an empty claim writes nothing.
				extractionResponse: selfSubjectProposal(content, { label: "I" }),
			});
			expect(result.counts.nodes).toBe(0);
		}
	});

	it("still refuses an unresolvable pronoun reference", async () => {
		const id = userId("unresolved");
		const result = await runMcpDirectSaveCommand(env, null, id, { content: "Remember that it is broken" });
		expect(result.counts.savedTotal).toBe(0);
		expect(await rows("nodes", id)).toHaveLength(0);
	});

	it("does not loosen save_conversation: a self-subject claim stays out of the graph", async () => {
		const id = userId("collect-strict");
		const content = "My favorite programming language is Kotlin";
		const result = await runMcpConversationCollectCommand(env, null, id, {
			conversationId: "collect-strict",
			messages: [{ id: "m0", role: "user", content }],
			digestResponse: content,
			extractionResponse: selfSubjectProposal(content),
		});

		expect((await rows("nodes", id)).map((node) => node.label)).not.toContain("Me");
		expect(result.receipt.skippedReasons.invalid_identity ?? 0).toBeGreaterThanOrEqual(1);
	});
});

describe("save_memory label hygiene and grounding", () => {
	it("saves a plural identity against a singular source word", async () => {
		const id = userId("plural");
		const content = "I always like to eat apple";
		const result = await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: {
				primary_subject_ref: "E0",
				entities: [{ ref: "E0", label: "Apples", category: "interest", mention_role: "primary_subject", evidence_ids: ["M0"], evidence_spans: [{ message_ref: "M0", quote: "apple" }] }],
				facts: [{
					subject_ref: "E0",
					identity: { label: "Apples", category: "interest" },
					memory: { kind: "slice", slice_kind: "preference", text: content },
					evidence_ids: ["M0"],
					evidence_spans: [{ message_ref: "M0", quote: content }],
					confidence: 0.95,
					attribution: "user_stated",
					polarity: "positive",
					modality: "asserted",
					temporal_status: "current",
				}],
				relationships: [],
				corrections: [],
			},
		});
		expect(result.counts.savedTotal).toBeGreaterThan(0);
		expect((await rows("nodes", id)).map((node) => node.label)).toContain("Apples");
	});

	it("collapses a sentence-shaped owner+value label to the real subject", async () => {
		const id = userId("echo-label");
		await seedUser(id, { name: "Ziyad" });
		const content = "Ziyad's favorite programming language is Kotlin";
		const sentenceLabel = "Ziyad Favorite Programming Language Kotlin";
		const result = await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: {
				primary_subject_ref: "E0",
				entities: [
					{ ref: "E0", label: sentenceLabel, category: "preference", mention_role: "primary_subject", evidence_ids: ["M0"], evidence_spans: [{ message_ref: "M0", quote: content }] },
					{ ref: "E1", label: "Kotlin", category: "tool", mention_role: "relationship_target", evidence_ids: ["M0"], evidence_spans: [{ message_ref: "M0", quote: "Kotlin" }] },
				],
				facts: [{
					subject_ref: "E0",
					identity: { label: sentenceLabel, category: "preference" },
					memory: { kind: "slice", slice_kind: "preference", text: content },
					evidence_ids: ["M0"],
					evidence_spans: [{ message_ref: "M0", quote: content }],
					confidence: 0.95,
					attribution: "user_stated",
					polarity: "positive",
					modality: "asserted",
					temporal_status: "current",
				}],
				relationships: [],
				corrections: [],
			},
		});

		expect(result.counts.savedTotal).toBeGreaterThan(0);
		const labels = (await rows("nodes", id)).map((node) => node.label);
		// The owner echo and the trailing value echo are both stripped.
		expect(labels).not.toContain(sentenceLabel);
		expect(labels.some((label) => /^favorite programming language$/i.test(label))).toBe(true);
	});

	it("reuses an existing owner node instead of duplicating the owner", async () => {
		const id = userId("owner-reuse");
		await seedUser(id, { name: "Ziyad E J" });
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
		).bind("node-ziyad", id, "Ziyad", "identity", now, now).run();

		const content = "My preferred code editor is Zed";
		await runMcpDirectSaveCommand(env, null, id, {
			content,
			extractionResponse: selfSubjectProposal(content, { label: "I" }),
		});

		const labels = (await rows("nodes", id)).map((node) => node.label);
		expect(labels.filter((label) => /ziyad/i.test(label))).toEqual(["Ziyad"]);
	});
});

describe("save_memory refusal reasons", () => {
	it("names the gate that fired instead of a generic message", async () => {
		const id = userId("reason");
		// Short content with no grounded fallback available, and a proposed subject
		// that appears nowhere in it: the save is refused outright.
		const result = await runMcpDirectSaveCommand(env, null, id, {
			content: "Kotlin is great",
			extractionResponse: {
				primary_subject_ref: "E0",
				entities: [],
				facts: [{
					subject_ref: "E0",
					identity: { label: "Zebra Protocol", category: "project" },
					memory: { kind: "slice", slice_kind: "technical_detail", text: "Zebra Protocol uses Neptune" },
					evidence_ids: ["M0"],
					evidence_spans: [{ message_ref: "M0", quote: "Kotlin is great" }],
					confidence: 0.95,
					attribution: "user_stated",
					polarity: "positive",
					modality: "asserted",
					temporal_status: "current",
				}],
				relationships: [],
				corrections: [],
			},
		});

		expect(result.counts.savedTotal).toBe(0);
		expect(result.receipt.reason).not.toBe("the submitted content could not be safely grounded into a manual memory");
		// Human phrasing plus the raw gate code, so a receipt is self-explaining.
		expect(result.receipt.reason).toMatch(/identity_not_in_submitted_content/);
		expect(result.receipt.reason).toMatch(/not present in the submitted content/);
		expect(Object.keys(result.receipt.skippedReasons).length).toBeGreaterThan(0);
	});
});
