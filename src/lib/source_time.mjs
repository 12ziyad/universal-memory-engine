/**
 * The authoritative source-time contract (BF-1).
 *
 * Itsuki already records when it RECEIVED a message. It had no way to be told
 * when the message was actually SAID. Those are different facts, and conflating
 * them is why "I moved yesterday" could never be placed: the only anchor
 * available was extraction day.
 *
 *   source_time  — when the message was written/said. Caller-supplied,
 *                  authoritative, optional.
 *   observed_at  — when Itsuki received it. Server clock. Always present.
 *
 * This module is deliberately runtime-neutral (no Workers APIs, no imports) so
 * the Worker, the SDKs, and the local plugin outboxes can share one definition
 * of what a valid source time is and what it means.
 *
 * Three decisions worth stating, because each rules out a whole class of silent
 * wrongness:
 *
 *   1. A date-time with NO offset is REFUSED, not guessed. `new Date("2025-09-18T08:00:00")`
 *      resolves against whatever zone the runtime happens to be in; on a Worker
 *      that is UTC, on a laptop it is not, so the same string would mean two
 *      different instants. Callers must write `Z` or `+02:00`.
 *   2. The offset is KEPT, not folded away. "Yesterday" said at
 *      2025-09-18T00:30+09:00 means 2025-09-17 in Tokyo, but the UTC instant
 *      falls on 2025-09-17T15:30Z, whose UTC date is the 17th and whose
 *      "yesterday" would be the 16th. Local civil date is the only correct
 *      anchor for a relative phrase, so we retain what we need to compute it.
 *   3. A date-only value keeps `precision: "day"`. It is not promoted to
 *      midnight-precision; nothing downstream may invent a time of day.
 */

export const SOURCE_TIME_SCHEMA = "itsuki.source-time/v1";

/**
 * Earliest accepted source time: strictly after the Unix epoch day.
 *
 * The bound is not about history — it is about sentinels. `0`, a zeroed struct
 * field, and a negative rollover are the three ways an uninitialised timestamp
 * arrives, and all of them land on or before 1970-01-01. Accepting them would
 * anchor every relative phrase in that packet to 1970 while looking perfectly
 * authoritative. Genuinely older material still ingests fine; its date belongs
 * in the message text, where nothing pretends to have machine precision.
 */
export const SOURCE_TIME_MIN_MS = Date.UTC(1970, 0, 2);
/** How far ahead of the server clock a source time may sit before it is a clock fault. */
export const SOURCE_TIME_MAX_SKEW_MS = 48 * 60 * 60 * 1000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const OFFSET_SUFFIX = /([+-])(\d{2}):(\d{2})$/;

function refuse(code, message) {
	return { ok: false, code, message };
}

/**
 * Parse one source-time value.
 *
 * Accepts: epoch milliseconds (integer), `YYYY-MM-DD`, or an ISO-8601 date-time
 * that carries `Z` or a `±HH:MM` offset.
 *
 * Returns `{ ok: true, time }` or `{ ok: false, code, message }`. It never
 * throws and never guesses — an unusable value is named, not dropped.
 */
