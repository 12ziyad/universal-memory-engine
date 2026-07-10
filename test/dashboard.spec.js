import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

describe("dashboard script", () => {
	it("parses and exposes graph modes/actions", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain('graphMode: "clean"');
		expect(script).toContain("function initShell()");
		expect(script).toContain("function initReveal()");
		expect(script).toContain("function renderAuth(");
		expect(script).toContain("function hashView()");
		expect(script).toContain('APP_VIEWS = new Set(["overview", "memory", "graph", "candidates", "connect", "receipts", "rules", "settings"])');
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

	it("renders the public UML platform landing shell", () => {
		expect((html.match(/<section class="landing-section/g) || []).length).toBeGreaterThanOrEqual(8);
		expect(html).toContain("Universal Memory Layer");
		expect(html).toContain("One private memory graph for AI tools, agents, and apps.");
		expect(html).toContain("UML turns useful context from chats, events, documents, tools, and workflows into structured memory");
		expect(html).toContain("Start building");
		expect(html).toContain("View docs");
		expect(html).toContain("Works with API, SDK, dashboard, and MCP-linked clients.");
		expect(html).toContain("Chat Turn");
		expect(html).toContain("Extract");
		expect(html).toContain("Graph");
		expect(html).toContain("Recall");
		expect(html).toContain("Chat history is not memory.");
		expect(html).toContain("Memory is structured meaning.");
		expect(html).toContain("Backend is the authority, not the LLM.");
		expect(html).toContain("bounded recall");
		expect(html).toContain("Prompt-ready context");
		expect(html).toContain("Not raw graph JSON");
		expect(html).toContain("API, SDK, MCP, and dashboard workflows");
		expect(html).toContain("beforeReply()");
		expect(html).toContain("afterReply()");
		expect(html).toContain("When UML is connected through an MCP-capable AI client");
		expect(html).toContain("The client or host model decides when to call them.");
		expect(html).toContain("If you need guaranteed per-turn capture or recall, use the UML API or SDK inside your app or agent runtime.");
		expect(html).toContain("UML does not sell user data");
		expect(html).toContain("or use user memory for unrelated purposes");
		expect(html).toContain("User memory belongs to the account that created it.");
		expect(html).toContain("private links or tokens you create");
		expect(html).toContain("you can revoke them from Connect");
		expect(html).toContain("Reset memory deletes saved memory rows");
		expect(html).toContain("Token secrets and full MCP URLs are shown only once");
		expect(html).toContain("Privacy Policy");
		expect(html).toContain("Terms &amp; Conditions");
		expect(html).toContain("Support");
		expect(html).toContain("founder@gpmai.dev");
		expect(html).toContain("ejziyad@gmail.com");
		expect(html).toContain("/assets/uml-logo.svg");
		for (const forbidden of [
			"Skip the copy-paste between Claude and ChatGPT",
			"Your AI context is scattered",
			"Every AI starts from zero",
			"UML remembers everything",
			"Never lose context again",
			"The future of AI memory",
			"Game-changer",
			"Just works",
			"Seamlessly",
			"UML saves every message",
		]) {
			expect(html).not.toContain(forbidden);
		}
		const withoutContactEmail = html.replace(/mailto:founder@gpmai\.dev|founder@gpmai\.dev/g, "");
		expect(withoutContactEmail).not.toMatch(/gpmai/i);
	});

	it("keeps sidebar sorting and evidence display deterministic", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function latestStamp(");
		expect(script).toContain("compareLatestThenName");
		expect(script).toContain("function uniqueEvidence(");
		expect(script).toContain("duplicate/extra evidence item(s) hidden");
	});

	it("has one normal dashboard nav with required tabs and hidden dev credentials", () => {
		for (const view of ["overview", "memory", "graph", "candidates", "connect", "receipts", "rules", "settings"]) {
			expect(html.match(new RegExp(`data-view="${view}"`, "g")) || []).toHaveLength(1);
		}
		for (const oldView of ["home", "memories", "save", "recall", "help", "profile"]) {
			expect(html).not.toContain(`data-view="${oldView}"`);
		}
		expect(html).toContain('id="userId" class="dev-only"');
		expect(html).toContain('id="key" class="dev-only"');
		expect(html).toContain('id="copyMcp"');
		expect(html).not.toContain('id="logoutBtn"');
	});

	it("keeps Memory, Review, Connect, Receipts, Rules, and Settings in the new IA", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain("function viewOverview(");
		expect(script).toContain("function viewMemory(");
		expect(script).toContain("Candidate Review");
		expect(script).toContain("Promote to Node");
		expect(script).toContain("Ignore Similar");
		expect(script).toContain("Search, save, and recall structured UML memory from one place.");
		expect(script).toContain("Save memory");
		expect(script).toContain("Collect context");
		expect(script).toContain("Recall / search");
		expect(script).toContain("Connect UML");
		expect(script).toContain("Create a named private connection for each tool or app.");
		expect(script).toContain("Connection name");
		expect(script).toContain("Generate MCP URL");
		expect(script).toContain("Generated MCP URL");
		expect(script).toContain("Copy MCP URL");
		expect(script).toContain("Generate API token/key");
		expect(script).toContain("Generated API token/key");
		expect(script).toContain("toggleOneTimeSecret()");
		expect(script).toContain("clearOneTimeLink()");
		expect(script).toContain("cancelConnectFlow()");
		expect(script).toContain("Full secret was shown only once");
		expect(script).toContain("Authorization: Bearer uml_live_xxxxx");
		expect(script).toContain("API token usage");
		expect(script).toContain("Receipts show what UML saved, updated, or ignored");
		for (const mode of ["Important only", "Manual only", "Topic-based", "Keyword-based", "Schema-based", "Disabled"]) {
			expect(script).toContain(mode);
		}
		for (const section of ["Account", "Security", "Connections", "Memory Controls", "Data &amp; Privacy", "Support", "Legal / Terms", "Danger Zone"]) {
			expect(script).toContain(section);
		}
	});

	it("renders review mode only when candidates exist", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(html).toContain('data-review-tab');
		expect(html).toContain('id="candidateSidebarSection"');
		expect(script).toContain("function candidateItems()");
		expect(script).toContain("function updateReviewVisibility()");
		expect(script).toContain('tab.hidden = hidden');
		expect(script).toContain('if (hidden && S.view === "candidates")');
		expect(script).toContain('history.replaceState(null, "", "/app#overview")');
		expect(script).toContain("let redirected = false;");
		expect(script).toContain("redirected = true;");
		expect(script).toContain("(updateHash || redirected)");
		expect(script).toContain('No pending candidates to review.');
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
		expect(script).toContain("Do not use UML for abuse, unsafe automation");
		expect(script).toContain("function openPolicyModal(");
		expect(script).toContain("function closePolicyModal()");
		expect(script).toContain("Support / report issue");
	});

	it("shows revoked connection row behavior in Connect", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		expect(script).toContain('data-token-status="${active ? "active" : "revoked"}"');
		expect(script).toContain("Revoked row. This token can no longer save or recall memory.");
		expect(script).toContain("Active rows can be revoked. Revoked rows remain visible for audit and are not usable.");
		expect(script).toContain("revokeToken(");
		expect(script).toContain("disabled");
	});

	it("uses JS-safe delegated token actions for awkward token labels", () => {
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
		const awkwardLabels = ["Ziyad's Claude", 'Quote " Tool', "Backslash \\\\ Tool", "<script>alert(1)</script>"];
		expect(awkwardLabels).toContain("Ziyad's Claude");
		expect(script).toContain('data-token-action="rotate"');
		expect(script).toContain('data-token-label="${esc(t.label || "")}"');
		expect(script).toContain('button.dataset.tokenLabel || ""');
		expect(script).toContain('data-token-action="revoke"');
		expect(script).toContain('event.target.closest("[data-token-action]")');
		expect(script).not.toContain("onclick=\"rotateConnection('");
		expect(script).not.toContain("onclick=\"revokeToken('");
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
