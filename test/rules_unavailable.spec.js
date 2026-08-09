import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { getMemoryRules, MemoryRulesUnavailableError, saveMemoryRules } from "../src/pipeline/rules.js";
import { resolveAdmissionRules } from "../src/pipeline/admission.js";
import { stageMemoryText } from "../src/pipeline/staged_text.js";
import { writeSourceEpisodes, countSourceEpisodes } from "../src/pipeline/episodes.js";

/**
 * V3-D01 — an unreadable rules store used to mean "no rules".
 *
 * Found while building the episode layer. Both `staged_text.js` and the new
 * episode writer are written to fail CLOSED when rules cannot be resolved, and
 * both had a try/catch that could never fire: `getMemoryRules` caught every
 * error and returned DEFAULTS, and `resolveAdmissionRules` passed those on. A
 * transient D1 failure on one SELECT therefore turned "never keep anything
 * about my salary" into "keep everything" — durably, and (with V3) searchably.
 *
 * The distinction that fixes it: a MISSING TABLE is a real answer (a table that
 * does not exist cannot hold a rule, so defaults are the truth). Any other read
 * failure is not an answer at all, and admission lanes must refuse rather than
 * assume.
 */

const brokenDb = (message = "D1_ERROR: network") => ({
	prepare() { throw new Error(message); },
	batch() { throw new Error(message); },
});

const missingTableDb = () => ({
	prepare() { throw new Error("D1_ERROR: no such table: memory_rules"); },
	batch() { throw new Error("D1_ERROR: no such table: memory_rules"); },
});

let counter = 0;
const nextUser = (tag) => `rules_${tag}_${Date.now().toString(36)}_${counter++}`;

describe("an unreadable rules store is not an empty one", () => {
	it("throws for admission callers instead of handing back defaults", async () => {
		await expect(resolveAdmissionRules({ DB: brokenDb() }, "user_x"))
			.rejects.toBeInstanceOf(MemoryRulesUnavailableError);
	});

	it("still returns defaults for display callers, which must not 500 over a blip", async () => {
		const rules = await getMemoryRules({ DB: brokenDb() }, "user_x");
		expect(rules.excludes).toEqual([]);
		expect(rules.includes).toEqual([]);
	});

	it("treats a MISSING TABLE as the real answer it is, in both modes", async () => {
		// A table that does not exist cannot hold a rule. This is the pre-migration
		// case the original swallow-everything was written for, and it is kept.
		await expect(resolveAdmissionRules({ DB: missingTableDb() }, "user_x")).resolves.toMatchObject({
			excludes: [],
			includes: [],
		});
		await expect(getMemoryRules({ DB: missingTableDb() }, "user_x", { failClosed: true }))
			.resolves.toMatchObject({ excludes: [] });
	});

	it("never consults the store at all when the door already resolved the rules", async () => {
		// The SRV-04 contract: a scoped mem_ id owns no rules row, so the door's
		// resolved object is authoritative and must not be second-guessed.
		const resolved = { excludes: ["salary"], includes: [], customInstructions: "" };
		await expect(resolveAdmissionRules({ DB: brokenDb() }, "mem_scoped", resolved)).resolves.toBe(resolved);
	});
});

describe("admission lanes fail closed when rules cannot be read", () => {
	it("stages no read-your-writes text", async () => {
		const userId = nextUser("staged");
		const result = await stageMemoryText({ DB: brokenDb() }, userId, {
			jobId: "job_1",
			sourcePacketId: "pkt_1",
			lane: "ingest",
			messages: [{ id: "m0", role: "user", content: "my salary is 74000" }],
		});
		expect(result.staged).toBe(0);
		expect(result.rulesUnavailable).toBe(true);

		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM staged_memories WHERE user_id = ?",
		).bind(userId).first();
		expect(row.n).toBe(0);
	});

	it("writes no source episodes", async () => {
		const userId = nextUser("episode");
		const result = await writeSourceEpisodes({ DB: brokenDb() }, userId, {
			sourcePacketId: "pkt_1",
			messages: [{ id: "m0", role: "user", content: "my salary is 74000" }],
		});
		expect(result.written).toBe(0);
		expect(result.rulesUnavailable).toBe(true);
		expect(await countSourceEpisodes(env, userId)).toBe(0);
	});

	it("keeps enforcing a real exclude when the store IS readable", async () => {
		// The negative control: fail-closed must not be an excuse to stop working.
		const userId = nextUser("works");
		await saveMemoryRules(env, userId, { excludes: ["salary"], includes: [], customInstructions: "" });
		const result = await writeSourceEpisodes(env, userId, {
			sourcePacketId: "pkt_ok",
			messages: [
				{ id: "m0", role: "user", content: "my salary is 74000" },
				{ id: "m1", role: "user", content: "I moved to Malmo" },
			],
		});
		expect(result.written).toBe(1);
		expect(result.ruleFiltered).toBe(1);
	});
});
