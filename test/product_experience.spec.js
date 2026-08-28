/* Product-experience campaign contract.
 *
 * Source-level assertions over public/index.html and the editorial CSS,
 * pinning the surfaces this campaign shipped: the landing hero and enterprise
 * footer, the neutral dark theme, the header profile menu, the settings
 * technical-details layout, conditional audit filters, the truthful rules
 * preview wording, bounded auth fetches, first-key naming, self-service
 * leave, and stale-scope revalidation. Each block names the behavior it
 * protects so a future edit fails with a readable reason.
 */
import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

function fnSource(name) {
	const start = html.indexOf(`function ${name}(`);
	expect(start, `function ${name} exists`).toBeGreaterThan(-1);
	const next = html.indexOf("\nfunction ", start + 1);
	const asyncNext = html.indexOf("\nasync function ", start + 1);
	const end = Math.min(...[next, asyncNext].filter((i) => i > -1));
	return html.slice(start, end === Infinity ? start + 8000 : end);
}

describe("landing hero and narrative", () => {
	it("leads with the researched cross-tool headline and a mechanism subhead", () => {
		// Landing rebuild 2026-08-28: the hero came out of a judged research
		// pass. The H1 is the one claim no competitor can sign — user-side,
		// cross-TOOL memory, with real tools named (Mem0/Zep/Letta/Supermemory
		// all speak in category nouns; none names a tool a human recognizes).
		expect(html).toContain("<h1>The memory layer<br /><em>that sits under<br />your AI tools.</em></h1>");
		// The sub carries mechanism + believability, not a restatement: what it
		// is (open-source memory service, 26 tools), how it works (extraction,
		// source-linked), and the verifiable properties.
		expect(html).toContain("links each to the words it came from");
		expect(html).toContain("any of 26 connected tools — assistants, agents, workflows");
		// The CTA continues the H1's promise (value over action), and the
		// proof line beneath it is the objection-killing microcopy.
		expect(html).toContain("Connect your tools <span aria-hidden=\"true\">→</span>");
		expect(html).toContain("Open source · One key, two minutes · Free during early access");
		// Breadth requirement survives in the use-case folio: never agents-only.
		expect(html).toContain('aria-label="Itsuki use cases"');
		expect(html).toContain("01 / Applications");
		expect(html).toContain("04 / Workflows");
	});

	it("keeps the closing section a full CTA: sentence, support line, primary and docs actions", () => {
		expect(html).toContain('class="closing-support"');
		expect(html).toContain("Connect a tool, save one conversation, and recall it in the next one.");
		// Voluntary quota disclosure at the moment of action: reads as
		// confidence, kills the what's-the-catch objection.
		expect(html).toContain("about 100 saves a day");
		const closing = html.slice(html.indexOf('class="closing-section'), html.indexOf("</footer>"));
		expect(closing).toContain("Connect your tools");
		expect(closing).toContain('href="/docs/"');
	});
});

describe("hero stays uncluttered", () => {
	// The hero now ends at the chapter rule, not at a section that no longer
	// exists — indexOf returned -1 and this slice silently ran to the end of
	// the page, so every "the hero does not contain X" assertion was passing
	// against the whole document.
	const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('<div class="chapter-rule"'));

	it("carries only the eyebrow, headline, deck, and two actions", () => {
		expect(hero).toContain("that sits under");
		// The banner used to run down the right of the hero and was pinned here
		// as owner-protected. The owner removed it so the console could have the
		// fold; the mark moved to the chapter rule and the footer instead. The
		// guard now lives at page scope — see "the mark keeps a home" below.
		expect(hero).not.toContain("イツキ");
		expect(hero).toContain('class="hero-actions"');
		const headline = hero.slice(hero.indexOf("<h1>"), hero.indexOf("</h1>"));
		for (const tool of ["Claude", "Cursor", "ChatGPT", "MCP", "Codex"]) {
			expect(headline, `headline stays tool-agnostic: ${tool}`).not.toContain(tool);
		}
		// Furniture that used to crowd this panel must stay out.
		for (const clutter of ["fact-row", "flow-rail", "flow-status", "system-inputs", "surface-band"]) {
			expect(hero, `hero stays free of ${clutter}`).not.toContain(clutter);
		}
	});

	it("gives the fold to the console, not to a band", () => {
		expect(hero).not.toContain('class="hero-mono"');
		// What replaced it: a console that shows the product answering rather
		// than a config file waiting to be pasted.
		expect(hero).toContain('id="landingCodeGutter"');
		expect(hero).toContain('class="code-result"');
		expect(hero).toContain("recalled in Cursor");
	});

	it("the mark keeps a home: centred on the seam, and signing the footer", () => {
		// Two placements, both outside the hero. If either disappears the brand
		// name is gone from the page entirely, which is what this pins.
		expect(html).toContain('class="chapter-rule-mark" lang="ja">イツキ<');
		expect(html).toContain('class="footer-japanese-mark" lang="ja">イツキ<');
		// The rule sits between the hero and section 2 — that seam is the whole
		// reason it works, so the order is part of the contract.
		const rule = html.indexOf('class="chapter-rule"');
		expect(rule).toBeGreaterThan(html.indexOf('<section class="hero"'));
		expect(rule).toBeLessThan(html.indexOf('<section class="handoff-section'));
	});
});

