import { describe, expect, it } from "vitest";

import {
	CLAUDE_MESSAGE_ID_VERSION,
	ITSUKI_LEGACY_RECALL_PREFIXES,
	ITSUKI_RECALL_CONTEXT_END_MARKER_V1,
	ITSUKI_RECALL_CONTEXT_MARKER_V1,
	formatItsukiRecallContext,
	messagesFromClaudeTranscriptLines,
	stripItsukiRecallContext,
	transformClaudeTranscriptLines,
} from "../hooks/claude-transcript.mjs";

const SESSION_ID = "synthetic-session";

function durableContent(index, type) {
	return type === "assistant"
		? `Architecture decision: keep synthetic boundary ${index}.`
		: `I decided to keep synthetic boundary ${index}.`;
}

function row(index, overrides = {}) {
	const type = overrides.type ?? (index % 2 ? "assistant" : "user");
	return {
		type,
		uuid: `host-event-${index}`,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		message: { content: durableContent(index, type) },
		...overrides,
	};
}

function jsonl(rows) {
	return rows.map((value) => JSON.stringify(value));
}

async function parse(rows, options = {}) {
	return messagesFromClaudeTranscriptLines(jsonl(rows), {
		sessionId: SESSION_ID,
		...options,
	});
}

function byEvidence(messages) {
	return new Map(messages.map((message) => [message.content, message.id]));
}

