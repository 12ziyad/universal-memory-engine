/**
 * Memories workspace UI — the frontend half of the contract.
 *
 * These are static contracts over public/index.html: the three views, real
 * API wiring, no /v1/graph inventory dependency, conditional tabs, URL
 * selection state, drawer accessibility, honest states, and the absence of
 * demo data and no-op controls. Behavioral pieces (stale responses, save
 * modal) run the extracted functions with stubs.
 */

import { describe, it, expect, vi } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	if (script.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
	// Find the body brace AFTER the parameter list — destructured defaults put
	// braces inside the parens, which a naive counter mistakes for the body.
	let parens = 0;
	let sawParams = false;
	let bodyStart = -1;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "(") { parens++; sawParams = true; }
		else if (script[i] === ")") parens--;
		else if (script[i] === "{" && sawParams && parens === 0) { bodyStart = i; break; }
	}
	if (bodyStart === -1) throw new Error(`no body for ${name}`);
	let depth = 0;
	for (let i = bodyStart; i < script.length; i++) {
		if (script[i] === "{") depth++;
		else if (script[i] === "}") {
			depth--;
			if (depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function workspaceRaceHarness(apiImpl) {
	return new Function("apiImpl", `
		const S = { view: "memory", projectEpoch: 7, devMode: false, userId: null };
		let MW = {
			view: "memories", q: "", sort: "updated_desc", fKind: [], fCat: [], fSrc: [], fLife: [], fState: [],
			fWindow: "any", sugStatus: "pending", items: [], total: null, cursor: null, loading: false,
			refreshing: false, loadingMore: false, error: "", loaded: false, sel: null, detail: null,
			detailLoading: false, detailError: "", tab: "", sat: {}, openMenu: "", listRequestId: 0,
			detailRequestId: 0, lastFocusRowId: null,
		};
		const api = apiImpl;
		const $ = () => null;
		function mwWriteRoute() {}
		function mwRenderHead() {}
		function mwRenderToolbar() {}
		function mwRenderCount() {}
		function mwRenderList() {}
		function mwRenderInsp() {}
		function mwSetDrawer() {}
		function mwNarrow() { return false; }
		${fnSource("mwPath")}
		${fnSource("mwFresh")}
		${fnSource("mwListParams")}
		${fnSource("mwItemById")}
		${fnSource("mwFetchList")}
		${fnSource("mwSelect")}
		${fnSource("mwOpenSource")}
		${fnSource("mwOpenMemoryFromSource")}
		return {
			state: () => MW,
			openSource: mwOpenSource,
			openMemoryFromSource: mwOpenMemoryFromSource,
		};
	`)(apiImpl);
}

describe("three primary views over real APIs", () => {
	it("wires each view to its workspace endpoint and nothing to /v1/graph", () => {
		const params = fnSource("mwListParams");
		expect(params).toContain("/v1/memories/workspace/inventory");
		expect(params).toContain("/v1/memories/workspace/sources");
		expect(params).toContain("/v1/memories/workspace/suggestions");
		// The workspace never renders inventory from the unbounded graph dump.
		const mwStart = script.indexOf("const MW_VIEWS");
		const mwEnd = script.indexOf("async function refreshTokens()");
		const workspace = script.slice(mwStart, mwEnd);
		expect(workspace).not.toContain("/v1/graph");
		expect(workspace).not.toContain("S.data");
	});

	it("uses cursors for pagination and recovers from a stale cursor", () => {
		const fetchList = fnSource("mwFetchList");
		expect(fetchList).toContain("params.cursor = cursor");
		expect(fetchList).toContain('error.code === "invalid_cursor"');
		expect(fetchList).toContain("mwFetchList({ reset: true })");
	});

	it("uses independent stale-response lanes for lists, details and satellites", () => {
		expect(fnSource("mwFetchList")).toContain('mwFresh("list"');
		expect(fnSource("mwSelect")).toContain('mwFresh("detail"');
		expect(fnSource("mwLoadSat")).toContain("existing.requestId");
		expect(fnSource("mwDefaults")).toContain("listRequestId: 0");
		expect(fnSource("mwDefaults")).toContain("detailRequestId: 0");
		// Counts ride beside the list rather than behind its request id, but must
		// still refuse a project switch.
		expect(fnSource("mwFetchCounts")).toContain("epoch !== S.projectEpoch");
		expect(fnSource("mwFresh")).toContain("S.projectEpoch");
		expect(fnSource("viewMemory")).toContain("MW.epoch !== S.projectEpoch");
	});

	it("lets an Open source list and detail settle independently", async () => {
		const list = deferred();
		const detail = deferred();
		const apiImpl = vi.fn((path) => (path === "/v1/memories/workspace/sources" || path.startsWith("/v1/memories/workspace/sources?")) ? list.promise : detail.promise);
		const harness = workspaceRaceHarness(apiImpl);
		const opening = harness.openSource("src_1");

		detail.resolve({ source: { id: "src_1", title: "Source one" } });
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.state().detail?.id).toBe("src_1");
		expect(harness.state().loading).toBe(true);

		list.resolve({ items: [{ id: "src_1", title: "Source one" }], total: 1, next_cursor: null });
		await opening;
		expect(harness.state()).toMatchObject({ loading: false, loaded: true, total: 1, sel: "src_1" });
		expect(harness.state().items).toHaveLength(1);
	});

	it("lets Open memory settle in the reverse order and always clears loading", async () => {
		const list = deferred();
		const detail = deferred();
		const apiImpl = vi.fn((path) => (path === "/v1/memories/workspace/inventory" || path.startsWith("/v1/memories/workspace/inventory?")) ? list.promise : detail.promise);
		const harness = workspaceRaceHarness(apiImpl);
		const opening = harness.openMemoryFromSource("node_1");

		list.resolve({ items: [{ id: "node_1", text: "A memory" }], total: 1, next_cursor: null });
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.state().loaded).toBe(true);
		detail.resolve({ memory: { id: "node_1", text: "A memory" } });
		await opening;
		expect(harness.state()).toMatchObject({ loading: false, detailLoading: false, sel: "node_1" });
		expect(harness.state().detail?.id).toBe("node_1");
	});

	it("shows a list error without stranding a successfully loaded source detail", async () => {
		const list = deferred();
		const detail = deferred();
		const apiImpl = vi.fn((path) => (path === "/v1/memories/workspace/sources" || path.startsWith("/v1/memories/workspace/sources?")) ? list.promise : detail.promise);
		const harness = workspaceRaceHarness(apiImpl);
		const opening = harness.openSource("src_2");
		detail.resolve({ source: { id: "src_2", title: "Source two" } });
		list.reject(new Error("List unavailable"));
		await opening;
		expect(harness.state()).toMatchObject({ loading: false, detailLoading: false, error: "List unavailable" });
		expect(harness.state().detail?.id).toBe("src_2");
	});

	it("keeps selection in the URL without a debug route chip", () => {
		expect(fnSource("mwWriteRoute")).toContain("history.replaceState");
		expect(fnSource("mwReadRoute")).toContain('raw.startsWith("memory")');
		expect(fnSource("hashView")).toContain('split("/")[0]');
		expect(script).not.toContain("mw-route-chip");
	});
});

describe("inspector", () => {
	it("renders conditional tabs only when their real counts exist", () => {
		const tabs = fnSource("mwTabsFor");
		expect(tabs).toContain("detail.evidence_count > 0");
		expect(tabs).toContain("detail.timeline_count > 0");
		expect(tabs).toContain("detail.connections_count > 0");
		expect(tabs).toContain("detail.memories > 0");
		expect(tabs).toContain("detail.evidence > 0");
		expect(tabs).toContain("detail.has_content");
	});

	it("lazy-loads satellites with independent cursors", () => {
		const sat = fnSource("mwLoadSat");
		expect(sat).toContain("existing.cursor");
		expect(sat).toContain("/${tab}");
		expect(fnSource("mwSatList")).toContain("data-mw-satmore");
	});

	it("has previous/next over the filtered order that extends past the page", () => {
		const step = fnSource("mwStep");
		expect(step).toContain("MW.items.findIndex");
		expect(step).toContain("mwFetchList({ reset: false, cursor: MW.cursor })");
	});

	it("shows a deleted-while-open message instead of a blank panel", () => {
		expect(fnSource("mwSelect")).toContain("error.status === 404");
		expect(script).toContain("This item is gone — it may have been deleted in another session.");
	});

	it("collapses technical detail by default and offers copyable ids", () => {
		expect(script).toContain('<details class="mw-tech">');
		expect(script).toContain("data-mw-copyval");
		expect(fnSource("mwInspPanel")).toContain("Raw metadata");
	});
});

describe("drawer accessibility", () => {
	it("moves focus in, makes the background inert and restores focus on close", () => {
		const drawer = fnSource("mwSetDrawer");
		expect(drawer).toContain("node.inert = true");
		expect(drawer).toContain('$("#mwInsp")?.focus()');
		expect(drawer).toContain("MW.lastFocusRowId");
	});

	it("closes on Escape and supports / to reach search", () => {
		const handlers = fnSource("mwInstallGlobalHandlers");
		expect(handlers).toContain('event.key === "Escape"');
		expect(handlers).toContain("mwSetDrawer(false)");
		expect(handlers).toContain('event.key === "/"');
	});

	it("keeps full keyboard row navigation", () => {
		const listKey = fnSource("mwListKey");
		for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
			expect(listKey).toContain(key);
		}
		expect(listKey).toContain('event.target.closest("button, a, input, select, textarea, [role=menuitem]")');
		expect(listKey).toContain("row.tabIndex = -1");
		expect(listKey).toContain("target.tabIndex = 0");
		const list = fnSource("mwRenderList");
		expect(list).toContain('tabindex="${index === rovingIndex ? "0" : "-1"}"');
		expect(list).toContain('aria-rowindex="${index + 2}"');
	});

	it("uses dialog semantics for the save modal with a focus trap", () => {
		expect(script).toContain('role="dialog" aria-modal="true" aria-label="Save memory"');
		expect(fnSource("mwRenderLayer")).toContain('event.key !== "Tab"');
	});
});

