/**
 * Typography + rhythm contract for the signed-in app shell.
 *
 * These assert the *scale*, not the look: two weights (600 headings / 400 body,
 * 500 reserved for tab labels), three text levels, one mono face, and the step
 * rhythm on Get started. They exist because the last three visual passes each
 * re-introduced a fourth weight or a second hardcoded mono stack.
 */

import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";

describe("app type scale", () => {
	it("self-hosts JetBrains Mono and never reaches a font CDN", () => {
		expect(css).toContain('font-family: "JetBrains Mono"');
		expect(css).toContain('src: url("/assets/jetbrains-mono-latin.woff2") format("woff2")');
		expect(css).toContain('--font-mono: "JetBrains Mono"');
		// Preloaded so the first code block does not flash a fallback face.
		expect(html).toContain('rel="preload" as="font" type="font/woff2" href="/assets/jetbrains-mono-latin.woff2"');
		// The privacy promise on the landing page depends on this staying true.
		expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fontawesome/i);
	});

	it("keeps every code surface on the shared mono variable", () => {
		// A second hardcoded stack is how the two faces drifted apart before.
		const hardcoded = css.match(/font-family:\s*ui-monospace/g) ?? [];
		expect(hardcoded).toHaveLength(0);
	});

	it("defines the page / section / step / body / footnote steps", () => {
		expect(css).toContain("body.app-mode { font-size: 14px; line-height: 1.6; }");
		expect(css).toMatch(/\.page-title \{ font-size: 32px; font-weight: 600; letter-spacing: -\.02em;/);
		expect(css).toMatch(/\.page-sub \{ font-size: 14px; font-weight: 400; letter-spacing: 0;/);
		expect(css).toMatch(/\.step-title \{ font-size: 15px; font-weight: 600; letter-spacing: -\.01em; \}/);
		expect(css).toMatch(/font-size: 16px; font-weight: 600; letter-spacing: -\.01em; line-height: 1\.35;/);
		expect(css).toMatch(/body\.app-mode \.step-note[\s\S]{0,220}font-size: 12px; font-weight: 400;/);
		expect(css).toMatch(/font-family: var\(--font-mono\); font-size: 13px; font-weight: 400; letter-spacing: 0; line-height: 1\.5;/);
	});

	it("reserves weight 500 for tab labels only", () => {
		expect(css).toContain("body.app-mode .term-tab, body.app-mode .tab {\n\t\tfont-size: 13px; font-weight: 500; letter-spacing: .01em; }");
		expect(css).toContain("body.app-mode .tab.active { font-weight: 600; }");
	});

	it("gives the app shell three text levels", () => {
		expect(css).toMatch(/--text: #101828; --muted: #667085; --faint: #98a2b3;/);
	});

	it("caps text columns and tightens the Get started step rhythm", () => {
		expect(css).toMatch(/body\.app-mode \.step-desc[\s\S]{0,220}max-width: 720px;/);
		expect(css).toContain("padding: 12px 0; border-bottom: 1px solid var(--border); align-items: start; }");
		expect(css).not.toContain("padding: 36px 0; border-bottom");
	});

	it("uses the page title on the views that have one", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		for (const title of ["Welcome back", "Get started with", "API keys", "History"]) {
			expect(script).toContain(`class="page-title">${title}`);
		}
	});
});
