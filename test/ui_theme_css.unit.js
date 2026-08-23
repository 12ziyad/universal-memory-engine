import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
	fileURLToPath(new URL("../public/assets/app-editorial-v1.css", import.meta.url)),
	"utf8",
).replace(/\r\n/g, "\n");

describe("product editorial stylesheet", () => {
	it("ships independent light and dark palettes for app, auth, and legal doors", () => {
		expect(stylesheet).toContain("Itsuki product editorial theme v1");
		for (const scope of [
			"body.app-mode {",
			'html[data-theme="dark"] body.app-mode',
			"body.auth-mode {",
			'html[data-theme="dark"] body.auth-mode',
			"#legalView.legal-shell",
			'html[data-theme="dark"] #legalView.legal-shell',
		]) expect(stylesheet).toContain(scope);
		for (const token of ["--bg", "--panel", "--input-bg", "--border2", "--text", "--muted", "--accent", "--accent-hover", "--on-accent", "--focus-ring"]) {
			expect(stylesheet.match(new RegExp(`${token}:`, "g"))?.length ?? 0, token).toBeGreaterThanOrEqual(4);
		}
	});

	it("keeps native controls native and disabled CTAs still", () => {
		expect(stylesheet).toContain('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"])');
		expect(stylesheet).toContain(".btn.primary:hover:not(:disabled)");
		expect(stylesheet).toContain(".auth-actions button:hover:not(:disabled)");
		expect(stylesheet).toMatch(/button:disabled,[\s\S]{0,220}button:disabled:hover,[\s\S]{0,220}button:disabled:active[\s\S]{0,180}transform: none;/);
	});

	it("protects contrast, focus, motion, and dark-logo treatment", () => {
		expect(stylesheet).toContain(".tab-badge");
		expect(stylesheet).toContain("color: var(--on-accent)");
		expect(stylesheet).toContain("a.forgot-link");
		expect(stylesheet).toContain(":focus-visible");
		expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
		expect(stylesheet).toContain("transition: none !important");
		expect(stylesheet).toContain("transform: none !important");
		expect(stylesheet).toContain("/assets/brand/itsuki-bonsai-mark-inverse.svg?v=1");
	});
});
