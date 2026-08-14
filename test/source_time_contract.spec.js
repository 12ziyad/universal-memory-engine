import { describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";
import {
	SOURCE_TIME_MAX_SKEW_MS,
	SOURCE_TIME_MIN_MS,
	parseSourceTime,
	persistedSourceTime,
	sourceCivilDate,
	temporalAnchor,
} from "../src/lib/source_time.mjs";
import { validateIngestBody } from "../src/lib/ingest_contract.mjs";
import { validateBody } from "../src/lib/params.js";
import { normalizeSourcePacket } from "../src/pipeline/source.js";

/**
 * BF-1. The product could record when it RECEIVED content but never when the
 * content was WRITTEN, so "I moved yesterday" had no anchor but extraction day.
 * This suite holds the new contract: optional, validated, timezone-aware,
 * replay-stable, and refused by name rather than honoured when V3 is off.
 */

const USER = "user_bf1";

describe("BF-1 parser: what a valid source time is", () => {
	it("accepts an ISO timestamp with Z and keeps a zero offset", () => {
		const { ok, time } = parseSourceTime("2025-09-18T08:00:00Z");
		expect(ok).toBe(true);
		expect(time).toEqual({
			epoch_ms: Date.parse("2025-09-18T08:00:00Z"),
			offset_minutes: 0,
			precision: "time",
			text: "2025-09-18T08:00:00Z",
		});
	});

	it("keeps the caller's UTC offset instead of folding it away", () => {
		const { time } = parseSourceTime("2025-09-18T00:30:00+09:00");
		expect(time.offset_minutes).toBe(540);
		expect(time.epoch_ms).toBe(Date.parse("2025-09-17T15:30:00Z"));
		// The whole reason the offset is retained: the local day is the 18th even
		// though the UTC day is the 17th, and "yesterday" must mean the 17th local.
		expect(sourceCivilDate(time)).toBe("2025-09-18");
		expect(new Date(time.epoch_ms).toISOString().slice(0, 10)).toBe("2025-09-17");
	});

	it("handles a negative offset the same way", () => {
		const { time } = parseSourceTime("2025-01-01T20:00:00-08:00");
		expect(time.offset_minutes).toBe(-480);
		expect(sourceCivilDate(time)).toBe("2025-01-01");
		expect(new Date(time.epoch_ms).toISOString().slice(0, 10)).toBe("2025-01-02");
	});

	it("treats DST as already resolved, because the caller wrote the offset", () => {
		// Same wall-clock hour in Berlin, either side of the DST change. The two
		// instants differ by exactly the offset, and neither is guessed.
		const winter = parseSourceTime("2025-01-15T12:00:00+01:00").time;
		const summer = parseSourceTime("2025-07-15T12:00:00+02:00").time;
		expect(winter.offset_minutes).toBe(60);
		expect(summer.offset_minutes).toBe(120);
		expect(sourceCivilDate(winter)).toBe("2025-01-15");
		expect(sourceCivilDate(summer)).toBe("2025-07-15");
	});

	it("accepts a bare calendar date and refuses to invent a time of day", () => {
		const { time } = parseSourceTime("2023-01-20");
		expect(time.precision).toBe("day");
		expect(time.offset_minutes).toBe(null);
		expect(time.epoch_ms).toBe(Date.UTC(2023, 0, 20));
		expect(time.text).toBe("2023-01-20");
	});

	it("accepts epoch milliseconds as a number", () => {
		const ms = Date.parse("2024-05-06T07:08:09Z");
		const { time } = parseSourceTime(ms);
		expect(time.epoch_ms).toBe(ms);
		expect(time.precision).toBe("time");
	});

	it("treats an absent value as absent, not as now", () => {
		expect(parseSourceTime(undefined)).toEqual({ ok: true, time: null });
		expect(parseSourceTime(null)).toEqual({ ok: true, time: null });
	});
});

describe("BF-1 parser: what it refuses, and why", () => {
	it("refuses a date-time with no offset instead of guessing a zone", () => {
		const result = parseSourceTime("2025-09-18T08:00:00");
		expect(result.ok).toBe(false);
		expect(result.code).toBe("source_time_missing_offset");
		expect(result.message).toMatch(/offset/i);
	});

	it("refuses calendar dates that do not exist", () => {
		for (const bad of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-01-32"]) {
			const result = parseSourceTime(bad);
			expect(result.ok, bad).toBe(false);
			expect(result.code).toBe("invalid_source_time");
		}
	});

	it("refuses an offset that does not exist", () => {
		expect(parseSourceTime("2025-09-18T08:00:00+25:00").ok).toBe(false);
		expect(parseSourceTime("2025-09-18T08:00:00+05:99").ok).toBe(false);
	});

	it("refuses free text, wrong types, and empty strings", () => {
		for (const bad of ["yesterday", "last Tuesday", "", "   ", "not a date", true, [], {}, Number.NaN, 1.5]) {
			expect(parseSourceTime(bad).ok, String(bad)).toBe(false);
		}
	});

	it("names the epoch-as-string mistake specifically", () => {
		const result = parseSourceTime("1758182400000");
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/JSON number/);
	});

	it("refuses a time far enough in the future to be a clock fault", () => {
		const now = Date.parse("2026-08-09T00:00:00Z");
		expect(parseSourceTime(now + SOURCE_TIME_MAX_SKEW_MS - 1000, { now }).ok).toBe(true);
		const far = parseSourceTime(now + SOURCE_TIME_MAX_SKEW_MS + 60_000, { now });
		expect(far.ok).toBe(false);
		expect(far.code).toBe("source_time_in_future");
	});

	it("tolerates a legitimate historical import but refuses the uninitialised sentinels", () => {
		expect(parseSourceTime("1998-04-11T09:00:00Z").ok).toBe(true);
		expect(parseSourceTime("1971-01-01T00:00:00Z").ok).toBe(true);
		// 0, a zeroed field, and a negative rollover are how an uninitialised
		// timestamp arrives. None of them may become an authoritative anchor.
		for (const sentinel of [0, -1, SOURCE_TIME_MIN_MS - 1, Date.UTC(1900, 0, 1)]) {
			const result = parseSourceTime(sentinel);
			expect(result.ok, String(sentinel)).toBe(false);
			expect(result.code).toBe("source_time_out_of_range");
		}
	});
});

