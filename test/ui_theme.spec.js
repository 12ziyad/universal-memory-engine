import { describe, expect, it } from "vitest";
// A side-effect import makes a missing product theme fail module collection.
// The Workers pool stubs CSS exports, so direct stylesheet policy assertions
// live in ui_theme_css.unit.js under the Node-only test config.
import "../public/assets/app-editorial-v1.css";
import html from "../public/index.html?raw";
import themeBootstrap from "../public/assets/theme-bootstrap.js?raw";

const css = (html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "").replace(/\r\n/g, "\n");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const appScript = scripts.at(-1) ?? "";

describe("app appearance themes", () => {
	it("applies a validated preference before fonts and app CSS paint", () => {
		expect(themeBootstrap).toContain('const key = "itsuki_theme"');
		expect(themeBootstrap).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
		expect(themeBootstrap).toContain("document.documentElement.dataset.theme");
		expect(themeBootstrap).toContain("document.documentElement.dataset.themePreference");
		expect(html).toContain('<script src="/assets/theme-bootstrap.js"></script>');
		expect(html.indexOf('/assets/theme-bootstrap.js')).toBeLessThan(html.indexOf("<style>"));
		expect(() => new Function(themeBootstrap)).not.toThrow();
	});

	it("loads the product editorial layer after the landing theme", () => {
		const landingHref = "/assets/landing-editorial-v1.css?v=6";
		const productHref = "/assets/app-editorial-v1.css?v=4";
		expect(html).toContain(`<link rel="stylesheet" href="${productHref}" />`);
		expect(html.indexOf(productHref)).toBeGreaterThan(html.indexOf(landingHref));
	});

	it("keeps semantic light and dark scopes wired for app and auth", () => {
		expect(css).toContain("body.app-mode {");
		expect(css).toContain('html[data-theme="dark"] body.app-mode');
		expect(appScript).toContain('["login", "signup", "onboarding", "first-key"].includes(mode) ? "auth-mode" : "public-mode"');
		for (const variable of [
			"--bg", "--panel", "--panel2", "--panel3", "--border", "--border2",
			"--text", "--muted", "--faint", "--accent", "--on-accent", "--shadow-sm",
			"--danger-bg", "--warning-bg", "--success-bg",
		]) {
			expect(css.match(new RegExp(`${variable}:`, "g"))?.length ?? 0, variable).toBeGreaterThanOrEqual(2);
		}
		expect(css).toContain("color-scheme: light;");
		expect(css).toContain("color-scheme: dark;");
	});

	it("offers Light, Dark, and System controls and follows system changes", () => {
		for (const theme of ["light", "dark", "system"]) {
			expect(appScript).toContain(`data-theme-option="${theme}"`);
			expect(appScript).toContain(`setTheme("${theme}")`);
		}
		expect(appScript).toContain('const THEME_STORAGE_KEY = "itsuki_theme"');
		expect(appScript).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
		expect(appScript).toContain('addEventListener("change"');
		expect(appScript).toContain("function applyTheme(");
		expect(appScript).toContain("function cycleTheme()");
		expect(html).toContain('id="themeQuick"');
		expect(appScript).toContain("Appearance");
	});

	it("keeps motion optional, keyboard focus visible, and primary control contracts stable", () => {
		expect(css).toContain(":focus-visible");
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		for (const productControl of ["mw-btn-primary", "btn primary", "install-btn", "auth-actions", "google-btn"]) {
			expect(html).toContain(productControl);
		}
	});
});