describe("honest states", () => {
	it("names every empty state and offers the right recovery", () => {
		const list = fnSource("mwRenderList");
		expect(list).toContain("No suggestions waiting for review.");
		expect(list).toContain("match this search.");
		expect(list).toContain("Nothing here yet. Save a memory or connect a tool to begin.");
		expect(list).toContain("Clear filters");
		expect(list).toContain("Retry");
	});

	it("keeps last-good rows while refreshing", () => {
		const fetchList = fnSource("mwFetchList");
		expect(fetchList).toContain("MW.refreshing = MW.items.length > 0");
		expect(fetchList).toContain("MW.loading = MW.items.length === 0");
	});

	it("read-only projects get an inspect-only surface, not silent failures", () => {
		expect(fnSource("mwRenderHead")).toContain("Viewers cannot save memory in this project.");
		expect(fnSource("mwSuggestionAct")).toContain("Viewers cannot review memory suggestions in this project.");
		expect(fnSource("mwRowMenuItems")).toContain("mwCanDelete()");
	});

	it("announces counts politely and errors assertively", () => {
		expect(fnSource("mwRenderCount")).toContain('aria-live="polite"');
		expect(fnSource("mwRenderList")).toContain('role="alert"');
	});
});

describe("no demo data, no no-op controls", () => {
	it("ships none of the prototype's sample content", () => {
		for (const label of ["Kasaragod", "Kovalam", "Priya Raghunathan", "doc_8f42a1", "mem_k01", "sug_01", "fleet-telemetry"]) {
			expect(html).not.toContain(label);
		}
		// "Northwind" and "Kerala" also appear in the prototype, but they have
		// legitimate pre-existing uses elsewhere in the page (the landing page's
		// illustrative graph; the Terms' governing-law clause). The workspace
		// itself must not carry any of the prototype's fiction.
		const mwStart = script.indexOf("const MW_VIEWS");
		const mwEnd = script.indexOf("async function refreshTokens()");
		const workspace = script.slice(mwStart, mwEnd);
		expect(workspace).not.toContain("Northwind");
		expect(workspace).not.toContain("Kerala");
	});

	it("ships no bulk-select control and no fake retry", () => {
		// No safe batch mutation API exists, so the Select/bulk bar was cut.
		expect(script).not.toContain("Select all shown memories");
		expect(script).not.toContain("bulkArchive");
		expect(script).not.toContain("Export selection");
		// There is no server-side packet retry; the failed state explains itself
		// instead of showing a button that only mutates local state.
		expect(script).not.toContain("Retry ingest");
		expect(script).not.toContain("Retry queued locally");
	});

	it("every row action maps to a real backend route", () => {
		const action = fnSource("mwRowAction");
		expect(fnSource("mwArchive")).toContain("/v1/actions/archive-object");
		expect(fnSource("mwDelete")).toContain("/v1/memories/");
		expect(fnSource("mwSuggestionAct")).toContain("/v1/candidates/");
		expect(fnSource("mwCommitSave")).toContain("/v1/save");
		expect(action).toContain("copyText");
	});

	it("destructive actions confirm with the exact target", () => {
		expect(fnSource("mwArchive")).toContain("confirm(");
		expect(fnSource("mwDelete")).toContain("confirm(");
		expect(fnSource("mwDelete")).toContain("item.text ?? item.title ?? item.id");
	});

	it("events expose neither delete nor archive (no API exists)", () => {
		const menu = fnSource("mwRowMenuItems");
		expect(menu).toContain('item.kind !== "event"');
		expect(menu).toContain('(item.kind === "node" || item.kind === "page")');
	});
});