export function parseSourceTime(value, { now = Date.now() } = {}) {
	if (value === undefined || value === null) return { ok: true, time: null };

	let epochMs;
	let offsetMinutes = null;
	let precision = "time";
	let text;

	if (typeof value === "number") {
		if (!Number.isFinite(value) || !Number.isInteger(value)) {
			return refuse("invalid_source_time", "sourceTime as a number must be whole epoch milliseconds.");
		}
		epochMs = value;
		offsetMinutes = 0;
		text = new Date(value).toISOString();
	} else if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return refuse("invalid_source_time", "sourceTime must not be empty. Omit it instead.");
		if (/^-?\d+$/.test(raw)) {
			return refuse(
				"invalid_source_time",
				"sourceTime looks like epoch milliseconds sent as a string. Send it as a JSON number, or as an ISO-8601 timestamp.",
			);
		}
		const dateOnly = DATE_ONLY.exec(raw);
		if (dateOnly) {
			const [, y, m, d] = dateOnly;
			const year = Number(y);
			const month = Number(m);
			const day = Number(d);
			if (month < 1 || month > 12 || day < 1 || day > 31) {
				return refuse("invalid_source_time", `sourceTime "${raw}" is not a real calendar date.`);
			}
			epochMs = Date.UTC(year, month - 1, day);
			// Round-trip check catches 2025-02-30 and friends, which Date.UTC rolls over.
			const back = new Date(epochMs);
			if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
				return refuse("invalid_source_time", `sourceTime "${raw}" is not a real calendar date.`);
			}
			precision = "day";
			offsetMinutes = null; // a bare date names a civil day, not an instant in a zone
			text = raw;
		} else if (DATE_TIME_OFFSET.test(raw)) {
			const parsed = Date.parse(raw);
			if (!Number.isFinite(parsed)) {
				return refuse("invalid_source_time", `sourceTime "${raw}" is not a valid ISO-8601 timestamp.`);
			}
			epochMs = parsed;
			const suffix = OFFSET_SUFFIX.exec(raw);
			if (suffix) {
				const sign = suffix[1] === "-" ? -1 : 1;
				const hours = Number(suffix[2]);
				const minutes = Number(suffix[3]);
				if (hours > 18 || minutes > 59) {
					return refuse("invalid_source_time", `sourceTime "${raw}" has a UTC offset that does not exist.`);
				}
				offsetMinutes = sign * (hours * 60 + minutes);
			} else {
				offsetMinutes = 0; // the Z form
			}
			text = raw;
		} else if (/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/.test(raw)) {
			return refuse(
				"source_time_missing_offset",
				`sourceTime "${raw}" has no UTC offset. Add "Z" or an offset like "+02:00" — without one the same text means a different instant on every machine.`,
			);
		} else {
			return refuse(
				"invalid_source_time",
				`sourceTime "${raw}" is not recognised. Use epoch milliseconds, "YYYY-MM-DD", or an ISO-8601 timestamp with an offset.`,
			);
		}
	} else {
		return refuse("invalid_source_time", "sourceTime must be a string or a number.");
	}

	if (epochMs < SOURCE_TIME_MIN_MS) {
		return refuse(
			"source_time_out_of_range",
			`sourceTime is on or before ${new Date(SOURCE_TIME_MIN_MS).toISOString().slice(0, 10)}, which is how an uninitialised timestamp looks rather than a real one. If the content genuinely predates that, record the date inside the message text instead.`,
		);
	}
	if (epochMs > now + SOURCE_TIME_MAX_SKEW_MS) {
		return refuse(
			"source_time_in_future",
			"sourceTime is more than 48 hours in the future, which is a clock or timezone fault rather than a memory. Send the real time the message was written.",
		);
	}

	return { ok: true, time: { epoch_ms: epochMs, offset_minutes: offsetMinutes, precision, text } };
}

/** Compact persisted form. Null in, null out. */
export function normalizeSourceTime(time) {
	if (!time) return null;
	return {
		epoch_ms: time.epoch_ms,
		offset_minutes: time.offset_minutes ?? null,
		precision: time.precision === "day" ? "day" : "time",
		text: String(time.text ?? new Date(time.epoch_ms).toISOString()),
	};
}

/** Re-read a persisted source time, rejecting anything that is not one. */
export function persistedSourceTime(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const epoch = Number(value.epoch_ms);
	if (!Number.isFinite(epoch) || !Number.isInteger(epoch)) return null;
	if (epoch < SOURCE_TIME_MIN_MS) return null;
	const offset = value.offset_minutes;
	const offsetMinutes = offset === null || offset === undefined
		? null
		: (Number.isInteger(Number(offset)) && Math.abs(Number(offset)) <= 18 * 60 ? Number(offset) : null);
	return {
		epoch_ms: epoch,
		offset_minutes: offsetMinutes,
		precision: value.precision === "day" ? "day" : "time",
		text: typeof value.text === "string" && value.text ? value.text : new Date(epoch).toISOString(),
	};
}

/**
 * The calendar date the source was ON, in the source's own frame. This — not the
 * UTC date, and not extraction day — is what a relative phrase resolves against.
 */
export function sourceCivilDate(time) {
	const t = persistedSourceTime(time);
	if (!t) return null;
	const shifted = new Date(t.epoch_ms + (t.offset_minutes ?? 0) * 60_000);
	return shifted.toISOString().slice(0, 10);
}

/**
 * The anchor a downstream consumer should use: the source time when the caller
 * gave one, otherwise the observation time. Callers that must know WHICH they
 * got can read `.kind` rather than inferring it from a timestamp's shape.
 */
export function temporalAnchor({ sourceTime = null, observedAt = null } = {}) {
	const source = persistedSourceTime(sourceTime);
	if (source) return { kind: "source_time", epoch_ms: source.epoch_ms, offset_minutes: source.offset_minutes ?? 0, precision: source.precision };
	const observed = Number(observedAt);
	if (Number.isFinite(observed) && observed > 0) {
		return { kind: "observed_at", epoch_ms: observed, offset_minutes: 0, precision: "time" };
	}
	return null;
}
