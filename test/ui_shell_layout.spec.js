/**
 * Shared app-shell layout contract.
 *
 * Dashboard pages may choose their own internal grids, but the rail, content
 * canvas, section rhythm, and responsive gutters stay common. This prevents a
 * new page from silently returning to an edge-pinned, full-width layout.
 */

import { describe, expect, it } from "vitest";
import html from "../public/index.html?raw";

const css = (html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "").replace(/\r\n/g, "\n");

describe("enterprise app shell", () => {
	it("uses one rail and one bounded content canvas", () => {
		expect(css).toContain("--shell-rail: 240px;");
		expect(css).toContain("--content-max: 1180px;");
		expect(css).toContain("--content-wide: 1460px;");
		expect(css).toContain("--content-gutter: clamp(24px, 3vw, 52px);");
		expect(css).toContain("grid-template-columns: var(--shell-rail) minmax(0, 1fr) 0px;");
		expect(css).toMatch(/\.view:not\(\.pad0\) > \* \{[\s\S]{0,180}max-width: var\(--content-max\);[\s\S]{0,180}margin-left: auto;[\s\S]{0,100}margin-right: auto;/);
		expect(css).toContain(".view > .pg-shell { max-width: var(--content-wide); }");
	});

	it("uses a consistent page and card rhythm", () => {
		expect(css).toContain("body.app-mode .page-head { margin-bottom: 32px; }");
		expect(css).toMatch(/\.panel-grid \{[\s\S]{0,180}gap: 20px; margin-bottom: 32px;/);
		expect(css).toMatch(/\.action-box \{[\s\S]{0,180}border-radius: 14px; padding: 22px;/);
		expect(css).toMatch(/\.settings-grid \{[\s\S]{0,180}minmax\(280px, 1fr\)[\s\S]{0,100}gap: 20px;/);
	});

	it("keeps memory content and onboarding aligned to the same visual system", () => {
		expect(css).toContain("width: min(calc(100% - 48px), var(--content-max));");
		expect(css).toMatch(/\.setup-step-button\[aria-selected="true"\],[\s\S]{0,180}\.setup-step-button\[aria-current="step"\] \{[\s\S]{0,220}border-left-color: var\(--accent\);/);
		expect(css).toMatch(/\.setup-expanded-dialog \.setup-guide-section\.is-current::after \{[\s\S]{0,180}border-color: var\(--accent\);[\s\S]{0,180}color: var\(--accent\);/);
	});

	it("tightens gutters safely on tablet and phone", () => {
		expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.view \{ padding: 24px 18px 36px; \}/);
		expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*?\.view \{ padding: 18px 14px 28px; \}/);
	});
});
