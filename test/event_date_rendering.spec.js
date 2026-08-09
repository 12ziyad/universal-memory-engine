import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { buildContext, recallGate } from "../src/pipeline/recall.js";
import { runExtraction } from "../src/pipeline/extract.js";

/**
 * V3-D04 — the date was stored correctly and never shown to the reader.
 *
 * Measured, not theorised. After V3-D03 put real dates in the graph, a full
 * LoCoMo re-run moved temporal token-F1 from 6.81% to 5.99% — nothing. The
 * reason was one line in `buildContext`:
 *
 *     const eventTexts = [...n.events].reverse().map((e) => e.text);
 *
 * `happened_at` is SELECTed, carried all the way here, and dropped on the last
 * line before the reader sees it. Asked "When did Jon lose his job as a
 * banker?", the reader was handed the string "Left job as a banker" — which
 * contains no date — and answered accordingly.
 *
 * Rendering it unconditionally would be worse than the bug: `happened_at` has
 * always fallen back to the message timestamp, so every pre-D03 event carries
 * ingest day, and printing those would assert a wrong date rather than omit
 * one. Hence provenance.
 */

const node = (events) => ([{
	type: "node",
	score: 1,
	item: {
		id: "n1", label: "Banker", category: "organization", state: "inactive",
		summary: "", cluster: null, project_id: null, project_name: null,
		slices: [], events, relations: [],
	},
}]);

const plan = recallGate("when did I leave the bank?");

describe("an event's date reaches the reader", () => {
	it("renders a date the extractor copied out of the source", () => {
		const context = buildContext(node([{
			id: "e1", text: "Left job as a banker",
			happened_at: Date.UTC(2023, 0, 20, 12), happened_at_source: "extracted",
		}]), plan);
		expect(context).toContain("Left job as a banker (2023-01-20)");
	});

	it("renders a date resolved from a relative phrase", () => {
		const context = buildContext(node([{
			id: "e1", text: "Moved into the flat",
			happened_at: Date.UTC(2025, 8, 17, 12), happened_at_source: "phrase",
		}]), plan);
		expect(context).toContain("(2025-09-17)");
	});

	it("renders a date anchored on the caller's authoritative write time", () => {
		const context = buildContext(node([{
			id: "e1", text: "Ran the charity race",
			happened_at: Date.UTC(2023, 4, 7, 12), happened_at_source: "source_time",
		}]), plan);
		expect(context).toContain("(2023-05-07)");
	});
});

describe("an ingest timestamp is never printed as if it were the event's date", () => {
	it("omits the date when provenance is 'observed'", () => {
		const context = buildContext(node([{
			id: "e1", text: "Left job as a banker",
			happened_at: Date.UTC(2026, 7, 9, 12), happened_at_source: "observed",
		}]), plan);
		expect(context).toContain("Left job as a banker");
		expect(context).not.toContain("2026-08-09");
	});

	it("omits the date for a legacy row with no provenance at all", () => {
		// Every event written before migration 0034. NULL is not 'trustworthy
		// until proven otherwise' — it is unknown, and unknown is not printed.
		for (const source of [null, undefined, "", "something_else"]) {
			const context = buildContext(node([{
				id: "e1", text: "Left job as a banker",
				happened_at: Date.UTC(2026, 7, 9, 12), happened_at_source: source,
			}]), plan);
			expect(context, String(source)).not.toContain("2026-08-09");
		}
	});

	it("omits a nonsensical timestamp even when provenance claims to be trusted", () => {
		for (const at of [0, -1, Number.NaN, null, undefined]) {
			const context = buildContext(node([{
				id: "e1", text: "Left job as a banker", happened_at: at, happened_at_source: "extracted",
			}]), plan);
			expect(context, String(at)).toContain("Left job as a banker");
			expect(context).not.toContain("(1970-");
		}
	});
});

describe("it does not state the same date twice", () => {
	it("leaves a fact alone when its text already carries the date", () => {
		// The extraction prompt asks for timing to be kept inside the text too, so
		// many facts already say it. " (2023-01-20)" appended reads as a second,
		// separate claim.
		const context = buildContext(node([{
			id: "e1", text: "Ran the charity race on 2023-05-07",
			happened_at: Date.UTC(2023, 4, 7, 12), happened_at_source: "extracted",
		}]), plan);
		expect(context).toContain("Ran the charity race on 2023-05-07");
		expect(context).not.toContain("2023-05-07 (2023-05-07)");
	});
});

describe("provenance is recorded end to end through a real extraction", () => {
	const proposal = (date) => ({
		objects: [
			{ kind: "node", label: "Charity race", category: "life_event", matches_existing: null, confidence: 0.95 },
			{
				kind: "event", on: "Charity race", action: "completed",
				text: "Ran the charity race", importance: "important", confidence: 0.95,
				...(date ? { date } : {}),
			},
		],
		notes: "test",
	});

	async function storedEvent(userId) {
		return env.DB.prepare(
			"SELECT happened_at, happened_at_source FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId).first();
	}

	it("marks a copied date 'extracted'", async () => {
		const userId = `d04_extracted_${Date.now().toString(36)}`;
		await runExtraction(env, userId, [{ id: "m-1", role: "user", content: "I ran the charity race on 7 May 2023", ts: Date.now() }], [], {
			llmResponse: proposal("2023-05-07"),
		});
		const row = await storedEvent(userId);
		expect(row.happened_at_source).toBe("extracted");
		expect(new Date(row.happened_at).toISOString().slice(0, 10)).toBe("2023-05-07");
	});

	it("marks an undated fact 'observed', so recall will not print its timestamp", async () => {
		const userId = `d04_observed_${Date.now().toString(36)}`;
		await runExtraction(env, userId, [{ id: "m-1", role: "user", content: "I ran the charity race", ts: Date.now() }], [], {
			llmResponse: proposal(null),
		});
		expect((await storedEvent(userId)).happened_at_source).toBe("observed");
	});
});
