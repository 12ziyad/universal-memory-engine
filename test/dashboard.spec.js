import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";
import docsHtml from "../public/docs/index.html?raw";

describe("dashboard script", () => {
	it("parses and exposes graph modes/actions", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain('graphMode: "clean"');
		expect(script).toContain("function initShell()");
		expect(script).toContain("function initReveal()");
		expect(script).toContain("function renderAuth(");
		expect(script).toContain("function hashView()");
		// All authenticated entry paths converge on one loader; duplicate shell
		// initialization was removed when first-run onboarding was introduced.
		expect(script.match(/setView\(S\.view, \{ updateHash: false \}\);/g)).toHaveLength(1);
		expect(script).toContain('APP_VIEWS = new Set(["overview", "memory", "graph", "candidates", "connect", "receipts", "rules", "settings", "admin", "install", "playground", "keys", "requests", "exports", "webhooks", "usage"])');
		expect(script).toContain("function viewMemory(");
		expect(script).toContain("/v1/candidates");
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

	it("keeps the public documentation script syntactically valid", () => {
		const script = docsHtml.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).not.toBe("");
		expect(() => new Function(script)).not.toThrow();
		expect(docsHtml).toContain("idempotency_key=MemoryClient.new_idempotency_key()");
		expect(docsHtml).not.toContain("idempotencyKey=MemoryClient.new_idempotency_key()");
		// Assert the methods are documented, not the exact argument text: the
		// SDK pages now carry full signatures (delete_by_source(source=None,
		// before=None, after=None, confirm=False)), which is strictly more
		// useful than the "(...)" these once pinned.
		for (const method of ["packet_status(", "packetStatus(", "delete_by_source(", "deleteBySource("]) {
			expect(docsHtml, method).toContain(method);
		}
	});

	it("uses procedural graph hulls instead of fixed DOM cluster rectangles", () => {
		expect(html).not.toContain("cluster-layer");
		expect(html).not.toContain("cluster-region");
		expect(html).not.toContain("renderClusterLayer");
		expect(html).toContain("clusterHullAnchors");
	});

	it("renders the public Itsuki platform landing shell", () => {
		const publicLanding = html.slice(html.indexOf('<div id="landing"'), html.indexOf('<div id="authView"'));
		expect(html).toContain('id="landing" class="public-shell lp-shell"');
		expect(html).toContain("For the AI tools you already use");
		expect(html).toContain("that sits under");
		expect(html).toContain("<em>that sits under<br />your AI tools.</em>");
		expect(html).toContain("Connect Itsuki once with one key.");
		expect(html).toContain("イツキ");
		// Section order is the product story: code surface at 02, the live
		// inspector at 03, and no section repeating another's argument. The
		// redundant surface band and positioning spread are gone for good.
		expect(html).toContain('class="chapter-rule-mark"');
		expect(html.indexOf('<span>02</span> One memory, every tool'))
			.toBeLessThan(html.indexOf('<span>03</span> The difference'));
		expect(html.indexOf('<span>03</span> The difference'))
			.toBeLessThan(html.indexOf('<span>04</span> How it works'));
		expect(html.indexOf('<span>06</span> Trust &amp; control'))
			.toBeLessThan(html.indexOf('<span>07</span> Open architecture'));
		expect(html).not.toContain("Built for every AI surface");
		expect(html).not.toContain("Context that survives");
		for (const surface of ["Applications", "Assistants", "Agents", "Workflows"]) {
			expect(publicLanding).toContain(surface);
		}
		expect(html).toContain("Four moves. One living memory.");
		expect(html).toContain('data-landing-step="0"');
		expect(html).toContain("landingSelectStep");
		expect(html).toContain("Memory across");
		expect(html).toContain("the entire stack.");
		expect(html).toContain("you can check.");
		expect(html).toContain("Memory<br />you can check.");
		expect(html).toContain('data-landing-sdk="node"');
		expect(html).toContain('data-landing-sdk="mcp"');
		expect(html).toContain("npm install itsuki");
		expect(html).toContain("pip install itsuki");
		expect(html).toContain("PASTE_THE_PRIVATE_URL_CREATED_IN_ITSUKI");
		expect(html).toContain('id="landingCodeAction" data-action="create-mcp"');
		expect(html).toContain('name === "mcp" ? "create-mcp" : "copy"');
		expect(html).toContain('location.href = "/app#install"');
		expect(html).toContain("landingSelectSdk");
		// Section 2 stopped being a quickstart when the connect card moved into
		// the hero; it is now the handoff.
		expect(html).toContain("Tell Claude Code.");
		expect(html).toContain("Cursor already knows.");
		expect(html).toContain('id="handoffInstrument"');
		expect(html).toContain("actually yours.");
		expect(html).toContain("Delete actually deletes");
		expect(html).toContain("Every write leaves a receipt");
		expect(html).toContain("No training on your data");
		expect(html).toContain("Put one memory under");
		expect(html).toContain("memory that carries forward");
		expect(html).toContain("showAuth('signup', event)");
		expect(html).toContain("showAuth('login', event)");
		expect(html).toContain("/docs/");
		expect(html).toContain("/privacy");
		expect(html).toContain("/terms");
		expect(html).toContain("hello@itsuki.app");
		expect(html).toContain("/assets/brand/itsuki-bonsai-mark.svg");
		expect(html).toContain("/assets/brand/itsuki-bonsai-favicon.svg");
		expect(html).toContain("/assets/landing-editorial-v1.css?v=8");
		expect(publicLanding).not.toMatch(/paper trail/i);
		// The receipts ban was deliberately lifted in the 2026-08-28 landing
		// rebuild: the competitor audit found auditable memory (write receipts,
		// source links, rollback) is the one trust territory Mem0/Zep/Letta/
		// Supermemory leave unclaimed, so the page now says it plainly —
		// "receipted" in the hero, "Every write leaves a receipt" in trust.
		expect(publicLanding).toMatch(/\breceipt(ed)?\b/i);
		for (const forbidden of [
			"Skip the copy-paste between Claude and ChatGPT",
			"Your AI context is scattered",
			"Every AI starts from zero",
			"Itsuki remembers everything",
			"Never lose context again",
			"The future of AI memory",
			"Game-changer",
			"Just works",
			"Seamlessly",
			"Itsuki saves every message",
			"Tell it once. Every AI remembers.",
			// Supermemory ships "What you teach one AI, every AI remembers" —
			// this shape is theirs now, whatever nouns we swap in.
			"Tell it once. Every tool remembers.",
			"every AI remembers",
			"Save once, recall everywhere.",
		]) {
			expect(html).not.toContain(forbidden);
		}
		// Brand hygiene, tightened for the domain move: no gpmai anywhere,
		// contact address included. The docs page gets the same rule.
		expect(html).not.toMatch(/gpmai/i);
		expect(docsHtml).not.toMatch(/gpmai/i);
	});

	it("keeps sidebar sorting and evidence display deterministic", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function latestStamp(");
		expect(script).toContain("compareLatestThenName");
		expect(script).toContain("function uniqueEvidence(");
		expect(script).toContain("duplicate/extra evidence item(s) hidden");
	});

	it("has one normal dashboard nav with required tabs and hidden dev credentials", () => {
		expect(html).toContain(".tab[hidden] { display: none; }");
		for (const view of ["overview", "memory", "graph", "install", "playground", "keys", "receipts", "settings"]) {
			// Count actual navigation buttons, not capability selectors that name
			// the same view in JavaScript.
			expect(html.match(new RegExp(`<button[^>]+data-view="${view}"`, "g")) || []).toHaveLength(1);
		}
		// Candidates and Rules stopped being top-level tabs; they live inside
		// Memories and Settings, but old deep links must still resolve.
		for (const merged of ["candidates", "rules"]) {
			expect(html).not.toContain(`class="tab" data-view="${merged}"`);
		}
		expect(html).toContain("const VIEW_ALIASES = { candidates: \"memory\", rules: \"settings\", connect: \"install\" }");
		// Connect stopped being a tab; the alias keeps old deep links working.
		expect(html).not.toContain('class="tab" data-view="connect"');
		// Setup/Activity rail sections and the external Docs link.
		expect(html).toContain('class="rail-label"');
		expect(html).toContain('href="/docs/"');
		for (const oldView of ["save", "recall", "help", "profile"]) {
			expect(html).not.toContain(`data-view="${oldView}"`);
		}
		expect(html).toContain('id="userId" class="dev-only"');
		expect(html).toContain('id="key" class="dev-only"');
		expect(html).toContain('id="copyMcp"');
		expect(html).not.toContain('id="logoutBtn"');
	});

	it("keeps Memories, suggestions, Connect, History, and Settings in the simplified IA", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function viewOverview(");
		expect(script).toContain("function viewMemory(");
		// The Memories page is the three-view workspace over the server-owned
		// /v1/memories/workspace surface; the inventory is never /v1/graph.
		expect(script).toContain("/v1/memories/workspace/inventory");
		expect(script).toContain("/v1/memories/workspace/sources");
		expect(script).toContain("/v1/memories/workspace/suggestions");
		expect(script).toContain("No suggestions waiting for review.");
		expect(script).toContain("Suggestion kept as a memory.");
		expect(script).toContain("Save memory");
		expect(script).toContain("function viewInstall(");
		expect(script).toContain("function viewKeys(");
		expect(script).toContain("function installSnippets(");
		expect(script).toContain("won't be shown again");
		expect(script).toContain('authorization: Bearer');
		// Get started is a searchable product catalog with one instruction and one
		// copyable thing per setup step.
		expect(script).toContain("function installMethods(");
		expect(script).toContain("function installCatalog(");
		expect(script).toContain("function openInstallProduct(");
		expect(script).toContain('class="integration-card');
		expect(script).toContain('id="installCatalogGrid" class="integration-grid"');
		expect(script).not.toContain('class="integration-group');
		expect(script).toContain('class="setup-step-button"');
		expect(script).toContain('class="setup-guide-section');
		expect(script).not.toContain('class="install-project-scope"');
		expect(script).toContain("x-itsuki-project");
		expect(script).toContain("Every write Itsuki accepted, what it made of it, and when");
		// The Rules tab is a working form wired to /v1/rules.
		for (const marker of [
			"Custom instructions",
			"Only collect (includes)",
			"Never collect (excludes)",
			"Custom categories",
			"saveRulesForm()",
			"/v1/rules",
			"rule-autocollect",
		]) {
			expect(script).toContain(marker);
		}
		for (const section of ["Account", "Security", "Connections", "Memory Controls", "Data &amp; Privacy", "Support", "Legal / Terms", "Delete project memory"]) {
			expect(script).toContain(section);
		}
	});

	it("keeps the pending-suggestion count on the Memories tab", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('id="reviewTabCount"');
		expect(script).toContain("function candidateItems()");
		expect(script).toContain("function updateReviewVisibility()");
		expect(script).toContain('if (hidden && S.view === "candidates")');
		expect(script).toContain('history.replaceState(null, "", "/app#overview")');
		expect(script).toContain("let redirected = false;");
		expect(script).toContain("redirected = true;");
		expect(script).toContain("(updateHash || redirected)");
	});

	it("has production legal, privacy, and support modal content", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('id="policyModal"');
		expect(script).toContain("const POLICY_CONTENT");
		expect(script).toContain("Early product.");
		expect(script).toContain("You own your account and the memory you intentionally store in it.");
		expect(script).toContain("Connected tools are third-party services.");
		expect(script).toContain("You are responsible for keeping tokens, API keys, and private MCP URLs safe.");
		expect(script).toContain("You can revoke tokens from Connect.");
		expect(script).toContain("Project-wide memory deletion is not currently exposed");
		expect(script).toContain("Avoid sensitive, regulated, or high-risk data");
		expect(script).toContain("Do not use Itsuki for abuse, unsafe automation");
		expect(script).toContain("function openPolicyModal(");
		expect(script).toContain("function closePolicyModal()");
		expect(script).toContain("Support / report issue");
	});

	it("offers one action per key, and it deletes", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain('data-key-action="delete"');
		expect(script).toContain("function deleteToken(");
		expect(script).toContain("Deleting a key stops it working immediately and removes it from this list.");
		// Rotate and Revoke are gone from the UI entirely.
		expect(script).not.toContain("rotateConnection");
		expect(script).not.toContain("revokeToken");
		expect(script).not.toContain("key-revoked");
	});

	it("keeps token row actions delegated, so awkward labels cannot break them", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		const awkwardLabels = ["Ziyad's Claude", 'Quote " Tool', "Backslash \\\\ Tool", "<script>alert(1)</script>"];
		expect(awkwardLabels).toContain("Ziyad's Claude");
		expect(script).toContain('button.dataset.keyLabel || "this key"');
		expect(script).toContain('event.target.closest("[data-key-action]")');
		expect(script).not.toContain("onclick=\"deleteToken('");
	});

	it("creates keys in a modal, because the secret is shown once", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('<div id="keyModal" class="modal-backdrop" hidden></div>');
		expect(script).toContain("function openKeyModal(");
		expect(script).toContain("function submitKeyModal(");
		expect(script).toContain("function closeKeyModal(");
		expect(script).toContain(`<label for="keyModalName">Key name`);
		// The field is bound to state so a failed create hands the name back
		// rather than a blank input (see form_state.spec.js).
		expect(script).toContain(`value="${"${esc(KEYMODAL.name)}"}" oninput="keyModalField(this.value)"`);
		expect(script).toContain('class="key-warning"');
		expect(script).toContain("won't be shown again.");
		// Get started's create-link button opens the same modal.
		expect(script).toMatch(/function createInstallKey\(\) \{\r?\n\treturn openKeyModal\("mcp"\);/);
		// The old inline panel is gone, so the secret has exactly one home.
		expect(script).not.toContain("oneTimeSecretPanel");
		// And the second create button on API Keys is gone with it.
		expect(script).not.toContain(">Create MCP link</button>");
	});

	it("exposes project-wide deletion only through the server-gated lifecycle workflow", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('data-view="settings"');
		expect(script).toContain("function viewSettings(");
		// The controls render only from the server's lifecycle payload — no
		// static destructive button exists before the backend answers.
		expect(script).toContain("function setDangerZone(");
		expect(script).toContain("/v1/settings/lifecycle");
		expect(script).toContain("Loading lifecycle state…");
		// Destructive operations require the typed project name and a preview
		// token, and a 202 is reported as accepted — never as deleted.
		expect(script).toContain("lcSyncConfirm");
		expect(script).toContain("accepted. Progress shows below.");
		expect(script).not.toContain("function viewReset(");
		expect(script).not.toContain("function resetSelectedUserMemory(");
		expect(script).not.toContain("function showResetMemoryConfirm(");
		expect(script).not.toContain("/v1/actions/delete-all");
		expect(script).not.toContain("DELETE ALL");
	});

	it("describes export and erasure at their real resolved-space boundary", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain("A JSON copy of the memory space resolved by this project and session");
		expect(script).toContain("does not aggregate sibling SDK subtenant spaces");
		expect(script).toContain("does not combine sibling SDK subtenant spaces");
		expect(script).toContain("function exportEntityLabel(row)");
		expect(script).toContain('"Resolved memory space"');
		expect(script).toContain("verified lifecycle workflow");
		expect(script).not.toContain("delete all of it, at any time, from Settings");
		expect(script).not.toContain("Deletion is self-serve and immediate for memory");
		expect(docsHtml).toContain("the one memory space resolved for the request");
		expect(docsHtml).toContain("is intentionally not exposed in Settings");
		expect(docsHtml).toContain("True project-wide deletion is self-serve from Settings via the verified lifecycle workflow");
		expect(docsHtml).not.toContain("Settings → danger zone");
	});
});