describe("visual system", () => {
	const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";

	it("is namespaced, tokenized and theme-aware", () => {
		expect(css).toContain("Memories workspace (mw-)");
		expect(css).toContain('html[data-theme="dark"] body.app-mode { --mw-selbg:');
		// No hard-coded prototype palette values.
		expect(css).not.toContain("#8273EE");
		expect(css).not.toContain("#0E0F12");
	});

	it("keeps the approved responsive breakpoints", () => {
		expect(css).toContain("@media (max-width: 1439px)");
		expect(fnSource("mwNarrow")).toContain('(max-width:1439px)');
		expect(css).toMatch(/@media \(max-width: 1023px\)[\s\S]{0,400}mw-col-src/);
		expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]{0,500}mw-col-type/);
		expect(css).toContain("grid-template-columns: minmax(0, 64fr) minmax(400px, 36fr)");
		expect(css).toContain("width: min(520px, 100%)");
	});

	it("respects reduced motion", () => {
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,300}mw/);
	});

	it("uses the app fonts, not remote ones", () => {
		expect(css).toMatch(/\.mw \{[^}]*font-family: var\(--font-ui\)/);
		expect(css).toMatch(/\.mw-mono \{ font-family: var\(--font-mono\); \}/);
		expect(html).not.toContain("fonts.googleapis.com");
	});

	it("defaults new users to compact while preserving an explicit comfortable preference", () => {
		expect(script).toContain('MW_DENSITY_KEY = "itsuki_mw_density"');
		expect(css).toContain('.mw[data-density="compact"]');
		expect(fnSource("mwDefaults")).toContain('=== "comfortable" ? "comfortable" : "compact"');
		expect(css).toContain('.mw[data-density="compact"] .mw-row .mw-meta { display: none; }');
	});

	it("keeps screen-reader status text clipped and owns headers inside the grid", () => {
		expect(css).toMatch(/\.sr-only \{[^}]*clip: rect\(0, 0, 0, 0\)/);
		expect(fnSource("mwHeadCols")).toContain('role="columnheader"');
		expect(fnSource("mwRenderList")).toContain('role="rowgroup"');
		expect(fnSource("mwRenderList")).toContain('aria-colcount=');
		expect(fnSource("mwRenderList")).toContain('aria-busy');
		expect(fnSource("mwRenderList")).toContain('aria-rowindex="1"');
	});
});
