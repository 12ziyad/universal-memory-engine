import { describe, expect, it, vi } from "vitest";
import { previewMemoryRules } from "../src/lib/rules_preview.js";

const category = {
	id: "pcat_work",
	slug: "work-projects",
	name: "Work projects",
	description: "Durable work and delivery context",
	color_token: "indigo",
	status: "active",
};

function aiReturning(value) {
	return {
		run: vi.fn(async () => ({ response: JSON.stringify(value) })),
	};
}

// The preview makes up to two calls in a fixed order (category proposal, then
// worthiness assessment), so tests queue one canned outcome per call. An Error
// in the queue makes that call throw.
function aiQueue(...outcomes) {
	const queue = [...outcomes];
	return {
		run: vi.fn(async () => {
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return { response: JSON.stringify(next) };
		}),
	};
}

describe("enterprise rules preview", () => {
	it("returns deterministic denies and one validated no-write category proposal", async () => {
		const AI = aiReturning({
			assignments: [
				{ index: 0, category_slug: "work-projects" },
				{ index: 2, category_slug: null },
			],
		});
		const env = { AI, RULES_PREVIEW_MODEL: "preview-model" };
		const result = await previewMemoryRules(env, {
			samples: ["Northwind ships on Friday", "My salary is private", "I enjoy hiking"],
			rules: { excludes: ["salary"], includes: [], captureDefault: "auto", autoCollect: true },
			projectCategories: [category],
		});

		expect(result).toMatchObject({ ok: true, active_category_count: 1, category_preview: "evaluated" });
		expect(result.results[0]).toMatchObject({
			kept: true,
			project_category: category,
			project_category_reason: "model_proposed",
		});
		expect(result.results[1]).toMatchObject({
			kept: false,
			project_category: null,
			project_category_reason: "not_evaluated_blocked",
		});
		expect(result.results[2]).toMatchObject({
			kept: true,
			project_category: null,
			project_category_reason: "no_clear_category",
		});

		// Category call first, worthiness assessment second — never more.
		expect(AI.run).toHaveBeenCalledTimes(2);
		const [model, input] = AI.run.mock.calls[0];
		expect(model).toBe("preview-model");
		const payload = JSON.parse(input.messages[1].content);
		expect(payload.samples.map((row) => row.index)).toEqual([0, 2]);
		expect(JSON.stringify(payload)).not.toContain("salary");
		expect(input.response_format.type).toBe("json_schema");
	});

	it("defaults to the documented JSON-mode model", async () => {
		const AI = aiReturning({ assignments: [{ index: 0, category_slug: null }] });
		await previewMemoryRules({ AI }, {
			samples: ["Allowed"],
			rules: {},
			projectCategories: [category],
		});
		expect(AI.run.mock.calls[0][0]).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
	});

	it("fails closed on unoffered slugs and never guesses a category", async () => {
		const AI = aiReturning({ assignments: [{ index: 0, category_slug: "invented-secret-folder" }] });
		const result = await previewMemoryRules({ AI }, {
			samples: ["Northwind ships on Friday"],
			rules: {},
			projectCategories: [category],
		});
		expect(result.results[0]).toMatchObject({
			kept: true,
			project_category: null,
			project_category_reason: "no_clear_category",
		});
	});

	it("normalizes the extraction-oriented active-category contract for display", async () => {
		const AI = aiReturning({ assignments: [{ index: 0, category_slug: "work_projects" }] });
		const result = await previewMemoryRules({ AI }, {
			samples: ["Northwind ships on Friday"],
			rules: {},
			projectCategories: [{
				id: "pcat_work",
				slug: "work_projects",
				name: "work_projects",
				displayName: "Work projects",
				description: "Durable work and delivery context",
				colorToken: "indigo",
			}],
		});
		expect(result.results[0].project_category).toMatchObject({
			id: "pcat_work",
			slug: "work_projects",
			name: "Work projects",
			color_token: "indigo",
		});
	});

	it("reports unavailable honestly and bounds samples without touching D1", async () => {
		const DB = new Proxy({}, { get() { throw new Error("preview must not touch D1"); } });
		const result = await previewMemoryRules({ DB }, {
			samples: Array.from({ length: 12 }, (_, index) => `${index}: ${"x".repeat(500)}`),
			rules: {},
			projectCategories: [category],
		});
		expect(result.results).toHaveLength(10);
		expect(result.results.every((row) => row.text.length <= 400)).toBe(true);
		expect(result.results.every((row) => row.project_category_reason === "preview_unavailable")).toBe(true);
		expect(result.category_preview).toBe("unavailable");
		expect(result.results.every((row) => row.assessment === "uncertain")).toBe(true);
		expect(result.results.every((row) => row.assessment_reason === "model review unavailable")).toBe(true);
		expect(result.assessment_preview).toBe("unavailable");
	});

	it("does not spend AI when every sample is blocked, and skips only the category call without categories", async () => {
		const AI = aiQueue({ assessments: [{ index: 0, durable: true, confidence: "high", reason: "preference" }] });
		const blocked = await previewMemoryRules({ AI }, {
			samples: ["salary"],
			rules: { excludes: ["salary"] },
			projectCategories: [category],
		});
		expect(AI.run).not.toHaveBeenCalled();
		expect(blocked.category_preview).toBe("not_needed");
		expect(blocked.assessment_preview).toBe("not_needed");
		expect(blocked.results[0]).toMatchObject({
			kept: false,
			assessment: "not_evaluated_blocked",
			assessment_reason: null,
		});

		const empty = await previewMemoryRules({ AI }, {
			samples: ["allowed"],
			rules: {},
			projectCategories: [],
		});
		// No categories means no category call; the worthiness call still runs.
		expect(AI.run).toHaveBeenCalledTimes(1);
		expect(empty.category_preview).toBe("not_needed");
		expect(empty.assessment_preview).toBe("evaluated");
		expect(empty.results[0].project_category_reason).toBe("no_active_categories");
		expect(empty.results[0].assessment).toBe("durable");
	});

	it("reports chatter as not_durable and real facts as durable from one batched call", async () => {
		const AI = aiQueue(
			{ assignments: [] },
			{ assessments: [
				{ index: 0, durable: false, confidence: "high", reason: "closing thanks" },
				{ index: 1, durable: false, confidence: "high", reason: "chat filler" },
				{ index: 2, durable: true, confidence: "high", reason: "health fact" },
				{ index: 3, durable: true, confidence: "high", reason: "communication preference" },
			] },
		);
		const result = await previewMemoryRules({ AI }, {
			samples: [
				"Thanks, that's all for today",
				"lol",
				"I am allergic to penicillin",
				"I prefer email over calls",
			],
			rules: {},
			projectCategories: [category],
		});

		expect(result.assessment_preview).toBe("evaluated");
		expect(result.results.map((row) => [row.kept, row.assessment])).toEqual([
			[true, "not_durable"],
			[true, "not_durable"],
			[true, "durable"],
			[true, "durable"],
		]);
		expect(result.results[2].assessment_reason).toBe("health fact");
		// One category call plus one worthiness call for the whole batch.
		expect(AI.run).toHaveBeenCalledTimes(2);
	});

	it("keeps denied text out of both model payloads and marks it not_evaluated_blocked", async () => {
		const AI = aiQueue(
			{ assignments: [{ index: 1, category_slug: null }] },
			{ assessments: [{ index: 1, durable: true, confidence: "high", reason: "health fact" }] },
		);
		const result = await previewMemoryRules({ AI }, {
			samples: ["My salary is private", "I am allergic to penicillin"],
			rules: { excludes: ["salary"] },
			projectCategories: [category],
		});

		expect(result.results[0]).toMatchObject({
			kept: false,
			assessment: "not_evaluated_blocked",
			assessment_reason: null,
		});
		expect(result.results[1]).toMatchObject({ kept: true, assessment: "durable" });
		expect(AI.run).toHaveBeenCalledTimes(2);
		for (const call of AI.run.mock.calls) {
			expect(JSON.stringify(call[1])).not.toContain("salary");
		}
	});

	it("degrades to uncertain when only the worthiness call fails, leaving categories intact", async () => {
		const AI = aiQueue(
			{ assignments: [{ index: 0, category_slug: "work-projects" }] },
			new Error("model down"),
		);
		const result = await previewMemoryRules({ AI }, {
			samples: ["Northwind ships on Friday"],
			rules: {},
			projectCategories: [category],
		});

		expect(result.category_preview).toBe("evaluated");
		expect(result.results[0].project_category).toMatchObject({ slug: "work-projects" });
		expect(result.assessment_preview).toBe("unavailable");
		expect(result.results[0]).toMatchObject({
			kept: true,
			assessment: "uncertain",
			assessment_reason: "model review unavailable",
		});
	});

	it("maps low confidence to uncertain and fails closed on invented or invalid entries", async () => {
		const AI = aiQueue({ assessments: [
			{ index: 0, durable: true, confidence: "low", reason: "might matter" },
			{ index: 5, durable: true, confidence: "high", reason: "invented row" },
			{ index: 1, durable: "yes", confidence: "high", reason: "bad type" },
		] });
		const result = await previewMemoryRules({ AI }, {
			samples: ["Maybe I will learn guitar", "I moved to Lisbon"],
			rules: {},
			projectCategories: [],
		});

		expect(result.assessment_preview).toBe("evaluated");
		expect(result.results[0]).toMatchObject({
			assessment: "uncertain",
			assessment_reason: "might matter",
		});
		// The invented index is ignored and the invalid entry fails closed.
		expect(result.results[1]).toMatchObject({
			assessment: "uncertain",
			assessment_reason: "model review unavailable",
		});
	});

	it("instructs the model never to reproduce credential-like samples", async () => {
		const AI = aiQueue({ assessments: [{ index: 0, durable: false, confidence: "high", reason: "credential-like content" }] });
		const result = await previewMemoryRules({ AI }, {
			samples: ["sk-live-abc123 is my API key"],
			rules: {},
			projectCategories: [],
		});

		expect(result.results[0].assessment).toBe("not_durable");
		const [, input] = AI.run.mock.calls[0];
		expect(input.messages[0].content).toContain("credential, API key, or password");
		expect(input.messages[0].content).toContain('durable=false with reason "credential-like content"');
	});
});
