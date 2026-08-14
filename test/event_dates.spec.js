import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { runExtraction } from "../src/pipeline/extract.js";

/**
 * V3-D03 — the extractor's proposed event date never reached storage.
 *
 * The extraction prompt tells the model, in as many words:
 *
 *   Events MAY carry "date" (YYYY-MM-DD): COPY it from an explicit date in the
 *   text or the message timestamp. NEVER invent or guess a date.
 *
 * The gate that consumes that field parsed it with
 *
 *   /^s*(d{4})-(d{2})-(d{2})s*$/
 *
 * — the backslashes are missing, so the pattern matches the literal text
 * "sssd{4}-d{2}-d{2}" and never a date. Every proposed date therefore failed to
 * parse and every event's happened_at silently fell back to the message
 * timestamp, which is when Itsuki was TOLD, not when the thing happened.
 *
 * This suite pins the field end to end through the real extraction path.
 */

const V3 = (userId) => ({ ...env, ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: userId });

let counter = 0;
const nextUser = (tag) => `evdate_${tag}_${Date.now().toString(36)}_${counter++}`;

const INGESTED_AT = Date.parse("2026-08-09T09:00:00Z");

function chunk(content, extra = {}) {
	return [{ id: "m-1", role: "user", content, ts: INGESTED_AT, ...extra }];
}

const proposal = (date) => ({
	objects: [
		{ kind: "node", label: "Charity race", category: "life_event", matches_existing: null, confidence: 0.95 },
		{
			kind: "event",
			on: "Charity race",
			action: "completed",
			text: "Ran the charity race",
			importance: "important",
			confidence: 0.95,
			...(date ? { date } : {}),
		},
	],
	notes: "test",
});

async function storedEvent(userId) {
	return env.DB.prepare(
		"SELECT text, happened_at, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
	).bind(userId).first();
}

describe("a date the extractor copied out of the text is stored", () => {
	it("uses the proposed date, not the moment we were told", async () => {
		const userId = nextUser("proposed");
		const result = await runExtraction(env, userId, chunk("I ran the charity race on 7 May 2023"), [], {
			llmResponse: proposal("2023-05-07"),
		});
		expect(result.outcome).toBe("wrote");

		const event = await storedEvent(userId);
		expect(new Date(event.happened_at).toISOString().slice(0, 10)).toBe("2023-05-07");
		// The old behaviour, for contrast: happened_at === the ingest timestamp.
		expect(event.happened_at).not.toBe(INGESTED_AT);
	});

	it("falls back to the message timestamp when the extractor proposes no date", async () => {
		const userId = nextUser("nodate");
		await runExtraction(env, userId, chunk("I ran the charity race"), [], { llmResponse: proposal(null) });
		const event = await storedEvent(userId);
		expect(event.happened_at).toBe(INGESTED_AT);
	});

	it("ignores a malformed or invented date rather than storing nonsense", async () => {
		for (const bad of ["not-a-date", "07/05/2023", "2023-13-45", "", "   ", "yesterday"]) {
			const userId = nextUser("bad");
			await runExtraction(env, userId, chunk("I ran the charity race"), [], { llmResponse: proposal(bad) });
			const event = await storedEvent(userId);
			expect(event.happened_at, bad).toBe(INGESTED_AT);
		}
	});

	it("refuses a date in the future, which is a copy error rather than a memory", async () => {
		const userId = nextUser("future");
		const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
		await runExtraction(env, userId, chunk("I ran the charity race"), [], { llmResponse: proposal(future) });
		const event = await storedEvent(userId);
		expect(event.happened_at).toBe(INGESTED_AT);
	});
});

describe("undated events anchor on when the content was written", () => {
	it("uses the source time rather than the ingest clock for a V3 account", async () => {
		// BF-1's whole purpose: a conversation imported in 2026 that happened in
		// 2023 must not have its events dated 2026.
		const userId = nextUser("anchor");
		const sourceTime = { epoch_ms: Date.parse("2023-01-20T16:04:00Z"), offset_minutes: 0, precision: "time" };
		await runExtraction(
			V3(userId),
			userId,
			chunk("I ran the charity race", { source_time: sourceTime }),
			[],
			{ llmResponse: proposal(null) },
		);
		const event = await storedEvent(userId);
		expect(new Date(event.happened_at).toISOString().slice(0, 10)).toBe("2023-01-20");
	});

	it("resolves a relative phrase in the fact's own words against that source time", async () => {
		const userId = nextUser("relative");
		const sourceTime = { epoch_ms: Date.parse("2025-09-18T08:00:00Z"), offset_minutes: 0, precision: "time" };
		await runExtraction(
			V3(userId),
			userId,
			chunk("I moved into the flat on Wexford Street yesterday", { source_time: sourceTime }),
			[],
			{
				llmResponse: {
					objects: [
						{ kind: "node", label: "Wexford Street", category: "place", matches_existing: null, confidence: 0.95 },
						{
							kind: "event",
							on: "Wexford Street",
							action: "moved",
							text: "Moved into the flat on Wexford Street yesterday",
							importance: "important",
							confidence: 0.95,
						},
					],
					notes: "test",
				},
			},
		);
		const event = await storedEvent(userId);
		expect(new Date(event.happened_at).toISOString().slice(0, 10)).toBe("2025-09-17");
	});

	it("leaves a legacy account on the ingest clock exactly as before", async () => {
		const userId = nextUser("legacy");
		const legacyEnv = { ...env, ITSUKI_MEMORY_V3: "off", ITSUKI_MEMORY_V3_USERS: "" };
		await runExtraction(
			legacyEnv,
			userId,
			chunk("I moved into the flat on Wexford Street yesterday"),
			[],
			{
				llmResponse: {
					objects: [
						{ kind: "node", label: "Wexford Street", category: "place", matches_existing: null, confidence: 0.95 },
						{
							kind: "event",
							on: "Wexford Street",
							action: "moved",
							text: "Moved into the flat on Wexford Street yesterday",
							importance: "important",
							confidence: 0.95,
						},
					],
					notes: "test",
				},
			},
		);
		const event = await storedEvent(userId);
		expect(event.happened_at).toBe(INGESTED_AT);
	});

	it("still prefers an explicitly proposed date over the anchor", async () => {
		const userId = nextUser("precedence");
		const sourceTime = { epoch_ms: Date.parse("2025-09-18T08:00:00Z"), offset_minutes: 0, precision: "time" };
		await runExtraction(
			V3(userId),
			userId,
			chunk("I ran the charity race on 7 May 2023", { source_time: sourceTime }),
			[],
			{ llmResponse: proposal("2023-05-07") },
		);
		const event = await storedEvent(userId);
		expect(new Date(event.happened_at).toISOString().slice(0, 10)).toBe("2023-05-07");
	});
});
