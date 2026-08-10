import { describe, expect, it } from "vitest";

import {
	chunkAnchor,
	messageAnchor,
	normalizeAtomicTemporal,
	resolveFactDate,
	resolveTemporalPhrase,
} from "../src/pipeline/temporal.js";
import { parseSourceTime } from "../src/lib/source_time.mjs";

/**
 * P1 — temporal normalization, anchored on when something was SAID.
 *
 * Temporal is the only LoCoMo category that got worse under semantic judging
 * (6.81% token-F1 → 6.23% judge), which rules out wording and points at a
 * genuine inability to place events in time. Every assertion here runs with
 * zero inference: the resolver is a pure function of (phrase, anchor).
 */

const anchorAt = (text) => {
	const { time } = parseSourceTime(text);
	return { epoch_ms: time.epoch_ms, offset_minutes: time.offset_minutes ?? 0 };
};

// Thursday 18 September 2025, 08:00 UTC.
const THU = anchorAt("2025-09-18T08:00:00Z");

describe("relative phrases resolve against the anchor", () => {
	const cases = [
		["today", "2025-09-18", "day"],
		["this morning", "2025-09-18", "day"],
		["yesterday", "2025-09-17", "day"],
		["the day before yesterday", "2025-09-16", "day"],
		["tomorrow", "2025-09-19", "day"],
		["three days ago", "2025-09-15", "day"],
		["10 days ago", "2025-09-08", "day"],
		["last week", "2025-09-11", "week"],
		["this week", "2025-09-18", "week"],
		["next week", "2025-09-25", "week"],
		["two weeks ago", "2025-09-04", "week"],
		["last month", "2025-08-01", "month"],
		["three months ago", "2025-06-18", "month"],
		["two years ago", "2023-09-18", "year"],
		["last year", "2024-01-01", "year"],
		["the start of last month", "2025-08-01", "month"],
		["the end of last month", "2025-08-31", "month"],
	];

	for (const [phrase, date, precision] of cases) {
		it(`resolves "${phrase}"`, () => {
			const resolved = resolveTemporalPhrase(phrase, THU);
			expect(resolved?.date, phrase).toBe(date);
			expect(resolved?.precision, phrase).toBe(precision);
		});
	}
});

describe("weekday phrases", () => {
	it("looks backwards for 'last <weekday>'", () => {
		expect(resolveTemporalPhrase("last Saturday", THU).date).toBe("2025-09-13");
		expect(resolveTemporalPhrase("last Wednesday", THU).date).toBe("2025-09-17");
	});

	it("means the FOLLOWING week for 'next <weekday>', not merely the next occurrence", () => {
		// Said on a Thursday, "next Friday" is eight days away, not one.
		expect(resolveTemporalPhrase("next Friday", THU).date).toBe("2025-09-26");
		expect(resolveTemporalPhrase("this Friday", THU).date).toBe("2025-09-19");
	});

	it("treats today's own weekday as today under 'this'", () => {
		expect(resolveTemporalPhrase("this Thursday", THU).date).toBe("2025-09-18");
	});
});

describe("explicit dates", () => {
	const cases = [
		["3 November 2025", "2025-11-03"],
		["3rd November 2025", "2025-11-03"],
		["November 3, 2025", "2025-11-03"],
		["3 Nov 2025", "2025-11-03"],
		["2025-11-03", "2025-11-03"],
		["6 January 2025", "2025-01-06"],
	];
	for (const [phrase, date] of cases) {
		it(`reads "${phrase}"`, () => {
			const resolved = resolveTemporalPhrase(phrase, THU);
			expect(resolved?.date, phrase).toBe(date);
			expect(resolved?.precision).toBe("day");
		});
	}

	it("fills a missing year from the anchor rather than guessing", () => {
		expect(resolveTemporalPhrase("on 3 November", THU).date).toBe("2025-11-03");
	});

	it("rejects impossible calendar dates instead of normalizing their overflow", () => {
		expect(resolveTemporalPhrase("2025-02-31", THU)).toBe(null);
		expect(resolveTemporalPhrase("31 February 2025", THU)).toBe(null);
		expect(resolveTemporalPhrase("April 31, 2025", THU)).toBe(null);
	});
});

