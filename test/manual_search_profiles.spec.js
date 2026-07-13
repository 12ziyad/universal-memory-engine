import { describe, expect, it } from "vitest";
import {
	buildManualNodeSearchProfile,
	buildManualPageSearchProfile,
} from "../src/pipeline/manual_search_profiles.js";

describe("manual search profiles", () => {
	it("builds one structured semantic profile for a node", async () => {
		const profile = await buildManualNodeSearchProfile({
			id: "node_1", user_id: "user_1", label: "Silver Comet", canonical_label: "silver comet",
			aliases_json: '["Comet"]', category: "project", role: "subject", state: "active",
			summary: "Silver Comet is a project.", updated_at: 10,
		}, {
			identityClaims: ["silver comet project"],
			slices: [{ text: "Silver Comet uses Rust.", is_current: 1, created_at: 11 }],
			relationships: [{ direction: "outgoing", type: "uses", other_label: "Rust", created_at: 12 }],
			communities: [{ label: "Cloud Systems" }],
		});
		expect(profile).toMatchObject({ object_kind: "node", object_id: "node_1", source_updated_at: 12 });
		expect(profile.identity_text).toContain("Comet");
		expect(profile.semantic_text).toContain("Silver Comet uses Rust");
		expect(profile.context_text).toContain("Cloud Systems");
		expect(profile.profile_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("keeps raw evidence out of a page semantic profile", async () => {
		const profile = await buildManualPageSearchProfile({
			id: "page_1", user_id: "user_1", title: "Silver Comet Architecture",
			canonical_title: "silver comet architecture", short_summary: "System architecture notes.",
			full_markdown: "# Silver Comet Architecture\n\n## Overview\nUses Workers.",
			evidence_json: '[{"snippet":"SECRET RAW TRANSCRIPT"}]', updated_at: 20,
		});
		expect(profile.semantic_text).toContain("Uses Workers");
		expect(profile.semantic_text).not.toContain("SECRET RAW TRANSCRIPT");
		expect(profile.object_kind).toBe("page");
	});
});
