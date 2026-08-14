import { describe, expect, it } from "vitest";

import {
	ATOMIC_CAPTURE_SCHEMA,
	ATOMIC_TYPES,
	buildAtomicCaptureMessages,
	normalizeAtomicCapture,
	parseAtomicCaptureText,
} from "../src/pipeline/atomic_capture.mjs";

const messages = [
	{
		id: "m1",
		content: "Northwind uses Go 🚀 and sqlc; no ORM.",
		ts: 1_762_250_400_000,
	},
	{
		id: "m2",
		content: "Deploy order is migrate, swap, smoke-test /healthz, then DNS.",
		ts: 1_762_250_460_000,
	},
];

function proposal(overrides = {}) {
	return {
		type: "fact",
		entity: "Northwind",
		entity_type: "project",
		attribute: "implementation language",
		value: "Go",
		assertion: "Northwind is written in Go.",
		source_message_id: "m1",
		evidence_quote: "Northwind uses Go",
		cardinality: "single",
		confidence: 0.93,
		...overrides,
	};
}

async function normalize(atoms, overrides = {}) {
	return normalizeAtomicCapture({ atoms }, {
		messages,
		userId: "tenant-a",
		projectId: "project-a",
		sourcePacketId: "packet-a",
		chunkKey: "chunk-a",
		...overrides,
	});
}

describe("atomic capture prompt boundary", () => {
	it("marks new_slice as the only extractable source and keeps it last", () => {
		const result = buildAtomicCaptureMessages({
			new_slice: messages,
			bridge_context: [{ id: "old", content: "Bridge fact must not be learned", ts: 1 }],
			assistant_context: [{ id: "assistant", content: "Assistant fact must not be learned", ts: 2 }],
		});
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("system");
		expect(result[0].content).toContain("new_slice is the ONLY source");
		const body = JSON.parse(result[1].content);
		expect(Object.keys(body).at(-1)).toBe("new_slice");
		expect(body.instructions).toContain("NEVER extract");
		expect(body.new_slice).toEqual(messages);
	});

	it("does not put rules or source text into the system instruction", () => {
		const result = buildAtomicCaptureMessages({ new_slice: messages }, {
			rules: { customInstructions: "Never store medical details", includes: [], excludes: ["medical"] },
		});
		expect(result[0].content).not.toContain("medical");
		expect(JSON.parse(result[1].content).rules).toContain("medical");
	});
});

describe("atomic capture parsing", () => {
	it("parses zero-to-many atoms through plain JSON and wrappers", () => {
		expect(parseAtomicCaptureText('{"atoms":[]}')).toEqual({ atoms: [] });
		const wrapped = `<think>private reasoning</think>\n\`\`\`json\n${JSON.stringify({ atoms: [proposal()] })}\n\`\`\``;
		expect(parseAtomicCaptureText(wrapped).atoms).toHaveLength(1);
	});

	it("salvages only complete atoms from a truncated response", () => {
		const text = `{"atoms":[${JSON.stringify(proposal())},${JSON.stringify(proposal({ value: "sqlc", assertion: "Northwind uses sqlc.", evidence_quote: "sqlc" }))},{"type":"fact","entity":"Half`;
		const parsed = parseAtomicCaptureText(text);
		expect(parsed.atoms).toHaveLength(2);
		expect(parsed._truncated).toBe(true);
	});

	it("rejects prose, arrays, and a response with no completed atom", () => {
		expect(parseAtomicCaptureText("I cannot comply")).toBeNull();
		expect(parseAtomicCaptureText("[]")).toBeNull();
		expect(parseAtomicCaptureText('{"atoms":[{"type":"fact"')).toBeNull();
	});
});

