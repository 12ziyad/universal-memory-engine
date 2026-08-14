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

		expect(AI.run).toHaveBeenCalledTimes(1);
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
	});

	it("does not spend AI when every sample is blocked or no categories are active", async () => {
		const AI = aiReturning({ assignments: [] });
		const blocked = await previewMemoryRules({ AI }, {
			samples: ["salary"],
			rules: { excludes: ["salary"] },
			projectCategories: [category],
		});
		const empty = await previewMemoryRules({ AI }, {
			samples: ["allowed"],
			rules: {},
			projectCategories: [],
		});
		expect(AI.run).not.toHaveBeenCalled();
		expect(blocked.category_preview).toBe("not_needed");
		expect(empty.results[0].project_category_reason).toBe("no_active_categories");
	});
});
