/**
 * Deterministic temporal normalization.
 *
 * "I moved yesterday" is only meaningful relative to when it was said. Before
 * BF-1 the product had no way to know that, so the only anchor available was
 * extraction day and temporal recall sat at 6.23% — the one category that got
 * WORSE under semantic judging, which rules out wording as the explanation.
 *
 * Three commitments:
 *
 *   DETERMINISTIC FIRST. Every phrase here is resolved by code. No model call
 *   is made or needed. That makes it free, testable, and identical on replay.
 *
 *   ANCHORED ON THE SOURCE'S OWN DAY. The anchor carries a UTC offset, so the
 *   civil date used is the one the person was living in. "Yesterday" said at
 *   00:30+09:00 is the previous day in Tokyo, and the UTC instant of that
 *   moment falls on a date whose "yesterday" is a day earlier again.
 *
 *   NEVER FABRICATE PRECISION. "Someday", "eventually" and "in a while" resolve
 *   to nothing at all. A wrong date presented as certain is worse than no date:
 *   the graph will happily rank it, and the reader will happily believe it.
 *   Precision is carried alongside the date for the same reason — "last week"
 *   is a week, not a Thursday.
 */

import { persistedSourceTime } from "../lib/source_time.mjs";

export const TEMPORAL_SCHEMA = "itsuki.temporal/v1";
export const ATOMIC_TEMPORAL_SCHEMA = "itsuki.atomic-temporal/v1";

/** How sure we are of the day. Consumers must not present these as equal. */
export const TEMPORAL_PRECISIONS = ["day", "week", "month", "year"];

const MS_DAY = 86_400_000;

const MONTHS = [
	"january", "february", "march", "april", "may", "june",
	"july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const NUMBER_WORDS = {
	a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
	seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Phrases that sound temporal and carry no date. Listed explicitly so the
 * intent is visible: these must resolve to NOTHING, and a future contributor
 * adding "soon → +7 days" has to argue with this comment first.
 */
const UNRESOLVABLE = [
	"someday", "some day", "eventually", "in a while", "at some point",
	"sooner or later", "one of these days", "in the future", "down the line",
	"soon", "shortly", "recently", "a while ago", "ages ago", "the other day",
];

/** The civil date at the anchor, as [year, monthIndex, day]. */
function civilParts(epochMs, offsetMinutes) {
	const shifted = new Date(epochMs + (offsetMinutes ?? 0) * 60_000);
	return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()];
}

function iso(year, monthIndex, day) {
	return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function normalizedYearMonth(year, monthIndex) {
	const normalized = new Date(Date.UTC(year, monthIndex, 1));
	return [normalized.getUTCFullYear(), normalized.getUTCMonth()];
}

function daysInMonth(year, monthIndex) {
	const [normalizedYear, normalizedMonth] = normalizedYearMonth(year, monthIndex);
	return new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
}

function validCivilDate(year, monthIndex, day) {
	if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
	if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return false;
	if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, monthIndex)) return false;
	return true;
}

function shiftDays(year, monthIndex, day, delta) {
	const shifted = new Date(Date.UTC(year, monthIndex, day) + delta * MS_DAY);
	return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()];
}

function shiftMonths(year, monthIndex, day, delta) {
	const [targetYear, targetMonth] = normalizedYearMonth(year, monthIndex + delta);
	return [targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth))];
}

function shiftYears(year, monthIndex, day, delta) {
	const targetYear = year + delta;
	return [targetYear, monthIndex, Math.min(day, daysInMonth(targetYear, monthIndex))];
}

/** Choose the closest occurrence when tense is unavailable, preferring this year on a six-month tie. */
function nearestYearForMonth(targetMonth, year, anchorMonth) {
	const delta = targetMonth - anchorMonth;
	if (delta > 6) return year - 1;
	if (delta < -6) return year + 1;
	return year;
}

function result(year, monthIndex, day, precision, phrase, relation = "at") {
	const [normalizedYear, normalizedMonth] = normalizedYearMonth(year, monthIndex);
	const normalizedDay = Math.min(Math.max(1, Number(day)), daysInMonth(normalizedYear, normalizedMonth));
	const date = iso(normalizedYear, normalizedMonth, normalizedDay);
	return {
		schema: TEMPORAL_SCHEMA,
		date,
		end_date: null,
		precision,
		phrase,
		relation,
		// Midday UTC, matching how the gates already store a proposed date: it
		// keeps the calendar day stable under any reasonable local rendering.
		epoch_ms: Date.UTC(normalizedYear, normalizedMonth, normalizedDay, 12, 0, 0),
		end_epoch_ms: null,
	};
}

