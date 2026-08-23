/* Dark-theme neutrality contract (unit lane — reads the CSS from disk like
 * ui_theme_css.unit.js). The campaign replaced the warm brown-black dark ramp
 * with achromatic surfaces; orange survives only as the accent family. These
 * pins make a regression to the warm wash a named failure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const productCss = readFileSync(fileURLToPath(new URL("../public/assets/app-editorial-v1.css", import.meta.url)), "utf8");
const landingCss = readFileSync(fileURLToPath(new URL("../public/assets/landing-editorial-v1.css", import.meta.url)), "utf8");

describe("neutral dark theme tokens", () => {
	const start = productCss.indexOf('html[data-theme="dark"] body.app-mode');
	const dark = productCss.slice(start, productCss.indexOf("color-scheme: dark;", start));

	it("uses achromatic dark surfaces", () => {
		for (const neutral of ["#0f0f10", "#161617", "#1e1e20", "#2c2c30", "#f4f4f2", "#b3b3b6"]) {
			expect(dark, `dark ramp keeps ${neutral}`).toContain(neutral);
		}
	});

	it("keeps orange as accent only, with an ink letterpress slab", () => {
		expect(dark).toContain("--accent: #e38362");
		expect(dark).toContain("--editorial-press-shadow: #000000");
	});

	it("never reverts to the warm brown-black ramp", () => {
		for (const warm of ["#11100d", "#181612", "#211e19", "#c8bca8"]) {
			expect(dark, `warm ${warm} stays out`).not.toContain(warm);
		}
	});

	it("keeps dark selection washes neutral and dark nav on a neutral active surface", () => {
		expect(productCss).toContain("--mw-selbg: rgba(244, 244, 242, .055)");
		expect(productCss).toMatch(/html\[data-theme="dark"\] body\.app-mode \.tab\.active/);
	});

	it("keeps the legal overlay's dark palette in step", () => {
		const legal = productCss.slice(productCss.indexOf('html[data-theme="dark"] #legalView.legal-shell'));
		expect(legal).toContain("--bg: #0f0f10");
		expect(legal).not.toContain("#11100d");
	});
});

describe("landing editorial sheet", () => {
	it("ships the enterprise footer styles", () => {
		for (const cls of [".footer-grid", ".footer-trust", ".footer-col", ".footer-base", ".closing-support"]) {
			expect(landingCss).toContain(cls);
		}
	});
});
