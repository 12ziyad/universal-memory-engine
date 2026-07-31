/**
 * Recall gate phrasing coverage.
 *
 * The gate is a cheap pre-filter that runs *after* an MCP client has already
 * chosen recall_memory, so an over-tight gate is far more damaging than a loose
 * one: it silently skips the D1 lookup and the tool answers "No relevant memory
 * found." for memory that is present. Production did exactly that for the most
 * natural phrasing there is ("what do you remember about X?"), which fell
 * through to classifyMessage() and was written off as a utility question.
 */

import { describe, expect, it } from "vitest";

import { recallGate } from "../src/pipeline/recall.js";

const RECALL_PHRASINGS = [
	"What do you remember about Rahul?",
	"What do you remember about Itsuki?",
	"what do you remember about the Unified Government QR Identity System?",
	"Do you remember Rahul?",
	"do you remember what I said about the QR project?",
	"Did you remember my sister?",
	"Can you recall my deployment preferences?",
	"What do you know about Rahul?",
	"Tell me everything you remember about Atlas",
];

const NON_RECALL_MESSAGES = [
	"hi",
	"hello",
	"thanks",
	"good morning",
	"what is 2 + 2?",
	"Please remember to buy milk",
];

describe("recall gate phrasing", () => {
	it.each(RECALL_PHRASINGS)("performs a memory lookup for %j", (query) => {
		expect(recallGate(query).mode).not.toBe("no_recall");
	});

	it.each(NON_RECALL_MESSAGES)("skips the memory lookup for %j", (query) => {
		expect(recallGate(query).mode).toBe("no_recall");
	});

	it("labels a subject-directed remember/recall question as recall intent", () => {
		expect(recallGate("What do you remember about Rahul?")).toMatchObject({
			mode: "light_recall",
			reason: "recall_intent_query",
		});
	});

	it("still routes a whole-profile question to deep recall", () => {
		expect(recallGate("what do you know about me")).toMatchObject({
			mode: "deep_recall",
			reason: "broad_profile_query",
		});
	});

	it("never treats a save instruction as recall intent even when it contains a recall verb", () => {
		// "can recall" matches the interrogative pattern; the leading imperative
		// must win so the sentence is written to memory rather than answered from it.
		expect(recallGate("Remember that I can recall my password").reason).not.toBe("recall_intent_query");
		expect(recallGate("Remember to note what you recall later").reason).not.toBe("recall_intent_query");
	});

	it("keeps an empty query out of the lookup path", () => {
		expect(recallGate("")).toMatchObject({ mode: "no_recall", reason: "empty_query", topN: 0 });
	});
});

describe("third-person questions reach memory", () => {
	// Regression: classifyMessage() is an INGEST classifier and called every
	// question without "I"/"my" utility. Gating retrieval on it silently
	// skipped 87.5% of LoCoMo questions whose answers were in the graph.
	const mustRecall = [
		"When did Melanie paint a sunrise?",
		"What did Caroline research?",
		"When is Sarah's birthday?",
		"Who is my manager's boss?",
		"What fields would Caroline pursue in her education?",
		"Where did we go camping last year?",
	];
	for (const query of mustRecall) {
		it("recalls for: " + query, () => {
			const plan = recallGate(query);
			expect(plan.mode).not.toBe("no_recall");
			expect(plan.topN).toBeGreaterThan(0);
		});
	}

	const mustNotRecall = [
		"translate this paragraph to French",
		"write me a python function that sorts a list",
		"calculate 15% of 2400",
		"hi",
		"thanks",
	];
	for (const query of mustNotRecall) {
		it("skips recall for: " + query, () => {
			expect(recallGate(query).mode).toBe("no_recall");
		});
	}
});