function explicitResult(year, monthIndex, day, precision, phrase, relation = "at") {
	return validCivilDate(year, monthIndex, day)
		? result(year, monthIndex, day, precision, phrase, relation)
		: null;
}

function rangeResult(start, end, precision, phrase) {
	if (!validCivilDate(...start) || !validCivilDate(...end)) return null;
	const startEpoch = Date.UTC(start[0], start[1], start[2], 12, 0, 0);
	const endEpoch = Date.UTC(end[0], end[1], end[2], 12, 0, 0);
	if (endEpoch < startEpoch) return null;
	return {
		schema: TEMPORAL_SCHEMA,
		date: iso(...start),
		end_date: iso(...end),
		precision,
		phrase,
		relation: "range",
		epoch_ms: startEpoch,
		end_epoch_ms: endEpoch,
	};
}

function count(word) {
	if (!word) return 1;
	const digits = Number(word);
	if (Number.isInteger(digits) && digits > 0 && digits < 1000) return digits;
	return NUMBER_WORDS[String(word).toLowerCase()] ?? null;
}

function monthIndexOf(name) {
	const value = String(name ?? "").toLowerCase();
	const full = MONTHS.indexOf(value);
	if (full !== -1) return full;
	const abbr = MONTH_ABBR.indexOf(value.slice(0, 3));
	return abbr === -1 ? null : abbr;
}

/**
 * Resolve one relative or explicit date phrase against an anchor.
 *
 * `anchor` is `{ epoch_ms, offset_minutes }` — normally the message's
 * `source_time`, falling back to when we observed it. Returns null when the
 * phrase names no date, which is a real and common answer.
 */
