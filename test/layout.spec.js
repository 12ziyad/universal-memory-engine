import { describe, it, expect } from "vitest";
import { buildGraphLayout, clusterClearance, filterGraphForMode, itemClearance } from "../src/pipeline/layout.js";

const nodes = [
	{ id: "n-uml", label: "UML", category: "project", cluster: "projects_systems", slices: [{ text: "uses D1" }], events: [] },
	{ id: "n-d1", label: "D1", category: "tool", cluster: "skills_tech", slices: [], events: [] },
	{ id: "n-graph", label: "Graph UX", category: "system", cluster: "projects_systems", slices: [], events: [{ text: "improved" }] },
];
const pages = [
	{
		id: "p-run",
		title: "UML Run 3.2 Memory Pages and Graph UX",
		topic_filter: "uml",
		short_summary: "Graph UX and memory pages.",
		cluster: "projects_systems",
		heat_score: 3,
		key_points_json: JSON.stringify(["Memory pages", "Graph UX"]),
		decisions_json: JSON.stringify(["Use backend layout"]),
	},
];
const candidates = [
	{ id: "c-vague", label: "Possible Graph Repair", cluster_hint: "projects_systems", mentions: 1 },
];

function normalizedDistance(item, cluster) {
	const dx = (item.x - cluster.x) / cluster.radius_x;
	const dy = (item.y - cluster.y) / cluster.radius_y;
	return Math.sqrt(dx * dx + dy * dy);
}

describe("deterministic graph layout", () => {
	it("returns stable positions and visual metadata", () => {
		const a = buildGraphLayout(nodes, pages, candidates);
		const b = buildGraphLayout(nodes, pages, candidates);
		expect(a).toEqual(b);
		expect(a.pages[0]).toMatchObject({
			visual_type: "page",
			cluster_id: "projects_systems",
			cluster_name: "Projects & Systems",
		});
		expect(typeof a.pages[0].x).toBe("number");
		expect(typeof a.pages[0].y).toBe("number");
		expect(a.pages[0].radius).toBeGreaterThan(a.nodes[0].radius);
	});

	it("keeps nodes/pages/candidates inside their cluster regions and labels outside center", () => {
		const layout = buildGraphLayout(nodes, pages, candidates);
		for (const item of [...layout.nodes, ...layout.pages, ...layout.candidates]) {
			const cluster = layout.clusters.find((c) => c.id === item.cluster);
			expect(cluster).toBeTruthy();
			expect(normalizedDistance(item, cluster)).toBeLessThanOrEqual(1);
		}
		for (const cluster of layout.clusters) {
			expect(cluster.label_y).toBeLessThan(cluster.y - cluster.radius_y / 2);
		}
	});

	it("keeps cluster regions and same-cluster items visually separated", () => {
		const manyNodes = Array.from({ length: 9 }, (_, i) => ({
			id: `n-${i}`,
			label: `UML Graph Topic ${i}`,
			category: "project",
			cluster: i < 5 ? "projects_systems" : "skills_tech",
			slices: [],
			events: [],
		}));
		const manyPages = [
			{ ...pages[0], id: "p-a", title: "UML Graph Layout and Reset UX", cluster: "projects_systems" },
			{ ...pages[0], id: "p-b", title: "Cloudflare D1 Vectorize Notes", cluster: "skills_tech" },
		];
		const layout = buildGraphLayout(manyNodes, manyPages, []);
		for (let i = 0; i < layout.clusters.length; i++) {
			for (let j = i + 1; j < layout.clusters.length; j++) {
				expect(clusterClearance(layout.clusters[i], layout.clusters[j])).toBeGreaterThanOrEqual(120);
			}
		}
		for (const cluster of layout.clusters) {
			const items = [...layout.nodes, ...layout.pages].filter((item) => item.cluster === cluster.id);
			for (let i = 0; i < items.length; i++) {
				for (let j = i + 1; j < items.length; j++) {
					expect(itemClearance(items[i], items[j])).toBeGreaterThanOrEqual(18);
				}
			}
		}
	});
});

describe("graph mode filtering", () => {
	const data = buildGraphLayout(nodes, pages, candidates);

	it("clean hides candidates, all/debug include them, focus limits to a cluster", () => {
		expect(filterGraphForMode(data, "clean").candidates).toHaveLength(0);
		expect(filterGraphForMode(data, "all").candidates).toHaveLength(1);
		expect(filterGraphForMode(data, "debug").candidates).toHaveLength(1);
		const focus = filterGraphForMode(data, "focus", { cluster: "skills_tech" });
		expect(focus.nodes.map((n) => n.id)).toEqual(["n-d1"]);
		expect(focus.pages).toHaveLength(0);
		expect(focus.candidates).toHaveLength(0);
	});
});
