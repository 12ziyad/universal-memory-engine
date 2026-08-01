/**
 * Split-rescue spending contract.
 *
 * The measured production failure this pins down: a fire whose primary parse
 * failed re-called the model once per held message — 41, 47, and 107 calls in
 * the conv-0 smoke, two of which still wrote NOTHING (5,374 neurons, 47.8% of
 * save spend, invisible on every receipt). The contract now:
 *
 *   1. a rescue larger than SPLIT_RESCUE_MAX_CALLS never starts
 *   2. once SPLIT_RESCUE_FAIL_FAST messages fail to parse, the fire is
 *      abandoned without walking the rest of the chunk
 *   3. fewer failures than that are tolerated: what parsed is kept
 *   4. every receipt reports what the rescue cost, even on failure
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runExtraction } from "../src/pipeline/extract.js";

// A realistic held chunk: people, dates, preferences, and chatter — the kind
// of mixed conversation that actually reaches a fire.
const CONVERSATION = [
	"My sister Amara is visiting from Lisbon on August 14th, she's staying two weeks",
	"I finally decided to move the api gateway off Express onto Hono, the middleware was a mess",
	"Amara wants us to run the Porto half marathon together in October so I signed us both up",
	"I prefer code reviews before noon, my focus is useless after lunch honestly",
	"We adopted a rescue greyhound last Saturday, named him Biscuit",
	"Biscuit chewed through my old Sony headphones so I ordered the Bose QC ones",
	"My manager Priya approved the four-day-week trial starting September",
	"haha yeah that meme is exactly it",
	"The half marathon training plan says 40km a week which feels like a lot",
	"Also decided we're hosting Christmas at ours this year since mum's knee surgery went well",
];

function messages(contents, { role = "user" } = {}) {
	return contents.map((content, i) => ({
		id: `m-${i + 1}`,
		role,
		content,
		ts: Date.parse("2026-08-02T10:00:00Z") + i * 60_000,
	}));
}

/** A hook that always returns something unparseable, counting its calls. */
function alwaysGarbage() {
	const counter = { calls: 0 };
	const hook = () => {
		counter.calls += 1;
		return "<think>model rambles and never closes a JSON object {\"objects\": [";
	};
	return { hook, counter };
}

describe("split-rescue spending contract", () => {
	it("fail-fast: abandons after the first batch of parse failures instead of walking the chunk", async () => {
		const userId = `sr-failfast-${crypto.randomUUID()}`;
		const { hook, counter } = alwaysGarbage();
		const chunk = messages(CONVERSATION.slice(0, 8));

		const result = await runExtraction(env, userId, chunk, [], { llmResponse: hook });

		expect(result.outcome).toBe("llm_failed");
		// 1 primary + one batch of 4 rescue calls — NOT 1 + 8.
		expect(counter.calls).toBe(5);
		expect(result.receipt.split_rescue).toBe(true);
		expect(result.receipt.split_rescue_calls).toBe(4);
		expect(result.receipt.split_rescue_aborted).toBe("fail_fast");
		expect(result.receipt.split_rescue_recovered).toBe(false);
		expect(result.receipt.savedTotal).toBe(0);
	});

	it("ceiling: a chunk larger than SPLIT_RESCUE_MAX_CALLS is refused before spending anything", async () => {
		const userId = `sr-ceiling-${crypto.randomUUID()}`;
		const { hook, counter } = alwaysGarbage();
		const chunk = messages(CONVERSATION); // 10 messages > default ceiling of 8

		const result = await runExtraction(env, userId, chunk, [], { llmResponse: hook });

		expect(result.outcome).toBe("llm_failed");
		// Only the primary call happened; the rescue never started.
		expect(counter.calls).toBe(1);
		expect(result.receipt.split_rescue).toBe(true);
		expect(result.receipt.split_rescue_calls).toBe(0);
		expect(result.receipt.split_rescue_aborted).toBe("over_ceiling");
	});

	it("ceiling is env-configurable", async () => {
		const userId = `sr-dial-${crypto.randomUUID()}`;
		const { hook, counter } = alwaysGarbage();
		const chunk = messages(CONVERSATION.slice(0, 3)); // 3 messages > ceiling of 2

		const tightened = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			SPLIT_RESCUE_MAX_CALLS: "2",
		});
		const result = await runExtraction(tightened, userId, chunk, [], { llmResponse: hook });

		expect(counter.calls).toBe(1);
		expect(result.receipt.split_rescue_aborted).toBe("over_ceiling");
	});

	it("partial rescue: keeps what parsed when failures stay under the fail-fast line", async () => {
		const userId = `sr-partial-${crypto.randomUUID()}`;
		let calls = 0;
		const hook = ({ packet }) => {
			calls += 1;
			// Primary call sees the whole chunk — fail it to trigger the rescue.
			if (packet.new_slice.length > 1) return "mangled { output the model never finished";
			const text = packet.new_slice[0].content;
			// One poisoned message keeps failing even alone.
			if (text.includes("meme")) return "st{ill garbage";
			if (text.includes("greyhound")) {
				return {
					objects: [
						{ kind: "node", label: "Biscuit", category: "other", matches_existing: null, confidence: 0.95 },
						{ kind: "event", on: "Biscuit", action: "started", text: "Adopted rescue greyhound Biscuit", importance: "ordinary", confidence: 0.9 },
					],
					notes: "adoption",
				};
			}
			if (text.includes("Hono")) {
				return {
					objects: [
						{ kind: "node", label: "API gateway", category: "project", matches_existing: null, confidence: 0.9 },
						{ kind: "slice", on: "API gateway", text: "Moved from Express to Hono", kind_detail: "decision", confidence: 0.9 },
					],
					notes: "migration decision",
				};
			}
			return { objects: [], notes: "nothing durable" };
		};

		// 5 messages, one of which ("meme") is unparseable even alone.
		const chunk = messages([
			CONVERSATION[1], // Hono decision
			CONVERSATION[4], // greyhound
			CONVERSATION[7], // meme — poisoned
			CONVERSATION[3], // preference (hook returns empty objects)
			CONVERSATION[6], // manager (hook returns empty objects)
		]);

		const result = await runExtraction(env, userId, chunk, [], { llmResponse: hook });

		expect(result.outcome).toBe("wrote");
		expect(calls).toBe(6); // 1 primary + 5 rescue
		expect(result.receipt.split_rescue).toBe(true);
		expect(result.receipt.split_rescue_calls).toBe(5);
		expect(result.receipt.split_rescue_dropped).toBe(1);
		expect(result.receipt.split_rescue_recovered).toBe(true);
		expect(result.receipt.savedTotal).toBeGreaterThan(0);

		// The good parses actually landed in the graph.
		const { results } = await env.DB.prepare("SELECT label FROM nodes WHERE user_id = ?").bind(userId).all();
		const labels = results.map((r) => r.label);
		expect(labels).toContain("Biscuit");
	});

	it("a single-message chunk that fails to parse never rescues (nothing to split)", async () => {
		const userId = `sr-single-${crypto.randomUUID()}`;
		const { hook, counter } = alwaysGarbage();
		const chunk = messages([CONVERSATION[0]]);

		const result = await runExtraction(env, userId, chunk, [], { llmResponse: hook });

		expect(result.outcome).toBe("llm_failed");
		expect(counter.calls).toBe(1);
		// No rescue attempted → no rescue fields claiming otherwise.
		expect(result.receipt.split_rescue).toBeUndefined();
	});
});
