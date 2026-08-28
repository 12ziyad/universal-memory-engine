/* Trust & Safety UI pins (Phase 2). The SPA is one HTML file with no build
 * step, so these pins hold the operator tab, the report modal, and the
 * step-up flow in place the same way the legal pins hold the documents.
 */
import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

describe("the operator tab", () => {
	it("exists in ADMIN_TABS and renders through its own branch", () => {
		expect(html).toContain('["trust", "Trust & Safety", "Cases with due clocks, and security events"]');
		expect(html).toContain('if (tab === "trust")');
		expect(html).toContain("function adminTrustView()");
		expect(html).toContain('fetch("/v1/admin/trust/overview"');
	});

	it("carries the full due-clock ladder: plain, warn, urgent, OVERDUE", () => {
		expect(html).toContain("function trustDueChip(");
		expect(html).toContain(">OVERDUE</span>");
		expect(html).toContain('mw-chip mw-chip-err">due in ${hours}h');
		expect(html).toContain('mw-chip-warn" : ""}">due in ${days}d');
	});

	it("collapses low-severity events behind a toggle", () => {
		expect(html).toContain("adminTrustToggleLow");
		expect(html).toContain('S.adminTrustShowLow ? "Hide" : "Show"');
	});
});

describe("the report modal", () => {
	it("replaces the mailto sheet for signed-in users and keeps founder@ as the signed-out fallback", () => {
		expect(html).toContain("function openTrustReportModal()");
		expect(html).toContain('if (!S.me?.user) { openPolicyModal("support"); return; }');
		expect(html).toContain('onclick="openTrustReportModal()">Support / report issue</button>');
		expect(html).toContain('fetch("/v1/trust/report"');
		// The signed-out sheet and the landing footer keep the email path.
		expect(html).toContain('mailto:founder@itsuki.app">founder@itsuki.app');
	});

	it("hosts its backdrop and closes on Escape like every other modal", () => {
		expect(html).toContain('<div id="trustReportModal" class="modal-backdrop" hidden></div>');
		expect(html).toContain('if (modal?.id === "trustReportModal") { event.preventDefault(); closeTrustReportModal(); return; }');
	});

	it("states the 7-day promise where the reporter files", () => {
		expect(html).toContain("Privacy requests and security reports get a response within 7 days.");
	});
});

describe("the step-up flow", () => {
	it("routes the destructive three through the typed confirmation, not confirm()", () => {
		expect(html).toContain('if (["delete", "promote", "demote"].includes(action)) {');
		expect(html).toContain("return openAdminConfirmModal(userId, action);");
		expect(html).toContain('fetch("/v1/admin/users/confirm"');
		expect(html).toContain("confirmation_token: token");
		// The old one-click browser confirms for these actions are gone.
		expect(html).not.toContain("PERMANENTLY delete this account and ALL of its memory");
		expect(html).not.toContain("Give this account full admin access?");
	});

	it("hosts its backdrop and closes on Escape", () => {
		expect(html).toContain('<div id="stepUpModal" class="modal-backdrop" hidden></div>');
		expect(html).toContain('if (modal?.id === "stepUpModal") { event.preventDefault(); closeStepUpModal(); return; }');
	});

	it("guards the destructive submit against double-fire", () => {
		expect(html).toContain("let stepUpBusy = false;");
		expect(html).toContain("if (stepUpBusy) return;");
	});
});

describe("failure states", () => {
	it("a failed overview load offers a retry instead of an eternal Loading…", () => {
		expect(html).toContain("S.adminTrustError = true;");
		expect(html).toContain('onclick="refreshAdminTrust()">Retry</button>');
	});
});
