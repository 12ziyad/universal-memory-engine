import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

describe("dashboard script", () => {
	it("parses and exposes graph modes/actions", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain('graphMode: "clean"');
		expect(script).toContain("function initShell()");
		expect(script).toContain("function initReveal()");
		expect(script).toContain("function renderAuth(");
		expect(script).toContain("function visibleGraphData()");
		expect(script).toContain("function computeClusterHulls(");
		expect(script).toContain("function drawClusterHulls(");
		expect(script).toContain("function separateClusterHulls(");
		expect(script).toContain("function startHullPulse(");
		expect(script).toContain("prefers-reduced-motion");
		expect(script).toContain('S.network.on("beforeDrawing"');
		expect(script).toContain('S.network.on("afterDrawing"');
		expect(script).toContain("dragNodes: false");
		expect(script).toContain("/v1/actions/repair-graph");
		expect(script).toContain("/v1/actions/clean-junk");
		expect(() => new Function(script)).not.toThrow();
	});

	it("uses procedural graph hulls instead of fixed DOM cluster rectangles", () => {
		expect(html).not.toContain("cluster-layer");
		expect(html).not.toContain("cluster-region");
		expect(html).not.toContain("renderClusterLayer");
		expect(html).toContain("clusterHullAnchors");
	});

	it("renders the public UML product shell and auth entry points", () => {
		expect(html.match(/<section class="landing-section/g) || []).toHaveLength(5);
		expect(html.match(/<h1>One memory for every AI you use\.<\/h1>/g) || []).toHaveLength(1);
		expect(html).toContain("Your AI context is scattered.");
		expect(html).toContain("UML is the shared memory layer between your AI tools.");
		expect(html).toContain("Connect UML in minutes.");
		expect(html).toContain("Start building with a memory layer that follows you.");
		expect(html).toContain("founder@gpmai.dev");
		expect(html).toContain("ejziyad@gmail.com");
		expect(html).toContain("/assets/uml-logo.svg");
		const withoutContactEmail = html.replace(/mailto:founder@gpmai\.dev|founder@gpmai\.dev/g, "");
		expect(withoutContactEmail).not.toMatch(/gpmai/i);
	});

	it("keeps sidebar sorting and evidence display deterministic", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function latestStamp(");
		expect(script).toContain("compareLatestThenName");
		expect(script).toContain("function uniqueEvidence(");
		expect(script).toContain("duplicate/extra evidence item(s) hidden");
	});

	it("has one normal dashboard nav with required tabs and hidden dev credentials", () => {
		for (const view of ["home", "graph", "memories", "save", "recall", "connect", "help", "profile", "settings"]) {
			expect(html.match(new RegExp(`data-view="${view}"`, "g")) || []).toHaveLength(1);
		}
		expect(html).toContain('id="userId" class="dev-only"');
		expect(html).toContain('id="key" class="dev-only"');
		expect(html).toContain('id="copyMcp"');
	});

	it("includes a settings danger zone with exact confirmation gating", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('data-view="settings"');
		expect(script).toContain("function viewReset(");
		expect(script).toContain("function viewSettings(");
		expect(script).toContain("function resetSelectedUserMemory(");
		expect(script).toContain("/v1/actions/delete-all");
		expect(script).toContain("DELETE ALL");
		expect(html).toContain('id="resetBtn" class="danger" disabled');
	});
});