export function resolveTemporalPhrase(phrase, anchor) {
	const text = String(phrase ?? "").toLowerCase().trim();
	if (!text || !anchor || !Number.isFinite(Number(anchor.epoch_ms))) return null;
	const [year, monthIndex, day] = civilParts(Number(anchor.epoch_ms), anchor.offset_minutes ?? 0);

	for (const dead of UNRESOLVABLE) {
		if (text.includes(dead)) return null;
	}

	// ---- explicit dates -----------------------------------------------------
	// "14 to 21 June", with an optional year. This must run before the
	// single-date parser, which would otherwise silently keep only 21 June.
	const sameMonthRange = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:to|through|[-–—])\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*,?\s*(\d{4})?\b/.exec(text);
	if (sameMonthRange) {
		const month = monthIndexOf(sameMonthRange[3]);
		if (month !== null) {
			const targetYear = sameMonthRange[4]
				? Number(sameMonthRange[4])
				: nearestYearForMonth(month, year, monthIndex);
			return rangeResult(
				[targetYear, month, Number(sameMonthRange[1])],
				[targetYear, month, Number(sameMonthRange[2])],
				"day",
				phrase,
			);
		}
	}
	const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
	if (isoMatch) {
		const y = Number(isoMatch[1]);
		const m = Number(isoMatch[2]) - 1;
		const d = Number(isoMatch[3]);
		return explicitResult(y, m, d, "day", phrase);
	}
	// "3 November 2025", "3 Nov 2025"
	const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*,?\s*(\d{4})?\b/.exec(text);
	if (dmy) {
		const m = monthIndexOf(dmy[2]);
		if (m !== null) {
			const d = Number(dmy[1]);
			return explicitResult(dmy[3] ? Number(dmy[3]) : year, m, d, "day", phrase);
		}
	}
	// "November 3, 2025", "Nov 3 2025"
	const mdy = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})?\b/.exec(text);
	if (mdy) {
		const m = monthIndexOf(mdy[1]);
		if (m !== null) {
			const d = Number(mdy[2]);
			return explicitResult(mdy[3] ? Number(mdy[3]) : year, m, d, "day", phrase);
		}
	}

	// ---- day-level relatives ------------------------------------------------
	if (/\b(today|this morning|this afternoon|this evening|tonight|just now)\b/.test(text)) {
		return result(year, monthIndex, day, "day", phrase);
	}
	// Checked before the bare forms: "the day before yesterday" contains
	// "yesterday", and matching that first would silently lose a day.
	if (/\bday before yesterday\b/.test(text)) {
		return result(...shiftDays(year, monthIndex, day, -2), "day", phrase);
	}
	if (/\bday after tomorrow\b/.test(text)) {
		return result(...shiftDays(year, monthIndex, day, 2), "day", phrase);
	}
	if (/\byesterday\b/.test(text)) {
		return result(...shiftDays(year, monthIndex, day, -1), "day", phrase);
	}
	if (/\btomorrow\b/.test(text)) {
		return result(...shiftDays(year, monthIndex, day, 1), "day", phrase);
	}

	// ---- "N <unit> ago" / "in N <unit>" ------------------------------------
	const ago = /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\s+ago\b/.exec(text);
	if (ago) {
		const n = count(ago[1]);
		if (n !== null) {
			if (ago[2] === "day") return result(...shiftDays(year, monthIndex, day, -n), "day", phrase);
			if (ago[2] === "week") return result(...shiftDays(year, monthIndex, day, -7 * n), "week", phrase);
			if (ago[2] === "month") return result(...shiftMonths(year, monthIndex, day, -n), "month", phrase);
			return result(...shiftYears(year, monthIndex, day, -n), "year", phrase);
		}
	}
	const future = /\bin\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\b/.exec(text);
	if (future) {
		const n = count(future[1]);
		if (n !== null) {
			if (future[2] === "day") return result(...shiftDays(year, monthIndex, day, n), "day", phrase);
			if (future[2] === "week") return result(...shiftDays(year, monthIndex, day, 7 * n), "week", phrase);
			if (future[2] === "month") return result(...shiftMonths(year, monthIndex, day, n), "month", phrase);
			return result(...shiftYears(year, monthIndex, day, n), "year", phrase);
		}
	}

	// ---- "the start/end of last/this/next month" ---------------------------
	const edge = /\b(start|beginning|end)\s+of\s+(last|this|next)\s+(month|year)\b/.exec(text);
	if (edge) {
		const delta = edge[2] === "last" ? -1 : edge[2] === "next" ? 1 : 0;
		if (edge[3] === "month") {
			const target = monthIndex + delta;
			const [targetYear, targetMonth] = normalizedYearMonth(year, target);
			return edge[1] === "end"
				? result(targetYear, targetMonth, daysInMonth(targetYear, targetMonth), "month", phrase)
				: result(targetYear, targetMonth, 1, "month", phrase);
		}
		return edge[1] === "end"
			? result(year + delta, 11, 31, "year", phrase)
			: result(year + delta, 0, 1, "year", phrase);
	}

	// ---- last/next/this <weekday> ------------------------------------------
	const weekday = /\b(last|next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
	if (weekday) {
		const targetDow = WEEKDAYS.indexOf(weekday[2]);
		const currentDow = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
		if (weekday[1] === "last") {
			// The most recent one strictly before today.
			let back = currentDow - targetDow;
			if (back <= 0) back += 7;
			return result(...shiftDays(year, monthIndex, day, -back), "day", phrase);
		}
		if (weekday[1] === "next") {
			// The one in the FOLLOWING week, not merely the next occurrence:
			// said on a Thursday, "next Friday" is eight days away, not one.
			let forward = targetDow - currentDow;
			if (forward <= 0) forward += 7;
			return result(...shiftDays(year, monthIndex, day, forward + 7), "day", phrase);
		}
		let forward = targetDow - currentDow;
		if (forward < 0) forward += 7;
		return result(...shiftDays(year, monthIndex, day, forward), "day", phrase);
	}

	// ---- last/this/next week|month|year ------------------------------------
	// Weeks are anchor-relative with week precision: we know which week, not
	// which day, and pretending otherwise is exactly the fabricated precision
	// this module refuses.
	const period = /\b(last|this|next)\s+(week|month|year)\b/.exec(text);
	if (period) {
		const delta = period[1] === "last" ? -1 : period[1] === "next" ? 1 : 0;
		if (period[2] === "week") return result(...shiftDays(year, monthIndex, day, 7 * delta), "week", phrase);
		if (period[2] === "month") return result(year, monthIndex + delta, 1, "month", phrase);
		return result(year + delta, 0, 1, "year", phrase);
	}

	// ---- a bare month name: "since March", "back in October" ----------------
	const midMonth = /\bmid[-\s]+([a-z]{3,9})\b/.exec(text);
	if (midMonth) {
		const month = monthIndexOf(midMonth[1]);
		if (month !== null) return result(nearestYearForMonth(month, year, monthIndex), month, 1, "month", phrase, "during");
	}
	const bareMonth = /\b(since|in|back in|during|from)\s+([a-z]{3,9})\b/.exec(text);
	if (bareMonth) {
		const relation = bareMonth[1];
		const m = monthIndexOf(bareMonth[2]);
		if (m !== null) {
			// Since/back-in/from are backward-looking. A bare "in August" has no
			// tense, so choose the closest civil occurrence rather than silently
			// forcing every future plan into last year.
			const pastOnly = relation === "since" || relation === "back in" || relation === "from";
			const y = pastOnly ? (m <= monthIndex ? year : year - 1) : nearestYearForMonth(m, year, monthIndex);
			return result(y, m, 1, "month", phrase, relation === "since" ? "since" : "during");
		}
	}
	// A bare year: "in 2019".
	const bareYear = /\b(?:since|in|back in|during|from)\s+(\d{4})\b/.exec(text);
	if (bareYear) {
		const y = Number(bareYear[1]);
		if (y >= 1900 && y <= year + 1) return result(y, 0, 1, "year", phrase);
	}

	return null;
}

