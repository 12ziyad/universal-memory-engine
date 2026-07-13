import { describe, expect, it } from "vitest";

import {
	MANUAL_IDENTITY_MARGIN_MIN,
	MANUAL_IDENTITY_MERGE_MIN,
	candidateMatchesManualNode,
	canonicalIdentity,
	manualIdentityEvidence,
	manualIdentitySimilarity,
	rankManualIdentityCandidates,
	resolveManualIdentity,
} from "../src/pipeline/manual_identity.js";

function node(id, label, aliases = [], category = "project") {
	return {
		id,
		label,
		canonical_label: canonicalIdentity(label),
		aliases_json: JSON.stringify(aliases),
		category,
	};
}

describe("manual identity resolution", () => {
	it("resolves an exact alias to the existing node", () => {
		const uml = node("node-uml", "Universal Memory Layer", ["UML"]);

		const result = resolveManualIdentity({ label: "UML", category: "project" }, [uml]);

		expect(result).toMatchObject({
			decision: "existing",
			label: "UML",
			node: { id: "node-uml" },
			matched_name: "UML",
		});
	});

	it("rejects a model hint that points at the wrong identity", () => {
		const alpha = node("node-alpha", "Project Alpha");
		const beta = node("node-beta", "Project Beta");

		const result = resolveManualIdentity(
			{ label: "Project Alpha", category: "project", existing_node_id: "node-beta" },
			[alpha, beta],
		);

		expect(result).toMatchObject({
			decision: "ambiguous",
			reason: "existing_node_hint_mismatch",
			matches: [{ id: "node-beta" }],
		});
	});

	it("fails closed when the same alias belongs to multiple nodes", () => {
		const first = node("node-first", "Universal Memory Layer", ["UML"]);
		const second = node("node-second", "Unified Modeling Language", ["UML"]);

		const result = resolveManualIdentity({ label: "UML" }, [first, second]);

		expect(result).toMatchObject({
			decision: "ambiguous",
			reason: "multiple_existing_nodes_match",
		});
		expect(result.matches.map((match) => match.id)).toEqual(["node-first", "node-second"]);
	});

	it("does not merge projects that only share a generic identity word", () => {
		const beta = node("node-beta", "Project Beta");

		expect(manualIdentitySimilarity("Project Alpha", "Project Beta")).toBe(0);
		expect(resolveManualIdentity({ label: "Project Alpha", category: "project" }, [beta])).toMatchObject({
			decision: "new",
			canonical_key: "project alpha",
		});
	});

	it("does not auto-merge distinct object types that share only a stripped core", () => {
		const service = node("node-atlas-service", "Atlas Service", [], "service");

		const result = resolveManualIdentity(
			{ label: "Atlas Database", category: "database" },
			[service],
		);

		expect(manualIdentitySimilarity("Atlas Database", "Atlas Service")).toBe(0.84);
		expect(result).toMatchObject({
			decision: "ambiguous",
			reason: "possible_existing_node_match",
			matches: [{ id: "node-atlas-service" }],
		});
	});

	it("does not resolve a candidate from a stale node-id hint without name evidence", () => {
		const atlas = node("node-atlas", "Atlas", [], "project");
		const candidate = {
			label: "Redis",
			label_guess: "Redis",
			canonical_key: "redis",
			possible_existing_node_id: atlas.id,
		};

		expect(candidateMatchesManualNode(candidate, atlas)).toBe(false);
	});

	it("converges safe Manchester United names without confusing Manchester entities", () => {
		const united = node("node-manchester-united", "Manchester United", [], "organization");
		const city = node("node-manchester-city", "Manchester City", [], "organization");
		const place = node("node-manchester-place", "Manchester", [], "place");
		const airport = node("node-manchester-airport", "Manchester Airport", [], "place");
		const university = node("node-manchester-university", "Manchester University", [], "organization");
		const pool = [university, airport, city, place, united];

		for (const label of ["Man United", "MUFC", "Manchester United FC"]) {
			const result = resolveManualIdentity({ label, category: "organization" }, pool);
			expect(result).toMatchObject({
				decision: "existing",
				node: { id: united.id },
			});
			expect(result.score).toBeGreaterThanOrEqual(MANUAL_IDENTITY_MERGE_MIN);
		}

		expect(manualIdentityEvidence("MUFC", university.label)).toMatchObject({ score: 0, kind: "none" });
		expect(manualIdentityEvidence("Man United", city.label).score).toBe(0);
	});

	it("keeps the Manchester place, airport, university, City, and United nodes distinct", () => {
		const nodes = [
			node("node-manchester-united", "Manchester United", [], "organization"),
			node("node-manchester-city", "Manchester City", [], "organization"),
			node("node-manchester-place", "Manchester", [], "place"),
			node("node-manchester-airport", "Manchester Airport", [], "place"),
			node("node-manchester-university", "Manchester University", [], "organization"),
		];

		for (const expected of nodes) {
			const result = resolveManualIdentity({ label: expected.label, category: expected.category }, [...nodes].reverse());
			expect(result).toMatchObject({ decision: "existing", node: { id: expected.id } });
		}
	});

	it("requires a 0.94 deterministic score and a clear 0.08 lead", () => {
		expect(MANUAL_IDENTITY_MERGE_MIN).toBe(0.94);
		expect(MANUAL_IDENTITY_MARGIN_MIN).toBe(0.08);
		expect(manualIdentityEvidence("Man United", "Manchester United")).toMatchObject({
			score: 0.95,
			kind: "token_abbreviation",
		});

		const clearWinner = resolveManualIdentity(
			{ label: "Man United", category: "organization" },
			[
				node("node-club", "Manchester United", [], "organization"),
				node("node-project", "Man United Project", [], "organization"),
			],
		);
		expect(clearWinner).toMatchObject({ decision: "existing", node: { id: "node-club" } });

		const tied = [
			node("node-manchester", "Manchester United", [], "organization"),
			node("node-manhattan", "Manhattan United", [], "organization"),
		];
		for (const ordered of [tied, [...tied].reverse()]) {
			const result = resolveManualIdentity({ label: "Man United", category: "organization" }, ordered);
			expect(result).toMatchObject({ decision: "ambiguous", reason: "multiple_existing_nodes_match" });
			expect(result.matches.map((match) => match.id)).toEqual(["node-manchester", "node-manhattan"]);
		}
	});

	it("keeps name evidence separate from hard category conflicts", () => {
		const manchester = node("node-manchester-place", "Manchester", [], "place");
		const ranked = rankManualIdentityCandidates(
			{ label: "Manchester", category: "organization" },
			[manchester],
		);

		expect(ranked[0]).toMatchObject({
			score: 0,
			nameScore: 1,
			category: { hard_conflict: true, reason_code: "place_category_conflict" },
		});
		expect(resolveManualIdentity(
			{ label: "Manchester", category: "organization" },
			[manchester],
		)).toMatchObject({
			decision: "ambiguous",
			reason: "identity_category_conflict",
		});
	});

	it("keeps C, C#, and C++ as three distinct identities", () => {
		const nodes = [
			node("node-c", "C", [], "skill"),
			node("node-csharp", "C#", [], "skill"),
			node("node-cpp", "C++", [], "skill"),
		];

		expect(nodes.map((entry) => canonicalIdentity(entry.label))).toEqual(["c", "csharp", "cpp"]);
		for (const entry of nodes) {
			const result = resolveManualIdentity({ label: entry.label, category: "skill" }, nodes);
			expect(result).toMatchObject({ decision: "existing", node: { id: entry.id } });
		}
		expect(manualIdentitySimilarity("C", "C#")).toBe(0);
		expect(manualIdentitySimilarity("C", "C++")).toBe(0);
		expect(manualIdentitySimilarity("C#", "C++")).toBe(0);
	});

	it("preserves a nonempty canonical identity for Unicode labels", () => {
		expect(canonicalIdentity("日本語")).toBe("日本語");
		expect(canonicalIdentity("Crème brûlée")).toBe("creme brulee");
		expect(canonicalIdentity("Проект Альфа")).not.toBe("");
	});
});