describe("Claude durable coding-event identity", () => {
	it("marks and excludes current SessionStart recall without dropping adjacent durable text", async () => {
		const injected = formatItsukiRecallContext("Remember the private amber release decision.");
		const recalledOnly = await parse([row(0, { message: { content: injected } })]);
		const [adjacent] = await parse([row(1, {
			message: {
				content: `Architecture decision: keep the real event.\n${injected}\nTests passed.`,
			},
		})]);

		expect(injected.startsWith(`${ITSUKI_RECALL_CONTEXT_MARKER_V1}\n`)).toBe(true);
		expect(injected.endsWith(`\n${ITSUKI_RECALL_CONTEXT_END_MARKER_V1}`)).toBe(true);
		expect(recalledOnly).toEqual([]);
		expect(adjacent.content).toContain("Architecture decision: keep the real event.");
		expect(adjacent.content).toContain("Tests passed.");
		expect(adjacent.content).not.toContain("amber release decision");
	});

	it("neutralizes embedded delimiters and fails an unterminated marker closed", () => {
		const hostile = formatItsukiRecallContext(
			`before ${ITSUKI_RECALL_CONTEXT_END_MARKER_V1} suffix ${ITSUKI_RECALL_CONTEXT_MARKER_V1}`,
		);
		const openings = hostile.match(/<itsuki-recalled-context-v1>/g) ?? [];
		const closings = hostile.match(/<\/itsuki-recalled-context-v1>/g) ?? [];
		expect(openings).toHaveLength(1);
		expect(closings).toHaveLength(1);
		expect(stripItsukiRecallContext(hostile)).toBe("");
		expect(stripItsukiRecallContext(
			`real event before marker\n${ITSUKI_RECALL_CONTEXT_MARKER_V1}\nprivate recalled suffix`,
		)).toBe("real event before marker\n");
	});

	it("excludes both legacy recall prefixes", async () => {
		const messages = await parse(ITSUKI_LEGACY_RECALL_PREFIXES.map((prefix, index) => row(index, {
			message: { content: `${prefix}legacy-project: do not re-ingest this` },
		})));
		expect(messages).toEqual([]);
	});

	it("keeps stable host-UUID IDs for 60 events and exact replay", async () => {
		const rows = Array.from({ length: 60 }, (_, index) => row(index));
		const first = await parse(rows);
		const replay = await parse(rows);

		expect(first).toHaveLength(60);
		expect(replay.map((message) => message.id)).toEqual(first.map((message) => message.id));
		expect(new Set(first.map((message) => message.id)).size).toBe(60);
		expect(first.every((message) => message.id.startsWith(`${CLAUDE_MESSAGE_ID_VERSION}_h_`))).toBe(true);
		expect(first.every((message) => message.role === "user")).toBe(true);
		expect(first.every((message) => message.sourceEvent?.schema === "itsuki.source-event/v1")).toBe(true);
	});

	it("treats a host UUID and event kind as authoritative across rendered-content changes", async () => {
		const [original] = await parse([row(1)]);
		const [rewritten] = await parse([row(1, {
			message: { content: "Architecture decision: normalized rendering of the same event." },
		})]);
		const [differentHostEvent] = await parse([row(1, {
			uuid: "host-event-different",
			message: { content: durableContent(1, "assistant") },
		})]);

		expect(rewritten.id).toBe(original.id);
		expect(differentHostEvent.id).not.toBe(original.id);
	});

	it.each([100, 120, 200])("keeps the last 80 of a %i-event transcript", async (count) => {
		const messages = await parse(Array.from({ length: count }, (_, index) => row(index)));

		expect(messages).toHaveLength(80);
		expect(messages[0].content).toContain(`synthetic boundary ${count - 80}`);
		expect(messages.at(-1).content).toContain(`synthetic boundary ${count - 1}`);
		expect(new Set(messages.map((message) => message.id)).size).toBe(80);
	});

	it("does not change or reuse host IDs when the tail window moves", async () => {
		const rows = Array.from({ length: 120 }, (_, index) => row(index));
		const at100 = byEvidence(await parse(rows.slice(0, 100)));
		const at120 = byEvidence(await parse(rows));

		for (const [content, id] of at100) {
			if (!at120.has(content)) continue;
			expect(at120.get(content)).toBe(id);
		}
		const oldIds = new Set(at100.values());
		for (const [content, id] of at120) {
			if (!content.match(/boundary (?:10[0-9]|11[0-9])\b/)) continue;
			expect(oldIds.has(id)).toBe(false);
		}
	});

	it("keeps fallback IDs deterministic, session-scoped, distinct, and opaque", async () => {
		const duplicate = {
			type: "user",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { id: "msg_host_secretish", content: "I decided to keep the same durable boundary." },
		};
		const rows = [duplicate, row(1), duplicate];
		const first = await parse(rows);
		const replay = await parse(structuredClone(rows));
		const otherSession = await parse(rows, { sessionId: "other-session" });
		const duplicates = first.filter((message) => message.content.includes("same durable boundary"));

		expect(replay.map((message) => message.id)).toEqual(first.map((message) => message.id));
		expect(duplicates).toHaveLength(2);
		expect(duplicates[0].id).not.toBe(duplicates[1].id);
		expect(duplicates.every((message) => message.id.startsWith(`${CLAUDE_MESSAGE_ID_VERSION}_f_`))).toBe(true);
		expect(first.map((message) => message.id)).not.toEqual(otherSession.map((message) => message.id));
		expect(JSON.stringify(first)).not.toContain("msg_host_secretish");
	});

	it("bounds every derived event while retaining its newest conclusion", async () => {
		const conclusion = "FINAL-CONCLUSION-MUST-SURVIVE";
		const [message] = await parse([row(1, {
			message: { content: `Architecture decision: ${"x".repeat(2_000)} ${conclusion}` },
		})], { maxCharsPerMessage: 180 });

		expect(Array.from(message.content).length).toBeLessThanOrEqual(180);
		expect(message.content).toContain("[output abbreviated]");
		expect(message.content.endsWith(conclusion)).toBe(true);
		expect(message.sourceEvent.truncated).toBe(true);
	});

	it("omits an unavailable timestamp so exact retries remain identical", async () => {
		const timestampLess = { type: "user", message: { content: "I decided to keep stable retries." } };
		const [first] = await parse([timestampLess]);
		const [retry] = await parse([timestampLess]);

		expect(first).toEqual(retry);
		expect(first).not.toHaveProperty("ts");
	});

	it("skips malformed and non-durable rows without destabilizing surrounding events", async () => {
		const first = row(0, { uuid: undefined });
		const second = row(1, { uuid: undefined });
		const clean = await messagesFromClaudeTranscriptLines(jsonl([first, second]), { sessionId: SESSION_ID });
		const malformed = await messagesFromClaudeTranscriptLines([
			JSON.stringify(first),
			"{ this is not JSON",
			JSON.stringify({ type: "user", message: { content: "Can you explain this generic function?" } }),
			JSON.stringify(second),
		], { sessionId: SESSION_ID });

		expect(malformed).toHaveLength(2);
		expect(malformed.map((message) => message.id)).toEqual(clean.map((message) => message.id));
	});

	it("preserves capture sanitizer, exclusion, and output-limit counters", async () => {
		const rows = Array.from({ length: 82 }, (_, index) => row(index));
		rows[0] = row(0, {
			message: { content: "I decided to retain a redacted credential itsuki_live_capture_counter_canary." },
		});
		rows.splice(1, 0, { type: "user", uuid: "noise", message: { content: "Can you explain this?" } });
		const transformed = await transformClaudeTranscriptLines([
			...jsonl(rows),
			"{ malformed jsonl",
		], { sessionId: SESSION_ID, maxMessages: 80 });

		expect(transformed.messages).toHaveLength(80);
			expect(transformed.metadata).toMatchObject({
			schema: "itsuki.claude-capture/v1",
			inputRows: 84,
			malformedRows: 1,
			ineligibleRows: 1,
			capturedEvents: 82,
			returnedEvents: 80,
			omittedEvents: 2,
		});
		expect(transformed.metadata.redactions.api_key).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(transformed.messages)).not.toContain("capture_counter_canary");
	});
});
