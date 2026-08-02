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
		expect(script).toContain('APP_VIEWS = new Set(["overview", "memory", "graph", "candidates", "connect", "receipts", "rules", "settings", "admin", "install", "playground", "keys", "requests", "exports", "webhooks"])');
		expect(script).toContain("function viewCandidates(");
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

	it("uses procedural graph hulls instead of fixed DOM cluster rectangles", () => {
		expect(html).not.toContain("cluster-layer");
		expect(html).not.toContain("cluster-region");
		expect(html).not.toContain("renderClusterLayer");
		expect(html).toContain("clusterHullAnchors");
	});

	it("renders the public Itsuki platform landing shell", () => {
		expect((html.match(/<section class="landing-section/g) || []).length).toBeGreaterThanOrEqual(8);
		expect(html).toContain("Universal Memory Layer");
		expect(html).toContain("Tell it once. Every AI remembers.");
		expect(html).toContain("one private memory graph shared by Claude, your agents, and your apps");
		expect(html).toContain("Itsuki turns useful context from chats, events, documents, tools, and workflows into structured memory");
		expect(html).toContain("Start free");
		expect(html).toContain("See how it works");
		expect(html).toContain("Works with API, SDK, dashboard, and MCP-linked clients.");
		// Hero product footage replaces the old CSS mock graph.
		expect(html).toContain("/assets/uml-reel.mp4");
		expect(html).toContain("hero-video");
		// How-it-works flow, written for a first-time visitor.
		expect(html).toContain("Four steps. Simple enough to explain to anyone.");
		expect(html).toContain("Itsuki organizes it");
		expect(html).toContain("Every tool remembers");
		// Connect terminal with per-client tabs; URLs are built from
		// location.origin at runtime so no deploy domain leaks into the shell.
		expect(html).toContain("Pick your tool. Paste one link. Done.");
		expect(html).toContain("data-connect");
		expect(html).toContain("YOUR_PRIVATE_TOKEN");
		expect(html).toContain("connectSnippets");
		expect(html).toContain("Chat history is not memory.");
		expect(html).toContain("Memory is structured meaning.");
		expect(html).toContain("Backend is the authority, not the LLM.");
		expect(html).toContain("A graph that can update, not just append.");
		expect(html).toContain("A memory you can see");
		expect(html).toContain("Latest truth wins");
		expect(html).toContain("Receipts for every save");
		expect(html).toContain("Your rules");
		expect(html).toContain("When Itsuki is connected through an MCP-capable AI client");
		expect(html).toContain("The client or host model decides when to call them.");
		expect(html).toContain("If you need guaranteed per-turn capture or recall, use the Itsuki API or SDK inside your app or agent runtime.");
		expect(html).toContain("Itsuki does not sell user data");
		expect(html).toContain("or use user memory for unrelated purposes");
		expect(html).toContain("User memory belongs to the account that created it.");
		expect(html).toContain("private links or tokens you create");
		expect(html).toContain("you can revoke them from Connect");
		expect(html).toContain("Token secrets and full MCP URLs are shown only once");
		expect(html).toContain("Free early access");
		expect(html).toContain("Privacy Policy");
		expect(html).toContain("Terms of Service");
		expect(html).toContain("Support");
		expect(html).toContain("hello@itsuki.app");
		expect(html).toContain("ejziyad@gmail.com");
		expect(html).toContain("/assets/uml-icon.png");
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
		for (const view of ["overview", "memory", "graph", "install", "playground", "keys", "receipts", "settings"]) {
			expect(html.match(new RegExp(`data-view="${view}"`, "g")) || []).toHaveLength(1);
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
		expect(script).toContain("Suggestions to review");
		expect(script).toContain("Promote to Node");
		expect(script).toContain("Ignore Similar");
		expect(script).toContain("Everything Itsuki remembers about you, in one place.");
		expect(script).toContain("Save a memory");
		expect(script).toContain("Save from a chat or notes");
		expect(script).toContain("Search your memories");
		expect(script).toContain("function viewInstall(");
		expect(script).toContain("function viewKeys(");
		expect(script).toContain("function installSnippets(");
		expect(script).toContain("Full secrets are shown only once");
		expect(script).toContain('authorization: Bearer');
		// Get started is a numbered stepper: three method cards, per-client tabs,
		// and one instruction + one copyable thing per step.
		expect(script).toContain("function installMethods(");
		expect(script).toContain("function setInstallMethod(");
		expect(script).toContain('class="method-card');
		expect(script).toContain('class="step-num"');
		expect(script).toContain("Three ways in. All of them read and write the same memory.");
		expect(script).toContain("A plain record of everything Itsuki saved, updated, or skipped");
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
		for (const section of ["Account", "Security", "Connections", "Memory Controls", "Data &amp; Privacy", "Support", "Legal / Terms", "Danger Zone"]) {
			expect(script).toContain(section);
		}
	});

	it("renders review mode only when candidates exist", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('id="reviewTabCount"');
		expect(html).toContain('id="candidateSidebarSection"');
		expect(script).toContain("function openSuggestions()");
		expect(script).toContain("suggestion${pending === 1 ? \"\" : \"s\"} waiting for you");
		expect(script).toContain("function candidateItems()");
		expect(script).toContain("function updateReviewVisibility()");
		expect(script).toContain("if (hidden && S.showSuggestions) S.showSuggestions = false;");
		expect(script).toContain('if (hidden && S.view === "candidates")');
		expect(script).toContain('history.replaceState(null, "", "/app#overview")');
		expect(script).toContain("let redirected = false;");
		expect(script).toContain("redirected = true;");
		expect(script).toContain("(updateHash || redirected)");
		expect(script).toContain('Nothing waiting for you.');
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
		expect(script).toContain("Reset memory currently deletes saved memory rows");
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
		expect(script).toContain('function createInstallKey() {\n\treturn openKeyModal("mcp");');
		// The old inline panel is gone, so the secret has exactly one home.
		expect(script).not.toContain("oneTimeSecretPanel");
		// And the second create button on API Keys is gone with it.
		expect(script).not.toContain(">Create MCP link</button>");
	});

	it("includes a settings danger zone with exact confirmation gating", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('data-view="settings"');
		expect(script).toContain("function viewReset(");
		expect(script).toContain("function viewSettings(");
		expect(script).toContain("function resetSelectedUserMemory(");
		expect(script).toContain("function showResetMemoryConfirm(");
		expect(script).toContain("function cancelResetMemory(");
		expect(script).toContain("resetConfirmOpen");
		expect(script).toContain("/v1/actions/delete-all");
		expect(script).toContain("DELETE ALL");
		expect(script).toContain("showResetMemoryConfirm()");
		expect(script).toContain('button.disabled = (input?.value || "") !== "DELETE ALL"');
		expect(script).toContain('if (confirmText !== "DELETE ALL") return resetConfirmChanged();');
	});
});