/**
 * The anchor for one message: its own source time when the caller supplied one,
 * otherwise when we observed it. The `kind` is returned rather than inferred,
 * so a consumer can tell an authoritative anchor from a fallback.
 */
export function messageAnchor(message) {
	const source = persistedSourceTime(message?.source_time);
	if (source) {
		return {
			kind: "source_time",
			epoch_ms: source.epoch_ms,
			offset_minutes: source.offset_minutes ?? 0,
			precision: source.precision,
		};
	}
	const observed = Number(message?.ts);
	if (Number.isFinite(observed) && observed > 0) {
		return { kind: "observed_at", epoch_ms: observed, offset_minutes: 0, precision: "time" };
	}
	return null;
}

/**
 * The anchor for a whole chunk: the NEWEST message's, because a relative phrase
 * refers to the moment it was written and the last message is the closest thing
 * the chunk has to "now". Prefers a real source time over an observation even
 * when the observation is newer — an authoritative anchor for the wrong minute
 * beats a precise one for the wrong day.
 */
export function chunkAnchor(messages = []) {
	let best = null;
	for (const message of messages ?? []) {
		const anchor = messageAnchor(message);
		if (!anchor) continue;
		if (!best) { best = anchor; continue; }
		if (best.kind === "observed_at" && anchor.kind === "source_time") { best = anchor; continue; }
		if (best.kind === anchor.kind && anchor.epoch_ms > best.epoch_ms) best = anchor;
	}
	return best;
}

/**
 * Find the date a fact refers to, from its own text, anchored on when it was
 * said. Returns null when the text names no date — the caller then falls back
 * to whatever it used before, unchanged.
 */
export function resolveFactDate(text, anchor) {
	if (!anchor) return null;
	return resolveTemporalPhrase(text, anchor);
}

/**
 * Convert one exact source-grounded phrase into the immutable representation
 * stored beside an atomic candidate. This never inspects unrelated messages,
 * never calls a model, and never substitutes wall-clock time for a missing
 * anchor.
 */
export function normalizeAtomicTemporal(phrase, message) {
	const raw = typeof phrase === "string" ? phrase : "";
	const empty = {
		schema: ATOMIC_TEMPORAL_SCHEMA,
		eventTime: null,
		eventTimeEnd: null,
		eventTimePrecision: null,
		eventTimeRelation: null,
		eventTimeSource: null,
		eventTimeAnchor: null,
	};
	if (!raw.trim()) return { ...empty, outcome: "absent" };
	const anchor = messageAnchor(message);
	if (!anchor) return { ...empty, outcome: "anchor_missing" };
	const resolved = resolveTemporalPhrase(raw, anchor);
	if (!resolved) return { ...empty, outcome: "unresolvable" };
	return {
		schema: ATOMIC_TEMPORAL_SCHEMA,
		outcome: "resolved",
		eventTime: resolved.epoch_ms,
		eventTimeEnd: resolved.end_epoch_ms ?? null,
		eventTimePrecision: resolved.precision,
		eventTimeRelation: resolved.relation ?? "at",
		eventTimeSource: "phrase",
		eventTimeAnchor: anchor.kind,
	};
}
