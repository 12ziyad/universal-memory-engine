import { describe, expect, it } from "vitest";

import {
	cleanManualEntityLabel,
	parseManualRelationshipCorrection,
} from "../src/pipeline/manual_language.js";

describe("manual correction language", () => {
	it.each([
		"Correction: My test project Blue Lantern uses Go, not Rust.",
		"Blue Lantern no longer uses Rust; it uses Go.",
		"Actually, Blue Lantern uses Go instead of Rust.",
		"Replace Rust with Go in Blue Lantern.",
	])("normalizes relationship correction syntax without negated identities: %s", (content) => {
		const correction = parseManualRelationshipCorrection(content);
		expect(correction).toMatchObject({
			subject: { label: "Blue Lantern" },
			old_target: { label: "Rust" },
			new_target: { label: "Go" },
			type: "uses",
			current_text: "Blue Lantern uses Go.",
			history_text: "Technology corrected from Rust to Go.",
		});
		expect(correction.old_target.label).not.toMatch(/^not\b/i);
	});

	it("preserves a canonical entity title while removing descriptive wrappers", () => {
		expect(cleanManualEntityLabel("Project Alpha")).toBe("Project Alpha");
		expect(cleanManualEntityLabel("My test project Blue Lantern")).toBe("Blue Lantern");
	});
});
