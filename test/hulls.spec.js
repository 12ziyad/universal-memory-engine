import { describe, it, expect } from "vitest";
import { clusterHullAnchors, computeClusterHulls, itemInsideHull } from "../src/pipeline/hulls.js";

const clusters = [
	{ id: "projects_systems", label: "Projects & Systems", color: "#bc8cff" },
	{ id: "skills_tech", label: "Skills & Tech", color: "#a371f7" },
	{ id: "empty_cluster", label: "Empty", color: "#8b949e" },
];

function item(id, cluster, x, y, radius = 18) {
	return { id, cluster, x, y, radius };
}

describe("procedural cluster hulls", () => {
	it("hides empty clusters", () => {
		expect(computeClusterHulls([], clusters)).toEqual([]);
		const hulls = computeClusterHulls([item("n1", "projects_systems", 0, 0)], clusters);
		expect(hulls.map((h) => h.id)).toEqual(["projects_systems"]);
	});

	it("creates a minimum island around a single visible item with the label above it", () => {
		const visible = [item("n1", "projects_systems", 42, -20, 22)];
		const [hull] = computeClusterHulls(visible, clusters);
		expect(hull.radiusX).toBeGreaterThanOrEqual(112);
		expect(hull.radiusY).toBeGreaterThanOrEqual(78);
		expect(hull.labelY).toBeLessThan(hull.bounds.top);
		expect(itemInsideHull(visible[0], hull)).toBe(true);
	});

	it("expands from actual visible positions for small groups", () => {
		const visible = [
			item("n1", "projects_systems", -180, 0, 18),
			item("n2", "projects_systems", 170, 16, 18),
			item("p1", "projects_systems", 20, 92, 52),
		];
		const [hull] = computeClusterHulls(visible, clusters);
		expect(hull.radiusX).toBeGreaterThan(210);
		expect(hull.radiusY).toBeGreaterThan(110);
		for (const node of visible) expect(itemInsideHull(node, hull)).toBe(true);
	});

	it("grows with spread for larger clusters instead of using fixed rectangles", () => {
		const tight = Array.from({ length: 6 }, (_, i) => item(`t${i}`, "skills_tech", i * 18, i % 2 ? 14 : -14));
		const wide = Array.from({ length: 6 }, (_, i) => item(`w${i}`, "skills_tech", i * 180, i % 2 ? 120 : -120));
		const [tightHull] = computeClusterHulls(tight, clusters);
		const [wideHull] = computeClusterHulls(wide, clusters);
		expect(wideHull.radiusX).toBeGreaterThan(tightHull.radiusX * 2);
		expect(wideHull.radiusY).toBeGreaterThan(tightHull.radiusY);
		for (const node of wide) expect(itemInsideHull(node, wideHull)).toBe(true);
	});

	it("moves with node coordinates and exposes fit anchors", () => {
		const [near] = computeClusterHulls([item("n1", "projects_systems", 0, 0)], clusters);
		const [far] = computeClusterHulls([item("n1", "projects_systems", 640, -360)], clusters);
		expect(far.x - near.x).toBe(640);
		expect(far.y - near.y).toBe(-360);
		const anchors = clusterHullAnchors([far]);
		expect(anchors).toHaveLength(5);
		expect(anchors.map((anchor) => anchor.id)).toContain("hull:projects_systems:label");
	});
});