describe("section 2 is the handoff, not a second quickstart", () => {
	const dev = html.slice(html.indexOf('<section class="handoff-section'), html.indexOf('<section class="contrast-section'));

	it("shows one memory reaching the whole surface, grouped as it really is", () => {
		// The connect card moved into the hero, which emptied this slot. A live
		// audit of twelve dev-tool homepages said the job here is to turn the
		// hero's claim into evidence carried by one visual — and the two usual
		// devices for that, a logo wall and testimonials, do not exist here.
		expect(dev).toContain('class="handoff-card"');
		expect(dev).toContain("An example memory");
		for (const group of ["SDKs &amp; API", "AI assistants", "Coding agents", "Agent harnesses", "Agent frameworks", "Workflow automation"]) {
			expect(dev, `names the ${group} group`).toContain(group);
		}
		// The quickstart's furniture must not have survived the replacement.
		expect(dev).not.toContain('class="surface-stats"');
		expect(dev).not.toContain('class="code-window"');
		expect(dev).not.toContain('class="surface-list"');
	});

	it("draws every one of the 26 real integration marks", () => {
		// get_started.spec.js pins exactly 26 products; this wall is the only
		// honest substitute for the customer logos the page cannot show, so a
		// missing mark is a silently shrunken claim.
		const tiles = dev.match(/class="handoff-tile"/g) ?? [];
		expect(tiles.length).toBe(26);
		for (const id of ["python-sdk", "typescript-sdk", "rest-api", "claude", "chatgpt", "claude-code",
			"codex", "cursor", "opencode", "antigravity", "openclaw", "hermes", "pi", "langchain",
			"crewai", "autogen", "agno", "llamaindex", "mastra", "vercel-ai", "camel", "google-adk",
			"openai-agents", "n8n", "dify", "convex"]) {
			expect(dev, `draws the ${id} mark`).toContain(`data-tool="${id}"`);
		}
		// Every tile carries its name for screen readers — the img is decorative.
		expect((dev.match(/class="sr-only"/g) ?? []).length).toBe(26);
	});

	it("keeps the 38 setup paths as the section's one outbound link", () => {
		expect(dev).toContain("All 38 setup paths");
		expect(dev).toContain('href="/docs/"');
	});
});

describe("raw versus structured section", () => {
	const contrast = html.slice(html.indexOf('<section class="contrast-section'), html.indexOf('<section class="lifecycle-section'));

	it("names the transformation in display type, not a caption", () => {
		// The panes carry RAW and STRUCTURED as headings so the change of state
		// is legible from the layout before any prose is read.
		expect(contrast).toContain("<header><b>Raw</b>");
		expect(contrast).toContain("<header><b>Structured</b>");
		expect(contrast).toContain('class="contrast-arrow"');
	});

	it("shows the discarded lines as a deliberate product behaviour", () => {
		expect(contrast).toContain("Discarded on purpose:");
		expect(contrast).toContain("Your rules decide what never becomes memory.");
	});

	it("emits every typed object the extractor produces", () => {
		for (const kind of ["Fact", "Event", "Entity", "Relationship"]) {
			expect(contrast, `names the ${kind} row`).toContain(`<b>${kind}</b>`);
		}
	});

	it("closes the loop with what an agent recalls later", () => {
		expect(contrast).toContain('class="contrast-recall"');
		expect(contrast).toContain("Six months later");
		expect(contrast).toContain("Who moved the pricing review, and when?");
	});

	it("labels itself an example so nothing reads as live product data", () => {
		expect(contrast).toContain("A worked example.");
		// The old panel imitated a dashboard, down to fake window chrome.
		expect(contrast).not.toContain("MEMORY INSPECTOR");
		expect(contrast).not.toContain("EXAMPLE WORKSPACE");
		expect(html).not.toContain("landingSelectMemory");
	});
});

