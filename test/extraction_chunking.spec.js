import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import {
	EXTRACTION_CHUNK_MAX_CHARS,
	EXTRACTION_CHUNK_MAX_MESSAGES,
	extractionChunkKey,
	planExtractionChunks,
	verifyChunkCoverage,
} from "../src/pipeline/chunking.js";
import { extractJson, normalize, responseTruncated, salvageObjects } from "../src/pipeline/llm.js";
import { getConfig } from "../src/config.js";

/**
 * P0-C — extraction mechanical reliability.
 *
 * Two mechanical ceilings sat in front of capture, and the LLM-judge baseline
 * puts 64.6% of its misses in "never stored". Neither is a model-quality
 * problem, so neither needs a model to fix or to test.
 */

const message = (id, chars, role = "user") => ({
	id,
	role,
	content: "x".repeat(chars),
	content_hash: `hash_${id}`,
});

describe("chunk planning: coverage", () => {
	it("covers every message exactly once, in order", async () => {
		for (const count of [0, 1, 2, 7, 8, 9, 10, 17, 31, 64]) {
			const messages = Array.from({ length: count }, (_, i) => message(`m${i}`, 10));
			const chunks = await planExtractionChunks(messages);
			const flat = chunks.flatMap((chunk) => chunk.messages);
			expect(flat, `count=${count}`).toEqual(messages);
			expect(verifyChunkCoverage(messages, chunks).ok).toBe(true);
		}
	});

	it("preserves chronology within and across sub-chunks", async () => {
		const messages = Array.from({ length: 25 }, (_, i) => message(`m${i}`, 10));
		const chunks = await planExtractionChunks(messages);
		const seen = chunks.flatMap((chunk) => chunk.messageIds);
		expect(seen).toEqual(messages.map((m) => m.id));
		// Sub-chunks are contiguous slices, never interleaved.
		let cursor = 0;
		for (const chunk of chunks) {
			expect(chunk.messages).toEqual(messages.slice(cursor, cursor + chunk.messages.length));
			cursor += chunk.messages.length;
		}
	});

	it("never exceeds its message bound", async () => {
		const messages = Array.from({ length: 40 }, (_, i) => message(`m${i}`, 10));
		for (const chunk of await planExtractionChunks(messages)) {
			expect(chunk.messages.length).toBeLessThanOrEqual(EXTRACTION_CHUNK_MAX_MESSAGES);
		}
	});

	it("bounds by CHARACTERS too, because eight long messages do not fit one call", async () => {
		// Eight messages at the 4,000-character wire limit is 32,000 characters:
		// under the message bound, far over any sane output budget.
		const messages = Array.from({ length: 8 }, (_, i) => message(`m${i}`, 4000));
		const chunks = await planExtractionChunks(messages);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// A chunk may reach the budget but must not be built past it, except
			// where a single message is itself larger than the whole budget.
			expect(chunk.chars <= EXTRACTION_CHUNK_MAX_CHARS || chunk.messages.length === 1).toBe(true);
		}
		expect(verifyChunkCoverage(messages, chunks).ok).toBe(true);
	});

	it("gives an oversized single message its own chunk rather than splitting it", async () => {
		const messages = [message("small", 10), message("huge", 50_000), message("after", 10)];
		const chunks = await planExtractionChunks(messages);
		const huge = chunks.find((chunk) => chunk.messageIds.includes("huge"));
		expect(huge.messages).toHaveLength(1);
		// Half a message with a provenance pointer to the whole would be a lie
		// about where the fact came from.
		expect(huge.messages[0].content).toHaveLength(50_000);
		expect(verifyChunkCoverage(messages, chunks).ok).toBe(true);
	});

	it("closes the 9-and-10-message hole: no sub-chunk outruns the rescue ceiling", async () => {
		// The old threshold split only chunks LONGER than 10 while the split
		// rescue refused more than 8, so a truncated 9- or 10-message call had no
		// recovery path and the fire wrote nothing.
		const rescueCeiling = getConfig(env).splitRescue.maxCalls;
		for (const count of [9, 10]) {
			const messages = Array.from({ length: count }, (_, i) => message(`m${i}`, 10));
			const chunks = await planExtractionChunks(messages, getConfig(env).extractionChunk);
			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect(chunk.messages.length).toBeLessThanOrEqual(rescueCeiling);
			}
		}
	});

	it("keeps the configured message bound at or under the rescue ceiling", () => {
		const config = getConfig(env);
		expect(config.extractionChunk.maxMessages).toBeLessThanOrEqual(config.splitRescue.maxCalls);
	});
});

