/**
 * Regression pass over the SHARED admission path — rules.js + source.js — with
 * ITSUKI_MEMORY_V3 switched ON, which is how production runs it.
 *
 * Two things make this file necessary rather than redundant:
 *
 *   1. `sourcePacketWithAdmissionRules()` only runs when V3 is enabled, and the
 *      suite's wrangler.test.jsonc does not set ITSUKI_MEMORY_V3 at all. Every
 *      other spec therefore exercises the admission path with that call skipped,
 *      while prod (wrangler.jsonc: "on") always takes it. Each test here passes
 *      a V3-enabled env explicitly.
 *
 *   2. Enforcement is shared. rulesRejection() is the single verdict behind the
 *      SDK, MCP, plugin, /v1/turn and Playground lanes, so a change to it is a
 *      change to all seven at once. These are the lane-level invariants, stated
 *      once and asserted per door.
 *
 * The invariant under test is the product promise: text an account's rules
 * refuse must not survive anywhere durable, and text they permit must not
 * silently stop being captured.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import { runDirectSaveCommand, runObserveMessagesCommand } from "../src/pipeline/commands.js";
import { normalizeSourcePacket, sourcePacketWithAdmissionRules } from "../src/pipeline/source.js";
import { normalizeMemoryRules, rulesRejection, saveMemoryRules } from "../src/pipeline/rules.js";

const KEPT = "The deploy is Friday.";
const REFUSED = "My salary review is Monday.";
const MESSAGE = `${KEPT} ${REFUSED}`;

function userId(label) {
	return `adm-${label}-${crypto.randomUUID()}`;
}

/** The env every lane actually runs under in production. */
function v3Env(id) {
	return { ...env, ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: id };
}