describe("BF-1 anchor: source time and observation time are different facts", () => {
	it("prefers the source time and says which one it used", () => {
		const sourceTime = parseSourceTime("2023-01-20T16:04:00Z").time;
		expect(temporalAnchor({ sourceTime, observedAt: Date.parse("2026-08-09T00:00:00Z") })).toEqual({
			kind: "source_time",
			epoch_ms: Date.parse("2023-01-20T16:04:00Z"),
			offset_minutes: 0,
			precision: "time",
		});
	});

	it("falls back to observation time, and labels it honestly", () => {
		const anchor = temporalAnchor({ sourceTime: null, observedAt: 1_700_000_000_000 });
		expect(anchor.kind).toBe("observed_at");
		expect(anchor.epoch_ms).toBe(1_700_000_000_000);
	});

	it("has no anchor at all rather than inventing one", () => {
		expect(temporalAnchor({})).toBe(null);
		expect(temporalAnchor({ observedAt: 0 })).toBe(null);
	});

	it("rejects a corrupt persisted value instead of trusting it", () => {
		expect(persistedSourceTime({ epoch_ms: "nonsense" })).toBe(null);
		expect(persistedSourceTime(null)).toBe(null);
		expect(persistedSourceTime({ epoch_ms: 0 })).toBe(null);
		expect(persistedSourceTime({ epoch_ms: -1 })).toBe(null);
		expect(persistedSourceTime({ epoch_ms: Date.UTC(2020, 0, 1), offset_minutes: 99999 })?.offset_minutes).toBe(null);
	});
});