describe("bare months and years", () => {
	it("picks the most recent past occurrence of a bare month", () => {
		expect(resolveTemporalPhrase("since March", THU).date).toBe("2025-03-01");
		expect(resolveTemporalPhrase("since March", anchorAt("2025-02-10T00:00:00Z")).date).toBe("2024-03-01");
	});

	it("reads a bare year", () => {
		const resolved = resolveTemporalPhrase("back in 2019", THU);
		expect(resolved.date).toBe("2019-01-01");
		expect(resolved.precision).toBe("year");
	});

	it("uses the nearest civil occurrence for an otherwise unqualified month", () => {
		expect(resolveTemporalPhrase("in August", anchorAt("2026-02-11T08:11:00Z")).date).toBe("2026-08-01");
		expect(resolveTemporalPhrase("in October", anchorAt("2026-01-19T11:09:00Z")).date).toBe("2025-10-01");
	});
});

describe("future offsets and explicit ranges", () => {
	it("resolves a future relative offset without changing its stated precision", () => {
		const resolved = resolveTemporalPhrase("in two weeks", THU);
		expect(resolved.date).toBe("2025-10-02");
		expect(resolved.precision).toBe("week");
		expect(resolved.relation).toBe("at");
	});

	it("clamps month arithmetic to the target month's last real day", () => {
		expect(resolveTemporalPhrase("one month ago", anchorAt("2025-03-31T08:00:00Z")).date).toBe("2025-02-28");
		expect(resolveTemporalPhrase("one month ago", anchorAt("2024-03-31T08:00:00Z")).date).toBe("2024-02-29");
	});

	it("represents both endpoints of an explicit same-month range", () => {
		const resolved = resolveTemporalPhrase("14 to 21 June", anchorAt("2026-02-11T08:02:00Z"));
		expect(resolved).toMatchObject({
			date: "2026-06-14",
			end_date: "2026-06-21",
			precision: "day",
			relation: "range",
		});
	});
});

describe("it refuses to fabricate precision", () => {
	const vague = [
		"someday", "eventually", "in a while", "at some point", "sooner or later",
		"soon", "recently", "a while ago", "the other day", "in the future",
	];
	for (const phrase of vague) {
		it(`resolves "${phrase}" to nothing`, () => {
			expect(resolveTemporalPhrase(phrase, THU)).toBe(null);
		});
	}

	it("resolves text with no date at all to nothing", () => {
		expect(resolveTemporalPhrase("I prefer tabs over spaces", THU)).toBe(null);
		expect(resolveTemporalPhrase("", THU)).toBe(null);
	});

	it("resolves to nothing without an anchor, rather than falling back to now", () => {
		expect(resolveTemporalPhrase("yesterday", null)).toBe(null);
		expect(resolveTemporalPhrase("yesterday", { epoch_ms: Number.NaN })).toBe(null);
	});

	it("carries precision so a week is never presented as a day", () => {
		expect(resolveTemporalPhrase("last week", THU).precision).toBe("week");
		expect(resolveTemporalPhrase("yesterday", THU).precision).toBe("day");
	});
});

describe("the anchor is the source's own civil day, not UTC's", () => {
	it("resolves 'yesterday' in the writer's timezone", () => {
		// 00:30 in Tokyo on the 18th is 15:30 UTC on the 17th. Yesterday is the
		// 17th locally; anchoring on the UTC date would answer the 16th.
		const tokyo = anchorAt("2025-09-18T00:30:00+09:00");
		expect(resolveTemporalPhrase("yesterday", tokyo).date).toBe("2025-09-17");
	});

	it("resolves 'today' across a westward offset", () => {
		// 20:00 in Los Angeles on 1 January is 04:00 UTC on 2 January.
		const la = anchorAt("2025-01-01T20:00:00-08:00");
		expect(resolveTemporalPhrase("today", la).date).toBe("2025-01-01");
	});

	it("handles both sides of a DST change without being told about DST", () => {
		expect(resolveTemporalPhrase("today", anchorAt("2025-01-15T12:00:00+01:00")).date).toBe("2025-01-15");
		expect(resolveTemporalPhrase("today", anchorAt("2025-07-15T12:00:00+02:00")).date).toBe("2025-07-15");
	});

	it("crosses a month boundary correctly", () => {
		expect(resolveTemporalPhrase("yesterday", anchorAt("2025-03-01T09:00:00Z")).date).toBe("2025-02-28");
		expect(resolveTemporalPhrase("yesterday", anchorAt("2024-03-01T09:00:00Z")).date).toBe("2024-02-29");
	});

	it("crosses a year boundary correctly", () => {
		expect(resolveTemporalPhrase("yesterday", anchorAt("2025-01-01T09:00:00Z")).date).toBe("2024-12-31");
		expect(resolveTemporalPhrase("tomorrow", anchorAt("2025-12-31T09:00:00Z")).date).toBe("2026-01-01");
	});
});

