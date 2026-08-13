/**
 * The rule every form in this app now obeys:
 *
 *   1. read what the person typed BEFORE anything re-renders
 *   2. a failed submit keeps every field
 *   3. the error names the real problem and clears when it is addressed
 *
 * The webhook form broke all three (a re-render before the read sent an empty
 * URL, which the server then correctly called invalid). These tests sweep the
 * other submit handlers for the same class of bug, each with a stub that
 * behaves like the real renderer — rebuilding inputs from state — so a
 * regression fails here instead of in someone's browser.
 */

import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	if (script.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
	let depth = 0;
	let seenBody = false;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "{") { depth++; seenBody = true; }
		else if (script[i] === "}") {
			depth--;
			if (seenBody && depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

function build(names, globals) {
	const keys = Object.keys(globals);
	return new Function(
		...keys,
		`${names.map(fnSource).join("\n")}\nreturn { ${names.join(", ")} };`,
	)(...keys.map((k) => globals[k]));
}

describe("the API key modal", () => {
	function harness({ apiImpl } = {}) {
		const KEYMODAL = { open: true, type: "api", busy: false, result: null, error: "", name: "" };
		const nameInput = { value: "" };
		const errorBox = { hidden: true };
		const calls = [];
		// Mirrors the real renderKeyModal: the input is rebuilt from state.
		const renderKeyModal = () => {
			nameInput.value = KEYMODAL.name;
			errorBox.hidden = !KEYMODAL.error;
		};
		const $ = (sel) => (sel === "#keyModalName" ? nameInput : sel === "#keyModalError" ? errorBox : null);
		const api = apiImpl ?? (async (path, init) => {
			calls.push(JSON.parse(init.body));
			return { token: "itsuki_live_abc", tokenRecord: { type: "api" } };
		});
		const built = build(["keyModalField", "submitKeyModal"], {
			KEYMODAL, $, api, renderKeyModal,
			S: {}, refreshTokens: async () => {}, mcpUrlForToken: (t) => `https://itsuki.app/mcp/${t}`,
		});
		return { ...built, KEYMODAL, nameInput, errorBox, calls };
	}

	it("sends the typed name", async () => {
		const h = harness();
		h.nameInput.value = "Production agent";
		h.keyModalField("Production agent");
		await h.submitKeyModal();
		expect(h.calls[0].label).toBe("Production agent");
	});

	it("a failed create hands the name back instead of a blank field", async () => {
		const h = harness({ apiImpl: async () => { throw new Error("Could not reach the server."); } });
		h.nameInput.value = "Production agent";
		h.keyModalField("Production agent");

		await h.submitKeyModal();

		expect(h.KEYMODAL.error).toBe("Could not reach the server.");
		expect(h.KEYMODAL.name).toBe("Production agent");
		expect(h.nameInput.value).toBe("Production agent"); // survived the re-render
		expect(h.errorBox.hidden).toBe(false);
	});

	it("the error clears on the next keystroke", async () => {
		const h = harness({ apiImpl: async () => { throw new Error("Could not reach the server."); } });
		h.keyModalField("x");
		await h.submitKeyModal();
		expect(h.KEYMODAL.error).toBeTruthy();

		h.keyModalField("xy");
		expect(h.KEYMODAL.error).toBe("");
		expect(h.errorBox.hidden).toBe(true);
	});

	it("an empty name is allowed and falls back to a sensible label", async () => {
		const h = harness();
		await h.submitKeyModal();
		expect(h.calls[0].label).toBe("API client");
	});
});

describe("the dashboard save forms", () => {
	function harness({ saveOk }) {
		const factText = { value: "" };
		const convText = { value: "" };
		const toasts = [];
		const $ = (sel) => (sel === "#factText" ? factText : sel === "#conversationText" ? convText : null);
		const built = build(["saveFactFromForm", "saveConversationFromForm"], {
			$, doSave: async () => saveOk, toast: (m, bad) => toasts.push({ m, bad }),
		});
		return { ...built, factText, convText, toasts };
	}

	it("clears the box after a save that landed", async () => {
		const h = harness({ saveOk: true });
		h.factText.value = "I started learning Kotlin this week.";
		await h.saveFactFromForm();
		expect(h.factText.value).toBe("");
	});

	it("a FAILED save does not eat what was typed", async () => {
		// doSave used to swallow its error and return undefined, so the caller
		// cleared the textarea either way — the save was lost AND the sentence.
		const h = harness({ saveOk: false });
		h.factText.value = "I started learning Kotlin this week.";
		await h.saveFactFromForm();
		expect(h.factText.value).toBe("I started learning Kotlin this week.");
	});

	it("the same holds for the conversation box", async () => {
		const ok = harness({ saveOk: true });
		ok.convText.value = "line one\nline two";
		await ok.saveConversationFromForm();
		expect(ok.convText.value).toBe("");

		const bad = harness({ saveOk: false });
		bad.convText.value = "line one\nline two";
		await bad.saveConversationFromForm();
		expect(bad.convText.value).toBe("line one\nline two");
	});

	it("an empty submit says what to do and never calls the API", async () => {
		const h = harness({ saveOk: true });
		await h.saveFactFromForm();
		expect(h.toasts[0].m).toBe("Write a fact first.");
	});
});

describe("the rules form", () => {
	function harness({ apiImpl } = {}) {
		const fields = {
			"#rule-instructions": { value: "Always save exam progress." },
			"#rule-includes": { value: "exams, health" },
			"#rule-excludes": { value: "politics" },
			"#rule-categories": { value: "study_progress: exam completion" },
			"#rule-capture": { value: "auto" },
			"#rule-density": { value: "standard" },
			"#rule-autocollect": { checked: true },
		};
		const status = { textContent: "", classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } };
		const button = { disabled: false, textContent: "Save rules" };
		const calls = [];
		const $ = (sel) => (sel === "#rules-status" ? status : sel === "#rules-save" ? button : fields[sel] ?? null);
		const api = apiImpl ?? (async (path, init) => { calls.push(JSON.parse(init.body)); return { rules: { customInstructions: "", includes: [], excludes: [], customCategories: [] } }; });
		const built = build(["saveRulesForm", "rulesStatusClear"], {
			$, api, calls,
			parseTermList: (v) => String(v).split(",").map((t) => t.trim()).filter(Boolean),
			parseCategoryLines: (v) => String(v).split("\n").filter(Boolean).map((l) => ({ name: l.split(":")[0].trim() })),
			scopedPayload: (p) => p,
			renderRulesSummary: () => {},
		});
		return { ...built, fields, status, button, calls };
	}

	it("reads every field before disabling the form", async () => {
		const h = harness();
		await h.saveRulesForm();
		expect(h.calls[0].rules.customInstructions).toBe("Always save exam progress.");
		expect(h.calls[0].rules.includes).toEqual(["exams", "health"]);
		expect(h.calls[0].rules.excludes).toEqual(["politics"]);
		expect(h.status.textContent).toBe("Saved ✓");
		expect(h.button.disabled).toBe(false); // re-enabled, not stuck on "Saving…"
	});

	it("a failed save keeps the fields, says why, and re-enables the button", async () => {
		const h = harness({ apiImpl: async () => { throw new Error("Could not save your rules right now."); } });
		await h.saveRulesForm();
		expect(h.status.textContent).toBe("Could not save your rules right now.");
		expect(h.status.classList.contains("rules-status-error")).toBe(true);
		expect(h.fields["#rule-instructions"].value).toBe("Always save exam progress.");
		expect(h.button.disabled).toBe(false);
	});

	it("editing after a failure retires the stale message", async () => {
		const h = harness({ apiImpl: async () => { throw new Error("nope"); } });
		await h.saveRulesForm();
		expect(h.status.textContent).toBeTruthy();
		h.rulesStatusClear();
		expect(h.status.textContent).toBe("");
		expect(h.status.classList.contains("rules-status-error")).toBe(false);
	});
});

describe("destructive actions ask first", () => {
	it("Reset configuration confirms before erasing saved playground settings", async () => {
		const PG = {
			threadId: "t1",
			settings: { captureMode: "only_topics", includeTopics: ["thesis"], excludeTopics: [], customCategories: [] },
			settingsDraft: null,
		};
		let applied = 0;
		let asked = null;
		let returned = 0;
		const built = build(["playgroundResetSettings"], {
			PG,
			confirm: (msg) => { asked = msg; return false; },
			playgroundApplySettings: async () => { applied++; },
			pgReturnToChat: () => { returned++; },
			renderPlaygroundSide: () => {},
		});

		await built.playgroundResetSettings();
		expect(asked).toContain("Clear the memory policy saved for this chat");
		expect(applied).toBe(0);                                        // declined → nothing erased
		expect(returned).toBe(0);                                       // and they stay on the form
		expect(PG.settings.includeTopics).toEqual(["thesis"]);
		expect(PG.settings.captureMode).toBe("only_topics");
	});

	it("with nothing saved it just clears the draft, no pointless prompt", async () => {
		const PG = {
			threadId: "t1",
			settings: { captureMode: "standard", includeTopics: [], excludeTopics: [], customCategories: [] },
			settingsDraft: { captureMode: "standard", includeTopics: ["typed but never applied"], excludeTopics: [], customCategories: [] },
		};
		let asked = false;
		let returnedWith = null;
		const built = build(["playgroundResetSettings"], {
			PG,
			confirm: () => { asked = true; return true; },
			playgroundApplySettings: async () => {},
			pgReturnToChat: (msg) => { returnedWith = msg; },
			renderPlaygroundSide: () => {},
		});
		await built.playgroundResetSettings();
		expect(asked).toBe(false);
		expect(PG.settingsDraft.includeTopics).toEqual([]);
		expect(PG.settingsDraft.captureMode).toBe("standard");
		// The button still did its job, so it still hands the conversation back.
		expect(returnedWith).toContain("account rules");
	});
});

describe("in-flight states", () => {
	it("every Create export button disables and says what it is doing", () => {
		// There are two of these — the page header and the empty state. The
		// empty-state copy was missing the binding, so the button a brand-new
		// account actually clicks stayed idle-looking mid-request.
		const buttons = [...script.matchAll(/<button[^>]*onclick="createExportJob\(\)"[^>]*>[^<]*/g)].map((m) => m[0]);
		expect(buttons.length).toBeGreaterThanOrEqual(2);
		for (const b of buttons) {
			expect(b, b).toContain("EX.creating");
			expect(b, b).toContain("Starting…");
		}
	});

	it("the webhook and key create buttons do the same", () => {
		expect(script).toMatch(/id="whCreate"[^>]*\$\{WH\.creating \? "disabled" : ""\}/);
		expect(script).toContain('${WH.creating ? "Creating…" : "Create webhook"}');
		expect(script).toMatch(/id="keyModalCreate"[^>]*\$\{KEYMODAL\.busy \? "disabled" : ""\}/);
	});
});

describe("no handler re-renders before it reads (static sweep)", () => {
	it("every submit handler reads its inputs first", () => {
		const RENDER = /\b(renderView|renderKeyModal|renderWebhooksTable|renderPlaygroundSide|renderAll)\s*\(/;
		const READ = /\$\("#[A-Za-z0-9_-]+"\)\s*\??\.\s*(value|checked)/;
		const handlers = [
			"createWebhookNow", "submitKeyModal", "saveRulesForm",
			"saveFactFromForm", "saveConversationFromForm", "submitAuth",
		];
		for (const name of handlers) {
			const body = fnSource(name);
			const render = RENDER.exec(body);
			const read = READ.exec(body);
			if (!render || !read) continue; // nothing to order
			expect(read.index, `${name} re-renders before reading its inputs`).toBeLessThan(render.index);
		}
	});
});