describe("chunk planning: replay equivalence", () => {
	it("is a pure function — same input, same plan, forever", async () => {
		const messages = Array.from({ length: 23 }, (_, i) => message(`m${i}`, 300));
		const first = await planExtractionChunks(messages);
		const second = await planExtractionChunks(messages);
		expect(second.map((c) => c.key)).toEqual(first.map((c) => c.key));
		expect(second.map((c) => c.messageIds)).toEqual(first.map((c) => c.messageIds));
	});

	it("derives the same identities from a rebuilt copy of the same messages", async () => {
		// What a retry actually does: rebuild the messages from D1, re-plan.
		const messages = Array.from({ length: 19 }, (_, i) => message(`m${i}`, 250));
		const rebuilt = JSON.parse(JSON.stringify(messages));
		expect((await planExtractionChunks(rebuilt)).map((c) => c.key))
			.toEqual((await planExtractionChunks(messages)).map((c) => c.key));
	});

	it("changes identity when the content changes", async () => {
		const a = [message("m0", 10), message("m1", 10)];
		const b = [message("m0", 10), { ...message("m1", 10), content_hash: "different" }];
		expect(await extractionChunkKey(b)).not.toBe(await extractionChunkKey(a));
	});

	it("changes identity when the order changes", async () => {
		const a = [message("m0", 10), message("m1", 10)];
		expect(await extractionChunkKey([a[1], a[0]])).not.toBe(await extractionChunkKey(a));
	});
});

describe("chunk planning: coverage verification catches a broken plan", () => {
	it("reports a dropped message", () => {
		const messages = [message("a", 5), message("b", 5)];
		const broken = [{ messages: [messages[0]] }];
		const result = verifyChunkCoverage(messages, broken);
		expect(result.ok).toBe(false);
		expect(result.problems[0]).toMatch(/covered 1 of 2/);
	});

	it("reports a reordered message", () => {
		const messages = [message("a", 5), message("b", 5)];
		const broken = [{ messages: [messages[1], messages[0]] }];
		expect(verifyChunkCoverage(messages, broken).ok).toBe(false);
	});
});

describe("truncated responses: keep the facts that completed", () => {
	const truncated = `{"objects":[
		{"kind":"node","label":"Boxing","category":"skill","confidence":0.95},
		{"kind":"event","on":"Boxing","action":"started","text":"Started boxing","confidence":0.9},
		{"kind":"node","label":"Aveiro","category":"place","confidence":0.9},
		{"kind":"slice","on":"Aveiro","text":"Sister lives in Av`;

	it("recovers every complete object from a response cut off mid-JSON", () => {
		const objects = salvageObjects(truncated);
		expect(objects).toHaveLength(3);
		expect(objects.map((o) => o.label ?? o.on)).toEqual(["Boxing", "Boxing", "Aveiro"]);
	});

	it("discards the object that was still open", () => {
		expect(salvageObjects(truncated).some((o) => String(o.text ?? "").includes("Sister lives"))).toBe(false);
	});

	it("routes salvage through the normal parse path and flags it", () => {
		const parsed = extractJson(truncated);
		expect(parsed.objects).toHaveLength(3);
		expect(parsed._truncated).toBe(true);
		const proposal = normalize(parsed);
		expect(proposal._ok).toBe(true);
		expect(proposal._truncated).toBe(true);
		expect(proposal.objects).toHaveLength(3);
	});

	it("does not disturb a well-formed response", () => {
		const whole = '{"objects":[{"kind":"node","label":"Kaka"}],"notes":"ok"}';
		const parsed = extractJson(whole);
		expect(parsed.objects).toHaveLength(1);
		expect(parsed._truncated).toBeUndefined();
		expect(normalize(parsed)._truncated).toBeUndefined();
	});

	it("still salvages through reasoning wrappers and code fences", () => {
		const wrapped = `<think>let me see</think>\n\`\`\`json\n${truncated}`;
		expect(extractJson(wrapped).objects).toHaveLength(3);
	});

	it("returns nothing when nothing completed", () => {
		expect(salvageObjects('{"objects":[{"kind":"node","label":"Half')).toBe(null);
		expect(extractJson('{"objects":[{"kind":"node","label":"Half')).toBe(null);
	});

	it("is not fooled by braces inside strings", () => {
		const tricky = '{"objects":[{"kind":"slice","text":"uses {curly} braces \\" and quotes"}], "notes":"x"}';
		expect(extractJson(tricky).objects[0].text).toBe('uses {curly} braces " and quotes');
	});

	it("finds no objects array to salvage in unrelated prose", () => {
		expect(salvageObjects("I am afraid I cannot help with that.")).toBe(null);
	});
});

describe("truncation detection is separate from parse failure", () => {
	it("reads the OpenAI-shaped finish reason", () => {
		expect(responseTruncated({ choices: [{ finish_reason: "length" }] })).toBe(true);
		expect(responseTruncated({ choices: [{ finish_reason: "stop" }] })).toBe(false);
	});

	it("reads the alternative shapes without inventing one", () => {
		expect(responseTruncated({ stop_reason: "max_tokens" })).toBe(true);
		expect(responseTruncated({ finish_reason: "length" })).toBe(true);
		expect(responseTruncated({ response: "plain text" })).toBe(false);
		expect(responseTruncated(null)).toBe(false);
		expect(responseTruncated("a string")).toBe(false);
	});
});

describe("schema-constrained output is available but not assumed", () => {
	it("is OFF unless the deployment says the model supports it", () => {
		expect(getConfig(env).llm.jsonMode).toBe(false);
		expect(getConfig({ ...env, LLM_JSON_MODE: "true" }).llm.jsonMode).toBe(true);
	});
});