describe("open source section", () => {
	const oss = html.slice(html.indexOf('<section class="oss-section'), html.indexOf('<section class="closing-section'));

	it("offers a real GitHub destination with the primary-action affordance", () => {
		expect(oss).toContain('class="primary-action oss-cta"');
		expect(oss).toContain('href="https://github.com/12ziyad/universal-memory-engine"');
		expect(oss).toContain('target="_blank"');
		expect(oss).toContain('rel="noopener"');
	});

	it("states only verifiable facts", () => {
		expect(oss).toContain("Apache 2.0");
		expect(oss).toContain("No lock-in");
		expect(oss).not.toMatch(/SOC\s*2|certified|enterprise[- ]ready/i);
	});
});

describe("navigation reaches every section it names", () => {
	it("links only anchors that exist in the document", () => {
		const nav = html.slice(html.indexOf('class="primary-nav"'), html.indexOf("</nav>"));
		const anchors = [...nav.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);
		expect(anchors.length).toBeGreaterThanOrEqual(5);
		for (const anchor of anchors) {
			expect(html, `#${anchor} exists`).toContain(`id="${anchor}"`);
		}
	});
});

describe("enterprise footer", () => {
	const footer = html.slice(html.indexOf('<footer class="footer" role="contentinfo">'), html.indexOf("</footer>"));

	it("is a structured four-group ending, not a strip", () => {
		expect(footer).toContain('class="footer-grid"');
		expect(footer).toContain('aria-label="Developer resources"');
		expect(footer).toContain('aria-label="Product"');
		expect(footer).toContain('aria-label="Company and trust"');
		expect(footer).toContain("© 2026 Itsuki");
	});

	it("links only destinations that exist", () => {
		for (const href of [
			"/docs/#/quickstart", "/docs/#/api/rest", "/docs/#/api/mcp", "/docs/#/sdk/python",
			"/docs/#/sdk/js", "/docs/#/integrations/native", "/docs/#/concepts/memory",
			"/docs/#/operate/observability", "/docs/#/privacy", "/privacy", "/terms",
			"https://github.com/12ziyad/universal-memory-engine",
		]) expect(footer, `footer links ${href}`).toContain(`href="${href}"`);
		expect(footer).not.toContain('href="#"');
	});

	it("carries truthful trust language and no unverifiable compliance claims", () => {
		for (const claim of ["Tenant-isolated", "Source-backed", "Versioned", "Deletable by design"]) {
			expect(footer).toContain(claim);
		}
		expect(html).not.toMatch(/SOC\s*2|HIPAA|ISO\s*27001|GDPR[- ]?(ready|compliant|certified)/i);
	});
});