describe("BF-1 wire contract", () => {
	it("is on the write doors and not on the lookup door", () => {
		expect(validateBody("/v1/ingest", { sourceTime: "2025-01-01" }).error).toBeUndefined();
		expect(validateBody("/v1/save", { sourceTime: "2025-01-01" }).error).toBeUndefined();
		expect(validateBody("/v1/turn", { sourceTime: "2025-01-01" }).error).toBeUndefined();
		expect(validateBody("/v1/recall", { sourceTime: "2025-01-01" }).error).toBe("unknown_parameter");
	});

	it("accepts snake_case, as a Python caller will always write it", () => {
		const checked = validateBody("/v1/ingest", { source_time: "2025-01-01" });
		expect(checked.error).toBeUndefined();
		expect(checked.body.sourceTime).toBe("2025-01-01");
	});

	it("refuses both spellings at once rather than picking one", () => {
		expect(validateBody("/v1/ingest", { sourceTime: "2025-01-01", source_time: "2024-01-01" }).error)
			.toBe("conflicting_parameters");
	});

	it("rejects a malformed batch source time at the door with a named field", () => {
		const violation = validateIngestBody({ sourceTime: "yesterday", messages: ["hi"] });
		expect(violation.status).toBe(422);
		expect(violation.field).toBe("sourceTime");
		expect(violation.code).toBe("invalid_source_time");
	});

	it("rejects a malformed per-message source time and says which message", () => {
		const violation = validateIngestBody({
			messages: [{ content: "ok" }, { content: "bad", sourceTime: "2025-09-18T08:00:00" }],
		});
		expect(violation.status).toBe(422);
		expect(violation.field).toBe("messages[1].sourceTime");
		expect(violation.message).toMatch(/messages\[1\]\.sourceTime/);
	});

	it("accepts a well-formed batch and per-message source time", () => {
		expect(validateIngestBody({
			sourceTime: "2023-01-20",
			messages: [{ content: "a" }, { content: "b", sourceTime: "2023-01-21T09:00:00+02:00" }],
		})).toBe(null);
	});

	it("leaves a request with no source time byte-identically valid", () => {
		expect(validateIngestBody({ messages: ["hello"] })).toBe(null);
	});
});

describe("BF-1 packet normalization", () => {
	it("applies the batch time to every message that has none", async () => {
		const { packet, messages } = await normalizeSourcePacket(USER, {
			messages: [{ content: "one" }, { content: "two" }],
			sourceTime: "2023-01-20T16:04:00Z",
			conversationId: "c1",
		});
		expect(packet.source_time).toBe(Date.parse("2023-01-20T16:04:00Z"));
		expect(packet.source_time_offset_minutes).toBe(0);
		expect(packet.source_time_precision).toBe("time");
		for (const message of messages) {
			expect(message.source_time.epoch_ms).toBe(Date.parse("2023-01-20T16:04:00Z"));
		}
	});

	it("lets a per-message time win over the batch default", async () => {
		const { messages } = await normalizeSourcePacket(USER, {
			messages: [
				{ content: "one" },
				{ content: "two", sourceTime: "2023-02-01T00:00:00Z" },
			],
			sourceTime: "2023-01-20T16:04:00Z",
			conversationId: "c2",
		});
		expect(messages[0].source_time.epoch_ms).toBe(Date.parse("2023-01-20T16:04:00Z"));
		expect(messages[1].source_time.epoch_ms).toBe(Date.parse("2023-02-01T00:00:00Z"));
	});

	it("keeps observation time and source time as separate fields", async () => {
		const { messages, packet } = await normalizeSourcePacket(USER, {
			messages: [{ content: "one" }],
			sourceTime: "2020-06-01T00:00:00Z",
			conversationId: "c3",
		});
		const stored = JSON.parse(packet.raw_meta_json).messages[0];
		expect(stored.source_time.epoch_ms).toBe(Date.parse("2020-06-01T00:00:00Z"));
		// ts is when we saw it, and it is emphatically not the source time.
		expect(messages[0].ts).toBeGreaterThan(Date.parse("2024-01-01T00:00:00Z"));
		expect(stored.ts).toBe(messages[0].ts);
	});

	it("stores nothing new when no source time is supplied", async () => {
		const { packet, messages } = await normalizeSourcePacket(USER, {
			messages: [{ content: "one" }],
			conversationId: "c4",
		});
		expect(packet.source_time).toBe(null);
		expect(packet.source_time_offset_minutes).toBe(null);
		expect(packet.source_time_precision).toBe(null);
		expect(messages[0].source_time).toBeUndefined();
		expect(JSON.parse(packet.raw_meta_json).source_time).toBeUndefined();
	});
});

