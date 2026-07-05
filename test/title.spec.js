import { describe, it, expect } from "vitest";
import { clusterForMemory } from "../src/pipeline/clusters.js";
import { generateTitle, isBadTitle } from "../src/pipeline/title.js";

describe("title dominance", () => {
	it("keeps UML graph work dominant over car/bike examples", () => {
		const text = `
			UML Run 3.2 added manual_collect memory pages.
			UML Run 3.3 improved graph UX, cluster labels, Cloudflare credits, D1, Vectorize, and MCP dashboard behavior.
			The next patch should repair graph layout and memory page title quality.
			Use car and bike as examples only, e.g. skip car/bike example topics and do not title this as vehicle research.
		`;
		const title = generateTitle(text, { topic: "car and bike examples" });
		expect(title).toMatch(/^UML Run 3\.2\/3\.3 Memory Pages and Graph UX$/);
		expect(title).not.toBe("Car Research");
	});

	it("flags vague request and assistant/chat phrase titles as bad", () => {
		expect(isBadTitle("want to see a detailed and interactive prototype")).toBe(true);
		expect(isBadTitle("Impressive/world-facing prototype request")).toBe(true);
		expect(isBadTitle("assistant said the user asked for this chat")).toBe(true);
	});

	it("uses dominant career, product, graph, and health topics for page titles", () => {
		expect(generateTitle("Microsoft Recruiting acknowledged the SWE application. Resume review says projects are strong but DSA interview prep is a risk in Bangalore.")).toBe(
			"Microsoft SWE Application and Resume Review",
		);
		expect(generateTitle("GPMai memory graph cluster rules need dynamic semantic clusters and hull spacing.")).toBe(
			"GPMai Memory Graph Cluster Rules",
		);
		expect(generateTitle("UML graph layout needs procedural cluster hulls plus Reset UX and DELETE ALL danger-zone confirmation.")).toBe(
			"UML Graph Layout and Reset UX",
		);
		expect(generateTitle("Boxing shoulder pain needs a return plan before training hard again.")).toBe(
			"Boxing Shoulder Pain and Return Plan",
		);
		expect(generateTitle("The product landing page and login plan need publishing and signup flows.")).toBe(
			"Product Landing Page and Login Plan",
		);
	});

	it("selects controlled dynamic semantic clusters for career, business, and health domains", () => {
		expect(clusterForMemory({ title: "Microsoft SWE Application", text: "resume recruiting DSA interview Bangalore" })).toBe(
			"career_applications",
		);
		expect(clusterForMemory({ title: "Product Landing Page and Login Plan", text: "business app publishing signup" })).toBe(
			"business_product",
		);
		expect(clusterForMemory({ title: "Boxing Shoulder Pain", text: "injury recovery return plan" })).toBe("health_fitness");
		expect(clusterForMemory({ title: "GTA 6 / PS5 Research", text: "console purchase research" })).toBe("preferences_research");
	});
});