describe("choosing the anchor", () => {
	it("prefers a message's own source time over when we observed it", () => {
		const anchor = messageAnchor({
			ts: Date.parse("2026-08-09T00:00:00Z"),
			source_time: { epoch_ms: Date.parse("2023-01-20T16:04:00Z"), offset_minutes: 0, precision: "time" },
		});
		expect(anchor.kind).toBe("source_time");
		expect(anchor.epoch_ms).toBe(Date.parse("2023-01-20T16:04:00Z"));
	});

	it("falls back to observation time and labels it as such", () => {
		const anchor = messageAnchor({ ts: 1_700_000_000_000 });
		expect(anchor.kind).toBe("observed_at");
	});

	it("takes the newest message as the chunk's anchor", () => {
		const anchor = chunkAnchor([
			{ ts: Date.parse("2025-09-16T10:00:00Z") },
			{ ts: Date.parse("2025-09-18T10:00:00Z") },
			{ ts: Date.parse("2025-09-17T10:00:00Z") },
		]);
		expect(new Date(anchor.epoch_ms).toISOString()).toBe("2025-09-18T10:00:00.000Z");
	});

	it("prefers an authoritative anchor over a newer observation", () => {
		// A source time for the wrong minute beats an observation for the wrong day.
		const anchor = chunkAnchor([
			{ ts: Date.parse("2026-08-09T00:00:00Z") },
			{
				ts: Date.parse("2026-08-09T00:00:00Z"),
				source_time: { epoch_ms: Date.parse("2023-01-20T16:04:00Z"), offset_minutes: 0, precision: "time" },
			},
		]);
		expect(anchor.kind).toBe("source_time");
	});

	it("has no anchor when a chunk carries no usable time", () => {
		expect(chunkAnchor([])).toBe(null);
		expect(chunkAnchor([{ ts: 0 }])).toBe(null);
	});
});

describe("resolving a fact's date from its own words", () => {
	it("finds the phrase inside a sentence", () => {
		expect(resolveFactDate("Moved into the flat on Wexford Street yesterday", THU).date).toBe("2025-09-17");
		expect(resolveFactDate("Contract at the co-op ends next Friday", THU).date).toBe("2025-09-26");
	});

	it("returns nothing for a fact with no date, leaving the caller's fallback alone", () => {
		expect(resolveFactDate("Prefers short, decision-first explanations", THU)).toBe(null);
	});

	it("returns nothing without an anchor", () => {
		expect(resolveFactDate("Moved in yesterday", null)).toBe(null);
	});
});

describe("atomic temporal representation", () => {
	it("binds a normalized phrase to the exact message source-time anchor", () => {
		const normalized = normalizeAtomicTemporal("yesterday", {
			ts: Date.parse("2026-08-11T12:00:00Z"),
			source_time: {
				epoch_ms: Date.parse("2025-09-18T08:00:00Z"),
				offset_minutes: 0,
				precision: "time",
			},
		});
		expect(normalized).toMatchObject({
			schema: "itsuki.atomic-temporal/v1",
			outcome: "resolved",
			eventTime: Date.UTC(2025, 8, 17, 12),
			eventTimeEnd: null,
			eventTimePrecision: "day",
			eventTimeRelation: "at",
			eventTimeSource: "phrase",
			eventTimeAnchor: "source_time",
		});
	});

	it("labels observation fallback and never pretends it was authoritative source time", () => {
		const normalized = normalizeAtomicTemporal("today", { ts: Date.parse("2025-09-18T08:00:00Z") });
		expect(normalized).toMatchObject({ outcome: "resolved", eventTimeAnchor: "observed_at" });
	});

	it("keeps absent and unresolvable phrases distinct without fabricated values", () => {
		expect(normalizeAtomicTemporal("   ", { ts: THU.epoch_ms })).toMatchObject({
			outcome: "absent", eventTime: null, eventTimePrecision: null,
		});
		expect(normalizeAtomicTemporal("eventually", { ts: THU.epoch_ms })).toMatchObject({
			outcome: "unresolvable", eventTime: null, eventTimePrecision: null,
		});
	});
});
