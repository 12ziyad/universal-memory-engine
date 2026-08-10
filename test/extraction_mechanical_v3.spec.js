import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
	extractionChunkKey,
	planExtractionChunks,
	verifyChunkCoverage,
} from "../src/pipeline/chunking.js";
import { getConfig } from "../src/config.js";
import { normalize, proposeMemory } from "../src/pipeline/llm.js";
import { runExtraction } from "../src/pipeline/extract.js";

const message = (id, content, sourceTime = null) => ({
	id,
	role: "user",
	content,
	content_hash: `hash-${id}`,
	...(sourceTime ? { source_time: sourceTime } : {}),
});

describe("E2-B0 extraction conservation", () => {
	it("uses Unicode code points consistently for planning and spans", async () => {
		const messages = [message("a", "😀😀😀"), message("b", "🧠🧠🧠")];
		const chunks = await planExtractionChunks(messages, { maxMessages: 8, maxChars: 6 });

		expect(chunks).toHaveLength(1);
		expect(chunks[0].chars).toBe(6);
		expect(chunks[0].spans).toEqual([
			{ messageId: "a", messageIndex: 0, startCodePoint: 0, endCodePoint: 3 },
			{ messageId: "b", messageIndex: 1, startCodePoint: 0, endCodePoint: 3 },
		]);
		expect(verifyChunkCoverage(messages, chunks)).toMatchObject({
			ok: true,
			inputCodePoints: 6,
			coveredCodePoints: 6,
		});
	});

	it("uses a SHA-256 identity bound to source time and packet provenance", async () => {
		const messages = [message("a", "same text", { epoch_ms: 1_700_000_000_000, offset_minutes: 0, precision: "time" })];
		const first = await extractionChunkKey(messages, { sourcePacketId: "packet-a" });
		const replay = await extractionChunkKey(JSON.parse(JSON.stringify(messages)), { sourcePacketId: "packet-a" });
		const otherPacket = await extractionChunkKey(messages, { sourcePacketId: "packet-b" });
		const otherTime = await extractionChunkKey([
			message("a", "same text", { epoch_ms: 1_700_000_001_000, offset_minutes: 0, precision: "time" }),
		], { sourcePacketId: "packet-a" });

		expect(first).toMatch(/^chunk:v2:[a-f0-9]{64}$/);
		expect(replay).toBe(first);
		expect(otherPacket).not.toBe(first);
		expect(otherTime).not.toBe(first);
	});

	it("fails closed when span accounting is altered", async () => {
		const messages = [message("a", "alpha"), message("b", "beta")];
		const chunks = await planExtractionChunks(messages);
		chunks[0].spans[0].endCodePoint -= 1;

		const coverage = verifyChunkCoverage(messages, chunks);
		expect(coverage.ok).toBe(false);
		expect(coverage.problems.join(" ")).toMatch(/span|code point/i);
	});

	it("classifies every normalized envelope without logging raw model output", async () => {
		expect(normalize({ objects: [{ kind: "node", label: "Alpha" }] })._outcome).toBe("valid_nonempty");
		expect(normalize({ objects: [] })._outcome).toBe("valid_empty");
		expect(normalize({ nope: [] })._outcome).toBe("schema_invalid");

		const canary = "PRIVATE_MODEL_OUTPUT_CANARY_7f98";
		const warnings = [];
		const warn = vi.spyOn(console, "warn").mockImplementation((...parts) => warnings.push(parts.join(" ")));
		try {
			const fakeEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
				AI: { run: async () => ({ response: `${canary} {\"objects\":[` }) },
			});
			const proposal = await proposeMemory(
				fakeEnv,
				getConfig(fakeEnv),
				{ packet: { bridge_context: [], assistant_context: [], new_slice: [] }, shortlist: [] },
			);
			expect(proposal).toMatchObject({ _ok: false, _outcome: "parse_invalid" });
			expect(warnings.join("\n")).not.toContain(canary);
		} finally {
			warn.mockRestore();
		}
	});

	it.each([
		["refusal", async () => ({ choices: [{ message: { refusal: "declined", content: "" } }] })],
		["truncated_unsalvageable", async () => ({ response: '{"objects":[{"kind":"node"', choices: [{ finish_reason: "length" }] })],
		["timeout", async () => { const error = new Error("private timeout detail"); error.name = "TimeoutError"; throw error; }],
		["transport_error", async () => { throw new Error("private transport detail"); }],
	])("classifies %s without emitting response/error details", async (expected, run) => {
		const warnings = [];
		const warn = vi.spyOn(console, "warn").mockImplementation((...parts) => warnings.push(parts.join(" ")));
		try {
			const fakeEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI: { run } });
			const proposal = await proposeMemory(
				fakeEnv,
				getConfig(fakeEnv),
				{ packet: { bridge_context: [], assistant_context: [], new_slice: [] }, shortlist: [] },
			);
			expect(proposal._outcome).toBe(expected);
			expect(warnings.join("\n")).not.toMatch(/declined|private timeout detail|private transport detail/);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("E2-B1 failed-span semantics", () => {
	it("rejects a structurally invalid object envelope for bounded retry", () => {
		const proposal = normalize({
			objects: [
				{ kind: "node", label: "Valid" },
				{ kind: "event", text: "Missing subject and action" },
			],
		}, { strict: true, dedupe: true });

		expect(proposal).toMatchObject({
			_ok: false,
			_outcome: "schema_invalid",
			_invalid_objects: 1,
		});
		expect(proposal.objects).toEqual([]);
	});

	it("deduplicates equivalent proposal atoms deterministically before admission", () => {
		const objects = [
				{ kind: "slice", on: "API gateway", text: "Moved  from Express to Hono", kind_detail: "decision", confidence: 0.8 },
				{ kind: "slice", on: "api GATEWAY", text: "moved from express to hono", kind_detail: "decision", confidence: 0.95 },
		];
		const forward = normalize({ objects }, { strict: true, dedupe: true });
		const reversed = normalize({ objects: [...objects].reverse() }, { strict: true, dedupe: true });

		expect(forward).toMatchObject({ _ok: true, _duplicates: 1 });
		expect(forward.objects).toHaveLength(1);
		expect(forward.objects).toEqual(reversed.objects);
		expect(forward.objects[0].confidence).toBe(0.95);
	});

	it("is active only for the selected tenant; legacy behavior cannot inherit the flag", async () => {
		const selected = `e2-selected-${crypto.randomUUID()}`;
		const legacy = `e2-legacy-${crypto.randomUUID()}`;
		const allowlistedEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: selected,
			ITSUKI_MEMORY_V3_EXTRACTION_B1: "allowlist",
			ITSUKI_MEMORY_V3_EXTRACTION_B1_USERS: selected,
		});
		const chunk = [message("good", "I use Hono for the Atlas gateway."), message("bad", "poisoned span")];
		const response = ({ packet }) => {
			if (packet.new_slice.length > 1 || packet.new_slice[0].id === "bad") return "{broken";
			return { objects: [{ kind: "node", label: "Atlas gateway", category: "project", confidence: 0.95 }] };
		};

		const selectedResult = await runExtraction(allowlistedEnv, selected, chunk, [], { llmResponse: response });
		const legacyResult = await runExtraction(allowlistedEnv, legacy, chunk, [], { llmResponse: response });
		const selectedNodes = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(selected).first();

		expect(selectedResult.outcome).toBe("llm_failed");
		expect(Number(selectedNodes.n)).toBe(0);
		expect(legacyResult.outcome).toBe("wrote");
		expect(legacyResult.receipt.savedTotal).toBeGreaterThan(0);
	});

	it("never reports semantic success or writes a partial graph when one rescued span is unreadable", async () => {
		const userId = `e2-failed-span-${crypto.randomUUID()}`;
		const chunk = [
			message("good", "I moved the API gateway from Express to Hono."),
			message("bad", "A permanently malformed model response is simulated for this span."),
		];
		const response = ({ packet }) => {
			if (packet.new_slice.length > 1) return "{broken primary";
			if (packet.new_slice[0].id === "bad") return "{still broken";
			return {
				objects: [
					{ kind: "node", label: "API gateway", category: "project", confidence: 0.95 },
					{ kind: "slice", on: "API gateway", text: "Moved from Express to Hono", kind_detail: "decision", confidence: 0.95 },
				],
			};
		};

		const v3Env = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			ITSUKI_MEMORY_V3: "on",
			ITSUKI_MEMORY_V3_EXTRACTION_B1: "on",
		});
		const result = await runExtraction(v3Env, userId, chunk, [], { llmResponse: response });
		const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?").bind(userId).first();

		expect(result.outcome).toBe("llm_failed");
		expect(result.receipt.savedTotal).toBe(0);
		expect(result.receipt.extraction_outcome).toBe("span_incomplete");
		expect(result.receipt.extraction_failed_spans).toBe(1);
		expect(Number(rows.n)).toBe(0);
	});
});
