import { describe, expect, it } from "vitest";

import { validateBody } from "../src/lib/params.js";

describe("recall scope request parsing", () => {
	it.each(["/v1/recall", "/v1/turn"])("accepts camelCase on %s", (path) => {
		const out = validateBody(path, { query: "project decisions", recallScope: "project_then_global" });

		expect(out).toEqual({
			body: { query: "project decisions", recallScope: "project_then_global" },
			renamed: [],
		});
	});

	it.each(["/v1/recall", "/v1/turn"])("canonicalises recall_scope on %s", (path) => {
		const out = validateBody(path, { query: "project decisions", recall_scope: "project_only" });

		expect(out).toEqual({
			body: { query: "project decisions", recallScope: "project_only" },
			renamed: ["recall_scope"],
		});
	});

	it("refuses ambiguous snake_case and camelCase values", () => {
		const out = validateBody("/v1/recall", {
			query: "project decisions",
			recallScope: "global",
			recall_scope: "project_only",
		});

		expect(out).toMatchObject({ error: "conflicting_parameters" });
	});

	it.each(["/v1/save", "/v1/ingest"])("does not widen the unrelated %s shape", (path) => {
		const out = validateBody(path, { recallScope: "global" });

		expect(out).toMatchObject({ error: "unknown_parameter" });
	});
});
