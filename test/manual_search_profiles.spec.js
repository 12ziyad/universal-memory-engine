import { describe, expect, it } from "vitest";
import {
	buildManualNodeSearchProfile,
	buildManualPageSearchProfile,
	manualSearchProfileReservationId,
} from "../src/pipeline/manual_search_profiles.js";
import {
	memoryProjectionOperationScopeId,
	memoryVectorReservationId,
} from "../src/lib/memory_versions.js";

describe("manual search profiles", () => {
	it("uses revision-scoped stable identities for durable profile and vector projections", async () => {
		const searchScope = memoryProjectionOperationScopeId("user_1", "slice", "slice_1", 3, "search");
		const profile = {
			operationScopeId: searchScope,
			userId: "user_1",
			objectKind: "node",
			objectId: "node_1",
		};
		const first = await manualSearchProfileReservationId(profile);
		expect(first).toMatch(/^airesv_[0-9a-f]{64}$/);
		expect(await manualSearchProfileReservationId(profile)).toBe(first);
		expect(await manualSearchProfileReservationId({ ...profile, objectId: "node_2" })).not.toBe(first);
		const laterScope = memoryProjectionOperationScopeId("user_1", "slice", "slice_1", 4, "search");
		expect(await manualSearchProfileReservationId({ ...profile, operationScopeId: laterScope })).not.toBe(first);

		const vector = await memoryVectorReservationId("user_1", "node", "node_1", 3);
		expect(await memoryVectorReservationId("user_1", "node", "node_1", 3)).toBe(vector);
		expect(await memoryVectorReservationId("user_1", "node", "node_1", 4)).not.toBe(vector);
		expect(await memoryVectorReservationId("user_1", "node", "node_2", 3)).not.toBe(vector);
	});

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
