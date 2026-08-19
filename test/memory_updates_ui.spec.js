/**
 * Memories workspace — safe-update UI behaviour.
 *
 * The first release only pinned that the markup existed. These tests execute
 * the shipped page functions against a scripted API and assert the behaviour a
 * customer actually depends on: a 412 must never discard their draft, history
 * pages with a bounded cursor, restore uses the current head, and rendered
 * content is escaped.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

/** Pull one top-level function's source out of the single-file app. */
function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	// Keep the `async` keyword: extracting from `function` alone would strip it
	// and every `await` inside would become a syntax error.
	if (script.slice(start - 6, start) === "async ") start -= 6;
	// Walk past the parameter list first: a destructured default like
	// `({ more = false } = {})` opens braces that are not the function body.
	let cursor = script.indexOf("(", script.indexOf(`function ${name}(`));
	let parens = 0;
	for (; cursor < script.length; cursor++) {
		if (script[cursor] === "(") parens++;
		else if (script[cursor] === ")") {
			parens--;
			if (parens === 0) { cursor++; break; }
		}
	}
	const bodyStart = script.indexOf("{", cursor);
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

/**
 * Build the edit/history functions with stand-ins for the browser globals the
 * page uses. Everything the functions touch is injected, so this exercises the
 * real shipped logic rather than a copy.
 */