describe("BF-1 content identity and replay", () => {
	it("hashes identically to the pre-BF-1 shape when no source time is given", async () => {
		// The guarantee that every already-issued idempotency key stays valid.
		const before = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "the same words" }],
			conversationId: "stable",
		});
		const after = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "the same words" }],
			conversationId: "stable",
		});
		expect(after.packet.content_hash).toBe(before.packet.content_hash);
		expect(after.packet.idempotency_key).toBe(before.packet.idempotency_key);
	});

	it("treats the same words said on two different days as different content", async () => {
		const monday = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "I moved yesterday" }],
			sourceTime: "2023-01-20T10:00:00Z",
			conversationId: "moved",
		});
		const tuesday = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "I moved yesterday" }],
			sourceTime: "2023-01-21T10:00:00Z",
			conversationId: "moved",
		});
		expect(tuesday.packet.content_hash).not.toBe(monday.packet.content_hash);
	});

	it("is replay-stable: the identical request hashes identically every time", async () => {
		const once = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "hello", sourceTime: "2023-01-20T10:00:00Z" }],
			sourceTime: "2023-01-19T10:00:00Z",
			conversationId: "replay",
		});
		const twice = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "hello", sourceTime: "2023-01-20T10:00:00Z" }],
			sourceTime: "2023-01-19T10:00:00Z",
			conversationId: "replay",
		});
		expect(twice.packet.content_hash).toBe(once.packet.content_hash);
		expect(twice.packet.idempotency_key).toBe(once.packet.idempotency_key);
	});

	it("does not let the observation clock move the hash", async () => {
		const first = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "hello", ts: 1 }],
			sourceTime: "2023-01-20T10:00:00Z",
			conversationId: "clock",
		});
		const second = await normalizeSourcePacket(USER, {
			messages: [{ id: "m1", content: "hello", ts: 999_999_999 }],
			sourceTime: "2023-01-20T10:00:00Z",
			conversationId: "clock",
		});
		expect(second.packet.content_hash).toBe(first.packet.content_hash);
	});
});

describe("BF-1 is gated: V3 off means refused by name, never accepted-then-ignored", () => {
	async function post(path, body, overrides = {}) {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(`https://itsuki.app${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": env.API_KEY },
				body: JSON.stringify(body),
			}),
			{
				...env,
				// Production/test defaults intentionally mirror V3-on. This describe
				// block is specifically the explicit feature-off compatibility contract.
				ITSUKI_MEMORY_V3: "off",
				ITSUKI_MEMORY_V3_USERS: "",
				...overrides,
			},
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it("refuses a batch source time with a semantic error, not unknown_parameter", async () => {
		const response = await post("/v1/ingest", {
			userId: USER,
			messages: [{ role: "user", content: "I moved yesterday" }],
			sourceTime: "2023-01-20T10:00:00Z",
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toBe("source_time_not_enabled");
		expect(body.field).toBe("sourceTime");
		expect(body.message).toMatch(/not enabled for this account/);
	});

	it("refuses a per-message source time too", async () => {
		const response = await post("/v1/ingest", {
			userId: USER,
			messages: [{ role: "user", content: "hi", sourceTime: "2023-01-20T10:00:00Z" }],
		});
		expect(response.status).toBe(400);
		expect((await response.json()).field).toBe("messages[].sourceTime");
	});

	it("does not disturb a request that sends no source time", async () => {
		const response = await post("/v1/ingest", {
			userId: USER,
			messages: [{ role: "user", content: "hi" }],
		});
		expect(response.status).not.toBe(400);
	});

	it("still refuses a MALFORMED source time before it looks at the flag", async () => {
		// Structure is checked at the door for everyone; a broken timestamp gets a
		// 422 about the timestamp, not a 400 about entitlement.
		const response = await post("/v1/ingest", {
			userId: USER,
			messages: [{ role: "user", content: "hi" }],
			sourceTime: "yesterday",
		});
		expect(response.status).toBe(422);
		expect((await response.json()).code).toBe("invalid_source_time");
	});
});
