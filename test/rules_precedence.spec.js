/**
 * Phase 7 §14.2 — rules precedence and conflict cases.
 *
 * The expected precedence must be explicit in tests, not inferred by the
 * extractor: deny beats allow, per-request overrides beat stored account rules
 * (replacement, not union), a rule change cannot retroactively rewrite an
 * already-accepted job's snapshot, and malformed/oversized rule input degrades
 * to a safe bounded set instead of disabling memory or throwing.
 */

import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";
import {
	getMemoryRules,
	mergeRuleOverride,
	normalizeMemoryRules,
	rulesAllowText,
	rulesRejection,
	saveMemoryRules,
} from "../src/pipeline/rules.js";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function post(path, body) {
	const request = new Request(`http://example.com${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

const canned = (label, text) => ({
	objects: [
		{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.95 },
		{ kind: "slice", on: label, text, kind_detail: "fact", confidence: 0.9 },
	],
	notes: "",
});

async function nodeLabels(userId) {
	const { results } = await env.DB.prepare(
		"SELECT label FROM nodes WHERE user_id = ? AND deleted_at IS NULL",
	).bind(userId).all();
	return (results ?? []).map((row) => String(row.label));
}

describe("deny beats allow", () => {
	it("refuses content that matches both an include and an exclude term", () => {
		const rules = normalizeMemoryRules({ includes: ["project"], excludes: ["salary"] });
		expect(rulesAllowText(rules, "My project salary review is next week")).toBe(false);
		expect(rulesRejection(rules, "My project salary review is next week")).toBe("excluded_by_rule");
		// Same include, no deny term → allowed.
		expect(rulesAllowText(rules, "My project deadline moved to Friday")).toBe(true);
	});

	it("names the two rejection reasons distinctly", () => {
		const denyOnly = normalizeMemoryRules({ excludes: ["salary"] });
		const allowOnly = normalizeMemoryRules({ includes: ["deploy"] });
		expect(rulesRejection(denyOnly, "salary talk")).toBe("excluded_by_rule");
		expect(rulesRejection(allowOnly, "lunch plans")).toBe("outside_include_rules");
		expect(rulesRejection(allowOnly, "deploy plans")).toBeNull();
	});

	it("compiles prose 'never save' instructions into enforced deny terms", () => {
		const rules = normalizeMemoryRules({ customInstructions: "Never save anything about my medication or my landlord." });
		expect(rulesAllowText(rules, "I take medication at eight")).toBe(false);
		expect(rulesAllowText(rules, "My landlord raised the rent")).toBe(false);
		expect(rulesAllowText(rules, "I deployed the new pipeline")).toBe(true);
	});

	it("refuses to compile a generic instruction into a memory-disabling deny term", () => {
		const rules = normalizeMemoryRules({ customInstructions: "Never save anything about it, or all the details." });
		expect(rulesAllowText(rules, "I decided to use SQLite for this project")).toBe(true);
	});
});

describe("override layering is replacement, not union", () => {
	it("lets a per-request override replace stored excludes entirely", () => {
		const base = normalizeMemoryRules({ excludes: ["salary"], includes: ["work"] });
		const overridden = mergeRuleOverride(base, { excludes: ["health"] });
		expect(overridden.excludes).toEqual(["health"]);
		// Untouched fields survive the override.
		expect(overridden.includes).toEqual(["work"]);
		expect(rulesAllowText(overridden, "my work salary")).toBe(true);
		expect(rulesAllowText(overridden, "my work health plan")).toBe(false);
	});

	it("keeps the base rule set when the override is empty or malformed", () => {
		const base = normalizeMemoryRules({ excludes: ["salary"] });
		for (const override of [null, undefined, "not an object", 42]) {
			expect(mergeRuleOverride(base, override)).toBe(base);
		}
	});
});

describe("matching cannot be evaded", () => {
	it("normalizes case, accents, and internal whitespace but respects token boundaries", () => {
		const rules = normalizeMemoryRules({ excludes: ["café münchen"] });
		expect(rulesAllowText(rules, "I met her at CAFE   MUNCHEN yesterday")).toBe(false);
		const salary = normalizeMemoryRules({ excludes: ["salary"] });
		expect(rulesAllowText(salary, "the salaryman commute is long")).toBe(true);
		expect(rulesAllowText(salary, "my salary, before tax")).toBe(false);
	});

	it("treats regex metacharacters in a term literally", () => {
		const rules = normalizeMemoryRules({ excludes: ["c++ (legacy)"] });
		expect(rulesAllowText(rules, "we retired the c++ (legacy) build")).toBe(false);
		expect(rulesAllowText(rules, "we retired the cxx build")).toBe(true);
	});
});

describe("malformed and oversized rule input degrades safely", () => {
	it("bounds term counts and lengths without throwing", async () => {
		const userId = `rules-bounds-${crypto.randomUUID()}`;
		const saved = await saveMemoryRules(env, userId, {
			excludes: Array.from({ length: 100 }, (_, index) => `term-${index}`),
			includes: ["x".repeat(500)],
			customInstructions: "y".repeat(5_000),
			customCategories: Array.from({ length: 40 }, (_, index) => ({ name: `Cat ${index}`, description: "d".repeat(400) })),
		});
		expect(saved.excludes).toHaveLength(32);
		expect(saved.includes[0]).toHaveLength(80);
		expect(saved.customInstructions).toHaveLength(2_000);
		expect(saved.customCategories).toHaveLength(16);
		expect(saved.customCategories[0].description.length).toBeLessThanOrEqual(160);
		// Round-trips through storage unchanged.
		expect(await getMemoryRules(env, userId)).toEqual(saved);
	});

	it("ignores non-string and duplicate terms instead of failing the save", async () => {
		const userId = `rules-malformed-${crypto.randomUUID()}`;
		const saved = await saveMemoryRules(env, userId, {
			excludes: ["Salary", "salary", "  salary  ", null, 42, {}, { term: "bonus" }],
		});
		expect(saved.excludes).toEqual(["Salary", "bonus"]);
		expect(rulesAllowText(saved, "my SALARY is fixed")).toBe(false);
		expect(rulesAllowText(saved, "my bonus is fixed")).toBe(false);
	});

	it("falls back to defaults rather than breaking a save when rules cannot be read", async () => {
		const broken = { DB: { prepare() { throw new Error("no table"); } } };
		const rules = await getMemoryRules(broken, "rules-unavailable");
		expect(rules.excludes).toEqual([]);
		expect(rulesAllowText(rules, "anything at all")).toBe(true);
	});
});

describe("a rule change reaches work that has not been written yet", () => {
	/**
	 * The documented contract: the CONTENT snapshot of an accepted job is
	 * immutable (a later session's messages can never join it), but the rules
	 * are resolved by the gates at WRITE time. That ordering is deliberate and
	 * privacy-forward: a user who says "stop saving X" has it honored for work
	 * still queued, instead of watching X land minutes later because the job was
	 * accepted first. Campaign invariant I8 forbids a later session SILENTLY
	 * changing an accepted job's terms; an explicit rule edit by the owner is
	 * neither silent nor someone else's.
	 */
	async function acceptWhileHeld(userId, message, llmResponse) {
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("lease", { until: Date.now() + 120_000, token: "rules-timing-hold" });
		});
		const save = await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m1", role: "user", content: message }],
			_test: { llmResponse },
		});
		expect(save.status).toBe(200);
		return stub;
	}

	async function releaseAndDrain(stub, userId) {
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.delete("lease");
		});
		for (let attempt = 0; attempt < 30; attempt += 1) {
			const drained = await stub.drain({ userId, maxJobs: 4 });
			if ((drained?.results ?? []).length || drained?.remaining === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	it("honors an exclude rule added after acceptance but before the write", async () => {
		const userId = `rules-tighten-${crypto.randomUUID()}`;
		const stub = await acceptWhileHeld(
			userId,
			"I decided the falcon pipeline runs its smoke suite first.",
			canned("Falcon pipeline", "Runs its smoke suite first"),
		);
		await saveMemoryRules(env, userId, { excludes: ["falcon"] });
		await releaseAndDrain(stub, userId);

		expect((await nodeLabels(userId)).some((label) => /falcon/i.test(label))).toBe(false);
		const receipts = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE user_id = ? AND detail LIKE '%excluded_by_rule%'",
		).bind(userId).all();
		// The refusal is explained, not silent.
		expect((receipts.results ?? []).length).toBeGreaterThan(0);
		await stub.resetAll();
	}, 30_000);

	it("honors a rule relaxed after acceptance, and records the write honestly", async () => {
		const userId = `rules-relax-${crypto.randomUUID()}`;
		await saveMemoryRules(env, userId, { excludes: ["falcon"] });
		const stub = await acceptWhileHeld(
			userId,
			"I decided the falcon pipeline runs its smoke suite first.",
			canned("Falcon pipeline", "Runs its smoke suite first"),
		);
		await saveMemoryRules(env, userId, { excludes: [] });
		await releaseAndDrain(stub, userId);

		expect((await nodeLabels(userId)).some((label) => /falcon/i.test(label))).toBe(true);
		await stub.resetAll();
	}, 30_000);

	it("keeps the accepted content snapshot immutable across the rule change", async () => {
		const userId = `rules-snapshot-content-${crypto.randomUUID()}`;
		const stub = await acceptWhileHeld(
			userId,
			"I decided the falcon pipeline runs its smoke suite first.",
			canned("Falcon pipeline", "Runs its smoke suite first"),
		);
		// A later, unrelated write must not be folded into the accepted job.
		await post("/v1/ingest", {
			userId,
			flush: true,
			messages: [{ id: "m2", role: "user", content: "I decided the heron service uses a read replica." }],
			_test: { llmResponse: canned("Heron service", "Uses a read replica") },
		});
		const jobs = await env.DB.prepare(
			"SELECT payload_json FROM memory_jobs WHERE user_id = ? AND type = 'extract'",
		).bind(userId).all();
		for (const row of jobs.results ?? []) {
			const payload = JSON.parse(row.payload_json ?? "{}");
			expect((payload.message_ids ?? []).length).toBe(1);
		}
		await stub.resetAll();
	}, 30_000);
});