describe("atomic capture normalization and exact provenance", () => {
	it("accepts a grounded atom and records an exact Unicode code-point span", async () => {
		const result = await normalize([proposal({
			value: "Go 🚀",
			assertion: "Northwind uses Go 🚀.",
			evidence_quote: "Go 🚀",
		})]);
		expect(result.ok).toBe(true);
		expect(result.atoms).toHaveLength(1);
		expect(result.atoms[0]).toMatchObject({
			schema: ATOMIC_CAPTURE_SCHEMA,
			userId: "tenant-a",
			projectId: "project-a",
			sourcePacketId: "packet-a",
			chunkKey: "chunk-a",
			sourceMessageId: "m1",
			evidenceQuote: "Go 🚀",
			startCodePoint: 15,
			endCodePoint: 19,
		});
		expect(result.atoms[0].id).toMatch(/^atom:v1:[a-f0-9]{64}$/);
	});

	it("normalizes an exact temporal phrase against that source message only", async () => {
		const temporalMessages = [{
			id: "when",
			content: "I moved to Malmo yesterday.",
			ts: Date.parse("2026-08-11T12:00:00Z"),
			source_time: {
				epoch_ms: Date.parse("2025-09-18T08:00:00Z"),
				offset_minutes: 0,
				precision: "time",
			},
		}];
		const result = await normalizeAtomicCapture({ atoms: [proposal({
			type: "event",
			entity: "user",
			entity_type: "person",
			attribute: "location history",
			value: "Malmo",
			assertion: "The user moved to Malmo.",
			source_message_id: "when",
			evidence_quote: "moved to Malmo yesterday",
			raw_temporal_phrase: "yesterday",
		})] }, {
			messages: temporalMessages,
			userId: "tenant-a",
			projectId: "project-a",
			sourcePacketId: "packet-a",
			chunkKey: "chunk-a",
		});
		expect(result.atoms[0]).toMatchObject({
			rawTemporalPhrase: "yesterday",
			temporal: {
				outcome: "resolved",
				eventTime: Date.UTC(2025, 8, 17, 12),
				eventTimeAnchor: "source_time",
			},
		});
		expect(result.outcomes).toMatchObject({ temporalPresent: 1, temporalResolved: 1 });
	});

	it("canonicalizes an empty model temporal phrase to absent", async () => {
		const result = await normalize([proposal({ raw_temporal_phrase: "" })]);
		expect(result.atoms[0].rawTemporalPhrase).toBe(null);
		expect(result.atoms[0].temporal.outcome).toBe("absent");
		expect(result.outcomes.temporalAbsent).toBe(1);
	});

	it("maps only an offered project category slug or id to stable metadata", async () => {
		const rules = {
			customInstructions: "",
			includes: [],
			excludes: [],
			projectCategories: [{
				id: "cat_customer_success",
				slug: "customer_success",
				description: "Customer adoption and renewal work",
			}],
		};
		const offered = await normalize([proposal({ project_category: "customer_success" })], { rules });
		expect(offered.atoms[0].projectCategoryId).toBe("cat_customer_success");
		const byId = await normalize([proposal({ project_category: "cat_customer_success" })], { rules });
		expect(byId.atoms[0].projectCategoryId).toBe("cat_customer_success");
		const invented = await normalize([proposal({ project_category: "executive_secrets" })], { rules });
		expect(invented.atoms[0].projectCategoryId).toBeNull();
	});

	it("rejects unknown source ids and inexact quotes", async () => {
		const result = await normalize([
			proposal({ source_message_id: "assistant" }),
			proposal({ evidence_quote: "Northwind is written in Go" }),
		]);
		expect(result.atoms).toEqual([]);
		expect(result.outcomes.rejectedByReason).toMatchObject({
			unknown_source_message: 1,
			inexact_evidence_quote: 1,
		});
	});

	it("rejects missing fields, invalid enums, and invalid confidence", async () => {
		const result = await normalize([
			proposal({ assertion: "" }),
			proposal({ type: "benchmark_hack" }),
			proposal({ entity_type: "planet" }),
			proposal({ cardinality: "sometimes" }),
			proposal({ confidence: 4 }),
		]);
		expect(result.atoms).toEqual([]);
		expect(result.outcomes.rejected).toBe(5);
		expect(result.outcomes.rejectedByReason.invalid_enum).toBe(3);
	});

	it("enforces account rules after model output", async () => {
		const result = await normalize([proposal()], {
			rules: {
				customInstructions: "",
				includes: [],
				excludes: ["Northwind"],
			},
		});
		expect(result.atoms).toEqual([]);
		expect(result.outcomes.rejectedByReason.excluded_by_rule).toBe(1);
	});

	it("rejects secret material hallucinated into semantic fields", async () => {
		const result = await normalize([proposal({
			value: "AKIAIOSFODNN7EXAMPLE",
			assertion: "The key is AKIAIOSFODNN7EXAMPLE.",
		})]);
		expect(result.atoms).toEqual([]);
		expect(result.outcomes.rejectedByReason.secret_material).toBe(1);
	});

	it("deduplicates deterministically and keeps the highest confidence", async () => {
		const result = await normalize([proposal({ confidence: 0.4 }), proposal({ confidence: 0.9 })]);
		expect(result.atoms).toHaveLength(1);
		expect(result.atoms[0].confidence).toBe(0.9);
		expect(result.outcomes.duplicate).toBe(1);
	});

	it("derives replay-stable ids but binds them to tenant, project, packet, chunk, and span", async () => {
		const first = await normalize([proposal()]);
		const replay = await normalize([proposal({ confidence: 0.2 })]);
		expect(replay.atoms[0].id).toBe(first.atoms[0].id);

		for (const changed of [
			{ userId: "tenant-b" },
			{ projectId: "project-b" },
			{ sourcePacketId: "packet-b" },
			{ chunkKey: "chunk-b" },
		]) {
			const other = await normalize([proposal()], changed);
			expect(other.atoms[0].id).not.toBe(first.atoms[0].id);
		}
	});

	it("bounds model proposals and classifies the omitted tail", async () => {
		const many = Array.from({ length: 70 }, (_, index) => proposal({
			attribute: `attribute ${index}`,
			assertion: `Northwind fact ${index}.`,
		}));
		const result = await normalize(many);
		expect(result.outcomes.proposed).toBe(70);
		expect(result.outcomes.rejectedByReason.over_limit).toBeGreaterThan(0);
		expect(result.outcomes.accepted).toBeLessThanOrEqual(64);
	});

	it("supports every preregistered compact atom type", () => {
		expect([...ATOMIC_TYPES]).toEqual([
			"fact", "event", "relationship", "preference", "decision", "goal",
			"plan", "procedure", "quantity", "location", "state", "other",
		]);
	});
});
