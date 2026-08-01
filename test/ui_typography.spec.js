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
	it("self-hosts Geist and Geist Mono and never reaches a font CDN", () => {
		for (const file of ["geist-400.woff2", "geist-600.woff2", "geist-mono-400.woff2"]) {
			expect(css).toContain(`src: url("/assets/${file}") format("woff2")`);
		}
		expect(css).toContain('--font-ui: "Geist", "Inter"');
		expect(css).toContain('--font-mono: "Geist Mono", "JetBrains Mono"');
		// Geist 400 is preloaded; body text is the first thing anyone reads.
		expect(html).toContain('rel="preload" as="font" type="font/woff2" href="/assets/geist-400.woff2"');
		// The privacy promise on the landing page depends on this staying true.
		// No third-party loads of any kind — fonts OR scripts. A CDN request
		// sends every visitor's IP off-origin, which the landing page promises
		// does not happen.
		expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|fontawesome|cdn\.jsdelivr|unpkg\.com/i);
		expect(html).not.toMatch(/<script[^>]+src="https?:\/\//i);
	});

	it("ships two static Geist weights, not the variable font", () => {
		const geistFaces = css.match(/font-family: "Geist";[\s\S]*?\}/g) ?? [];
		expect(geistFaces).toHaveLength(2);
		expect(geistFaces.filter((f) => /font-weight: 400;/.test(f))).toHaveLength(1);
		expect(geistFaces.filter((f) => /font-weight: 600;/.test(f))).toHaveLength(1);
		// A range like `font-weight: 100 900` would mean the variable file.
		expect(css).not.toMatch(/font-family: "Geist";[\s\S]{0,160}font-weight: \d+ \d+/);
		// Two real weights, so nothing should ever be faux-bolded into a third.
		expect(css).toContain("font-synthesis-weight: none;");
	});

	it("keeps Inter and JetBrains Mono declared as the fallback faces", () => {
		expect(css).toContain('src: url("/assets/inter-latin.woff2") format("woff2")');
		expect(css).toContain('src: url("/assets/jetbrains-mono-latin.woff2") format("woff2")');
	});

	it("scopes the fallback faces so they are not downloaded speculatively", () => {
		// A fallback that downloads on every load is not a fallback, it is a
		// second font. One rail glyph Geist lacks was pulling 63 KB of Inter.
		const fallbackFaces = css.match(/font-family: "(?:Inter|JetBrains Mono)";[\s\S]*?\}/g) ?? [];
		expect(fallbackFaces).toHaveLength(2);
		for (const face of fallbackFaces) expect(face).toMatch(/unicode-range: U\+0000-00FF/);
		// Geist itself must stay unscoped — it is the primary face.
		const geistFaces = css.match(/font-family: "Geist(?: Mono)?";[\s\S]*?\}/g) ?? [];
		for (const face of geistFaces) expect(face).not.toMatch(/unicode-range/);
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

	it("caps text columns at 720px", () => {
		expect(css).toMatch(/body\.app-mode \.step-desc[\s\S]{0,220}max-width: 720px;/);
		expect(css).toMatch(/\.page-sub \{[\s\S]{0,160}max-width: 720px;/);
	});

	it("uses the page title on the views that have one", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		for (const title of ["Welcome back", "Get started with", "API keys", "History"]) {
			expect(script).toContain(`class="page-title">${title}`);
		}
	});
});
