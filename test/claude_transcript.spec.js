import { describe, expect, it } from "vitest";

import {
	CLAUDE_MESSAGE_ID_VERSION,
	messagesFromClaudeTranscriptLines,
} from "../hooks/claude-transcript.mjs";

const SESSION_ID = "synthetic-session";

function row(index, overrides = {}) {
	return {
		type: index % 2 ? "assistant" : "user",
		uuid: `host-event-${index}`,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		message: { content: `synthetic message ${index}` },
		...overrides,
	};
}

function jsonl(rows) {
	return rows.map((value) => JSON.stringify(value));
}

async function parse(rows, options = {}) {
	return messagesFromClaudeTranscriptLines(jsonl(rows), {
		sessionId: SESSION_ID,
		now: () => 1_800_000_000_000,
		...options,
	});
}

function byContent(messages) {
	return new Map(messages.map((message) => [message.content, message.id]));
}

function legacyTailIds(rows, maxMessages = 80) {
	return new Map(rows.slice(-maxMessages).map((value, index) => [
		value.uuid,
		`${SESSION_ID}-${index}`,
	]));
}

describe("Claude transcript message identity", () => {
	it("keeps stable host-UUID IDs for 60 messages and exact replay", async () => {
		const rows = Array.from({ length: 60 }, (_, index) => row(index));
		const first = await parse(rows);
		const replay = await parse(rows);

		expect(first).toHaveLength(60);
		expect(replay.map((message) => message.id)).toEqual(first.map((message) => message.id));
		expect(new Set(first.map((message) => message.id)).size).toBe(60);
		expect(first.every((message) => message.id.startsWith(`${CLAUDE_MESSAGE_ID_VERSION}_h_`))).toBe(true);
	});

	it("treats host UUIDs as authoritative across rendered-content changes", async () => {
		const [original] = await parse([row(0)]);
		const [rewritten] = await parse([row(0, {
			type: "assistant",
			message: { content: "normalized rendering of the same host event" },
		})]);
		const [differentHostEvent] = await parse([row(0, {
			uuid: "host-event-different",
			message: { content: "synthetic message 0" },
		})]);

		expect(rewritten.id).toBe(original.id);
		expect(differentHostEvent.id).not.toBe(original.id);
	});

	it.each([100, 120, 200])("keeps the last 80 of a %i-message transcript", async (count) => {
		const rows = Array.from({ length: count }, (_, index) => row(index));
		const messages = await parse(rows);

		expect(messages).toHaveLength(80);
		expect(messages[0].content).toBe(`synthetic message ${count - 80}`);
		expect(messages.at(-1).content).toBe(`synthetic message ${count - 1}`);
		expect(new Set(messages.map((message) => message.id)).size).toBe(80);
	});

	it("captures the legacy moving-tail identity change and ID reuse", () => {
		const rows = Array.from({ length: 120 }, (_, index) => row(index));
		const at100 = legacyTailIds(rows.slice(0, 100));
		const at120 = legacyTailIds(rows);

		expect(at100.get("host-event-40")).toBe(`${SESSION_ID}-20`);
		expect(at120.get("host-event-40")).toBe(`${SESSION_ID}-0`);
		expect(at120.get("host-event-60")).toBe(at100.get("host-event-40"));
	});

	it("does not change or reuse IDs when the tail window moves", async () => {
		const rows = Array.from({ length: 120 }, (_, index) => row(index));
		const at100 = byContent(await parse(rows.slice(0, 100)));
		const at120 = byContent(await parse(rows));

		for (let index = 40; index < 100; index += 1) {
			expect(at120.get(`synthetic message ${index}`)).toBe(at100.get(`synthetic message ${index}`));
		}
		const oldIds = new Map([...at100].map(([content, id]) => [id, content]));
		for (let index = 100; index < 120; index += 1) {
			const content = `synthetic message ${index}`;
			expect(oldIds.get(at120.get(content))).toBeUndefined();
		}
	});

	it("keeps deterministic fallback IDs stable when the tail window moves", async () => {
		const rows = Array.from({ length: 120 }, (_, index) => ({
			type: index % 2 ? "assistant" : "user",
			timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
			message: { content: `fallback tail message ${index}` },
		}));
		const at100 = byContent(await parse(rows.slice(0, 100)));
		const at120 = byContent(await parse(rows));

		for (let index = 40; index < 100; index += 1) {
			expect(at120.get(`fallback tail message ${index}`)).toBe(at100.get(`fallback tail message ${index}`));
		}
	});

	it("retains IDs when the same session is resumed", async () => {
		const rows = Array.from({ length: 100 }, (_, index) => row(index));
		const beforeResume = await parse(rows);
		const afterResume = await parse(rows, { source: "resume" });

		expect(afterResume.map((message) => message.id)).toEqual(beforeResume.map((message) => message.id));
	});

	it("distinguishes identical fallback messages by full-transcript occurrence and ordinal", async () => {
		const duplicate = {
			type: "user",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { content: "the same durable decision" },
		};
		const messages = await parse([duplicate, row(1), duplicate]);
		const duplicates = messages.filter((message) => message.content === duplicate.message.content);

		expect(duplicates).toHaveLength(2);
		expect(duplicates[0].id).not.toBe(duplicates[1].id);
		expect(duplicates.every((message) => message.id.startsWith(`${CLAUDE_MESSAGE_ID_VERSION}_f_`))).toBe(true);
		expect(duplicates.every((message) => !message.id.includes("durable"))).toBe(true);
	});

	it("uses a host message ID when no event UUID exists, without exposing it", async () => {
		const message = row(0, { uuid: undefined, message: { id: "msg_host_secretish", content: "synthetic" } });
		const [parsed] = await parse([message]);

		expect(parsed.id).toMatch(new RegExp(`^${CLAUDE_MESSAGE_ID_VERSION}_m_[a-f0-9]{32}$`));
		expect(parsed.id).not.toContain("msg_host_secretish");
	});

	it("preserves the existing bounded-content behavior", async () => {
		const [parsed] = await parse([row(0, { message: { content: "x".repeat(12) } })], {
			maxCharsPerMessage: 8,
		});

		expect(parsed.content).toBe("xxxxxxxx\u2026");
	});

	it("replays identical IDs after a timeout or process restart", async () => {
		const rows = Array.from({ length: 120 }, (_, index) => row(index, index % 3 === 0 ? { uuid: undefined, message: { content: `fallback ${index}` } } : {}));
		const timedOutAttempt = await parse(rows);
		const restartedRetry = await parse(JSON.parse(JSON.stringify(rows)));

		expect(restartedRetry.map((message) => message.id)).toEqual(timedOutAttempt.map((message) => message.id));
	});

	it("omits an unavailable timestamp so exact retries keep the same envelope material", async () => {
		const timestampLess = { type: "user", message: { content: "stable without a timestamp" } };
		const [first] = await parse([timestampLess], { now: () => 1 });
		const [retry] = await parse([timestampLess], { now: () => 9_999_999 });

		expect(first).toEqual(retry);
		expect(first).not.toHaveProperty("ts");
	});

	it("skips malformed JSONL without destabilizing surrounding fallback IDs", async () => {
		const first = { type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "first valid" } };
		const second = { type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { content: "second valid" } };
		const clean = await messagesFromClaudeTranscriptLines(jsonl([first, second]), { sessionId: SESSION_ID });
		const malformed = await messagesFromClaudeTranscriptLines([
			JSON.stringify(first),
			"{ this is not JSON",
			JSON.stringify(second),
		], { sessionId: SESSION_ID });

		expect(malformed).toHaveLength(2);
		expect(malformed.map((message) => message.id)).toEqual(clean.map((message) => message.id));
	});
});