async function httpFetch(path, body, id) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers: { "x-api-key": env.API_KEY, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, v3Env(id), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/**
 * Everything this user's accepted WRITE made durable at accept time, as one
 * string. Stringified whole rows rather than named columns so a future column
 * carrying text cannot quietly escape the assertion.
 *
 * Recall packets (source_type "query") are excluded, and not because they are
 * uninteresting: /v1/turn stores the query text in a source packet that the
 * admission rules never see, so an account that said "never save my salary"
 * still gets that text durably stored the moment it ASKS about it. That is a
 * real gap in the read lane, it predates this file, and closing it changes
 * recall idempotency — so it is named here and tracked separately rather than
 * silently folded into a write-lane assertion.
 */
async function durableTextFor(id) {
	const parts = [];
	const { results: packets } = await env.DB.prepare(
		"SELECT * FROM source_packets WHERE user_id = ? AND source_type != 'query'",
	).bind(id).all();
	parts.push(JSON.stringify(packets ?? []));
	const { results: episodes } = await env.DB.prepare(
		"SELECT * FROM source_episodes WHERE user_id = ?",
	).bind(id).all();
	parts.push(JSON.stringify(episodes ?? []));
	return parts.join("\n");
}

async function packetsFor(id) {
	const { results } = await env.DB.prepare(
		"SELECT * FROM source_packets WHERE user_id = ?",
	).bind(id).all();
	return results ?? [];
}

describe("the admission path never stores what the rules refuse", () => {
	it("stores nothing from a message the rules refuse", async () => {
		const rules = normalizeMemoryRules({ excludes: ["salary"] });
		const normalized = await normalizeSourcePacket(userId("unit"), {
			messages: [{ role: "user", content: MESSAGE }],
			conversationId: "admission-unit",
		});
		const gated = sourcePacketWithAdmissionRules(normalized.packet, normalized.messages, rules);

		// Admission is per message. A message carrying a refused term is not
		// stored — not previewed, not counted, and above all not left sitting in
		// the provenance blob that is what actually gets read back.
		expect(gated.content_preview).toBeNull();
		expect(gated.message_count).toBe(0);
		expect(JSON.parse(gated.raw_meta_json).messages).toEqual([]);
		expect(gated.raw_meta_json).not.toContain("salary");
	});

	it("keeps the permitted message when another in the same batch is refused", async () => {
		const rules = normalizeMemoryRules({ excludes: ["salary"] });
		const normalized = await normalizeSourcePacket(userId("unit-batch"), {
			messages: [
				{ role: "user", content: KEPT },
				{ role: "user", content: REFUSED },
			],
			conversationId: "admission-unit-batch",
		});
		const gated = sourcePacketWithAdmissionRules(normalized.packet, normalized.messages, rules);
		expect(gated.content_preview).toBe(KEPT);
		expect(gated.message_count).toBe(1);
		expect(gated.raw_meta_json).not.toContain("salary");
	});

	it("leaves a fully permitted packet byte-for-byte alone", async () => {
		const rules = normalizeMemoryRules({ excludes: ["salary"] });
		const normalized = await normalizeSourcePacket(userId("unit-clean"), {
			messages: [{ role: "user", content: KEPT }],
			conversationId: "admission-unit-clean",
		});
		const gated = sourcePacketWithAdmissionRules(normalized.packet, normalized.messages, rules);
		expect(gated).toBe(normalized.packet);
	});
});

describe("every write lane enforces the same rules", () => {
	it("SDK ingest / REST /v1/ingest", async () => {
		const id = userId("ingest");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const res = await httpFetch("/v1/ingest", {
			userId: id,
			messages: [{ role: "user", content: MESSAGE }],
			conversationId: "lane-ingest",
		}, id);
		expect(res.status).toBe(200);
		expect(await durableTextFor(id)).not.toContain("salary");
	});

	it("SDK add / REST /v1/save (direct)", async () => {
		const id = userId("save");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const res = await httpFetch("/v1/save", { userId: id, content: MESSAGE, conversationId: "lane-save" }, id);
		expect(res.status).toBe(200);
		expect(await durableTextFor(id)).not.toContain("salary");
	});

	it("SDK add_conversation / REST /v1/save mode=conversation", async () => {
		const id = userId("conversation");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const res = await httpFetch("/v1/save", {
			userId: id,
			mode: "conversation",
			messages: [{ role: "user", content: MESSAGE }],
			conversationId: "lane-conversation",
		}, id);
		expect(res.status).toBe(200);
		expect(await durableTextFor(id)).not.toContain("salary");
	});

	it("/v1/turn", async () => {
		const id = userId("turn");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const res = await httpFetch("/v1/turn", {
			userId: id,
			messages: [{ role: "user", content: MESSAGE }],
			conversationId: "lane-turn",
		}, id);
		expect(res.status).toBe(200);
		expect(await durableTextFor(id)).not.toContain("salary");
	});

	it("MCP save_memory", async () => {
		const id = userId("mcp-direct");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const ctx = createExecutionContext();
		await runDirectSaveCommand(v3Env(id), ctx, id, { content: MESSAGE, conversationId: "lane-mcp-direct" });
		await waitOnExecutionContext(ctx);
		expect(await durableTextFor(id)).not.toContain("salary");
	});

	it("the Playground chat lane", async () => {
		const id = userId("playground");
		await saveMemoryRules(env, id, { excludes: ["salary"] });
		const ctx = createExecutionContext();
		await runObserveMessagesCommand(v3Env(id), ctx, id, [{ role: "user", content: MESSAGE }], {
			conversationId: "playground:lane",
			source: "ingest",
			sourceMode: "playground",
		});
		await waitOnExecutionContext(ctx);
		expect(await durableTextFor(id)).not.toContain("salary");
	});
});

describe("a written instruction cannot silently switch memory off", () => {
	/**
	 * The deny side of instruction parsing fails safe: a false positive blocks
	 * one topic. The allow side does not — an allow-list refuses EVERYTHING that
	 * does not match it, so one over-broad phrase lifted out of prose turns the
	 * product off for that account with no error and no receipt anywhere.
	 *
	 * These are the phrasings a person actually writes.
	 */
	const vacuous = [
		"Only save what matters.",
		"Just remember the key decisions.",
		"Please only store information that is actually useful later.",
		"Save only what I explicitly tell you to remember.",
	];

	for (const instructions of vacuous) {
		it(`still captures ordinary content under: ${JSON.stringify(instructions)}`, () => {
			const rules = normalizeMemoryRules({ customInstructions: instructions });
			expect(rulesRejection(rules, "I moved the deploy to Friday")).toBeNull();
			expect(rulesRejection(rules, "We picked Postgres over SQLite")).toBeNull();
		});
	}

	it("still enforces the deny half of the same instruction", () => {
		const rules = normalizeMemoryRules({
			customInstructions: "Don't save jokes. Only keep decisions about the codebase.",
		});
		expect(rulesRejection(rules, "I told two jokes at standup")).toBe("excluded_by_rule");
		expect(rulesRejection(rules, "I moved the deploy to Friday")).toBeNull();
	});

	it("still enforces an allow-list the account actually set", () => {
		const rules = normalizeMemoryRules({ includes: ["boxing"] });
		expect(rulesRejection(rules, "I started boxing today")).toBeNull();
		expect(rulesRejection(rules, "I love guitar")).toBe("outside_include_rules");
	});

	it("writes a real packet through a live lane under that instruction", async () => {
		const id = userId("prose-allow");
		await saveMemoryRules(env, id, { customInstructions: "Only save what matters." });
		const res = await httpFetch("/v1/ingest", {
			userId: id,
			messages: [{ role: "user", content: "I moved the deploy to Friday." }],
			conversationId: "lane-prose-allow",
		}, id);
		expect(res.status).toBe(200);
		const [packet] = await packetsFor(id);
		expect(packet).toBeTruthy();
		// message_count 0 is what "the account's memory is now off" looks like
		// from the outside: accepted, receipted, and holding nothing.
		expect(packet.message_count).toBe(1);
	});
});