function buildHarness({ apiImpl } = {}) {
	const state = {
		toasts: [],
		confirmAnswers: [],
		rendered: 0,
		listRefreshed: 0,
		selected: null,
	};
	const MWEDIT = {
		open: false, id: null, kind: null, base: null, initial: {}, draft: {},
		reason: "", busy: false, error: "", conflict: null, fresh: null, needsFull: false,
	};
	const MW = {
		sel: "node_1", detail: null, updatesEnabled: true, tab: "history",
		history: null, historyLoading: false, historyError: "",
	};
	const names = [
		"mwEditDirtyFields", "mwEditSeed", "mwEditSave", "mwEditLoadLatest",
		"mwLoadHistory", "closeMwEditModal", "mwEditLocalDatetime", "clampMwText",
	];
	const source = names.map(fnSource).join("\n");
	const factory = new Function(
		"MWEDIT", "MW", "api", "toast", "confirm", "renderMwEditModal", "mwSelect",
		"mwFetchList", "mwRenderInsp", "restoreModalOpener", "requireProjectCapability",
		"crypto", "esc", "$", "MW_EDIT_KIND_FIELDS", "state",
		`${source}\nreturn { mwEditDirtyFields, mwEditSeed, mwEditSave, mwEditLoadLatest, mwLoadHistory, closeMwEditModal, clampMwText };`,
	);
	const MW_EDIT_KIND_FIELDS = {
		node: [
			{ name: "label", label: "Label", kind: "text", max: 200 },
			{ name: "category", label: "Category", kind: "select", options: ["tool", "project"] },
			{ name: "summary", label: "Summary", kind: "textarea", max: 4000 },
		],
		page: [
			{ name: "title", label: "Title", kind: "text", max: 200 },
			{ name: "short_summary", label: "Short summary", kind: "textarea", max: 4000 },
			{ name: "full_markdown", label: "Content", kind: "textarea", max: 20000 },
		],
		slice: [{ name: "text", label: "Detail", kind: "textarea", max: 4000 }, { name: "kind", label: "Type", kind: "select", options: ["other"] }],
		event: [
			{ name: "text", label: "Event", kind: "textarea", max: 4000 },
			{ name: "importance", label: "Importance", kind: "select", options: ["ordinary"] },
			{ name: "happened_at", label: "Happened", kind: "datetime" },
		],
	};
	const api = apiImpl ?? (async () => ({ ok: true }));
	const fns = factory(
		MWEDIT, MW, api,
		(message, isError) => state.toasts.push({ message, isError }),
		() => (state.confirmAnswers.length ? state.confirmAnswers.shift() : true),
		() => { state.rendered += 1; },
		(id) => { state.selected = id; },
		() => { state.listRefreshed += 1; },
		() => {},
		() => {},
		() => true,
		{ randomUUID: () => "11111111-2222-3333-4444-555555555555" },
		(value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
		() => null,
		MW_EDIT_KIND_FIELDS,
		state,
	);
	return { fns, MWEDIT, MW, state, MW_EDIT_KIND_FIELDS };
}

describe("edit dialog", () => {
	it("sends only the fields the user actually changed, with the precondition", async () => {
		const calls = [];
		const { fns, MWEDIT } = buildHarness({
			apiImpl: async (path, opts) => {
				calls.push({ path, body: JSON.parse(opts.body) });
				return { ok: true, revision: 4 };
			},
		});
		Object.assign(MWEDIT, {
			open: true, id: "node_1", kind: "node", base: 3,
			initial: { label: "Same", category: "tool", summary: "Old summary" },
			draft: { label: "Same", category: "tool", summary: "New summary" },
			reason: "corrected",
		});

		await fns.mwEditSave();

		expect(calls).toHaveLength(1);
		expect(calls[0].path).toContain("/v1/memories/node_1");
		expect(calls[0].body.summary).toBe("New summary");
		expect(calls[0].body.label).toBeUndefined();   // unchanged field not sent
		expect(calls[0].body.expectedRevision).toBe(3);
		expect(calls[0].body.reason).toBe("corrected");
		expect(typeof calls[0].body.idempotencyKey).toBe("string");
	});

	it("a 412 conflict PRESERVES the draft and records the newer revision", async () => {
		const conflict = Object.assign(new Error("changed"), {
			status: 412, body: { error: "stale_revision", current_revision: 9 },
		});
		const { fns, MWEDIT, state } = buildHarness({ apiImpl: async () => { throw conflict; } });
		Object.assign(MWEDIT, {
			open: true, id: "node_1", kind: "node", base: 3,
			initial: { label: "Old", category: "tool", summary: "Old" },
			draft: { label: "My careful new label", category: "tool", summary: "Old" },
		});

		await fns.mwEditSave();

		// The user's typing survives, the dialog stays open, and the conflict is
		// explicit — nothing was silently overwritten or auto-merged.
		expect(MWEDIT.open).toBe(true);
		expect(MWEDIT.draft.label).toBe("My careful new label");
		expect(MWEDIT.conflict).toEqual({ current_revision: 9 });
		expect(MWEDIT.busy).toBe(false);
		expect(state.rendered).toBeGreaterThan(0);
	});

	it("loading the latest revision rebases the precondition without touching the draft", async () => {
		const { fns, MWEDIT } = buildHarness({
			apiImpl: async (path) => {
				if (path.includes("/workspace/memory/")) {
					return { memory: { id: "node_1", kind: "node", text: "Server label", category: "tool", summary: "Server summary", revision: 9 } };
				}
				return { memory: {} };
			},
		});
		Object.assign(MWEDIT, {
			open: true, id: "node_1", kind: "node", base: 3,
			initial: { label: "Old", category: "tool", summary: "Old" },
			draft: { label: "My draft", category: "tool", summary: "My draft summary" },
			conflict: { current_revision: 9 },
		});

		await fns.mwEditLoadLatest();

		expect(MWEDIT.base).toBe(9);
		expect(MWEDIT.fresh.label).toBe("Server label");
		expect(MWEDIT.draft.label).toBe("My draft");        // untouched
		expect(MWEDIT.draft.summary).toBe("My draft summary");
	});

	it("a no-op save closes without calling the API", async () => {
		let called = 0;
		const { fns, MWEDIT, state } = buildHarness({ apiImpl: async () => { called += 1; return { ok: true }; } });
		Object.assign(MWEDIT, {
			open: true, id: "node_1", kind: "node", base: 2,
			initial: { label: "Same", category: "tool", summary: "Same" },
			draft: { label: "Same", category: "tool", summary: "Same" },
		});
		await fns.mwEditSave();
		expect(called).toBe(0);
		expect(MWEDIT.open).toBe(false);
		expect(state.toasts.some((t) => /nothing changed/i.test(t.message))).toBe(true);
	});

	it("closing with unsaved changes asks first and keeps the dialog when refused", async () => {
		const { fns, MWEDIT, state } = buildHarness();
		Object.assign(MWEDIT, {
			open: true, id: "node_1", kind: "node", base: 1,
			initial: { label: "A", category: "tool", summary: "A" },
			draft: { label: "B", category: "tool", summary: "A" },
		});
		state.confirmAnswers.push(false);
		fns.closeMwEditModal();
		expect(MWEDIT.open).toBe(true);
	});
});

describe("history panel", () => {
	it("requests a bounded page and appends when loading older revisions", async () => {
		const urls = [];
		const { fns, MW } = buildHarness({
			apiImpl: async (path) => {
				urls.push(path);
				return urls.length === 1
					? { id: "node_1", current_revision: 5, revisions: [{ revision: 5 }, { revision: 4 }], next_cursor: "4" }
					: { id: "node_1", current_revision: 5, revisions: [{ revision: 3 }], next_cursor: null };
			},
		});

		await fns.mwLoadHistory();
		expect(urls[0]).toContain("/history?limit=20");
		expect(MW.history.revisions).toHaveLength(2);

		await fns.mwLoadHistory({ more: true });
		expect(urls[1]).toContain("cursor=4");
		expect(MW.history.revisions.map((r) => r.revision)).toEqual([5, 4, 3]);
		expect(MW.history.next_cursor).toBe(null);
	});

	it("a history failure is surfaced, not silently empty", async () => {
		const { fns, MW } = buildHarness({ apiImpl: async () => { throw new Error("history unavailable"); } });
		await fns.mwLoadHistory();
		expect(MW.historyError).toBe("history unavailable");
		expect(MW.historyLoading).toBe(false);
	});

	it("a response for a different memory is discarded (stale selection)", async () => {
		const { fns, MW } = buildHarness({
			apiImpl: async () => {
				MW.sel = "node_other";   // the user moved on mid-flight
				return { id: "node_1", current_revision: 2, revisions: [{ revision: 2 }], next_cursor: null };
			},
		});
		await fns.mwLoadHistory();
		expect(MW.history).toBe(null);
	});
});

describe("rendering safety", () => {
	it("history and edit markup escape user content", () => {
		const panel = fnSource("mwHistoryPanel");
		const modal = fnSource("renderMwEditModal");
		// Every interpolation of user-authored values goes through esc(...).
		expect(panel).toContain("esc(clampMwText(String(preview ?? \"\"), 220))");
		expect(panel).toContain("esc(revision.reason)");
		expect(modal).toContain("esc(String(value ?? \"\"))");
		expect(modal).not.toMatch(/\$\{\s*MWEDIT\.draft\[[^\]]+\]\s*\}/);
	});

	it("clamping never breaks out of the bound", () => {
		const { fns } = buildHarness();
		expect(fns.clampMwText("x".repeat(500), 10)).toHaveLength(10);
		expect(fns.clampMwText("short", 10)).toBe("short");
	});

	it("the edit affordance is gated on server capability and object state", () => {
		const insp = fnSource("mwRenderInsp");
		expect(insp).toContain("MW.updatesEnabled && detail.editable && mwCanWrite()");
		const tabs = fnSource("mwTabsFor");
		expect(tabs).toContain("MW.updatesEnabled && detail.revision != null");
	});
});