describe("neutral dark theme (markup side)", () => {
	it("never hardcodes white on the accent", () => {
		expect(html).not.toMatch(/background: var\(--accent\); color: #fff/);
	});

	it("previews the real editorial palettes in the appearance picker", () => {
		expect(html).toContain(".theme-preview.preview-dark { --panel: #161617;");
		expect(html).not.toContain("#8b7cf6; }\n\t.theme-preview.preview-system");
	});
});

describe("header profile menu", () => {
	it("exists with correct popover semantics and house wiring", () => {
		expect(html).toContain('id="profileTrigger"');
		expect(html).toMatch(/id="profileTrigger"[^>]*aria-haspopup="menu"/s);
		expect(html).toContain('<div class="profile-menu" id="profileMenu" role="menu"');
		// Outside-click and Escape close it exactly like the scope switchers.
		expect(html).toContain('if (!event.target.closest("#profileMenuWrap")) toggleProfileMenu(false);');
		const escapeChain = html.slice(html.indexOf("toggleProjectMenu(false);\n\ttoggleOrganizationMenu(false);"), 0x7fffffff);
		expect(escapeChain).toContain("toggleProfileMenu(false);");
	});

	it("contains identity, appearance, settings, support and sign-out — and no forbidden id", () => {
		const menu = fnSource("renderProfileMenu");
		expect(menu).toContain("profile-id");
		expect(menu).toContain('role="group" aria-label="Appearance"');
		expect(menu).toContain("setTheme('${value}')");
		for (const t of ['"light", "Light"', '"dark", "Dark"', '"system", "System"']) {
			expect(menu).toContain(`themeBtn(${t})`);
		}
		expect(menu).toContain("setView('settings')");
		expect(menu).toContain("mailto:hello@itsuki.app");
		expect(menu).toContain("logoutNow()");
		expect(html).not.toContain('id="logoutBtn"');
	});

	it("returns focus to the trigger when closing from inside", () => {
		const toggle = fnSource("toggleProfileMenu");
		expect(toggle).toContain("focusWasInside");
		expect(toggle).toContain("button.focus()");
	});
});

describe("settings layout", () => {
	it("puts Save/Cancel directly under the editable fields, metadata behind Technical details", () => {
		for (const fn of ["setProjectGeneral", "setOrgGeneral"]) {
			const src = fnSource(fn);
			const actions = src.indexOf('id="setGeneralSave"');
			const tech = src.indexOf("Technical details");
			expect(actions, `${fn} has actions`).toBeGreaterThan(-1);
			expect(tech, `${fn} has a Technical details disclosure`).toBeGreaterThan(-1);
			expect(actions, `${fn}: Save sits before the disclosure`).toBeLessThan(tech);
			expect(src).toContain('<details class="mw-tech set-tech">');
			// Collapsed by default: no open attribute.
			expect(src).not.toContain("<details class=\"mw-tech set-tech\" open");
		}
	});

	it("offers self-service leave with server-guarded visibility", () => {
		expect(fnSource("setProjectGeneral")).toContain("leaveCurrentProject()");
		expect(fnSource("setOrgGeneral")).toContain("leaveCurrentOrganization()");
		expect(fnSource("setOrgGeneral")).toContain('org_role !== "owner"');
		expect(fnSource("leaveCurrentProject")).toContain('"/v1/settings/members/leave"');
		expect(fnSource("leaveCurrentOrganization")).toContain('"/v1/settings/org-members/leave"');
	});
});

describe("conditional audit filters", () => {
	it("derives Apply and Clear from draft-vs-applied state", () => {
		const audit = fnSource("setProjectAudit");
		expect(audit).toContain("auditApplyDisabled");
		expect(audit).toContain("setAuditFiltersEqual(draftFilters, filters)");
		expect(audit).toContain("setAuditFiltersBlank(draftFilters)");
		expect(audit).toContain('oninput="setAuditDraftField');
	});

	it("keeps typed values on validation errors instead of re-rendering them away", () => {
		const apply = fnSource("setApplyAuditFilters");
		expect(apply).toContain('setAuditFilterStatus("Choose valid From and To dates.")');
		expect(apply).toContain('setAuditFilterStatus("From must be earlier than To.")');
		expect(apply).not.toContain("renderSettingsSection()");
	});

	it("both controls stay quiet while any load is in flight", () => {
		expect(fnSource("setProjectAudit")).toContain("SET.auditLoading || SET.auditLoadingMore");
	});
});

describe("truthful rules preview", () => {
	it("separates policy, worthiness, and category in the copy", () => {
		expect(html).toContain("Allowed by rules");
		expect(html).toContain("Blocked by policy:");
		expect(html).toContain('"Allowed by rules" alone never means a line will be stored.');
	});

	it("renders the assessment states including explicit uncertainty", () => {
		const copy = fnSource("setAssessmentCopy");
		expect(copy).toContain("Likely durable memory");
		expect(copy).toContain("Not durable — would not be stored");
		expect(copy).toContain("Uncertain — model review");
	});
});

describe("auth flow hardening", () => {
	it("bounds every gating fetch with a timeout", () => {
		expect(fnSource("submitAuth")).toContain('fetchWithTimeout("/auth/email/start"');
		expect(fnSource("submitAuthCode")).toContain('fetchWithTimeout("/auth/email/verify"');
		expect(fnSource("refreshMe")).toContain('fetchWithTimeout("/auth/me"');
		expect(fnSource("finishAuthentication")).toContain("Workspace data took too long to load.");
	});

	it("re-enables resend after the cooldown and counts down the expiry", () => {
		expect(html).toContain('id="authResend"');
		expect(html).toContain('id="authExpiry"');
		const sync = fnSource("syncAuthCountdown");
		expect(sync).toContain("Send another code");
		expect(sync).toContain("resendBtn.disabled = AUTH_FLOW.busy || waiting");
	});

	it("surfaces a recoverable screen when the workspace cannot load", () => {
		const err = fnSource("renderShellLoadError");
		expect(err).toContain("Try again");
		expect(err).toContain("location.reload()");
		expect(html).not.toContain('banner("Account setup could not be loaded');
	});

	it("lets the first key be named and never hardcodes the label", () => {
		expect(html).toContain('id="firstRunKeyName"');
		const create = fnSource("createFirstRunKey");
		expect(create).toContain("firstRunKeyName");
		expect(create).toContain("JSON.stringify({ type: \"api\", label })");
	});
});

describe("stale scope recovery", () => {
	it("revalidates scope once per epoch when the project stops resolving", () => {
		const api = fnSource("scheduleScopeRevalidation");
		expect(api).toContain("refreshProjects()");
		expect(api).toContain("resetProjectBoundUiState()");
		expect(html).toContain('failure.code === "project_not_found" || res.status === 403');
	});
});

