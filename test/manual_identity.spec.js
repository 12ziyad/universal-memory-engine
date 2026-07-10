import { describe, expect, it } from "vitest";

import {
	canonicalIdentity,
	manualIdentitySimilarity,
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
